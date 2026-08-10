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
`prefix+q` runs `herdr-tmux focus-pane`, and `prefix+a` runs
`herdr-tmux focus-agent`.

## Pane layouts and focus commands

The tmux layout bindings are available in Herdr too:

- `prefix =` unzooms the active tab and stacks its panes evenly top-to-bottom.
- `prefix _` unzooms the active tab and spreads its panes evenly left-to-right.
- `prefix q` opens a popup that lists the active tab's panes in geometric
  reading order. Press `0`–`9` without Enter to focus a pane.
- `prefix a` opens a popup that lists all live agents across the session.
  Each row shows the agent kind and state, workspace and tab IDs, and terminal
  title. Press `0`–`9` without Enter to focus an agent.

The layout commands preserve existing pane processes and scrollback. The pane
focus command supports up to ten panes, marks the active pane, cancels after 1.5
seconds or on invalid input, and validates the selected pane before focusing
it. The agent focus command supports the same number of rows and cancellation
behavior, and validates the selected agent before focusing it. Install the
`herdr-tmux` command from its sibling source directory:

```bash
cd "$DOTFILES/herdr-tmux"
just install
```

This installs `~/.local/bin/herdr-tmux`, which the managed configuration calls
directly. For local development, `--socket-path`, `--tab-id`, and `--pane-id`
override Herdr's injected environment.
