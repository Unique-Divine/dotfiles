# Herdr configuration

`config.toml` is the managed Herdr configuration. The dotfiles link script
places it at `~/.config/herdr/config.toml`; Herdr session state and logs remain
outside this directory.

## Codex history and restore

The TypeScript defaults in `../codex/config.ts` set
`tui.alternate_screen = "never"`. Codex renders on the normal terminal screen,
so `Ctrl-b [` can scroll earlier output. Apply those defaults with
`just codex --run` from the dotfiles root. Existing Codex processes need to be
reopened for the display setting to apply.

Herdr saves recent terminal output with `experimental.pane_history = true`
and reopens recorded conversations with `session.resume_agents_on_restore = true`.
Saved screen history and conversation resume are separate features.

Codex 0.160.1 can reuse a shared daemon that retains the environment of its
first Herdr pane. Session hooks can then target the wrong pane or an old socket.
The Zsh wrapper and custom Herdr start/restore commands pass `--no-daemon`
inside Herdr. Explicit remote connections and the `codex agents` overview keep
their required daemon behavior. A new chat gets its session ID when the first
prompt starts; an untouched welcome screen has no conversation to restore.

Build and install the vendored v0.9.3 fork with `just herdr-install` from the
dotfiles root. It requires Zig 0.16.0, available through `brew install zig@0.16`
or the `ZIG` environment variable. Avoid `herdr update`, which replaces the
custom binary with an upstream release.

## Replace a running 0.8.0 server

Installing the binary does not replace an already running server. The
0.8.0 client uses protocol 20; v0.9.3 uses protocol 22. A live handoff keeps
pane processes and conversations running, but disconnects the old TUI.
Run this from a separate terminal, then reopen Herdr with `herdr`:

```bash
~/.local/bin/herdr server live-handoff \
  --import-exe "$HOME/.local/bin/herdr" \
  --expected-protocol 22 --expected-version 0.9.3
```

Existing Codex processes retain their original daemon and display settings.
After their work finishes, exit each Codex process and resume its conversation
with `codex resume <conversation-id>`. Fresh Zsh shells already load the
wrapper; use `source "$DOTFILES/zsh/aliases.sh"` in an older shell first.
Earlier output from an alternate screen cannot be recovered as host scrollback.

## Apply a configuration change

Validate the managed configuration, then reload the running Herdr server:

```bash
HERDR_CONFIG_PATH="$DOTFILES/herdr-cfg/config.toml" herdr config check
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
