# herdr-tmux

`herdr-tmux` adds tmux-style even pane layouts to a local
[Herdr](https://herdr.dev) session. It rearranges the existing panes, so their
processes and scrollback remain live.

This is an early personal tool. The command-line interface may change as its
use cases become clearer.

## Requirements

- A Unix environment with a running Herdr session.
- Herdr 0.8.0 or later, which provides the local socket API used by this tool.

## Install

```bash
cargo install herdr-tmux
```

## Usage

Run either command from a Herdr custom key binding or a Herdr-managed pane:

```bash
herdr-tmux layout even-vertical
herdr-tmux layout even-horizontal
```

`even-vertical` stacks panes top-to-bottom. `even-horizontal` spreads panes
left-to-right. Both commands unzoom the active tab, preserve its focused pane,
and restore the original layout if a recoverable mutation fails.

For development or tests outside a Herdr-managed pane, pass the command-line
overrides `--socket-path`, `--tab-id`, and `--pane-id`.

## Dotfiles integration

The source repository's [Herdr configuration](https://github.com/Unique-Divine/dotfiles/tree/main/herdr)
binds `prefix =` to `even-vertical` and `prefix _` to `even-horizontal`.

## License

BSD-2-Clause. See [LICENSE](LICENSE).
