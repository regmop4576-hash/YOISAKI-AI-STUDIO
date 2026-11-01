# YOISAKI AI STUDIO v1.7.7 — результаты тестов

Дата: 2026-10-28. Журналы: `docs/verification/v177/`. Ни один тест не выполнялся на реальном GPU и на реальном API CloudCompute.

## Сводка по видам проверок

| Вид | Что именно | Результат |
|---|---|---|
| **Статические** | `tsc --noEmit`; production-сборка; проверки Dockerfile/файлов/переменных окружения/compose; синтаксис `onstart` (`bash -n`, `sh -n`); lock-файл зависимостей | все прошли |
| **Тесты на тестовых двойниках API (mocked)** | `npm test` (Node): 135 тестов | **130 passed, 0 failed, 5 skipped** |
| | из них новые `tests/v177-cloudcompute-stability.test.mjs` | 20 passed, 1 skipped (живой реестр — opt-in, выполнен отдельно, см. ниже) |
| | Python на хосте (автозапуск, лаунчер, диагностика, Drive sync, one-click) | 159 passed, 29 skipped (нужны fastapi/torch/rclone — выполнены в образе) |
| | Браузер (Chromium, мобильные 360/390/430, RU/EN), 12 сценариев | **10 passed**, 2 failed — устаревшие тесты, падают так же на исходной 1.7.6 (см. ниже) |
| **Docker runtime (без GPU)** | `tests/docker-runtime-audit.sh` на локальной сборке 1.7.5 | 9 из 12: FAIL — старт от uid 1000, bootstrap-слой (`failed to solve`), гонка onstart/CMD (контейнер останавливается) |
| | то же на локальном эквиваленте 1.7.7 | **12 из 12** |
| | Python-набор внутри образа (CPU, uid 1000, настоящие torch 2.10.0+cu128 / diffusers 0.36.0) | 283 passed, 1 failed (`test_panel_no_gpu`: нужен `ipywidgets`, есть только в Colab; так же в 1.7.5), 2 skipped |
| **Реестр (живые запросы)** | анонимный доступ к `engine:1.7.7` и `engine:1.7.5` (HTTP 200), `tags/list`, журнал сборки GHA (`IMPORTS_OK`, `ARCH_OK`, `pip check`, linux/amd64) | прошли |
| **Обновление установки** | `tests/update-release.py`: загруженный ZIP 1.7.6 → новый ZIP 1.7.7 через `update.sh`, затем ручной откат (Linux-симуляция, не Android) | PASS: галерея, история, настройки, вход Google, папка, ключ CloudCompute сохраняются; откат без потери данных |
| **Реальный GPU** | — | **не выполнялись** |

## Требуемые сценарии

### Монитор GPU (mocked API)
| Сценарий | Тест | Итог |
|---|---|---|
| корректные предложения, фильтры, сортировка | `monitor: valid offers are filtered and sorted…` | PASS |
| нет цены | там же (offer 3) | PASS |
| неизвестная валюта (USD) | там же (offer 4) | PASS |
| занятые предложения (`rentable:false`) | там же (offer 5) | PASS |
| исчезающие предложения | `monitor: disappearing offers…` | PASS |
| обнаружение новых, без дублей, базовая линия без уведомлений | там же | PASS |
| лимит частоты API (429, Retry-After, пауза, общий интервал) | `monitor: HTTP 429 honours Retry-After…` | PASS |
| сетевые ошибки, отзыв ключа, мгновенная остановка, лимит времени | `monitor: network errors keep the last snapshot…` | PASS |
| каталог GPU: T4/V100/3090/4090/5060 Ti, Pascal, нестандартный VRAM, неизвестная модель | `GPU catalog…` | PASS |

### Создание инстанса (mocked API, настоящий HTTP-сервер приложения)
| Сценарий | Тест | Итог |
|---|---|---|
| успешное создание (+ `bootstrap_profile`, итоговая конфигурация) | `creation: final configuration is re-verified…` | PASS |
| хост занят (422 и 409) | `creation: occupied host…` | PASS |
| двойная отправка (одновременно и повтор `request_id`) | `creation: duplicate submissions…` | PASS |
| таймаут сети | `creation: timeout / lost response…` | PASS |
| потерянный ответ (5xx) | там же | PASS |
| цена изменилась | `creation: price changed, offer disappeared, insufficient balance and rate limit…` | PASS |
| предложение исчезло | там же | PASS |
| недостаточно средств (402) | там же | PASS |
| лимит частоты при проверке перед созданием | там же | PASS |

