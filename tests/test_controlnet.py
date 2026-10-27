"""CPU tests; synthetic detector contracts are NOT neural inference evidence."""
import sys,io,base64,unittest,tempfile,weakref,gc,types
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'engine'))
from PIL import Image,ImageDraw
import numpy as np
from inference.controlnet import preprocess,decode_image,encode_image,validate_control,ControlNetError,to_base,activate
from worker.direct_server import AdapterRequest,create_app
from fastapi.testclient import TestClient

class ControlTests(unittest.TestCase):
    def setUp(self):
        with Image.new('RGB',(320,160),'black') as im:
            ImageDraw.Draw(im).rectangle((50,30,270,130),outline='white',width=6)
            self.image=encode_image(im)
    def request(self,**kw):
        return dict(image=self.image,type='Canny',prepared=False,width=256,height=512,**kw)
    def config(self,mode='Canny'):
        return dict(enabled=True,type=mode,map_type=mode,image=self.image,strength=.8,start=0,end=1)
    def test_canny_real_deterministic_letterbox(self):
        a=preprocess(self.request());self.assertEqual(a,preprocess(self.request()))
        with decode_image(a['image']) as im:
            ar=np.asarray(im);self.assertEqual(im.size,(256,512));self.assertEqual(ar[:190].max(),0);self.assertGreater(ar[192:320].max(),0)
    def test_prepared_all_modes(self):
        for mode in ('Canny','OpenPose','Depth'):
            a=preprocess(dict(self.request(),type=mode,prepared=True));self.assertEqual(a['type'],mode)
            validate_control(dict(self.config(mode),image=a['image']))
    def test_reject_empty_and_bad_images(self):
        for mode in ('Canny','OpenPose','Depth'):
            with Image.new('RGB',(256,256)) as im:
                with self.assertRaises(ControlNetError):preprocess(dict(self.request(),image=encode_image(im),type=mode,prepared=True))
        for image in (None,'data:image/svg+xml;base64,AA==','data:image/png;base64,AA==','x'*9000000):
            with self.assertRaises(ControlNetError):decode_image(image)
    def test_parameters_and_conflict(self):
        validate_control({'enabled':False})
        for patch_ in ({'image':None},{'start':1},{'start':.5,'end':.5},{'end':1.1},{'strength':float('nan')},{'map_type':'Depth'},{'type':'bad'}):
            with self.assertRaises(ControlNetError):validate_control(dict(self.config(),**patch_))
        with self.assertRaisesRegex(ControlNetError,'Одновременная'):validate_control(self.config(),[{'enabled':True}])
    def test_python_request_schema(self):
        base=dict(prompt='fox',checkpoint_id='a'*32,width=256,height=512,steps=2,cfg_scale=5,sampler='Euler',scheduler='Normal',seed=1,batch_size=2,controlnet_config=self.config())
        self.assertEqual(AdapterRequest(**base).model_dump()['controlnet_config'],self.config())
        with self.assertRaises(ValueError):AdapterRequest(**dict(base,controlnet_config=dict(self.config(),end=0)))
    def test_authenticated_api_real_canny(self):
        with tempfile.TemporaryDirectory() as tmp:
            app=create_app(Path(tmp)/'models','a'*64)
            with TestClient(app) as c:
                self.assertEqual(c.post('/controlnet/preprocess',json=self.request()).status_code,401)
                headers={'Authorization':'Bearer '+'a'*64}
                r=c.post('/controlnet/preprocess',headers=headers,json=self.request());self.assertEqual(r.status_code,200,r.text)
                self.assertEqual(r.json()['type'],'Canny')
                self.assertEqual(c.post('/controlnet/preprocess',headers=headers,json=dict(self.request(),image='bad')).status_code,422)
                h=c.get('/health',headers=headers).json();self.assertEqual(h['engine_version'],'1.7.0');self.assertTrue(h['capabilities']['controlnet'])
    def test_pipeline_sharing_and_release_contract(self):
        # Test orchestration independently of unavailable torch/CUDA, not model accuracy.
        class Model:
            config=types.SimpleNamespace(in_channels=4,block_out_channels=(320,640,1280),addition_embed_type='text_time')
            @classmethod
            def from_pretrained(cls,*a,**kw):return cls()
        class Base:
            def __init__(self,unet=None):self.unet=unet or Model();self.events=[]
            @classmethod
            def from_pipe(cls,p,**kw):
                new=cls(p.unet)
                if 'controlnet' in kw:new.controlnet=kw['controlnet']
                return new
            def remove_all_hooks(self):self.events.append('remove')
            def to(self,*a):self.events.append('cpu')
            def enable_model_cpu_offload(self):self.events.append('offload')
        class CN(Base):pass
        fake=types.SimpleNamespace(ControlNetModel=Model,StableDiffusionXLPipeline=Base,StableDiffusionXLControlNetPipeline=CN)
        torch=types.SimpleNamespace(float16='float16',cuda=types.SimpleNamespace(is_available=lambda:False))
        a=types.SimpleNamespace(pipe=Base(),measure=lambda p:None,unload=lambda:None)
        unet=a.pipe.unet
        with patch.dict(sys.modules,{'diffusers':fake,'torch':torch}):
            for mode in ('Canny','Depth','OpenPose'):
                p=activate(a,mode);self.assertIs(p.unet,unet);ref=weakref.ref(p.controlnet);del p
                to_base(a);gc.collect();self.assertIsNone(ref());self.assertIs(a.pipe.unet,unet);self.assertFalse(hasattr(a.pipe,'controlnet'))

if __name__=='__main__':unittest.main(verbosity=2)
