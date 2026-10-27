#!/usr/bin/env bash
# Idempotent native install (no Docker): Python venv + pinned cloudflared on the persistent data disk.
# A repeat run with unchanged pins does nothing (marker = hash of pins + Python version).
set -euo pipefail
# shellcheck source=cloudcompute/lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/lib.sh"
yoisaki_load_config
yoisaki_prepare_dirs

RUNTIME=$YOISAKI_DATA_ROOT/runtime
VENV=$RUNTIME/venv
MARKER=$VENV/.yoisaki-install

pick_python() {
  local candidate
  for candidate in ${YOISAKI_BASE_PYTHON:-} python3.12 python3.11 python3.13 python3.10 python3; do
    command -v "$candidate" >/dev/null 2>&1 || continue
    "$candidate" -c 'import sys; sys.exit(not (3, 10) <= sys.version_info[:2] <= (3, 13))' && { command -v "$candidate"; return; }
  done
  return 1
}

install_venv() {
  local base want
  base=$(pick_python) || {
    if [[ $(id -u) == 0 ]] && command -v apt-get >/dev/null; then
      say 'Устанавливаю Python 3 (apt)…'
      apt-get update -qq && apt-get install -y -qq python3 python3-venv >/dev/null
      base=$(pick_python) || die 'Не найден Python 3.10–3.13.'
    else die 'Не найден Python 3.10–3.13. Используйте режим Docker или образ с Python.'; fi
  }
  want=$( { cat "$YOISAKI_APP/cloudcompute/requirements-cloud.txt" "$YOISAKI_APP/engine/requirements.txt"; "$base" -VV; } | sha256sum | cut -c1-64)
  if [[ -x $VENV/bin/python && -f $MARKER && $(cat "$MARKER") == "$want" ]]; then
    say "✔ Зависимости уже установлены ($VENV) — переустановка не нужна."
    return
  fi
  if [[ ! -x $VENV/bin/python ]]; then
    if ! "$base" -m venv "$VENV" 2>/dev/null; then
      if [[ $(id -u) == 0 ]] && command -v apt-get >/dev/null; then
        apt-get update -qq && apt-get install -y -qq python3-venv >/dev/null
        rm -rf -- "$VENV"   # only our half-created venv folder, never user data
        "$base" -m venv "$VENV"
      else die 'Модуль venv недоступен (пакет python3-venv).'; fi
    fi
  fi
  local free_gb
  free_gb=$(df -Pk "$RUNTIME" | awk 'NR==2 {print int($4/1048576)}')
  (( free_gb >= 12 )) || die "Для установки PyTorch нужно ≥ 12 ГБ свободного места, свободно ${free_gb} ГБ."
  say 'Установка зависимостей (первый раз: несколько ГБ, займёт время)…'
  local log=$YOISAKI_DATA_ROOT/logs/install-native.log
  {
    "$VENV/bin/python" -m pip install --disable-pip-version-check -r "$YOISAKI_APP/cloudcompute/requirements-cloud.txt" &&
    "$VENV/bin/python" -m pip install --disable-pip-version-check -c "$YOISAKI_APP/cloudcompute/requirements-cloud.txt" -r "$YOISAKI_APP/engine/requirements.txt" &&
    "$VENV/bin/python" -m pip check &&
    (cd "$YOISAKI_APP/engine" && "$VENV/bin/python" "$YOISAKI_APP/cloudcompute/import_check.py" "$YOISAKI_APP/engine")
  } >"$log" 2>&1 || { tail -n 30 "$log" >&2; die "Установка не завершена. Полный журнал: $log"; }
  "$VENV/bin/python" -m pip freeze > "$RUNTIME/installed-versions.txt"
  printf '%s\n' "$want" > "$MARKER.tmp" && mv -f "$MARKER.tmp" "$MARKER"
  say '✔ Зависимости установлены.'
}

install_cloudflared() {
  local target=$RUNTIME/bin/cloudflared
  if [[ -x $target ]] && echo "$CLOUDFLARED_SHA256  $target" | sha256sum -c --status -; then
    say "✔ cloudflared $CLOUDFLARED_VERSION уже установлен."
    return
  fi
  say "Загрузка cloudflared $CLOUDFLARED_VERSION…"
  curl -fsSL -o "$target.part" "https://github.com/cloudflare/cloudflared/releases/download/$CLOUDFLARED_VERSION/cloudflared-linux-amd64"
  echo "$CLOUDFLARED_SHA256  $target.part" | sha256sum -c --status - || { rm -f -- "$target.part"; die 'Контрольная сумма cloudflared не совпала.'; }
  chmod 0755 "$target.part" && mv -f "$target.part" "$target"
  say '✔ cloudflared установлен и проверен (SHA-256).'
}

# 1.7.2: rclone for the read-only Google Drive model sync (distribution package, verified by apt).
install_rclone() {
  if [[ -n ${YOISAKI_RCLONE:-} && -x ${YOISAKI_RCLONE} ]] || command -v rclone >/dev/null 2>&1; then
    say "✔ rclone: $( { "${YOISAKI_RCLONE:-rclone}" version 2>/dev/null || true; } | head -n1)"
    return
  fi
  if [[ $(id -u) == 0 ]] && command -v apt-get >/dev/null; then
    say 'Установка rclone (apt)…'
    apt-get update -qq && apt-get install -y -qq rclone >/dev/null && { say '✔ rclone установлен.'; return; }
  fi
  warn 'rclone не установлен: синхронизация с Google Drive недоступна (движок работает). Установите rclone (apt install rclone) от root.'
}

[[ $(uname -m) == x86_64 ]] || die 'Поддерживается только x86_64 (amd64).'
install_venv
install_cloudflared
[[ ${YOISAKI_DRIVE_SYNC:-1} == 0 ]] || install_rclone
