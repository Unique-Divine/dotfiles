#!/usr/bin/env bash

# Global order for zsh: zshenv, zprofile, zshrc, zlogin
ln -sf "$DOTFILES/zsh/zshenv" ~/.zshenv # cp ~/.zshenv "$DOTFILES/zsh/zshenv"
ln -sf "$DOTFILES/zsh/zshrc" ~/.zshrc
ln -sf "$DOTFILES/rustfmt.toml" ~/rustfmt.toml
ln -sf "$DOTFILES/tmux/tmux.conf" ~/.tmux.conf

mkdir -p ~/.config
ln -sf "$DOTFILES/nvim" ~/.config/

mkdir -p ~/.config/yarn/global
ln -sf "$DOTFILES/.config/yarn/global/package.json" ~/.config/yarn/global/package.json
