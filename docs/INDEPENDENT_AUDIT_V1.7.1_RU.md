# YOISAKI AI STUDIO v1.7.1 — независимый аудит CloudCompute

Дата: 26 октября 2026 года. Пакет развёртывания **1.7.1**, сайт и протокол **YOISAKI ENGINE 1.7.0**. Версии не повышались.

## Итог

**Четыре CONFIRMED BUG, все четыре имеют статус VERIFIED FIX.** Изменены только три рабочих файла: `cloudcompute/install-native.sh`, `cloudcompute/fetch_models.py`, `cloudcompute/launcher.py`. Добавлены регрессионные тесты и пояснения в инструкции; манифест целостности обновлён. Новых runtime-зависимостей нет.

Исправлена обработка неудачной native-установки, граница домена при передаче токена скачивания, учёт отрицательного ответа проверки туннеля и проверка полноты скачанного safetensors. Исходная архитектура, интерфейс AMBER CORE, инференс, параметры памяти, авторизация движка, очередь и ACK не менялись.

**Готовность: исправления проверены локально; приёмка на реальном CloudCompute GPU ещё нужна.** Docker build/runtime, драйвер NVIDIA, реальная генерация и сохранность диска провайдера этим аудитом не подтверждены. Предыдущие журналы в исходном ZIP не выдаются за результаты настоящего аудита.

## Источники и границы

Основной источник — приложенный `YOISAKI_AI_STUDIO_V1.7.1_CLOUDCOMPUTE_EDITION.zip`, распакованный в исходный каталог `YOISAKI_AI_STUDIO_V1.4.0_LOCAL_EDITION`. Приложенный технический отчёт прочитан как описание автора. Приложенная Android-инструкция сопоставлена с копией `docs/CLOUDCOMPUTE_INSTALL_ANDROID_RU.md` и командами пакета.

Исследованы:

- `cloudcompute/launcher.py`: Config, prepare, child_env, write_private, request_json, verify_tunnel, Launcher, terminate, local_status, main.
- `cloudcompute/lib.sh`, `start-cloudcompute.sh`, `stop-cloudcompute.sh`, `check-cloudcompute.sh`, `fetch-models-cloudcompute.sh`, `cloudcompute/install-native.sh`.
- `cloudcompute/diagnose.py`, `cloudcompute/import_check.py`, `cloudcompute/fetch_models.py`, VERSION, requirements-cloud.txt, yoisaki.env.example.
- Dockerfile, docker-compose.yml, .dockerignore; package.json, package-lock.json, package-manifest.json; install.sh, update.sh, scripts/build.mjs, scripts/verify-package.mjs.
- `engine/worker/serve.py`, direct_server.py, models.py, results.py, memory.py, allocator_policy.py; `engine/inference/text2img.py`, img2img.py, controlnet.py, sdpose.py; bootstrap.py и Colab-пакет.
- `server/upstream.mjs`, app.mjs, release.mjs и соответствующие Node/Python тесты. Фронтенд проверен сборкой и существующими браузерными сценариями; его исходники не перерабатывались.

Номера строк ниже относятся к **исходному ZIP**, а после стрелки — к исправленной версии, где это существенно.

## Подтверждённые дефекты и проверенные исправления

### CC-001 — native-установщик мог отмечать неудачную установку успешной

- **Классификация:** CONFIRMED BUG → VERIFIED FIX.
- **Severity:** HIGH — ошибочная отметка заставляет последующие запуски пропускать восстановление зависимостей.
- **Файл / функция / строки:** `cloudcompute/install-native.sh`, `install_venv`, 51–58.
- **Причина:** группа `{ ...; }` стоит слева от `||`. Bash не применяет `set -e` внутри проверяемой группы. Последний успешный import-check маскировал ненулевой код одного из предыдущих `pip install` / `pip check`.
- **Воспроизведение:** тест `test_cc001_failed_install_never_writes_success_marker`, три параметра. Выполняется настоящий текст функции; подставной Python возвращает код 23 на выбранном шаге, остальные шаги завершаются успешно. Подменяются только интерпретатор и проверка свободного места; реальное скачивание не требуется.
- **Наблюдалось до исправления:** во всех трёх случаях installer возвращал 0 и записывал `.yoisaki-install`; тесты ожидания отказа падали.
- **Ожидается:** ненулевой код, отсутствие отметки успешной установки, возможность повторить установку.
- **Минимальное изменение:** три явных `&&` между четырьмя проверяемыми командами.
- **Регрессия:** все три варианта проходят после исправления. Отдельный `test_native_install_cache_reused_on_second_and_third_start` подтверждает, что успешная отметка по-прежнему пропускает два последующих запуска установочных команд. Это тест управления установкой с подставным Python, не полная native-установка CUDA.
- **Восстановление существующей установки:** старую ошибочно созданную отметку код сам не отличает от правильной. Для ранее неудачной установки инструкция содержит удаление только `runtime/venv/.yoisaki-install` и повторный запуск. Рабочие окружения не переустанавливаются принудительно.

