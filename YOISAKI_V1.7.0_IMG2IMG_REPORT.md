# YOISAKI AI STUDIO v1.7.0 + YOISAKI ENGINE v1.7.0 — Img2Img Edition

База: `YOISAKI_AI_STUDIO_V1.6.2_SDPOSE_EDITION.zip` и `YOISAKI_ENGINE_V1.6.2_SDPOSE_EDITION.ipynb`. Встроенный в ZIP notebook побайтно совпадал с отдельным.

Объём работы: только настоящий Image-to-Image в существующем маршруте генерации. Не менялись:
- архитектура (React/esbuild + Node.js, FastAPI-движок);
- дизайн AMBER CORE и структура Generate / Editor / Models / Gallery / GPU;
- очередь, ACK, хранилище результатов, LoRA-загрузка, prompt encoding, Regional routing;
- предобработка ControlNet и SDPose-OOD;
- зависимости (`engine/requirements.txt`, `package.json`, кроме версии).

**На реальном GPU ничего не запускалось.** Настоящие веса SDXL/Illustrious в этой среде не загружались. Все проверки с diffusers выполнены на CPU на крошечных случайных SDXL-компонентах. Подробно — раздел 6.

## 1. Что было до изменений (краткий осмотр)

- На сайте вкладка IMG2IMG, загрузка исходника и ползунок Denoise уже были. Отправка блокировалась: `'Генерация Img2Img пока не подключена'`.
- Во вкладке IMG2IMG редактора стоял `preparationOnly`: кнопка неактивна, запросов нет.
- Node (`validateGeneration`) и движок (`AdapterRequest`, `generate()`) принимали только `mode/kind = 'text2img'`.
- В движке не было ни Img2Img-конвейера, ни поля исходного изображения.

## 2. Как работает Img2Img

Сайт:
- Вкладка IMG2IMG на странице «Генерация» (прежнее место, тот же блок) теперь отправляет настоящие задания.
- В блок добавлены строка «Исходник W × H → результат W × H», кнопка «Размер по исходнику» и строка «Шагов денойза: N из M». Других изменений интерфейса нет.
- Вкладка IMG2IMG в «Редакторе» использует те же `GenerationControls`. Режим зафиксирован на Img2Img, есть превью результата. Inpaint и Face Fix не трогались.
- Перед отправкой исходник вписывается в Width × Height (`src/lib/img2img.ts`):
  - обрезка по центру (cover), без растяжения и полей;
  - прозрачность заливается белым;
  - кодирование PNG, если data URL больше 4 МБ — JPEG 0,95.
  - Поэтому размер запроса ограничен размером генерации, а не размером загруженного файла, а латенты всегда совпадают с масками Regional и картой ControlNet.
- «Размер по исходнику» подбирает ≈1 Мп с пропорциями исходника, кратно 8, в пределах 256–1536.
- Denoise: 0,05–1. Проверка `int(Steps × Denoise) ≥ 1` выполняется на сайте, в Node и в движке.

Параметры, которые доходят до конвейера:
- prompt, negative prompt (длинные промпты через прежний `embedding_kwargs`);
- seed (CPU-генератор);
- Steps, CFG;
- Sampler/Scheduler: Euler, Euler a, DPM++ 2M, Normal/Karras;
- Width/Height (по ним вписывается исходник);
- batch 1–2: один исходник, разный шум для каждого изображения;
- Checkpoint/VAE;
- активные LoRA (прежний `prepare_adapters`, адаптеры уже загружены в общих модулях);
- Regional Control: та же маршрутизация UNet-хуком;
- ControlNet: см. ниже.

Протокол (согласован в сайте, Node и движке):
- `mode` = `kind` = `'img2img'`;
- `init_image` — data URL PNG/JPEG/WebP до 8 МБ;
- `denoising_strength` — Diffusers `strength`, 0 < x ≤ 1.
- Запросы Text2Img не изменились: новых полей в них нет. Движок отклоняет `init_image`/`denoising_strength` в Text2Img.
- `/health`: `engine_version: '1.7.0'`, `capabilities.img2img: true`. Сайт 1.7.0 принимает только движок 1.7.0 с этой capability; 1.6.2 отклоняется понятной ошибкой.

