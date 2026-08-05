#!/usr/bin/env bash
# lemux installer — works from a local checkout (./install.sh)
# or as a one-liner:
#   curl -fsSL https://raw.githubusercontent.com/Photon48/lemux/main/install.sh | bash
set -euo pipefail

REPO="${LEMUX_REPO:-Photon48/lemux}"
RAW="https://raw.githubusercontent.com/$REPO/main"
BIN_DIR="${LEMUX_BIN_DIR:-$HOME/.local/bin}"
BIN="$BIN_DIR/lemux"

say() { printf '\033[1mlemux:\033[0m %s\n' "$*"; }

# 1. get the script — everything else is `lemux setup`, which checks deps,
#    writes the tmux keybindings, merges the claude hooks, and reloads tmux
mkdir -p "$BIN_DIR"
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)
if [[ -n "$script_dir" && -f "$script_dir/lemux" ]]; then
  say "installing from local checkout"
  exec "$script_dir/lemux" setup
else
  curl -fsSL "$RAW/lemux" -o "$BIN"
  chmod +x "$BIN"
  say "downloaded $REPO → $BIN"
  exec "$BIN" setup
fi
