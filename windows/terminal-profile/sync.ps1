[CmdletBinding()]
param(
    [switch]$Apply,
    [string[]]$SettingsPath,
    [string]$ProfilePath = $PROFILE.CurrentUserAllHosts,
    [string]$ManagedProfilePath = (Join-Path $env:LOCALAPPDATA 'Dotfiles\PowerShell\interactive.ps1')
)

$ErrorActionPreference = 'Stop'
$ubuntuName = 'Ubuntu-24.04'
$ubuntuGuid = '{858bea76-da08-4d4c-89e9-8ae9737314a6}'
$powershellGuid = '{61c54bbd-c2c6-5271-96e7-009a87ff44bf}'
$adminGuid = '{ad18b9dd-81fa-4fcf-b9a7-701d1d8a40b4}'
$powershellCommand = '%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe'
$loaderMarker = '# dotfiles: load interactive PowerShell settings'

function Find-TerminalSettings {
    $found = foreach ($package in Get-AppxPackage -Name 'Microsoft.WindowsTerminal*') {
        if ($package.Name -notin @('Microsoft.WindowsTerminal', 'Microsoft.WindowsTerminalPreview')) { continue }
        $relative = "Packages\$($package.PackageFamilyName)\LocalState\settings.json"
        $path = Join-Path $env:LOCALAPPDATA $relative
        if (Test-Path -LiteralPath $path -PathType Leaf) { $path }
    }
    if ($found) { return $found }
    $path = Join-Path $env:LOCALAPPDATA 'Microsoft\Windows Terminal\settings.json'
    if (Test-Path -LiteralPath $path -PathType Leaf) { return $path }
    throw 'Open Windows Terminal once or supply its settings path with -SettingsPath.'
}

function Read-Text($Path, [Text.Encoding]$Encoding) {
    if (!(Test-Path -LiteralPath $Path -PathType Leaf)) {
        return @{ Text = ''; Encoding = $Encoding }
    }
    $reader = [IO.StreamReader]::new($Path, $Encoding, $true)
    try {
        $text = $reader.ReadToEnd()
        return @{ Text = $text; Encoding = $reader.CurrentEncoding }
    } finally {
        $reader.Dispose()
    }
}

function Set-Property($Object, $Name, $Value) {
    if ($Object.PSObject.Properties[$Name]) {
        $Object.$Name = $Value
    } else {
        $Object | Add-Member -NotePropertyName $Name -NotePropertyValue $Value
    }
}

function Set-PowerShellShortcut($Settings, $Keys, $Id, $Name, $Guid) {
    $actions = @($Settings.actions | Where-Object { $_ -and $_.id -ne $Id })
    $bindings = @($Settings.keybindings | Where-Object { $_ -and $_.id -ne $Id -and $_.keys -ne $Keys })
    $actions += [pscustomobject]@{
        id = $Id
        name = $Name
        command = [pscustomobject]@{ action = 'newTab'; profile = $Guid }
    }
    $bindings += [pscustomobject]@{ keys = $Keys; id = $Id }
    Set-Property $Settings 'actions' $actions
    Set-Property $Settings 'keybindings' $bindings
}

function Update-PowerShellProfiles($Settings, $Profiles) {
    $normal = $Profiles | Where-Object guid -eq $powershellGuid | Select-Object -First 1
    if (!$normal) {
        $normal = $Profiles | Where-Object name -eq 'Windows PowerShell' | Select-Object -First 1
    }
    if (!$normal) {
        $normal = [pscustomobject]@{ guid = $powershellGuid; name = 'Windows PowerShell'; commandline = $powershellCommand }
        $Profiles.Add($normal)
    }
    if (!$normal.guid) { Set-Property $normal 'guid' $powershellGuid }
    Set-Property $normal 'elevate' $false
    Set-Property $normal 'hidden' $false

    $admin = $Profiles | Where-Object guid -eq $adminGuid | Select-Object -First 1
    if (!$admin) {
        $admin = [pscustomobject]@{ guid = $adminGuid }
        $Profiles.Add($admin)
    }
    Set-Property $admin 'name' 'Windows PowerShell (Admin)'
    Set-Property $admin 'commandline' $powershellCommand
    Set-Property $admin 'elevate' $true
    Set-Property $admin 'hidden' $false

    Set-PowerShellShortcut $Settings 'ctrl+shift+3' 'User.Dotfiles.PowerShell' 'Windows PowerShell' $normal.guid
    Set-PowerShellShortcut $Settings 'ctrl+shift+4' 'User.Dotfiles.PowerShellAdmin' 'Windows PowerShell (Admin)' $admin.guid
}

