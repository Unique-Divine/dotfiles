import {
  afterEach, describe, expect, setDefaultTimeout, test,
} from "bun:test"
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  makeFakeWindows, standardFixture, type FakeWindows,
} from "./testkit/testkit"

// Each case runs the CLI and stub programs as real subprocesses.
setDefaultTimeout(30_000)

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

describe("ids", () => {
  test("a unique prefix, a full name, a stem, and paths all resolve", () => {
    const fake = fixture()
    const name = "26-11-18__215216-audio.mp3"
    const wsl = join(fake.screenshots, "2026-11", name)
    for (const id of ["26-11-18__2152", name, "26-11-18__215216-audio", wsl,
      `C:\\Users\\test\\Documents\\ShareX\\Screenshots\\2026-11\\${name}`]) {
      const out = fake.run(["show", id, "--json"])
      expect(out.stderr).toBe("")
      expect(JSON.parse(out.stdout).recording.name).toBe(name)
    }
  })

  test("an ambiguous prefix errors with the candidates", () => {
    const fake = fixture()
    const out = fake.run(["show", "26-11-18__1137"])
    expect(out.code).toBe(1)
    expect(out.stderr).toBe('ac: "26-11-18__1137" matches 2 recordings:\n' +
      "  26-11-18__113755-audio.mp3\n  26-11-18__113708-audio.mp3\n")
  })

  test("an unknown id errors", () => {
    const fake = fixture()
    expect(fake.run(["show", "25-01"]).stderr).toBe(
      'ac: no recording matches "25-01"\n')
  })
})

describe("ac show", () => {
  test("--json has file, log, and sidecar facts", () => {
    const fake = fixture()
    const shown = JSON.parse(fake.run(["show", "26-10-30", "--json"]).stdout)
    expect(Object.keys(shown).sort()).toEqual([
      "file", "log", "recording", "sidecar", "sidecar_error", "sidecar_path",
    ])
    expect(shown.file).toEqual({
      path: join(fake.screenshots, "2026-10", "26-10-30__090000-audio.mp3"),
      win_path: "C:\\Users\\test\\Documents\\ShareX\\Screenshots\\2026-10\\" +
        "26-10-30__090000-audio.mp3",
      size_bytes: 2_000_000,
      modified: shown.recording.modified,
    })
    expect(shown.log.session).toBe("20261030-090000-001")
    expect(shown.log.started).toBe("2026-10-30T09:00:00.000+07:00")
    expect(shown.log.mics).toEqual(["Yeti", "Laptop Mic"])
    expect(shown.log.segments.map((s: { file: string }) => s.file))
      .toEqual(["system-01.pcm", "mic-01.pcm", "mic-02.pcm"])
    expect(shown.sidecar).toBeNull()
    expect(shown.sidecar_path).toBe(
      join(fake.screenshots, "2026-10", "26-10-30__090000-audio.json"))
  })

  test("text output labels each fact", () => {
    const fake = fixture()
    const out = fake.run(["show", "last"]).stdout
    expect(out).toContain("26-11-18__215216-audio.mp3\n  path         ")
    expect(out).toContain("  session      20261118-215216-052\n")
    expect(out).toContain("  sidecar      none\n")
  })

  test("a broken sidecar warns but still shows the recording", () => {
    const fake = fixture()
    writeFileSync(join(fake.screenshots, "2026-11", "26-11-18__215216-audio.json"),
      '{"version": 9}')
    const out = fake.run(["show", "last", "--json"])
    expect(out.code).toBe(0)
    expect(out.stderr).toContain("warning: ")
    expect(out.stderr).toContain("unsupported version 9")
    expect(JSON.parse(out.stdout).sidecar_error).toContain("unsupported version 9")
  })
})

