# ShareX dual audio capture

This directory contains the portable setup for ShareX audio-only recording
with two DirectShow inputs:

- `virtual-audio-capturer` for Windows playback audio.
- The Windows default recording endpoint for microphone audio.

ShareX continues to launch its bundled `ffmpeg.exe`. The scripts discover the
machine-specific microphone name, generate the custom FFmpeg arguments, and
optionally patch one selected ShareX hotkey.

## Direct invocation

Run the scripts from Windows PowerShell 5.1:

```powershell
powershell.exe -NoLogo -NoProfile -NonInteractive -File .\Get-ShareXFFmpeg.ps1
powershell.exe -NoLogo -NoProfile -NonInteractive -File .\Get-DefaultRecordingDevice.ps1 -Role Console
powershell.exe -NoLogo -NoProfile -NonInteractive -File .\New-ShareXAudioCommand.ps1
```

Each script writes one JSON document to standard output. Diagnostics go to
standard error. `New-ShareXAudioCommand.ps1` writes its command, device list,
endpoint data, and result under a unique Windows temporary directory.

## WSL invocation

The `winps` adapter runs the same scripts from WSL:

```bash
./winps ./Get-ShareXFFmpeg.ps1
./winps ./Get-DefaultRecordingDevice.ps1 --Role Console
./winps ./New-ShareXAudioCommand.ps1 | jq .
```

The adapter checks for Windows PowerShell 5.1 and translates only the script
path. It does not bypass the machine's execution policy. Direct
`powershell.exe -File` calls remain a supported way to test a script.

If the effective policy is `Restricted`, both forms fail closed. Run a
one-off test with an explicit per-process override when that is permitted by
the machine policy:

```bash
powershell.exe -ExecutionPolicy Bypass -NoLogo -NoProfile \
  -NonInteractive -File "$(wslpath -w ./Get-ShareXFFmpeg.ps1)"
```

For regular use, place trusted scripts on the Windows filesystem and use the
machine's approved execution-policy or signing configuration. The generated
ShareX FFmpeg command does not depend on PowerShell.

## Generate the command

Run:

```bash
./winps ./New-ShareXAudioCommand.ps1 | jq .
```

The result reports:

- the ShareX FFmpeg path and version;
- the Core Audio default recording endpoint;
- the DirectShow audio devices;
- the selected microphone and matching method;
- the final ShareX argument string;
- paths to the temporary command and diagnostic files.

The final ShareX argument string contains `$output$`. ShareX replaces that
placeholder with the real destination path. It does not include `ffmpeg.exe`
or `-nostdin`. The latter is used only by unattended PowerShell probes because
FFmpeg otherwise inherits the probe process's standard input.

## Dry-run and apply

The installer requires an explicit target. The current machine's target is
the description `Audio Virtual Record`:

```bash
./winps ./Install-ShareXAudioHotkey.ps1 \
  -Description 'Audio Virtual Record'
```

That command performs discovery, shows the planned target and changed fields,
and leaves the live ShareX file unchanged.

Apply the patch only after reviewing the dry-run result:

```bash
./winps ./Install-ShareXAudioHotkey.ps1 \
  -Description 'Audio Virtual Record' -Apply
```

The installer reads the live
`Documents\ShareX\HotkeysConfig.json`, backs it up under ShareX's `Backup`
directory, and changes only the selected hotkey's FFmpeg settings. It
preserves all other hotkeys and runtime-owned values.

The checked-in `HotkeysConfig.json` is a sanitized schema reference and test
fixture. It is not copied over the live ShareX configuration.

## Probe the sources

Run the discovery checks without recording:

```bash
./winps ./Test-ShareXAudio.ps1 | jq .
```

Run short source and mixed captures:

```bash
./winps ./Test-ShareXAudio.ps1 -DurationSeconds 10 -RunCapture | jq .
```

The probe writes WAV and MP3 files plus FFmpeg logs to a unique temporary
directory. Play system audio and speak into the microphone during the test.

## Selection policy

The generator uses the Windows default capture endpoint for the requested
role. It matches the endpoint to DirectShow devices by:

1. exact friendly name;
2. the device GUID embedded in the Core Audio and DirectShow identifiers;
3. normalized name;
4. a single eligible microphone fallback.

It excludes `virtual-audio-capturer` from microphone candidates. Zero eligible
microphones produces a deliberate system-only command. Multiple unmatched
microphones produce an error.

The source of truth for the portable behavior is the PowerShell module and
the command generator. The JSON file in this directory documents the ShareX
shape without storing the full machine-specific runtime configuration.
