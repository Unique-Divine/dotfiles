import { describe, expect, test } from "bun:test"
import { join } from "node:path"

const npmScript = join(import.meta.dir, "npm")
const npxScript = join(import.meta.dir, "npx")

function run(path: string, args: string[]) {
  const proc = Bun.spawnSync([path, ...args])
  return {
    code: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  }
}

/** Runs bin/npm, which must fail without writing to stdout. */
function npm(args: string[]): string {
  const result = run(npmScript, args)
  expect(result.code).toBe(1)
  expect(result.stdout).toBe("")
  return result.stderr
}

describe("bin/npm", () => {
  test("install without args points to bun install", () => {
    expect(npm(["install"])).toContain("bun install")
  })

  test("install with a package points to bun add", () => {
    expect(npm(["install", "zod"])).toContain("bun add zod")
  })

  test("ci points to a frozen bun install", () => {
    expect(npm(["ci"])).toContain("bun install --frozen-lockfile")
  })

  test("registry commands use real npm through bunx", () => {
    expect(npm(["publish", "--access", "public"])).toContain(
      "bunx npm@12.2.0 publish --access public",
    )
  })

  test("no args lists common equivalents", () => {
    expect(npm([])).toContain("bun add <pkg>")
  })
})

describe("bin/npx", () => {
  test("forwards to bunx", () => {
    const result = run(npxScript, ["--version"])
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe(Bun.version)
  })
})
