# YOISAKI AI STUDIO v1.6.2 + YOISAKI ENGINE v1.6.2 — SDPose Edition

База: `YOISAKI_AI_STUDIO_V1.6.1_STABILITY_FIX.zip` и `YOISAKI_ENGINE_V1.6.1_STABILITY_FIX.ipynb`. Встроенный в ZIP notebook побайтно совпадал с отдельным.
Объём: только препроцессор позы SDPose-OOD в существующем ControlNet плюс управление памятью для него. Не менялись: архитектура (React/esbuild + Node.js, FastAPI-движок), AMBER CORE, очередь, история, галерея, Regional Control, LoRA, загрузка и переходы ControlNet (`activate`/`to_base`), Canny, Depth, OpenPose Classic, зависимости (`engine/requirements.txt`).

**На реальном GPU ничего не запускалось. Настоящие веса SDPose-OOD не загружались: Hugging Face из этой среды недоступен (403).** Раздел 6.

## 1. Что изменено

- В панели ControlNet при типе OpenPose появился один селектор «Препроцессор позы»: **OpenPose Classic** (по умолчанию) или **SDPose-OOD**. Ниже — подсказка: SDPose-OOD лучше для стилизованных, аниме, фурри и сложных поз.
- SDPose-OOD строит OpenPose-карту тела (18 точек). Карта идёт в прежний маршрут генерации: тот же `xinsir/controlnet-openpose-sdxl-1.0`, тот же `activate()`. Отдельной архитектуры ControlNet нет.
- «Использовать готовую карту» работает как раньше. Селектор в этом режиме заблокирован, SDPose не загружается.
- Карта сбрасывается при смене препроцессора, типа, размеров, файла или режима готовой карты. Препроцессор входит в ключ карты.
- Протокол, согласованно на сайте и в движке:
  - необязательное поле `preprocessor: 'openpose' | 'sdpose'`, допустимо только для OpenPose;
  - по умолчанию `openpose`, поэтому запросы без поля работают как прежде;
  - движок возвращает поле в ответе предобработки, сайт сверяет его с запросом;
  - в `controlnet_config` поле попадает в историю и галерею (компактная форма без карты, AUD-002).
- `/health` объявляет `capabilities.sdpose: true`. Сайт 1.6.2 принимает только движок 1.6.2 с этой capability; 1.6.1 отклоняется с понятной ошибкой.
- Все версии — 1.6.2: `package.json`/lock, `release.mjs`, совместимость, журналы запуска, UI (боковая панель, настройки, экран GPU), `/health`, панель Colab, диагностика, стресс-тест, notebook и его метаданные, документация.

## 2. Изменённые файлы (относительно v1.6.1)

Движок:
- `engine/inference/sdpose.py` — новый модуль SDPose-OOD.
- `engine/inference/sdpose_empty_embed.safetensors` — новый файл (8 КБ), раздел 3.
- `engine/inference/controlnet.py` — `POSE_PREPROCESSORS`; проверка `preprocessor` в `preprocess()` и `validate_control()`; ветка `sdpose`; поле `preprocessor` в ответе.
- `engine/worker/direct_server.py` — версия, `capabilities.sdpose`.
- `engine/bootstrap.py` — проверка импортов SDPose при установке.
- `engine/panel.py`, `engine/stress_memory.py`, `engine/diagnostics/runner.py`, `engine/diagnostics/ui.py` — только версия.

Сайт:
- `src/components/Generator.tsx` — селектор, подсказка, `preprocessor` в запросах, ключ карты.
- `src/lib/controlnet.ts` — `posePreprocessors`, `posePreprocessor()`, ключ карты с препроцессором.
- `src/stores/studio.ts` — `controlPreprocessor` (по умолчанию `openpose`). Старые настройки и пресеты получают значение по умолчанию.
- `server/controlnet.mjs` — проверка `preprocessor` (предобработка и генерация).
- `server/app.mjs` — сверка `preprocessor` в ответе движка, версия.
- `server/release.mjs`, `server/upstream.mjs` — 1.6.2 + `capabilities.sdpose`.
- `server/index.mjs`, `scripts/service.mjs`, `package.json`, `package-lock.json` (только корневая версия), `Shell.tsx`, `SettingsModal.tsx`, `src/app/engine/page.tsx` — только версия.

