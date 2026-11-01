"""v1.7.5 automatic initialization on the GPU side: autostart-image.sh (real bash, fake interpreter), signed stages
of the launcher, the hash-pinned image lock and the image policies. No network, no GPU, no real credentials."""
import json
import os
import re
import signal
import stat
import subprocess
import sys
import time
from pathlib import Path

import pytest

APP = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP / 'cloudcompute'))
import check_lock  # noqa: E402
import launcher  # noqa: E402
import rendezvous  # noqa: E402

AUTOSTART = APP / 'cloudcompute/autostart-image.sh'
TOKEN = 'a' * 64

FAKE_PY = r'''#!/bin/bash
# Stand-in for the image venv python: records what autostart-image.sh asks for.
{
  printf 'CALL %s' "$*"
  printf ' STABLE=%s RDV=%s DATA=%s' "${YOISAKI_STABLE_LINK:-}" "${YOISAKI_RENDEZVOUS:-}" "${YOISAKI_DATA_ROOT:-}"
  [ -f "${YOISAKI_DATA_ROOT}/config/engine/engine.token" ] && printf ' TOKEN=%s' "$(cat "${YOISAKI_DATA_ROOT}/config/engine/engine.token")"
  printf '\n'
} >> "$FAKE_LOG"
case "$*" in
  *launcher.py\ run*)  # like launcher.py: SIGTERM stops it together with its children
    trap 'kill "$child" 2>/dev/null; exit 0' TERM
    sleep "${FAKE_RUN_SLEEP:-0}" & child=$!
    wait "$child"
    exit "${FAKE_RUN_EXIT:-0}" ;;
esac
exit 0
'''


@pytest.fixture
def env(tmp_path):
    app = tmp_path / 'app'
    (app / 'cloudcompute').mkdir(parents=True)
    py = tmp_path / 'python'
    py.write_text(FAKE_PY)
    py.chmod(0o755)
    data = tmp_path / 'data'
    return {
        'PATH': os.environ['PATH'], 'HOME': str(tmp_path), 'YOISAKI_APP_DIR': str(app), 'YOISAKI_PYTHON': str(py),
        'YOISAKI_DATA_ROOT': str(data), 'FAKE_LOG': str(tmp_path / 'calls.log'),
        'YOISAKI_RUN_UID': str(os.getuid()), 'YOISAKI_RUN_GID': str(os.getgid()),
        'YOISAKI_AUTOSTART_DELAY': '0', 'YOISAKI_AUTOSTART_POLL': '0.2',
    }


def calls(env):
    path = Path(env['FAKE_LOG'])
    return path.read_text().splitlines() if path.exists() else []


def wait_for(fn, timeout=15):
    end = time.time() + timeout
    while time.time() < end:
        value = fn()
        if value:
            return value
        time.sleep(0.1)
    raise AssertionError('timeout')


def provisioned_files(env, token=TOKEN):
    secrets = Path(env['YOISAKI_DATA_ROOT']) / 'config/engine'
    secrets.mkdir(parents=True, exist_ok=True)
    (secrets / 'engine.token').write_text(token + '\n')
    (secrets / 'autostart.json').write_text('{"version": 1, "stable_link": true, "rendezvous": "ntfy"}\n')


def test_without_provisioning_behaves_like_174(env):
    r = subprocess.run(['bash', str(AUTOSTART)], env={**env, 'FAKE_RUN_EXIT': '5'}, capture_output=True, text=True, timeout=30)
    assert r.returncode == 5  # no automatic restart, exit code of the launcher
    lines = calls(env)
    assert len(lines) == 1 and 'launcher.py run' in lines[0] and 'STABLE= RDV=' in lines[0]
    assert not any('rendezvous.py' in line for line in lines)


def test_invalid_provision_token_writes_nothing(env):
    r = subprocess.run(['bash', str(AUTOSTART), '--provision'], env={**env, 'YOISAKI_PROVISION_TOKEN': 'not-a-token'}, capture_output=True, text=True, timeout=30)
    assert r.returncode == 2
    assert not (Path(env['YOISAKI_DATA_ROOT']) / 'config/engine/engine.token').exists()


