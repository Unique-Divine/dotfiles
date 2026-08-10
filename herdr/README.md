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
