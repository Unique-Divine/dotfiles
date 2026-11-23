# Run with Windows PowerShell. Supply fixture WSL registrations to avoid machine state.
$ErrorActionPreference = 'Stop'
$sync = Join-Path (Split-Path -Parent $PSScriptRoot) 'sync.ps1'
$root = Join-Path $env:TEMP ('terminal-dotfiles-' + [guid]::NewGuid())
[void][IO.Directory]::CreateDirectory($root)
try {
    $userPolicy = Get-ExecutionPolicy -Scope CurrentUser
    $paths = @{
        SettingsPath = @((Join-Path $root 'settings.json'), (Join-Path $root 'preview.json'))
        ProfilePath = Join-Path $root 'profile.ps1'
        ManagedProfilePath = Join-Path $root "managed profile's.ps1"
        WslDistributions = @('Ubuntu-24.04')
        UbuntuPackageFamilies = @()
    }
    $settings = @'
{
    "defaultProfile": "{00000000-0000-0000-0000-000000000001}",
    "profiles": {
        "defaults": {"font": {"face": "Consolas"}},
        "list": [
            {"name":"Windows PowerShell","guid":"{00000000-0000-0000-0000-000000000001}","commandline":"powershell.exe","elevate":true},
            {"name":"Ubuntu 22.04.5 LTS","guid":"{00000000-0000-0000-0000-000000000002}","source":"Microsoft.WSL"},
            {"name":"Ubuntu-24.04","guid":"{00000000-0000-0000-0000-000000000003}","source":"Microsoft.WSL","hidden":true},
            {"name":"Work","guid":"{00000000-0000-0000-0000-000000000004}","commandline":"cmd.exe /k"}
        ]
    },
    "actions": [{"id":"User.keep","command":"find"}],
    "keybindings": [{"keys":"ctrl+f","id":"User.keep"},{"keys":"ctrl+shift+3","id":"User.keep"}]
}
'@
    $userProfile = '# Keep existing profile' + [Environment]::NewLine
    foreach ($path in $paths.SettingsPath) { [IO.File]::WriteAllText($path, $settings) }
    [IO.File]::WriteAllText($paths.ProfilePath, $userProfile)

    & $sync @paths
    if ([IO.File]::ReadAllText($paths.SettingsPath[0]) -cne $settings -or
        [IO.File]::ReadAllText($paths.SettingsPath[1]) -cne $settings -or
        [IO.File]::ReadAllText($paths.ProfilePath) -cne $userProfile -or
        [IO.File]::Exists($paths.ManagedProfilePath)) {
        throw 'Preview changed a file.'
    }

    & $sync @paths -Apply
    $updated = [IO.File]::ReadAllText($paths.SettingsPath[0]) | ConvertFrom-Json
    if ([IO.File]::ReadAllText($paths.SettingsPath[0]) -cne [IO.File]::ReadAllText($paths.SettingsPath[1])) {
        throw 'The second Terminal edition did not receive the same changes.'
    }
    $profiles = $updated.profiles.list
    if ($updated.defaultProfile -ne '{00000000-0000-0000-0000-000000000001}' -or
        $updated.profiles.defaults.font.face -ne 'Consolas' -or
        ($profiles | Where-Object name -eq Work).commandline -ne 'cmd.exe /k' -or
        ($profiles | Where-Object name -eq 'Windows PowerShell').commandline -ne 'powershell.exe' -or
        ($profiles | Where-Object name -eq Ubuntu-24.04).hidden -ne $false -or
        $profiles.name -contains 'Ubuntu 22.04.5 LTS') {
        throw 'Terminal profiles did not update as expected.'
    }
    $normal = $profiles | Where-Object name -eq 'Windows PowerShell'
    $admin = $profiles | Where-Object name -eq 'Windows PowerShell (Admin)'
    $normalKey = @($updated.keybindings | Where-Object keys -eq 'ctrl+shift+3')
    $adminKey = @($updated.keybindings | Where-Object keys -eq 'ctrl+shift+4')
    if ($normal.elevate -ne $false -or $admin.elevate -ne $true -or
        $normalKey.Count -ne 1 -or $adminKey.Count -ne 1 -or
        ($updated.actions | Where-Object id -eq $normalKey[0].id).command.profile -ne $normal.guid -or
        ($updated.actions | Where-Object id -eq $adminKey[0].id).command.profile -ne $admin.guid -or
        ($updated.keybindings | Where-Object keys -eq 'ctrl+f').id -ne 'User.keep') {
        throw 'PowerShell profiles or bindings did not update as expected.'
    }

    $profile = [IO.File]::ReadAllText($paths.ProfilePath)
    if (!$profile.StartsWith($userProfile) -or !$profile.Contains("managed profile''s.ps1") -or
        ![IO.File]::Exists($paths.ManagedProfilePath)) {
        throw 'The managed loader was installed incorrectly.'
    }

    $backups = @(Get-ChildItem $root -Filter '*.bak')
    if ($backups.Count -ne 3 -or
        (Get-Content -Raw (Join-Path $root 'settings.json.dotfiles-*.bak')) -cne $settings -or
        (Get-Content -Raw (Join-Path $root 'profile.ps1.dotfiles-*.bak')) -cne $userProfile) {
        throw 'Expected both originals to be backed up.'
    }

    $before = Get-ChildItem $root | Get-FileHash | Sort-Object Path
    & $sync @paths -Apply
    $after = Get-ChildItem $root | Get-FileHash | Sort-Object Path
    if (Compare-Object $before $after -Property Path, Hash) {
        throw 'A second sync changed files.'
    }

    $nativePaths = @{
        SettingsPath = Join-Path $root 'no-wsl.json'
        ProfilePath = Join-Path $root 'no-wsl-profile.ps1'
        ManagedProfilePath = Join-Path $root 'no-wsl-interactive.ps1'
        WslDistributions = @()
        UbuntuPackageFamilies = @()
    }
    [IO.File]::WriteAllText($nativePaths.SettingsPath, $settings)
    & $sync @nativePaths -Apply
    $nativeSettings = [IO.File]::ReadAllText($nativePaths.SettingsPath) | ConvertFrom-Json
    $nativeProfiles = $nativeSettings.profiles.list
    if ($nativeProfiles.name -notcontains 'Windows PowerShell (Admin)' -or
        ($nativeProfiles | Where-Object name -eq 'Ubuntu-24.04').hidden -ne $true -or
        $nativeProfiles.name -notcontains 'Ubuntu 22.04.5 LTS' -or
        ![IO.File]::Exists($nativePaths.ProfilePath) -or
        ![IO.File]::Exists($nativePaths.ManagedProfilePath)) {
        throw 'Without WSL, sync should install PowerShell and leave Linux profiles untouched.'
    }

    $compatPaths = $nativePaths.Clone()
    foreach ($layout in @('legacy-list', 'defaults-only')) {
        $fixture = ConvertFrom-Json $settings
        if ($layout -eq 'legacy-list') { $fixture.profiles = $fixture.profiles.list }
        else { $fixture.profiles.PSObject.Properties.Remove('list') }
        $compatPaths.SettingsPath = Join-Path $root "$layout.json"
        [IO.File]::WriteAllText($compatPaths.SettingsPath, ($fixture | ConvertTo-Json -Depth 10))
        & $sync @compatPaths -Apply
        $configured = [IO.File]::ReadAllText($compatPaths.SettingsPath) | ConvertFrom-Json
        if ($configured.profiles.list.name -notcontains 'Windows PowerShell (Admin)') {
            throw "Terminal did not accept the $layout profile layout."
        }
        if ($layout -eq 'legacy-list' -and $configured.profiles.list.name -notcontains 'Work') {
            throw 'Converting the legacy layout lost an existing profile.'
        }
        if ($layout -eq 'defaults-only' -and $configured.profiles.defaults.font.face -ne 'Consolas') {
            throw 'Adding the profile list lost existing defaults.'
        }
    }

    $nativePaths.SettingsPath = @()
    $nativePaths.ProfilePath = Join-Path $root 'no-terminal-profile.ps1'
    $nativePaths.ManagedProfilePath = Join-Path $root 'no-terminal-interactive.ps1'
    & $sync @nativePaths -Apply
    if (![IO.File]::Exists($nativePaths.ProfilePath) -or ![IO.File]::Exists($nativePaths.ManagedProfilePath)) {
        throw 'Without Terminal settings, sync should still install the PowerShell profile.'
    }

    $signedPaths = $nativePaths.Clone()
    $signedPaths.SettingsPath = Join-Path $root 'signed.json'
    $signedPaths.ProfilePath = Join-Path $root 'signed-profile.ps1'
    $signedPaths.ManagedProfilePath = Join-Path $root 'signed-interactive.ps1'
    $newline = [Environment]::NewLine
    $signedProfile = $userProfile + '# SIG # Begin signature block' + $newline +
        '# SIG # End signature block' + $newline
    [IO.File]::WriteAllText($signedPaths.SettingsPath, $settings)
    [IO.File]::WriteAllText($signedPaths.ProfilePath, $signedProfile)
    $rejectedSignedProfile = $false
    try { & $sync @signedPaths -Apply }
    catch {
        if ($_.Exception.Message -notlike '*signed profile*') { throw }
        $rejectedSignedProfile = $true
    }
    if (!$rejectedSignedProfile -or
        [IO.File]::ReadAllText($signedPaths.SettingsPath) -cne $settings -or
        [IO.File]::ReadAllText($signedPaths.ProfilePath) -cne $signedProfile -or
        [IO.File]::Exists($signedPaths.ManagedProfilePath)) {
        throw 'Attempting to sync a signed profile should leave all files untouched.'
    }

    if ((Get-ExecutionPolicy -Scope CurrentUser) -ne $userPolicy) {
        throw 'A fixture profile changed the current user execution policy.'
    }

    $originalPath = $env:PATH
    $originalLocalData = $env:LOCALAPPDATA
    try {
        $env:PATH = Join-Path $env:SystemRoot 'System32'
        $env:LOCALAPPDATA = $root
        if (Get-Command zoxide.exe, winget.exe -CommandType Application -ErrorAction SilentlyContinue) {
            throw 'The interactive fixture must run without zoxide or WinGet.'
        }
        . $paths.ManagedProfilePath
        $options = Get-PSReadLineOption
        $keys = Get-PSReadLineKeyHandler
        if ($options.EditMode -ne 'Vi' -or $options.ViModeIndicator -ne 'Cursor' -or
            ($keys | Where-Object Key -eq 'Ctrl+r').Function -ne 'ReverseSearchHistory' -or
            ($keys | Where-Object Key -eq 'Tab').Function -ne 'MenuComplete') {
            throw 'The managed profile did not enable Vi mode and its insert-mode editing keys.'
        }
    } finally {
        $env:PATH = $originalPath
        $env:LOCALAPPDATA = $originalLocalData
    }
    Write-Host 'Terminal profile sync checks passed.'
} finally {
    Remove-Item -LiteralPath $root -Recurse -Force
}
