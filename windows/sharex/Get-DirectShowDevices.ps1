[CmdletBinding()]
param(
  [string]$FFmpegPath,
  [string]$OutputDirectory
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)

Import-Module (Join-Path $PSScriptRoot "ShareXAudio.psm1") -Force

try {
  $ffmpeg = Get-ShareXFfmpegData -FFmpegPath $FFmpegPath
  $data = Get-DirectShowAudioData `
    -FFmpegPath $ffmpeg.Path `
    -OutputDirectory $OutputDirectory
  $result = [pscustomobject]@{
    Ffmpeg = $ffmpeg
    Devices = @($data.Devices)
    EnumerationExitCode = $data.ExitCode
    StdoutPath = $data.StdoutPath
    StderrPath = $data.StderrPath
  }
  [Console]::Out.WriteLine(
    (ConvertTo-ShareXJson -Value (New-ShareXEnvelope `
      -Ok $true -Data $result)))
  exit 0
} catch {
  $errorData = New-ShareXError -Exception $_.Exception
  [Console]::Error.WriteLine($errorData.Message)
  [Console]::Out.WriteLine(
    (ConvertTo-ShareXJson -Value (New-ShareXEnvelope `
      -Ok $false -Data $null -Error $errorData)))
  exit 1
}
