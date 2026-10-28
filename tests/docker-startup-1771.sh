#!/usr/bin/env bash
# Real image / real FastAPI on CPU. No GPU inference claim. Run on a Docker-capable host.
# No container here gets a GPU, so the unchanged engine answers an authenticated /health with state=ERROR and
# gpu_name=null by design: READY (and `launcher.py healthcheck`) need CUDA and are covered only by a real GPU run.
# YOISAKI_SERVER_TIMEOUT keeps the launcher (and its real server) waiting for READY while the CPU checks run.
set -euo pipefail
IMAGE=${1:?image required}
PREFIX=yoisaki-startup-$$
WORK=$(mktemp -d)
cleanup() { docker rm -f "$PREFIX-normal" "$PREFIX-override" >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }
CPU_ENV=(-e YOISAKI_GPU_PREFLIGHT=0 -e YOISAKI_TUNNEL=0 -e YOISAKI_SERVER_TIMEOUT=900)
# Exit 0: the real engine answers /health with the launcher's token (and refuses a request without it), honestly
# reporting no GPU. Exit 10: nothing listens on the engine port. Anything else: not ready / unexpected answer.
PROBE='
import json, sys, urllib.error, urllib.request
sys.path.insert(0, "/opt/yoisaki/cloudcompute")
from launcher import Config, read_private, request_json
cfg = Config()
try:
    urllib.request.urlopen(cfg.local + "/health", timeout=5)
    sys.exit("unauthenticated /health was answered")
except urllib.error.HTTPError as exc:
    if exc.code != 401:
        sys.exit(f"unauthenticated /health: HTTP {exc.code}")
except OSError:
    sys.exit(10)
token = read_private(cfg, "token")
if not token:
    sys.exit("no launcher token yet")
health = request_json(cfg.local + "/health", token, timeout=5)
print(json.dumps({k: health.get(k) for k in ("engine", "engine_version", "api_version", "state", "gpu_name")}))
if health.get("engine") != "YOISAKI_ENGINE" or health.get("state") != "ERROR" or health.get("gpu_name") is not None:
    sys.exit("unexpected CPU health")
'
probe() { docker exec "$1" /opt/yoisaki/venv/bin/python -c "$PROBE"; }
wait_engine() {
 local name=$1 out
 for attempt in {1..90}; do
  if out=$(probe "$name" 2>&1); then
   echo "engine /health: $out"
   if docker exec "$name" /opt/yoisaki/venv/bin/python /opt/yoisaki/cloudcompute/launcher.py healthcheck; then fail "healthcheck READY without a GPU: $name"; fi
   return
  fi
  sleep 2
 done
 echo "last probe: $out"; docker logs "$name" 2>&1 | tail -n 40; fail "engine timeout: $name"
}
engine_down() {
 local code=0
 probe "$1" >/dev/null 2>&1 || code=$?
 [[ $code == 10 ]]
}
cfg=$(docker image inspect "$IMAGE" --format '{{.Os}}/{{.Architecture}}|{{json .Config.Entrypoint}}|{{json .Config.Cmd}}|{{index .Config.Labels "org.opencontainers.image.version"}}')
[[ $cfg == 'linux/amd64|["/usr/bin/tini","--"]|["/opt/yoisaki/cloudcompute/autostart-image.sh"]|1.7.7.1' ]] || fail "$cfg"
pass 'amd64, ENTRYPOINT, CMD and version'
docker run --rm --entrypoint bash "$IMAGE" -ec 'test -x cloudcompute/autostart-image.sh; test -r cloudcompute/launcher.py; test -r cloudcompute/rendezvous.py; test -r cloudcompute/serve_cloud.py; test -x /usr/bin/tini; test -x /usr/bin/setpriv'
pass 'required files and executable permissions'
set +e
timeout 180 docker run --rm "$IMAGE" >"$WORK/no-gpu.log" 2>&1
code=$?
set -e
[[ $code == 3 ]] && grep -q 'CUDA недоступна' "$WORK/no-gpu.log" || { cat "$WORK/no-gpu.log"; fail 'missing GPU must fail honestly with exit 3'; }
pass 'normal CMD missing GPU: exit 3'
docker run -d --name "$PREFIX-normal" "${CPU_ENV[@]}" "$IMAGE" >/dev/null
wait_engine "$PREFIX-normal"
docker exec "$PREFIX-normal" sh -c 'ps -eo user,args | grep "^yoisaki .*launcher.py run"' >/dev/null
pass 'normal ENTRYPOINT/CMD real FastAPI on CPU, privilege drop, authenticated health (no GPU: not READY)'
docker stop -t 45 "$PREFIX-normal" >/dev/null
[[ $(docker inspect "$PREFIX-normal" --format '{{.State.ExitCode}}') == 0 ]] || fail 'unclean normal shutdown'
pass 'SIGTERM normal supervisor: graceful exit 0'
# Both command and entrypoint replaced. Presence of /.launch alone intentionally starts no engine.
docker run -d --name "$PREFIX-override" "${CPU_ENV[@]}" -e YOISAKI_AUTOSTART_RESTARTS=0 -e YOISAKI_RENDEZVOUS_HOST=invalid.invalid \
 --entrypoint /bin/sh "$IMAGE" -c 'touch /.launch; while [ ! -e /.launch ]; do sleep 1; done; exec sleep infinity' >/dev/null
