#!/usr/bin/env bash
# Start YOISAKI ENGINE on a CloudCompute GPU server (run ON THE SERVER, not in Termux).
#   ./start-cloudcompute.sh [--mode auto|docker|native] [--rebuild]
# Idempotent: installed dependencies, the Docker image and all weights on the data disk are reused.
# Data folder: $YOISAKI_DATA_ROOT (default /workspace/yoisaki-data).
set -euo pipefail
# shellcheck source=cloudcompute/lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/cloudcompute/lib.sh"

REBUILD=0
while (($#)); do
  case $1 in
    --mode) export YOISAKI_MODE=${2:?}; shift 2 ;;
    --rebuild) REBUILD=1; shift ;;
    -h|--help) sed -n '2,6p' "$0"; exit 0 ;;
    *) die "Неизвестный параметр: $1" ;;
  esac
done

yoisaki_load_config
TIMEOUT=${YOISAKI_START_TIMEOUT:-900}
# Drive sync writes verified files into models/: the engine container mounts it rw only when sync is on.
if [[ ${YOISAKI_DRIVE_SYNC:-1} == 0 ]]; then export YOISAKI_MODELS_MOUNT=ro; else export YOISAKI_MODELS_MOUNT=rw; fi
MODE=$(yoisaki_mode)
STATE=$YOISAKI_DATA_ROOT/runtime/state

say "YOISAKI ENGINE · CloudCompute · режим: $MODE · данные: $YOISAKI_DATA_ROOT"
command -v nvidia-smi >/dev/null && nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader 2>/dev/null | sed 's/^/GPU: /' || true
yoisaki_prepare_dirs
free_gb=$(df -Pk "$YOISAKI_DATA_ROOT" | awk 'NR==2 {print int($4/1048576)}')
(( free_gb >= 10 )) || warn "Свободно ${free_gb} ГБ на диске данных: мало для моделей и кэша."

tunnel_hint() {
  if [[ ${YOISAKI_TUNNEL:-1} == 0 ]]; then say 'Туннель отключён (YOISAKI_TUNNEL=0): движок доступен только на сервере.'
  else say 'Туннель ещё готовится: ./check-cloudcompute.sh link'; fi
}

wait_for_link() {   # $1 = command that succeeds while the engine is alive
  local alive=$1 start=$SECONDS
  say 'Жду готовности: проверка GPU → сервер → (прогрев) → туннель Cloudflare…'
  until yoisaki_ready; do
    if ! $alive; then return 1; fi
    if (( SECONDS - start > TIMEOUT )); then warn "Нет готовности за ${TIMEOUT} с."; return 1; fi
    sleep 2
  done
}

# YOISAKI_DRIVE_AUTOSYNC=1: download missing/changed models BEFORE the engine and tunnel start.
autosync() {
  [[ ${YOISAKI_DRIVE_AUTOSYNC:-0} == 1 && ${YOISAKI_DRIVE_SYNC:-1} != 0 ]] || return 0
  if [[ ! -s $YOISAKI_DATA_ROOT/config/rclone/rclone.conf ]]; then
    warn 'YOISAKI_DRIVE_AUTOSYNC=1, но Google Drive не подключён: ./drive-sync-cloudcompute.sh connect'
    return 0
  fi
  say 'Синхронизация моделей с Google Drive перед запуском движка…'
  bash "$YOISAKI_APP/drive-sync-cloudcompute.sh" sync || warn 'Синхронизация не завершена; движок запускается с уже установленными моделями.'
}

source_hash() {
  (cd "$YOISAKI_APP" && find Dockerfile engine cloudcompute -type f ! -path '*/__pycache__/*' ! -path 'engine/.venv/*' ! -path 'engine/.results/*' -print0 \
     | sort -z | xargs -0 sha256sum | sha256sum | cut -c1-16)
}

start_docker() {
  yoisaki_docker_ok || die 'Docker недоступен. Запустите с --mode native.'
  if [[ $(id -u) == 0 ]]; then export YOISAKI_UID=1000 YOISAKI_GID=1000; yoisaki_grant 1000:1000
  else export YOISAKI_UID; YOISAKI_UID=$(id -u); export YOISAKI_GID; YOISAKI_GID=$(id -g); fi
  YOISAKI_SOURCE_HASH=$(source_hash); export YOISAKI_SOURCE_HASH
  if [[ $(yoisaki_container_state) == running ]]; then
    say '✔ Движок уже запущен (контейнер yoisaki-engine).'
    yoisaki_print_link || tunnel_hint
    return
  fi
  local built
  built=$(docker image inspect -f '{{index .Config.Labels "org.yoisaki.source"}}' "$YOISAKI_IMAGE" 2>/dev/null || true)
  if [[ $REBUILD == 1 || $built != "$YOISAKI_SOURCE_HASH" ]]; then
    if [[ -z $built ]]; then say 'Первая сборка образа: загрузка PyTorch и зависимостей (несколько ГБ, только один раз).'
    else say 'Файлы движка изменились: пересборка (слои зависимостей берутся из кэша).'; fi
    yoisaki_compose build engine
  else
    say "✔ Образ $YOISAKI_IMAGE уже собран — пересборка не нужна."
  fi
  autosync
  rm -f -- "$STATE/link.txt" "$STATE/launcher.json"
  yoisaki_compose up -d --no-build engine
  docker_alive() { [[ $(yoisaki_container_state) == running ]]; }
  if ! wait_for_link docker_alive; then
    docker logs --tail 60 "$YOISAKI_CONTAINER" 2>&1 | yoisaki_redact
    die 'Движок не запустился. Подробности: ./check-cloudcompute.sh logs'
  fi
}

