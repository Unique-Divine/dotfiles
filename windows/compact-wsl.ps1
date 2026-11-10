# windows/compact-wsl.ps1
#
# Reclaim unused space from WSL virtual disks (ext4.vhdx).
#
# A WSL disk grows as Linux writes data but never shrinks on its own. This
# script trims free blocks inside each distro, shuts WSL down, and compacts
# each disk with DiskPart. It works on Windows Home (no Hyper-V needed) and
# does not depend on WSL being healthy: if WSL is broken, the trim step is
# skipped and compaction still runs.
#
# Usage (from a normal or admin PowerShell, or double-click compact-wsl.cmd):
#   .\compact-wsl.ps1                 # all Linux distros, asks before shutdown
#   .\compact-wsl.ps1 -DryRun         # list disks and sizes, change nothing
#   .\compact-wsl.ps1 -IncludeDocker  # also compact Docker Desktop disks
#   .\compact-wsl.ps1 -Distro Ubuntu-24.04 -Yes
#
# Target: Windows PowerShell 5.1. Keep this file ASCII-only.

[CmdletBinding()]
param(
  [string[]]$Distro,
  [switch]$IncludeDocker,
  [switch]$DryRun,
  [switch]$SkipTrim,
  [switch]$Yes,
  # Internal: set by the self-elevation relaunch.
  [string[]]$VhdPath,
  [switch]$Elevated
)

$ErrorActionPreference = "Stop"

function Format-GiB([long]$bytes) {
  return "{0:N1} GiB" -f ($bytes / 1GB)
}

function Get-CFreeBytes {
  return (Get-PSDrive C).Free
}

function Test-IsAdmin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($id)
  return $principal.IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
}

# Read registered distros and their disk paths from the registry. This is
# where WSL itself records them, so it works without WSL running.
function Get-WslDisk {
  $root = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss"
  if (-not (Test-Path $root)) { return @() }
  $disks = foreach ($key in Get-ChildItem $root) {
    $p = Get-ItemProperty $key.PSPath
    if (-not $p.BasePath) { continue }
    $base = $p.BasePath -replace '^\\\\\?\\', ''
    $file = if ($p.VhdFileName) { $p.VhdFileName } else { "ext4.vhdx" }
    $path = Join-Path $base $file
    if (-not (Test-Path -LiteralPath $path)) { continue }
    [pscustomobject]@{
      Name     = $p.DistributionName
      Path     = $path
      IsDocker = $p.DistributionName -like "docker-desktop*"
      Bytes    = (Get-Item -LiteralPath $path).Length
    }
  }
  return @($disks)
}

function Select-WslDisk($disks) {
  $picked = $disks | Where-Object { $IncludeDocker -or -not $_.IsDocker }
  if ($Distro) {
    $picked = $picked | Where-Object { $Distro -contains $_.Name }
  }
  return @($picked)
}

function Show-Disk($disks) {
  $disks | Format-Table -AutoSize Name,
    @{ Name = "Size"; Expression = { Format-GiB $_.Bytes } }, Path |
    Out-String | Write-Host
  Write-Host ("C: free: {0}" -f (Format-GiB (Get-CFreeBytes)))
}

# Run fstrim inside a distro so freed Linux blocks become reclaimable.
# Without this, compaction recovers little.
function Invoke-Trim($disk) {
  Write-Host ("Trimming {0} ..." -f $disk.Name)
  & wsl.exe -d $disk.Name -u root -- fstrim -v /
  if ($LASTEXITCODE -ne 0) {
    Write-Warning ("fstrim failed for {0} (exit {1}); compacting anyway." -f
      $disk.Name, $LASTEXITCODE)
  }
}

function Invoke-DiskPart([string[]]$lines) {
  $tmp = [IO.Path]::GetTempFileName()
  try {
    Set-Content -LiteralPath $tmp -Value $lines -Encoding ASCII
    & diskpart.exe /s $tmp | Write-Host
    return $LASTEXITCODE
  } finally {
    Remove-Item -LiteralPath $tmp -ErrorAction SilentlyContinue
  }
}

