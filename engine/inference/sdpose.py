"""SDPose-OOD body pose preprocessor (v1.6.2): a pose map for the existing OpenPose ControlNet.

Reference: https://github.com/T-S-Liang/SDPose-OOD (MIT). One x0-prediction pass of the SD2-based
UNet at t=999 on the image latent, decoder features -> HeatmapHead -> UDP/DARK keypoints, drawn
in OpenPose-18 style by controlnet_aux exactly like the classic preprocessor.

Memory policy (Colab Free T4): the models are loaded only for one request (fp16 on CUDA,
weights placed directly on the GPU; the SDXL pipeline is CPU-offloaded at that moment), and every
reference is dropped, garbage-collected and the CUDA cache emptied before preprocess() returns.
mmpose/mmcv and the CLIP text encoder are not needed: the head is plain torch and the empty-prompt
embedding is bundled (sdpose_empty_embed.safetensors, 8 KB)."""
import gc, hashlib, os, traceback
from pathlib import Path
from .controlnet import ControlNetError

# Official diffusers-format Body model (unet/, vae/, decoder/decoder.safetensors). A local mirror
# directory with the same layout can be given when Hugging Face is unreachable.
REPO = os.environ.get('YOISAKI_SDPOSE_REPO', 'teemosliang/SDPose-Body')
INPUT_SIZE = (768, 1024)  # model input W, H (heatmaps 192x256)
TIMESTEP = 999
LATENT_SCALE = 0.18215
SCORE_THRESHOLD = 0.3
MIN_KEYPOINTS = 3
EMBED_PATH = Path(__file__).with_name('sdpose_empty_embed.safetensors')
EMBED_SHA256 = '03d73b8b792dd00dbd3034b3116cfe36ac3c2bafaa17245109c432bbdb64d9b3'  # raw fp32 [1, 2, 1024]
# COCO-17 -> OpenPose-18 body order; index 1 (neck) is the midpoint of both shoulders.
OPENPOSE_FROM_COCO = (0, None, 6, 8, 10, 5, 7, 9, 12, 14, 16, 11, 13, 15, 2, 1, 4, 3)

class SDPoseError(ControlNetError):
    pass

def build_head(in_channels=320, keypoints=17):
    """mmpose HeatmapHead of SDPose-Body (InstanceNorm + SiLU variant); identical state_dict keys."""
    from torch import nn
    class HeatmapHead(nn.Module):
        def __init__(self):
            super().__init__()
            self.deconv_layers = nn.Sequential(nn.ConvTranspose2d(in_channels, in_channels, 4, stride=2, padding=1, output_padding=0, bias=False), nn.InstanceNorm2d(in_channels), nn.SiLU(inplace=True))
            self.conv_layers = nn.Sequential(nn.Conv2d(in_channels, in_channels, 1), nn.InstanceNorm2d(in_channels), nn.SiLU(inplace=True))
            self.final_layer = nn.Conv2d(in_channels, keypoints, 1)
        def forward(self, x):
            return self.final_layer(self.conv_layers(self.deconv_layers(x)))
    return HeatmapHead()

def head_state(state, conv_layers=3):
    """mmpose HeatmapHead._load_state_dict_pre_hook, which runs for a plain (version-less) state dict:
    pre-1.0 'final_layer.n.x' keys become 'conv_layers.n.x' (n < len(conv_layers)) or 'final_layer.x'."""
    out = {}
    for key, value in state.items():
        parts = key.split('.')
        if parts[0] == 'final_layer' and len(parts) == 3:
            key = 'conv_layers.' + '.'.join(parts[1:]) if int(parts[1]) < conv_layers else 'final_layer.' + parts[2]
        out[key] = value
    return out

def load_embedding():
    from safetensors.torch import load_file
    tensor = load_file(str(EMBED_PATH))['empty_text_embed']
    if tuple(tensor.shape) != (1, 2, 1024) or hashlib.sha256(tensor.contiguous().numpy().tobytes()).hexdigest() != EMBED_SHA256:
        raise SDPoseError('Повреждён встроенный файл SDPose-OOD. Заново откройте блокнот v1.7.0.')
    return tensor