docker exec "$PREFIX-override" sh -ec 'test -e /.launch; test ! -e /data/config'
engine_down "$PREFIX-override" || fail 'override started an engine'
if docker exec "$PREFIX-override" /opt/yoisaki/venv/bin/python /opt/yoisaki/cloudcompute/launcher.py healthcheck; then fail 'override incorrectly healthy'; fi
pass 'provider-style override + existing marker + missing config reproduce no engine'
node --input-type=module -e 'import {onstartScript,ENGINE_IMAGE} from "./server/cloudcompute-deploy.mjs";process.stdout.write(onstartScript({image:ENGINE_IMAGE,token:"d".repeat(64)}))' > "$WORK/onstart.sh"
docker cp "$WORK/onstart.sh" "$PREFIX-override:/onstart.sh"
docker exec "$PREFIX-override" bash /onstart.sh > "$WORK/provision.log"
grep -q 'YOISAKI_INIT_OK' "$WORK/provision.log" || { cat "$WORK/provision.log"; fail 'onstart did not complete'; }
wait_engine "$PREFIX-override"
docker exec "$PREFIX-override" sh -ec 'for d in config logs runtime models; do test -d /data/$d; done; test "$(stat -c %a /data/config/engine/engine.token)" = 600; test "$(stat -c %u /data/config/engine/engine.token)" = 1000; test "$(cat /data/runtime/state/token)" = "$(cat /data/config/engine/engine.token)"'
pid=$(docker exec "$PREFIX-override" cat /data/runtime/state/supervisor.pid)
for attempt in {1..5}; do docker exec "$PREFIX-override" bash /onstart.sh >> "$WORK/provision.log"; done
[[ $(docker exec "$PREFIX-override" cat /data/runtime/state/supervisor.pid) == "$pid" ]] || fail 'duplicate supervisor'
[[ $(docker exec "$PREFIX-override" pgrep -fc '^/opt/yoisaki/venv/bin/python /opt/yoisaki/cloudcompute/launcher.py run$') == 1 ]] || fail 'duplicate launcher'
if grep -q 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd' "$WORK/provision.log"; then fail 'credential in logs'; fi
pass 'initial + repeated provisioning, directories, 0600 token, website token in use, one detached supervisor, no credential logs'
docker exec "$PREFIX-override" kill -TERM "$pid"
for attempt in {1..30}; do
 if ! docker exec "$PREFIX-override" pgrep -f '^/opt/yoisaki/venv/bin/python /opt/yoisaki/cloudcompute/launcher.py run$' >/dev/null; then break; fi
 sleep 1
done
for _ in {1..15}; do engine_down "$PREFIX-override" && break; sleep 1; done
engine_down "$PREFIX-override" || fail 'engine server still answers after supervisor shutdown'
if docker exec "$PREFIX-override" /opt/yoisaki/venv/bin/python /opt/yoisaki/cloudcompute/launcher.py healthcheck; then fail 'health stayed ready after shutdown'; fi
pass 'detached supervisor shutdown removes server, failed health is not READY'
echo 'RESULT: Docker CPU smoke passed; CloudCompute / real GPU inference UNVERIFIED'
