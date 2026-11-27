#!/usr/bin/env zsh
#
# Load SSH keys into the shared systemd ssh-agent (systemd/ssh-agent.service;
# zshenv points SSH_AUTH_SOCK at its socket). Sourced by zshrc.zsh.

# Private keys to load, by file name under ~/.ssh. Each machine has only some
# of them; missing files are skipped. id_ed25519 is the Googlebox GitHub key.
ssh_identity_names=(
  personal_sb3_wsl_key
  peggyWSL
  personalSB3Key
  dieselSB3WSL_key
  id_ed25519
)

# Print the readable key files from ssh_identity_names, one per line.
ssh_identity_files() {
  local name
  for name in "${ssh_identity_names[@]}"; do
    [[ -r "$HOME/.ssh/$name" ]] && print -r -- "$HOME/.ssh/$name"
  done
  return 0
}

# Add every existing key to the agent. Each key with a passphrase prompts once.
# Returns 1 if any key failed to load, after trying the rest.
ssh_setup() {
  if [[ ! -S "${SSH_AUTH_SOCK:-}" ]]; then
    print -u2 "SSH agent is unavailable; run: systemctl --user start ssh-agent"
    return 1
  fi

  local identity_file rc=0
  for identity_file in "${(@f)$(ssh_identity_files)}"; do
    [[ -n "$identity_file" ]] || continue
    ssh-add "$identity_file" || rc=1
  done
  return $rc
}

# Run ssh_setup once when a new terminal finds the agent empty, as after a
# reboot. Skips agent and script shells (no terminal), an agent that already
# holds keys, and machines with none of the keys. A lock keeps the panes that
# Herdr or tmux restore at the same moment from all prompting at once: the
# first shell prompts and the rest skip.
ssh_auto_setup() {
  [[ -o interactive && -t 0 && -t 2 ]] || return 0
  [[ -S "${SSH_AUTH_SOCK:-}" ]] || return 0
  # ssh-add -l exits 1 for an empty agent; 0 means keys are loaded and 2
  # means no agent answered.
  ssh-add -l >/dev/null 2>&1
  (( $? == 1 )) || return 0
  [[ -n "$(ssh_identity_files)" ]] || return 0

  zmodload -F zsh/system b:zsystem 2>/dev/null || return 0
  local lock_file="${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}/ssh-setup.lock"
  local lock_fd
  # zsystem flock opens the file but does not create it.
  [[ -e "$lock_file" ]] || : >| "$lock_file" 2>/dev/null || return 0
  # The kernel releases the lock when this shell's descriptor closes, even if
  # the shell is killed at the passphrase prompt.
  zsystem flock -t 0 -f lock_fd "$lock_file" 2>/dev/null || return 0
  ssh_setup
  local rc=$?
  zsystem flock -u $lock_fd
  return $rc
}
