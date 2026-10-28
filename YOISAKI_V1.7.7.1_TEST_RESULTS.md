# YOISAKI AI STUDIO v1.7.7.1 — результаты проверок

Дата: 28 октября 2026. Исходники — приложенный выпуск v1.7.7. Среда локальных проверок: Linux x86_64, Node.js 24.22.1, Python 3.12.14. **Реального GPU нет; CloudCompute API, терминальный WebSocket и health в тестах сайта подменены.**

## Сводка

| Уровень | Результат | Практическая граница |
|---|---|---|
| Node regression: `npm test` | **140 passed, 5 skipped, 0 failed** (145 tests) | Сайт, API маршруты, мок провайдера, секреты, генерация команд, reconnect/timeout, диагностика |
| Python CloudCompute suite | **150 passed, 27 skipped, 0 failed** | stdlib и процессная обвязка; 27 тестов с отсутствующими engine dependencies пропущены |
| Из них supervisor/startup suite | **20 passed** | Настоящие bash/flock/signals/PTY, подменённый inference launcher |
| TypeScript | **PASS**, `tsc --noEmit` | Статическая проверка React и типов |
| Production build | **PASS**, версия 1.7.7.1 | Поставляется собранный `dist/` |
| Chromium mobile v175/v177 сценарии | **PASS**, RU/EN, 360/390/430 px | Реальный браузер + локальный HTTP сервер; CloudCompute/GPU — моки |
| Python AST / Node syntax / bash syntax | **PASS** | Синтаксис CloudCompute Python, server/*.mjs и shell scripts |
| ShellCheck | **PASS**, уровень error | Изменённый supervisor и новый Docker runtime script |
| Dockerfile parser и версия | **PASS** | ENTRYPOINT/CMD/labels, package + lock + deployment version; это не сборка Docker |
| Python requirements hash lock | **PASS** | `cloudcompute/check_lock.py`; зависимости не менялись |
| `engine/` | **BYTE IDENTICAL** | Сравнение с исходным ZIP; inference и Colab engine не изменены |
| Установочный ZIP / updater | **PASS**, manifest и существующий update.sh | Содержимое и сохранение пользовательских данных |
| Docker runtime | **PASS (CPU)**, 9/9 в GitHub Actions на реальном кандидате 1.7.7.1 до публикации | [run 40701192429](https://github.com/regmop4576-hash/YOISAKI-AI-STUDIO/actions/runs/40701192429); GPU в контейнере нет. В первой редакции тест не мог пройти без CUDA — см. «Docker runtime» ниже |
| Публикация образа | **PASS**, `engine:1.7.7.1`, digest `sha256:a148c0e8f5df410454c33dc4bef902fbfad412ddfc9b357e487f02a9ce4964dc` | Первая попытка: GitHub create-tree HTTP 403 `Resource not accessible by integration` (запись исходников подключением GitHub, workflow не запускался). Опубликовано через git push → GitHub Actions (`GITHUB_TOKEN`, `packages: write`) |
| Анонимный manifest `engine:1.7.7.1` | **HTTP 200** (до публикации: 404) | Workflow и независимая проверка; checkImage сайта: «Образ опубликован и доступен…»; config: linux/amd64, version 1.7.7.1, revision `1166a784d42f8b1e7f618c46eb8ecb01987f28e3` |
| Реальный CloudCompute / GPU | **UNVERIFIED** | Платный инстанс не создавался, #10766 не использовался |

Полный Python regression с inference-модулями не выполнен: отдельная попытка collection `test_v170_img2img.py` остановилась из-за отсутствия torch. Это ограничение среды, не успешный тест. После этого выполнен перечисленный CloudCompute suite, который явно отмечает отсутствующие зависимости как skips. Предыдущие неуспешные итерации разработки исправлены; таблица отражает окончательные результаты указанного набора.

## Статическая проверка

- AST всех cloudcompute/*.py; `node --check` всех server/*.mjs; `bash -n` корневых/CloudCompute scripts и tests/docker-startup-1771.sh.
- `npm run typecheck`, `npm run build`.
- DockerfileParser подтверждает `ENTRYPOINT ["/usr/bin/tini","--"]`, `CMD ["/opt/yoisaki/cloudcompute/autostart-image.sh"]`, image label 1.7.7.1. Workflow явно задаёт linux/amd64.
- package.json, оба version-поля package-lock.json, cloudcompute/VERSION, Dockerfile label, стандартный registry reference, compose/lib image references согласованы.
- ShellCheck 0.11.0 с `-S error`. Замечания меньшей серьёзности не объявляются проверенными/устранёнными.
- Workflow regex принимает четвёртый hotfix-сегмент; существующий тег не перезаписывается. Build candidate → CPU runtime checks → push → anonymous manifest check. В первой попытке workflow не выполнялся из-за отказа записи GitHub; 28.10.2026 выполнен успешно (run 40701192429, 14 мин 28 с). Workflow дополнительно настраивает Node 22 для генератора onstart в тесте, фиксирует digest после push и сверяет анонимный manifest/config с этим запуском.

## Мок провайдера и реальный локальный сервер сайта

Проверены числовые 0/1/2/99 и строковые числовые статусы: raw value/type сохраняются, enum не выдумывается. Проверены running/loading/failed/stopped, приоритет известного фактического поля и игнорирование intended_status как доказательства.

Существующая регрессия проверяет успешное создание, актуальную цену/диск/образ, занятый offer, недостаток баланса, 429, двойное нажатие, потерю create-response, bootstrap/Docker failure, signed stages, engine connect, GPU timeout, Drive bind и синхронизацию выбранных файлов. Готовность не появляется по одному статусу провайдера.

Новые tests/v1771-startup.test.mjs дополнительно проверяют:

1. ttyd handshake и подтверждение echo-off перед отправкой секрета; echo команды не считается подтверждением.
2. Exit 42, закрытый WebSocket, timeout, malformed/missing ws_url, cleartext/untrusted URL: без ложного успеха и утечки секрета.
3. `/deploy/initialize` выполняет provisioning и объединяет concurrent requests; токен не ротируется.
4. Данные initialization восстанавливаются SecretStore после перезапуска; скачиваемая диагностика без ключей.
5. URL найден, но health не прошёл: повторное подключение и конечный timeout вместо бесконечного ожидания.
6. HMAC диагностического snapshot совместим в Python/Node; подмена содержимого отклоняется.
7. Перезапуск сайта при незавершённом bootstrap возобновляет официальный terminal fallback, не создавая вторую аренду.
8. HTTP 409/429 при ожидании терминала не расходуют три попытки исполнения; Retry-After ограничивает также ручной повтор.

**WebSocket CloudCompute не использован вживую.** Протокол проверен тестовым EventTarget-клиентом; отдельно проверено исполнение shell-команд в настоящем локальном PTY.

## Процессная проверка без Docker/GPU

Python tests/test_v175_autostart.py и test_v1771_startup.py запускают реальный autostart-image.sh с тестовым launcher вместо CUDA/FastAPI.

Проверены: отсутствие config/logs/models; корректный и некорректный токен; 0600/0700; атомарное сохранение; восемь concurrent provisioning; один supervisor/launcher; повтор того же токена без рестарта; смена токена с одним рестартом; сохранение модели и её ownership/mode; недоступный data root без тихого fallback; отказ symlink в config без изменения цели; ограниченные рестарты; SIGTERM; foreground CMD после onstart; передача shutdown фоновой копии; освобождение блокировки; health с неверным engine identity/STARTING/READY/BUSY.

Настоящий bash в PTY исполняет сгенерированный onstart, отключает echo до передачи токена, затем закрывается. Отдельный супервизор продолжает работу; токен отсутствует в выводе PTY. Это доказывает поведение локального POSIX-пути, **не** поведение CloudCompute cgroup/ttyd/container runtime и **не** успешную загрузку GPU модели.

## Docker runtime

**Исполнено 28.10.2026** в GitHub Actions ([run 40701192429](https://github.com/regmop4576-hash/YOISAKI-AI-STUDIO/actions/runs/40701192429), ubuntu-24.04, без GPU) на собранном кандидате `engine:1.7.7.1` до `docker push`: 9 PASS, затем `RESULT: Docker CPU smoke passed; CloudCompute / real GPU inference UNVERIFIED`. Опубликован именно этот кандидат: config `sha256:8a1385c1adcffbb32d0876c4e462ee854e2f8c812c70d3c44b11aac17168bb03` совпадает с его image ID.

Исправление теста перед запуском: первая редакция ждала `launcher.py healthcheck` (state READY). Неизменённый движок отвечает READY только при наличии CUDA (`engine/worker/direct_server.py`: `'READY' if gpu_name else 'ERROR'`), поэтому на хосте без GPU тест не мог пройти и публикация была бы заблокирована. Теперь тест проверяет настоящий FastAPI через аутентифицированный `/health` (без токена 401; с токеном `engine=YOISAKI_ENGINE`, `state=ERROR`, `gpu_name=null`) и требует, чтобы healthcheck без GPU оставался NOT READY; `YOISAKI_SERVER_TIMEOUT=900` держит сервер запущенным на время проверок. Движок и launcher не менялись.

Фактический вывод: `engine /health: {"engine": "YOISAKI_ENGINE", "engine_version": "1.7.0", "api_version": "1.7.0", "state": "ERROR", "gpu_name": null}` (обычный CMD и после onstart).

Сценарии `tests/docker-startup-1771.sh`:

| Требуемая проверка | Сценарий в script | Выполнено (run 40701192429) |
|---|---|---|
| Normal ENTRYPOINT/CMD | Реальный образ, tini, FastAPI на CPU с явным отключением GPU preflight; аутентифицированный /health без GPU = ERROR | PASS |
| Override ENTRYPOINT/CMD | /bin/sh + keepalive вместо CMD; затем onstart через docker exec | PASS |
| `/.launch` существует | Marker создан до проверки; engine не запускается сам по этому факту | PASS |
| Нет `/data/config` | Чистый контейнер, затем provisioning | PASS |
| Initial/repeated provisioning | Token mode/uid, четыре каталога, пять повторов, один PID | PASS |
| Lifecycle | Процесс uid 1000, supervisor lock, отдельный background start | PASS |
| Missing GPU | Обычный CMD с включённым preflight обязан завершиться кодом 3 | PASS |
| Health failure | До запуска и после остановки healthcheck обязан отказать | PASS |
| Safe shutdown | docker stop → exit 0; SIGTERM detached supervisor → server down | PASS |
| Files/permissions/platform | inspect + проверка нужных файлов/executable | PASS |

Скрипт эмулирует возможность override, **не воспроизводит недоступную внутреннюю реализацию CloudCompute**. Сценарий CPU FastAPI также не заменяет GPU smoke test.

## Реальная GPU проверка

**Не выполнялась.** Единственные реальные GPU сведения — наблюдения пользователя о неудаче v1.7.7 на #10766. Нельзя переносить их на v1.7.7.1 как доказательство исправления. CUDA 13.2 у провайдера не означает CUDA 13.2 внутри PyTorch; зависимости образа остались cu128. Приёмка на RTX 3090, генерация, стабильность загрузки моделей, живой Cloudflare и WebSocket остаются открытыми.

## Установка

Архив сохраняет историческое имя корневой папки `YOISAKI_AI_STUDIO_V1.4.0_LOCAL_EDITION`, необходимое существующему updater. Номер релиза берётся из package.json (1.7.7.1), а не имени папки. Итоговый manifest проверяется по SHA-256 каждого файла; node_modules, секреты и пользовательские данные не включаются.

**PASS:** tests/update-release.py обновил установленный 1.7.7 → 1.7.7.1 через настоящий update.sh и проверил HTTP /api/version. Сохранились Google sign-in/выбранная папка, CloudCompute key, исходные bytes галереи, избранное, история, presets, settings, models/tags и пользовательский файл в backup. Проверены code/data backups, отказ при устаревшем dist/исходниках и rollback к 1.7.7 без изменения пользовательских данных. Это Linux simulation, не физический Android/Termux. После добавления окончательных отчётов manifest пересоздан и повторно проверен; исходники updater/install/start не менялись.
