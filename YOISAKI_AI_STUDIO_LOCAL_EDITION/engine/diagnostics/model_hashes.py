"""Optional local SHA-256 manifest. Run while inference is stopped; no weights loaded."""
import hashlib,json,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from worker.models import entries,model_id

def fingerprints(root):
    root=Path(root).expanduser().resolve()
    for path,kind in entries(root):
        files=sorted(p for p in path.rglob('*') if p.is_file()) if path.is_dir() else [path]
        for file in files:
            if not file.resolve().is_relative_to(root):continue
            digest=hashlib.sha256()
            with file.open('rb') as stream:
                for chunk in iter(lambda:stream.read(1024*1024),b''):digest.update(chunk)
            yield {'id':model_id(path.relative_to(root).as_posix()),'kind':kind,'file':file.relative_to(root).as_posix(),'sha256':digest.hexdigest(),'bytes':file.stat().st_size}
if __name__=='__main__':
    if len(sys.argv)!=2:raise SystemExit('Usage: python diagnostics/model_hashes.py MODEL_ROOT')
    print(json.dumps(list(fingerprints(sys.argv[1])),ensure_ascii=False,indent=2))
