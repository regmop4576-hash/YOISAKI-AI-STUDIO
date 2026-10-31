# YOISAKI ENGINE v1.9.2 COLAB — отчёт о совместимости с YOISAKI AI STUDIO v1.9.2

**Итог:** реальных несовместимостей API между сайтом v1.9.2 и движком из присланного notebook не найдено.
Генерационный код не менялся. `YOISAKI_ENGINE_V1.9.2_COLAB.ipynb` — тот же проверенный движок с обновлённой
инструкцией под интерфейс сайта 1.9.2 и исправленным именем в метаданных. **Изменения сайта не требуются, новый
ZIP сайта не создавался.** На Tesla T4 ничего не запускалось — см. раздел 6.

## 1. Исходные файлы

| | |
|---|---|
| Присланный notebook | `YOISAKI_ENGINE_V1.8.1_SMART_FACE_FIX.ipynb`, SHA-256 `591165356fc4…a2fc`, nbformat 4.5, 10 ячеек |
| Совпадение | побайтно совпадает с `colab/YOISAKI_ENGINE_V1.8.1_SMART_FACE_FIX.ipynb` в релизе сайта |
| Движок внутри | base64-ZIP в ячейке 1, 32 файла, SHA-256 `fa9f5283eed2…2d82` (сверяется с `_EXPECTED` при запуске) |
| Версии | `engine_version 1.8.1`, `api_version 1.7.0` |
| Сайт | YOISAKI AI STUDIO v1.9.2 PIXEL FANTASY (`server/`, `src/`) |

## 2. Аудит контракта (сайт v1.9.2 ↔ движок notebook)

Источник ожиданий сайта: `server/upstream.mjs` (белый список маршрутов, `validateHealth`, `validateGeneration`),
`server/release.mjs` (допуск версии и возможностей), `server/app.mjs`, тела запросов из `src/components`.
Тела запросов генерации в v1.9.x не менялись относительно v1.8.1 (переработан только интерфейс).

| Область | Сайт ожидает | Движок notebook | Итог |
|---|---|---|---|
| Авторизация | `Authorization: Bearer <токен из #token>` | `hmac`-сравнение, 401 без токена | ✓ |
| `/health` | `engine=YOISAKI_ENGINE`, версия ∈ {1.7.0, 1.7.6, 1.8.0, 1.8.1}, API 1.7.0, `state`, `gpu_name`, VRAM | 1.8.1 / 1.7.0, состояние по CUDA | ✓ COMPATIBLE |
| Возможности | `controlnet`, `sdpose`, `img2img`, `inpaint`, `facefix`, `auto_facefix`, `face_detect_contract=1`, `regional_control`, `result_ack` | все объявлены | ✓ |
| `/models` | `id` (32 hex), `name`, `kind`, `architecture`, `compatible`, `size_bytes` | те же + `relative_path`, `metadata` (лишние поля сайт игнорирует) | ✓ |
| `/generate` | text2img / img2img / inpaint / facefix, `lora_adapters[{id,weight}]`, `regions[]`, `controlnet_config`, editor-поля, `face_detection`, `face_options` | `AdapterRequest` с теми же полями и пределами (256–1536, шаги 1–60, CFG 1–20, batch ≤ 2, вес LoRA 0–2) | ✓ |
| Размер тела | до 20 МБ (`jsonBody … 20*1024*1024`) | 20 971 520 байт, затем 413 | ✓ согласованы |
| `/jobs/{id}`, `DELETE`, `/jobs/{id}/ack` | статус, `progress{step,total_steps,percent,stage,eta}`, отмена, подтверждение получения | есть | ✓ |
| `/results/{id}?index=` | PNG (проверяется сигнатура) | PNG | ✓ |
| `/facefix/detect` | `image`, `detector`, `min_confidence` → лица с id и уверенностью | есть | ✓ |
| `/controlnet/preprocess` | карта, `PENDING` для долгой подготовки | есть | ✓ |
| `/inventory`, `/sync/*` | только для CloudCompute | в Colab-движке нет; сайт их для Colab не вызывает | ✓ не требуется |
| Туннель | `https://*.trycloudflare.com/#token=` | `cloudflared` последнего релиза с проверкой SHA-256 | ✓ |

