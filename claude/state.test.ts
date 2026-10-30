import { bash } from "@uniquedivine/bash"
import { describe, expect, test } from "bun:test"
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  applyConfig, applyState, dotfileState, mergeRuntimeState, ownedState,
  runtimeStatePath, stateHasDrift, writeState,
} from "./config"

async function withState(
  run: (home: string, path: string) => Promise<void>,
): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "claude-state-"))
  try { await run(home, join(home, ".claude.json")) }
  finally { await rm(home, { recursive: true, force: true }) }
}

const uid = process.getuid?.()
const runningClaude = uid !== undefined &&
  (await bash(`pgrep -u ${uid} -x claude`)).exitCode === 0

describe("managed Claude state", () => {
  test("enforces preferences while preserving host-local state", () => {
    const local = {
      editorMode: "emacs", showExpandedTodos: false,
      hasCompletedOnboarding: false,
      oauthAccount: { accountUuid: crypto.randomUUID() },
      mcpServers: { private: { env: { TOKEN: crypto.randomUUID() } } },
      projects: { "/project": { hasTrustDialogAccepted: false } },
      machineID: crypto.randomUUID(),
    }
    const merged = mergeRuntimeState(local)
    expect(merged).toEqual({ ...local, ...dotfileState })
    expect(stateHasDrift(local)).toBe(true)
    expect(stateHasDrift(merged)).toBe(false)
    expect(ownedState(merged)).toEqual(dotfileState)
    expect(local.editorMode).toBe("emacs")
    expect(runtimeStatePath({ HOME: "/test" })).toBe("/test/.claude.json")
  })

  test("atomic write keeps other fields and a private backup", async () => {
    await withState(async (home, path) => {
      const local = { mcpServers: { private: { token: crypto.randomUUID() } } }
      const before = JSON.stringify(local)
      await writeFile(path, before)
      await writeState(path, before, mergeRuntimeState(local))
      expect(JSON.parse(await readFile(path, "utf8")))
        .toEqual({ ...local, ...dotfileState })
      expect((await stat(path)).mode & 0o777).toBe(0o600)
      const backups = (await readdir(home))
        .filter((name) => name.includes(".before-dotfiles-"))
      expect(backups).toHaveLength(1)
      const backup = join(home, backups[0]!)
      expect(await readFile(backup, "utf8")).toBe(before)
      expect((await stat(backup)).mode & 0o777).toBe(0o600)
      expect(await applyState({ runtimePath: path, quiet: true })).toBe(false)
      expect(await readdir(home)).toHaveLength(2)
    })
  })

  test("fresh file contains only managed defaults", async () => {
    await withState(async (home, path) => {
      await writeState(path, "", mergeRuntimeState({}))
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual(dotfileState)
      expect(await readdir(home)).toEqual([".claude.json"])
    })
  })

  test("refuses to replace state changed since it was read", async () => {
    await withState(async (home, path) => {
      await writeFile(path, '{"machineID":"new"}')
      await expect(writeState(path, "{}", mergeRuntimeState({})))
        .rejects.toThrow("changed during sync")
      expect(await readFile(path, "utf8")).toBe('{"machineID":"new"}')
      expect(await readdir(home)).toEqual([".claude.json"])
    })
  })

  test("CLI check is read-only and never prints unmanaged secrets", async () => {
    await withState(async (home, path) => {
      const token = crypto.randomUUID()
      const before = JSON.stringify({ mcpServers: { private: { token } } })
      await writeFile(path, before)
      for (const flag of ["--check", "--dry-run"]) {
        const proc = Bun.spawn([process.execPath,
          join(import.meta.dir, "config.ts"), flag], {
          env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: "" },
          stdout: "pipe", stderr: "pipe",
        })
        const [stdout, stderr, code] = await Promise.all([
          new Response(proc.stdout).text(), new Response(proc.stderr).text(),
          proc.exited,
        ])
        expect(stdout + stderr).not.toContain(token)
        expect(stdout + stderr).not.toContain("mcpServers")
        expect(code).toBe(flag === "--check" ? 1 : 0)
        expect(await readFile(path, "utf8")).toBe(before)
      }
      await writeState(path, before, mergeRuntimeState({
        mcpServers: { private: { token } },
      }))
      expect(await applyState({ runtimePath: path, dryRun: true, quiet: true }))
        .toBe(false)
    })
  })

  test("malformed JSON fails without changing the file", async () => {
    await withState(async (home, path) => {
      await writeFile(path, "{broken")
      await expect(applyState({ runtimePath: path, quiet: true }))
        .rejects.toThrow("Unable to parse JSON")
      expect(await readFile(path, "utf8")).toBe("{broken")
      expect(await readdir(home)).toEqual([".claude.json"])
    })
  })

  test.skipIf(!runningClaude)("refuses repair during real Claude sessions",
    async () => {
      await withState(async (home, path) => {
        const before = '{"editorMode":"emacs"}'
        await writeFile(path, before)
        const settingsPath = join(home, "settings.json")
        await writeFile(settingsPath, "{}")
        await expect(applyConfig({ settingsPath, statePath: path, quiet: true }))
          .rejects.toThrow("Claude is running")
        expect(await readFile(path, "utf8")).toBe(before)
        expect(await readFile(settingsPath, "utf8")).toBe("{}")
        expect((await readdir(home)).sort())
          .toEqual([".claude.json", "settings.json"])
      })
    })

  test.skipIf(runningClaude)("shared setup creates both runtime files",
    async () => {
      await withState(async (home, path) => {
        const settingsPath = join(home, "settings.json")
        const options = { settingsPath, statePath: path, quiet: true }
        expect(await applyConfig(options)).toBe(true)
        expect(JSON.parse(await readFile(path, "utf8"))).toEqual(dotfileState)
        const settings = JSON.parse(await readFile(settingsPath, "utf8"))
        expect(settings.tui).toBe("default")
        expect(await applyConfig(options)).toBe(false)
      })
    })
})