Notebook:
- `colab/YOISAKI_ENGINE_V1.6.2_SDPOSE_EDITION.ipynb` заменяет `…V1.6.1_STABILITY_FIX.ipynb`.
- Встроенный пакет пересобран из `engine/`: 24 файла, SHA-256 пакета `ba0d610a607436f1db742acae58f43131db80433ac29b50023905b5dad6230c0` (= `_EXPECTED`).

Документация: `README_RU.md`, `CHANGELOG_RU.md`, `docs/CHANGELOG_RU.md`, `docs/TERMUX_UPDATE_RU.md`, `YOISAKI_V1.4.0_INSTALL_ANDROID_RU.md`, этот отчёт, `docs/verification/v162-*.txt`, пересчитанный `package-manifest.json`.

Тесты:
- Новые: `tests/test_v162_sdpose.py` (13), `tests/v162-sdpose.test.mjs` (4); сценарий SDPose добавлен в `tests/controlnet-browser.mjs`.
- В остальных тестах обновлены версия и `capabilities` у тестовых двойников движка. В `controlnet-browser.mjs` селектор типа уточнён до `.first()`: в панели теперь два `select`.

Не изменены (`git diff`): `text2img.py`, `regional.py`, `prompt_encoding.py`, `storage.mjs`, `history.mjs`, `globals.css`, `RegionalControl.tsx`, `JobHistory.tsx`, `gallery.ts`, `requirements.txt`, `install.sh`, `update.sh`.

## 3. Как интегрирован SDPose-OOD

Источник весов — официальный `teemosliang/SDPose-Body` в формате diffusers. Скачиваются только `unet/`, `vae/` и `decoder/decoder.safetensors`; текстовый энкодер не нужен.

Конвейер, как в официальном `SDPose_D_Pipeline`:
1. Изображение вписывается в 768×1024 (3:4) с сохранением пропорций и чёрными полями (как top-down кроп mmpose).
2. VAE-кодирование, латент × 0,18215. Берётся `latent_dist.mode()`, а не `sample()`, — результат детерминирован.
3. Один проход UNet (SD2, `class_embed_type='projection'`, `projection_class_embeddings_input_dim=4` — тот же override, что в официальном загрузчике) при t = 999 с task-embedding `[sin 1, sin 0, cos 1, cos 0]`.
4. Выход последнего up-блока снимается forward-hook'ом, который снимается сразу после прохода.
5. HeatmapHead даёт 17 тепловых карт 192×256.
6. Декодирование UDP/DARK, отображение обратно в координаты изображения.
7. Порог 0,3, COCO-17 → OpenPose-18 (шея = середина плеч).
8. Отрисовка функцией `draw_poses` из controlnet_aux с геометрией классического детектора (detect 512 → image 1024). Стиль карты совпадает с OpenPose Classic.
9. Далее прежние `ensure_content` и letterbox NEAREST до размера генерации.

Без mmpose/mmcv:
- HeatmapHead переписана на чистом torch с теми же ключами `state_dict`. Перенесена и конвертация старых ключей из `_load_state_dict_pre_hook`.
- Декодер — порт `UDPHeatmap.decode` + `refine_keypoints_dark_udp` на cv2. **Побитово совпадает с оригинальным кодом mmpose** из репозитория SDPose-OOD: максимальная разница 0 на 50 случайных зашумлённых наборах. Оригинальные функции исполнялись напрямую.

Пустой текстовый эмбеддинг:
- CLIP-H (`[1, 2, 1024]`, fp32) взят готовым из `ComfyUI-SDPose-OOD/empty_text_encoder` (MIT), чтобы не качать и не держать текстовый энкодер (~1,3 ГБ).
- Целостность проверяется по SHA-256 при каждой загрузке.

Почему не `Comfy-Org/SDPose`: это единый fp16-чекпойнт ComfyUI (`sdpose_wholebody_fp16.safetensors`, 1,92 ГБ) в формате ключей LDM, только WholeBody (133 точки). Нужна конвертация ключей, которую без файла нельзя проверить. Лица и кисти выходят за пределы прежнего маршрута OpenPose, где рисуется только тело. Использованы официальные веса Body, которые грузят официальный код и ComfyUI-SDPose-OOD.

`YOISAKI_SDPOSE_REPO`: путь к локальной копии репозитория с той же структурой — для случая, когда Hugging Face недоступен.

## 4. Управление ресурсами (Colab Free, T4)

