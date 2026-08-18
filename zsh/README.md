# Zsh configuration

## Background work

Use `&` only when a task can run independently of the shell configuration. It
starts a background job, but that job remains associated with the shell and may
receive `SIGHUP` when the shell exits if the `HUP` option is set.

Use `&!` when a process must continue after shell exit. It starts the process
in the background and disowns it, removing it from Zsh's job table. `nohup` and
`disown` are alternatives for intentionally detached work.

Do not background `source` operations that are expected to configure the active
shell. A child process cannot change the parent shell's variables, functions,
aliases, completion state, or `PATH`.

See the official Zsh references:

- [Jobs and signals](https://zsh.sourceforge.io/Doc/Release/Jobs-_0026-Signals.html)
- [Job-control options, including `HUP`](https://zsh.sourceforge.io/Doc/Release/Options.html)
- [`disown` builtin](https://zsh.sourceforge.io/Doc/Release/Shell-Builtin-Commands.html)
