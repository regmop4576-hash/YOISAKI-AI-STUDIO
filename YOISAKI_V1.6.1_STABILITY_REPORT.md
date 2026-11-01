# YOISAKI AI STUDIO v1.6.1 + YOISAKI ENGINE v1.6.1 — отчёт о стабилизации

Выпуск: **CONTROLNET STABILITY FIX**. Сайт **v1.6.1**, движок **v1.6.1**.
База: `YOISAKI_AI_STUDIO_V1.6.0_CONTROLNET_EDITION.zip` и `YOISAKI_ENGINE_V1.6.0_CONTROLNET.ipynb` (встроенный в ZIP notebook v1.6.0 был байт-в-байт равен отдельному), а также независимый аудит v1.6.0.
Тип обновления: только исправления ошибок. Архитектура (React/esbuild + Node.js, FastAPI-движок, Cloudflare Tunnel, очередь, галерея, Regional Control, LoRA) не заменялась, интерфейс AMBER CORE не менялся, зависимости не обновлялись.

## 1. Итог

- Исправлены все подтверждённые находки высокого приоритета (AUD-001, AUD-002, AUD-004), устранён механизм AUD-003 и исправлены AUD-006, AUD-007, AUD-008, AUD-009, AUD-012 и AUD-015.
- При исправлении AUD-004 найден и исправлен **новый критический дефект AUD-019**: в v1.6.0 первая же ControlNet-задача переводила общие модули SDXL в fp32 и удваивала их объём в памяти.
- Тесты на CPU с настоящими diffusers 0.36 / accelerate / peft, Node и браузерные тесты проходят.
- **На реальном GPU ничего не запускалось.** Стабильность RAM/VRAM на Colab T4 не подтверждена и не заявляется (раздел 8).

## 2. Исправленные находки

### AUD-019 (CRITICAL, новая, подтверждена) — `from_pipe()` переводил SDXL и ControlNet в fp32
- **Где:** `engine/inference/controlnet.py`, `activate()` и `to_base()`.
- **Дефект:** в diffusers 0.36 `DiffusionPipeline.from_pipe()` берёт `torch_dtype = kwargs.pop("torch_dtype", torch.float32)` и в конце вызывает `new_pipeline.to(dtype=torch_dtype)`. Модули общие, поэтому уже первая ControlNet-задача на месте переводила общие UNet, оба текстовых энкодера, VAE и сам ControlNet из fp16 в fp32. Обратный переход в `to_base()` тоже оставлял fp32. Удвоение касается и всех последующих обычных генераций. На T4 базовая модель весила бы ≈13,9 ГБ вместо ≈6,95 ГБ, плюс ControlNet 4,8 ГБ — больше 12,7 ГБ RAM.
- **Почему аудит пропустил:** в тестах аудита крошечная модель была в fp32, и приведение к fp32 ничего не меняло. Дефект нашёлся при проверке загрузки fp16-варианта Canny через настоящий загрузчик.
- **Доказательство:** `evidence/from_pipe_dtype_v160.txt`. Исходный движок v1.6.0: fp16 → fp32 после `activate()` и после `to_base()`, байты весов ×2.
- **Исправление:** `from_pipe(..., torch_dtype=None)` в обоих вызовах. С `None` diffusers не выполняет никакого приведения, dtype остаются такими, какими их загрузил движок.
- **Тест:** `FP16PipelineTransitions.test_aud019_activate_and_release_keep_fp16_and_bytes` — три режима, байты весов не меняются, LoRA остаётся в fp16.

### AUD-001 (HIGH) — Strength 0/1/2 вызывали `TypeError`
- **Где:** `engine/inference/controlnet.py` (новая `normalize()`), `engine/inference/text2img.py` (`generate()`).
- **Исправление:** после прежней валидации `strength`, `start` и `end` приводятся к `float` перед вызовом Diffusers. Диапазоны и правила проверки не менялись, `bool` и строки по-прежнему отклоняются.

### AUD-004 (HIGH) — Canny загружал fp32-чекпойнт (≈5 ГБ)
- **Где:** `engine/inference/controlnet.py`, `FP16_VARIANT = ('Canny', 'Depth')`.
- **Исправление:** для Canny добавлен `variant='fp16'`. Модель прежняя (`diffusers/controlnet-canny-sdxl-1.0`), `use_safetensors=True`. Загрузка OpenPose (единственный fp16-файл xinsir) и Depth не изменена.

