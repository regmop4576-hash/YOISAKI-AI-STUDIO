# YOISAKI AI STUDIO v1.7.3 · EASY CONNECT EDITION

Мобильная студия генерации изображений (SDXL / Illustrious XL) для Android: сайт работает локально на телефоне (Termux, Node.js), генерация — на вашем GPU (CloudCompute или Google Colab) через движок YOISAKI ENGINE (Python / FastAPI).

Text2Img, Img2Img, Multi-LoRA, ControlNet, Regional Control, очередь и история, пресеты, галерея, Google Drive Auto Sync.

**v1.7.3:** ключ CloudCompute API и кнопка «ПОДКЛЮЧИТЬ GPU»; вход в Google Drive через браузер без GPU, выбор папки моделей, автоматическая передача на GPU-сервер.

| Документ | Для чего |
|---|---|
| [ANDROID_INSTALL_RU.md](ANDROID_INSTALL_RU.md) | Установка и обновление на Android |
| [CLOUDCOMPUTE_API_SETUP_RU.md](CLOUDCOMPUTE_API_SETUP_RU.md) | Ключ API, управление инстансом, быстрая установка движка |
| [GOOGLE_DRIVE_SETUP_RU.md](GOOGLE_DRIVE_SETUP_RU.md) | Подключение Google Drive, OAuth, области доступа |
| [PUBLIC_GITHUB_SETUP.md](PUBLIC_GITHUB_SETUP.md) | Что подготовить сопровождающему публичной сборки |
| [ROLLBACK_V1.7.2_RU.md](ROLLBACK_V1.7.2_RU.md) | Откат на 1.7.2 |
| [YOISAKI_V1.7.3_EASY_CONNECT_REPORT_RU.md](YOISAKI_V1.7.3_EASY_CONNECT_REPORT_RU.md) | Технический отчёт, тесты, ограничения |
| [CHANGELOG_RU.md](CHANGELOG_RU.md) | История изменений |

В репозитории нет учётных данных: каждый пользователь подключает свой GPU, свой ключ CloudCompute API и свой аккаунт Google. Проверка перед публикацией: `node scripts/secret-audit.mjs`.

Разработка: `npm ci && npm run build && npm test` (Node 22–26); Python-тесты: `pytest tests`.
