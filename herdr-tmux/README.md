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

## Install

### Prebuilt Release

Pick the target for your operating system and CPU. The Linux binaries also
work in WSL.

| Platform | Target |
| --- | --- |
| Linux x86-64 | `x86_64-unknown-linux-musl` |
| Linux ARM64 | `aarch64-unknown-linux-musl` |
| macOS Intel | `x86_64-apple-darwin` |
| macOS Apple Silicon | `aarch64-apple-darwin` |

From an empty directory, download the archive and verify its SHA-256 checksum.
Set the `target` variable to the value for your platform.

```bash
version=0.2.0
target=x86_64-unknown-linux-musl
archive="herdr-tmux-v$version-$target.tar.gz"
base="https://github.com/Unique-Divine/dotfiles/releases/download/herdr-tmux/v$version"
curl -fSLO "$base/$archive"
curl -fSLO "$base/SHA256SUMS"
awk -v name="$archive" '$2 == name { print }' SHA256SUMS |
  shasum -a 256 -c -
```

To verify that the release workflow built the archive from the release tag,
use the GitHub CLI before extracting it.

```bash
gh attestation verify "$archive" --repo Unique-Divine/dotfiles \
  --source-ref "refs/tags/herdr-tmux/v$version" \
  --signer-workflow Unique-Divine/dotfiles/.github/workflows/herdr-tmux-release.yml
```

Extract and install the executable after verification succeeds.

```bash
tar -xzf "$archive"
mkdir -p "$HOME/.local/bin"
install -m 755 herdr-tmux "$HOME/.local/bin/herdr-tmux"
"$HOME/.local/bin/herdr-tmux" --version
"$HOME/.local/bin/herdr-tmux" plugin register
```

The archive and registration command require no Rust toolchain. Add
`~/.local/bin` to `PATH` to invoke the CLI by name. Copy the plugin bindings
below into your Herdr configuration to use the keyboard shortcuts.

### Build from GitHub

With Rust and Cargo installed, Herdr can build and register the source plugin
at a pinned release tag.

```bash
herdr plugin install Unique-Divine/dotfiles/herdr-tmux --ref herdr-tmux/v0.2.0
```

### Build from crates.io

When the version is available on crates.io, use Cargo to build the executable.

```bash
cargo install herdr-tmux --version 0.2.0 --locked
herdr-tmux plugin register
```

### Switch or Refresh Registration

Command `herdr-tmux plugin register` writes a manifest pointing to the
installed executable under `$XDG_DATA_HOME/herdr-tmux/plugin`, which defaults
to `~/.local/share/herdr-tmux/plugin`. Run the command again after updating a
prebuilt or Cargo-installed binary. Direct CLI commands also work without
registration.

Use `herdr plugin list --json` to inspect the registration before changing
routes. Remove the GitHub-source installation with
`herdr plugin uninstall unique-divine.herdr-tmux`, or remove a local
registration with `herdr plugin unlink unique-divine.herdr-tmux`.

### Local Development

```bash
just plugin-link
```

This builds the release binary and links the source directory. Run the recipe
from `herdr-tmux`. Herdr's `plugin link` command does not build source itself.
After editing Rust code, run `just build`. After editing the manifest, run
`just plugin-link` again.

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
then left to right, including shell terminals. Its table shows a quick-jump
badge, focused-pane marker, harness, status, pane ID, and title. Pane IDs are
location labels; digits `0` through `9` select the first ten matching rows.
Use `j`/`k` or arrows and Enter to reach every pane, with no pane count limit.
Press `/` to search the displayed fields. Digits are text in search mode;
Enter or Escape returns to navigation, and Escape in navigation closes.
The picker stays open until selection or cancellation and refreshes metadata
once per second. A one-pane tab and selecting the active pane are successful
no-ops. Before changing focus, it validates the selected pane's tab and
terminal identity.

Command `herdr-tmux focus-agent` lists every live agent in the session.
The columns are Agent, Harness, Status, Tab, and Title. Agent shows the jump
number and an asterisk for the focused agent; Harness shows its detected kind.
Titles fit the popup width and end with an ellipsis when truncated.
The tab position follows `keys.switch_tab`. Range `0..8` renders `t0` through
`t8`, while `1..9` renders `t1` through `t9`. The first ten idle, done, or
blocked agents in list order get jump numbers `0` through `9`. Press a
number to focus that agent, including across workspaces or tabs. Use `j`/`k`
or the arrow keys and Enter to focus any row, including working and unknown
agents. The table scrolls to keep the highlighted row visible. Escape closes
the picker. Before focusing, the picker confirms the selected agent still
occupies its pane.

Press `/` to search the title, harness, status, or tab label. Matching ignores
case and includes title text beyond the popup width. While editing a query,
digits are text. Enter or Escape returns to navigation; Escape in navigation
closes the picker. Digit assignments follow the matching rows and are
independent of scroll position.

Both popup pickers request 116 columns by 42 rows. Herdr clamps that size to
the available terminal area. The search line reserves its right side for the
visible row range and total, such as `1-14/14` or `↑21-26/50↓`. Arrows show
that more matching rows are above or below the viewport, even with a long
query. Narrow layouts hide location and harness columns before clipping the
destination title. Tiny layouts keep the selected row visible first.

Agent metadata refreshes once per second while the popup is open. Digits
follow the refreshed statuses, and the highlight follows the selected
agent's pane and terminal identity. Filtering uses the local snapshot.
The plugin lists agents in the current session; the native Go To menu can
also aggregate connected machines.

The Tab column shows `t0` when all listed agents share a workspace and `t0_w6`
when agents span multiple workspaces. Status icons and colors are:

| Status | Icon | Foreground | Jump number |
| --- | --- | --- | --- |
| Working | ↻ | Default terminal color | Blank |
| Idle | . | Cyan | Bold |
| Done | ✓ | Cyan | Bold |
| Blocked | ! | Amber | Bold |
| Unknown | ? | Cyan | Blank |

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
