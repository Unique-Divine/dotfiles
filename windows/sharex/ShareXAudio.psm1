Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$coreAudioSource = @'
using System;
using System.Runtime.InteropServices;

namespace ShareXAudio {
  public enum EDataFlow { eRender = 0, eCapture = 1, eAll = 2 }
  public enum ERole { eConsole = 0, eMultimedia = 1, eCommunications = 2 }
  public enum STGM { Read = 0 }

  [StructLayout(LayoutKind.Sequential)]
  public struct PROPERTYKEY {
    public Guid fmtid;
    public int pid;

    public PROPERTYKEY(Guid fmtid, int pid) {
      this.fmtid = fmtid;
      this.pid = pid;
    }
  }

  [StructLayout(LayoutKind.Explicit)]
  public struct PROPVARIANT {
    [FieldOffset(0)] public ushort vt;
    [FieldOffset(8)] public IntPtr ptr;

    public string GetString() {
      return ptr == IntPtr.Zero ? null : Marshal.PtrToStringUni(ptr);
    }
  }

  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
  public class MMDeviceEnumeratorComObject { }

  [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"),
   InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IMMDeviceEnumerator {
    int EnumAudioEndpoints(
      EDataFlow flow,
      int stateMask,
      out IMMDeviceCollection devices);
    int GetDefaultAudioEndpoint(
      EDataFlow flow,
      ERole role,
      out IMMDevice device);
    int GetDevice(
      [MarshalAs(UnmanagedType.LPWStr)] string id,
      out IMMDevice device);
    int RegisterEndpointNotificationCallback(IntPtr callback);
    int UnregisterEndpointNotificationCallback(IntPtr callback);
  }

  [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-C0F0A4E9C0E4"),
   InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IMMDeviceCollection { }

  [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"),
   InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IMMDevice {
    int Activate(
      ref Guid iid,
      int clsCtx,
      IntPtr activationParams,
      [MarshalAs(UnmanagedType.IUnknown)] out object result);
    int OpenPropertyStore(STGM access, out IPropertyStore store);
    int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    int GetState(out int state);
  }

  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"),
   InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IPropertyStore {
    int GetCount(out int count);
    int GetAt(int index, out PROPERTYKEY key);
    int GetValue(ref PROPERTYKEY key, out PROPVARIANT value);
    int SetValue(ref PROPERTYKEY key, ref PROPVARIANT value);
    int Commit();
  }

  public sealed class EndpointInfo {
    public string Role { get; set; }
    public string Id { get; set; }
    public string FriendlyName { get; set; }
    public int State { get; set; }
  }

  public static class CoreAudio {
    public static EndpointInfo GetDefault(string roleName) {
      ERole role = (ERole)Enum.Parse(typeof(ERole), roleName, true);
      IMMDeviceEnumerator enumerator =
        (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
      IMMDevice device;
      Marshal.ThrowExceptionForHR(
        enumerator.GetDefaultAudioEndpoint(EDataFlow.eCapture, role, out device));

      string id;
      Marshal.ThrowExceptionForHR(device.GetId(out id));
      int state;
      Marshal.ThrowExceptionForHR(device.GetState(out state));

      IPropertyStore store;
      Marshal.ThrowExceptionForHR(device.OpenPropertyStore(STGM.Read, out store));
      PROPERTYKEY key = new PROPERTYKEY(
        new Guid("A45C254E-DF1C-4EFD-8020-67D146A850E0"), 14);
      PROPVARIANT value;
      Marshal.ThrowExceptionForHR(store.GetValue(ref key, out value));

      return new EndpointInfo {
        Role = role.ToString(),
        Id = id,
        FriendlyName = value.GetString(),
        State = state
      };
    }
  }
}
'@

if ($null -eq ("ShareXAudio.CoreAudio" -as [type])) {
  Add-Type -TypeDefinition $coreAudioSource
}

function ConvertTo-ShareXJson {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][object]$Value,
    [switch]$Pretty
  )

  if ($Pretty) {
    return ($Value | ConvertTo-Json -Depth 100)
  }

  return ($Value | ConvertTo-Json -Depth 100 -Compress)
}

function New-ShareXEnvelope {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][bool]$Ok,
    [object]$Data,
    [object]$Error
  )

  return [pscustomobject]@{
    Ok = $Ok
    Data = $Data
    Error = $Error
  }
}

function New-ShareXError {
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)][System.Exception]$Exception)

  return [pscustomobject]@{
    Type = $Exception.GetType().FullName
    Message = $Exception.Message
  }
}

