[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$modulePath = Join-Path $PSScriptRoot "..\ShareXAudio.psm1"
$fixturePath = Join-Path $PSScriptRoot "..\HotkeysConfig.json"
Import-Module $modulePath -Force

$testCount = 0

function Assert-True {
  param(
    [Parameter(Mandatory = $true)][bool]$Condition,
    [Parameter(Mandatory = $true)][string]$Message
  )

  $script:testCount++
  if (-not $Condition) {
    throw "FAIL: $Message"
  }
  Write-Output "PASS: $Message"
}

function Assert-Equal {
  param(
    [Parameter(Mandatory = $true)][object]$Expected,
    [Parameter(Mandatory = $true)][object]$Actual,
    [Parameter(Mandatory = $true)][string]$Message
  )

  Assert-True `
    -Condition ($Expected -eq $Actual) `
    -Message "$Message (expected '$Expected', got '$Actual')"
}

function Assert-Throws {
  param(
    [Parameter(Mandatory = $true)][scriptblock]$Script,
    [Parameter(Mandatory = $true)][string]$Message
  )

  $threw = $false
  try {
    & $Script
  } catch {
    $threw = $true
  }
  Assert-True -Condition $threw -Message $Message
}

try {
  $dualCommand = New-ShareXDualAudioCommand -MicrophoneName "Test Mic"
  Assert-True `
    -Condition ($dualCommand.Contains('audio="virtual-audio-capturer"')) `
    -Message "dual command includes the system source"
  Assert-True `
    -Condition ($dualCommand.Contains('audio="Test Mic"')) `
    -Message "dual command includes the microphone source"
  Assert-True `
    -Condition ($dualCommand.Contains('amix=inputs=2')) `
    -Message "dual command mixes both inputs"
  Assert-True `
    -Condition ($dualCommand.Contains('"$output$"')) `
    -Message "dual command uses ShareX output substitution"
  Assert-Throws `
    -Script { New-ShareXDualAudioCommand -MicrophoneName 'Bad " Mic' } `
    -Message "microphone names containing quotes are rejected"

  $endpoint = [pscustomobject]@{
    FriendlyName = "Default Mic"
    DeviceGuid = "a44c1905-ea7e-44ff-82d0-79cfc0929a8e"
  }
  $devices = @(
    [pscustomobject]@{
      Name = "virtual-audio-capturer"
      AlternativeName = $null
    },
    [pscustomobject]@{
      Name = "Default Mic"
      AlternativeName = "wave_{A44C1905-EA7E-44FF-82D0-79CFC0929A8E}"
    }
  )
  $resolution = Resolve-ShareXMicrophone `
    -DefaultEndpoint $endpoint `
    -Devices $devices
  Assert-Equal -Expected "FriendlyName" `
    -Actual $resolution.SelectionMethod `
    -Message "microphone resolution prefers an exact friendly name"

  $guidEndpoint = [pscustomobject]@{
    FriendlyName = "Windows Friendly Name"
    DeviceGuid = $endpoint.DeviceGuid
  }
  $guidResolution = Resolve-ShareXMicrophone `
    -DefaultEndpoint $guidEndpoint `
    -Devices @($devices[0], $devices[1])
  Assert-Equal -Expected "DeviceGuid" `
    -Actual $guidResolution.SelectionMethod `
    -Message "microphone resolution falls back to the device GUID"

  $noMic = Resolve-ShareXMicrophone `
    -DefaultEndpoint $endpoint `
    -Devices @($devices[0])
  Assert-Equal -Expected "NoMicrophone" `
    -Actual $noMic.Status `
    -Message "system-only devices produce a deliberate no-microphone result"

  Assert-Throws `
    -Script {
      Resolve-ShareXMicrophone `
        -DefaultEndpoint $guidEndpoint `
        -Devices @(
          [pscustomobject]@{ Name = "Mic A"; AlternativeName = $null },
          [pscustomobject]@{ Name = "Mic B"; AlternativeName = $null }
        )
    } `
    -Message "ambiguous microphone matches are rejected"

  $fixture = Read-ShareXJsonFile -Path $fixturePath
  $merge = Merge-ShareXAudioHotkey `
    -Config $fixture `
    -Description "Audio Virtual Record" `
    -Command $dualCommand
  Assert-Equal -Expected 2 `
    -Actual $merge.ChangedFields.Count `
    -Message "fixture merge changes only the two fields that differ"
  $options = $merge.Config.Hotkeys[0].TaskSettings.CaptureSettings.FFmpegOptions
  Assert-True `
    -Condition $options.UseCustomCommands `
    -Message "fixture merge enables custom commands"
  Assert-Equal -Expected $dualCommand `
    -Actual $options.CustomCommands `
    -Message "fixture merge stores the generated command"
  Assert-Equal -Expected "ScreenRecorderActiveWindow" `
    -Actual $merge.Config.Hotkeys[0].TaskSettings.Job `
    -Message "fixture merge preserves the selected hotkey job"

  Assert-Throws `
    -Script {
      Merge-ShareXAudioHotkey `
        -Config (Read-ShareXJsonFile -Path $fixturePath) `
        -Description "Missing target" `
        -Command $dualCommand
    } `
    -Message "installer refuses an unknown target"

  $tempDirectory = Join-Path ([IO.Path]::GetTempPath()) `
    ("ShareXAudioTests-" + [guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Path $tempDirectory | Out-Null
  try {
    $tempConfigPath = Join-Path $tempDirectory "HotkeysConfig.json"
    Write-ShareXUtf8NoBom `
      -Path $tempConfigPath `
      -Content (ConvertTo-ShareXJson -Value $merge.Config -Pretty)
    $rewritten = Read-ShareXJsonFile -Path $tempConfigPath
    Assert-Equal -Expected $dualCommand `
      -Actual $rewritten.Hotkeys[0].TaskSettings.CaptureSettings.FFmpegOptions.CustomCommands `
      -Message "written JSON can be read back"
    Write-ShareXConfigAtomic `
      -Path $tempConfigPath `
      -Content (ConvertTo-ShareXJson -Value $fixture -Pretty)
    $atomic = Read-ShareXJsonFile -Path $tempConfigPath
    Assert-Equal -Expected "virtual-audio-capturer" `
      -Actual $atomic.Hotkeys[0].TaskSettings.CaptureSettings.FFmpegOptions.AudioSource `
      -Message "atomic config replacement preserves valid JSON"

    $powershell = Get-Command powershell.exe -ErrorAction SilentlyContinue
    if ($null -ne $powershell) {
      $probeDirectory = Join-Path $tempDirectory "probe"
      $probeMessage = ""
      try {
        Invoke-ShareXAudioProbe `
          -FFmpegPath $powershell.Source `
          -MicrophoneName "Test Mic" `
          -DurationSeconds 1 `
          -OutputDirectory $probeDirectory | Out-Null
      } catch {
        $probeMessage = $_.Exception.Message
      }
      Assert-True `
        -Condition ($probeMessage -like "*system.stderr.log*") `
        -Message "capture probe reports failed FFmpeg processes with a log path"
    }
  } finally {
    Remove-Item -LiteralPath $tempDirectory -Recurse -Force
  }

  Write-Output "PASS: $testCount ShareX audio tests"
  exit 0
} catch {
  Write-Error $_.Exception.Message
  exit 1
}
