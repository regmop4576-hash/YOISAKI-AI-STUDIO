# Откат v1.7.3 → v1.7.2

## Телефон (Termux)

`update.sh` при обновлении оставляет резервные копии рядом с папкой приложения:
`<папка>.backup-<дата>` (код 1.7.2) и `~/.local/share/yoisaki-ai-studio.backup-<дата>` (данные до обновления).

```bash
cd ~/YOISAKI_AI_STUDIO_V1.4.0_LOCAL_EDITION && ./stop.sh && cd ~
mv YOISAKI_AI_STUDIO_V1.4.0_LOCAL_EDITION YOISAKI_AI_STUDIO_V1.4.0_LOCAL_EDITION.v173
mv YOISAKI_AI_STUDIO_V1.4.0_LOCAL_EDITION.backup-<дата> YOISAKI_AI_STUDIO_V1.4.0_LOCAL_EDITION
cd YOISAKI_AI_STUDIO_V1.4.0_LOCAL_EDITION && ./start.sh
```
(Либо: `bash update.sh <архив 1.7.2>.zip` — тот же механизм в обратную сторону.)

**Данные.** v1.7.3 не меняет схему `state.json`: галерея, история, пресеты и теги LoRA читаются версией 1.7.2 как есть. Новое хранится только в `secrets.json` (ключ CloudCompute API, привязка Google Drive, запомненные серверы) — 1.7.2 этот файл не читает. Чтобы на телефоне не оставалось секретов после отката, перед откатом нажмите «Удалить ключ» (GPU) и «Отключить Google Drive» (Модели) или удалите `~/.local/share/yoisaki-ai-studio/secrets.json` вручную. Восстанавливать резервную копию данных не требуется; она нужна только если вы хотите вернуть состояние на момент обновления.

## GPU-сервер CloudCompute

Распакуйте пакет 1.7.2 и запустите `./start-cloudcompute.sh`. Если в 1.7.3 была выбрана папка Google Drive, `rclone.conf` содержит `root_folder_id`, а сервер 1.7.2 будет искать `YOISAKI_DRIVE_PATH` **внутри** этой папки и сообщит «Папка не найдена». Решение: `./drive-sync-cloudcompute.sh disconnect` и подключить Google Drive заново способом 1.7.2. Модели на диске не затрагиваются.

## Движок и Colab

Протокол движка не менялся (1.7.0), каталог `engine/` и Colab-блокнот — те же байты, поэтому откат движка не нужен.
