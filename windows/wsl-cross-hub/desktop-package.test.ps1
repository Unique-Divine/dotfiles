# Exercise the real Windows shortcut and directory operations in a temp folder.

$ErrorActionPreference = "Stop"
$scratchBase = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { $env:TEMP }
$temp = Join-Path $scratchBase ("cross hub packaging " + [Guid]::NewGuid().ToString("N"))
$originalLocalAppData = $env:LOCALAPPDATA
try {
    $env:LOCALAPPDATA = Join-Path $temp "profile"
    . (Join-Path $PSScriptRoot "desktop-package.ps1")
    $package = Join-Path $temp "package"
    $install = Join-Path $temp "installed app"
    $programs = Join-Path $temp "program links"
    $exe = Join-Path $install $desktopExeName
    [void][IO.Directory]::CreateDirectory($package)
    $settingsPath = Join-Path $desktopStateRoot "desktop-settings.json"
    [void][IO.Directory]::CreateDirectory($desktopStateRoot)
    $rid = Get-DesktopRuntime
    @{ product = "WSL Cross Hub Desktop"; schemaVersion = 1; runtimeIdentifier = $rid } |
        ConvertTo-Json | Set-Content -LiteralPath (Join-Path $package $desktopMarker) -Encoding ASCII
    Add-Type -TypeDefinition @"
public static class PackageTestApp
{
    public static int Main(string[] args)
    {
        return args.Length == 1 && args[0] == "--self-test" ? 0 : 9;
    }
}
"@ -OutputAssembly (Join-Path $package $desktopExeName) -OutputType WindowsApplication
    'Write-Output ''{"runtime":{"state":"ready"}}''' |
        Set-Content -LiteralPath (Join-Path $package "wsl-cross-hub.ps1")
    'initial package' | Set-Content -LiteralPath (Join-Path $package "status.ps1")
    '@exit /b' | Set-Content -LiteralPath (Join-Path $package "status.cmd")
    $script:desktopShell = New-Object -ComObject WScript.Shell
    $links = @(Get-DesktopShortcuts $programs)
    $options = @{ InstallDirectory = $install; ProgramsDirectory = $programs }
    $installer = Join-Path $PSScriptRoot "install-desktop.ps1"
    $uninstaller = Join-Path $PSScriptRoot "uninstall-desktop.ps1"

    & $installer -PackagePath $package -NoLaunch @options
    if (!(Test-Path -LiteralPath $exe) -or !(Test-DesktopShortcut $links[0] $exe) -or
        !(Test-DesktopShortcut $links[1] $exe)) {
        $paths = foreach ($link in $links) {
            $target = $script:desktopShell.CreateShortcut($link.Path)
            "$($link.Path) -> $($target.TargetPath) $($target.Arguments)"
        }
        throw ("Initial install did not create the app and both owned shortcuts for $exe. " +
            ($paths -join "; "))
    }

    '{"startupEnabled":false}' | Set-Content -LiteralPath $settingsPath -Encoding ASCII
    'updated package' | Set-Content -LiteralPath (Join-Path $package "status.ps1")
    & $installer -PackagePath $package -NoLaunch @options
    if ((Get-Content -LiteralPath (Join-Path $install "status.ps1")) -ne "updated package" -or
        !(Test-DesktopShortcut $links[0] $exe) -or (Test-Path -LiteralPath $links[1].Path)) {
        throw "Update did not publish the new files and honor disabled startup."
    }

    [IO.Directory]::Delete((Split-Path -Parent $links[1].Path))
    [IO.File]::WriteAllText((Split-Path -Parent $links[1].Path), "blocks shortcut creation")
    '{"startupEnabled":true}' | Set-Content -LiteralPath $settingsPath -Encoding ASCII
    'should be rolled back' | Set-Content -LiteralPath (Join-Path $package "status.ps1")
    $failed = $false
    try { & $installer -PackagePath $package -NoLaunch @options }
    catch { $failed = $true }
    if (!$failed -or (Get-Content -LiteralPath (Join-Path $install "status.ps1")) -ne "updated package" -or
        !(Test-DesktopShortcut $links[0] $exe)) {
        throw "Failed update did not restore the previous release and shortcut."
    }
    [IO.File]::Delete((Split-Path -Parent $links[1].Path))

    Set-DesktopShortcut $links[1] $env:ComSpec
    try {
        & $installer -PackagePath $package -NoLaunch @options
        throw "Install did not refuse the foreign shortcut."
    } catch {
        if ($_.Exception.Message -notlike "A shortcut at * belongs to another program.") { throw }
    }
    if (!(Test-DesktopShortcut $links[1] $env:ComSpec)) {
        throw "Install modified a foreign shortcut."
    }

    & $uninstaller @options
    if ((Test-Path -LiteralPath $install) -or (Test-Path -LiteralPath $links[0].Path) -or
        !(Test-DesktopShortcut $links[1] $env:ComSpec) -or !(Test-Path -LiteralPath $settingsPath)) {
        throw "Uninstall did not remove only the owned files and shortcuts."
    }
    Write-Host "Desktop install, update, rollback, collision, and uninstall checks passed."
} finally {
    $env:LOCALAPPDATA = $originalLocalAppData
    if ([IO.Directory]::Exists($temp)) { [IO.Directory]::Delete($temp, $true) }
}
