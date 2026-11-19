import { afterEach, describe, expect, test } from "bun:test"
import { rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  makeFakeWindows, standardFixture, type FakeWindows,
} from "./testkit/testkit"

const fakes: FakeWindows[] = []
const fixture = (): FakeWindows => {
  const fake = makeFakeWindows()
  fakes.push(fake)
  standardFixture(fake)
  return fake
}
afterEach(() => {
  for (const fake of fakes.splice(0)) fake.cleanup()
})

const RECORDING_KEYS = [
  "name", "path", "win_path", "time", "size_bytes", "modified", "duration_s",
  "session", "segments", "mics", "note", "tags", "links",
].sort()

describe("ac last", () => {
  test("prints the newest recording's WSL path", () => {
    const fake = fixture()
    const out = fake.run(["last"])
    expect(out.stderr).toBe("")
    expect(out.code).toBe(0)
    expect(out.stdout).toBe(
      join(fake.screenshots, "2026-11", "26-11-18__215216-audio.mp3") + "\n")
  })

  test("--win prints the Windows path without calling wslpath per file", () => {
    const fake = fixture()
    const out = fake.run(["last", "--win"])
    expect(out.stdout).toBe(
      "C:\\Users\\test\\Documents\\ShareX\\Screenshots\\2026-11\\" +
        "26-11-18__215216-audio.mp3\n")
    const wslpathCalls = fake.calls().filter((c) => c.name === "wslpath")
    expect(wslpathCalls.map((c) => c.argv)).toEqual([
      ["-u", "C:\\Users\\test"],
    ])
  })

  test("--copy sends the path to clip.exe on stdin", () => {
    const fake = fixture()
    const out = fake.run(["last", "--win", "--copy"])
    expect(out.code).toBe(0)
    const clip = fake.calls().filter((c) => c.name === "clip.exe")
    expect(clip).toEqual([{
      name: "clip.exe",
      argv: [],
      stdin: "C:\\Users\\test\\Documents\\ShareX\\Screenshots\\2026-11\\" +
        "26-11-18__215216-audio.mp3",
    }])
  })

  test("--dry-run prints the clip command instead of running it", () => {
    const fake = fixture()
    const out = fake.run(["--dry-run", "last", "--copy"])
    expect(out.code).toBe(0)
    const path = join(fake.screenshots, "2026-11", "26-11-18__215216-audio.mp3")
    expect(out.stdout).toBe(`printf %s ${path} | clip.exe\n${path}\n`)
    expect(fake.calls().some((c) => c.name === "clip.exe")).toBe(false)
  })

  test("--json prints one recording object", () => {
    const fake = fixture()
    const recording = JSON.parse(fake.run(["last", "--json"]).stdout)
    expect(Object.keys(recording).sort()).toEqual(RECORDING_KEYS)
    expect(recording.session).toBe("20261118-215216-052")
    expect(recording.duration_s).toBe(4.6)
  })

  test("calls only the expected programs with the expected argv", () => {
    const fake = fixture()
    fake.run(["last"])
    const calls = fake.calls()
    expect(calls[0]).toEqual({
      name: "cmd.exe", argv: ["/c", "echo %USERPROFILE%"], stdin: null,
    })
    expect(calls.map((c) => c.name)).toEqual(["cmd.exe", "wslpath",
      "powershell.exe"])
  })
})

