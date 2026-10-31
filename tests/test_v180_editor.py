"""Real image geometry + real tiny RANDOM SDXL CPU inference, no quality/GPU claim."""
import sys, io, base64, tempfile, gc, weakref, json, time, os
from pathlib import Path
from unittest.mock import patch
import pytest
import numpy as np
from PIL import Image, ImageDraw
sys.path.insert(0,os.environ.get('YOISAKI_TEST_ENGINE',str(Path(__file__).resolve().parents[1]/'engine')))
sys.path.insert(0,str(Path(__file__).resolve().parent))
from inference.editor import decode, validate_editor, EditSession, EditorError
from worker.direct_server import AdapterRequest

def url(im, fmt='PNG', mime=None):
    b=io.BytesIO();im.save(b,format=fmt)
    return 'data:image/'+(mime or fmt.lower())+';base64,'+base64.b64encode(b.getvalue()).decode()

def payload(mode='inpaint', **changes):
    src=Image.new('RGBA',(80,48),(90,45,120,130))
    mask=Image.new('L',src.size);ImageDraw.Draw(mask).rectangle((20,12,39,31),fill=255)
    req=dict(mode=mode,kind=mode,prompt='  purple bat, orange eyes  ',negative_prompt='  blur  ',checkpoint_id='a'*32,
             vae_id='auto',lora_adapters=[],width=256,height=256,steps=4,cfg_scale=5,sampler='Euler',scheduler='Normal',
             seed=42,batch_size=1,regions=[],controlnet_config={'enabled':False},init_image=url(src),denoising_strength=.5,
             mask_blur=3,mask_padding=.15,inpaint_region='crop')
    if mode=='inpaint':req['mask_image']=url(mask)
    else:req['face_region']=dict(x=0,y=0,width=20,height=20)
    req.update(changes);return req

def test_api_validation_and_rejections():
    for mode in ('inpaint','facefix'):
        req=payload(mode);parsed=AdapterRequest(**req).model_dump();assert parsed['prompt']==req['prompt'];assert parsed['seed']==42
    invalid=[{'mask_image':url(Image.new('L',(79,48),255))},{'mask_image':url(Image.new('L',(80,48)))},
             {'init_image':'data:image/png;base64,aGVsbG8='},{'init_image':url(Image.new('RGB',(80,48)),'JPEG',mime='png')},
             {'init_image':url(Image.new('RGB',(8193,16)))},{'denoising_strength':.01},{'mask_padding':2},{'mask_blur':float('nan')},
             {'batch_size':2},{'regions':[dict(name='A',enabled=True,mask='x')]},
             {'mask_image':url(Image.new('RGBA',(80,48),(255,255,255,0)))}]
    palette=Image.new('P',(80,48),0);palette.putpalette([255,255,255]+[0,0,0]*255);palette.info['transparency']=0
    invalid.append({'mask_image':url(palette)})
    for change in invalid:
        with pytest.raises(ValueError):AdapterRequest(**payload(**change))
    for box in [dict(x=-1,y=0,width=20,height=20),dict(x=70,y=0,width=20,height=20),dict(x=0,y=0,width=1,height=20),dict(x=float('nan'),y=0,width=20,height=20)]:
        with pytest.raises(ValueError):AdapterRequest(**payload('facefix',face_region=box))

@pytest.mark.parametrize('mode',['inpaint','facefix'])
@pytest.mark.parametrize('region',['crop','full'])
def test_geometry_exact_unselected_rgba_and_original_size(mode,region):
    if mode=='facefix' and region=='full':return
    req=payload(mode,inpaint_region=region)
    edit=EditSession(req)
    try:
        before=np.asarray(edit.original).copy();support=np.asarray(edit.mask)>0
        if mode=='inpaint':assert edit.mask.getpixel((20,12))==0, 'feather must reach zero at selection boundary'
        with Image.new('RGB',(256,256),'red') as generated:out=edit.composite(generated)
        after=np.asarray(out);assert out.size==(80,48)
        assert np.array_equal(before[~support],after[~support]);assert np.array_equal(before[:,:,3],after[:,:,3]);assert np.any(before[support]!=after[support])
        assert edit.source.size==edit.work_mask.size==(256,256)
        # Same work pixels / affine letterbox for source and mask; no stretching.
        l,t,r,b=edit.content;c=edit.crop
        assert abs((r-l)/(b-t)-(c[2]-c[0])/(c[3]-c[1]))<.03
        out.close()
    finally:edit.close()

def test_exif_orientation():
    im=Image.new('RGB',(40,24),'red');exif=im.getexif();exif[274]=6
    b=io.BytesIO();im.save(b,format='JPEG',exif=exif)
    data='data:image/jpeg;base64,'+base64.b64encode(b.getvalue()).decode()
    with decode(data) as oriented:assert oriented.size==(24,40)