### CC-003 — токен скачивания добавлялся к запросу на похожий чужой домен

- **Классификация:** CONFIRMED BUG → VERIFIED FIX.
- **Severity:** HIGH — раскрытие HF/Civitai-токена при использовании соответствующей неподходящей ссылки. Это не обход Bearer-авторизации движка.
- **Файл / функция / строки:** `cloudcompute/fetch_models.py`, `open_url`, 100–109 → 116–126.
- **Причина:** `host.endswith('civitai.com')` и аналогичная проверка Hugging Face не проверяли границу DNS-метки.
- **Воспроизведение:** `test_cc003_download_auth_requires_domain_boundary` перехватывает сформированный `urllib.request.Request` вместо обращения в сеть. Используется только строка `AUDIT_PLACEHOLDER`.
- **Наблюдалось до исправления:** `Authorization` присутствовал в запросах к `notcivitai.com` и `nothuggingface.co`; два регрессионных случая падали.
- **Ожидается:** секрет передаётся только самому домену сервиса или его настоящему поддомену.
- **Минимальное изменение:** точное равенство либо суффикс с ведущей точкой — `.civitai.com` / `.huggingface.co`.
- **Регрессия:** восемь случаев: оба сервиса, их поддомены, похожие имена и домены вида `civitai.com.example.org`. Все проходят. Старый тест unredirected Authorization также проходит.
- **Предел доказательства:** реальный секрет никому не отправлялся; наличие ошибочного заголовка доказано на объекте реального HTTP-запроса до транспорта.

### CC-004 — отрицательный результат health-проверки туннеля игнорировался

- **Классификация:** CONFIRMED BUG → VERIFIED FIX.
- **Severity:** MEDIUM — живой процесс cloudflared с ответом, не подтверждающим YOISAKI_ENGINE, не запускал предусмотренное восстановление.
- **Файл / функция / строки:** `cloudcompute/launcher.py`, `Launcher.supervise`, 354–360 → 354–359.
- **Причина:** `verify_tunnel` возвращает boolean, но supervisor сбрасывал failures в 0 после любого вызова без исключения, включая False.
- **Воспроизведение:** `test_cc004_negative_tunnel_health_triggers_restart`: процессы считаются живыми, проверка возвращает False; ожидания времени заменены счётчиком. Выполняется настоящий цикл supervisor.
- **Наблюдалось до исправления:** за более чем три интервала проверки ни stop_tunnel, ни start_tunnel не вызывались.
- **Ожидается:** три последовательных отрицательных проверки вызывают существующий механизм перезапуска.
- **Минимальное изменение:** одна строка — сброс failures только при True, иначе увеличение счётчика.
- **Регрессия:** новый тест проходит; существующий тест падения процесса cloudflared и смены URL тоже проходит. stop_tunnel удаляет старую ссылку до создания новой.
- **Предел доказательства:** это детерминированная проверка логики, а не утверждение, что такой ответ был получен на реальном CloudCompute.

### CC-005 — обрезанные данные safetensors принимались за готовую модель