def test_provision_starts_background_engine_with_website_token(env):
    r = subprocess.run(['bash', str(AUTOSTART), '--provision'], env={**env, 'YOISAKI_PROVISION_TOKEN': TOKEN, 'FAKE_RUN_SLEEP': '1'},
                       capture_output=True, text=True, timeout=30)
    assert r.returncode == 0, r.stderr
    assert TOKEN not in r.stdout + r.stderr  # the token is never printed
    secrets = Path(env['YOISAKI_DATA_ROOT']) / 'config/engine'
    assert stat.S_IMODE((secrets / 'engine.token').stat().st_mode) == 0o600
    assert stat.S_IMODE(secrets.stat().st_mode) == 0o700
    assert json.loads((secrets / 'autostart.json').read_text()) == {'version': 1, 'stable_link': True, 'rendezvous': 'ntfy'}
    run = wait_for(lambda: [line for line in calls(env) if 'launcher.py run' in line])
    assert 'STABLE=1 RDV=ntfy' in run[0] and 'TOKEN=' + TOKEN in run[0]
    wait_for(lambda: any('rendezvous.py status IMAGE_READY' in line for line in calls(env)))
    log = Path(env['YOISAKI_DATA_ROOT']) / 'logs/autostart.log'
    wait_for(lambda: log.exists() and 'Движок остановлен' in log.read_text())
    assert TOKEN not in log.read_text()


def test_managed_engine_restarts_a_limited_number_of_times(env):
    provisioned_files(env)
    r = subprocess.run(['bash', str(AUTOSTART)], env={**env, 'FAKE_RUN_EXIT': '3', 'YOISAKI_AUTOSTART_RESTARTS': '2'}, capture_output=True, text=True, timeout=60)
    assert r.returncode == 3
    assert sum('launcher.py run' in line for line in calls(env)) == 3
    assert 'после 2 перезапусков' in r.stdout


