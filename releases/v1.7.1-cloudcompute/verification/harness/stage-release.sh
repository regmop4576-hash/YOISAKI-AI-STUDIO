#!/usr/bin/env bash
# Copy the release into the git repository: releases/v1.7.1-cloudcompute/. Args: <scratch dir> <repo dir>
set -euo pipefail
S=$1 REPO=$2
P=$S/work/YOISAKI_AI_STUDIO_V1.4.0_LOCAL_EDITION
R=$REPO/releases/v1.7.1-cloudcompute
mkdir -p "$R/deployment/cloudcompute" "$R/deployment/tests" "$R/verification"
cp "$S/out/YOISAKI_AI_STUDIO_V1.7.1_CLOUDCOMPUTE_EDITION.zip" "$R/"
cp "$S/release-README.md" "$R/README.md"
cp "$P/YOISAKI_V1.7.1_CLOUDCOMPUTE_REPORT.md" "$R/"
cp "$P/docs/CLOUDCOMPUTE_INSTALL_ANDROID_RU.md" "$R/"
cp "$P/Dockerfile" "$P/.dockerignore" "$P/docker-compose.yml" "$P"/*-cloudcompute.sh "$R/deployment/"
cp "$P"/cloudcompute/* "$R/deployment/cloudcompute/"
cp "$P/tests/test_v171_cloudcompute.py" "$R/deployment/tests/"
cp "$P"/docs/verification/v171-*.txt "$R/verification/"
cp "$S/package-check.txt" "$R/verification/v171-package.txt"
[[ -f $S/native-install.txt ]] && cp "$S/native-install.txt" "$R/verification/v171-native-install.txt"
[[ -f $S/native-host-e2e.txt ]] && cp "$S/native-host-e2e.txt" "$R/verification/v171-native-host-e2e.txt"
find "$R" -name __pycache__ -prune -exec rm -r {} +
(cd "$R" && find . -type f | sort)
