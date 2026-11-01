# Installing YOISAKI AI STUDIO on Android with Termux

For people who only have a phone. Long-press a code block → Copy, then long-press in Termux → Paste → Enter.

> **What was verified.** Commands come from the real `install.sh`, `start.sh`, `stop.sh`, `update.sh` of release
> 1.9.2. The full flow (unzip → `install.sh` → `start.sh` → `diagnostics.sh` → `update.sh` → `stop.sh`) was run on
> Linux with Node.js 22. **It was not run in real Termux on a physical phone for this release.** Script messages
> are in Russian; the expected output is quoted below with a translation.

## 1. Install Termux from an official source

- **F-Droid:** <https://f-droid.org/packages/com.termux/>
- **GitHub Releases:** <https://github.com/termux/termux-app/releases> — on Android 7+ pick the `apt-android-7`
  build for your architecture (usually `arm64-v8a`, or `universal` if unsure).

The Google Play build is experimental (missing features and bugs, per the Termux developers). Android 7 or newer
is required. Do not mix sources: builds are signed with different keys; uninstall Termux and all its plugins
before switching.

## 2. Prepare Termux

```bash
pkg update -y && pkg upgrade -y
pkg install -y nodejs-lts unzip
node -v
```

`node -v` must print **v22–v26** (24 LTS recommended); `install.sh` refuses other versions. Then grant storage
access (Android will ask — tap Allow) so that Downloads is available as `~/storage/downloads`:

```bash
termux-setup-storage
```

## 3. Download the ZIP

On <https://github.com/regmop4576-hash/YOISAKI-AI-STUDIO/releases/latest> tap
**`YOISAKI_AI_STUDIO_V1.9.2_PIXEL_FANTASY.zip`** under *Assets* (not "Source code"). Optional check:

```bash
sha256sum ~/storage/downloads/YOISAKI_AI_STUDIO_V1.9.2_PIXEL_FANTASY.zip
```

Compare with `SHA256SUMS.txt` in the same release.

## 4. Unzip

If you already have an installation, **skip to step 10 (update)** instead.

```bash
cd ~ && unzip -q ~/storage/downloads/YOISAKI_AI_STUDIO_V1.9.2_PIXEL_FANTASY.zip
```

This creates `~/YOISAKI_AI_STUDIO_V1.4.0_LOCAL_EDITION`. Keep it in the Termux home folder (Android forbids
running programs from shared storage) and **do not rename it** — `update.sh` expects this historical name.

## 5. Install

```bash
cd ~/YOISAKI_AI_STUDIO_V1.4.0_LOCAL_EDITION && bash install.sh
```

The script checks Node.js, verifies the SHA-256 of all 553 files against `package-manifest.json`, fixes the
script interpreter line for Termux, creates the data folder `~/.local/share/yoisaki-ai-studio`, and checks that
the bundled production build matches the sources (so no npm download is needed).

Expected output:

```text
Обнаружен Android Termux.                              (Android Termux detected)
Проверка целостности файлов: OK (553)                  (File integrity check: OK)
Установлено. Локальная production-сборка готова.       (Installed. Production build ready.)
Запуск: ./start.sh
```

If you see `Файлы приложения отсутствуют или повреждены…` (files missing or damaged), **do not disable the
check** — delete the folder, re-download the ZIP and repeat steps 3–5.

## 6. Start

```bash
./start.sh
```

Prints `YOISAKI AI STUDIO v1.9.2 PIXEL FANTASY` and `Откройте: http://127.0.0.1:3000`. Port taken? Use
`PORT=3001 ./start.sh`. Allow Termux to run in the background (battery: unrestricted) or run `termux-wake-lock`.

## 7. Open the site

Open **http://127.0.0.1:3000** in the phone browser. You will see the pixel YOISAKI header and "GPU отключён"
(GPU disconnected) — expected until you connect Colab. The GPU page shows the studio version 1.9.2.

## 8. Stop

```bash
cd ~/YOISAKI_AI_STUDIO_V1.4.0_LOCAL_EDITION && ./stop.sh
```

Prints `Приложение остановлено. Данные сохранены.` (stopped, data kept).

## 9. Start again after a reboot

```bash
cd ~/YOISAKI_AI_STUDIO_V1.4.0_LOCAL_EDITION && ./start.sh
```

`./diagnostics.sh` shows the version, Node.js, whether the server runs and from which folder, and a redacted log
tail.

## 10. Update

```bash
cd ~/YOISAKI_AI_STUDIO_V1.4.0_LOCAL_EDITION && bash update.sh ~/storage/downloads/YOISAKI_AI_STUDIO_V1.9.2_PIXEL_FANTASY.zip
```

`update.sh` validates the archive, prepares and verifies the new copy while the old one keeps running, stops the
old version, backs up code (`…LOCAL_EDITION.backup-DATE`) and data, swaps folders and starts the new version —
rolling back automatically if the start fails. Do not unzip a new version on top of an old one. After updating,
pull-to-refresh the browser page.
