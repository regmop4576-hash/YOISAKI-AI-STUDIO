# Публикация исправленной сборки 1.9.2 (R2) — выполняется только с разрешения владельца

Номер сайта остаётся **1.9.2**. Движок **1.8.1 SMART FACE FIX**, API **1.7.0** и блокноты Colab не изменены.
Разные сборки одной версии различаются **идентификатором сборки** (первые 12 символов
`source_sha256` из `dist/release.json`): он показывается в «Настройках», в `/api/session`,
в выводе установщика и командой `yoisaki version --build`.

## Почему прошлое исправление не дошло до телефона

`yoisaki update` каждый раз скачивает установщик **из ветки `main`**
(`raw.githubusercontent.com/…/main/install-termux.sh`), а не из ZIP. В `main` до сих пор лежит
установщик с правилом «та же версия 1.9.2 и нет сохранённой SHA-256 ⇒ обновление не нужно».
Для установки, распакованной вручную (без `~/.local/share/yoisaki-installer/installed.env`),
он печатает «Уже установлена последняя версия 1.9.2 — скачивание не требуется» и оставляет
старую сборку. Это воспроизведено тестом `tests/installer/regression.sh`.
Поэтому для доставки нужно обновить **и** Asset релиза, **и** `install-termux.sh` в `main`.

## Шаги (только после явного разрешения владельца)

1. Проверить отчёт `REGRESSION_REPAIR_REPORT_RU.md`, итоговый ZIP и его SHA-256.
2. Влить ветку с исправлением в `main` обычным merge (без переписывания истории).
   Так `yoisaki update` получит исправленный `install-termux.sh`.
3. В релизе с тегом `Ai` добавить Asset `YOISAKI_AI_STUDIO_V1.9.2_STABILITY_R2_PIXEL_FANTASY.zip`.
   Тег не перемещать, новый релиз не создавать.
4. В `SHA256SUMS.txt` добавить точную строку нового ZIP (строки остальных ZIP оставить, если они
   остаются среди Assets). Список сумм должен описывать фактические Assets.
5. Сверить `digest` и размер Asset с локальным ZIP, затем на телефоне выполнить `yoisaki update`
   и сравнить идентификатор сборки (см. ниже).

Выбор архива: установщик берёт ZIP с наибольшим именем (`localeCompare`). Имя
`…V1.9.2_STABILITY_R2_PIXEL_FANTASY.zip` больше и `…V1.9.2_PIXEL_FANTASY.zip`, и
`…V1.9.2_STABILITY_PIXEL_FANTASY.zip` — проверено тестом с тремя Assets для текущего установщика
`main` и для исправленного. Версия, извлекаемая из имени, остаётся 1.9.2.

## Проверка на Android конкретной сборки

```bash
yoisaki update
yoisaki version --build        # ожидается: 1.9.2 <идентификатор из отчёта>
```

Затем в браузере: «Настройки» → строка «Сборка: …» должна совпасть. Если вкладка была открыта
во время обновления, сайт покажет «Установлена другая сборка… Обновить страницу».

## Тесты установщика (Linux-имитация Termux, не настоящий Android)

```bash
bash tests/installer/run.sh       REPAIRED.zip
bash tests/installer/stability.sh ORIGINAL.zip REPAIRED.zip
git show main:install-termux.sh > /tmp/main-install-termux.sh
bash tests/installer/regression.sh ORIGINAL.zip STABILITY.zip REPAIRED.zip /tmp/main-install-termux.sh
```
