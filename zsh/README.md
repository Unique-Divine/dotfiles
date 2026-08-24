# Zsh configuration

## Zsh startup benchmarks

Recorded on 2026-08-24 on this WSL machine with 20 measured runs and five
warmups per mode.

| Change | Synchronous startup | Prompt ready |
| --- | ---: | ---: |
| Before deferred Goenv initialization | 2178.50 ms | 2696.66 ms |
| After deferred Goenv initialization | 481.34 ms | 1012.85 ms |
| Improvement | 77.9% | 62.4% |

Run the same measurements with:

```sh
just bench-zsh --mode init --runs 20 --warmups 5
just bench-zsh --mode prompt --runs 20 --warmups 5
```

Zinit keeps prompt-critical setup synchronous, including Powerlevel10k, Git
aliases, `z`, and the Goenv shim path. Its Turbo queue moves the full Goenv
shell initialization off the prompt path. The `goenv` trigger loads that setup
and replays the command if Goenv is used before Turbo has run.

These are local measurements, not a portable speed claim. Other machines and
startup state will produce different numbers.

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
