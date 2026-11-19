import { describe, expect, test } from "bun:test"
import { parseLogLines, savedSeconds, sessionFacts, winPathKey } from "./log"
import { parseSince } from "./recordings"
import { formatCommand, winToWslVia, wslToWinVia } from "./system"
import {
  expandDates, expandFolders, parseNameTime, splitDir, templateMatcher,
} from "./templates"

describe("templates", () => {
  test("splitDir separates the fixed root from dated folders", () => {
    expect(splitDir("{documents}/ShareX/Screenshots/{yyyy-MM}")).toEqual({
      root: ["{documents}", "ShareX", "Screenshots"], dated: ["{yyyy-MM}"],
    })
    expect(splitDir("{home}\\rec")).toEqual({ root: ["{home}", "rec"], dated: [] })
  })

  test("expandFolders and expandDates", () => {
    expect(expandFolders("{Documents}\\a", { documents: "C:\\D\\" })).toBe("C:\\D\\a")
    expect(() => expandFolders("{music}", {})).toThrow("unknown folder {music}")
    const date = new Date(2026, 10, 8, 7, 5, 9, 42)
    expect(expandDates("{yyyy-MM}", date)).toBe("2026-11")
    expect(expandDates("{yy-MM-dd}__{HHmmss}-{fff}", date))
      .toBe("26-11-08__070509-042")
  })

  test("templateMatcher matches only names the template makes", () => {
    const { regex } = templateMatcher("{yy-MM-dd}__{HHmmss}-audio.mp3")
    expect(regex.test("26-11-18__113708-audio.mp3")).toBe(true)
    expect(regex.test("26-11-18__113708-audio.MP3")).toBe(true)
    expect(regex.test("26-11-18__113708.png")).toBe(false)
    expect(regex.test("x26-11-18__113708-audio.mp3")).toBe(false)
    expect(regex.test("26-11-18__113708-audio-2.mp3")).toBe(false)
  })

  test("collisionSuffix accepts Paths.Unique names and keeps their time", () => {
    const template = "{yy-MM-dd}__{HHmmss}-audio.mp3"
    const { regex } = templateMatcher(template, { collisionSuffix: true })
    for (const name of ["26-11-18__113708-audio.mp3",
      "26-11-18__113708-audio-2.mp3", "26-11-18__113708-audio-12.mp3"]) {
      expect(regex.test(name)).toBe(true)
    }
    for (const name of ["26-11-18__113708-audio-1.mp3",
      "26-11-18__113708-audio-02.mp3", "26-11-18__113708-audio-x.mp3",
      "26-11-18__113708-audio.mp3-2"]) {
      expect(regex.test(name)).toBe(false)
    }
    expect(parseNameTime("26-11-18__113708-audio-3.mp3", template))
      .toEqual(new Date(2026, 10, 18, 11, 37, 8))
  })

  test("parseNameTime reads the local time from a name", () => {
    expect(parseNameTime("26-11-18__113708-audio.mp3",
      "{yy-MM-dd}__{HHmmss}-audio.mp3")).toEqual(new Date(2026, 10, 18, 11, 37, 8))
    expect(parseNameTime("nope.mp3", "{yy-MM-dd}.mp3")).toBeNull()
    // No calendar date in the name: no time from the name at all.
    expect(parseNameTime("113708.mp3", "{HHmmss}.mp3")).toBeNull()
    expect(parseNameTime("11-18_1137.mp3", "{MM-dd}_{HHmm}.mp3")).toBeNull()
  })
})

describe("parseSince", () => {
  const now = new Date("2026-11-19T12:00:00Z")
  test("relative units", () => {
    expect(parseSince("30m", now).toISOString()).toBe("2026-11-19T11:30:00.000Z")
    expect(parseSince("12h", now).toISOString()).toBe("2026-11-19T00:00:00.000Z")
    expect(parseSince("2d", now).toISOString()).toBe("2026-11-17T12:00:00.000Z")
    expect(parseSince("1w", now).toISOString()).toBe("2026-11-12T12:00:00.000Z")
  })
  test("local dates and date-times", () => {
    expect(parseSince("2026-11-01", now)).toEqual(new Date(2026, 10, 1))
    expect(parseSince("2026-11-01T09:30", now)).toEqual(new Date(2026, 10, 1, 9, 30))
  })
  test("anything else is an error that names the forms", () => {
    expect(() => parseSince("2 days", now)).toThrow(/use 30m, 12h, 2d, 1w/)
    expect(() => parseSince("2026-13-45T", now)).toThrow(/invalid --since/)
  })
})

describe("log", () => {
  test("skips bad lines and groups facts by session", () => {
    const events = parseLogLines([
      '{"ts":"t1","event":"recording.start","session":"s","dir":"C:\\\\x",' +
        '"mic_policy":"follow"}',
      "not json",
      '{"ts":"t2","event":"segment.start","session":"s","kind":"mic","device":"A"}',
      '{"ts":"t3","event":"mix.segment","session":"s","kind":"mic","device":"B",' +
        '"file":"mic-02.pcm","start":1,"media_seconds":2}',
      '{"ts":"t4","event":"mix.done","session":"s","ok":true,' +
        '"msg":"saved C:\\\\a.mp3 (15.6 s, expected 15.6 s)","output":"C:\\\\a.mp3"}',
      '{"ts":"t5"}',
    ].join("\n"))
    expect(events).toHaveLength(4)
    const facts = sessionFacts(events).get("s")
    expect(facts?.mics).toEqual(["A", "B"])
    expect(facts?.session_dir).toBe("C:\\x")
    expect(facts?.saved?.duration_s).toBe(15.6)
    expect(facts?.segments).toHaveLength(1)
  })
  test("winPathKey normalizes slashes, repeats, and case", () => {
    expect(winPathKey("C:/Users//Test\\Rec\\\\a.MP3")).toBe("c:\\users\\test\\rec\\a.mp3")
    expect(winPathKey("\\\\server\\share\\a.mp3")).toBe("\\\\server\\share\\a.mp3")
  })

  test("savedSeconds", () => {
    expect(savedSeconds("saved x (2.0 s, expected 2.0 s)")).toBe(2)
    expect(savedSeconds(null)).toBeNull()
  })
})

describe("system path mapping", () => {
  const pairs = [{ win: "C:\\Users\\t", wsl: "/mnt/c/Users/t" }]
  test("maps both ways under a known pair, case-insensitively on Windows", () => {
    expect(wslToWinVia("/mnt/c/Users/t/a b/x.mp3", pairs)).toBe("C:\\Users\\t\\a b\\x.mp3")
    expect(winToWslVia("c:\\users\\T\\x.mp3", pairs)).toBe("/mnt/c/Users/t/x.mp3")
    expect(wslToWinVia("/mnt/c/Users/tt", pairs)).toBeNull()
  })
  test("formatCommand quotes only when needed", () => {
    expect(formatCommand(["explorer.exe", "/select,C:\\a\\b.mp3"]))
      .toBe("explorer.exe /select,C:\\a\\b.mp3")
    expect(formatCommand(["clip.exe"], "it's")).toBe(`printf %s 'it'"'"'s' | clip.exe`)
  })
})