### AUD-003 (HIGH, механизм подтверждён по коду; эффект на T4 не измерен) — ControlNet копировался GPU→RAM перед удалением
- **Механизм (diffusers 0.36):** в конце `__call__` выполняется `maybe_free_model_hooks()`, затем `enable_model_cpu_offload()`, затем `self.to("cpu")`. ControlNet (2,4 ГБ fp16) копировался в RAM, после чего `to_base()` вызывал ещё и `old.to('cpu')` и только потом его удалял.
- **Исправление:** в одноразовом ControlNet-wrapper:
  - ControlNet добавлен в `_exclude_from_cpu_offload` экземпляра. Он один раз переносится на GPU, где и так находился весь цикл денойзинга.
  - `maybe_free_model_hooks` экземпляра заменён на `_offload_hooked_models()`. Она выгружает UNet, текстовые энкодеры и VAE штатным `hook.offload()` (как обычный model offload), не трогая ControlNet.
  - `to_base()` убирает ссылку на ControlNet без `.to('cpu')`.
- **Что сохранено:** CPU offload базовых модулей, общие UNet и VAE, LoRA. Обычный Text2Img не меняется. Очистка после ошибки, отмены и при смене режима проверена.
- **Ожидаемый эффект (не измерен):** минус ≈2,4 ГБ пика RAM в конце каждой ControlNet-задачи. VRAM почти без изменений: ControlNet находится на GPU также и во время кодирования текста (+2,4 ГБ к TE1+TE2 ≈1,6 ГБ).

### AUD-002 (HIGH) — base64-карты в истории и галерее
- **Где:** `server/controlnet.mjs` (`compactControlRequest`), `server/app.mjs`, `server/storage.mjs`.
- **Исправление:**
  - На GPU уходит полный запрос. В историю и в `parameters` галереи пишется компактная форма: все настройки ControlNet плюс `image_sha256` и `image_length`.
  - Идемпотентный повтор сравнивается с компактной формой.
  - Миграция при запуске: в записях v1.6.0 удаляется только встроенная карта. Записи, изображения, пресеты, настройки и теги сохраняются. Исходник однократно сохраняется в `state.json.v1.6.0-backup`.
  - `Store.change()` больше не перезаписывает `state.json` и `.bak`, если данные не изменились.

### AUD-006 (MEDIUM) — обрыв предобработки на 95 с
- **Где:** `engine/worker/direct_server.py`, `server/app.mjs`, `src/components/Generator.tsx`.
- **Исправление:**
  - Движок ждёт результат не дольше 60 с, затем отвечает `{"status":"PENDING"}`, а операция продолжается в прежнем единственном executor.
  - Повтор идентичного запроса (по SHA-256 тела) подключается к той же операции и не запускает новую. Запрос с другой картой во время работы получает 409. Второй очереди нет.
  - Каждый участок цепочки укладывается в лимиты: движок 60 с, Node 90 с, браузер 95 с, Cloudflare ≈100 с.
  - Интерфейс показывает прежнее «Подготовка карты…», пока ответ `PENDING`. Внешний вид не менялся.

### AUD-007 (MEDIUM) — лимит 100 записей в таблице заданий движка
- **Где:** `engine/worker/direct_server.py`, `prune_jobs()`.
- **Исправление:** при заполнении таблицы удаляются самые старые записи, которые больше не нужны сайту:
  - `COMPLETED` с подтверждённым ACK (или уже очищенным результатом);
  - `FAILED`/`CANCELLED` старше 15 минут.
- **Что не трогается:** `QUEUED`/`RUNNING` и неподтверждённые результаты.
- Если удалить нечего, движок отвечает понятным 429 на русском.

### AUD-008 (MEDIUM) — Canny терял бинарность
- **Исправление:** изображение вписывается в целевой размер до Canny, детектор работает в итоговом разрешении. Карты Canny и OpenPose вписываются с NEAREST, поэтому остаются строго 0/255.

### AUD-012 (LOW) — однородная глубина проходила проверку
- **Исправление:** до интерполяции проверяется относительный диапазон сырой оценки, `FLAT_DEPTH = 1e-3` от модуля (не меньше 1). Это отсекает константы, шум округления и рябь 0,01%. Низкоконтрастные карты (3%) и малые абсолютные значения проходят.

### AUD-009 (LOW/MEDIUM) — общие сообщения вместо причины
- **Где:** `server/upstream.mjs`, `engineDetail()`.
- **Исправление:** для `/generate` с кодами 400/422/429/507 пользователь видит причину от движка: «GPU отклонил задание: …». Префикс pydantic убирается, токены и пути маскируются, длина ограничена 300 символами. Для 500 по-прежнему общее сообщение без трассировки.

