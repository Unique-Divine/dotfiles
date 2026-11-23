# Windows Pictures and Documents

Use Windows Known Folders to make `$env:USERPROFILE\Pictures-real` the Pictures
folder and `$env:USERPROFILE\desk-drawer` the Documents folder. The target
folders must already exist. Apps that use the Windows folder API pick up these
paths. Reopen apps that cache the setting.

After staging the scripts with `just win-sync`, run these from Windows PowerShell.

~~~powershell
$sync = Join-Path $env:USERPROFILE 'dotfiles\windows\known-folders\sync.cmd'
& $sync                     # Preview redirection
& $sync -Apply              # Apply redirection only
& $sync -MoveFiles          # Preview redirection and file migration
& $sync -Apply -MoveFiles   # Migrate files and apply redirection
& $sync -Rollback           # Restore mappings and move unchanged local files back
~~~

The migration uses the file's Windows last-modified date for loose filenames.
It preserves existing date prefixes and names within subfolders. Windows
`desktop.ini` files and links stay in place. If a destination name exists, the
incoming file gets the next available numbered suffix. Cloud placeholders are
copied when they can be read and verified. Their source files stay in place
because moving them could remove the cloud copies.

The manifest and journal live in `%LOCALAPPDATA%\Dotfiles\KnownFolders`.
Rerun `-Apply -MoveFiles` to resume the same migration. The script writes any
blocked file paths to `failures.txt`. Rollback preserves
cloud copies, checks local file hashes, and flags any new files occupying an
original location. Its manifest remains available for reference.

Windows PowerShell reads its user profile from the Documents folder. Migrate
the files or rerun the Terminal profile installer after redirection to keep
the dotfiles keybindings in new PowerShell tabs.