- **Классификация:** CONFIRMED BUG → VERIFIED FIX.
- **Severity:** MEDIUM — повреждённая модель появляется в рабочем каталоге и затем пропускается как уже скачанная.
- **Файл / функция / строки:** `cloudcompute/fetch_models.py`, `validate` 74–87 и `finish` 90–98 → validate 75–100, finish 103–113.
- **Причина:** каталог движка проверяет заголовок/архитектуру, но не длину tensor payload. Проверка Content-Length не покрывает ответ без этого заголовка или уже неполный исходный файл.
- **Воспроизведение:** `test_cc005_truncated_tensor_payload_not_published`: заголовок LoRA указывает данные `[0,64]`, но после него записано только 4 байта. Вызывается настоящий finish.
- **Наблюдалось до исправления:** сообщение «Готово», файл переименован из `.part` в `.safetensors`, исключения нет.
- **Ожидается:** отказ от публикации в каталоге моделей.
- **Минимальное изменение:** загрузчик проверяет границы data_offsets и равенство фактического размера `8 + длина заголовка + максимальное окончание tensor payload`. Веса в RAM не загружаются; inference/model catalogue не меняются.
- **Регрессия:** обрезанный файл отклоняется; `test_cc005_complete_tensor_payload_still_published` подтверждает успешную публикацию полного файла. Существующие тесты докачки, пропуска готовых моделей, `.invalid` и свободного места проходят.
- **Предел исправления:** это проверка полноты по заголовку, не криптографическая проверка содержимого, не гарантия идентичности удалённого файла между двумя запросами и не полный валидатор всех ограничений формата.

Полные падения до исправлений сохранены в `independent-before.txt`: **7 failed, 9 passed**. Семь падений — параметризованные случаи четырёх дефектов. Исправленные тесты входят в финальные успешные прогоны.

## NO DEFECT FOUND — что проверено без обнаружения дефекта

| Область | Доказательства и ограничения |
|---|---|
| Протокол подключения | serve.py привязывает uvicorn к 127.0.0.1; cloudflared получает тот же YOISAKI_PORT. Реальный сервер с имитированной CUDA выдаёт 1.7.0 и controlnet/sdpose/img2img/regional_control/result_ack. Node validateHealth требует 1.7.0 и три основных capability-флага. |
| Формат ссылки | `https://<name>.trycloudflare.com/#token=<64 hex>` принимается настоящим parseTunnel; фрагмент превращается в Authorization на Node-сервере. Произвольные адреса, private IP и перенаправления ограничены существующим proxy. |
| Авторизация движка | 401 без токена/с чужим токеном; guard использует compare_digest. Токен создаётся secrets.token_hex(32), передаётся worker через окружение, отсутствует в CLI; state 0700, token/link 0600. Заново создаётся при полном запуске, сохраняется при восстановлении одного туннеля. TTL по времени нет — срок жизни соответствует запуску. |
| Штатные процессы | Отказ второго launcher через flock; три запуска, смена токена; падение worker вызывает остановку launcher; занятый порт не становится READY; SIGTERM удаляет token/link и останавливает worker. Это локальные процессы с подставной CUDA, не GPU-memory test. |
| Потеря связи сайта | Node tests проверяют ошибки HTTPS/DNS/auth/таймаутов, reconnect и сохранение результатов/ACK. Browser tests используют synthetic upstream. |
| Конфигурация | yoisaki.env разбирается как данные, не source. Подставной shell-код не выполняется. Уже заданные переменные имеют приоритет; проверявшееся предположение об ошибочном exit на таком override не подтвердилось. |
| Docker, статический уровень | Источник engine и cloudcompute копируется в /opt/yoisaki; Python/path согласованы; rootfs read-only, /tmp tmpfs, data/cache/home/output доступны через /data; models дополнительным ro mount. Нет ports, есть GPU reservation, tini, healthcheck и stop_grace_period. YAML разбирается. Runtime-права/Compose/NVIDIA не подтверждены запуском Docker. |
| Память | worker_environment применяется до exec так же, как в Colab. Инференс сохраняет FP16 при CUDA, CPU offload, VAE slicing/tiling, shared Img2Img modules, lifecycle ControlNet/SDPose. CPU-тесты реальных маленьких Diffusers-компонентов проходят; SDXL VRAM/RAM на видеокарте не измерялись. |
| Данные и кэш | YOISAKI_DATA_ROOT/models/{checkpoints,loras,vae,controlnet}; HF_HOME → huggingface-cache; SDPose использует HF-кэш либо существующий data/sdpose; outputs, logs, diagnostics, native venv лежат на диске данных. Модель и метка сохраняются в локальных повторных запусках. |
| Скачивания | Готовые файлы при заданном имени не скачиваются; `.part` продолжается при 206, ответ 200 начинает заново; публикация через rename. Prefetch repositories/patterns сопоставлены с inference-кодом. Реальные многогигабайтные модели не скачивались. |
| Быстрый повторный запуск | Native marker зависит от requirements и версии Python; cloudflared проверяется по SHA; Docker image — по source hash. Нет автоматического скачивания checkpoint при старте. Warmup включается только явно. Никаких обещаний секунд старта GPU нет. |
| Android | Имя ZIP и историческое имя внутренней папки верны; скрипты в исходном ZIP имеют executable mode; серверные команды отделены от Termux. Desktop не требуется. Реального Android-устройства в аудите нет. |