describe("ac ls", () => {
  test("lists matching files newest first with log facts", () => {
    const fake = fixture()
    const out = fake.run(["ls"])
    expect(out.stderr).toBe("")
    const lines = out.stdout.trimEnd().split("\n")
    expect(lines.map((l) => l.split(/\s+/).find((w) => w.endsWith(".mp3"))))
      .toEqual([
        "26-11-18__215216-audio.mp3",
        "26-11-18__113755-audio.mp3",
        "26-11-18__113708-audio.mp3",
        "26-10-30__090000-audio.mp3",
        "26-10-29__080000-audio.mp3",
      ])
    expect(lines[3]).toBe("2026-10-30 09:00  1:02:05   1.9 MB  2 mics, 3 segs" +
      "  26-10-30__090000-audio.mp3")
    expect(lines[4]).toContain("no log")
  })

  test("--json schema, --limit, and --since with a date", () => {
    const fake = fixture()
    const rows = JSON.parse(fake.run(["ls", "--json", "--limit", "2"]).stdout)
    expect(rows).toHaveLength(2)
    for (const row of rows) expect(Object.keys(row).sort()).toEqual(RECORDING_KEYS)
    expect(rows[0].mics).toEqual(["Headset"])
    expect(rows[0].segments).toBe(2)
    expect(rows[1].mics).toEqual([])

    const since = JSON.parse(
      fake.run(["ls", "--json", "--since", "2026-10-30"]).stdout)
    expect(since.map((r: { name: string }) => r.name)).toEqual([
      "26-11-18__215216-audio.mp3",
      "26-11-18__113755-audio.mp3",
      "26-11-18__113708-audio.mp3",
      "26-10-30__090000-audio.mp3",
    ])
  })

  test("rejects a bad --since", () => {
    const fake = fixture()
    const out = fake.run(["ls", "--since", "yesterday"])
    expect(out.code).toBe(1)
    expect(out.stderr).toContain("invalid --since \"yesterday\"")
  })

  test("a missing log degrades to file facts with a yellow warning", () => {
    const fake = fixture()
    rmSync(fake.logsDir, { recursive: true })
    const out = fake.run(["ls", "--json"], { NO_COLOR: "", FORCE_COLOR: "1" })
    expect(out.code).toBe(0)
    expect(out.stderr).toBe(`\x1b[33mwarning:\x1b[39m no log at ${
      join(fake.logsDir, "audio-capture.jsonl")}; durations, mics, and ` +
      "sessions are unknown\n")
    const rows = JSON.parse(out.stdout)
    expect(rows).toHaveLength(5)
    expect(rows[0].duration_s).toBeNull()
    expect(rows[0].segments).toBeNull()
  })

  test("a missing recordings folder warns and lists nothing", () => {
    const fake = fixture()
    rmSync(join(fake.profile, "Documents"), { recursive: true })
    const out = fake.run(["ls"])
    expect(out.code).toBe(0)
    expect(out.stdout).toBe("")
    expect(out.stderr).toContain("warning: recordings folder not found: " +
      join(fake.profile, "Documents", "ShareX", "Screenshots"))
  })

  test("a missing profile folder warns and uses default settings", () => {
    const fake = fixture()
    rmSync(fake.stateDir, { recursive: true })
    const out = fake.run(["ls"])
    expect(out.code).toBe(0)
    expect(out.stderr).toContain(
      `warning: no audio-capture folder at ${fake.stateDir}`)
    expect(out.stdout.trimEnd().split("\n")).toHaveLength(5)
  })

  test("follows [output] dir and name from config.toml", () => {
    const fake = fixture()
    writeFileSync(join(fake.stateDir, "config.toml"),
      '[output]\ndir = "{home}/rec"\nname = "{yyyyMMdd-HHmm}.mp3"\n')
    fake.addRecording("../../../rec", "20261101-0930.mp3")
    const out = fake.run(["ls", "--json"])
    const rows = JSON.parse(out.stdout)
    // Files the log saved elsewhere still count; the rest come from the scan.
    expect(rows.map((r: { name: string }) => r.name)).toEqual([
      "26-11-18__215216-audio.mp3",
      "26-11-18__113755-audio.mp3",
      "26-11-18__113708-audio.mp3",
      "20261101-0930.mp3",
      "26-10-30__090000-audio.mp3",
    ])
    expect(new Date(rows[3].time).getHours()).toBe(9)
    expect(new Date(rows[3].time).getMinutes()).toBe(30)
    expect(fake.calls().some((c) => c.name === "powershell.exe")).toBe(false)
  })
})
