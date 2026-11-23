[CmdletBinding(DefaultParameterSetName = 'Sync')]
param(
    [Parameter(ParameterSetName = 'Sync')]
    [Parameter(ParameterSetName = 'Policy')][switch]$Apply,
    [Parameter(ParameterSetName = 'Sync')][switch]$MoveFiles,
    [Parameter(Mandatory, ParameterSetName = 'Policy')][switch]$BlockOneDrive,
    [Parameter(Mandatory, ParameterSetName = 'Rollback')][switch]$Rollback
)

$ErrorActionPreference = 'Stop'

$folders = @(
    @{ Name = 'Pictures'; LocalName = 'Local Pictures'; Target = 'Pictures'; MigrateFrom = 'Pictures-real'
       Id = '33E28130-4E1E-4676-835A-98395C3BC3BB'; LocalId = '0DDD015D-B06C-45D5-8C4C-F59713854639' }
    @{ Name = 'Documents'; LocalName = 'Local Documents'; Target = 'desk-drawer'; MigrateFrom = 'Documents'; DateLooseFiles = $true
       Id = 'FDD39AD0-238F-46AF-ADB4-6C85480369C7'; LocalId = 'F42EE2D3-909F-4907-8871-4C22FC0BF756' }
    @{ Name = 'Desktop'; Target = 'Desktop'; Id = 'B4BFCC3A-DB2C-424C-B029-7FE99A87C641' }
    @{ Name = 'Downloads'; LocalName = 'Local Downloads'; Target = 'Downloads'
       Id = '374DE290-123F-4565-9164-39C4925E467B'; LocalId = '7D83EE9B-2244-4E70-B1F5-5393042AF1E4' }
    @{ Name = 'Music'; LocalName = 'Local Music'; Target = 'Music'
       Id = '4BD8D571-6D19-48D3-BE97-422220080E43'; LocalId = 'A0C69A99-21C8-4671-8703-7934162FCF1D' }
)
$oneDrivePolicy = 'HKLM:\SOFTWARE\Policies\Microsoft\OneDrive'

Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;

public static class DotfilesKnownFolders
{
    [DllImport("shell32.dll")]
    private static extern int SHGetKnownFolderPath(ref Guid id, uint flags, IntPtr token, out IntPtr path);

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern int SHSetKnownFolderPath(ref Guid id, uint flags, IntPtr token, string path);

    [DllImport("shell32.dll")]
    public static extern void SHChangeNotify(int eventId, uint flags, IntPtr first, IntPtr second);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct FindData
    {
        public uint Attributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write;
        public uint SizeHigh, SizeLow, Tag, Reserved;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string Name;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 14)] public string ShortName;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr FindFirstFile(string path, out FindData data);

    [DllImport("kernel32.dll")]
    private static extern bool FindClose(IntPtr handle);

    public static string Get(Guid id)
    {
        IntPtr path;
        int result = SHGetKnownFolderPath(ref id, 0x4000, IntPtr.Zero, out path);
        try {
            Marshal.ThrowExceptionForHR(result);
            return Marshal.PtrToStringUni(path);
        } finally {
            Marshal.FreeCoTaskMem(path);
        }
    }

    public static void Set(Guid id, string path)
    {
        Marshal.ThrowExceptionForHR(SHSetKnownFolderPath(ref id, 0, IntPtr.Zero, path));
    }

    public static bool IsCloudFile(string path)
    {
        FindData data;
        IntPtr handle = FindFirstFile(@"\\?\" + path, out data);
        if (handle == new IntPtr(-1))
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        FindClose(handle);
        // IO_REPARSE_TAG_CLOUD and the CLOUD_1 through CLOUD_F tags.
        return (data.Tag & 0xFFFF0FFFu) == 0x9000001Au;
    }

    public static string Hash(string path)
    {
        using (var stream = File.OpenRead(path))
        using (var sha = SHA256.Create())
            return Convert.ToBase64String(sha.ComputeHash(stream));
    }
}
'@

function Get-Redirections {
    foreach ($folder in $folders) {
        $target = Join-Path $env:USERPROFILE $folder.Target
        foreach ($entry in @(@{ Id = $folder.Id; Name = $folder.Name },
                             @{ Id = $folder.LocalId; Name = $folder.LocalName })) {
            if (!$entry.Id) { continue }
            [pscustomobject]@{
                Id = $entry.Id
                Name = $entry.Name
                Before = [DotfilesKnownFolders]::Get([guid]$entry.Id)
                After = $target
            }
        }
    }
}

