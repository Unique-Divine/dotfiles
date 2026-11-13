Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot '..\ShareXSync.psm1') -Force
$managedPath = Join-Path $PSScriptRoot '..\ManagedHotkeys.json'
function Managed { Get-Content -Raw $managedPath | ConvertFrom-Json }
function Assert($condition, $message) { if (-not $condition) { throw $message } }

$config = [pscustomobject]@{ Hotkeys = @(); Other = 'preserved' }
$first = Merge-ShareXManagedHotkeys -Config $config -Managed (Managed) -AudioCommand 'dual audio'
Assert $first.Changed 'First sync should change the configuration.'
Assert ($config.Hotkeys.Count -eq 4) 'First sync should create four hotkeys.'
Assert ($config.Other -eq 'preserved') 'Unmanaged configuration must survive.'
$second = Merge-ShareXManagedHotkeys -Config $config -Managed (Managed) -AudioCommand 'dual audio'
Assert (-not $second.Changed) 'Second sync should be idempotent.'
$config.Hotkeys[1].HotkeyInfo.Hotkey = 'F5'
$config.Hotkeys[1].TaskSettings | Add-Member -NotePropertyName Unmanaged -NotePropertyValue 'keep'
$third = Merge-ShareXManagedHotkeys -Config $config -Managed (Managed) -AudioCommand 'dual audio'
Assert $third.Changed 'Drift should be corrected.'
Assert (@($config.Hotkeys | Where-Object { $_.HotkeyInfo.Hotkey -eq 'Home, Shift' }).Count -eq 1) 'Video shortcut should be restored.'
Assert ($config.Hotkeys[1].HotkeyInfo.Hotkey -eq 'F5') 'Another shortcut for the same job must survive.'
Assert ($config.Hotkeys[1].TaskSettings.Unmanaged -eq 'keep') 'Unmanaged fields must survive.'
$config.Hotkeys += [pscustomobject]@{
  HotkeyInfo = [pscustomobject]@{ Hotkey = 'F8'; Win = $false }
  TaskSettings = [pscustomobject]@{ Job = 'Other' }
}
$preserved = Merge-ShareXManagedHotkeys -Config $config -Managed (Managed) -AudioCommand 'dual audio'
Assert (-not $preserved.Changed) 'Unrelated shortcuts must be preserved.'
$config.Hotkeys = @($config.Hotkeys | Where-Object { $_.TaskSettings.Job -ne 'Other' })
$config.Hotkeys += [pscustomobject]@{
  HotkeyInfo = [pscustomobject]@{ Hotkey = 'F2, Control'; Win = $false }
  TaskSettings = [pscustomobject]@{ Job = 'Other' }
}
$threw = $false
try { Merge-ShareXManagedHotkeys -Config $config -Managed (Managed) -AudioCommand 'dual audio' } catch { $threw = $true }
Assert $threw 'Conflicting shortcuts must be rejected.'
$threw = $false
try {
  Merge-ShareXManagedHotkeys -Config ([pscustomobject]@{ Hotkeys = $null }) `
    -Managed (Managed) -AudioCommand 'dual audio'
} catch { $threw = $true }
Assert $threw 'Malformed configuration must be rejected.'
$unavailable = Get-ShareXSyncAudio -Discover {
  throw (New-Object System.Runtime.InteropServices.COMException('No default device', -2147023728))
}
Assert ($null -eq $unavailable) 'A missing default microphone must defer sync.'
$unavailable = Get-ShareXSyncAudio -Discover {
  [pscustomobject]@{ Microphone = 'mic'; DirectShowDevices = @() }
}
Assert ($null -eq $unavailable) 'A missing playback source must defer sync.'
$unavailable = Get-ShareXSyncAudio -Discover {
  $deviceError = New-Object System.InvalidOperationException('No DirectShow devices')
  $deviceError.Data['ShareXAudioUnavailable'] = $true
  throw $deviceError
}
Assert ($null -eq $unavailable) 'No DirectShow devices must defer sync.'
$threw = $false
try { Get-ShareXSyncAudio -Discover { throw 'Unexpected failure' } } catch { $threw = $true }
Assert $threw 'Unexpected discovery failures must remain errors.'
Import-Module (Join-Path $PSScriptRoot '..\ShareXAudio.psm1') -Force
$path = Join-Path ([IO.Path]::GetTempPath()) ("sharex-utf8-" + [guid]::NewGuid() + '.json')
try {
  $name = 'Microphone ' + [char]0x0E01
  Write-ShareXUtf8NoBom -Path $path -Content (ConvertTo-Json @{ Name = $name })
  $read = Read-ShareXJsonFile -Path $path
  Assert ($read.Name -ceq $name) 'UTF-8 device names must round trip.'
} finally { Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue }
Write-Output 'PASS: ShareX sync tests'
