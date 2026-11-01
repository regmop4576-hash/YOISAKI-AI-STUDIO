# YOISAKI ENGINE v1.9.2 COLAB — отчёт совместимости с сайтом 1.9.2

Дата проверки: 2026-11-01. Проверка выполнена по исходникам; реальный запуск на Tesla T4 не выполнялся.

## Что внутри блокнота

| Параметр | Значение |
|---|---|
| Файл | `colab/YOISAKI_ENGINE_V1.9.2_COLAB.ipynb` |
| Движок | `engine_version='1.8.1'` (`worker/direct_server.py` встроенного пакета) |
| API | `api_version='1.7.0'` |
| SHA-256 встроенного пакета | `fa9f5283eed2fb164e1f1712bb79c3a8add91b9d46c4115ca4955e2f65b92d82` (проверяется самим блокнотом) |
| Capabilities | controlnet, sdpose, img2img, inpaint, facefix, auto_facefix, face_detect_contract 1, editor_contract 1, regional_control, result_ack |

Все 5 кодовых ячеек **побайтно совпадают** с `colab/YOISAKI_ENGINE_V1.8.1_SMART_FACE_FIX.ipynb`. Изменены только
текстовые (markdown) ячейки и метаданные блокнота (`colab.name`, `yoisaki_release`).

### Примечание о файле блокнота

Присланный для релиза файл `YOISAKI_ENGINE_V1.9.2_COLAB.ipynb` был не JSON-блокнотом, а текстовой (Markdown)
выгрузкой: Google Colab не смог бы его открыть. Блокнот собран заново в формате nbformat 4: текст взят из
присланного файла, кодовые ячейки и их метаданные (`cellView: form`) — из блокнота 1.8.1 с автоматической
проверкой побайтного совпадения кода. Код движка, RAM FIX и CPU Offload не изменялись.

## Проверка API-контракта

| Сайт 1.9.2 (`server/`) | Движок 1.8.1 | Итог |
|---|---|---|
| `engineCompatibility()` в `server/release.mjs`: `engine==='YOISAKI_ENGINE'`, версия ∈ {1.7.0, 1.7.6, 1.8.0, 1.8.1}, `api_version==='1.7.0'`, capabilities controlnet/sdpose/img2img = true | 1.8.1 / 1.7.0 / все три true | COMPATIBLE |
| Автоматический Face Fix требует `auto_facefix` | true | доступен |
| Разрешённые маршруты `allowedRoute()` (`server/upstream.mjs`): `GET /health`, `GET /models`, `POST /generate`, `POST /controlnet/preprocess`, `POST /facefix/detect`, `GET/DELETE /jobs/{id}`, `POST /jobs/{id}/ack`, `GET /results/{id}?index=N` | все маршруты есть в `direct_server.py` | совпадает |
| `GET /inventory` | нет в движке Colab | используется только для CloudCompute (`provider==='cloudcompute'`), для Colab — `/models` |

Существующий автотест сайта `local server proxies detection for v1.8.1 and refuses automatic requests to a
v1.8.0 engine` проходит.

## Что не проверено

- Реальная генерация на Tesla T4 с полноразмерным Illustrious XL.
- Реальное потребление RAM/VRAM Colab, качество Face Fix.
- Python-тесты движка (`tests/test_*.py`) в среде подготовки релиза не запускались: нет PyTorch/FastAPI и
  доступа к PyPI.
