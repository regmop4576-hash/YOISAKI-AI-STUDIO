# YOISAKI AI STUDIO v1.7.1 — CLOUDCOMPUTE UI FIX

Дата: 26 октября 2026. Исправлен предоставленный архив. Перестройки приложения и нового inference-конвейера нет.

## Результат

Студия показывает **1.7.1 CLOUDCOMPUTE EDITION**. На существующей странице GPU появились Google Colab и CloudCompute, отдельные сохранённые адреса, явное подключение, изоляция сессий и статус выбранного провайдера. Интерфейс AMBER CORE сохранён. Версия движка и протокола остаётся **1.7.0** и выводится независимо.

Реальная GPU-генерация на CloudCompute/Colab и работа на физическом Android в этой среде не проверялись. Проверки production-сборки, локального сервера, браузера, HTTPS, FastAPI, CPU-тестов и обновления перечислены в отдельном `YOISAKI_V1.7.1_TEST_RESULTS.md`.

## Установленные причины

1. `package.json` и корень/основной пакет `package-lock.json` имели версию 1.7.0. `server/release.mjs` также объявлял WEBSITE_VERSION 1.7.0. В SettingsModal, Shell, GPU page, startup и diagnostics находились отдельные строки 1.7.0 LOCAL / CONTROLNET. Скриншоты соответствуют исходникам; оснований считать главным виновником браузерный кэш нет.
2. GPU page содержала одну Colab-форму. Выбора провайдера, состояния выбранного провайдера и пары endpoint-конфигураций не существовало. Предыдущая поставка добавила CloudCompute deployment, но не UI-интеграцию.
3. Прокси разрешал только `*.trycloudflare.com`. Для существующего CloudCompute quick tunnel это подходило, для другого публичного HTTPS endpoint — нет.
4. `install.sh` ориентировался на существование `dist/index.html`; `start.sh` мог принять старый запущенный процесс за готовое приложение. Это дополнительные возможные пути устаревшего запуска, а не доказательство конкретного старого процесса на телефоне пользователя.
5. В архиве **нет активного Next.js runtime**: package.json, scripts/build.mjs, server/index.mjs и src/compat показывают React + esbuild + Node.js. Импорты next/link и прочие идут через локальные адаптеры. Поэтому фактическая production-проверка — `npm run build`; `next build` неприменим. Архитектура сохранена, новых npm runtime-зависимостей нет.
6. Service Worker отсутствует. Статика уже отдаётся с `Cache-Control: no-cache`, API — `no-store`; эти защиты сохранены.

## Реализация

### Провайдеры и хранение

- `server/providers.mjs`: идентификаторы colab/cloudcompute, проверка endpoint, безопасная миграция старого last_host в адрес Colab без предположения, где фактически был запущен старый туннель.
- В существующем state.json сохранены `preferences.gpu.selected` и `preferences.gpu.endpoints.{colab,cloudcompute}`. Схема хранилища по-прежнему version=1, новая БД не создаётся. Старые настройки, tags, пресеты, история и изображения не удаляются.
- Адрес сохраняется при попытке подключения и смене провайдера. Набор текста сам по себе остаётся черновиком. Активная форма показывает только выбранного провайдера.
- Токен из вставленной ссылки переносится в password-поле и удаляется из текстового URL. После отправки поле очищается. Локальный Node-сервер держит только токен активного соединения в памяти. Переключение и disconnect уничтожают привязку активной сессии; повторное подключение требует токена.
- В общем экспорте настроек провайдерских токенов нет; нет их в state.json, localStorage, sessionStorage, статусе, diagnostics и новых логах.
- После перезапуска локального сервера сохранены адреса и выбор, но соединение OFFLINE. Reload страницы может показать уже существующую явную серверную сессию; новый connect он не выполняет.

### Подключение и гонки

- Общие `/health`, `/models`, `/generate`, `/jobs`, `/results`, ACK и `/controlnet/preprocess` сохранены. Провайдер изменяет только выбранную сессию/адрес.
- При переключении старые health/poll responses не могут вернуть предыдущий GPU в UI. Revision на клиенте и epoch на сервере отбрасывают устаревшие результаты.
- История новых задач помечена провайдером. Восстановление и отмена требуют совпадения provider + origin; старые записи без provider трактуются как Colab. Отмена старого задания не отправляется в новую сессию.
- Disconnect прекращает локальный опрос, но не отменяет уже запущенную удалённую генерацию. Незавершённая история сохраняется как CONNECTION_LOST и может быть проверена после явного возврата к тому же провайдеру/адресу. Уже отправленный сетевой запрос нельзя «отозвать» сменой выбора.
- Модели обновляются по ответу выбранного движка, существующая логика генерации и проверки ID сохранена. Неизвестный checkpoint/LoRA не считается доступным автоматически.

