"""v1.7.2 Google Drive → CloudCompute model sync.

Integration tests run the REAL rclone binary against a temporary folder exposed as the configured remote
(rclone `alias` backend), through a logging shim that can also cut, slow down or corrupt a transfer.
No real Google account, Google Drive or GPU is used here: OAuth/Drive behaviour is covered by the
token/config/error-classification tests only, and must be accepted on a real CloudCompute instance.
"""
import hashlib, json, os, re, shutil, stat, struct, subprocess, sys, textwrap, time
from pathlib import Path
import importlib.util
import pytest

APP = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP / 'cloudcompute'))
sys.path.insert(0, str(APP / 'engine'))
import drive_sync  # noqa: E402
import launcher  # noqa: E402
from drive_sync import SyncConfig, SyncError, SyncService, classify  # noqa: E402

RCLONE = shutil.which('rclone')
needs_rclone = pytest.mark.skipif(RCLONE is None, reason='rclone not installed')
needs_fastapi = pytest.mark.skipif(importlib.util.find_spec('fastapi') is None or importlib.util.find_spec('httpx') is None,
                                   reason='fastapi/httpx not installed')
KEYS = {'checkpoint': ['conditioner.embedders.1.w', 'model.diffusion_model.w'], 'lora': ['lora_te2_x.w'],
        'vae': ['decoder.conv_in.weight', 'encoder.conv_out.weight']}
TOKEN = {'access_token': 'ya29.TESTONLY_' + 'A' * 40, 'token_type': 'Bearer', 'refresh_token': '1//TESTONLY_' + 'R' * 40,
         'expiry': '2026-10-26T10:00:00Z'}


