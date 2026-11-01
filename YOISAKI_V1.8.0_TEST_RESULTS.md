# YOISAKI v1.8.0 — TEST RESULTS

Дата: 29 октября 2026, Иркутск. Финальная production-сборка сайта и встроенный Colab-пакет проверены. Реальная Tesla T4 отсутствует.

## Статические проверки

- `npm run typecheck` — PASS.
- `npm run build` — PASS, production v1.8.0.
- `node scripts/build-identity.mjs` — PASS, fingerprint исходников и статических outputs совпадает.
- Python compileall двух engine trees и AST всех кодовых ячеек notebook — PASS.
- nbformat structure — PASS; outputs/exec counts очищены.
- SHA-256 встроенного ZIP notebook и сравнение каждого из 27 embedded files с Colab-исходниками — PASS.
- Публичный контракт AdapterRequest, ограничения размера, mask/face validation и capabilities проверены тестами.
- `source-verification.json`: исходные SHA-256, неизменность allocator policy и CloudCompute startup/Docker, соответствие embedded package.

## Node / HTTP / mocked upstream

`npm test`: **143 passed, 0 failed, 5 skipped** (148 записей runner, включая пропуски/подтесты). Пропуски относятся к прежним интеграциям, зависящим от отдельной внешней validation environment. Лог: `validation/node-tests.log`.

Проверены новый request contract, сохранение строк промпта/negative/seed/LoRA, отказы для несовместимых параметров, удаление source/mask base64 из истории, совместимость API 1.7.0, старые операции модели/истории/галереи, Drive/CloudCompute через существующие test doubles. Несколько исторических expected website/engine versions обновлены до текущего релиза; контрактные проверки не удалены. Реальные CloudCompute, OAuth и Drive-сессии здесь не проверялись.

## Python / реальные CPU-компоненты и mocked hardware

Финальный набор: **59 passed, 0 failed**, около 66 секунд. Команда включает:

```
python -m pytest tests/test_v170_img2img.py tests/test_controlnet_diffusers_cpu.py tests/test_prompt_fidelity.py tests/test_engine_regional.py tests/test_memory.py tests/test_v180_editor.py -q
```

Лог: `validation/regression-python.log`. Предупреждения — deprecation в зависимостях, намеренная CPU-offload проверка вместо CUDA, тестовые короткие CLIP context и повторное подключение PEFT в тестах; не GPU failures.

Текущий новый редакторский набор отдельно: **8 passed** на engine сайта и **8 passed** на Colab engine. Это перекрывающиеся проверки, их нельзя складывать с 59. Логи: `editor-python.log`, `colab-editor-python.log`.

Реально выполнено:

- Pillow decoding, проверка EXIF rotation, PNG/JPEG MIME mismatch, corrupt/oversized input, empty/transparent/mismatched mask и некорректные face bounds.
- Crop/letterbox/inverse scaling на неравностороннем источнике; исходный размер результата, точное совпадение RGBA вне поддержки маски и сохранение alpha; нулевая растушёвка на границе.
- Настоящие `StableDiffusionXLPipeline`, `StableDiffusionXLImg2ImgPipeline` и `StableDiffusionXLInpaintPipeline` Diffusers 0.36 со случайными tiny SDXL weights на CPU.
- Последовательность Text2Img → Img2Img → Inpaint → Face Fix → Inpaint → Face Fix → намеренная отмена → успешный Inpaint, активная LoRA и её вес, общие modules/параметры, отсутствие retained editor wrappers.
- Прежние реальные tiny CPU ControlNet и Regional/prompt-fidelity проверки.

Отдельно **mocked**: в FastAPI queue/auth tests GPU readiness и inference заменены test doubles. Настоящие HTTP parsing, validation, FIFO, queued/running cancellation, failure/recovery, disk result and resource logs продолжают выполняться реально. Проверка доказывает сериализацию worker, а не безопасность параллельной работы на T4. В tiny inference обходятся загрузка checkpoint и CUDA, а `enable_model_cpu_offload` вызывается с CPU device для проверки lifecycle Accelerate hooks. Качество случайных tiny outputs не оценивалось и пользователю они как генерации не выдаются.

## Браузер / Android-sized viewport

Chromium Playwright, 390×844, mobile + hasTouch; дополнительно ширина 360. **PASS**:

- Загрузка и отображение источника, кисть/диаметр, touch drawing без прокрутки страницы.
- Ластик, Undo/Redo и full-resolution PNG mask export.
- Правильные source coordinates после Zoom 2× + Pan; совпадающие размеры source/mask в request.
- Face rectangle через touch: создание, перемещение, изменение размера, crop preview и корректные bounds.
- Default strength 0.25 и рабочее разрешение 512×512 для Face Fix.
- Сохранение prompt и LoRA weights; реальный локальный HTTP путь сайта.
- Result preview, original download availability, result download, сохранение галереи, исключение base64 source/mask из истории.
- Подтверждение ACK получения результатов v1.8; отсутствие horizontal overflow и pageerror.
- Прежний Img2Img сценарий с centre crop, параметрами, галереей и Text2Img regression — PASS отдельным скриптом.

Логи: `editor-browser.log`, `img2img-browser.log`. Браузерные снимки использованы для внутренней визуальной проверки. **GPU upstream синтетический**; одноцветный квадрат является fixture, не результатом pretrained inference. Физическое Android-устройство не подключалось.

## Реальный GPU

**NOT RUN / UNVERIFIED**: Tesla T4, Colab Free RAM/VRAM, pretrained Illustrious, визуальное качество Inpaint/Face Fix, точность identity, CUDA OOM recovery, продолжительные mixed-mode серии. Причина: нет доступного CUDA GPU и полноразмерного checkpoint. Ни synthetic browser fixture, ни tiny CPU output не являются real GPU evidence.

## Evidence

`validation/`: финальные логи, environment.json, cpu-resources.json, source-verification.json, build identity и SOURCE_CHANGES.diff. Все новые тесты поставляются в `tests/`; установленный dependency cache и тестовая venv в релиз не включены. Отдельный verification ZIP содержит эти evidence и три отчёта.
