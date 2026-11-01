import sys,struct,json,tempfile,time,threading,subprocess,os
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'engine'))
import pytest
from fastapi.testclient import TestClient
from worker.direct_server import create_app,AdapterRequest
from worker.models import scan,resolve,model_id
from panel import gpu,Controller,Panel
TOKEN='a'*64
AUTH={'Authorization':'Bearer '+TOKEN}
def safe(p,kind='checkpoint'):
    p.parent.mkdir(parents=True,exist_ok=True)
    keys={'checkpoint':['conditioner.embedders.1.foo','model.diffusion_model.foo'],'lora':['lora_te2_foo'],'vae':['decoder.conv_in.weight','encoder.conv_out.weight']}[kind]
    h={'__metadata__':{'trigger':'vesperfox'},**{k:{'dtype':'F32','shape':[1],'data_offsets':[0,4]} for k in keys}}
    b=json.dumps(h).encode();p.write_bytes(struct.pack('<Q',len(b))+b+b'1234')
def request(mid):return dict(prompt='fox',checkpoint_id=mid,width=512,height=512,steps=2,cfg_scale=7,sampler='Euler',scheduler='Normal',seed=1,batch_size=1)
def test_catalog_and_escape(tmp_path):
    safe(tmp_path/'checkpoints/a.safetensors');safe(tmp_path/'loras/b.safetensors','lora');safe(tmp_path/'vae/c.safetensors','vae')
    (tmp_path/'loras/b.json').write_text('{"trainedWords":["vesperfox"]}')
    rows=scan(tmp_path);assert len(rows)==3
    assert next(m for m in rows if m['kind']=='lora')['trigger_words']==['vesperfox']
    assert resolve(tmp_path,rows[0]['id'],'checkpoint').name=='a.safetensors'
    outside=tmp_path.parent/'outside.safetensors';safe(outside)
    (tmp_path/'checkpoints/escape.safetensors').symlink_to(outside)
    assert len(scan(tmp_path))==3
    with pytest.raises(ValueError):resolve(tmp_path,'../../etc/passwd','checkpoint')
def test_auth_health_and_limits(tmp_path):
    from urllib.parse import urlsplit,parse_qs
    assert parse_qs(urlsplit('https://example.trycloudflare.com/#token='+TOKEN).fragment)['token']==[TOKEN]
    with TestClient(create_app(tmp_path,TOKEN)) as c:
        for url in ['/health','/models','/jobs/no','/results/no']:assert c.get(url).status_code==401
        assert c.get('/health',headers=AUTH).json()['engine_version']=='1.7.0'
        assert c.get('/models',headers=AUTH).json()=={'models':[]}
        assert c.post('/generate',headers=AUTH,content='x'*12582913).status_code==413
        assert c.get('/results/../etc/passwd',headers=AUTH).status_code==404
        assert c.get('/jobs/no',headers=AUTH).status_code==404
        assert c.options('/generate',headers={'Origin':'https://studio.example','Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'authorization,content-type'}).status_code==200
        assert c.post('/generate',headers=AUTH,json=request('b'*32)).status_code==503
@pytest.mark.parametrize('update',[{'width':513},{'batch_size':3},{'steps':100},{'vae_id':'/etc/passwd'},{'mode':'inpaint'},{'lora_adapters':[{'id':'b'*32,'weight':float('nan')}]},{'sampler':'Euler a','scheduler':'Karras'}])
def test_request_validation(update):
    with pytest.raises(ValueError):AdapterRequest(**(request('a'*32)|update))
def test_panel_no_gpu():
    assert gpu()['cuda'] is False
    p=Panel();assert len(p.buttons)==4;assert 'GPU недоступен' in p.status.value
    p.action(p.start);assert 'GPU недоступен' in p.error.value
    p.close()
def test_real_http_process(tmp_path):
    import urllib.request,urllib.error,socket
    with socket.socket() as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
    env=os.environ|{'PYTHONPATH':str(Path(__file__).resolve().parents[1]/'engine'),'YOISAKI_TOKEN':TOKEN,'YOISAKI_MODEL_ROOT':str(tmp_path),'YOISAKI_PORT':str(port)}
    p=subprocess.Popen([sys.executable,'-m','worker.serve'],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    try:
        for _ in range(50):
            try:
                req=urllib.request.Request(f'http://127.0.0.1:{port}/health',headers=AUTH)
                with urllib.request.urlopen(req,timeout=1) as r:assert json.load(r)['engine']=='YOISAKI_ENGINE'
                break
            except OSError:time.sleep(.1)
        else:pytest.fail('server startup failed')
    finally:p.terminate();p.wait(timeout=15)
    assert p.returncode in (0,-15)
def test_job_protocol_with_test_double(tmp_path,monkeypatch):
    """Synthetic transport test ONLY. Does not claim CUDA or diffusion success."""
    import torch
    from PIL import Image
    from inference.text2img import InferenceAdapter
    monkeypatch.setattr(torch.cuda,'is_available',lambda:True)
    monkeypatch.setattr(torch.cuda,'get_device_name',lambda:'TEST_DOUBLE_NOT_REAL_GPU')
    monkeypatch.setattr(torch.cuda,'mem_get_info',lambda:(1024,2048))
    started=threading.Event();release=threading.Event()
    def fake(self,req,progress):
        started.set();release.wait(3);progress(1,'TEST_ONLY');return [Image.new('RGB',(8,8))],req['seed']
    monkeypatch.setattr(InferenceAdapter,'generate',fake)
    monkeypatch.setattr(InferenceAdapter,'unload',lambda self:None)
    safe(tmp_path/'checkpoints/a.safetensors')
    mid=scan(tmp_path)[0]['id']
    with TestClient(create_app(tmp_path,TOKEN)) as c:
        first=c.post('/generate',headers=AUTH,json=request(mid));assert first.status_code==200
        ident=first.json()['id'];assert started.wait(2)
        queued=c.post('/generate',headers=AUTH,json=request(mid));assert queued.status_code==200
        assert c.delete('/jobs/'+queued.json()['id'],headers=AUTH).json()['status']=='CANCELLED'
        assert c.get('/health',headers=AUTH).json()['state']=='BUSY'
        release.set()
        for _ in range(100):
            status=c.get('/jobs/'+ident,headers=AUTH).json()
            if status['status']=='COMPLETED':break
            time.sleep(.01)
        assert status['result']['seed']==1
        assert c.get('/results/'+ident,headers=AUTH).headers['content-type']=='image/png'
        assert c.get('/results/'+ident+'?index=100',headers=AUTH).status_code==404
        started.clear();release.clear()
        second=c.post('/generate',headers=AUTH,json=request(mid)).json()['id'];assert started.wait(2)
        assert c.delete('/jobs/'+second,headers=AUTH).json()['status']=='CANCELLED'
        queued=c.post('/generate',headers=AUTH,json=request(mid));assert queued.status_code==200
        assert c.delete('/jobs/'+queued.json()['id'],headers=AUTH).json()['status']=='CANCELLED'
        release.set()
