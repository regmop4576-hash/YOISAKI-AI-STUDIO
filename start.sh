#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
if ! command -v node >/dev/null 2>&1 || ! node scripts/build-identity.mjs >/dev/null 2>&1; then bash ./install.sh; fi
node scripts/service.mjs start
