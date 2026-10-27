"""v1.7.3 CloudCompute side of the one-click connection: stable engine token, Named Tunnel mode, tunnel retries that
keep the engine alive, signed address publication, /inventory and selective Drive sync.
No real GPU, Cloudflare, ntfy or Google here: cloudflared is a stub script, HTTP publication uses a stub opener."""
import importlib.util, json, os, shutil, stat, struct, subprocess, sys, time, types
from pathlib import Path
import pytest

APP = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP / 'cloudcompute'))
sys.path.insert(0, str(APP / 'engine'))
import launcher  # noqa: E402
import rendezvous  # noqa: E402
import inventory  # noqa: E402
from test_v172_drive_sync import env, model, run, by_path, needs_rclone, needs_fastapi  # noqa: E402,F401


def cfg_for(tmp_path, **extra):
    environ = {'YOISAKI_DATA_ROOT': str(tmp_path / 'data'), 'YOISAKI_ENGINE_DIR': str(APP / 'engine'), **extra}
    cfg = launcher.Config(environ)
    launcher.prepare(cfg)
    return cfg


def safetensors(path, keys, meta=None):
    path.parent.mkdir(parents=True, exist_ok=True)
    head = json.dumps({'__metadata__': meta or {}, **{k: {'dtype': 'F32', 'shape': [1], 'data_offsets': [0, 4]} for k in keys}}).encode()
    path.write_bytes(struct.pack('<Q', len(head)) + head + b'1234')
    return path


# ------------------------------------------------------------------ stable token
def test_stable_token_survives_restarts_and_rotation_revokes_it(tmp_path):
    cfg = cfg_for(tmp_path, YOISAKI_STABLE_LINK='1')
    first = launcher.engine_token(cfg)
    assert launcher.TOKEN_RE.match(first) and launcher.engine_token(cfg) == first
    path = cfg.secrets / 'engine.token'
    assert stat.S_IMODE(path.stat().st_mode) == 0o600 and stat.S_IMODE(cfg.secrets.stat().st_mode) == 0o700
    launcher.rotate_token(cfg)
    rotated = launcher.engine_token(cfg)
    assert rotated != first and launcher.TOKEN_RE.match(rotated)
    path.write_text('not-a-token\n')  # damaged file: replaced, never used
    assert launcher.engine_token(cfg) not in ('not-a-token', rotated)


def test_default_keeps_the_old_per_start_token(tmp_path):
    for cfg in (cfg_for(tmp_path), cfg_for(tmp_path, YOISAKI_STABLE_LINK='0')):
        assert launcher.engine_token(cfg) != launcher.engine_token(cfg)
        assert not (cfg.secrets / 'engine.token').exists()


def test_rotate_token_cli(tmp_path):
    env_ = {**os.environ, 'YOISAKI_DATA_ROOT': str(tmp_path / 'data'), 'YOISAKI_ENGINE_DIR': str(APP / 'engine'), 'YOISAKI_STABLE_LINK': '1'}
    cfg = cfg_for(tmp_path, YOISAKI_STABLE_LINK='1')
    before = launcher.engine_token(cfg)
    out = subprocess.run([sys.executable, str(APP / 'cloudcompute/launcher.py'), 'rotate-token'], env=env_, capture_output=True, text=True)
    assert out.returncode == 0 and 'перезапуска' in out.stdout and before not in out.stdout
    assert launcher.engine_token(cfg) != before


# ------------------------------------------------------------------ configuration
@pytest.mark.parametrize('extra,message', [
    ({'YOISAKI_TUNNEL_MODE': 'magic'}, 'quick или named'),
    ({'YOISAKI_TUNNEL_MODE': 'named'}, 'YOISAKI_PUBLIC_HOSTNAME'),
    ({'YOISAKI_TUNNEL_MODE': 'named', 'YOISAKI_PUBLIC_HOSTNAME': 'http://x'}, 'YOISAKI_PUBLIC_HOSTNAME'),
])
def test_tunnel_mode_validation(tmp_path, extra, message):
    with pytest.raises(launcher.LaunchError, match=message):
        launcher.Config({'YOISAKI_DATA_ROOT': str(tmp_path), **extra})


