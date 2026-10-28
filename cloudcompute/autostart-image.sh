#!/usr/bin/env bash
# YOISAKI ENGINE deployment 1.7.7 · automatic start inside the prebuilt image (no SSH, pip or Termux for the user).
#
#   autostart-image.sh               Image CMD (foreground). Supervises cloudcompute/launcher.py.
#                                    Without a saved provisioning it starts the launcher exactly as 1.7.4 did
#                                    (new token per start, link via ./check-cloudcompute.sh link, no restarts).
#                                    With one (config/engine/autostart.json) it uses the website-issued token,
#                                    publishes signed stages/address (YOISAKI_RENDEZVOUS=ntfy) and restarts a
#                                    failed launcher a few times.
#   autostart-image.sh --provision   Called by the CloudCompute "onstart" script that YOISAKI AI STUDIO generates
#                                    at instance creation: saves YOISAKI_PROVISION_TOKEN (0600), asks a running
#                                    supervisor to restart with it or starts one in the background, returns at once.
#   autostart-image.sh --status      Prints the launcher state as JSON (never the token).
#
# Never prints the token, never deletes models or images, never installs packages.
set -euo pipefail
umask 077

APP=${YOISAKI_APP_DIR:-/opt/yoisaki}
PY=${YOISAKI_PYTHON:-$APP/venv/bin/python}
RUN_UID=${YOISAKI_RUN_UID:-1000}
RUN_GID=${YOISAKI_RUN_GID:-1000}
MAX_RESTARTS=${YOISAKI_AUTOSTART_RESTARTS:-4}
DELAY=${YOISAKI_AUTOSTART_DELAY:-20}
POLL=${YOISAKI_AUTOSTART_POLL:-3}

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }

# /data is the image volume; the others are fallbacks for runtimes that mount storage elsewhere.
data_root() {
  local d
  for d in "${YOISAKI_DATA_ROOT:-}" /data /workspace/yoisaki-data "${HOME:-/root}/yoisaki-data"; do
    [[ -n $d ]] || continue
    if mkdir -p "$d" 2>/dev/null && [[ -w $d ]]; then printf '%s\n' "$d"; return 0; fi
  done
  return 1
}
DATA=$(data_root) || { log 'ОШИБКА: нет папки данных, доступной для записи (/data).'; exit 3; }
export YOISAKI_DATA_ROOT=$DATA
SECRETS=$DATA/config/engine
TOKEN_FILE=$SECRETS/engine.token
PROVISION=$SECRETS/autostart.json
STATE=$DATA/runtime/state
RESTART_FLAG=$STATE/autostart.restart
mkdir -p "$SECRETS" "$STATE" "$DATA/logs"
chmod 700 "$SECRETS" "$STATE" 2>/dev/null || true

write_private() {   # $1 = file, $2 = content; atomic, 0600
  local tmp="$1.tmp.$$"
  printf '%s\n' "$2" > "$tmp"
  chmod 600 "$tmp"
  mv -f "$tmp" "$1"
}

provisioned() {
  [[ -s $PROVISION && -s $TOKEN_FILE ]] && grep -q '"stable_link": *true' "$PROVISION"
}

# Root (the provider's onstart) prepares the data folder for the unprivileged engine user of the image.
fix_owner() {
  [[ $EUID -eq 0 ]] || return 0
  find "$DATA" -xdev \( ! -uid "$RUN_UID" -o ! -gid "$RUN_GID" \) -exec chown -h "$RUN_UID:$RUN_GID" {} + 2>/dev/null || true
}

# Runs in a background subshell: exec makes $! the launcher itself, so SIGTERM reaches it (and its children).
as_engine_user() {
  if [[ $EUID -eq 0 ]] && command -v setpriv >/dev/null 2>&1; then
    HOME=$DATA/runtime/home exec setpriv --reuid="$RUN_UID" --regid="$RUN_GID" --clear-groups -- "$@"
  else
    exec "$@"
  fi
}

stage() {   # signed initialization stage for the website (best effort, never blocks the start)
  provisioned || return 0
  YOISAKI_TOKEN_FILE=$TOKEN_FILE "$PY" "$APP/cloudcompute/rendezvous.py" status "$1" >/dev/null 2>&1 &
}