Движок (`engine/inference/img2img.py`, `text2img.py`, `controlnet.py`):
- Без ControlNet: `StableDiffusionXLImg2ImgPipeline.from_pipe(base, torch_dtype=None)`.
- С ControlNet: `StableDiffusionXLControlNetImg2ImgPipeline.from_pipe(...)` в прежнем `activate()`. Исходник передаётся как `image`, карта — как `control_image`. Жизненный цикл ControlNet тот же (AUD-003/AUD-019).
- Text2Img и Text2Img + ControlNet вызываются точно как в v1.6.2.
- Источник размера: у Img2Img-конвейера размер берётся из уже вписанного исходника. На стороне движка тоже есть обрезка по центру (LANCZOS) на случай запроса не с сайта.
- Прогресс: ETA, процент и стадия DECODING считаются по реально выполняемым шагам — `int(steps × strength)`, как в `get_timesteps()` Diffusers.
- Ошибки исходника (`Img2ImgError`) доходят до страницы как есть.

Сохранение: результат проходит прежний путь `ResultStore` → сбор в галерею Node → ACK.
- В истории и в `parameters` галереи хранятся `mode`, `denoising_strength` и SHA-256 с длиной исходника. Base64 не хранится — та же политика AUD-002, что для карт ControlNet.
- Исправлено попутно (иначе Img2Img/Text2Img на 1.7.0 ломали бы хранилище движка): ACK результатов отправлялся только движкам `1.5.x/1.6.x`. Регулярное выражение расширено до `1.[5-7]`.

## 3. Ресурсы (Colab Free, T4)

- Вторая копия весов не загружается. `from_pipe()` создаёт только лёгкий объект-обёртку над теми же UNet, VAE, обоими текстовыми энкодерами, токенизаторами и LoRA-слоями.
  - Тесты проверяют идентичность модулей, неизменное число объектов UNet/VAE и равенство байтов параметров.
- `torch_dtype=None` (AUD-019): общие fp16-модули не приводятся к fp32. Тест с fp16 подтверждает dtype и байты для обоих Img2Img-конвейеров.
- Переходы выполняются, когда модели уже выгружены на CPU после прошлого задания (`finish_job`). Пересоздание hooks `enable_model_cpu_offload()` не копирует веса.
- После каждого задания, в том числе после ошибки или отмены, `finish_job()` → `to_base()` возвращает обычный `StableDiffusionXLPipeline`. Img2Img-обёртка освобождается (weakref), ControlNet выгружается как раньше.
- VAE-кодирование исходника идёт через штатный путь Diffusers:
  - VAE на время encode временно в fp32 (`force_upcast`), как при decode в Text2Img;
  - `enable_vae_slicing/tiling` общие с базовым конвейером.
- Исходное PIL-изображение закрывается в `finally`.
- Повторные задания (Img2Img / Text2Img / Img2Img + ControlNet / batch 2, 3 цикла) не увеличивают число живых тензоров, конвейеров и `nn.Module` (тест-перепись `gc`).
- Размер POST по-прежнему ограничен 12 МБ (сайт и движок). Исходник, вписанный в ≤ 2 Мп, обычно занимает 0,5–4 МБ.

## 4. Изменённые файлы (относительно v1.6.2)

Движок:
- `engine/inference/img2img.py` — новый: проверка, вписывание исходника, Img2Img-вид, подсчёт шагов.
- `engine/inference/text2img.py` — ветка Img2Img в `generate()`, шаги прогресса, закрытие исходника.
- `engine/inference/controlnet.py`:
  - `activate(..., img2img=False)` выбирает ControlNet-Img2Img-класс;
  - `to_base()` освобождает и Img2Img-вид.
- `engine/worker/direct_server.py` — поля `init_image`/`denoising_strength`, проверка режима, шаги прогресса, `Img2ImgError`, версия, `capabilities.img2img`.
- `engine/bootstrap.py` — проверка импортов Img2Img при установке.
- `engine/panel.py`, `engine/stress_memory.py`, `engine/diagnostics/runner.py`, `engine/diagnostics/ui.py`, `engine/inference/sdpose.py` — только версия.

