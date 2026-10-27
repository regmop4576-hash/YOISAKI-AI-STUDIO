# YOISAKI CONTROLNET v1.6.0 — изменения и проверка

Дата: 25 октября 2026. Сайт **v1.6.0**, движок **v1.6.0**.
База: предоставленный ZIP сайта v1.5.4 и notebook движка v1.5.3. Встроенный пакет исходного notebook совпадал с engine/ исходного ZIP побайтно.

## Реализовано

Существующая панель ControlNet сохранена. Добавлены подготовка и preview карты рядом с исходным изображением, режим готовой карты, русские подсказки. Смена типа, файла, размеров или prepared сбрасывает карту; идентификатор операции предотвращает применение устаревшего ответа.

Предобработка через прежний Node API и аутентифицированный FastAPI: `/api/gpu/controlnet/preprocess` → `/controlnet/preprocess`. Выполняется на CPU в том же однопоточном executor, что и задания, без второй очереди генерации. Во время активной очереди предобработка явно отклоняется.

- OpenPose: body detector controlnet_aux; используется только body checkpoint lllyasviel/Annotators. Без пальцев/лица. Пустой результат — ошибка. Антро не гарантируется.
- Canny: настоящая cv2.Canny, внутренние пороги 100/200, переменные YOISAKI_CANNY_LOW/HIGH; без новых слайдеров.
- Depth: настоящая Depth Anything V2 Small через Transformers; float32 CPU, eval/inference_mode, нормализация конечного ненулевого диапазона. Это не grayscale.
- PNG/JPEG/WebP, EXIF orientation, лимиты размера/пикселей, lossless PNG-карта. Вписывание с полями без растяжения. Подготовленные карты доступны для всех трёх типов.

В existing `/generate` передаётся snapshot карты и параметров конкретного задания. Strength → controlnet_conditioning_scale; Start/End → control_guidance_start/end. Валидируется 0 ≤ Start < End ≤ 1, Strength 0–2. По умолчанию для новых настроек 0.8/0/1; сохранённые валидные параметры не изменяются.

Используется StableDiffusionXLControlNetPipeline.from_pipe с переиспользованием базовых модулей. Не вызывается второй from_pretrained для базового checkpoint. Сохранены prompt embeddings, negative prompt, seed, sampler/scheduler, размеры, CFG, steps, batch 1–2 и текущая загрузка LoRA. Regional + ControlNet явно запрещены указанным сообщением. При ошибке ControlNet нет отката к обычной генерации.

## Модели и зависимости

| Назначение | Модель |
|---|---|
| OpenPose ControlNet | xinsir/controlnet-openpose-sdxl-1.0 |
| Canny ControlNet | diffusers/controlnet-canny-sdxl-1.0 |
| Depth ControlNet | diffusers/controlnet-depth-sdxl-1.0-small, fp16 variant |
| Pose detector | lllyasviel/Annotators, body_pose_model.pth |
| Depth estimator | depth-anything/Depth-Anything-V2-Small-hf |

Добавлены прямые pins: controlnet-aux==0.0.10, opencv-python-headless==4.11.0.86, timm==1.0.22. Их зависимости устанавливает pip (включая torchvision/scipy/scikit-image/einops). Pins PyTorch/CUDA не заменялись; Diffusers 0.36.0, Transformers 4.57.3, Accelerate 1.12.0 и остальные исходные pins сохранены. JS dependency versions не изменены. bootstrap сохраняет исходный запрет замены Colab Torch через constraint.

ControlNet weights загружаются с use_safetensors=True/FP16. OpenPose detector использует официальный .pth body checkpoint библиотеки controlnet_aux. Модели не включены в ZIP, скачиваются только при использовании; кеш на диске среды Colab. Первый запуск может занять несколько минут.

Проверка архитектуры ControlNet: in_channels, block_out_channels, addition_embed_type=text_time против базового SDXL UNet. Это не подтверждение визуального качества: перечисленные ControlNet обучены для SDXL; качество на конкретном Illustrious/WAI checkpoint требует реального прогона. Small Depth имеет ограничения детализации; выбранная Depth Anything карта может отличаться по распределению от MiDaS, использованной в примерах автора ControlNet.

Источники API/моделей:
- https://huggingface.co/docs/diffusers/v0.36.0/en/api/pipelines/overview
- https://huggingface.co/xinsir/controlnet-openpose-sdxl-1.0
- https://huggingface.co/diffusers/controlnet-canny-sdxl-1.0
- https://huggingface.co/diffusers/controlnet-depth-sdxl-1.0-small
- https://huggingface.co/depth-anything/Depth-Anything-V2-Small-hf