function Update-Terminal($Settings, [string[]]$Distros, [string[]]$Packages) {
    if ($Distros -notcontains $ubuntuName) {
        throw "The registered WSL distributions do not include $ubuntuName."
    }
    if ($null -eq $Settings.profiles -or
        $Settings.profiles.list -isnot [System.Array]) {
        throw 'Expected a profiles.list array in Windows Terminal settings.'
    }

    $changes = [Collections.Generic.List[string]]::new()
    $profiles = [Collections.Generic.List[object]]::new()
    $target = $null
    $replaceDefault = $false
    $legacyRegistered = [bool]($Distros -match '^Ubuntu[- ]22\.04(?:\.\d+)?(?: LTS)?$')
    foreach ($entry in $Settings.profiles.list) {
        if (!$entry -or !$entry.name) { throw 'Terminal contains an invalid profile.' }
        $legacyProfile = $entry.name -match '^Ubuntu[- ]22\.04(?:\.\d+)?(?: LTS)?$' -and
            $entry.source -match '^(Windows\.Terminal\.Wsl|Microsoft\.WSL|CanonicalGroupLimited\.Ubuntu22\.04.*)$'
        if ($legacyProfile -and !$legacyRegistered) {
            if ($Settings.defaultProfile -and
                $Settings.defaultProfile -in @($entry.guid, $entry.name)) {
                $replaceDefault = $true
            }
            if ($entry.source -in $Packages) {
                if ($entry.hidden -ne $true) {
                    Set-Property $entry 'hidden' $true
                    $changes.Add("Hide generated profile $($entry.name)")
                }
            } else {
                $changes.Add("Remove stale profile $($entry.name)")
                continue
            }
        }
        if ($entry.name -eq $ubuntuName) {
            if ($target) { throw "More than one profile is named $ubuntuName." }
            $target = $entry
            if ($entry.hidden -eq $true) {
                Set-Property $entry 'hidden' $false
                $changes.Add("Show $ubuntuName")
            }
        }
        $profiles.Add($entry)
    }
    if (!$target) {
        $target = [pscustomobject]@{
            guid = $ubuntuGuid
            name = $ubuntuName
            commandline = "wsl.exe --distribution $ubuntuName"
            hidden = $false
        }
        $profiles.Add($target)
        $changes.Add("Add $ubuntuName")
    }
    if ($replaceDefault) {
        Set-Property $Settings 'defaultProfile' $(if ($target.guid) { $target.guid } else { $target.name })
        $changes.Add("Use $ubuntuName as the replacement for the stale default")
    }
    $Settings.profiles.list = $profiles.ToArray()
    $before = $Settings | ConvertTo-Json -Depth 100 -Compress
    Update-PowerShellProfiles $Settings $profiles
    $Settings.profiles.list = $profiles.ToArray()
    if (($Settings | ConvertTo-Json -Depth 100 -Compress) -cne $before) {
        $changes.Add('Configure Ctrl+Shift+3 for PowerShell and Ctrl+Shift+4 for PowerShell (Admin)')
    }
    return $changes.ToArray()
}

function Write-Text($Path, $Contents, $Encoding) {
    $directory = Split-Path -Parent $Path
    [void][IO.Directory]::CreateDirectory($directory)
    $temp = Join-Path $directory ('.dotfiles-' + [guid]::NewGuid() + '.tmp')
    try {
        [IO.File]::WriteAllText($temp, $Contents, $Encoding)
        if ([IO.File]::Exists($Path)) {
            $backup = "$Path.dotfiles-$([DateTime]::UtcNow.ToString('yyyyMMddHHmmssfff')).bak"
            [IO.File]::Replace($temp, $Path, $backup)
            Write-Host "Backed up $backup"
        } else {
            [IO.File]::Move($temp, $Path)
        }
    } finally {
        if ([IO.File]::Exists($temp)) { [IO.File]::Delete($temp) }
    }
}

$SettingsPath = if ($SettingsPath) { $SettingsPath } else { Find-TerminalSettings }
$SettingsPath = @($SettingsPath | ForEach-Object {
    $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($_)
} | Select-Object -Unique)
$ProfilePath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($ProfilePath)
$ManagedProfilePath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($ManagedProfilePath)
if ($ProfilePath -eq $ManagedProfilePath -or $ProfilePath -in $SettingsPath -or $ManagedProfilePath -in $SettingsPath) {
    throw 'Terminal settings, user profile, and managed profile must use distinct paths.'
}
$configuredPolicies = @(Get-ExecutionPolicy -List | Where-Object {
    $_.Scope -ne 'Process' -and $_.ExecutionPolicy -ne 'Undefined'
})
# The launcher sets a process policy. Check persistent scopes so this also
# covers PowerShell started directly or from an elevated Terminal window.
$enableUserPolicy = $ProfilePath -eq $PROFILE.CurrentUserAllHosts -and
    $configuredPolicies.Count -eq 0
