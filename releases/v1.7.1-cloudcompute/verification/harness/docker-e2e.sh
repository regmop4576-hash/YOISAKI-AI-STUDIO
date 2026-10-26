#!/usr/bin/env bash
# VALIDATION ONLY: Docker mode through the shipped scripts. Args: <scratch dir> <package dir> <data dir> <source hash>
S=$1 W=$2 D=$3 H=$4
export YOISAKI_DATA_ROOT=$D YOISAKI_TUNNEL=0 YOISAKI_COMPOSE_OVERRIDE=$S/validate/compose.validate.yml
cd "$W" || exit 1
run() { echo; echo "\$ $*"; "$@" 2>&1; echo "[exit ${PIPESTATUS[0]}]"; }
secs() { python3 -c "import time;print(round(time.time()-$1,1))"; }
echo "# v1.7.1 Docker-mode end-to-end via the shipped scripts (sandbox without NVIDIA GPU)"
echo "# Image: shipped Dockerfile dependency layers (full build #2) + final sources (validate/Dockerfile.patch), label org.yoisaki.source=$H"
echo "# Override (validation only): no GPU reservation, CUDA test double, YOISAKI_GPU_PREFLIGHT=0; YOISAKI_TUNNEL=0 because api.trycloudflare.com does not resolve here"
cat "$S/validate/compose.validate.yml"
echo
echo "# before: model sha=$(sha256sum "$D/models/checkpoints/test_sdxl.safetensors" | cut -c1-16) outputs/user-file.png=$(cat "$D/outputs/user-file.png")"
T0=$(date +%s.%N); run ./start-cloudcompute.sh; echo "wall time of ./start-cloudcompute.sh: $(secs "$T0") s (no GPU check, no model load, no tunnel)"
echo; echo '$ docker inspect yoisaki-engine'
docker inspect yoisaki-engine -f 'user={{.Config.User}} readonly_rootfs={{.HostConfig.ReadonlyRootfs}} restart={{.HostConfig.RestartPolicy.Name}} cap_drop={{.HostConfig.CapDrop}} security_opt={{.HostConfig.SecurityOpt}} published_ports={{json .NetworkSettings.Ports}}'
docker inspect yoisaki-engine -f '{{range .Mounts}}mount {{.Destination}} rw={{.RW}}{{"\n"}}{{end}}'
echo '$ docker exec yoisaki-engine: id; write to image rootfs; write to models; state folder'
docker exec yoisaki-engine sh -c 'id; touch /opt/yoisaki/x 2>&1; touch /data/models/checkpoints/x 2>&1; ls -la /data/runtime/state | tail -n +2'
echo '$ wait for Docker HEALTHCHECK'
for _ in $(seq 60); do s=$(docker inspect -f '{{.State.Health.Status}}' yoisaki-engine); [ "$s" = healthy ] && break; sleep 5; done; echo "health=$s"
echo "\$ docker logs yoisaki-engine   (64-hex strings in log: $(docker logs yoisaki-engine 2>&1 | grep -cE '[a-f0-9]{64}'))"
docker logs yoisaki-engine 2>&1
run ./start-cloudcompute.sh
run ./check-cloudcompute.sh
run ./fetch-models-cloudcompute.sh list
run ./check-cloudcompute.sh logs
run ./stop-cloudcompute.sh
echo; echo "# after stop: containers=$(docker ps -a --filter name=yoisaki-engine -q | wc -l) image=$(docker image ls -q yoisaki-engine:1.7.1-cloudcompute | wc -l) token_file=$(ls "$D/runtime/state/token" 2>/dev/null | wc -l) phase=$(python3 -c "import json;print(json.load(open('$D/runtime/state/launcher.json'))['phase'])")"
echo "# after: model sha=$(sha256sum "$D/models/checkpoints/test_sdxl.safetensors" | cut -c1-16) outputs/user-file.png=$(cat "$D/outputs/user-file.png") data-id=$(cat "$D/.yoisaki-data-id")"
T0=$(date +%s.%N); run ./start-cloudcompute.sh; echo "wall time of repeated start: $(secs "$T0") s"
echo; echo '$ cat diagnostics/startup-timings.jsonl'; cat "$D/diagnostics/startup-timings.jsonl"
run ./stop-cloudcompute.sh
