"""v1.7.1 CloudCompute deployment: launcher, paths, auth, persistence, downloads, scripts, Colab compatibility.
No real GPU here: the end-to-end test runs the REAL engine server with a CUDA test double (sitecustomize)."""
import base64, hashlib, io, json, os, re, shutil, signal, stat, struct, subprocess, sys, time, zipfile
import urllib.error, urllib.request
from pathlib import Path
import pytest
import importlib.util

APP = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP / 'cloudcompute'))
import launcher  # noqa: E402
import fetch_models  # noqa: E402
import diagnose  # noqa: E402

def safetensors(path, keys=('conditioner.embedders.1.w', 'model.diffusion_model.w')):
    path.parent.mkdir(parents=True, exist_ok=True)
    head = json.dumps({'__metadata__': {}, **{k: {'dtype': 'F32', 'shape': [1], 'data_offsets': [0, 4]} for k in keys}}).encode()
    path.write_bytes(struct.pack('<Q', len(head)) + head + b'1234')
    return path

def env_for(tmp_path, **extra):
    env = {'YOISAKI_DATA_ROOT': str(tmp_path / 'data'), 'YOISAKI_ENGINE_DIR': str(APP / 'engine'), **extra}
    return env

# ---------------------------------------------------------------- configuration and paths
def test_config_validation(tmp_path):
    with pytest.raises(launcher.LaunchError):launcher.Config({})
    with pytest.raises(launcher.LaunchError):launcher.Config({'YOISAKI_DATA_ROOT': 'relative/data'})
    with pytest.raises(launcher.LaunchError):launcher.Config(env_for(tmp_path, YOISAKI_PORT='80'))
    cfg = launcher.Config(env_for(tmp_path))
    assert cfg.models == tmp_path / 'data/models' and cfg.local == 'http://127.0.0.1:8765' and cfg.tunnel
    assert launcher.Config(env_for(tmp_path, YOISAKI_TUNNEL='0')).tunnel is False

def test_prepare_is_idempotent_and_preserves_user_files(tmp_path):
    cfg = launcher.Config(env_for(tmp_path))
    weights = safetensors(cfg.models / 'checkpoints/illustrious.safetensors')
    before = weights.read_bytes()
    launcher.prepare(cfg)
    marker = (cfg.data / '.yoisaki-data-id').read_text()
    for sub in ('models/checkpoints', 'models/loras', 'models/vae', 'models/controlnet', 'huggingface-cache', 'outputs', 'logs', 'diagnostics', 'runtime/state'):
        assert (cfg.data / sub).is_dir()
    assert stat.S_IMODE((cfg.state).stat().st_mode) == 0o700
    launcher.prepare(cfg)
    assert (cfg.data / '.yoisaki-data-id').read_text() == marker  # persistence probe is written once
    assert weights.read_bytes() == before

def test_child_environment_paths_and_secret_handling(tmp_path, monkeypatch):
    cfg = launcher.Config(env_for(tmp_path))
    launcher.prepare(cfg)
    for key in ('HF_HOME', 'TORCH_HOME', 'YOISAKI_SDPOSE_REPO', 'HF_HUB_OFFLINE', 'LD_PRELOAD', 'GLIBC_TUNABLES'):
        monkeypatch.delenv(key, raising=False)
    env = launcher.child_env(cfg, 'f' * 64)
    assert env['YOISAKI_TOKEN'] == 'f' * 64 and env['YOISAKI_MODEL_ROOT'] == str(cfg.models)
    assert env['YOISAKI_RESULTS_DIR'] == str(cfg.data / 'outputs') and env['PYTHONPATH'] == str(cfg.engine)
    assert env['HF_HOME'] == str(cfg.data / 'huggingface-cache') and 'HF_HUB_OFFLINE' not in env
    assert env['MALLOC_MMAP_THRESHOLD_'] == '131072'  # unchanged Colab allocator policy (engine/worker/allocator_policy.py)
    assert 'YOISAKI_SDPOSE_REPO' not in env
    (cfg.data / 'sdpose/unet').mkdir(parents=True)
    monkeypatch.setenv('YOISAKI_HF_OFFLINE', '1')
    env = launcher.child_env(cfg, 'f' * 64)
    assert env['YOISAKI_SDPOSE_REPO'] == str(cfg.data / 'sdpose') and env['HF_HUB_OFFLINE'] == '1'
    assert 'f' * 64 not in os.environ.values()  # the token never leaks into the launcher's own environment

