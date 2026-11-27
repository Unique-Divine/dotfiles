# Shared ownership checks for the desktop build, install, and uninstall.

$desktopExeName = "wsl-cross-hub-desktop.exe"
$desktopMarker = ".wsl-cross-hub-desktop.json"
$desktopLinkName = "WSL Cross Hub.lnk"
$desktopInstallRoot = Join-Path $env:LOCALAPPDATA "Programs\WslCrossHub"
$desktopStateRoot = Join-Path $env:LOCALAPPDATA "WslCrossHub"

function Get-DesktopRuntime {
    $architecture = $env:PROCESSOR_ARCHITEW6432
    if (!$architecture) { $architecture = $env:PROCESSOR_ARCHITECTURE }
    switch ($architecture) {
        "ARM64" { "win-arm64" }
        "AMD64" { "win-x64" }
        default { throw "Unsupported Windows architecture: $architecture." }
    }
}

function Assert-DesktopOrdinaryPath([string]$Path) {
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    if ($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "Refusing to modify a symlink or junction: $Path."
    }
}

function Get-DesktopPackageRuntime([string]$Root) {
    Assert-DesktopOrdinaryPath $Root
    $marker = Join-Path $Root $desktopMarker
    Assert-DesktopOrdinaryPath $marker
    if (!(Test-Path -LiteralPath $marker -PathType Leaf)) {
        throw "Directory has no WSL Cross Hub desktop marker: $Root."
    }
    $package = Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json
    if ($package.product -cne "WSL Cross Hub Desktop" -or
        $package.schemaVersion -ne 1 -or
        $package.runtimeIdentifier -cnotin @("win-arm64", "win-x64")) {
        throw "Unrecognized WSL Cross Hub desktop package marker: $marker."
    }
    return $package.runtimeIdentifier
}

function New-DesktopSibling([string]$Path, [string]$Purpose) {
    $parent = Split-Path -Parent $Path
    Assert-DesktopOrdinaryPath $parent
    [void][IO.Directory]::CreateDirectory($parent)
    Join-Path $parent (".cross-hub-" + $Purpose + "-" + [Guid]::NewGuid().ToString("N"))
}

function Clear-DesktopScratch([string]$Path) {
    if ([IO.Directory]::Exists($Path)) {
        try { [IO.Directory]::Delete($Path, $true) }
        catch { Write-Warning "Could not remove desktop scratch directory $Path. $_" }
    }
}

function Get-DesktopShortcuts([string]$ProgramsDirectory) {
    if ($ProgramsDirectory) {
        $programs = [IO.Path]::GetFullPath($ProgramsDirectory)
        $startup = Join-Path $programs "Startup"
    } else {
        $programs = [Environment]::GetFolderPath([Environment+SpecialFolder]::Programs)
        $startup = [Environment]::GetFolderPath([Environment+SpecialFolder]::Startup)
    }
    if (!$programs -or !$startup) { throw "Windows did not return its shortcut directories." }
    @{ Path = (Join-Path $programs $desktopLinkName); Arguments = "--show" }
    @{ Path = (Join-Path $startup $desktopLinkName); Arguments = "--tray" }
}

function Test-DesktopShortcut($Link, [string]$Exe) {
    Assert-DesktopOrdinaryPath $Link.Path
    if (!(Test-Path -LiteralPath $Link.Path)) { return $false }
    $shortcut = $script:desktopShell.CreateShortcut($Link.Path)
    return $shortcut.TargetPath -ieq $Exe -and $shortcut.Arguments -ceq $Link.Arguments
}

function Set-DesktopShortcut($Link, [string]$Exe) {
    $directory = Split-Path -Parent $Link.Path
    Assert-DesktopOrdinaryPath $directory
    [void][IO.Directory]::CreateDirectory($directory)
    $shortcut = $script:desktopShell.CreateShortcut($Link.Path)
    $shortcut.TargetPath = $Exe
    $shortcut.Arguments = $Link.Arguments
    $shortcut.WorkingDirectory = Split-Path -Parent $Exe
    $shortcut.Description = "WSL Cross Hub"
    $shortcut.Save()
}

function Restore-DesktopShortcuts($Links, $Originals, [string]$Exe) {
    foreach ($link in $Links) {
        if ($Originals.ContainsKey($link.Path)) {
            [IO.File]::WriteAllBytes($link.Path, $Originals[$link.Path])
        } elseif (Test-DesktopShortcut $link $Exe) {
            [IO.File]::Delete($link.Path)
        }
    }
}

function Stop-DesktopProcess([string]$Exe) {
    $processes = @(Get-Process -Name "wsl-cross-hub-desktop" -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -ieq $Exe })
    if (!$processes) { return $false }
    $command = Start-Process -FilePath $Exe -ArgumentList "--quit" -PassThru
    if (!$command.WaitForExit(5000) -or $command.ExitCode -ne 0) {
        throw "The installed desktop app did not accept its quit command."
    }
    foreach ($process in $processes) {
        if (!$process.WaitForExit(5000)) {
            throw "The installed desktop app did not exit. Install files were left intact."
        }
    }
    return $true
}

function Protect-DesktopInstall([scriptblock]$Action) {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $mutex = New-Object Threading.Mutex($false, ("Global\WslCrossHubInstall-" + $identity.User.Value))
    $held = $false
    try {
        try { $held = $mutex.WaitOne(0) }
        catch [Threading.AbandonedMutexException] { $held = $true }
        if (!$held) { throw "Another WSL Cross Hub desktop install or uninstall is running." }
        & $Action
    } finally {
        if ($held) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}
