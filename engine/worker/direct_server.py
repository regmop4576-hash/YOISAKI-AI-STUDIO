"""Authenticated, single-user HTTP adapter for Colab. No public filesystem endpoints."""
import gc
import hashlib
import json
import os
import secrets
import threading
import uuid
import hmac
import time
import traceback
from contextlib import asynccontextmanager
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout
from fastapi import FastAPI, HTTPException, Header
from fastapi.responses import Response, StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, model_validator
from .models import scan, resolve
from .memory import MemoryLog
from .results import ResultStore

ENGINE_VERSION = '1.7.0'
API_VERSION = '1.7.0'  # Existing wire contract; the Studio release is independent.

class RegionRequest(BaseModel):
    name: str = Field(max_length=100)
    enabled: bool = True
    lora_id: str = Field(default='',pattern=r'^([a-f0-9]{32})?$')
    trigger: str = Field(default='',max_length=1000)
    prompt: str = Field(default='',max_length=10000)
    negative_prompt: str = Field(default='',max_length=10000)
    weight: float = Field(default=0.8,ge=0,le=2)
    mask: str = Field(max_length=400000)

class AdapterRequest(BaseModel):
    client_request_id: str | None = Field(default=None,pattern=r'^[a-f0-9-]{36}$')
    regions: list[RegionRequest] = Field(default_factory=list,max_length=3)
    clip_skip: None = None  # Reject unsupported overrides instead of ignoring them.
    kind: str = 'text2img'
    mode: str = 'text2img'
    prompt: str = Field(min_length=1,max_length=10000)
    negative_prompt: str = Field(default='',max_length=10000)
    checkpoint_id: str = Field(pattern=r'^[a-f0-9]{32}$')
    vae_id: str = 'auto'
    lora_adapters: list[dict] = Field(default_factory=list,max_length=8)
    width: int = Field(ge=256,le=1536)
    height: int = Field(ge=256,le=1536)
    steps: int = Field(ge=1,le=60)
    cfg_scale: float = Field(ge=1,le=20)
    sampler: str
    scheduler: str
    seed: int = Field(ge=-1,le=2147483647)
    batch_size: int = Field(ge=1,le=2)
    controlnet_config: dict = Field(default_factory=lambda:{'enabled':False})
    # v1.7.0 Img2Img: source data URL (fitted to width x height by the website) and Diffusers `strength`.
    init_image: str | None = Field(default=None,max_length=8*1024*1024)
    denoising_strength: float | None = Field(default=None,gt=0,le=1,allow_inf_nan=False)
    @model_validator(mode='after')
    def check(self):
        if self.mode not in ('text2img','img2img') or self.kind!=self.mode:raise ValueError('Only Text2Img and Img2Img are supported')
        from inference.img2img import validate_img2img
        validate_img2img(self.mode,self.init_image,self.denoising_strength,self.steps)
        if self.width%8 or self.height%8 or self.width*self.height*self.batch_size>1024*1024*2:raise ValueError('Unsupported resolution')
        if self.sampler not in ('Euler','Euler a','DPM++ 2M') or self.scheduler not in ('Normal','Karras'):raise ValueError('Unsupported sampler or scheduler')
        if self.vae_id!='auto' and (len(self.vae_id)!=32 or any(c not in '0123456789abcdef' for c in self.vae_id)):raise ValueError('Invalid VAE')
        if self.sampler=='Euler a' and self.scheduler=='Karras':raise ValueError('Euler a supports Normal scheduler only')
        from inference.controlnet import validate_control
        validate_control(self.controlnet_config,self.regions)
        for item in self.lora_adapters:
            if set(item)!={'id','weight'} or not isinstance(item['id'],str) or len(item['id'])!=32 or not all(c in '0123456789abcdef' for c in item['id']) or type(item['weight']) not in (float,int) or not 0<=item['weight']<=2:raise ValueError('Invalid LoRA')
        enabled=[r for r in self.regions if r.enabled]
        if enabled:
            if self.batch_size!=1 or self.width*self.height>1048576:raise ValueError('Regional: batch 1, maximum 1 megapixel for T4')
            from inference.regional import decode_mask
            for r in enabled:
                decode_mask(r.mask,self.width,self.height)
                if any(a['id']==r.lora_id for a in self.lora_adapters):raise ValueError('Character LoRA must be regional only, remove it from global stack')
        return self