Фраза **NO DEFECT FOUND** означает отсутствие продемонстрированного дефекта в обозначенном объёме; она не означает сертификацию всей среды.

## CUDA, PyTorch и драйверы

Фактические pins: torch 2.10.0, torchvision 0.25.0, gdown 6.4.2. Docker base — CUDA 12.8.1 / Ubuntu 24.04, Python из этого образа ожидается 3.12. Native допускает Python 3.10–3.13. Colab не устанавливает requirements-cloud.txt.

Официальная таблица PyTorch подтверждает пару **2.10.0 / 0.25.0** и наличие варианта **cu128**. Официальный список NVIDIA относит RTX 5060 Ti к CC 12.0, RTX 3060/3090/A5000 — к 8.6, T4 — к 7.5. Проверки пакета соответствуют этим архитектурам.

`diagnose.py` получает название/CC/VRAM, проверяет compiled architectures и запускает настоящее FP16 matmul, если CUDA доступна. Отдельного сравнения номера драйвера с таблицей минимальных версий нет: `nvidia-smi` выводит его для диагностики, работоспособность проверяется CUDA-вызовами. Это не универсальный детектор совместимости всего inference workload.

Совместимость CUDA runtime и поддержка самой видеокарты драйвером — разные условия. NVIDIA приводит для CUDA 12.8 Update 1 toolkit driver 570.124.06; это не обещание поддержки любой новой карты каждым драйвером ветки 570. RTX 5060 Ti явно присутствует в supportedchips для 575.51.02. Таблицы minor-version compatibility также нельзя трактовать как разрешение использовать старый драйвер на неподдерживаемом GPU.

В аудите установлен **torch 2.10.0+cpu / torchvision 0.25.0+cpu**. Это позволяет запускать настоящий Python-сервер и маленькие CPU Diffusers-тесты; **не проверяет CUDA wheel, CUDA 12.8, RTX 5060 Ti или build архитектур sm_120**. Весь CloudCompute install/import_check на CUDA wheel остаётся непроверенным здесь. Версии engine-зависимостей закреплены как в исходнике; `pip check` в тестовой среде проходит.

Официальные источники, проверенные во время аудита:

- https://pytorch.org/get-started/previous-versions/ — пара версий и cu128.
- https://developer.nvidia.com/cuda/gpus — compute capability целевых GPU.
- https://docs.nvidia.com/cuda/archive/12.8.1/cuda-toolkit-release-notes/ — CUDA/driver и оговорки совместимости.
- https://download.nvidia.com/XFree86/Linux-x86_64/575.51.02/README/supportedchips.html — RTX 5060 Ti.

## UNVERIFIED RISK

1. **SIGKILL launcher во время незавершённого запуска.** Список children записывается в состояние после готовности worker/этапов, не атомарно с spawn. Возможность потери сведений о раннем процессе требует проверки на обычном Linux с общим PID namespace. Попытка отдельного локального сценария остановилась на проверке предусловия: PID, записанный дочерним процессом, не сопоставлялся с доступным `/proc` в управляемой среде. Это не считается воспроизведённой ошибкой приложения; эксперимент не включён в рабочие регрессионные тесты. Лог `orphan-before.txt` сохранён как неуспешный эксперимент. Четыре подтверждённых дефекта выше не зависят от него.
2. **Изменение удалённого файла между докачками / параллельные загрузчики одного имени.** Нет доказанной проверки неизменности источника через ETag/If-Range и общей блокировки downloads. Не воспроизводилось; проверка размера не заменяет checksum. Уже существующие веса не изменялись в выполненных тестах.
3. **Наследуемые cache-переменные и ограниченный диск.** child_env использует setdefault для HF_HOME; стороннее окружение может переопределить путь. Prefetch оценивает весь выбранный набор, а не только недостающие байты. Реальная комбинация провайдера/кэша/мало места не проверена, исправления без воспроизведения не вносились.
4. **Несколько пользователей и нестандартный UID в Docker tools.** Проверены declarations, не реальные mount permissions для всех UID. Нужен runtime-тест в целевой конфигурации.

