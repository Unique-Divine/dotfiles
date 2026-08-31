#!/usr/bin/env bash

# ===================================================
# Unique Divine linux commands
# ===================================================

alias ls="exa" # cargo install exa
# alias ls="exa --icons" # cargo install exa
alias la="ls -a"

# cargo install bat
[[ -n "$(command -v bat)" ]] && alias cat="bat" # cargo install bat
# if command -v bat >/dev/null 2>&1; then
#
# fi
# NOTE: This is important - sudo apt install build-essential
alias rm="trash -v"

alias vi="nvim"
alias vim="nvim"

# vv: short for "vim view". Piping to vv opens stdout in Neovim.
alias vv="nvim -"
alias jqvv="jq | nvim -"

# Core Unix
alias grep="rg --color=auto"
alias diff="diff --color=auto"
alias df="df -h"

# Navigate to last directory using single dash, similar to your oil.nvim setup.
alias -- -='cd -'
#  Jump to prev dir with `cd -`
#  The -- Prevents being parsed as a flag;

alias ess="2>&1"

alias start="cmd.exe /C start"
# Ex: cmd.exe /C start https://google.com

# Git aliases and editor live in zsh/gitconfig.ini.

# Broadcast tx and open it in vim.
# alias tx="jq -rcs '.[0].txhash' | { read txhash; sleep 3; nibid q tx \$txhash | jq '{txhash, height, code, logs, gas_used, gas_wanted, tx}' | vv}"
# Broadcast tx and save it to "txout.json"
# alias txout="jq -rcs '.[0].txhash' | { read txhash; sleep 3; nibid q tx \$txhash | jq '{txhash, height, code, logs, gas_used, gas_wanted, tx}' >> txout.json}"

alias ft="focustime" # 2026-03-04
alias npx="bunx"
alias codex="FORCE_COLOR=1 codex"