def test_named_mode_is_accepted_and_tunnel_off_needs_no_hostname(tmp_path):
    cfg = launcher.Config({'YOISAKI_DATA_ROOT': str(tmp_path), 'YOISAKI_TUNNEL_MODE': 'named', 'YOISAKI_PUBLIC_HOSTNAME': 'GPU.Example.com.'})
    assert cfg.tunnel_mode == 'named' and cfg.public_hostname == 'gpu.example.com'
    assert launcher.Config({'YOISAKI_DATA_ROOT': str(tmp_path), 'YOISAKI_TUNNEL': '0', 'YOISAKI_TUNNEL_MODE': 'named'}).tunnel is False


# ------------------------------------------------------------------ Named Tunnel
def test_named_tunnel_uses_fixed_hostname_and_keeps_its_token_out_of_argv(tmp_path, monkeypatch):
    stub = tmp_path / 'cloudflared'
    record = tmp_path / 'record.json'
    stub.write_text(f'#!{sys.executable}\nimport json,os,sys,time\n'
                    f'json.dump({{"argv":sys.argv[1:],"token":os.environ.get("TUNNEL_TOKEN")}},open({str(record)!r},"w"))\n'
                    'print("INF Registered tunnel connection", flush=True)\ntime.sleep(300)\n')
    stub.chmod(0o755)
    cfg = cfg_for(tmp_path, YOISAKI_CLOUDFLARED=str(stub), YOISAKI_TUNNEL_MODE='named', YOISAKI_PUBLIC_HOSTNAME='gpu.example.com',
                  YOISAKI_TUNNEL_TIMEOUT='10')
    run_ = launcher.Launcher(cfg)
    run_.token = 'c' * 64
    with pytest.raises(launcher.LaunchError, match='Нет токена Named Tunnel'):
        run_.start_tunnel()
    secret = 'eyJhIjoiTEVTVC1PTkxZIn0' + 'A' * 40
    launcher.write_private(cfg.secrets / 'cloudflared.token', secret + '\n')
    seen = []
    monkeypatch.setattr(launcher, 'verify_tunnel', lambda base, token: seen.append(base) or True)
    try:
        run_.start_tunnel()
        assert run_.url == 'https://gpu.example.com' and seen == ['https://gpu.example.com']
        assert (cfg.state / 'link.txt').read_text().strip() == 'https://gpu.example.com/#token=' + 'c' * 64
        for _ in range(50):
            if record.exists() and record.read_text():
                break
            time.sleep(0.1)
        rec = json.loads(record.read_text())
        assert rec['token'] == secret and secret not in ' '.join(rec['argv']) and rec['argv'][-1] == 'run'
    finally:
        run_.stop_tunnel()


# ------------------------------------------------------------------ resilience
class FakeClock:
    def __init__(self):
        self.now = 1000.0
    def monotonic(self):
        return self.now
    def sleep(self, s):
        self.now += s
    def time(self):
        return self.now


def test_tunnel_failures_keep_the_engine_running_and_back_off(tmp_path, monkeypatch):
    cfg = cfg_for(tmp_path, YOISAKI_TUNNEL_RESTARTS='2')
    clock = FakeClock()
    monkeypatch.setattr(launcher, 'time', types.SimpleNamespace(monotonic=clock.monotonic, sleep=clock.sleep, time=clock.time,
                                                                strftime=time.strftime))
    run_ = launcher.Launcher(cfg)
    run_.token = 'c' * 64
    run_.server = type('Alive', (), {'poll': lambda self: None, 'pid': 0})()
    attempts = []

    def failing():
        attempts.append(clock.now)
        if len(attempts) == 5:
            run_.stopping = True
        raise launcher.LaunchError('test: cloudflare unreachable')
    run_.start_tunnel = failing
    run_.supervise()  # must return normally: the engine is never stopped because of the tunnel
    gaps = [round(b - a) for a, b in zip(attempts, attempts[1:])]
    assert gaps[0] <= 5 and gaps[1] >= 15 and gaps[2] >= 30 and gaps[3] >= 60, gaps
    state = json.loads((cfg.state / 'launcher.json').read_text())
    assert state['phase'] == 'TUNNEL_RETRY' and 'cloudflare unreachable' in state['tunnel_error']


def test_quick_tunnel_waits_before_the_first_dns_lookup(tmp_path, monkeypatch):
    stub = tmp_path / 'cloudflared'
    stub.write_text('#!/bin/sh\necho "INF |  https://calm-fox-$$.trycloudflare.com  |"\nexec sleep 300\n')
    stub.chmod(0o755)
    cfg = cfg_for(tmp_path, YOISAKI_CLOUDFLARED=str(stub), YOISAKI_TUNNEL_TIMEOUT='20', YOISAKI_TUNNEL_DNS_DELAY='2')
    calls = []
    monkeypatch.setattr(launcher, 'verify_tunnel', lambda base, token: calls.append(time.monotonic()) or True)
    run_ = launcher.Launcher(cfg)
    run_.token = 'c' * 64
    started = time.monotonic()
    try:
        run_.start_tunnel()
        assert calls and calls[0] - started >= 1.9
    finally:
        run_.stop_tunnel()