## PLATFORM DEPENDENCY

- Наличие Docker daemon/Compose/NVIDIA Container Toolkit, права пользователя и GPU reservation определяются сервером.
- Исходящий интернет, DNS и доступ к Cloudflare/Hugging Face/Civitai/Google Drive — внешние зависимости.
- 50 ГБ — минимальный выбранный объём, 100+ ГБ предпочтительнее; приложение не выделяет диск. Свободное место и общий размер — разные величины: runtime предупреждает при нехватке свободных ГБ, но не гарантирует полный объём 50 ГБ.
- Сохранность data root, native venv, Docker image/layer cache и перенос между инстансами зависит от cloud storage. Docker image cache находится в storage Docker daemon, **не гарантированно в YOISAKI_DATA_ROOT**.
- `.yoisaki-data-id` помогает проверить пережитый stop/start, но не создаёт постоянный диск и не является бэкапом.
- Остановка скриптов не завершает биллинг инстанса. Фактические правила и управление оплатой следует проверять у CloudCompute; цены и UI не подтверждались этим аудитом.

## REQUIRES REAL GPU VALIDATION

На реальном инстансе выполнить preflight, затем Text2Img, Img2Img, LoRA, Regional Control и ControlNet: OpenPose Classic / SDPose-OOD / Canny / Depth. Проверить полную цепочку с Android через публичный туннель, получение PNG в галерею и ACK; отмену и потерю связи; RAM/VRAM в повторных генерациях; освобождение ресурсов при остановке. Отдельно проверить Docker с read-only rootfs, фактический driver/5060 Ti и первый/повторный native install. После stop/start самого инстанса проверить модели, кэши и метку диска.

Это перечень незавершённой приёмки инфраструктуры, а не список подтверждённых багов.

## Google Colab и неизменность

Сопоставление с входным v1.7.1 ZIP подтверждает побайтную неизменность **71 файла** в engine/, colab/, src/, server/. В частности, все 25 файлов engine/ совпадают и со встроенным архивом Colab notebook, и с соответствующими digest исходного манифеста. Сам notebook не изменён.

Отдельный исходный v1.7.0 архив в этом задании не предоставлен. Поэтому утверждение «исторический v1.7.0 и v1.7.1 совпадали до аудита» устанавливается только по внутренним данным поставки, а не по независимому сравнению двух исторических архивов. Пакетные CloudCompute requirements не участвуют в Colab bootstrap. Реальный Google Colab Free в этой среде не запускался.

## Проверки и журналы

Среда: Linux x86_64, Python 3.12.14, Node.js 24.22.1, PyTorch CPU 2.10.0, torchvision CPU 0.25.0; engine requirements как в исходнике. GPU, nvidia-smi и Docker отсутствуют. Полный список — `environment.txt`, `environment-freeze.txt`. Тестовые библиотеки установлены отдельно и не добавлены в проект.

Все команды ниже выполнялись из корня проекта. `PY` обозначает точный путь `/workspace/scratch/a49d325c271b/audit-venv/bin/python`, `SC` — `/workspace/scratch/a49d325c271b/audit-venv/bin/shellcheck`.

