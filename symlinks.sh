#!/usr/bin/env bash

if [[ -z "$DOTFILES" ]]; then
  echo "ERROR; \$DOTIFLES variable is not set. Run the script via \"zsh/zshenv\""
  exit 1
fi

# Global order for zsh: zshenv, zprofile, zshrc, zlogin
ln -sf "$DOTFILES/zsh/zshenv" ~/.zshenv # cp ~/.zshenv "$DOTFILES/zsh/zshenv"
ln -sf "$DOTFILES/zsh/zshrc" ~/.zshrc
ln -sf "$DOTFILES/rustfmt.toml" ~/rustfmt.toml
ln -sf "$DOTFILES/tmux/tmux.conf" ~/.tmux.conf

mkdir -p ~/.config
ln -sf "$DOTFILES/nvim" ~/.config/

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
ln -sf "$DOTFILES/.config/yarn/global/package.json" ~/.config/yarn/global/package.json