def test_engine_memory_log_lands_in_data_diagnostics(tmp_path):
    """The engine writes memory.jsonl to <model root>/../diagnostics: inside the persistent data root."""
    sys.path.insert(0, str(APP / 'engine'))
    from worker.memory import MemoryLog
    cfg = launcher.Config(env_for(tmp_path))
    assert MemoryLog(cfg.models).path == cfg.diagnostics / 'memory.jsonl'

def test_private_files_are_0600(tmp_path):
    target = tmp_path / 'link.txt'
    launcher.write_private(target, 'secret\n')
    assert stat.S_IMODE(target.stat().st_mode) == 0o600 and target.read_text() == 'secret\n'

# ---------------------------------------------------------------- end-to-end with the real engine server
needs_engine = pytest.mark.skipif(importlib.util.find_spec('fastapi') is None or importlib.util.find_spec('torch') is None,
                                  reason='engine dependencies (run inside the YOISAKI image)')

def listeners(port):
    rows = []
    for table in ('/proc/net/tcp', '/proc/net/tcp6'):
        if not Path(table).exists():continue  # no IPv6 in this namespace
        for line in Path(table).read_text().splitlines()[1:]:
            local, state = line.split()[1], line.split()[3]
            if state == '0A' and local.endswith(':%04X' % port):rows.append(local.split(':')[0])
    return rows

SITE = '''import torch
torch.cuda.is_available = lambda: True
torch.cuda.get_device_name = lambda *a: 'TEST_DOUBLE_NOT_REAL_GPU'
torch.cuda.mem_get_info = lambda *a: (15 * 2**30, 16 * 2**30)
'''

def fake_gpu_engine(tmp_path):
    engine = tmp_path / 'engine'
    shutil.copytree(APP / 'engine', engine, ignore=shutil.ignore_patterns('.venv', '.results', '__pycache__'))
    (engine / 'sitecustomize.py').write_text(SITE)  # imported at worker start (PYTHONPATH=engine)
    return engine

def get(url, token=None, timeout=5):
    req = urllib.request.Request(url, headers={'Authorization': 'Bearer ' + token} if token else {})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, json.load(r)

def wait(predicate, timeout=60):
    end = time.time() + timeout
    while time.time() < end:
        if predicate():return True
        time.sleep(0.5)
    return False

