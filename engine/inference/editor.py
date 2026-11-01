"""Masked SDXL editing on shared base components. White edits, black preserves.

Geometry is in EXIF-oriented source pixels; inference dimensions are explicit
letterboxed work dimensions, never output dimensions. No second model is loaded.
"""
import base64
import io
import math
from contextlib import ExitStack
from PIL import Image, ImageOps, ImageDraw

EDIT_MODES = ('inpaint', 'facefix')
MAX_ENCODED = 8 * 1024 * 1024
MAX_PIXELS = 16_777_216

class EditorError(ValueError):
    pass

def feather_mask(mask, radius):
    """Smooth inward distance ramp: boundary is zero, original zero pixels stay zero.
    Work only on the mask bounding crop, particularly for small face selections.
    OpenCV/numpy already belong to the pinned ControlNet preprocessing runtime.
    """
    import numpy as np
    import cv2
    bounds=mask.getbbox()
    if not bounds:raise EditorError('Маска пуста.')
    with mask.crop(bounds) as cropped:
        values=np.asarray(cropped)
        binary=np.pad((values>0).astype('uint8'),1)
        distance=cv2.distanceTransform(binary,cv2.DIST_L2,3)[1:-1,1:-1]
        ramp=np.clip((distance-1)/radius,0,1)
        ramp=ramp*ramp*(3-2*ramp)
        feathered=Image.fromarray(np.rint(values*ramp).astype('uint8'))
    result=Image.new('L',mask.size)
    try:result.paste(feathered,bounds[:2])
    finally:feathered.close()
    if not result.getbbox():
        result.close()
        raise EditorError('Растушёвка скрыла всю маску. Уменьшите её радиус или увеличьте выделение.')
    return result

def decode(data, mask=False):
    try:
        if not isinstance(data, str) or len(data) > MAX_ENCODED:
            raise EditorError('Изображение/маска: максимум 6 МБ после кодирования.')
        head, encoded = data.split(',', 1)
        formats = {'data:image/png;base64':'PNG', 'data:image/jpeg;base64':'JPEG', 'data:image/webp;base64':'WEBP'}
        if head not in formats or mask and formats[head] != 'PNG':
            raise EditorError('Нужен PNG, JPEG или WebP; маска должна быть PNG.')
        raw = base64.b64decode(encoded, validate=True)
        with Image.open(io.BytesIO(raw)) as im:
            if im.format != formats[head] or getattr(im, 'n_frames', 1) != 1:
                raise EditorError('MIME не совпадает с изображением или файл анимирован.')
            if min(im.size) < 16 or max(im.size) > 8192 or im.width * im.height > MAX_PIXELS:
                raise EditorError('Источник: от 16 пикселей, до 8192 по стороне и 16 Мп.')
            im.load()
            oriented = ImageOps.exif_transpose(im)
            try:
                if mask:
                    if 'A' in oriented.getbands() or 'transparency' in oriented.info:
                        with oriented.convert('RGBA') as rgba, rgba.getchannel('A') as alpha:
                            if alpha.getextrema() != (255, 255):
                                raise EditorError('Маска должна быть непрозрачной: белое редактируется, чёрное сохраняется.')
                    return oriented.convert('L')
                return oriented.convert('RGBA')
            finally:
                oriented.close()
    except EditorError:
        raise
    except Exception as exc:
        raise EditorError('Не удалось декодировать изображение/маску.') from exc

def face_bounds(region, size):
    if not isinstance(region, dict) or set(region) != {'x', 'y', 'width', 'height'}:
        raise EditorError('Нужны координаты x, y, width, height в пикселях исходника.')
    if any(type(v) not in (int, float) or not math.isfinite(v) for v in region.values()):
        raise EditorError('Некорректные координаты лица.')
    x, y, w, h = (region[k] for k in ('x', 'y', 'width', 'height'))
    if x < 0 or y < 0 or w < 2 or h < 2 or x+w > size[0] or y+h > size[1]:
        raise EditorError('Выделение лица выходит за границы исходника.')
    return (math.floor(x), math.floor(y), math.ceil(x+w), math.ceil(y+h))

FACE_OPTION_KEYS = {'mask_shape', 'mask_expand', 'work_fit'}

def face_options(req):
    """v1.8.1 optional Face Fix geometry. Absent: exact v1.8.0 behaviour (rectangle, letterbox)."""
    options = req.get('face_options')
    if options is None:
        return dict(mask_shape='box', mask_expand=0, work_fit='letterbox')
    if not isinstance(options, dict) or set(options) != FACE_OPTION_KEYS:
        raise EditorError('face_options: нужны mask_shape, mask_expand, work_fit.')
    expand = options['mask_expand']
    if options['mask_shape'] not in ('ellipse', 'box') or options['work_fit'] not in ('aspect', 'letterbox') \
            or type(expand) not in (int, float) or not math.isfinite(expand) or not 0 <= expand <= .5:
        raise EditorError('face_options: mask_shape ellipse|box, mask_expand 0–0.5, work_fit aspect|letterbox.')
    return dict(options)