def load_models(device, dtype):
    """Returns (unet, vae, head). Only the unet, vae and decoder subfolders are downloaded."""
    import torch
    from diffusers import AutoencoderKL, UNet2DConditionModel
    from safetensors.torch import load_file
    local = Path(REPO).is_dir()
    common = {'local_files_only': True} if local else {}
    # Same config override as the official loader; weights go straight to the GPU in fp16.
    unet = UNet2DConditionModel.from_pretrained(REPO, subfolder='unet', class_embed_type='projection', projection_class_embeddings_input_dim=4,
                                                torch_dtype=dtype, low_cpu_mem_usage=True, device_map=str(device), **common).eval()
    # The VAE encoder stays fp32 like the reference (~0.14 GB); the decoder is never used.
    vae = AutoencoderKL.from_pretrained(REPO, subfolder='vae', torch_dtype=torch.float32, low_cpu_mem_usage=True, **common)
    vae.decoder = None; vae.post_quant_conv = None
    vae = vae.to(device).eval()
    if local:
        decoder = Path(REPO) / 'decoder' / 'decoder.safetensors'
    else:
        from huggingface_hub import hf_hub_download
        decoder = hf_hub_download(REPO, 'decoder/decoder.safetensors')
    head = build_head()
    head.load_state_dict(head_state(load_file(str(decoder))), strict=True)
    return unet, vae, head.to(device=device, dtype=dtype).eval()

