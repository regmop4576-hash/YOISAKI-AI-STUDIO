#!/usr/bin/env bash
# End-to-end test of install-termux.sh in a clean, fake Termux root (own HOME and PREFIX, no node/curl/unzip
# until the stub `pkg install` provides them) against a local mock of the GitHub Releases API.
# It is NOT a real Android device: Android permissions, real pkg/apt and the Termux app are not exercised.
#
#   bash tests/installer/run.sh /path/to/YOISAKI_AI_STUDIO_V1.9.2_PIXEL_FANTASY.zip [/opt/node22/bin]
set -uo pipefail
HERE=$(cd -- "$(dirname -- "$0")" && pwd -P)
INSTALLER=$(cd "$HERE/../.." && pwd -P)/install-termux.sh
SRC_ZIP=$(realpath "$1"); NODE_BIN=${2:-$(dirname "$(command -v node)")}
export ITEST_DIR=$(mktemp -d); W=$ITEST_DIR
mkdir -p "$W/art"; cp "$SRC_ZIP" "$W/art/YOISAKI_AI_STUDIO_V1.9.2_PIXEL_FANTASY.zip"
python3 -I "$HERE/mkvariant.py" "$W/art/YOISAKI_AI_STUDIO_V1.9.2_PIXEL_FANTASY.zip" "$W/art/YOISAKI_AI_STUDIO_V1.9.3_TEST.zip" 1.9.3 ok >/dev/null
python3 -I "$HERE/mkvariant.py" "$W/art/YOISAKI_AI_STUDIO_V1.9.2_PIXEL_FANTASY.zip" "$W/art/YOISAKI_AI_STUDIO_V1.9.4_TEST.zip" 1.9.4 broken >/dev/null
cfg() { printf '{"installer":"%s",%s}\n' "$INSTALLER" "$1" > "$W/mock-config.json"; }
cfg '"zip":"YOISAKI_AI_STUDIO_V1.9.2_PIXEL_FANTASY.zip"'; : > "$W/mock.log"
node "$HERE/mock-release.mjs" > "$W/mock.out" 2>&1 & MOCK=$!
export NODE_BIN
bash "$HERE/fake-termux.sh" "$W/T" >/dev/null
R=$W/T
export PREFIX=$R/data/data/com.termux/files/usr HOME=$R/data/data/com.termux/files/home TMPDIR=$R/data/data/com.termux/files/usr/tmp
export PATH=$PREFIX/bin PKG_LOG=$R/pkg.log PORT=3000
export YOISAKI_RELEASE_API=http://127.0.0.1:18080/repos/x/releases/latest YOISAKI_INSTALLER_URL=http://127.0.0.1:18080/install-termux.sh
D=$HOME/.local/share/yoisaki-ai-studio; APP=$HOME/YOISAKI_AI_STUDIO_V1.4.0_LOCAL_EDITION
pass=0 fail=0
check() { if eval "$2"; then echo "PASS  $1"; pass=$((pass+1)); else echo "FAIL  $1"; fail=$((fail+1)); fi; }
ver() { curl -fsS -m 3 -H 'X-Yoisaki-Local: 1' http://127.0.0.1:3000/api/session 2>/dev/null | sed -n 's/.*"version":"\([^"]*\)".*/\1/p'; }
dl() { grep -c "GET /dl/YOISAKI" "$W/mock.log"; }
run() { (cd "$HOME" && "$@") > "$W/last.log" 2>&1; RC=$?; }
sleep 1

echo "== 1. fresh install with the one-line command (no node/curl/unzip present)"
check "node, curl, unzip absent before install" '! command -v node >/dev/null && ! command -v curl >/dev/null && ! command -v unzip >/dev/null'
run bash -c 'pkg install -y curl && curl -fsSL "$YOISAKI_INSTALLER_URL" | bash'
check "one-liner exits 0" '[[ $RC == 0 ]]'
check "pkg installed nodejs-lts unzip curl" 'grep -q "install .*nodejs-lts unzip curl" "$PKG_LOG"'
check "integrity check ran: OK (553)" 'grep -q "Проверка целостности файлов: OK (553)" "$W/last.log"'
check "SHA-256 verified against SHA256SUMS.txt" 'grep -q "SHA-256 архива совпадает" "$W/last.log"'
check "site answers on 127.0.0.1:3000 with 1.9.2" '[[ $(ver) == 1.9.2 ]]'
check "installer prints http://127.0.0.1:3000" 'grep -q "Откройте в браузере телефона:  http://127.0.0.1:3000" "$W/last.log"'
check "yoisaki command works" '[[ $(yoisaki version) == 1.9.2 ]]'
check "scripts use Termux bash" 'head -1 "$APP/start.sh" | grep -q "^#!$PREFIX/bin/bash"'
echo "user-data-$RANDOM" > "$D/USER_MARKER.txt"; (cd "$D" && sha256sum USER_MARKER.txt state.json > "$W/data.sha")

echo "== 2. re-run is safe and downloads nothing"
: > "$W/mock.log"; run bash -c 'curl -fsSL "$YOISAKI_INSTALLER_URL" | bash'
check "re-run exits 0" '[[ $RC == 0 ]]'
check "no archive downloaded" '[[ $(dl) == 0 ]]'
check "reports latest already installed" 'grep -q "Уже установлена последняя версия 1.9.2" "$W/last.log"'

echo "== 3. second concurrent run is refused"
mkdir -p "$HOME/.local/share/yoisaki-installer/lock"; sleep 60 & SP=$!; echo $SP > "$HOME/.local/share/yoisaki-installer/lock/pid"
run bash "$INSTALLER"; rc=$RC; kill $SP 2>/dev/null; wait $SP 2>/dev/null
check "concurrent run refused" '[[ $rc != 0 ]] && grep -q "Установщик уже запущен" "$W/last.log"'
run bash "$INSTALLER" --no-start
check "stale lock is recovered" '[[ $RC == 0 ]]'

echo "== 4. yoisaki update to 1.9.3, interrupted download resumes, data kept"
cfg '"zip":"YOISAKI_AI_STUDIO_V1.9.3_TEST.zip","truncate_once":true'; : > "$W/mock.log"
run yoisaki update
check "update exits 0" '[[ $RC == 0 ]]'
check "download resumed with HTTP Range" 'grep -q "range=bytes=" "$W/mock.log"'
check "site now 1.9.3" '[[ $(ver) == 1.9.3 ]]'
check "code and data backups created" 'ls -d "$APP".backup-* "$D".backup-* >/dev/null 2>&1'
check "user data unchanged" '(cd "$D" && sha256sum -c --quiet "$W/data.sha")'

echo "== 5. failed update (1.9.4 does not start) rolls back"
cfg '"zip":"YOISAKI_AI_STUDIO_V1.9.4_TEST.zip"'
run yoisaki update; rc=$RC
check "failed update exits non-zero" '[[ $rc != 0 ]]'
check "previous version 1.9.3 restored and running" '[[ $(ver) == 1.9.3 ]]'
check "restored install passes integrity check" '(cd "$APP" && node scripts/verify-package.mjs >/dev/null)'
check "user data unchanged" '(cd "$D" && sha256sum -c --quiet "$W/data.sha")'

echo "== 6. older release is not installed over a newer one"
cfg '"zip":"YOISAKI_AI_STUDIO_V1.9.2_PIXEL_FANTASY.zip"'; run bash "$INSTALLER"; rc=$RC
check "downgrade refused" '[[ $rc != 0 ]] && [[ $(yoisaki version) == 1.9.3 ]]'

echo "== 7. checksum mismatch stops everything"
cfg '"zip":"YOISAKI_AI_STUDIO_V1.9.4_TEST.zip","badsum":true'; run bash "$INSTALLER"; rc=$RC
check "SHA256SUMS vs GitHub digest mismatch refused" '[[ $rc != 0 ]] && grep -q "не совпадает с контрольной суммой GitHub" "$W/last.log"'
rm -f "$HOME/.cache/yoisaki-ai-studio/"*; cfg '"zip":"YOISAKI_AI_STUDIO_V1.9.4_TEST.zip","badsum":true,"digest":false'; run bash "$INSTALLER"; rc=$RC
check "downloaded file with wrong SHA-256 refused and deleted" '[[ $rc != 0 ]] && grep -q "SHA-256 архива не совпадает" "$W/last.log" && ! ls "$HOME/.cache/yoisaki-ai-studio/"*.zip* >/dev/null 2>&1'
check "installed version untouched" '[[ $(yoisaki version) == 1.9.3 && $(ver) == 1.9.3 ]]'

echo "== 8. release without assets gives a clear message"
cfg '"zip":"YOISAKI_AI_STUDIO_V1.9.4_TEST.zip","noassets":true'; run bash "$INSTALLER"; rc=$RC
check "missing assets reported" '[[ $rc != 0 ]] && grep -q "нет нужных файлов" "$W/last.log"'

echo "== 9. damaged installation is repaired, data kept"
rm -f "$APP/server/history.mjs"
cfg '"zip":"YOISAKI_AI_STUDIO_V1.9.3_TEST.zip"'; run bash "$INSTALLER"
check "repair exits 0" '[[ $RC == 0 ]]'
check "broken copy moved aside" 'ls -d "$APP".broken-* >/dev/null 2>&1'
check "repaired install passes integrity check and runs" '(cd "$APP" && node scripts/verify-package.mjs >/dev/null) && [[ $(ver) == 1.9.3 ]]'
check "user data unchanged" '(cd "$D" && sha256sum -c --quiet "$W/data.sha")'

echo "== 10. stop / start commands"
run yoisaki stop; check "yoisaki stop" '[[ -z $(ver) ]]'
run yoisaki start; check "yoisaki start" '[[ $(ver) == 1.9.3 ]]'
run yoisaki start; check "yoisaki start when already running is OK" '[[ $RC == 0 ]]'
yoisaki stop >/dev/null 2>&1
kill $MOCK 2>/dev/null
echo; echo "RESULT: $pass passed, $fail failed  (logs: $W)"
[[ $fail == 0 ]]
