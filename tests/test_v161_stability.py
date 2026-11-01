"""v1.6.1 engine API regressions (AUD-006 resumable preprocessing, AUD-007 bounded job table).
Synthetic GPU test double and synthetic preprocessing delay: transport/lifecycle only, NOT CUDA inference."""
import sys, time, threading, json, struct
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine'))
import pytest
from fastapi.testclient import TestClient
from PIL import Image
import worker.direct_server as ds
from worker.direct_server import create_app
from worker.models import scan

TOKEN = 'b' * 64
AUTH = {'Authorization': 'Bearer ' + TOKEN}

def checkpoint(root):
    p = root / 'checkpoints/a.safetensors'; p.parent.mkdir(parents=True, exist_ok=True)
    h = {'__metadata__': {}, **{k: {'dtype': 'F32', 'shape': [1], 'data_offsets': [0, 4]} for k in ['conditioner.embedders.1.x', 'model.diffusion_model.x']}}
    b = json.dumps(h).encode(); p.write_bytes(struct.pack('<Q', len(b)) + b + b'1234')
    return scan(root)[0]['id']

@pytest.fixture
def gpu_double(monkeypatch):
    import torch
    monkeypatch.setattr(torch.cuda, 'is_available', lambda: True)
    monkeypatch.setattr(torch.cuda, 'get_device_name', lambda: 'TEST_DOUBLE_NOT_REAL_GPU')
    monkeypatch.setattr(torch.cuda, 'mem_get_info', lambda: (1024, 2048))
    monkeypatch.setattr(torch.cuda, 'reset_peak_memory_stats', lambda: None)

def wait_status(c, ident, wanted=('COMPLETED', 'FAILED', 'CANCELLED')):
    for _ in range(500):
        s = c.get('/jobs/' + ident, headers=AUTH).json()
        if s['status'] in wanted: return s
        time.sleep(.01)
    raise AssertionError(s)

def test_aud006_preprocess_resumes_same_operation_and_never_runs_untracked(tmp_path, monkeypatch, gpu_double):
    import inference.controlnet as cn
    calls = []; release = threading.Event()
    def slow(data):
        calls.append(data['type']); release.wait(5)
        return {'image': 'data:image/png;base64,AAAA', 'type': data['type'], 'width': data['width'], 'height': data['height']}
    monkeypatch.setattr(cn, 'preprocess', slow)
    monkeypatch.setattr(ds, 'PREPROCESS_WAIT', 0.2)
    body = dict(image='data:image/png;base64,AAAA', type='Depth', prepared=False, width=512, height=512)
    with TestClient(create_app(tmp_path / 'models', TOKEN)) as c:
        first = c.post('/controlnet/preprocess', headers=AUTH, json=body)
        assert first.status_code == 200 and first.json() == {'status': 'PENDING'}
        again = c.post('/controlnet/preprocess', headers=AUTH, json=body)      # identical request resumes
        assert again.json() == {'status': 'PENDING'}
        other = c.post('/controlnet/preprocess', headers=AUTH, json={**body, 'type': 'Canny'})
        assert other.status_code == 409 and 'выполняется' in other.json()['detail']
        release.set()
        done = c.post('/controlnet/preprocess', headers=AUTH, json=body)
        assert done.status_code == 200 and done.json()['type'] == 'Depth'
        assert calls == ['Depth'], 'repeated requests must not start a second detector run'
        release.clear(); release.set()
        assert c.post('/controlnet/preprocess', headers=AUTH, json={**body, 'type': 'Canny'}).json()['type'] == 'Canny'
        assert calls == ['Depth', 'Canny']

def test_aud006_preprocess_errors_and_busy_queue(tmp_path, monkeypatch, gpu_double):
    import inference.controlnet as cn
    from inference.text2img import InferenceAdapter
    monkeypatch.setattr(ds, 'PREPROCESS_WAIT', 0.2)
    def bad(data): raise cn.ControlNetError('Поза не обнаружена.')
    monkeypatch.setattr(cn, 'preprocess', bad)
    started = threading.Event(); release = threading.Event()
    def fake(self, req, progress):
        started.set(); release.wait(5); return [Image.new('RGB', (8, 8))], 1
    monkeypatch.setattr(InferenceAdapter, 'generate', fake); monkeypatch.setattr(InferenceAdapter, 'unload', lambda self: None)
    monkeypatch.setattr(InferenceAdapter, 'finish_job', lambda self: None)
    mid = checkpoint(tmp_path)
    body = dict(image='data:image/png;base64,AAAA', type='OpenPose', prepared=False, width=512, height=512)
    with TestClient(create_app(tmp_path, TOKEN)) as c:
        r = c.post('/controlnet/preprocess', headers=AUTH, json=body)
        assert r.status_code == 422 and 'Поза' in r.json()['detail']
        job = c.post('/generate', headers=AUTH, json=dict(prompt='fox', checkpoint_id=mid, width=512, height=512, steps=2, cfg_scale=5,
                                                           sampler='Euler', scheduler='Normal', seed=1, batch_size=1)).json()['id']
        assert started.wait(2)
        busy = c.post('/controlnet/preprocess', headers=AUTH, json=body)
        assert busy.status_code == 409 and 'GPU занят' in busy.json()['detail']
        release.set(); wait_status(c, job)

