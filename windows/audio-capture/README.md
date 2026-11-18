# audio-capture

A hotkey recorder for Windows. It records system audio and the mic and saves
one MP3. A small pill in a screen corner shows the mic's waveform and the
elapsed time, and it never takes focus.

The mic follows Windows. If the USB mic is unplugged, the recording moves to
whatever Windows makes the default (the laptop mic, say) and moves back when
the USB mic returns. AirPods connecting mid-call take over the same way. The
pill shows the new device's name for 2 s. The saved file puts every segment
at its real time offset, so it plays as one continuous recording.

Design notes, decisions, and the QA checklist are in the boku epic
`epics/boku/26-11-13-audio-capture/README.md`.

## Install

Installing needs the .NET 10 SDK (`winget install Microsoft.DotNet.SDK.10`)
and FFmpeg 7 or newer. ShareX's `ffmpeg.exe` works. The reference install is
the Windows side of Unique's laptop, installed from its WSL.

From WSL:

```sh
just audio-capture-install     # win-sync, then install.cmd on Windows
just audio-capture-uninstall   # win-sync, then uninstall.cmd on Windows
```

On Windows without WSL, double-click `install.cmd` or `uninstall.cmd` in
`%USERPROFILE%\.files\windows\audio-capture`. Both routes run the same
scripts.

`install.cmd` does the following:

1. Runs `build.cmd`, which refuses to run while a recording or a save is in
   progress, publishes `%LOCALAPPDATA%\Programs\audio-capture\audio-capture.exe`,
   creates `%USERPROFILE%\.audio-capture\config.toml` from the example on a
   first install, and runs the self-tests.
2. Creates the Start Menu shortcut,
   `%APPDATA%\Microsoft\Windows\Start Menu\Programs\audio-capture.lnk`, so
   the app shows up in Windows search.
3. Creates the Startup shortcut in
   `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup`, unless
   Start with Windows is off.
4. Starts the installed exe with `--tray`.

If a shortcut named `audio-capture.lnk` that points at another program is
in the way, install leaves it, names it, and fails.

Rerunning it updates the exe and both shortcuts. Both shortcuts run
`audio-capture.exe --tray`, which starts the app without recording; if the
app is already running, it shows a tray notification instead.

`just audio-capture-build` runs step 1 alone, and `just audio-capture-run`
starts the app.

### Start With Windows

Start with Windows is on after install. The tray menu's "Start with
Windows" item turns it off and on. The setting lives in `config.toml`:

```toml
[app]
start_with_windows = true
```

The tray item writes this key, keeping the rest of the file as it was, and
then adds or removes the Startup shortcut. A hand edit of the key applies at
the next app start, recording start, or tray menu open. Copies outside the
install folder (dev builds) never touch the Startup shortcut.

### Uninstall

`uninstall.cmd` removes only what install created:

- The Start Menu and Startup shortcuts (the Windows launcher `.lnk` files,
  not hotkeys).
- `%LOCALAPPDATA%\Programs\audio-capture`, the exe folder.

A shortcut counts as install's only if its target is the installed exe.
Install, the tray toggle, and uninstall leave any other `audio-capture.lnk`
alone: install fails, the tray logs a warning, and uninstall prints one.
Uninstall keeps
`%USERPROFILE%\.audio-capture` entirely: `config.toml` with your
hotkeys and other settings, the logs, and any unsaved sessions. Like the
build, it refuses to run while a recording or a save is in progress.

### Icon and Version

The app icon is Unique's lion avatar with a microphone badge. `icon/`
holds the source photo, the generated `audio-capture.ico` (16 to 256 px),
`icon-preview.png`, and the generator:

```sh
uv run --with pillow python windows/audio-capture/icon/make-icon.py
```

The build embeds the icon in the exe, and the tray and both shortcuts use
it. `#:property Version` at the top of `audio-capture.cs` sets the version
shown by `--version`, the exe's Properties, and Task Manager.

## Use

Press the hotkey (`ctrl+alt+f2` by default) to start, and press it again to
stop. Saving runs in the background, so the hotkey can start the next
recording right away. The tray icon's menu also starts and stops recording,
opens the recordings folder and the log, toggles Start with Windows, and
quits the app.

## Files

