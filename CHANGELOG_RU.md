# v1.7.1 CLOUDCOMPUTE UI FIX

Раздельные провайдеры, сохранение адресов, изоляция токенов, единая версия студии, независимые метаданные движка/API, проверка сборки и безопасное обновление Termux. См. YOISAKI_V1.7.1_UI_FIX_REPORT.md.

# Выпуск CloudCompute Deployment 1.7.1

Сайт и протокол движка не меняются: v1.7.0. Добавлен дополнительный способ запустить тот же YOISAKI ENGINE на арендованном GPU CloudCompute.ru. Google Colab остаётся рабочим: блокнот и папка `engine/` не изменены ни на байт. Полный отчёт: `YOISAKI_V1.7.1_CLOUDCOMPUTE_REPORT.md`. Инструкция для Android: `docs/CLOUDCOMPUTE_INSTALL_ANDROID_RU.md`.

- `start-cloudcompute.sh` / `stop-cloudcompute.sh` / `check-cloudcompute.sh` / `fetch-models-cloudcompute.sh` выполняются на сервере.
  - Режим Docker (`Dockerfile`, `docker-compose.yml`) или native venv на постоянном диске.
  - Повторный запуск не переустанавливает зависимости и не скачивает модели заново.
- Подключение как в Colab: туннель Cloudflare, ссылка `https://*.trycloudflare.com/#token=…`. Сервер слушает только 127.0.0.1, токен новый при каждом запуске и не пишется в журналы.
- PyTorch 2.10.0 + CUDA 12.8: ядра для T4 (sm_75), RTX 3060/3090/A5000 (sm_86) и RTX 5060 Ti (sm_120). Перед запуском проверяется совместимость GPU и выполняется пробное fp16-вычисление.
- Данные в одной папке (по умолчанию `/workspace/yoisaki-data`). Структура `models/{checkpoints,loras,vae,controlnet}` та же, что на Google Drive. Кэш Hugging Face, результаты, журналы и диагностика лежат там же.
- На реальном GPU CloudCompute не проверялось (см. отчёт).

# Текущий выпуск: v1.7.0 Img2Img Edition

Сайт и движок: v1.7.0. Подключён настоящий Image-to-Image; интерфейс AMBER CORE, Text2Img, ControlNet, SDPose-OOD, Regional Control, очередь, история и галерея сохранены. Полный отчёт: `YOISAKI_V1.7.0_IMG2IMG_REPORT.md`.

- Вкладка IMG2IMG на странице «Генерация» и в «Редакторе» отправляет настоящие задания: исходник, Denoise, prompt/negative, seed, steps, CFG, sampler/scheduler, batch, активные LoRA, Regional Control, ControlNet.
- Движок: `inference/img2img.py` — `StableDiffusionXLImg2ImgPipeline.from_pipe()` поверх уже загруженных компонентов (без второй копии весов, dtypes fp16 сохраняются); с ControlNet — `StableDiffusionXLControlNetImg2ImgPipeline` с прежним одноразовым жизненным циклом ControlNet; после задания возврат к базовому конвейеру.
- Протокол: `mode/kind: 'img2img'`, `init_image` (data URL, уже вписанный в Width×Height), `denoising_strength` (0 < x ≤ 1, `int(steps×x) ≥ 1`); `/health` объявляет `capabilities.img2img`; сайт 1.7.0 принимает только движок 1.7.0. Запросы Text2Img не изменились.
- Прогресс считает реально выполняемые шаги `int(steps × Denoise)`. История и галерея хранят SHA-256 исходника вместо base64.

# Выпуск v1.6.2 SDPose Edition

Сайт и движок: v1.6.2. Добавлен только препроцессор позы SDPose-OOD в существующий ControlNet; Canny, Depth, OpenPose Classic, очередь, галерея, LoRA и интерфейс AMBER CORE не менялись. Полный отчёт: `YOISAKI_V1.6.2_SDPOSE_REPORT.md`.