## 3. Найденные несоответствия и решения

**Несовместимостей API нет.** Найденное:

1. **Номер версии и допуск сайта.** Сайт пускает только движки из списка проверенных (1.7.0 / 1.7.6 / 1.8.0 / 1.8.1).
   Если просто сменить `engine_version` на 1.9.2, сайт v1.9.2 отклонит движок (`ENGINE_UPGRADE_REQUIRED`). Пришлось
   бы менять и сайт, и диагностику движка (там тоже список версий) — без технической причины. **Решение:**
   внутренняя версия движка остаётся 1.8.1. На сайте после подключения: «Версия движка 1.8.1 · API 1.7.0 ·
   COMPATIBLE» — это ожидаемо и объяснено в первой ячейке notebook.
2. **Устаревшее имя в метаданных notebook** — `YOISAKI_ENGINE_V1.7.6_COLAB_COMPATIBILITY.ipynb` (видно в заголовке
   вкладки Colab). Исправлено.
3. **`engine/` в релизе сайта старее движка в notebook** (8 файлов: подписи версий в панели и диагностике, `/health`
   через общую функцию `hardware()`, поле `relative_path` в `/models`, версия в профайлере памяти). На Colab это не
   влияет: notebook несёт свой пакет. `engine/` используется образом CloudCompute и Python-тестами. Не менял, чтобы
   не выпускать новый сайт; рекомендую синхронизировать в следующем релизе сайта.
4. **Устаревшие проверки в Python-тестах репозитория:** `tests/test_engine.py` и `tests/test_controlnet.py` ждали
   `engine_version 1.7.0`, а тест лимита тела отправлял 12 МБ при лимите 20 МБ. Приведены к фактическому поведению
   (1.8.1; 20 МБ + 1 байт → 413). Код движка не менялся.
5. **Особенность каталога (давняя, не совместимость):** если checkpoint лежит Diffusers-папкой, файлы внутри неё
   (`unet/…`, `vae/…`) показываются отдельными несовместимыми записями («Несовместимые модели: N»). Сама папка
   определяется верно и работает. Для обычных single-file `.safetensors` эффекта нет. Не менял.

## 4. Что изменено

Только `colab/YOISAKI_ENGINE_V1.9.2_COLAB.ipynb` (SHA-256 `3a4be8f73bc8…ee11`):
- ячейка 0 (описание): шаги подключения под интерфейс сайта 1.9.2 (GPU → Google Colab → «URL туннеля Colab» →
  «Подключиться»; плитки «Модель» / «LoRA» на «Генерации»; Редактор → Inpaint / Face Fix), объяснение версий;
  технические разделы v1.8.1 (Inpaint, Smart Face Fix, ограничения, проверка релиза) сохранены дословно;
- `metadata.colab.name` → `YOISAKI_ENGINE_V1.9.2_COLAB.ipynb`.

В репозитории дополнительно: исправлены 3 устаревшие проверки в 2 тестах (п. 3.4), добавлен стенд
`tests/engine-integration/` (раздел 5).

## 5. Что осталось без изменений

Все кодовые ячейки (1, 3, 6, 8, 9) и встроенный пакет движка — побайтно (SHA-256 `fa9f5283…`): SDXL / Illustrious XL,
профиль Colab Free T4 16 GB, RAM FIX (`MALLOC_MMAP_THRESHOLD_`, отдельный worker), CPU Offload, VAE slicing / tiling,
fp16, Text2Img, Img2Img, Inpaint, Face Fix (ручной и Smart), ControlNet (OpenPose / SDPose-OOD / Canny / Depth),
Regional Control, Multi-LoRA с весами, очередь, прогресс, отмена, подтверждение результатов, Google Drive,
Cloudflare Tunnel, диагностика памяти и ресурсов, аудит промптов. Промпты не изменяются, скрытые теги не добавляются.

## 6. Проверки

