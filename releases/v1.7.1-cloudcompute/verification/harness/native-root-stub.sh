#!/usr/bin/env bash
# VALIDATION ONLY: native mode started by root -> unprivileged "yoisaki" user, with a STUB interpreter.
# The full venv could not be downloaded in this sandbox (see v171-native-install.txt), so runtime/venv/bin/python
# is a symlink to the system python3.12 and the install marker is written with the exact hash install-native.sh
# expects. The engine server therefore cannot start (no fastapi): this checks the privilege-drop, access-check,
# detach, failure-report and stop paths of start/stop-cloudcompute.sh, not inference.
APP=/opt/yoisaki-native-app/YOISAKI_AI_STUDIO_V1.4.0_LOCAL_EDITION CF=$1
run() { echo; echo "\$ $*"; "$@" 2>&1; echo "[exit $?]"; }
stub() {  # $1 = data root
  mkdir -p "$1/runtime/venv/bin" "$1/runtime/bin"
  ln -sf "$(command -v python3.12)" "$1/runtime/venv/bin/python"
  { cat "$APP/cloudcompute/requirements-cloud.txt" "$APP/engine/requirements.txt"; python3.12 -VV; } | sha256sum | cut -c1-64 > "$1/runtime/venv/.yoisaki-install"
  install -m 0755 "$CF" "$1/runtime/bin/cloudflared"
}
cd "$APP" || exit 1
export YOISAKI_TUNNEL=0 YOISAKI_GPU_PREFLIGHT=0 YOISAKI_START_TIMEOUT=60
echo "# running as $(id -un); user yoisaki exists before: $(id yoisaki >/dev/null 2>&1 && echo yes || echo no)"

echo; echo "# 1) data root under /root (mode $(stat -c %a /root)) -> the engine user cannot read the venv -> clear refusal"
stub /root/yoisaki-stub-data
YOISAKI_DATA_ROOT=/root/yoisaki-stub-data run ./start-cloudcompute.sh --mode native

echo; echo "# 2) data root outside /root (/srv): privilege drop, detached launcher as yoisaki, failure reported (no fastapi in the stub)"
stub /srv/yoisaki-stub-data
export YOISAKI_DATA_ROOT=/srv/yoisaki-stub-data
run ./start-cloudcompute.sh --mode native
echo "\$ id yoisaki"; id yoisaki
echo "\$ owners of writable folders"; stat -c '%U %a %n' "$YOISAKI_DATA_ROOT"/{runtime/state,logs,outputs,huggingface-cache,diagnostics} "$YOISAKI_DATA_ROOT"/models/checkpoints
echo "\$ owner of files written by the launcher (= the user it ran as)"; stat -c '%U %a %n' "$YOISAKI_DATA_ROOT"/runtime/state/launcher.json "$YOISAKI_DATA_ROOT"/diagnostics/* 2>&1
echo "\$ launcher.out"; cat "$YOISAKI_DATA_ROOT/logs/launcher.out"
echo "\$ server.log (last lines)"; tail -3 "$YOISAKI_DATA_ROOT/logs/server.log"
run ./stop-cloudcompute.sh
echo "remaining launcher/server processes: $(ps -eo args | grep -cE '[l]auncher.py run|[w]orker.serve')"
