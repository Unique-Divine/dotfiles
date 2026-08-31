#!/usr/bin/env zsh

# Sets up Tab completion for this Zsh configuration. Zsh ships `compinit` as an
# autoloadable shell function, not a binary. Calling it discovers completion
# definitions on Zsh's function search path, `fpath`, and registers them so Tab
# can complete commands, options, and file paths. This file owns that
# initialization, applies matching rules, and loads extra completion scripts,
# including fzf's Tab widget. Ubuntu's global compinit is disabled to prevent a
# second initialization.
#
# The work is deferred because scanning definitions and sourcing plugins slows
# the first prompt. Zinit normally loads this file just after the prompt; the
# first Tab press can load it sooner. Both paths must produce the same state and
# initialization must run only once. Keep Tab fallbacks explicit because plugins
# such as fzf may capture the temporary loader while being sourced.

(( ${_dotfiles_completions_loaded:-0} )) && return 0

# Ubuntu's vendor directory can contain a broken Docker Desktop symlink when
# Docker is closed or WSL integration is unavailable. Keep compinit usable by
# presenting the other vendor completions through a user-owned overlay. This
# avoids changing /usr/share and lets Docker completion return in a later shell
# once the real target exists again.
_dotfiles_prepare_vendor_completions() {
  local vendor_dir="/usr/share/zsh/vendor-completions"
  local docker_completion="$vendor_dir/_docker"

  [[ -L "$docker_completion" ]] || return 0
  [[ -e "$docker_completion" ]] && return 0

  local overlay_dir="${XDG_CACHE_HOME:-$HOME/.cache}/zsh/vendor-completions"
  command mkdir -p "$overlay_dir" || return 0

  local completion name
  for completion in "$vendor_dir"/_*(N); do
    [[ "$completion" == "$docker_completion" ]] && continue
    name="${completion:t}"
    command ln -sfn "$completion" "$overlay_dir/$name" 2>/dev/null || true
  done

  typeset -gU fpath
  fpath=("$overlay_dir" "${fpath[@]:#$vendor_dir}")
}

_dotfiles_prepare_vendor_completions

autoload -Uz compinit
compinit -i || return 1

# Replay completion definitions registered by plugins loaded before this file.
if (( ${+functions[zinit]} )); then
  zinit cdreplay -q
fi

# Use case-insensitive shell matching.
zstyle ':completion:*' matcher-list 'm:{a-z}={A-Za-z}'

# Reuse `ls` shell completions for `exa`.
compdef exa=ls

# ----------------------------------------------
# Fuzzy Finder (fzf)
# - Use `Ctrl-R` for `fzf` history search. This comes from the
#   fzf-history-widget in the fzf key-bindings.zsh file.
# ----------------------------------------------

# fzf records the current Tab widget as its fallback when completion.zsh loads.
# Tab may still point to our lazy loader here, so name the native widget instead.
typeset -g fzf_default_completion=expand-or-complete

# macOS / Homebrew (Apple Silicon)
if [[ -f /opt/homebrew/opt/fzf/shell/key-bindings.zsh ]]; then
  source /opt/homebrew/opt/fzf/shell/key-bindings.zsh
  source /opt/homebrew/opt/fzf/shell/completion.zsh
fi

# macOS / Homebrew (Intel)
if [[ -f /usr/local/opt/fzf/shell/key-bindings.zsh ]]; then
  source /usr/local/opt/fzf/shell/key-bindings.zsh
  source /usr/local/opt/fzf/shell/completion.zsh
fi

# Arch
if [[ -f /usr/share/fzf/key-bindings.zsh ]]; then
  source /usr/share/fzf/key-bindings.zsh
  source /usr/share/fzf/completion.zsh
fi

# Ubuntu
if [[ -f /usr/share/doc/fzf/examples/key-bindings.zsh ]]; then
  source /usr/share/doc/fzf/examples/key-bindings.zsh
  source /usr/share/doc/fzf/examples/completion.zsh
fi

# Google Cloud SDK command completion.
if [[ -f "$HOME/google-cloud-sdk/completion.zsh.inc" ]]; then
  source "$HOME/google-cloud-sdk/completion.zsh.inc"
fi

# Go command completion uses Bash's completion compatibility layer.
if [[ -x "$HOME/go/bin/gocomplete" ]]; then
  autoload -U +X bashcompinit
  bashcompinit
  complete -o nospace -C "$HOME/go/bin/gocomplete" go
fi

# Bun completions.
if [[ -s "$HOME/.bun/_bun" ]]; then
  source "$HOME/.bun/_bun"
fi

typeset -g _dotfiles_completions_loaded=1
