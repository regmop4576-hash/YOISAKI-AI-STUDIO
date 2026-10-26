# YOISAKI AI STUDIO v1.7.0 — установка на Android

1. Установите актуальный Termux из официального проекта: https://github.com/termux/termux-app#installation .
2. Скачайте ZIP в папку **Download** телефона. В Termux выполните:

```bash
termux-setup-storage
pkg update -y
pkg install -y unzip
cd ~
unzip ~/storage/downloads/YOISAKI_AI_STUDIO_V1.7.0_IMG2IMG_EDITION.zip
cd YOISAKI_AI_STUDIO_V1.4.0_LOCAL_EDITION
bash install.sh
./start.sh
```

Android запросит разрешение на общую память. Разрешите его. Приложение устанавливается в домашнюю папку Termux; запуск из Download не поддерживается. Установка сама добавит Node.js, если его нет. npm, сборка и Python на телефоне не нужны.

3. Откройте **http://127.0.0.1:3000** в Chrome.
4. Откройте в Google Colab файл **colab/YOISAKI_ENGINE_V1.7.0_IMG2IMG_EDITION.ipynb** из архива. Выберите среду **T4 GPU**, запустите основную ячейку подготовки, подтвердите доступ к Google Drive и нажмите **ЗАПУСТИТЬ ДВИЖОК**. Код движка уже встроен в notebook — второй архив загружать не нужно. Colab может запросить подтверждение выполнения чужого блокнота.
5. Вставьте полную ссылку `https://….trycloudflare.com/#token=…` в раздел GPU приложения. Нажмите «Подключиться». Выберите checkpoint в генераторе, введите промпт и запустите Text2Img. Готовый результат автоматически сохраняется в локальную галерею.

Модели остаются на Drive: `MyDrive/YOISAKI_AI_STUDIO/models/`, подпапки `checkpoints`, `loras`, `vae`. Поддерживаются совместимые SDXL/Illustrious файлы safetensors. Модели не скачиваются на телефон.

Дальнейший запуск:

```bash
cd ~/YOISAKI_AI_STUDIO_V1.4.0_LOCAL_EDITION
./start.sh
```

Остановка: `./stop.sh`. Проверка: `./diagnostics.sh`. Обновление: `./update.sh /путь/к/новому.zip`.

Не закрывайте Termux принудительно во время работы; отключите для него ограничение фоновой активности Android. После остановки сервера или сброса Colab вставьте новую ссылку GPU. Токен хранится только в памяти сервера. Ссылку не публикуйте.

Данные сохраняются отдельно: `~/.local/share/yoisaki-ai-studio/` (галерея, настройки, теги, история). Для резервной копии остановите приложение и скопируйте эту папку. Обновление её не удаляет.

**Граница проверки:** сборка и локальные тесты выполнены на Linux. Реальный Android/Termux, публичный туннель к вашему Colab и генерация на вашем checkpoint требуют проверки на устройстве/GPU. Img2Img, Inpaint и Face Fix не заявлены как рабочие режимы инференса; ControlNet (OpenPose Classic / SDPose-OOD, Canny, Depth) описан в README_RU.md; интерфейсы редактора сохранены.

Имя каталога `YOISAKI_AI_STUDIO_V1.4.0_LOCAL_EDITION` сохранено намеренно: существующий update.sh ищет именно его. Версия приложения внутри — 1.6.2. Порядок запуска не менялся.