def letterbox(image):
    """Aspect-preserving fit into the 3:4 model input (black padding, as a full-image top-down crop)."""
    from PIL import Image
    w, h = INPUT_SIZE
    scale = min(w / image.width, h / image.height)
    size = (max(1, round(image.width * scale)), max(1, round(image.height * scale)))
    offset = ((w - size[0]) // 2, (h - size[1]) // 2)
    canvas = Image.new('RGB', INPUT_SIZE)
    with image.resize(size, Image.Resampling.BILINEAR) as resized:
        canvas.paste(resized, offset)
    return canvas, scale, offset

def decode_heatmaps(heatmaps, blur_kernel=11):
    """mmpose UDPHeatmap.decode (argmax + DARK-UDP refinement) for heatmaps (K, H, W) -> input-space
    keypoints (K, 2) and scores (K,)."""
    import cv2, numpy as np
    heatmaps = np.array(heatmaps, dtype=np.float32)
    K, H, W = heatmaps.shape
    flat = heatmaps.reshape(K, -1)
    y, x = np.unravel_index(np.argmax(flat, axis=1), (H, W))
    keypoints = np.stack((x, y), axis=-1).astype(np.float32)
    scores = flat.max(axis=1)
    valid = scores > 0
    border = (blur_kernel - 1) // 2
    blurred = np.empty_like(heatmaps)
    for k in range(K):
        origin = heatmaps[k].max()
        padded = np.zeros((H + 2 * border, W + 2 * border), dtype=np.float32)
        padded[border:-border, border:-border] = heatmaps[k]
        blurred[k] = cv2.GaussianBlur(padded, (blur_kernel, blur_kernel), 0)[border:-border, border:-border]
        peak = blurred[k].max()
        if peak > 0: blurred[k] *= origin / peak
    np.clip(blurred, 1e-3, 50., blurred)
    np.log(blurred, blurred)
    pad = np.pad(blurred, ((0, 0), (1, 1), (1, 1)), mode='edge').flatten()
    index = (keypoints[:, 0] + 1 + (keypoints[:, 1] + 1) * (W + 2) + (W + 2) * (H + 2) * np.arange(K)).astype(int).reshape(-1, 1)
    i_, ix1, iy1, ix1y1 = pad[index], pad[index + 1], pad[index + W + 2], pad[index + W + 3]
    ix1_y1_, ix1_, iy1_ = pad[index - W - 3], pad[index - 1], pad[index - 2 - W]
    derivative = np.concatenate([0.5 * (ix1 - ix1_), 0.5 * (iy1 - iy1_)], axis=1).reshape(K, 2, 1)
    dxx = ix1 - 2 * i_ + ix1_; dyy = iy1 - 2 * i_ + iy1_
    dxy = 0.5 * (ix1y1 - ix1 - iy1 + i_ + i_ - ix1_ - iy1_ + ix1_y1_)
    hessian = np.linalg.inv(np.concatenate([dxx, dxy, dxy, dyy], axis=1).reshape(K, 2, 2) + np.finfo(np.float32).eps * np.eye(2))
    keypoints -= np.einsum('imn,ink->imk', hessian, derivative).squeeze(-1)
    keypoints = keypoints / [W - 1, H - 1] * np.array(INPUT_SIZE, dtype=np.float32)
    keypoints[~valid] = -1; scores[~valid] = 0
    return keypoints, scores

def draw_openpose(keypoints, scores, width, height):
    """OpenPose-18 body map, drawn by controlnet_aux at the classic detector's resolutions
    (detect 512 -> image 1024), so both preprocessors feed the OpenPose ControlNet the same style."""
    import cv2, numpy as np
    from PIL import Image
    from controlnet_aux.open_pose import PoseResult, draw_poses
    from controlnet_aux.open_pose.body import BodyResult, Keypoint
    def resolution(r):  # controlnet_aux.util.resize_image geometry
        k = r / min(width, height)
        return int(np.round(height * k / 64.0)) * 64, int(np.round(width * k / 64.0)) * 64
    ok = scores >= SCORE_THRESHOLD
    def point(i):
        if i is None:
            if not (ok[5] and ok[6]): return None
            x, y = (keypoints[5] + keypoints[6]) / 2
        elif ok[i]: x, y = keypoints[i]
        else: return None
        return Keypoint(float(x) / width, float(y) / height)
    body = [point(i) for i in OPENPOSE_FROM_COCO]
    canvas = draw_poses([PoseResult(BodyResult(body, float(scores[ok].sum()), int(ok.sum())), None, None, None)], *resolution(512), draw_body=True, draw_hand=False, draw_face=False)
    h, w = resolution(1024)
    return Image.fromarray(cv2.resize(canvas, (w, h), interpolation=cv2.INTER_LINEAR)).convert('RGB')

def infer(models, image, device, dtype):
    """image: PIL RGB -> (heatmaps (17, 256, 192) float32 numpy, letterbox scale, offset)."""
    import numpy as np, torch
    unet, vae, head = models
    framed, scale, offset = letterbox(image)
    with framed:
        pixels = torch.from_numpy(np.asarray(framed, dtype=np.float32) / 127.5 - 1).permute(2, 0, 1)[None].to(device)
    feats = []
    handle = unet.up_blocks[-1].register_forward_hook(lambda _m, _i, out: feats.append(out))
    try:
        with torch.inference_mode():
            latent = vae.encode(pixels).latent_dist.mode() * LATENT_SCALE  # deterministic: posterior mean
            task = torch.tensor([[1., 0.]])
            task = torch.cat([torch.sin(task), torch.cos(task)], dim=-1).to(device=device, dtype=dtype)
            embed = load_embedding().to(device=device, dtype=dtype)
            # Only the decoder features of the last up block are used (x0-prediction, single step).
            unet(latent.to(dtype), TIMESTEP, encoder_hidden_states=embed, class_labels=task, return_dict=False)
            return head(feats[-1]).float()[0].cpu().numpy(), scale, offset
    finally:
        handle.remove()
        feats.clear()

def release():
    gc.collect()
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.synchronize()
            torch.cuda.empty_cache()
    except Exception:
        pass

def _failure(exc, loading):
    if isinstance(exc, SDPoseError):return exc
    if isinstance(exc, MemoryError):return SDPoseError('Недостаточно системной RAM для SDPose-OOD. Выберите OpenPose Classic или перезапустите Colab.')
    if 'out of memory' in str(exc).lower():return SDPoseError('Недостаточно VRAM для SDPose-OOD. Выберите OpenPose Classic или перезапустите движок.')
    if loading:return SDPoseError(f'Не удалось загрузить веса SDPose-OOD ({REPO}). Проверьте доступ к Hugging Face в Colab или выберите OpenPose Classic ({type(exc).__name__}).')
    return SDPoseError(f'Ошибка SDPose-OOD ({type(exc).__name__}). Выберите OpenPose Classic или другое изображение.')

def detect(image):
    """Full preprocessing step: load -> infer -> unload -> decode/draw on CPU. Returns the OpenPose-style map (PIL RGB)."""
    import numpy as np, torch
    device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
    dtype = torch.float16 if device.type == 'cuda' else torch.float32  # CPU fp16 is unsupported/slow
    models = failure = None
    loading = True
    release()  # leftovers of the previous step (the SDXL pipeline itself is CPU-offloaded here)
    try:
        models = load_models(device, dtype)
        loading = False
        heatmaps, scale, offset = infer(models, image, device, dtype)
    except Exception as exc:
        failure = exc
        # The traceback (kept by the executor future) must not pin weights through finished frames.
        traceback.clear_frames(exc.__traceback__)
    finally:
        models = None
        release()
    if failure is not None:raise _failure(failure, loading) from failure
    if not np.isfinite(heatmaps).all():raise SDPoseError('SDPose-OOD вернул некорректный результат (NaN). Выберите OpenPose Classic или другое изображение.')
    keypoints, scores = decode_heatmaps(heatmaps)
    valid = scores > 0
    keypoints[valid] = (keypoints[valid] - np.array(offset, dtype=np.float32)) / scale
    if int((scores >= SCORE_THRESHOLD).sum()) < MIN_KEYPOINTS:
        raise SDPoseError('SDPose-OOD не обнаружил позу. Используйте другое изображение, OpenPose Classic или готовую OpenPose-карту.')
    return draw_openpose(keypoints, scores, image.width, image.height)
