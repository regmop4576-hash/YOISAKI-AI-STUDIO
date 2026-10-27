#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
case "$(pwd -P)" in /sdcard/*|/storage/*) echo 'Переместите папку приложения в домашнюю папку Termux (~). Android запрещает запуск из общей памяти.'; exit 1;; esac
if [[ "${PREFIX:-}" == *com.termux* ]]; then
  echo 'Обнаружен Android Termux.'
  if ! command -v node >/dev/null 2>&1; then pkg update -y; pkg install -y nodejs-lts; fi
elif ! command -v node >/dev/null 2>&1; then
  echo 'Установите Node.js 22 или 24 LTS. В Termux: pkg install nodejs-lts'; exit 1
fi
node -e 'const n=Number(process.versions.node.split(".")[0]);if(n<22||n>=27){console.error("Нужен Node.js 22–26; рекомендуется 24 LTS. В Termux: pkg upgrade nodejs-lts");process.exit(1)}'
node scripts/verify-package.mjs
if [[ "${PREFIX:-}" == *com.termux* ]]; then
  # Direct execution must use Android's interpreter path (also without termux-exec).
  for script in install.sh start.sh stop.sh update.sh diagnostics.sh; do
    sed -i "1c#!${PREFIX}/bin/bash" "$script"
  done
fi
chmod +x install.sh start.sh stop.sh update.sh diagnostics.sh
mkdir -p "${YOISAKI_DATA_DIR:-$HOME/.local/share/yoisaki-ai-studio}"
chmod 700 "${YOISAKI_DATA_DIR:-$HOME/.local/share/yoisaki-ai-studio}"
if ! node scripts/build-identity.mjs >/dev/null 2>&1; then
  npm ci --no-audit --no-fund
  npm run build
fi
echo 'Установлено. Локальная production-сборка готова.'
echo 'Запуск: ./start.sh'
