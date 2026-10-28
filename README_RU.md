# YOISAKI AI STUDIO v1.7.7.1 — CLOUDCOMPUTE STARTUP FIX

Исправление существующего запуска: Initialize Engine выполняет provisioning через официальный API терминала, onstart сообщает ошибки, повторная инициализация сохраняет один супервизор и тот же токен. Движок генерации и Colab не заменены.

Инструкция: [Запуск 1.7.7.1](docs/CLOUDCOMPUTE_STARTUP_FIX_1771_RU.md). [Расследование](YOISAKI_STARTUP_ROOT_CAUSE_REPORT.md), [результаты проверок](YOISAKI_V1.7.7.1_TEST_RESULTS.md).

**Образ 1.7.7.1 опубликован** 28.10.2026 через GitHub Actions ([run 40701192429](https://github.com/regmop4576-hash/YOISAKI-AI-STUDIO/actions/runs/40701192429)): `ghcr.io/regmop4576-hash/yoisaki-ai-studio/engine:1.7.7.1`, digest `sha256:a148c0e8f5df410454c33dc4bef902fbfad412ddfc9b357e487f02a9ce4964dc`, linux/amd64, анонимная загрузка — OK ([страница версии](https://github.com/users/regmop4576-hash/packages/container/yoisaki-ai-studio%2Fengine/1461324402?tag=1.7.7.1)). Docker CPU runtime-тест пройден на этом образе до публикации. **Реальный CloudCompute/GPU ещё не проверен.** Первая попытка публикации (HTTP 403 у подключения GitHub, manifest 404) описана в [результатах проверок](YOISAKI_V1.7.7.1_TEST_RESULTS.md). Проверка образа перед платной арендой остаётся включена.

Ниже — исторические сведения предыдущих выпусков; их заявления о публикации не относятся к 1.7.7.1.

---

# YOISAKI AI STUDIO v1.7.7 — CLOUDCOMPUTE STABILITY

Обновление v1.7.4. GPU в CloudCompute арендуется и запускается с телефона в пять кнопок, без SSH, Python и Termux: выбор GPU с ценой → создание с подтверждением оплаты → автоматический запуск готового образа движка → автоматическое подключение → загрузка выбранных моделей из Google Drive (с 1.7.6).

**Новое в 1.7.7:** монитор доступности GPU, безопасная аренда (перепроверка, занятый хост, защита от двойной оплаты), раздельные состояния «инстанс CloudCompute» и «YOISAKI ENGINE», диагностика JSON, исправленный образ `engine:1.7.7`. Отчёты: [Docker](YOISAKI_DOCKER_AUDIT.md), [монитор GPU](YOISAKI_GPU_MONITOR_REPORT.md), [тесты](YOISAKI_V1.7.7_TEST_RESULTS.md).

**1.7.6:** [модели Google Drive без GPU и монитор синхронизации](docs/MODEL_LIBRARY_ANDROID_RU.md), [отчёт](YOISAKI_V1.7.6_REPORT_RU.md).

**Начните с [инструкции](docs/CLOUDCOMPUTE_ZERO_TERMINAL_RU.md).** Образ: `ghcr.io/regmop4576-hash/yoisaki-ai-studio/engine:1.7.7`. Живое создание инстанса CloudCompute и генерация на реальном GPU в разработке не выполнялись: первый запуск — приёмочный. Сайт: 1.7.7, deployment: 1.7.7; протокол ENGINE: 1.7.0.

---

# YOISAKI AI STUDIO v1.7.4 — CloudCompute API & Google Drive

Обновление существующего v1.7.3. CloudCompute REST API, Google OAuth и выбор папки без GPU, обновление токенов, передача папки существующему rclone, честный статус каталога моделей, повторное использование готовых окружений и Docker-образов.

**Начните с [актуальной инструкции](docs/INTEGRATIONS_SETUP_RU.md) и [отчёта](YOISAKI_V1.7.4_REPORT_RU.md).** Реальный Google OAuth требует зарегистрированного Desktop client; он не включён в ZIP. Живые операции с CloudCompute/GPU не подтверждены. Сайт и deployment: 1.7.4; неизменённый протокол ENGINE: 1.7.0.

Ниже сохранена историческая документация прежних выпусков; её ограничения и старые способы подключения не заменяют инструкцию 1.7.4.

---

# YOISAKI AI STUDIO v1.7.3 — ONE-CLICK CONNECT EDITION

**Новое в 1.7.3:** подключение к GPU одной кнопкой (CloudCompute) с ожиданием загрузки и диагностикой по компонентам; исправлено исчезновение новых LoRA из генератора; Google Drive через вход в браузере. Инструкция: `YOISAKI_V1.7.3_ONE_CLICK_SETUP_RU.md`, отчёт: `YOISAKI_V1.7.3_REPORT_RU.md`.

---

# YOISAKI AI STUDIO v1.7.2 — GOOGLE DRIVE AUTO SYNC EDITION

**Новое в 1.7.2:** страница «Модели» → раздел **GOOGLE DRIVE AUTO SYNC** (только CloudCompute). GPU-сервер сам скачивает модели из вашей приватной папки `Мой диск/YOISAKI_AI_STUDIO/models/{checkpoints,loras,vae}`: только чтение Drive, без публичных ссылок, с докачкой, проверкой файлов и атомарной установкой. Локальные модели при этом не удаляются. Инструкции:

- `YOISAKI_V1.7.2_TERMUX_INSTALL.md` — обновление телефона;
- `YOISAKI_V1.7.2_CLOUDCOMPUTE_SETUP.md` — сервер;
- `YOISAKI_V1.7.2_GOOGLE_DRIVE_SETUP.md` — однократная авторизация;
- `YOISAKI_V1.7.2_DEVELOPMENT_REPORT.md` и `YOISAKI_V1.7.2_TEST_RESULTS.md` — отчёты.

Студия 1.7.2 использует YOISAKI ENGINE 1.7.0 / API 1.7.0 (протокол не менялся). Версии релиза и протокола независимы. Отдельные кнопки Google Colab / CloudCompute находятся на странице GPU. Старые движки отклоняются с понятной ошибкой. Выпуск 1.7.0 подключает настоящий Image-to-Image — см. `YOISAKI_V1.7.0_IMG2IMG_REPORT.md`. SDPose-OOD 1.6.2 (`YOISAKI_V1.6.2_SDPOSE_REPORT.md`) и исправления 1.6.1 (`YOISAKI_V1.6.1_STABILITY_REPORT.md`) сохранены.

Сохранён локальный React/esbuild + Node.js проект из v1.5.4. Next.js отсутствует в активном runtime исходного архива; архитектура не заменялась. AMBER CORE, галерея, очередь, Regional Control, LoRA, sampler/scheduler сохранены.

## Установка / обновление

На Android перенесите распакованную папку в домашний каталог Termux, выполните `bash install.sh`, затем `./start.sh`. Откройте http://127.0.0.1:3000 . Node.js 22–26, предпочтительно 24 LTS.

Архив содержит исходники и проверенную production-сборку dist, без node_modules. install.sh проверяет соответствие сборки исходникам, при необходимости выполняет npm ci и npm run build. Для пересборки нужен интернет.

Для безопасного обновления используйте новый update.sh из нового архива с путём старой установки. Точная процедура, резервные копии и откат: `YOISAKI_V1.7.2_TERMUX_INSTALL.md`. Не распаковывайте поверх старого каталога.
Внутренняя папка ZIP намеренно называется `YOISAKI_AI_STUDIO_V1.4.0_LOCAL_EDITION`: старый updater ищет именно этот путь. Это путь совместимости, а не версия приложения. Настройки и изображения остаются в прежнем отдельном каталоге данных.

В Colab откройте `colab/YOISAKI_ENGINE_V1.7.0_IMG2IMG_EDITION.ipynb`, выберите T4, выполните подготовку и запустите движок через прежнюю панель. Вставьте новую ссылку туннеля в GPU.

## GPU на CloudCompute (необязательно, v1.7.1)

Вместо Colab движок можно запустить на арендованном GPU CloudCompute.ru: RTX 5060 Ti, RTX 3060/3090, A5000 или T4.

- Пошаговая инструкция только с телефона: `docs/CLOUDCOMPUTE_INSTALL_ANDROID_RU.md`.
- Коротко, на сервере: `./start-cloudcompute.sh`, затем на странице GPU выберите CloudCompute и вставьте ссылку из вывода. Токен не сохраняется на диск; после смены провайдера введите его заново.
- Остановка: `./stop-cloudcompute.sh`, затем **обязательно** остановите инстанс в панели CloudCompute: оплата идёт, пока инстанс существует.
- Colab работает как раньше.

## Img2Img

На странице «Генерация» выберите вкладку IMG2IMG (или вкладку IMG2IMG в «Редакторе»), загрузите исходное изображение PNG/JPEG/WebP и задайте «Сила изменения» (Denoise, 0,05–1). Prompt, Negative, Checkpoint/VAE, активные LoRA, Seed, Steps, CFG, Sampler/Scheduler, batch 1–2, Regional Control и ControlNet работают как в Text2Img. Размер результата — заданные Width/Height; исходник обрезается по центру до этого размера без растяжения. Кнопка «Размер по исходнику» подбирает ≈1 Мп с пропорциями исходника. Выполняется `int(Steps × Denoise)` шагов денойза — это число показано под ползунком и в прогрессе задания. Результаты сохраняются в галерею и историю (вместо base64 исходника хранится его SHA-256).

Движок не загружает вторую копию модели: на время задания строится `StableDiffusionXLImg2ImgPipeline.from_pipe()` (с ControlNet — `StableDiffusionXLControlNetImg2ImgPipeline`) поверх уже загруженных UNet/VAE/текстовых энкодеров и LoRA, после задания возвращается базовый конвейер.

## ControlNet

В существующей панели включите ControlNet, выберите OpenPose / Canny / Depth, загрузите PNG/JPEG/WebP (до 6 МБ, 16 Мп), нажмите «Подготовить карту». Дождитесь preview карты, затем запускайте генерацию.

Для готовых карт отметьте «Использовать готовую карту». Смена типа, изображения, размеров или режима готовой карты сбрасывает результат; запоздавший ответ предобработки игнорируется. Пропорции сохраняются с чёрными полями. Нет дополнительного редактора.

Новые настройки: Strength 0.8, Start 0, End 1. Валидные сохранённые значения не перезаписываются. Требуется 0 ≤ Start < End ≤ 1. Вместе с Regional Control режим отклоняется. Batch остаётся 1–2, прочие исходные ограничения сохранены.

Для OpenPose есть «Препроцессор позы»: **OpenPose Classic** (прежний детектор человеческого тела, без пальцев/лица; антро может не распознаться) или **SDPose-OOD** (нейросетевая оценка позы на основе Stable Diffusion, устойчивее на стилизованных, аниме, фурри и сложных позах). Оба строят одинаковую OpenPose-карту тела (18 точек) для того же OpenPose ControlNet. Смена препроцессора сбрасывает подготовленную карту. С «Использовать готовую карту» препроцессор не используется. SDPose-OOD (`teemosliang/SDPose-Body`) загружается на GPU в fp16 только на время подготовки карты и полностью выгружается до генерации; первая подготовка скачивает веса и идёт дольше (ответ PENDING, страница ждёт). Без доступа к Hugging Face можно указать локальную копию репозитория в `YOISAKI_SDPOSE_REPO`. Depth — настоящая нейросетевая оценка относительной глубины. Canny — OpenCV, внутренние пороги 100/200 (YOISAKI_CANNY_LOW/HIGH).

Модели скачиваются из Hugging Face при первом использовании, затем используются из кеша Colab. Все три ControlNet одновременно не загружаются. Предобработка OpenPose Classic / Depth / Canny выполняется на CPU, SDPose-OOD — на GPU; вся предобработка сериализована с генерацией. После задания ControlNet освобождается; базовые компоненты SDXL и LoRA переиспользуются. Следующая генерация ControlNet заново загружает его веса из кеша.

## Проверки и ограничения

Актуальные отчёты: `YOISAKI_V1.7.2_DEVELOPMENT_REPORT.md` и `YOISAKI_V1.7.2_TEST_RESULTS.md`; предыдущие — `YOISAKI_V1.7.1_UI_FIX_REPORT.md` и `YOISAKI_V1.7.1_TEST_RESULTS.md`; история Img2Img: `YOISAKI_V1.7.0_IMG2IMG_REPORT.md` (SDPose-OOD — `YOISAKI_V1.6.2_SDPOSE_REPORT.md`, исправления 1.6.1 — `YOISAKI_V1.6.1_STABILITY_REPORT.md`, история ControlNet v1.6.0 — `YOISAKI_CONTROLNET_V1.6.0_CHANGELOG.md`). CPU/контрактные проверки не заменяют реальный GPU-прогон. RAM/VRAM T4, качество Illustrious, загрузка настоящих весов SDPose-OOD, настоящая Img2Img- и ControlNet-генерация на GPU в этой среде не проверены. Не гарантируется работа любого SDXL ControlNet с любым Illustrious checkpoint.

Исторические документы в docs/ и MEMORY_DIAGNOSTICS_REPORT_RU.md описывают прежние выпуски; актуальные версии и инструкции находятся здесь и в отчёте v1.7.1 UI FIX.

При первом запуске v1.6.1 и новее история и метаданные галереи v1.6.0 автоматически освобождаются от встроенных base64-карт ControlNet (остаются тип, Strength/Start/End и SHA-256 карты). Записи и изображения не удаляются. Исходный файл однократно сохраняется как `state.json.v1.6.0-backup` в каталоге данных; его можно удалить вручную после проверки.
