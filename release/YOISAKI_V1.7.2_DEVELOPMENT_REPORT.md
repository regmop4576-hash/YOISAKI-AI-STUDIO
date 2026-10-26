# YOISAKI AI STUDIO v1.7.2 — GOOGLE DRIVE AUTO SYNC EDITION · отчёт о разработке

Дата: 26 октября 2026.
Исходник: `YOISAKI_AI_STUDIO_V1.7.1_CLOUDCOMPUTE_UI_FIXED.zip` — единственный источник истины, приложение не перестраивалось.

**Результат.** GPU-сервер CloudCompute сам находит и скачивает checkpoints, LoRA и VAE из приватной папки `Мой диск/YOISAKI_AI_STUDIO/models` пользователя:

- один раз, только чтение;
- с докачкой, проверкой и атомарной установкой;
- прямо в каталог, который уже читает движок.

Управление — на странице «Модели» студии в Termux. После синхронизации модели сразу доступны для генерации, без перезапуска и пересборки.

> **Не проверено на реальном оборудовании:** NVIDIA GPU CloudCompute, настоящий аккаунт Google Drive, физический Android. Всё остальное проверено настоящими инструментами (rclone, FastAPI, Docker, Chromium) на фикстурах. См. `YOISAKI_V1.7.2_TEST_RESULTS.md`.

## 1. Что найдено при изучении v1.7.1 и как это учтено

| Факт исходника | Решение |
|---|---|
| Сайт — React + esbuild + Node.js (`server/*.mjs`), не Next.js runtime | Новый UI — компонент в той же сборке. Новых npm-зависимостей нет |
| Каталог моделей движка: `$YOISAKI_DATA_ROOT/models/{checkpoints,loras,vae,controlnet}`; `worker.models.scan()` сканирует его **при каждом** `GET /models` | Синхронизация пишет **в этот же каталог**. Вторая папка `/workspace/yoisaki/models` не вводится. Обновление каталога = обычный `/models`: перезапуск не нужен |
| `engine/` и встроенный в блокнот Colab пакет должны совпадать байт в байт (тест) | `engine/` **не изменён**. Маршруты `/sync/*` добавляет отдельный entrypoint `cloudcompute/serve_cloud.py` поверх `create_app()`. Colab запускает прежний `worker/serve.py` |
| Протокол движка 1.7.0 проверяется студией (`validateHealth`) | Версия движка и API не повышалась. Студия 1.7.2, пакет CloudCompute 1.7.2 |
| Прокси студии пропускает к движку только перечисленные маршруты (`allowedRoute`) | Добавлены ровно 6 маршрутов `/sync/*` с фиксированными методами |
| В Docker `models` монтировался только для чтения | Режим монтирования задаётся (`YOISAKI_MODELS_MOUNT`, по умолчанию `ro`). `start-cloudcompute.sh` включает `rw` только при `YOISAKI_DRIVE_SYNC=1` |
| `fetch_models.validate()` проверяет safetensors тем же кодом, что каталог движка | Переиспользован без копирования |
| Движок держит загруженный pipeline по ID модели (хеш пути) | Обновлённая на Drive модель с тем же путём применяется после смены модели или перезапуска. Сервер ставит `restart_recommended`, UI предупреждает |

## 2. Архитектура

```
ANDROID · Termux
  YOISAKI AI STUDIO 1.7.2 (Node, 127.0.0.1:3000)
   ├─ Модели → <DriveSync/>  ──/api/gpu/drive/{status,check,sync,cancel,connect,disconnect}
   └─ server/app.mjs → server/drive-sync.mjs (проекция/валидация) → upstream.mjs (allowlist, DNS-pinning, TLS)
          │ HTTPS + Bearer (64 hex)
          ▼  Cloudflare quick tunnel (исходящий)
CLOUDCOMPUTE
  launcher.py ── YOISAKI_DRIVE_SYNC=1 ──► serve_cloud.py
                                         ├─ worker.direct_server.create_app()   (НЕИЗМЕНЁННЫЙ движок 1.7.0)
                                         └─ sync_api.add_routes() → drive_sync.SyncService (поток, flock)
                                                 └─ rclone lsjson / rclone cat  (только чтение, argv, без shell)
  drive-sync-cloudcompute.sh ──► drive_sync.py (CLI; та же блокировка; движок может быть остановлен)
  $YOISAKI_DATA_ROOT
   ├─ models/{checkpoints,loras,vae}  ← итоговые файлы (rename)
   ├─ models/.yoisaki-sync/*.part     ← загрузка/докачка, 0700, тот же mount → атомарный rename
   ├─ config/rclone/rclone.conf       ← OAuth-токен, 0600; config/ = 0711
   └─ runtime/sync/{status,manifest}.json, sync.lock (0600/0700)
```