- Предобработка уже сериализована с генерацией (один executor; при занятой очереди — 409). Во время SDPose базовый SDXL-конвейер выгружен на CPU (model CPU offload после `finish_job`), ControlNet не загружен.
- Загрузка по требованию:
  - UNet — `torch_dtype=fp16`, `low_cpu_mem_usage=True`, `device_map='cuda'`: веса читаются через mmap сразу на GPU (так в diffusers 0.36 устроены оба пути, safetensors и `.bin`);
  - VAE — только энкодер (декодер и `post_quant_conv` удаляются), fp32 как в эталоне, ≈0,14 ГБ;
  - голова — fp16.
  - Ожидаемая VRAM ≈ 1,7 ГБ весов UNet плюс активации. Расчёт, не измерение.
- Освобождение до возврата из `preprocess()`, то есть до любой генерации:
  - снимается hook, обнуляются ссылки;
  - `traceback.clear_frames()` — при ошибке исключение хранится в Future и иначе удерживало бы веса через кадры;
  - затем `gc.collect()`, `torch.cuda.synchronize()`, `torch.cuda.empty_cache()`.
  - Декодирование и отрисовка идут на CPU уже после выгрузки.
- Повторных загрузок и кеша моделей между запросами нет. Порядок: SDPose → выгрузка → (позже) ControlNet + SDXL. SDPose и ControlNet никогда не находятся в памяти одновременно.
- CPU offload, переходы fp16 (AUD-019) и выгрузка ControlNet (AUD-003) не тронуты.
- Ошибки — понятные `ControlNetError` (HTTP 422, текст доходит до страницы):
  - веса недоступны или загрузка запрещена;
  - нехватка RAM или VRAM (`out of memory`);
  - NaN в выходе;
  - меньше 3 уверенных точек («поза не обнаружена»);
  - повреждённый эмбеддинг;
  - неверный препроцессор.
  - Во всех случаях советуется OpenPose Classic. Ресурсы освобождаются; Canny, Depth и OpenPose Classic продолжают работать.

## 5. Что проверено

Окружение: Linux, 4 CPU, **без CUDA**; Python 3.13, torch 2.14.1; diffusers 0.36.0, transformers 4.57.3, accelerate 1.12.0, peft 0.18.0, controlnet-aux 0.0.10 (пины `engine/requirements.txt`); Node 22.22.0; Chromium (предустановленный).

| # | Проверка | Результат |
|---|---|---|
| 1 | `npm ci --ignore-scripts`, `npx tsc --noEmit`, `node scripts/build.mjs` | PASS |
| 2 | `node --test tests/*.test.mjs` | PASS 36/36 (32 прежних + 4 новых) |
| 3 | Браузер: `controlnet-browser` (с SDPose), `browser-e2e`, `history-browser`, `regional-compatibility-browser`, `ui-check`, `memory-ui`, `mobile` | PASS 7/7 |
| 4 | `python -m pytest tests` | PASS 80/80 (67 прежних + 13 новых) |
| 5 | Декодер UDP/DARK против оригинального mmpose | разница 0 |
| 6 | Notebook: `nbformat.validate`, компиляция ячеек, распаковка по логике ячейки 2, SHA-256, побайтное сравнение с `engine/`, `/health` распакованного движка | PASS, `engine_version` 1.6.2, `capabilities.sdpose` true |
| 7 | Строка проверки импортов из `bootstrap.py` (как в Colab) | `IMPORTS_OK` |
| 8 | Мутационная проверка: без `traceback.clear_frames` тест освобождения падает | тест ловит регрессию |
| 9 | Чистая установка из ZIP (`install.sh`, изолированный HOME); `update.sh` поверх реальной установки v1.6.1 с сохранёнными настройками и пресетом | PASS: `verify-package` OK, сборка, `/api/session` → 1.6.2, настройки/пресет сохранены, backup-папка создана, `node --test` в установленной копии 36/36, notebook в архиве побайтно равен отдельному |

