# shellcheck shell=bash
# Shared helpers for the CloudCompute scripts. Sourced, never executed.
# Never prints the engine token; never deletes model weights or generated images.

YOISAKI_APP=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
export YOISAKI_DATA_ROOT=${YOISAKI_DATA_ROOT:-/workspace/yoisaki-data}
# shellcheck disable=SC2034  # constants used by the scripts that source this file
YOISAKI_IMAGE=yoisaki-engine:1.7.7-cloudcompute
YOISAKI_CONTAINER=yoisaki-engine
# shellcheck disable=SC2034
YOISAKI_RUN_USER=yoisaki
# Keep in sync with the Dockerfile ARGs (checked by tests/test_v171_cloudcompute.py).
# shellcheck disable=SC2034
CLOUDFLARED_VERSION=2026.9.3
# shellcheck disable=SC2034
CLOUDFLARED_SHA256=77e26d8d900e0b8469f416239d14b5f296525fdf79fee6f511ef55609e3fbac2

say() { printf '%s\n' "$*"; }
warn() { printf '⚠ %s\n' "$*" >&2; }
die() { printf '✖ %s\n' "$*" >&2; exit 1; }

# Optional persistent settings: $YOISAKI_DATA_ROOT/config/yoisaki.env (KEY=VALUE lines).
# Parsed, not sourced: only whitelisted keys, no command execution, no YOISAKI_TOKEN.
yoisaki_load_config() {
  local file=$YOISAKI_DATA_ROOT/config/yoisaki.env line key value
  [[ -f $file ]] || return 0
  while IFS= read -r line || [[ -n $line ]]; do
    line=${line%$'\r'}
    [[ $line =~ ^[[:space:]]*(#|$) ]] && continue
    [[ $line =~ ^([A-Z_][A-Z0-9_]*)=(.*)$ ]] || { warn "Пропущена строка в yoisaki.env: ${line%%=*}"; continue; }
    key=${BASH_REMATCH[1]} value=${BASH_REMATCH[2]}
    value=${value#\"} value=${value%\"}
    case $key in
      YOISAKI_TOKEN|YOISAKI_DATA_ROOT) warn "$key в yoisaki.env игнорируется." ;;
      YOISAKI_*|HF_TOKEN|CIVITAI_TOKEN|PYTORCH_CUDA_ALLOC_CONF) [[ -v $key ]] || export "$key=$value" ;;
      *) warn "Неизвестный ключ в yoisaki.env: $key" ;;
    esac
  done < "$file"
}

yoisaki_in_image() { [[ ${YOISAKI_IN_IMAGE:-0} == 1 ]]; }

yoisaki_docker_ok() {
  command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 && docker compose version >/dev/null 2>&1
}

yoisaki_docker_gpu() {
  docker info --format '{{json .Runtimes}}' 2>/dev/null | grep -q nvidia && return 0
  compgen -G '/etc/cdi/nvidia*.yaml' >/dev/null || compgen -G '/var/run/cdi/nvidia*.yaml' >/dev/null
}

# auto: Docker when this server runs Docker with NVIDIA support, otherwise a venv on the data disk.
yoisaki_mode() {
  local mode=${YOISAKI_MODE:-auto}
  if yoisaki_in_image; then say native; return; fi
  case $mode in
    docker|native) say "$mode" ;;
    # An existing YOISAKI image means this server already runs in Docker mode.
    auto) if yoisaki_docker_ok && { yoisaki_docker_gpu || docker image inspect "$YOISAKI_IMAGE" >/dev/null 2>&1; }; then say docker; else say native; fi ;;
    *) die "YOISAKI_MODE должен быть auto, docker или native." ;;
  esac
}

# YOISAKI_COMPOSE_OVERRIDE: optional extra compose file (e.g. additional volumes) merged over ours.
yoisaki_compose() {
  local files=(-f "$YOISAKI_APP/docker-compose.yml")
  [[ -n ${YOISAKI_COMPOSE_OVERRIDE:-} ]] && files+=(-f "$YOISAKI_COMPOSE_OVERRIDE")
  docker compose -p yoisaki "${files[@]}" "$@"
}

# Ready = the verified tunnel link exists (or, with YOISAKI_TUNNEL=0, the launcher reports READY).
yoisaki_ready() {
  local state=$YOISAKI_DATA_ROOT/runtime/state
  [[ -s $state/link.txt ]] && return 0
  # 1.7.3: the engine runs and only the tunnel is being retried (it reconnects by itself).
  grep -q '"phase": "TUNNEL_RETRY"' "$state/launcher.json" 2>/dev/null && return 0
  [[ ${YOISAKI_TUNNEL:-1} == 0 ]] && grep -q '"phase": "READY"' "$state/launcher.json" 2>/dev/null
}

yoisaki_container_state() {
  docker inspect -f '{{.State.Status}}' "$YOISAKI_CONTAINER" 2>/dev/null || true
}

yoisaki_python() {
  if [[ -n ${YOISAKI_PYTHON:-} && -x ${YOISAKI_PYTHON} ]]; then say "$YOISAKI_PYTHON"
  elif [[ -f $YOISAKI_DATA_ROOT/runtime/reused-python ]] && [[ -x $(cat "$YOISAKI_DATA_ROOT/runtime/reused-python") ]]; then cat "$YOISAKI_DATA_ROOT/runtime/reused-python"
  else say "$YOISAKI_DATA_ROOT/runtime/venv/bin/python"; fi
}

