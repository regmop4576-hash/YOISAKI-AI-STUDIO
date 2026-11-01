"""Run Smart Face Fix detection on YOUR OWN reference images and print what the engine would offer.
Usage (Colab after "ПОДГОТОВИТЬ ПАНЕЛЬ", or any machine with opencv-python-headless + Pillow):
    python /content/yoisaki_engine/face_eval.py /path/to/folder [--detector auto]
Reads PNG/JPEG/WebP only; prints boxes and confidences; writes nothing and sends nothing anywhere.
Detection success says nothing about repair quality, which must be judged on real SDXL results."""
import argparse, sys, time
from pathlib import Path

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('folder')
    ap.add_argument('--engine', default=str(Path(__file__).resolve().parent))
    ap.add_argument('--detector', default='auto', choices=['auto', 'anime', 'human'])
    ap.add_argument('--min-confidence', type=float, default=.35)
    a = ap.parse_args()
    sys.path.insert(0, a.engine)
    from PIL import Image, ImageOps
    from inference.facedetect import detect
    for path in sorted(p for p in Path(a.folder).iterdir() if p.suffix.lower() in ('.png', '.jpg', '.jpeg', '.webp')):
        with Image.open(path) as im:
            image = ImageOps.exif_transpose(im).convert('RGBA')
        started = time.perf_counter()
        r = detect(image, a.detector, a.min_confidence)
        state = 'AUTO' if r['selected'] else 'CHOOSE' if r['selection_required'] else 'NONE'
        print(f'{path.name}: {image.width}x{image.height} {state} {len(r["faces"])} face(s) {1000*(time.perf_counter()-started):.0f} ms')
        for f in r['faces']:
            print(f'   {f["id"]} x={f["x"]} y={f["y"]} {f["width"]}x{f["height"]} conf={f["confidence"]:.2f} {f["detector"]}{"" if f["auto_selectable"] else " (uncertain)"}')

if __name__ == '__main__':
    main()
