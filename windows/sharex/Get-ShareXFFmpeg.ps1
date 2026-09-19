[CmdletBinding()]
param(
  [string]$FFmpegPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)

Import-Module (Join-Path $PSScriptRoot "ShareXAudio.psm1") -Force

try {
  $data = Get-ShareXFfmpegData -FFmpegPath $FFmpegPath
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
