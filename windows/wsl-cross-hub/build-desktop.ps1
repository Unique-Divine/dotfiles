[CmdletBinding()]
param(
    [ValidateSet("win-arm64", "win-x64")][string]$RuntimeIdentifier,
    [string]$OutputDirectory,
    [string]$UvExe
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "desktop-package.ps1")

if (!$RuntimeIdentifier) { $RuntimeIdentifier = Get-DesktopRuntime }
if (!$OutputDirectory) {
    $OutputDirectory = Join-Path $desktopStateRoot "build\$RuntimeIdentifier"
}
$output = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $output) { [void](Get-DesktopPackageRuntime $output) }

$dotnet = Get-Command dotnet.exe -CommandType Application -ErrorAction SilentlyContinue
if (!$dotnet) { throw "Install the .NET 10 SDK before building the desktop package." }
$project = Join-Path $PSScriptRoot "desktop\Desktop.csproj"
$files = @(
    "client.cmd", "client.ps1", "desktop-package.ps1", "install-desktop.cmd",
    "install-desktop.ps1", "install-task.cmd", "install-task.ps1", "inventory.cmd",
    "inventory.ps1", "maintenance_plan.py", "maintenance_rehearsal.py",
    "setup_core.py", "status.cmd", "status.ps1",
    "status_core.py", "uninstall-desktop.cmd", "uninstall-desktop.ps1", "worker.py",
    "wsl-cross-hub.cmd", "wsl-cross-hub.ps1"
)
foreach ($file in @("desktop\Desktop.csproj") + $files) {
    if (!(Test-Path -LiteralPath (Join-Path $PSScriptRoot $file) -PathType Leaf)) {
        throw "Desktop package source is missing $file."
    }
}
if (!$UvExe -and $RuntimeIdentifier -eq (Get-DesktopRuntime)) {
    $candidate = Join-Path $PSScriptRoot "runtime\uv.exe"
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { $UvExe = $candidate }
}
if ($UvExe) {
    $UvExe = (Get-Item -LiteralPath $UvExe).FullName
    if ([IO.Path]::GetFileName($UvExe) -ine "uv.exe" -or
        !(Test-Path -LiteralPath $UvExe -PathType Leaf)) {
        throw "Pass a Windows uv.exe using -UvExe."
    }
    $reader = New-Object IO.BinaryReader([IO.File]::OpenRead($UvExe))
    try {
        # COFF machine type follows the PE signature.
        if ($reader.ReadUInt16() -ne 0x5a4d) { throw "uv.exe is not a Windows executable." }
        $reader.BaseStream.Position = 0x3c
        $reader.BaseStream.Position = $reader.ReadUInt32()
        if ($reader.ReadUInt32() -ne 0x4550) { throw "uv.exe has an invalid PE signature." }
        $machine = $reader.ReadUInt16()
        $expected = if ($RuntimeIdentifier -eq "win-arm64") { 0xaa64 } else { 0x8664 }
        if ($machine -ne $expected) { throw "The bundled uv.exe does not target $RuntimeIdentifier." }
    } finally {
        $reader.Dispose()
    }
}

$stage = New-DesktopSibling $output "publish"
$artifacts = New-DesktopSibling $output "artifacts"
$backup = New-DesktopSibling $output "previous"
try {
    & $dotnet.Source publish $project -c Release -r $RuntimeIdentifier --self-contained true `
        --artifacts-path $artifacts -o $stage | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "Desktop publish failed for $RuntimeIdentifier." }
    if (!(Test-Path -LiteralPath (Join-Path $stage $desktopExeName) -PathType Leaf)) {
        throw "Desktop publish did not produce $desktopExeName."
    }
    foreach ($file in $files) {
        [IO.File]::Copy((Join-Path $PSScriptRoot $file), (Join-Path $stage $file))
    }
    if ($UvExe) {
        [void][IO.Directory]::CreateDirectory((Join-Path $stage "runtime"))
        [IO.File]::Copy($UvExe, (Join-Path $stage "runtime\uv.exe"))
    }
    @{ product = "WSL Cross Hub Desktop"; schemaVersion = 1; runtimeIdentifier = $RuntimeIdentifier } |
        ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $stage $desktopMarker) -Encoding ASCII
    if (Test-Path -LiteralPath $output) {
        [void](Get-DesktopPackageRuntime $output)
        [IO.Directory]::Move($output, $backup)
    }
    try { [IO.Directory]::Move($stage, $output) }
    catch {
        if (Test-Path -LiteralPath $backup) { [IO.Directory]::Move($backup, $output) }
        throw
    }
    Clear-DesktopScratch $backup
    Write-Host "Published WSL Cross Hub desktop ($RuntimeIdentifier) to $output."
} finally {
    Clear-DesktopScratch $stage
    Clear-DesktopScratch $artifacts
}
