import { afterEach, describe, expect, test } from "bun:test"
import { join, resolve } from "node:path"
import { cleanup, ok, repoPair, sh } from "./git-test-repo"

const binDir = resolve(import.meta.dir)

const run = (name: string, args: string[]) =>
  Bun.spawnSync([join(binDir, name), ...args], {
    stderr: "pipe",
    stdout: "pipe",
  })

afterEach(cleanup)

describe("git_mf", () => {
  test("--help prints usage and exits 0", () => {
    const result = run("git_mf", ["--help"])
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toContain("Usage: git_mf")
  })

  test("merges the updated target into the starting branch", async () => {
    const { clone, pushUpstream } = await repoPair()
    await ok(clone, "git switch -q -c feature")
    await ok(clone, "printf 'f\\n' > feature.txt && git add . && git commit -qm f")
    const upstream = await pushUpstream("two")

    const r = await sh(clone, `${join(binDir, "git_mf")} main`)
    expect(r.code, r.stderr).toBe(0)
    expect(await ok(clone, "git branch --show-current")).toBe("feature")
    expect(
      await ok(clone, `git merge-base --is-ancestor ${upstream} HEAD && echo yes`),
    ).toBe("yes")
  })

  test("from a detached checkout ends on the updated target", async () => {
    const { clone, pushUpstream } = await repoPair()
    await ok(clone, "git switch -q --detach HEAD")
    const upstream = await pushUpstream("two")

    const r = await sh(clone, `${join(binDir, "git_mf")} main`)
    expect(r.code, r.stderr).toBe(0)
    expect(r.stdout).toContain("Started detached; now on main")
    expect(await ok(clone, "git branch --show-current")).toBe("main")
    expect(await ok(clone, "git rev-parse HEAD")).toBe(upstream)
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
