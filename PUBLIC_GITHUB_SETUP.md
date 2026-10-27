# Публичный GitHub: что настроить сопровождающему (v1.7.3)

Публичный репозиторий содержит **только код**. Он не предоставляет ни GPU, ни OAuth-инфраструктуру, ни чьи-либо учётные данные. Каждая установка независима: свой ключ CloudCompute API, свой аккаунт Google, своя папка моделей, свои настройки и адреса GPU — всё хранится в папке данных конкретного телефона.

## Что НЕ должно попадать в репозиторий

Правила уже в `.gitignore`: `.env`, `config/google-oauth-client.json`, `cloudcompute-api.json`, `secrets.json`, `state.json`, `rclone.conf`, `*.token`, `yoisaki.env`, а также `dist/`, `node_modules/`, кэши, `validation/`, `*.zip`.

Проверка перед публикацией и перед сборкой архива:

```bash
node scripts/secret-audit.mjs            # исходники
node scripts/secret-audit.mjs dist       # production-сборка
unzip -q release.zip -d /tmp/r && node scripts/secret-audit.mjs /tmp/r   # архив
```

Аудит ищет ключи `cc-…`, `GOCSPX-…`, токены Google `ya29.`/`1//0…`, реальные Client ID, ссылки движка с `#token=`, приватные ключи, токены GitHub/Hugging Face и файлы учётных данных. В тестах используются только очевидные подделки (`TESTONLY`, `BROWSERTEST`).

## Что должен подготовить сопровождающий (необязательно)

### 1. Общий OAuth-клиент Google (для кнопки «Войти через Google» без настройки)

Без него приложение работает: каждый пользователь один раз создаёт свой клиент (см. `GOOGLE_DRIVE_SETUP_RU.md`, вариант B).

Если вы хотите дать пользователям «вход в один клик»:
1. Google Cloud → проект → включить Google Drive API.
2. OAuth consent screen: External, название, политика конфиденциальности, домен; scope `.../auth/drive.readonly`.
3. Credentials → OAuth client ID → **Desktop app**.
4. Распространяйте Client ID / Secret **вне репозитория** (например, в описании релиза или отдельном файле релиза), пользователь кладёт их в `config/google-oauth-client.json` (шаблон: `config/google-oauth-client.example.json`) или в переменные `YOISAKI_GOOGLE_CLIENT_ID` / `YOISAKI_GOOGLE_CLIENT_SECRET` (`.env.example`).

Важно:
- Для Desktop-клиентов Google считает «secret» неконфиденциальным (его можно извлечь из любого установленного приложения). Он идентифицирует приложение, но не даёт доступа к чьим-либо данным: каждый пользователь сам входит в свой аккаунт и сам выдаёт разрешение.
- `drive.readonly` — **restricted scope**. Чтобы снять экран «непроверенное приложение» и лимит в 100 пользователей, нужна проверка приложения Google и **ежегодная оценка безопасности CASA**. Это организационная и, как правило, платная процедура; одного репозитория для неё недостаточно.
- Квоты Drive API общего клиента делятся между всеми пользователями.

### 2. Проверенное описание CloudCompute API

Сверьте `config/cloudcompute-api.example.json` с https://cloudcompute.ru/docs/api (см. `CLOUDCOMPUTE_API_SETUP_RU.md`). Проверенное описание пользователи копируют в свою папку данных. Ключи API у каждого пользователя свои; общего ключа быть не должно.

### 3. Готовый Docker-образ движка (необязательно)

Workflow `.github/workflows/engine-image.yml` публикует образ в GitHub Container Registry (`ghcr.io/<owner>/yoisaki-engine:<версия>-cloudcompute`). Сделайте пакет публичным в настройках GitHub Packages. Workflow не запускался при разработке 1.7.3.

## Чего репозиторий не обеспечивает

- GPU-мощности: у каждого пользователя свой аккаунт CloudCompute или Google Colab.
- Хостинг: приложение работает локально на телефоне (Termux), публичного сервера нет.
- OAuth-инфраструктуру: см. пункт 1.
