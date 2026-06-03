# Use this justfile by
# (1) installing with "cargo install just"
# (2) running the "just" command.

# Displays available recipes by running `just -l`.
setup:
  #!/usr/bin/env bash
  just -l

test:
  bun test

alias t := test

# Synchronize runtime skills (~/.cursor/skills) with public and private backups
skills-sync *ARGS:
  bun run skillsSync.ts {{ARGS}}