### Развёртывание (mocked API и сигналы GPU)
| Сценарий | Тест | Итог |
|---|---|---|
| инстанс создан / хост / образ / работает; неизвестный статус не считается | `stages: created → provider bootstrapping…` | PASS |
| инстанс работает, движок молчит (#10758) | там же | PASS |
| bootstrap не завершён → TIMEOUT с указанием bootstrap | `stages: bootstrap incomplete…` | PASS |
| терминал недоступен («Terminal port has not yet been published by the host.») | `terminal availability is probed on request only…` | PASS |
| образ Docker недоступен (pull access denied / manifest unknown) | `stages: Docker image unavailable…` | PASS |
| сбой старта контейнера (`failed to solve`, `No such container`, NVIDIA toolkit) | там же | PASS |
| сбой запуска движка и очистка ошибки после восстановления | `stages: engine failure is reported and cleared…` | PASS |
| движок готов только после health check | там же | PASS |
| инстанс удалён (404 / destroyed), остановлен | `stages: instance deleted…` | PASS |
| таймаут развёртывания | `stages: bootstrap incomplete…` (две ветки) и `watcher timeout…` (v1.7.5) | PASS |
| диагностика без секретов | `diagnostics: downloadable JSON…` + браузер | PASS |

### Docker
| Сценарий | Где | Итог |
|---|---|---|
| публичная доступность образа | живой запрос к ghcr.io (`LIVE registry`), анонимный токен + манифест | PASS (1.7.7 и 1.7.5) |
| архитектура манифеста | журнал GHA (`linux/amd64`), `docker image inspect`; проверка индекса без amd64 — mocked | PASS |
| конфигурация запуска (ENTRYPOINT/CMD/пользователь/HEALTHCHECK) | статический тест + runtime-аудит | PASS для 1.7.7 |
| нужные файлы | статический тест + runtime-аудит | PASS |
| переменные окружения | статический тест Dockerfile | PASS |
| гонка onstart → CMD | `test_177_image_cmd_after_onstart…` (bash) + runtime-аудит | PASS для 1.7.7, FAIL (воспроизводит дефект) для 1.7.5 |

## Устаревшие тесты (не регрессии)
`tests/history-browser.mjs` (ищет надпись «YOISAKI AI STUDIO v1.7.0 · COMPATIBLE», которой в интерфейсе нет с ранних версий) и `tests/drive-sync-browser.mjs` (ищет панель Drive на прежнем месте до реорганизации 1.7.6) падают **так же на неизменённой 1.7.6** (проверено отдельной копией коммита 1.7.6). Их не было и в списке проверок отчёта 1.7.6. `regional-compatibility-browser` падал на 1.7.6 из-за изменённого Colab-фиксом текста — ожидание обновлено, тест проходит.

## Изменённые существующие тесты (намеренно)
Версия сайта 1.7.6 → 1.7.7; `VERSION` образа 1.7.5 → 1.7.7; этап `INSTANCE_INITIALIZING` → `IMAGE_PREPARING` для статуса провайдера `loading`; поле `bootstrap_profile` в теле создания; Docker-ветка `onstart` только в ручной команде; второй запуск автозапуска теперь ждёт, а не выходит (старый тест закреплял дефект D2); нестабильная гонка `readdir/stat` в тесте v1.7.3 сделана устойчивой (без ослабления проверки); браузерный тест v1.7.5 переведён на шаги 1.7.7.

## Как повторить
```
npm ci && npm run typecheck && npm test
YOISAKI_LIVE_REGISTRY=1 node --test --test-name-pattern="LIVE registry" tests/v177-cloudcompute-stability.test.mjs
python3 -m pytest -q tests/test_v175_autostart.py tests/test_v171_cloudcompute.py
npm run build && node tests/v177-browser.mjs        # Playwright Chromium
bash tests/docker-runtime-audit.sh ghcr.io/regmop4576-hash/yoisaki-ai-studio/engine:1.7.7   # нужен Docker
```

**Развёртывание на CloudCompute не считается проверенным, пока весь путь «найти GPU → аренда → инициализация → подключение → генерация» не пройдёт на реальном GPU-инстансе.**
