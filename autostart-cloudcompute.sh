#!/usr/bin/env bash
# Start YOISAKI ENGINE automatically whenever this GPU instance boots (run ON THE SERVER, once, as root).
#   ./autostart-cloudcompute.sh enable | disable | status
# Uses systemd when it is PID 1 (a full VM), otherwise cron @reboot when a cron daemon runs.
# Many rented GPU containers have neither: then the script says so and changes nothing.
set -euo pipefail
# shellcheck source=cloudcompute/lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/cloudcompute/lib.sh"
yoisaki_load_config
ACTION=${1:-status}
UNIT=/etc/systemd/system/yoisaki-engine.service
MARK='# yoisaki-engine-autostart'
pid1=$(cat /proc/1/comm 2>/dev/null || echo '?')

has_cron() { command -v crontab >/dev/null 2>&1 && { pgrep -x cron >/dev/null 2>&1 || pgrep -x crond >/dev/null 2>&1; }; }
cron_line() { printf '@reboot YOISAKI_DATA_ROOT=%q /bin/bash %q >>%q 2>&1 %s\n' "$YOISAKI_DATA_ROOT" "$YOISAKI_APP/start-cloudcompute.sh" "$YOISAKI_DATA_ROOT/logs/autostart.log" "$MARK"; }

unsupported() {
  warn "Автозапуск здесь недоступен: PID 1 = «$pid1», systemd нет, cron не запущен."
  say  'Это обычно для арендованного контейнера. Варианты:'
  say  "  • если в панели CloudCompute можно задать команду при запуске инстанса, укажите: bash $YOISAKI_APP/start-cloudcompute.sh"
  say  '  • иначе после запуска инстанса один раз выполните ./start-cloudcompute.sh (сайт подождёт и подключится сам).'
  exit 2
}

case $ACTION in
  enable)
    [[ $(id -u) == 0 ]] || die 'Нужны права root.'
    if [[ $pid1 == systemd ]]; then
      cat >"$UNIT" <<EOF
[Unit]
Description=YOISAKI ENGINE (CloudCompute)
Wants=network-online.target
After=network-online.target docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
Environment=YOISAKI_DATA_ROOT=$YOISAKI_DATA_ROOT
ExecStart=/bin/bash $YOISAKI_APP/start-cloudcompute.sh
ExecStop=/bin/bash $YOISAKI_APP/stop-cloudcompute.sh
TimeoutStartSec=1200

[Install]
WantedBy=multi-user.target
EOF
      systemctl daemon-reload && systemctl enable yoisaki-engine.service
      say '✔ Автозапуск включён (systemd: yoisaki-engine.service).'
    elif has_cron; then
      { crontab -l 2>/dev/null | grep -vF "$MARK" || true; cron_line; } | crontab -
      say '✔ Автозапуск включён (cron @reboot).'
    else
      unsupported
    fi
    say 'Проверка: перезапустите инстанс в панели CloudCompute и откройте сайт → GPU → «Подключить».' ;;
  disable)
    [[ $(id -u) == 0 ]] || die 'Нужны права root.'
    if [[ -f $UNIT ]]; then systemctl disable yoisaki-engine.service 2>/dev/null || true; rm -f -- "$UNIT"; systemctl daemon-reload 2>/dev/null || true; fi
    if command -v crontab >/dev/null 2>&1; then { crontab -l 2>/dev/null | grep -vF "$MARK" || true; } | crontab - 2>/dev/null || true; fi
    say '✔ Автозапуск выключен.' ;;
  status)
    if [[ -f $UNIT ]]; then say "systemd: $(systemctl is-enabled yoisaki-engine.service 2>/dev/null || echo '?')"
    elif command -v crontab >/dev/null 2>&1 && crontab -l 2>/dev/null | grep -qF "$MARK"; then say "cron @reboot: включён (cron $(has_cron && echo запущен || echo 'НЕ запущен'))"
    else say "Автозапуск не настроен (PID 1: $pid1)."; fi ;;
  *) sed -n '2,5p' "$0"; exit 2 ;;
esac
