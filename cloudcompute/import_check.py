"""Runs the exact Colab import check from engine/bootstrap.py (single source of truth) plus the
CloudCompute requirements: PyTorch kernels for T4 (sm_75) through RTX 50xx (sm_120)."""
import ast
import sys
from pathlib import Path

engine = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).resolve().parents[1] / 'engine')
tree = ast.parse((engine / 'bootstrap.py').read_text())
check = next(node.value.value for node in ast.walk(tree)
             if isinstance(node, ast.Assign) and any(getattr(t, 'id', None) == 'check' for t in node.targets))
sys.path.insert(0, str(engine))
exec(compile(check, 'bootstrap.check', 'exec'), {'__name__': '__yoisaki_check__'})
import torch  # noqa: E402
arch = torch._C._cuda_getArchFlags().split()  # compiled list; get_arch_list() is empty without a GPU
print('torch', torch.__version__, 'cuda', torch.version.cuda, 'arch', ' '.join(arch))
missing = [a for a in ('sm_75', 'sm_86', 'sm_120') if a not in arch]
if missing:
    sys.exit('PyTorch build lacks kernels for ' + ' '.join(missing))
print('ARCH_OK')
