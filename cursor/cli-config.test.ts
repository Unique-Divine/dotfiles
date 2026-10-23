import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  applyCliConfig,
  dotfileConfig,
  mergeRuntimeConfig,
} from "./cli-config.ts"

const scriptPath = join(import.meta.dir, "cli-config.ts")

const runCliConfig = async (
  homeDir: string,
  args: string[] = [],
): Promise<{
  exitCode: number
  stdout: string
  stderr: string
}> => {
  const proc = Bun.spawn(["bun", scriptPath, ...args], {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      HOME: homeDir,
    },
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

describe("cursor cli config", () => {
  test("overwrites owned preferences and preserves Cursor-managed runtime fields", () => {
    const merged = mergeRuntimeConfig({
      version: 1,
      permissions: {
        allow: ["Shell(echo)"],
        deny: ["Shell(rm)"],
      },
      editor: {
        vimMode: false,
      },
      attribution: {
        attributeCommitsToAgent: true,
        attributePRsToAgent: true,
      },
      display: {
        showLineNumbers: true,
      },
      authInfo: {
        email: "user@example.com",
      },
      privacyCache: {
        privacyMode: 4,
      },
      serverConfigCache: {
        backendUrl: "https://api2.cursor.sh",
      },
      model: {
        modelId: "gpt-5.5",
      },
      selectedModel: {
        modelId: "gpt-5.5",
      },
      modelParameters: {
        "gpt-5.5": [],
      },
      hasChangedDefaultModel: true,
      runEverythingSettingsPromptStreak: 1,
      showSandboxIntro: false,
    })

    expect(merged.permissions).toEqual(dotfileConfig.permissions)
    expect(merged.editor).toEqual(dotfileConfig.editor)
    expect(merged.editor).toEqual({ vimMode: true })
    expect(merged.attribution).toEqual({
      attributeCommitsToAgent: false,
      attributePRsToAgent: false,
    })
    expect(merged.display).toBeUndefined()
    expect(merged.authInfo).toEqual({ email: "user@example.com" })
    expect(merged.privacyCache).toEqual({ privacyMode: 4 })
    expect(merged.serverConfigCache).toEqual({
      backendUrl: "https://api2.cursor.sh",
    })
    expect(merged.model).toEqual({ modelId: "gpt-5.5" })
    expect(merged.selectedModel).toEqual({ modelId: "gpt-5.5" })
    expect(merged.modelParameters).toEqual({ "gpt-5.5": [] })
    expect(merged.hasChangedDefaultModel).toBe(true)
    expect(merged.runEverythingSettingsPromptStreak).toBe(1)
    expect(merged.showSandboxIntro).toBe(false)
  })

  test("writes runtime config atomically only when generated JSON differs", async () => {
    const root = await mkdtemp(join(tmpdir(), "cursor-cli-config-test-"))

    try {
      const runtimePath = join(root, ".cursor/cli-config.json")
      await mkdir(join(root, ".cursor"), { recursive: true })

      const firstChanged = await applyCliConfig({ runtimePath, quiet: true })
      const firstText = await Bun.file(runtimePath).text()
      const secondChanged = await applyCliConfig({ runtimePath, quiet: true })
      const secondText = await Bun.file(runtimePath).text()

      expect(firstChanged).toBe(true)
      expect(secondChanged).toBe(false)
      expect(JSON.parse(firstText)).toEqual(dotfileConfig)
      expect(JSON.parse(firstText).attribution).toEqual({
        attributeCommitsToAgent: false,
        attributePRsToAgent: false,
      })
      expect(secondText).toBe(firstText)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("treats blank runtime config as missing config", async () => {
    const root = await mkdtemp(join(tmpdir(), "cursor-cli-config-blank-test-"))

    try {
      const runtimePath = join(root, ".cursor/cli-config.json")
      await mkdir(join(root, ".cursor"), { recursive: true })
      await writeFile(runtimePath, " \n")

      const changed = await applyCliConfig({ runtimePath, quiet: true })

      expect(changed).toBe(true)
      expect(JSON.parse(await Bun.file(runtimePath).text())).toEqual(
        dotfileConfig,
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("reports changed key paths without printing tokens", async () => {
    const root = await mkdtemp(join(tmpdir(), "cursor-cli-config-leak-test-"))
    const secret = `secret-${crypto.randomUUID()}`

    try {
      const runtimePath = join(root, ".cursor/cli-config.json")
      await mkdir(join(root, ".cursor"), { recursive: true })
      // The token sits next to a drifted field, inside old diff context.
      await writeFile(
        runtimePath,
        `${JSON.stringify(
          {
            ...dotfileConfig,
            authInfo: { accessToken: secret },
            editor: { vimMode: false },
          },
          null,
          2,
        )}\n`,
      )

      for (const args of [["--dry-run"], ["--check"], ["--run"]]) {
        const result = await runCliConfig(root, args)

        expect(result.stdout).not.toContain(secret)
        expect(result.stderr).not.toContain(secret)

        if (args[0] !== "--run") {
          expect(result.stdout).toContain("~ editor.vimMode")
        }
      }

      expect(JSON.parse(await Bun.file(runtimePath).text()).authInfo).toEqual(
        { accessToken: secret },
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("prints help by default and writes only with --run", async () => {
    const root = await mkdtemp(join(tmpdir(), "cursor-cli-config-cli-test-"))

    try {
      const runtimePath = join(root, ".cursor/cli-config.json")
      const helpResult = await runCliConfig(root)

      expect(helpResult.exitCode).toBe(0)
      expect(helpResult.stderr).toBe("")
      expect(helpResult.stdout).toContain("Usage:")
      expect(await Bun.file(runtimePath).exists()).toBe(false)

      const runResult = await runCliConfig(root, ["--run", "--quiet"])

      expect(runResult.exitCode).toBe(0)
      expect(runResult.stdout).toBe("")
      expect(runResult.stderr).toBe("")
      expect(JSON.parse(await Bun.file(runtimePath).text())).toEqual(
        dotfileConfig,
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
