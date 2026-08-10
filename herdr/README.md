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

The configuration key `keys.detach` uses `prefix+d`, matching tmux. This
reserves `prefix+q` for the future pane picker.

## Pane layouts

The tmux layout bindings are available in Herdr too:

- `prefix =` unzooms the active tab and stacks its panes evenly top-to-bottom.
- `prefix _` unzooms the active tab and spreads its panes evenly left-to-right.

They preserve the existing pane processes and scrollback. The commands are
provided by the standalone Rust crate in this directory. Install it after a
clone or update:

```bash
cd "$DOTFILES/herdr"
just install
```

This installs `~/.local/bin/herdr-tmux`, which the managed configuration calls
directly. For local development, `--socket-path`, `--tab-id`, and `--pane-id`
override Herdr's injected environment.