def model(path, kind, payload=150_000, seed=b''):
    """Structurally valid safetensors (header + exact payload) of the given engine kind."""
    path.parent.mkdir(parents=True, exist_ok=True)
    keys = KEYS[kind]
    each = payload // len(keys)
    tensors = {k: {'dtype': 'U8', 'shape': [each], 'data_offsets': [i * each, (i + 1) * each]} for i, k in enumerate(keys)}
    head = json.dumps({'__metadata__': {}, **tensors}).encode()
    body = (hashlib.sha256(seed + path.name.encode()).digest() * (each * len(keys) // 32 + 1))[:each * len(keys)]
    path.write_bytes(struct.pack('<Q', len(head)) + head + body)
    return path


SHIM = textwrap.dedent('''\
    #!/usr/bin/env python3
    import json, os, subprocess, sys, time
    ctl = os.environ['SHIM_DIR']; args = sys.argv[1:]
    with open(os.path.join(ctl, 'log'), 'a') as f: f.write(json.dumps(args) + '\\n')
    def take(name):
        p = os.path.join(ctl, name)
        if not os.path.exists(p): return None
        value = open(p).read(); return value
    command = args[2]
    err = take('stderr')
    if err is not None:
        sys.stderr.write(err); sys.exit(1)
    limit = take('fail_after') if command == 'cat' else None
    if limit is not None: os.unlink(os.path.join(ctl, 'fail_after')); limit = int(limit)
    corrupt = command == 'cat' and take('corrupt') is not None
    delay = float(take('delay') or 0) if command == 'cat' else 0
    p = subprocess.Popen([os.environ['SHIM_REAL'], *args], stdout=subprocess.PIPE)
    out = sys.stdout.buffer; sent = 0
    while chunk := p.stdout.read(65536):
        if corrupt and sent == 0: chunk = bytes([chunk[-1] ^ 1]) + chunk[1:] if len(chunk) == 1 else chunk[:-1] + bytes([chunk[-1] ^ 1])
        if limit is not None and sent + len(chunk) > limit:
            out.write(chunk[:limit - sent]); out.flush(); p.kill(); sys.exit(1)
        out.write(chunk); out.flush(); sent += len(chunk)
        if delay: time.sleep(delay)
    sys.exit(p.wait())
    ''')


@pytest.fixture
def env(tmp_path, monkeypatch):
    """Data root + fake 'Drive' folder + configured remote; small size limits so fixtures stay small."""
    monkeypatch.setattr(drive_sync, 'LIMITS', {'checkpoint': (100_000, 10**9), 'lora': (10_000, 10**9), 'vae': (10_000, 10**9)})
    data, drive, ctl = tmp_path / 'data', tmp_path / 'drive', tmp_path / 'shim'
    (drive / 'YOISAKI_AI_STUDIO/models').mkdir(parents=True)
    ctl.mkdir()
    shim = tmp_path / 'rclone-shim'
    shim.write_text(SHIM)
    shim.chmod(0o755)
    monkeypatch.setenv('SHIM_DIR', str(ctl))
    monkeypatch.setenv('SHIM_REAL', RCLONE or '/bin/false')
    environ = {'YOISAKI_DATA_ROOT': str(data), 'YOISAKI_ENGINE_DIR': str(APP / 'engine'), 'YOISAKI_RCLONE': str(shim)}
    launcher.prepare(launcher.Config(environ))
    (data / 'config/rclone').mkdir(parents=True)
    (data / 'config/rclone/rclone.conf').write_text(f'[yoisaki-gdrive]\ntype = alias\nremote = {drive}\n')

    class Env:
        pass
    e = Env()
    e.data, e.drive, e.ctl, e.environ = data, drive / 'YOISAKI_AI_STUDIO/models', ctl, environ
    e.models = data / 'models'
    e.cfg = SyncConfig(environ)
    e.service = lambda: SyncService(SyncConfig(environ))
    e.calls = lambda: [json.loads(l) for l in (ctl / 'log').read_text().splitlines()] if (ctl / 'log').exists() else []
    return e


def run(service, kind='sync', timeout=60):
    service.start(kind)
    service.wait(timeout)
    assert not service.thread.is_alive()
    return service.status()


def by_path(snap):
    return {i['path']: i for i in snap['items']}


# ------------------------------------------------------------------------------ validation (no rclone)
@pytest.mark.parametrize('path,state', [
    ('checkpoints/Illustrious XL.safetensors', 'PENDING'),
    ('loras/characters/Amber 3.0.safetensors', 'PENDING'),
    ('vae/sdxl_vae.safetensors', 'PENDING'),
    ('checkpoints/model.ckpt', 'REJECTED'),
    ('loras/a.pt', 'REJECTED'), ('loras/a.pth', 'REJECTED'), ('loras/a.bin', 'REJECTED'), ('vae/x.pickle', 'REJECTED'),
    ('loras/readme.txt', 'REJECTED'),
    ('checkpoints/../../etc/passwd.safetensors', 'REJECTED'),
    ('checkpoints/./x.safetensors', 'REJECTED'),
    ('loras/.hidden/x.safetensors', 'REJECTED'),
    ('loras/.x.safetensors', 'REJECTED'),
    ('loras/a\\b.safetensors', 'REJECTED'),
    ('loras/a;rm -rf.safetensors', 'REJECTED'),
    ('loras/$(touch pwned).safetensors', 'REJECTED'),
    ('loras/a/b/c/d.safetensors', 'REJECTED'),  # deeper than kind/sub/sub/file
])
def test_classify_paths_and_formats(path, state, monkeypatch):
    monkeypatch.setattr(drive_sync, 'LIMITS', {k: (1, 10**12) for k in ('checkpoint', 'lora', 'vae')})
    item = classify({'Path': path, 'Size': 10**6, 'IsDir': False, 'Hashes': {'md5': 'a' * 32}})
    assert item['state'] == state, item
    if state == 'REJECTED':
        assert item['reason']


def test_classify_ignores_non_model_folders_and_checks_size():
    assert classify({'Path': 'notes.txt', 'Size': 3}) is None
    assert classify({'Path': 'controlnet/x.safetensors', 'Size': 10**8}) is None
    assert classify({'Path': 'checkpoints', 'IsDir': True}) is None
    tiny = classify({'Path': 'checkpoints/tiny.safetensors', 'Size': 1000})  # real limits: a 1 KB "checkpoint" is not one
    assert tiny['state'] == 'REJECTED' and 'вне допустимого' in tiny['reason']
    nosize = classify({'Path': 'loras/a.safetensors', 'Size': '5'})
    assert nosize['state'] == 'REJECTED' and nosize['size'] is None
    assert classify({'Path': 'loras/a.safetensors', 'Size': 10**6, 'Hashes': {'md5': 'A' * 32, 'sha256': 'zz'}})['hash'] == 'a' * 32
    assert drive_sync.best_hash({'md5': 'b' * 32, 'sha1': 'c' * 40, 'sha256': 'd' * 64}) == ('sha256', 'd' * 64)


@pytest.mark.parametrize('key,value', [('YOISAKI_DRIVE_REMOTE', 'a:b'), ('YOISAKI_DRIVE_REMOTE', '-x'), ('YOISAKI_DRIVE_REMOTE', 'a b'),
                                       ('YOISAKI_DRIVE_PATH', '../models'), ('YOISAKI_DRIVE_PATH', 'a/../b'), ('YOISAKI_DRIVE_PATH', 'x:y'),
                                       ('YOISAKI_DRIVE_PATH', 'a/./b')])
def test_server_config_rejects_unsafe_remote_and_path(tmp_path, key, value):
    with pytest.raises(launcher.LaunchError):
        SyncConfig({'YOISAKI_DATA_ROOT': str(tmp_path), key: value})


def test_defaults_target_engine_catalogue(tmp_path):
    cfg = SyncConfig({'YOISAKI_DATA_ROOT': str(tmp_path)})
    assert cfg.source == 'YOISAKI_AI_STUDIO/models' and cfg.remote == 'yoisaki-gdrive'
    assert cfg.models == launcher.Config({'YOISAKI_DATA_ROOT': str(tmp_path)}).models  # one catalogue, no second model dir
    assert cfg.staging.parent == cfg.models and cfg.rclone_conf == tmp_path / 'config/rclone/rclone.conf'


def test_symlinked_subfolder_cannot_escape_models(tmp_path):
    cfg = SyncConfig({'YOISAKI_DATA_ROOT': str(tmp_path / 'data')})
    (cfg.models / 'loras').mkdir(parents=True)
    (tmp_path / 'outside').mkdir()
    (cfg.models / 'loras/evil').symlink_to(tmp_path / 'outside')
    with pytest.raises(SyncError) as e:
        cfg.target('loras/evil/x.safetensors')
    assert e.value.code == 'UNSAFE_PATH'
    assert cfg.target('loras/sub/x.safetensors') == cfg.models / 'loras/sub/x.safetensors'


@pytest.mark.parametrize('command', ['delete', 'deletefile', 'purge', 'rmdir', 'rmdirs', 'sync', 'copy', 'copyto', 'move',
                                     'moveto', 'rcat', 'mkdir', 'touch', 'bisync', 'cleanup', 'dedupe', 'link', 'config', 'serve'])
def test_only_read_only_rclone_commands_can_be_built(tmp_path, command):
    cfg = SyncConfig({'YOISAKI_DATA_ROOT': str(tmp_path)})
    with pytest.raises(SyncError) as e:
        drive_sync.rclone_argv(cfg, command)
    assert e.value.code == 'FORBIDDEN'
    argv = drive_sync.rclone_argv(cfg, 'cat', 'yoisaki-gdrive:YOISAKI_AI_STUDIO/models/x')
    assert argv[3] == 'cat' and argv[argv.index('--drive-scope') + 1] == 'drive.readonly'


def test_source_has_one_subprocess_path_without_shell():
    src = (APP / 'cloudcompute/drive_sync.py').read_text()
    assert src.count('subprocess.Popen(') == 1 and 'rclone_argv(self.cfg, command' in src
    assert 'shell=True' not in src and 'os.system' not in src and 'os.remove(self.cfg.models' not in src
    # Local deletion is limited to the sync's own temporary files and the server copy of the token.
    unlinks = re.findall(r'(\w+(?:\.\w+)*)\.unlink\(', src)
    assert set(unlinks) <= {'part', 'meta', 'self.cfg.rclone_conf'}, unlinks
    assert 'rmtree' not in src and 'shutil.move' not in src


def test_sanitize_removes_tokens():
    raw = ('2026/10/26 08:00:00 ERROR : oauth2: "refresh_token":"1//abcdefghijklmnopqrstuv" "access_token":"ya29.secret" '
           'token={"x":1} Bearer abc.def client_secret=GOCSPX-zzz ' + 'f' * 64)
    out = drive_sync.sanitize(raw)
    for secret in ('1//abc', 'ya29.secret', 'abc.def', 'GOCSPX-zzz', 'f' * 64, '"x":1'):
        assert secret not in out
    assert not out.startswith('2026/')


@pytest.mark.parametrize('stderr,code', [('oauth2: cannot fetch token: 400 invalid_grant', 'AUTH_FAILED'),
                                         ("Failed to create file system: didn't find section in config file", 'NOT_CONFIGURED'),
                                         ('error listing: directory not found', 'SOURCE_NOT_FOUND'),
                                         ('googleapi: Error 403: userRateLimitExceeded', 'RATE_LIMITED'),
                                         ('dial tcp: lookup www.googleapis.com: no such host', 'NETWORK'),
                                         ('something else', 'RCLONE_ERROR')])
def test_rclone_error_classification(stderr, code):
    assert drive_sync.classify_rclone_error(stderr, 1).code == code


# ------------------------------------------------------------------------------ token handling
def test_connect_stores_readonly_token_privately_and_never_returns_it(tmp_path):
    cfg = SyncConfig({'YOISAKI_DATA_ROOT': str(tmp_path / 'data')})
    service = SyncService(cfg)
    snap = service.connect(json.dumps(TOKEN))
    conf = cfg.rclone_conf.read_text()
    assert stat.S_IMODE(cfg.rclone_conf.stat().st_mode) == 0o600 and stat.S_IMODE(cfg.rclone_dir.stat().st_mode) == 0o700
    assert '[yoisaki-gdrive]\ntype = drive\nscope = drive.readonly\ntoken = {' in conf and TOKEN['refresh_token'] in conf
    assert snap['configured'] is True and snap['scope'] == 'drive.readonly'
    surfaces = json.dumps(snap) + json.dumps(service.status())
    surfaces += ''.join(p.read_text() for p in (tmp_path / 'data/runtime/sync').glob('*') if p.is_file())
    for secret in (TOKEN['access_token'], TOKEN['refresh_token']):
        assert secret not in surfaces
    service.connect(TOKEN, '123456789-abcdefghij0123.apps.googleusercontent.com', 'GOCSPX-abcdefghij_klm')
    assert 'client_id = 123456789-abcdefghij0123.apps.googleusercontent.com' in cfg.rclone_conf.read_text()
    service.disconnect()
    assert not cfg.rclone_conf.exists() and service.status()['configured'] is False


@pytest.mark.parametrize('token', ['not json', '[]', json.dumps({'access_token': 'x'}), json.dumps({**TOKEN, 'evil': 'x'}),
                                   json.dumps({**TOKEN, 'refresh_token': 'a\n[other]\ntype = local'}), json.dumps({**TOKEN, 'access_token': True}),
                                   json.dumps({**TOKEN, 'refresh_token': 'x' * 5000}), json.dumps({**TOKEN, 'refresh_token': ' '})])
def test_connect_rejects_malformed_tokens(tmp_path, token):
    service = SyncService(SyncConfig({'YOISAKI_DATA_ROOT': str(tmp_path)}))
    with pytest.raises(SyncError) as e:
        service.connect(token)
    assert e.value.code == 'INVALID_TOKEN' and not (tmp_path / 'config/rclone/rclone.conf').exists()


def test_connect_rejects_bad_client_pair(tmp_path):
    service = SyncService(SyncConfig({'YOISAKI_DATA_ROOT': str(tmp_path)}))
    for cid, secret in (('123456789-abcdefghij0123.apps.googleusercontent.com', ''), ('evil\nx', 'GOCSPX-abcdefghij'), ('', 'GOCSPX-abcdefghij')):
        with pytest.raises(SyncError):
            service.connect(TOKEN, cid, secret)


def test_start_requires_configuration_and_rclone(tmp_path):
    service = SyncService(SyncConfig({'YOISAKI_DATA_ROOT': str(tmp_path), 'YOISAKI_RCLONE': '/nonexistent/rclone'}))
    with pytest.raises(SyncError) as e:
        service.start('sync')
    assert e.value.code == 'RCLONE_MISSING'
    service = SyncService(SyncConfig({'YOISAKI_DATA_ROOT': str(tmp_path), 'YOISAKI_RCLONE': '/bin/true'}))
    with pytest.raises(SyncError) as e:
        service.start('sync')
    assert e.value.code == 'NOT_CONFIGURED'
    service = SyncService(SyncConfig({'YOISAKI_DATA_ROOT': str(tmp_path), 'YOISAKI_RCLONE': '/bin/true', 'YOISAKI_DRIVE_SYNC': '0'}))
    with pytest.raises(SyncError) as e:
        service.start('check')
    assert e.value.code == 'DISABLED'


# ------------------------------------------------------------------------------ real rclone integration
@needs_rclone
def test_discover_download_verify_install_and_engine_inventory(env):
    model(env.drive / 'checkpoints/Illustrious XL.safetensors', 'checkpoint', 400_000)
    model(env.drive / 'loras/characters/Amber 3.0.safetensors', 'lora', 50_000)
    model(env.drive / 'loras/Vesper 3.0.safetensors', 'lora', 60_000)
    model(env.drive / 'vae/sdxl_vae.safetensors', 'vae', 40_000)
    (env.drive / 'loras/old.ckpt').write_bytes(b'\x80\x04' + b'x' * 20_000)  # pickle: listed, never downloaded
    (env.drive / 'readme.txt').write_text('not a model')
    (env.drive / 'controlnet').mkdir()
    model(env.drive / 'controlnet/c.safetensors', 'vae', 20_000)

    service = env.service()
    check = run(service, 'check')
    states = {p: i['state'] for p, i in by_path(check).items()}
    assert states == {'checkpoints/Illustrious XL.safetensors': 'MISSING', 'loras/characters/Amber 3.0.safetensors': 'MISSING',
                      'loras/Vesper 3.0.safetensors': 'MISSING', 'vae/sdxl_vae.safetensors': 'MISSING', 'loras/old.ckpt': 'REJECTED'}
    assert not any(env.models.rglob('*.safetensors'))  # a check never downloads

    snap = run(service, 'sync')
    job = snap['job']
    assert job['state'] == 'COMPLETED' and job['overall']['files_total'] == 4 and job['overall']['files_done'] == 4
    assert job['overall']['bytes_done'] == job['overall']['bytes_total'] > 0
    assert snap['last_success_unix'] and snap['inventory_revision'] == 4
    for rel in ('checkpoints/Illustrious XL.safetensors', 'loras/characters/Amber 3.0.safetensors', 'vae/sdxl_vae.safetensors'):
        assert (env.models / rel).read_bytes() == (env.drive / rel).read_bytes()
        assert by_path(snap)[rel]['state'] == 'INSTALLED' and by_path(snap)[rel]['verification'] in ('sha256+safetensors', 'md5+safetensors')
    assert not (env.models / 'loras/old.ckpt').exists() and not (env.models / 'controlnet/c.safetensors').exists()
    assert not list(env.cfg.staging.iterdir())  # no temporary file left behind

    # The unchanged engine catalogue sees the new files immediately (no restart, no rebuild).
    from worker.models import scan
    names = {(m['kind'], m['name'], m['compatible']) for m in scan(env.models)}
    assert ('checkpoint', 'Illustrious XL.safetensors', True) in names and ('lora', 'Amber 3.0.safetensors', True) in names
    assert ('vae', 'sdxl_vae.safetensors', None) in names

    # Only read-only commands reached rclone; the token never appears in any public surface.
    assert {c[2] for c in env.calls()} == {'lsjson', 'cat'}
    assert all(c[:2] == ['--config', str(env.cfg.rclone_conf)] for c in env.calls())
    public = json.dumps(snap)
    assert str(env.cfg.rclone_conf) not in public and 'Hashes' not in public and str(env.data) not in public


@needs_rclone
def test_repeated_sync_skips_unchanged_files_without_downloading(env):
    model(env.drive / 'checkpoints/a.safetensors', 'checkpoint', 300_000)
    model(env.drive / 'loras/b.safetensors', 'lora', 30_000)
    service = env.service()
    run(service)
    before = {p: p.stat().st_mtime_ns for p in env.models.rglob('*.safetensors')}
    (env.ctl / 'log').unlink()
    snap = run(env.service())  # a new process after a restart: state comes from disk
    assert snap['job']['state'] == 'COMPLETED' and snap['job']['overall']['files_total'] == 0 and snap['job']['overall']['bytes_total'] == 0
    assert [c[2] for c in env.calls()] == ['lsjson']  # no `cat`: nothing re-downloaded
    assert {p: p.stat().st_mtime_ns for p in env.models.rglob('*.safetensors')} == before
    assert all(i['state'] == 'INSTALLED' for i in snap['items'])


@needs_rclone
def test_changed_drive_file_is_updated_atomically_and_flags_restart(env):
    src = model(env.drive / 'checkpoints/a.safetensors', 'checkpoint', 300_000)
    service = env.service()
    run(service)
    old_inode = (env.models / 'checkpoints/a.safetensors').stat().st_ino
    model(src, 'checkpoint', 300_000, seed=b'v2')  # same name, same size, new content
    check = run(service, 'check')
    assert by_path(check)['checkpoints/a.safetensors']['state'] == 'CHANGED'
    snap = run(service)
    assert snap['job']['restart_recommended'] is True and snap['job']['overall']['files_done'] == 1
    final = env.models / 'checkpoints/a.safetensors'
    assert final.read_bytes() == src.read_bytes() and final.stat().st_ino != old_inode  # replaced by rename, not rewritten in place


@needs_rclone
def test_existing_local_files_are_adopted_or_left_untouched(env):
    same = model(env.drive / 'loras/same.safetensors', 'lora', 40_000)
    model(env.drive / 'loras/other.safetensors', 'lora', 40_000)
    model(env.drive / 'vae/size.safetensors', 'vae', 40_000)
    shutil.copy(same, env.models / 'loras/same.safetensors')                       # placed by hand, identical
    model(env.models / 'loras/other.safetensors', 'lora', 40_000, seed=b'mine')    # same size, different content
    model(env.models / 'vae/size.safetensors', 'vae', 30_000)                      # different size
    mine = (env.models / 'loras/other.safetensors').read_bytes()
    snap = run(env.service())
    items = by_path(snap)
    assert items['loras/same.safetensors']['state'] == 'INSTALLED'
    assert items['loras/other.safetensors']['state'] == 'CONFLICT' and items['vae/size.safetensors']['state'] == 'CONFLICT'
    assert (env.models / 'loras/other.safetensors').read_bytes() == mine  # never overwritten
    assert not any(c[2] == 'cat' for c in env.calls())


@needs_rclone
def test_interrupted_transfer_is_retried_from_offset(env):
    src = model(env.drive / 'checkpoints/big.safetensors', 'checkpoint', 600_000)
    (env.ctl / 'fail_after').write_text('200000')  # first `cat` dies after 200000 bytes (network drop)
    snap = run(env.service())
    assert snap['job']['state'] == 'COMPLETED'
    cats = [c for c in env.calls() if c[2] == 'cat']
    assert len(cats) == 2 and '--offset' not in cats[0] and cats[1][cats[1].index('--offset') + 1] == '200000'
    assert (env.models / 'checkpoints/big.safetensors').read_bytes() == src.read_bytes()


@needs_rclone
def test_partial_download_survives_restart_and_resumes(env):
    src = model(env.drive / 'checkpoints/big.safetensors', 'checkpoint', 600_000)
    service = env.service()
    run(service, 'check')
    item = next(i for i in service.items if i['path'] == 'checkpoints/big.safetensors')
    part, meta = service._part_paths(item)
    part.parent.mkdir(parents=True, exist_ok=True)
    part.write_bytes(src.read_bytes()[:250_000])  # left by a killed process / instance restart
    meta.write_text(json.dumps(service._part_identity(item)))
    snap = run(env.service())
    cat = next(c for c in env.calls() if c[2] == 'cat')
    assert cat[cat.index('--offset') + 1] == '250000'
    assert snap['job']['state'] == 'COMPLETED' and (env.models / 'checkpoints/big.safetensors').read_bytes() == src.read_bytes()


@needs_rclone
def test_stale_partial_from_other_version_restarts_from_zero(env):
    src = model(env.drive / 'loras/a.safetensors', 'lora', 80_000)
    service = env.service()
    run(service, 'check')
    item = service.items[0]
    part, meta = service._part_paths(item)
    part.write_bytes(b'garbage' * 1000)
    meta.write_text(json.dumps({**service._part_identity(item), 'hash': '0' * 64}))
    run(env.service())
    assert '--offset' not in next(c for c in env.calls() if c[2] == 'cat')
    assert (env.models / 'loras/a.safetensors').read_bytes() == src.read_bytes()


@needs_rclone
def test_cancel_keeps_partial_and_next_sync_resumes(env):
    src = model(env.drive / 'checkpoints/slow.safetensors', 'checkpoint', 1_500_000)
    (env.ctl / 'delay').write_text('0.05')
    service = env.service()
    service.start('sync')
    deadline = time.time() + 30
    while time.time() < deadline:
        cur = (service.status()['job'] or {}).get('current') or {}
        if cur.get('phase') == 'DOWNLOADING' and (cur.get('bytes_done') or 0) > 200_000:
            break
        time.sleep(0.05)
    service.cancel()
    service.wait(30)
    snap = service.status()
    assert snap['job']['state'] == 'CANCELLED' and snap['job']['error_code'] == 'CANCELLED'
    assert not (env.models / 'checkpoints/slow.safetensors').exists()
    assert by_path(snap)['checkpoints/slow.safetensors']['state'] == 'MISSING'
    done = next(env.cfg.staging.glob('*.part')).stat().st_size
    assert 0 < done < src.stat().st_size
    (env.ctl / 'delay').unlink()
    snap = run(env.service())
    cat = [c for c in env.calls() if c[2] == 'cat'][-1]
    assert int(cat[cat.index('--offset') + 1]) == done
    assert snap['job']['state'] == 'COMPLETED' and (env.models / 'checkpoints/slow.safetensors').read_bytes() == src.read_bytes()


@needs_rclone
def test_concurrent_jobs_are_rejected_in_process_and_across_processes(env):
    model(env.drive / 'checkpoints/slow.safetensors', 'checkpoint', 1_000_000)
    (env.ctl / 'delay').write_text('0.05')
    first = env.service()
    first.start('sync')
    try:
        with pytest.raises(SyncError) as e:
            first.start('check')
        assert e.value.code == 'BUSY'
        other = env.service()  # e.g. the CLI on the server or a second engine process
        with pytest.raises(SyncError) as e:
            other.start('sync')
        assert e.value.code == 'BUSY' and other.status()['owner'] == 'other'
        with pytest.raises(SyncError):
            other.cancel()  # a sync started elsewhere (terminal) is cancelled there, not from the page
    finally:
        first.cancel()
        first.wait(30)
    assert first.status()['job']['state'] == 'CANCELLED'


@needs_rclone
def test_checksum_mismatch_is_rejected(env):
    model(env.drive / 'loras/a.safetensors', 'lora', 80_000)
    (env.ctl / 'corrupt').write_text('1')
    snap = run(env.service())
    item = by_path(snap)['loras/a.safetensors']
    assert item['state'] == 'FAILED' and 'контрольная сумма' in item['reason']
    assert not (env.models / 'loras/a.safetensors').exists() and not list(env.cfg.staging.glob('*.part'))
    (env.ctl / 'corrupt').unlink()
    assert by_path(run(env.service()))['loras/a.safetensors']['state'] == 'INSTALLED'


@needs_rclone
def test_invalid_or_incompatible_safetensors_never_enter_catalogue(env):
    bad = env.drive / 'checkpoints/fake.safetensors'
    bad.parent.mkdir(parents=True)
    bad.write_bytes(b'<html>quota exceeded</html>' * 5000)
    sd15 = env.drive / 'checkpoints/sd15.safetensors'
    model(sd15, 'lora', 200_000)  # valid safetensors, but not an SDXL checkpoint
    snap = run(env.service())
    assert by_path(snap)['checkpoints/fake.safetensors']['state'] == 'FAILED'
    assert by_path(snap)['checkpoints/sd15.safetensors']['state'] == 'FAILED'
    assert not any((env.models / 'checkpoints').iterdir()) and not list(env.cfg.staging.glob('*.part'))
    assert snap['job']['overall']['files_failed'] == 2 and snap['last_success_unix'] is None


@needs_rclone
def test_disk_space_is_checked_before_any_download(env, monkeypatch):
    model(env.drive / 'checkpoints/a.safetensors', 'checkpoint', 300_000)
    real = shutil.disk_usage
    monkeypatch.setattr(drive_sync.shutil, 'disk_usage', lambda p: real(p)._replace(free=drive_sync.MARGIN + 1000))
    snap = run(env.service())
    assert snap['job']['state'] == 'FAILED' and snap['job']['error_code'] == 'DISK_SPACE'
    assert not any(c[2] == 'cat' for c in env.calls()) and not (env.models / 'checkpoints/a.safetensors').exists()


@needs_rclone
@pytest.mark.parametrize('stderr,code', [('oauth2: "refresh_token":"1//SECRETSECRETSECRETSECRET" invalid_grant', 'AUTH_FAILED'),
                                         ('error listing: directory not found', 'SOURCE_NOT_FOUND')])
def test_remote_errors_are_reported_without_secrets(env, stderr, code):
    (env.ctl / 'stderr').write_text(stderr)
    snap = run(env.service(), 'check')
    assert snap['job']['state'] == 'FAILED' and snap['job']['error_code'] == code
    assert snap['connection']['state'] == 'ERROR' and 'SECRETSECRET' not in json.dumps(snap)


@needs_rclone
def test_interrupted_job_is_reported_after_restart(env):
    service = env.service()
    service._ensure_dirs()
    launcher.write_private(env.data / 'runtime/sync/status.json', json.dumps({'job': {'type': 'sync', 'state': 'RUNNING', 'current': {'path': 'x'}}}))
    snap = env.service().status()
    assert snap['job']['state'] == 'INTERRUPTED' and snap['job']['current'] is None


@needs_rclone
def test_cli_check_and_sync(env, tmp_path):
    model(env.drive / 'loras/a.safetensors', 'lora', 40_000)
    run_env = {**os.environ, **env.environ}
    for command in ('check', 'sync', 'status'):
        r = subprocess.run([sys.executable, str(APP / 'cloudcompute/drive_sync.py'), command], env=run_env, capture_output=True, text=True, timeout=120)
        assert r.returncode == 0, r.stderr
    assert 'INSTALLED' in r.stdout and (env.models / 'loras/a.safetensors').exists()


# ------------------------------------------------------------------------------ HTTP routes on the engine app
@needs_fastapi
@needs_rclone
def test_engine_sync_routes_require_bearer_and_never_leak_token(env, monkeypatch):
    from fastapi.testclient import TestClient
    import serve_cloud
    for k, v in env.environ.items():
        monkeypatch.setenv(k, v)
    token = 'e' * 64
    app = serve_cloud.build(str(env.models), token)
    client = TestClient(app)
    routes = [('get', '/sync/status'), ('post', '/sync/check'), ('post', '/sync/start'), ('post', '/sync/cancel'),
              ('post', '/sync/drive/connect'), ('post', '/sync/drive/disconnect')]
    for method, path in routes:
        assert getattr(client, method)(path).status_code == 401, path
        assert getattr(client, method)(path, headers={'Authorization': 'Bearer ' + 'b' * 64}).status_code == 401, path
    auth = {'Authorization': 'Bearer ' + token}
    # No route accepts a path, remote or command from the client.
    paths = [r.path for r in app.routes if r.path.startswith('/sync')]
    assert sorted(paths) == sorted(p for _, p in routes) and not any('{' in p for p in paths)
    model(env.drive / 'loras/a.safetensors', 'lora', 40_000)
    r = client.post('/sync/start', headers=auth, json={'path': '../../etc', 'remote': 'evil:', 'command': 'delete'})
    assert r.status_code == 200 and r.json()['job']['type'] == 'sync'
    deadline = time.time() + 30
    while client.get('/sync/status', headers=auth).json()['job']['state'] == 'RUNNING' and time.time() < deadline:
        time.sleep(0.1)
    snap = client.get('/sync/status', headers=auth).json()
    assert snap['job']['state'] == 'COMPLETED' and (env.models / 'loras/a.safetensors').exists()
    assert {c[2] for c in env.calls()} <= {'lsjson', 'cat'}
    bad = client.post('/sync/drive/connect', headers=auth, json={'token': 'x' * 30})
    assert bad.status_code == 422 and bad.json()['code'] == 'INVALID_TOKEN'
    assert client.post('/sync/drive/connect', headers=auth, json={'token': json.dumps(TOKEN), 'extra': 1}).status_code == 422
    ok = client.post('/sync/drive/connect', headers=auth, json={'token': json.dumps(TOKEN)})
    assert ok.status_code == 200 and TOKEN['refresh_token'] not in ok.text and TOKEN['access_token'] not in ok.text
    assert TOKEN['refresh_token'] not in client.get('/sync/status', headers=auth).text
    # The engine's own routes are unchanged and still protected.
    assert client.get('/health').status_code == 401 and client.get('/models', headers=auth).status_code == 200


@needs_fastapi
def test_serve_cloud_refuses_a_second_model_directory(tmp_path, monkeypatch):
    pytest.importorskip('torch', reason='Engine import requires torch; GPU not required')
    import serve_cloud
    monkeypatch.setenv('YOISAKI_DATA_ROOT', str(tmp_path / 'data'))
    with pytest.raises(SystemExit):
        serve_cloud.build(str(tmp_path / 'elsewhere/models'), 'e' * 64)


def test_launcher_uses_sync_entrypoint_only_when_enabled(tmp_path, monkeypatch):
    seen = []

    class Stop(Exception):
        pass

    def fake_popen(argv, **kw):
        seen.append(argv)
        raise Stop
    monkeypatch.setattr(launcher.subprocess, 'Popen', fake_popen)
    for flag, expected in (('1', 'serve_cloud.py'), ('0', 'worker.serve')):
        cfg = launcher.Config({'YOISAKI_DATA_ROOT': str(tmp_path / 'data'), 'YOISAKI_ENGINE_DIR': str(APP / 'engine'), 'YOISAKI_DRIVE_SYNC': flag})
        launcher.prepare(cfg)
        with pytest.raises(Stop):
            launcher.Launcher(cfg).start_server()
        assert expected in ' '.join(seen[-1])
    assert stat.S_IMODE((tmp_path / 'data/runtime/sync').stat().st_mode) == 0o700


# ------------------------------------------------------------------------------ deployment files
def bash(script, tmp_path, **extra):
    env = {'PATH': os.environ['PATH'], 'YOISAKI_DATA_ROOT': str(tmp_path / 'data'), **extra}
    return subprocess.run(['bash', '-c', f'source "{APP}/cloudcompute/lib.sh"; {script}'], env=env, capture_output=True, text=True)


def test_prepare_dirs_creates_private_sync_folders(tmp_path):
    assert bash('yoisaki_prepare_dirs', tmp_path).returncode == 0
    for d in ('runtime/sync', 'config/rclone', 'models/.yoisaki-sync'):
        assert stat.S_IMODE((tmp_path / 'data' / d).stat().st_mode) == 0o700, d
    assert stat.S_IMODE((tmp_path / 'data/config').stat().st_mode) == 0o711  # engine user may traverse, not list


def test_redaction_covers_google_tokens():
    out = subprocess.run(['bash', '-c', f'source "{APP}/cloudcompute/lib.sh"; printf "%s\\n" "ya29.a0AfB_secret" "x 1//0gSECRETSECRETSECRETSECRET" \'{{"refresh_token": "abc"}}\' GOCSPX-abcdef | yoisaki_redact'],
                         capture_output=True, text=True).stdout
    assert 'secret' not in out.lower() and '"abc"' not in out and 'abcdef' not in out


@needs_rclone
def test_shell_wrapper_connect_reads_token_from_hidden_stdin(env, tmp_path):
    fake = tmp_path / 'fake-rclone'
    fake.write_text('#!/bin/sh\necho "oauth2: invalid_grant" >&2\nexit 1\n')
    fake.chmod(0o755)
    run_env = {'PATH': os.environ['PATH'], 'YOISAKI_DATA_ROOT': str(env.data), 'YOISAKI_IN_IMAGE': '1', 'YOISAKI_PYTHON': sys.executable,
               'YOISAKI_ENGINE_DIR': str(APP / 'engine'), 'YOISAKI_RCLONE': str(fake)}
    (env.data / 'config/rclone/rclone.conf').unlink()
    r = subprocess.run(['bash', str(APP / 'drive-sync-cloudcompute.sh'), 'connect'], input=json.dumps(TOKEN) + '\n', env=run_env,
                       capture_output=True, text=True, timeout=120)
    conf = env.data / 'config/rclone/rclone.conf'
    assert conf.exists() and stat.S_IMODE(conf.stat().st_mode) == 0o600 and 'scope = drive.readonly' in conf.read_text()
    assert TOKEN['refresh_token'] not in r.stdout + r.stderr and TOKEN['access_token'] not in r.stdout + r.stderr
    assert r.returncode == 1 and 'AUTH_FAILED' not in r.stdout  # the access check failed with a clear message
    assert 'Google отклонил авторизацию' in r.stdout + r.stderr
    assert subprocess.run(['bash', str(APP / 'drive-sync-cloudcompute.sh'), 'bogus'], env=run_env, capture_output=True).returncode == 2
    off = subprocess.run(['bash', str(APP / 'drive-sync-cloudcompute.sh'), 'sync'], env={**run_env, 'YOISAKI_DRIVE_SYNC': '0'}, capture_output=True, text=True)
    assert off.returncode != 0 and 'отключена' in off.stderr


def test_compose_dockerfile_and_start_script_policies():
    compose = (APP / 'docker-compose.yml').read_text()
    assert '/models:/data/models:${YOISAKI_MODELS_MOUNT:-ro}' in compose  # read-only unless sync is enabled
    assert 'YOISAKI_DRIVE_SYNC: "${YOISAKI_DRIVE_SYNC:-1}"' in compose and 'ports:' not in compose
    start = (APP / 'start-cloudcompute.sh').read_text()
    assert 'export YOISAKI_MODELS_MOUNT=ro; else export YOISAKI_MODELS_MOUNT=rw' in start
    docker = (APP / 'Dockerfile').read_text()
    pip_layer, rclone_layer, copy_engine = docker.index('pip check'), docker.index('install -y --no-install-recommends rclone'), docker.index('COPY engine/ /opt/yoisaki/engine/')
    assert pip_layer < rclone_layer < copy_engine  # the ~7 GB dependency layer stays cached on upgrade
    assert 'drive-sync-cloudcompute.sh' in docker and '!drive-sync-cloudcompute.sh' in (APP / '.dockerignore').read_text()
    assert (APP / 'cloudcompute/VERSION').read_text().strip() == '1.7.7'


def test_engine_and_colab_do_not_reference_sync():
    for path in (APP / 'engine').rglob('*.py'):
        text = path.read_text()
        assert 'drive_sync' not in text and 'rclone' not in text and '/sync/' not in text, path
    nb = next((APP / 'colab').glob('*.ipynb')).read_text().lower()
    assert 'rclone' not in nb and 'drive_sync' not in nb


def test_diagnostics_report_includes_sync_state_without_secrets(tmp_path, monkeypatch, capsys):
    import diagnose
    monkeypatch.setenv('YOISAKI_DATA_ROOT', str(tmp_path / 'data'))
    monkeypatch.setenv('YOISAKI_ENGINE_DIR', str(APP / 'engine'))
    SyncService(SyncConfig()).connect(TOKEN)
    assert diagnose.main(['diagnose.py', '--json']) == 0
    out = capsys.readouterr().out
    data = json.loads(out)
    assert data['drive_sync']['configured'] is True and data['drive_sync']['remote_type'] == 'drive'
    assert TOKEN['refresh_token'] not in out and TOKEN['access_token'] not in out
    assert diagnose.main(['diagnose.py']) == 0
    text = capsys.readouterr().out
    assert 'Google Drive:   подключён' in text and TOKEN['refresh_token'] not in text


@needs_rclone
def test_write_check_needs_staging_not_models_root(env, monkeypatch):
    """Found in the Docker run: the engine user owns models/.yoisaki-sync and the kind folders, not models/ itself."""
    model(env.drive / 'loras/a.safetensors', 'lora', 40_000)
    env.cfg.staging.mkdir(exist_ok=True)
    real = os.access
    monkeypatch.setattr(drive_sync.os, 'access', lambda p, m: False if Path(p) == env.models else real(p, m))
    assert run(env.service())['job']['state'] == 'COMPLETED'
    monkeypatch.setattr(drive_sync.os, 'access', lambda p, m: False if Path(p) in (env.models, env.cfg.staging) else real(p, m))
    with pytest.raises(SyncError) as e:
        env.service().start('sync')
    assert e.value.code == 'READ_ONLY'


@pytest.mark.skipif(importlib.util.find_spec('fastapi') is None or importlib.util.find_spec('torch') is None,
                    reason='engine dependencies (run inside the YOISAKI image)')
def test_real_launcher_serves_engine_and_sync_routes(tmp_path):
    """Real launcher → serve_cloud.py → unchanged engine app (CUDA test double), loopback only, token from the state file."""
    import urllib.request, urllib.error, signal
    engine = tmp_path / 'engine'
    shutil.copytree(APP / 'engine', engine, ignore=shutil.ignore_patterns('.venv', '.results', '__pycache__'))
    (engine / 'sitecustomize.py').write_text("import torch\ntorch.cuda.is_available = lambda: True\n"
                                             "torch.cuda.get_device_name = lambda *a: 'TEST_DOUBLE_NOT_REAL_GPU'\n"
                                             "torch.cuda.mem_get_info = lambda *a: (15 * 2**30, 16 * 2**30)\n")
    env = {**os.environ, 'YOISAKI_DATA_ROOT': str(tmp_path / 'data'), 'YOISAKI_ENGINE_DIR': str(engine), 'YOISAKI_TUNNEL': '0',
           'YOISAKI_GPU_PREFLIGHT': '0', 'YOISAKI_PORT': '18767'}
    proc = subprocess.Popen([sys.executable, str(APP / 'cloudcompute/launcher.py'), 'run'], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    state = tmp_path / 'data/runtime/state'
    try:
        end = time.time() + 90
        while time.time() < end and not ((state / 'launcher.json').exists() and json.loads((state / 'launcher.json').read_text())['phase'] == 'READY'):
            assert proc.poll() is None
            time.sleep(0.5)
        token = (state / 'token').read_text().strip()
        req = lambda path, t=None: urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:18767' + path, headers={'Authorization': 'Bearer ' + t} if t else {}), timeout=10)
        with pytest.raises(urllib.error.HTTPError) as e:
            req('/sync/status')
        assert e.value.code == 401
        snap = json.load(req('/sync/status', token))
        assert snap['service'] == 'YOISAKI_DRIVE_SYNC' and snap['configured'] is False and snap['source'] == 'YOISAKI_AI_STUDIO/models'
        health = json.load(req('/health', token))
        assert health['engine_version'] == '1.7.0' and health['api_version'] == '1.7.0' and health['state'] == 'READY'
        proc.send_signal(signal.SIGTERM)
        out, _ = proc.communicate(timeout=60)
    finally:
        if proc.poll() is None:
            proc.kill()
    assert proc.returncode == 0 and token not in out