def test_editor_http_auth_serial_queue_cancel_failure_and_resources(tmp_path,monkeypatch):
    """Real FastAPI routing/validation/worker/result disk. Inference and GPU readiness mocked."""
    import threading, torch
    from fastapi.testclient import TestClient
    from inference.text2img import InferenceAdapter
    from worker.direct_server import create_app
    from inference.img2img import total_steps
    gate=threading.Event();entered=threading.Event();order=[];concurrency=[0,0]
    def generate(adapter,req,progress):
        concurrency[0]+=1;concurrency[1]=max(concurrency)
        order.append(req['seed']);entered.set()
        try:
            gate.wait(3)
            progress(1,'GENERATING')
            if req['seed']==9:raise EditorError('Test invalid model compatibility')
            return [Image.new('RGBA',(80,48))],req['seed']
        finally:concurrency[0]-=1
    def wait(client,ident,expected=None):
        for _ in range(500):
            row=client.get('/jobs/'+ident,headers=headers).json()
            if row['status'] in ('COMPLETED','CANCELLED','FAILED') and row.get('resources'):
                if expected:assert row['status']==expected
                return row
            time.sleep(.01)
        raise AssertionError(row)
    token='b'*64;headers={'Authorization':'Bearer '+token}
    monkeypatch.setattr(torch.cuda,'is_available',lambda:True)
    monkeypatch.setattr(torch.cuda,'get_device_name',lambda:'MOCK GPU READINESS')
    monkeypatch.setattr(torch.cuda,'mem_get_info',lambda:(10*1024**3,16*1024**3))
    monkeypatch.setattr('worker.direct_server.scan',lambda _:[dict(id='a'*32,kind='checkpoint')])
    monkeypatch.setattr('worker.direct_server.resolve',lambda *args:tmp_path)
    monkeypatch.setattr(InferenceAdapter,'generate',generate)
    with TestClient(create_app(tmp_path,token)) as c:
        assert c.post('/generate',json=payload()).status_code==401
        h=c.get('/health',headers=headers).json();assert h['engine_version']=='1.8.1';assert h['capabilities']['inpaint'];assert h['capabilities']['facefix']
        assert c.post('/generate',headers=headers,json=payload(mask_image='broken')).status_code==422
        first=c.post('/generate',headers=headers,json=payload(seed=1)).json()['id'];assert entered.wait(2)
        queued=c.post('/generate',headers=headers,json=payload('facefix',seed=2)).json()['id']
        cancelled=c.post('/generate',headers=headers,json=payload(seed=3)).json()['id']
        assert c.delete('/jobs/'+cancelled,headers=headers).json()['status']=='CANCELLED'
        c.delete('/jobs/'+first,headers=headers);gate.set();wait(c,first,'CANCELLED');wait(c,queued,'COMPLETED')
        bad=c.post('/generate',headers=headers,json=payload('facefix',seed=9)).json()['id'];wait(c,bad,'FAILED')
        good=c.post('/generate',headers=headers,json=payload(seed=4)).json()['id'];row=wait(c,good,'COMPLETED')
        assert row['resources']['job_type']=='inpaint';assert row['resources']['cleanup']=='ok';assert row['resources']['duration_seconds']>=0
        assert c.get('/memory',headers=headers).json()['job_resources']['job_type']=='inpaint'
        assert c.get('/results/'+good+'?index=0',headers=headers).status_code==200
        assert concurrency[1]==1;assert order==[1,2,9,4]

def test_real_diffusers_mixed_modes_lora_storage_release_and_error_recovery(tmp_path):
    import torch
    from diffusers import DiffusionPipeline,StableDiffusionXLPipeline
    from inference.text2img import InferenceAdapter
    from worker.resources import JobResources
    import test_controlnet_diffusers_cpu as tiny
    torch.set_num_threads(2)
    with patch.object(DiffusionPipeline,'enable_model_cpu_offload',tiny._cpu_offload):
        pipe,_=tiny.tiny_pipe(tmp_path);pipe.enable_vae_slicing();pipe.enable_model_cpu_offload()
        a=InferenceAdapter(tmp_path);a.pipe=pipe;a.key=('a'*32,'auto');a.scheduler_config=dict(pipe.scheduler.config)
        a.adapter_key=(('adapter_0','test',1,1),)
        a.load=lambda *args:a.pipe
        a.prepare_adapters=lambda req:(a.pipe.set_adapters(['adapter_0'],[.7]) or ([('adapter_0',.7)],[]))
        modules={k:getattr(pipe,k) for k in ('unet','vae','text_encoder','text_encoder_2')}
        params={k:sum(p.numel()*p.element_size() for p in m.parameters()) for k,m in modules.items()}
        views=[];measurements=[]
        def run(req,cancel=False):
            res=JobResources(req['mode']);res.start()
            def progress(step,stage):
                if step>0:
                    views.append(weakref.ref(a.pipe))
                    if cancel:raise RuntimeError('Cancellation requested')
            try:return a.generate(req,progress)
            finally:
                a.finish_job();gc.collect();measurements.append(res.finish(a,'ok'))
        for mode in ['text2img','img2img','inpaint','facefix','inpaint','facefix']:
            req=payload(mode,width=32,height=32,steps=4,mask_blur=0)
            if mode=='text2img':
                for k in ('init_image','denoising_strength','face_region','mask_blur','mask_padding','inpaint_region'):req.pop(k,None)
            elif mode=='img2img':
                for k in ('face_region','mask_blur','mask_padding','inpaint_region'):req.pop(k,None)
            images,seed=run(req);assert seed==42;assert len(images)==1
            if mode in ('inpaint','facefix'):
                assert images[0].size==(80,48)
                with decode(req['init_image']) as original:
                    assert images[0].getpixel((79,47))==original.getpixel((79,47))
            images[0].close()
            assert type(a.pipe) is StableDiffusionXLPipeline
            for k,m in modules.items():
                assert getattr(a.pipe,k) is m
                assert sum(p.numel()*p.element_size() for p in m.parameters())==params[k]
            assert a.pipe.get_active_adapters()==['adapter_0']
            assert not getattr(a.pipe,'_yoisaki_editor',False)
        req=payload(width=32,height=32,mask_blur=0)
        with pytest.raises(RuntimeError,match='Cancellation'):run(req,cancel=True)
        images,_=run(req);images[0].close()
        gc.collect()
        assert all(ref() is None or type(ref()) is StableDiffusionXLPipeline for ref in views)
        (Path(__file__).parents[1]/'validation'/'cpu-resources.json').write_text(json.dumps(measurements,indent=2))
        a.unload()
