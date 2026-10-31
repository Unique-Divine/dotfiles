import { afterAll, describe, expect, test } from "bun:test"
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

import {
  parseArgs,
  resolveOption,
  selectionFromValue,
  stripLastNewline,
  TARGETS_LISTING,
  type Selection,
} from "./xclip.ts"

// Expected behavior below was recorded from the real xclip 0.13 on
// 2026-10-31, so these tests do not need it installed.

describe("resolveOption", () => {
  const cases: [string, string | null][] = [
    ["-selection", "selection"],
    ["-sel", "selection"],
    ["-se", "selection"],
    ["-s", null], // ambiguous: selection, silent
    ["-si", "silent"],
    ["-o", "out"],
    ["-out", "out"],
    ["-i", "in"],
    ["-in", "in"],
    ["-v", null], // ambiguous: version, verbose
    ["-ver", null],
    ["-verb", "verbose"],
    ["-vers", "version"],
    ["-h", "help"],
    ["-he", "help"],
    ["-t", "target"],
    ["-r", "rmlastnl"],
    ["-f", "filter"],
    ["-n", "noutf8"],
    ["-q", "quiet"],
    ["-l", "loops"],
    ["-d", "display"],
    ["-O", null],
    ["-sensitive", null],
    ["-sel=c", null],
    ["--", null],
    ["-", null],
    ["file.txt", null],
  ]
  for (const [word, expected] of cases) {
    test(`${word} -> ${expected}`, () => {
      expect(resolveOption(word)).toBe(expected)
    })
  }
})

describe("selectionFromValue", () => {
  const cases: [string, Selection][] = [
    ["clipboard", "clipboard"],
    ["CLIPBOARD", "clipboard"],
    ["c", "clipboard"],
    ["Cx", "clipboard"],
    ["secondary", "secondary"],
    ["S", "secondary"],
    ["buffer-cut", "buffer-cut"],
    ["B", "buffer-cut"],
    ["primary", "primary"],
    ["pizza", "primary"],
    ["1", "primary"],
    ["", "primary"],
  ]
  for (const [value, expected] of cases) {
    test(`${JSON.stringify(value)} -> ${expected}`, () => {
      expect(selectionFromValue(value)).toBe(expected)
    })
  }
})

describe("parseArgs", () => {
  test("defaults to copying primary from stdin", () => {
    const args = parseArgs([])
    expect(args.mode).toBe("in")
    expect(args.selection).toBe("primary")
    expect(args.files).toEqual([])
  })

  test("tuicr form", () => {
    const args = parseArgs(["-selection", "clipboard"])
    expect(args.mode).toBe("in")
    expect(args.selection).toBe("clipboard")
  })

  test("last -i/-o and -selection win", () => {
    expect(parseArgs(["-o", "-i"]).mode).toBe("in")
    expect(parseArgs(["-i", "-o"]).mode).toBe("out")
    expect(parseArgs(["-sel", "c", "-sel", "p"]).selection).toBe("primary")
  })

  test("files may appear between options", () => {
    const args = parseArgs(["-o", "-i", "f1", "-sel", "c", "f2"])
    expect(args.mode).toBe("in")
    expect(args.files).toEqual(["f1", "f2"])
  })

  test("a value option consumes the next word, even an option", () => {
    const args = parseArgs(["-sel", "-o"])
    expect(args.mode).toBe("in")
    expect(args.selection).toBe("primary")
  })

  test("a value option with no value becomes a file", () => {
    expect(parseArgs(["-sel"]).files).toEqual(["-sel"])
    expect(parseArgs(["-o", "-t"]).files).toEqual(["-t"])
  })

  test("unknown and ambiguous words become files", () => {
    expect(parseArgs(["-bogus", "-s", "--"]).files).toEqual([
      "-bogus",
      "-s",
      "--",
    ])
  })

  test("flags and target", () => {
    const args = parseArgs(["-f", "-r", "-verb", "-t", "UTF8_STRING"])
    expect(args.filter).toBe(true)
    expect(args.rmlastnl).toBe(true)
    expect(args.verbose).toBe(true)
    expect(args.target).toBe("UTF8_STRING")
  })

  test("ignored options still consume their values", () => {
    const args = parseArgs(["-l", "1", "-d", ":0", "-noutf8", "-quiet"])
    expect(args.files).toEqual([])
  })
})

describe("stripLastNewline", () => {
  const enc = new TextEncoder()
  const dec = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

  test("removes exactly one trailing newline", () => {
    expect(dec(stripLastNewline(enc.encode("a\n\n")))).toBe("a\n")
    expect(dec(stripLastNewline(enc.encode("a\n")))).toBe("a")
  })

  test("leaves other input alone", () => {
    expect(dec(stripLastNewline(enc.encode("a")))).toBe("a")
    expect(dec(stripLastNewline(enc.encode("")))).toBe("")
    expect(dec(stripLastNewline(enc.encode("a\r\n")))).toBe("a\r")
  })
})