# ------------------------------------------------------------------ signed address publication
def test_rendezvous_records_match_the_website_implementation():
    if shutil.which('node') is None:
        pytest.skip('Node.js not installed')
    token, url, ts = 'ab' * 32, 'https://calm-fox-1.trycloudflare.com', 1800000000
    js = subprocess.run(['node', '--input-type=module', '-e',
                         "import {topicFor,sign} from './server/rendezvous.mjs';const [t,u,s]=process.argv.slice(1);"
                         "console.log(JSON.stringify([topicFor(t),sign(t,u,Number(s))]))", token, url, str(ts)],
                        cwd=APP, capture_output=True, text=True)
    assert js.returncode == 0, js.stderr
    assert json.loads(js.stdout) == [rendezvous.topic_for(token), rendezvous.sign(token, url, ts)]


def test_publish_sends_signed_record_without_the_token():
    sent = {}

    class Resp:
        status = 200
        def __enter__(self):
            return self
        def __exit__(self, *a):
            return False

    def opener(req, timeout):
        sent.update(url=req.full_url, body=req.data.decode(), timeout=timeout)
        return Resp()
    token = 'ef' * 32
    assert rendezvous.publish(token, 'https://a-b.trycloudflare.com', opener=opener)
    rec = json.loads(sent['body'])
    assert sent['url'] == 'https://ntfy.sh/' + rendezvous.topic_for(token) and token not in sent['body'] + sent['url']
    assert rec['sig'] == rendezvous.sign(token, rec['url'], rec['ts'])
    with pytest.raises(ValueError):
        rendezvous.publish(token, 'https://x', host='evil.com/@x', opener=opener)


def test_announce_only_with_rendezvous_and_stable_token(tmp_path, monkeypatch):
    published = []
    monkeypatch.setattr(rendezvous, 'publish', lambda token, url, host='ntfy.sh': published.append((url, host)))
    for extra, expected in [({}, 0), ({'YOISAKI_RENDEZVOUS': 'ntfy'}, 0),
                            ({'YOISAKI_RENDEZVOUS': 'ntfy', 'YOISAKI_STABLE_LINK': '1'}, 1)]:
        published.clear()
        run_ = launcher.Launcher(cfg_for(tmp_path, **extra))
        run_.token, run_.url = 'c' * 64, 'https://x-y.trycloudflare.com'
        run_.announce()
        assert len(published) == expected, extra


# ------------------------------------------------------------------ inventory
def test_inventory_revision_and_compact_listing(tmp_path):
    root = tmp_path / 'models'
    safetensors(root / 'checkpoints/wai.safetensors', ['conditioner.embedders.1.w', 'model.diffusion_model.w'], {'blob': 'x' * 10000})
    safetensors(root / 'loras/Amber_Nova.safetensors', ['lora_te2_x.w'], {'ss_base_model_version': 'sdxl_base_v1-0', 'ss_tag_frequency': '{"a":1}'})
    first = inventory.revision(root)
    (root / 'loras/Vesper_Nova.safetensors').write_bytes(b'\x00' * 7)  # truncated copy
    second = inventory.revision(root)
    assert first != second and len(second) == 32
    models = {m['name']: m for m in inventory.compact(root)}
    assert models['Amber_Nova.safetensors']['compatible'] is True and models['Amber_Nova.safetensors']['base_model'] == 'sdxl_base_v1-0'
    vesper = models['Vesper_Nova.safetensors']
    assert vesper['compatible'] is False and vesper['architecture'] == 'invalid' and 'Повреждён' in vesper['detail']
    assert all('metadata' not in m for m in models.values())
    assert inventory.revision(root) == second  # stable when nothing changes


@needs_fastapi
def test_inventory_route_requires_the_engine_token(env):
    from fastapi.testclient import TestClient
    import serve_cloud
    token = 'f' * 64
    model(env.models / 'loras/Amber_Nova.safetensors', 'lora')
    client = TestClient(serve_cloud.build(str(env.models), token, env.environ))
    assert client.get('/inventory').status_code == 401
    assert client.get('/inventory', headers={'Authorization': 'Bearer ' + 'e' * 64}).status_code == 401
    ok = client.get('/inventory', headers={'Authorization': 'Bearer ' + token}).json()
    assert set(ok) == {'revision'}
    full = client.get('/inventory?models=1', headers={'Authorization': 'Bearer ' + token}).json()
    assert [m['name'] for m in full['models']] == ['Amber_Nova.safetensors'] and full['revision'] == ok['revision']