| Команда | Результат | Журнал |
|---|---|---|
| `python -m pytest -q tests/test_v171_independent_audit.py` до исправлений | 7 failed / 9 passed; доказательства четырёх багов | independent-before.txt |
| `python -m pytest -q tests/test_v171_cloudcompute.py` до исправлений | 35 passed / 2 skipped (не было torch) | cloud-baseline.txt |
| `python -m pytest -q tests/test_v171_independent_audit.py tests/test_v171_cloudcompute.py` после исправлений | 51 passed / 2 skipped (до установки CPU torch) | cloud-after.txt |
| `OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 $PY -m pytest -q tests/test_v171_independent_audit.py tests/test_v171_cloudcompute.py` | 56 passed / 0 failed / 0 skipped | cloud-pinned-final.txt |
| `OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 $PY -m pytest -q tests` — первый полный прогон | 146 passed / 0 failed / 0 skipped, 112 warnings, 220.15 s; три дополнительных lifecycle-теста выполнены отдельно выше | full-python-pinned.txt |
| `OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 $PY -m pytest -q tests` — финальный состав | 149 passed / 0 failed / 0 skipped, 112 warnings, 229.12 s | full-python-final.txt |
| `npm test` | 40 passed / 0 failed / 0 skipped | node-tests.txt |
| `npm ci --ignore-scripts --fetch-retries=0 --fetch-timeout=20000` | успешно, 23 packages | npm-ci.txt |
| `npm run typecheck` | успешно, exit 0 | typecheck.txt |
| `npm run build` | успешно, Production build ready | build.txt |
| `node tests/img2img-browser.mjs` | 1 сценарий PASS, Chromium mobile 390×844; synthetic upstream, не GPU | browser-img2img-final.txt |
| `node tests/browser-e2e.mjs` | 1 сценарий PASS: local API, request, result, gallery, reload; synthetic upstream | browser-e2e-final.txt |
| `$SC -x start-cloudcompute.sh stop-cloudcompute.sh check-cloudcompute.sh fetch-models-cloudcompute.sh cloudcompute/lib.sh cloudcompute/install-native.sh` | 6 файлов, exit 0, замечаний нет | shellcheck.txt |
| `bash -n <file>` для всех корневых и cloudcompute/*.sh | 11 файлов, все exit 0 | bash-syntax.txt |
| `py_compile.compile(..., doraise=True)` для cloudcompute/*.py и engine/**/*.py | 27 файлов успешно | compilation.txt |
| `$PY -m pip check` | No broken requirements found | pip-check.txt |
| `node scripts/verify-package.mjs` после обновления манифеста | успешно, exit 0, целостность OK | package-integrity.txt |
| `docker version`, `docker compose config`, `docker build -t yoisaki-independent-audit .` | NOT RUN: executable unavailable; не считать Docker validation | docker-availability.txt |
| PyYAML safe_load docker-compose.yml + assertions | 3 статических assertions PASS; не заменяет Compose | compose-static.txt |
| Скачивание pinned cloudflared + SHA-256 + `--version` | checksum совпал, cloudflared 2026.9.3 | cloudflared-download.txt, cloudflared-hash.txt |
| `$PY /workspace/scratch/a49d325c271b/probe_tunnel.py` | настоящий cloudflared: DNS network unreachable; launcher exit 3, token/link удалены | public-tunnel-attempt.txt |

Последний сценарий использовал настоящий HTTP worker, но GPU health — TEST_DOUBLE_NOT_REAL_GPU. Cloudflared завершился при запросе к api.trycloudflare.com из-за недоступной сети DNS. Это **PLATFORM DEPENDENCY среды аудита**, не ошибка параметров launcher и не доказательство отказа CloudCompute.

Начальные попытки полного pytest без зависимостей дали отсутствие pytest, затем пять collection errors из-за отсутствующего diffusers; после установки requirements эти препятствия сняты. Первый browser run не нашёл executable Chromium; после `npx playwright install chromium --only-shell` оба сценария прошли. Все первоначальные логи сохранены, но не считаются финальными продуктовыми сбоями. Отдельный эксперимент orphan остановился на некорректном предусловии PID; см. UNVERIFIED RISK.

## Поставка и воспроизведение

Исправленный ZIP сохраняет исходный layout, имена и версии. Старые regression tests не удалены и не изменены; новый файл — `tests/test_v171_independent_audit.py`. Папка `audit_logs` из рабочей среды, venv, node_modules, скачанный cloudflared, временные модели и данные сервера не включены в installation ZIP. Логи и unified patch выдаются отдельно в `YOISAKI_V1.7.1_AUDIT_EVIDENCE.zip`.

Для проверки на своей тестовой машине установить исходные requirements и тестовые pytest/httpx/ipywidgets, затем выполнить команды из таблицы. Для только CloudCompute orchestration-тестов не нужны pretrained weights. CPU-сборку PyTorch из среды аудита **не переносить на GPU-сервер**: deploy-пакет сохраняет свои CUDA-зависимости.

Обновлённая инструкция содержит точные действия для старой ошибочной native-отметки, новые ограничения проверки и повторное подключение после смены туннеля. Основной способ установки с Android не изменился.
