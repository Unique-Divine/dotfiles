[CmdletBinding(DefaultParameterSetName = "Description")]
param(
  [Parameter(Mandatory = $true, ParameterSetName = "Description")]
  [string]$Description,
  [Parameter(Mandatory = $true, ParameterSetName = "Hotkey")]
  [string]$Hotkey,
  [ValidateSet("Console", "Communications", "Multimedia")]
  [string]$Role = "Console",
  [string]$FFmpegPath,
  [string]$ConfigPath,
  [string]$BackupDirectory,
  [string]$OutputDirectory,
  [switch]$Apply
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)

Import-Module (Join-Path $PSScriptRoot "ShareXAudio.psm1") -Force

try {
  $configPath = Get-ShareXConfigPath -ConfigPath $ConfigPath
  $commandData = New-ShareXAudioCommandData `
    -Role $Role `
    -FFmpegPath $FFmpegPath `
    -OutputDirectory $OutputDirectory
  $config = Read-ShareXJsonFile -Path $configPath
  $merge = Merge-ShareXAudioHotkey `
    -Config $config `
    -Description $Description `
    -Hotkey $Hotkey `
    -Command $commandData.Command
  $after = ConvertTo-ShareXJson -Value $merge.Config -Pretty
  $before = Get-Content -LiteralPath $configPath -Raw
  $backupPath = $null
  $applied = $false
  if ($Apply -and $merge.ChangedFields.Count -gt 0) {
    $backupPath = Backup-ShareXConfig `
      -ConfigPath $configPath `
      -BackupDirectory $BackupDirectory
    Write-ShareXConfigAtomic -Path $configPath -Content $after
    $applied = $true
  }
  $result = [pscustomobject]@{
    Applied = $applied
    DryRun = -not $Apply
    ConfigPath = $configPath
    BackupPath = $backupPath
    Target = $merge.Target
    ChangedFields = @($merge.ChangedFields)
    BeforeLength = $before.Length
    AfterLength = $after.Length
    GeneratedCommand = $commandData.Command
    CommandData = $commandData
  }
  $resultPath = Join-Path $commandData.OutputDirectory "install-result.json"
  $result | Add-Member -NotePropertyName ResultPath -NotePropertyValue $resultPath
  Write-ShareXUtf8NoBom `
    -Path $resultPath `
    -Content (ConvertTo-ShareXJson -Value $result -Pretty)
  [Console]::Out.WriteLine(
    (ConvertTo-ShareXJson -Value (New-ShareXEnvelope -Ok $true -Data $result)))
  exit 0
} catch {
  $errorData = New-ShareXError -Exception $_.Exception
  [Console]::Error.WriteLine($errorData.Message)
  [Console]::Out.WriteLine(
    (ConvertTo-ShareXJson -Value (New-ShareXEnvelope `
      -Ok $false -Data $null -Error $errorData)))
  exit 1
}
