import { describe, expect, test } from "bun:test"

import { builtBinary, defaultSrc, formatSteps, planInstall } from "./install.ts"

const src = "/h/cbm-ud-main"
const dest = "/h/.local/bin/codebase-memory-mcp"
const base = { src, dest, shimDir: "/shim", path: "/usr/bin" }
const has = (...paths: string[]) => (p: string) => paths.includes(p)

describe("planInstall", () => {
  test("builds, backs up, installs, then stops the daemon", () => {
    const steps = planInstall({ ...base, build: true, rollback: false,
      exists: has(`${src}/.git`, dest) })
    expect(steps.map((s) => s.argv[0])).toEqual(
      ["scripts/build.sh", "cp", "install", "pkill"])
    expect(steps[0].cwd).toBe(src)
    expect(steps[0].env).toEqual({ PATH: "/shim:/usr/bin" })
    expect(steps[1].argv).toEqual(["cp", "-p", dest, `${dest}.prev`])
    expect(steps[2].argv).toEqual(
      ["install", "-m", "0755", builtBinary(src), dest])
    expect(steps[3].optional).toBe(true)
  })

  test("skips the backup on a first install", () => {
    const steps = planInstall({ ...base, build: true, rollback: false,
      exists: has(`${src}/.git`) })
    expect(steps.map((s) => s.argv[0])).toEqual(
      ["scripts/build.sh", "install", "pkill"])
  })

  test("--no-build needs an existing build", () => {
    expect(() => planInstall({ ...base, build: false, rollback: false,
      exists: has(`${src}/.git`) })).toThrow("is missing")
    const steps = planInstall({ ...base, build: false, rollback: false,
      exists: has(`${src}/.git`, builtBinary(src)) })
    expect(steps[0].argv[0]).toBe("install")
  })

  test("rejects a missing checkout", () => {
    expect(() => planInstall({ ...base, build: true, rollback: false,
      exists: has() })).toThrow("no fork checkout")
  })

  test("rollback restores the previous binary", () => {
    const steps = planInstall({ ...base, build: true, rollback: true,
      exists: has(`${dest}.prev`) })
    expect(steps[0].argv).toEqual(
      ["install", "-m", "0755", `${dest}.prev`, dest])
    expect(() => planInstall({ ...base, build: true, rollback: true,
      exists: has() })).toThrow("no previous binary")
  })
})

describe("defaultSrc", () => {
  test("prefers the ud/main worktree, then the clone", () => {
    expect(defaultSrc("/h", has("/h/cbm-ud-main/.git",
      "/h/codebase-memory-mcp/.git"))).toBe("/h/cbm-ud-main")
    expect(defaultSrc("/h", has("/h/codebase-memory-mcp/.git")))
      .toBe("/h/codebase-memory-mcp")
    expect(defaultSrc("/h", has())).toBe("/h/cbm-ud-main")
  })
})

test("formatSteps numbers each step with its command", () => {
  expect(formatSteps([{ label: "x", argv: ["a", "b"], cwd: "/d" }]))
    .toBe("1. x\n   (in /d) a b")
})
