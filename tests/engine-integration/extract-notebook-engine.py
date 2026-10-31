"""Extract the engine package embedded in a YOISAKI ENGINE Colab notebook (cell 1, _PACKAGE) and verify _EXPECTED.
usage: python3 -I extract-notebook-engine.py NOTEBOOK.ipynb OUT_DIR"""
import sys, json, re, base64, hashlib, zipfile, io
nb = json.load(open(sys.argv[1], encoding='utf-8'))
src = next(''.join(c['source']) for c in nb['cells'] if c['cell_type'] == 'code' and '_PACKAGE = ' in ''.join(c['source']))
raw = base64.b64decode(re.search(r"_PACKAGE = '([A-Za-z0-9+/=]+)'", src).group(1))
expected = re.search(r"_EXPECTED = '([0-9a-f]{64})'", src).group(1)
if hashlib.sha256(raw).hexdigest() != expected: raise SystemExit('package checksum mismatch')
zipfile.ZipFile(io.BytesIO(raw)).extractall(sys.argv[2]); print('engine package OK:', expected)