Сценарии (`test_v162_sdpose.py`, `v162-sdpose.test.mjs`, `controlnet-browser.mjs`):
- **Загрузчик.** Настоящий загрузчик diffusers на крошечном локальном репозитории со структурой SDPose-Body. Конфиг UNet без `class_embed_type` — как предполагает override в официальном коде. Веса `class_embedding` загружены, а не случайны; `device_map` работает; VAE без декодера; выход 17×256×192; hook снят.
- **Маршрут SDPose.** Классический детектор не вызывается. Карта OpenPose (палитра OpenPose) проходит `ensure_content` и `validate_control`. В ответе `preprocessor='sdpose'`.
- **Освобождение.** Все 3 модели SDPose мертвы (weakref) после возврата, в том числе после ошибки, когда объект исключения ещё жив. 4 повторных запуска дают идентичный результат без накопления объектов.
- **Отказы.** Загрузка запрещена (OSError), OOM, MemoryError, NaN, поза не найдена, повреждённый эмбеддинг — понятные сообщения.
- **Готовая карта** не загружает SDPose.
- **Другие режимы после отказа SDPose:** OpenPose Classic с прежними параметрами (`detect_resolution=512`, `image_resolution=1024`, без кистей и лица) — и без поля, и с `openpose`; Canny без поля `preprocessor`; Depth.
- **Генерация после освобождения:** карта SDPose → настоящий `StableDiffusionXLControlNetPipeline` (крошечный SDXL, CPU offload) с OpenPose ControlNet. SDPose к началу генерации выгружен, ControlNet после задания освобождён, конвейер возвращён в базовое состояние.
- **Валидация** (движок и Node): `sdpose` с Canny или Depth, неизвестное значение, `null` — отклоняются.
- **Node:** сверка эха `preprocessor`, отказ 422 доходит до пользователя, Canny работает после отказа SDPose, история хранит `preprocessor` без карты, движок без `capabilities.sdpose` несовместим.
- **Браузер (390×844):**
  - по умолчанию OpenPose Classic;
  - выбор SDPose-OOD сбрасывает карту классического детектора, без карты генерация не отправляется;
  - запрос предобработки и генерации содержит `preprocessor: 'sdpose'`;
  - смена высоты сбрасывает карту;
  - готовая карта блокирует селектор и не запрашивает SDPose;
  - для Canny селектора нет;
  - прежние проверки трёх режимов, размеров и запоздалого ответа проходят.

Ход отладки: два первых падения новых тестов были ошибками самих тестов (неверная распаковка в тесте; точка в 3 пикселях от края тепловой карты, где DARK-уточнение неточно и в mmpose). Код движка из-за них не менялся.

## 6. Что не проверено (нужен реальный Colab T4)

1. Скачивание `teemosliang/SDPose-Body` и точный набор файлов (`unet/`, `vae/`, `decoder/decoder.safetensors`; safetensors или `.bin`). Структура взята из официального кода и ComfyUI-SDPose-OOD; репозиторий из этой среды не открывался.
2. Загрузка настоящего UNet с override в fp16 через `device_map='cuda'`, совпадение ключей `decoder.safetensors` с головой (строгая загрузка: при расхождении будет понятная ошибка, а не тихая порча).
3. Качество поз на аниме, фурри и стилизованных изображениях и подбор порога 0,3.
4. Пиковая VRAM и RAM при SDPose. Возврат VRAM после выгрузки (`memory.jsonl`: `before_control_preprocess` / `after_control_preprocess`). Отсутствие роста за 10+ подготовок подряд.
5. Время первой подготовки (скачивание весов) через протокол PENDING и время последующих.
6. Генерация Illustrious XL с картой SDPose через OpenPose ControlNet и визуальное соответствие позе.

Пошаговый план: новая среда T4 → notebook v1.6.2 → обычная генерация → SDPose «Подготовить карту» ×3 на разных изображениях (снять `memory.jsonl`) → генерация с картой → OpenPose Classic, Canny, Depth по одной генерации → снова обычная генерация с прежним seed.

## 7. Ограничения и особенности Colab Free

- Первая подготовка SDPose скачивает несколько ГБ (UNet SD2 + VAE) в кеш HF Colab и может идти минутами: страница показывает «Подготовка карты…» (PENDING). После перезапуска среды кеш теряется.
- SDPose выполняется на GPU. Без CUDA (CPU) он работает в fp32 и очень медленно, но не ломает остальное.
- Только тело (17 → 18 точек), без кистей и лица. Без детектора людей: оценивается одна фигура на всё изображение (как в эталоне без YOLO). Для нескольких персонажей результат не гарантирован.
- Изображение вписывается в 3:4. Очень широкие кадры уменьшают фигуру.
- Пик RAM ожидается небольшим (веса через mmap сразу на GPU), но SDXL при этом лежит в RAM (≈7 ГБ fp16). Если RAM Colab уже на пределе, возможна ошибка RAM — она выводится понятным сообщением.
- Внутренняя папка архива — по-прежнему `YOISAKI_AI_STUDIO_V1.4.0_LOCAL_EDITION` (путь совместимости `update.sh`).