### AUD-015 (LOW) — версии и устаревшие тесты
- Все версии приложения — 1.6.1: `package.json`/lock, `release.mjs`, `/health`, совместимость, журнал запуска, `service.mjs`, панель Colab, notebook и его метаданные, диагностика, документация.
- Обновлены устаревшие ожидания в `history-browser.mjs`, `regional-compatibility-browser.mjs` и `memory-ui.mjs`.
- Сообщение «v1.3» в `text2img.py` исправлено.
- Папка `YOISAKI_AI_STUDIO_V1.4.0_LOCAL_EDITION` не переименована: `update.sh` ищет её по этому имени.

## 3. Изменённые файлы (относительно v1.6.0)

Движок (`engine/`, он же пакет внутри notebook):
- `engine/inference/controlnet.py` — AUD-001 (`normalize`), AUD-003, AUD-004, AUD-008, AUD-012, AUD-019.
- `engine/inference/text2img.py` — AUD-001 (вызов `normalize`); исправлено сообщение «v1.3» (AUD-015).
- `engine/worker/direct_server.py` — AUD-006 (возобновляемая предобработка), AUD-007 (`prune_jobs`), версия 1.6.1.
- `engine/panel.py`, `engine/stress_memory.py`, `engine/diagnostics/runner.py`, `engine/diagnostics/ui.py` — только версия 1.6.1.

Сайт:
- `server/controlnet.mjs` — `compactControlRequest` (AUD-002).
- `server/app.mjs` — компактная запись истории, сквозная передача PENDING, таймаут участка 90 с, версия (AUD-002/006/015).
- `server/storage.mjs` — миграция v1.6.0, запись только при изменении данных (AUD-002).
- `server/upstream.mjs` — `engineDetail` (AUD-009), версия совместимости 1.6.1.
- `server/release.mjs`, `server/index.mjs`, `scripts/service.mjs`, `package.json`, `package-lock.json` (только корневая версия) — версия 1.6.1.
- `src/components/Generator.tsx` — цикл PENDING в `preprocessControl` (AUD-006); вёрстка не изменена.
- `src/components/Shell.tsx`, `src/components/SettingsModal.tsx`, `src/app/engine/page.tsx` — только текст версии.

Notebook:
- `colab/YOISAKI_ENGINE_V1.6.1_STABILITY_FIX.ipynb` (заменяет `colab/YOISAKI_ENGINE_V1.6.0_CONTROLNET.ipynb`). Встроенный пакет пересобран из исправленного `engine/`: 22 файла, SHA-256 пакета `dcf01a5375419c6ae1bedeef0d61ceda1a1d727df91924d31be49ed5f3a549a8`, совпадает с `_EXPECTED`; распакованные файлы побайтно равны `engine/`.

Документация: `README_RU.md`, `CHANGELOG_RU.md`, `docs/CHANGELOG_RU.md`, `docs/TERMUX_UPDATE_RU.md`, `YOISAKI_V1.4.0_INSTALL_ANDROID_RU.md`, этот отчёт; `package-manifest.json` пересчитан.

Тесты:
- Новые: `tests/test_controlnet_diffusers_cpu.py` (11), `tests/test_v161_stability.py` (4), `tests/v161-stability.test.mjs` (6).
- Обновлены ожидания версии и устаревшие ожидания: `backend`, `browser-e2e`, `controlnet`, `controlnet-browser` (теперь с PENDING), `history`, `history-browser`, `memory-ui`, `regional`, `regional-compatibility`, `regional-compatibility-browser`, `result-ack`, `ui-check`, `test_controlnet.py`, `test_engine.py`.

Не изменены (проверено `git diff`): `globals.css`, `RegionalControl.tsx`, `regional.ts`, `inference/regional.py`, `prompt_encoding.py`, `allocator_policy.py`, `memory_profiler.py`, `results.py`, `JobHistory.tsx`, `gallery.ts`, `history.mjs`, `public/`, `update.sh`, `install.sh`, `requirements.txt`.

## 4. Выполненные проверки

Окружение: Linux, 4 CPU, **без CUDA**. Python 3.13 + torch 2.14.1 CPU (в Colab — Python 3.12 и свой torch); diffusers 0.36.0, transformers 4.57.3, accelerate 1.12.0, peft 0.18.0, controlnet-aux 0.0.10 и другие пины ровно из `engine/requirements.txt`. Node 22.22.0. Hugging Face из этой среды недоступен.

