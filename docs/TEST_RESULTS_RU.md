# Проверки v1.5.4

- `npm run typecheck`: PASS.
- `npm run build`: PASS. В фактическом проекте React/TypeScript + esbuild; отдельного next build нет.
- `node --test --test-concurrency=1 tests/*.test.mjs`: **23 PASS, 0 FAIL**.
- `node tests/history-browser.mjs`: PASS, Chromium 390×844/touch. Свёрнутая история, видимые RUNNING/QUEUED, корзина ≥44 px, удаление, reload, отмена/подтверждение bulk, сохранение Gallery/favorites/triggers, website 1.5.4 + engine 1.5.3 COMPATIBLE.
- `node tests/regional-compatibility-browser.mjs`: PASS. Regional UI, маски, engine 1.5.3, genuine unsupported warning, обычная Text2Img.
- `node tests/browser-e2e.mjs`: PASS. Подключение, теги LoRA, длинный positive/negative, две LoRA 1.15/0.8, preview, download, Gallery/reload. Upstream синтетический, не T4.
- Node syntax (`node --check`) для изменённых server/service modules: PASS.
- `bash -n update.sh`: PASS.
- Реальный старый update.sh запущен на изолированной установке: **PASS**, обновление до 1.5.4, backup создан, state.json и файл изображения побайтово сохранены. Это Linux-проверка скрипта, не физический Android.
- 22 файла engine/notebook: побайтово равны 1.5.3 hotfix.
- Отдельный lint script/ESLint не настроен в исходном package.json; lint не объявляется выполненным. TypeScript и Node syntax проверены.

## Новые серверные регрессии

Удаление COMPLETED/FAILED/INTERRUPTED/CANCELLED; перезагрузка API/повторное открытие Store/restart server/reconnect; bulk successful/unsuccessful/all; защита RUNNING/QUEUED/UNKNOWN; connection-lost офлайн и running отклоняются, terminal remote удаляется после проверки; готовый remote result сначала попадает в Gallery; retention 50 + nonterminal; startup pruning; parallel cleanup/completion; переход в active до commit; сбой atomic write; сохранение изображений, favorites, saved prompts/parameters, settings, presets, LoRA tags, checkpoint и regional masks.

## Ограничения

Физический Android Termux, реальная NVIDIA T4 и живой Cloudflare→Colab не запускались. Python не изменялся и повторная CPU diffusion-suite для этого выпуска не запускалась; прежние 45 Python-тестов не считаются новыми тестами 1.5.4. UNKNOWN/CONNECTION_LOST не удаляются автоматически, пока нет подтверждения terminal state.

Протоколы текущего выпуска — `docs/verification/v154-*.txt` в ZIP. Старые протоколы других версий оставлены отдельно.
