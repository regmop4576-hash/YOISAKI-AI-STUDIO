#!/bin/bash
# Creates a clean fake Termux root: own HOME and PREFIX, no node/curl/unzip until "pkg install".
set -e
R=$1; rm -rf "$R"; P=$R/data/data/com.termux/files/usr; H=$R/data/data/com.termux/files/home
mkdir -p "$P/bin" "$H" "$P/tmp"
for d in /usr/bin /bin /usr/local/bin; do for f in "$d"/*; do n=$(basename "$f"); case $n in node|npm|npx|curl|unzip|corepack|yoisaki) continue;; esac; [ -e "$P/bin/$n" ] || ln -s "$f" "$P/bin/$n"; done; done
cat > "$P/bin/pkg" <<'P'
#!/bin/bash
echo "pkg $*" >> "$PKG_LOG"
P=${PREFIX}
if [ "$1" = install ]; then for a in "$@"; do case $a in
  nodejs-lts) for b in node npm npx; do ln -sf "${NODE_BIN:-/opt/node22/bin}/$b" "$P/bin/$b"; done;;
  curl) ln -sf /usr/bin/curl "$P/bin/curl";; unzip) ln -sf /usr/bin/unzip "$P/bin/unzip";; esac; done; fi
exit 0
P
chmod +x "$P/bin/pkg"
echo "PREFIX=$P HOME=$H"

