# YOISAKI AI STUDIO v1.7.1 UI FIX — результаты проверки

Дата: 26 октября 2026. Источник — предоставленный исправленный CloudCompute ZIP. Это результаты текущего прогона, а не переписанные результаты прежнего аудита.

## Итог

**46 Node-тестов + 150 Python-тестов прошли.** TypeScript и production-сборка прошли. Браузерные сценарии, мобильные размеры, установка/обновление/откат и проверка сохранности данных прошли. В финальном наборе автоматических тестов: **0 failed, 0 skipped**. Python сообщает 112 предупреждений сторонних библиотек (deprecation, CPU-only и optional modules), они сохранены в журнале.

**Реальная GPU-генерация и физический Android не проверены.** Синтетический upstream, тестовая подмена CUDA в отдельных тестах и маленькие CPU Diffusers-компоненты не являются испытанием арендованного GPU.

## Среда

- Linux x86_64, Python 3.12.14, Node.js 24.22.1.
- PyTorch 2.10.0+cpu, torchvision 0.25.0+cpu; `torch.cuda.is_available() == False`.
- FastAPI 0.115.12, uvicorn 0.34.2, pydantic 2.11.4.
- Diffusers 0.36.0, transformers 4.57.3, accelerate 1.12.0, peft 0.18.0.
- Pillow runtime 12.3.0, pytest 9.1.1, Playwright 1.56.1 с Chromium headless shell.
- Docker и nvidia-smi отсутствуют.
- Тестовые зависимости установлены в отдельный venv. Этот CPU-venv не включён в ZIP и не заменяет CUDA-зависимости CloudCompute.

## Финальные команды и результаты

Команды запускаются из корня проекта. `PY` означает Python тестового venv с engine/requirements.txt и pytest/httpx/ipywidgets. Логи находятся в `docs/verification/ui-fix/`.