$utf8 = [Text.UTF8Encoding]::new($false, $true)
$registered = @(Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss' |
    ForEach-Object { (Get-ItemProperty $_.PSPath).DistributionName } |
    Where-Object { $_ })
$packages = @(Get-AppxPackage -Name 'CanonicalGroupLimited.Ubuntu*' |
    Select-Object -ExpandProperty PackageFamilyName)
$terminalUpdates = foreach ($path in $SettingsPath) {
    $terminal = Read-Text $path $utf8
    if (!$terminal.Text) { throw "Windows Terminal settings are missing or empty at $path." }
    try {
        # Windows PowerShell 5.1 rejects comments. Keep a JSONC file intact.
        $settings = ConvertFrom-Json $terminal.Text
    } catch {
        throw "Could not parse the Terminal settings at $path. Review the file in Terminal settings first."
    }
    $changes = @(Update-Terminal $settings $registered $packages)
    if ($changes.Count) {
        Write-Host $path
        foreach ($change in $changes) { Write-Host "  $change" }
        @{
            Path = $path
            Text = ($settings | ConvertTo-Json -Depth 100) + "`r`n"
            Encoding = $terminal.Encoding
            Original = $terminal.Text
        }
    }
}

$profile = Read-Text $ProfilePath ([Text.Encoding]::Default)
$managed = Read-Text $ManagedProfilePath $utf8
$source = Read-Text (Join-Path $PSScriptRoot 'interactive.ps1') $utf8
if (!$source.Text) { throw 'The dotfiles interactive.ps1 is missing or empty.' }
$existingLoader = $profile.Text.Contains($loaderMarker)
$loader = @'
# dotfiles: load interactive PowerShell settings
if ($Host.Name -eq 'ConsoleHost' -and ![Console]::IsInputRedirected) {
    if (Test-Path -LiteralPath '__PROFILE_PATH__' -PathType Leaf) {
        . '__PROFILE_PATH__'
    }
}
'@
$loaderPath = if ($ManagedProfilePath -eq (Join-Path $env:LOCALAPPDATA 'Dotfiles\PowerShell\interactive.ps1')) {
    '$env:LOCALAPPDATA\Dotfiles\PowerShell\interactive.ps1'
} else {
    $ManagedProfilePath
}
$loader = if ($loaderPath.StartsWith('$env:LOCALAPPDATA\')) {
    $loader.Replace("'__PROFILE_PATH__'", '"' + $loaderPath + '"')
} else {
    $loader.Replace('__PROFILE_PATH__', $loaderPath.Replace("'", "''"))
}
if ($existingLoader -and !$profile.Text.Replace("`r`n", "`n").Contains($loader.Replace("`r`n", "`n"))) {
    throw 'This profile has a different dotfiles loader. Review it before syncing.'
}
$profileText = if ($existingLoader) { $profile.Text } else {
    $separator = if ($profile.Text) { "`r`n`r`n" } else { '' }
    $profile.Text + $separator + $loader + "`r`n"
}
$tokens = $null
$parseErrors = $null
[void][Management.Automation.Language.Parser]::ParseInput(
    $profileText, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'The merged PowerShell profile does not parse.' }

if ($enableUserPolicy) { Write-Host 'Set the Windows PowerShell execution policy to RemoteSigned for the current user' }
if (!$existingLoader) { Write-Host "Add a loader to $ProfilePath" }
if ($managed.Text -cne $source.Text) { Write-Host "Install $ManagedProfilePath" }
if (!$Apply) {
    Write-Host 'Preview only. Pass -Apply to write changes.'
    return
}

if ($enableUserPolicy) {
    try {
        Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned -Force
    } catch {
        # The installer's process policy still takes precedence until it exits.
        if ($_.FullyQualifiedErrorId -notlike 'ExecutionPolicyOverride,*' -or
            (Get-ExecutionPolicy -Scope CurrentUser) -ne 'RemoteSigned') { throw }
    }
}
if ($managed.Text -cne $source.Text) { Write-Text $ManagedProfilePath $source.Text $utf8 }
if (!$existingLoader) { Write-Text $ProfilePath $profileText $profile.Encoding }
foreach ($update in $terminalUpdates) {
    if ((Read-Text $update.Path $utf8).Text -cne $update.Original) {
        throw "Terminal settings changed while syncing at $($update.Path). Run the sync again."
    }
    Write-Text $update.Path $update.Text $update.Encoding
}
Write-Host 'Windows Terminal and PowerShell profile sync complete.'
