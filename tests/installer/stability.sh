#!/usr/bin/env bash
# Same-version 1.9.2 release update, Linux fake Termux + local GitHub API. NOT an Android device.
# Usage: bash tests/installer/stability.sh ORIGINAL.zip STABILITY.zip
set -euo pipefail
HERE=$(cd -- "$(dirname -- "$0")" && pwd -P)
INSTALLER=$(cd "$HERE/../.." && pwd -P)/install-termux.sh
ORIGINAL=$(realpath "$1"); FIXED=$(realpath "$2")
NODE_BIN=$(dirname "$(command -v node)"); export NODE_BIN
ITEST_DIR=$(mktemp -d); export ITEST_DIR; W=$ITEST_DIR
mkdir -p "$W/art"
OLD=YOISAKI_AI_STUDIO_V1.9.2_PIXEL_FANTASY.zip
NEW=YOISAKI_AI_STUDIO_V1.9.2_STABILITY_PIXEL_FANTASY.zip
BAD=YOISAKI_AI_STUDIO_V1.9.2_ZBROKEN_TEST.zip
cp "$ORIGINAL" "$W/art/$OLD"; cp "$FIXED" "$W/art/$NEW"
python3 -I "$HERE/mkvariant.py" "$FIXED" "$W/art/$BAD" 1.9.2 broken >/dev/null
cfg(){ printf '{"installer":"%s",%s}\n' "$INSTALLER" "$1" > "$W/mock-config.json"; }
cfg "\"zip\":\"$OLD\""; : > "$W/mock.log"
node "$HERE/mock-release.mjs" > "$W/mock.out" 2>&1 & MOCK=$!
bash "$HERE/fake-termux.sh" "$W/T" >/dev/null
export PREFIX=$W/T/data/data/com.termux/files/usr HOME=$W/T/data/data/com.termux/files/home
export TMPDIR=$PREFIX/tmp PATH=$PREFIX/bin PKG_LOG=$W/pkg.log PORT=3000
export YOISAKI_RELEASE_API=http://127.0.0.1:18080/repos/x/releases/latest YOISAKI_INSTALLER_URL=http://127.0.0.1:18080/install-termux.sh
D=$HOME/.local/share/yoisaki-ai-studio; APP=$HOME/YOISAKI_AI_STUDIO_V1.4.0_LOCAL_EDITION
trap '[[ -x "$PREFIX/bin/yoisaki" ]] && yoisaki stop >/dev/null 2>&1 || true; kill "$MOCK" 2>/dev/null || true' EXIT
pass=0; fail=0
check(){ if eval "$2"; then echo "PASS $1"; pass=$((pass+1)); else echo "FAIL $1"; fail=$((fail+1)); fi; }
run(){ set +e; (cd "$HOME" && "$@") > "$W/last.log" 2>&1; RC=$?; set -e; }
ver(){ curl -fsS -m 3 -H 'X-Yoisaki-Local: 1' http://127.0.0.1:3000/api/session 2>/dev/null | sed -n 's/.*"version":"\([^"]*\)".*/\1/p'; }
sleep 1
check 'initially no node/curl/unzip' '! command -v node && ! command -v curl && ! command -v unzip'
run bash -c 'pkg install -y curl && curl -fsSL "$YOISAKI_INSTALLER_URL" | bash'
check 'fresh one-command install exits 0' '[[ $RC == 0 ]]'
check 'SHA verified; integrity check executed' 'grep -q "SHA-256 архива совпадает" "$W/last.log" && grep -q "Проверка целостности файлов: OK" "$W/last.log"'
check 'site and yoisaki version are 1.9.2' '[[ $(ver) == 1.9.2 && $(yoisaki version) == 1.9.2 ]]'
check 'Termux interpreter installed' 'head -1 "$APP/start.sh" | grep -q "^#!$PREFIX/bin/bash"'
echo user-data > "$D/USER_MARKER.txt"; (cd "$D" && sha256sum USER_MARKER.txt state.json > "$W/data.sha")
: > "$W/mock.log"; run bash "$INSTALLER"
check 'repeat install downloads no ZIP' '[[ $RC == 0 ]] && ! grep -q "GET /dl/YOISAKI" "$W/mock.log"'
cfg "\"zip\":\"$NEW\",\"also_zip\":\"$OLD\",\"truncate_once\":true"; : > "$W/mock.log"
run yoisaki update
check 'update selects repaired asset alongside original' '[[ $RC == 0 ]] && grep -q "ZIP_NAME=$NEW" "$HOME/.local/share/yoisaki-installer/installed.env"'
check 'partial download resumes with Range' 'grep -q "range=bytes=" "$W/mock.log"'
check 'same version 1.9.2 kept after update' '[[ $(ver) == 1.9.2 && $(yoisaki version) == 1.9.2 ]]'
check 'new source installed' 'grep -q "normalizeRegionalMode" "$APP/src/lib/regional.ts"'
check 'code and data backups exist' 'ls -d "$APP".backup-* "$D".backup-* >/dev/null'
check 'settings and user marker preserved' '(cd "$D" && sha256sum -c --quiet "$W/data.sha")'
run yoisaki update
check 'repeat fixed update is idempotent' '[[ $RC == 0 ]] && grep -q "скачивание не требуется" "$W/last.log"'
rm "$HOME/.local/share/yoisaki-installer/installed.env"
run yoisaki update
check 'manual same-version install without archive digest is verified and updated' '[[ $RC == 0 ]] && test -f "$HOME/.local/share/yoisaki-installer/installed.env"'
cfg "\"zip\":\"$BAD\""; run yoisaki update
check 'broken same-version update rejected and previous build restarted' '[[ $RC != 0 && $(ver) == 1.9.2 ]] && ! grep -q "TEST: broken release" "$APP/server/index.mjs"'
check 'rollback keeps data' '(cd "$D" && sha256sum -c --quiet "$W/data.sha")'
cfg "\"zip\":\"$BAD\",\"badsum\":true"; run yoisaki update
check 'checksum metadata mismatch refused before installation' '[[ $RC != 0 ]] && grep -q "не совпадает с контрольной суммой GitHub" "$W/last.log"'
cfg "\"zip\":\"$NEW\",\"noassets\":true"; run yoisaki update
check 'missing release assets refused' '[[ $RC != 0 ]] && grep -q "нет нужных файлов" "$W/last.log"'
cfg "\"zip\":\"$NEW\""; rm "$APP/server/history.mjs"; run yoisaki update
check 'damaged install repaired without data loss' '[[ $RC == 0 ]] && test -f "$APP/server/history.mjs" && (cd "$D" && sha256sum -c --quiet "$W/data.sha")'
run yoisaki stop; check 'yoisaki stop' '[[ -z $(ver) ]]'
run yoisaki start; check 'yoisaki start after stop' '[[ $RC == 0 && $(ver) == 1.9.2 ]]'
run yoisaki start; check 'repeated start is safe' '[[ $RC == 0 ]]'
run yoisaki status; check 'yoisaki status' '[[ $RC == 0 ]]'
echo "RESULT: $pass passed, $fail failed; logs: $W; simulated Termux only"
[[ $fail == 0 ]]