## Память и сохранённая архитектура

Одна ControlNet за раз, lazy loading. После каждого ControlNet задания (успех, отмена или исключение) finish_job возвращает обычный SDXL wrapper с теми же базовыми модулями, удаляет offload hooks прежнего wrapper, освобождает ControlNet, выполняет GC/empty_cache и восстанавливает CPU offload. При ошибке загрузки сбрасывается adapter. Повторная ControlNet генерация заново загружает веса из дискового кеша; это осознанный компромисс скорости и удерживаемой памяти.

Изображения закрываются, временные detector/tensors не кешируются. Сохранены allocator policy, MemoryLog, JobProfiler, results ACK/TTL, исходные lifecycle/error recovery. В MemoryLog добавлены controlnet component и этапы before/after_controlnet_load, after_controlnet_release, before/after_control_preprocess; after_decode и after_cleanup остаются.

**Замеров RAM/VRAM настоящей модели нет. Устранение утечки и пригодность всей нагрузки для T4 не заявляются.** CPU mock проверяет лишь освобождение Python-ссылок и переиспользование базового модуля.

Побайтно проверено сохранение 13 критичных файлов: globals.css, RegionalControl.tsx, regional.ts, inference/regional.py, prompt_encoding.py, allocator_policy.py, memory_profiler.py, results.py, server/history.mjs, server/storage.mjs, storage/gallery.ts, JobHistory.tsx, Editor.tsx.

## Фактические проверки

| Проверка | Статус | Результат / предел |
|---|---|---|
| TypeScript `npm run typecheck` | PASS | tsc --noEmit, ошибок нет |
| Production build `npm run build` | PASS | штатный React/esbuild build |
| Next.js production build | NOT TESTED | Next.js отсутствует в исходном package.json/runtime; миграция не выполнялась |
| ESLint | NOT TESTED | lint script/config отсутствует в исходнике; новый lint toolchain не добавлялся |
| Node tests `npm test` | PASS | 26/26, включая queue/gallery/history/ACK/LoRA transport/ControlNet |
| Mobile browser ControlNet | PASS | Chromium 390×844; три режима, preview, missing map, type/size invalidation, stale async response, disabled mode |
| Browser generation/gallery regression | PASS | теги LoRA, полный prompt, preview, download, gallery reload; GPU транспорт синтетический |
| Python syntax | PASS | AST всех engine .py и всех исполняемых ячеек notebook |
| Notebook JSON/schema | PASS | nbformat.validate; SHA256 payload; встроенные файлы совпадают с engine/ |
| Python CPU tests | PASS | 33 passed; 3 недоступных теста исключены явно, см. ниже |
| Python API/import/schema | PASS | FastAPI/Pydantic, auth, параметры, ошибка изображения, health v1.6.0 |
| Canny preprocessing | PASS | настоящий OpenCV CPU, детерминированность и вписывание с полями |
| Готовые карты OpenPose/Canny/Depth | PASS | CPU, декодирование/resize/проверка пустой карты |
| Автоматический OpenPose neural detector | NOT TESTED | нет Torch и скачанных весов; реализация присутствует |
| Автоматический Depth neural estimator | NOT TESTED | нет Torch/Transformers и скачанных весов; реализация присутствует |
| ControlNet loading / pretrained inference | NOT TESTED | нет Torch/Diffusers/CUDA/весов в среде проверки |
| Pipeline transition integration contract | PASS | mock: shared base module и освобождение ControlNet после каждого режима; не настоящий Diffusers inference |
| LoRA + ControlNet real inference | NOT TESTED | сохранены алгоритм загрузки и параметры; требуется CUDA/framework validation |
| ControlNet disabled | PASS | UI/API contract, обычная конфигурация; реальная diffusion генерация не проверена |
| OpenPose enabled | PASS | UI/API request/map contract; neural/GPU отдельно NOT TESTED |
| Canny enabled | PASS | UI/API + реальный CPU preprocessing; GPU отдельно NOT TESTED |
| Depth enabled | PASS | UI/API/prepared-map contract; neural/GPU отдельно NOT TESTED |
| Invalid/missing image and Start/End | PASS | Node/Python/browser validation |
| Regional Control conflict | PASS | запрос отклоняется, алгоритм Regional не изменён |
| Older engine mismatch | PASS | 1.5.x и отсутствие capability отклоняются |
| RAM/VRAM T4/repeated real inference | NOT TESTED | оборудования CUDA нет; не выдуманы измерения |
| Реальный Android Termux / Cloudflare | NOT TESTED | браузер/локальный Node проверены на Linux, не на телефоне |

