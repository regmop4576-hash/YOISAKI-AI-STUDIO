"""v1.8.1 SMART FACE FIX: real OpenCV detector models on CPU, selection rules, masks, API/HTTP contract,
and real tiny RANDOM SDXL multi-face inference on CPU. No quality or GPU claim."""
import sys, io, base64, gc, json, os, time, weakref, importlib
from pathlib import Path
from unittest.mock import patch
import pytest
import numpy as np
from PIL import Image, ImageDraw
sys.path.insert(0,os.environ.get('YOISAKI_TEST_ENGINE',str(Path(__file__).resolve().parents[1]/'engine')))
sys.path.insert(0,str(Path(__file__).resolve().parent))
from inference import facedetect
from inference.editor import EditorError, EditSession, decode, face_mask, fitted_work_size, validate_editor
from worker.direct_server import AdapterRequest

def url(im):
    b=io.BytesIO();im.save(b,format='PNG');return 'data:image/png;base64,'+base64.b64encode(b.getvalue()).decode()

SOURCE=Image.new('RGBA',(96,64),(90,45,120,255))
ImageDraw.Draw(SOURCE).rectangle((0,0,47,63),fill=(200,150,90,255))

def fake_detectors(monkeypatch, anime=(), human=()):
    monkeypatch.setattr(facedetect,'_lbp',lambda bgr:list(anime))
    monkeypatch.setattr(facedetect,'_yunet',lambda bgr:facedetect._merge([(b,c,('human',)) for b,c in human],fuse=False))

def payload(**changes):
    req=dict(mode='facefix',kind='facefix',prompt='  orange fox, amber eyes  ',negative_prompt='',checkpoint_id='a'*32,vae_id='auto',
             lora_adapters=[],width=256,height=256,steps=4,cfg_scale=5.5,sampler='Euler',scheduler='Normal',seed=7,batch_size=1,
             regions=[],controlnet_config={'enabled':False},init_image=url(SOURCE),denoising_strength=.5,mask_blur=2,mask_padding=.5,
             inpaint_region='crop',face_options=dict(mask_shape='ellipse',mask_expand=.08,work_fit='aspect'))
    req.update(changes);return req

def test_real_models_hash_verified_lazy_and_no_false_positive_on_flat_images():
    importlib.reload(facedetect)
    assert facedetect.loaded_models()==[]
    for image in (Image.new('RGBA',(320,240),'white'),Image.linear_gradient('L').resize((300,200)).convert('RGBA')):
        result=facedetect.detect(image)
        assert result['faces']==[] and result['selected'] is None and result['selection_required'] is False
        assert result['image']=={'width':image.width,'height':image.height}
    assert facedetect.loaded_models()==['anime','human']
    # The detector never touches CUDA: torch need not even be imported for detection.
    assert result['detectors_run']==['anime','human'] and result['duration_ms']>=0

def test_tampered_or_missing_model_fails_closed(monkeypatch):
    importlib.reload(facedetect)
    monkeypatch.setitem(facedetect.MODELS,'anime',('lbpcascade_animeface.xml','0'*64))
    with pytest.raises(EditorError,match='повреждён'):facedetect.detect(Image.new('RGBA',(64,64)),'anime')
    monkeypatch.setitem(facedetect.MODELS,'human',('missing.onnx','0'*64))
    with pytest.raises(EditorError,match='отсутствует'):facedetect.detect(Image.new('RGBA',(64,64)),'human')
    importlib.reload(facedetect)