def edit_targets(req, original):
    """Source-pixel bounds to edit, in order. Inpaint: [None]. Detected ids are re-detected on the
    job's own decoded source; client-supplied boxes for them are never used."""
    if req['mode'] == 'inpaint':
        return [None], None
    if req.get('face_detection') is not None:
        from inference.facedetect import select_faces
        faces, result = select_faces(original, req['face_detection'])
        return [(f['x'], f['y'], f['x']+f['width'], f['y']+f['height']) for f in faces], result
    return [face_bounds(req['face_region'], original.size)], None

def fitted_work_size(crop, width, height):
    """Largest multiple-of-8 size with the crop's aspect inside width x height (no letterbox).
    Falls back to the explicit size when a side would drop below the API minimum (256)."""
    cw, ch = crop[2]-crop[0], crop[3]-crop[1]
    ratio = min(width/cw, height/ch)
    w, h = int(cw*ratio)//8*8, int(ch*ratio)//8*8
    return (w, h) if min(w, h) >= min(256, width, height) else (width, height)

def validate_editor(req):
    if req.get('mode') not in EDIT_MODES:
        if any(req.get(k) is not None for k in ('mask_image', 'face_region', 'mask_blur', 'mask_padding', 'inpaint_region', 'face_detection', 'face_options')):
            raise EditorError('Поля редактора допустимы только для Inpaint и Face Fix.')
        return
    if req.get('batch_size') != 1:
        raise EditorError('Редактор поддерживает batch 1. Значение не изменено.')
    if req.get('controlnet_config', {}).get('enabled') or any(r.get('enabled') for r in req.get('regions', [])):
        raise EditorError('Inpaint/Face Fix + ControlNet/Regional Control пока не поддерживаются. Отключите их явно.')
    strength = req.get('denoising_strength')
    if type(strength) not in (float, int) or not math.isfinite(strength) or not 0 < strength <= 1 or int(req['steps']*strength) < 1:
        raise EditorError('Denoise должен давать хотя бы один шаг и быть в диапазоне (0, 1].')
    for k, maximum, default in (('mask_blur', 64, 8), ('mask_padding', 1, .15)):
        v = req.get(k, default)
        if type(v) not in (float, int) or not math.isfinite(v) or not 0 <= v <= maximum:
            raise EditorError('Некорректный параметр '+k)
    if req.get('inpaint_region', 'crop') not in ('crop', 'full'):
        raise EditorError('Режим области должен быть crop или full.')
    with ExitStack() as stack:
        source = stack.enter_context(decode(req.get('init_image')))
        if req['mode'] == 'inpaint':
            if req.get('face_region') is not None or req.get('face_detection') is not None or req.get('face_options') is not None:
                raise EditorError('Face region не применяется к Inpaint.')
            mask = stack.enter_context(decode(req.get('mask_image'), mask=True))
            if mask.size != source.size:
                raise EditorError('Размеры источника и маски должны совпадать; маска не масштабируется автоматически.')
            if not mask.getbbox():
                raise EditorError('Маска пуста. Закрасьте редактируемую область белым.')
        else:
            if req.get('mask_image') is not None or req.get('inpaint_region', 'crop') != 'crop':
                raise EditorError('Face Fix использует выделение лица и режим crop.')
            face_options(req)
            if (req.get('face_region') is None) == (req.get('face_detection') is None):
                raise EditorError('Face Fix: укажите либо ручную рамку face_region, либо выбранные лица face_detection.')
            if req.get('face_detection') is not None:
                # Ids are resolved by re-running detection on this exact source.
                from inference.facedetect import select_faces
                select_faces(source, req['face_detection'])
            else:
                face_bounds(req.get('face_region'), source.size)

def face_mask(size, bounds, shape='box', expand=0):
    """Selection support for one face. `ellipse` leaves the box corners (hair, ears, background)
    untouched; `expand` grows the box by a fraction of its size per side, clipped to the image."""
    w, h = bounds[2]-bounds[0], bounds[3]-bounds[1]
    ex, ey = w*expand, h*expand
    box = (bounds[0]-ex, bounds[1]-ey, bounds[2]+ex-1, bounds[3]+ey-1)
    mask = Image.new('L', size)
    draw = ImageDraw.Draw(mask)
    if shape == 'ellipse':
        draw.ellipse(box, fill=255)
    else:
        draw.rectangle(tuple(round(v) for v in box), fill=255)
    if not mask.getbbox():
        mask.close()
        raise EditorError('Выделение лица пустое.')
    return mask