function Compress-Vhd([string]$path) {
  $before = (Get-Item -LiteralPath $path).Length
  Write-Host ""
  Write-Host ("Compacting {0}" -f $path)
  $select = 'select vdisk file="{0}"' -f $path
  $code = Invoke-DiskPart @($select, "attach vdisk readonly", "compact vdisk")
  # Always detach, even when compaction failed, so WSL can open the disk.
  $null = Invoke-DiskPart @($select, "detach vdisk noerr")
  $after = (Get-Item -LiteralPath $path).Length
  return [pscustomobject]@{
    Path   = $path
    Before = $before
    After  = $after
    Ok     = ($code -eq 0)
  }
}

# --- Elevated phase: shut down WSL and compact the given disks. ------------

function Invoke-Compaction([string[]]$paths) {
  $freeBefore = Get-CFreeBytes
  Write-Host "Shutting down WSL ..."
  & wsl.exe --shutdown
  Start-Sleep -Seconds 5

  $results = foreach ($path in $paths) { Compress-Vhd $path }

  Write-Host ""
  $results | Format-Table -AutoSize `
    @{ Name = "Before"; Expression = { Format-GiB $_.Before } },
    @{ Name = "After"; Expression = { Format-GiB $_.After } },
    @{ Name = "Saved"; Expression = { Format-GiB ($_.Before - $_.After) } },
    Ok, Path | Out-String | Write-Host
  $freeAfter = Get-CFreeBytes
  Write-Host ("C: free: {0} -> {1}" -f (Format-GiB $freeBefore),
    (Format-GiB $freeAfter))
  if ($results | Where-Object { -not $_.Ok }) {
    Write-Warning "DiskPart reported an error for at least one disk."
    return 1
  }
  return 0
}

if ($Elevated) {
  $code = 1
  try {
    $code = Invoke-Compaction $VhdPath
  } catch {
    Write-Host ("ERROR: {0}" -f $_) -ForegroundColor Red
  }
  Read-Host "Done. Press Enter to close"
  exit $code
}

# --- Normal phase: discover, trim, confirm, then elevate. ------------------

$disks = Select-WslDisk (Get-WslDisk)
if ($disks.Count -eq 0) {
  Write-Host "No matching WSL disks found."
  exit 1
}

Write-Host "WSL disks to compact:"
Show-Disk $disks

if ($DryRun) {
  Write-Host "Dry run: nothing changed."
  exit 0
}

if ($disks | Where-Object IsDocker) {
  if (Get-Process -Name "Docker Desktop" -ErrorAction SilentlyContinue) {
    Write-Host "Quit Docker Desktop first; it restarts WSL during compaction."
    exit 1
  }
}

Write-Host ""
Write-Host "This shuts down ALL of WSL: terminals, agents, and servers stop."
if (-not $Yes) {
  $answer = Read-Host "Continue? [y/N]"
  if ($answer -notmatch '^(y|yes)$') {
    Write-Host "Cancelled."
    exit 1
  }
}

if (-not $SkipTrim) {
  foreach ($disk in ($disks | Where-Object { -not $_.IsDocker })) {
    Invoke-Trim $disk
  }
}

$paths = @($disks | ForEach-Object Path)
if (Test-IsAdmin) {
  exit (Invoke-Compaction $paths)
}

# Paths are resolved here and passed along, because an elevated process may
# run as a different account with a different HKCU.
Write-Host "Requesting administrator rights for DiskPart ..."
$quoted = ($paths | ForEach-Object { "'{0}'" -f ($_ -replace "'", "''") }) -join ","
$command = "& '{0}' -Elevated -VhdPath {1}" -f
  ($PSCommandPath -replace "'", "''"), $quoted
# EncodedCommand sidesteps 5.1's unquoted ArgumentList joining.
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
$proc = Start-Process powershell.exe -Verb RunAs -Wait -PassThru -ArgumentList @(
  "-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", $encoded)
exit $proc.ExitCode
