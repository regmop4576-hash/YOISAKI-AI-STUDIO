#!/usr/bin/env bash
# Stop YOISAKI ENGINE on the CloudCompute server (run ON THE SERVER).
# Stops the tunnel and the engine only. Models, caches, outputs, the Docker image and the venv stay.
# The GPU instance keeps running and billing: stop it in the CloudCompute panel.
set -euo pipefail
# shellcheck source=cloudcompute/lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/cloudcompute/lib.sh"
yoisaki_load_config
STATE=$YOISAKI_DATA_ROOT/runtime/state
stopped=0

if ! yoisaki_in_image && command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 \
   && [[ -n $(yoisaki_container_state) ]]; then
  say 'Останавливаю контейнер yoisaki-engine (до 45 с на корректное завершение)…'
  # down: removes only the container; image, data folder and caches are kept.
  yoisaki_compose down --timeout 45
  stopped=1
fi

pid=$(yoisaki_state_pid)
if yoisaki_native_running; then
  say "Останавливаю движок (PID $pid)…"
  kill -TERM "$pid"
  for _ in $(seq 60); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
  if kill -0 "$pid" 2>/dev/null; then warn 'Не завершился за 60 с — принудительная остановка.'; kill -KILL "$pid"; fi
  stopped=1
fi

# Leftover engine/tunnel processes of a launcher that was killed hard (matched by command line).
if [[ -n $pid && -f $STATE/launcher.json ]]; then
  for child in $(sed -nE 's/.*"children": \[([0-9, ]*)\].*/\1/p' "$STATE/launcher.json" | tr ',' ' '); do
    if kill -0 "$child" 2>/dev/null && grep -qaE 'worker\.serve|cloudflared' "/proc/$child/cmdline"; then
      kill -TERM "$child"; sleep 3; kill -0 "$child" 2>/dev/null && kill -KILL "$child"
      stopped=1
    fi
  done
fi
rm -f -- "$STATE/link.txt" "$STATE/token"

if [[ $stopped == 1 ]]; then say '✔ YOISAKI ENGINE остановлен. Ссылка на сайте больше не работает.'
else say 'Движок не был запущен.'; fi
yoisaki_billing_notice
