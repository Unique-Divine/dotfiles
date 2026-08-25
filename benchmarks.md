# Dotfiles benchmark log

This is a reverse-chronological record of measured performance changes in this
repository. Each entry keeps the benchmark method next to the result. Runs
with different payloads, sample counts, or readiness definitions are not
combined into one percentage.

## 2026-08-25: Defer Zsh completion setup

The completion pass moved Ubuntu's global `compinit`, FZF, gcloud, Go, Bun,
and `exa` registration behind the first prompt. The Zsh benchmark used 20
measured runs and five warmups per mode.

| Mode | Mean | Median | P95 |
| --- | ---: | ---: | ---: |
| Synchronous startup | 493.65 ms | 474.46 ms | 639.55 ms |
| Prompt ready | 841.24 ms | 756.90 ms | 1138.75 ms |

The previous Goenv-lazy checkpoint measured 481.34 ms synchronous startup and
1012.85 ms prompt readiness. The new run is 2.6% slower synchronously and
16.9% faster to prompt readiness. The prompt result is useful directionally,
but host scheduling can move these numbers between runs.

Method: `just bench-zsh --mode init --runs 20 --warmups 5` and the same command
with `--mode prompt`. See the [Zsh benchmark notes](zsh/README.md) and the
[migration journal](scope.md).

## 2026-08-24: Defer Goenv initialization with Zinit Turbo

This checkpoint kept Goenv's `bin` and shim paths synchronous while moving
`goenv init -` behind Zinit Turbo and a first-use trigger. The benchmark used
20 measured runs and five warmups.

| Mode | Before | After | Change |
| --- | ---: | ---: | ---: |
| Synchronous startup | 2178.50 ms | 481.34 ms | 77.9% faster |
| Prompt ready | 2696.66 ms | 1012.85 ms | 62.4% faster |

Method: `just bench-zsh --mode init` and `--mode prompt`. The prompt benchmark
stops when ZLE accepts input, so it does not claim that every deferred plugin
has finished loading.

Source: [PR #31](https://github.com/Unique-Divine/dotfiles/pull/31), with the
full local sequence in [scope.md](scope.md).

## 2026-08-23: Early Zsh migration checkpoints

These first-cut measurements used five measured runs and two warmups. They
show the direction of the migration, but they are smaller samples than the
later 20-run snapshots.

| Change | Synchronous startup | Prompt ready |
| --- | ---: | ---: |
| Initial baseline | 1845 ms | 2594 ms |
| Load P10k once through Zinit | 1579 ms | 2403 ms |
| Replace Oh My Zsh with explicit plugins | 1442 ms | 1896 ms |
| Turbo-load safe plugins | 1411 ms | 1896 ms |

Later 20-run snapshots varied with host activity. One post-migration run
measured 1946.13 ms synchronous startup and 3019.60 ms prompt readiness. A
later rerun measured 2178.50 ms and 2696.66 ms respectively. Those runs are
kept as separate checkpoints rather than treated as a clean monotonic series.

Source: [scope.md](scope.md) and
[PR #30](https://github.com/Unique-Divine/dotfiles/pull/30).

## 2026-08-16: Defer Neovim startup work

Issue #27 began with an `nvim --startuptime` result of about 485 ms. A later
run reached about 233 ms after DAP setup, eager module loading, and duplicate
theme work were moved behind more specific Lazy triggers.

The recorded diagnosis included roughly 230 ms from DAP and
`mason-nvim-dap`, about 177 ms for adapter configuration loading, and about
30 ms from applying the OneDark theme twice. The follow-up log identified the
last Embedded run as 233.959 ms.

Method: `nvim --startuptime startup.log`, inspecting the final Embedded run
instead of concatenated earlier traces.

Source: [issue #27](https://github.com/Unique-Divine/dotfiles/issues/27) and
[PR #28](https://github.com/Unique-Divine/dotfiles/pull/28).

## 2026-08-15: Persistent clipboard bridge checkpoint

The persistent WSL clipboard bridge was compared with the retained one-shot
wrappers using a 64-byte payload, two measured runs, and one warmup.

| Operation | Legacy median | Persistent median |
| --- | ---: | ---: |
| Copy | 49.6 ms | 28.6 ms |
| Paste | 233.9 ms | 37.6 ms |
| Copy plus paste | 302.2 ms | 61.1 ms |

That smoke run reported approximately 1.7x faster copy, 6.2x faster paste,
and 4.9x faster round trips. The in-process protocol measured 0.76 ms versus
261.1 ms for a one-shot no-profile PowerShell read, a 342.8x component-level
difference. The normal CLI path includes Linux process and socket overhead.

The pull request summary reported another short-run comparison of 10.7x for
copy, 31.0x for paste, and 21.4x for round trips. Those figures are retained
as a separate report because the run details differ.

An earlier bridge pull request measured the `pbpaste` symlink at 11.0 ms
median versus 10.6 ms for direct binary invocation, within subprocess timing
noise.

Source: [issue #21](https://github.com/Unique-Divine/dotfiles/issues/21) and
[PR #26](https://github.com/Unique-Divine/dotfiles/pull/26), plus
[PR #25](https://github.com/Unique-Divine/dotfiles/pull/25).

## 2026-08-10: Clipboard baseline

The original WSL2 clipboard benchmark used a 128-byte payload, ten measured
runs, and two warmups.

| Operation | Median |
| --- | ---: |
| Process baseline | 0.8 ms |
| `clip.exe` direct | 60.2 ms |
| `pbcopy` wrapper | 63.5 ms |
| PowerShell direct | 302.3 ms |
| `pbpaste` wrapper | 302.3 ms |
| `pbcopy` plus `pbpaste` | 352.5 ms |

The benchmark found that PowerShell process startup dominated paste latency.
Its persistent-process experiment later measured a 0.37 ms median for the
request/response protocol after warmup, compared with 306.6 ms for a no-profile
one-shot process. The persistent process took 293.2 ms to initialize, and its
first clipboard request took 57.3 ms.

Source: [issue #21](https://github.com/Unique-Divine/dotfiles/issues/21).