def test_aud007_more_than_100_jobs_with_safe_pruning(tmp_path, monkeypatch, gpu_double):
    from inference.text2img import InferenceAdapter
    def fake(self, req, progress):
        progress(1, 'TEST_ONLY')
        if req['prompt'] == 'fail': raise RuntimeError('synthetic failure')
        return [Image.new('RGB', (8, 8))], req['seed']
    monkeypatch.setattr(InferenceAdapter, 'generate', fake); monkeypatch.setattr(InferenceAdapter, 'unload', lambda self: None)
    monkeypatch.setattr(InferenceAdapter, 'finish_job', lambda self: None)
    mid = checkpoint(tmp_path)
    req = lambda prompt='fox', seed=1: dict(prompt=prompt, checkpoint_id=mid, width=512, height=512, steps=2, cfg_scale=5,
                                            sampler='Euler', scheduler='Normal', seed=seed, batch_size=1)
    with TestClient(create_app(tmp_path, TOKEN)) as c:
        # 130 sequential jobs; the website collects + ACKs each result (normal flow).
        ids = []
        for i in range(130):
            r = c.post('/generate', headers=AUTH, json=req(seed=i)); assert r.status_code == 200, (i, r.text)
            ident = r.json()['id']; ids.append(ident)
            assert wait_status(c, ident)['status'] == 'COMPLETED'
            assert c.get(f'/results/{ident}', headers=AUTH).status_code == 200
            assert c.post(f'/jobs/{ident}/ack', headers=AUTH).status_code == 200
        assert c.get('/jobs/' + ids[0], headers=AUTH).status_code == 404       # old acknowledged record pruned
        assert c.get('/jobs/' + ids[-1], headers=AUTH).json()['status'] == 'COMPLETED'
        # Unacknowledged results and recent failures are never pruned: the table fills and refuses explicitly.
        keep = []
        for i in range(130):   # ~99 acknowledged records are evicted first, then the table fills
            r = c.post('/generate', headers=AUTH, json=req('fail' if i % 10 == 0 else 'fox', seed=i))
            if r.status_code == 429:
                assert 'непринятыми' in r.json()['detail']; break
            keep.append(r.json()['id']); wait_status(c, keep[-1])
        else:
            raise AssertionError('table never filled with unacknowledged results')
        for ident in keep:
            s = c.get('/jobs/' + ident, headers=AUTH)
            assert s.status_code == 200 and s.json()['status'] in ('COMPLETED', 'FAILED')
        # Once the website acknowledges, generation is accepted again.
        for ident in keep[:5]:
            if c.get('/jobs/' + ident, headers=AUTH).json()['status'] == 'COMPLETED':
                c.post(f'/jobs/{ident}/ack', headers=AUTH)
        r = c.post('/generate', headers=AUTH, json=req(seed=999)); assert r.status_code == 200, r.text
        assert wait_status(c, r.json()['id'])['status'] == 'COMPLETED'

def test_aud007_old_failures_pruned_after_grace(tmp_path, monkeypatch, gpu_double):
    from inference.text2img import InferenceAdapter
    def fake(self, req, progress): raise RuntimeError('synthetic failure')
    monkeypatch.setattr(InferenceAdapter, 'generate', fake); monkeypatch.setattr(InferenceAdapter, 'unload', lambda self: None)
    monkeypatch.setattr(InferenceAdapter, 'finish_job', lambda self: None)
    monkeypatch.setattr(ds, 'FINISHED_GRACE_SECONDS', 0)
    mid = checkpoint(tmp_path)
    with TestClient(create_app(tmp_path, TOKEN)) as c:
        for i in range(105):
            r = c.post('/generate', headers=AUTH, json=dict(prompt='x', checkpoint_id=mid, width=512, height=512, steps=2, cfg_scale=5,
                                                             sampler='Euler', scheduler='Normal', seed=i, batch_size=1))
            assert r.status_code == 200, (i, r.text)
            assert wait_status(c, r.json()['id'])['status'] == 'FAILED'