| # | Команда | Результат |
|---|---|---|
| 1 | `npm ci --ignore-scripts` (существующий lockfile) | PASS |
| 2 | `npx tsc --noEmit` | PASS |
| 3 | `node scripts/build.mjs` (esbuild; проект не на Next.js) | PASS |
| 4 | `node --test tests/*.test.mjs` | PASS 32/32 (26 прежних + 6 новых) |
| 5 | Браузер Chromium: `controlnet-browser`, `browser-e2e`, `history-browser`, `regional-compatibility-browser`, `ui-check`, `memory-ui`, `mobile` (сервер v1.6.1 на :3000) | PASS 7/7 (в v1.6.0 три теста падали из-за устаревших ожиданий) |
| 6 | `python -m pytest tests` | PASS 67/67 (52 прежних + 15 новых) |
| 7 | Новые регрессионные тесты на **исходном** движке v1.6.0 | 10 FAIL / 1 PASS: каждый дефект воспроизводится |
| 8 | Стенд интеграции аудита `cn_integration.py` | v1.6.0: 30/33 → v1.6.1: 33/33 |
| 9 | Стенд предобработки аудита `preprocess_audit.py` | v1.6.0: 34/37 → v1.6.1: 36/37 (остаток — слишком строгая проверка самого стенда для синтетической рампы, не дефект) |
| 10 | Доказательство AUD-019 (`evidence/from_pipe_dtype.py`, fp16-база) | v1.6.0: fp16→fp32, байты весов ×2; v1.6.1: fp16 сохраняется |
| 11 | `nbformat.validate`, компиляция кода ячеек, распаковка пакета по логике ячейки 2, SHA-256, сравнение с `engine/` | PASS |
| 12 | Импорт распакованного движка и `/health` | PASS, `engine_version` = 1.6.1 |
| 13 | `node scripts/verify-package.mjs` по новому манифесту | PASS (в составе `install.sh` и `update.sh`) |
| 14 | Установка из итогового ZIP и `update.sh` поверх реальной установки v1.6.0 с данными | PASS (раздел 5) |

### Регрессионные сценарии

1. Strength 0 / 0.5 / 0.8 / 1 / 1.5 / 2 в JSON-типах браузера — генерация через настоящий `StableDiffusionXLControlNetPipeline` проходит. Strength 0 в точности равен обычной генерации; неверные значения (−0.01, 2.01, NaN, bool, строка, Start ≥ End, End > 1) отклоняются — **PASS**.
2. Canny загружается с `variant='fp16'`; настоящий `ControlNetModel.from_pretrained` выбирает `diffusion_pytorch_model.fp16.safetensors` из репозитория с двумя файлами, dtype — fp16 — **PASS** (локально; реальный HF не проверен).
3. 12 ControlNet-заданий с картами ≈2,1 МБ: `state.json` 20,7 КБ, `.bak` 20,7 КБ, `/api/history` 10,0 КБ, `/api/gallery` 10,9 КБ. В аудите v1.6.0 было 58,8 / 58,8 / 33,6 / 25,2 МБ. GPU по-прежнему получает полную карту — **PASS**.
4. Данные v1.6.0 читаются: история (3), галерея (3), пресеты, настройки, теги и файлы изображений сохранены; исходник побайтно лежит в `state.json.v1.6.0-backup`; повторный запуск ничего не переписывает — **PASS**.
5. Жизненный цикл на настоящем diffusers во всех трёх режимах, при batch 2, ошибке размера карты и отмене: тот же объект UNet, LoRA сохраняется, ControlNet освобождён, 4 hook, dtype fp16 — **PASS**.
6. Предобработка: PENDING и возобновление без второго запуска детектора; другая карта во время работы — 409; ошибка детектора — 422 с текстом; занятая очередь — 409; каждый участок < 95 с; браузер дожидается карты после PENDING — **PASS**.
7. 130 последовательных заданий с ACK принимаются, старые записи удаляются; неподтверждённые результаты и свежие ошибки не удаляются (явный 429), после ACK приём возобновляется; 105 ошибок подряд при нулевой выдержке — **PASS**.
8. Canny строго 0/255 для 5 пар размеров и пропорций; готовые бинарные карты Canny и OpenPose сохраняют палитру — **PASS**.
9. Однородная глубина, шум округления, рябь 0,01% и NaN отклоняются; градиент, контраст 3% и малые абсолютные значения принимаются — **PASS**.
10. Regional + ControlNet отклоняются (UI, Node, движок); Regional-браузерный тест и regional-тесты проходят — **PASS**.
11. Обычный Text2Img после ControlNet и после отменённой ControlNet-задачи побитно совпадает с исходным — **PASS** (CPU).
12. Галерея загружается, файлы изображений отдаются (HTTP 200) — **PASS**.
13. Версии сайта и движка совпадают (раздел 9) — **PASS**.