Python command: `PYTHONPATH=<validation-deps> python -m pytest tests/test_controlnet.py tests/test_memory.py tests/test_engine.py tests/test_engine_regional.py -q -k 'not panel_no_gpu and not real_http_process and not job_protocol_with_test_double'`.
Три исключения: Panel требует ipywidgets; отдельный subprocess требует установленного uvicorn/FastAPI в своём окружении; job test double импортирует torch. Torch-зависимые test_routing.py/test_diffusers_cpu.py/test_prompt_fidelity.py также NOT TESTED. При расширенной попытке их запуска обнаружены именно отсутствующие зависимости; это не записано как PASS. Обнаруженные устаревшие test expectations версии/body limit обновлены, затронутые CPU-проверки повторены успешно. Предупреждение Starlette об устаревшем anyio alias не мешает тестам.

## Необходимые сопутствующие изменения

- Body limit Node/FastAPI поднят до 12 MiB, карта ограничена 8 MiB base64, proxy JSON response до 12 MiB. Иначе исходный лимит 1.5 MiB отклонял PNG-карты.
- Для preprocessing endpoint timeout 300s upstream / 310s browser. Прежние таймауты генерации не изменены.
- Allowlist proxy разрешает только новый фиксированный preprocessing endpoint; Bearer/Cloudflare/локальная session architecture сохранены.
- ACK recognition расширен с 1.5.x на 1.6.0: иначе готовые результаты новой версии не освобождались бы по прежнему ACK пути.
- Обновлены версии startup, diagnostics guards/UI и health. Сайт требует ровно 1.6.0 и capability controlnet=true.
- Source-only ZIP не содержит dist/node_modules/build-meta; install.sh собирает приложение при отсутствии dist. Внутренний каталог ZIP сохранён с legacy именем 1.4.0 для существующего updater. package-manifest пересчитан.

## Проверка в настоящем Colab

Запустить новый notebook на T4 и подключить сайт v1.6.0. На одном checkpoint проверить обычную генерацию, Canny, OpenPose, Depth, по 3 повторения, переключение типов, ControlNet OFF, LoRA (фиксированный seed), batch 1/2, отмену и ошибку. Начать с 512–768 px / batch 1; это рекомендация для проверки, не изменение defaults/лимитов.
Сравнить memory.jsonl до загрузки, после загрузки, after_decode, after_controlnet_release, after_cleanup. Проверить качество выбранного Illustrious checkpoint отдельно. Если Colab убьёт процесс из-за системного OOM, Python не сможет перехватить SIGKILL; сайт покажет потерю соединения, не ложный успех.

## Точные изменённые / новые файлы

- `CHANGELOG_RU.md`
- `README_RU.md`
- `colab/YOISAKI_ENGINE_V1.6.0_CONTROLNET.ipynb`
- `docs/CHANGELOG_RU.md`
- `docs/TERMUX_UPDATE_RU.md`
- `engine/bootstrap.py`
- `engine/diagnostics/runner.py`
- `engine/diagnostics/ui.py`
- `engine/inference/controlnet.py`
- `engine/inference/text2img.py`
- `engine/panel.py`
- `engine/requirements.txt`
- `engine/stress_memory.py`
- `engine/worker/direct_server.py`
- `engine/worker/memory.py`
- `install.sh`
- `package-lock.json`
- `package.json`
- `scripts/service.mjs`
- `server/app.mjs`
- `server/controlnet.mjs`
- `server/index.mjs`
- `server/release.mjs`
- `server/upstream.mjs`
- `src/app/engine/page.tsx`
- `src/components/Generator.tsx`
- `src/components/SettingsModal.tsx`
- `src/components/Shell.tsx`
- `src/lib/controlnet.ts`
- `src/lib/i18n.ts`
- `src/stores/studio.ts`
- `tests/backend.test.mjs`
- `tests/browser-e2e.mjs`
- `tests/controlnet-browser.mjs`
- `tests/controlnet.test.mjs`
- `tests/fixtures/control-reference.png`
- `tests/history-browser.mjs`
- `tests/history.test.mjs`
- `tests/regional-compatibility-browser.mjs`
- `tests/regional-compatibility.test.mjs`
- `tests/regional.test.mjs`
- `tests/result-ack.test.mjs`
- `tests/test_controlnet.py`
- `tests/test_engine.py`
- `tests/ui-check.mjs`
- `package-manifest.json` — пересчитан для итоговой поставки.
- `YOISAKI_CONTROLNET_V1.6.0_CHANGELOG.md` — этот отчёт.

Заменён bundled notebook v1.5.3 на v1.6.0; отдельный output notebook идентичен bundled. Исторические отчёты прежних релизов сохранены с исходными номерами как история, не как активная версия.
