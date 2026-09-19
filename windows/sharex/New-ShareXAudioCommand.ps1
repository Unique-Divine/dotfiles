[CmdletBinding()]
param(
  [ValidateSet("Console", "Communications", "Multimedia")]
  [string]$Role = "Console",
  [string]$FFmpegPath,
  [string]$OutputDirectory
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)

Import-Module (Join-Path $PSScriptRoot "ShareXAudio.psm1") -Force

try {
  $data = New-ShareXAudioCommandData `
    -Role $Role `
    -FFmpegPath $FFmpegPath `
    -OutputDirectory $OutputDirectory
  $resultPath = Join-Path $data.OutputDirectory "result.json"
  $data | Add-Member -NotePropertyName ResultPath -NotePropertyValue $resultPath
  Write-ShareXUtf8NoBom `
    -Path $resultPath `
    -Content (ConvertTo-ShareXJson -Value $data -Pretty)
  [Console]::Out.WriteLine(
    (ConvertTo-ShareXJson -Value (New-ShareXEnvelope -Ok $true -Data $data)))
  exit 0
} catch {
  $errorData = New-ShareXError -Exception $_.Exception
  [Console]::Error.WriteLine($errorData.Message)
  [Console]::Out.WriteLine(
    (ConvertTo-ShareXJson -Value (New-ShareXEnvelope `
      -Ok $false -Data $null -Error $errorData)))
  exit 1
}
