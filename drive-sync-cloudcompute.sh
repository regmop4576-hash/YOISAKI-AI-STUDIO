#!/usr/bin/env bash
# Google Drive → CloudCompute model sync (run ON THE SERVER). Read-only for Google Drive; never deletes models.
#   ./drive-sync-cloudcompute.sh connect      paste the token printed by `rclone authorize` in Termux (hidden input)
#   ./drive-sync-cloudcompute.sh check        list My Drive/YOISAKI_AI_STUDIO/models and compare with the server
#   ./drive-sync-cloudcompute.sh sync         download missing / changed models (resumable, verified, atomic)
#   ./drive-sync-cloudcompute.sh status       last result, installed models, free disk space
#   ./drive-sync-cloudcompute.sh disconnect   delete the server copy of the token
# Works with the engine running (same lock as the website) or stopped: no GPU work is started.
set -euo pipefail
# shellcheck source=cloudcompute/lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/cloudcompute/lib.sh"
yoisaki_load_config
COMMAND=${1:-status}
case $COMMAND in connect|check|sync|status|disconnect) ;; *) sed -n '2,8p' "$0"; exit 2 ;; esac
[[ ${YOISAKI_DRIVE_SYNC:-1} != 0 ]] || die 'Синхронизация отключена (YOISAKI_DRIVE_SYNC=0 в config/yoisaki.env).'
yoisaki_prepare_dirs
MODE=$(yoisaki_mode)

INPUT=''
if [[ $COMMAND == connect ]]; then
  say 'Вставьте JSON-токен из Termux (строка {"access_token":…} целиком после «Paste the following into your remote machine»).'
  say 'Ввод скрыт и не попадает в историю команд и журналы.'
  IFS= read -rs token; say ''
  [[ -n $token ]] || die 'Пустой токен.'
  client_id='' client_secret=''
  if [[ ${YOISAKI_DRIVE_OWN_CLIENT:-0} == 1 ]]; then
    IFS= read -r -p 'Client ID вашего OAuth-клиента Google: ' client_id
    IFS= read -rs -p 'Client Secret (скрыт): ' client_secret; say ''
  fi
  INPUT=$(printf '%s\n%s\n%s\n' "$token" "$client_id" "$client_secret")
  unset token client_secret
fi

run() {   # stdin carries the token for `connect` only; it is never an argument
  if [[ $MODE == docker ]]; then
    docker image inspect "$YOISAKI_IMAGE" >/dev/null 2>&1 || die 'Образ не собран. Сначала выполните ./start-cloudcompute.sh'
    if [[ $(yoisaki_container_state) == running ]]; then
      docker exec -i "$YOISAKI_CONTAINER" /opt/yoisaki/venv/bin/python /opt/yoisaki/cloudcompute/drive_sync.py "$COMMAND"
    else
      if [[ $(id -u) == 0 ]]; then export YOISAKI_UID=1000 YOISAKI_GID=1000; yoisaki_grant 1000:1000; fi
      yoisaki_compose --profile tools run --rm -T --no-deps tools /opt/yoisaki/cloudcompute/drive_sync.py "$COMMAND"
    fi
    return
  fi
  if ! yoisaki_in_image; then bash "$YOISAKI_APP/cloudcompute/install-native.sh" >/dev/null; fi
  local py; py=$(yoisaki_python)
  local cmd=(env YOISAKI_ENGINE_DIR="${YOISAKI_ENGINE_DIR:-$YOISAKI_APP/engine}" "$py" "$YOISAKI_APP/cloudcompute/drive_sync.py" "$COMMAND")
  # Native root login: files must belong to the engine user, exactly like the running engine writes them.
  if [[ $(id -u) == 0 && ${YOISAKI_RUN_AS_ROOT:-0} != 1 ]] && id "$YOISAKI_RUN_USER" >/dev/null 2>&1; then
    yoisaki_grant "$YOISAKI_RUN_USER:$(id -gn "$YOISAKI_RUN_USER")"
    cmd=(runuser -u "$YOISAKI_RUN_USER" -- "${cmd[@]}")
  fi
  HOME="$YOISAKI_DATA_ROOT/runtime/home" "${cmd[@]}"
}

status=0
if [[ $COMMAND == connect ]]; then printf '%s' "$INPUT" | run || status=$?; unset INPUT
else run </dev/null || status=$?; fi
exit $status
