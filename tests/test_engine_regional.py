"""CPU contract tests. Fake CUDA/adapter below are NOT visual inference validation."""
import sys, unittest, io, base64, time, threading, types
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'engine'))
from PIL import Image
from fastapi.testclient import TestClient
from worker.direct_server import AdapterRequest,create_app
from inference.regional import decode_mask
from inference.text2img import InferenceAdapter

def mask(w=512,h=512,fill=255):
    b=io.BytesIO();Image.new('L',(w,h),fill).save(b,format='PNG');return 'data:image/png;base64,'+base64.b64encode(b.getvalue()).decode()
REQ=dict(prompt='park',checkpoint_id='b'*32,width=512,height=512,steps=4,cfg_scale=5,sampler='Euler',scheduler='Normal',seed=1,batch_size=1)
def region(**kw):return dict(name='A',enabled=True,lora_id='',trigger='amber',prompt='bat',negative_prompt='fox',weight=.8,mask=mask(),**kw)
class SchemaTests(unittest.TestCase):
    def test_off_compatible(self):self.assertEqual(AdapterRequest(**REQ).regions,[])
    def test_one_two_three(self):
        for n in [1,2,3]:self.assertEqual(len(AdapterRequest(**REQ,regions=[region() for _ in range(n)]).regions),n)
    def test_invalid_masks(self):
        for v in ['x','data:image/png;base64,no!',mask(256,512),mask(fill=0)]:
            with self.assertRaises(ValueError):AdapterRequest(**REQ,regions=[{**region(),'mask':v}])
    def test_aspect_ratios(self):
        for w,h in [(768,1024),(1024,576),(512,512)]:self.assertEqual(decode_mask(mask(w,h),w,h).size,(w,h))
    def test_limits(self):
        for overrides in [dict(batch_size=2),dict(width=1536,height=1024)]:
            with self.assertRaises(ValueError):AdapterRequest(**{**REQ,**overrides},regions=[region()])
        with self.assertRaises(ValueError):AdapterRequest(**REQ,regions=[{**region(),'lora_id':'file.ckpt'}])
        with self.assertRaises(ValueError):AdapterRequest(**REQ,regions=[{**region(),'weight':float('nan')}])
    def test_global_character_rejected(self):
        with self.assertRaises(ValueError):AdapterRequest(**REQ,lora_adapters=[{'id':'c'*32,'weight':1}],regions=[{**region(),'lora_id':'c'*32}])

class QueueTests(unittest.TestCase):
    def test_fifo_idempotency_cancel_progress_auth(self):
        gate=threading.Event();entered=threading.Event();order=[]
        def generate(adapter,req,progress):
            order.append(req['seed']);progress(0,'PREPARING');entered.set();gate.wait(3)
            for step in range(1,5):time.sleep(.01);progress(step,'GENERATING')
            progress(4,'DECODING');return [Image.new('RGB',(8,8))],req['seed']
        cuda=types.SimpleNamespace(empty_cache=lambda:None,is_available=lambda:True,mem_get_info=lambda:(10,16),get_device_name=lambda:'TEST DOUBLE')
        token='a'*64;headers={'Authorization':'Bearer '+token}
        with patch.dict(sys.modules,torch=types.SimpleNamespace(cuda=cuda)),patch('worker.direct_server.scan',return_value=[dict(id='b'*32,kind='checkpoint')]),patch('worker.direct_server.resolve'),patch.object(InferenceAdapter,'generate',generate):
            with TestClient(create_app('/unused',token)) as client:
                self.assertEqual(client.get('/health').status_code,401)
                ids=[]
                for i in range(3):
                    key=f'00000000-0000-0000-0000-{i:012d}'
                    body={**REQ,'seed':i,'client_request_id':key}
                    r=client.post('/generate',headers=headers,json=body);self.assertEqual(r.status_code,200,r.text);ids.append(r.json()['id'])
                    if i==0:
                        self.assertTrue(entered.wait(2));self.assertEqual(client.post('/generate',headers=headers,json=body).json()['id'],ids[0])
                        self.assertEqual(client.post('/generate',headers=headers,json={**body,'seed':99}).status_code,409)
                self.assertEqual(client.get('/jobs/'+ids[2],headers=headers).json()['queue_position'],2)
                client.delete('/jobs/'+ids[1],headers=headers);gate.set()
                deadline=time.time()+4
                while time.time()<deadline:
                    j=client.get('/jobs/'+ids[2],headers=headers).json()
                    if j['status']=='COMPLETED':break
                    time.sleep(.01)
                self.assertEqual(j['status'],'COMPLETED');self.assertEqual(order,[0,2]);self.assertEqual(j['progress']['stage'],'DONE');self.assertEqual(j['progress']['step'],4)
                self.assertEqual(client.get('/results/'+ids[2],headers=headers).headers['content-type'],'image/png')
                self.assertEqual(client.get('/jobs/'+ids[1],headers=headers).json()['status'],'CANCELLED')
    def test_running_cancellation(self):
        gate=threading.Event();entered=threading.Event()
        def generate(adapter,req,progress):entered.set();gate.wait(2);progress(1,'GENERATING');raise AssertionError('must cancel')
        cuda=types.SimpleNamespace(empty_cache=lambda:None,is_available=lambda:True,mem_get_info=lambda:(10,16),get_device_name=lambda:'TEST')
        headers={'Authorization':'Bearer '+'a'*64}
        with patch.dict(sys.modules,torch=types.SimpleNamespace(cuda=cuda)),patch('worker.direct_server.scan',return_value=[dict(id='b'*32,kind='checkpoint')]),patch('worker.direct_server.resolve'),patch.object(InferenceAdapter,'generate',generate):
            with TestClient(create_app('/unused','a'*64)) as client:
                ident=client.post('/generate',headers=headers,json=REQ).json()['id'];self.assertTrue(entered.wait(2));client.delete('/jobs/'+ident,headers=headers);gate.set();time.sleep(.05);self.assertEqual(client.get('/jobs/'+ident,headers=headers).json()['status'],'CANCELLED')