# Host-side python able to run the stdlib-only launcher/diagnostics helpers.
yoisaki_host_python() {
  local py; py=$(yoisaki_python)
  if [[ -x $py ]]; then say "$py"; elif command -v python3 >/dev/null; then command -v python3; else say ''; fi
}

yoisaki_redact() { sed -E 's/[a-f0-9]{64}/[СКРЫТО]/g; s/(#token=|Bearer )[^[:space:]"]+/\1[СКРЫТО]/g; s/ya29\.[[:alnum:]._-]+|1\/\/[[:alnum:]._-]{20,}|GOCSPX-[[:alnum:]_-]+/[СКРЫТО]/g; s/"(access_token|refresh_token|client_secret)" *: *"[^"]*"/"\1":"[СКРЫТО]"/g'; }

# Create only missing folders (same layout as Google Drive: models/{checkpoints,loras,vae,controlnet}).
yoisaki_prepare_dirs() {
  local d
  for d in models/checkpoints models/loras models/vae models/controlnet models/.yoisaki-sync huggingface-cache outputs logs diagnostics \
           runtime/state runtime/home runtime/bin runtime/sync config config/rclone config/engine sdpose; do
    mkdir -p "$YOISAKI_DATA_ROOT/$d" 2>/dev/null || [[ -d $YOISAKI_DATA_ROOT/$d ]] \
      || die "Нет прав на создание $YOISAKI_DATA_ROOT/$d (владелец папки данных: $(stat -c %U "$YOISAKI_DATA_ROOT" 2>/dev/null || echo '?'))."
  done
  # Only folders we own (a folder prepared by root for the engine user is left as it is).
  for d in runtime/state runtime/sync config/rclone config/engine models/.yoisaki-sync; do [[ -O $YOISAKI_DATA_ROOT/$d ]] && chmod 700 "$YOISAKI_DATA_ROOT/$d"; done
  # config/: traverse-only for the engine user (reaches its own config/rclone); yoisaki.env stays 0600 and unlistable.
  [[ -O $YOISAKI_DATA_ROOT/config ]] && chmod 711 "$YOISAKI_DATA_ROOT/config"
  [[ -w $YOISAKI_DATA_ROOT/runtime/state && -w $YOISAKI_DATA_ROOT/logs ]] \
    || die "Нет прав на запись в $YOISAKI_DATA_ROOT/runtime/state или logs. Запустите от владельца папки данных или от root."
  # Persistence probe, written once: if its date survives an instance stop/start, the disk is persistent.
  local marker=$YOISAKI_DATA_ROOT/.yoisaki-data-id
  [[ -e $marker || ! -w $YOISAKI_DATA_ROOT ]] || printf '{"id": "%s", "created_unix": %s}\n' "$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')" "$(date +%s)" > "$marker"
}

# The engine runs unprivileged: give its user the folders it writes (never the model files themselves).
yoisaki_grant() {
  local owner=$1 d
  [[ $(id -u) == 0 ]] || return 0
  for d in huggingface-cache outputs logs diagnostics runtime/state runtime/home runtime/sync config/rclone config/engine models/.yoisaki-sync; do
    chown -R "$owner" "$YOISAKI_DATA_ROOT/$d"
  done
  # Folders only (files keep their owner): lets fetch-models / Drive sync add files, also in subfolders.
  chown "$owner" "$YOISAKI_DATA_ROOT/models"/controlnet
  find "$YOISAKI_DATA_ROOT/models"/{checkpoints,loras,vae} -type d -exec chown "$owner" {} +
}

yoisaki_state_pid() {
  local file=$YOISAKI_DATA_ROOT/runtime/state/launcher.json
  [[ -f $file ]] || return 0
  local here=false; yoisaki_in_image && here=true
  grep -q "\"in_image\": $here" "$file" || return 0
  sed -nE 's/.*"pid": ([0-9]+).*/\1/p' "$file"
}

yoisaki_native_running() {
  local pid; pid=$(yoisaki_state_pid)
  [[ -n $pid ]] && kill -0 "$pid" 2>/dev/null && grep -q 'launcher.py' "/proc/$pid/cmdline" 2>/dev/null
}

yoisaki_print_link() {
  local link=$YOISAKI_DATA_ROOT/runtime/state/link.txt
  [[ -s $link ]] || return 1
  say ''
  say '🔗 Ссылка для YOISAKI AI STUDIO (страница «GPU» → поле URL туннеля):'
  say ''
  cat -- "$link"
  say ''
  say 'Ссылка содержит секретный токен: не публикуйте её.'
  if [[ ${YOISAKI_STABLE_LINK:-0} == 1 ]]; then
    say 'Токен постоянный: на сайте отметьте «Запомнить» — дальше подключение одной кнопкой.'
    [[ ${YOISAKI_TUNNEL_MODE:-quick} == named ]] || say 'Адрес Quick Tunnel меняется при каждом запуске: включите Named Tunnel или автообнаружение (./setup-cloudcompute.sh).'
  else
    say 'После перезапуска движка ссылка меняется. Подключение одной кнопкой: ./setup-cloudcompute.sh'
  fi
}

yoisaki_billing_notice() {
  say ''
  say '💰 Остановка движка НЕ останавливает оплату GPU-инстанса.'
  say '   Остановите или удалите инстанс в панели CloudCompute. Остановленный инстанс продолжает'
  say '   оплачивать хранение диска; удаление инстанса может безвозвратно удалить модели на его диске.'
}