### Алгоритм синхронизации (`drive_sync.py`)

1. **Список.** `rclone lsjson -R --files-only --hash --max-depth 4 remote:YOISAKI_AI_STUDIO/models`.
2. **Классификация** (`classify`):
   - учитываются только `checkpoints/`, `loras/`, `vae/`;
   - файлы вне этих папок игнорируются;
   - отклоняются:
     - pickle-форматы (`.ckpt .pt .pth .bin .pkl .pickle`);
     - любые форматы кроме `.safetensors`;
     - скрытые сегменты, `.`/`..`, `\`;
     - недопустимые символы и глубина больше 4;
     - отсутствующий или нечисловой размер;
     - размер вне окна типа: checkpoint 256 МБ–32 ГБ, LoRA 16 КБ–4 ГБ, VAE 1 МБ–2 ГБ.
3. **Сравнение** с манифестом (`runtime/sync/manifest.json`: размер, тип и значение хеша Drive, modtime, локальные `size`/`mtime_ns`):
   - `INSTALLED` — установлен этой синхронизацией, не изменён локально, на Drive тот же хеш (или размер+modtime без хеша);
   - `CHANGED` — установлен синхронизацией, на Drive новая версия → будет заменён;
   - чужой локальный файл с тем же размером и хешем → «усыновляется» без скачивания;
   - любой другой локальный файл → `CONFLICT`, **никогда не перезаписывается**;
   - `MISSING` — файла нет.
4. **Место на диске.** Нужно: сумма оставшихся байт + 2 ГБ резерва. Иначе `DISK_SPACE` до любой записи. Повторная проверка — перед каждым файлом.
5. **Загрузка.**
   - `rclone cat [--offset N]` → `.part`, сразу считается хеш.
   - Реальная скорость по скользящему окну 5 с, байты файла и общие.
   - До 3 попыток с продолжением с текущего байта.
   - `.part.json` фиксирует версию удалённого файла: чужой `.part` начинается заново.
   - Отмена: `terminate` процесса rclone, `.part` сохраняется.
6. **Проверка.**
   - Размер.
   - Хеш Drive: sha256 → sha1 → md5, что доступно.
   - `fetch_models.validate`: заголовок safetensors, границы данных, точный размер, совместимость SDXL для checkpoint.
   - Несовпадение → `.part` удаляется (это наш временный файл), статус FAILED.
7. **Установка.**
   - `fsync` → повторная проверка пути (`SyncConfig.target`: realpath внутри папки типа, симлинки не выводят наружу);
   - проверка, что целевой файл не изменён вручную во время загрузки;
   - `os.replace` → `fsync` каталога → запись манифеста → `inventory_revision += 1`.
8. **Конкуренция.**
   - Один поток на процесс плюс `fcntl.flock(runtime/sync/sync.lock)` между процессами (API движка и CLI).
   - Вторая операция → `BUSY` (409).
   - Статус процесса-владельца виден другим (`owner: other`).
9. **Восстановление.**
   - `status.json` переживает перезапуск.
   - Задание в состоянии RUNNING без живого владельца блокировки отображается как `INTERRUPTED`; `.part` продолжается при следующем запуске.

## 3. Новые файлы

| Файл | Назначение |
|---|---|
| `cloudcompute/drive_sync.py` | Сервис синхронизации и CLI (`status/check/sync/connect/disconnect`), только stdlib |
| `cloudcompute/sync_api.py` | FastAPI-маршруты `/sync/*` с Bearer-проверкой `hmac.compare_digest` |
| `cloudcompute/serve_cloud.py` | Entrypoint CloudCompute: `create_app()` + маршруты синхронизации. Отказ при несовпадении `YOISAKI_MODEL_ROOT` и папки синхронизации |
| `drive-sync-cloudcompute.sh` | Обёртка для сервера: режимы docker (exec или `tools`) и native. Токен вводится скрыто и передаётся через stdin |
| `server/drive-sync.mjs` | Карта действий → маршрутов, проекция и валидация статуса (белый список полей, скрытие токенов), проверка тела `connect` |
| `src/components/DriveSync.tsx` | Раздел GOOGLE DRIVE AUTO SYNC (RU/EN, `data-localized`) |
| `tests/test_v172_drive_sync.py` | 92 Python-теста: настоящий rclone, shim для обрыва, замедления и порчи данных, FastAPI, shell |
| `tests/v172-drive-sync.test.mjs` | 6 Node-тестов: allowlist, проекция, локальный API, маппинг ошибок upstream |
| `tests/drive-sync-browser.mjs` | Chromium: полный пользовательский сценарий на 360/390/430 px |
| `YOISAKI_V1.7.2_*.md` | Отчёт, инструкции, результаты тестов |

## 4. Изменённые файлы

| Файл | Изменение |
|---|---|
| `package.json`, `package-lock.json` | 1.7.2 |
| `server/release.mjs`, `src/lib/release.ts` | `STUDIO_EDITION = 'GOOGLE DRIVE AUTO SYNC EDITION'` → «AMBER CORE · v1.7.2 GOOGLE DRIVE AUTO SYNC EDITION» |
| `server/app.mjs` | Маршруты `/api/gpu/drive/*` (только CloudCompute, проверка метода). `/api/version` берёт edition из `release.mjs`. Диагностические события без опроса статуса |
| `server/upstream.mjs` | `allowedRoute` + `SYNC_ROUTES`. Ошибки `/sync/*`: 404 → `DRIVE_SYNC_UNAVAILABLE`, код движка → `DRIVE_<CODE>`, текст очищается от секретов |
| `src/app/models/page.tsx` | Вставлен `<DriveSync/>` над прежней библиотекой (библиотека не менялась) |
| `src/app/globals.css` | Стили `.syncbar` (native `<progress>`, в том числе неопределённый), `.synctable`, `code` в палитре AMBER CORE |
| `cloudcompute/launcher.py` | `YOISAKI_DRIVE_SYNC` → запуск через `serve_cloud.py`. Папка `runtime/sync` (0700). Подсказка про синхронизацию |
| `cloudcompute/lib.sh` | Образ `1.7.2`. Папки `runtime/sync`, `config/rclone`, `models/.yoisaki-sync` (0700), `config/` (0711). Выдача прав этим папкам и подпапкам моделей (файлы сохраняют владельца). Скрытие токенов Google в журналах |
| `cloudcompute/install-native.sh` | `install_rclone` (apt, только от root; иначе предупреждение, движок работает) |
| `cloudcompute/diagnose.py` | Раздел «Google Drive»: подключён ли, версия rclone, последняя операция. Токен не читается |
| `cloudcompute/yoisaki.env.example`, `cloudcompute/VERSION` | `YOISAKI_DRIVE_*`; 1.7.2 |
| `Dockerfile`, `.dockerignore` | Слой rclone **после** слоя PyTorch (кэш 7 ГБ сохраняется при обновлении); `drive-sync-cloudcompute.sh` |
| `docker-compose.yml` | Тег 1.7.2, `YOISAKI_DRIVE_*`, монтирование `models:${YOISAKI_MODELS_MOUNT:-ro}` |
| `start-cloudcompute.sh` | `YOISAKI_MODELS_MOUNT=rw` только при включённой синхронизации; `YOISAKI_DRIVE_AUTOSYNC` (синхронизация до запуска движка) |
| `update.sh` | Текст итоговой проверки версии |
| `README_RU.md`, `CHANGELOG_RU.md` (= `docs/CHANGELOG_RU.md`), `docs/TERMUX_UPDATE_RU.md`, `docs/CLOUDCOMPUTE_INSTALL_ANDROID_RU.md` | Описание 1.7.2 и ссылки |
| `tests/history.test.mjs`, `tests/providers*.mjs`, `tests/update-release.py`, `tests/test_v171_cloudcompute.py` | Ожидаемая версия 1.7.2. Политика монтирования `models`. Версия базовой установки в update-тесте берётся из её `package.json` |
| `dist/`, `package-manifest.json` | Пересобраны и пересчитаны |

**Не изменены (побайтно):**

- `engine/` (25 файлов);
- `colab/` (блокнот и встроенный пакет);
- генерация, Img2Img, LoRA, Regional, ControlNet, очередь, история, галерея, пресеты, редактор, страница GPU;
- `install.sh`, `start.sh`, `stop.sh`, `diagnostics.sh`;
- `fetch_models.py`, `stop-cloudcompute.sh`, `check-cloudcompute.sh`.

## 5. API

**Движок (только CloudCompute 1.7.2, все с Bearer):**

| Метод | Путь | Тело | Ответ |
|---|---|---|---|
| GET | `/sync/status` | — | статус (ниже) |
| POST | `/sync/check` | игнорируется | статус; фоновая проверка без загрузки |
| POST | `/sync/start` | игнорируется | статус; фоновая синхронизация |
| POST | `/sync/cancel` | — | статус |
| POST | `/sync/drive/connect` | `{token, client_id?, client_secret?}` (лишние поля → 422) | статус (без токена) |
| POST | `/sync/drive/disconnect` | — | статус |

Ошибки имеют вид `{"detail": "<сообщение>", "code": "BUSY|NOT_CONFIGURED|READ_ONLY|DISABLED|RCLONE_MISSING|INVALID_TOKEN|INVALID_CLIENT"}`.

Статус:

- `enabled`, `rclone_available`, `configured`;
- `connection{state,error,code}`, `source`, `scope`;
- `job{id,type,state,phase,current{path,kind,phase,bytes_done,bytes_total,speed_bps,resumed_from},overall{…},summary,error,error_code,cancel_requested,restart_recommended}`;
- `items[{path,name,kind,size,state,reason,verification}]`;
- `disk{free_bytes,total_bytes,reserve_bytes}`;
- `last_success_unix`, `last_check_unix`, `inventory_revision`, `verification`, `owner`.

ID файлов Drive, хеши, абсолютные пути и rclone.conf в ответ не попадают.

**Студия:**

- `GET /api/gpu/drive/status`;
- `POST /api/gpu/drive/{check,sync,cancel,connect,disconnect}`.

Условия:

- нужна существующая локальная сессия (cookie + `X-Yoisaki-Local`), подключённый провайдер `cloudcompute`, правильный метод;
- иначе ошибки `GPU_OFFLINE`, `DRIVE_CLOUDCOMPUTE_ONLY`, `METHOD_DENIED`;
- `/api/version.edition` = `GOOGLE DRIVE AUTO SYNC EDITION`.

**Без изменений:** `/health`, `/models`, `/generate`, `/jobs`, `/results`, `/controlnet/preprocess`. `engine_version` и `api_version` = 1.7.0.

## 6. Решения по безопасности

| Требование | Реализация |
|---|---|
| Аутентификация всех операций | `/sync/*`: зависимость `guard` (hmac) плюс прежний middleware движка для POST. Тест: 401 без токена и с чужим токеном на каждом маршруте. Студия: прежние сессия, Host/Origin/Fetch-Site |
| HTTPS | Прежний транспорт студии: HTTPS, DNS-pinning, запрет приватных IP и редиректов. Сервер слушает только 127.0.0.1 |
| Только чтение Drive | Токен с областью `drive.readonly`. В config `scope = drive.readonly`, `--drive-scope drive.readonly` в каждом вызове. `rclone_argv` разрешает только `lsjson`/`cat`, остальные 19 проверенных команд → `FORBIDDEN`. Единственный `subprocess.Popen` в модуле |
| Нет произвольных команд, путей и инъекций | Клиент не передаёт путей, remote или команд: тело `check`/`start` игнорируется (тест с `../../etc`, `evil:`, `delete`). Remote и путь задаются на сервере и валидируются регулярками. argv-списки, `shell=True` нет. Имена файлов Drive проверяются до использования |
| Path traversal | Проверка сегментов + `SyncConfig.target()` (realpath внутри папки типа). Симлинк-подпапка наружу → `UNSAFE_PATH` (тест) |
| Не выполнять модели | Pickle-форматы отклоняются. safetensors только разбирается: JSON-заголовок и арифметика границ. Файлы получают права 0644 |
| Не удалять модели | В коде удаляются только собственные `.part`/`.part.json` и (по `disconnect`) `rclone.conf` — тест разбирает исходник. `CONFLICT` не перезаписывается. Нет `rmtree`, `move`, «зеркала» |
| Секреты | Токен Google не попадает в: state.json студии, localStorage, ответы, `/api/diagnostics`, журналы (`sanitize`, `yoisaki_redact`), URL, argv, `docker logs` (проверено: 0). В CLI вводится скрыто через stdin. На сервере: 0600 в 0700, `config/` 0711, `yoisaki.env` движку недоступен (проверено под uid 1000) |
| Публичный каталог моделей | Нет: маршрутов к файлам моделей нет, отдаются только метаданные |
| Минимум метаданных Drive | Студия получает только путь внутри `models/`, имя, тип, размер, статус и причину |

**Осознанные компромиссы:**

1. **Docker.** При включённой синхронизации контейнер движка монтирует `models` на запись. Отдельный контейнер синхронизации увеличил бы сложность и потребовал бы проксирования между сетевыми пространствами. Изоляцию по процессу внутри одного контейнера обеспечить нельзя. Смягчение:
   - инференс по-прежнему не пишет в `models`;
   - запись выполняет только код синхронизации;
   - `YOISAKI_DRIVE_SYNC=0` возвращает `ro`.
2. **Ввод токена через сайт.** Любой, кто знает Bearer-токен движка, может заменить токен Drive. У него и так полный контроль над движком; новые файлы проходят те же проверки.
3. **Токен не шифруется.** Ключ пришлось бы хранить на том же диске.

## 7. Совместимость

- **Colab.**
  - Без изменений. Раздел синхронизации скрыт.
  - Сервер без `/sync/*` (Colab, CloudCompute 1.7.1) даёт понятное `DRIVE_SYNC_UNAVAILABLE`; генерация не затронута.
- **CloudCompute 1.7.1 → 1.7.2.**
  - Папка данных переиспользуется.
  - Образ Docker пересобирается, но слой PyTorch берётся из кэша.
  - Модели, загруженные `fetch-models` или вручную, «усыновляются» при совпадении с Drive или отмечаются как CONFLICT.
- **Termux 1.7.1 → 1.7.2.**
  - `update.sh`, данные вне кода, `state.json` version 1 без новых полей.
  - Откат без отката данных.
- **rclone.**
  - В образе и native — пакет Ubuntu 24.04 (1.60.1, проверка подписью apt). Скачать и закрепить новый релиз по SHA-256 в среде разработки было невозможно (GitHub и downloads.rclone.org недоступны), а непроверенный хеш мы не публикуем.
  - Drive в rclone 1.60 обычно отдаёт md5. Если rclone новее и Drive отдаёт sha1/sha256, используется более сильный хеш.
  - Формат токена `rclone authorize` в Termux совместим.
- **Python** 3.10–3.13 (stdlib), FastAPI 0.115.12 (пин движка). **Node.js** 22–26.

## 8. Известные ограничения

1. **Реальный GPU и реальный Google Drive не проверены:**
   - вход OAuth, скорость и квоты Drive;
   - поведение `cannotDownloadAbusiveFile` для очень больших файлов;
   - реальный Docker с NVIDIA.
2. **Перенос данных без платного GPU-инстанса** (только хранилище или CPU-инстанс с тем же диском) **не исследован на практике**: cloudcompute.ru недоступен из среды разработки. Мы не предполагаем, что такой вариант есть. Реализована синхронизация до запуска движка; оплата инстанса при этом идёт.
3. **Целостность.** MD5 на rclone 1.60 — контроль ошибок передачи, не защита от подмены файла на вашем Drive.
4. **Обновлённая модель**, загруженная в память GPU, применяется после смены модели или перезапуска движка.
5. **Папки Drive.** Синхронизируются только `checkpoints/`, `loras/`, `vae/`. ControlNet по-прежнему загружается из Hugging Face. Файлы из «Доступные мне» без ярлыка в «Мой диск» не видны.
6. **Удаление на Drive** не удаляет модель на сервере. Это сознательное решение; удалять вручную на сервере.
7. **Прогресс без числа.** Скорость и процент — по данным rclone и диска. На этапах «Чтение списка» и «Сравнение» прогресс неопределённый, и UI показывает это явно.
8. **Тест `tests/history-browser.mjs`** падает одинаково на исходной v1.7.1 и на 1.7.2: он ищет текст «YOISAKI ENGINE v1.7.0», которого страница GPU в v1.7.1 больше не выводит. Это не регрессия, тест не правился (вне объёма задачи).
