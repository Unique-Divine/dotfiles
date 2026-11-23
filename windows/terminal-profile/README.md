# Windows Terminal and PowerShell

From Windows PowerShell, preview the changes, then apply them after reviewing
the output.

```powershell
& "$env:USERPROFILE\.files\windows\terminal-profile\sync.cmd"
& "$env:USERPROFILE\.files\windows\terminal-profile\sync.cmd" -Apply
```

Open a new Windows PowerShell tab to pick up the profile. The setup uses the
PSReadLine module included with Windows PowerShell on Windows 11. It saves
command history across tabs and restarts.

| Key | Action |
| --- | --- |
| Ctrl+R | Search history by substring. |
| Up / Down | Search backward / forward for lines that start with the text you typed. |
| Tab / Shift+Tab | Open completion choices / move to the previous match. |
| Ctrl+A / Ctrl+E | Move to the start / end of the command. |
| Ctrl+W / Ctrl+U | Delete the previous word / text before the cursor. |
| Ctrl+L | Clear the screen. |

The setup adds a loader to your existing Windows PowerShell profile and copies
the keybindings to `%LOCALAPPDATA%\Dotfiles\PowerShell\interactive.ps1`.
The profile works from the native Windows filesystem when WSL is down. If
Windows PowerShell has no persistent execution policy, the setup sets
`RemoteSigned` for the current Windows user. This lets direct PowerShell
launches and elevated tabs under the same account load the profile, too.
The setup respects existing user, machine, and Group Policy settings and
keeps the Windows PowerShell launch command in Terminal as configured.

The sync makes `Ubuntu-24.04` visible if registered and removes or hides
generated Ubuntu 22.04 profiles once that distro is unregistered. It keeps
the current default unless that default points to a stale profile it removes
or hides. It formats the settings as JSON when updating them and stops if
the Windows PowerShell JSON parser cannot read them. Changed settings and
existing profiles get timestamped `.bak` copies alongside the originals.
