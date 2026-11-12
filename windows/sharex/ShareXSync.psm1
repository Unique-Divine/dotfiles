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
    $matches = @($Config.Hotkeys | Where-Object { $_.TaskSettings.Job -eq $job })
    if ($matches.Count -gt 1) { throw "Multiple ShareX hotkeys use job '$job'." }
    $conflicts = @($Config.Hotkeys | Where-Object {
      $_.HotkeyInfo.Hotkey -eq $key -and $_.TaskSettings.Job -ne $job
    })
    if ($conflicts.Count -gt 0) { throw "ShareX hotkey '$key' is already in use." }
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

Export-ModuleMember -Function Merge-ShareXManagedHotkeys
