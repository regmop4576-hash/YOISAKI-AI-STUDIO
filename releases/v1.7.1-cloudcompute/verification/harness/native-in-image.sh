#!/usr/bin/env bash
# VALIDATION ONLY: runs inside the yoisaki-engine image as uid 1000 (custom-image scenario, native mode).
run() { echo; echo "\$ $*"; "$@" 2>&1; echo "[exit $?]"; }
srv() { pgrep -f '^/opt/yoisaki/venv/bin/python -m worker.serve' | wc -l; }
lch() { pgrep -f 'cloudcompute/launcher.py run' | wc -l; }
echo "# v1.7.1 native mode INSIDE the image (custom-image scenario), uid $(id -u), YOISAKI_IN_IMAGE=$YOISAKI_IN_IMAGE"
cd /opt/yoisaki || exit 1
run ./start-cloudcompute.sh
echo "engine server processes: $(srv); launchers: $(lch)"
run ./start-cloudcompute.sh
echo '$ ./check-cloudcompute.sh json -> engine_state'
./check-cloudcompute.sh json | python3 -c 'import json,sys;d=json.load(sys.stdin)["engine_state"];print(json.dumps({k:d[k] for k in ("model_loaded","link_ready")}|{"health_state":(d["health"] or {}).get("state")},ensure_ascii=False))'
run ./stop-cloudcompute.sh
echo "engine server processes after stop: $(srv); launchers: $(lch)"
echo
echo '# hard-kill recovery: SIGKILL the launcher; stop must clean the orphaned engine server'
./start-cloudcompute.sh >/dev/null 2>&1
kill -KILL "$(pgrep -f 'cloudcompute/launcher.py run')"
sleep 1
echo "launchers alive: $(lch); orphaned engine servers: $(srv)"
run ./stop-cloudcompute.sh
echo "orphaned engine servers after stop: $(srv)"
