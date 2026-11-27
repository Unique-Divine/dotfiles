[CmdletBinding()]
param(
    [string]$PackagePath,
    [string]$InstallDirectory,
    [string]$ProgramsDirectory,
    [switch]$NoLaunch
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "desktop-package.ps1")

function Initialize-DesktopPython([string]$Package) {
    $powerShell = Join-Path $PSHOME "powershell.exe"
    $doctor = Join-Path $Package "wsl-cross-hub.ps1"
    $report = & $powerShell -NoProfile -NonInteractive -ExecutionPolicy Bypass `
        -File $doctor | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0) {
        throw "Could not check the Windows Python runtime."
    }
    if ($report.runtime.state -eq "ready") { return }

    $uv = Join-Path $Package "runtime\uv.exe"
    if (!(Test-Path -LiteralPath $uv -PathType Leaf)) {
        $uv = (Get-Command uv.exe -CommandType Application -ErrorAction SilentlyContinue).Source
    }
    if (!$uv) { $uv = Join-Path $desktopStateRoot "runtime\uv.exe" }
    if (!(Test-Path -LiteralPath $uv -PathType Leaf)) {
        Write-Warning "Windows uv.exe is unavailable. Install uv or use a bundled package for Python-backed features."
        return
    }
    & $uv --no-config python install --managed-python --no-bin 3.13 | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "uv could not install native Windows Python 3.13." }
}

function Test-DesktopExecutable([string]$Path) {
    $process = Start-Process -FilePath $Path -ArgumentList "--self-test" -PassThru
    try {
        if (!$process.WaitForExit(15000)) {
            if (!$process.HasExited) { $process.Kill() }
            throw "The staged desktop self-test timed out."
        }
        if ($process.ExitCode -ne 0) {
            throw "The staged desktop self-test failed with exit code $($process.ExitCode)."
        }
    } finally {
        $process.Dispose()
    }
}

if ($InstallDirectory -and (!$NoLaunch -or !$ProgramsDirectory)) {
    throw "A custom install directory requires -NoLaunch and -ProgramsDirectory."
}
$installRoot = if ($InstallDirectory) { [IO.Path]::GetFullPath($InstallDirectory) } else { $desktopInstallRoot }
$nativeRuntime = Get-DesktopRuntime
if (!$PackagePath) {
    if (Test-Path -LiteralPath (Join-Path $PSScriptRoot $desktopMarker)) {
        $PackagePath = $PSScriptRoot
    } else {
        $PackagePath = Join-Path $desktopStateRoot "build\$nativeRuntime"
        & (Join-Path $PSScriptRoot "build-desktop.ps1") -OutputDirectory $PackagePath
    }
}
$package = [IO.Path]::GetFullPath($PackagePath)
$runtime = Get-DesktopPackageRuntime $package
if ($runtime -ne $nativeRuntime) {
    throw "Package targets $runtime. Use a $nativeRuntime package on this machine."
}
foreach ($file in @($desktopExeName, "status.ps1", "status.cmd", "wsl-cross-hub.ps1")) {
    if (!(Test-Path -LiteralPath (Join-Path $package $file) -PathType Leaf)) {
        throw "The desktop package is missing $file."
    }
}

Protect-DesktopInstall {
    if (Test-Path -LiteralPath $installRoot) {
        [void](Get-DesktopPackageRuntime $installRoot)
    }
    $exe = Join-Path $installRoot $desktopExeName
    $script:desktopShell = New-Object -ComObject WScript.Shell
    $links = @(Get-DesktopShortcuts $ProgramsDirectory)
    $originals = @{}
    foreach ($link in $links) {
        if (!(Test-Path -LiteralPath $link.Path)) { continue }
        if (!(Test-DesktopShortcut $link $exe)) {
            throw "A shortcut at $($link.Path) belongs to another program."
        }
        $originals[$link.Path] = [IO.File]::ReadAllBytes($link.Path)
    }
    $settingsPath = Join-Path $desktopStateRoot "desktop-settings.json"
    $startupEnabled = $true
    if (Test-Path -LiteralPath $settingsPath -PathType Leaf) {
        $settings = Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json
        if ($settings.startupEnabled -is [bool]) { $startupEnabled = $settings.startupEnabled }
    }
    Initialize-DesktopPython $package

    $stage = New-DesktopSibling $installRoot "install"
    $backup = New-DesktopSibling $installRoot "previous"
    $wasRunning = $false
    $swapped = $false
    try {
        [void][IO.Directory]::CreateDirectory($stage)
        Get-ChildItem -LiteralPath $package -Force |
            Copy-Item -Destination $stage -Recurse -Force
        Test-DesktopExecutable (Join-Path $stage $desktopExeName)
        $wasRunning = Stop-DesktopProcess $exe
        if (Test-Path -LiteralPath $installRoot) { [IO.Directory]::Move($installRoot, $backup) }
        [IO.Directory]::Move($stage, $installRoot)
        $swapped = $true
        foreach ($link in $links) {
            if ($link.Arguments -eq "--show" -or $startupEnabled) {
                Set-DesktopShortcut $link $exe
            } elseif (Test-DesktopShortcut $link $exe) {
                [IO.File]::Delete($link.Path)
            }
        }
        if (!$NoLaunch) { Start-Process -FilePath $exe -ArgumentList "--tray" }
    } catch {
        $failure = $_
        if ($swapped) {
            Restore-DesktopShortcuts $links $originals $exe
            [IO.Directory]::Move($installRoot, $stage)
        }
        if (Test-Path -LiteralPath $backup) { [IO.Directory]::Move($backup, $installRoot) }
        if ($wasRunning -and (Test-Path -LiteralPath $exe)) {
            Start-Process -FilePath $exe -ArgumentList "--tray"
        }
        throw $failure
    } finally {
        Clear-DesktopScratch $stage
    }
    Clear-DesktopScratch $backup
    Write-Host "Installed WSL Cross Hub desktop to $installRoot."
}
