import { describe, expect, test } from "bun:test"
import { join, resolve } from "node:path"

const binDir = resolve(import.meta.dir)

const run = (name: string, args: string[]) =>
  Bun.spawnSync([join(binDir, name), ...args], {
    stderr: "pipe",
    stdout: "pipe",
  })

describe("git_mf", () => {
  test("--help prints usage and exits 0", () => {
    const result = run("git_mf", ["--help"])
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toContain("Usage: git_mf")
  })
})

describe("git_cof", () => {
  test("--help prints usage and exits 0", () => {
    const result = run("git_cof", ["--help"])
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toContain("Usage: git_cof")
  })

  test("no args prints usage and exits 1", () => {
    const result = run("git_cof", [])
    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain("exactly 1 arg")
    expect(result.stdout.toString()).toContain("Usage: git_cof")
  })
})
