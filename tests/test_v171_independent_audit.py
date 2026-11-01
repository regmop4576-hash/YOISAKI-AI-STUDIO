"""Independent audit regressions. No external network or real credentials required."""
import io
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
from unittest.mock import patch
import pytest

APP = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP / 'cloudcompute'))
import launcher
import fetch_models

@pytest.mark.parametrize('failed_step', ['requirements-cloud.txt', 'engine/requirements.txt', 'pip check'])
def test_cc001_failed_install_never_writes_success_marker(tmp_path, failed_step):
    data = tmp_path / 'data'
    py = data / 'runtime/venv/bin/python'
    py.parent.mkdir(parents=True)
    py.write_text('#!/bin/bash\ncase "$*" in\n  *"' + failed_step + '"*) echo INTENTIONAL_FAILURE; exit 23;;\nesac\nexit 0\n')
    py.chmod(0o755)
    # Execute the actual function unchanged, with only the OS/interpreter probes replaced.
    script = (APP / 'cloudcompute/install-native.sh').read_text().split('[[ $(uname -m)')[0]
    script = script.replace('source "$(dirname -- "${BASH_SOURCE[0]}")/lib.sh"', 'source "$AUDIT_APP/cloudcompute/lib.sh"')
    script += '\npick_python() { echo "$AUDIT_PY"; }\ndf() { printf "Filesystem 1024-blocks Used Available Capacity Mounted\\nx 999999999 0 999999999 0%% /\\n"; }\ninstall_venv\n'
    result = subprocess.run(['bash', '-c', script], env={**os.environ, 'AUDIT_APP': str(APP), 'AUDIT_PY': str(py), 'YOISAKI_DATA_ROOT': str(data)}, capture_output=True, text=True)
    assert result.returncode != 0, 'installer incorrectly returned success after ' + failed_step
    assert not (data / 'runtime/venv/.yoisaki-install').exists()