### Версии и метаданные

- Авторитетный источник версии студии — `package.json: version`. `src/lib/release.ts` и `server/release.mjs` читают его. Lockfile синхронизирован.
- SettingsModal, Shell, GPU page, HTML title/meta, API session/status/diagnostics, service/startup показывают реальную 1.7.1.
- `/api/version` локального сервера сообщает studio_version, edition, compatible_engine, engine_version и api_version. Требует существующую локальную сессию, как другие API.
- В FastAPI установлены ENGINE_VERSION=1.7.0 и API_VERSION=1.7.0. app.version больше не остаётся стандартным 0.1.0. `/health` дополнен api_version без изменения старого wire-контракта.
- Совместимые старые движки 1.7.0 без api_version принимаются; UI показывает «Нет данных», не выдумывает номер. Явно несовместимый api_version отклоняется. Прежние обязательные capabilities ControlNet/SDPose/Img2Img сохранены.
- Встроенный engine-пакет Colab notebook синхронизирован с изменённым direct_server.py; checksum пересчитан. Имя notebook и версия движка 1.7.0 сохранены.
- `cloudcompute/diagnose.py` теперь умеет читать ENGINE_VERSION из константы, сохраняя поддержку старого литерала. Этот случай найден и исправлен в регрессионном тесте.

### Hardware и язык

Имя GPU и доступная/общая VRAM берутся только из валидного `/health`. При отсутствии сведений выводится «Нет данных» / “No data”. В рабочем коде нет RTX/T4 заглушек. Значения SYNTHETIC/TEST присутствуют только в тестах и их снимках.

Новая страница GPU локализуется непосредственно по выбранному языку. LocaleBridge пропускает уже локализованный блок, предотвращая конфликт с React. Поддерживаются RU/EN, отдельные labels и aria-pressed для выбранной кнопки. Ошибки соединения переводятся по code; API-диагностика остаётся доступной.

### Безопасность

- Google Colab сохраняет прежнее ограничение `*.trycloudflare.com` и существующий 64-hex Bearer token.
- CloudCompute принимает явно введённый публичный DNS HTTPS endpoint на 443, включая quick tunnel. HTTP, пользователь/пароль в URL, query, пути, нестандартные порты и IP literals отклоняются.
- Каждый upstream-запрос проверяет DNS, запрещает private/reserved IP, закрепляет адрес для TLS-запроса и сохраняет проверку сертификата/имени. Redirect не выполняется, Bearer на другой origin не переносится.
- Сохранены ограничение маршрутов, максимального размера ответа, таймауты, классификация 401/403, malformed JSON, TLS и сетевых ошибок.
- Локальный сервер слушает только 127.0.0.1; Host/Origin/Fetch-Site, HttpOnly session, CSP и локальный header сохранены.
- Токен намеренно не шифруется «ключом в том же файле»: секрет вообще не пишется на диск. Он временно доступен текущей странице/процессу во время ввода и активной сессии. Компрометация самого Termux/браузера выходит за пределы этой защиты; пользователь вводит токен только к своему проверенному серверу.

### Установка и защита от старой сборки

- `scripts/build-identity.mjs` вычисляет SHA-256 исходников и выходных файлов; build записывает `dist/release.json`.
- install/start и server startup проверяют соответствие production-сборки исходникам. Изменённый исходник или asset заставляет проверку завершиться ошибкой; это проверено отдельно.
- При уже работающем процессе start указывает его каталог и требует явного stop/start. Diagnostics показывает отдельно установленную и запущенную версии.
- Boot сверяет версию загруженного интерфейса с локальным API и показывает инструкцию перезапуска при несовпадении.
- Новый update.sh может запускаться из распакованного нового архива с аргументом старой папки. Он проверяет/готовит новую поставку, останавливает сервер, копирует каталог данных, сохраняет весь предыдущий код, устанавливает и запускает обновление. Неудачный запуск возвращает прежний код; старые данные не удаляются.
- Пользовательские файлы внутри каталога кода сохраняются целиком в backup; новая установка не обязана автоматически подхватывать пользовательские модификации исходников.
- ZIP содержит dist, исходники, тесты, инструкции и проверку целостности; node_modules, виртуальное Python-окружение, реальные токены, веса и пользовательские данные отсутствуют.

