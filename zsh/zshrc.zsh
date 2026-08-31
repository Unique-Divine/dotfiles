#!/usr/bin/env zsh
#
# .zshrc
#
# Contact: Unique Divine <realuniquedivine@gmail.com>
# The .zshrc runs after .zshenv

# The $REPO and $DOTFILES variables are exported from .zshenv.

source $DOTFILES/zsh/bashlib.sh
# For a full list of active aliases, run `alias`.
# Set $DOTFILES/zsh/aliases.sh for custom ones.

# Add SSH keys to the persistent systemd-managed agent when a new WSL session
# needs Git SSH access. New terminals reuse the keys without calling this.
ssh_setup() {
  if [[ ! -S "${SSH_AUTH_SOCK:-}" ]]; then
    print -u2 "SSH agent is unavailable; run: systemctl --user start ssh-agent"
    return 1
  fi

  local -a identity_files=(
    "$HOME/.ssh/personal_sb3_wsl_key"
    "$HOME/.ssh/peggyWSL"
    "$HOME/.ssh/personalSB3Key"
    "$HOME/.ssh/dieselSB3WSL_key"
  )
  local identity_file
  for identity_file in "${identity_files[@]}"; do
    [[ -r "$identity_file" ]] || continue
    ssh-add "$identity_file" || return 1
  done
}

# Load NVM only when `nvm` is invoked. The flag is scoped to this shell session,
# so NVM is sourced and its default/project version chosen only once.
typeset -g _dotfiles_nvm_loaded=0

load_nvm() {
  (( _dotfiles_nvm_loaded )) && return 0

  export NVM_DIR="$HOME/.nvm"
  if [[ ! -s "$NVM_DIR/nvm.sh" ]]; then
    print -u2 "NVM is not installed at $NVM_DIR/nvm.sh"
    return 1
  fi

  source "$NVM_DIR/nvm.sh"
  nvm alias default lts/krypton >/dev/null
  nvm use --silent >/dev/null 2>&1 ||
    nvm use --silent default >/dev/null 2>&1 || true
  _dotfiles_nvm_loaded=1
}

nvm() {
  load_nvm || return
  nvm "$@"
}


echo "⚡ Shell setup with IO complete."

# ------------ --------------------------------------------- ------------
# -            NOTE: Perform any console IO above this block.           -
# ------------ --------------------------------------------- ------------

# Enable Powerlevel10k instant prompt. Should stay close to the top of ~/.zshrc.
# Initialization code that may require console input (password prompts, [y/n]
# confirmations, etc.) must go above this block; everything else may go below.
if [[ -r "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh" ]]; then
  source "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh"
fi

source "$DOTFILES/zsh/zinit.sh"
[[ ! -f ~/.p10k.zsh ]] || source ~/.p10k.zsh

# If you come from bash you might have to change your $PATH.
export PATH=$HOME/bin:/usr/local/bin:$DOTFILES/bin:$PATH

vs_code="/mnt/c/Program Files/Microsoft VS Code"
export PATH=$vs_code/bin:$PATH

# User configuration

# export MANPATH="/usr/local/man:$MANPATH"

# You may need to manually set your language environment
# export LANG=en_US.UTF-8

# Preferred editor for local and remote sessions
if [[ -n $SSH_CONNECTION ]]; then
  export EDITOR='vi'
fi

# Compilation flags
# export ARCHFLAGS="-arch x86_64"

# Set personal aliases, overriding those provided by oh-my-zsh libs,
# plugins, and themes. Aliases can be placed here, though oh-my-zsh
# users are encouraged to define aliases within the ZSH_CUSTOM folder.
#
# Example aliases

# Enable vim keybinds
bindkey -v

# Restore Oh My Zsh's typed-prefix history search for the arrow keys.
autoload -Uz up-line-or-beginning-search down-line-or-beginning-search
zle -N up-line-or-beginning-search
zle -N down-line-or-beginning-search
for keymap in emacs viins vicmd; do
  bindkey -M "$keymap" "^[[A" up-line-or-beginning-search
  bindkey -M "$keymap" "^[[B" down-line-or-beginning-search
  if [[ -n "${terminfo[kcuu1]:-}" ]]; then
    bindkey -M "$keymap" "$terminfo[kcuu1]" up-line-or-beginning-search
  fi
  if [[ -n "${terminfo[kcud1]:-}" ]]; then
    bindkey -M "$keymap" "$terminfo[kcud1]" down-line-or-beginning-search
  fi