- Панель ControlNet, тип OpenPose: «Препроцессор позы» — OpenPose Classic (по умолчанию) или SDPose-OOD (стилизованные, аниме, фурри, сложные позы). Карта — OpenPose-18 тела для того же OpenPose ControlNet.
- Движок: `inference/sdpose.py` — SDPose-Body (`teemosliang/SDPose-Body`), fp16 на GPU только на время подготовки карты, затем полная выгрузка (ссылки, gc, `torch.cuda.empty_cache()`); без mmpose/mmcv и без CLIP text encoder.
- Протокол: необязательное поле `preprocessor` (`openpose` | `sdpose`) в предобработке и в `controlnet_config`; `/health` объявляет `capabilities.sdpose`; сайт 1.6.2 принимает только движок 1.6.2.
- Понятные ошибки: недоступные веса, нехватка RAM/VRAM, NaN, поза не найдена; остальные режимы продолжают работать.

# Выпуск v1.6.1 ControlNet Stability Fix

Сайт и движок: v1.6.1. Только исправления ошибок по независимому аудиту v1.6.0; архитектура, интерфейс AMBER CORE и зависимости не менялись. Полный отчёт: `YOISAKI_V1.6.1_STABILITY_REPORT.md`.

- AUD-001: Strength/Start/End приводятся к float перед Diffusers (Strength 0/1/2 больше не вызывают TypeError).
- AUD-019 (найдено при исправлении): `from_pipe()` больше не переводит общие fp16-модули SDXL и ControlNet в fp32.
- AUD-004: Canny загружает официальный fp16-вариант safetensors.
- AUD-003: ControlNet не копируется GPU→RAM перед освобождением (нужны замеры на T4).
- AUD-002: история и галерея хранят SHA-256 карты вместо base64; миграция данных v1.6.0 без потерь; state.json не перезаписывается без изменений.
- AUD-006: предобработка ControlNet возобновляется ответом PENDING, без обрыва по таймауту браузера/Cloudflare.
- AUD-007: ограниченная очистка завершённых записей движка (более 100 заданий за сессию).
- AUD-008 / AUD-012: бинарные карты Canny; надёжная отбраковка однородной глубины.
- AUD-009 / AUD-015: понятные причины отказа GPU; синхронизированы версии, документация и устаревшие тесты.

# Выпуск v1.6.0 ControlNet

Отчёт: `YOISAKI_CONTROLNET_V1.6.0_CHANGELOG.md` в корне проекта.

## История прежних выпусков

# Изменения v1.5.4

- `server/history.mjs` — общие terminal статусы и retention 50.
- `server/storage.mjs` — постоянный pruning при загрузке и сериализованной записи, без изменения других данных.
- `server/app.mjs` — individual/bulk history API, проверка CONNECTION_LOST перед удалением, history metadata для UI, отдельные сведения о версиях, совместимый reconnect ACK.
- `server/release.mjs` — версия сайта и compatibility metadata.
- `src/components/JobHistory.tsx` — компактная история, корзина, подтверждаемая очистка, сохранение активных задач.
- `src/components/Generator.tsx` — подключение истории и защита от устаревших polling-ответов.
- `src/lib/engine/direct.ts` — типы metadata сайта и совместимости.
- `src/components/Shell.tsx`, `SettingsModal.tsx`, `src/app/engine/page.tsx` — только отдельные truthful версии сайта/движка.
- `server/index.mjs`, `scripts/service.mjs`, package.json/package-lock.json — версия сайта 1.5.4.
- Новые `tests/history.test.mjs`, `tests/history-browser.mjs`; пересобраны dist и integrity manifest; обновлена документация.

Python engine/Colab 1.5.3, long prompts, LoRA, Regional algorithm, CPU Offload, RAM FIX, галерея, пресеты и настройки не менялись. Внешняя логика генерации не заменялась тестовыми изображениями.
