"""v1.8.1 automatic face detection for Face Fix. CPU only, small bundled OpenCV models.

Coordinates are integer EXIF-oriented source pixels. Detector tensors never leave this module.
The SDXL pipeline is not touched here; detection never allocates CUDA memory.
Detections are reproducible: the same decoded image and settings give the same face ids, so a
/generate request can name ids and the engine re-detects instead of trusting client boxes.
"""
import hashlib
import math
import threading
import time
from pathlib import Path

from inference.editor import EditorError, decode

MODEL_DIR = Path(__file__).with_name('face_models')
MODELS = {
    'anime': ('lbpcascade_animeface.xml', '9376d30ac38db6bda2a68b88b3b76bbd7e6aa33af47f7f5c76bc88ca75f1ce30'),
    'human': ('face_detection_yunet_2023mar.onnx', '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4'),
}
DETECTORS = ('auto', 'anime', 'human')
DEFAULT_MIN_CONFIDENCE = .35
# A face is selected without user input only above this score and only when it is the sole such face.
AUTO_SELECT_CONFIDENCE = .6
MAX_FACES = 12
LBP_MAX_SIDE = 1600
YUNET_SIDES = (640, 1280)
VERSION = 1

_models = {}
_model_lock = threading.Lock()
# One detection at a time; it runs on CPU beside (never inside) the single GPU worker.
detect_lock = threading.Lock()

def _model(kind):
    with _model_lock:
        if kind in _models:
            return _models[kind]
        import cv2
        name, expected = MODELS[kind]
        path = MODEL_DIR / name
        try:
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
        except OSError as exc:
            raise EditorError('Файл детектора лиц отсутствует. Переустановите движок v1.8.1.') from exc
        if digest != expected:
            raise EditorError('Файл детектора лиц повреждён. Переустановите движок v1.8.1.')
        if kind == 'anime':
            model = cv2.CascadeClassifier(str(path))
            if model.empty():
                raise EditorError('Не удалось загрузить детектор аниме-лиц.')
        else:
            model = cv2.FaceDetectorYN.create(str(path), '', (320, 320), .3, .3, 50)
        _models[kind] = model
        return model

def loaded_models():
    with _model_lock:
        return sorted(_models)

def _scaled(array, side):
    import cv2
    h, w = array.shape[:2]
    ratio = min(1., side / max(w, h))
    if ratio == 1.:
        return array, 1.
    return cv2.resize(array, (max(1, round(w*ratio)), max(1, round(h*ratio))), interpolation=cv2.INTER_AREA), ratio

def _lbp(bgr):
    """Anime/illustration faces. The cascade has no probability; its last-stage weight is mapped
    to (0, 1) with a logistic calibrated on the v1.8.1 evaluation set (see FACE_DETECTION_REPORT)."""
    import cv2
    import numpy as np
    small, ratio = _scaled(bgr, LBP_MAX_SIDE)
    gray = cv2.equalizeHist(cv2.cvtColor(small, cv2.COLOR_BGR2GRAY))
    rects, _, weights = _model('anime').detectMultiScale3(gray, scaleFactor=1.1, minNeighbors=3, minSize=(24, 24), outputRejectLevels=True)
    out = []
    for (x, y, w, h), weight in zip(rects, np.ravel(weights)):
        out.append(((x/ratio, y/ratio, w/ratio, h/ratio), 1/(1+math.exp(-1.5*(float(weight)-.5)))))
    return out

def _yunet(bgr):
    """General (mostly human) faces. YuNet sees faces of roughly 10-300 px, so two scales are used."""
    detector = _model('human')
    out = []
    long_side = max(bgr.shape[:2])
    for side in YUNET_SIDES:
        if side > YUNET_SIDES[0] and long_side <= side*.8:
            break
        small, ratio = _scaled(bgr, side)
        detector.setInputSize((small.shape[1], small.shape[0]))
        _, faces = detector.detect(small)
        for row in (faces if faces is not None else []):
            x, y, w, h = (float(v)/ratio for v in row[:4])
            out.append(((x, y, w, h), float(row[-1])))
    return _merge([(b, c, ('human',)) for b, c in out], fuse=False)

def _overlap(a, b):
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    iw = max(0., min(ax+aw, bx+bw)-max(ax, bx))
    ih = max(0., min(ay+ah, by+bh)-max(ay, by))
    inter = iw*ih
    if not inter:
        return 0.
    return max(inter/(aw*ah+bw*bh-inter), inter/min(aw*ah, bw*bh)*.75)

