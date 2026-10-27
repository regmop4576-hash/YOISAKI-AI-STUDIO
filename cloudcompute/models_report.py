"""CloudCompute 1.7.3: `./check-cloudcompute.sh models` — what the engine catalogue sees and why a model is hidden.

Uses the engine's own classifier (engine/worker/models.py, unchanged), so the verdict is exactly the one the
generator receives. Prints kind, compatibility, architecture, size, base-model hint and, for unreadable files,
the read error. Stdlib only; reads file headers, never loads weights.
"""
import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, os.environ.get('YOISAKI_ENGINE_DIR') or str(HERE.parent / 'engine'))
sys.path.insert(0, str(HERE))
import inventory  # noqa: E402
from launcher import Config, LaunchError  # noqa: E402

VERDICT = {True: 'совместима', None: 'не определена (разрешена)', False: 'НЕСОВМЕСТИМА (скрыта в старых версиях сайта)'}


def main(argv):
    try:
        cfg = Config()
    except LaunchError as exc:
        print('ОШИБКА: ' + str(exc), file=sys.stderr)
        return 3
    models = inventory.compact(cfg.models)
    if '--json' in argv:
        print(json.dumps({'revision': inventory.revision(cfg.models), 'models': models}, ensure_ascii=False, indent=1))
        return 0
    print(f'Папка моделей: {cfg.models}  ·  ревизия {inventory.revision(cfg.models)}')
    if not models:
        print('Моделей нет.')
    for m in models:
        size = '—' if m.get('size_bytes') is None else f"{m['size_bytes'] / 2**20:.0f} МБ"
        print(f"[{m['kind']}] {m['name']}: {VERDICT[m.get('compatible')]} · {m.get('architecture')} · {size}")
        if m.get('base_model'):
            print(f"    базовая модель в метаданных: {m['base_model']}")
        if m.get('detail'):
            print(f"    ошибка чтения: {m['detail']}")
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
