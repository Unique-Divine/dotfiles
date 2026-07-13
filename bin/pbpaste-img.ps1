[CmdletBinding()]
param(
  [string]$OutRootWindows,
  [string]$OutRootWsl = $env:PBPASTE_IMG_ROOT_WSL,
  [switch]$WindowsPathToClipboard
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

function Invoke-WslText {
  param([string[]]$Arguments)

  $output = & wsl.exe @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "wsl.exe $($Arguments -join ' ') failed with exit code $LASTEXITCODE"
  }

  return (($output -join "`n").Trim())
}

function Invoke-WslChecked {
  param([string[]]$Arguments)

  & wsl.exe @Arguments | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "wsl.exe $($Arguments -join ' ') failed with exit code $LASTEXITCODE"
  }
}

function Join-WslPath {
  param(
    [string]$Root,
    [string]$Child
  )

  return (($Root.TrimEnd("/", "\")) + "/" + $Child)
}

if ([string]::IsNullOrWhiteSpace($OutRootWsl) -and
    [string]::IsNullOrWhiteSpace($OutRootWindows)) {
  $wslHome = Invoke-WslText -Arguments @("sh", "-lc", 'printf %s "$HOME"')
  $OutRootWsl = Join-WslPath -Root $wslHome -Child ".local/pbpaste-img"
}

$month = Get-Date -Format "yy-MM"
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$fileName = "$timestamp.png"

if (-not [string]::IsNullOrWhiteSpace($OutRootWsl)) {
  $outDirWsl = Join-WslPath -Root $OutRootWsl -Child $month
  Invoke-WslChecked -Arguments @("mkdir", "-p", $outDirWsl)
} else {
  $outDirWsl = $null
}

if ([string]::IsNullOrWhiteSpace($OutRootWindows)) {
  if ([string]::IsNullOrWhiteSpace($outDirWsl)) {
    throw "Either -OutRootWindows or -OutRootWsl must be set."
  }
  $outDirWindows = Invoke-WslText -Arguments @("wslpath", "-w", $outDirWsl)
} else {
  $outDirWindows = Join-Path $OutRootWindows $month
  New-Item -ItemType Directory -Force -Path $outDirWindows | Out-Null
}

$outFileWindows = Join-Path $outDirWindows $fileName

if (-not [string]::IsNullOrWhiteSpace($outDirWsl)) {
  $outFileWsl = Join-WslPath -Root $outDirWsl -Child $fileName
} else {
  $outFileWsl = $null
}

$image = [System.Windows.Forms.Clipboard]::GetImage()
if ($null -eq $image) {
  Write-Error "No bitmap image found on the clipboard."
  exit 1
}

try {
  $image.Save($outFileWindows, [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
  $image.Dispose()
}

if ($WindowsPathToClipboard -or [string]::IsNullOrWhiteSpace($outFileWsl)) {
  $clipboardPath = $outFileWindows
} else {
  $clipboardPath = $outFileWsl
}

Set-Clipboard -Value $clipboardPath
Write-Output $clipboardPath