def _merge(items, fuse=True):
    """Greedy grouping by overlap. Within one detector: keep the best box. Across detectors:
    confidence-weighted box and noisy-OR confidence, so agreement raises confidence."""
    items = sorted(items, key=lambda x: -x[1])
    groups = []
    for box, conf, names in items:
        for group in groups:
            if _overlap(group['box'], box) >= .35:
                if fuse and not set(names) <= set(group['names']):
                    total = group['conf']+conf
                    group['box'] = tuple((g*group['conf']+v*conf)/total for g, v in zip(group['box'], box))
                    group['conf'] = 1-(1-group['conf'])*(1-conf)
                    group['names'] = tuple(sorted(set(group['names'])|set(names)))
                break
        else:
            groups.append({'box': box, 'conf': conf, 'names': tuple(names)})
    return [(g['box'], g['conf'], g['names']) for g in groups]

def validate_options(detector, min_confidence):
    if detector not in DETECTORS:
        raise EditorError('Детектор: auto, anime или human.')
    if type(min_confidence) not in (int, float) or not math.isfinite(min_confidence) or not .05 <= min_confidence <= .95:
        raise EditorError('Порог уверенности детектора: от 0.05 до 0.95.')

def detect(image, detector='auto', min_confidence=DEFAULT_MIN_CONFIDENCE):
    """`image` is the decoded RGBA source. Returns the public detection document."""
    import numpy as np
    validate_options(detector, min_confidence)
    started = time.perf_counter()
    with detect_lock:
        rgb = image.convert('RGB') if 'A' not in image.getbands() else None
        if rgb is None:
            from PIL import Image
            rgb = Image.new('RGB', image.size, 'white')
            with image.getchannel('A') as alpha:
                rgb.paste(image, mask=alpha)
        try:
            import cv2
            bgr = cv2.cvtColor(np.asarray(rgb), cv2.COLOR_RGB2BGR)
        finally:
            rgb.close()
        # Ids bind to the exact pixels; hash the existing buffer instead of copying the image again.
        digest = hashlib.sha256(memoryview(bgr)).hexdigest()
        found = []
        run = ('anime', 'human') if detector == 'auto' else (detector,)
        if 'anime' in run:
            found += [(b, c, ('anime',)) for b, c in _lbp(bgr)]
        if 'human' in run:
            found += _yunet(bgr)
        del bgr
    width, height = image.size
    faces = []
    for (x, y, w, h), conf, names in _merge(found):
        x0, y0 = max(0, math.floor(x)), max(0, math.floor(y))
        x1, y1 = min(width, math.ceil(x+w)), min(height, math.ceil(y+h))
        if x1-x0 < 8 or y1-y0 < 8 or conf < min_confidence:
            continue
        box = dict(x=x0, y=y0, width=x1-x0, height=y1-y0)
        ident = 'f'+hashlib.sha256(f'{VERSION}|{digest}|{detector}|{x0},{y0},{x1},{y1}'.encode()).hexdigest()[:12]
        faces.append(dict(id=ident, **box, confidence=round(conf, 4), detector='+'.join(names), label='face',
                          auto_selectable=conf >= AUTO_SELECT_CONFIDENCE))
    faces.sort(key=lambda f: (-f['width']*f['height'], f['y'], f['x']))
    faces = faces[:MAX_FACES]
    strong = [f for f in faces if f['auto_selectable']]
    return dict(detector=detector, detectors_run=list(run), min_confidence=min_confidence,
                auto_select_confidence=AUTO_SELECT_CONFIDENCE, image=dict(width=width, height=height),
                faces=faces, selected=strong[0]['id'] if len(strong) == 1 else None,
                selection_required=len(strong) != 1 and bool(faces),
                duration_ms=round((time.perf_counter()-started)*1000, 1))

def detect_request(data):
    """HTTP body {image, detector?, min_confidence?} -> detection document. Image validated like /generate."""
    if not isinstance(data, dict) or not set(data) <= {'image', 'detector', 'min_confidence'}:
        raise EditorError('Ожидаются поля image, detector, min_confidence.')
    detector = data.get('detector', 'auto')
    min_confidence = data.get('min_confidence', DEFAULT_MIN_CONFIDENCE)
    validate_options(detector, min_confidence)
    with decode(data.get('image')) as image:
        return detect(image, detector, min_confidence)

def select_faces(image, spec):
    """Resolve a /generate `face_detection` spec on the exact job source. Unknown ids fail closed."""
    if not isinstance(spec, dict) or set(spec) != {'detector', 'min_confidence', 'select'}:
        raise EditorError('face_detection: нужны detector, min_confidence и select.')
    ids = spec['select']
    if not isinstance(ids, list) or not 1 <= len(ids) <= MAX_FACES or len(set(ids)) != len(ids) or not all(isinstance(i, str) and len(i) == 13 for i in ids):
        raise EditorError('Выберите от 1 до 12 найденных лиц.')
    result = detect(image, spec['detector'], spec['min_confidence'])
    by_id = {f['id']: f for f in result['faces']}
    missing = [i for i in ids if i not in by_id]
    if missing:
        raise EditorError('Выбранное лицо не найдено при повторной проверке. Обновите обнаружение лиц и выберите заново.')
    return [by_id[i] for i in ids], result