# AUD-006: one preprocessing HTTP request waits at most this long (< browser 95 s / Cloudflare ~100 s);
# the client repeats the identical request to resume the same tracked operation.
PREPROCESS_WAIT = float(os.environ.get('YOISAKI_PREPROCESS_WAIT', '60'))
# AUD-007: bounded engine job table; only finished records the website no longer needs are pruned.
JOB_TABLE_LIMIT = 100
FINISHED_GRACE_SECONDS = 900

class PromptAuditRequest(BaseModel):
    prompt: str = Field(max_length=10000)
    negative_prompt: str = Field(default='',max_length=10000)
    include_text: bool = False

def create_app(model_root,token):
    if not token or len(token)<32:raise ValueError('Private tunnel token required')
    @asynccontextmanager
    async def lifespan(app):
        yield
        with lock:
            for job in jobs.values():
                if job['status'] in ('QUEUED','RUNNING'):job['status']='CANCELLED'
        pool.shutdown(wait=True,cancel_futures=True)
        if adapter[0]:adapter[0].unload()
    app=FastAPI(lifespan=lifespan,title='YOISAKI Direct Engine',version=ENGINE_VERSION,docs_url=None,redoc_url=None,openapi_url=None)
    app.add_middleware(CORSMiddleware,allow_origins=['*'],allow_credentials=False,allow_methods=['GET','POST','DELETE'],allow_headers=['Authorization','Content-Type'])
    @app.middleware('http')
    async def bounded_body(request,call_next):
        if request.method=='POST':
            if not hmac.compare_digest(request.headers.get('authorization','').encode(),('Bearer '+token).encode()):
                return Response(status_code=401)
            body=bytearray()
            async for chunk in request.stream():
                body.extend(chunk)
                if len(body)>12582912:return Response(status_code=413)
            request._body=bytes(body)
        return await call_next(request)
    lock=threading.RLock();pool=ThreadPoolExecutor(max_workers=1);jobs={};adapter=[None];active=[False];requests={};results=ResultStore();jobs.update(results.restored_jobs());memory=MemoryLog(model_root)
    def guard(authorization: str=Header(default='')):
        if not hmac.compare_digest(authorization.encode(),('Bearer '+token).encode()):raise HTTPException(401,'Invalid engine access token')
    from fastapi import Depends
    auth=Depends(guard)
    def hardware():
        try:
            import torch
            if torch.cuda.is_available():
                free,total=torch.cuda.mem_get_info();return dict(gpu_name=torch.cuda.get_device_name(),vram_total_mb=round(total/1048576),vram_available_mb=round(free/1048576))
        except (ImportError,RuntimeError):pass
        return dict(gpu_name=None,vram_total_mb=None,vram_available_mb=None)
    @app.get('/health',dependencies=[auth])
    def health():
        with lock:busy=active[0]
        results.cleanup()
        return dict(memory_log_ok=memory.write_ok,engine='YOISAKI_ENGINE',engine_version=ENGINE_VERSION,api_version=API_VERSION,capabilities={'controlnet':True,'sdpose':True,'img2img':True,'regional_control':True,'result_ack':True},state='BUSY' if busy else 'READY' if hardware()['gpu_name'] else 'ERROR',**hardware())
    preprocess_op=[None]
    @app.post('/controlnet/preprocess',dependencies=[auth])
    def controlnet_preprocess(data:dict):
        # Share the one inference executor: detectors never overlap generation.
        def work():
            from inference.controlnet import preprocess
            memory.sample('before_control_preprocess',adapter[0],results)
            try:return preprocess(data)
            finally:memory.sample('after_control_preprocess',adapter[0],results)
        # AUD-006: an identical repeated request resumes the tracked operation instead of starting another.
        digest=hashlib.sha256(json.dumps(data,sort_keys=True,separators=(',',':')).encode()).hexdigest()
        with lock:
            op=preprocess_op[0]
            if op is not None and op['digest']!=digest:
                if not op['future'].done():raise HTTPException(409,'Предобработка уже выполняется.')
                preprocess_op[0]=op=None  # finished result of an abandoned map is discarded
            if op is None:
                if active[0] or any(j['status']=='QUEUED' for j in jobs.values()):raise HTTPException(409,'GPU занят. Дождитесь завершения очереди перед предобработкой.')
                op=preprocess_op[0]={'digest':digest,'future':pool.submit(work)}
        try:value=op['future'].result(timeout=PREPROCESS_WAIT)
        except FutureTimeout:return {'status':'PENDING'}
        except ValueError as exc:raise HTTPException(422,str(exc))
        finally:
            with lock:
                if preprocess_op[0] is op and op['future'].done():preprocess_op[0]=None
        return value
    @app.get('/models',dependencies=[auth])
    def models():return {'models':scan(model_root)}
    @app.post('/prompt-audit',dependencies=[auth])
    def prompt_audit(data:PromptAuditRequest):
        engine=adapter[0]
        if engine is None or engine.pipe is None:raise HTTPException(409,'Run a generation first to load the selected tokenizers')
        if not engine.lock.acquire(blocking=False):raise HTTPException(409,'Generation in progress')
        try:
            from inference.prompt_encoding import token_plan
            return token_plan(engine.pipe,data.prompt,data.negative_prompt,include_text=data.include_text)
        except ValueError as exc:raise HTTPException(422,str(exc))
        finally:engine.lock.release()
    @app.get('/memory',dependencies=[auth])
    def memory_status():return {'last':memory.last,'log_write_ok':memory.write_ok}
    @app.post('/jobs/{ident}/ack',dependencies=[auth])
    def acknowledge(ident:str):
        with lock:
            if ident not in jobs or jobs[ident]['status']!='COMPLETED':raise HTTPException(404,'Result unavailable')
            results.ack(ident)
        return {'ok':True}
    def run_job(ident,request):
        images=[]
        profiler=None
        # Opt-in local control: existing authenticated /generate schema is untouched.
        try:
            from .memory_profiler import JobProfiler,load_control
            config=load_control(model_root,ident)
            if config is not None:
                profiler=JobProfiler(model_root,ident,config)
                profiler.start()
        except Exception as exc:
            # Diagnostic initialization failure must not break normal image inference.
            print('Memory profiler unavailable:',type(exc).__name__)
            profiler=None
        try:
            import torch
            if torch.cuda.is_available():torch.cuda.reset_peak_memory_stats()
        except Exception:pass
        def measure(phase):
            memory.sample(phase,adapter[0],results,ident)
            if profiler is not None:
                profiler.mark('after_image_saving' if phase=='after_save' else phase,adapter[0])
        timing={'last':None,'ema':None,'observations':0}
        from inference.img2img import total_steps
        total=total_steps(request)  # Img2Img runs only int(steps*denoise) timesteps
        def update(step,stage):
            with lock:
                job=jobs[ident]
                if job['status']=='CANCELLED':raise RuntimeError('Cancellation requested')
                if step<0:
                    job['progress']={**job.get('progress',{}),'stage':stage}
                    return
                now=time.monotonic()
                if stage=='GENERATING':
                    if timing['last'] is not None:
                        delta=now-timing['last'];timing['ema']=delta if timing['ema'] is None else .3*delta+.7*timing['ema'];timing['observations']+=1
                    timing['last']=now
                job['progress']={'step':step,'total_steps':total,'stage':stage,
                    'percent':round(step/total*100),
                    'elapsed_seconds':round(now-job['_started'],1),
                    'eta_seconds':round(timing['ema']*(total-step),1) if stage=='GENERATING' and timing['observations']>=2 else None}
        with lock:
            if jobs[ident]['status']=='CANCELLED':
                results.release(ident)
                return
            active[0]=True
            jobs[ident].update(status='RUNNING',_started=time.monotonic())
        try:
            update(0,'PREPARING')
            from inference.text2img import InferenceAdapter
            if adapter[0] is None:adapter[0]=InferenceAdapter(model_root)
            adapter[0].measure=measure
            adapter[0].profiler=profiler
            images,seed=adapter[0].generate(request,update)
            update(total,'SAVING')
            results.save(ident,images,seed)
            measure('after_save')
            update(total,'DONE')
            with lock:
                if jobs[ident]['status']!='CANCELLED':jobs[ident].update(status='COMPLETED',_finished=time.time(),progress={**jobs[ident]['progress'],'stage':'DONE'},result={'image_keys':[str(i) for i in range(len(images))],'seed':seed},diagnostics=adapter[0].last_trace)
        except Exception as exc:
            with lock:
                if jobs[ident]['status']=='CANCELLED':return
            app.state.last_traceback=traceback.format_exc()
            import sys
            print(app.state.last_traceback,file=sys.stderr)
            with lock:
                if jobs[ident]['status']!='CANCELLED':jobs[ident].update(status='FAILED',_finished=time.time(),progress={**jobs[ident].get('progress',{}),'stage':'FAILED'},error=(str(exc) if type(exc).__name__ in ('PromptEncodingError','ControlNetError','Img2ImgError') else 'Недостаточно системной RAM. Уменьшите размеры или перезапустите Colab.' if isinstance(exc,MemoryError) else 'Недостаточно VRAM. Уменьшите размер или batch.' if 'out of memory' in str(exc).lower() else 'Ошибка загрузки или генерации модели. Проверьте SDXL-совместимость; подробности в диагностике Colab.'))
        finally:
            for im in images:im.close()
            images.clear()
            if adapter[0]:
                try:adapter[0].finish_job()
                except Exception:adapter[0].unload()
            with lock:
                if jobs[ident]['status']!='COMPLETED':results.discard(ident)
                active[0]=False
            gc.collect()  # Once temporary tensors/context managers have left generate().
            measure('after_cleanup')
            if adapter[0] is not None:adapter[0].profiler=None
            if profiler is not None:
                # One-worker pool: inference has exited, images discarded, GC finished.
                profiler.finish(adapter[0],allow_allocator=True)
    def prune_jobs():
        # AUD-007 (called under lock): never QUEUED/RUNNING, never an unacknowledged result.
        now=time.time()
        def removable(ident,job):
            if job['status']=='COMPLETED':
                entry=results.entries.get(ident)
                return entry is None or entry.get('ack') is not None
            return job['status'] in ('FAILED','CANCELLED') and now-job.get('_finished',job.get('created',now))>=FINISHED_GRACE_SECONDS
        for ident,job in sorted(list(jobs.items()),key=lambda x:x[1].get('created',0)):
            if len(jobs)<JOB_TABLE_LIMIT:break
            if removable(ident,job):
                del jobs[ident]
                for key in [k for k,(old_id,_) in requests.items() if old_id==ident]:del requests[key]
    @app.post('/generate',dependencies=[auth])
    def generate(data:AdapterRequest):
        key=data.client_request_id
        payload=data.model_dump()
        digest=hashlib.sha256(json.dumps(payload,sort_keys=True,separators=(',',':')).encode()).hexdigest()
        with lock:
            if key and key in requests:
                old_id,old_digest=requests[key]
                if digest!=old_digest:raise HTTPException(409,'Request ID reused with different parameters')
                return {'id':old_id,'status':'QUEUED'}
        if not hardware()['gpu_name']:raise HTTPException(503,'GPU недоступен. Выберите T4 и повторите установку.')
        models=scan(model_root)
        if not any(m['id']==data.checkpoint_id and m['kind']=='checkpoint' for m in models):raise HTTPException(400,'Checkpoint not found')
        if any(not any(m['id']==a['id'] and m['kind']=='lora' for m in models) for a in data.lora_adapters):raise HTTPException(400,'LoRA not found')
        try:
            resolve(model_root,data.checkpoint_id,'checkpoint')
            if data.vae_id!='auto':resolve(model_root,data.vae_id,'vae')
            for a in data.lora_adapters:resolve(model_root,a['id'],'lora')
            for r in data.regions:
                if r.enabled and r.lora_id:resolve(model_root,r.lora_id,'lora')
        except ValueError as e:raise HTTPException(400,str(e))
        with lock:
            if key and key in requests:
                old_id,old_digest=requests[key]
                if digest!=old_digest:raise HTTPException(409,'Request ID conflict')
                return {'id':old_id,'status':'QUEUED'}
            if sum(j['status'] in ('QUEUED','RUNNING') for j in jobs.values())>=20:raise HTTPException(429,'Queue full (20)')
            # Bound job metadata; disk results have their own ACK-based retention policy.
            prune_jobs()
            if len(jobs)>=JOB_TABLE_LIMIT:raise HTTPException(429,'История сессии GPU заполнена непринятыми результатами. Дождитесь сохранения в галерею или перезапустите движок.')
            ident=key or str(uuid.uuid4())
            if ident in jobs:raise HTTPException(409,'Job ID already exists; reconcile with GET')
            try:results.reserve(ident,data.batch_size)
            except ValueError as e:raise HTTPException(507,str(e))
            from inference.img2img import total_steps
            jobs[ident]={'id':ident,'status':'QUEUED','created':time.time(),
                'progress':{'stage':'PENDING','step':0,'total_steps':total_steps(payload),'percent':0}}
            if key:requests[key]=(ident,digest)
            pool.submit(run_job,ident,payload)
        return {'id':ident,'status':'QUEUED'}
    @app.get('/jobs/{ident}',dependencies=[auth])
    def status(ident:str):
        with lock:
            if ident not in jobs:raise HTTPException(404,'Job not found')
            pending=[k for k,v in jobs.items() if v['status']=='QUEUED']
            result={k:v for k,v in jobs[ident].items() if k!='images' and not k.startswith('_')}
            result['queue_position']=pending.index(ident)+1 if ident in pending else 0
            result['pending_jobs']=len(pending)
            if result['status']=='RUNNING':
                result['progress']={**result.get('progress',{}),'elapsed_seconds':round(time.monotonic()-jobs[ident]['_started'],1)}
            return result
    @app.delete('/jobs/{ident}',dependencies=[auth])
    def cancel(ident:str):
        with lock:
            if ident not in jobs:raise HTTPException(404,'Job not found')
            if jobs[ident]['status'] in ('QUEUED','RUNNING'):
                if jobs[ident]['status']=='QUEUED':results.release(ident)
                jobs[ident]['status']='CANCELLED';jobs[ident]['_finished']=time.time()
                jobs[ident]['progress']={**jobs[ident].get('progress',{}),'stage':'CANCELLED'}
            return {'status':jobs[ident]['status']}
    @app.get('/results/{ident}',dependencies=[auth])
    def result(ident:str,index:int=0):
        with lock:
            job=jobs.get(ident)
            if not job or job['status']!='COMPLETED':raise HTTPException(404,'Result unavailable')
            try:stream=results.open(ident,index)
            except (FileNotFoundError,IndexError):raise HTTPException(404,'Image unavailable')
        def chunks():
            try:
                while chunk:=stream.read(65536):yield chunk
            finally:stream.close()
        return StreamingResponse(chunks(),media_type='image/png',headers={'Cache-Control':'no-store'})
    return app
