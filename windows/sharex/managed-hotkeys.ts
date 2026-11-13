/**
 * Portable ShareX settings. ShareX fills in its other settings; the sync only
 * owns the fields listed here. Regenerate ManagedHotkeys.json after edits.
 */
export const managedHotkeys = {
  Hotkeys: [
    {
      // Capture a selected region as an image.
      HotkeyInfo: { Hotkey: "Home, Control", Win: false },
      TaskSettings: {
        Job: "RectangleRegion",
        UseDefaultCaptureSettings: true,
      },
    },
    {
      // Record a selected region using ShareX's native recorder and system audio.
      HotkeyInfo: { Hotkey: "Home, Shift", Win: false },
      TaskSettings: {
        Job: "ScreenRecorder",
        UseDefaultCaptureSettings: false,
        CaptureSettings: {
          ScreenRecordUseNative: true,
          ScreenRecordSystemAudio: true,
          ScreenRecordMicrophone: false,
          ScreenRecordFPS: 30,
        },
      },
    },
    {
      // Record a selected region as an animated GIF.
      HotkeyInfo: { Hotkey: "Home, Shift, Control", Win: false },
      TaskSettings: {
        Job: "ScreenRecorderGIF",
        UseDefaultCaptureSettings: true,
      },
    },
    {
      // Record playback and the Windows default microphone to an audio file.
      HotkeyInfo: { Hotkey: "F2, Control", Win: false },
      TaskSettings: {
        Description: "Audio Virtual Record",
        Job: "ScreenRecorderActiveWindow",
        UseDefaultCaptureSettings: false,
        CaptureSettings: {
          // ShareX's native recorder records video and ignores FFmpeg custom
          // commands, so this audio-only hotkey must use FFmpeg.
          ScreenRecordUseNative: false,
          FFmpegOptions: {
            AudioSource: "virtual-audio-capturer",
            AudioCodec: "libmp3lame",
            UseCustomCommands: true,
            // Sync replaces this placeholder with a device-specific command.
            CustomCommands: "",
          },
        },
      },
    },
  ],
}

export function renderManagedHotkeys(): string {
  return `${JSON.stringify(managedHotkeys, null, 2)}\n`
}

if (import.meta.main) {
  const output = new URL("./ManagedHotkeys.json", import.meta.url)
  const mode = process.argv[2]
  if (mode === "--write") {
    await Bun.write(output, renderManagedHotkeys())
  } else if (mode === "--check") {
    const file = Bun.file(output)
    if (!(await file.exists()) || (await file.text()) !== renderManagedHotkeys()) {
      console.error("ManagedHotkeys.json is stale; run just sharex-generate.")
      process.exitCode = 1
    }
  } else {
    console.error("Usage: bun run managed-hotkeys.ts --write|--check")
    process.exitCode = 2
  }
}
