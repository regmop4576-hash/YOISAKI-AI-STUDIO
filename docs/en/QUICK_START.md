# Quick start

1. **Site on the phone (once).** Termux from [F-Droid](https://f-droid.org/packages/com.termux/) or
   [GitHub](https://github.com/termux/termux-app/releases), then in Termux:

   ```bash
   pkg install -y curl && curl -fsSL https://raw.githubusercontent.com/regmop4576-hash/YOISAKI-AI-STUDIO/main/install-termux.sh | bash
   ```

   Open **http://127.0.0.1:3000**. Commands: `yoisaki start`, `yoisaki stop`, `yoisaki update`.
   Details: [INSTALL_TERMUX.md](INSTALL_TERMUX.md).

2. **Models on Google Drive (once):** `MyDrive/YOISAKI_AI_STUDIO/models/checkpoints/` (SDXL / Illustrious
   `.safetensors`) and optionally `…/loras/`. Details: [MODELS_AND_LORA.md](MODELS_AND_LORA.md).

3. **Engine in Colab (every session):**
   [open the notebook](https://colab.research.google.com/github/regmop4576-hash/YOISAKI-AI-STUDIO/blob/main/colab/YOISAKI_ENGINE_V1.9.2_COLAB.ipynb),
   select T4 GPU, run "🚀 1. ПОДГОТОВИТЬ ПАНЕЛЬ", allow Drive, press "🚀 ЗАПУСТИТЬ ДВИЖОК", copy the full link
   with `#token=…` (keep it secret). Details: [GOOGLE_COLAB.md](GOOGLE_COLAB.md).

4. **Connect and generate:** site → GPU → Google Colab → Paste link from clipboard → Connect; Models → GPU models →
   Refresh models; Generate → Model / LoRA → prompt → **GENERATE**. Results go to the Gallery.

5. **Finish:** site → Disconnect; Colab → "🛑 ОСТАНОВИТЬ" and delete the runtime; Termux → `yoisaki stop`.
