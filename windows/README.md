# Windows tools

Scripts that run on the Windows side of the machine. Anything that must work
while WSL is shut down or broken lives here, as Windows PowerShell 5.1 (ships
with every Windows 10 and 11) with no other dependencies.

`just win-sync` copies this folder to `%USERPROFILE%\dotfiles\windows`, so a
working copy exists on Windows even when WSL is down. Edit the files in the
dotfiles repository. Sync keeps files staged from other branches and refuses
to copy into a Git checkout. `just sync` runs it on WSL.
Don't run these scripts from `\\wsl.localhost\...`: shutting WSL down would
remove the file the script is running from.

## When WSL is down

Open File Explorer, go to `%USERPROFILE%\dotfiles\windows`, and double-click the
`.cmd` file you need. Or, from any PowerShell window:

```powershell
& "$env:USERPROFILE\dotfiles\windows\compact-wsl.cmd"
```

## Scripts

- `compact-wsl.cmd` / `compact-wsl.ps1`: trims each WSL distro, shuts WSL
  down, and compacts its `ext4.vhdx` with DiskPart, printing before and after
  sizes. Asks for admin rights itself. Flags: `-DryRun` (list disks only),
  `-IncludeDocker`, `-Distro <name>`, `-SkipTrim`, `-Yes`.
- `explorer.ps1`: Explorer preferences (classic context menu). Run from WSL
  with `windows/cfg.sh`.
- `audio-capture/`: hotkey recorder for system audio plus the mic, saved as
  MP3, that survives a mic unplug. Install with
  `just audio-capture-install`. See its README.
- `sharex/`: ShareX dual audio capture setup. See its README.
- `terminal-profile/`: Ubuntu-24.04 in Windows Terminal and PowerShell history,
  completion, and editing keys. Run `terminal-profile\sync.cmd` to preview.
  See its [README](terminal-profile/README.md).

## Native Windows Codex

Run `just windows-codex-sync` in WSL to see what would change. Add `--apply`
to sync once, or use `just windows-codex-sync --install-timer` to sync now and
every six hours while WSL is running. Run the install command again after a
dotfiles update to refresh the installed program. Windows Codex can read its
local copies while WSL is down.

Skills are copied from `~/.agents/skills` to
`%USERPROFILE%\.agents\skills\wsl-synced`. The sync follows top-level
skill links, skips known credential and cache files, and skips skills
containing nested links. It preserves Windows skill directories with the
same name and leaves locally edited copies alone. Copies of skills removed
from WSL stay on Windows until removed by hand.

The sync adds reviewed HTTP entries to the Windows `CODEX_HOME\config.toml`
and keeps existing Windows definitions. The default entries are OpenAI
Developer Docs and Superhuman Mail, if present in WSL. Sign in directly from
Windows Codex for servers that use OAuth. The sync leaves Linux credentials,
OAuth sessions, and server headers on the Linux side.

Use `just windows-codex-sync --wsl-servers NAME` to preview an optional
bridge for a named WSL stdio server. Add `--apply` to install the bridge.
These entries can start WSL when Windows Codex starts. Keep them out of the
Windows config if you need Codex to stay open during Cross Hub compaction.
The periodic job only copies skills and adds native HTTP entries.

Check sync runs with
`journalctl --user -u dotfiles-windows-codex-sync.service`. To pause the
timer, run `systemctl --user disable --now dotfiles-windows-codex-sync.timer`.

## Conventions for agents

- Windows-only or WSL-independent tooling goes here as PowerShell 5.1, with
  one entry in the list above saying what it does and how to run it.
- Keep `.ps1` files ASCII-only; 5.1 misreads UTF-8 without a BOM.
- Discover paths (registry, environment) instead of hardcoding them.
- Give each user-facing script a `.cmd` launcher so execution policy never
  blocks it.
- An agent inside WSL can test with `-DryRun` only. Anything that shuts WSL
  down ends the agent's own session.
