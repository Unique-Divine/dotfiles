# herdr-tmux

`herdr-tmux` adds tmux-style even pane layouts and numbered pane and agent pickers to a
local [Herdr](https://herdr.dev) session. Layout commands rearrange existing
panes, so their processes and scrollback remain live.

This is an early personal tool. The command-line interface may change as its
use cases become clearer.

## Requirements

- A Unix environment with a running Herdr session.
- Herdr 0.9.5 or later for plugin installation.
- Linux or macOS. The binary uses Unix sockets; native Windows is unsupported.
- Cargo and a Rust toolchain to build the plugin or install the crate.

## Install

### Herdr plugin

Once version 0.1.0 is released and merged into the repository's default branch:

```bash
herdr plugin install Unique-Divine/dotfiles/herdr-tmux
```

Herdr builds the plugin with locked dependencies and registers its actions.
For a pinned release, add `--ref herdr-tmux/v0.1.0`. Installation does not add
key bindings; copy the bindings below into your Herdr configuration.

### Cargo binary

Once version 0.1.0 is published:

```bash
cargo install herdr-tmux --version 0.1.0 --locked
herdr-tmux plugin register
```

The second command links a manifest pointing to the installed binary. It stores
that manifest under `$XDG_DATA_HOME/herdr-tmux/plugin`, defaulting to
`~/.local/share/herdr-tmux/plugin`. It refuses to replace a GitHub installation
or a link to a different directory. Choose one registration route per user.
Repeating registration refreshes the generated manifest after a binary update.
The binary remains usable directly without registering it as a plugin.

### Local development

```bash
just plugin-link
```

This builds the release binary and links the source directory. Run the recipe
from `herdr-tmux`. Herdr's `plugin link` command does not build source itself.
Rebuild after editing Rust code; relink after editing the manifest.
To switch installation routes, explicitly unlink the local registration or
uninstall the GitHub registration first:

```bash
herdr plugin unlink unique-divine.herdr-tmux
```

## Usage

Run these commands from a Herdr custom key binding or a Herdr-managed pane:

```bash
herdr-tmux layout even-vertical
herdr-tmux layout even-horizontal
herdr-tmux focus-pane
herdr-tmux focus-agent
```

`even-vertical` stacks panes top-to-bottom. `even-horizontal` spreads panes
left-to-right. Both commands unzoom the active tab, preserve its focused pane,
and restore the original layout if a recoverable mutation fails.

Command `herdr-tmux focus-pane` lists panes in the active tab from top to bottom,
then left to right. Press one digit without Enter to focus that pane. The
command supports up to ten panes and cancels on Escape, invalid input, or a
five-second timeout. A one-pane tab and selecting the active pane are successful
no-ops. Before changing focus, the command verifies that the selected pane still
belongs to the originating tab.

Command `herdr-tmux focus-agent` lists every live agent in the session.
The columns are Agent, Harness, Status, Tab, and Title. Agent shows the jump
number and an asterisk for the focused agent; Harness shows its detected kind.
Titles fit the popup width and end with an ellipsis when truncated.
The tab position follows `keys.switch_tab`: `0..8`
renders `t0` through `t8`, while `1..9` renders `t1` through `t9`. Press
`0`–`9` without Enter to focus an agent, even when it is in another workspace
or tab. It shares the pane focus command's cancellation and timeout behavior,
and confirms the selected agent still occupies its pane before focus.

The Tab column shows `t0` when all listed agents share a workspace and `t0_w6`
when agents span multiple workspaces. Status icons and colors are:

| Status | Icon | Foreground | Jump number |
| --- | --- | --- | --- |
| Working | ↻ | Default terminal color | Normal |
| Idle | . | Cyan | Bold |
| Done | ✓ | Cyan | Bold |
| Blocked | ! | Amber | Bold |
| Unknown | ? | Cyan | Bold |

Headings and status text are bold. Jump numbers match their status foreground.
Redirected output has no ANSI styling. The picker uses simple
Unicode symbols without requiring an icon font.

For development or tests outside a Herdr-managed pane, pass the command-line
overrides `--socket-path`, `--tab-id`, and `--pane-id`.

## Plugin bindings

Add these commands to Herdr's `config.toml`, then reload the configuration:

```toml
[[keys.command]]
key = "prefix+="
type = "plugin_action"
command = "unique-divine.herdr-tmux.even-vertical"
description = "even vertical pane layout"

[[keys.command]]
key = "prefix+_"
type = "plugin_action"
command = "unique-divine.herdr-tmux.even-horizontal"
description = "even horizontal pane layout"

[[keys.command]]
key = "prefix+q"
type = "plugin_action"
command = "unique-divine.herdr-tmux.focus-pane"
description = "select pane by number"

[[keys.command]]
key = "prefix+a"
type = "plugin_action"
command = "unique-divine.herdr-tmux.focus-agent"
description = "select agent by number"
```

Plugin actions open pickers over the active pane. Plugin context identifies the
underlying tab and pane even though the popup has no pane ID. Explicit CLI
targets take precedence over plugin context, which takes precedence over shell
identity variables. Existing direct shell and popup bindings remain supported.
No startup hooks or background services run.

## Development and releases

Run `just test`, `just lint`, and `just build`. Run `just release-check` before
publishing; it verifies the independently packaged crate and performs Cargo's
publish dry run. The recipe expects committed changes.

See [RELEASING.md](RELEASING.md) for release commands and live smoke checks.

## License

BSD-2-Clause. See [LICENSE](LICENSE).