Сайт:
- `src/lib/img2img.ts` — новый: подготовка исходника, размер по исходнику, шаги денойза.
- `src/components/Generator.tsx` — настоящая отправка Img2Img и проверки. `preparationOnly` заменён на `lockedMode`. Освобождается blob-URL превью исходника. Экспортирован `DirectImage`.
- `src/components/Editor.tsx` — вкладка IMG2IMG подключена к движку, превью результата.
- `src/lib/i18n.ts` — три новые строки перевода.
- `server/img2img.mjs` — новый: проверка, компактная форма для истории.
- `server/upstream.mjs` — режим `img2img` в `validateGeneration`, `validateHealth` 1.7.0.
- `server/app.mjs` — компактная история, ACK для 1.7.x, тексты версии.
- `server/release.mjs` — 1.7.0 + `capabilities.img2img`.
- `server/index.mjs`, `scripts/service.mjs`, `package.json`, `package-lock.json` (только корневая версия), `Shell.tsx`, `SettingsModal.tsx`, `src/app/engine/page.tsx` — только версия.

Notebook:
- `colab/YOISAKI_ENGINE_V1.7.0_IMG2IMG_EDITION.ipynb` заменяет `…V1.6.2_SDPOSE_EDITION.ipynb`.
- Встроенный пакет пересобран из `engine/`: 25 файлов, SHA-256 `f50bf634cdd6c0fa00cab11cc35a26e45733e0ade83903581f05b0f2deea8d7c` (= `_EXPECTED`).
- Тот же сборщик воспроизводит прежний пакет v1.6.2 байт-в-байт.

Документация: `README_RU.md`, `CHANGELOG_RU.md`, `docs/CHANGELOG_RU.md`, `docs/TERMUX_UPDATE_RU.md`, `YOISAKI_V1.4.0_INSTALL_ANDROID_RU.md`, этот отчёт, `docs/verification/v170-*.txt`, пересчитанный `package-manifest.json`.

Тесты:
- Новые: `tests/test_v170_img2img.py` (13), `tests/v170-img2img.test.mjs` (4), `tests/img2img-browser.mjs`.
- В остальных тестах обновлены версия и `capabilities` тестовых двойников движка.

## 5. Что проверено

Окружение: Linux, **без CUDA**; Python 3.13, torch 2.14.1 (CPU), diffusers 0.36.0, transformers 4.57.3, accelerate 1.12.0, peft 0.18.0 (пины `engine/requirements.txt`); Node 22.22.0; предустановленный Chromium.

| # | Проверка | Результат |
|---|---|---|
| 1 | `npm ci --ignore-scripts`, `npx tsc --noEmit`, `node scripts/build.mjs` | PASS |
| 2 | `node --test tests/*.test.mjs` | PASS 40/40 (36 прежних + 4 новых) |
| 3 | Браузер: `img2img-browser` (новый), `controlnet-browser`, `browser-e2e`, `history-browser`, `regional-compatibility-browser`, `ui-check`, `memory-ui`, `mobile` | PASS 8/8 |
| 4 | `python -m pytest tests` | PASS 93/93 (80 прежних + 13 новых) |
| 5 | Мутационная проверка новых тестов (вид не освобождается; прогресс по полным шагам; strength игнорируется; `from_pipe` без `torch_dtype=None`; ACK только для 1.5/1.6; base64 исходника в истории) | каждая мутация ловится |
| 6 | Notebook: `nbformat.validate`, компиляция ячеек, распаковка по логике ячейки 2, SHA-256, побайтное сравнение с `engine/`, `/health` распакованного движка | PASS, 1.7.0, `capabilities.img2img` true |
| 7 | Строка проверки импортов из `bootstrap.py` (как в Colab) | `IMPORTS_OK` |
| 8 | Чистая установка из ZIP и `update.sh` поверх v1.6.2 | см. `docs/verification/v170-install.txt` |

Сценарии с настоящими объектами diffusers (`test_v170_img2img.py`):
- **Общие компоненты.**
  - Во время задания работает `StableDiffusionXLImg2ImgPipeline` с теми же модулями.
  - После задания — базовый конвейер, 4 offload-hooks, LoRA на месте.
  - Новых UNet/VAE нет, обёртка освобождена.
