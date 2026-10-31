"""Integration stand: the REAL YOISAKI ENGINE FastAPI app from the notebook package, served by uvicorn on CPU.
Only test shims: torch.cuda.* answers like a 16 GB GPU named 'CPU SHIM (no CUDA)' and model CPU offload targets the CPU.
Models on disk are REAL Diffusers / LoRA files, but tiny and randomly initialised (no image quality, no T4 claim).
usage: python engine_stand.py ENGINE_PKG MODELS_DIR PORT TOKEN
"""
import sys, types, json
PKG, MODELS, PORT, TOKEN = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4]
sys.path.insert(0, PKG)
from pathlib import Path
import torch
GB = 16 * 2**30
torch.cuda.is_available = lambda: True
torch.cuda.get_device_name = lambda *a, **k: 'CPU SHIM (no CUDA)'
torch.cuda.mem_get_info = lambda *a, **k: (15 * 2**30, GB)
for n in ('memory_allocated', 'memory_reserved', 'max_memory_allocated', 'max_memory_reserved'): setattr(torch.cuda, n, lambda *a, **k: 0)
for n in ('empty_cache', 'synchronize', 'reset_peak_memory_stats'): setattr(torch.cuda, n, lambda *a, **k: None)
torch.cuda.get_device_properties = lambda *a, **k: types.SimpleNamespace(total_memory=GB, name='CPU SHIM (no CUDA)')
from diffusers import DiffusionPipeline, StableDiffusionXLPipeline, UNet2DConditionModel, AutoencoderKL, EulerDiscreteScheduler
_offload = DiffusionPipeline.enable_model_cpu_offload
DiffusionPipeline.enable_model_cpu_offload = lambda self, gpu_id=None, device=None: _offload(self, device='cpu')
from transformers import CLIPTextConfig, CLIPTextModel, CLIPTextModelWithProjection, CLIPTokenizer

def build(models: Path):
    ck = models / 'checkpoints' / 'tiny-sdxl-test'
    if (ck / 'model_index.json').is_file(): return
    torch.manual_seed(0)
    tmp = models / '_tok'; tmp.mkdir(parents=True, exist_ok=True)
    vocab = {'<|startoftext|>': 0, '<|endoftext|>': 1}
    for c in 'abcdefghijklmnopqrstuvwxyz': vocab[c] = len(vocab); vocab[c + '</w>'] = len(vocab)
    (tmp / 'vocab.json').write_text(json.dumps(vocab)); (tmp / 'merges.txt').write_text('#version: 0.2\n')
    tok = CLIPTokenizer(vocab_file=str(tmp / 'vocab.json'), merges_file=str(tmp / 'merges.txt'), model_max_length=16)
    cfg = CLIPTextConfig(vocab_size=len(vocab), hidden_size=8, intermediate_size=16, num_hidden_layers=2, num_attention_heads=2,
                         max_position_embeddings=16, projection_dim=8, bos_token_id=0, eos_token_id=1, pad_token_id=1)
    unet = UNet2DConditionModel(sample_size=4, in_channels=4, out_channels=4, down_block_types=('CrossAttnDownBlock2D', 'DownBlock2D'),
                                up_block_types=('UpBlock2D', 'CrossAttnUpBlock2D'), block_out_channels=(16, 32), layers_per_block=1,
                                cross_attention_dim=16, attention_head_dim=4, norm_num_groups=4, addition_embed_type='text_time',
                                addition_time_embed_dim=2, projection_class_embeddings_input_dim=20)
    vae = AutoencoderKL(block_out_channels=(8, 8, 8, 8), down_block_types=('DownEncoderBlock2D',) * 4,
                        up_block_types=('UpDecoderBlock2D',) * 4, norm_num_groups=4, latent_channels=4)
    pipe = StableDiffusionXLPipeline(vae=vae, text_encoder=CLIPTextModel(cfg), text_encoder_2=CLIPTextModelWithProjection(cfg),
                                     tokenizer=tok, tokenizer_2=tok, unet=unet, scheduler=EulerDiscreteScheduler(), add_watermarker=False)
    pipe.save_pretrained(str(ck), safe_serialization=True)
    # A real PEFT LoRA file for the UNet, saved in the Diffusers LoRA format.
    from peft import LoraConfig
    from peft.utils import get_peft_model_state_dict
    unet.add_adapter(LoraConfig(r=2, lora_alpha=2, target_modules=['to_q', 'to_k', 'to_v', 'to_out.0']), adapter_name='style')
    for n, p in unet.named_parameters():
        if 'lora_' in n:
            with torch.no_grad(): p.normal_(std=.3)
    lora_dir = models / '_lora'; lora_dir.mkdir(exist_ok=True)
    StableDiffusionXLPipeline.save_lora_weights(str(lora_dir), unet_lora_layers=get_peft_model_state_dict(unet, adapter_name='style'))
    (models / 'loras').mkdir(exist_ok=True)
    (lora_dir / 'pytorch_lora_weights.safetensors').rename(models / 'loras' / 'tiny_style_test.safetensors')

build(Path(MODELS))
import uvicorn
from worker.direct_server import create_app
uvicorn.run(create_app(MODELS, TOKEN), host='127.0.0.1', port=PORT, log_level='warning')
