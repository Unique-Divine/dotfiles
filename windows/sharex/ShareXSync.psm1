Set-StrictMode -Version Latest

function Merge-ManagedProperties {
  param([object]$Target, [object]$Desired)

  foreach ($property in $Desired.PSObject.Properties) {
    $existing = $Target.PSObject.Properties[$property.Name]
    if ($null -eq $existing) {
      $Target | Add-Member -NotePropertyName $property.Name -NotePropertyValue $property.Value
      continue
    }
    if ($null -ne $property.Value -and
        $property.Value -is [pscustomobject] -and
        $null -ne $existing.Value -and $existing.Value -is [pscustomobject]) {
      Merge-ManagedProperties -Target $existing.Value -Desired $property.Value
    } else {
      $existing.Value = $property.Value
    }
  }
}

function Merge-ShareXManagedHotkeys {
  param(
    [Parameter(Mandatory = $true)][object]$Config,
    [Parameter(Mandatory = $true)][object]$Managed,
    [Parameter(Mandatory = $true)][string]$AudioCommand
  )

  if ($null -eq $Config.PSObject.Properties['Hotkeys'] -or
      $null -eq $Config.Hotkeys -or $Config.Hotkeys -isnot [array]) {
    throw 'ShareX configuration has no valid Hotkeys array.'
  }
  $before = ConvertTo-Json -InputObject $Config -Depth 100 -Compress
  foreach ($desired in $Managed.Hotkeys) {
    $job = $desired.TaskSettings.Job
    $key = $desired.HotkeyInfo.Hotkey
    $matches = @($Config.Hotkeys | Where-Object {
      $_.HotkeyInfo.Hotkey -eq $key -and $_.HotkeyInfo.Win -eq $desired.HotkeyInfo.Win
    })
    if ($matches.Count -gt 1 -or
        ($matches.Count -eq 1 -and $matches[0].TaskSettings.Job -ne $job)) {
      throw "ShareX hotkey '$key' is already in use."
    }
    if ($job -eq 'ScreenRecorderActiveWindow') {
      $desired.TaskSettings.CaptureSettings.FFmpegOptions.CustomCommands = $AudioCommand
    }
    if ($matches.Count -eq 0) {
      $Config.Hotkeys = @($Config.Hotkeys) + @($desired)
    } else {
      Merge-ManagedProperties -Target $matches[0] -Desired $desired
    }
  }
  $after = ConvertTo-Json -InputObject $Config -Depth 100 -Compress
  return [pscustomobject]@{ Config = $Config; Changed = ($before -cne $after) }
}

function Get-ShareXSyncAudio {
  param([Parameter(Mandatory = $true)][scriptblock]$Discover)
  try {
    $audio = & $Discover
  } catch {
    $exception = $_.Exception
    while ($null -ne $exception) {
      if ($exception.HResult -eq -2147023728) { return $null }
      $exception = $exception.InnerException
    }
    throw
  }
  if ($null -eq $audio.Microphone -or
      @($audio.DirectShowDevices | Where-Object { $_.Name -eq 'virtual-audio-capturer' }).Count -eq 0) {
    return $null
  }
  return $audio
}

Export-ModuleMember -Function Merge-ShareXManagedHotkeys, Get-ShareXSyncAudio