def test_selection_rules_fusion_ids_and_clamping(monkeypatch):
    img=SOURCE
    fake_detectors(monkeypatch,anime=[((10,10,30,30),.9)])
    one=facedetect.detect(img)
    assert len(one['faces'])==1 and one['selected']==one['faces'][0]['id'] and not one['selection_required']
    assert facedetect.detect(img)['faces'][0]['id']==one['faces'][0]['id'], 'ids are reproducible'
    other=Image.new('RGBA',img.size,(1,2,3,255))
    assert facedetect.detect(other)['faces'][0]['id']!=one['faces'][0]['id'], 'ids are bound to the image'
    # Two detectors agreeing on one face: one fused face, noisy-OR confidence.
    fake_detectors(monkeypatch,anime=[((10,10,30,30),.5)],human=[((12,12,28,28),.5)])
    fused=facedetect.detect(img)['faces']
    assert len(fused)==1 and fused[0]['detector']=='anime+human' and abs(fused[0]['confidence']-.75)<1e-3
    # Two confident faces: the user must choose; nothing is selected silently.
    fake_detectors(monkeypatch,anime=[((2,2,30,30),.95),((60,10,30,30),.9)])
    two=facedetect.detect(img);assert two['selected'] is None and two['selection_required'] and len(two['faces'])==2
    # Low confidence: shown, never auto-selected; below threshold: dropped.
    fake_detectors(monkeypatch,human=[((5,5,30,30),.45),((60,5,20,20),.2)])
    weak=facedetect.detect(img);assert [f['auto_selectable'] for f in weak['faces']]==[False] and weak['selected'] is None
    # A face crossing the image edge is clamped to source pixels.
    fake_detectors(monkeypatch,anime=[((-10,40,40,40),.9)])
    edge=facedetect.detect(img)['faces'][0]
    assert edge['x']==0 and edge['y']==40 and edge['y']+edge['height']<=64 and edge['x']+edge['width']<=96

def test_detect_request_and_select_validation(monkeypatch):
    fake_detectors(monkeypatch,anime=[((10,10,30,30),.9),((60,10,30,30),.8)])
    doc=facedetect.detect_request({'image':url(SOURCE)})
    ids=[f['id'] for f in doc['faces']]
    for bad in ({'image':url(SOURCE),'detector':'yolo'},{'image':url(SOURCE),'min_confidence':2},{'image':'data:image/png;base64,AAAA'},{'image':url(SOURCE),'extra':1}):
        with pytest.raises(EditorError):facedetect.detect_request(bad)
    with decode(url(SOURCE)) as image:
        faces,_=facedetect.select_faces(image,{'detector':'auto','min_confidence':.35,'select':ids[::-1]})
        assert [f['id'] for f in faces]==ids[::-1]
        for spec in ({'detector':'auto','min_confidence':.35,'select':['f000000000000']},{'detector':'auto','min_confidence':.35,'select':[]},
                     {'detector':'auto','min_confidence':.35,'select':[ids[0],ids[0]]},{'detector':'auto','select':ids}):
            with pytest.raises(EditorError):facedetect.select_faces(image,spec)

def test_face_mask_shape_expand_edges_and_work_size():
    m=face_mask((100,80),(20,20,60,60),'ellipse',0)
    a=np.asarray(m);assert a[40,40]==255 and a[20,20]==0 and a[21,59]==0, 'ellipse leaves box corners untouched'
    grown=np.asarray(face_mask((100,80),(20,20,60,60),'ellipse',.25));assert (grown>0).sum()>(a>0).sum()
    edge=np.asarray(face_mask((100,80),(0,50,30,80),'ellipse',.1));assert edge[79,10]==255 and edge.shape==(80,100)
    box=np.asarray(face_mask((100,80),(20,20,60,60),'box',0));assert box[20,20]==255 and box[19,19]==0
    assert fitted_work_size((0,0,300,600),1024,1024)==(512,1024)
    assert fitted_work_size((0,0,1000,10),1024,1024)==(1024,1024), 'degenerate aspect falls back to explicit size'

def test_ellipse_session_changes_only_inside_support():
    req=payload(width=512,height=512,face_region=dict(x=20,y=10,width=40,height=40),face_options=dict(mask_shape='ellipse',mask_expand=0,work_fit='aspect'))
    edit=EditSession(req)
    try:
        before=np.asarray(edit.original).copy();support=np.asarray(edit.mask)>0
        assert edit.source.size==edit.work_mask.size and edit.source.width%8==0
        l,t,r,b=edit.content;assert r-l>=edit.source.width-8 and b-t>=edit.source.height-8, 'aspect fit: no letterbox bands'
        with Image.new('RGB',edit.source.size,'red') as generated:out=edit.composite(generated)
        after=np.asarray(out)
        assert np.array_equal(before[~support],after[~support]) and np.any(before[support]!=after[support])
        assert not support[10,20] and not support[49,59], 'corners of the face box are preserved'
        out.close()
    finally:edit.close()

