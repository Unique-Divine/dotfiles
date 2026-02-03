#!/usr/bin/env bash
# shellcheck disable=SC2155

# ℹ️  -------- IMPORTS --------  ℹ️
source "$DOTFILES/zsh/bashlib.sh"

# The $DOTFILES  and $BOKU_PATH variables are exported from .zshenv.

# ----------------- Git -----------------
# Some of my most-used commands. I rely on these daily to quickly finish
# branches, prepare pull requests, and cleanly sync changes with the remote.

# git_cof: Git "[c]heck [o]ut [f]rom": Check out the target, fetch, prune remote,
# and delete the starting branch.
git_cof() {
  echo "Usage: git_cof <target_branch>"
  if [[ "$#" -ne 1 ]]; then
    echo "  ERROR The git_cof function accepts exactly 1 arg, not $#"
    echo "  Checks out <target_branch>, fetches/prunes, deletes the starting branch,"
    echo "  then pulls the latest changes for <target_branch>."
    return 1
  fi

  _run() {
    echo "RUN $*"
    "$@"
  }
  
  local target_branch="$1"
  local start_branch="$(git br --show-current)"
  _run git fetch --all --prune || true
  _run git checkout "$target_branch"
  _run git branch -D "$start_branch"
  _run git pull || true
}

# git_mf: Git "[m]erge [f]rom". Fetch, prune, check out the target and merge it
# into the starting branch.
git_mf() {
  echo "Usage: git_mf <target_branch>"
  if [[ "$#" -ne 1 && "$#" -ne 0 ]]; then
    echo "  ERROR The git_mf function accepts 1 arg or 0, not $#"
    echo "  If the <target_branch> is empty, git_mf -> git fetch, git pull"
    return 1
  fi

  local target_branch="$1"
  echo "RUN git fetch --all --prune"
  git fetch --all --prune || true
  if [[ -z "$target_branch" ]]; then
    echo "No target branch given."
    echo "RUN git pull"
    git pull || true
    return 0
  fi

  local start_branch="$(git br --show-current)"
  git checkout "$target_branch"
  git pull || true
  git checkout "$start_branch"
  git merge "$target_branch"
}

# ----------------- Daily Shortcuts -----------------

# todos: Opens NeoVim with your notes workspace as the working directory with
# your text-based TODO-list open.
todos() {
  local before="$(pwd)"
  cd "$BOKU_PATH" || return 1
  nvim "$BOKU_PATH/free/todos.md"
  cd "$before" || return 1
}

# notes: Opens NeoVim with a notes workspace as the working directory.
notes() {
  local before="$(pwd)"
  cd "$BOKU_PATH" || return 1
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

# skills: Opens AI agent skills directory.
skills() {
  local before="$(pwd)"
  cd "$HOME/.cursor/skills" || return 1
  nvim "$HOME/.cursor/skills"
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

sharex() {
  bash $BOKU_PATH/sharex.sh
}

# ----------------- Nibiru -----------------

# Reminders for config_* functions
# - Update any relevant .env files in py-sdk, ts-sdk, etc.

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

# ----------------- Deletion Commands

del_node_modules() {
  local dir_name="node_modules"
  find . -path "*/$dir_name*" -delete
  find . -type d -name "$dir_name" -delete
}

del_yarn() {
  rm -f yarn.lock
  del_node_modules
}

del_nvm_other() {
  # To delete all `nvm` versions beside the one you're currently using:
  # Note, $NVM_DIR is usually set to $HOME/.nvim
  cd $NVM_DIR/versions/node; ls -A | grep -v `nvm current` | xargs rm -rf
}

# Windows sometimes adds
del_zone() {
  find "." -type f -name '*Zone*' -delete
}
