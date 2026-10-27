"""Bounded ControlNet preprocessing and shared-component SDXL pipeline transitions."""
import base64, gc, io, math, os, types
from PIL import Image, ImageOps

MAX_ENCODED = 8 * 1024 * 1024
FLAT_DEPTH = 1e-3  # relative range below which a depth estimate is treated as uniform
MODELS = {
    'OpenPose': 'xinsir/controlnet-openpose-sdxl-1.0',
    'Canny': 'diffusers/controlnet-canny-sdxl-1.0',
    'Depth': 'diffusers/controlnet-depth-sdxl-1.0-small',
}
FP16_VARIANT = ('Canny', 'Depth')
# v1.6.2: pose preprocessors; both produce an OpenPose-18 map for the same OpenPose ControlNet.
POSE_PREPROCESSORS = ('openpose', 'sdpose')
class ControlNetError(ValueError):
    pass

def decode_image(data):
    if not isinstance(data,str) or len(data)>MAX_ENCODED or not data.startswith(('data:image/png;base64,','data:image/jpeg;base64,','data:image/webp;base64,')):
        raise ControlNetError('Нужен PNG, JPEG или WebP до 6 МБ.')
    try:
        raw=base64.b64decode(data.split(',',1)[1],validate=True)
        with Image.open(io.BytesIO(raw)) as src:
            if src.format not in ('PNG','JPEG','WEBP') or src.width*src.height>16_777_216 or min(src.size)<16:
                raise ControlNetError('Неподдерживаемый формат или размер изображения (до 16 Мп).')
            return ImageOps.exif_transpose(src).convert('RGB')
    except ControlNetError:raise
    except Exception as exc:raise ControlNetError('Не удалось прочитать изображение.') from exc

def encode_image(image):
    with io.BytesIO() as buf:
        image.save(buf,format='PNG')
        result='data:image/png;base64,'+base64.b64encode(buf.getvalue()).decode()
    if len(result)>MAX_ENCODED:raise ControlNetError('Карта слишком велика. Уменьшите размеры.')
    return result

def validate_control(config,regions=()):
    if not isinstance(config,dict) or type(config.get('enabled')) is not bool:
        raise ControlNetError('Неверная конфигурация ControlNet.')
    if not config['enabled']:return
    if any((r.get('enabled') if isinstance(r,dict) else r.enabled) for r in regions):
        raise ControlNetError('Одновременная работа Regional Control и ControlNet пока не поддерживается.')
    if config.get('type') not in MODELS:raise ControlNetError('Неизвестный тип ControlNet.')
    for key,lo,hi in [('strength',0,2),('start',0,1),('end',0,1)]:
        v=config.get(key)
        if type(v) not in (float,int) or not math.isfinite(v) or not lo<=v<=hi:raise ControlNetError('Неверные Strength / Start / End ControlNet.')
    if config['start']>=config['end']:raise ControlNetError('ControlNet: требуется 0 ≤ Start < End ≤ 1.')
    if config.get('map_type')!=config['type']:raise ControlNetError('Тип карты изменился. Подготовьте карту заново.')
    if 'preprocessor' in config and (config['type']!='OpenPose' or config['preprocessor'] not in POSE_PREPROCESSORS):raise ControlNetError('Неверный препроцессор позы.')
    with decode_image(config.get('image')) as image:
        ensure_content(image,config['type'])

def ensure_content(image,mode):
    import numpy as np
    values=np.asarray(image)
    if mode=='OpenPose' and (values.max()<30 or values.std()<1):raise ControlNetError('Поза не обнаружена. Используйте другое фото или готовую OpenPose-карту.')
    if mode=='Depth' and values.std()<1:raise ControlNetError('Карта глубины пуста или однородна. Используйте другое фото.')
    if mode=='Canny' and values.max()==0:raise ControlNetError('Контуры не обнаружены. Используйте другое фото.')