provision() {
  local token=${YOISAKI_PROVISION_TOKEN:-}
  unset YOISAKI_PROVISION_TOKEN
  [[ $token =~ ^[a-f0-9]{64}$ ]] || { log 'ОШИБКА: YOISAKI_PROVISION_TOKEN отсутствует или неверен.'; exit 2; }
  write_private "$TOKEN_FILE" "$token"
  write_private "$PROVISION" '{"version": 1, "stable_link": true, "rendezvous": "ntfy"}'
  : > "$RESTART_FLAG"
  fix_owner
  log 'Токен движка от YOISAKI AI STUDIO сохранён (0600).'
}

CHILD=
stop_child() {
  if [[ -n $CHILD ]] && kill -0 "$CHILD" 2>/dev/null; then
    kill -TERM "$CHILD" 2>/dev/null || true
    wait "$CHILD" 2>/dev/null || true
  fi
}
on_signal() { log 'Остановка по сигналу.'; stop_child; exit 0; }

supervise() {
  exec 9>"$STATE/autostart.lock"
  if ! flock -n 9; then
    # 1.7.7: never exit here. When the provider runs "onstart" before the image CMD, the onstart-started supervisor
    # already holds the lock; an exiting CMD would end PID 1 (tini) and stop the whole container with the engine.
    # Wait instead and take over only if that supervisor ends (its own restart limit still applies to it).
    log 'Автозапуск уже работает в этом контейнере: он сам применит новый токен. Ожидаю его завершения.'
    flock 9
    log 'Предыдущий автозапуск завершился: продолжаю наблюдение за движком.'
  fi
  trap on_signal TERM INT HUP
  local restarts=0 code managed
  set +e
  while :; do
    rm -f "$RESTART_FLAG"
    # 1.7.7: always, not only when provisioned. Started as root (the 1.7.7 image default, or a provider that runs the
    # container as root), this script creates the data folders as root; the engine runs as uid 1000 and needs them.
    fix_owner
    if provisioned; then
      managed=1
      export YOISAKI_STABLE_LINK=1 YOISAKI_RENDEZVOUS=ntfy
      stage IMAGE_READY
      log "Запуск YOISAKI ENGINE (автоматическая инициализация, данные: $DATA)…"
    else
      managed=0
      log "Запуск YOISAKI ENGINE (данные: $DATA)…"
    fi
    as_engine_user "$PY" "$APP/cloudcompute/launcher.py" run 9>&- &
    CHILD=$!
    while kill -0 "$CHILD" 2>/dev/null; do
      if [[ -e $RESTART_FLAG ]]; then
        log 'Получена новая конфигурация запуска: перезапускаю движок.'
        stop_child
        break
      fi
      sleep "$POLL"
    done
    wait "$CHILD" 2>/dev/null
    code=$?
    CHILD=
    if [[ -e $RESTART_FLAG ]]; then restarts=0; continue; fi
    if (( code == 0 )); then log 'Движок остановлен.'; return 0; fi
    if (( managed == 0 )); then return "$code"; fi   # 1.7.4 behaviour: no automatic restarts
    restarts=$((restarts + 1))
    if (( restarts > MAX_RESTARTS )); then
      log "Движок не запустился после $MAX_RESTARTS перезапусков. Журнал: $DATA/logs/server.log"
      return "$code"
    fi
    log "Движок завершился (код $code). Повтор через $((DELAY * restarts)) с ($restarts/$MAX_RESTARTS)."
    sleep $((DELAY * restarts))
  done
}

case ${1:-} in
  --provision)
    provision
    if flock -n "$STATE/autostart.lock" true 2>/dev/null; then
      nohup setsid "$0" >>"$DATA/logs/autostart.log" 2>&1 </dev/null &
      log "Автозапуск движка начат в фоне (журнал: $DATA/logs/autostart.log)."
    else
      log 'Автозапуск уже работает: движок будет перезапущен с новым токеном.'
    fi
    ;;
  --status)
    exec "$PY" "$APP/cloudcompute/launcher.py" status
    ;;
  '')
    supervise
    ;;
  *)
    echo 'Использование: autostart-image.sh [--provision|--status]' >&2
    exit 2
    ;;
esac
