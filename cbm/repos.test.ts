import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  ignoreState, manifestDirs, parseManifest, planRepo, projectName,
  type RepoEntry, savedIgnorePath,
} from "./repos"

describe("manifest", () => {
  test("parses entries and drops empty remotes", () => {
    const m = parseManifest(JSON.stringify({ repos: [
      { dir: "sai-web", remote: "git@github.com:SaiDotFun/sai-web.git" },
      { dir: "gh", remote: "" },
    ] }))
    expect(m.repos).toEqual([
      { dir: "sai-web", remote: "git@github.com:SaiDotFun/sai-web.git",
        note: undefined },
      { dir: "gh", remote: undefined, note: undefined },
    ])
  })

  test("rejects duplicates, paths, and a missing list", () => {
    expect(() => parseManifest('{"repos":[{"dir":"a"},{"dir":"a"}]}'))
      .toThrow("listed twice")
    expect(() => parseManifest('{"repos":[{"dir":"../etc"}]}'))
      .toThrow("plain dir name")
    expect(() => parseManifest("{}")).toThrow("no repos list")
  })

  test("manifestDirs keeps file order", () => {
    const dir = mkdtempSync(join(tmpdir(), "cbm-repos-"))
    const path = join(dir, "repos.json")
    writeFileSync(path, JSON.stringify({ repos: [{ dir: "x" }, { dir: "boku" }] }))
    expect(manifestDirs(path)).toEqual(["x", "boku"])
  })

  test("the checked-in manifest parses and ends with boku", () => {
    const dirs = manifestDirs()
    expect(dirs.at(-1)).toBe("boku")
    expect(new Set(dirs).size).toBe(dirs.length)
  })

  test("project names match Codebase Memory's", () => {
    expect(projectName("/home/u", "gh-io-ud")).toBe("home-u-gh-io-ud")
    expect(savedIgnorePath("gh", "/d")).toBe("/d/gh.cbmignore")
  })
})

describe("ignoreState", () => {
  test("each combination", () => {
    expect(ignoreState({ tracked: true, local: "a" })).toBe("tracked")
    expect(ignoreState({ tracked: false })).toBe("none")
    expect(ignoreState({ tracked: false, saved: "a" })).toBe("not-restored")
    expect(ignoreState({ tracked: false, local: "a" })).toBe("unsaved")
    expect(ignoreState({ tracked: false, local: "a", saved: "a" }))
      .toBe("in-sync")
    expect(ignoreState({ tracked: false, local: "a", saved: "b" }))
      .toBe("differs")
  })
})

describe("planRepo", () => {
  const e: RepoEntry = { dir: "sai-web", remote: "git@x:o/sai-web.git" }
  const disk = { present: true, isGit: true, excluded: true,
    ignore: "in-sync" as const }

  test("a synced repo needs nothing", () => {
    expect(planRepo(e, disk)).toEqual([])
  })

  test("a missing checkout is skipped unless cloning is asked for", () => {
    const missing = { ...disk, present: false, excluded: false,
      ignore: "not-restored" as const }
    expect(planRepo(e, missing)).toEqual(
      [{ kind: "skip", dir: "sai-web", reason: "not on this machine" }])
    expect(planRepo(e, missing, true).map((a) => a.kind))
      .toEqual(["clone", "write-ignore", "exclude"])
  })

  test("a missing folder without a remote can't be cloned", () => {
    expect(planRepo({ dir: "gh" }, { ...disk, present: false,
      ignore: "not-restored" }, true)[0]).toMatchObject({ kind: "skip" })
  })

  test("never overwrites a different local .cbmignore", () => {
    const plan = planRepo(e, { ...disk, ignore: "differs" })
    expect(plan.map((a) => a.kind)).toEqual(["skip"])
  })

  test("a folder that isn't a Git checkout gets no exclude line", () => {
    expect(planRepo({ dir: "gh" }, { present: true, isGit: false,
      excluded: false, ignore: "not-restored" }).map((a) => a.kind))
      .toEqual(["write-ignore"])
  })

  test("a repo that commits its .cbmignore is left alone", () => {
    expect(planRepo({ dir: "boku" }, { ...disk, excluded: false,
      ignore: "tracked" })).toEqual([])
  })
})
