#!/usr/bin/env bash
# Real image / real FastAPI on CPU. No GPU inference claim. Run on a Docker-capable host.
set -euo pipefail
IMAGE=${1:?image required}
PREFIX=yoisaki-startup-$$
WORK=$(mktemp -d)
cleanup() { docker rm -f "$PREFIX-normal" "$PREFIX-override" >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }
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
wait_health() {
 local name=$1
 for attempt in {1..90}; do
  if docker exec "$name" /opt/yoisaki/venv/bin/python /opt/yoisaki/cloudcompute/launcher.py healthcheck >/dev/null 2>&1; then return; fi
  sleep 2
 done
 docker logs "$name"; fail "health timeout: $name"
}
docker run -d --name "$PREFIX-normal" -e YOISAKI_GPU_PREFLIGHT=0 -e YOISAKI_TUNNEL=0 "$IMAGE" >/dev/null
wait_health "$PREFIX-normal"
docker exec "$PREFIX-normal" sh -c 'ps -eo user,args | grep "^yoisaki .*launcher.py run"' >/dev/null
pass 'normal ENTRYPOINT/CMD real FastAPI on CPU, privilege drop and authenticated health'
docker stop -t 45 "$PREFIX-normal" >/dev/null
[[ $(docker inspect "$PREFIX-normal" --format '{{.State.ExitCode}}') == 0 ]] || fail 'unclean normal shutdown'
pass 'SIGTERM normal supervisor: graceful exit 0'
# Both command and entrypoint replaced. Presence of /.launch alone intentionally starts no engine.
docker run -d --name "$PREFIX-override" -e YOISAKI_GPU_PREFLIGHT=0 -e YOISAKI_TUNNEL=0 -e YOISAKI_AUTOSTART_RESTARTS=0 -e YOISAKI_RENDEZVOUS_HOST=invalid.invalid \
 --entrypoint /bin/sh "$IMAGE" -c 'touch /.launch; while [ ! -e /.launch ]; do sleep 1; done; exec sleep infinity' >/dev/null
docker exec "$PREFIX-override" sh -ec 'test -e /.launch; test ! -e /data/config'
if docker exec "$PREFIX-override" /opt/yoisaki/venv/bin/python /opt/yoisaki/cloudcompute/launcher.py healthcheck; then fail 'override incorrectly healthy'; fi
pass 'provider-style override + existing marker + missing config reproduce no engine'
node --input-type=module -e 'import {onstartScript,ENGINE_IMAGE} from "./server/cloudcompute-deploy.mjs";process.stdout.write(onstartScript({image:ENGINE_IMAGE,token:"d".repeat(64)}))' > "$WORK/onstart.sh"
docker cp "$WORK/onstart.sh" "$PREFIX-override:/onstart.sh"
docker exec "$PREFIX-override" bash /onstart.sh > "$WORK/provision.log"
wait_health "$PREFIX-override"
docker exec "$PREFIX-override" sh -ec 'for d in config logs runtime models; do test -d /data/$d; done; test "$(stat -c %a /data/config/engine/engine.token)" = 600; test "$(stat -c %u /data/config/engine/engine.token)" = 1000'
pid=$(docker exec "$PREFIX-override" cat /data/runtime/state/supervisor.pid)
for attempt in {1..5}; do docker exec "$PREFIX-override" bash /onstart.sh >> "$WORK/provision.log"; done
[[ $(docker exec "$PREFIX-override" cat /data/runtime/state/supervisor.pid) == "$pid" ]] || fail 'duplicate supervisor'
[[ $(docker exec "$PREFIX-override" pgrep -fc '^/opt/yoisaki/venv/bin/python /opt/yoisaki/cloudcompute/launcher.py run$') == 1 ]] || fail 'duplicate launcher'
if grep -q 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd' "$WORK/provision.log"; then fail 'credential in logs'; fi
pass 'initial + repeated provisioning, directories, 0600 token, one detached supervisor, no credential logs'
docker exec "$PREFIX-override" kill -TERM "$pid"
for attempt in {1..30}; do
 if ! docker exec "$PREFIX-override" pgrep -f '^/opt/yoisaki/venv/bin/python /opt/yoisaki/cloudcompute/launcher.py run$' >/dev/null; then break; fi
 sleep 1
done
if docker exec "$PREFIX-override" /opt/yoisaki/venv/bin/python /opt/yoisaki/cloudcompute/launcher.py healthcheck; then fail 'health stayed ready after shutdown'; fi
pass 'detached supervisor shutdown removes server, failed health is not READY'
echo 'RESULT: Docker CPU smoke passed; CloudCompute / real GPU inference UNVERIFIED'
