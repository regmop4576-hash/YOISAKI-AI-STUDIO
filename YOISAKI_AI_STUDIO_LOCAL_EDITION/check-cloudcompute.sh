#!/usr/bin/env bash
# Diagnostics on the CloudCompute server (run ON THE SERVER).
#   ./check-cloudcompute.sh          GPU, CUDA, VRAM, RAM, disk, paths, versions, engine state, timings
#   ./check-cloudcompute.sh link     the website link with token (print only to your own terminal)
#   ./check-cloudcompute.sh logs     last lines of the launcher / engine / tunnel logs (tokens hidden)
#   ./check-cloudcompute.sh json     the same report as JSON
#   ./check-cloudcompute.sh models   every model the engine sees, its compatibility and why (1.7.3)
#   ./check-cloudcompute.sh rotate-token   revoke remembered website connections (new token after restart, 1.7.3)
set -euo pipefail
# shellcheck source=cloudcompute/lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/cloudcompute/lib.sh"
yoisaki_load_config
COMMAND=${1:-report}
LOGS=$YOISAKI_DATA_ROOT/logs

docker_mode() { ! yoisaki_in_image && command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 && [[ -n $(yoisaki_container_state) || $(yoisaki_mode) == docker ]]; }

report() {   # $@ = extra diagnose.py arguments
  tool diagnose.py "$@"
}

tool() {   # $1 = script in cloudcompute/, $@ = its arguments; runs where the engine runs (container or venv)
  local script=$1; shift
  if docker_mode; then
    if [[ $(yoisaki_container_state) == running ]]; then
      docker exec "$YOISAKI_CONTAINER" /opt/yoisaki/venv/bin/python "/opt/yoisaki/cloudcompute/$script" "$@"
    elif docker image inspect "$YOISAKI_IMAGE" >/dev/null 2>&1; then
      [[ $(id -u) == 0 ]] && export YOISAKI_UID=1000 YOISAKI_GID=1000
      yoisaki_compose --profile tools run --rm --no-deps tools "/opt/yoisaki/cloudcompute/$script" "$@"
    elif [[ $script != diagnose.py ]]; then
      die 'Образ ещё не собран: сначала ./start-cloudcompute.sh'
    else
      say 'Образ ещё не собран (будет собран при первом ./start-cloudcompute.sh). Краткая проверка хоста:'
      if command -v nvidia-smi >/dev/null; then nvidia-smi; else warn 'nvidia-smi не найден.'; fi
      df -h "$YOISAKI_DATA_ROOT" 2>/dev/null || true; free -h || true
    fi
    return
  fi
  local py; py=$(yoisaki_host_python)
  [[ -n $py ]] || die 'Python не найден. Сначала выполните ./start-cloudcompute.sh'
  YOISAKI_ENGINE_DIR=${YOISAKI_ENGINE_DIR:-$YOISAKI_APP/engine} HF_HOME=${HF_HOME:-$YOISAKI_DATA_ROOT/huggingface-cache} \
    "$py" "$YOISAKI_APP/cloudcompute/$script" "$@"
}

case $COMMAND in
  report) report ;;
  json) report --json ;;
  models) tool models_report.py "${@:2}" ;;
  rotate-token) tool launcher.py rotate-token ;;
  link)
    yoisaki_print_link || die 'Ссылки нет: движок не запущен или туннель ещё готовится. Запуск: ./start-cloudcompute.sh' ;;
  logs)
    for f in launcher.out server.log tunnel.log; do
      [[ -f $LOGS/$f ]] || continue
      say "===== $f (последние 40 строк)"; tail -n 40 "$LOGS/$f" | yoisaki_redact
    done
    if docker_mode && [[ -n $(yoisaki_container_state) ]]; then
      say '===== docker logs yoisaki-engine'; docker logs --tail 40 "$YOISAKI_CONTAINER" 2>&1 | yoisaki_redact
    fi ;;
  *) sed -n '2,9p' "$0"; exit 2 ;;
esac
