#!/usr/bin/env zsh

# Start Docker Desktop on the first Docker command, then wait until the daemon
# can answer. Zinit's trigger wrapper replays that original command afterward.
if command docker info >/dev/null 2>&1; then
  return 0
fi

if ! command -v ud >/dev/null 2>&1; then
  print -u2 "Docker is unavailable because the 'ud' command was not found."
  return 1
fi

if ! command ud docker start; then
  print -u2 "Docker Desktop could not be started."
  return 1
fi

integer attempts=0
while (( attempts < 120 )); do
  if command docker info >/dev/null 2>&1; then
    return 0
  fi
  sleep 0.25
  (( attempts += 1 ))
done

print -u2 "Docker did not become ready within 30 seconds."
return 1
