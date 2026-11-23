# Windows Terminal and PowerShell

Run `just win-sync` in WSL to stage the dotfiles under
`%USERPROFILE%\dotfiles\windows`. The installer updates the live settings of
Terminal Stable and Preview if they have both been opened on this account.

From Windows PowerShell, preview the changes, then apply them after reviewing
the output.

```powershell
& "$env:USERPROFILE\dotfiles\windows\terminal-profile\sync.cmd" -InstallZoxide
& "$env:USERPROFILE\dotfiles\windows\terminal-profile\sync.cmd" -Apply -InstallZoxide
```

From a regular Terminal window, `Ctrl+Shift+3` opens Windows PowerShell 5.1,
and `Ctrl+Shift+4` opens Windows PowerShell (Admin). The latter opens a separate
administrator window and may show a UAC prompt. Use a regular Terminal window
for the regular shortcut because tabs in an administrator window inherit its
privileges. The shortcuts use profile GUIDs and work after rearranging the menu.

Open a new Windows PowerShell tab to pick up the profile. The bundled
PSReadLine module starts in Vi insert mode and saves command history across tabs
and restarts. Press `Esc` for command mode and `i` or `a` to return to insert mode.
The cursor changes shape between modes. The following shortcuts work in insert mode.

| Key | Action |
| --- | --- |
| Ctrl+R | Search history by substring. |
| Up / Down | Search backward / forward for lines that start with the text you typed. |
| Tab / Shift+Tab | Open completion choices / move to the previous match. |
| Ctrl+A / Ctrl+E | Move to the start / end of the command. |
| Ctrl+W / Ctrl+U | Delete the previous word / text before the cursor. |
| Ctrl+L | Clear the screen. |

Use `z <query>` to jump to directories you have visited, for example `z desk`
after visiting `desk-drawer`. Zoxide learns Windows paths and keeps its history
on the local machine. `cd` still performs ordinary directory changes. Omit
`-InstallZoxide` to apply the profile without installing the WinGet package.

`$PROFILE.CurrentUserAllHosts` shows your Windows PowerShell startup file. The
setup adds a loader there and copies `interactive.ps1` from dotfiles to
`%LOCALAPPDATA%\Dotfiles\PowerShell\interactive.ps1`. Edit the repository copy
and rerun sync to update it.
The profile works from the native Windows filesystem when WSL is down. If
Windows PowerShell has no persistent execution policy, the setup sets
`RemoteSigned` for the current Windows user. This lets direct PowerShell
launches and elevated tabs under the same account load the profile, too.
The setup respects existing user, machine, and Group Policy settings and
keeps the Windows PowerShell launch command in Terminal as configured. If
the startup file is signed, add the loader and re-sign the file separately.

PowerShell setup works before Windows Terminal has created a settings file.
Open Windows Terminal once and rerun sync to manage its profiles. When
`Ubuntu-24.04` is registered, sync makes it visible and removes or hides
generated Ubuntu 22.04 profiles if that distro is unregistered. It keeps
the current default unless that default points to a stale profile it removes
or hides. It formats the settings as JSON when updating them and stops if
the Windows PowerShell JSON parser cannot read them. Changed settings and
existing profiles get timestamped `.bak` copies alongside the originals.
