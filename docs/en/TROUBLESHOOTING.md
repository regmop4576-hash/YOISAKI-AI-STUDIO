# Troubleshooting

Start with `cd ~/YOISAKI_AI_STUDIO_V1.4.0_LOCAL_EDITION && ./diagnostics.sh` — version, Node.js, server state, the
folder the running server comes from, build/source match and a redacted log tail. Messages are in Russian; the
Russian original is quoted so you can match it.

## Termux

| Message | Fix |
|---|---|
| `Файлы приложения отсутствуют или повреждены…` (files missing or damaged), `SHA-256 не совпадает` | Incomplete download or unzip over another version. Never disable the check: delete the folder, re-download, verify `SHA256SUMS.txt`, unzip into `~`. Use `update.sh` for existing installs. |
| `Переместите папку приложения в домашнюю папку Termux (~)` | App is in shared storage; unzip with `cd ~ && unzip -q …`. |
| `Нужен Node.js 22–26` | `pkg upgrade nodejs-lts`. |
| `unzip: command not found` | `pkg install -y unzip`. |
| `Production build does not match installed sources` | Run `bash install.sh` (rebuilds if needed; requires internet) or reinstall from the ZIP. |
| `Порт 3000 занят` (port busy) | `./stop.sh` the other copy or `PORT=3001 ./start.sh`. |
| `Сервер уже работает из …` (already running from …) | If it is another (old) folder, `./stop.sh` there, then `./start.sh` in the right one. |
| Old UI after update | Check "running server folder/version" in diagnostics; pull-to-refresh the page. |
| Site stops when Termux is in the background | Unrestricted battery for Termux or `termux-wake-lock`. |
| `В архиве не найдена локальная редакция приложения` | Wrong ZIP (e.g. "Source code"). Use the release asset ZIP. |

## Colab connection

| Site message | Fix |
|---|---|
| Invalid / rejected token | Copy the **new** full link with `#token=…`; old tokens die on engine restart. |
| Timeout / connection interrupted | Make sure the Colab tab and session are alive, then Connect again. |
| Tunnel works but engine does not answer | Engine is still starting or stopped — check the Colab panel. |
| CUDA/GPU unavailable | Select T4 GPU in Colab and rerun the notebook. |
| Engine version incompatible | You opened an old notebook; use `YOISAKI_ENGINE_V1.9.2_COLAB.ipynb`. |
| Private network / invalid URL / redirect | Not the panel link; paste `https://….trycloudflare.com/#token=…`. |
| Colab: `Файлы движка повреждены` | Re-open the notebook from the repository or release. |

## Models and generation

Empty model list → Drive mounted? exact path `MyDrive/YOISAKI_AI_STUDIO/models/...`? `.safetensors`? refresh in
Colab and on the site. "Model incompatible" → not SDXL. Out of memory → smaller size, batch 1, fewer LoRA,
ControlNet off. LoRA has no effect → add trigger words, check weight and base model.

## Data

The gallery lives in the phone browser (IndexedDB) — clearing site data deletes it. Settings live in
`~/.local/share/yoisaki-ai-studio`; `update.sh` backs them up before every update.
