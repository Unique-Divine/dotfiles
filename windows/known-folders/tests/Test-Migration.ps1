$ErrorActionPreference = 'Stop'
$script = Join-Path (Split-Path -Parent $PSScriptRoot) 'sync.ps1'
$source = [IO.File]::ReadAllText($script)
. ([scriptblock]::Create($source.Substring(0, $source.IndexOf('$stateRoot ='))))

$root = Join-Path $env:TEMP ('known-folders-test-' + [guid]::NewGuid())
$profileBefore = $env:USERPROFILE
try {
    $env:USERPROFILE = $root
    $mappings = foreach ($folder in $folders) {
        $before = Join-Path $root $(if ($folder.MigrateFrom) { $folder.MigrateFrom } else { $folder.Target })
        $after = Join-Path $root $folder.Target
        [void][IO.Directory]::CreateDirectory($before)
        [void][IO.Directory]::CreateDirectory($after)
        [pscustomobject]@{ Id = $folder.Id; Before = $before; After = $after }
    }
    $pictures = $mappings | Where-Object Id -eq $folders[0].Id
    $photo = Join-Path $pictures.Before 'photo.jpg'
    [IO.File]::WriteAllText($photo, 'incoming')
    [IO.File]::SetLastWriteTime($photo, [datetime]'2025-03-02')
    $collision = Join-Path $pictures.After 'photo.jpg'
    [IO.File]::WriteAllText($collision, 'existing')
    $reservedFolder = Join-Path $pictures.Before 'photo (2).jpg'
    [void][IO.Directory]::CreateDirectory($reservedFolder)
    [IO.File]::WriteAllText((Join-Path $reservedFolder 'preserve.txt'), 'folder contents')
    [IO.File]::WriteAllText((Join-Path $pictures.Before 'desktop.ini'), 'metadata')
    $nested = Join-Path $pictures.Before 'Screenshots'
    [void][IO.Directory]::CreateDirectory($nested)
    [IO.File]::WriteAllText((Join-Path $nested 'first.png'), 'nested')
    $duplicate = Join-Path $pictures.Before 'same.jpg'
    [IO.File]::WriteAllText($duplicate, 'same on both sides')
    [IO.File]::WriteAllText((Join-Path $pictures.After 'same.jpg'), 'same on both sides')
    $documents = $mappings | Where-Object Id -eq $folders[1].Id
    $document = Join-Path $documents.Before 'notes.txt'
    [IO.File]::WriteAllText($document, 'notes')
    [IO.File]::SetLastWriteTime($document, [datetime]'2025-04-03')

    $backup = Join-Path $root 'backup'
    [void][IO.Directory]::CreateDirectory($backup)
    $entries = @(Get-FileMigration $mappings $backup)
    $planned = $entries | Where-Object Source -eq $photo
    $nestedFile = $entries | Where-Object Source -eq (Join-Path $nested 'first.png')
    $plannedDuplicate = $entries | Where-Object Source -eq $duplicate
    if ($planned.Destination -ne (Join-Path $pictures.After 'photo (3).jpg') -or
        $nestedFile.Destination -ne (Join-Path $pictures.After 'Screenshots\first.png') -or
        ($entries.Source -match 'desktop.ini$') -or
        $plannedDuplicate.Destination -ne (Join-Path $backup 'picture-duplicates\same.jpg') -or
        ($entries | Where-Object Source -eq $document).Destination -ne (Join-Path $documents.After '25-04-03-notes.txt')) {
        throw 'Preview did not preserve folder names, metadata, and the existing photo.'
    }

    $journalPath = Join-Path $root 'journal.jsonl'
    if (Test-FileMigrationComplete $entries $journalPath) {
        throw 'An unstarted migration was reported complete.'
    }
    [IO.File]::WriteAllText($plannedDuplicate.DuplicateOf, 'the existing file changed')
    $failures = @(Invoke-FileMigration @($plannedDuplicate) $journalPath 'fixture')
    if ($failures.Count -ne 1 -or $failures[0] -notmatch 'matching picture changed' -or
        ![IO.File]::Exists($duplicate) -or [IO.File]::Exists($plannedDuplicate.Destination)) {
        throw 'A stale duplicate plan archived the only active copy.'
    }
    [IO.File]::WriteAllText($plannedDuplicate.DuplicateOf, 'same on both sides')
    $writer = [IO.StreamWriter]::new($journalPath)
    try { Write-Event $writer $planned 'Prepared' ([DotfilesKnownFolders]::Hash($photo)) }
    finally { $writer.Dispose() }
    # Emulate interruption between moving the file and recording completion.
    [IO.File]::Move($photo, $planned.Destination)
    [IO.File]::AppendAllText($journalPath, '{"State":"Do')

    $failures = @(Invoke-FileMigration $entries $journalPath 'fixture')
    if ($failures.Count -or [IO.File]::Exists($nestedFile.Source) -or
        !(Test-FileMigrationComplete $entries $journalPath) -or
        [IO.File]::ReadAllText($planned.Destination) -ne 'incoming' -or
        [IO.File]::ReadAllText($collision) -ne 'existing' -or
        [IO.File]::ReadAllText((Join-Path $pictures.After 'photo (2).jpg\preserve.txt')) -ne 'folder contents') {
        throw "Migration did not resume safely: $failures"
    }
    if (@(Invoke-FileMigration $entries $journalPath 'fixture').Count) {
        throw 'A repeated migration failed.'
    }

    $renamed = Join-Path $pictures.After 'renamed photo.jpg'
    [IO.File]::Move($planned.Destination, $renamed)
    $failures = @(Invoke-FileMigration $entries $journalPath 'fixture' -VerifyCompleted)
    if ($failures.Count -ne 1 -or $failures[0] -notmatch 'recorded destination is missing or changed' -or
        (Test-FileMigrationComplete $entries $journalPath)) {
        throw 'A missing destination passed the resumed cutover check.'
    }

    [IO.File]::WriteAllText($planned.Destination, 'changed!')
    $failures = @(Invoke-FileMigration $entries $journalPath 'fixture' -VerifyCompleted)
    if ($failures.Count -ne 1 -or $failures[0] -notmatch 'recorded destination is missing or changed' -or
        (Test-FileMigrationComplete $entries $journalPath)) {
        throw 'A replaced destination passed the resumed cutover check.'
    }
    if (@(Invoke-FileMigration $entries $journalPath 'fixture').Count -or
        [IO.File]::ReadAllText($planned.Destination) -ne 'changed!' -or
        [IO.File]::ReadAllText($renamed) -ne 'incoming') {
        throw 'Reapplying after cutover should leave renamed or edited files alone.'
    }
    [IO.File]::Delete($planned.Destination)
    [IO.File]::Move($renamed, $planned.Destination)

    $pictureArchive = Join-Path $backup 'Pictures-real-metadata'
    [void][IO.Directory]::CreateDirectory($pictureArchive)
    $attributes = [IO.File]::GetAttributes($pictures.Before) -bor [IO.FileAttributes]::ReadOnly
    [IO.File]::SetAttributes($pictures.Before, $attributes)
    Move-PictureMetadata $pictures.Before $pictureArchive
    if ([IO.Directory]::Exists($pictures.Before) -or
        ![IO.File]::Exists((Join-Path $pictureArchive 'desktop.ini')) -or
        [IO.File]::GetAttributes($pictureArchive) -ne $attributes) {
        throw 'The legacy Pictures folder was not archived with its metadata.'
    }
    Move-PictureMetadata $pictures.Before $pictureArchive -Restore
    if (@(Invoke-FileMigration $entries $journalPath 'fixture' -Restore).Count -or
        [IO.File]::ReadAllText($photo) -ne 'incoming' -or
        [IO.File]::ReadAllText($nestedFile.Source) -ne 'nested' -or
        [IO.File]::ReadAllText($duplicate) -ne 'same on both sides' -or
        [IO.File]::ReadAllText($document) -ne 'notes' -or
        [IO.File]::ReadAllText($collision) -ne 'existing') {
        throw 'Rollback did not restore the original paths.'
    }
    $retained = [pscustomobject]@{ Kind = 'Retain'; Source = $document }
    $failures = @(Invoke-FileMigration @($retained) $journalPath 'fixture')
    if ($failures.Count -ne 1 -or $failures[0] -notmatch 'Retained a reparse point' -or
        [IO.File]::ReadAllText($document) -ne 'notes') {
        throw 'An unmigrated item was not reported as an incomplete migration.'
    }
    function Set-Redirections { throw 'The Known Folder mapping changed despite failed file work.' }
    if ((Complete-MigrationRedirections $mappings $failures) -or
        (Complete-MigrationRedirections $mappings $failures -Restore)) {
        throw 'Failed file work did not block the mapping change.'
    }
    [IO.File]::Move($document, (Join-Path $root 'resolved-retained.txt'))
    if (@(Invoke-FileMigration @($retained) $journalPath 'fixture').Count -or
        !(Test-FileMigrationComplete @($retained) $journalPath)) {
        throw 'A resolved reparse point still blocks migration.'
    }
    Write-Host 'Known-folder migration fixture passed.'
} finally {
    $env:USERPROFILE = $profileBefore
    $fixturePictures = Join-Path $root 'Pictures-real'
    if ([IO.Directory]::Exists($fixturePictures)) {
        [IO.File]::SetAttributes($fixturePictures, [IO.FileAttributes]::Directory)
    }
    if ([IO.Directory]::Exists($root)) { [IO.Directory]::Delete($root, $true) }
}
