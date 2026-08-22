#!/usr/bin/env bash
# Clone Zinit into XDG data if the checkout is missing.
set -Eeuo pipefail

# Pin matches the checkout already on this machine.
ZINIT_PIN="fc234da3adfcb3480a54ceab192c8e6886f8cff8"
ZINIT_REPO="https://github.com/zdharma-continuum/zinit"
ZINIT_HOME="${ZINIT_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/zinit/zinit.git}"

if [[ ! -f "$ZINIT_HOME/zinit.zsh" ]]; then
  parent_dir="$(dirname -- "$ZINIT_HOME")"
  mkdir -p "$parent_dir"

  if [[ -e "$ZINIT_HOME" ]]; then
    echo "Zinit path exists but is not a checkout: $ZINIT_HOME" >&2
    exit 1
  fi

  git clone "$ZINIT_REPO" "$ZINIT_HOME"
  git -C "$ZINIT_HOME" checkout --detach "$ZINIT_PIN"
fi

# Fetch every plugin before the first interactive shell needs it. Zinit caches
# these checkouts, so plugin loading during shell startup stays offline.
ZINIT_HOME="$ZINIT_HOME" zsh -df <<'ZSH'
source "$ZINIT_HOME/zinit.zsh"

zinit ice depth"1"
zinit light romkatv/powerlevel10k
zinit snippet OMZP::git
zinit light agkozak/zsh-z
zinit snippet OMZP::jsontools
zinit snippet OMZP::sudo
zinit light zsh-users/zsh-syntax-highlighting
ZSH