def preprocess(data):
    """CPU only; at most one temporary detector, destroyed before returning."""
    mode=data.get('type');prepared=data.get('prepared',False)
    width=data.get('width');height=data.get('height')
    if mode not in MODELS or type(prepared) is not bool:raise ControlNetError('Неверный режим предобработки.')
    pose_source=data.get('preprocessor','openpose' if mode=='OpenPose' else None)
    if (mode=='OpenPose')!=(pose_source in POSE_PREPROCESSORS):raise ControlNetError('Неверный препроцессор позы.')
    if any(type(v) is not int or not 256<=v<=1536 or v%8 for v in (width,height)):raise ControlNetError('Неверные размеры карты.')
    detector=processor=tensors=depth=None
    try:
        import numpy as np
        with decode_image(data.get('image')) as original:
            original.thumbnail((1024,1024),Image.Resampling.LANCZOS)
            if prepared:
                result=original.copy()
            elif mode=='Canny':
                import cv2
                low=int(os.environ.get('YOISAKI_CANNY_LOW','100'));high=int(os.environ.get('YOISAKI_CANNY_HIGH','200'))
                if not 0<=low<high<=255:raise ControlNetError('Неверные внутренние пороги Canny.')
                # AUD-008: detect edges at the final resolution; the binary map is never resampled.
                with ImageOps.contain(original,(width,height),method=Image.Resampling.LANCZOS) as source:
                    edges=cv2.Canny(cv2.cvtColor(np.asarray(source),cv2.COLOR_RGB2GRAY),low,high)
                result=Image.fromarray(edges).convert('RGB')
            elif pose_source=='sdpose':
                # Loads, runs and fully releases SDPose-OOD before returning (inference/sdpose.py).
                from inference.sdpose import detect as sdpose_detect
                result=sdpose_detect(original)
            elif mode=='OpenPose':
                from controlnet_aux import OpenposeDetector
                from controlnet_aux.open_pose.body import Body
                from huggingface_hub import hf_hub_download
                detector=OpenposeDetector(Body(hf_hub_download('lllyasviel/Annotators','body_pose_model.pth')))
                # Body pose only: do not download unused hand/face models at inference.
                result=detector(original,detect_resolution=512,image_resolution=1024,include_hand=False,include_face=False).convert('RGB')
            else:
                import torch
                from transformers import AutoImageProcessor,AutoModelForDepthEstimation
                processor=AutoImageProcessor.from_pretrained('depth-anything/Depth-Anything-V2-Small-hf')
                detector=AutoModelForDepthEstimation.from_pretrained('depth-anything/Depth-Anything-V2-Small-hf',use_safetensors=True).eval()
                tensors=processor(images=original,return_tensors='pt')
                with torch.inference_mode():
                    depth=detector(**tensors).predicted_depth
                    # AUD-012: relative flatness test on the raw estimate (interpolation round-off is ~1e-6).
                    if not torch.isfinite(depth).all() or (depth.max()-depth.min()).item()<=FLAT_DEPTH*max(1.0,depth.abs().max().item()):raise ControlNetError('Не удалось оценить глубину изображения.')
                    depth=torch.nn.functional.interpolate(depth.unsqueeze(1),size=(original.height,original.width),mode='bicubic',align_corners=False)[0,0]
                    lo,hi=depth.min(),depth.max()
                    if not torch.isfinite(depth).all() or (hi-lo).item()<1e-6:raise ControlNetError('Не удалось оценить глубину изображения.')
                    result=Image.fromarray(((depth-lo)/(hi-lo)*255).clamp(0,255).byte().cpu().numpy()).convert('RGB')
            try:
                ensure_content(result,mode)
                # Letterbox, no stretching or cropping. Depth uses far (black) padding.
                with ImageOps.pad(result,(width,height),method=Image.Resampling.NEAREST if mode in ('OpenPose','Canny') else Image.Resampling.LANCZOS,color=(0,0,0)) as fitted:
                    return {'image':encode_image(fitted),'type':mode,'width':width,'height':height,**({'preprocessor':pose_source} if pose_source else {})}
            finally:result.close()
    except ControlNetError:raise
    except MemoryError as exc:raise ControlNetError('Недостаточно системной RAM для предобработки.') from exc
    except Exception as exc:raise ControlNetError(f'Ошибка предобработки {"SDPose-OOD" if pose_source=="sdpose" else mode}: проверьте загрузку весов и зависимости в Colab ({type(exc).__name__}).') from exc
    finally:
        detector=processor=tensors=depth=None
        gc.collect()