Ход отладки:
- Тест AUD-007 сначала падал из-за моего неверного расчёта числа итераций; исправлен цикл теста, движок не менялся.
- Расхождение «первой генерации» в одном тесте оказалось ошибкой индексации эталона в тесте: `plain[0][0]` вместо `plain[0]`. Отдельными экспериментами подтверждено, что движок детерминирован и в v1.6.0, и в v1.6.1.

## 5. Проверка установочных файлов

**Чистая установка из `YOISAKI_AI_STUDIO_V1.6.1_STABILITY_FIX.zip`** (изолированный HOME):
- `bash install.sh` — PASS: `verify-package` по новому манифесту, `npm ci`, production-сборка.
- `node --test` в распакованной копии — 32/32 PASS.
- Права `install.sh`/`update.sh` — 755.

**Обновление реальной установки v1.6.0 штатным `update.sh`:**
1. Исходный ZIP v1.6.0 установлен его `install.sh`. Сервером v1.6.0 созданы данные: 3 ControlNet-задания (OpenPose/Canny/Depth) с картами ≈2,1 МБ, галерея, настройки, пресет. Итог: `state.json` = 16 805 205 байт, в нём 3 встроенные карты.
2. `bash update.sh YOISAKI_AI_STUDIO_V1.6.1_STABILITY_FIX.zip` — PASS. Создана резервная папка `…LOCAL_EDITION.backup-<дата>`, выполнена новая установка.
3. Сервер v1.6.1 на тех же данных — PASS:
   - история 3/3 (`COMPLETED`), галерея 3/3, все PNG отдаются;
   - пресет «Пресет пользователя» и prompt сохранены; тип и Strength ControlNet и SHA-256 карт сохранены;
   - встроенных карт осталось 0, `state.json` = 5 637 байт;
   - `state.json.v1.6.0-backup` = 16 805 205 байт (исходник).
4. `start.sh` → `/api/session` возвращает `version: "1.6.1"`; `stop.sh` — «Приложение остановлено. Данные сохранены.» — PASS.

**Notebook:**
- Встроенный `colab/YOISAKI_ENGINE_V1.6.1_STABILITY_FIX.ipynb` побайтно равен отдельно поставляемому (SHA-256 `da2768f10cf62faa470a7d454cf93592e850c970b2a11ef0ff321eef54816e26`).
- Старый notebook v1.6.0 из архива удалён, поэтому в поставке одна реализация движка.

**Состав архива:**
- 142 файла (только исходники), корневая папка `YOISAKI_AI_STUDIO_V1.4.0_LOCAL_EDITION`.
- Без `node_modules`, `dist`, `build-meta.json`, `__pycache__`, виртуальных окружений и весов моделей.
- `package-manifest.json` — 141 запись (все файлы, кроме самого манифеста, как в v1.6.0).

## 6. Оптимизация RAM: что изменено и что не доказано

| Изменение | Ожидаемый эффект на T4 | Статус |
|---|---|---|
| AUD-019: `from_pipe(torch_dtype=None)` | Базовая модель остаётся fp16 (≈6,95 ГБ) и не удваивается до ≈13,9 ГБ после первой ControlNet-задачи; ControlNet 2,4 ГБ вместо 4,8 ГБ. Касается и всех последующих обычных генераций. | dtype и байты подтверждены на CPU с настоящим diffusers 0.36; замеры на T4 не выполнялись |
| AUD-004: Canny `variant='fp16'` | Пик при загрузке Canny ≈ +0,04 ГБ вместо +7,2 ГБ, загрузка 2,5 ГБ вместо 5 ГБ | Загрузчик проверен локально на структуре репозитория с двумя файлами; настоящий чекпойнт с HF не загружался (HF недоступен) |
| AUD-003: без GPU→RAM копии ControlNet | Минус ≈2,4 ГБ RAM в конце каждой ControlNet-задачи | Отсутствие перемещения ControlNet после активации проверено инструментированием; RAM на T4 не измерена |
| AUD-002 (сайт) | `state.json` и ответы API не растут на 2× размер карты за задание | Подтверждено (12 заданий, см. тесты) |

