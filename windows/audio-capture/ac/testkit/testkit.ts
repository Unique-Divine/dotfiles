/**
 * A fake Windows profile for `ac` tests: a temp C: drive with
 * Users\test\.audio-capture (config, logs) and recordings under
 * Documents\ShareX\Screenshots, plus stub executables first on PATH. Real
 * Windows paths and binaries are never reachable: PATH holds only the stubs,
 * bun's folder, /usr/bin, and /bin.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

export const CLI = resolve(import.meta.dir, "..", "cli.ts")
const STUB = resolve(import.meta.dir, "stub-exe.ts")
export const STUB_NAMES = [
  "wslpath", "cmd.exe", "powershell.exe", "explorer.exe", "clip.exe", "fzf",
]

export interface StubCall {
  name: string
  argv: string[]
  stdin: string | null
}

export interface RunOutput {
  code: number
  stdout: string
  stderr: string
}

export interface FakeWindows {
  root: string
  cDrive: string
  profile: string
  stateDir: string
  logsDir: string
  screenshots: string
  /** Writes a recording file (and its folder) under Screenshots. */
  addRecording: (month: string, name: string, bytes?: number) => string
  /** Appends events to the live log (or a rotated copy). */
  addLog: (events: object[], file?: string) => void
  calls: () => StubCall[]
  run: (args: string[], env?: Record<string, string>) => RunOutput
  cleanup: () => void
}

export const makeFakeWindows = (): FakeWindows => {
  const root = mkdtempSync(join(tmpdir(), "ac-fake-"))
  const cDrive = join(root, "c")
  const profile = join(cDrive, "Users", "test")
  const stateDir = join(profile, ".audio-capture")
  const logsDir = join(stateDir, "logs")
  const screenshots = join(profile, "Documents", "ShareX", "Screenshots")
  const stubDir = join(root, "stubs")
  const callLog = join(root, "calls.jsonl")
  for (const dir of [logsDir, screenshots, stubDir]) mkdirSync(dir, { recursive: true })
  for (const name of STUB_NAMES) {
    const path = join(stubDir, name)
    writeFileSync(path,
      `#!/bin/sh\nexec "${process.execPath}" "${STUB}" "${name}" "$@"\n`)
    chmodSync(path, 0o755)
  }

  const fake: FakeWindows = {
    root, cDrive, profile, stateDir, logsDir, screenshots,
    addRecording(month, name, bytes = 1000) {
      const path = join(screenshots, month, name)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, Buffer.alloc(bytes))
      return path
    },
    addLog(events, file = "audio-capture.jsonl") {
      const path = join(logsDir, file)
      const text = events.map((e) => JSON.stringify(e)).join("\n") + "\n"
      writeFileSync(path, (existsSync(path) ? readFileSync(path, "utf8") : "") + text)
    },
    calls() {
      if (!existsSync(callLog)) return []
      return readFileSync(callLog, "utf8").trim().split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as StubCall)
    },
    run(args, env = {}) {
      const result = Bun.spawnSync({
        cmd: [process.execPath, CLI, ...args],
        cwd: root,
        env: {
          PATH: [stubDir, dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
          HOME: join(root, "home"),
          NO_COLOR: "1",
          // bun test runs in UTC; keep the CLI on the same clock.
          TZ: "UTC",
          AC_STUB_LOG: callLog,
          AC_STUB_C: cDrive,
          ...env,
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      })
      return {
        code: result.exitCode ?? 1,
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
      }
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true })
    },
  }
  return fake
}

const iso = (local: string): string => `${local}+07:00`

/** Log events for one saved recording, shaped like the app's. */
export const sessionEvents = (opts: {
  session: string
  started: string
  output: string
  seconds: number
  mics: string[]
}): object[] => {
  const base = { level: "info", session: opts.session }
  const events: object[] = [
    { ...base, ts: iso(`${opts.started}.000`), event: "recording.start",
      msg: "recording started",
      dir: `C:\\Users\\test\\.audio-capture\\sessions\\${opts.session}`,
      mic_policy: "follow Communications default", earlier_saves_running: 0 },
    { ...base, ts: iso(`${opts.started}.050`), event: "segment.start",
      kind: "system", segment: 1, device: "virtual-audio-capturer", at: 0.05 },
  ]
  opts.mics.forEach((device, i) => events.push({
    ...base, ts: iso(`${opts.started}.400`), event: "segment.start",
    kind: "mic", segment: i + 1, device, at: 0.4,
  }))
  events.push({ ...base, ts: iso(`${opts.started}.900`), event: "recording.stop",
    msg: "recording stopped; saving", stop_at: opts.seconds + 0.4 })
  events.push({ ...base, ts: iso(`${opts.started}.950`), event: "mix.segment",
    kind: "system", file: "system-01.pcm", device: "virtual-audio-capturer",
    start: 0.4, media_seconds: opts.seconds })
  opts.mics.forEach((device, i) => events.push({
    ...base, ts: iso(`${opts.started}.950`), event: "mix.segment", kind: "mic",
    file: `mic-0${i + 1}.pcm`, device, start: 0.6, media_seconds: opts.seconds,
  }))
  events.push({ ...base, ts: iso(`${opts.started}.990`), event: "mix.done",
    msg: `saved ${opts.output} (${opts.seconds.toFixed(1)} s, expected ` +
      `${opts.seconds.toFixed(1)} s, ${opts.mics.length + 1} segments, mixed in 0.3 s)`,
    ok: true, output: opts.output })
  return events
}

/** Windows path of a recording in the fake profile. */
export const winRecording = (month: string, name: string): string =>
  `C:\\Users\\test\\Documents\\ShareX\\Screenshots\\${month}\\${name}`

/**
 * The standard fixture: three recordings in November (two share the
 * 26-11-18__1137 prefix), one in October from a rotated log, one with no
 * log facts, and files that must be ignored.
 */
export const standardFixture = (fake: FakeWindows): void => {
  fake.addRecording("2026-11", "26-11-18__113708-audio.mp3", 48_000)
  fake.addRecording("2026-11", "26-11-18__113755-audio.mp3", 20_000)
  fake.addRecording("2026-11", "26-11-18__215216-audio.mp3", 50_000)
  fake.addRecording("2026-10", "26-10-30__090000-audio.mp3", 2_000_000)
  fake.addRecording("2026-10", "26-10-29__080000-audio.mp3", 3_000)
  fake.addRecording("2026-11", "notes.txt")
  fake.addRecording("2026-11", "26-11-18__113708.png")
  fake.addRecording("misc", "26-11-01__000000-audio.mp3")
  fake.addLog(sessionEvents({
    session: "20261030-090000-001", started: "2026-10-30T09:00:00",
    output: winRecording("2026-10", "26-10-30__090000-audio.mp3"),
    seconds: 3725, mics: ["Yeti", "Laptop Mic"],
  }), "audio-capture.1.jsonl")
  fake.addLog([
    ...sessionEvents({
      session: "20261118-113708-869", started: "2026-11-18T11:37:08",
      output: winRecording("2026-11", "26-11-18__113708-audio.mp3"),
      seconds: 6.1, mics: ["Headset"],
    }),
    ...sessionEvents({
      session: "20261118-113755-100", started: "2026-11-18T11:37:55",
      output: winRecording("2026-11", "26-11-18__113755-audio.mp3"),
      seconds: 2, mics: [],
    }),
    ...sessionEvents({
      session: "20261118-215216-052", started: "2026-11-18T21:52:16",
      output: winRecording("2026-11", "26-11-18__215216-audio.mp3"),
      seconds: 4.6, mics: ["Headset"],
    }),
  ])
}
