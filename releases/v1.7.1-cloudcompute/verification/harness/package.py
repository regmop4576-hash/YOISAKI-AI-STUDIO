"""Rebuild package-manifest.json (same hashing rule as scripts/verify-package.mjs) and the release ZIP.
Usage: python3 package.py <package dir> <output zip>
Existing manifest entries for unchanged files keep their value; engine/ and colab/ entries must not change."""
import hashlib, json, os, re, stat, sys, zipfile
from pathlib import Path

pkg = Path(sys.argv[1]).resolve()
out = Path(sys.argv[2]).resolve()
SKIP_DIRS = {'.git', '__pycache__', 'node_modules', 'dist', '.venv', '.results', '.pytest_cache'}

def files():
    for root, dirs, names in os.walk(pkg):
        dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS)
        for name in sorted(names):
            p = Path(root) / name
            if p.is_symlink():
                raise SystemExit(f'symlink not allowed: {p}')
            yield p.relative_to(pkg).as_posix()

def digest(rel):
    data = (pkg / rel).read_bytes()
    if rel.endswith('.sh'):
        data = re.sub(rb'^#![^\n]+', b'#!/usr/bin/env bash', data, count=1)
    return hashlib.sha256(data).hexdigest()

old = json.loads((pkg / 'package-manifest.json').read_text())
new = {rel: digest(rel) for rel in files() if rel != 'package-manifest.json'}
frozen = [k for k in old if k.startswith(('engine/', 'colab/'))]
changed_frozen = [k for k in frozen if new.get(k) != old[k]]
if changed_frozen:
    raise SystemExit(f'engine/colab files changed: {changed_frozen}')
removed = sorted(set(old) - set(new))
if removed:
    raise SystemExit(f'files removed: {removed}')
(pkg / 'package-manifest.json').write_text(json.dumps(dict(sorted(new.items())), indent=2, ensure_ascii=False) + '\n')
added = sorted(set(new) - set(old))
modified = sorted(k for k in old if new[k] != old[k])
print(f'manifest: {len(new)} files; added {len(added)}; modified {len(modified)}: {modified}')

top = 'YOISAKI_AI_STUDIO_V1.4.0_LOCAL_EDITION'  # compatibility path expected by update.sh
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for rel in [*files()]:
        info = zipfile.ZipInfo(f'{top}/{rel}', date_time=(2026, 10, 25, 12, 0, 0))
        mode = (pkg / rel).stat().st_mode
        info.external_attr = ((0o755 if mode & stat.S_IXUSR else 0o644) | stat.S_IFREG) << 16
        info.compress_type = zipfile.ZIP_DEFLATED
        z.writestr(info, (pkg / rel).read_bytes())
print(f'zip: {out} ({out.stat().st_size} bytes), sha256 {hashlib.sha256(out.read_bytes()).hexdigest()}')
