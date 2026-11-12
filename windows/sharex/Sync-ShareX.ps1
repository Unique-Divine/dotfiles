[CmdletBinding()]
param([switch]$Check)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'ShareXAudio.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'ShareXSync.psm1') -Force

try {
  $executables = @(
    (Join-Path $env:ProgramFiles 'ShareX\ShareX.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'ShareX\ShareX.exe')
  )
  $executable = $executables | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
    Select-Object -First 1
  if (-not $executable) {
    Write-Output 'ShareX is not installed; skipping.'
    exit 0
  }
  $configPath = Get-ShareXConfigPath
  if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    throw "ShareX config is missing: $configPath. Start ShareX once before syncing."
  }
  $audio = New-ShareXAudioCommandData -FFmpegPath (Join-Path (Split-Path $executable) 'ffmpeg.exe')
  if ($null -eq $audio.Microphone -or
      -not @($audio.DirectShowDevices | Where-Object { $_.Name -eq 'virtual-audio-capturer' }).Count) {
    throw 'Two-way audio requires virtual-audio-capturer and a detected microphone.'
  }
  $managedPath = Join-Path $PSScriptRoot 'ManagedHotkeys.json'
  function Get-Plan {
    $config = Read-ShareXJsonFile -Path $configPath
    $managed = Read-ShareXJsonFile -Path $managedPath
    return Merge-ShareXManagedHotkeys -Config $config -Managed $managed -AudioCommand $audio.Command
  }
  $plan = Get-Plan
  if (-not $plan.Changed) {
    Write-Output 'ShareX managed hotkeys are up to date.'
    exit 0
  }
  if ($Check) {
    Write-Output 'ShareX managed hotkeys need updating.'
    exit 1
  }
  $running = @(Get-Process ShareX -ErrorAction SilentlyContinue)
  $wasRunning = $running.Count -gt 0
  try {
    if ($wasRunning) {
      $running | Stop-Process -Force -ErrorAction Stop
      $running | Wait-Process -ErrorAction SilentlyContinue
      # ShareX may have written settings before it stopped.
      $plan = Get-Plan
    }
    if ($plan.Changed) {
      $backup = Backup-ShareXConfig -ConfigPath $configPath
      Write-ShareXConfigAtomic -Path $configPath `
        -Content (ConvertTo-ShareXJson -Value $plan.Config -Pretty)
      Write-Output "Updated ShareX hotkeys. Backup: $backup"
    }
  } finally {
    if ($wasRunning) { Start-Process -FilePath $executable }
  }
} catch {
  [Console]::Error.WriteLine("ShareX sync: $($_.Exception.Message)")
  exit 1
}
