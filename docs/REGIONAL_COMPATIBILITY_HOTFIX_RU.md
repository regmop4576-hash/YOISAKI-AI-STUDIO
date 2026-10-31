# YOISAKI AI STUDIO 1.5.3 — Regional Compatibility Hotfix

## Причина

Ошибка находилась в `server/app.mjs`, в обработчике `POST /api/gpu/generate`. Если были включены регионы, сервер допускал только точные версии `['1.5.0','1.5.1']`. Версии 1.5.2, 1.5.2.1 и 1.5.3 отклонялись HTTP 409 с сообщением «Regional Control требует YOISAKI ENGINE v1.5.0». Запрос не доходил до Colab. Предупреждение не означало сбой GPU или алгоритма Regional Control.

## Проверка API

В актуальном Colab 1.5.3 существует `/health`: возвращает `engine='YOISAKI_ENGINE'`, `engine_version='1.5.3'`, state и GPU/memory сведения. Отдельных `/status` и `/capabilities` в этом движке нет; regional capability в текущем health не объявлена.

Локальный `/api/gpu/status` получает `/health`, сохраняет весь объект как `info` и возвращает клиенту. `validateHealth` проверяет контракт и не отбрасывает дополнительные поля. Потери информации между Colab и сайтом не обнаружено. Региональные поля уже принимаются действующим Colab API, обрабатываются прежним inference/regional.py.

## Исправление

Изменены ровно два production-файла:

1. `server/upstream.mjs`: добавлена `supportsRegionalControl(info)`.
2. `server/app.mjs`: устаревший whitelist заменён вызовом этой проверки; уточнено предупреждение для действительно неподдерживаемого движка.

Правила:

- Проверяется идентификатор YOISAKI_ENGINE.
- Если в health явно есть `capabilities.regional_control`, разрешение даёт только boolean `true`. `false` и некорректное значение не обходятся номером версии.
- Если признак отсутствует, используется совместимость семейства стабильных версий `1.5.x`, включая четырёхкомпонентный hotfix `1.5.2.1`.
- Неизвестные, prerelease и другие minor/major версии без явной capability не разрешаются автоматически.
- При Regional OFF эта проверка не блокирует обычную Text2Img.

Поле capability — поддерживаемый сайтом будущий явный контракт. Оно не добавлялось в текущий Colab и не выдаётся за уже существующую возможность API. Для действующих движков используется version fallback.

## Сохранено

Содержимое engine/, встроенный Colab, все src/ и dist/ побайтово совпадают с ранее выданным 1.5.3. Не изменены AMBER CORE, Text2Img, кодирование длинных промптов, LoRA Manager, Regional algorithm, RAM FIX, CPU Offload, галерея, пресеты, очередь и сохранение изображений.

Новый notebook не нужен. Уже работающий Colab 1.5.3 можно оставить запущенным.

## Проверки

- TypeScript `npm run typecheck`: PASS.
- Production `npm run build`: PASS. В приложенном проекте сборка React/TypeScript выполняется esbuild, а не `next build`; архитектура не менялась.
- Node API/integration: **15/15 PASS**. Проверены версии 1.5.0, 1.5.1, 1.5.2, 1.5.2.1, 1.5.3; explicit true/false; неизвестные версии; сохранение capability через /health → /api/gpu/status; передача полного regional request; блокировка без отправки upstream при отсутствии поддержки; сохранение обычной Text2Img.
- Chromium, мобильный viewport 390×844: **PASS**. Проверены отображение Regional Control, отправка двух регионов с настоящими PNG-масками в synthetic upstream 1.5.3, видимое предупреждение при explicit false и успешная обычная Text2Img после переключения OFF.
- Сравнение с ранее выданным ZIP: изменены только два production-файла выше. Дополнительно включены новые тесты, этот отчёт и обновлённый integrity manifest.

Реальная NVIDIA T4 и живая Colab-сессия недоступны. Полноценная региональная diffusion-генерация не проверена. API и браузерные тесты используют явно синтетический upstream. Python inference-код не менялся, поэтому результаты прежних Python-тестов не выдаются за новый GPU-прогон.

## Установка через Termux

Скачайте `YOISAKI_AI_STUDIO_V1.5.3_REGIONAL_COMPAT_HOTFIX.zip` в Download. Перейдите в существующую папку сайта, где находятся update.sh/start.sh. Для стандартного расположения:

```bash
cd ~/YOISAKI_AI_STUDIO_V1.4.0_LOCAL_EDITION
bash update.sh /sdcard/Download/YOISAKI_AI_STUDIO_V1.5.3_REGIONAL_COMPAT_HOTFIX.zip
bash start.sh
```

Если ваша папка называется иначе, измените только путь в cd. ZIP содержит прежнее внутреннее имя каталога ради совместимости update.sh. Скрипт сохранит резервную копию предыдущей папки. Пользовательские данные хранятся отдельно и не удаляются.

Обновите страницу `http://127.0.0.1:3000`. После перезапуска локального сервера подключитесь к текущему Colab по полной ссылке с токеном. Notebook менять и перезапускать ради этого hotfix не требуется. Включите Regional Control и отправьте новый запрос. Старое сообщение предыдущей неудачной попытки исчезнет при обновлении страницы/новой отправке.

Полные новые протоколы: `docs/verification/hotfix-node.txt` и `hotfix-browser.txt` внутри ZIP. Воспроизведение: `node --test --test-concurrency=1 tests/*.test.mjs`; браузер — `node tests/regional-compatibility-browser.mjs` после установки Chromium через Playwright.
