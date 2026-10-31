"""v1.7.0 Img2Img on the SAME loaded SDXL components: no second checkpoint, UNet, VAE or encoder copy.

The per-job Img2Img pipeline is a Diffusers from_pipe() view of the base modules (with ControlNet:
StableDiffusionXLControlNetImg2ImgPipeline in inference.controlnet.activate). to_base() returns to the
plain StableDiffusionXLPipeline after every job, exactly like the one-job ControlNet wrapper."""
import math
from PIL import Image, ImageOps

MAX_ENCODED = 8 * 1024 * 1024
MODES = ('text2img', 'img2img')

class Img2ImgError(ValueError):
    pass

def denoise_steps(steps, strength):
    """Exactly Diffusers get_timesteps(): the Img2Img loop runs int(steps*strength) of `steps` timesteps."""
    return min(int(steps * strength), steps)

def total_steps(req):
    """Denoising steps the job really executes (progress, ETA, DECODING stage)."""
    if req.get('mode') not in ('img2img','inpaint','facefix'):
        return req['steps']
    faces = req.get('face_detection') or {}
    # v1.8.1: selected detected faces are refined one after another within the same job.
    count = len(faces.get('select') or []) if req.get('mode') == 'facefix' and isinstance(faces.get('select'), list) else 1
    return denoise_steps(req['steps'], req['denoising_strength']) * max(1, count)

def decode_source(data):
    from inference.controlnet import decode_image, ControlNetError
    if not isinstance(data, str) or len(data) > MAX_ENCODED:
        raise Img2ImgError('Img2Img: загрузите исходное изображение PNG, JPEG или WebP.')
    try:
        return decode_image(data)
    except ControlNetError as exc:
        raise Img2ImgError('Исходное изображение Img2Img: ' + str(exc)) from exc

def validate_img2img(mode, image, strength, steps):
    if mode not in MODES:
        raise Img2ImgError('Поддерживаются только Text2Img и Img2Img.')
    if mode == 'text2img':
        if image is not None or strength is not None:
            raise Img2ImgError('Исходное изображение и Denoise допустимы только в режиме Img2Img.')
        return
    if type(strength) not in (float, int) or not math.isfinite(strength) or not 0 < strength <= 1:
        raise Img2ImgError('Img2Img: Denoise должен быть больше 0 и не больше 1.')
    if denoise_steps(steps, strength) < 1:
        raise Img2ImgError(f'Img2Img: Denoise {strength} при {steps} шагах не даёт ни одного шага. Увеличьте Denoise или Steps.')
    decode_source(image).close()

def source_image(data, width, height):
    """Decoded source at the exact generation size: centre crop + LANCZOS, never stretched or padded.
    The website already sends it at this size, so this is normally a no-op."""
    image = decode_source(data)
    if image.size == (width, height):
        return image
    try:
        return ImageOps.fit(image, (width, height), method=Image.Resampling.LANCZOS)
    finally:
        image.close()

def activate(adapter):
    """Img2Img view of the loaded base pipeline. Shared modules, no weight copy; dtypes kept (AUD-019)."""
    from diffusers import StableDiffusionXLImg2ImgPipeline
    from inference.controlnet import to_base
    to_base(adapter)
    base = adapter.pipe
    base.remove_all_hooks()
    try:
        pipe = StableDiffusionXLImg2ImgPipeline.from_pipe(base, torch_dtype=None)
    except Exception:
        base.enable_model_cpu_offload()  # the base pipeline stays usable for the next job
        raise
    pipe._yoisaki_img2img = True
    adapter.pipe = pipe
    del base, pipe
    adapter.pipe.enable_model_cpu_offload()
    adapter.measure('after_img2img_view')
    return adapter.pipe
