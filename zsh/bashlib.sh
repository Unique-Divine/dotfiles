#!/usr/bin/env bash

# main_bash_setup (Function): Sets the expected bash aliases and global 
#   functions for the entire configuration. This function is called during 
#   main shell setup.
#
# shellcheck disable=SC1090
main_bash_setup() {
  # Check if DOTFILES variable is set and not empty
  if [ -z "$DOTFILES" ]; then
    echo "Error: \$DOTFILES variable is not set!" >&2
    return 1
  fi

  source "$DOTFILES/zsh/bashlib.sh"
  source "$DOTFILES/zsh/aliases.sh"
  source "$DOTFILES/zsh/quick.sh"
  # For a full list of active aliases, run `alias`.
  nvm use lts/hydrogen >/dev/null 2>&1 || true
}


# ghpeggy: Convenience function to add ssh private key to the ssh agent.
ghpeggy() {
  eval "$(ssh-agent -s)"
  ssh-add ~/.ssh/peggyWSL
}

# ghdiesel: Convenience function to add ssh private key to the ssh agent.
ghdiesel() {
  eval "$(ssh-agent -s)"
  ssh-add ~/.ssh/dieselSB3WSL_key  # vimdiesel@matrixsystems.co
}

# assert attempts to run an arbitrary command and errors out of the script
# otherwise.
assert() {
  # Check if no arguments are passed
  if [ $# -eq 0 ]; then
    printf "assert (bash function): Executes a command and exits with an error message if it fails.\n\n"
    echo "Usage:"
    echo "    assert [cmd]"
    return
  fi

  local arg_cmd="$*"
  if ! eval "$arg_cmd"; then
    echo "Failed to execute command: $arg_cmd"
    return 1
  fi

  # local arg_cmd="$@"
  # if ! eval $arg_cmd; then
  #   echo "Failed to execute command: $arg_cmd"
  #   return 1
  # fi
}

# —————————————————————————————————————————————————
# COLORS: Terminal colors are set with ANSI escape codes.

export COLOR_GREEN="\033[32m"
export COLOR_CYAN="\033[36m"
export COLOR_RESET="\033[0m"

export COLOR_BLACK="\033[30m"
export COLOR_RED="\033[31m"
export COLOR_YELLOW="\033[33m"
export COLOR_BLUE="\033[34m"
export COLOR_MAGENTA="\033[35m"
export COLOR_WHITE="\033[37m"

# Bright color definitions
export COLOR_BRIGHT_BLACK="\033[90m"
export COLOR_BRIGHT_RED="\033[91m"
export COLOR_BRIGHT_GREEN="\033[92m"
export COLOR_BRIGHT_YELLOW="\033[93m"
export COLOR_BRIGHT_BLUE="\033[94m"
export COLOR_BRIGHT_MAGENTA="\033[95m"
export COLOR_BRIGHT_CYAN="\033[96m"
export COLOR_BRIGHT_WHITE="\033[97m"

# —————————————————————————————————————————————————
# LOGGING

# log_debug: Simple wrapper for `echo` with a DEBUG prefix.
log_debug() {
  echo "${COLOR_CYAN}DEBUG${COLOR_RESET}" "$@"
}

# log_error: ERROR messages in red, output to stderr.
log_error() {
  echo "❌ ${COLOR_RED}ERROR:${COLOR_RESET}" "$@" >&2
}

log_success() {
  echo "${COLOR_GREEN}✅ Success:${COLOR_RESET}" "$@"
}

# log_warning: WARNING messages represent non-critical issues that might not
# require immediate action but should be noted as points of concern or failure.
log_warning() {
  echo "${COLOR_YELLOW}INFO${COLOR_RESET}" "$@" >&2
}

log_info() {
  echo "${COLOR_MAGENTA}INFO${COLOR_RESET}" "$@"
}

# —————————————————————————————————————————————————
# OK Suffix: Functions used for error handling or validating inputs.

# which_ok: Check if the given binary is in the $PATH.
# Returns code 0 on success and code 1 if the command fails.
which_ok() {
  if which "$1" >/dev/null 2>&1; then
    return 0
  else
    log_error "$1 is not present in \$PATH"
    return 1
  fi
}

# source_ok (Function): Sources a bash script if it exists.
# Usage:  source_ok [bash_script]
source_ok() {
  local bash_script="$1"
  if test -r "$bash_script"; then 
    # shellcheck disable=SC1090
    source "$bash_script"
  fi
}

env_var_ok() {
  local env_var="$1"
  if [[ -z "$env_var" ]]; then 
    log_error "expected env var to be set"
    return 1  # Return 1 to indicate error (variable is not set)
  else
    return 0  # Return 0 to indicate success (variable is set)
  fi
}
