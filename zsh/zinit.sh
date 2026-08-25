# zinit.sh - Load Zinit after `just sync` installs the checkout.
#
# The clone lives under XDG data, not this repo:
#   ~/.local/share/zinit/zinit.git
# Plugin declarations belong here. Do not symlink the clone.

ZINIT_HOME="${ZINIT_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/zinit/zinit.git}"

if [[ ! -f "$ZINIT_HOME/zinit.zsh" ]]; then
  print -u2 "Zinit is not installed at $ZINIT_HOME; run just sync"
  return 0
fi

source "$ZINIT_HOME/zinit.zsh"
autoload -Uz _zinit
(( ${+_comps} )) && _comps[zinit]=_zinit

# Powerlevel10k must load before ~/.p10k.zsh and before ZLE draws a prompt.
zinit ice depth"1"
zinit light romkatv/powerlevel10k

# Plugins that must work in the first command after a prompt.
zinit snippet OMZP::git

# `z` comes from agkozak/zsh-z. It records frequently and recently visited
# directories in ~/.z and provides the familiar `z <query>` jump command.
zinit light agkozak/zsh-z

# Goenv's shims are already in PATH before this file loads. Turbo initializes
# its shell function and completions after the prompt. If `goenv` is used
# first, Zinit loads this snippet synchronously and forwards that command.
zinit ice wait"0" lucid link nocompile trigger-load'!goenv'
zinit snippet "$DOTFILES/zsh/goenv-init.zsh"

# Start Docker Desktop only when the first Docker command is used. The local
# snippet waits for the daemon, then Zinit replays the original command.
zinit ice lucid link nocompile trigger-load'!docker'
zinit snippet "$DOTFILES/zsh/docker-init.zsh"

# Own compinit and all custom completion registration in one Turbo-loaded file.
# The first-Tab fallback in zshrc handles a user who types before Turbo runs.
zinit ice wait"0" lucid link nocompile
zinit snippet "$DOTFILES/zsh/completions.zsh"

# These commands and widgets can appear after the first prompt. Syntax
# highlighting must load last so it sees widgets created by earlier plugins.
zinit ice wait"0" lucid
zinit snippet OMZP::jsontools

zinit ice wait"0" lucid
zinit snippet OMZP::sudo

zinit ice wait"0b" lucid
zinit light zsh-users/zsh-syntax-highlighting