function Write-ShareXUtf8NoBom {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Content
  )

  $encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Content, $encoding)
}

function New-ShareXOutputDirectory {
  [CmdletBinding()]
  param([string]$OutputDirectory)

  if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = Join-Path ([System.IO.Path]::GetTempPath()) (
      "ShareXAudio-" + [guid]::NewGuid().ToString("N"))
  }

  New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
  return (Resolve-Path -LiteralPath $OutputDirectory).Path
}

function Get-ShareXConfigPath {
  [CmdletBinding()]
  param([string]$ConfigPath)

  if (-not [string]::IsNullOrWhiteSpace($ConfigPath)) {
    return $ConfigPath
  }

  $documents = [Environment]::GetFolderPath("MyDocuments")
  if ([string]::IsNullOrWhiteSpace($documents)) {
    throw "Windows could not resolve the Documents folder."
  }

  return (Join-Path $documents "ShareX\HotkeysConfig.json")
}

function Invoke-ShareXProcess {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string[]]$ArgumentList,
    [string]$OutputDirectory,
    [string]$LogName = "process"
  )

  if (-not (Test-Path -LiteralPath $FilePath -PathType Leaf)) {
    throw "Executable does not exist: $FilePath"
  }

  $outputDirectory = New-ShareXOutputDirectory -OutputDirectory $OutputDirectory
  $stdoutPath = Join-Path $outputDirectory ("$LogName.stdout.log")
  $stderrPath = Join-Path $outputDirectory ("$LogName.stderr.log")
  $process = Start-Process `
    -FilePath $FilePath `
    -ArgumentList $ArgumentList `
    -Wait `
    -PassThru `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath

  $stdout = if (Test-Path -LiteralPath $stdoutPath) {
    Get-Content -LiteralPath $stdoutPath -Raw
  } else {
    ""
  }
  $stderr = if (Test-Path -LiteralPath $stderrPath) {
    Get-Content -LiteralPath $stderrPath -Raw
  } else {
    ""
  }

  return [pscustomobject]@{
    ExitCode = $process.ExitCode
    Stdout = $stdout
    Stderr = $stderr
    StdoutPath = $stdoutPath
    StderrPath = $stderrPath
  }
}

function Get-ShareXFfmpegData {
  [CmdletBinding()]
  param([string]$FFmpegPath)

  $candidates = New-Object System.Collections.Generic.List[string]
  if (-not [string]::IsNullOrWhiteSpace($FFmpegPath)) {
    [void]$candidates.Add($FFmpegPath)
  }

  foreach ($process in @(Get-CimInstance Win32_Process `
      -Filter "Name='ffmpeg.exe'" -ErrorAction SilentlyContinue)) {
    if (-not [string]::IsNullOrWhiteSpace($process.ExecutablePath)) {
      [void]$candidates.Add($process.ExecutablePath)
    }
  }

  foreach ($process in @(Get-CimInstance Win32_Process `
      -Filter "Name='ShareX.exe'" -ErrorAction SilentlyContinue)) {
    if (-not [string]::IsNullOrWhiteSpace($process.ExecutablePath)) {
      [void]$candidates.Add((Join-Path `
        (Split-Path -Parent $process.ExecutablePath) "ffmpeg.exe"))
    }
  }

  $programFiles = @(
    (Join-Path $env:ProgramFiles "ShareX\ffmpeg.exe"),
    (Join-Path ${env:ProgramFiles(x86)} "ShareX\ffmpeg.exe")
  )
  foreach ($candidate in $programFiles) {
    if (-not [string]::IsNullOrWhiteSpace($candidate)) {
      [void]$candidates.Add($candidate)
    }
  }

  $pathCommand = Get-Command ffmpeg.exe -ErrorAction SilentlyContinue
  if ($null -ne $pathCommand -and
      -not [string]::IsNullOrWhiteSpace($pathCommand.Source)) {
    [void]$candidates.Add($pathCommand.Source)
  }

  $resolved = @($candidates |
    Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
    Select-Object -Unique |
    Where-Object { Test-Path -LiteralPath $_ -PathType Leaf })
  if ($resolved.Count -eq 0) {
    throw "Could not find ffmpeg.exe used by ShareX."
  }

  $path = $resolved[0]
  $version = Invoke-ShareXProcess `
    -FilePath $path `
    -ArgumentList @("-nostdin", "-hide_banner", "-version") `
    -OutputDirectory (Join-Path ([System.IO.Path]::GetTempPath()) `
      ("ShareXAudioVersion-" + [guid]::NewGuid().ToString("N"))) `
    -LogName "version"
  $versionLine = @(
    ($version.Stdout + "`n" + $version.Stderr) -split "`r?`n" |
      Where-Object { $_ -match "^ffmpeg version " } |
      Select-Object -First 1
  )[0]
  if ([string]::IsNullOrWhiteSpace($versionLine)) {
    throw "FFmpeg did not report a version from $path."
  }

  return [pscustomobject]@{
    Path = $path
    Version = $versionLine.Trim()
    Candidates = @($resolved)
  }
}

