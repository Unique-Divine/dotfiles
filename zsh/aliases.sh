#!/usr/bin/env bash

alias ohmyzsh="nvim ~/.oh-my-zsh"

# MongoDB alias commands 
alias mongo="/mnt/c/Program\ Files/MongoDB/Server/5.0/bin/mongo.exe"
alias mongod="/mnt/c/Program\ Files/MongoDB/Server/5.0/bin/mongod.exe"
alias mongosh="/mnt/c/Users/realu/AppData/Local/Programs/mongosh/mongosh.exe"
alias mongos="/mnt/c/Program\ Files/MongoDB/Server/5.0/bin/mongos.exe"

# Unique Divine linux commands
alias ls="exa"    # cargo install exa
alias la='exa -a'
alias s='sudo'
alias yarn-offline='yarn --prefer-offline'
alias cat="bat"   # cargo install bat
# NOTE: This is important - sudo apt install build-essential

alias vi="nvim"
alias vim="nvim"

# vv: short for "vim view". Piping to vv lets you read stdout in a vi editor
alias vv="view -"
alias vvjq="jq | vv"

alias ess="2>&1"

alias start="cmd.exe /C start"
# Ex: cmd.exe /C start https://google.com

git config --global alias.co checkout
git config --global alias.br branch
git config --global alias.ci commit
git config --global alias.st status
git config --global alias.ac '!git add -A && git commit'
git config --global core.editor "nvim"

# Broadcast tx and open it in vim.
# alias tx="jq -rcs '.[0].txhash' | { read txhash; sleep 3; nibid q tx \$txhash | jq '{txhash, height, code, logs, gas_used, gas_wanted, tx}' | vv}"
# Broadcast tx and save it to "txout.json"
# alias txout="jq -rcs '.[0].txhash' | { read txhash; sleep 3; nibid q tx \$txhash | jq '{txhash, height, code, logs, gas_used, gas_wanted, tx}' >> txout.json}"

