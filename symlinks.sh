#!/usr/bin/env bash
#
# symlinks.sh - Create symlinks from the dotfiles configuration to appropriate
# locations in the users "$HOME" directory.
#
# Dependencies:
#   - $DOTFILES: Path to the dotfiles repository root. Set via zshenv.
#   - $SUDO_PW: Password for sudo operations (from env.sh)
#   - bashlib.sh: Provides which_ok() and log_warning() functions
#   - env.sh: Provides $SUDO_PW environment variable

if [[ -z "$DOTFILES" ]]; then
  echo "ERROR; \$DOTFILES variable is not set. Run the script via \"zsh/zshenv\""
  exit 1
fi

# Function `_symlink` creates a symbolic link from source to destination if it
# doesn't already exist. 
# Usage: _symlink <source_path> <destination_path>
_symlink() {
  local src="$1"
  local dst="$2"

  if [[ -L "src" ]]; then
    return 0
  fi
  
  ln -sf "$src" "$dst" 
}

# Global order for zsh: zshenv, zprofile, zshrc, zlogin
_symlink "$DOTFILES/zsh/zshenv" ~/.zshenv # cp ~/.zshenv "$DOTFILES/zsh/zshenv"
_symlink "$DOTFILES/zsh/zshrc" ~/.zshrc
_symlink "$DOTFILES/rustfmt.toml" ~/rustfmt.toml
_symlink "$DOTFILES/tmux/tmux.conf" ~/.tmux.conf

mkdir -p ~/.config
_symlink "$DOTFILES/nvim" ~/.config/

source "$DOTFILES/zsh/bashlib.sh"
source "$DOTFILES/env.sh" # For the $SUDO_PW env var

# Ensure both nvim and view are available before creating symlink
if which_ok nvim && which_ok view; then
  # The `sudo` command doesn't typically read from stdin, so you have to use
  # `sudo -S` to get the desired behavior. The `-S` is shorthand for `--std-in`.
  # See the docs at `man sudo`.
  echo "$SUDO_PW" | sudo -S ln -sf "$(which nvim)" "$(which view)"
else
    log_warning "Skipping symlink creation between nvim <-> view due to missing dependencies." >&2
fi

mkdir -p ~/.config/yarn/global
_symlink "$DOTFILES/.config/yarn/global/package.json" ~/.config/yarn/global/package.json