// Process tests run bin/xclip with stand-in pbcopy, pbpaste, and clip.exe
// that store the clipboard in a file, so they never touch the real one.
describe("bin/xclip process", () => {
  const xclip = join(resolve(import.meta.dir), "xclip")
  const sandbox = mkdtempSync(join(tmpdir(), "xclip-test-"))
  const store = join(sandbox, "clipboard")
  const helpers: Record<string, string> = {
    pbcopy: `cat > "${store}"`,
    pbpaste: `cat "${store}"`,
    "clip.exe": `: > "${store}"`,
  }
  for (const [name, body] of Object.entries(helpers)) {
    const path = join(sandbox, name)
    writeFileSync(path, `#!/bin/sh\n${body}\n`)
    chmodSync(path, 0o755)
  }
  const env = {
    PATH: `${sandbox}:${dirname(process.execPath)}:/usr/bin:/bin`,
  }

  afterAll(() => rmSync(sandbox, { recursive: true, force: true }))

  const run = (args: string[], stdin = "") =>
    Bun.spawnSync([xclip, ...args], {
      env,
      cwd: sandbox,
      stdin: new TextEncoder().encode(stdin),
      stdout: "pipe",
      stderr: "pipe",
    })

  const clipboard = () => readFileSync(store, "utf8")

  test("tuicr copy: -selection clipboard", () => {
    const result = run(["-selection", "clipboard"], "review\n")
    expect(result.exitCode).toBe(0)
    expect(clipboard()).toBe("review\n")
  })

  test("herdr copy and paste: -in / -out", () => {
    expect(run(["-selection", "clipboard", "-in"], "pane").exitCode).toBe(0)
    const paste = run(["-selection", "clipboard", "-out"])
    expect(paste.exitCode).toBe(0)
    expect(paste.stdout.toString()).toBe("pane")
  })

  test("bytes round-trip exactly", () => {
    const text = "ünï 日本 🦀\r\nline\n\n"
    expect(run(["-sel", "c"], text).exitCode).toBe(0)
    expect(run(["-o", "-sel", "c"]).stdout.toString()).toBe(text)
  })

  test("every selection maps to the Windows clipboard", () => {
    for (const sel of [[], ["-sel", "p"], ["-sel", "s"], ["-sel", "b"]]) {
      run(sel, `via-${sel.join("")}`)
      expect(run(["-o", ...sel]).stdout.toString()).toBe(`via-${sel.join("")}`)
    }
  })

  test("files are concatenated in order", () => {
    writeFileSync(join(sandbox, "fa"), "a\n")
    writeFileSync(join(sandbox, "fb"), "b")
    expect(run(["-sel", "c", "fa", "fb"]).exitCode).toBe(0)
    expect(clipboard()).toBe("a\nb")
  })

  test("missing file fails like xclip", () => {
    const result = run(["-sel", "c", "nope"])
    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toBe(
      "xclip: nope: No such file or directory\n",
    )
  })

  test("unknown option is a missing file", () => {
    const result = run(["-bogus"])
    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain("-bogus: No such file")
  })

  test("output mode ignores extra words", () => {
    run(["-sel", "c"], "kept")
    const result = run(["-o", "-sel", "c", "extra", "-bogus"])
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toBe("kept")
  })

  test("-rmlastnl strips one newline on copy and on paste", () => {
    run(["-sel", "c", "-r"], "x\n\n")
    expect(clipboard()).toBe("x\n")
    expect(run(["-o", "-sel", "c", "-rmlastnl"]).stdout.toString()).toBe("x")
  })

  test("-filter echoes the input", () => {
    const result = run(["-sel", "c", "-f"], "echo\n")
    expect(result.stdout.toString()).toBe("echo\n")
    expect(clipboard()).toBe("echo\n")
  })

  test("empty input clears the clipboard", () => {
    run(["-sel", "c"], "before")
    expect(run(["-sel", "c"], "").exitCode).toBe(0)
    expect(clipboard()).toBe("")
  })

  test("-o -t TARGETS lists text targets", () => {
    const result = run(["-o", "-sel", "c", "-t", "TARGETS"])
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toBe(TARGETS_LISTING)
  })

  test("text targets are accepted", () => {
    run(["-sel", "c"], "t")
    for (const target of ["UTF8_STRING", "STRING", "text/plain"]) {
      const result = run(["-o", "-sel", "c", "-t", target])
      expect(result.exitCode).toBe(0)
      expect(result.stdout.toString()).toBe("t")
    }
  })

  test("image targets are rejected in both directions", () => {
    for (const args of [
      ["-o", "-sel", "c", "-t", "image/png"],
      ["-sel", "c", "-t", "image/png"],
    ]) {
      const result = run(args, "png")
      expect(result.exitCode).toBe(1)
      expect(result.stderr.toString()).toContain("not supported")
    }
  })

  test("-help and -version print to stderr and exit 0", () => {
    for (const flag of ["-h", "-help", "-version", "-vers"]) {
      const result = run([flag])
      expect(result.exitCode).toBe(0)
      expect(result.stdout.toString()).toBe("")
      expect(result.stderr.toString()).toContain("xclip")
    }
  })

  test("-verbose reports the selection on stderr", () => {
    const result = run(["-sel", "c", "-verbose"], "v")
    expect(result.stderr.toString()).toContain("clipboard (Windows clipboard)")
  })

  test("missing pbcopy is reported", () => {
    const result = Bun.spawnSync([xclip, "-sel", "c"], {
      env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin` },
      stdin: new TextEncoder().encode("x"),
      stderr: "pipe",
    })
    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain("pbcopy not found on PATH")
  })
})

// One round trip through the real Windows clipboard when the bridge exists.
const hasBridge = ["powershell.exe", "pbcopy", "pbpaste"].every(
  (cmd) => Bun.which(cmd) !== null,
)
const bridgeTest = hasBridge ? test : test.skip

bridgeTest("real Windows clipboard round trip", () => {
  const xclip = join(resolve(import.meta.dir), "xclip")
  const text = `xclip-bridge-${Date.now()} ✓\n`
  const copy = Bun.spawnSync([xclip, "-selection", "clipboard"], {
    stdin: new TextEncoder().encode(text),
  })
  expect(copy.exitCode).toBe(0)
  const paste = Bun.spawnSync([xclip, "-o", "-selection", "clipboard"], {
    stdout: "pipe",
  })
  expect(paste.stdout.toString()).toBe(text)
})