def to_base(adapter):
    """Drop the one-job ControlNet / Img2Img wrapper and offload hooks, retain exact base modules / LoRA weights."""
    if adapter.pipe is None:return
    control=hasattr(adapter.pipe,'controlnet')
    if not control and not getattr(adapter.pipe,'_yoisaki_img2img',False):return
    from diffusers import StableDiffusionXLPipeline
    old=adapter.pipe
    old.remove_all_hooks()
    # AUD-003: drop the ControlNet where it is (GPU) instead of copying it to RAM first.
    # Base modules are moved to CPU by enable_model_cpu_offload() of the new wrapper below.
    if control:old.controlnet=None
    # AUD-019: diffusers 0.36 from_pipe() defaults to torch_dtype=float32 and would upcast the shared fp16 modules.
    adapter.pipe=StableDiffusionXLPipeline.from_pipe(old,torch_dtype=None)
    del old
    gc.collect()
    import torch
    if torch.cuda.is_available():torch.cuda.empty_cache()
    adapter.pipe.enable_model_cpu_offload()
    adapter.measure('after_controlnet_release' if control else 'after_img2img_release')

def _offload_hooked_models(pipe):
    """maybe_free_model_hooks() for the one-job ControlNet wrapper: offload the hooked base
    models exactly like model CPU offload, without pipe.to('cpu') of the excluded ControlNet."""
    for component in pipe.components.values():
        if hasattr(component,'_reset_stateful_cache'):component._reset_stateful_cache()
    for hook in getattr(pipe,'_all_hooks',[]):hook.offload()

def normalize(config):
    """AUD-001: JSON sends 1.0 as 1; Diffusers requires float conditioning values."""
    return {**config,'strength':float(config['strength']),'start':float(config['start']),'end':float(config['end'])}

def activate(adapter,mode,img2img=False):
    import torch
    from diffusers import ControlNetModel
    # v1.7.0: Img2Img + ControlNet uses the same shared modules and the same one-job ControlNet lifecycle.
    if img2img:from diffusers import StableDiffusionXLControlNetImg2ImgPipeline as ControlPipeline
    else:from diffusers import StableDiffusionXLControlNetPipeline as ControlPipeline
    to_base(adapter)
    adapter.measure('before_controlnet_load')
    model=None
    try:
        kwargs={'torch_dtype':torch.float16,'use_safetensors':True,'low_cpu_mem_usage':True}
        # AUD-004: official fp16 safetensors (Canny repo default file is fp32, ~5 GB). xinsir OpenPose ships fp16 only.
        if mode in FP16_VARIANT:kwargs['variant']='fp16'
        model=ControlNetModel.from_pretrained(MODELS[mode],**kwargs)
        base=adapter.pipe
        # SDXL architecture compatibility, not a promise of quality for every fine-tune.
        if model.config.in_channels!=base.unet.config.in_channels or tuple(model.config.block_out_channels)!=tuple(base.unet.config.block_out_channels) or model.config.addition_embed_type!='text_time':
            raise ControlNetError('Несовместимые веса ControlNet: требуется архитектура SDXL.')
        base.remove_all_hooks()
        base.to('cpu')
        pipe=ControlPipeline.from_pipe(base,controlnet=model,torch_dtype=None)  # AUD-019: keep dtypes
        del base
        if img2img:pipe._yoisaki_img2img=True
        # AUD-003: the ControlNet stays on the GPU for this one job (it was there during the whole
        # denoising loop anyway) and is never offloaded back to RAM before to_base() releases it.
        pipe._exclude_from_cpu_offload=[*getattr(pipe,'_exclude_from_cpu_offload',[]),'controlnet']
        pipe.maybe_free_model_hooks=types.MethodType(_offload_hooked_models,pipe)
        adapter.pipe=pipe;pipe=None
        adapter.pipe.enable_model_cpu_offload()
        adapter.measure('after_controlnet_load')
        return adapter.pipe
    except Exception as exc:
        adapter.unload()
        if isinstance(exc,ControlNetError):raise
        if isinstance(exc,MemoryError):raise ControlNetError('Недостаточно системной RAM для ControlNet.') from exc
        if 'out of memory' in str(exc).lower():raise ControlNetError('Недостаточно VRAM для ControlNet. Уменьшите размеры или batch.') from exc
        raise ControlNetError('Не удалось загрузить веса ControlNet. Проверьте доступ к Hugging Face и SDXL-совместимость в Colab.') from exc
    finally:
        model=None
        gc.collect()