function Assert-LocalDirectory([string]$Path) {
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    if ($item -and (!$item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint))) {
        throw "Expected a local directory at $Path."
    }
}

function Test-OneDriveProtection($Mappings) {
    $policy = Get-ItemProperty -LiteralPath $oneDrivePolicy -ErrorAction SilentlyContinue
    if ($policy.KFMOptInWithWizard -or $policy.KFMSilentOptIn -or $policy.KFMBlockOptOut -eq 1 -or
        ($null -ne $policy.KFMBlockOptIn -and $policy.KFMBlockOptIn -notin @(0, 1))) {
        throw 'Conflicting machine policy for OneDrive Known Folder Move. Review it before applying dotfiles.'
    }
    $cloudRoots = @($env:OneDrive, $env:OneDriveConsumer, $env:OneDriveCommercial)
    $cloudRoots += @(Get-ChildItem -LiteralPath 'HKCU:\Software\Microsoft\OneDrive\Accounts' -ErrorAction SilentlyContinue |
        ForEach-Object { (Get-ItemProperty -LiteralPath $_.PSPath).UserFolder })
    foreach ($entry in $Mappings) {
        $path = $entry.Before
        $inCloud = $path -match '(?i)(^|\\)OneDrive(?: - [^\\]+)?(\\|$)'
        foreach ($root in $cloudRoots | Where-Object { $_ }) {
            $prefix = $root.TrimEnd('\')
            if ($path -eq $prefix -or $path.StartsWith($prefix + '\', [StringComparison]::OrdinalIgnoreCase)) {
                $inCloud = $true
            }
        }
        if ($inCloud) { throw "OneDrive owns $($entry.Name) at $path. Stop its folder backup before applying dotfiles." }
    }
    return ($policy.KFMBlockOptIn -eq 1 -and
        (Get-Item -LiteralPath $oneDrivePolicy).GetValueKind('KFMBlockOptIn') -eq [Microsoft.Win32.RegistryValueKind]::DWord)
}

function Set-Redirections($Redirections, [switch]$Restore) {
    $changed = [Collections.Generic.List[object]]::new()
    try {
        foreach ($entry in $Redirections) {
            $expected = if ($Restore) { $entry.Before } else { $entry.After }
            $current = [DotfilesKnownFolders]::Get([guid]$entry.Id)
            if ($current -eq $expected) { continue }
            if ($Restore -and $current -notin @($entry.Before, $entry.After)) {
                throw "$($entry.Name) was changed separately to $current."
            }
            [DotfilesKnownFolders]::Set([guid]$entry.Id, $expected)
            $changed.Add(@{ Id = $entry.Id; Path = $current })
            if ([DotfilesKnownFolders]::Get([guid]$entry.Id) -ne $expected) {
                throw "Windows did not resolve $($entry.Name) to $expected."
            }
        }
    } catch {
        foreach ($entry in $changed) {
            try { [DotfilesKnownFolders]::Set([guid]$entry.Id, $entry.Path) }
            catch { Write-Warning "Could not restore $($entry.Path): $_" }
        }
        throw
    }
    if ($changed.Count) {
        [DotfilesKnownFolders]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)
    }
}

function Complete-MigrationRedirections($Mappings, $Failures, [switch]$Restore) {
    if ($Failures.Count) {
        Write-Warning 'File migration is incomplete. Known Folder mappings have not been changed.'
        return $false
    }
    Set-Redirections $Mappings -Restore:$Restore
    return $true
}

function Get-FileMigration($Mappings, [string]$ArchiveRoot) {
    $reserved = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($folder in $folders) {
        if (!$folder.MigrateFrom) { continue }
        $mapping = $Mappings | Where-Object Id -eq $folder.Id
        $sourceRoot = Join-Path $env:USERPROFILE $folder.MigrateFrom
        $targetRoot = $mapping.After
        if ($folder.Name -eq 'Documents' -and $mapping.Before -ne $sourceRoot) { continue }
        Assert-LocalDirectory $sourceRoot
        if (![IO.Directory]::Exists($sourceRoot)) { continue }
        if ($mapping.Before -notin @($sourceRoot, $targetRoot)) {
            throw "Review the current $($folder.Name) path $($mapping.Before) before moving files."
        }
        $source = Get-Item -LiteralPath $sourceRoot -Force
        if (!$source.PSIsContainer -or ($source.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "Expected a local source directory at $sourceRoot."
        }
        $pending = [Collections.Generic.Queue[string]]::new()
        $pending.Enqueue($sourceRoot)
        while ($pending.Count) {
            $directory = $pending.Dequeue()
            $relative = $directory.Substring($sourceRoot.Length).TrimStart('\')
            $target = Join-Path $targetRoot $relative
            if ($relative) {
                if ([IO.File]::Exists($target) -or (Test-ReparsePoint $target)) {
                    throw "Cannot merge a folder into $target."
                }
                [pscustomobject]@{ Kind = 'Directory'; Source = $directory; Destination = $target }
            }
            $items = @(Get-ChildItem -LiteralPath $directory -Force | Sort-Object Name)
            foreach ($item in $items) {
                if ($item.PSIsContainer -and $item.Name -ine 'desktop.ini' -and
                    !($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
                    [void]$reserved.Add((Join-Path $target $item.Name))
                }
            }
            foreach ($item in $items) {
                if ($item.Name -ieq 'desktop.ini') { continue }
                $reparse = [bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint)
                if ($item.PSIsContainer -and !$reparse) {
                    $pending.Enqueue($item.FullName)
                    continue
                }
                if ($reparse -and ($item.PSIsContainer -or ![DotfilesKnownFolders]::IsCloudFile($item.FullName))) {
                    [pscustomobject]@{ Kind = 'Retain'; Source = $item.FullName; Destination = $null }
                    continue
                }

                $name = $item.Name
                if ($folder.DateLooseFiles -and !$relative -and $name -notmatch '^\d{2}-\d{2}-\d{2}(?=$|[- ._])') {
                    $name = $item.LastWriteTime.ToString('yy-MM-dd') + '-' + $name
                }
                $destinationDirectory = $target
                $destination = Join-Path $destinationDirectory $name
                $duplicateOf = $null
                if ($folder.Name -eq 'Pictures' -and !$reparse -and [IO.File]::Exists($destination) -and
                    !(Test-ReparsePoint $destination) -and [IO.FileInfo]::new($destination).Length -eq $item.Length -and
                    [DotfilesKnownFolders]::Hash($destination) -ceq [DotfilesKnownFolders]::Hash($item.FullName)) {
                    $duplicateOf = $destination
                    $destinationDirectory = Join-Path (Join-Path $ArchiveRoot 'picture-duplicates') $relative
                    $destination = Join-Path $destinationDirectory $name
                }
                $number = 2
                while (!$reserved.Add($destination) -or (Test-Path -LiteralPath $destination) -or (Test-ReparsePoint $destination)) {
                    $stem = [IO.Path]::GetFileNameWithoutExtension($name)
                    $destination = Join-Path $destinationDirectory ($stem + " ($number)" + [IO.Path]::GetExtension($name))
                    $number++
                }
                [pscustomobject]@{
                    Kind = if ($reparse) { 'CopyCloud' } else { 'Move' }
                    Source = $item.FullName
                    Destination = $destination
                    Length = $item.Length
                    LastWrite = $item.LastWriteTimeUtc.Ticks
                    DuplicateOf = $duplicateOf
                }
            }
        }
    }
}

function Test-ReparsePoint([string]$Path) {
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    return $null -ne $item -and [bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint)
}

function Assert-LocalParents([string]$Path, $Checked) {
    for ($directory = Split-Path -Parent $Path; $directory; $directory = Split-Path -Parent $directory) {
        if ($Checked.Contains($directory)) { return }
        if (Test-ReparsePoint $directory) { throw "Directory is a reparse point at $directory." }
    }
    [void]$Checked.Add((Split-Path -Parent $Path))
}

function Read-Journal($Path) {
    $records = @{}
    if (Test-Path -LiteralPath $Path) {
        $text = [IO.File]::ReadAllText($Path)
        $completeLength = $text.LastIndexOf("`n") + 1
        if ($completeLength -lt $text.Length) {
            # A stopped writer may leave a partial last record. Prepared
            # records on preceding lines are enough to recover the move.
            $text = $text.Substring(0, $completeLength)
            $stream = [IO.File]::OpenWrite($Path)
            try { $stream.SetLength([Text.Encoding]::UTF8.GetByteCount($text)) }
            finally { $stream.Dispose() }
        }
        foreach ($line in $text.Split("`n", [StringSplitOptions]::RemoveEmptyEntries)) {
            $entry = $line | ConvertFrom-Json
            if ($entry.State -eq 'Restored') {
                $records.Remove($entry.Source)
            } else {
                $records[$entry.Source] = $entry
            }
        }
    }
    return $records
}

function Write-Event($Writer, $Item, $State, $Hash) {
    $Writer.WriteLine((@{ Source = $Item.Source; State = $State; Hash = $Hash } | ConvertTo-Json -Compress))
}

function Assert-PictureDuplicate($Entry, [string]$Hash) {
    if (!$Entry.DuplicateOf) { return }
    if (![IO.File]::Exists($Entry.DuplicateOf) -or (Test-ReparsePoint $Entry.DuplicateOf) -or
        [DotfilesKnownFolders]::Hash($Entry.DuplicateOf) -cne $Hash) {
        throw "The matching picture changed at $($Entry.DuplicateOf). Review it before archiving this file."
    }
}

function Assert-CompletedMigrationFile($Entry, $Record) {
    if (![IO.File]::Exists($Entry.Destination) -or (Test-ReparsePoint $Entry.Destination) -or
        [DotfilesKnownFolders]::Hash($Entry.Destination) -cne $Record.Hash) {
        throw "The recorded destination is missing or changed at $($Entry.Destination). Review it before retrying."
    }
    Assert-PictureDuplicate $Entry $Record.Hash
}

function Test-FileMigrationComplete($Items, $JournalPath) {
    $journal = Read-Journal $JournalPath
    foreach ($entry in $Items) {
        if ($entry.Kind -eq 'Directory') {
            if (![IO.Directory]::Exists($entry.Destination) -or (Test-ReparsePoint $entry.Destination)) {
                return $false
            }
        } elseif ($entry.Kind -eq 'Retain') {
            if ((Test-Path -LiteralPath $entry.Source) -or (Test-ReparsePoint $entry.Source)) {
                return $false
            }
        } else {
            $record = $journal[$entry.Source]
            if ($record.State -ne 'Done') { return $false }
            try { Assert-CompletedMigrationFile $entry $record }
            catch { return $false }
        }
    }
    return $true
}

function Invoke-FileMigration($Items, $JournalPath, $SessionId, [switch]$Restore, [switch]$VerifyCompleted) {
    $journal = Read-Journal $JournalPath
    $writer = [IO.StreamWriter]::new($JournalPath, $true, [Text.UTF8Encoding]::new($false))
    $writer.AutoFlush = $true
    $failures = [Collections.Generic.List[string]]::new()
    $checked = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $moved = $copied = $retained = 0
    try {
        foreach ($entry in $Items) {
            try {
                if ($entry.Kind -eq 'Retain') {
                    if (!$Restore -and ((Test-Path -LiteralPath $entry.Source) -or (Test-ReparsePoint $entry.Source))) {
                        $retained++
                        throw 'Retained a reparse point that cannot be migrated safely. Resolve this item before retrying.'
                    }
                    continue
                }
                if ($entry.Kind -eq 'Directory') {
                    if (!$Restore) {
                        Assert-LocalParents $entry.Destination $checked
                        if (Test-ReparsePoint $entry.Destination) {
                            throw "Directory is a reparse point at $($entry.Destination)."
                        }
                        [void][IO.Directory]::CreateDirectory($entry.Destination)
                    }
                    continue
                }

                $record = $journal[$entry.Source]
                $hash = $record.Hash
                if ($Restore) {
                    if ($entry.Kind -ne 'Move' -or !$record) { continue }
                    Assert-LocalParents $entry.Source $checked
                    Assert-LocalParents $entry.Destination $checked
                    if (![IO.File]::Exists($entry.Source)) {
                        if ((Test-ReparsePoint $entry.Destination) -or
                            [DotfilesKnownFolders]::Hash($entry.Destination) -cne $hash) {
                            throw 'Destination changed since the migration.'
                        }
                        [void][IO.Directory]::CreateDirectory((Split-Path -Parent $entry.Source))
                        [IO.File]::Move($entry.Destination, $entry.Source)
                    } elseif ((Test-Path -LiteralPath $entry.Destination) -or
                        [DotfilesKnownFolders]::Hash($entry.Source) -cne $hash) {
                        throw 'The old path is occupied or changed.'
                    }
                    Write-Event $writer $entry 'Restored' $hash
                    $moved++
                    continue
                }

                if ($record.State -eq 'Done') {
                    if ($VerifyCompleted) { Assert-CompletedMigrationFile $entry $record }
                    if ($entry.Kind -eq 'Move') { $moved++ } else { $copied++ }
                    continue
                }
                Assert-LocalParents $entry.Source $checked
                Assert-LocalParents $entry.Destination $checked
                [void][IO.Directory]::CreateDirectory((Split-Path -Parent $entry.Destination))
                if ([IO.File]::Exists($entry.Destination)) {
                    if (!$record -or (Test-ReparsePoint $entry.Destination) -or
                        ($entry.Kind -eq 'Move' -and [IO.File]::Exists($entry.Source)) -or
                        [DotfilesKnownFolders]::Hash($entry.Destination) -cne $hash) {
                        throw 'Destination is occupied or changed.'
                    }
                    Assert-PictureDuplicate $entry $hash
                } else {
                    $file = Get-Item -LiteralPath $entry.Source -Force
                    if ($file.PSIsContainer -or $file.Length -ne $entry.Length -or
                        $file.LastWriteTimeUtc.Ticks -ne $entry.LastWrite -or
                        (($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -and
                            ($entry.Kind -ne 'CopyCloud' -or ![DotfilesKnownFolders]::IsCloudFile($entry.Source)))) {
                        throw 'Source changed since the preview.'
                    }
                    $actualHash = [DotfilesKnownFolders]::Hash($entry.Source)
                    if ($record -and $actualHash -cne $hash) { throw 'Source contents changed.' }
                    $hash = $actualHash
                    Assert-PictureDuplicate $entry $hash
                    if (!$record) { Write-Event $writer $entry 'Prepared' $hash }
                    if ($entry.Kind -eq 'Move') {
                        [IO.File]::Move($entry.Source, $entry.Destination)
                    } else {
                        $temp = Join-Path (Split-Path -Parent $entry.Destination) ('.dotfiles-copy-' + $SessionId)
                        try {
                            if ([IO.File]::Exists($temp)) { [IO.File]::Delete($temp) }
                            [IO.File]::Copy($entry.Source, $temp)
                            if ((Test-ReparsePoint $temp) -or [DotfilesKnownFolders]::Hash($temp) -cne $hash) {
                                throw 'The cloud copy is not a verified local file.'
                            }
                            [IO.File]::Move($temp, $entry.Destination)
                        } finally {
                            if ([IO.File]::Exists($temp)) { [IO.File]::Delete($temp) }
                        }
                    }
                    if ($entry.Kind -eq 'Move' -and [DotfilesKnownFolders]::Hash($entry.Destination) -cne $hash) {
                        throw 'The destination hash differs from the original.'
                    }
                }
                Write-Event $writer $entry 'Done' $hash
                if ($entry.Kind -eq 'Move') { $moved++ } else { $copied++ }
            } catch {
                $failures.Add("$($entry.Source): $($_.Exception.Message)")
            }
        }
    } finally {
        $writer.Dispose()
    }
    Write-Host "Local files moved: $moved. Cloud files copied: $copied. Other reparse points retained: $retained."
    return $failures.ToArray()
}

function Move-ShellDirectory([string]$Source, [string]$Destination) {
    $attributes = [IO.File]::GetAttributes($Source)
    $readOnly = $attributes -band [IO.FileAttributes]::ReadOnly
    if ($readOnly) { [IO.File]::SetAttributes($Source, $attributes -bxor $readOnly) }
    $path = $Source
    try {
        [IO.Directory]::Move($Source, $Destination)
        $path = $Destination
    } finally {
        if ($readOnly) { [IO.File]::SetAttributes($path, $attributes) }
    }
}

function Move-PictureMetadata([string]$Original, [string]$Archive, [switch]$Restore) {
    $source, $target = if ($Restore) { $Archive, $Original } else { $Original, $Archive }
    Assert-LocalDirectory $source
    Assert-LocalDirectory $target
    if (![IO.Directory]::Exists($source)) { return }
    $directories = [Collections.Generic.List[string]]::new()
    $metadata = [Collections.Generic.List[string]]::new()
    $directories.Add($source)
    for ($index = 0; $index -lt $directories.Count; $index++) {
        foreach ($item in Get-ChildItem -LiteralPath $directories[$index] -Force) {
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "The old Pictures folder contains a reparse point at $($item.FullName)."
            }
            if ($item.PSIsContainer) {
                $directories.Add($item.FullName)
            } elseif ($item.Name -ine 'desktop.ini') {
                throw "Files still remain in the old Pictures folder, including $($item.FullName)."
            } else {
                $metadata.Add($item.FullName)
            }
        }
    }

    if (![IO.Directory]::Exists($target)) {
        try {
            Move-ShellDirectory $source $target
            Write-Host "Saved the Pictures directory structure at $target."
            return
        } catch {
            if (![IO.Directory]::Exists($source) -or [IO.Directory]::Exists($target)) { throw }
        }
    }

    # Explorer or Windows may keep a handle open on the old folder. Archive
    # only the inspected metadata and remove directories only if empty.
    $attributes = @{}
    foreach ($directory in $directories) {
        $destination = $target + $directory.Substring($source.Length)
        Assert-LocalDirectory $destination
        $attributes[$destination] = [IO.File]::GetAttributes($directory)
        [void][IO.Directory]::CreateDirectory($destination)
    }
    foreach ($file in $metadata) { [IO.File]::Move($file, $target + $file.Substring($source.Length)) }
    foreach ($destination in $attributes.Keys) { [IO.File]::SetAttributes($destination, $attributes[$destination]) }
    for ($index = $directories.Count - 1; $index -ge 0; $index--) {
        $directory = $directories[$index]
        $flags = [IO.File]::GetAttributes($directory)
        $readOnly = $flags -band [IO.FileAttributes]::ReadOnly
        if ($readOnly) { [IO.File]::SetAttributes($directory, $flags -bxor $readOnly) }
        try { [IO.Directory]::Delete($directory) }
        catch {
            if ($readOnly) { [IO.File]::SetAttributes($directory, $flags) }
            throw
        }
    }
    Write-Host "Saved the Pictures directory structure at $target."
}

$stateRoot = Join-Path $env:LOCALAPPDATA 'Dotfiles\KnownFolders\profile-v2'
$currentMappings = @(Get-Redirections)
if (!$Rollback) {
    $protected = Test-OneDriveProtection $currentMappings
    if ($BlockOneDrive) {
        if ($protected) {
            Write-Host 'OneDrive Known Folder Move is already blocked by machine policy.'
        } elseif (!$Apply) {
            Write-Host 'Preview: set the machine OneDrive policy KFMBlockOptIn to DWORD 1.'
        } else {
            $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
            $principal = [Security.Principal.WindowsPrincipal]::new($identity)
            if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
                throw 'Run -BlockOneDrive -Apply as administrator.'
            }
            if (!(Test-Path -LiteralPath $oneDrivePolicy)) { New-Item -Path $oneDrivePolicy -Force | Out-Null }
            New-ItemProperty -LiteralPath $oneDrivePolicy -Name 'KFMBlockOptIn' -PropertyType DWord -Value 1 -Force | Out-Null
            if (!(Test-OneDriveProtection $currentMappings)) { throw 'Could not verify the OneDrive machine policy.' }
            Write-Host 'Blocked OneDrive Known Folder Move by machine policy.'
        }
        return
    }
    if (!$protected) {
        if ($Apply) { throw 'Set the OneDrive protection first with -BlockOneDrive -Apply as administrator.' }
        Write-Host 'OneDrive protection is missing. Preview the machine policy with -BlockOneDrive.'
    }
}

$manifestPath = Join-Path $stateRoot 'migration.json'
$journalPath = Join-Path $stateRoot 'journal.jsonl'
$manifestText = if (Test-Path -LiteralPath $manifestPath) {
    [IO.File]::ReadAllText($manifestPath)
}
$manifest = if ($manifestText) { $manifestText | ConvertFrom-Json }
if ($Rollback -and !$manifest) { throw 'There is no migration manifest to roll back.' }

$mappings = if ($manifest) { $manifest.Mappings } else { $currentMappings }
foreach ($entry in $mappings) { Assert-LocalDirectory $entry.After }
$legacyPictures = Join-Path $env:USERPROFILE 'Pictures-real'
$pictureArchive = Join-Path $stateRoot 'Pictures-real-metadata'
$entries = if ($manifest -and $manifest.WithFiles) {
    $manifest.Entries
} elseif ($MoveFiles) {
    @(Get-FileMigration $mappings $stateRoot)
}

foreach ($entry in $currentMappings) {
    Write-Host "$($entry.Name) -> $($entry.After) (currently $($entry.Before))"
}

if (!$Apply -and !$Rollback) {
    if ($MoveFiles) {
        $entries | Group-Object Kind | ForEach-Object { Write-Host "$($_.Name): $($_.Count)" }
        $entries | Where-Object Kind -ne Directory | ForEach-Object {
            Write-Output "$($_.Kind)`t$($_.Source)`t$($_.Destination)"
        }
    }
    Write-Host 'Preview only. Pass -Apply to change Windows settings.'
    return
}

[void][IO.Directory]::CreateDirectory($stateRoot)
$lockPath = Join-Path $stateRoot 'migration.lock'
$lockFile = [IO.File]::Open($lockPath, 'OpenOrCreate', 'ReadWrite', 'None')
try {
    $latestManifest = if ([IO.File]::Exists($manifestPath)) { [IO.File]::ReadAllText($manifestPath) }
    if ($latestManifest -cne $manifestText) { throw 'The migration plan changed. Run the command again.' }
    $migrationCutoverPending = $false
    foreach ($entry in $mappings) {
        $current = [DotfilesKnownFolders]::Get([guid]$entry.Id)
        if ($entry.Name -in @('Pictures', 'Local Pictures', 'Documents', 'Local Documents') -and
            $current -ne $entry.After) {
            $migrationCutoverPending = $true
        }
        if (($MoveFiles -or $Rollback) -and $current -notin @($entry.Before, $entry.After)) {
            throw "$($entry.Name) was changed separately to $current."
        }
    }
    if (!$manifest -or ($MoveFiles -and !$manifest.WithFiles)) {
        $manifest = @{
            Id = [guid]::NewGuid().ToString('N')
            Mappings = @($mappings)
            WithFiles = [bool]$MoveFiles
            Entries = @($entries)
        }
        $temp = Join-Path $stateRoot ("manifest-" + $manifest.Id + ".tmp")
        [IO.File]::WriteAllText($temp, ($manifest | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
        if ([IO.File]::Exists($manifestPath)) {
            [IO.File]::Replace($temp, $manifestPath, $null)
        } else {
            [IO.File]::Move($temp, $manifestPath)
        }
    }

    if ($Rollback) {
        if ($manifest.WithFiles) {
            Move-PictureMetadata $legacyPictures $pictureArchive -Restore
            $failures = @(Invoke-FileMigration $entries $journalPath $manifest.Id -Restore)
        }
        [void](Complete-MigrationRedirections $mappings $failures -Restore)
    } else {
        if (!$MoveFiles -and $manifest.WithFiles -and $migrationCutoverPending -and
            !(Test-FileMigrationComplete $entries $journalPath)) {
            throw 'The recorded migration is incomplete. Rerun with -MoveFiles before changing the Known Folder mappings.'
        }
        foreach ($target in $mappings.After | Select-Object -Unique) { [void][IO.Directory]::CreateDirectory($target) }
        if ($MoveFiles) {
            $failures = @(Invoke-FileMigration $entries $journalPath $manifest.Id -VerifyCompleted:$migrationCutoverPending)
        }
        if ((Complete-MigrationRedirections $mappings $failures) -and $MoveFiles) {
            try { Move-PictureMetadata $legacyPictures $pictureArchive }
            catch { $failures = @($failures) + $_.Exception.Message }
        }
    }
    Write-Host "Manifest: $manifestPath"
    $report = Join-Path $stateRoot 'failures.txt'
    if ($failures.Count) {
        [IO.File]::WriteAllLines($report, [string[]]$failures)
        Write-Warning "$($failures.Count) files or directories need attention. See $report."
        exit 2
    }
    if ([IO.File]::Exists($report)) { [IO.File]::Delete($report) }
} finally {
    $lockFile.Dispose()
}
