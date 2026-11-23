$ErrorActionPreference = 'Stop'
$script = Join-Path (Split-Path -Parent $PSScriptRoot) 'sync.ps1'
$source = [IO.File]::ReadAllText($script)
. ([scriptblock]::Create($source.Substring(0, $source.IndexOf('$stateRoot ='))))

$root = Join-Path $env:TEMP ('known-folders-test-' + [guid]::NewGuid())
$profileBefore = $env:USERPROFILE
try {
    $env:USERPROFILE = $root
    $mappings = foreach ($folder in $folders) {
        $before = Join-Path $root $folder.Name
        $after = Join-Path $root $folder.Target
        [void][IO.Directory]::CreateDirectory($before)
        [void][IO.Directory]::CreateDirectory($after)
        [pscustomobject]@{ Id = $folder.Id; Before = $before; After = $after }
    }
    $pictures = $mappings | Where-Object Id -eq $folders[0].Id
    $photo = Join-Path $pictures.Before 'photo.jpg'
    [IO.File]::WriteAllText($photo, 'incoming')
    [IO.File]::SetLastWriteTime($photo, [datetime]'2025-03-02')
    $collision = Join-Path $pictures.After '25-03-02-photo.jpg'
    [IO.File]::WriteAllText($collision, 'existing')
    [IO.File]::WriteAllText((Join-Path $pictures.Before 'desktop.ini'), 'metadata')
    $nested = Join-Path $pictures.Before 'Screenshots'
    [void][IO.Directory]::CreateDirectory($nested)
    [IO.File]::WriteAllText((Join-Path $nested 'first.png'), 'nested')

    $entries = @(Get-FileMigration $mappings)
    $planned = $entries | Where-Object Source -eq $photo
    $nestedFile = $entries | Where-Object Kind -eq 'Move' | Where-Object Source -ne $photo
    if ($planned.Destination -ne (Join-Path $pictures.After '25-03-02-photo (2).jpg') -or
        $nestedFile.Destination -ne (Join-Path $pictures.After 'Screenshots\first.png') -or
        ($entries.Source -match 'desktop.ini$')) {
        throw 'Preview did not preserve folder names, metadata, and the existing photo.'
    }

    $journalPath = Join-Path $root 'journal.jsonl'
    $writer = [IO.StreamWriter]::new($journalPath)
    try { Write-Event $writer $planned 'Prepared' ([DotfilesKnownFolders]::Hash($photo)) }
    finally { $writer.Dispose() }
    # Emulate interruption between moving the file and recording completion.
    [IO.File]::Move($photo, $planned.Destination)
    [IO.File]::AppendAllText($journalPath, '{"State":"Do')

    $failures = @(Invoke-FileMigration $entries $journalPath 'fixture')
    if ($failures.Count -or [IO.File]::Exists($nestedFile.Source) -or
        [IO.File]::ReadAllText($planned.Destination) -ne 'incoming' -or
        [IO.File]::ReadAllText($collision) -ne 'existing') {
        throw "Migration did not resume safely: $failures"
    }
    if (@(Invoke-FileMigration $entries $journalPath 'fixture').Count) {
        throw 'A repeated migration failed.'
    }
    if (@(Invoke-FileMigration $entries $journalPath 'fixture' -Restore).Count -or
        [IO.File]::ReadAllText($photo) -ne 'incoming' -or
        [IO.File]::ReadAllText($nestedFile.Source) -ne 'nested' -or
        [IO.File]::ReadAllText($collision) -ne 'existing') {
        throw 'Rollback did not restore the original paths.'
    }
    Write-Host 'Known-folder migration fixture passed.'
} finally {
    $env:USERPROFILE = $profileBefore
    if ([IO.Directory]::Exists($root)) { [IO.Directory]::Delete($root, $true) }
}
