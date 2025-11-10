#!/usr/bin/env bash
# shellcheck disable=SC2155

# ℹ️  -------- IMPORTS --------  ℹ️
source "$DOTFILES/zsh/bashlib.sh"

# The $DOTFILES  and $BOKU_PATH variables are exported from .zshenv.

# todos: Opens NeoVim with your notes workspace as the working directory with
# your text-based TODO-list open.
todos() {
  local before="$(pwd)"
  z "$BOKU_PATH"
  nvim "$BOKU_PATH/free/todos.md"
  cd "$before" || return 1
}

# notes: Opens NeoVim with a notes workspace as the working directory.
notes() {
  local before="$(pwd)"
  z "$BOKU_PATH"
  nvim "$BOKU_PATH/free/the-log.md"
  cd "$before" || return 1
}

# music: Opens the Windows file explorer to your music files.
music() {
  local before="$(pwd)"
  cd /mnt/c/Users/realu/Music/携帯に追加した || return 1
  explorer.exe . 
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

# dotf: Edit your dotfiles.
dotf() {
  local before="$(pwd)"
  cd "$DOTFILES" || return 1
  nvim .
  main_bash_setup
  cd "$before" || return 1
}

# cfg_nvim: Edit your nvim config.
cfg_nvim() {
  local before="$(pwd)"
  local cfg="$HOME/.config/nvim"
  cd "$cfg" || return 1
  nvim .
  cd "$before" || return 1
}

# cfg_tmux: Edit your tmux config.
cfg_tmux() {
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
RPC_TESTNET="https://rpc.archive.testnet-2.nibiru.fi:443"  # load balanced between nodes
# RPC_TESTNET="https://rpc.testnet-2.nibiru.fi:443"  # load balanced between nodes
RPC_NIBI="https://rpc.archive.nibiru.fi:443"
# RPC_NIBI="https://rpc.nibiru.fi:443"
RPC_DEVNET="https://rpc.devnet-3.nibiru.fi:443"
# ITN_RPC="https://rpc-1.itn-1.nibiru.fi:443"   # individual node
# https://rpc-nibiru.nodeist.net:443 # an alternative RPC 

# Functions for switching chain configurations on nibiru.

# cfg_nibi_local: Set Nibiru CLI config to local network.
cfg_nibi_local() {
  local rpc_url="$RPC_LOCAL"
  local chain_id="nibiru-localnet-0"
  nibid config node $rpc_url
  nibid config chain-id "$chain_id"
  nibid config broadcast-mode sync 
  nibid config
  export RPC="$rpc_url"
}

# cfg_nibi_test: Set Nibiru CLI config to a test network (testnet).
cfg_nibi_test() {
  local rpc_url="$RPC_TESTNET"
  local chain_id="nibiru-testnet-2"
  nibid config node $rpc_url
  nibid config chain-id "$chain_id"
  nibid config broadcast-mode sync 
  nibid config
  export RPC="$rpc_url"
}

# cfg_nibi_dev: Set Nibiru CLI config to a dev network (devnet).
cfg_nibi_dev() {
  local rpc_url="$RPC_DEVNET"
  nibid config node $rpc_url
  nibid config chain-id nibiru-devnet-3
  nibid config broadcast-mode sync 
  nibid config
  export RPC="$rpc_url"
}

cfg_nibi() {
  echo "Usage: cfg_nibi [--local | --test | --dev | --prod]"
  echo "Sets the Nibiru CLI config to one of the Nibiru blockchain networks."
  case "$1" in
    --local)
      cfg_nibi_local
      ;;
    --test)
      cfg_nibi_test
      ;;
    --dev)
      cfg_nibi_dev
      ;;
    --prod|--mainnet|"")
      # Default to mainnet if no args or --prod
      local rpc_url="$RPC_NIBI"
      nibid config node "$rpc_url"
      nibid config chain-id cataclysm-1
      nibid config broadcast-mode sync
      nibid config
      export RPC="$rpc_url"
      ;;
    --help|-h)
      echo "Usage: cfg_nibi [--local | --test | --dev | --prod]"
      ;;
    *)
      echo "❌ Unknown flag: $1"
      echo "Usage: cfg_nibi [--local | --test | --dev | --prod]"
      return 1
      ;;
  esac
}

# # cfg_nibi: Set Nibiru CLI config to mainnet (cataclysm-1). 
# cfg_nibi() {
#   local rpc_url="$RPC_NIBI"
#   nibid config node $rpc_url
#   nibid config chain-id cataclysm-1
#   nibid config broadcast-mode sync 
#   nibid config
#   export RPC="$rpc_url"
# }


# Ex: nibid tx bank send ... -y | tx
# unalias tx
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

# Nibiru Flex Multsig
# Ex: msig_vote yes 83
# Ex: msig_vote no 84
msig_vote() {
  local vote="$1"
  local proposal_id="$2"

  log_info "Execute flex multisig vote."
  log_info "\$vote: $vote"
  log_info "\$proposal_id: $proposal_id"
  log_info "\$MULTISIG: $MULTISIG"
  log_info "\$FROM: $FROM"
  env_vars_ok vote proposal_id MULTISIG FROM

  # Vote on CW3
  cat << EOF | jq | tee vote.json
{
  "vote": {
    "proposal_id": $proposal_id,
    "vote": "$vote"
  }
}
EOF

  nibid tx wasm execute "$MULTISIG" "$(cat vote.json)" \
  --from "$FROM" \
  --gas auto \
  --gas-adjustment 1.5 \
  --gas-prices 0.025unibi \
  --yes | tx
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

del_zone() {
  find -type f -name '*Zone*' -delete
}


