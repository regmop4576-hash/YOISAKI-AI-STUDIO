"""v1.7.3 Easy Connect, GPU side: the model folder chosen on the website (Drive folder ID → rclone root_folder_id).

Uses the REAL rclone binary against a local folder (alias backend), like test_v172_drive_sync.py. The Google Drive
backend itself (root_folder_id against a real account) is NOT exercised here and must be accepted on a real instance.
"""
import json, stat, time
import pytest

from test_v172_drive_sync import (APP, TOKEN, SyncConfig, SyncError, SyncService, drive_sync, env, model, needs_fastapi,  # noqa: F401
                                  needs_rclone, run, by_path)

FOLDER = '1AbCdEfGhIjKlMnOpQrStUv'


def test_connect_with_chosen_folder_writes_root_folder_id_and_private_label(tmp_path):
    cfg = SyncConfig({'YOISAKI_DATA_ROOT': str(tmp_path / 'data')})
    service = SyncService(cfg)
    snap = service.connect(json.dumps(TOKEN), folder_id=FOLDER, folder_label='YOISAKI_AI_STUDIO/models')
    conf = cfg.rclone_conf.read_text()
    assert f'root_folder_id = {FOLDER}\n' in conf and 'scope = drive.readonly' in conf
    assert stat.S_IMODE(cfg.source_file.stat().st_mode) == 0o600
    assert snap['source'] == 'YOISAKI_AI_STUDIO/models' and snap['source_kind'] == 'folder' and snap['folder_select'] is True
    assert drive_sync.remote_spec(cfg, 'loras/a.safetensors') == 'yoisaki-gdrive:loras/a.safetensors'
    assert FOLDER not in json.dumps(snap)  # the Drive ID stays on the server
    # Re-connecting without a folder returns to YOISAKI_DRIVE_PATH.
    snap = service.connect(json.dumps(TOKEN))
    assert 'root_folder_id' not in cfg.rclone_conf.read_text() and not cfg.source_file.exists()
    assert snap['source'] == 'YOISAKI_AI_STUDIO/models' and snap['source_kind'] == 'path'
    assert drive_sync.remote_spec(cfg) == 'yoisaki-gdrive:YOISAKI_AI_STUDIO/models'
    service.connect(json.dumps(TOKEN), folder_id=FOLDER, folder_label='x')
    service.disconnect()
    assert not cfg.rclone_conf.exists() and not cfg.source_file.exists()


@pytest.mark.parametrize('folder', ["x' or 1", 'short', 'a/b' * 5, 'a\nroot_folder_id = evil', 'A' * 201])
def test_connect_rejects_unsafe_folder_ids(tmp_path, folder):
    service = SyncService(SyncConfig({'YOISAKI_DATA_ROOT': str(tmp_path / 'data')}))
    with pytest.raises(SyncError) as e:
        service.connect(json.dumps(TOKEN), folder_id=folder, folder_label='x')
    assert e.value.code == 'INVALID_FOLDER'
    assert not service.cfg.rclone_conf.exists()


def test_tampered_source_file_is_ignored(tmp_path):
    cfg = SyncConfig({'YOISAKI_DATA_ROOT': str(tmp_path / 'data')})
    cfg.state.mkdir(parents=True)
    cfg.source_file.write_text(json.dumps({'folder_id': '../../etc', 'label': 'x'}))
    assert drive_sync.folder_override(cfg) is None and drive_sync.remote_spec(cfg) == 'yoisaki-gdrive:YOISAKI_AI_STUDIO/models'


def test_controlnet_folder_is_still_not_synced():
    # The engine's ControlNet uses fixed prefetched models; Drive files there would be listed but unusable.
    assert drive_sync.classify({'Path': 'controlnet/c.safetensors', 'Size': 10**7}) is None


@needs_rclone
def test_sync_through_the_chosen_folder_root(env):
    """With a chosen folder the remote root IS that folder: models/… paths are read relative to it."""
    model(env.drive / 'loras/characters/Amber_Nova.safetensors', 'lora', 50_000)
    model(env.drive / 'checkpoints/wai.safetensors', 'checkpoint', 300_000)
    # Alias remote = the chosen folder itself (stands in for root_folder_id of the drive backend).
    env.cfg.rclone_conf.write_text(f'[yoisaki-gdrive]\ntype = alias\nremote = {env.drive}\n')
    env.cfg.state.mkdir(parents=True, exist_ok=True)
    env.cfg.source_file.write_text(json.dumps({'folder_id': FOLDER, 'label': 'Моя папка/models'}))
    snap = run(env.service(), 'sync')
    assert snap['job']['state'] == 'COMPLETED', snap['job']
    assert by_path(snap)['loras/characters/Amber_Nova.safetensors']['state'] == 'INSTALLED'
    assert (env.models / 'checkpoints/wai.safetensors').read_bytes() == (env.drive / 'checkpoints/wai.safetensors').read_bytes()
    assert snap['source'] == 'Моя папка/models' and snap['source_kind'] == 'folder'
    assert any(c[2] == 'lsjson' and c[-1] == 'yoisaki-gdrive:' for c in env.calls())


@needs_fastapi
def test_connect_route_accepts_folder_and_rejects_bad_ids(env, monkeypatch):
    from fastapi.testclient import TestClient
    import serve_cloud
    for k, v in env.environ.items():
        monkeypatch.setenv(k, v)
    token = 'e' * 64
    client = TestClient(serve_cloud.build(str(env.models), token))
    auth = {'Authorization': 'Bearer ' + token}
    assert client.post('/sync/drive/connect', json={'token': json.dumps(TOKEN), 'folder_id': FOLDER}).status_code == 401
    bad = client.post('/sync/drive/connect', headers=auth, json={'token': json.dumps(TOKEN), 'folder_id': '../x', 'folder_label': ''})
    assert bad.status_code == 422 and bad.json()['code'] == 'INVALID_FOLDER'
    ok = client.post('/sync/drive/connect', headers=auth, json={'token': json.dumps(TOKEN), 'folder_id': FOLDER, 'folder_label': 'YOISAKI_AI_STUDIO/models'})
    assert ok.status_code == 200 and ok.json()['source_kind'] == 'folder' and ok.json()['folder_select'] is True
    assert TOKEN['refresh_token'] not in ok.text and FOLDER not in ok.text
    # Older websites (no folder fields) keep working.
    assert client.post('/sync/drive/connect', headers=auth, json={'token': json.dumps(TOKEN)}).json()['source_kind'] == 'path'
