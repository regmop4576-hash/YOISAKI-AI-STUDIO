# Безопасность / Security

## Главное правило

**Ссылка движка (`https://….trycloudflare.com/#token=…`) — это секрет.** Любой, у кого она есть, может отправлять
задания на ваш GPU-сеанс Colab. Не публикуйте её, не отправляйте в чаты, не показывайте на скриншотах, видео и в
сообщениях об ошибках. Если ссылка утекла — нажмите «🛑 ОСТАНОВИТЬ» в панели Colab и запустите движок заново:
будет выдан новый токен, старый перестанет работать.

## Как устроена защита

- Локальный сервер слушает только `127.0.0.1` (доступен только с самого телефона).
- Токен движка хранится отдельно от адреса; без «Запомнить на этом телефоне» он живёт только до отключения.
- `diagnostics.sh` и журналы скрывают `Bearer …`, `#token=…` и 64-символьные ключи.
- Установщик проверяет SHA-256 каждого файла (`scripts/verify-package.mjs`); `update.sh` отклоняет архивы с
  абсолютными путями, `../` и символическими ссылками и делает резервные копии.
- Блокнот Colab проверяет SHA-256 встроенного пакета движка перед распаковкой.

## Что никогда не должно попасть в репозиторий

`.env`, `config/google-desktop-client.json` (OAuth-клиент), `secrets.json`, `state.json`, `rclone.conf`,
`*.token`, `yoisaki.env`, галерея, содержимое Google Drive, личные checkpoint/LoRA, журналы с токенами,
`engine/.results/`, `engine/.venv/`. Правила — в [`.gitignore`](.gitignore).

Перед публикацией релиза 1.9.2 проверены исходники, блокнот и кадры видео (OCR каждые 3 секунды) на токены,
ключи Google OAuth (`GOCSPX-`, `ya29.`, `1//`), GitHub/Hugging Face/AWS-ключи, приватные ключи и адреса
туннелей: найдены только тестовые заглушки в `tests/` и примеры `a.trycloudflare.com`. В видео поле ссылки
пустое или скрыто.

## Сообщить об уязвимости

Не создавайте публичный Issue с деталями уязвимости. Используйте
[GitHub Private vulnerability reporting](https://github.com/regmop4576-hash/YOISAKI-AI-STUDIO/security/advisories/new)
(вкладка Security → Report a vulnerability). Если эта функция в репозитории выключена — откройте Issue только
с просьбой связаться, без технических деталей.

Поддерживается последняя версия (сейчас 1.9.2).

---

**English summary.** The engine link with `#token=` is a secret — never share it; restart the engine if it leaks.
The local server binds to `127.0.0.1` only. Report vulnerabilities privately via GitHub Security → Report a
vulnerability, not via public issues. Only the latest release is supported.
