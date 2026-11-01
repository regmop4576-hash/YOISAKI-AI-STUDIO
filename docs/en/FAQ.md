# FAQ

**Is this a neural network?** No. It is an interface; YOISAKI ENGINE in your Colab generates images with your
models.

**Does it work offline?** The site itself runs locally (`127.0.0.1`). Generation needs internet (tunnel to Colab,
Colab reads your Drive).

**Is it free?** The site and engine are free. Colab Free GPU time and availability are limited and not guaranteed.

**Do I need a computer?** No.

**Why is the folder called `…V1.4.0_LOCAL_EDITION`?** Historical name expected by `update.sh`. Do not rename.
The real version is on the GPU page and in `./diagnostics.sh`.

**Why engine 1.8.1 with site 1.9.2?** Versions are independent; compatibility is defined by API 1.7.0. The
v1.9.2 notebook contains the verified 1.8.1 engine unchanged.

**Which models?** SDXL / Illustrious XL `.safetensors` (or SDXL diffusers folders), SDXL LoRA.

**Where are my images?** In the site gallery in the phone browser. The engine keeps a result in a temporary Colab
folder until the site confirms the gallery save; nothing is written to Drive automatically.

**Can I share the engine link?** No — it contains a secret token.

**How do I switch to English?** Settings → interface language.

**Where do I report bugs?** [Issues](https://github.com/regmop4576-hash/YOISAKI-AI-STUDIO/issues) (remove any
`#token=` links first). Vulnerabilities: [SECURITY.md](../../SECURITY.md).
