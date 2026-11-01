# Как выпускать релиз, чтобы работал установщик

Команда установки берёт **последний стабильный GitHub Release** (`/releases/latest`: не черновик и не pre-release)
и ищет в нём два файла (Assets):

| Файл | Требование |
|---|---|
| `YOISAKI_AI_STUDIO_V<версия>_<что угодно>.zip` | установочный ZIP с готовой сборкой `dist/`; внутри одна папка `YOISAKI_AI_STUDIO_V1.4.0_LOCAL_EDITION`; версия в имени должна совпадать с `package.json` (например `YOISAKI_AI_STUDIO_V1.9.2_PIXEL_FANTASY.zip`) |
| `SHA256SUMS.txt` | строка `<sha256>  <имя ZIP>` (формат `sha256sum`) |

Остальные файлы (блокнот Colab, видео) установщик не трогает.

## Шаги

1. Соберите ZIP как обычно (`scripts/make-release.mjs`) и проверьте: `node scripts/verify-package.mjs`.
2. Посчитайте суммы: `sha256sum YOISAKI_AI_STUDIO_V*.zip YOISAKI_ENGINE_*.ipynb *.mp4 > SHA256SUMS.txt`.
3. GitHub → Releases → Draft a new release → тег `vX.Y.Z` → приложите ZIP и `SHA256SUMS.txt` (и остальные файлы) →
   **Publish release**. Не отмечайте «Set as a pre-release».
4. Проверьте из любого Termux: повторный запуск команды установки должен показать новую версию.

Если в последнем релизе нет этих файлов, установщик остановится с сообщением
«Последний релиз нельзя установить … нет нужных файлов» и ничего не изменит у пользователей.

## Проверка установщика

```bash
bash tests/installer/run.sh /путь/к/YOISAKI_AI_STUDIO_V1.9.2_PIXEL_FANTASY.zip
```

Тест создаёт чистую имитацию Termux и локальную копию GitHub Releases API и проверяет установку, повторный
запуск, обновление, докачку, откат неудачного обновления, отказ при неверной SHA-256, запрет понижения версии и
восстановление повреждённой установки. Это не настоящее Android-устройство.
