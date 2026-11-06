import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  applyWithManagedState,
  describePlan,
  hasChanges,
  managedNames,
  managedStatePath,
  planSync,
  readManagedState,
  sameEntry,
} from "./plan.ts"
import {
  desiredEntries, launcherEntry, type LauncherContext,
} from "./servers.ts"

const ctx: LauncherContext = {
  bunPath: "/opt/bun/bin/bun",
  launcherPath: "/home/u/dotfiles/claude/mcp-launch.ts",
  sourcePath: "/home/u/.codex/config.toml",
}

const codexServers = {
  notion: { command: "notion", env: { NOTION_TOKEN: "s" } },
  docs: { url: "https://docs.example.com/mcp" },
}

const withTempDir = async (
  run: (dir: string) => Promise<void>,
): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-plan-"))

  try {
    await run(dir)
  } finally {
    await rm(dir, { force: true, recursive: true })
  }
}

describe("planSync", () => {
  const desired = desiredEntries(codexServers, "claude", ctx)

  test("adds every desired entry to an empty target", () => {
    const plan = planSync(desired, {})
    expect(plan.add.map(({ name }) => name)).toEqual(["docs", "notion"])
    expect(describePlan(plan, "Claude")).toEqual(["+ add docs", "+ add notion"])
  })

  test("is empty when the target already matches", () => {
    const plan = planSync(desired, {
      notion: { ...launcherEntry("notion", ctx), env: {} },
      docs: { url: "https://docs.example.com/mcp", type: "http" },
    }, new Set(["docs"]))
    expect(hasChanges(plan)).toBe(false)
  })

  test("replaces same-named unmanaged entries and says so", () => {
    const plan = planSync(desired, {
      notion: { command: "npx", args: ["notion"] },
      docs: { type: "http", url: "https://old.example.com/mcp" },
    })
    expect(plan.update.map(({ name, replacesUnmanaged }) =>
      [name, replacesUnmanaged])).toEqual([["docs", true], ["notion", true]])
    expect(describePlan(plan, "Cursor")[0])
      .toBe("~ replace docs (unmanaged Cursor entry)")
  })

  test("updates a managed url entry without calling it unmanaged", () => {
    const plan = planSync(desired, {
      docs: { type: "http", url: "https://old.example.com/mcp" },
      notion: launcherEntry("notion", ctx),
    }, new Set(["docs"]))
    expect(plan.update).toEqual([{
      name: "docs",
      entry: { type: "http", url: "https://docs.example.com/mcp" },
      replacesUnmanaged: false,
    }])
  })

  test("updates entries from a moved checkout", () => {
    const moved = { ...ctx, launcherPath: "/old/dotfiles/claude/mcp-launch.ts" }
    const plan = planSync(desired, {
      notion: launcherEntry("notion", moved),
      docs: desired.entries.docs,
    }, new Set(["docs"]))
    expect(plan.update.map(({ name, replacesUnmanaged }) =>
      [name, replacesUnmanaged])).toEqual([["notion", false]])
  })

  test("removes only owned entries that left the Codex config", () => {
    const plan = planSync(desiredEntries({}, "claude", ctx), {
      stale: launcherEntry("stale", ctx),
      oldDocs: { type: "http", url: "https://old.example.com/mcp" },
      mine: { type: "http", url: "https://mine.example.com/mcp" },
      local: { command: "local-server" },
    }, new Set(["oldDocs"]))
    expect(plan.remove).toEqual(["oldDocs", "stale"])
  })

  test("keeps the old copy of a server that cannot be mapped", () => {
    const skipped = desiredEntries({
      docs: { url: "https://x", bearer_token_env_var: "T" },
    }, "claude", ctx)
    const plan = planSync(skipped, {
      docs: { type: "http", url: "https://x" },
    }, new Set(["docs"]))
    expect(plan.remove).toEqual([])
    expect(plan.skip.map(({ name }) => name)).toEqual(["docs"])
  })

  test("entry comparison ignores key order, empty env, and stdio type", () => {
    expect(sameEntry(
      { args: ["a"], command: "c", env: {} },
      { type: "stdio", command: "c", args: ["a"] },
    )).toBe(true)
    expect(sameEntry({ command: "c", args: ["b"] }, { command: "c", args: ["a"] }))
      .toBe(false)
  })
})

describe("managed state", () => {
  test("defaults to XDG state, then HOME", () => {
    expect(managedStatePath({ XDG_STATE_HOME: "/s", HOME: "/h" }))
      .toBe("/s/dotfiles/mcp-managed.json")
    expect(managedStatePath({ HOME: "/h" }))
      .toBe("/h/.local/state/dotfiles/mcp-managed.json")
  })

  test("records desired url names after a successful apply", async () => {
    await withTempDir(async (dir) => {
      const statePath = join(dir, "state/mcp-managed.json")
      const targetPath = join(dir, "claude.json")
      const desired = desiredEntries(codexServers, "claude", ctx)
      let applied = false

      await applyWithManagedState({
        statePath, targetPath, desired,
        plan: planSync(desired, {}),
        apply: async () => {
          // Names are recorded before the first target write.
          const pending = await readManagedState(statePath)
          expect([...managedNames(pending, targetPath)]).toEqual(["docs"])
          applied = true
        },
      })

      expect(applied).toBe(true)
      const state = await readManagedState(statePath)
      expect([...managedNames(state, targetPath)]).toEqual(["docs"])
      expect((await stat(statePath)).mode & 0o777).toBe(0o600)
    })
  })

  test("keeps pending names when apply fails", async () => {
    await withTempDir(async (dir) => {
      const statePath = join(dir, "mcp-managed.json")
      const targetPath = join(dir, "cursor.json")
      const desired = desiredEntries(codexServers, "cursor", ctx)

      await expect(applyWithManagedState({
        statePath, targetPath, desired,
        plan: planSync(desired, {}),
        apply: async () => { throw new Error("boom") },
      })).rejects.toThrow("boom")

      const state = await readManagedState(statePath)
      expect([...managedNames(state, targetPath)]).toEqual(["docs"])
    })
  })

  test("a failed apply never claims an untouched user entry", async () => {
    await withTempDir(async (dir) => {
      const statePath = join(dir, "mcp-managed.json")
      const targetPath = join(dir, "cursor.json")
      const desired = desiredEntries({
        ...codexServers,
        mail: { url: "https://mail.example.com/mcp" },
      }, "cursor", ctx)
      const plan = planSync(desired, {
        mail: { url: "https://user.example.com/mcp" },
      })
      expect(plan.update[0]).toMatchObject({
        name: "mail", replacesUnmanaged: true,
      })

      await expect(applyWithManagedState({
        statePath, targetPath, desired, plan,
        apply: async () => { throw new Error("boom") },
      })).rejects.toThrow("boom")

      const state = await readManagedState(statePath)
      expect([...managedNames(state, targetPath)]).toEqual(["docs"])
    })
  })

  test("no-op runs with nothing to own write no state file", async () => {
    await withTempDir(async (dir) => {
      const statePath = join(dir, "mcp-managed.json")
      const desired = desiredEntries({}, "claude", ctx)

      await applyWithManagedState({
        statePath, targetPath: join(dir, "c.json"), desired,
        plan: planSync(desired, {}),
        apply: async () => {},
      })

      expect(await Bun.file(statePath).exists()).toBe(false)
    })
  })
})
