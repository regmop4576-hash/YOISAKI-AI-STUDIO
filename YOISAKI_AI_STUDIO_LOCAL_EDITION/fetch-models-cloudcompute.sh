#!/usr/bin/env bash
# Download models onto the persistent data disk (run ON THE SERVER). Existing files are never replaced.
#   ./fetch-models-cloudcompute.sh list
#   ./fetch-models-cloudcompute.sh url 'https://…/model.safetensors' --kind checkpoint [--name file.safetensors]
#   ./fetch-models-cloudcompute.sh gdrive 'https://drive.google.com/file/d/<ID>/view' --kind lora --name file.safetensors
#   ./fetch-models-cloudcompute.sh prefetch [--only sdxl-config,controlnet,annotators,depth,sdpose]
# Private downloads: put HF_TOKEN / CIVITAI_TOKEN into $YOISAKI_DATA_ROOT/config/yoisaki.env (chmod 600).
set -euo pipefail
# shellcheck source=cloudcompute/lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/cloudcompute/lib.sh"
yoisaki_load_config
(($#)) || { sed -n '2,7p' "$0"; exit 2; }
yoisaki_prepare_dirs
MODE=$(yoisaki_mode)

if [[ $MODE == docker ]]; then
  docker image inspect "$YOISAKI_IMAGE" >/dev/null 2>&1 || die 'Образ не собран. Сначала выполните ./start-cloudcompute.sh'
  if [[ $(id -u) == 0 ]]; then export YOISAKI_UID=1000 YOISAKI_GID=1000; yoisaki_grant 1000:1000; fi
  yoisaki_compose --profile tools run --rm --no-deps tools /opt/yoisaki/cloudcompute/fetch_models.py "$@"
  exit
fi

if ! yoisaki_in_image; then bash "$YOISAKI_APP/cloudcompute/install-native.sh" >/dev/null; fi
PY=$(yoisaki_python)
export YOISAKI_ENGINE_DIR=${YOISAKI_ENGINE_DIR:-$YOISAKI_APP/engine} HF_HOME=${HF_HOME:-$YOISAKI_DATA_ROOT/huggingface-cache}
status=0
"$PY" "$YOISAKI_APP/cloudcompute/fetch_models.py" "$@" || status=$?
# Native root runs: hand the shared cache back to the engine user.
if [[ $(id -u) == 0 ]] && id "$YOISAKI_RUN_USER" >/dev/null 2>&1; then
  yoisaki_grant "$YOISAKI_RUN_USER:$(id -gn "$YOISAKI_RUN_USER")"
fi
exit $status