| Проверка | Результат |
|---|---|
| Формат notebook (`nbformat.validate`), синтаксис всех кодовых ячеек, компиляция 27 `.py` пакета | OK |
| Контрольная сумма встроенного пакета = `_EXPECTED` | OK |
| Установка зависимостей движка из `requirements.txt` (diffusers 0.36.0, transformers 4.57.3, accelerate 1.12.0, peft 0.18.0, controlnet-aux 0.0.10, opencv 4.11.0.86, fastapi 0.115.12 и др.) с torch 2.15.0 | установились без конфликтов |
| Проверка импорта из `bootstrap.install()` (`create_app`, pipelines SDXL / ControlNet, peft, cv2, controlnet_aux) | `IMPORTS_OK` |
| Python-тесты движка (13 файлов) на пакете из notebook | **110 / 110** |
| Те же тесты на `engine/` репозитория | 110 / 110 |
| Интеграция: **настоящий локальный сервер сайта v1.9.2 ↔ настоящий FastAPI движка под uvicorn** (`tests/engine-integration/integration.mjs`) | **14 / 14** |
| Интерфейс сайта в Chromium (телефон 412 px) ↔ настоящий движок (`ui-real.mjs`) | **5 / 5** |
| Тесты сайта `npm test` (сайт не менялся) | 153 pass, 0 fail |

Интеграционные сценарии: подключение по защищённой ссылке и допуск версии; статус GPU (имя, VRAM); каталог
(Diffusers-checkpoint и настоящий LoRA-файл); Text2Img с LoRA (вес 0.45, batch 2): стадии, PNG в галерее сайта,
промпт и параметры сохранены без изменений; Img2Img; Inpaint (маска, растушёвка, контекст, crop); Face Fix по
области; Smart Face Fix (`/facefix/detect` через сайт + задание с `face_options`); Regional Control (две области,
одна с LoRA); два задания подряд в очереди; отмена через сайт (`CANCELLED`); ошибка выбора модели доходит до
пользователя; **отключение и повторное подключение** (история и каталог сохранены, новое задание выполняется;
во время выполнения движок честно сообщает `BUSY`); неверный токен → `AUTH_REJECTED`. В браузере: подключение
на странице GPU, выбор модели и LoRA в окнах, генерация с кнопкой «ГОТОВО», галерея с метаданными,
Inpaint в Редакторе с «До / После».

**Как устроен стенд:** код движка настоящий (`create_app`, загрузка через `from_pretrained`, LoRA через PEFT,
очередь, результаты); код сайта настоящий, включая `requestUpstream`. Подменены только TLS-туннель (локальный
HTTP) и 11 функций `torch.cuda` (CPU отвечает как GPU «CPU SHIM (no CUDA)», offload — на CPU). Модель — крошечная
SDXL со случайными весами.

Ограничения среды: `download.pytorch.org` и Hugging Face недоступны. Поэтому torch взят с PyPI, а ControlNet
с реальными весами (OpenPose / SDPose / Depth из Hugging Face) в интеграции не запускался; ControlNet покрыт
CPU-тестами с крошечными моделями (`test_controlnet_diffusers_cpu.py`, входит в 110 / 110).

## 7. Что требует реального запуска в Colab (не проверено)

- **Генерация на Tesla T4 не выполнялась.** CUDA, fp16 на GPU, скорость, реальное потребление VRAM и RAM при CPU
  Offload, эффект RAM FIX на двух и более генерациях подряд.
- Полноразмерный Illustrious XL / SDXL single-file, реальные LoRA и VAE пользователя, качество изображений.
- Текущая версия Python / torch / torchvision в Colab: зависимости ставятся с ограничением `torch==<версия Colab>`;
  здесь проверена совместимость набора с torch 2.15.0 на Python 3.13 (CPU).
- ControlNet и SDPose-OOD с загрузкой весов из Hugging Face; поиск лиц на реальных портретах.
- Cloudflare Quick Tunnel и подключение Google Drive в живой сессии Colab.

Проверка в Colab: T4 → «ПОДГОТОВИТЬ ПАНЕЛЬ» → «ЗАПУСТИТЬ ДВИЖОК» → ссылку на страницу GPU сайта → «Модели GPU →
Обновить модели» → генерация 768 × 768, 20 шагов → Inpaint → Face Fix → отключиться и подключиться снова.