function Get-DirectShowAudioData {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$FFmpegPath,
    [string]$OutputDirectory
  )

  $run = Invoke-ShareXProcess `
    -FilePath $FFmpegPath `
    -ArgumentList @(
      "-nostdin", "-hide_banner", "-list_devices", "true", "-f", "dshow",
      "-i", "dummy"
    ) `
    -OutputDirectory $OutputDirectory `
    -LogName "directshow"

  $lines = @($run.Stdout, $run.Stderr) -join "`n" -split "`r?`n"
  $devices = @()
  $pending = $null
  foreach ($line in $lines) {
    $audio = [regex]::Match($line, '"(?<name>[^"]+)"\s+\(audio\)')
    if ($audio.Success) {
      if ($null -ne $pending) {
        $devices += [pscustomobject]@{
          Name = $pending
          AlternativeName = $null
        }
      }
      $pending = $audio.Groups["name"].Value
      continue
    }

    if ($null -ne $pending) {
      $alternative = [regex]::Match(
        $line, 'Alternative name\s+"(?<name>[^"]+)"')
      if ($alternative.Success) {
        $devices += [pscustomobject]@{
          Name = $pending
          AlternativeName = $alternative.Groups["name"].Value
        }
        $pending = $null
      }
    }
  }
  if ($null -ne $pending) {
    $devices += [pscustomobject]@{
      Name = $pending
      AlternativeName = $null
    }
  }

  if ($devices.Count -eq 0) {
    throw "FFmpeg returned no DirectShow audio devices. Exit code: $($run.ExitCode)"
  }

  return [pscustomobject]@{
    Devices = @($devices)
    ExitCode = $run.ExitCode
    StdoutPath = $run.StdoutPath
    StderrPath = $run.StderrPath
  }
}

function Get-NormalizedDeviceGuid {
  [CmdletBinding()]
  param([string]$Id)

  if ([string]::IsNullOrWhiteSpace($Id)) {
    return $null
  }

  $match = [regex]::Match(
    $Id,
    '(?<guid>[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})')
  if (-not $match.Success) {
    return $null
  }

  return $match.Groups["guid"].Value.ToLowerInvariant()
}

function Get-NormalizedDeviceName {
  [CmdletBinding()]
  param([string]$Name)

  if ([string]::IsNullOrWhiteSpace($Name)) {
    return ""
  }

  return (($Name.ToLowerInvariant()) -replace "[^a-z0-9]", "")
}

function Get-DefaultRecordingDeviceData {
  [CmdletBinding()]
  param(
    [ValidateSet("Console", "Communications", "Multimedia")]
    [string]$Role = "Console"
  )

  $endpoint = [ShareXAudio.CoreAudio]::GetDefault("e$Role")
  return [pscustomobject]@{
    Role = $Role
    Id = $endpoint.Id
    DeviceGuid = Get-NormalizedDeviceGuid -Id $endpoint.Id
    FriendlyName = $endpoint.FriendlyName
    State = $endpoint.State
  }
}