def test_serve_cloud_started_by_hand_explains_instead_of_keyerror(tmp_path):
    env_ = {k: v for k, v in os.environ.items() if not k.startswith('YOISAKI_')}
    env_['PYTHONPATH'] = str(APP / 'engine')
    out = subprocess.run([sys.executable, str(APP / 'cloudcompute/serve_cloud.py')], env=env_, capture_output=True, text=True, timeout=120)
    if 'No module named' in out.stderr:
        pytest.skip('engine dependencies not installed')
    assert out.returncode != 0 and 'start-cloudcompute.sh' in out.stderr and 'KeyError' not in out.stderr


def test_models_report_explains_hidden_models(tmp_path):
    cfg = cfg_for(tmp_path)
    (cfg.models / 'loras/Vesper_Nova.safetensors').write_bytes(b'\x00' * 7)
    safetensors(cfg.models / 'loras/Old.safetensors', ['lora_unet_x.w'], {'ss_base_model_version': 'sd_v1'})
    env_ = {**os.environ, 'YOISAKI_DATA_ROOT': str(cfg.data), 'YOISAKI_ENGINE_DIR': str(APP / 'engine')}
    out = subprocess.run([sys.executable, str(APP / 'cloudcompute/models_report.py')], env=env_, capture_output=True, text=True)
    assert out.returncode == 0, out.stderr
    assert 'Vesper_Nova.safetensors: НЕСОВМЕСТИМА' in out.stdout and 'ошибка чтения' in out.stdout
    assert 'Old.safetensors: НЕСОВМЕСТИМА' in out.stdout and 'sd_v1' in out.stdout


# ------------------------------------------------------------------ selective Drive sync
@needs_rclone
def test_selected_paths_only_are_downloaded(env):
    model(env.drive / 'loras/Amber_Nova.safetensors', 'lora')
    model(env.drive / 'loras/Vesper_Nova.safetensors', 'lora')
    model(env.drive / 'checkpoints/wai.safetensors', 'checkpoint')
    service = env.service()
    assert service.status()['selective'] is True
    run(service, 'check')
    service.start('sync', ['loras/Amber_Nova.safetensors', 'loras/not-on-drive.safetensors'])
    service.wait(60)
    snap = service.status()
    assert by_path(snap)['loras/Amber_Nova.safetensors']['state'] == 'INSTALLED'
    assert by_path(snap)['loras/Vesper_Nova.safetensors']['state'] == 'MISSING'
    assert (env.models / 'loras/Amber_Nova.safetensors').exists() and not (env.models / 'loras/Vesper_Nova.safetensors').exists()
    with pytest.raises(Exception):
        service.start('check', ['loras/Amber_Nova.safetensors'])  # a selection only makes sense for sync


@needs_rclone
@needs_fastapi
def test_sync_start_route_accepts_an_optional_selection(env):
    from fastapi.testclient import TestClient
    import serve_cloud
    token = 'f' * 64
    model(env.drive / 'loras/A.safetensors', 'lora')
    model(env.drive / 'loras/B.safetensors', 'lora')
    app = serve_cloud.build(str(env.models), token, env.environ)
    client = TestClient(app)
    auth = {'Authorization': 'Bearer ' + token}
    assert client.post('/sync/check', headers=auth).status_code == 200
    for _ in range(100):
        if client.get('/sync/status', headers=auth).json()['job']['state'] != 'RUNNING':
            break
        time.sleep(0.1)
    for bad in ({'paths': 'loras/B.safetensors'}, {'paths': []}, {'paths': [1]}):
        assert client.post('/sync/start', headers=auth, json=bad).status_code == 422, bad
    assert client.post('/sync/start', headers=auth, json={'paths': ['loras/B.safetensors']}).status_code == 200
    for _ in range(100):
        snap = client.get('/sync/status', headers=auth).json()
        if snap['job']['state'] != 'RUNNING':
            break
        time.sleep(0.1)
    assert by_path(snap)['loras/B.safetensors']['state'] == 'INSTALLED' and by_path(snap)['loras/A.safetensors']['state'] == 'MISSING'