class EditSession:
    def __init__(self, req, source=None, face=None):
        """`source`: caller-owned RGBA image (sequential multi-face jobs), not closed here.
        `face`: source-pixel bounds for Face Fix; default is the request's manual face_region."""
        self.stack = ExitStack()
        self.images = []
        try:
            self.original = source if source is not None else self.keep(decode(req['init_image']))
            options = face_options(req) if req['mode'] == 'facefix' else dict(work_fit='letterbox')
            if req['mode'] == 'inpaint':
                mask = self.keep(decode(req['mask_image'], mask=True))
            else:
                b = face if face is not None else face_bounds(req['face_region'], self.original.size)
                mask = self.keep(face_mask(self.original.size, b, options['mask_shape'], options['mask_expand']))
            # Feather inward only, reaching zero at the boundary to avoid a rectangle seam.
            radius = float(req.get('mask_blur', 8))
            self.mask = self.keep(feather_mask(mask, radius)) if radius else mask
            bounds = mask.getbbox()
            pad = float(req.get('mask_padding', .15))
            px, py = math.ceil((bounds[2]-bounds[0])*pad), math.ceil((bounds[3]-bounds[1])*pad)
            self.crop = (max(0,bounds[0]-px), max(0,bounds[1]-py), min(self.original.width,bounds[2]+px), min(self.original.height,bounds[3]+py))
            if req['mode'] == 'inpaint' and req.get('inpaint_region', 'crop') == 'full':
                self.crop = (0,0,*self.original.size)
            cropped = self.keep(self.original.crop(self.crop))
            # Transparent sources are shown on white for inference; output retains source alpha.
            rgb = self.keep(Image.new('RGB', cropped.size, 'white'))
            rgb.paste(cropped, mask=self.keep(cropped.getchannel('A')))
            cmask = self.keep(self.mask.crop(self.crop))
            w, h = req['width'], req['height']
            if options['work_fit'] == 'aspect':
                w, h = fitted_work_size(self.crop, w, h)
            ratio = min(w/rgb.width, h/rgb.height)
            rw, rh = max(1,round(rgb.width*ratio)), max(1,round(rgb.height*ratio))
            left, top = (w-rw)//2, (h-rh)//2
            self.content = (left, top, left+rw, top+rh)
            self.source = self.keep(Image.new('RGB', (w,h), 'white'))
            self.source.paste(self.keep(rgb.resize((rw,rh),Image.Resampling.LANCZOS)), (left,top))
            self.work_mask = self.keep(Image.new('L', (w,h)))
            self.work_mask.paste(self.keep(cmask.resize((rw,rh),Image.Resampling.NEAREST)), (left,top))
            if self.work_mask.getextrema()[1] < 128:
                raise EditorError('Маска слишком мала для выбранного рабочего разрешения. Увеличьте его или используйте crop.')
        except Exception:
            self.close()
            raise

    def keep(self, image):
        self.stack.callback(image.close)
        return image

    def composite(self, generated):
        # No VAE reconstruction outside the mask, including source alpha.
        with generated.crop(self.content) as region:
            with region.resize((self.crop[2]-self.crop[0], self.crop[3]-self.crop[1]), Image.Resampling.LANCZOS) as patch:
                with self.original.crop(self.crop) as original, self.mask.crop(self.crop) as mask:
                    with Image.composite(patch.convert('RGBA'), original, mask) as blended:
                        blended.putalpha(original.getchannel('A'))
                        result = self.original.copy()
                        result.paste(blended, self.crop[:2])
                        return result

    def close(self):
        self.stack.close()

def activate(adapter):
    from diffusers import StableDiffusionXLInpaintPipeline
    from inference.controlnet import to_base
    to_base(adapter)
    base = adapter.pipe
    if base.unet.config.in_channels != 4:
        raise EditorError('Нужен SDXL/Illustrious checkpoint с 4-канальным UNet. Модель не заменена.')
    modules = {k:getattr(base,k) for k in ('unet','vae','text_encoder','text_encoder_2')}
    # Check actual parameter storage before hooks move devices, not only object references.
    base.remove_all_hooks()
    storage = {k:tuple((id(p), p.data_ptr(), p.dtype) for p in m.parameters()) for k,m in modules.items() if m is not None}
    try:
        pipe = StableDiffusionXLInpaintPipeline.from_pipe(base, torch_dtype=None)
        for k,m in modules.items():
            if getattr(pipe,k) is not m or k in storage and tuple((id(p),p.data_ptr(),p.dtype) for p in m.parameters()) != storage[k]:
                raise EditorError('Не удалось безопасно переиспользовать компоненты SDXL.')
        pipe._yoisaki_editor = True
        adapter.pipe = pipe
        pipe.enable_model_cpu_offload()
    except Exception:
        base.enable_model_cpu_offload()
        raise
    adapter.measure('after_editor_view')
    return adapter.pipe
