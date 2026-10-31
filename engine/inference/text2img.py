"""Local-only SDXL inference (Text2Img and, since v1.7.0, Img2Img on the same components). Never load pickle checkpoint files."""
import gc,threading,secrets,hashlib,time
from pathlib import Path
from worker.models import resolve
class InferenceAdapter:
    def __init__(self,root):self.root=root;self.pipe=None;self.key=None;self.lock=threading.Lock();self.adapter_key=();self.measure=lambda phase:None;self.profiler=None;self.last_trace=None;self.scheduler_config=None
    def unload(self):
        if self.pipe is not None and hasattr(self.pipe,'remove_all_hooks'):self.pipe.remove_all_hooks()
        self.pipe=None;self.key=None;self.adapter_key=();gc.collect()
        try:
            import torch
            if torch.cuda.is_available():torch.cuda.empty_cache()
        except ImportError:pass
    def load(self,identifier,vae_id="auto"):
        path=resolve(self.root,identifier,'checkpoint')
        if not Path(path).is_dir() and Path(path).suffix.lower()!='.safetensors':raise ValueError('Only safe .safetensors checkpoints or Diffusers directories are supported')
        import torch
        from diffusers import StableDiffusionXLPipeline,DPMSolverMultistepScheduler,EulerDiscreteScheduler,EulerAncestralDiscreteScheduler
        if not torch.cuda.is_available():raise RuntimeError('CUDA GPU unavailable')
        if self.key==(identifier,vae_id) and self.pipe is not None:return self.pipe
        self.unload()
        dtype=torch.float16 if torch.cuda.is_available() else torch.float32
        kwargs={}
        if vae_id and vae_id!='auto':
            from diffusers import AutoencoderKL
            vae_path=resolve(self.root,vae_id,'vae')
            from worker.models import header
            keys=header(vae_path)
            if 'decoder.up_blocks.0.resnets.0.conv1.weight' in keys:
                from safetensors.torch import load_file
                config=AutoencoderKL.load_config('stabilityai/stable-diffusion-xl-base-1.0',subfolder='vae')
                vae=AutoencoderKL.from_config(config)
                vae.load_state_dict(load_file(str(vae_path)),strict=True)
                kwargs['vae']=vae.to(dtype=dtype)
            else:
                kwargs['vae']=AutoencoderKL.from_single_file(str(vae_path),config='stabilityai/stable-diffusion-xl-base-1.0',subfolder='vae',torch_dtype=dtype)
        if Path(path).is_dir():
            self.pipe=StableDiffusionXLPipeline.from_pretrained(str(path),torch_dtype=dtype,local_files_only=True,use_safetensors=True,**kwargs)
        else:
            self.pipe=StableDiffusionXLPipeline.from_single_file(str(path),torch_dtype=dtype,config="stabilityai/stable-diffusion-xl-base-1.0",local_files_only=False,use_safetensors=True,**kwargs)
        self.pipe.enable_vae_slicing()
        self.pipe.enable_vae_tiling()
        self.pipe.enable_model_cpu_offload()
        self.scheduler_config=dict(self.pipe.scheduler.config)
        self.key=(identifier,vae_id)
        return self.pipe
    def prepare_adapters(self,req):
        from inference.regional import select_adapters,validate_regional_adapter
        entries=[];globals_=[];regional=[]
        for i,a in enumerate(req.get('lora_adapters',[])):
            name='adapter_'+str(i);entries.append((name,resolve(self.root,a['id'],'lora'),False));globals_.append((name,a['weight']))
        for i,r in enumerate(r for r in req.get('regions',[]) if r['enabled']):
            group=[]
            if r['lora_id']:
                name='region_'+str(i);entries.append((name,resolve(self.root,r['lora_id'],'lora'),True));group=[(name,r['weight'])]
            regional.append(group)
        signature=tuple((name,str(path),path.stat().st_size,path.stat().st_mtime_ns) for name,path,_ in entries)
        if signature!=self.adapter_key:
            try:
                if self.adapter_key:self.pipe.unload_lora_weights()
                self.adapter_key=()
                for name,path,is_regional in entries:
                    if is_regional:validate_regional_adapter(path)
                    self.pipe.load_lora_weights(str(path.parent),weight_name=path.name,adapter_name=name,local_files_only=True)
                self.adapter_key=signature
            except Exception:
                self.unload()
                raise
        select_adapters(self.pipe,globals_,bool(entries))
        return globals_,regional

    def finish_job(self):
        from inference.controlnet import to_base
        to_base(self)
        if self.pipe is not None:
            for hook in getattr(self.pipe,'_all_hooks',[]):hook.offload()
        self.measure=lambda phase:None

    def generate(self,req,progress):
        import torch
        with self.lock:
            from inference.img2img import MODES,total_steps
            mode=req.get('mode','text2img')
            if mode not in (*MODES, 'inpaint', 'facefix'):raise ValueError('Unsupported inference mode')
            editing=mode in ('inpaint','facefix')
            from worker.resources import check_budget
            check_budget(req)
            self.model_reused=self.pipe is not None and self.key==(req['checkpoint_id'],req.get('vae_id','auto'))
            img2img=mode=='img2img'
            from inference.controlnet import validate_control,activate
            control=req.get('controlnet_config',{'enabled':False})
            validate_control(control,req.get('regions',[]))
            total=total_steps(req)
            self.last_trace=None
            progress(0,'PREPARING')
            self.measure('before_model_load')
            pipe=self.load(req['checkpoint_id'],req.get('vae_id','auto'))
            self.measure('after_model_load')
            globals_,regional_adapters=self.prepare_adapters(req)
            from inference.regional import regional_routing
            self.measure('after_adapter_prepare')
            # Text2Img keeps the exact v1.6.2 ControlNet call.
            if editing:
                from inference.editor import activate as activate_editor
                pipe=activate_editor(self)
            elif control['enabled']:pipe=activate(self,control['type'],img2img=True) if img2img else activate(self,control['type'])
            elif img2img:
                from inference.img2img import activate as activate_img2img
                pipe=activate_img2img(self)
            sampler=req.get('sampler','Euler')
            from diffusers import EulerDiscreteScheduler,EulerAncestralDiscreteScheduler,DPMSolverMultistepScheduler
            cls={'Euler':EulerDiscreteScheduler,'Euler a':EulerAncestralDiscreteScheduler,'DPM++ 2M':DPMSolverMultistepScheduler}.get(sampler)
            if cls is None:raise ValueError('Unsupported sampler: '+str(sampler))
            scheduler=req.get('scheduler','Normal')
            if scheduler not in ('Normal','Karras'):raise ValueError('Unsupported scheduler: '+str(scheduler))
            # Rebuild from checkpoint configuration, never the previous request's scheduler.
            config=self.scheduler_config or dict(pipe.scheduler.config)
            options={'use_karras_sigmas':scheduler=='Karras'} if cls!=EulerAncestralDiscreteScheduler else {}
            if cls==DPMSolverMultistepScheduler:options.update(algorithm_type='dpmsolver++',solver_order=2)
            pipe.scheduler=cls.from_config(config,**options)
            seed=int(req.get('seed',-1));seed=secrets.randbelow(2147483648) if seed<0 else seed
            if not 0 <= seed <= 2147483647:raise ValueError("Seed must be between 0 and 2147483647")
            generator=torch.Generator(device='cpu').manual_seed(seed)
            observer=None
            offset=[0]  # v1.8.1: sequential faces share one progress range
            def callback(_pipe,step,timestep,tensors):
                if observer is not None:observer.step_end(step)
                progress(offset[0]+step+1,'GENERATING')
                if offset[0]+step+1==total:progress(offset[0]+step+1,'DECODING')
                return tensors
            self.last_pipeline_type=type(pipe).__name__
            self.measure('before_generation')
            from contextlib import nullcontext
            if self.profiler is not None:
                from inference.diagnostic_hooks import SDXLStageObserver
                observer=SDXLStageObserver(pipe, lambda phase:self.profiler.mark(phase,self),total)
            control_image=source=None
            control_kwargs={};source_kwargs={}
            size_kwargs=dict(width=req['width'],height=req['height'])
            if control['enabled']:
                from inference.controlnet import decode_image,ControlNetError,normalize
                control=normalize(control)
                control_image=decode_image(control['image'])
                if control_image.size!=(req['width'],req['height']):
                    control_image.close()
                    raise ControlNetError('Размер карты ControlNet изменился. Подготовьте карту заново.')
                # Img2Img + ControlNet: `image` is the source, the map is `control_image`.
                control_kwargs={'control_image' if img2img else 'image':control_image,'controlnet_conditioning_scale':control['strength'],'control_guidance_start':control['start'],'control_guidance_end':control['end']}
            stage_hook=None
            edit=None
            current=None
            targets=[]
            self.last_face_job=None
            try:
                if editing:
                    from inference.editor import decode,edit_targets
                    current=decode(req['init_image'])
                    detect_started=time.perf_counter()
                    targets,detection=edit_targets(req,current)
                    self.last_face_job=dict(detector=detection['detector'] if detection else 'manual',
                        detectors_run=detection['detectors_run'] if detection else [],
                        detected_faces=len(detection['faces']) if detection else None,
                        detection_seconds=round(time.perf_counter()-detect_started,3) if detection else None,
                        requested_faces=len(targets),refined_faces=0)
                if img2img:
                    from inference.img2img import source_image
                    source=source_image(req['init_image'],req['width'],req['height'])
                    source_kwargs=dict(image=source,strength=float(req['denoising_strength']))
                    # StableDiffusionXLImg2ImgPipeline takes the size from the (already fitted) source image.
                    if not control['enabled']:size_kwargs={}
                stage_hook=pipe.unet.register_forward_pre_hook(lambda *_:progress(-1,'GENERATING'))
                with torch.no_grad(), regional_routing(pipe,req,globals_,regional_adapters,progress), (observer if observer is not None else nullcontext()):
                    from inference.prompt_encoding import embedding_kwargs,token_plan
                    if observer is not None:observer.emit('before_text_encoding')
                    conditioning=embedding_kwargs(pipe,req)
                    if observer is not None:observer.emit('after_text_encoding')
                    self.last_trace={'tokens':token_plan(pipe,req['prompt'],req.get('negative_prompt','')),
                        'settings':{k:req.get(k) for k in ('mode','checkpoint_id','vae_id','lora_adapters','width','height','steps','cfg_scale','sampler','scheduler','batch_size','denoising_strength')},
                        'prompt_sha256':hashlib.sha256(req['prompt'].encode()).hexdigest(),
                        'negative_sha256':hashlib.sha256(req.get('negative_prompt','').encode()).hexdigest(),
                        'seed':seed,'clip_skip':None,'active_adapters':pipe.get_active_adapters() if self.adapter_key else [],
                        'adapter_files':[{'name':a[0],'path':a[1],'size':a[2]} for a in self.adapter_key],
                        'regional_enabled':any(r['enabled'] for r in req.get('regions',[])),
                        'embedding_shapes':{k:list(v.shape) for k,v in conditioning.items() if v is not None},
                        'embedding_bytes':sum(v.numel()*v.element_size() for v in conditioning.values() if v is not None),
                        'dtype':str(conditioning['prompt_embeds'].dtype),'device':str(conditioning['prompt_embeds'].device)}
                    if not editing:
                        images=pipe(**conditioning,**control_kwargs,**source_kwargs,**size_kwargs,num_inference_steps=req['steps'],guidance_scale=req['cfg_scale'],num_images_per_prompt=req['batch_size'],generator=generator,callback_on_step_end=callback).images
                    else:
                        from inference.editor import EditSession
                        from inference.img2img import denoise_steps
                        per_face=denoise_steps(req['steps'],req['denoising_strength'])
                        # One masked pass per face, strictly sequential, on the same shared pipeline.
                        for index,target in enumerate(targets):
                            offset[0]=index*per_face
                            edit=EditSession(req,source=current,face=target)
                            raw=pipe(**conditioning,image=edit.source,mask_image=edit.work_mask,strength=float(req['denoising_strength']),width=edit.source.width,height=edit.source.height,num_inference_steps=req['steps'],guidance_scale=req['cfg_scale'],num_images_per_prompt=1,generator=generator,callback_on_step_end=callback).images
                            try:updated=edit.composite(raw[0])
                            finally:
                                for im in raw:im.close()
                            edit.close();edit=None
                            current.close();current=updated
                            self.last_face_job['refined_faces']=index+1
                        images=[current];current=None
            finally:
                if stage_hook is not None:stage_hook.remove()
                if control_image is not None:control_image.close()
                if source is not None:source.close()
                if edit is not None:edit.close()
                if current is not None:current.close()
            self.measure('after_decode')
            return images,int(seed)
