import { describe, expect, test } from "bun:test"
import { join } from "node:path"

import { advice } from "./npm"

const script = join(import.meta.dir, "npm")
const npxScript = join(import.meta.dir, "npx")

function run(path: string, args: string[]) {
  const proc = Bun.spawnSync([path, ...args])
  return {
    code: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  }
}

describe("bin/npm", () => {
  test("install without args points to bun install", () => {
    expect(advice(["install"])).toContain("bun install")
  })

  test("install with a package points to bun add", () => {
    expect(advice(["install", "zod"])).toContain("bun add zod")
  })

  test("registry commands use real npm through bunx", () => {
    expect(advice(["publish", "--access", "public"])).toContain(
      "bunx npm@12.2.0 publish --access public",
    )
  })

  test("no args lists common equivalents", () => {
    expect(advice([])).toContain("bun add <pkg>")
  })

  test("the program exits 1 and writes advice to stderr", () => {
    const result = run(script, ["ci"])
    expect(result.code).toBe(1)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("bun install --frozen-lockfile")
  })
})

describe("bin/npx", () => {
  test("forwards to bunx", () => {
    const result = run(npxScript, ["--version"])
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe(Bun.version)
  })
})
