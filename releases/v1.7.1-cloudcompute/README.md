# YOISAKI AI STUDIO 1.7.1 — CloudCompute Edition

Дополнительный способ запустить YOISAKI ENGINE (протокол 1.7.0) на арендованном GPU CloudCompute.ru. Управлять им можно только с Android-телефона через Termux.

- Google Colab остаётся рабочим вариантом.
- Сайт, папка `engine/` и Colab-блокнот v1.7.0 не изменены.

| Файл | Что это |
|---|---|
| `YOISAKI_AI_STUDIO_V1.7.1_CLOUDCOMPUTE_EDITION.zip` | Полный пакет: сайт v1.7.0, движок, Colab-блокнот, Docker-развёртывание и скрипты CloudCompute. Один и тот же ZIP ставится и в Termux (`update.sh`/`install.sh`), и на GPU-сервер. |
| `CLOUDCOMPUTE_INSTALL_ANDROID_RU.md` | Пошаговая инструкция только с телефона. |
| `YOISAKI_V1.7.1_CLOUDCOMPUTE_REPORT.md` | Технический отчёт: архитектура, хранение, память, безопасность, проверки, ограничения. |
| `deployment/` | Добавленные файлы развёртывания в открытом виде для просмотра. Те же файлы есть в ZIP. |
| `verification/` | Фактические выводы проверок. |

**Коротко, на сервере:**

```bash
cd /workspace/yoisaki-app
./start-cloudcompute.sh     # печатает ссылку для страницы GPU сайта
./stop-cloudcompute.sh      # затем ОБЯЗАТЕЛЬНО остановите инстанс в панели CloudCompute
```

> На реальном GPU CloudCompute этот выпуск ещё не запускался. Что проверить при первом запуске, описано в разделе 10 отчёта.
