import { describe, expect, test } from "bun:test"
import { join, resolve } from "node:path"

const binDir = resolve(import.meta.dir)
const xclip = join(binDir, "xclip")

const run = (args: string[], stdin?: string) =>
  Bun.spawnSync([xclip, ...args], {
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stderr: "pipe",
    stdout: "pipe",
  })

const hasCommand = (cmd: string): boolean => Bun.which(cmd) !== null

const hasClipboardBridge =
  hasCommand("powershell.exe") &&
  hasCommand("pbcopy") &&
  hasCommand("pbpaste")

describe("xclip shim rejects unsupported args", () => {
  const cases: string[][] = [
    [],
    ["-o"],
    ["-selection", "primary"],
    ["-sel", "c"],
    ["-o", "-selection", "clipboard"],
    ["-selection", "clipboard", "-o"],
  ]

  for (const args of cases) {
    test(`'${args.join(" ")}' exits 2`, () => {
      const result = run(args)
      expect(result.exitCode).toBe(2)
      expect(result.stderr.toString()).toContain("unsupported args")
    })
  }
})

const clipboardTest = hasClipboardBridge ? test : test.skip

clipboardTest("-selection clipboard copies stdin to pbpaste", () => {
  const text = `xclip-shim-${Date.now()}`
  const copy = run(["-selection", "clipboard"], text)
  expect(copy.exitCode).toBe(0)

  const paste = Bun.spawnSync(["pbpaste"], { stdout: "pipe" })
  expect(paste.stdout.toString().trim()).toBe(text)
})
