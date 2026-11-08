#!/usr/bin/env bash
# Install or verify the standalone Codex CLI.
#   --check  report whether codex runs (default)
#   --run    install it with OpenAI's installer when it's missing
# Installer: https://learn.chatgpt.com/docs/codex/cli
set -Eeuo pipefail

mode="${1:---check}"
install_url="${CODEX_INSTALL_URL:-https://chatgpt.com/codex/install.sh}"
local_bin="$HOME/.local/bin/codex"

codex_ok() {
  local bin
  bin="$(command -v codex || true)"
  [[ -n "$bin" ]] || bin="$local_bin"
  [[ -x "$bin" ]] && "$bin" --version >/dev/null 2>&1
}

case "$mode" in
  --run)
    if ! codex_ok; then
      curl -fsSL "$install_url" | CODEX_NON_INTERACTIVE=1 sh
    fi
    ;;
  --check) ;;
  *) echo "Usage: bash codex/native.sh [--check|--run]" >&2; exit 2 ;;
esac

if ! codex_ok; then
  echo "Codex is missing or broken (repair: just codex-install)." >&2
  exit 1
fi
