"""CloudCompute 1.7.3: compact model inventory next to the UNCHANGED engine catalogue (worker.models).

GET /inventory           -> {'revision': '<hex>'}               cheap: file names, sizes and mtimes only
GET /inventory?models=1  -> {'revision': ..., 'models': [...]}   the engine's own scan() without the safetensors
                            metadata blobs, plus the base-model hint and, for unreadable files, the reason.

The website polls the revision, so models copied to the server (scp, Drive sync) appear without a restart and
without re-downloading the full /models answer. Compatibility is decided by worker.models.inspect() exactly as the
engine decides it; nothing here re-classifies a model.
"""
import hashlib
from pathlib import Path

from worker.models import KINDS, contained, entries, inspect, model_id, scan

DETAIL_MAX = 300


def revision(root):
    """Hash of (relative path, size, mtime) of every file the engine catalogue can see."""
    base = Path(root).expanduser().resolve()
    h = hashlib.sha256()
    for folder in sorted(KINDS):
        directory = base / folder
        if not directory.is_dir() or not contained(directory, base):
            continue
        for p in sorted(directory.rglob('*')):
            try:
                if not p.is_file() or not contained(p, base):
                    continue
                st = p.stat()
            except OSError:
                continue
            h.update(f'{p.relative_to(base).as_posix()}\0{st.st_size}\0{st.st_mtime_ns}\n'.encode())
    return h.hexdigest()[:32]


def _base_hint(meta):
    if not isinstance(meta, dict):
        return ''
    parts = [str(meta.get(k, '')).strip()[:60] for k in ('ss_base_model_version', 'modelspec.architecture')]
    return ' · '.join(p for p in parts if p)[:120]


def _failure_details(root):
    """Reason text for files the engine could not read (scan() reports them as architecture 'invalid')."""
    base = Path(root).expanduser().resolve()
    out = {}
    for path, kind in entries(base):
        try:
            inspect(path, kind)
        except (ValueError, OSError, TypeError) as exc:
            out[model_id(path.relative_to(base).as_posix())] = f'{type(exc).__name__}: {exc}'[:DETAIL_MAX]
    return out


def compact(root):
    models = scan(root)
    details = _failure_details(root) if any(m.get('architecture') == 'invalid' for m in models) else {}
    result = []
    for m in models:
        item = {k: m.get(k) for k in ('id', 'name', 'kind', 'architecture', 'compatible', 'size_bytes')}
        hint = _base_hint(m.get('metadata'))
        if hint:
            item['base_model'] = hint
        if m.get('kind') == 'lora':
            words = m.get('trigger_words')
            if isinstance(words, list):
                item['trigger_words'] = [w for w in words if isinstance(w, str)][:64]
            elif isinstance(words, str) and not words.strip().startswith('{'):
                item['trigger_words'] = words[:4000]
            side = m.get('sidecar')
            if isinstance(side, dict):
                item['sidecar'] = {k: side[k] for k in ('trainedWords', 'description') if k in side}
        if m['id'] in details:
            item['detail'] = details[m['id']]
        result.append(item)
    return result


def add_routes(app, auth, model_root):
    def inventory(models: bool = False):
        body = {'revision': revision(model_root)}
        if models:
            body['models'] = compact(model_root)
        return body
    app.add_api_route('/inventory', inventory, methods=['GET'], dependencies=auth)
    return app
