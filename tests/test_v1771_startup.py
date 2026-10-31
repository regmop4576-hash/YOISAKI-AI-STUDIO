"""Real POSIX process tests with a fake inference launcher, NOT Docker or real GPU validation."""
import concurrent.futures
import json
import os
import signal
import stat
import subprocess
import time
from pathlib import Path

import pytest
from test_v175_autostart import env, AUTOSTART, TOKEN, calls, wait_for, launcher


def provision(env, token=TOKEN):
    return subprocess.run(['bash', str(AUTOSTART), '--provision'], env={**env, 'YOISAKI_PROVISION_TOKEN': token, 'FAKE_RUN_SLEEP': '120'}, capture_output=True, text=True, timeout=15)


def stop(env):
    path = Path(env['YOISAKI_DATA_ROOT']) / 'runtime/state/supervisor.pid'
    if path.exists():
        try:
            os.kill(int(path.read_text()), signal.SIGTERM)
        except ProcessLookupError:
            pass


def test_parallel_repeated_provision_does_not_reload_or_create_waiting_supervisors(env):
    try:
        first = provision(env)
        assert first.returncode == 0, first.stderr + first.stdout
        wait_for(lambda: any('launcher.py run' in c for c in calls(env)))
        root = Path(env['YOISAKI_DATA_ROOT'])
        model = root / 'models/user-model.safetensors'
        model.write_bytes(b'KEEP-USER-DATA')
        before = model.stat()
        pid = (root / 'runtime/state/supervisor.pid').read_text()
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda _: provision(env), range(8)))
        assert all(r.returncode == 0 for r in results)
        time.sleep(.5)
        assert len([c for c in calls(env) if 'launcher.py run' in c]) == 1
        assert (root / 'runtime/state/supervisor.pid').read_text() == pid
        assert model.read_bytes() == b'KEEP-USER-DATA'
        assert (model.stat().st_uid, model.stat().st_mode) == (before.st_uid, before.st_mode)
        for name in ('config', 'logs', 'runtime', 'models'):
            assert (root / name).is_dir()
        assert stat.S_IMODE((root / 'config/engine/engine.token').stat().st_mode) == 0o600
        assert TOKEN not in ''.join(r.stdout + r.stderr for r in results)
    finally:
        stop(env)


def test_changed_token_restarts_once_and_detached_supervisor_survives_caller(env):
    try:
        assert provision(env).returncode == 0
        wait_for(lambda: len([c for c in calls(env) if 'launcher.py run' in c]) == 1)
        assert provision(env, 'c' * 64).returncode == 0
        wait_for(lambda: len([c for c in calls(env) if 'launcher.py run' in c]) == 2)
        assert provision(env, 'c' * 64).returncode == 0
        time.sleep(.5)
        assert len([c for c in calls(env) if 'launcher.py run' in c]) == 2
    finally:
        stop(env)


def test_explicit_bad_data_root_does_not_fall_back_or_touch_models(env, tmp_path):
    bad = tmp_path / 'not-directory'
    bad.write_text('user-data')
    result = provision({**env, 'YOISAKI_DATA_ROOT': str(bad)})
    assert result.returncode != 0
    assert bad.read_text() == 'user-data'


def test_private_config_symlink_rejected_without_modifying_target(env, tmp_path):
    root = Path(env['YOISAKI_DATA_ROOT']);root.mkdir()
    target = tmp_path / 'elsewhere';target.mkdir()
    (root / 'config').symlink_to(target, target_is_directory=True)
    assert provision(env).returncode != 0
    assert list(target.iterdir()) == []


def test_healthcheck_requires_engine_identity_and_ready_state(tmp_path, monkeypatch):
    monkeypatch.setenv('YOISAKI_DATA_ROOT', str(tmp_path))
    monkeypatch.setattr(launcher, 'read_private', lambda *_: TOKEN)
    for payload, expected in [({'state': 'READY'}, 1), ({'engine': 'YOISAKI_ENGINE', 'state': 'STARTING'}, 1), ({'engine': 'YOISAKI_ENGINE', 'state': 'READY'}, 0), ({'engine': 'YOISAKI_ENGINE', 'state': 'BUSY'}, 0)]:
        monkeypatch.setattr(launcher, 'request_json', lambda *a, **k: payload)
        assert launcher.main(['launcher', 'healthcheck']) == expected


def test_diagnostics_missing_directories_is_unknown_not_ready(tmp_path):
    cfg = launcher.Config({'YOISAKI_DATA_ROOT': str(tmp_path)})
    d = launcher.startup_diagnostics(cfg)
    assert d['supervisor_confirmed'] is False and d['provisioning_completed'] is False
    assert not any(d['directories'].values())
    assert d['engine_health'] is None
    assert TOKEN not in json.dumps(d)


def test_foreground_waiter_forwards_shutdown_to_detached_supervisor(env):
    proc = None
    try:
        assert provision(env).returncode == 0
        wait_for(lambda: any('launcher.py run' in c for c in calls(env)))
        proc = subprocess.Popen(['bash', str(AUTOSTART)], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        time.sleep(.3)
        proc.terminate()
        proc.communicate(timeout=15)
        assert proc.returncode == 0
        # A new lock acquisition proves the original supervisor and its child released the lifetime lock.
        result = subprocess.run(['flock', '-n', str(Path(env['YOISAKI_DATA_ROOT']) / 'runtime/state/autostart.lock'), 'true'])
        assert result.returncode == 0
    finally:
        if proc is not None and proc.poll() is None:
            proc.kill()
        stop(env)


def test_real_browser_terminal_shell_echo_and_detachment(env):
    import pty
    import select
    import shutil
    app = Path(env['YOISAKI_APP_DIR'])
    shutil.copy2(AUTOSTART, app / 'cloudcompute/autostart-image.sh')
    script = subprocess.check_output(['node', '--input-type=module', '-e',
        'import {onstartScript,ENGINE_IMAGE} from "./server/cloudcompute-deploy.mjs";process.stdout.write(onstartScript({image:ENGINE_IMAGE,token:"a".repeat(64)}))'], cwd=AUTOSTART.parents[1], text=True)
    master, slave = pty.openpty()
    proc = subprocess.Popen(['bash', '--noprofile', '--norc', '-i'], stdin=slave, stdout=slave, stderr=slave,
                            env={**env, 'FAKE_RUN_SLEEP': '120'}, start_new_session=True)
    os.close(slave)
    def receive(marker):
        data = b''
        end = time.time() + 12
        while marker not in data and time.time() < end:
            if select.select([master], [], [], .1)[0]:
                data += os.read(master, 65536)
        assert marker in data, data.decode(errors='replace')
        return data
    try:
        receive(b'# ')
        os.write(master, b" stty -echo && set +o history && printf '\\nQUIET_%s\\n' YES\n")
        receive(b'\r\nQUIET_YES\r\n')
        os.write(master, ("bash <<'Y_INIT'\n" + script + "Y_INIT\nprintf '\\nDONE:%s\\n' \"$?\"\n").encode())
        output = receive(b'DONE:0')
        assert TOKEN.encode() not in output
        assert b'YOISAKI_SUPERVISOR_CONFIRMED' in output
        os.write(master, b'exit\n');proc.wait(timeout=5)
        wait_for(lambda: any('launcher.py run' in c for c in calls(env)))
        pid = int((Path(env['YOISAKI_DATA_ROOT']) / 'runtime/state/supervisor.pid').read_text())
        os.kill(pid, 0)  # remains alive after terminal shell exits
    finally:
        if proc.poll() is None:
            proc.kill();proc.wait()
        os.close(master);stop(env)
