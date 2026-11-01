# YOISAKI AI STUDIO v1.7.2 — установка и обновление в Android / Termux

Студия: **1.7.2 GOOGLE DRIVE AUTO SYNC EDITION**. Движок и API: **1.7.0**. Это разные версии, и это нормально: протокол движка не менялся. Синхронизация Google Drive добавлена отдельными маршрутами CloudCompute-пакета 1.7.2.

Компьютер не нужен: все команды выполняются в Termux на телефоне.

## Что сохраняется при обновлении с 1.7.1

Всё пользовательское хранится **вне папки кода**, в `~/.local/share/yoisaki-ai-studio` (или в вашем `YOISAKI_DATA_DIR`):

- галерея — файлы `images/` и записи в `state.json`;
- избранное, промпты, история генераций;
- пресеты и настройки генерации (`settings`);
- теги LoRA и последний каталог моделей;
- адреса провайдеров GPU (Colab и CloudCompute).

`update.sh` эту папку не изменяет. Перед заменой кода он делает **две резервные копии**:

- кода: `<папка_приложения>.backup-ДАТА`;
- данных: `<папка_данных>.backup-ДАТА` рядом с папкой данных.

Схема `state.json` в 1.7.2 не менялась: version 1, без новых полей.

Модели GPU-движка в Termux не хранятся. Они лежат на GPU-сервере или на Google Drive, и обновление телефона их не затрагивает.

## 1. Подготовка

Дождитесь завершения генераций. Скачайте `YOISAKI_AI_STUDIO_V1.7.2_GOOGLE_DRIVE_AUTO_SYNC.zip` в «Загрузки».

📱 TERMUX
```bash
termux-setup-storage
pkg install -y nodejs-lts unzip
node --version          # нужен 22–26
APP_DIR="$HOME/YOISAKI_AI_STUDIO_V1.4.0_LOCAL_EDITION"
ARCHIVE="$HOME/storage/downloads/YOISAKI_AI_STUDIO_V1.7.2_GOOGLE_DRIVE_AUTO_SYNC.zip"
cd "$APP_DIR" && bash stop.sh
```

- Если вы переименовывали папку, измените только `APP_DIR`.
- Историческое имя `…V1.4.0_LOCAL_EDITION` сохранено для совместимости `update.sh`.

## 2. Дополнительная ручная копия (рекомендуется)

📱 TERMUX
```bash
DATA_DIR="${YOISAKI_DATA_DIR:-$HOME/.local/share/yoisaki-ai-studio}"
BACKUP_DIR="$HOME/yoisaki-backup-$(date +%Y%m%d-%H%M%S)"
mkdir -m 700 "$BACKUP_DIR"
cp -a "$APP_DIR" "$BACKUP_DIR/app"
[ -d "$DATA_DIR" ] && cp -a "$DATA_DIR" "$BACKUP_DIR/data"
echo "Резервная копия: $BACKUP_DIR"
```

Бэкап содержит ваши изображения и промпты: не публикуйте его.

## 3. Обновление (новый updater из нового архива)

📱 TERMUX
```bash
PREP_DIR=$(mktemp -d "$HOME/yoisaki-1.7.2.XXXXXX")
unzip -q "$ARCHIVE" -d "$PREP_DIR"
bash "$PREP_DIR/YOISAKI_AI_STUDIO_V1.4.0_LOCAL_EDITION/update.sh" "$ARCHIVE" "$APP_DIR"
```

Updater выполняет по порядку:

1. Проверяет архив: нет абсолютных путей, `..` и симлинков.
2. Проверяет целостность файлов (`verify-package.mjs`, SHA-256 всех файлов).
3. Проверяет готовую production-сборку `dist/` (`build-identity`). Это делается **до** остановки сервера.
4. Останавливает сервер и копирует код и данные.
5. Заменяет папку приложения и запускает новую версию.

Если запуск не удался, прежний код возвращается автоматически, а данные не удаляются.

ZIP уже содержит проверенную сборку. `npm ci` и `npm run build` запускаются, только если сборка не совпадает с исходниками; тогда нужен интернет.

## 4. Первая установка (если приложения ещё нет)

📱 TERMUX
```bash
cd ~ && unzip -q "$HOME/storage/downloads/YOISAKI_AI_STUDIO_V1.7.2_GOOGLE_DRIVE_AUTO_SYNC.zip"
cd ~/YOISAKI_AI_STUDIO_V1.4.0_LOCAL_EDITION
bash install.sh
bash start.sh
```

Папка должна лежать в домашнем каталоге Termux, а не в `/sdcard`.

## 5. Проверка версии

1. Откройте `http://127.0.0.1:3000/engine`.
2. **Настройки** — внизу должно быть `AMBER CORE · v1.7.2 GOOGLE DRIVE AUTO SYNC EDITION` (то же в боковой панели на планшете).
3. На странице GPU: «Версия студии: 1.7.2». Версия движка после подключения: 1.7.0.
4. Через API:

📱 TERMUX
```bash
curl -s -c "$TMPDIR/c" -H 'X-Yoisaki-Local: 1' http://127.0.0.1:3000/api/session
curl -s -b "$TMPDIR/c" -H 'X-Yoisaki-Local: 1' http://127.0.0.1:3000/api/version
```

Ожидается: `"studio_version":"1.7.2","edition":"GOOGLE DRIVE AUTO SYNC EDITION"`.

5. `bash diagnostics.sh` — показывает версию установленного и запущенного сервера и проверку сборки.

## 6. Где новая функция

**Модели → GOOGLE DRIVE AUTO SYNC.**

- Раздел виден только при выбранном провайдере **CloudCompute**. Для Colab всё работает как раньше.
- Ему нужен GPU-сервер с пакетом CloudCompute **1.7.2**: `YOISAKI_V1.7.2_CLOUDCOMPUTE_SETUP.md`.
- Сервер 1.7.1 ответит «На этом GPU-сервере нет Google Drive Auto Sync»; генерация при этом продолжает работать.
- Подключение Drive (`rclone authorize` в Termux): `YOISAKI_V1.7.2_GOOGLE_DRIVE_SETUP.md`.

## 7. Ручная пересборка (если нужно)

Проект — React + esbuild + Node.js (не Next.js runtime). `next build` не применяется.

📱 TERMUX
```bash
cd "$APP_DIR" && bash stop.sh
npm ci --no-audit --no-fund
npm run typecheck && npm run build && node scripts/build-identity.mjs
bash start.sh
```

## 8. Откат на 1.7.1

📱 TERMUX
```bash
cd "$APP_DIR" && bash stop.sh
OLD_CODE="/полный/путь/к/папке.backup-ДАТА"      # напечатан updater'ом
mv "$APP_DIR" "${APP_DIR}.saved-1.7.2-$(date +%Y%m%d-%H%M%S)"
cp -a "$OLD_CODE" "$APP_DIR"
cd "$APP_DIR" && bash start.sh
```

Откат данных не нужен: формат `state.json` тот же.

## Что проверено

На Linux (x86_64, Node.js 22) воспроизведено обновление настоящего архива v1.7.1 до 1.7.2 через `update.sh`:

- галерея, избранное, история, пресеты, настройки, модели и теги сохранены побайтно;
- резервные копии кода и данных созданы;
- откат работает.

На физическом Android/Termux это не проверялось. Результаты — `YOISAKI_V1.7.2_TEST_RESULTS.md`.
