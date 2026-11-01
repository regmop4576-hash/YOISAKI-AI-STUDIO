# Быстрый старт

Цель: телефон → сайт → Google Colab → ваши модели → первая картинка.

## 1. Сайт на телефоне (один раз)

Termux берите из [F-Droid](https://f-droid.org/packages/com.termux/) или
[GitHub](https://github.com/termux/termux-app/releases), не из Google Play.

```bash
pkg update -y && pkg upgrade -y
pkg install -y nodejs-lts unzip
termux-setup-storage
```

Скачайте `YOISAKI_AI_STUDIO_V1.9.2_PIXEL_FANTASY.zip` из
[Releases](https://github.com/regmop4576-hash/YOISAKI-AI-STUDIO/releases/latest) в «Загрузки».

```bash
cd ~ && unzip -q ~/storage/downloads/YOISAKI_AI_STUDIO_V1.9.2_PIXEL_FANTASY.zip
cd ~/YOISAKI_AI_STUDIO_V1.4.0_LOCAL_EDITION && bash install.sh && ./start.sh
```

Браузер → **http://127.0.0.1:3000**. Подробно — [INSTALL_TERMUX.md](INSTALL_TERMUX.md).

## 2. Модели на Google Drive (один раз)

```text
MyDrive/YOISAKI_AI_STUDIO/models/checkpoints/   ← ваш SDXL / Illustrious .safetensors
MyDrive/YOISAKI_AI_STUDIO/models/loras/         ← ваши LoRA (по желанию)
```

Подробно — [MODELS_AND_LORA.md](MODELS_AND_LORA.md).

## 3. Движок в Colab (каждый сеанс)

1. [Открыть блокнот в Colab](https://colab.research.google.com/github/regmop4576-hash/YOISAKI-AI-STUDIO/blob/main/colab/YOISAKI_ENGINE_V1.9.2_COLAB.ipynb).
2. «Среда выполнения» → «Сменить среду выполнения» → **T4 GPU**.
3. ▶ «🚀 1. ПОДГОТОВИТЬ ПАНЕЛЬ», разрешите доступ к Drive.
4. «🚀 ЗАПУСТИТЬ ДВИЖОК» → скопируйте ссылку целиком, с `#token=…`. **Никому её не показывайте.**

Подробно — [GOOGLE_COLAB.md](GOOGLE_COLAB.md).

## 4. Подключение и генерация

1. Сайт → **GPU → Google Colab → «Вставить ссылку из буфера» → «Подключиться»**.
   Ожидается: «ПОДКЛЮЧЁН», «Версия движка 1.8.1 · API 1.7.0», «Версия студии 1.9.2 · COMPATIBLE».
2. **Модели → Модели GPU → «Обновить модели»**.
3. **Генерация** → плитка «Модель» → ваш checkpoint; плитка «LoRA» → LoRA и вес.
4. Промпт → **«ГЕНЕРИРОВАТЬ»**. Результат появится в предпросмотре и в **Галерее**.

## 5. Завершение

Сайт: GPU → «Отключиться». Colab: «🛑 ОСТАНОВИТЬ», затем «Среда выполнения» → «Отключиться от среды выполнения
и удалить её». Termux: `./stop.sh`.

Видео со всеми шагами: [видеоинструкция v1.9.2](https://github.com/regmop4576-hash/YOISAKI-AI-STUDIO/releases/download/v1.9.2/YOISAKI_PIXEL_FANTASY_FULL_TUTORIAL.mp4).
