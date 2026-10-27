#!/usr/bin/env bash
# Native-mode permissions: root prepares the data root (lib.sh), the unprivileged engine user (uid 1000)
# stores a token like the website connect does, syncs with the real rclone, and must NOT read config/yoisaki.env.
set -euo pipefail
S=$1; W=$2; T=/tmp/yoisaki-permtest; trap 'rm -rf "$T"' EXIT
rm -rf "$T"; mkdir -p "$T/app"; cp -a "$W/cloudcompute" "$W/engine" "$T/app/"; cp -a "$S/smoke/drive" "$T/drive"; chmod -R a+rX "$T"
export YOISAKI_DATA_ROOT=$T/data
bash -c "source $T/app/cloudcompute/lib.sh; yoisaki_prepare_dirs; yoisaki_grant 1000:1000"
printf 'HF_TOKEN=secret\n' > "$T/data/config/yoisaki.env"; chmod 600 "$T/data/config/yoisaki.env"
stat -c '%a %U %n' "$T/data/config" "$T/data/config/rclone" "$T/data/runtime/sync" "$T/data/models/.yoisaki-sync" "$T/data/models/checkpoints" | sed "s#$T#<T>#"
runuser -u "$(getent passwd 1000 | cut -d: -f1)" -- env YOISAKI_DATA_ROOT="$T/data" YOISAKI_ENGINE_DIR="$T/app/engine" HOME="$T/data/runtime/home" python3 - "$T" <<'PY'
import os, sys
T = sys.argv[1]; sys.path.insert(0, T + '/app/cloudcompute')
from drive_sync import SyncConfig, SyncService
print('uid', os.getuid())
s = SyncService(SyncConfig())
s.connect('{"access_token":"ya29.x","refresh_token":"1//yyyyyyyyyyyyyyyyyyyyyyyy","token_type":"Bearer","expiry":"x"}')
print('rclone.conf mode', oct(os.stat(s.cfg.rclone_conf).st_mode & 0o777))
open(s.cfg.rclone_conf, 'w').write(f'[yoisaki-gdrive]\ntype = alias\nremote = {T}/drive\n')  # fixture remote instead of Google
s.start('sync'); s.wait(300); j = s.status()['job']
print('sync', j['state'], j['overall'])
for path in (T + '/data/config/yoisaki.env',):
    try: open(path).read(); print('FAIL: engine user can read yoisaki.env')
    except PermissionError: print('OK: engine user cannot read config/yoisaki.env')
try: os.listdir(T + '/data/config'); print('FAIL: config listable')
except PermissionError: print('OK: config/ is traverse-only')
PY
ls -l "$T/data/models/checkpoints" | sed "s#$T#<T>#"