start_native() {
  local py run=()
  if yoisaki_native_running; then
    say '✔ Движок уже запущен.'
    yoisaki_print_link || tunnel_hint
    return
  fi
  if ! yoisaki_in_image; then bash "$YOISAKI_APP/cloudcompute/install-native.sh"; fi
  py=$(yoisaki_python)
  [[ -x $py ]] || die "Не найден Python окружения: $py"
  export YOISAKI_PYTHON=$py YOISAKI_ENGINE_DIR=${YOISAKI_ENGINE_DIR:-$YOISAKI_APP/engine}
  [[ -n ${YOISAKI_CLOUDFLARED:-} ]] || export YOISAKI_CLOUDFLARED=$YOISAKI_DATA_ROOT/runtime/bin/cloudflared
  # Root login (typical for a rented container): run the engine as an unprivileged user.
  if [[ $(id -u) == 0 && ${YOISAKI_RUN_AS_ROOT:-0} != 1 ]] && command -v runuser >/dev/null && command -v useradd >/dev/null; then
    if ! id "$YOISAKI_RUN_USER" >/dev/null 2>&1; then
      if getent passwd 1000 >/dev/null; then useradd --system --no-create-home --shell /usr/sbin/nologin "$YOISAKI_RUN_USER"
      else useradd --system --uid 1000 --no-create-home --shell /usr/sbin/nologin "$YOISAKI_RUN_USER"; fi
    fi
    yoisaki_grant "$YOISAKI_RUN_USER:$(id -gn "$YOISAKI_RUN_USER")"
    run=(runuser -u "$YOISAKI_RUN_USER" --)
    # e.g. a package or data folder under /root (mode 700) is invisible to the engine user.
    "${run[@]}" test -x "$py" -a -r "$YOISAKI_APP/cloudcompute/launcher.py" -a -r "$YOISAKI_ENGINE_DIR/worker/serve.py" \
      || die "Пользователь $YOISAKI_RUN_USER не может прочитать $YOISAKI_APP или $YOISAKI_DATA_ROOT. Разместите их вне /root (например, в /workspace)."
  elif [[ $(id -u) == 0 ]]; then
    warn 'Движок будет работать от root (нет runuser/useradd или YOISAKI_RUN_AS_ROOT=1).'
  fi
  autosync
  rm -f -- "$STATE/link.txt" "$STATE/launcher.json"
  [[ -f $YOISAKI_DATA_ROOT/logs/launcher.out ]] && mv -f "$YOISAKI_DATA_ROOT/logs/launcher.out" "$YOISAKI_DATA_ROOT/logs/launcher.out.1"
  # Detached from this SSH session: closing Termux does not stop the engine.
  setsid nohup "${run[@]}" env HOME="$YOISAKI_DATA_ROOT/runtime/home" "$py" "$YOISAKI_APP/cloudcompute/launcher.py" run \
    >>"$YOISAKI_DATA_ROOT/logs/launcher.out" 2>&1 </dev/null &
  local spawned=$! started=$SECONDS
  native_alive() { yoisaki_native_running || { kill -0 "$spawned" 2>/dev/null && (( SECONDS - started < 30 )); }; }
  if ! wait_for_link native_alive; then
    tail -n 40 "$YOISAKI_DATA_ROOT/logs/launcher.out" 2>/dev/null | yoisaki_redact
    die 'Движок не запустился. Подробности: ./check-cloudcompute.sh logs'
  fi
}

case $MODE in
  docker) start_docker ;;
  native) start_native ;;
esac
tail -n 8 "$YOISAKI_DATA_ROOT/logs/launcher.out" 2>/dev/null | grep -E 'готов|Прогрев' | yoisaki_redact || true
yoisaki_print_link || true
say ''
say 'Проверка: ./check-cloudcompute.sh   ·   Остановка: ./stop-cloudcompute.sh'
yoisaki_billing_notice
