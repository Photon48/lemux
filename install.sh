#!/usr/bin/env bash
# lemux installer — works from a local checkout (./install.sh)
# or as a one-liner:
#   curl -fsSL https://raw.githubusercontent.com/Photon48/lemux/main/install.sh | bash
set -euo pipefail

REPO="${LEMUX_REPO:-Photon48/lemux}"
RAW="https://raw.githubusercontent.com/$REPO/main"
BIN_DIR="${LEMUX_BIN_DIR:-$HOME/.local/bin}"
BIN="$BIN_DIR/lemux"
TMUX_CONF="${LEMUX_TMUX_CONF:-$HOME/.tmux.conf}"

say()  { printf '\033[1mlemux:\033[0m %s\n' "$*"; }
fail() { printf 'lemux: %s\n' "$*" >&2; exit 1; }

# 1. dependencies
missing=()
for c in tmux fzf jq; do command -v "$c" >/dev/null 2>&1 || missing+=("$c"); done
((${#missing[@]} == 0)) || fail "missing dependencies: ${missing[*]} — try: brew install ${missing[*]}"
command -v claude >/dev/null 2>&1 || fail "claude not found — install Claude Code first: https://claude.com/claude-code"

# 2. install the script
mkdir -p "$BIN_DIR"
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)
if [[ -n "$script_dir" && -f "$script_dir/lemux" ]]; then
  cp "$script_dir/lemux" "$BIN"
  say "installed from local checkout → $BIN"
else
  curl -fsSL "$RAW/lemux" -o "$BIN"
  say "downloaded $REPO → $BIN"
fi
chmod +x "$BIN"

# 3. tmux keybindings (idempotent: replaces any existing lemux block)
touch "$TMUX_CONF"
sed -i.lemux-bak '/^# >>> lemux >>>/,/^# <<< lemux <<</d' "$TMUX_CONF"
rm -f "$TMUX_CONF.lemux-bak"
"$BIN" init >>"$TMUX_CONF"
say "keybindings added to $TMUX_CONF"

# 4. reload tmux if it's running
if tmux list-sessions >/dev/null 2>&1; then
  tmux source-file "$TMUX_CONF" && say "tmux config reloaded"
fi

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) say "note: $BIN_DIR is not on your PATH — add it to use 'lemux' directly" ;;
esac

say "done. inside tmux, run:  lemux start [name]"
say "keys: prefix+B branch · prefix+T tree · prefix+X delete"