function Resolve-ShareXMicrophone {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][object]$DefaultEndpoint,
    [Parameter(Mandatory = $true)][object[]]$Devices,
    [string]$ExcludeName = "virtual-audio-capturer"
  )

  $eligible = @($Devices | Where-Object {
    -not [string]::Equals($_.Name, $ExcludeName, `
      [StringComparison]::OrdinalIgnoreCase)
  })
  if ($eligible.Count -eq 0) {
    return [pscustomobject]@{
      Status = "NoMicrophone"
      SelectionMethod = "NoEligibleDevice"
      Device = $null
      Candidates = @()
    }
  }

  $exact = @($eligible | Where-Object {
    [String]::Equals($_.Name, $DefaultEndpoint.FriendlyName, `
      [StringComparison]::OrdinalIgnoreCase)
  })
  if ($exact.Count -eq 1) {
    return [pscustomobject]@{
      Status = "Matched"
      SelectionMethod = "FriendlyName"
      Device = $exact[0]
      Candidates = @($eligible)
    }
  }

  $defaultGuid = $DefaultEndpoint.DeviceGuid
  if (-not [string]::IsNullOrWhiteSpace($defaultGuid)) {
    $guidMatches = @($eligible | Where-Object {
      $guid = Get-NormalizedDeviceGuid -Id $_.AlternativeName
      -not [string]::IsNullOrWhiteSpace($guid) -and $guid -eq $defaultGuid
    })
    if ($guidMatches.Count -eq 1) {
      return [pscustomobject]@{
        Status = "Matched"
        SelectionMethod = "DeviceGuid"
        Device = $guidMatches[0]
        Candidates = @($eligible)
      }
    }
  }

  $defaultName = Get-NormalizedDeviceName -Name $DefaultEndpoint.FriendlyName
  $normalizedMatches = @($eligible | Where-Object {
    (Get-NormalizedDeviceName -Name $_.Name) -eq $defaultName
  })
  if ($normalizedMatches.Count -eq 1) {
    return [pscustomobject]@{
      Status = "Matched"
      SelectionMethod = "NormalizedName"
      Device = $normalizedMatches[0]
      Candidates = @($eligible)
    }
  }

  if ($eligible.Count -eq 1) {
    return [pscustomobject]@{
      Status = "Matched"
      SelectionMethod = "SingleEligibleFallback"
      Device = $eligible[0]
      Candidates = @($eligible)
    }
  }

  $names = ($eligible | ForEach-Object { $_.Name }) -join ", "
  throw "Could not match default recording device '$($DefaultEndpoint.FriendlyName)' to DirectShow devices. Candidates: $names"
}

function New-ShareXSystemAudioCommand {
  [CmdletBinding()]
  param()

  return '-f dshow -thread_queue_size 1024 -rtbufsize 256M -audio_buffer_size 80 -i audio="virtual-audio-capturer" -c:a libmp3lame -qscale:a 4 -y "$output$"'
}

function New-ShareXDualAudioCommand {
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)][string]$MicrophoneName)

  if ($MicrophoneName.Contains('"')) {
    throw "The microphone name contains a quote and cannot be rendered safely."
  }

  return ('-f dshow -thread_queue_size 1024 -rtbufsize 256M ' +
    '-audio_buffer_size 80 -i audio="virtual-audio-capturer" ' +
    '-f dshow -thread_queue_size 1024 -rtbufsize 256M ' +
    '-audio_buffer_size 80 -i audio="' + $MicrophoneName + '" ' +
    '-filter_complex "[0:a:0][1:a:0]amix=inputs=2:duration=longest:' +
    'dropout_transition=0:normalize=0,alimiter=limit=0.95[mixed]" ' +
    '-map "[mixed]" -c:a libmp3lame -qscale:a 4 -y "$output$"')
}

function New-ShareXAudioCommandData {
  [CmdletBinding()]
  param(
    [ValidateSet("Console", "Communications", "Multimedia")]
    [string]$Role = "Console",
    [string]$FFmpegPath,
    [string]$OutputDirectory
  )

  $outputDirectory = New-ShareXOutputDirectory `
    -OutputDirectory $OutputDirectory
  $ffmpeg = Get-ShareXFfmpegData -FFmpegPath $FFmpegPath
  $directShow = Get-DirectShowAudioData `
    -FFmpegPath $ffmpeg.Path `
    -OutputDirectory $outputDirectory
  $endpoint = Get-DefaultRecordingDeviceData -Role $Role
  $resolution = Resolve-ShareXMicrophone `
    -DefaultEndpoint $endpoint `
    -Devices $directShow.Devices

  if ($resolution.Status -eq "NoMicrophone") {
    $command = New-ShareXSystemAudioCommand
    $microphone = $null
  } else {
    $command = New-ShareXDualAudioCommand `
      -MicrophoneName $resolution.Device.Name
    $microphone = $resolution.Device
  }

  $commandPath = Join-Path $outputDirectory "ffmpeg-command.txt"
  Write-ShareXUtf8NoBom -Path $commandPath -Content ($command + "`n")
  $endpointPath = Join-Path $outputDirectory "default-endpoint.json"
  Write-ShareXUtf8NoBom -Path $endpointPath `
    -Content (ConvertTo-ShareXJson -Value $endpoint)
  $devicesPath = Join-Path $outputDirectory "directshow-devices.json"
  Write-ShareXUtf8NoBom -Path $devicesPath `
    -Content (ConvertTo-ShareXJson -Value $directShow)

  return [pscustomobject]@{
    Ffmpeg = $ffmpeg
    Role = $Role
    DefaultEndpoint = $endpoint
    DirectShowDevices = @($directShow.Devices)
    Microphone = $microphone
    SelectionMethod = $resolution.SelectionMethod
    SystemAudio = "virtual-audio-capturer"
    Command = $command
    OutputDirectory = $outputDirectory
    CommandPath = $commandPath
    EndpointPath = $endpointPath
    DevicesPath = $devicesPath
  }
}

