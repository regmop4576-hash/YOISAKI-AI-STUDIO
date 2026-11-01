"""v1.7.6 end-to-end harness: the REAL GPU-side sync stack without a GPU.

Runs the unchanged cloudcompute/drive_sync.py SyncService and cloudcompute/sync_api.py routes (plus the real
cloudcompute/inventory.py catalogue on engine/worker/models.py) in uvicorn on 127.0.0.1. Transfers are made by the
real rclone binary from a local folder exposed as the configured remote (rclone `alias` backend) through the same
logging shim as tests/test_v172_drive_sync.py (it can slow down, cut or corrupt a transfer).

SIMULATED parts, stated explicitly: Google Drive is a local folder (no Google account, no OAuth) and /health is a
static answer (no CUDA, no GPU, no inference). Usage: python3 -I tests/real_sync_gpu.py WORKDIR PORT TOKEN
Prints one JSON line {"ready": true, ...} when the server accepts requests.
"""
import json
import hashlib
import shutil
import struct
import sys
import textwrap
from pathlib import Path

APP = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(APP / 'cloudcompute'), str(APP / 'engine')]
import drive_sync  # noqa: E402
import launcher  # noqa: E402
import inventory  # noqa: E402
import sync_api  # noqa: E402
from fastapi import Depends, FastAPI, Header, HTTPException  # noqa: E402
import uvicorn  # noqa: E402

SHIM = textwrap.dedent('''\
    #!/usr/bin/env python3
    import json, os, subprocess, sys, time
    ctl = os.environ['SHIM_DIR']; args = sys.argv[1:]
    with open(os.path.join(ctl, 'log'), 'a') as f: f.write(json.dumps(args) + '\\n')
    def take(name):
        p = os.path.join(ctl, name)
        return open(p).read() if os.path.exists(p) else None
    command = args[2]
    corrupt = command == 'cat' and take('corrupt') is not None
    delay = float(take('delay') or 0) if command == 'cat' else 0
    p = subprocess.Popen([os.environ['SHIM_REAL'], *args], stdout=subprocess.PIPE)
    out = sys.stdout.buffer; sent = 0
    while chunk := p.stdout.read(65536):
        if corrupt and sent == 0: chunk = chunk[:-1] + bytes([chunk[-1] ^ 1])
        out.write(chunk); out.flush(); sent += len(chunk)
        if delay: time.sleep(delay)
    sys.exit(p.wait())
    ''')
KEYS = {'checkpoint': ['conditioner.embedders.1.w', 'model.diffusion_model.w'], 'lora': ['lora_te2_x.lora_up.weight', 'lora_unet_y.lora_down.weight'],
        'vae': ['decoder.conv_in.weight', 'encoder.conv_out.weight']}


def model(path, kind, payload):
    """Structurally valid safetensors of the engine kind (header + exact payload)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    keys = KEYS[kind]
    each = payload // len(keys)
    tensors = {k: {'dtype': 'U8', 'shape': [each], 'data_offsets': [i * each, (i + 1) * each]} for i, k in enumerate(keys)}
    head = json.dumps({'__metadata__': {'ss_base_model_version': 'sdxl_base_v1-0'} if kind == 'lora' else {}, **tensors}).encode()
    body = (hashlib.sha256(path.name.encode()).digest() * (each * len(keys) // 32 + 1))[:each * len(keys)]
    path.write_bytes(struct.pack('<Q', len(head)) + head + body)


def main(work, port, token):
    work = Path(work)
    data, drive, ctl = work / 'data', work / 'drive', work / 'shim'
    for d in (drive, ctl):
        d.mkdir(parents=True, exist_ok=True)
    rclone = shutil.which('rclone')
    shim = work / 'rclone-shim'
    shim.write_text(SHIM)
    shim.chmod(0o755)
    import os
    os.environ.update(SHIM_DIR=str(ctl), SHIM_REAL=rclone)
    drive_sync.LIMITS = {'checkpoint': (100_000, 10**9), 'lora': (10_000, 10**9), 'vae': (10_000, 10**9)}
    environ = {'YOISAKI_DATA_ROOT': str(data), 'YOISAKI_ENGINE_DIR': str(APP / 'engine'), 'YOISAKI_RCLONE': str(shim)}
    launcher.prepare(launcher.Config(environ))
    (data / 'config/rclone').mkdir(parents=True, exist_ok=True)
    # root_folder_id makes the sync read the selected folder exactly like a folder chosen on the phone.
    (data / 'config/rclone/rclone.conf').write_text(f'[yoisaki-gdrive]\ntype = alias\nremote = {drive}\nroot_folder_id = selected\n')
    model(drive / 'checkpoints/Illustrious_XL_v17.safetensors', 'checkpoint', 6 * 2**20)
    model(drive / 'loras/characters/Amber_Nova.safetensors', 'lora', 3 * 2**20)
    model(drive / 'loras/Vesper_Nova.safetensors', 'lora', 3 * 2**20)
    model(drive / 'vae/sdxl_vae.safetensors', 'vae', 2 * 2**20)
    cfg = drive_sync.SyncConfig(environ)
    app = FastAPI()

    def guard(authorization: str = Header(default='')):
        if authorization != 'Bearer ' + token:
            raise HTTPException(401, 'Invalid engine access token')
    app.add_api_route('/health', lambda: {'engine': 'YOISAKI_ENGINE', 'engine_version': '1.7.0', 'api_version': '1.7.0', 'state': 'READY',
                                          'capabilities': {'controlnet': True, 'sdpose': True, 'img2img': True, 'regional_control': True},
                                          'gpu_name': 'SIMULATED (no GPU in this test)', 'vram_total_mb': None, 'vram_available_mb': None},
                      methods=['GET'], dependencies=[Depends(guard)])
    inventory.add_routes(app, [Depends(guard)], cfg.models)
    sync_api.add_routes(app, token, drive_sync.SyncService(cfg))
    print(json.dumps({'ready': True, 'models': str(cfg.models), 'staging': str(cfg.staging), 'ctl': str(ctl), 'drive': str(drive)}), flush=True)
    uvicorn.run(app, host='127.0.0.1', port=int(port), log_level='warning', access_log=False)


if __name__ == '__main__':
    main(*sys.argv[1:4])
