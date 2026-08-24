#!/usr/bin/env zsh

# Reuse `ls` shell completions for `exa`, as this removes the need to define a
# separate completion function for `exa`.
compdef exa=ls
