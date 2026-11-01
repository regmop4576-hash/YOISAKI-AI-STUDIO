#!/usr/bin/env bash
# Docker runtime validation (no GPU): production compose + override without GPU reservation, real rclone in the image.
set -euo pipefail
S=$1; W=$2; T=e5$(printf 'e%.0s' {1..62})
export YOISAKI_DATA_ROOT=$S/dockerdata YOISAKI_COMPOSE_OVERRIDE=$S/validate/override.yml
rm -rf "$YOISAKI_DATA_ROOT"; cd "$W"
source cloudcompute/lib.sh
yoisaki_prepare_dirs; yoisaki_grant 1000:1000
printf '[yoisaki-gdrive]\ntype = alias\nremote = /drive\n' > "$YOISAKI_DATA_ROOT/config/rclone/rclone.conf"
chown 1000:1000 "$YOISAKI_DATA_ROOT/config/rclone/rclone.conf"; chmod 600 "$YOISAKI_DATA_ROOT/config/rclone/rclone.conf"
cat > "$YOISAKI_COMPOSE_OVERRIDE" <<YML
services:
  engine:
    deploy: !reset {}
    healthcheck: {disable: true}
    working_dir: /opt/yoisaki/engine
    command: ["/opt/yoisaki/venv/bin/python", "/opt/yoisaki/cloudcompute/serve_cloud.py"]
    environment:
      YOISAKI_TOKEN: "$T"
      YOISAKI_MODEL_ROOT: /data/models
      YOISAKI_RESULTS_DIR: /data/outputs
      PYTHONPATH: /opt/yoisaki/engine
    volumes: ["$S/smoke/drive:/drive:ro"]
  tools:
    deploy: !reset {}
    volumes: ["$S/smoke/drive:/drive:ro"]
YML
export YOISAKI_UID=1000 YOISAKI_GID=1000
api() { docker exec yoisaki-engine curl -s -X "$1" -H "Authorization: Bearer $T" "http://127.0.0.1:8765$2"; }
echo '== 1. models mounted READ-ONLY (YOISAKI_MODELS_MOUNT=ro): sync refused with a clear error'
YOISAKI_MODELS_MOUNT=ro yoisaki_compose up -d --no-build engine; sleep 4
api POST /sync/start; echo
docker exec yoisaki-engine sh -c 'id; touch /opt/x 2>&1 | head -1; touch /data/models/x 2>&1 | head -1'
yoisaki_compose down
echo '== 2. YOISAKI_MODELS_MOUNT=rw (what start-cloudcompute.sh sets): authenticated sync through the engine API'
YOISAKI_MODELS_MOUNT=rw yoisaki_compose up -d --no-build engine; sleep 4
docker exec yoisaki-engine curl -s -o /dev/null -w 'no token -> HTTP %{http_code}\n' http://127.0.0.1:8765/sync/status
api POST /sync/start | head -c 120; echo
for i in $(seq 1 120); do s=$(api GET /sync/status); grep -q '"state":"RUNNING"' <<<"$s" || break; sleep 1; done
python3 -c 'import json,sys; d=json.loads(sys.argv[1]); j=d["job"]; print("job:", j["state"], j["overall"]); [print(" ", i["state"], i["path"]) for i in d["items"]]' "$s"
echo '== 3. CLI via docker exec while the engine runs (same lock): nothing to download'
bash drive-sync-cloudcompute.sh sync | grep -E 'DONE|Последняя операция'
yoisaki_compose down
echo '== 4. CLI with the engine stopped (one-off tools container)'
bash drive-sync-cloudcompute.sh status | head -3
echo '== host view'
stat -c '%U:%G %a %n' "$YOISAKI_DATA_ROOT"/models/checkpoints/* "$YOISAKI_DATA_ROOT"/config/rclone/rclone.conf "$YOISAKI_DATA_ROOT"/runtime/sync/*
ls -A "$YOISAKI_DATA_ROOT/models/.yoisaki-sync" | wc -l | sed 's/^/staging files left: /'
cmp "$S/smoke/drive/YOISAKI_AI_STUDIO/models/checkpoints/Illustrious XL.safetensors" "$YOISAKI_DATA_ROOT/models/checkpoints/Illustrious XL.safetensors" && echo 'checkpoint bytes identical to the Drive fixture'
docker logs yoisaki-engine 2>&1 | grep -c "$T" | sed 's/^/token occurrences in docker logs: /' || true