## Функциональная совместимость

| Функция | Реальная реализация и граница проверки |
|---|---|
| Health / auth / версии | Реальный FastAPI запуск и HTTP/TestClient, 401 без/с неправильным токеном; Node HTTPS transport отдельно |
| Model discovery / LoRA | Реальные проверки каталога/формата и API; synthetic/browser request tests; реальные веса GPU не загружались |
| Text2Img / очередь / галерея | Прежний общий pipeline; браузер/Node проверяют запрос, очередь, PNG, сохранение, ACK и reload на synthetic upstream |
| Img2Img | Реализован в существующем engine; браузерная цепочка и маленькие CPU Diffusers tests проверяют контракт и компоненты |
| Regional Control | Существующая реализация/ограничения сохранены; Node/Python и малые CPU тесты |
| ControlNet | Существующие OpenPose/Canny/Depth/SDPose пути сохранены; API, invalidation, UI и CPU tests; реальные большие веса и CUDA не проверены |
| Image editing | Локальная загрузка, рисование/экспорт масок, область лица; Img2Img действительно отправляется движку |
| Inpaint / Face Fix | GPU-inpaint, автообнаружение и face-restoration в этом движке не реализованы. UI предоставляет локальные инструменты; эти функции не объявлены новой поддержкой CloudCompute |

## Сохранение предыдущего аудита

`cloudcompute/install-native.sh`, `cloudcompute/fetch_models.py`, `cloudcompute/launcher.py` побайтно совпадают с входным исправленным ZIP. Поэтому четыре прежние коррекции (native install status, границы домена токенов, проверка туннеля, полнота safetensors) сохранены. Их регрессионные тесты включены в текущий Python-прогон.

Все исходные `.py` в `engine/inference/` побайтно неизменны. В engine изменены только версия FastAPI и дополнительные health metadata в direct_server.py. Остальные файлы встроенного Colab engine также сохранены.

## Проверки и ограничения

Полная таблица результатов, команды и промежуточные неудачи — в `YOISAKI_V1.7.1_TEST_RESULTS.md`. Новые журналы — `docs/verification/ui-fix/`; более старые файлы verification и исторические отчёты не выдаются за этот прогон.

Нужна отдельная приёмка на физическом Android и реальном GPU CloudCompute/Colab: HTTPS-туннель, модель/LoRA, Text2Img, Img2Img, ControlNet/Regional, RAM/VRAM и перезапуск инстанса. Docker/NVIDIA runtime, стоимость и сохранность диска провайдера здесь не проверялись. Новая UI-интеграция не меняет эти платформенные условия.

## Изменённые файлы

- `CHANGELOG_RU.md`
- `README_RU.md`
- `install.sh`
- `package-lock.json`
- `package.json`
- `start.sh`
- `tsconfig.json`
- `update.sh`
- `cloudcompute/diagnose.py`
- `colab/YOISAKI_ENGINE_V1.7.0_IMG2IMG_EDITION.ipynb`
- `docs/CHANGELOG_RU.md`
- `docs/CLOUDCOMPUTE_INSTALL_ANDROID_RU.md`
- `docs/TERMUX_UPDATE_RU.md`
- `engine/worker/direct_server.py`
- `scripts/build.mjs`
- `scripts/service.mjs`
- `server/app.mjs`
- `server/index.mjs`
- `server/release.mjs`
- `server/upstream.mjs`
- `src/main.tsx`
- `src/app/engine/page.tsx`
- `src/components/Common.tsx`
- `src/components/LocaleBridge.tsx`
- `src/components/SettingsModal.tsx`
- `src/components/Shell.tsx`
- `src/lib/i18n.ts`
- `src/lib/local-api.ts`
- `src/lib/engine/direct.ts`
- `tests/history.test.mjs`
- `tests/https.test.mjs`
- `tests/img2img-browser.mjs`
- `tests/test_v171_cloudcompute.py`

Новые рабочие файлы: `server/providers.mjs`, `src/lib/release.ts`, `scripts/build-identity.mjs`. Новые проверки: `tests/providers.test.mjs`, `tests/providers-browser.mjs`, `tests/test_ui_release_metadata.py`, `tests/update-release.py`. Добавлены три текущих отчёта/инструкции, production `dist/` с `release.json` и журналы `docs/verification/ui-fix/`. `package-manifest.json` пересчитан для окончательной поставки.
