# Herdr configuration

`config.toml` is the managed Herdr configuration. The dotfiles link script
places it at `~/.config/herdr/config.toml`; Herdr session state and logs remain
outside this directory.

## Apply a configuration change

Validate the managed configuration, then reload the running Herdr server:

```bash
HERDR_CONFIG_PATH="$DOTFILES/herdr/config.toml" herdr config check
herdr server reload-config
```

The configuration key `keys.detach` uses `prefix+d`, matching tmux. Binding
`prefix+q` opens the local numeric pane picker.

## Pane layouts and picker

The tmux layout bindings are available in Herdr too:

- `prefix =` unzooms the active tab and stacks its panes evenly top-to-bottom.
- `prefix _` unzooms the active tab and spreads its panes evenly left-to-right.
- `prefix q` opens a popup that lists the active tab's panes in geometric
  reading order. Press `0`–`9` without Enter to focus a pane.

The layout commands preserve existing pane processes and scrollback. The
picker supports up to ten panes, marks the active pane, cancels after 1.5
seconds or on invalid input, and validates the selected pane before focusing
it. Install the `herdr-tmux` command from its sibling source directory:

```bash
cd "$DOTFILES/herdr-tmux"
just install
```

This installs `~/.local/bin/herdr-tmux`, which the managed configuration calls
directly. For local development, `--socket-path`, `--tab-id`, and `--pane-id`
override Herdr's injected environment.
