# VALIDATION ONLY: CUDA test double (no GPU in the validation sandbox). Never shipped.
import torch
torch.cuda.is_available = lambda: True
torch.cuda.get_device_name = lambda *a: 'TEST_DOUBLE_NOT_REAL_GPU'
torch.cuda.mem_get_info = lambda *a: (15 * 2**30, 16 * 2**30)
