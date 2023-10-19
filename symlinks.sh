#!/usr/bin/env bash

ln -sf "$DOTFILES/rustfmt.toml" ~/rustfmt.toml
ln -sf "$DOTFILES/tmux/tmux.conf" ~/.tmux.conf
ln -sf "$DOTFILES/nvim" ~/.config/nvim

ln -sf "$DOTFILES/.config/yarn" ~/.config/yarn

# Global order for zsh: zshenv, zprofile, zshrc, zlogin
