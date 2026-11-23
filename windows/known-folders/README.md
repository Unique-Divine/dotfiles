# Windows Known Folders

Dotfiles manages these paths for the signed-in Windows user. The setup uses
Windows Known Folder IDs, so Explorer and apps that ask Windows for a folder
receive the configured path.

| Known Folder | Path |
| --- | --- |
| Desktop | `%USERPROFILE%\Desktop` |
| Downloads | `%USERPROFILE%\Downloads` |
| Documents | `%USERPROFILE%\desk-drawer` |
| Music | `%USERPROFILE%\Music` |
| Pictures | `%USERPROFILE%\Pictures` |

## Set Up a Machine

Run `just win-sync` in WSL to stage the scripts. From an Administrator
PowerShell window, preview and apply the OneDrive machine policy once.

~~~powershell
$sync = Join-Path $env:USERPROFILE 'dotfiles\windows\known-folders\sync.cmd'
& $sync -BlockOneDrive
& $sync -BlockOneDrive -Apply
~~~

This sets `KFMBlockOptIn` to 1, which prevents OneDrive from taking over
Desktop, Documents, and Pictures. OneDrive can still sync its own folders.
Run this before signing into OneDrive. If OneDrive already owns a folder, stop
its folder backup first and leave the cloud files in place. The setup reports
any active backup or conflicting Windows policy.

From regular Windows PowerShell, preview or apply the paths. Reopen apps that
cache the old locations.

~~~powershell
$sync = Join-Path $env:USERPROFILE 'dotfiles\windows\known-folders\sync.cmd'
& $sync                     # Preview redirection
& $sync -Apply              # Apply redirection only
& $sync -MoveFiles          # Preview redirection and file migration
& $sync -Apply -MoveFiles   # Migrate files and apply redirection
& $sync -Rollback           # Restore the previous paths and moved files
~~~

## Move Existing Files

If Pictures-real exists, the migration merges it into Pictures using the
existing filenames. Distinct collisions get the next available numbered
suffix. Identical local files already in Pictures are archived for rollback.
The script preserves the destination's `desktop.ini` and archives the original
folder structure and metadata after verifying the move.

If Windows still points Documents at its original local directory, the
migration moves eligible local files to desk-drawer. It adds a last-modified
date prefix to loose filenames that do not already have one. For both
migrations, readable cloud placeholders are copied and verified, and their
originals stay in place. Other reparse points stay in place and block the
mapping change until you resolve those items and retry.

The current manifest and journal live in `%LOCALAPPDATA%\Dotfiles\KnownFolders\profile-v2`.
The previous Pictures and Documents migration records remain in the parent
directory. Rerun `-Apply -MoveFiles` to resume a file migration. Blocked file paths
appear in `failures.txt`. Before switching Pictures or Documents, a resumed
migration verifies the recorded destination files. After switching, reapplying
the setup leaves later edits alone. The script changes the Known Folder paths
only after the requested file move or restore completes. Rollback verifies hashes
and preserves cloud copies.
The OneDrive machine policy stays enabled after rolling back folder mappings.

Windows PowerShell reads its user profile from Documents. After redirecting
Documents without moving the profile, rerun the Terminal profile installer to
restore the dotfiles keybindings.
