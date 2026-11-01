# Changelog

Краткая история. Полные описания версий — в [CHANGELOG_RU.md](CHANGELOG_RU.md) и отчётах `YOISAKI_V*_REPORT*.md`.

## Не выпущено — установка одной командой

- `install-termux.sh`: установка в Termux одной командой — зависимости, последний стабильный GitHub Release,
  проверка SHA-256 по `SHA256SUMS.txt`, штатная проверка целостности, команда `yoisaki`
  (start / stop / restart / status / update / open), обновление с сохранением данных и откатом.
  Сайт, Pixel Fantasy, Colab и движок не изменены.
- `tests/installer/run.sh`: 35 проверок установщика в чистой имитации Termux.
- Документация: `docs/ru/INSTALL_TERMUX.md`, `docs/en/INSTALL_TERMUX.md`, `docs/RELEASING.md`, README.

## v1.9.2 hotfix — ORIGIN_DENIED · 2026-11-01

- **Исправлено:** открытие `http://127.0.0.1:3000` по ссылке из GitHub, через `yoisaki open` / `termux-open-url` или
  с ярлыка Android давало `{"code":"ORIGIN_DENIED"}`. Со стороннего сайта теперь разрешён только переход верхнего
  уровня (`GET`, `Sec-Fetch-Mode: navigate`, `Sec-Fetch-Dest: document`) на страницы приложения без параметров
  OAuth. Проверки `Host`, `Origin`, `X-Yoisaki-Local` и локальной сессии API не изменены.
- Тесты: `tests/origin-navigation.test.mjs`. Номер версии сайта остался 1.9.2; движок, Colab и Pixel Fantasy не изменены.

## v1.9.2 — Android Input Fix · 2026-10-31

Сайт 1.9.2, YOISAKI ENGINE 1.8.1 (без изменений), API 1.7.0. Отчёт: `YOISAKI_V1.9.2_INPUT_FIX_REPORT.md`.

- **Исправлено:** экранная клавиатура Android больше не закрывается сама в окнах (выбор модели и LoRA, параметры
  генерации, заметки галереи): `Modal` перехватывал фокус при каждой перерисовке страницы (опрос очереди раз
  в 2 с).
- **Исправлено:** числовые поля (Width, Height, размеры по умолчанию, рабочий размер Face Fix, Regional Control %,
  тариф GPU) можно стереть и набрать заново; дробный тариф с точкой/запятой вводится.
- **Исправлено:** поле ввода не прячется под клавиатурой (`interactive-widget=resizes-content`).
- **Новое в репозитории:** блокнот `colab/YOISAKI_ENGINE_V1.9.2_COLAB.ipynb` (движок 1.8.1 побайтно, обновлённое
  описание для сайта 1.9.2), документация RU/EN в `docs/ru` и `docs/en`, скриншоты, лицензия Apache-2.0,
  `SECURITY.md`, `NOTICE`, отчёт совместимости `YOISAKI_ENGINE_V1.9.2_COMPATIBILITY_REPORT.md`.

## v1.9.1 — Pixel Fantasy Hotfix

Читаемый шрифт Onest для текста, PWA-манифест и иконки Ёоисаки, исправлен просмотр в галерее.

## v1.9.0 — Pixel Fantasy Edition

Пиксельная дизайн-система, шрифты Tiny5 / Press Start 2P, иконки Pixelarticons, маскот Ёоисаки; русский по
умолчанию; новые экраны генерации, галереи и настроек; редактор не сбрасывается между страницами.

## v1.8.1 — Smart Face Fix

Автоматический поиск лиц (CPU-детекторы OpenCV, MIT), мягкая овальная маска, исправление нескольких лиц по
очереди. Colab-движок 1.8.1.

## v1.8.0 — Editor Completion

Inpaint, Face Fix (ручная рамка) и Img2Img в редакторе на общих компонентах SDXL.

## v1.7.x

Img2Img (1.7.0), CloudCompute и Docker (1.7.1–1.7.7, скрыты по умолчанию), синхронизация Google Drive,
совместимость Colab (1.7.6).

## v1.6.x

ControlNet (OpenPose / Depth / Canny), SDPose-OOD, исправления стабильности.

## v1.1.0 и ранее

Первые версии интерфейса на Next.js (без генерации). Сохранены в истории git ветки `main`.