def test_new_provisioning_restarts_running_engine_and_sigterm_stops_cleanly(env):
    provisioned_files(env)
    proc = subprocess.Popen(['bash', str(AUTOSTART)], env={**env, 'FAKE_RUN_SLEEP': '60'}, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        wait_for(lambda: any('launcher.py run' in line for line in calls(env)))
        # a second start in the same container does not start a second engine; 1.7.7: it waits instead of exiting
        # (an exiting image CMD would end PID 1 and stop the container)
        again = subprocess.Popen(['bash', str(AUTOSTART)], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                                 start_new_session=True)
        try:
            time.sleep(1.5)
            assert again.poll() is None
            assert sum('launcher.py run' in line for line in calls(env)) == 1
        finally:
            os.killpg(again.pid, signal.SIGKILL)  # bash and its waiting flock
            out, _ = again.communicate(timeout=10)
        assert 'уже работает' in out
        provisioned_files(env, 'b' * 64)
        Path(env['YOISAKI_DATA_ROOT'], 'runtime/state/autostart.restart').touch()
        wait_for(lambda: any('TOKEN=' + 'b' * 64 in line and 'launcher.py run' in line for line in calls(env)))
        proc.send_signal(signal.SIGTERM)
        out, _ = proc.communicate(timeout=30)
        assert proc.returncode == 0 and 'Остановка по сигналу' in out
    finally:
        if proc.poll() is None:
            proc.kill()


def test_177_image_cmd_after_onstart_waits_instead_of_stopping_the_container(env):
    """Provider order onstart → image CMD: the onstart supervisor holds the lock. The CMD (PID 1 child under tini)
    must neither start a second engine nor exit (exit = container stop); it takes over when the first one ends."""
    r = subprocess.run(['bash', str(AUTOSTART), '--provision'], env={**env, 'YOISAKI_PROVISION_TOKEN': TOKEN, 'FAKE_RUN_SLEEP': '3'},
                       capture_output=True, text=True, timeout=30)
    assert r.returncode == 0, r.stderr
    wait_for(lambda: any('launcher.py run' in line for line in calls(env)))
    cmd = subprocess.Popen(['bash', str(AUTOSTART)], env={**env, 'FAKE_RUN_SLEEP': '1'}, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        time.sleep(1)
        assert cmd.poll() is None  # the container keeps running
        assert sum('launcher.py run' in line for line in calls(env)) == 1  # still one engine
        out, _ = cmd.communicate(timeout=30)  # first supervisor ends → CMD takes over, its engine exits 0
    finally:
        if cmd.poll() is None:
            cmd.kill()
    assert cmd.returncode == 0 and 'уже работает' in out and 'продолжаю наблюдение' in out
    runs = [line for line in calls(env) if 'launcher.py run' in line]
    assert len(runs) == 2 and all('TOKEN=' + TOKEN in line and 'STABLE=1' in line for line in runs)
    assert TOKEN not in out


def test_launcher_signals_stages_only_with_rendezvous_and_stable_token(tmp_path, monkeypatch):
    sent = []
    monkeypatch.setattr(rendezvous, 'publish_status', lambda token, stage, host='ntfy.sh': sent.append((token, stage, host)))
    cfg = launcher.Config({'YOISAKI_DATA_ROOT': str(tmp_path)})
    launcher.prepare(cfg)
    assert launcher.Launcher(cfg).signal('ENGINE_STARTING') is None  # off by default
    cfg = launcher.Config({'YOISAKI_DATA_ROOT': str(tmp_path), 'YOISAKI_RENDEZVOUS': 'ntfy', 'YOISAKI_STABLE_LINK': '1'})
    (cfg.secrets / 'engine.token').write_text(TOKEN + '\n')
    worker = launcher.Launcher(cfg).signal('SERVER_READY')
    worker.join(5)
    assert sent == [(TOKEN, 'SERVER_READY', 'ntfy.sh')]
    monkeypatch.setattr(rendezvous, 'publish_status', lambda *a, **k: (_ for _ in ()).throw(OSError('offline')))
    launcher.Launcher(cfg).signal('ENGINE_STARTING').join(5)  # a failing publication is never fatal


def test_gpu_check_failure_is_signalled_before_exit(tmp_path, monkeypatch):
    cfg = launcher.Config({'YOISAKI_DATA_ROOT': str(tmp_path), 'YOISAKI_RENDEZVOUS': 'ntfy', 'YOISAKI_STABLE_LINK': '1'})
    launcher.prepare(cfg)
    stages = []
    monkeypatch.setattr(rendezvous, 'publish_status', lambda token, stage, host='ntfy.sh': stages.append(stage))
    monkeypatch.setattr(launcher.subprocess, 'run', lambda *a, **k: subprocess.CompletedProcess(a, 1, 'no CUDA\n', ''))
    run = launcher.Launcher(cfg)
    with pytest.raises(launcher.LaunchError):
        run.run()
    assert stages == ['ENGINE_STARTING', 'GPU_CHECK_FAILED']  # ENGINE_FAILED is not sent twice


def test_rendezvous_status_cli_reads_token_from_file_only(tmp_path, monkeypatch):
    token_file = tmp_path / 'engine.token'
    token_file.write_text(TOKEN + '\n')
    sent = []
    monkeypatch.setattr(rendezvous, 'publish_status', lambda token, stage, host='ntfy.sh': sent.append((token, stage, host)))
    assert rendezvous.main(['x', 'status', 'IMAGE_READY'], {'YOISAKI_TOKEN_FILE': str(token_file)}) == 0
    assert sent == [(TOKEN, 'IMAGE_READY', 'ntfy.sh')]
    assert rendezvous.main(['x', 'status', 'NOT_A_STAGE'], {'YOISAKI_TOKEN_FILE': str(token_file)}) == 2
    assert rendezvous.main(['x', 'status', 'IMAGE_READY'], {}) == 1
    rec = rendezvous.status_record(TOKEN, 'SERVER_READY', 10)
    assert rec == {'v': 1, 'kind': 'status', 'stage': 'SERVER_READY', 'ts': 10, 'sig': rendezvous.sign_status(TOKEN, 'SERVER_READY', 10)}
    assert 'url' not in rec and TOKEN not in json.dumps(rec)  # websites before 1.7.5 ignore status records


def test_lock_file_pins_everything_by_hash_and_satisfies_top_level_pins(tmp_path):
    assert check_lock.problems(APP) == []
    lock = (APP / 'cloudcompute/requirements-lock.txt').read_text()
    pins = dict(re.findall(r'^([a-z0-9-]+)==(\S+)', lock, re.M))
    assert pins['torch'] == '2.10.0' and pins['torchvision'] == '0.25.0' and pins['diffusers'] == '0.36.0'
    assert all(name.endswith('-cu12') for name in pins if name.startswith('nvidia-'))  # CUDA 12.8 wheels, not cu13
    bad = tmp_path / 'app'
    (bad / 'cloudcompute').mkdir(parents=True)
    (bad / 'engine').mkdir()
    (bad / 'engine/requirements.txt').write_text((APP / 'engine/requirements.txt').read_text())
    (bad / 'cloudcompute/requirements-cloud.txt').write_text((APP / 'cloudcompute/requirements-cloud.txt').read_text())
    (bad / 'cloudcompute/requirements-lock.txt').write_text(lock.replace('diffusers==0.36.0', 'diffusers==0.35.0'))
    assert any('diffusers' in p for p in check_lock.problems(bad))


def test_image_policies_175():
    docker = (APP / 'Dockerfile').read_text()
    code = re.sub(r'#.*', '', docker)
    assert '--require-hashes --no-deps -r /opt/yoisaki/cloudcompute/requirements-lock.txt' in docker and 'pip check' in docker and 'check_lock.py' in docker
    assert 'CMD ["/opt/yoisaki/cloudcompute/autostart-image.sh"]' in docker and 'chown -R 1000:1000 /data' in docker
    assert 'org.opencontainers.image.version="1.7.7.1"' in docker and ':latest' not in code
    # 1.7.7: the container starts as root (provider bootstraps need it); the engine drops to uid 1000 in autostart
    assert not re.search(r'^\s*USER\s', code, re.M)
    autostart = AUTOSTART.read_text()
    assert 'setpriv --reuid="$RUN_UID" --regid="$RUN_GID" --clear-groups' in autostart
    assert 'COPY config' not in code and 'secrets.json' not in code and 'extra_ca' not in code.split('RUN apt-get update')[0]
    # the optional build CA is a BuildKit secret mount, never COPY/ENV/ARG
    assert all('extra_ca' in line and '--mount=type=secret' in line for line in code.splitlines() if 'extra_ca' in line and 'RUN' in line)
    ignore = (APP / '.dockerignore').read_text().splitlines()
    assert '!config/' not in ignore and '!server/' not in ignore
    workflow = (APP / '.github/workflows/engine-image.yml').read_text()
    assert ':latest' not in re.sub(r'#.*', '', workflow) and 'steps.meta.outputs.version' in workflow and 'Refuse to overwrite' in workflow
    assert (APP / 'cloudcompute/VERSION').read_text().strip() == '1.7.7.1'
    assert os.access(AUTOSTART, os.X_OK) or AUTOSTART.read_text().startswith('#!/usr/bin/env bash')


def test_engine_directory_is_byte_identical_to_174():
    import hashlib
    h = hashlib.sha256()
    for path in sorted((APP / 'engine').rglob('*')):
        if path.is_file() and '__pycache__' not in path.parts:
            h.update(str(path.relative_to(APP)).encode() + b'\0' + path.read_bytes())
    assert h.hexdigest() == 'a5ab65527fceaeff5610a4be993d94c17cd150661ad8592c73576cc5b65df888'  # engine/ of YOISAKI AI STUDIO 1.7.4 (no inference pipeline change)
