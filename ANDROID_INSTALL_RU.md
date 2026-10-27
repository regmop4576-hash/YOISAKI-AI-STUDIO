# Установка на Android (Termux) — v1.7.3

## Новая установка

1. Установите **Termux** из F-Droid или GitHub (версия из Google Play устарела).
2. В Termux:
   ```bash
   pkg update -y && pkg install -y nodejs-lts unzip
   termux-setup-storage            # один раз, чтобы видеть «Загрузки»
   cd ~ && unzip ~/storage/downloads/YOISAKI_AI_STUDIO_V1.7.3_EASY_CONNECT.zip
   cd ~/YOISAKI_AI_STUDIO_V1.4.0_LOCAL_EDITION   # имя папки сохранено для совместимости update.sh
   bash install.sh
   ./start.sh
   ```
   Из GitHub вместо архива: `pkg install git && git clone <адрес репозитория> && cd <папка> && bash install.sh` (`install.sh` сам выполнит `npm ci` и сборку, т. к. `dist/` в репозитории нет).
3. Откройте в Chrome телефона `http://127.0.0.1:3000`.

Папку приложения держите в домашней папке Termux (`~`), не в `/sdcard`: Android запрещает запуск оттуда.

## Первая настройка (один раз)

1. **GPU → CloudCompute → CloudCompute API**: вставьте ключ `cc-…` → «Сохранить ключ».
2. На инстансе CloudCompute (SSH или терминал Jupyter, один раз): распакуйте пакет и выполните `./setup-cloudcompute.sh`. Скопируйте ссылку движка (`./check-cloudcompute.sh link`), вставьте её на странице GPU и отметьте «Запомнить».
3. **Модели → GOOGLE DRIVE → «Войти через Google»** → выберите аккаунт → выберите папку моделей. GPU для этого не нужен.

## Каждый день

**GPU → «ПОДКЛЮЧИТЬ GPU»** → (если инстанс остановлен и метод запуска описан — подтверждение оплаты) → ожидание → READY. Google Drive передаётся на сервер, недостающие модели загружаются сами. Ни SSH, ни rclone, ни копирования токенов.

Если управление инстансом через API ещё не включено (см. `CLOUDCOMPUTE_API_SETUP_RU.md`), сначала запустите инстанс в панели CloudCompute, затем нажмите «ПОДКЛЮЧИТЬ GPU».

## Обновление с 1.7.2 или ранней сборки 1.7.3

```bash
cd ~/YOISAKI_AI_STUDIO_V1.4.0_LOCAL_EDITION
bash update.sh ~/storage/downloads/YOISAKI_AI_STUDIO_V1.7.3_EASY_CONNECT.zip
```
`update.sh` проверяет архив, собирает новую версию, делает резервные копии кода и данных и при неудачном запуске возвращает прежнюю версию. Данные (галерея, история, пресеты, теги LoRA, запомненные серверы) сохраняются.

На GPU-сервере обновите пакет CloudCompute (распакуйте новый архив на инстансе и выполните `./start-cloudcompute.sh`): выбор папки Google Drive работает только с сервером 1.7.3.

## Если что-то не так

`bash diagnostics.sh` в Termux; «Технический журнал для разработчиков» на странице GPU (без секретов); `./check-cloudcompute.sh` на сервере.
