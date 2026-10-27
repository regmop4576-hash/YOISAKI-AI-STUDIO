"""Real CPU tensors, deterministic fake predictor. Does not test image quality."""
import unittest,sys,io,base64
from pathlib import Path
from types import SimpleNamespace
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'engine'))
from unittest.mock import patch
import torch
from PIL import Image
from inference.regional import regional_routing

def png(left=0,right=32):
    im=Image.new('L',(32,32));im.paste(255,(left,0,right,32));b=io.BytesIO();im.save(b,format='PNG');return 'data:image/png;base64,'+base64.b64encode(b.getvalue()).decode()
class Predictor(torch.nn.Module):
    def __init__(self,pipe):super().__init__();self.pipe=pipe
    def forward(self,*args,**kwargs):return self.pipe.forward(*args,**kwargs)
class Pipe:
    def __init__(self):self._execution_device='cpu';self.active=[];self.calls=[];self.encoded=[];self.unet=Predictor(self)
    def enable_lora(self):pass
    def disable_lora(self):self.active=[]
    def set_adapters(self,names,adapter_weights):self.active=list(zip(names,adapter_weights))
    def encode_prompt(self,**kw):
        self.encoded.append((self.active[:],kw));return (torch.ones(1,2,3),torch.zeros(1,2,3),torch.ones(1,3),torch.zeros(1,3))
    def forward(self,sample,timestep,encoder_hidden_states,**kw):
        self.calls.append(self.active[:]);value=1+sum((10 if n=='a' else 20)*w for n,w in self.active);return (torch.ones_like(sample)*value,)
def region(mask,trigger='amber',negative='fox'):return dict(enabled=True,mask=mask,trigger=trigger,prompt='character',negative_prompt=negative)
class RoutingTests(unittest.TestCase):
    def setUp(self):
        p=patch('inference.prompt_encoding.encode_long_prompt',lambda pipe,**kw:pipe.encode_prompt(**kw));p.start();self.addCleanup(p.stop)
    def run_route(self,regions,adapters,cfg=5):
        pipe=Pipe();original=pipe.unet.forward;req=dict(regions=regions,width=32,height=32,cfg_scale=cfg,prompt='park',negative_prompt='bad');calls=[]
        with regional_routing(pipe,req,[],adapters,lambda s,t:calls.append((s,t))):
            result=pipe.unet(torch.zeros(2 if cfg>1 else 1,4,4,4),torch.tensor(1),encoder_hidden_states=torch.ones(1,2,3),added_cond_kwargs={'text_embeds':torch.zeros(1,3),'time_ids':torch.zeros(1,6)},return_dict=False)[0]
        self.assertEqual(pipe.unet.forward,original);self.assertEqual(pipe.active,[]);return pipe,result
    def test_two_separate_strengths_triggers_negatives_background(self):
        p,r=self.run_route([region(png(0,8)),region(png(24,32),'vesper','bat')],[[('a',.5)],[('b',.8)]])
        self.assertTrue(torch.all(r[:,:,:,0]==6));self.assertTrue(torch.all(r[:,:,:,1:3]==1));self.assertTrue(torch.all(r[:,:,:,3]==17));self.assertEqual(p.calls,[[],[('a',.5)],[('b',.8)]]);self.assertIn('park',p.encoded[0][1]['prompt']);self.assertIn('vesper',p.encoded[1][1]['prompt']);self.assertIn('bat',p.encoded[1][1]['negative_prompt'])
    def test_overlap_first_wins(self):
        _,r=self.run_route([region(png()),region(png())],[[('a',1)],[('b',1)]]);self.assertTrue(torch.all(r==11))
    def test_three_and_cfg_off(self):
        _,r=self.run_route([region(png(0,8)),region(png(8,24)),region(png(24,32))],[[('a',1)],[],[('b',1)]],1);self.assertEqual(r.shape[0],1);self.assertTrue(torch.all(r[:,:,:,1:3]==1))
    def test_cleanup_on_exception(self):
        p=Pipe();original=p.unet.forward
        with self.assertRaises(RuntimeError):
            with regional_routing(p,dict(regions=[region(png())],width=32,height=32,cfg_scale=5,prompt='p'),[],[[('a',1)]],lambda *x:None):raise RuntimeError('cancel')
        self.assertEqual(p.unet.forward,original);self.assertEqual(p.active,[])
    def test_off_is_untouched(self):
        p=Pipe();original=p.unet.forward
        with regional_routing(p,{},[],[],lambda *x:None):self.assertEqual(p.unet.forward,original)
if __name__=='__main__':unittest.main()
