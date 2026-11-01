"""Provider-independent tests; Google account and physical GPU are not used."""
import sys, json, os, struct, subprocess
from pathlib import Path
import pytest
APP=Path(__file__).resolve().parents[1]
sys.path[:0]=[str(APP/'cloudcompute'),str(APP/'engine')]
from drive_sync import SyncConfig, SyncService, selected_folder, remote_spec, SyncError
from launcher import Config, prepare
from check_dependencies import missing
from inventory import compact, revision
TOKEN={'access_token':'test-access','refresh_token':'test-refresh','expiry':'2099-01-01T00:00:00Z'}
CLIENT=('123456789-abcdefghij.apps.googleusercontent.com','GOCSPX-test_secret')

def test_selected_folder_survives_restart_and_cannot_inject_config(tmp_path):
    env={'YOISAKI_DATA_ROOT':str(tmp_path)}
    prepare(Config(env));service=SyncService(SyncConfig(env))
    service.connect(TOKEN,*CLIENT,'folder-123')
    cfg=SyncConfig(env)
    assert selected_folder(cfg)=='folder-123'
    assert remote_spec(cfg,'loras/new.safetensors')=='yoisaki-gdrive:loras/new.safetensors'
    assert service.status()['folder_selection'] is True
    assert cfg.rclone_conf.stat().st_mode & 0o777==0o600
    before=cfg.rclone_conf.read_bytes()
    with pytest.raises(SyncError):service.connect(TOKEN,*CLIENT,'id\nremote = attacker')
    assert cfg.rclone_conf.read_bytes()==before
    SyncService(cfg).disconnect()
    assert not cfg.rclone_conf.exists()
    assert remote_spec(cfg)=='yoisaki-gdrive:YOISAKI_AI_STUDIO/models'

def test_folder_binding_api_validates_and_requires_engine_token(tmp_path):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from sync_api import add_routes
    env={'YOISAKI_DATA_ROOT':str(tmp_path)};prepare(Config(env));service=SyncService(SyncConfig(env))
    app=add_routes(FastAPI(),'a'*64,service)
    with TestClient(app) as client:
        body={'token':json.dumps(TOKEN),'client_id':CLIENT[0],'client_secret':CLIENT[1],'root_folder_id':'chosen'}
        assert client.post('/sync/drive/connect',json=body).status_code==401
        headers={'Authorization':'Bearer '+'a'*64}
        assert client.post('/sync/drive/connect',json={**body,'root_folder_id':'bad\nvalue'},headers=headers).status_code==422
        r=client.post('/sync/drive/connect',json=body,headers=headers)
        assert r.status_code==200 and r.json()['folder_selection'] is True
        assert 'test-refresh' not in r.text
        assert selected_folder(SyncConfig(env))=='chosen'

def test_dependency_reuse_rejects_wrong_versions_and_accepts_cuda_local_tag():
    assert missing(['torch==2.10.0\nPillow>=11.3,<13'],lambda name:{'torch':'2.10.0+cu128','Pillow':'12.0'}[name])==[]
    assert missing(['torch==2.10.0'],lambda _: '2.11.0')

def test_data_and_new_lora_inventory_survive_repeated_prepare(tmp_path):
    cfg=Config({'YOISAKI_DATA_ROOT':str(tmp_path)});prepare(cfg)
    marker=(tmp_path/'.yoisaki-data-id').read_bytes();before=revision(cfg.models)
    file=cfg.models/'loras/new.safetensors'
    h=json.dumps({'__metadata__':{'ss_base_model_version':'sdxl_base_v1-0'},'lora_te2_x':{'dtype':'U8','shape':[1],'data_offsets':[0,1]}}).encode()
    file.write_bytes(struct.pack('<Q',len(h))+h+b'x');original=file.read_bytes()
    for _ in range(3):prepare(cfg)
    assert file.read_bytes()==original and (tmp_path/'.yoisaki-data-id').read_bytes()==marker
    assert revision(cfg.models)!=before
    models=compact(cfg.models);assert models[0]['name']=='new.safetensors' and models[0]['compatible'] is True
    file.write_bytes(b'corrupt');models=compact(cfg.models)
    assert models[0]['compatible'] is False and models[0]['detail']
