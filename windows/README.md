# Windows tools

Scripts that run on the Windows side of the machine. Anything that must work
while WSL is shut down or broken lives here, as Windows PowerShell 5.1 (ships
with every Windows 10 and 11) with no other dependencies.

`just win-sync` copies this folder to `%USERPROFILE%\.files\windows`, so a
working copy exists on C: even when WSL is down. `just sync` runs it on WSL.
Don't run these scripts from `\\wsl.localhost\...`: shutting WSL down would
remove the file the script is running from.

## When WSL is down

Open File Explorer, go to `%USERPROFILE%\.files\windows`, and double-click the
`.cmd` file you need. Or, from any PowerShell window:

```powershell
& "$env:USERPROFILE\.files\windows\compact-wsl.cmd"
```

## Scripts

- `compact-wsl.cmd` / `compact-wsl.ps1`: trims each WSL distro, shuts WSL
  down, and compacts its `ext4.vhdx` with DiskPart, printing before and after
  sizes. Asks for admin rights itself. Flags: `-DryRun` (list disks only),
  `-IncludeDocker`, `-Distro <name>`, `-SkipTrim`, `-Yes`.
- `explorer.ps1`: Explorer preferences (classic context menu). Run from WSL
  with `windows/cfg.sh`.
- `audio-capture/`: hotkey recorder for system audio plus the mic, saved as
  MP3, that survives a mic unplug. Build with `just audio-capture-build`. See
  its README.
- `sharex/`: ShareX dual audio capture setup. See its README.

## Conventions for agents

- Windows-only or WSL-independent tooling goes here as PowerShell 5.1, with
  one entry in the list above saying what it does and how to run it.
- Keep `.ps1` files ASCII-only; 5.1 misreads UTF-8 without a BOM.
- Discover paths (registry, environment) instead of hardcoding them.
- Give each user-facing script a `.cmd` launcher so execution policy never
  blocks it.
- An agent inside WSL can test with `-DryRun` only. Anything that shuts WSL
  down ends the agent's own session.
