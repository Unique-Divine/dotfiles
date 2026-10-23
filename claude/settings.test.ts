import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  applySettings,
  dotfileSettings,
  mergeRuntimeSettings,
  ownedView,
} from "./settings.ts"

const scriptPath = join(import.meta.dir, "settings.ts")

const runSettings = async (
  homeDir: string,
  args: string[] = [],
): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  const proc = Bun.spawn(["bun", scriptPath, ...args], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, HOME: homeDir },
    stderr: "pipe",
    stdout: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])

  return { exitCode, stdout, stderr }
}

const withHome = async (
  settings: object | undefined,
  run: (homeDir: string, settingsPath: string) => Promise<void>,
): Promise<void> => {
  const homeDir = await mkdtemp(join(tmpdir(), "claude-settings-"))
  const settingsPath = join(homeDir, ".claude/settings.json")

  try {
    if (settings !== undefined) {
      await mkdir(join(homeDir, ".claude"), { recursive: true })
      await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`)
    }

    await run(homeDir, settingsPath)
  } finally {
    await rm(homeDir, { force: true, recursive: true })
  }
}

describe("claude settings", () => {
  test("hides commit, PR, and session-link attribution", () => {
    expect(dotfileSettings.attribution).toEqual({
      commit: "",
      pr: "",
      sessionUrl: false,
    })
  })

  test("overwrites owned keys and keeps runtime keys", () => {
    const merged = mergeRuntimeSettings({
      model: "opus",
      editorMode: "vim",
      permissions: { allow: ["Bash(ls)"] },
      attribution: { commit: "Co-Authored-By: someone", pr: "footer" },
      includeCoAuthoredBy: true,
    })

    expect(merged).toEqual({
      model: "opus",
      editorMode: "vim",
      permissions: { allow: ["Bash(ls)"] },
      attribution: dotfileSettings.attribution,
    })
  })

  test("adds owned keys to an empty runtime file", () => {
    expect(mergeRuntimeSettings({})).toEqual(dotfileSettings)
  })

  test("owned view excludes unmanaged keys", () => {
    expect(
      ownedView({ env: { TOKEN: "x" }, attribution: { pr: "" } }),
    ).toEqual({ attribution: { pr: "" } })
  })

  test("writes once, then reports current", async () => {
    await withHome({ editorMode: "vim" }, async (_homeDir, settingsPath) => {
      expect(await applySettings({ runtimePath: settingsPath, quiet: true }))
        .toBe(true)
      expect(await Bun.file(settingsPath).json()).toEqual({
        editorMode: "vim",
        ...dotfileSettings,
      })
      expect((await stat(settingsPath)).mode & 0o777).toBe(0o600)
      expect(await applySettings({ runtimePath: settingsPath, quiet: true }))
        .toBe(false)
    })
  })

  test("dry run leaves the file unchanged", async () => {
    await withHome({ editorMode: "vim" }, async (_homeDir, settingsPath) => {
      const before = await Bun.file(settingsPath).text()

      expect(
        await applySettings({
          runtimePath: settingsPath,
          dryRun: true,
          quiet: true,
        }),
      ).toBe(true)
      expect(await Bun.file(settingsPath).text()).toBe(before)
    })
  })

  test("creates the settings file when it is missing", async () => {
    await withHome(undefined, async (homeDir, settingsPath) => {
      const result = await runSettings(homeDir, ["--run", "--quiet"])

      expect(result.exitCode).toBe(0)
      expect(await Bun.file(settingsPath).json()).toEqual(dotfileSettings)
    })
  })

  test("--check exits 1 on drift and 0 when current", async () => {
    await withHome({}, async (homeDir) => {
      expect((await runSettings(homeDir, ["--check"])).exitCode).toBe(1)
      await runSettings(homeDir, ["--run", "--quiet"])
      expect((await runSettings(homeDir, ["--check"])).exitCode).toBe(0)
    })
  })

  test("output never shows unmanaged values", async () => {
    const secret = `secret-${crypto.randomUUID()}`

    await withHome(
      { env: { API_TOKEN: secret }, includeCoAuthoredBy: true },
      async (homeDir) => {
        for (const args of [["--dry-run"], ["--check"], ["--print"]]) {
          const result = await runSettings(homeDir, args)

          expect(result.stdout).not.toContain(secret)
          expect(result.stderr).not.toContain(secret)
        }

        const dryRun = await runSettings(homeDir, ["--dry-run"])
        expect(dryRun.stdout).toContain("-  \"includeCoAuthoredBy\": true")
        expect(dryRun.stdout).toContain("+    \"sessionUrl\": false")
      },
    )
  })
})
