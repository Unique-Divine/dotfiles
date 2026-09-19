[CmdletBinding()]
param(
  [ValidateSet("Console", "Communications", "Multimedia")]
  [string]$Role = "Console",
  [string]$FFmpegPath,
  [ValidateRange(1, 3600)][int]$DurationSeconds = 10,
  [string]$OutputDirectory,
  [switch]$RunCapture
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
  $capture = $null
  if ($RunCapture) {
    if ($null -eq $data.Microphone) {
      throw "The generator selected system-only audio, so a dual-input capture cannot run."
    }
    $capture = Invoke-ShareXAudioProbe `
      -FFmpegPath $data.Ffmpeg.Path `
      -MicrophoneName $data.Microphone.Name `
      -DurationSeconds $DurationSeconds `
      -OutputDirectory $data.OutputDirectory
  }
  $result = [pscustomobject]@{
    Discovery = $data
    Capture = $capture
  }
  $resultPath = Join-Path $data.OutputDirectory "test-result.json"
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