**Не заявляется:** «утечка RAM устранена», «стабильно на T4». Без настоящего T4 это не доказано.

## 7. Оставшиеся ограничения (вне объёма 1.6.1)

- AUD-005: VRAM при 1024²×2 с полным ControlNet не измерена. Лимиты batch и разрешения не менялись.
- AUD-010: предобработка по-прежнему отклоняется, пока в очереди есть задание (409).
- AUD-011: встроенный профилировщик и стресс-тест по-прежнему работают только без ControlNet; данные о ControlNet пишет `memory.jsonl`.
- AUD-013: полярность готовых карт (инверсный Canny/Depth) не проверяется.
- AUD-014: отмена во время скачивания или загрузки весов ControlNet срабатывает только на первом шаге UNet.
- AUD-016: `last_trace` не содержит настроек ControlNet.
- AUD-017: pickle-веса OpenPose (`torch.load`) и `cloudflared latest` не менялись.
- AUD-018: полезная нагрузка заданий в очереди движка по-прежнему хранит карту до выполнения.
- Регионные маски (до 3×400 КБ) по-прежнему хранятся в истории: эта находка в аудите не числилась, Regional Control не трогали.
- `state.json.v1.6.0-backup` остаётся в каталоге данных после миграции (защита данных); пользователь может удалить его вручную.
- Если движок навсегда завис на предобработке, сайт показывает «Подготовка карты…», пока пользователь не сменит тип, размер или файл (тогда опрос прекращается).

## 8. Обязательные проверки на реальном Colab T4

Ни одна GPU-проверка в этой среде не выполнялась.

1. Новая среда T4, notebook v1.6.1, обычная генерация 768² batch 1 (seed 123) — `memory.jsonl` before/after.
2. Для каждого режима (OpenPose, Canny, Depth) по 3 генерации при Strength 1.0. Снять в `memory.jsonl` фазы `after_controlnet_load`, `after_decode`, `after_controlnet_release`, `after_cleanup`; RAM (MemAvailable, RSS) и пиковую VRAM.
3. Убедиться по логу или `memory.jsonl` (`components.*.dtype`), что после ControlNet компоненты остаются `torch.float16`.
4. Обычная генерация после ControlNet с тем же seed — изображение должно совпадать с генерацией до ControlNet.
5. Первая загрузка Canny: файл в кеше HF — `diffusion_pytorch_model.fp16.safetensors` (≈2,5 ГБ).
6. Первая предобработка OpenPose/Depth на чистой среде (скачивание весов): карта должна появиться без ошибки таймаута.
7. 1024²×1 и 1024²×2 с ControlNet — пиковая VRAM (AUD-005).
8. Более 100 генераций за сессию (можно 256², 1–2 шага) — сайт продолжает принимать задания.
9. Отмена во время ControlNet-генерации, затем обычная генерация — без ошибок, RAM возвращается.
10. Визуальное качество каждого ControlNet на выбранном Illustrious-чекпойнте.

## 9. Итоговая согласованность версий

| Место | Значение |
|---|---|
| `package.json` / `package-lock.json` (корень) | 1.6.1 |
| `server/release.mjs` WEBSITE_VERSION / COMPATIBLE_ENGINE_FAMILY | 1.6.1 / 1.6.1 |
| Совместимость сайта (`validateHealth`, `engineCompatibility`) | ровно 1.6.1 + `capabilities.controlnet` |
| Журнал запуска (`server/index.mjs`, `scripts/service.mjs`) | v1.6.1 |
| UI: боковая панель, настройки, экран GPU | v1.6.1 |
| Движок `/health` `engine_version` | 1.6.1 |
| Панель Colab, диагностика, стресс-тест | v1.6.1 |
| Notebook: заголовок, метаданные `colab.name`, `yoisaki_profiler.base` | v1.6.1 / `YOISAKI_ENGINE_V1.6.1_STABILITY_FIX.ipynb` / v1.6.1 |
| Документация | v1.6.1 |

Внутренняя папка архива — `YOISAKI_AI_STUDIO_V1.4.0_LOCAL_EDITION` (путь совместимости `update.sh`, не версия). Движок 1.6.0 сайт 1.6.1 отклоняет как несовместимый: протокол предобработки PENDING есть только в 1.6.1. Обновлять нужно оба компонента.