| Проверка | Результат | Доказательство |
|---|---|---|
| `npm ci --no-audit --no-fund` | PASS: зависимости установлены, исходные версии сохранены | Текущий lockfile; build/typecheck/test |
| `npm run typecheck` | PASS, exit 0 | typecheck.log |
| `npm run build` | PASS, production dist создан | build.log |
| `npm test` | **46 passed / 0 failed / 0 skipped** | node-tests.log |
| `OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 $PY -m pytest -q tests` | **150 passed / 0 failed / 0 skipped**, 112 warnings, 223.97 s | python-tests-final.log |
| `$PY -m pytest -q tests/test_ui_release_metadata.py` | PASS: FastAPI metadata/auth, 1 test; также входит в 150 выше | python-metadata.log |
| `node tests/providers-browser.mjs` | PASS: обе формы, switching, адреса, токены, RU/EN, reload, ошибки, 360/390/430 px | providers-browser.log |
| `node tests/browser-e2e.mjs` | PASS: connect, LoRA tags, request, result, preview, download, gallery, reload | browser-original.log |
| `node tests/img2img-browser.mjs` | PASS: upload/crop/denoise/LoRA, запрос Img2Img, результат в галерее, editor Img2Img, Text2Img regression | img2img-browser.log |
| `node tests/controlnet-browser.mjs` | PASS: 3 типа, SDPose selector/routing, карта/preview/invalidation/старый async response | controlnet-browser.log |
| `node tests/ui-check.mjs` | PASS: 390 px touch и 1280 px, маски/undo/reset, режимы/requests/overflow | ui-check.log |
| `node tests/mobile.mjs` с production-сервером на 3000 | PASS: Generate/Edit/Models/GPU/Gallery и Settings при 360/390/430 px | mobile.log, startup.log |
| Python `py_compile` | PASS: 27 исходных .py в engine/ и cloudcompute/ | syntax.log |
| `bash -n` | PASS: 11 корневых/cloudcompute shell scripts | syntax.log |
| `$PY -m pip check` | PASS: No broken requirements found | pip-check.log |
| `node scripts/verify-package.mjs` | PASS: все включённые файлы соответствуют манифесту | package-integrity.log |
| `node scripts/build-identity.mjs` | PASS: версия и SHA-256 исходников/assets совпадают | build-identity.log |
| Полный update + rollback на реальном локальном процессе | PASS: 1.7.0 → 1.7.1 на 3000, backup кода/данных, запуск, сохранность, откат к 1.7.0 | update-integration.log |
| Подмена исходника и production JS в изолированной тестовой установке | PASS: обе устаревшие/изменённые сборки отклонены | update-integration.log |
| Сравнение с исходным ZIP | PASS: 3 ранее исправленных CloudCompute-файла и все engine/inference/*.py побайтно неизменны | changed-files.json; раздел предыдущего аудита в UI_FIX_REPORT |
| Проверка embedded Colab engine/checksum | PASS в Python suite: встроенные bytes соответствуют engine/, checksum корректен | python-tests-final.log |

## Что именно проверяют новые Node-тесты

`tests/providers.test.mjs` проверяет настоящий локальный HTTP API с тестовой заменой только удалённого GPU:

1. Раздельные endpoint-конфигурации, выбор провайдера после перезапуска, отсутствие auto-connect.
2. Отсутствие токенов в status, diagnostics, settings, state.json и его backup.
3. Отказ при несовпадении provider у connect, обязательный токен после переключения.
4. Запоздалые health/refresh старой сессии не возвращают старого провайдера и не перезаписывают новый статус.
5. Отмена старого задания не уходит новому провайдеру.
6. CloudCompute public HTTPS policy, запрет private IP/DNS rebinding.
7. Независимые версии, legacy health без api_version и честное отсутствие hardware data.

`tests/https.test.mjs` использует настоящий локальный HTTPS-сервер с тестовым сертификатом и внедрённым тестовым DNS. Для Colab и CloudCompute проверены Bearer, запрет redirects, 401, malformed JSON и timeout. В production остаются system TLS validation и public DNS pinning; тестовые localhost/CA не входят в рабочую конфигурацию.

## Что проверяют Python-тесты

Реальная FastAPI app/lifespan, авторизация, health, metadata, недопустимые requests, реальный отдельный HTTP worker-процесс, каталог моделей, очередь/результаты/ACK, memory lifecycle, ControlNet/SDPose маршрутизация, Img2Img и Regional. Часть тестов использует крошечные реальные Diffusers-компоненты на CPU; часть заменяет CUDA и inference тестовыми функциями. Все четыре прежние CloudCompute audit regressions входят в набор.

## Проверка обновления и данных

В отдельной временной установке запущен старый сервер 1.7.0 на 127.0.0.1:3000. Созданы контрольные данные: изображение, favorite, завершённая история, настройки, пресет, модель, LoRA tags и дополнительный пользовательский файл в каталоге кода.

Новый updater выполнен из отдельного нового архива. После обновления API вернул 1.7.1. state.json и изображение совпали с контрольными данными, backup кода сохранил пользовательский файл, backup данных содержит прежнее состояние. Проверены отказы на изменённый source/asset. Затем выполнен недеструктивный откат к прежнему коду и снова получена версия 1.7.0 при неизменных данных.

Воспроизведение: `python tests/update-release.py /путь/к/исходному.zip /путь/к/исправленному.zip`. Нужен свободный порт 3000; тест использует временные каталоги. Это Linux-проверка Bash/Node, не эмуляция Android-системных ограничений.

## Промежуточные неудачи и исправления

- Начальный typecheck выявил неверный относительный путь нового импорта package.json; исправлен, итоговый typecheck проходит.
- Старый Node-тест требовал, чтобы studio_version оставался 1.7.0. Ожидание обновлено до 1.7.1, ожидание движка сохранено 1.7.0.
- Первый полный Python-прогон: **146 passed, 3 failed**. Две проверки нуждались в актуализации provider-aware результата и текущего package-manifest. Третья выявила настоящую регрессию diagnostics: поиск literal engine_version больше не находил новую константу. Код исправлен с сохранением поддержки прежнего формата. Итоговый полный прогон — 150 passed.
- Один ранний Img2Img browser run завершился timeout при переходе в Editor. Два последующих отдельных прогона прошли, воспроизводимая ошибка приложения не подтверждена. В финальных журналах сохранены успешные прогоны; первоначальный timeout не выдаётся за PASS.
- При подготовке тестового venv параллельная установка оставила лишние Pillow 13 metadata рядом с рабочим Pillow 12.3.0. Runtime обеих итоговых CPU-проверок был 12.3.0; лишние metadata убраны из venv, финальный pip check проходит. Пакет проекта/requirements не менялись.

## Неприменимо / не выполнено

| Проверка | Статус и причина |
|---|---|
| `next build` | **N/A**: в предоставленном проекте нет Next.js runtime/dependency; фактическая production-сборка esbuild прошла |
| ESLint | **N/A**: eslint script/config/dependency в проекте отсутствуют; новые зависимости ради фиктивного lint не добавлялись |
| Android + Termux на физическом телефоне | **NOT RUN**: устройство недоступно; Bash/Node update проверен на Linux |
| GPU CloudCompute / Google Colab | **NOT RUN**: GPU/учётные данные инстанса отсутствуют |
| Реальные SDXL/Illustrious веса, GPU Text2Img/Img2Img/LoRA/ControlNet/Regional | **NOT RUN**: synthetic + CPU checks не заменяют GPU приёмку |
| Docker image build/Compose/NVIDIA Container Toolkit | **NOT RUN**: Docker/NVIDIA отсутствуют; прежняя deployment-реализация сохранена |
| Публичный Cloudflare Tunnel в реальном инстансе | **NOT RUN**: проверены transport/launcher tests, не публичный GPU endpoint |
| GPU Face Fix/Inpaint | **NOT SUPPORTED** текущим engine; локальная работа масок и областей лица сохранена |

В ZIP не включены реальные токены, модели, данные пользователя и тестовый venv. Скриншоты с SYNTHETIC GPU показывают проверку интерфейса, а не обнаруженную видеокарту.
