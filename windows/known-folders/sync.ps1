[CmdletBinding(DefaultParameterSetName = 'Sync')]
param(
    [Parameter(ParameterSetName = 'Sync')][switch]$Apply,
    [Parameter(ParameterSetName = 'Sync')][switch]$MoveFiles,
    [Parameter(Mandatory, ParameterSetName = 'Rollback')][switch]$Rollback
)

$ErrorActionPreference = 'Stop'

$folders = @(
    @{ Name = 'Pictures'; LocalName = 'Local Pictures'; Target = 'Pictures-real'
       Id = '33E28130-4E1E-4676-835A-98395C3BC3BB'; LocalId = '0DDD015D-B06C-45D5-8C4C-F59713854639' }
    @{ Name = 'Documents'; LocalName = 'Local Documents'; Target = 'desk-drawer'
       Id = 'FDD39AD0-238F-46AF-ADB4-6C85480369C7'; LocalId = 'F42EE2D3-909F-4907-8871-4C22FC0BF756' }
)

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
        $item = Get-Item -LiteralPath $target -Force
        if (!$item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "Expected a local directory at $target."
        }
        foreach ($entry in @(@{ Id = $folder.Id; Name = $folder.Name },
                             @{ Id = $folder.LocalId; Name = $folder.LocalName })) {
            [pscustomobject]@{
                Id = $entry.Id
                Name = $entry.Name
                Before = [DotfilesKnownFolders]::Get([guid]$entry.Id)
                After = $target
            }
        }
    }
}

function Set-Redirections($Redirections, [switch]$Restore) {
    $changed = [Collections.Generic.List[object]]::new()
    try {
        foreach ($entry in $Redirections) {
            $expected = if ($Restore) { $entry.Before } else { $entry.After }
            $current = [DotfilesKnownFolders]::Get([guid]$entry.Id)
            if ($current -eq $expected) { continue }
            if ($current -notin @($entry.Before, $entry.After)) {
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

function Get-FileMigration($Mappings) {
    $reserved = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($folder in $folders) {
        $mapping = $Mappings | Where-Object Id -eq $folder.Id
        $sourceRoot = $mapping.Before
        $targetRoot = $mapping.After
        if ($sourceRoot -eq $targetRoot) { continue }
        $expected = Join-Path $env:USERPROFILE $folder.Name
        if ($sourceRoot -ne $expected) {
            throw "The existing $($folder.Name) path is $sourceRoot. Expected $expected for the file migration."
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
            foreach ($item in Get-ChildItem -LiteralPath $directory -Force | Sort-Object Name) {
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
                if (!$relative -and $name -notmatch '^\d{2}-\d{2}-\d{2}(?=$|[- ._])') {
                    $name = $item.LastWriteTime.ToString('yy-MM-dd') + '-' + $name
                }
                $destination = Join-Path $target $name
                $number = 2
                while (!$reserved.Add($destination) -or (Test-Path -LiteralPath $destination) -or (Test-ReparsePoint $destination)) {
                    $stem = [IO.Path]::GetFileNameWithoutExtension($name)
                    $destination = Join-Path $target ($stem + " ($number)" + [IO.Path]::GetExtension($name))
                    $number++
                }
                [pscustomobject]@{
                    Kind = if ($reparse) { 'CopyCloud' } else { 'Move' }
                    Source = $item.FullName
                    Destination = $destination
                    Length = $item.Length
                    LastWrite = $item.LastWriteTimeUtc.Ticks
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

function Invoke-FileMigration($Items, $JournalPath, $SessionId, [switch]$Restore) {
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
                    $retained++
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

$stateRoot = Join-Path $env:LOCALAPPDATA 'Dotfiles\KnownFolders'
$manifestPath = Join-Path $stateRoot 'migration.json'
$journalPath = Join-Path $stateRoot 'journal.jsonl'
$manifestText = if (Test-Path -LiteralPath $manifestPath) {
    [IO.File]::ReadAllText($manifestPath)
}
$manifest = if ($manifestText) { $manifestText | ConvertFrom-Json }
if ($Rollback -and !$manifest) { throw 'There is no migration manifest to roll back.' }

$mappings = if ($manifest) { $manifest.Mappings } else { @(Get-Redirections) }
$entries = if ($manifest -and $manifest.WithFiles) {
    $manifest.Entries
} elseif ($MoveFiles) {
    @(Get-FileMigration $mappings)
}

foreach ($entry in $mappings) {
    Write-Host "$($entry.Name) -> $($entry.After) (previously $($entry.Before))"
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
    foreach ($entry in $mappings) {
        $current = [DotfilesKnownFolders]::Get([guid]$entry.Id)
        if ($current -notin @($entry.Before, $entry.After)) {
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
        if ($manifest.WithFiles) { $failures = @(Invoke-FileMigration $entries $journalPath $manifest.Id -Restore) }
        Set-Redirections $mappings -Restore
    } else {
        if ($MoveFiles) { $failures = @(Invoke-FileMigration $entries $journalPath $manifest.Id) }
        Set-Redirections $mappings
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