done
unset keymap

# Ensure completion setup exists before the first Tab, even if Zinit's Turbo
# queue has not run yet. Run native completion directly for that first press.
# The completion module may install another Tab widget for later presses.
if [[ -o interactive ]] && (( ${+widgets[expand-or-complete]} )); then
  _dotfiles_load_completions() {
    (( ${_dotfiles_completions_loaded:-0} )) && return 0
    source "$DOTFILES/zsh/completions.zsh"
  }

  _dotfiles_lazy_complete() {
    _dotfiles_load_completions || return
    zle expand-or-complete
  }

  zle -N _dotfiles_lazy_complete
  bindkey -M emacs '^I' _dotfiles_lazy_complete
  bindkey -M viins '^I' _dotfiles_lazy_complete
fi

export PATH=$HOME/bin:$PATH

# Fixes permission denied error in Windows machine sometimes seen with `just`.
# > error: Recipe `setup` with shebang `#!/usr/bin/env bash` execution error: Permission denied (os error 13)
if [[ -n "${SUDO_PW:-}" ]] &&
  is_wsl >/dev/null &&
  [[ "${XDG_RUNTIME_DIR:-}" == /run/user/* ]]; then
  # WSL can mount /run/user as tmpfs with the noexec option, which prevents
  # scripts stored under XDG_RUNTIME_DIR from being executed. `just` runs
  # shebang recipes through temp files there, so noexec can surface as:
  # "Permission denied (os error 13)". Remounting the actual mount point
  # (/run/user, not /run/user/1000) with exec allows those temp files to run.
  echo "$SUDO_PW" | sudo -S --prompt="" mount -o remount,exec /run/user
fi

# ----------------------------------------------
# History
# ----------------------------------------------
HISTSIZE="100000"
SAVEHIST="$HISTSIZE"
HISTDUP="erase"
HISTFILE="$HOME/.zsh_history"

# APPEND_HISTORY: Append to the HISTFILE instead of overwriting it
setopt APPEND_HISTORY
# SHARE_HISTORY: Shares history across all zsh sessions at the same time rather
#   than treating them independently. Great setting for someone that works across
#   multiple terminals.
setopt SHARE_HISTORY
# Collectively, these prevent duplicates from becoming part of the history.
setopt HIST_IGNORE_ALL_DUPS
# HIST_SAVE_NO_DUPS: When writing out the history file, older commands that
#   duplicate newer ones are omitted.
setopt HIST_SAVE_NO_DUPS
# HIST_IGNORE_DUPS: Do not enter command lines into the history list if they are
#   duplicates of the previous event.
setopt HIST_IGNORE_DUPS
# HIST_FIND_NO_DUPS: Prevents dups display in historical search
setopt HIST_FIND_NO_DUPS

# Binds C-p and C-n to forward and backward history search.
bindkey '^p' history-search-backward
bindkey '^n' history-search-forward

# NUMERIC_GLOB_SORT: Sort where file `f10` is after `f9` rather than after `f1`
setopt NUMERIC_GLOB_SORT

# Turn off all beeps
unsetopt BEEP

# ----------------------- Go / Golang
export GOROOT="/usr/local/go"
export GOPATH="$HOME/go"
export PATH="$GOPATH/bin:$GOROOT/bin:$PATH"
export GO111MODULE=on

# Define the Goenv installation and shims before deferred initialization. The
# shim path lets `go` resolve immediately after the prompt.
export GOENV_ROOT="$HOME/.goenv"
export PATH="$GOENV_ROOT/bin:$PATH"
export PATH="$PATH:$GOENV_ROOT/shims"
export PATH="$GOROOT/bin:$PATH"
export PATH="$PATH:$GOPATH/bin"

export PATH="/mnt/c/Windows:/mnt/c/Windows/system32:$PATH"
export PATH="/mnt/c/Users/realu/AppData/Local/Programs/Microsoft VS Code/bin:$PATH"

# Cosmos-sdk 'file' backend
# alias keyd='f(){ "$@" --keyring-backend test;  unset -f f; }; f'
export KEYRING="--keyring-backend=test"
# nibid flag for outputting in JSON format
# you can also edit the config directly with `nibid config [key] [value]`
# Display the current binary config by running `nibid config`

# Yarn and nvm
export PATH="$HOME/.yarn/bin:$HOME/.config/yarn/global/node_modules/.bin:$PATH"

export PATH="$PATH:/home/linuxbrew/.linuxbrew/bin"
export PATH="$PATH:$HOME/.foundry/bin"

# Google Cloud SDK:
# The next line updates PATH for the Google Cloud SDK.
if [ -f "$HOME/google-cloud-sdk/path.zsh.inc" ]; then . "$HOME/google-cloud-sdk/path.zsh.inc"; fi

export PATH="$HOME/.local/bin:$PATH"
export PATH="$HOME/.poetry/bin:$PATH"

clean_poetry() {
  # Cleans and resets the enviroment for the Poeatry package manager, which is
  # used to manage Python dependencies.
  echo "clearing .cache/pypoetry" 
  rm -rf ~/.cache/pypoetry

  echo "clearing .venv" 
  rm -rf .venv

  echo "clearing poetry.lock" 
  rm -f poetry.lock

  echo "poetry cache clear pypi --all"
  poetry cache clear pypi --all
}

export NIBI="000000unibi"
export FAUCET_WEB="nibi1cq87ggjzlt3jzs8u7fc2e36e7nellvatzw8a63"
export FAUCET_DISCORD="nibi1x9tym6ah8lzrnmzvv33pwmz9jeqd6ucd69kemr"
export TXFLAG=(--gas-prices 0.25unibi --gas auto --gas-adjustment 1.3)

nibi_addrs() {
  # ADDR_DELPHI: (TESTING ONLY)
  export ADDR_DELPHI="nibi10gm4kys9yyrlqpvj05vqvjwvje87gln8nsm8wa"

  # ADDR_VAL: (TESTING ONLY) Default localnet validator
  export ADDR_VAL="nibi1zaavvzxez0elundtn32qnk9lkm8kmcsz44g7xl"
  echo $ADDR_VAL ADDR_VAL 
  echo $ADDR_DELPHI ADDR_DELPHI 
  echo $FAUCET_WEB FAUCET_WEB 
  echo $FAUCET_DISCORD FAUCET_DISCORD 
}

nibi_keys() {
  # ADDR_VAL: (TESTING ONLY) Default localnet validator
  # This is the main validator on a fresh local test instance of Nibiru
  KEY_NAME="validator"
  local MNEM="guard cream sadness conduct invite crumble clock pudding hole grit liar hotel maid produce squeeze return argue turtle know drive eight casino maze host" 
  echo "$MNEM" | nibid keys add $KEY_NAME --recover --keyring-backend test
}


# Too many open files
# List the soft file limit: ulimit -n
# Increase soft file limit: ulimit -n 4096
ulimit -n 4096

# bun
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"

# Mason - pkgs used in nvim
# Load to the right side of `PATH` so that other binaries take precedence over
# the Mason binaries.
export PATH="$PATH:$HOME/.local/share/nvim/mason/bin"

# sync_cursor_cli_config keeps Cursor CLI's runtime config aligned with the
# dotfile config while preserving Cursor-managed auth, cache, and model state.
sync_cursor_cli_config() {
  if ! which_ok bun; then
    return 0
  fi

  if [[ ! -f "$DOTFILES/cursor/cli-config.ts" ]]; then
    return 0
  fi

  local output
  output=$(bun run "$DOTFILES/cursor/cli-config.ts" --run --quiet 2>&1) || {
    echo "Cursor CLI config sync failed:" >&2
    echo "$output" >&2
  }
}

sync_cursor_cli_config

# GVM (Go Version Manager) was an experiment. Load it only if it is invoked;
# the regular system `go` command remains available without this setup.
load_gvm() {
  [[ -s "$HOME/.gvm/scripts/gvm" ]] || return 1
  source "$HOME/.gvm/scripts/gvm"
}

gvm() {
  unfunction gvm
  load_gvm || {
    print -u2 "GVM is not installed at $HOME/.gvm/scripts/gvm"
    return 1
  }
  gvm "$@"
}

# >>> Codex installer >>>
export PATH="$HOME/.local/bin:$PATH"
# <<< Codex installer <<<