class ProgressTests(unittest.TestCase):
    def test_real_clock_eta_and_oom_failure(self):
        entered=threading.Event();gate=threading.Event()
        def generate(adapter,req,progress):
            for step in range(1,4):time.sleep(.02);progress(step,'GENERATING')
            entered.set();gate.wait(2)
            if req['seed']==9:raise RuntimeError('CUDA out of memory')
            progress(4,'GENERATING');progress(4,'DECODING');return [Image.new('RGB',(8,8))],req['seed']
        cuda=types.SimpleNamespace(empty_cache=lambda:None,is_available=lambda:True,mem_get_info=lambda:(10,16),get_device_name=lambda:'TEST')
        headers={'Authorization':'Bearer '+'a'*64}
        with patch.dict(sys.modules,torch=types.SimpleNamespace(cuda=cuda)),patch('worker.direct_server.scan',return_value=[dict(id='b'*32,kind='checkpoint')]),patch('worker.direct_server.resolve'),patch.object(InferenceAdapter,'generate',generate):
            with TestClient(create_app('/unused','a'*64)) as client:
                ident=client.post('/generate',headers=headers,json=REQ).json()['id'];self.assertTrue(entered.wait(2));p=client.get('/jobs/'+ident,headers=headers).json()['progress'];self.assertEqual(p['step'],3);self.assertEqual(p['stage'],'GENERATING');self.assertIsNotNone(p['eta_seconds']);self.assertGreaterEqual(p['elapsed_seconds'],0);gate.set()
                deadline=time.time()+2
                while time.time()<deadline:
                    j=client.get('/jobs/'+ident,headers=headers).json()
                    if j['status']=='COMPLETED':break
                    time.sleep(.01)
                self.assertEqual(j['progress']['stage'],'DONE');self.assertIsNone(j['progress']['eta_seconds'])
                ident=client.post('/generate',headers=headers,json={**REQ,'seed':9}).json()['id'];deadline=time.time()+2
                while time.time()<deadline:
                    j=client.get('/jobs/'+ident,headers=headers).json()
                    if j['status']=='FAILED':break
                    time.sleep(.01)
                self.assertEqual(j['status'],'FAILED');self.assertIn('VRAM',j['error'])
    def test_unsupported_adapter_format(self):
        import tempfile,json,struct
        from inference.regional import validate_regional_adapter
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'test.safetensors';header=json.dumps({'unet.hada_w1_a':{}}).encode();p.write_bytes(struct.pack('<Q',len(header))+header)
            with self.assertRaises(ValueError):validate_regional_adapter(p)

if __name__=='__main__':unittest.main()
