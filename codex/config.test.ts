import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { parse, type TomlTable } from "smol-toml"

import { applyConfig, dotfileConfig, mergeRuntimeConfig } from "./config.ts"

const scriptPath = join(import.meta.dir, "config.ts")

const runConfig = async (
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

describe("codex config", () => {
  test("overwrites portable defaults and preserves local tables", () => {
    const merged = mergeRuntimeConfig({
      personality: "other",
      model: "other-model",
      tui: {
        vim_mode_default: false,
        model_availability_nux: { "gpt-5.6-sol": 4 },
      },
      projects: { "/tmp/project": { trust_level: "trusted" } },
      mcp_servers: { private: { command: "private-command" } },
    })

    expect(merged).toMatchObject(dotfileConfig)
    expect(merged.tui).toEqual({
      vim_mode_default: true,
      model_availability_nux: { "gpt-5.6-sol": 4 },
    })
    expect(merged.projects).toEqual({
      "/tmp/project": { trust_level: "trusted" },
    })
    expect(merged.mcp_servers).toEqual({
      private: { command: "private-command" },
    })
  })

  test("creates the runtime config and is idempotent", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-config-test-"))

    try {
      const runtimePath = join(root, ".codex/config.toml")
      expect(await applyConfig({ runtimePath, quiet: true })).toBe(true)
      const firstText = await Bun.file(runtimePath).text()
      expect(parse(firstText) as TomlTable).toEqual(dotfileConfig)
      expect(await applyConfig({ runtimePath, quiet: true })).toBe(false)
      expect(await Bun.file(runtimePath).text()).toBe(firstText)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("preserves local config when writing", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-config-merge-test-"))

    try {
      const runtimePath = join(root, ".codex/config.toml")
      await mkdir(join(root, ".codex"), { recursive: true })
      await writeFile(
        runtimePath,
        '[projects."/tmp/project"]\ntrust_level = "trusted"\n\n' +
          "[mcp_servers.private]\ncommand = \"private-command\"\n\n" +
          "[tui]\nvim_mode_default = false\n\n" +
          "[tui.model_availability_nux]\n\"gpt-5.6-sol\" = 4\n",
      )

      await applyConfig({ runtimePath, quiet: true })
      const config = parse(await Bun.file(runtimePath).text()) as TomlTable
      expect(config.projects).toEqual({
        "/tmp/project": { trust_level: "trusted" },
      })
      expect(config.mcp_servers).toEqual({
        private: { command: "private-command" },
      })
      expect(config.tui).toEqual({
        vim_mode_default: true,
        model_availability_nux: { "gpt-5.6-sol": 4 },
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("does not rewrite equivalent TOML comments or formatting", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-config-comment-test-"))

    try {
      const runtimePath = join(root, ".codex/config.toml")
      const text = `# Portable preferences\n${[
        'personality = "pragmatic"',
        'approvals_reviewer = "user"',
        'model = "gpt-5.6-terra"',
        'model_reasoning_effort = "medium"',
        'trust_level = "trusted"',
        'approval_policy = "never"',
        'sandbox_mode = "danger-full-access"',
        "",
        "[tui]",
        "vim_mode_default = true",
      ].join("\n")}\n`
      await mkdir(join(root, ".codex"), { recursive: true })
      await writeFile(runtimePath, text)

      expect(await applyConfig({ runtimePath, quiet: true })).toBe(false)
      expect(await Bun.file(runtimePath).text()).toBe(text)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("rejects malformed TOML without changing it", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-config-invalid-test-"))

    try {
      const runtimePath = join(root, ".codex/config.toml")
      const invalidToml = "model = [\n"
      await mkdir(join(root, ".codex"), { recursive: true })
      await writeFile(runtimePath, invalidToml)
      await expect(applyConfig({ runtimePath, quiet: true })).rejects.toThrow()
      expect(await Bun.file(runtimePath).text()).toBe(invalidToml)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("prints help by default and checks drift without writing", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-config-cli-test-"))

    try {
      const runtimePath = join(root, ".codex/config.toml")
      const help = await runConfig(root)
      expect(help).toMatchObject({ exitCode: 0, stderr: "" })
      expect(help.stdout).toContain("Usage:")
      expect(await Bun.file(runtimePath).exists()).toBe(false)

      const check = await runConfig(root, ["--check"])
      expect(check.exitCode).toBe(1)
      expect(check.stdout).toContain("Codex runtime config differs")
      expect(await Bun.file(runtimePath).exists()).toBe(false)

      const run = await runConfig(root, ["--run", "--quiet"])
      expect(run).toEqual({ exitCode: 0, stdout: "", stderr: "" })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