@needs_engine
def test_launcher_end_to_end_auth_health_lock_and_clean_stop(tmp_path):
    env = {**os.environ, **env_for(tmp_path, YOISAKI_ENGINE_DIR=str(fake_gpu_engine(tmp_path)), YOISAKI_TUNNEL='0',
           YOISAKI_GPU_PREFLIGHT='0', YOISAKI_PORT='18765')}
    data = tmp_path / 'data'
    proc = subprocess.Popen([sys.executable, str(APP / 'cloudcompute/launcher.py'), 'run'], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        state = data / 'runtime/state'
        assert wait(lambda: (state / 'launcher.json').exists() and json.loads((state / 'launcher.json').read_text())['phase'] == 'READY'), proc
        token = (state / 'token').read_text().strip()
        assert re.fullmatch('[a-f0-9]{64}', token) and stat.S_IMODE((state / 'token').stat().st_mode) == 0o600
        with pytest.raises(urllib.error.HTTPError) as denied:get('http://127.0.0.1:18765/health')
        assert denied.value.code == 401
        with pytest.raises(urllib.error.HTTPError):get('http://127.0.0.1:18765/health', 'b' * 64)
        status, health = get('http://127.0.0.1:18765/health', token)
        assert status == 200 and health['engine'] == 'YOISAKI_ENGINE' and health['engine_version'] == '1.7.0' and health['state'] == 'READY'
        assert health['capabilities'] == {'controlnet': True, 'sdpose': True, 'img2img': True, 'regional_control': True, 'result_ack': True}
        assert get('http://127.0.0.1:18765/models', token)[1] == {'models': []}
        # The listener is loopback-only (same as Colab): no public interface is bound.
        assert listeners(18765) == ['0100007F']
        # healthcheck / status subcommands (used by Docker HEALTHCHECK and check-cloudcompute.sh)
        assert subprocess.run([sys.executable, str(APP / 'cloudcompute/launcher.py'), 'healthcheck'], env=env).returncode == 0
        st = json.loads(subprocess.run([sys.executable, str(APP / 'cloudcompute/launcher.py'), 'status'], env=env, capture_output=True, text=True).stdout)
        assert st['health']['state'] == 'READY' and st['model_loaded'] is False and token not in json.dumps(st)
        # A second launcher on the same data root is refused (no duplicate SDXL in VRAM).
        second = subprocess.run([sys.executable, str(APP / 'cloudcompute/launcher.py'), 'run'], env=env, capture_output=True, text=True, timeout=60)
        assert second.returncode == 3 and 'уже запущен' in second.stdout
        assert (state / 'token').exists()  # the refused launcher did not touch the running one
        proc.send_signal(signal.SIGTERM)
        out, _ = proc.communicate(timeout=60)
    finally:
        if proc.poll() is None:proc.kill()
    assert proc.returncode == 0
    assert not (state / 'token').exists() and not (state / 'link.txt').exists()
    assert json.loads((state / 'launcher.json').read_text())['phase'] == 'STOPPED'
    with pytest.raises(OSError):get('http://127.0.0.1:18765/health', token, 2)
    timings = json.loads((data / 'diagnostics/startup-timings.jsonl').read_text().splitlines()[-1])
    assert timings['server_ready_after_s'] >= 0 and 'tunnel_ready_after_s' not in timings
    logs = ''.join(p.read_text() for p in (data / 'logs').glob('*')) + out
    assert token not in logs  # no secret in any log or console output

@needs_engine
def test_launcher_refuses_to_start_without_cuda(tmp_path):
    """Without the test double the real engine reports state=ERROR: no tunnel, no link, exit 3."""
    env = {**os.environ, **env_for(tmp_path, YOISAKI_TUNNEL='0', YOISAKI_GPU_PREFLIGHT='0', YOISAKI_PORT='18766', YOISAKI_SERVER_TIMEOUT='20')}
    result = subprocess.run([sys.executable, str(APP / 'cloudcompute/launcher.py'), 'run'], env=env, capture_output=True, text=True, timeout=120)
    assert result.returncode == 3 and 'CUDA' in result.stdout
    assert not (tmp_path / 'data/runtime/state/link.txt').exists()

def test_gpu_preflight_blocks_start_on_cpu(tmp_path):
    env = {**os.environ, **env_for(tmp_path, YOISAKI_TUNNEL='0', YOISAKI_PORT='18767')}
    result = subprocess.run([sys.executable, str(APP / 'cloudcompute/launcher.py'), 'run'], env=env, capture_output=True, text=True, timeout=300)
    assert result.returncode == 3 and 'GPU не прошёл проверку' in result.stdout
    assert not (tmp_path / 'data/logs/server.log').exists()  # the engine was never started

def test_tunnel_link_format_restart_and_website_parser(tmp_path, monkeypatch):
    """Fake cloudflared prints a quick-tunnel URL; the stored link must pass the website's parseTunnel()."""
    stub = tmp_path / 'cloudflared'
    stub.write_text('#!/bin/sh\necho "INF |  https://calm-fox-$$.trycloudflare.com  |"\nexec sleep 300\n')
    stub.chmod(0o755)
    cfg = launcher.Config(env_for(tmp_path, YOISAKI_CLOUDFLARED=str(stub), YOISAKI_TUNNEL_TIMEOUT='20'))
    launcher.prepare(cfg)
    monkeypatch.setattr(launcher, 'verify_tunnel', lambda base, token: True)
    run = launcher.Launcher(cfg)
    run.token = 'c' * 64
    run.start_tunnel()
    link = (cfg.state / 'link.txt').read_text().strip()
    assert stat.S_IMODE((cfg.state / 'link.txt').stat().st_mode) == 0o600
    assert re.fullmatch(r'https://calm-fox-\d+\.trycloudflare\.com/#token=c{64}', link)
    first = run.url
    run.tunnel.kill()  # tunnel lost -> supervise() replaces it and rewrites the link
    run.server = type('Alive', (), {'poll': lambda self: None, 'pid': 0})()
    run.cfg.tunnel_restarts = 1
    original = run.start_tunnel
    calls = []
    def restart():
        calls.append(1);original();run.stopping = True
    run.start_tunnel = restart
    run.supervise()
    assert calls and run.url and run.url != first
    run.stop_tunnel()
    assert not (cfg.state / 'link.txt').exists()

@pytest.mark.skipif(shutil.which('node') is None, reason='Node.js (website server) not installed here')
def test_link_accepted_by_website_parser():
    """The exact link format the launcher writes passes the provider-aware website's parseTunnel()."""
    link = 'https://calm-fox-123.trycloudflare.com/#token=' + 'c' * 64
    parsed = subprocess.run(['node', '--input-type=module', '-e',
        "import {parseTunnel} from './server/upstream.mjs';console.log(JSON.stringify(parseTunnel(process.argv[1])))", link],
        cwd=APP, capture_output=True, text=True)
    assert parsed.returncode == 0, parsed.stderr
    assert json.loads(parsed.stdout) == {'origin': 'https://calm-fox-123.trycloudflare.com', 'hostname': 'calm-fox-123.trycloudflare.com', 'token': 'c' * 64, 'provider': 'colab'}
    # and the launcher's own pattern matches what cloudflared prints
    assert launcher.TUNNEL_RE.search('INF |  https://calm-fox-123.trycloudflare.com  |').group(0) == 'https://calm-fox-123.trycloudflare.com'

# ---------------------------------------------------------------- model downloads
class FakeResponse(io.BytesIO):
    def __init__(self, data, status=200, headers=None):
        super().__init__(data);self.status = status;self.headers = headers or {}
    def __enter__(self):return self
    def __exit__(self, *a):self.close()

def fetch_cfg(tmp_path):
    cfg = launcher.Config(env_for(tmp_path));launcher.prepare(cfg);return cfg

@pytest.fixture
def roomy_disk(monkeypatch):
    """Independent of the real free space of the test machine (the disk check has its own test)."""
    monkeypatch.setattr(fetch_models.shutil, 'disk_usage', lambda path: shutil._ntuple_diskusage(10**13, 0, 10**13))

def test_fetch_skips_existing_weights_without_network(tmp_path, monkeypatch):
    cfg = fetch_cfg(tmp_path)
    existing = safetensors(cfg.models / 'checkpoints/illustrious.safetensors')
    monkeypatch.setattr(fetch_models, 'open_url', lambda *a, **k: pytest.fail('must not download again'))
    assert fetch_models.fetch_url(cfg, 'https://example.com/x', 'checkpoint', 'illustrious.safetensors') == existing

def test_fetch_resume_validate_and_publish(tmp_path, monkeypatch, roomy_disk):
    cfg = fetch_cfg(tmp_path)
    blob = safetensors(tmp_path / 'src.safetensors').read_bytes()
    part = cfg.models / 'checkpoints/model.safetensors.part'
    part.write_bytes(blob[:20])
    seen = []
    def fake(url, start=0):
        seen.append(start)
        return FakeResponse(blob[start:], 206 if start else 200, {'Content-Length': str(len(blob) - start)})
    monkeypatch.setattr(fetch_models, 'open_url', fake)
    final = fetch_models.fetch_url(cfg, 'https://example.com/dl', 'checkpoint', 'model.safetensors')
    assert seen == [20] and final.read_bytes() == blob and not part.exists()

def test_fetch_invalid_file_never_enters_catalogue(tmp_path, monkeypatch, roomy_disk):
    cfg = fetch_cfg(tmp_path)
    monkeypatch.setattr(fetch_models, 'open_url', lambda url, start=0: FakeResponse(b'<html>login</html>', 200, {'Content-Length': '18'}))
    with pytest.raises(fetch_models.FetchError):fetch_models.fetch_url(cfg, 'https://example.com/dl', 'lora', 'bad.safetensors')
    assert not (cfg.models / 'loras/bad.safetensors').exists() and (cfg.models / 'loras/bad.safetensors.invalid').exists()

def test_fetch_checks_disk_space_before_writing(tmp_path, monkeypatch):
    cfg = fetch_cfg(tmp_path)
    monkeypatch.setattr(fetch_models, 'open_url', lambda url, start=0: FakeResponse(b'', 200, {'Content-Length': str(10**15)}))
    with pytest.raises(fetch_models.FetchError, match='Недостаточно места'):
        fetch_models.fetch_url(cfg, 'https://example.com/dl', 'checkpoint', 'huge.safetensors')
    assert not any((cfg.models / 'checkpoints').iterdir())

@pytest.mark.parametrize('name', ['../escape.safetensors', 'model.ckpt', 'a/b.pt', ''])
def test_fetch_rejects_unsafe_names(name):
    if name.startswith('../'):
        assert fetch_models.safe_name(name) == 'escape.safetensors'  # basename only, no traversal
    else:
        with pytest.raises(fetch_models.FetchError):fetch_models.safe_name(name)

def test_fetch_token_is_not_forwarded_on_redirect(monkeypatch):
    captured = {}
    def fake_urlopen(req, timeout):
        captured['req'] = req;return FakeResponse(b'')
    monkeypatch.setattr(urllib.request, 'urlopen', fake_urlopen)
    monkeypatch.setenv('CIVITAI_TOKEN', 'civitai-secret')
    fetch_models.open_url('https://civitai.com/api/download/models/1')
    req = captured['req']
    assert req.unredirected_hdrs.get('Authorization') == 'Bearer civitai-secret' and 'Authorization' not in req.headers
    fetch_models.open_url('https://example.com/file')
    assert 'Authorization' not in captured['req'].unredirected_hdrs

def test_prefetch_sets_match_engine_sources():
    """Prefetch must warm exactly the repositories the engine loads at runtime."""
    controlnet = (APP / 'engine/inference/controlnet.py').read_text()
    sdpose = (APP / 'engine/inference/sdpose.py').read_text()
    text2img = (APP / 'engine/inference/text2img.py').read_text()
    repos = {repo for group in fetch_models.HF_SETS.values() for repo, _ in group}
    for repo in repos - {os.environ.get('YOISAKI_SDPOSE_REPO', 'teemosliang/SDPose-Body')}:
        assert repo in controlnet + text2img, repo
    assert "'teemosliang/SDPose-Body'" in sdpose
    assert "variant']='fp16'" in controlnet.replace(' ', '') or "kwargs['variant']='fp16'" in controlnet

# ---------------------------------------------------------------- diagnostics
TORCH_210_CU128 = ['sm_70', 'sm_75', 'sm_80', 'sm_86', 'sm_90', 'sm_100', 'sm_120']  # measured in the image build


@pytest.mark.parametrize('cap,arch,ok', [((7, 5), ['sm_75', 'sm_80'], True), ((12, 0), ['sm_75', 'sm_120'], True),
    ((12, 0), ['sm_75', 'sm_90'], False), ((12, 0), ['sm_90', 'compute_90'], True), ((8, 6), ['sm_90'], False),
    # 1.7.7: CUDA binary compatibility within a major version (sm_86 SASS runs on sm_89), never across majors
    ((8, 9), TORCH_210_CU128, True),    # RTX 4090 / 4080 / L4 / L40S — rejected by 1.7.5
    ((7, 0), TORCH_210_CU128, True),    # Tesla V100
    ((7, 5), TORCH_210_CU128, True),    # Tesla T4
    ((8, 6), TORCH_210_CU128, True),    # RTX 3090
    ((12, 0), TORCH_210_CU128, True),   # RTX 5060 Ti / 5090
    ((6, 1), TORCH_210_CU128, False),   # Pascal (GTX 1080, P40): no kernels in this wheel
    ((8, 9), ['sm_90'], False), ((12, 1), ['sm_100'], False), ((9, 0), ['sm_90a'], False)])
def test_arch_support(cap, arch, ok):
    assert diagnose.arch_supported(*cap, arch) is ok

def test_diagnostics_report_without_gpu(tmp_path, monkeypatch, capsys):
    for k, v in env_for(tmp_path).items():monkeypatch.setenv(k, v)
    cfg = launcher.Config()
    launcher.prepare(cfg)
    safetensors(cfg.models / 'checkpoints/a.safetensors')
    assert diagnose.main(['diagnose.py', '--json']) == 0
    data = json.loads(capsys.readouterr().out)
    assert data['engine_version'] == '1.7.0' and data['deploy_version'] == '1.7.7'
    assert data['models'] == {'checkpoint': 1} and data['paths']['models'] == str(cfg.models)
    assert data['disk']['free_gb'] > 0 and data['memory']['ram_total_gb'] > 0
    assert any('CUDA недоступна' in w for w in diagnose.warnings(data))
    assert diagnose.main(['diagnose.py']) == 0 and 'ПРЕДУПРЕЖДЕНИЯ' in capsys.readouterr().out
    assert (cfg.diagnostics / 'cloudcompute-report.txt').exists()

def test_gpu_check_paths(monkeypatch):
    monkeypatch.setattr(diagnose, 'gpu_info', lambda: {'cuda_available': False, 'error': 'x'})
    assert diagnose.gpu_check() == 3
    good = {'cuda_available': True, 'gpu_name': 'RTX 5060 Ti', 'sm': 'sm_120', 'vram_available_mb': 15000, 'vram_total_mb': 16000,
            'torch_version': '2.10.0', 'torch_cuda': '12.8', 'arch_list': ['sm_120'], 'arch_supported': True}
    monkeypatch.setattr(diagnose, 'gpu_info', lambda: good)
    monkeypatch.setattr(diagnose, 'smoke_test', lambda: True)
    assert diagnose.gpu_check() == 0
    monkeypatch.setattr(diagnose, 'gpu_info', lambda: {**good, 'arch_supported': False})
    assert diagnose.gpu_check() == 3
    def boom():raise RuntimeError('CUDA error: no kernel image is available for execution on the device')
    monkeypatch.setattr(diagnose, 'gpu_info', lambda: good)
    monkeypatch.setattr(diagnose, 'smoke_test', boom)
    assert diagnose.gpu_check() == 3

def test_model_load_time_from_engine_memory_log(tmp_path):
    cfg = launcher.Config(env_for(tmp_path));launcher.prepare(cfg)
    rows = [{'phase': 'before_model_load', 'job_id': 'j', 'time_unix': 100.0}, {'phase': 'after_model_load', 'job_id': 'j', 'time_unix': 142.5}]
    (cfg.diagnostics / 'memory.jsonl').write_text(''.join(json.dumps(r) + '\n' for r in rows))
    assert diagnose.model_load_seconds(cfg) == 42.5

# ---------------------------------------------------------------- shell scripts, Docker files
def bash(script, tmp_path, **extra):
    env = {'PATH': os.environ['PATH'], 'HOME': str(tmp_path), 'YOISAKI_DATA_ROOT': str(tmp_path / 'data'), **extra}
    return subprocess.run(['bash', '-c', f'source "{APP}/cloudcompute/lib.sh"; {script}'], env=env, capture_output=True, text=True)

def test_config_file_is_parsed_not_executed(tmp_path):
    (tmp_path / 'data/config').mkdir(parents=True)
    (tmp_path / 'data/config/yoisaki.env').write_text(f'YOISAKI_WARMUP_CHECKPOINT="a.safetensors"\r\nYOISAKI_TOKEN={"d"*64}\nHF_TOKEN=hf_x\nEVIL=$(touch {tmp_path}/pwned)\n$(touch {tmp_path}/pwned2)\n# c\n')
    r = bash('yoisaki_load_config; echo "W=$YOISAKI_WARMUP_CHECKPOINT T=${YOISAKI_TOKEN:-none} H=$HF_TOKEN"', tmp_path)
    assert 'W=a.safetensors T=none H=hf_x' in r.stdout
    assert not (tmp_path / 'pwned').exists() and not (tmp_path / 'pwned2').exists()
    r = bash('yoisaki_load_config; echo "W=$YOISAKI_WARMUP_CHECKPOINT"', tmp_path, YOISAKI_WARMUP_CHECKPOINT='shell.safetensors')
    assert 'W=shell.safetensors' in r.stdout  # shell values take precedence

def test_mode_selection_and_dirs(tmp_path):
    r = bash('YOISAKI_MODE=native yoisaki_mode; YOISAKI_IN_IMAGE=1 YOISAKI_MODE=docker yoisaki_mode; yoisaki_prepare_dirs; ls "$YOISAKI_DATA_ROOT/models"', tmp_path)
    assert r.stdout.split() == ['native', 'native', 'checkpoints', 'controlnet', 'loras', 'vae']
    assert bash('YOISAKI_MODE=bogus yoisaki_mode', tmp_path).returncode != 0

def test_redaction():
    out = subprocess.run(['bash', '-c', f'source "{APP}/cloudcompute/lib.sh"; printf "%s\\n" "https://a.trycloudflare.com/#token={"e"*64}" "Authorization: Bearer abc.def" | yoisaki_redact'], capture_output=True, text=True).stdout
    assert 'e' * 64 not in out and 'abc.def' not in out and out.count('[СКРЫТО]') == 2

def test_stop_without_running_engine_is_safe(tmp_path):
    data = tmp_path / 'data'
    weights = safetensors(data / 'models/checkpoints/keep.safetensors')
    (data / 'outputs').mkdir(parents=True);(data / 'outputs/result.png').write_bytes(b'png')
    r = subprocess.run(['bash', str(APP / 'stop-cloudcompute.sh')], env={'PATH': '/usr/bin:/bin', 'YOISAKI_DATA_ROOT': str(data)}, capture_output=True, text=True)
    assert r.returncode == 0 and 'не был запущен' in r.stdout and 'НЕ останавливает оплату' in r.stdout
    assert weights.exists() and (data / 'outputs/result.png').exists()

def test_pins_are_consistent():
    lib = (APP / 'cloudcompute/lib.sh').read_text();docker = (APP / 'Dockerfile').read_text()
    for key in ('CLOUDFLARED_VERSION', 'CLOUDFLARED_SHA256'):
        assert re.search(rf'^{key}=(\S+)', lib, re.M).group(1) == re.search(rf'ARG {key}=(\S+)', docker).group(1)
    req = (APP / 'cloudcompute/requirements-cloud.txt').read_text()
    assert 'torch==2.10.0' in req and 'torchvision==0.25.0' in req
    assert 'torch' not in re.sub(r'#.*', '', (APP / 'engine/requirements.txt').read_text()).split()  # Colab keeps its own torch
    assert (APP / 'cloudcompute/VERSION').read_text().strip() == '1.7.7'
    assert 'yoisaki-engine:1.7.7-cloudcompute' in lib and 'yoisaki-engine:1.7.7-cloudcompute' in (APP / 'docker-compose.yml').read_text()

def test_dockerfile_policies():
    docker = (APP / 'Dockerfile').read_text()
    assert re.search(r'^FROM nvidia/cuda:12\.8\.\d+-base-ubuntu24\.04@sha256:[a-f0-9]{64}$', docker, re.M)
    assert 'USER 1000:1000' in docker and 'HEALTHCHECK' in docker and 'tini' in docker and 'sha256sum -c' in docker
    for word in ('safetensors', 'snapshot_download', 'hf_hub_download', 'huggingface-cli', '.ckpt'):
        assert word not in re.sub(r'#.*', '', docker), word  # no model weights in the image
    ignore = (APP / '.dockerignore').read_text().splitlines()
    assert '*' in ignore and '!engine/' in ignore and '!cloudcompute/' in ignore and '!colab/' not in ignore

def test_compose_policies():
    compose = (APP / 'docker-compose.yml').read_text()
    # 1.7.2: read-only by default; start-cloudcompute.sh mounts it rw only while Drive sync is enabled (test_v172_drive_sync.py).
    assert 'ports:' not in compose and 'restart: "no"' in compose and '/models:/data/models:${YOISAKI_MODELS_MOUNT:-ro}' in compose
    assert 'read_only: true' in compose and 'no-new-privileges:true' in compose and 'cap_drop: [ALL]' in compose
    assert not re.search(r'(TOKEN|SECRET|PASSWORD)\s*:\s*\S', compose.replace('HF_TOKEN:\n', '').replace('CIVITAI_TOKEN:\n', ''))

# ---------------------------------------------------------------- Google Colab compatibility
def test_notebook_package_is_byte_identical_to_engine():
    nb = json.loads(next((APP / 'colab').glob('YOISAKI_ENGINE_V1.7.0_*.ipynb')).read_text())
    source = ''.join(nb['cells'][2]['source'])
    raw = base64.b64decode(re.search(r"_PACKAGE = '([A-Za-z0-9+/=]+)'", source).group(1))
    assert hashlib.sha256(raw).hexdigest() == re.search(r"_EXPECTED = '([a-f0-9]{64})'", source).group(1)
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        names = [i.filename for i in z.infolist() if not i.is_dir()]
        for name in names:
            assert z.read(name) == (APP / 'engine' / name).read_bytes(), name
    assert len(names) == 25 and not any('cloudcompute' in n for n in names)
    text = json.dumps(nb)
    assert 'cloudcompute' not in text.lower()  # no CloudCompute import or path on the Colab startup path

def test_engine_files_match_current_package_manifest():
    manifest = json.loads((APP / 'package-manifest.json').read_text())
    engine = {k: v for k, v in manifest.items() if k.startswith('engine/')}
    assert len(engine) == 25
    for name, digest in engine.items():
        assert hashlib.sha256((APP / name).read_bytes()).hexdigest() == digest, name