function Read-ShareXJsonFile {
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)][string]$Path)

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "ShareX configuration does not exist: $Path"
  }

  $text = Get-Content -LiteralPath $Path -Raw
  if ([string]::IsNullOrWhiteSpace($text)) {
    throw "ShareX configuration is empty: $Path"
  }

  try {
    return ($text | ConvertFrom-Json)
  } catch {
    throw "Unable to parse ShareX configuration '$Path': $($_.Exception.Message)"
  }
}

function Merge-ShareXAudioHotkey {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][object]$Config,
    [string]$Description,
    [string]$Hotkey,
    [Parameter(Mandatory = $true)][string]$Command
  )

  if ($null -eq $Config.Hotkeys) {
    throw "ShareX configuration has no Hotkeys array."
  }
  if ([string]::IsNullOrWhiteSpace($Description) -and
      [string]::IsNullOrWhiteSpace($Hotkey)) {
    throw "Provide either -Description or -Hotkey."
  }

  $matches = @($Config.Hotkeys | Where-Object {
    $descriptionMatches = -not [string]::IsNullOrWhiteSpace($Description) -and
      [string]::Equals(
        [string]$_.TaskSettings.Description,
        $Description,
        [StringComparison]::OrdinalIgnoreCase)
    $hotkeyMatches = -not [string]::IsNullOrWhiteSpace($Hotkey) -and
      [string]::Equals(
        [string]$_.HotkeyInfo.Hotkey,
        $Hotkey,
        [StringComparison]::OrdinalIgnoreCase)
    $descriptionMatches -or $hotkeyMatches
  })
  if ($matches.Count -ne 1) {
    throw "Expected exactly one ShareX hotkey match, found $($matches.Count)."
  }

  $target = $matches[0]
  if ($target.TaskSettings.UseDefaultCaptureSettings -eq $true) {
    throw "The selected hotkey inherits default capture settings. Enable per-hotkey capture settings before applying this patch."
  }
  if ($null -eq $target.TaskSettings.CaptureSettings -or
      $null -eq $target.TaskSettings.CaptureSettings.FFmpegOptions) {
    throw "The selected hotkey has no per-hotkey FFmpeg settings."
  }

  $options = $target.TaskSettings.CaptureSettings.FFmpegOptions
  $changed = @()
  if ($options.AudioSource -ne "virtual-audio-capturer") {
    $options.AudioSource = "virtual-audio-capturer"
    $changed += "AudioSource"
  }
  if ($options.AudioCodec -ne "libmp3lame") {
    $options.AudioCodec = "libmp3lame"
    $changed += "AudioCodec"
  }
  if ($options.UseCustomCommands -ne $true) {
    $options.UseCustomCommands = $true
    $changed += "UseCustomCommands"
  }
  if ($options.CustomCommands -ne $Command) {
    $options.CustomCommands = $Command
    $changed += "CustomCommands"
  }

  return [pscustomobject]@{
    Config = $Config
    Target = [pscustomobject]@{
      Description = [string]$target.TaskSettings.Description
      Hotkey = [string]$target.HotkeyInfo.Hotkey
    }
    ChangedFields = @($changed)
  }
}

function Write-ShareXConfigAtomic {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Content
  )

  $directory = Split-Path -Parent $Path
  $tempPath = Join-Path $directory (".$([IO.Path]::GetFileName($Path)).$PID.tmp")
  $replaceBackupPath = Join-Path $directory `
    (".$([IO.Path]::GetFileName($Path)).$PID.backup.tmp")
  try {
    Write-ShareXUtf8NoBom -Path $tempPath -Content $Content
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
      [IO.File]::Replace(
        $tempPath,
        $Path,
        $replaceBackupPath,
        $true)
    } else {
      Move-Item -LiteralPath $tempPath -Destination $Path
    }
  } finally {
    if (Test-Path -LiteralPath $tempPath) {
      Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $replaceBackupPath) {
      Remove-Item `
        -LiteralPath $replaceBackupPath `
        -Force `
        -ErrorAction SilentlyContinue
    }
  }
}

