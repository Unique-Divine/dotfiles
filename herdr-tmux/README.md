# herdr-tmux

`herdr-tmux` adds tmux-style even pane layouts and numeric pane selection to a
local [Herdr](https://herdr.dev) session. Layout commands rearrange existing
panes, so their processes and scrollback remain live.

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

Run these commands from a Herdr custom key binding or a Herdr-managed pane:

```bash
herdr-tmux layout even-vertical
herdr-tmux layout even-horizontal
herdr-tmux picker
```

`even-vertical` stacks panes top-to-bottom. `even-horizontal` spreads panes
left-to-right. Both commands unzoom the active tab, preserve its focused pane,
and restore the original layout if a recoverable mutation fails.

Command `herdr-tmux picker` lists panes in the active tab from top to bottom,
then left to right. Press one digit without Enter to focus that pane. The
picker supports up to ten panes and cancels on Escape, invalid input, or a
1.5-second timeout. A one-pane tab and selecting the active pane are successful
no-ops. Before changing focus, the picker verifies that the selected pane still
belongs to the originating tab.

For development or tests outside a Herdr-managed pane, pass the command-line
overrides `--socket-path`, `--tab-id`, and `--pane-id`.

## Dotfiles integration

The source repository's [Herdr configuration](https://github.com/Unique-Divine/dotfiles/tree/main/herdr)
binds `prefix =` to `even-vertical`, `prefix _` to `even-horizontal`, and
`prefix q` to the popup pane picker. The picker is a local, early feature and
is not packaged as a Herdr plugin.

## License

BSD-2-Clause. See [LICENSE](LICENSE).
