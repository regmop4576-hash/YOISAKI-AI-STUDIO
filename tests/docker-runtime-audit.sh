#!/usr/bin/env bash
# YOISAKI ENGINE image runtime audit (no GPU needed; Docker daemon required). Reproduces YOISAKI_DOCKER_AUDIT.md §4.
#   bash tests/docker-runtime-audit.sh ghcr.io/regmop4576-hash/yoisaki-ai-studio/engine:1.7.7
# Checks what can be checked without a GPU: configuration, files, imports, start without GPU, privilege drop,
# onstart provisioning (uid 1000 and root), a provider-style bootstrap layer on top of the image, and the
# onstart-before-CMD race. It does NOT prove GPU inference, NVIDIA Container Toolkit behaviour or CloudCompute's bootstrap.
set -u
IMAGE=${1:?usage: docker-runtime-audit.sh IMAGE}
WORK=$(mktemp -d); trap 'docker rm -f yoisaki-audit-race yoisaki-audit-priv >/dev/null 2>&1; docker volume rm -f yoisaki-audit-data >/dev/null 2>&1; rm -rf "$WORK"' EXIT
pass() { printf 'PASS  %s\n' "$*"; }
fail() { printf 'FAIL  %s\n' "$*"; FAILED=1; }
FAILED=0
cd "$(dirname "$0")/.."

docker image inspect "$IMAGE" >/dev/null 2>&1 || docker pull "$IMAGE" >/dev/null || { echo "cannot get $IMAGE"; exit 2; }
cfg=$(docker image inspect "$IMAGE" --format '{{.Os}}/{{.Architecture}}|{{json .Config.User}}|{{json .Config.Entrypoint}}|{{json .Config.Cmd}}')
echo "image: $IMAGE  ($cfg)"
[[ $cfg == linux/amd64* ]] && pass 'platform linux/amd64' || fail 'platform is not linux/amd64'
[[ $cfg == *'["/usr/bin/tini","--"]'*'["/opt/yoisaki/cloudcompute/autostart-image.sh"]'* ]] && pass 'ENTRYPOINT tini, CMD autostart-image.sh' || fail 'unexpected ENTRYPOINT/CMD'
[[ $cfg == *'|""|'* || $cfg == *'|"root"|'* || $cfg == *'|"0'* ]] && pass 'container starts as root (provider bootstrap compatible)' || fail "container starts as $(cut -d'|' -f2 <<<"$cfg") (provider bootstraps that need root fail)"

out=$(docker run --rm --entrypoint bash "$IMAGE" -c 'for f in /opt/yoisaki/cloudcompute/{autostart-image.sh,launcher.py,rendezvous.py,diagnose.py,serve_cloud.py} /opt/yoisaki/engine/worker/serve.py /usr/local/bin/cloudflared /usr/bin/tini /usr/bin/setpriv; do [ -e "$f" ] || echo "MISSING $f"; done; cd /opt/yoisaki/engine && /opt/yoisaki/venv/bin/python /opt/yoisaki/cloudcompute/import_check.py /opt/yoisaki/engine 2>/dev/null | grep -E "IMPORTS_OK|ARCH_OK|arch "; /opt/yoisaki/venv/bin/pip check' 2>&1)
grep -q MISSING <<<"$out" && fail "files: $(grep MISSING <<<"$out" | tr '\n' ' ')" || pass 'required files present'
grep -q IMPORTS_OK <<<"$out" && grep -q ARCH_OK <<<"$out" && pass "imports + $(grep -o 'arch .*' <<<"$out")" || fail 'import check'
grep -q 'No broken requirements' <<<"$out" && pass 'pip check' || fail 'pip check'

out=$(timeout 300 docker run --rm "$IMAGE" 2>&1); code=$?
[[ $code == 3 ]] && grep -q 'CUDA недоступна' <<<"$out" && pass 'default CMD without GPU: honest GPU-check refusal (exit 3), no crash' || fail "default CMD without GPU: exit $code"

docker run -d --name yoisaki-audit-priv -e YOISAKI_GPU_PREFLIGHT=0 -e YOISAKI_TUNNEL=0 "$IMAGE" >/dev/null; sleep 12
ps=$(docker exec yoisaki-audit-priv ps -eo user,args 2>/dev/null)
grep -q '^yoisaki .*launcher.py run' <<<"$ps" && pass 'engine (launcher.py) runs as uid 1000' || fail "engine user: $(docker logs yoisaki-audit-priv 2>&1 | tail -1)"
docker rm -f yoisaki-audit-priv >/dev/null

TOKEN=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
node -e "import('./server/cloudcompute-deploy.mjs').then(m=>process.stdout.write(m.onstartScript({image:process.argv[1],token:process.argv[2]})))" "$IMAGE" "$TOKEN" > "$WORK/onstart.sh"
for user in 1000:1000 0:0; do
  docker volume rm -f yoisaki-audit-data >/dev/null 2>&1
  out=$(docker run --rm --user $user -e YOISAKI_RENDEZVOUS_HOST=invalid.invalid -v yoisaki-audit-data:/data -v "$WORK/onstart.sh:/onstart.sh:ro" --entrypoint bash "$IMAGE" \
    -c 'bash /onstart.sh; sleep 3; stat -c "%a %u" /data/config/engine/engine.token; cat /var/log/yoisaki-onstart.log /tmp/yoisaki-onstart.log /data/logs/autostart.log 2>/dev/null' 2>&1)
  grep -q '^600 1000' <<<"$out" && ! grep -q "$TOKEN" <<<"$out" && pass "onstart as $user: token saved 0600 for uid 1000, never logged" || fail "onstart as $user"
done

printf 'FROM %s\nRUN apt-get update -qq && apt-get install -y -qq --no-install-recommends openssh-server >/dev/null\n' "$IMAGE" > "$WORK/Dockerfile.asis"
if docker build -q -f "$WORK/Dockerfile.asis" -t yoisaki-audit-derived "$WORK" >/dev/null 2>"$WORK/derived.err"; then pass 'provider-style bootstrap layer (apt-get as image user) builds'
else fail "provider-style bootstrap layer fails as image user: $(grep -o 'failed to solve[^"]*' "$WORK/derived.err" | head -1)"; fi
docker rmi -f yoisaki-audit-derived >/dev/null 2>&1

docker run -d --name yoisaki-audit-race --user 0 -e YOISAKI_RENDEZVOUS_HOST=invalid.invalid -v "$WORK/onstart.sh:/onstart.sh:ro" --entrypoint /usr/bin/tini "$IMAGE" -- \
  bash -c 'bash /onstart.sh; sleep 2; exec /opt/yoisaki/cloudcompute/autostart-image.sh' >/dev/null; sleep 15
[[ $(docker inspect yoisaki-audit-race --format '{{.State.Running}}') == true ]] && pass 'onstart before CMD: container keeps running' || fail 'onstart before CMD: image CMD exited and stopped the container'

echo; [[ $FAILED == 0 ]] && echo 'RESULT: all runtime checks passed (no GPU: inference not tested)' || echo 'RESULT: some runtime checks FAILED'
exit $FAILED
