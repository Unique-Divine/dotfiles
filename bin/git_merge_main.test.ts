import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { cleanup, ok, repoPair, sh } from "./git-test-repo"

const script = join(resolve(import.meta.dir), "git_merge_main")

afterEach(cleanup)

/** A PATH with only the system tools and the given fake agent CLIs. */
async function fakeAgents(root: string, names: string[]) {
  const bin = join(root, "fake-bin")
  await mkdir(bin, { recursive: true })
  for (const name of names) {
    await writeFile(
      join(bin, name),
      `#!/bin/sh\nprintf '%s\\n' "$*" > "${root}/${name}.args"\ncat > "${root}/${name}.stdin"\n`,
      { mode: 0o755 },
    )
  }
  return `${bin}:/usr/bin:/bin`
}

const snapshot = (dir: string) =>
  ok(dir, "git rev-parse HEAD && git branch --show-current && git status --porcelain")

describe("git_merge_main", () => {
  test("fast-forwards main", async () => {
    const { clone, pushUpstream } = await repoPair()
    const upstream = await pushUpstream("two")
    const r = await sh(clone, script)
    expect(r.code, r.stderr).toBe(0)
    expect(await ok(clone, "git rev-parse HEAD")).toBe(upstream)
    expect(await ok(clone, "git branch --show-current")).toBe("main")
  })

  test("merges origin/main into a feature branch with a merge commit", async () => {
    const { clone, pushUpstream } = await repoPair()
    await ok(clone, "git switch -q -c feature")
    await ok(clone, "printf 'f\\n' > feature.txt && git add . && git commit -qm f")
    const upstream = await pushUpstream("two")

    const r = await sh(clone, script)
    expect(r.code, r.stderr).toBe(0)
    expect(await ok(clone, "git branch --show-current")).toBe("feature")
    expect(await ok(clone, "git rev-list --parents -n1 HEAD")).toContain(upstream)
    expect(await ok(clone, "cat feature.txt file.txt")).toBe("f\ntwo")
  })

  test("from a detached checkout behind main ends on main", async () => {
    const { clone, pushUpstream } = await repoPair()
    await ok(clone, "git switch -q --detach HEAD && git branch -q -D main")
    const upstream = await pushUpstream("two")

    const r = await sh(clone, script)
    expect(r.code, r.stderr).toBe(0)
    expect(await ok(clone, "git branch --show-current")).toBe("main")
    expect(await ok(clone, "git rev-parse HEAD")).toBe(upstream)
  })

  test("refuses a detached commit that isn't on main", async () => {
    const { clone } = await repoPair()
    await ok(clone, "git switch -q --detach && printf x > x && git add . && git commit -qm x")
    const before = await snapshot(clone)
    const r = await sh(clone, script)
    expect(r.code).toBe(4)
    expect(await snapshot(clone)).toBe(before)
  })

  test.each(["staged", "unstaged", "untracked"])(
    "leaves a %s working tree untouched",
    async (state) => {
      const { clone, pushUpstream } = await repoPair()
      await pushUpstream("two")
      const change = {
        staged: "printf local > file.txt && git add file.txt",
        unstaged: "printf local > file.txt",
        untracked: "printf local > new.txt",
      }[state]!
      await ok(clone, change)
      const before = await snapshot(clone)

      const r = await sh(clone, script)
      expect(r.code).toBe(2)
      expect(r.stderr).toContain("uncommitted changes")
      expect(await snapshot(clone)).toBe(before)
    },
  )

  test("a conflict aborts cleanly with exit 3", async () => {
    const { clone, pushUpstream } = await repoPair()
    await ok(clone, "git switch -q -c feature")
    await ok(clone, "printf mine > file.txt && git commit -qam mine")
    await pushUpstream("theirs")
    const before = await snapshot(clone)

    const r = await sh(clone, script)
    expect(r.code).toBe(3)
    expect(r.stderr).toContain("conflicts in: file.txt")
    expect(r.stderr).toContain("git_merge_main --agent")
    expect(await snapshot(clone)).toBe(before)
    expect(await sh(clone, "git rev-parse -q --verify MERGE_HEAD")).toMatchObject({ code: 1 })
  })

  test("a diverged main is left alone with exit 3", async () => {
    const { clone, pushUpstream } = await repoPair()
    await ok(clone, "printf x > local.txt && git add . && git commit -qm local")
    await pushUpstream("two")
    const before = await snapshot(clone)

    const r = await sh(clone, script)
    expect(r.code).toBe(3)
    expect(await snapshot(clone)).toBe(before)
  })

  test("--agent hands a conflict to claude with the prompt", async () => {
    const { root, clone, pushUpstream } = await repoPair()
    await ok(clone, "git switch -q -c feature")
    await ok(clone, "printf mine > file.txt && git commit -qam mine")
    await pushUpstream("theirs")
    const PATH = await fakeAgents(root, ["claude", "codex"])

    const r = await sh(clone, `${script} --agent`, { PATH })
    expect(r.code, r.stderr).toBe(0)
    const stdin = await readFile(join(root, "claude.stdin"), "utf8")
    expect(stdin).toContain("# Merge origin/main Into the Current Branch")
    expect(stdin).toContain("conflicts in: file.txt")
    expect(await readFile(join(root, "claude.args"), "utf8")).toContain("-p")
    expect(await Bun.file(join(root, "codex.stdin")).exists()).toBe(false)
  })

  test("--agent falls back to codex when claude is missing", async () => {
    const { root, clone } = await repoPair()
    await ok(clone, "printf local > file.txt")
    const PATH = await fakeAgents(root, ["codex"])

    const r = await sh(clone, `${script} --agent`, { PATH })
    expect(r.code, r.stderr).toBe(0)
    expect(await readFile(join(root, "codex.stdin"), "utf8")).toContain(
      "uncommitted changes",
    )
    expect(await readFile(join(root, "codex.args"), "utf8")).toContain("exec")
  })

  test("--agent with no agent installed says how to repair", async () => {
    const { root, clone } = await repoPair()
    await ok(clone, "printf local > file.txt")
    const PATH = await fakeAgents(root, [])

    const r = await sh(clone, `${script} --agent`, { PATH })
    expect(r.code).toBe(1)
    expect(r.stderr).toContain("neither claude nor codex")
  })
})