- **Шаги.** (10; 0,3) → 3, (5; 1) → 5, (20; 0,55) → 11, (4; 0,25) → 1. DECODING приходит на последнем реальном шаге.
- **Параметры.**
  - Тот же seed воспроизводит результат.
  - seed, Denoise, исходник и negative меняют результат.
  - batch 2 даёт два разных изображения.
  - Работают Euler/Karras, Euler a, DPM++ 2M/Normal и Karras.
  - Вес LoRA влияет на результат.
- **Исходник** другого размера и формата (JPEG, WebP) вписывается обрезкой по центру.
- **Img2Img + ControlNet** (`StableDiffusionXLControlNetImg2ImgPipeline`): ControlNet освобождается, неверный размер карты отклоняется. Text2Img + ControlNet по-прежнему идёт через `StableDiffusionXLControlNetPipeline`.
- **Regional Control + Img2Img** работает.
- **Повреждённый исходник и отмена** освобождают вид. Text2Img после Img2Img побитово совпадает с эталоном.
- **Повторные задания** не накапливают тензоры, конвейеры и модули.
- **fp16** сохраняется для обоих Img2Img-конвейеров.
- **Контракт запроса и маршрут `/generate`:** `total_steps` в прогрессе, текст ошибки `Img2ImgError`, 422 при Denoise без шагов, Text2Img без новых полей.

Браузер (`img2img-browser.mjs`, 390×844, синтетический движок):
- без исходника запрос не отправляется;
- превью исходника; «Размер по исходнику» 600×400 → 1256×840;
- «Шагов денойза: 10 из 30»;
- запрос содержит prompt, negative, LoRA, размер, шаги, Denoise;
- исходник ровно 1256×840;
- при 1:1 — обрезка по центру, проверенная по пикселям на границах полос (растяжение дало бы другие границы);
- слишком малый Denoise блокируется;
- результат в превью и в галерее без base64; ACK отправлен;
- Text2Img без новых полей;
- вкладка IMG2IMG редактора отправляет Img2Img и показывает результат;
- нет горизонтальной прокрутки.

Ход отладки:
- Один прежний тест подменял `activate` функцией с двумя аргументами. Вызов для Text2Img оставлен в точности прежним, Img2Img передаёт `img2img=True`.
- Падения при отладке браузерного теста были ошибками самого теста: точный текст уведомления со ссылкой и неверно рассчитанные границы полос. Код из-за них не менялся.

## 6. Что не проверено (нужен реальный Colab T4)

1. Img2Img на настоящем SDXL / Illustrious XL в fp16 на CUDA. Качество при разных Denoise.
2. Пиковая VRAM при VAE-encode исходника 1024² и 1536×1024 (VAE временно fp32) и пиковая RAM. `memory.jsonl` содержит точки `after_img2img_view` / `after_img2img_release`.
3. Отсутствие роста RAM/VRAM за 10+ Img2Img подряд на T4. На CPU это проверено переписью объектов, а не замером памяти.
4. Img2Img + ControlNet с настоящими весами xinsir/diffusers ControlNet.
5. Время задания: Img2Img выполняет только `int(Steps × Denoise)` шагов, поэтому должен быть быстрее Text2Img с теми же Steps.

План проверки:
1. Новая среда T4 → notebook v1.7.0.
2. Text2Img (seed 123) → Img2Img того же изображения: Denoise 0,3 / 0,6 / 0,9, по 3 раза (снять `memory.jsonl`).
3. Img2Img batch 2 → Img2Img + Canny → Img2Img + Regional.
4. Снова Text2Img с seed 123: результат должен совпасть с первым.

## 7. Ограничения

- Размер результата задают Width/Height; исходник обрезается по центру. Чтобы сохранить кадр целиком, нажмите «Размер по исходнику».
- Img2Img + ControlNet: исходник и карта идут в одном запросе (лимит 12 МБ). При очень крупной карте Depth возможен ответ «Слишком большой запрос».
- Inpaint и Face Fix не реализованы: вкладки редактора работают локально, как раньше.
- Внутренняя папка архива по-прежнему `YOISAKI_AI_STUDIO_V1.4.0_LOCAL_EDITION` (путь совместимости `update.sh`).