Everything lives in `%USERPROFILE%\.audio-capture\`:

| Path | Contents |
| --- | --- |
| `config.toml` | Settings; `audio-capture.example.toml` documents every key |
| `logs\audio-capture.jsonl` | The log, one JSON object per line, rotated at 10 MB |
| `sessions\<time>\` | Raw audio of a recording until its MP3 is saved |
| `simulate\` | MP3s from `--simulate` |

On its first start, the app copies a config from the old location,
`%APPDATA%\audio-capture\audio-capture.toml`, and logs `config.migrated`.

Config edits apply at the next recording start. A change to `keys.toggle`
needs a restart. If no config exists, the app reads `audio-capture.toml`
next to the exe, then falls back to built-in defaults.

To follow the log from WSL:

```sh
tail -f "$(wslpath "$(cmd.exe /c 'echo %USERPROFILE%' | tr -d '\r')")/.audio-capture/logs/audio-capture.jsonl" | jq -c '{ts, event, msg}'
```

## Command Line

The first launch stays resident and owns the hotkey. Later launches pass
their command to it and exit.

| Command | Effect |
| --- | --- |
| `audio-capture` | Start the app, or toggle recording if it's running |
| `--tray` | Start the app without recording; if running, show a notification |
| `--install` | Create the shortcuts (run by `install.cmd`) |
| `--uninstall` | Remove the shortcuts (run by `uninstall.cmd`) |
| `--toggle` | Start or stop recording, starting the app if needed |
| `--start`, `--stop` | Start or stop recording |
| `--quit` | Stop, wait for every save, then exit |
| `--quit-if-idle` | Exit if not recording or saving; else exit code 3 |
| `--list-devices` | Print devices, both Windows defaults, and the mic choice |
| `--recover <dir>` | Mix a session folder that never got saved |
| `--self-test` | Run the unit tests, including short FFmpeg captures |
| `--simulate <name>` | Run a device scenario with fake mics and check the MP3 |
| `--watch-devices [s]` | Print recording devices and every Windows change event for s seconds |
| `--config <path>` | Use this config file instead of the usual search |

## Which Mic

Windows keeps two default recording devices, set in Sound settings. The
Default Device is what most apps use. The Default Communication Device is
what call apps such as Zoom and Teams use. `[audio] mic` picks one policy:

| Value | Behavior |
| --- | --- |
| `"communications"` (default) | Follow the Default Communication Device |
| `"default-device"` | Follow the Default Device |
| A device name | Pin that device; if it's unplugged, wait for it on any USB port |
| `"none"` | System audio only |

`"default"` means `"communications"` and logs a warning.

In a follow mode, Windows device notifications trigger a check 500 ms after
the last event, since USB and Bluetooth send bursts. If the default moved
while the current mic still works, the new device starts first, and the old
one stops once the new one delivers audio, so a switch leaves no gap. If the
mic is lost, its segment closes and the next default takes over.

## How It Records

- **Two FFmpeg processes.** One reads `virtual-audio-capturer` (system
  audio) and one reads the mic. Each writes raw 48 kHz stereo PCM into a
  named pipe the app owns, and the app writes it to a segment file. A raw
  file stays usable even if FFmpeg is killed. Temp files take about 690 MB
  per hour per input.
- **Lost input.** An input is lost when its FFmpeg exits, or sends no audio
  for 1.5 s, or prints a device error during a 0.5 s gap. Its segment
  closes and a new one starts on the next available device, retrying with
  backoff up to 5 s.
- **Timing.** The app timestamps every PCM read against the PC clock. The
  earliest-arriving read gives each segment's start time, and the trend
  gives its clock drift. Segments longer than 60 s with 100 to 500 ppm of
  drift are resampled to wall-clock speed; more than 500 ppm looks like
  dropped audio and isn't corrected. Measured drift on Unique's Surface
  with a Blue Yeti was 1 to 3 ppm.
- **Saving.** One FFmpeg pass trims each segment at its end and at the stop
  time, delays it to its offset, mixes with `amix` (no normalization, like
  the ShareX command), limits peaks to 0.95, and encodes MP3 with
  `libmp3lame -q:a 4`. The app decodes the result to check its length,
  renames it into place, writes `saved.txt`, and only then deletes the
  session folder. On failure the folder stays, with `session.json` and
  `mix-command.txt`, and `--recover` can retry.
- **Stop.** The app sends FFmpeg `q` and kills it after 3 s.
  `virtual-audio-capturer` prints "Received stop event" on FFmpeg's stdout,
  which is why PCM travels through a named pipe instead.

## Testing Without Hardware

`--simulate` swaps the Windows devices for scripted fakes. Each fake device
is this exe in a hidden `--fake-device` mode, started in place of FFmpeg. It
writes PCM into the capture pipe in real time: a steady tone of its own
(Yeti 440 Hz, laptop 660 Hz, AirPods 880 Hz, system audio 150 Hz), plus a
50 ms burst at a fixed point of every wall-clock second (system 2 kHz at
:00.000, mics 3 kHz at :00.500). An unplug freezes the fake process, the
way a vanished USB device freezes FFmpeg. After the save, the app decodes
the MP3 and checks which tone plays when, the gaps, and where each burst
lands against the wall clock. A wrong start estimate or offset moves the
bursts; shifting the mic by 40 ms in a test build fails the check.

The fakes skip two real parts: Windows device notifications and the
DirectShow device mapping. `--watch-devices` checks those on real
hardware: run it, plug and unplug mics, and watch the events and defaults.

| Scenario | Script |
| --- | --- |
| `replug` | Yeti out for 4 s: laptop mic, then Yeti |
| `bump` | Yeti out for 0.7 s |
| `airpods` | AirPods connect and become the default |
| `switch-retry` | AirPods become the default but fail to open for 2 s |
| `switch-lookup` | As above, then a retry can't find them in DirectShow |
| `console-change` | Only the Default Device changes: ignored |
| `back-to-back` | A second recording starts while the first saves |
| `all` | Every scenario |
