#!/usr/bin/env bash
# VALIDATION ONLY: checks of the release ZIP. Args: <new zip> <v1.7.0 zip> <scratch work dir>
NEW=$1 OLD=$2 T=$3
TOP=YOISAKI_AI_STUDIO_V1.4.0_LOCAL_EDITION
mkdir -p "$T"
echo "# Release ZIP: $(basename "$NEW")  size $(stat -c %s "$NEW") bytes  sha256 $(sha256sum "$NEW" | cut -c1-64)"
echo "\$ unzip -Z1 | wc -l; forbidden entries (__pycache__, .git, node_modules, dist, .venv, symlinks)"
unzip -Z1 "$NEW" | wc -l
unzip -Z1 "$NEW" | grep -cE '__pycache__|/\.git/|node_modules|/dist/|\.venv|\.pyc$' || true
unzip -Z -l "$NEW" | awk '$1 ~ /^l/' | wc -l
echo "\$ top-level folder (update.sh compatibility path)"; unzip -Z1 "$NEW" | cut -d/ -f1 | sort -u

echo; echo "# 1) engine/ and colab/ byte-identical to the v1.7.0 release ZIP"
mkdir -p "$T/old" "$T/new"; unzip -q -o "$OLD" -d "$T/old"; unzip -q -o "$NEW" -d "$T/new"
diff -r "$T/old/$TOP/engine" "$T/new/$TOP/engine" && echo "engine/: identical ($(find "$T/new/$TOP/engine" -type f | wc -l) files)"
diff -r "$T/old/$TOP/colab" "$T/new/$TOP/colab" && echo "colab/: identical"
for d in server src scripts public; do diff -r "$T/old/$TOP/$d" "$T/new/$TOP/$d" >/dev/null && echo "$d/: identical"; done
for f in install.sh start.sh stop.sh update.sh diagnostics.sh package.json package-lock.json tsconfig.json; do cmp -s "$T/old/$TOP/$f" "$T/new/$TOP/$f" && echo "$f: identical"; done
echo "\$ diff -rq v1.7.0 v1.7.1 (files changed or added)"; diff -rq "$T/old/$TOP" "$T/new/$TOP" | sed "s#$T/##g"

echo; echo "# 2) fresh install from the new ZIP (Linux; Termux uses the same install.sh)"
cd "$T/new/$TOP" && node scripts/verify-package.mjs && HOME=$T/home bash install.sh 2>&1 | grep -vE 'npm notice|^$' | tail -4
echo "[exit ${PIPESTATUS[0]}] dist/index.html: $(test -f dist/index.html && echo present)"

echo; echo "# 3) update.sh of an installed v1.7.0 with the new ZIP (the phone update path)"
mkdir -p "$T/upd" && unzip -q "$OLD" -d "$T/upd"
cd "$T/upd/$TOP" && HOME=$T/home bash install.sh >/dev/null 2>&1 && echo "v1.7.0 installed"
HOME=$T/home bash update.sh "$NEW" 2>&1 | grep -vE 'npm notice|^$' | tail -6
echo "[exit ${PIPESTATUS[0]}] version in updated app: $(cat "$T/upd/$TOP/cloudcompute/VERSION") · start-cloudcompute.sh executable: $(test -x "$T/upd/$TOP/start-cloudcompute.sh" && echo yes)"
