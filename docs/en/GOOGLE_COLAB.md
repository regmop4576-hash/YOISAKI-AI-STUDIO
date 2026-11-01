# Connecting Google Colab (YOISAKI ENGINE)

[![Open In Colab](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/github/regmop4576-hash/YOISAKI-AI-STUDIO/blob/main/colab/YOISAKI_ENGINE_V1.9.2_COLAB.ipynb)

Notebook: [`colab/YOISAKI_ENGINE_V1.9.2_COLAB.ipynb`](../../colab/YOISAKI_ENGINE_V1.9.2_COLAB.ipynb) (also attached
to the release). The notebook UI is in Russian; button names are given with translations.

## Versions

| Item | Version |
|---|---|
| Site | 1.9.2 PIXEL FANTASY |
| Engine inside the notebook | 1.8.1 SMART FACE FIX (code unchanged, package SHA-256 `fa9f5283…92d82`) |
| API protocol | 1.7.0 |

Site and engine versions do not have to match. The site accepts engines 1.7.0 / 1.7.6 / 1.8.0 / 1.8.1 with API
1.7.0 and the ControlNet, SDPose and Img2Img capabilities (`server/release.mjs`). Automatic Face Fix needs 1.8.1.
See [`YOISAKI_ENGINE_V1.9.2_COMPATIBILITY_REPORT.md`](../../YOISAKI_ENGINE_V1.9.2_COMPATIBILITY_REPORT.md).

## Colab Free limits

A GPU is not guaranteed; idle or long sessions may be disconnected; the link and token change after every
restart. Keep the Colab tab open. Real T4 runs with a full-size Illustrious model were not verified in the release
environment.

## Steps

1. **Open the notebook** with the button above and sign in to your Google account.
2. **Select a GPU:** Runtime → Change runtime type → **T4 GPU** → Save.
3. **Prepare:** run "🚀 1. ПОДГОТОВИТЬ ПАНЕЛЬ" (prepare panel). It verifies the embedded engine package (SHA-256),
   installs dependencies (a few minutes — do not rerun) and shows a control panel with
   "🚀 ЗАПУСТИТЬ ДВИЖОК" (start), "🛑 ОСТАНОВИТЬ" (stop), "🔄 ОБНОВИТЬ МОДЕЛИ" (refresh models),
   "📁 Подключить Drive" (mount Drive). If buttons do not render, use the "🛠 Резервное управление" fallback cell.
4. **Mount your Google Drive:** grant access only to this notebook and only to your own account.
5. **Place models** in `MyDrive/YOISAKI_AI_STUDIO/models/checkpoints`, `…/loras`, `…/vae` — see
   [MODELS_AND_LORA.md](MODELS_AND_LORA.md). The panel shows counts such as `Checkpoints: 1 · LoRA: 17 · VAE: 1`.
6. **Start the engine:** "🚀 ЗАПУСТИТЬ ДВИЖОК". The engine server and a Cloudflare tunnel start, then the panel
   checks the external connection.
7. **Copy the link** shown under "🔗 Подключение к AI STUDIO": `https://<random>.trycloudflare.com/#token=<secret>`,
   in full. 🔒 It contains a secret — never share it. If it leaks, stop and restart the engine to get a new token.
8. **Open the GPU page** of the site (http://127.0.0.1:3000 → GPU → **Google Colab**).
9. **Connect:** "Paste link from clipboard" (the token moves to a hidden field automatically), optionally
   "Remember on this phone (until the Colab session ends)", then **Connect**.
10. **Verify:** status "ПОДКЛЮЧЁН" (connected), GPU `Tesla T4`, VRAM, "Ready to generate", engine 1.8.1 · API
    1.7.0, studio 1.9.2 · COMPATIBLE, model count. Then Models → GPU models → **Refresh models**, choose a model
    on Generate and press **GENERATE**.
11. **End the session:** site → GPU → **Disconnect**; Colab panel → "🛑 ОСТАНОВИТЬ"; Colab → Runtime →
    Disconnect and delete runtime.

## Preserved T4 optimisations

CPU Offload, RAM FIX (glibc allocator tuning; `os.environ['YOISAKI_RAM_FIX']='0'` before starting the worker
disables it for A/B tests), a 4 GiB free-RAM guard between diagnostic jobs, and checkpoint reuse between jobs.
