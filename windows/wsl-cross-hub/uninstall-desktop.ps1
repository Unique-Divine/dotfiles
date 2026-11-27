[CmdletBinding()]
param(
    [string]$InstallDirectory,
    [string]$ProgramsDirectory
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "desktop-package.ps1")

if ($InstallDirectory -and !$ProgramsDirectory) {
    throw "A custom install directory requires -ProgramsDirectory."
}
$installRoot = if ($InstallDirectory) { [IO.Path]::GetFullPath($InstallDirectory) } else { $desktopInstallRoot }
$exe = Join-Path $installRoot $desktopExeName

Protect-DesktopInstall {
    $installed = Test-Path -LiteralPath $installRoot
    if ($installed) { [void](Get-DesktopPackageRuntime $installRoot) }
    $script:desktopShell = New-Object -ComObject WScript.Shell
    $links = @(Get-DesktopShortcuts $ProgramsDirectory)
    $originals = @{}
    foreach ($link in $links) {
        if (!(Test-Path -LiteralPath $link.Path)) { continue }
        if (Test-DesktopShortcut $link $exe) {
            $originals[$link.Path] = [IO.File]::ReadAllBytes($link.Path)
        } else {
            Write-Warning "Kept shortcut owned by another program at $($link.Path)."
        }
    }
    $removed = if ($installed) { New-DesktopSibling $installRoot "uninstall" }
    $wasRunning = Stop-DesktopProcess $exe
    try {
        if ($installed) { [IO.Directory]::Move($installRoot, $removed) }
        foreach ($path in $originals.Keys) { [IO.File]::Delete($path) }
    } catch {
        $failure = $_
        if ($removed -and (Test-Path -LiteralPath $removed)) {
            [IO.Directory]::Move($removed, $installRoot)
        }
        foreach ($path in $originals.Keys) { [IO.File]::WriteAllBytes($path, $originals[$path]) }
        if ($wasRunning) { Start-Process -FilePath $exe -ArgumentList "--tray" }
        throw $failure
    }
    if ($removed) { Clear-DesktopScratch $removed }
    Write-Host "Uninstalled the WSL Cross Hub desktop. Kept state in $desktopStateRoot."
}
