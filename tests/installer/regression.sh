#!/usr/bin/env bash
# v1.9.2 delivery regression: why the Android phone kept the old build, and that the repaired ZIP
# (same version 1.9.2) really replaces it. Linux fake Termux + local mock of the GitHub API. NOT an Android device.
# Usage: bash tests/installer/regression.sh ORIGINAL.zip STABILITY.zip REPAIRED.zip MAIN_INSTALLER.sh
#   MAIN_INSTALLER.sh = install-termux.sh as currently on the main branch (what `yoisaki update` downloads).
set -euo pipefail
HERE=$(cd -- "$(dirname -- "$0")" && pwd -P)
NEW_INSTALLER=$(cd "$HERE/../.." && pwd -P)/install-termux.sh
ORIGINAL=$(realpath "$1"); STAB=$(realpath "$2"); FIXED=$(realpath "$3"); MAIN_INSTALLER=$(realpath "$4")
NODE_BIN=$(dirname "$(command -v node)"); export NODE_BIN
ITEST_DIR=$(mktemp -d); export ITEST_DIR; W=$ITEST_DIR
mkdir -p "$W/art"
OLD=YOISAKI_AI_STUDIO_V1.9.2_PIXEL_FANTASY.zip
S1=YOISAKI_AI_STUDIO_V1.9.2_STABILITY_PIXEL_FANTASY.zip
NEW=YOISAKI_AI_STUDIO_V1.9.2_STABILITY_R2_PIXEL_FANTASY.zip
cp "$ORIGINAL" "$W/art/$OLD"; cp "$STAB" "$W/art/$S1"; cp "$FIXED" "$W/art/$NEW"
build_of(){ unzip -p "$1" YOISAKI_AI_STUDIO_V1.4.0_LOCAL_EDITION/dist/release.json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).source_sha256.slice(0,12)))'; }
OLD_BUILD=$(build_of "$ORIGINAL"); NEW_BUILD=$(build_of "$FIXED")
cfg(){ printf '{"installer":"%s",%s}\n' "$1" "$2" > "$W/mock-config.json"; }
cfg "$MAIN_INSTALLER" "\"zip\":\"$OLD\""; : > "$W/mock.log"
node "$HERE/mock-release.mjs" > "$W/mock.out" 2>&1 & MOCK=$!
bash "$HERE/fake-termux.sh" "$W/T" >/dev/null
export PREFIX=$W/T/data/data/com.termux/files/usr HOME=$W/T/data/data/com.termux/files/home
export TMPDIR=$PREFIX/tmp PATH=$PREFIX/bin PKG_LOG=$W/pkg.log PORT=3000
export YOISAKI_RELEASE_API=http://127.0.0.1:18080/repos/x/releases/latest YOISAKI_INSTALLER_URL=http://127.0.0.1:18080/install-termux.sh
D=$HOME/.local/share/yoisaki-ai-studio; APP=$HOME/YOISAKI_AI_STUDIO_V1.4.0_LOCAL_EDITION; ENVF=$HOME/.local/share/yoisaki-installer/installed.env
trap '[[ -x "$PREFIX/bin/yoisaki" ]] && yoisaki stop >/dev/null 2>&1 || true; kill "$MOCK" 2>/dev/null || true' EXIT
pass=0; fail=0
check(){ if eval "$2"; then echo "PASS $1"; pass=$((pass+1)); else echo "FAIL $1"; fail=$((fail+1)); fi; }
run(){ set +e; (cd "$HOME" && "$@") > "$W/last.log" 2>&1; RC=$?; set -e; }
session(){ curl -fsS -m 3 -c "$W/jar" -H 'X-Yoisaki-Local: 1' http://127.0.0.1:3000/api/session 2>/dev/null; }
build(){ session | sed -n 's/.*"build":"\([^"]*\)".*/\1/p'; }
ver(){ session | sed -n 's/.*"version":"\([^"]*\)".*/\1/p'; }
api(){ session >/dev/null; curl -fsS -m 5 -b "$W/jar" -H 'X-Yoisaki-Local: 1' -H 'Content-Type: application/json' "$@"; }
sleep 1
run bash -c 'pkg install -y curl && curl -fsSL "$YOISAKI_INSTALLER_URL" | bash'
check 'original public 1.9.2 installed (old build, no build id in /api/session)' '[[ $RC == 0 && $(ver) == 1.9.2 && -z $(build) ]]'
# The user's data from the screenshots: 4 lost jobs of an earlier Colab session + legacy regional settings.
yoisaki stop >/dev/null
node -e '
const fs=require("fs"),f=process.argv[1],d=JSON.parse(fs.readFileSync(f,"utf8"));
d.history=["add55d35","ee0ac494","e82d53d3","61c9fe82"].map((p,i)=>({id:p+"-0000-4000-8000-00000000000"+i,status:"CONNECTION_LOST",created:1,updated:1,origin:"https://old.trycloudflare.com",provider:"colab",progress:{step:15,total_steps:35,percent:43},request:{prompt:"old"}}));
const r=i=>({id:"r"+i,name:"Region "+"ABC"[i],enabled:true,visible:true,lora_id:"",trigger:"",prompt:"p"+i,negative_prompt:"",weight:.8,rect:[i/3,0,1/3,1],strokes:[]});
d.settings={version:2,state:{settings:{prompt:"user prompt",regional:{mode:"2 ПЕРСОНАЖА",regions:[r(0),r(1),r(2)]}},presets:[{id:"p1",name:"my preset",version:1,settings:{prompt:"x"}}]}};
fs.writeFileSync(f,JSON.stringify(d));' "$D/state.json"
echo user-data > "$D/USER_MARKER.txt"
yoisaki start >/dev/null
# Manual installation (no installed.env), as for users who unpacked the ZIP themselves.
rm -f "$ENVF"

# --- 1. Reproduction: the main-branch installer refuses the same-version update.
cfg "$MAIN_INSTALLER" "\"zip\":\"$S1\""; : > "$W/mock.log"; run yoisaki update
check 'REPRODUCED: main-branch installer skips same-version 1.9.2 update ("скачивание не требуется")' '[[ $RC == 0 ]] && grep -q "скачивание не требуется" "$W/last.log" && ! grep -q "GET /dl/YOISAKI" "$W/mock.log" && [[ -z $(build) ]]'

# --- 2. Repaired installer + release holding all three ZIPs: the repaired one is selected and installed.
cfg "$NEW_INSTALLER" "\"zip\":\"$NEW\",\"also_zips\":[\"$OLD\",\"$S1\"]"; : > "$W/mock.log"; run yoisaki update
check 'repaired installer updates the manual install of the same version' '[[ $RC == 0 ]] && grep -q "ZIP_NAME=$NEW" "$ENVF"'
check 'repaired ZIP chosen among original / stability / repaired assets' 'grep -q "GET /dl/$NEW" "$W/mock.log" && ! grep -q "GET /dl/$OLD" "$W/mock.log" && ! grep -q "GET /dl/$S1" "$W/mock.log"'
check "running server reports the repaired build $NEW_BUILD (version stays 1.9.2)" '[[ $(ver) == 1.9.2 && $(build) == "$NEW_BUILD" ]]'
check 'installer output names the build' 'grep -q "сборка $NEW_BUILD" "$W/last.log"'
check 'yoisaki version --build shows the build' '[[ $(yoisaki version) == 1.9.2 && $(yoisaki version --build) == "1.9.2 $NEW_BUILD" ]]'
check 'served page and script carry the same build (no stale bundle on disk)' 'curl -fsS http://127.0.0.1:3000/generate | grep -q "application-build\" content=\"$NEW_BUILD" && grep -q "$NEW_BUILD" "$APP/dist/assets/main.js"'
check 'static files are revalidated by the browser (Cache-Control: no-cache)' 'curl -fsSI -H "X-Yoisaki-Local: 1" http://127.0.0.1:3000/assets/main.js | grep -qi "cache-control: no-cache"'
check 'user data kept: marker, presets, prompt, legacy regional draft' '[[ $(cat "$D/USER_MARKER.txt") == user-data ]] && api http://127.0.0.1:3000/api/settings | grep -q "my preset" && api http://127.0.0.1:3000/api/settings | grep -q "user prompt"'
H=$(api http://127.0.0.1:3000/api/history)
check 'the four lost records survive the update, unconfirmed, without GPU' '[[ $(grep -o "\"status\":\"CONNECTION_LOST\"" <<<"$H" | wc -l) == 4 ]] && grep -q "\"current_session\":null" <<<"$H"'
R=$(api -X POST -d '{"ids":["add55d35-0000-4000-8000-000000000000","ee0ac494-0000-4000-8000-000000000001","e82d53d3-0000-4000-8000-000000000002","61c9fe82-0000-4000-8000-000000000003"]}' http://127.0.0.1:3000/api/history/forget)
check 'stale records removed locally on the installed build' 'grep -q "\"removed\":4" <<<"$R"'
run yoisaki restart
check 'removal persists across restart of the app' '[[ $(api http://127.0.0.1:3000/api/history | grep -o "CONNECTION_LOST" | wc -l) == 0 ]]'

# --- 3. Idempotence and the old installer still on main.
: > "$W/mock.log"; run yoisaki update
check 'repeat update: nothing downloaded' '[[ $RC == 0 ]] && grep -q "скачивание не требуется" "$W/last.log" && ! grep -q "GET /dl/YOISAKI" "$W/mock.log"'
sed -i "s/^ZIP_SHA256=.*/ZIP_SHA256=$(sha256sum "$W/art/$OLD" | cut -d' ' -f1)/" "$ENVF"
cfg "$MAIN_INSTALLER" "\"zip\":\"$NEW\",\"also_zips\":[\"$OLD\",\"$S1\"]"; : > "$W/mock.log"; run yoisaki update
check 'main-branch installer (installed via installer) also selects the repaired ZIP by name' '[[ $RC == 0 ]] && grep -q "архив $NEW" "$W/last.log" && grep -q "ZIP_NAME=$NEW" "$ENVF" && [[ $(build) == "$NEW_BUILD" ]]'
echo "RESULT: $pass passed, $fail failed; old build=$OLD_BUILD/none, repaired build=$NEW_BUILD; logs: $W; simulated Termux only"
[[ $fail == 0 ]]
