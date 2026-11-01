# Models and LoRA

No models are bundled. You connect **your own** files through Google Drive.

- **Checkpoint** — the main model (several GB). YOISAKI ENGINE supports **SDXL**, including **Illustrious XL**.
- **LoRA** — a small add-on that teaches a character, style or detail; applied with a weight. Must be trained for
  SDXL/Illustrious.
- **VAE** — optional image decoder; the checkpoint's built-in VAE is normally used.

## Supported formats (engine 1.8.1 code)

| Kind | Format | Compatibility check |
|---|---|---|
| Checkpoint | `.safetensors` file or diffusers folder with `model_index.json` | SDXL keys required (`conditioner.embedders.1.*`, `model.diffusion_model.*`) or `StableDiffusionXLPipeline`; otherwise marked incompatible |
| LoRA | `.safetensors` | SD1/SD2/Flux/SD3 metadata → incompatible; SDXL markers → compatible; otherwise "unknown" (selectable) |
| VAE | `.safetensors` | structure check only |
| ControlNet | `.safetensors` in `models/controlnet` | optional; standard OpenPose/Depth/Canny are fetched from Hugging Face on first use |

`.ckpt`, `.pt`, `.bin` are not detected. SD 1.5, SD 2, Flux and SD3 models are not supported.

## Folder layout

```text
MyDrive/YOISAKI_AI_STUDIO/models/
├── checkpoints/
├── loras/
├── vae/          (optional)
└── controlnet/   (optional)
```

Subfolders are scanned recursively. An optional sidecar JSON with the same name (e.g. `my_lora.json`) may contain
`"trigger_words"` (or Civitai-style `"trainedWords"`); it is read-only.

## Refresh, select, apply

1. Upload files to Drive → Colab panel "🔄 ОБНОВИТЬ МОДЕЛИ" → site **Models → GPU models → Refresh models**.
2. **Generate** page → **Model** tile → pick a model marked compatible.
3. **LoRA** tile → up to **8 LoRA**, weight **0–2** in steps of 0.05 (start with 0.6–1.0), enable toggle,
   **Tags** → insert into prompt / copy all. Include trigger words in your prompt.

## Check availability

Colab panel shows the model catalogue and counts; the site GPU page shows the model count; Models → GPU models
lists files with size and compatibility. Empty list → check Drive is mounted, the exact path, the `.safetensors`
extension, then refresh.

## Rights

Do not add third-party or personal checkpoints/LoRA or Drive files to this repository. Only use models whose
licenses allow your use, and do not redistribute models without permission.