@pytest.mark.parametrize('last_line', ['CIVITAI_TOKEN=', 'YOISAKI_MODE=auto'])
def test_cc002_existing_env_override_does_not_abort_config(tmp_path, last_line):
    config = tmp_path / 'config'
    config.mkdir()
    (config / 'yoisaki.env').write_text(last_line + '\n')
    env = {**os.environ, 'YOISAKI_DATA_ROOT': str(tmp_path), 'CIVITAI_TOKEN': 'TEST_ONLY', 'YOISAKI_MODE': 'native'}
    result = subprocess.run(['bash', '-c', 'set -e; source "$1/cloudcompute/lib.sh"; yoisaki_load_config; echo CONFIG_OK', 'audit', str(APP)], env=env, capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    assert 'CONFIG_OK' in result.stdout

@pytest.mark.parametrize('host,key,allowed', [
    ('civitai.com','CIVITAI_TOKEN',True), ('api.civitai.com','CIVITAI_TOKEN',True),
    ('notcivitai.com','CIVITAI_TOKEN',False), ('civitai.com.example.org','CIVITAI_TOKEN',False),
    ('huggingface.co','HF_TOKEN',True), ('cdn.huggingface.co','HF_TOKEN',True),
    ('nothuggingface.co','HF_TOKEN',False), ('huggingface.co.example.org','HF_TOKEN',False)])
def test_cc003_download_auth_requires_domain_boundary(monkeypatch, host, key, allowed):
    monkeypatch.setenv(key, 'AUDIT_PLACEHOLDER')
    with patch.object(fetch_models.urllib.request, 'urlopen', return_value=io.BytesIO()) as opened:
        fetch_models.open_url('https://' + host + '/weights')
    request = opened.call_args.args[0]
    assert bool(request.get_header('Authorization')) is allowed


def test_cc004_negative_tunnel_health_triggers_restart(tmp_path, monkeypatch):
    cfg = launcher.Config({'YOISAKI_DATA_ROOT': str(tmp_path)})
    launcher.prepare(cfg)
    run = launcher.Launcher(cfg)
    run.server = run.tunnel = type('Alive', (), {'poll': lambda self: None, 'pid': 123})()
    count = [0]
    def tick(_):
        count[0] += 1
        if count[0] > 100:
            run.stopping = True
    monkeypatch.setattr(launcher.time, 'sleep', tick)
    monkeypatch.setattr(launcher, 'verify_tunnel', lambda *_: False)
    stopped, restarted = [], []
    monkeypatch.setattr(run, 'stop_tunnel', lambda: stopped.append(True))
    def start():
        restarted.append(True)
        run.stopping = True
    monkeypatch.setattr(run, 'start_tunnel', start)
    run.supervise()
    assert stopped == [True] and restarted == [True]


def test_cc005_truncated_tensor_payload_not_published(tmp_path):
    cfg = launcher.Config({'YOISAKI_DATA_ROOT': str(tmp_path)})
    launcher.prepare(cfg)
    head = json.dumps({'lora_te2_test': {'dtype': 'F32', 'shape': [16], 'data_offsets': [0,64]}}).encode()
    final = cfg.models / 'loras/truncated.safetensors'
    part = final.with_name(final.name + '.part')
    part.write_bytes(struct.pack('<Q',len(head)) + head + b'1234')
    with pytest.raises(fetch_models.FetchError):
        fetch_models.finish(part, final, 'lora', cfg)
    assert not final.exists()


def test_cc005_complete_tensor_payload_still_published(tmp_path):
    cfg = launcher.Config({'YOISAKI_DATA_ROOT': str(tmp_path)})
    launcher.prepare(cfg)
    head = json.dumps({'lora_te2_test': {'dtype': 'F32', 'shape': [1], 'data_offsets': [0,4]}}).encode()
    final = cfg.models / 'loras/complete.safetensors'
    part = final.with_name(final.name + '.part')
    part.write_bytes(struct.pack('<Q',len(head)) + head + b'1234')
    fetch_models.finish(part, final, 'lora', cfg)
    assert final.exists() and not part.exists()


def test_native_install_cache_reused_on_second_and_third_start(tmp_path):
    data = tmp_path / 'data'
    py = data / 'runtime/venv/bin/python'
    py.parent.mkdir(parents=True)
    py.write_text('#!/bin/bash\nprintf "%s\\n" "$*" >> "$AUDIT_CALLS"\nexit 0\n')
    py.chmod(0o755)
    script = (APP / 'cloudcompute/install-native.sh').read_text().split('[[ $(uname -m)')[0]
    script = script.replace('source "$(dirname -- "${BASH_SOURCE[0]}")/lib.sh"', 'source "$AUDIT_APP/cloudcompute/lib.sh"')
    script += '\npick_python() { echo "$AUDIT_PY"; }\ndf() { printf "Filesystem 1024-blocks Used Available Capacity Mounted\\nx 999999999 0 999999999 0%% /\\n"; }\ninstall_venv\n'
    calls = tmp_path / 'calls.txt'
    env = {**os.environ,'AUDIT_APP':str(APP),'AUDIT_PY':str(py),'AUDIT_CALLS':str(calls),'YOISAKI_DATA_ROOT':str(data)}
    for attempt in range(3):
        result = subprocess.run(['bash','-c',script],env=env,capture_output=True,text=True)
        assert result.returncode == 0, result.stderr
        assert calls.read_text().count('-m pip install') == 2
        if attempt:
            assert 'переустановка не нужна' in result.stdout


def test_real_server_three_starts_crash_and_token_rotation(tmp_path):
    pytest.importorskip('torch')
    import signal
    import socket
    from test_v171_cloudcompute import fake_gpu_engine, env_for, wait, safetensors
    engine = fake_gpu_engine(tmp_path)
    with socket.socket() as s:
        s.bind(('127.0.0.1',0)); port=s.getsockname()[1]
    env = {**os.environ, **env_for(tmp_path, YOISAKI_ENGINE_DIR=str(engine),YOISAKI_TUNNEL='0',YOISAKI_GPU_PREFLIGHT='0',YOISAKI_PORT=str(port))}
    state = tmp_path/'data/runtime/state'
    weights = safetensors(tmp_path/'data/models/checkpoints/preserve.safetensors')
    original = weights.read_bytes()
    tokens = []
    marker = None
    for attempt in range(3):
        proc = subprocess.Popen([sys.executable,str(APP/'cloudcompute/launcher.py'),'run'],env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
        try:
            assert wait(lambda:(state/'launcher.json').exists() and json.loads((state/'launcher.json').read_text()).get('phase')=='READY',timeout=40)
            row = json.loads((state/'launcher.json').read_text())
            tokens.append((state/'token').read_text())
            now = (tmp_path/'data/.yoisaki-data-id').read_bytes()
            if marker is None:marker=now
            assert now==marker and weights.read_bytes()==original
            if attempt==1:os.kill(row['children'][0],signal.SIGKILL)
            else:proc.send_signal(signal.SIGTERM)
            out,_=proc.communicate(timeout=40)
            assert proc.returncode == (3 if attempt==1 else 0),out
            assert not (state/'token').exists() and not (state/'link.txt').exists()
            assert json.loads((state/'launcher.json').read_text())['phase']=='STOPPED'
        finally:
            if proc.poll() is None:
                proc.terminate();proc.wait(timeout=40)
    assert len(set(tokens))==3


def test_busy_port_does_not_report_ready_or_kill_owner(tmp_path):
    pytest.importorskip('torch')
    import socket
    from test_v171_cloudcompute import fake_gpu_engine,env_for
    with socket.socket() as listener:
        listener.bind(('127.0.0.1',0));listener.listen()
        port=listener.getsockname()[1]
        env={**os.environ,**env_for(tmp_path,YOISAKI_ENGINE_DIR=str(fake_gpu_engine(tmp_path)),YOISAKI_TUNNEL='0',YOISAKI_GPU_PREFLIGHT='0',YOISAKI_PORT=str(port),YOISAKI_SERVER_TIMEOUT='8')}
        result=subprocess.run([sys.executable,str(APP/'cloudcompute/launcher.py'),'run'],env=env,capture_output=True,text=True,timeout=30)
        assert result.returncode==3
        state=tmp_path/'data/runtime/state'
        assert not (state/'token').exists()
        assert json.loads((state/'launcher.json').read_text())['phase']=='STOPPED'
        assert listener.getsockname()[1]==port

