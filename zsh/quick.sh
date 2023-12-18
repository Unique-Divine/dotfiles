#!/usr/bin/env bash

# shellcheck disable=SC2155
# The $DOTFILES  and $KOJIN_PATH variables are exported from .zshenv.

# todos: Opens NeoVim with your notes workspace as the working directory with
# your text-based TODO-list open.
todos() {
  local before="$(pwd)"
  z gh-realu/kojin
  nvim "$KOJIN_PATH/free/todo.md"
  cd "$before" || return 1
}

# notes: Opens NeoVim with a notes workspace as the working directory.
notes() {
  local before="$(pwd)"
  z gh-realu/kojin
  nvim .
  cd "$before" || return 1
}

# myrc: For editing your zshrc config. Opens the NeoVim working directory
# in the zsh section of your dotfiles. This command autosaves to update 
# the shell by re-running the main shell aliases and bash lib.
myrc() {
  local before="$(pwd)"
  cd "$DOTFILES/zsh" || return 1
  nvim .
  main_bash_setup
  cd "$before" || return 1
}

dotf() {
  local before="$(pwd)"
  cd "$DOTFILES" || return 1
  nvim .
  main_bash_setup
  cd "$before" || return 1
}

# nvim_cfg: Edit your nvim config.
nvim_cfg() {
  local before="$(pwd)"
  local cfg="$HOME/.config/nvim"
  cd "$cfg" || return 1
  nvim .
  cd "$before" || return 1
}

# nvim_cfg: Edit your tmux config.
tmux_cfg() {
  local before="$(pwd)"
  local tmux_path="$HOME/.tmux.conf"
  nvim "$tmux_path"
  tmux source-file "$tmux_path"
  cd "$before" || return 1
}

# git_cof: Git "[c]heck [o]ut [f]rom": Check out the target and fetch prune,
# deleting the starting branch.
git_cof() {
  local target_branch="$1"
  local start_branch="$(git br --show-current)"
  git fetch --all --prune || true
  git checkout "$target_branch"
  git branch -D "$start_branch"
  git pull || true
}

# git_mf: Git "[m]erge [f]rom". Fetch, prune, check out the target and merge it
# into the starting branch.
git_mf() {
  local target_branch="$1"
  local start_branch="$(git br --show-current)"
  git fetch --all --prune || true
  git checkout "$target_branch"
  git pull || true
  git checkout "$start_branch"
  git merge "$target_branch"
}


### ----------------- Nibiru Chain -----------------
#

# Reminders for config_* functions
# - Update any relevant .env files in py-sdk, ts-sdk, etc.

RPC_LOCAL="http://localhost:26657"
RPC_TESTNET="https://rpc.testnet-1.nibiru.fi:443"  # load balanced between nodes
RPC_DEVNET="https://rpc.devnet-3.nibiru.fi:443"
RPC_NIBI="https://rpc.nibiru.fi:443"
# ITN_RPC="https://rpc-1.itn-1.nibiru.fi:443"   # individual node
# https://rpc-nibiru.nodeist.net:443 # an alternative RPC 

# Functions for switching chain configurations on nibiru.

# config_localnet: Fn for switching the Nibid config to local network.
config_localnet() {
  local rpc_url="$RPC_LOCAL"
  local chain_id="nibiru-localnet-0"
  nibid config node $rpc_url
  nibid config chain-id "$chain_id"
  nibid config broadcast-mode sync 
  nibid config
  export RPC="$rpc_url"
}

# config_testnet: Fn for switching the Nibid config to a test network (testnet).
config_testnet() {
  local rpc_url="$RPC_TESTNET"
  local chain_id="nibiru-testnet-1"
  nibid config node $rpc_url
  nibid config chain-id "$chain_id"
  nibid config broadcast-mode sync 
  nibid config
  export RPC="$rpc_url"
}

# config_devnet: Fn for switching the Nibid config to a dev network (devnet).
config_devnet() {
  local rpc_url="$RPC_DEVNET"
  nibid config node $rpc_url
  nibid config chain-id nibiru-devnet-3
  nibid config broadcast-mode sync 
  nibid config
  export RPC="$rpc_url"
}

config_nibi() {
  local rpc_url="$RPC_NIBI"
  nibid config node $rpc_url
  nibid config chain-id cataclysm-1
  nibid config broadcast-mode sync 
  nibid config
  export RPC="$rpc_url"
}


# Ex: nibid tx bank send ... -y | tx
tx() {
  # Check if there is input from stdin
  # `cat` will hang if nothing is passed to this fn.
  if [ -t 0 ]; then
    echo "No input provided."
    return 1
  fi

  # Read stdin into a variable.
  local args=$(cat)

  local txhash=$(echo "$args" | jq -rcs '.[0].txhash')
  sleep 3
  local tx_resp=$(nibid q tx "$txhash" | jq '{txhash, height, code, logs, gas_used, gas_wanted, tx}')

  local txoutjson="txout.json"
  if [ ! -f $txoutjson ]; then
    echo "[]" >> $txoutjson
  fi

  # echo "$tx_resp" >> "$txoutjson"
  jq ". += [$tx_resp]" $txoutjson > tmp.json && mv tmp.json $txoutjson
  echo "$tx_resp" | view -
}

do_faucet() {
  FAUCET_URL="https://faucet.devnet-3.nibiru.fi/"
  ADDR="$1"
  curl -X POST -d '{"address": "'"$ADDR"'", "coins": ["10000000000unibi","100000000000unusd", "100000000000uusdt"]}' $FAUCET_URL
}

# Deletion Commands

clean_yarn() {
  rm -rf node_modules yarn.lock
}

del_node_modules() {
  local dir_name="node_modules"
  find -path "*/$dir_name*" -delete
  find -type d -name "$dir_name" -delete
}

del_nvm_other() {
  # To delete all `nvm` versions beside the one you're currently using:
  # Note, $NVM_DIR is usually set to $HOME/.nvim
  cd $NVM_DIR/versions/node; ls -A | grep -v `nvm current` | xargs rm -rf
}
