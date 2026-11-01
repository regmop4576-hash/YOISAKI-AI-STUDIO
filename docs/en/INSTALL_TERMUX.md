# Installing YOISAKI AI STUDIO on Android with Termux

Installation is **one command** — no manual ZIP download, no storage permission, no unzipping. The official
installer is [`install-termux.sh`](../../install-termux.sh).

> **What was verified.** The installer passed 35 automated checks in a clean simulated Termux (own `HOME` and
> `PREFIX`, no Node.js/curl/unzip beforehand, stub `pkg`, local mock of the GitHub Releases API): install,
> re-run, update, resumed download, rollback, checksum mismatch, repair of a damaged install. **It has not been
> run in real Termux on a physical phone.** Script messages are in Russian.

## 1. Install Termux

From **F-Droid** (<https://f-droid.org/packages/com.termux/>) or **GitHub Releases**
(<https://github.com/termux/termux-app/releases>, `apt-android-7` build). The Google Play build is experimental.
Android 7+ is required. Do not mix sources.

## 2. Paste one command

```bash
pkg install -y curl && curl -fsSL https://raw.githubusercontent.com/regmop4576-hash/YOISAKI-AI-STUDIO/main/install-termux.sh | bash
```

What happens:

1. Missing dependencies are installed with `pkg` (`nodejs-lts` 22–26, `unzip`, `curl`); config-file questions are
   answered automatically (your current files are kept).
2. The latest **stable** GitHub Release is read (drafts and pre-releases are ignored).
3. The ZIP is downloaded into `~/.cache/yoisaki-ai-studio`; interrupted downloads resume, also on the next run.
4. SHA-256 is checked against the release's `SHA256SUMS.txt` (and GitHub's own asset digest when present). On
   mismatch the file is deleted and nothing is installed.
5. The archive is checked for absolute paths, `../`, symlinks and unexpected folders.
6. It is unpacked into a staging folder and the project's own `install.sh` runs, including the per-file SHA-256
   check of all 553 files (`scripts/verify-package.mjs`). The check is never skipped.
7. The folder is moved to `~/YOISAKI_AI_STUDIO_V1.4.0_LOCAL_EDITION` (historical name required by `update.sh`).
8. The `yoisaki` command is created, the site is started and checked.

At the end: `Готово! Откройте в браузере телефона:  http://127.0.0.1:3000` — open **http://127.0.0.1:3000**.

## 3. Commands

| Command | Action |
|---|---|
| `yoisaki start` | start the site (after a phone reboot, just open Termux and run it) |
| `yoisaki stop` | stop; data is kept |
| `yoisaki restart` | restart |
| `yoisaki status` | diagnostics |
| `yoisaki update` | update to the latest release |
| `yoisaki open` | open the site in the browser |
| `yoisaki version` | installed version |

## 4. Updating

`yoisaki update` (or the install command again). If the latest version is installed nothing is downloaded. A new
release is downloaded once (verified cached copies are reused) and installed by the **new release's** `update.sh`:
the new copy is verified while the old one runs, code and data are backed up, and if the new version fails to
start the previous one is restored and started again. Older releases are never installed over newer ones unless
`--force` is given. Settings live in `~/.local/share/yoisaki-ai-studio` (untouched by the installer); the gallery
lives in the browser for `http://127.0.0.1:3000`.

## 5. Safe re-runs

Concurrent runs are refused (stale locks are cleared), damaged installs are moved to `…LOCAL_EDITION.broken-DATE`
and reinstalled without touching data, partial downloads are never installed. Options:
`… | bash -s -- --no-start` or `--force`.

## 6. If it fails

| Message | Fix |
|---|---|
| `curl: (6)` / `(7)` | No internet or GitHub unreachable; retry. |
| `pkg update не удался` | `termux-change-repo`, then retry. |
| `CANNOT LINK EXECUTABLE` | `pkg upgrade -y`, then retry. |
| `Последний релиз нельзя установить … нет нужных файлов` | The latest release lacks `YOISAKI_AI_STUDIO_V…zip` and `SHA256SUMS.txt` — see [RELEASING.md](../RELEASING.md). |
| `SHA-256 архива не совпадает` | Corrupted or tampered download; retry, report if it persists. |

A manual fallback (download the release ZIP, `unzip`, `bash install.sh`) is described in the Russian guide.
