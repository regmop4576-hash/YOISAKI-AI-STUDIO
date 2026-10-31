#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR=$(cd -- "$(dirname -- "$0")" && pwd -P)
APP_DIR=$(cd -- "${2:-$SCRIPT_DIR}" && pwd -P)
if [[ $# -lt 1 || $# -gt 2 ]]; then echo 'Обновление: bash update.sh /путь/к/новому_архиву.zip [папка_установленного_приложения]'; exit 1; fi
[[ -f "$APP_DIR/server/index.mjs" && -f "$APP_DIR/stop.sh" ]] || { echo 'Укажите существующую папку приложения.'; exit 1; }
ARCHIVE=$(realpath -- "$1")
DATA_DIR=$(realpath -m -- "${YOISAKI_DATA_DIR:-$HOME/.local/share/yoisaki-ai-studio}")
case "$DATA_DIR/" in "$APP_DIR/"*) echo 'YOISAKI_DATA_DIR внутри приложения. Сначала скопируйте данные вне приложения и задайте новый YOISAKI_DATA_DIR.'; exit 1;; esac
if ! command -v unzip >/dev/null; then
 if command -v pkg >/dev/null; then pkg install -y unzip; else echo 'Нужна программа unzip.'; exit 1; fi
fi
STAGE=$(mktemp -d "$(dirname "$APP_DIR")/.yoisaki-update.XXXXXX")
trap 'rm -rf -- "$STAGE"' EXIT
while IFS= read -r entry; do
 case "$entry" in /*|*../*|*\\*) echo 'Небезопасный путь в архиве.'; exit 1;; esac
done < <(unzip -Z1 "$ARCHIVE")
if unzip -Z -l "$ARCHIVE" | awk '$1 ~ /^l/ {found=1} END {exit !found}'; then echo 'Символические ссылки в архиве запрещены.'; exit 1; fi
unzip -q "$ARCHIVE" -d "$STAGE"
NEW_DIR="$STAGE/YOISAKI_AI_STUDIO_V1.4.0_LOCAL_EDITION"
if [[ ! -f "$NEW_DIR/server/index.mjs" ]]; then echo 'В архиве не найдена локальная редакция приложения.'; exit 1; fi
if find "$NEW_DIR" -type l | read -r _; then echo 'Символические ссылки запрещены.'; exit 1; fi
# Keep a locally configured public Desktop OAuth client when the new package has no publisher client.
if [[ -f "$APP_DIR/config/google-desktop-client.json" && ! -e "$NEW_DIR/config/google-desktop-client.json" ]]; then
  mkdir -p "$NEW_DIR/config"
  cp -- "$APP_DIR/config/google-desktop-client.json" "$NEW_DIR/config/google-desktop-client.json"
fi
# Validate and prepare the new build before interrupting the running application.
(cd "$NEW_DIR" && node scripts/verify-package.mjs && bash install.sh && node scripts/build-identity.mjs)
bash "$APP_DIR/stop.sh"
STAMP=$(date +%Y%m%d-%H%M%S)-$$
BACKUP="${APP_DIR}.backup-$STAMP"
DATA_BACKUP="${DATA_DIR}.backup-$STAMP"
if [[ -d "$DATA_DIR" ]]; then cp -a -- "$DATA_DIR" "$DATA_BACKUP"; fi
mv -- "$APP_DIR" "$BACKUP"
if ! mv -- "$NEW_DIR" "$APP_DIR"; then mv -- "$BACKUP" "$APP_DIR"; echo 'Не удалось установить; предыдущая версия восстановлена.'; exit 1; fi
if ! (cd "$APP_DIR" && bash start.sh); then
 mv -- "$APP_DIR" "${APP_DIR}.failed-$STAMP"
 mv -- "$BACKUP" "$APP_DIR"
 echo 'Запуск не удался. Код предыдущей версии восстановлен, данные не удалялись. Запустите bash start.sh.'
 exit 1
fi
echo "Обновлено. Резервная копия кода: $BACKUP"
echo "Резервная копия данных (если существовали): $DATA_BACKUP"
echo 'Откройте http://127.0.0.1:3000/engine и проверьте версию сайта (для этого релиза: 1.9.0 PIXEL FANTASY).'
