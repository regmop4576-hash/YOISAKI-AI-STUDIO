# YOISAKI AI STUDIO v1.7.2 — результаты проверок

Дата: 26 октября 2026. Полные выводы — в `docs/verification/v172/`: пути песочницы заменены на `<scratch>`, токенов там нет. Журнал обновления содержит SHA-256 самого ZIP, поэтому лежит рядом с архивом, а не внутри: `update-integration.log`.

## Среда (`environment.log`)

Linux x86_64. **NVIDIA GPU нет** (`nvidia-smi: command not found`, `torch.cuda.is_available() = False`).

| Компонент | Версия |
|---|---|
| Node.js / npm | 22.22.0 / 10.9.4 |
| Python | 3.13.17 |
| torch | 2.10.0+cu128 (пины `requirements-cloud.txt`) |
| diffusers / fastapi | 0.36.0 / 0.115.12 (пины `engine/requirements.txt`), `pip check`: «No broken requirements found» |
| rclone | 1.60.1 (пакет Ubuntu 24.04, тот же, что ставится в образ) |
| Docker / Compose | 29.9.2 / v5.6.1 |
| Chromium | headless shell (Playwright 1.56.1) |
| shellcheck | 0.9.0 |

**Недоступно:** cloudcompute.ru (403 прокси), downloads.rclone.org и GitHub releases (403), аккаунт Google, физический Android.

## Сводка

| # | Проверка | Команда | Результат |
|---|---|---|---|
| 1 | TypeScript | `npm run typecheck` | **PASS** |
| 2 | Production-сборка | `npm run build && node scripts/build-identity.mjs` | **PASS**, `version 1.7.2` |
| 3 | Node-тесты (локальный сервер, прокси, провайдеры, история, ControlNet, Img2Img, HTTPS, **Drive sync**) | `npm test` | **52/52 PASS** (46 прежних + 6 новых) |
| 4 | Все Python-тесты на полном стеке движка (CPU) | `python -m pytest -rs tests/` | **242 passed, 0 skipped, 0 failed** |
| 5 | Из них новые Drive-sync тесты | `pytest tests/test_v172_drive_sync.py` | **92 passed** |
| 6 | Синтаксис | `bash -n` всех `.sh`, `py_compile`, `node --check` | **PASS** |
| 7 | shellcheck всех скриптов CloudCompute | `shellcheck -x …` | Новые и изменённые скрипты без замечаний. 1 замечание уровня *info* SC2015 в неизменённой строке 28 `start-cloudcompute.sh`: то же на исходной 1.7.1 с shellcheck 0.9.0 |
| 8 | Браузер: Drive sync | `node tests/drive-sync-browser.mjs` | **PASS** |
| 9 | Браузер: прежние сценарии | `ui-check`, `browser-e2e`, `providers-browser`, `controlnet-browser`, `img2img-browser`, `regional-compatibility-browser`, `memory-ui`, `mobile` (с `start.sh` на :3000) | **8/8 PASS** |
| 10 | Браузер: `history-browser.mjs` | то же | **FAIL — и на исходном архиве v1.7.1 без изменений** (`browser-history-baseline-v171.log`): тест ждёт текст «YOISAKI ENGINE v1.7.0», которого страница GPU не выводит с 1.7.1. Не регрессия, тест не правился |
| 11 | Docker-образ (валидационный) | `docker build -f Dockerfile.validate` | **PASS**: слой rclone (`rclone v1.60.1-DEV`), cloudflared SHA-256 OK |
| 12 | Docker runtime | `docker-e2e.sh` | **PASS** (ниже) |
| 13 | Права native (root → uid 1000) | `native-permissions.sh` | **PASS** (ниже) |
| 14 | Целостность пакета | `node scripts/verify-package.mjs` | **PASS** (278 файлов) |
| 15 | Обновление Termux v1.7.1 → v1.7.2 на настоящем архиве пользователя | `python3 tests/update-release.py <v1.7.1.zip> <v1.7.2.zip>` | **PASS** (ниже) |
| 16 | `docker compose config` | без и с `YOISAKI_MODELS_MOUNT=rw` | **PASS**: по умолчанию `read_only: true` для `/data/models`; с `rw` — запись; `ports` нет |