def test_request_contract(monkeypatch):
    fake_detectors(monkeypatch,anime=[((10,10,30,30),.9)])
    ident=facedetect.detect_request({'image':url(SOURCE)})['faces'][0]['id']
    spec={'detector':'auto','min_confidence':.35,'select':[ident]}
    parsed=AdapterRequest(**payload(face_detection=spec)).model_dump()
    assert parsed['face_detection']==spec and parsed['prompt']=='  orange fox, amber eyes  ' and parsed['seed']==7
    assert AdapterRequest(**payload(face_region=dict(x=1,y=1,width=20,height=20),face_options=None)).model_dump()['face_options'] is None
    bad=[dict(face_detection=spec,face_region=dict(x=1,y=1,width=20,height=20)),dict(),dict(face_detection={**spec,'select':['f'+'0'*12]}),
         dict(face_detection=spec,face_options=dict(mask_shape='circle',mask_expand=.1,work_fit='aspect')),
         dict(face_detection=spec,face_options=dict(mask_shape='ellipse',mask_expand=.9,work_fit='aspect')),
         dict(face_detection=spec,inpaint_region='full')]
    for change in bad:
        with pytest.raises(ValueError):AdapterRequest(**payload(**change))
    with pytest.raises(ValueError):validate_editor(dict(mode='text2img',face_options={}))
    from inference.img2img import total_steps
    two={**payload(face_detection={**spec,'select':[ident,'f'+'1'*12]})}
    assert total_steps(two)==2*total_steps(payload(face_detection=spec))==4

def test_http_detect_route_auth_capability_and_independent_of_gpu_queue(tmp_path,monkeypatch):
    import threading, torch
    from fastapi.testclient import TestClient
    from inference.text2img import InferenceAdapter
    from worker.direct_server import create_app
    gate=threading.Event();entered=threading.Event()
    def generate(adapter,req,progress):
        entered.set();gate.wait(5);progress(1,'GENERATING');return [Image.new('RGBA',(96,64))],1
    monkeypatch.setattr(torch.cuda,'is_available',lambda:True)
    monkeypatch.setattr(torch.cuda,'get_device_name',lambda:'MOCK GPU READINESS')
    monkeypatch.setattr(torch.cuda,'mem_get_info',lambda:(10*1024**3,16*1024**3))
    monkeypatch.setattr('worker.direct_server.scan',lambda _:[dict(id='a'*32,kind='checkpoint')])
    monkeypatch.setattr('worker.direct_server.resolve',lambda *args:tmp_path)
    monkeypatch.setattr(InferenceAdapter,'generate',generate)
    fake_detectors(monkeypatch,anime=[((10,10,30,30),.9),((60,10,30,30),.85)])
    token='c'*64;headers={'Authorization':'Bearer '+token}
    with TestClient(create_app(tmp_path,token)) as c:
        h=c.get('/health',headers=headers).json()
        assert h['engine_version']=='1.8.1' and h['api_version']=='1.7.0'
        assert h['capabilities']['auto_facefix'] is True and h['capabilities']['face_detect_contract']==1 and h['capabilities']['facefix'] is True
        assert c.post('/facefix/detect',json={'image':url(SOURCE)}).status_code==401
        assert c.post('/facefix/detect',headers=headers,json={'image':url(SOURCE),'detector':'yolo'}).status_code==422
        ids=[f['id'] for f in c.post('/facefix/detect',headers=headers,json={'image':url(SOURCE)}).json()['faces']]
        job=c.post('/generate',headers=headers,json=payload(face_detection={'detector':'auto','min_confidence':.35,'select':ids})).json()['id']
        assert entered.wait(3)
        # Detection is answered while the single GPU worker is busy: it never enters that queue.
        started=time.monotonic();doc=c.post('/facefix/detect',headers=headers,json={'image':url(SOURCE)}).json()
        assert time.monotonic()-started<3 and len(doc['faces'])==2 and doc['selection_required']
        row=c.get('/jobs/'+job,headers=headers).json();assert row['status']=='RUNNING' and row['progress']['total_steps']==4
        gate.set()
        for _ in range(500):
            row=c.get('/jobs/'+job,headers=headers).json()
            if row['status']=='COMPLETED' and row.get('resources'):break
            time.sleep(.01)
        assert row['status']=='COMPLETED'
        assert c.get('/memory',headers=headers).json()['face_detection']['faces']==2
        bad=c.post('/generate',headers=headers,json=payload(face_detection={'detector':'auto','min_confidence':.35,'select':['f'+'2'*12]}))
        assert bad.status_code==422 and 'не найдено' in bad.text

