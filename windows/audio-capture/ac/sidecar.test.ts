import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  applySidecarChange, formatSidecar, parseSidecar, readSidecar, sidecarPath,
  validateSidecar, writeSidecar, type Sidecar,
} from "./sidecar"

const dirs: string[] = []
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "ac-sidecar-"))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const now = new Date("2026-11-18T05:00:00.000Z")

describe("sidecar", () => {
  test("sidecarPath swaps the extension", () => {
    expect(sidecarPath("/a/26-11-18__113708-audio.mp3"))
      .toBe("/a/26-11-18__113708-audio.json")
  })

  test("validateSidecar accepts v1 and lists every problem", () => {
    const good = applySidecarChange(null, "x.mp3", { note: "hi" }, now)
    expect(validateSidecar(good)).toEqual([])
    expect(validateSidecar({ version: 2, recording: "", note: 3, tags: [1],
      links: "x", updated: "no" })).toEqual([
      "unsupported version 2; expected 1",
      "recording must be a non-empty string",
      "note must be a string or null",
      "tags must be strings",
      "links must be strings",
      "updated must be an ISO 8601 time",
    ])
    expect(validateSidecar([])).toEqual(["sidecar must be a JSON object"])
  })

  test("parseSidecar reports the source on bad JSON", () => {
    expect(() => parseSidecar("{", "f.json")).toThrow(/f\.json: invalid JSON/)
  })

  test("applySidecarChange merges tags and links, clears empty notes", () => {
    const first = applySidecarChange(null, "x.mp3",
      { note: "call", addTags: ["a", "b"], addLinks: ["u1"] }, now)
    const second = applySidecarChange(first, "x.mp3",
      { addTags: ["b", " c "], addLinks: ["u1", "u2"] }, now)
    expect(second.note).toBe("call")
    expect(second.tags).toEqual(["a", "b", "c"])
    expect(second.links).toEqual(["u1", "u2"])
    expect(applySidecarChange(second, "x.mp3", { note: "" }, now).note)
      .toBeNull()
  })

  test("writes are atomic, 2-space, and keep unknown fields", () => {
    const dir = tempDir()
    const mp3 = join(dir, "26-11-18__113708-audio.mp3")
    writeFileSync(mp3, "")
    const original = {
      version: 1, recording: "26-11-18__113708-audio.mp3", note: "old",
      tags: ["t"], links: [], updated: "2026-11-01T00:00:00Z",
      written_by: "audio-capture 1.2", extra: { nested: [1, 2] },
    }
    writeFileSync(sidecarPath(mp3), JSON.stringify(original))
    const next = applySidecarChange(readSidecar(mp3), "26-11-18__113708-audio.mp3",
      { note: "new" }, now)
    writeSidecar(mp3, next)
    const text = readFileSync(sidecarPath(mp3), "utf8")
    expect(text).toBe(formatSidecar(next))
    expect(text.startsWith('{\n  "version": 1,')).toBe(true)
    const parsed = JSON.parse(text) as Sidecar
    expect(parsed.written_by).toBe("audio-capture 1.2")
    expect(parsed.extra).toEqual({ nested: [1, 2] })
    expect(parsed.note).toBe("new")
    expect(parsed.updated).toBe(now.toISOString())
    expect(readdirSync(dir).sort()).toEqual([
      "26-11-18__113708-audio.json", "26-11-18__113708-audio.mp3",
    ])
  })

  test("writeSidecar refuses an invalid sidecar and leaves the old file", () => {
    const dir = tempDir()
    const mp3 = join(dir, "a.mp3")
    writeFileSync(sidecarPath(mp3), "keep")
    expect(() => writeSidecar(mp3, { version: 1 } as Sidecar)).toThrow(/invalid/)
    expect(readFileSync(sidecarPath(mp3), "utf8")).toBe("keep")
  })
})
