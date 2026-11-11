#!/usr/bin/env bash
# Install or verify the Grok CLI.
#   --check  report whether grok runs (default)
#   --run    install it with the xAI installer when it's missing
# Installer: https://x.ai/cli/install.sh
set -Eeuo pipefail

mode="${1:---check}"
install_url="${GROK_INSTALL_URL:-https://x.ai/cli/install.sh}"

grok_ok() {
  local bin
  bin="$(command -v grok || true)"
  if [[ -z "$bin" && -x "$HOME/.local/bin/grok" ]]; then
    bin="$HOME/.local/bin/grok"
  fi
  if [[ -z "$bin" && -x "$HOME/.grok/bin/grok" ]]; then
    bin="$HOME/.grok/bin/grok"
  fi
  [[ -n "$bin" && -x "$bin" ]] && "$bin" --version >/dev/null 2>&1
}

case "$mode" in
  --run)
    if ! grok_ok; then
      # SHELL=/bin/sh keeps the installer off ~/.zshrc. That file is a
      # managed symlink, and the installer follows it into this repo.
      mkdir -p "$HOME/.local/bin"
      (
        export SHELL=/bin/sh
        export PATH="$HOME/.local/bin:$PATH"
        curl -fsSL "$install_url" | bash
      )
    fi
    ;;
  --check) ;;
  *) echo "Usage: bash grok/native.sh [--check|--run]" >&2; exit 2 ;;
esac

if ! grok_ok; then
  echo "Grok is missing or broken (repair: just grok-install)." >&2
  exit 1
fi
