#!/usr/bin/env bash
# First-time setup of the one-click connection (run ON THE SERVER once; 1.7.3).
#   ./setup-cloudcompute.sh          guided questions
#   ./setup-cloudcompute.sh show     current choices (never prints secrets)
# Writes only keys of $YOISAKI_DATA_ROOT/config/yoisaki.env and the Named Tunnel credential
# config/engine/cloudflared.token (0600). Takes effect at the next ./start-cloudcompute.sh.
set -euo pipefail
# shellcheck source=cloudcompute/lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/cloudcompute/lib.sh"
yoisaki_load_config
yoisaki_prepare_dirs
ENV_FILE=$YOISAKI_DATA_ROOT/config/yoisaki.env
SECRETS=$YOISAKI_DATA_ROOT/config/engine

set_key() {   # KEY VALUE: replace or append one line; values are validated by the caller
  local key=$1 value=$2
  [[ -f $ENV_FILE ]] || { install -m 600 /dev/null "$ENV_FILE"; }
  if grep -q "^$key=" "$ENV_FILE"; then sed -i "s|^$key=.*|$key=$value|" "$ENV_FILE"; else printf '%s=%s\n' "$key" "$value" >>"$ENV_FILE"; fi
  chmod 600 "$ENV_FILE"
}
ask() { local reply; read -r -p "$1 " reply || true; printf '%s' "${reply:-$2}"; }

show() {
  say "Папка данных: $YOISAKI_DATA_ROOT"
  say "Постоянная ссылка (YOISAKI_STABLE_LINK): ${YOISAKI_STABLE_LINK:-0}"
  say "Туннель (YOISAKI_TUNNEL_MODE): ${YOISAKI_TUNNEL_MODE:-quick}${YOISAKI_PUBLIC_HOSTNAME:+ · $YOISAKI_PUBLIC_HOSTNAME}"
  say "Токен Named Tunnel: $([[ -s $SECRETS/cloudflared.token ]] && echo сохранён || echo нет)"
  say "Автообнаружение адреса (YOISAKI_RENDEZVOUS): ${YOISAKI_RENDEZVOUS:-off}"
  bash "$YOISAKI_APP/autostart-cloudcompute.sh" status || true
}
[[ ${1:-} == show ]] && { show; exit 0; }

say '=== YOISAKI ENGINE · настройка подключения одной кнопкой ==='
say ''
say '1) Постоянная ссылка: токен доступа не меняется при перезапуске движка. Тогда на сайте достаточно один раз'
say '   вставить ссылку и отметить «Запомнить». Отозвать доступ: ./check-cloudcompute.sh rotate-token.'
case $(ask 'Включить постоянную ссылку? [Д/н]' д) in [нНnN]*) set_key YOISAKI_STABLE_LINK 0 ;; *) set_key YOISAKI_STABLE_LINK 1 ;; esac
say ''
say '2) Адрес сервера:'
say '   1 — Quick Tunnel (бесплатно, без регистрации; адрес меняется при каждом запуске, ссылку вставлять заново)'
say '   2 — Quick Tunnel + автообнаружение: сервер публикует новый адрес на ntfy.sh (подписан токеном; сам токен'
say '       не передаётся). Сайт находит адрес сам. Нужна постоянная ссылка. Бесплатно, сторонний сервис.'
say '   3 — Cloudflare Named Tunnel: постоянный адрес на вашем домене (нужен домен в Cloudflare и бесплатный аккаунт).'
case $(ask 'Ваш выбор [1/2/3]:' 1) in
  2) set_key YOISAKI_TUNNEL_MODE quick; set_key YOISAKI_RENDEZVOUS ntfy
     [[ $(grep -E '^YOISAKI_STABLE_LINK=' "$ENV_FILE" | tail -n1) == 'YOISAKI_STABLE_LINK=0' ]] && warn 'Автообнаружение работает только с постоянной ссылкой.' ;;
  3) say ''
     say 'В Cloudflare: Zero Trust → Networks → Tunnels → Create tunnel (Cloudflared) → скопируйте токен из команды'
     say "установки; Public Hostname: ваш адрес, Service: HTTP, URL: 127.0.0.1:${YOISAKI_PORT:-8765}."
     host=$(ask 'Адрес (например gpu.example.com):' '')
     host=${host,,}
     [[ $host =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$ ]] || die "Неверный адрес: $host"
     read -r -s -p 'Токен туннеля (ввод скрыт): ' tunnel; say ''
     [[ $tunnel =~ ^[A-Za-z0-9+/=_.-]{40,4096}$ ]] || die 'Это не похоже на токен Cloudflare Tunnel.'
     install -m 600 /dev/null "$SECRETS/cloudflared.token.tmp" && printf '%s\n' "$tunnel" >"$SECRETS/cloudflared.token.tmp"
     mv -f "$SECRETS/cloudflared.token.tmp" "$SECRETS/cloudflared.token"
     [[ $(id -u) == 0 ]] && chown --reference="$SECRETS" "$SECRETS/cloudflared.token"
     unset tunnel
     set_key YOISAKI_TUNNEL_MODE named; set_key YOISAKI_PUBLIC_HOSTNAME "$host"; set_key YOISAKI_RENDEZVOUS off ;;
  *) set_key YOISAKI_TUNNEL_MODE quick; set_key YOISAKI_RENDEZVOUS off ;;
esac
say ''
case $(ask '3) Запускать движок автоматически при старте инстанса? [Д/н]' д) in
  [нНnN]*) say 'Автозапуск не включён.' ;;
  *) bash "$YOISAKI_APP/autostart-cloudcompute.sh" enable || true ;;
esac
say ''
say '✔ Настройки сохранены. Применить: ./stop-cloudcompute.sh && ./start-cloudcompute.sh'
say '  Затем на сайте: GPU → CloudCompute → вставьте ссылку (./check-cloudcompute.sh link) → отметьте «Запомнить».'
yoisaki_billing_notice
