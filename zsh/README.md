# Zsh configuration

The cross-dotfiles performance timeline is in the root
[benchmark log](../benchmarks.md). This file keeps the Zsh-specific startup
behavior and measurement details.

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

## Deferred completion benchmarks

Recorded on 2026-08-25 with 20 measured runs and five warmups per mode. This
isolates the change that moved global `compinit`, FZF, gcloud, Go, and Bun
completion setup behind the first prompt.

| Change | Synchronous startup | Prompt ready |
| --- | ---: | ---: |
| Before deferred completion setup | 481.34 ms | 1012.85 ms |
| After deferred completion setup | 493.65 ms | 841.24 ms |
| Observed change | 2.6% slower | 16.9% faster |

The synchronous result is within normal host variance and is not a new speed
claim. The important behavior change is that the expensive completion work no
longer blocks the first prompt. A first-Tab fallback loads the same module
synchronously if Zinit Turbo has not run yet.

Ubuntu's global `compinit` is disabled with `skip_global_compinit=1`, so
`zsh/completions.zsh` is the sole owner of `compinit`, Zinit completion replay,
completion styles, and custom registrations. If Ubuntu's Docker Desktop
completion link is dangling, the module uses a user-owned cache overlay for
the other vendor completions instead of changing `/usr/share` or printing an
error.

Docker itself is not started while completion setup loads. The Zinit
`trigger-load'!docker'` wrapper runs `ud docker start` only when the first
Docker command is entered, waits up to 30 seconds for `docker info`, and then
replays that original command.

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
