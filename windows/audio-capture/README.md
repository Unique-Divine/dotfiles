# audio-capture

A hotkey recorder for Windows. It records system audio and the mic and saves
one MP3. A small pill in a screen corner shows the mic's waveform and the
elapsed time, and it never takes focus. If the mic disappears mid-recording,
system audio keeps going, the pill shows "mic lost", and the mic rejoins when
it's back. The saved file puts every mic segment at its real time offset.

Design notes and open tasks are in the boku epic
`epics/boku/26-11-13-audio-capture/README.md`.

## Build and Run

The build needs the .NET 10 SDK (`winget install Microsoft.DotNet.SDK.10`)
and an `ffmpeg.exe`. ShareX's copy works.

From WSL:

```sh
just audio-capture-build   # win-sync, then build.cmd on Windows
just audio-capture-run     # start it (tray icon, hotkey ready)
```

Without WSL, run `build.cmd` from `%USERPROFILE%\.files\windows\audio-capture`.

The build does the following:

- Publishes `%LOCALAPPDATA%\Programs\audio-capture\audio-capture.exe`.
- Copies `audio-capture.example.toml` to
  `%APPDATA%\audio-capture\audio-capture.toml` if that file doesn't exist.
- Runs the self-tests.

Press the hotkey (`ctrl+alt+f2` by default) to start, and press it again to
stop and save. The tray icon's menu also starts and stops recording, opens
the recordings folder and the log, and quits the app.

## Command Line

The first launch stays resident and owns the hotkey. Later launches pass
their command to it and exit.

| Command | Effect |
| --- | --- |
| `audio-capture` | Start the app, or toggle recording if it's running |
| `--toggle` | Start or stop recording, starting the app if needed |
| `--start`, `--stop` | Start or stop recording |
| `--quit` | Stop and save, then exit. Waits until the app exits |
| `--list-devices` | Print FFmpeg, DirectShow devices, and the resolved mic |
| `--recover <dir>` | Mix a session folder that never got saved |
| `--self-test` | Run the unit tests |
| `--config <path>` | Use this config file instead of the usual search |

## Config

The commented example `audio-capture.example.toml` lists every key. The app
reads the first file that exists:

1. The path given with `--config`.
2. `%APPDATA%\audio-capture\audio-capture.toml`.
3. `audio-capture.toml` next to the exe.

Edits apply at the next recording start. A change to `keys.toggle` needs a
restart.

## How It Records

- **Two FFmpeg processes.** One reads `virtual-audio-capturer` (system audio)
  and one reads the mic. Each pipes raw 48 kHz stereo PCM to the app, and
  the app writes it to a segment file under
  `%LOCALAPPDATA%\audio-capture\sessions\<time>\`. A raw file stays usable
  even if FFmpeg is killed. The temp files take about 690 MB per hour per
  input.
- **Lost input.** The app marks an input lost if its FFmpeg exits, prints a
  device error, or sends no audio for 1.5 s. A lost input's segment closes.
  About once a second the app checks whether the device is back: the
  Windows endpoint state for the mic, then the DirectShow list. When it is,
  a new segment starts. System audio gets the same treatment.
- **Timing.** The app timestamps every PCM read against the PC clock. The
  earliest-arriving read gives each segment's start time, and the trend
  over the segment gives its clock drift. Segments longer than 60 s with
  more than 100 ppm of drift are resampled to wall-clock speed. Measured
  drift on Unique's Surface with a Blue Yeti was 1 to 3 ppm over 87 s.
- **Saving.** One FFmpeg pass delays each segment to its offset, mixes with
  `amix` (no normalization, like the ShareX command), limits peaks to 0.95,
  and encodes MP3 with `libmp3lame -q:a 4`. The app decodes the result to
  check its length against the session's, renames it into place, and only
  then deletes the session folder. On failure the folder stays, with
  `session.json` and `mix-command.txt`, and `--recover` can retry.
- **Stop.** The app sends FFmpeg `q` and kills it after 3 s. Each segment
  ends at the moment of the stop request. `virtual-audio-capturer` prints
  "Received stop event" into FFmpeg's stdout as it stops, and those bytes
  would otherwise be a loud click at the end of the file.

The log is `%LOCALAPPDATA%\audio-capture\audio-capture.log`.