## Что именно проверено по требованиям задания

### Синхронизация (настоящий rclone 1.60.1)

Источник — временная папка как remote rclone (`alias`) в той же структуре `YOISAKI_AI_STUDIO/models`. Shim-обёртка логирует argv и может оборвать, замедлить или испортить поток.

| Требование | Тест | Итог |
|---|---|---|
| Обнаружение checkpoints / loras (с подпапками) / vae, игнор прочих папок | `test_discover_download_verify_install_and_engine_inventory` | PASS |
| Отказ: pickle (`.ckpt .pt .pth .bin .pickle`), не-safetensors, `..`, `.`, скрытые, `\`, `;`, `$(…)`, глубина, размер вне окна, нечисловой размер | `test_classify_*` (17 путей + границы размера) | PASS |
| Небезопасный remote или путь в конфигурации сервера | `test_server_config_rejects_unsafe_remote_and_path` (7) | PASS |
| Симлинк-подпапка не выводит запись наружу | `test_symlinked_subfolder_cannot_escape_models` | PASS |
| Загрузка недостающих, проверка хеша + safetensors, атомарная установка, staging пуст | `test_discover…` | PASS |
| Новые файлы сразу видит **неизменённый** `worker.models.scan` | `test_discover…`, `test_engine_sync_routes…` | PASS |
| Повторная синхронизация: 1 вызов `lsjson`, **0** вызовов `cat`, mtime не изменились | `test_repeated_sync_skips_unchanged_files_without_downloading` | PASS |
| Изменённый на Drive файл → `CHANGED` → замена через rename (новый inode), `restart_recommended` | `test_changed_drive_file_is_updated_atomically_and_flags_restart` | PASS |
| Ручной идентичный файл усыновлён без загрузки; отличающийся → `CONFLICT`, байты не тронуты | `test_existing_local_files_are_adopted_or_left_untouched` | PASS |
| Обрыв на 200 000 байт → повтор с `--offset 200000`, файл идентичен | `test_interrupted_transfer_is_retried_from_offset` | PASS |
| `.part` после перезапуска процесса → `--offset 250000` | `test_partial_download_survives_restart_and_resumes` | PASS |
| `.part` другой версии файла → загрузка с нуля | `test_stale_partial_from_other_version_restarts_from_zero` | PASS |
| Отмена: CANCELLED, `.part` сохранён, финального файла нет; следующая синхронизация продолжает с точного байта | `test_cancel_keeps_partial_and_next_sync_resumes` | PASS |
| Одновременные задания: BUSY в процессе и между процессами (flock); чужое задание не отменяется со страницы | `test_concurrent_jobs_are_rejected_in_process_and_across_processes` | PASS |
| Порча 1 бита → «контрольная сумма не совпала», файл и `.part` отброшены; повтор успешен | `test_checksum_mismatch_is_rejected` | PASS |
| HTML вместо модели и не-SDXL checkpoint не попадают в каталог | `test_invalid_or_incompatible_safetensors_never_enter_catalogue` | PASS |
| Нехватка места → `DISK_SPACE` **до** первого `cat` | `test_disk_space_is_checked_before_any_download` | PASS |
| Ошибки Google (`invalid_grant`, `directory not found`) классифицированы, refresh-токен из stderr не утекает | `test_remote_errors_are_reported_without_secrets`, `test_rclone_error_classification` (6) | PASS |
| Прерванное задание после перезапуска → INTERRUPTED | `test_interrupted_job_is_reported_after_restart` | PASS |
| Только чтение Drive: 19 записывающих или удаляющих команд rclone → `FORBIDDEN`; в коде один `Popen`, нет `shell=True` и `rmtree`; удаляются только свои `.part`/`.part.json` и `rclone.conf` | `test_only_read_only_rclone_commands_can_be_built`, `test_source_has_one_subprocess_path_without_shell` | PASS |
| Docker: models только для чтения → понятная ошибка `READ_ONLY`; запись нужна лишь в staging | `test_write_check_needs_staging_not_models_root` + Docker e2e | PASS (дефект найден в Docker, см. ниже) |

### Безопасность и токены

| Проверка | Итог |
|---|---|
| Все 6 маршрутов `/sync/*` без токена и с чужим токеном → 401; маршрутов с параметрами пути нет; тело `{path:'../../etc', remote:'evil:', command:'delete'}` игнорируется | PASS |
| `connect`: `rclone.conf` 0600 в 0700, `scope = drive.readonly`; токена нет в ответах, `status.json`, `manifest.json`, `diagnose.py --json` и тексте отчёта | PASS |
| Неверные токены (не JSON, лишние ключи, перевод строки для инъекции секции ini, bool, длина, пустой refresh) и неверная пара client_id/secret отклоняются, конфиг не создаётся | PASS (11) |
| Студия: Drive-маршруты только для CloudCompute (Colab → `DRIVE_CLOUDCOMPUTE_ONLY`, upstream не вызывается), офлайн → `GPU_OFFLINE`, неверный метод → `METHOD_DENIED` | PASS |
| Студия: OAuth-токен передан upstream ровно один раз и отсутствует в ответе, `/api/gpu/status`, `/api/diagnostics`, `/api/settings`, `/api/history`, `state.json` | PASS |
| Проекция статуса отбрасывает лишние поля (хеши, ID Drive, путь конфига) и скрывает `ya29.`, `1//`, 64-hex; неверные типы и состояния → `INVALID_RESPONSE` | PASS |
| Прокси: allowlist ровно 6 маршрутов; `?path=`, `/../`, DELETE, `/sync/purge` → отказ. Ошибки upstream: 404 → `DRIVE_SYNC_UNAVAILABLE`, 409 BUSY → `DRIVE_BUSY` (64-hex вырезан), 422 → `DRIVE_INVALID_TOKEN`, 401 → `AUTH_REJECTED` | PASS |
| `yoisaki_redact` скрывает токены Google в журналах; CLI `connect` читает токен скрыто из stdin, токена нет в выводе | PASS |
| Браузер: поле токена `type=password`; токен не в `state.json`, localStorage/sessionStorage и тексте страницы | PASS |
| Docker: 0 вхождений токена движка в `docker logs` | PASS |

### Docker runtime (`docker-e2e.log`)

Валидационный образ = боевой `Dockerfile`, в котором слой torch/diffusers заменён на fastapi/uvicorn/pydantic: в песочнице медленная сеть. Слой rclone, cloudflared, COPY, пользователь, `tini`, read-only rootfs, `cap_drop` и `no-new-privileges` — без изменений. Используется боевой `docker-compose.yml` с override: без резервирования GPU, entrypoint `serve_cloud.py` напрямую, потому что launcher без CUDA штатно не запускает сервер. Результаты:

1. `YOISAKI_MODELS_MOUNT=ro` → `{"code":"READ_ONLY"}` с понятной инструкцией. `uid=1000`; запись в `/opt` и `/data/models` — «Read-only file system».
2. `YOISAKI_MODELS_MOUNT=rw`:
   - без токена → 401;
   - `POST /sync/start` → COMPLETED, 3/3 файла, 318 767 656 байт;
   - `.ckpt` → REJECTED;
   - checkpoint побайтно совпадает с источником.
3. CLI через `docker exec` при работающем движке → «нечего скачивать».
4. CLI при остановленном движке через одноразовый `tools` → статус.
5. На хосте:
   - файлы принадлежат uid 1000, `rclone.conf`/`status.json`/`manifest.json` — 0600;
   - staging пуст;
   - токен в `docker logs` встречается 0 раз.

### Права native (`native-permissions.log`)

- root выполняет `yoisaki_prepare_dirs` и `yoisaki_grant 1000:1000`.
- Пользователь uid 1000 сохраняет токен (0600) и синхронизирует 3 файла (COMPLETED).
- uid 1000 **не может прочитать** `config/yoisaki.env` и **не может получить список** `config/` (режим 0711).

### Обновление Termux (`update-integration.log`, рядом с ZIP)

Настоящий архив пользователя `YOISAKI_AI_STUDIO_V1.7.1_CLOUDCOMPUTE_UI_FIXED.zip` запущен на :3000, затем обновлён новым `update.sh`:

- `PASS baseline old server 1.7.1`;
- `PASS update preserved gallery bytes, favorites, history, presets, settings, models, tags and custom content; code/data backups exist`: `state.json` сравнивается целиком, изображение — побайтно;
- `PASS stale source and stale build rejected`;
- `PASS manual rollback to old 1.7.1, user data unchanged`.

Это Linux-симуляция, не физический Android.

### Интерфейс (`drive-sync-browser.log`, скриншоты `drive-sync-*.png`)

Chromium, мобильная эмуляция 390×844 с касаниями. Синтетический движок отдаёт статусы в формате сервера.

1. При Colab раздела нет; при CloudCompute до подключения — подсказка.
2. После подключения:
   - «Не подключён»;
   - все 5 кнопок;
   - «Синхронизировать» и «Отменить загрузку» неактивны;
   - источник `YOISAKI_AI_STUDIO/models`, место «500 GB / 944 GB».
3. Форма токена (password) → токен передан один раз → таблица: 5 строк, «Нет на сервере», «Отклонена».
4. Синхронизация:
   - этап «Чтение списка» — `<progress>` без значения, то есть неопределённый прогресс;
   - затем реальные байты: значение 1–100, «MB/s», «0/4 файлов»;
   - «Отменить загрузку» активна.
5. Ширина 360, 390 и 430 px — горизонтальной прокрутки нет.
6. Завершение: 4× «Установлена». `inventory_revision` изменился → библиотека моделей **обновилась без перезагрузки**, Illustrious XL виден.
7. Английский интерфейс: все 5 кнопок на английском.
8. Ошибок JavaScript нет.

Дефект, найденный этим тестом и исправленный: кнопки «Проверить», «Синхронизировать» и «Отменить» без тела запроса отправляли GET.

## Дефекты, найденные проверками и исправленные до выпуска

1. **Права `config/`.** `config/` (0700, root) делал `config/rclone` недоступным для движка (uid 1000) → `config/` теперь 0711. Найдено при разборе модели прав, подтверждено `native-permissions.sh`.
2. **Проверка записи в Docker.** Проверка «только для чтения» требовала права записи в корень `models/`, который движку не принадлежит → проверяется staging. Найдено в реальном Docker, добавлен регрессионный тест.
3. **Метод запроса в UI.** UI отправлял GET вместо POST для действий без тела. Найдено браузерным тестом.
4. **Формат размера.** Формат «500.0 GB» исправлен на «500 GB». Косметика, найдено браузерным тестом.

## Что НЕ проверено (нужна приёмка на реальном оборудовании)

- **Реальный NVIDIA GPU CloudCompute** (RTX 5060 Ti sm_120 и другие):
  - preflight, генерация Text2Img и Img2Img, LoRA, ControlNet, Regional с настоящими весами;
  - RAM и VRAM.

  Python-тесты движка выполнены на CPU, CUDA имитировалась.
- **Настоящий Google Drive и OAuth:**
  - `rclone authorize` в Termux и вход в Google;
  - реальные квоты и скорость Drive, большие (≈7 ГБ) файлы, `cannotDownloadAbusiveFile`;
  - обновление access-токена rclone внутри контейнера.
- **Полный боевой Docker-образ с torch:** собран в v1.7.1. В 1.7.2 добавлен слой rclone, он проверен в валидационном образе. NVIDIA runtime и Cloudflare-туннель в песочнице недоступны.
- **Особенности CloudCompute:**
  - сохранность диска при остановке и удалении инстанса;
  - возможность переносить данные без GPU-инстанса;
  - цены.
- **Физический Android/Termux:** проверялась Linux-симуляция обновления и мобильная эмуляция Chromium.
- **Время и стоимость синхронизации** не измерялись: цифр в документах нет.