describe("ac open", () => {
  test("selects the recording in Explorer with a Windows path", () => {
    const fake = fixture()
    const out = fake.run(["open", "26-11-18__1137", "--dry-run"])
    expect(out.code).toBe(1)
    const open = fake.run(["open", "26-11-18__11370"])
    expect(open.code).toBe(0)
    const explorer = fake.calls().filter((c) => c.name === "explorer.exe")
    expect(explorer).toEqual([{
      name: "explorer.exe",
      argv: ["/select,C:\\Users\\test\\Documents\\ShareX\\Screenshots\\" +
        "2026-11\\26-11-18__113708-audio.mp3"],
      stdin: null,
    }])
  })

  test("no id opens this month's folder, or the root when it's missing", () => {
    const fake = fixture()
    const now = new Date()
    const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`
    fake.addRecording(month, "keep.txt")
    fake.run(["open"])
    rmSync(join(fake.screenshots, month), { recursive: true })
    const out = fake.run(["open"])
    expect(out.stderr).toContain("warning: no folder for this month yet")
    const explorer = fake.calls().filter((c) => c.name === "explorer.exe")
    expect(explorer.map((c) => c.argv)).toEqual([
      [`C:\\Users\\test\\Documents\\ShareX\\Screenshots\\${month}`],
      ["C:\\Users\\test\\Documents\\ShareX\\Screenshots"],
    ])
  })

  test("--dry-run prints the explorer command and runs nothing", () => {
    const fake = fixture()
    const out = fake.run(["--dry-run", "open", "last"])
    expect(out.stdout).toBe("explorer.exe /select,C:\\Users\\test\\Documents\\" +
      "ShareX\\Screenshots\\2026-11\\26-11-18__215216-audio.mp3\n")
    expect(fake.calls().some((c) => c.name === "explorer.exe")).toBe(false)
  })
})

describe("ac note", () => {
  const sidecarFile = (fake: FakeWindows) =>
    join(fake.screenshots, "2026-11", "26-11-18__113708-audio.json")

  test("creates a v1 sidecar and then merges into it", () => {
    const fake = fixture()
    const first = fake.run(["note", "26-11-18__11370", "Infra call",
      "--tag", "call,infra", "--link", "https://example.com/1"])
    expect(first.stderr).toBe("")
    expect(first.stdout).toBe(`💚 Saved ${sidecarFile(fake)}\n`)
    const created = JSON.parse(readFileSync(sidecarFile(fake), "utf8"))
    expect(Object.keys(created)).toEqual(
      ["version", "recording", "note", "tags", "links", "updated"])
    expect(created).toMatchObject({
      version: 1, recording: "26-11-18__113708-audio.mp3", note: "Infra call",
      tags: ["call", "infra"], links: ["https://example.com/1"],
    })

    fake.run(["note", "26-11-18__11370", "--tag", "infra,followup",
      "--link", "https://example.com/1", "--link", "https://example.com/2"])
    const merged = JSON.parse(readFileSync(sidecarFile(fake), "utf8"))
    expect(merged.note).toBe("Infra call")
    expect(merged.tags).toEqual(["call", "infra", "followup"])
    expect(merged.links).toEqual(["https://example.com/1", "https://example.com/2"])

    const shown = JSON.parse(fake.run(["ls", "--json"]).stdout)
      .find((r: { name: string }) => r.name === "26-11-18__113708-audio.mp3")
    expect(shown.note).toBe("Infra call")
  })

  test("keeps unknown fields and leaves no temp files", () => {
    const fake = fixture()
    writeFileSync(sidecarFile(fake), JSON.stringify({
      version: 1, recording: "26-11-18__113708-audio.mp3", note: null,
      tags: [], links: [], updated: "2026-11-18T05:00:00Z",
      transcript: { path: "t.md" },
    }))
    fake.run(["note", "26-11-18__11370", "hello"])
    const text = readFileSync(sidecarFile(fake), "utf8")
    expect(JSON.parse(text).transcript).toEqual({ path: "t.md" })
    expect(text).toContain('\n  "note": "hello",\n')
    expect(readdirSync(join(fake.screenshots, "2026-11"))
      .filter((n) => n.endsWith(".tmp"))).toEqual([])
  })

  test("refuses to overwrite a sidecar of an unknown version", () => {
    const fake = fixture()
    writeFileSync(sidecarFile(fake), '{"version": 2}')
    const out = fake.run(["note", "26-11-18__11370", "x"])
    expect(out.code).toBe(1)
    expect(out.stderr).toContain("unsupported version 2")
    expect(readFileSync(sidecarFile(fake), "utf8")).toBe('{"version": 2}')
  })

  test("needs something to change", () => {
    const fake = fixture()
    const out = fake.run(["note", "last"])
    expect(out.code).toBe(1)
    expect(out.stderr).toContain("nothing to change")
  })
})

describe("ac index", () => {
  const indexFile = (fake: FakeWindows) => join(fake.stateDir, "index.jsonl")

  test("writes one entry per recording, newest first", () => {
    const fake = fixture()
    const out = fake.run(["index"])
    expect(out.stdout).toBe(`💚 Indexed ${indexFile(fake)}: 5 added, ` +
      "0 updated, 0 removed, 0 unchanged\n")
    const entries = readFileSync(indexFile(fake), "utf8").trim().split("\n")
      .map((line) => JSON.parse(line))
    expect(entries.map((e) => e.recording)).toEqual([
      "26-11-18__215216-audio.mp3", "26-11-18__113755-audio.mp3",
      "26-11-18__113708-audio.mp3", "26-10-30__090000-audio.mp3",
      "26-10-29__080000-audio.mp3",
    ])
    expect(Object.keys(entries[0])).toEqual([
      "version", "recording", "path", "wsl_path", "time", "size_bytes",
      "modified", "duration_s", "session", "segments", "mics", "note", "tags",
      "links", "sidecar_updated",
    ])
    expect(entries[0].path).toBe("C:\\Users\\test\\Documents\\ShareX\\" +
      "Screenshots\\2026-11\\26-11-18__215216-audio.mp3")
  })

  test("incremental updates equal a rebuild from scratch", () => {
    const fake = fixture()
    fake.run(["index"])
    // Change the world: a note (which updates the index), a new
    // recording, a deleted one, and a corrupt line in the old index.
    fake.run(["note", "26-11-18__11370", "Infra call", "--tag", "call"])
    expect(readFileSync(indexFile(fake), "utf8")).toContain('"note":"Infra call"')
    fake.addRecording("2026-11", "26-11-19__080000-audio.mp3")
    rmSync(join(fake.screenshots, "2026-10", "26-10-29__080000-audio.mp3"))
    writeFileSync(indexFile(fake), readFileSync(indexFile(fake), "utf8") + "{bad\n")
    const incremental = fake.run(["index"])
    expect(incremental.stdout).toContain("1 added, 0 updated, 2 removed, 4 unchanged")
    const afterIncremental = readFileSync(indexFile(fake), "utf8")
    rmSync(indexFile(fake))
    fake.run(["index", "--rebuild"])
    expect(readFileSync(indexFile(fake), "utf8")).toBe(afterIncremental)
    const again = fake.run(["index", "--rebuild"])
    expect(again.stdout).toContain("0 added, 0 updated, 0 removed, 5 unchanged")
    expect(readdirSync(fake.stateDir).filter((n) => n.endsWith(".tmp"))).toEqual([])
  })

  test("note does not create an index", () => {
    const fake = fixture()
    fake.run(["note", "last", "x"])
    expect(readdirSync(fake.stateDir)).not.toContain("index.jsonl")
  })

  test("errors without the audio-capture folder", () => {
    const fake = fixture()
    rmSync(fake.stateDir, { recursive: true })
    const out = fake.run(["index"])
    expect(out.code).toBe(1)
    expect(out.stderr).toContain(`ac: no audio-capture folder at ${fake.stateDir}`)
  })
})

describe("ac pick", () => {
  const picked = (key: string, name: string) =>
    ({ AC_STUB_FZF_OUT: `${key}\n${name}\t2026-11-18 11:37  row text\n` })
  const name = "26-11-18__113708-audio.mp3"
  const winPath = `C:\\Users\\test\\Documents\\ShareX\\Screenshots\\2026-11\\${name}`

  test("feeds fzf the rows with an ac show preview; enter prints the path", () => {
    const fake = fixture()
    const out = fake.run(["pick"], picked("", name))
    expect(out.stderr).toBe("")
    expect(out.stdout).toBe(join(fake.screenshots, "2026-11", name) + "\n")
    const fzf = fake.calls().filter((c) => c.name === "fzf")
    expect(fzf).toHaveLength(1)
    expect(fzf[0]?.argv).toEqual([
      "--expect=ctrl-o,ctrl-y,ctrl-n",
      "--delimiter=\t",
      "--with-nth=2",
      "--no-sort",
      `--preview=${process.execPath} ${join(import.meta.dir, "cli.ts")} show {1}`,
      "--preview-window=right,55%,wrap",
      "--header=enter: print path  ctrl-o: open  ctrl-y: copy path  ctrl-n: note",
    ])
    const lines = (fzf[0]?.stdin ?? "").trimEnd().split("\n")
    expect(lines).toHaveLength(5)
    expect(lines[0]?.startsWith("26-11-18__215216-audio.mp3\t2026-11-18 21:52"))
      .toBe(true)
  })

  test("ctrl-o selects it in Explorer", () => {
    const fake = fixture()
    fake.run(["pick"], picked("ctrl-o", name))
    expect(fake.calls().filter((c) => c.name === "explorer.exe")
      .map((c) => c.argv)).toEqual([[`/select,${winPath}`]])
  })

  test("ctrl-y copies the Windows path", () => {
    const fake = fixture()
    const out = fake.run(["pick"], picked("ctrl-y", name))
    expect(out.stdout).toBe(winPath + "\n")
    expect(fake.calls().filter((c) => c.name === "clip.exe")
      .map((c) => c.stdin)).toEqual([winPath])
  })

  test("ctrl-n asks for a note and saves it", () => {
    const fake = fixture()
    const out = fake.run(["pick"], picked("ctrl-n", name), "Great call\n")
    expect(out.code).toBe(0)
    const sidecar = JSON.parse(readFileSync(
      join(fake.screenshots, "2026-11", "26-11-18__113708-audio.json"), "utf8"))
    expect(sidecar.note).toBe("Great call")
  })

  test("--dry-run prints the action instead of running it", () => {
    const fake = fixture()
    const out = fake.run(["--dry-run", "pick"], picked("ctrl-o", name))
    expect(out.stdout).toBe(`explorer.exe /select,${winPath}\n`)
    expect(fake.calls().some((c) => c.name === "explorer.exe")).toBe(false)
  })

  test("Esc in fzf does nothing", () => {
    const fake = fixture()
    const out = fake.run(["pick"], { AC_STUB_FZF_OUT: "", AC_STUB_FZF_CODE: "130" })
    expect(out).toEqual({ code: 0, stdout: "", stderr: "" })
  })
})