function Backup-ShareXConfig {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$ConfigPath,
    [string]$BackupDirectory
  )

  if ([string]::IsNullOrWhiteSpace($BackupDirectory)) {
    $BackupDirectory = Join-Path (Split-Path -Parent $ConfigPath) "Backup"
  }
  New-Item -ItemType Directory -Path $BackupDirectory -Force | Out-Null
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $backupPath = Join-Path $BackupDirectory "HotkeysConfig-$stamp.json"
  Copy-Item -LiteralPath $ConfigPath -Destination $backupPath -Force
  return $backupPath
}

function Invoke-ShareXAudioProbe {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$FFmpegPath,
    [Parameter(Mandatory = $true)][string]$MicrophoneName,
    [ValidateRange(1, 3600)][int]$DurationSeconds = 10,
    [string]$OutputDirectory
  )

  $outputDirectory = New-ShareXOutputDirectory `
    -OutputDirectory $OutputDirectory
  $systemPath = Join-Path $outputDirectory "system.wav"
  $microphonePath = Join-Path $outputDirectory "microphone.wav"
  $mixedPath = Join-Path $outputDirectory "mixed.mp3"

  $system = Invoke-ShareXProcess `
    -FilePath $FFmpegPath `
    -ArgumentList @(
      "-nostdin", "-hide_banner", "-f", "dshow", "-thread_queue_size", "1024",
      "-rtbufsize", "256M", "-audio_buffer_size", "80", "-i",
      'audio="virtual-audio-capturer"', "-t", "$DurationSeconds", "-c:a",
      "pcm_s16le", "-y", $systemPath
    ) `
    -OutputDirectory $outputDirectory `
    -LogName "system"
  $microphone = Invoke-ShareXProcess `
    -FilePath $FFmpegPath `
    -ArgumentList @(
      "-nostdin", "-hide_banner", "-f", "dshow", "-thread_queue_size", "1024",
      "-rtbufsize", "256M", "-audio_buffer_size", "80", "-i",
      ('audio="' + $MicrophoneName + '"'), "-t", "$DurationSeconds", "-c:a",
      "pcm_s16le", "-y", $microphonePath
    ) `
    -OutputDirectory $outputDirectory `
    -LogName "microphone"
  $filter = '[0:a:0][1:a:0]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0,alimiter=limit=0.95[mixed]'
  $mixed = Invoke-ShareXProcess `
    -FilePath $FFmpegPath `
    -ArgumentList @(
      "-nostdin", "-hide_banner", "-f", "dshow", "-thread_queue_size", "1024",
      "-rtbufsize", "256M", "-audio_buffer_size", "80", "-i",
      'audio="virtual-audio-capturer"', "-f", "dshow", "-thread_queue_size",
      "1024", "-rtbufsize", "256M", "-audio_buffer_size", "80", "-i",
      ('audio="' + $MicrophoneName + '"'), "-filter_complex", $filter, "-map",
      "[mixed]", "-t", "$DurationSeconds", "-c:a", "libmp3lame", "-qscale:a",
      "4", "-y", $mixedPath
    ) `
    -OutputDirectory $outputDirectory `
    -LogName "mixed"

  return [pscustomobject]@{
    OutputDirectory = $outputDirectory
    Files = @(
      [pscustomobject]@{ Name = "system.wav"; Path = $systemPath; ExitCode = $system.ExitCode },
      [pscustomobject]@{ Name = "microphone.wav"; Path = $microphonePath; ExitCode = $microphone.ExitCode },
      [pscustomobject]@{ Name = "mixed.mp3"; Path = $mixedPath; ExitCode = $mixed.ExitCode }
    )
  }
}

Export-ModuleMember -Function `
  ConvertTo-ShareXJson, `
  Write-ShareXUtf8NoBom, `
  New-ShareXEnvelope, `
  New-ShareXError, `
  Get-ShareXConfigPath, `
  Get-ShareXFfmpegData, `
  Get-DirectShowAudioData, `
  Get-DefaultRecordingDeviceData, `
  Resolve-ShareXMicrophone, `
  New-ShareXSystemAudioCommand, `
  New-ShareXDualAudioCommand, `
  New-ShareXAudioCommandData, `
  Read-ShareXJsonFile, `
  Merge-ShareXAudioHotkey, `
  Write-ShareXConfigAtomic, `
  Backup-ShareXConfig, `
  Invoke-ShareXAudioProbe