def test_real_diffusers_sequential_multi_face_cancel_and_memory(tmp_path,monkeypatch):
    """Two detected faces refined one after another on shared tiny SDXL modules; repeated jobs; cancellation."""
    import torch
    from diffusers import DiffusionPipeline,StableDiffusionXLPipeline
    from inference.text2img import InferenceAdapter
    from worker.resources import JobResources
    import test_controlnet_diffusers_cpu as tiny
    torch.set_num_threads(2)
    fake_detectors(monkeypatch,anime=[((4,6,32,32),.95),((56,8,32,32),.9)])
    ids=[f['id'] for f in facedetect.detect_request({'image':url(SOURCE)})['faces']]
    with patch.object(DiffusionPipeline,'enable_model_cpu_offload',tiny._cpu_offload):
        pipe,_=tiny.tiny_pipe(tmp_path);pipe.enable_vae_slicing();pipe.enable_model_cpu_offload()
        a=InferenceAdapter(tmp_path);a.pipe=pipe;a.key=('a'*32,'auto');a.scheduler_config=dict(pipe.scheduler.config)
        a.load=lambda *args:a.pipe;a.prepare_adapters=lambda req:([],[])
        modules={k:getattr(pipe,k) for k in ('unet','vae','text_encoder','text_encoder_2')}
        params={k:sum(p.numel()*p.element_size() for p in m.parameters()) for k,m in modules.items()}
        views=[];measurements=[];steps=[]
        def run(req,cancel_at=None):
            res=JobResources(req['mode']);res.start()
            def progress(step,stage):
                if step>0:
                    steps.append(step);views.append(weakref.ref(a.pipe))
                    if cancel_at and step>=cancel_at:raise RuntimeError('Cancellation requested')
            try:return a.generate(req,progress)
            finally:
                a.finish_job();gc.collect();summary=res.finish(a,'ok');summary['face_fix']=a.last_face_job;measurements.append(summary)
        req=payload(width=64,height=64,steps=4,face_detection={'detector':'auto','min_confidence':.35,'select':ids})
        for _ in range(4):
            steps.clear()
            images,seed=run(req);assert seed==7 and len(images)==1 and images[0].size==(96,64)
            assert max(steps)==4, 'progress spans both faces (2 x int(4*0.5))'
            assert a.last_face_job['refined_faces']==2 and a.last_face_job['requested_faces']==2 and a.last_face_job['detected_faces']==2
            out=np.asarray(images[0]);src=np.asarray(SOURCE)
            assert out[63,47].tolist()==src[63,47].tolist() and out[0,95].tolist()==src[0,95].tolist(), 'pixels outside both masks unchanged'
            images[0].close()
            assert type(a.pipe) is StableDiffusionXLPipeline and not getattr(a.pipe,'_yoisaki_editor',False)
            for k,m in modules.items():
                assert getattr(a.pipe,k) is m and sum(p.numel()*p.element_size() for p in m.parameters())==params[k]
        # Cancel during the second face, then a normal job succeeds.
        with pytest.raises(RuntimeError,match='Cancellation'):run(req,cancel_at=3)
        assert a.last_face_job['refined_faces']==1
        images,_=run(req);images[0].close()
        gc.collect()
        assert all(ref() is None or type(ref()) is StableDiffusionXLPipeline for ref in views)
        out=Path(__file__).parents[1]/'validation';out.mkdir(exist_ok=True)
        (out/'cpu-facefix-resources.json').write_text(json.dumps(measurements,indent=2))
        a.unload()
