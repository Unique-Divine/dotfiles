import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { parse, type TomlTable } from "smol-toml"

import {
  applyConfig,
  dotfileConfig,
  mergeRuntimeConfig,
  readCursorMcpServers,
} from "./config.ts"

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

  test("merges Cursor MCP servers by name and replaces matching entries", () => {
    const merged = mergeRuntimeConfig(
      {
        mcp_servers: {
          cursor: {
            command: "old-command",
            env: { OLD_SECRET: "old" },
          },
          private: { command: "private-command" },
        },
      },
      dotfileConfig,
      {
        cursor: {
          command: "new-command",
          args: ["--serve"],
          env: { NEW_SECRET: "new" },
        },
      },
    )

    expect(merged.mcp_servers).toEqual({
      cursor: {
        command: "new-command",
        args: ["--serve"],
        env: { NEW_SECRET: "new" },
      },
      private: { command: "private-command" },
    })
  })

  test("creates the runtime config and is idempotent", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-config-test-"))

    try {
      const runtimePath = join(root, ".codex/config.toml")
      const mcpSourcePath = join(root, "missing-cursor-mcp.json")
      expect(
        await applyConfig({ runtimePath, mcpSourcePath, quiet: true }),
      ).toBe(true)
      const firstText = await Bun.file(runtimePath).text()
      expect(parse(firstText) as TomlTable).toEqual(dotfileConfig)
      expect(
        await applyConfig({ runtimePath, mcpSourcePath, quiet: true }),
      ).toBe(false)
      expect(await Bun.file(runtimePath).text()).toBe(firstText)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("preserves local config when writing", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-config-merge-test-"))

    try {
      const runtimePath = join(root, ".codex/config.toml")
      const mcpSourcePath = join(root, "missing-cursor-mcp.json")
      await mkdir(join(root, ".codex"), { recursive: true })
      await writeFile(
        runtimePath,
        '[projects."/tmp/project"]\ntrust_level = "trusted"\n\n' +
          '[mcp_servers.private]\ncommand = "private-command"\n\n' +
          "[tui]\nvim_mode_default = false\n\n" +
          '[tui.model_availability_nux]\n"gpt-5.6-sol" = 4\n',
      )

      await applyConfig({ runtimePath, mcpSourcePath, quiet: true })
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

  test("imports Cursor MCP JSON from a configurable source", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-config-mcp-test-"))

    try {
      const runtimePath = join(root, ".codex/config.toml")
      const mcpSourcePath = join(root, "cursor-mcp.json")
      await writeFile(
        mcpSourcePath,
        JSON.stringify({
          mcpServers: {
            telegram: {
              command: "uv",
              args: ["--directory", "/tmp/telegram", "run", "main.py"],
              env: { TELEGRAM_TOKEN: "fixture-token" },
            },
          },
        }),
      )

      expect(
        await applyConfig({ runtimePath, mcpSourcePath, quiet: true }),
      ).toBe(true)
      const config = parse(await Bun.file(runtimePath).text()) as TomlTable
      expect(config.mcp_servers).toEqual({
        telegram: {
          command: "uv",
          args: ["--directory", "/tmp/telegram", "run", "main.py"],
          env: { TELEGRAM_TOKEN: "fixture-token" },
        },
      })
      expect(
        await applyConfig({ runtimePath, mcpSourcePath, quiet: true }),
      ).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("skips a missing source and a source without mcpServers", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-config-empty-mcp-test-"))

    try {
      const missingPath = join(root, "missing.json")
      expect(await readCursorMcpServers(missingPath)).toEqual({})

      const sourcePath = join(root, "cursor-mcp.json")
      await writeFile(sourcePath, JSON.stringify({ version: 1 }))
      expect(await readCursorMcpServers(sourcePath)).toEqual({})
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("rejects invalid Cursor MCP JSON without changing runtime config", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-config-invalid-mcp-test-"))

    try {
      const runtimePath = join(root, ".codex/config.toml")
      const sourcePath = join(root, "cursor-mcp.json")
      const runtimeText = 'model = "existing-model"\n'
      await mkdir(join(root, ".codex"), { recursive: true })
      await writeFile(runtimePath, runtimeText)
      await writeFile(sourcePath, '{"mcpServers": []}')

      await expect(
        applyConfig({ runtimePath, mcpSourcePath: sourcePath, quiet: true }),
      ).rejects.toThrow("mcpServers must be an object")
      expect(await Bun.file(runtimePath).text()).toBe(runtimeText)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("does not rewrite equivalent TOML comments or formatting", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-config-comment-test-"))

    try {
      const runtimePath = join(root, ".codex/config.toml")
      const mcpSourcePath = join(root, "missing-cursor-mcp.json")
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

      expect(
        await applyConfig({ runtimePath, mcpSourcePath, quiet: true }),
      ).toBe(false)
      expect(await Bun.file(runtimePath).text()).toBe(text)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("rejects malformed TOML without changing it", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-config-invalid-test-"))

    try {
      const runtimePath = join(root, ".codex/config.toml")
      const mcpSourcePath = join(root, "missing-cursor-mcp.json")
      const invalidToml = "model = [\n"
      await mkdir(join(root, ".codex"), { recursive: true })
      await writeFile(runtimePath, invalidToml)
      await expect(
        applyConfig({ runtimePath, mcpSourcePath, quiet: true }),
      ).rejects.toThrow()
      expect(await Bun.file(runtimePath).text()).toBe(invalidToml)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("rejects malformed Cursor JSON without changing runtime config", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-config-bad-json-test-"))

    try {
      const runtimePath = join(root, ".codex/config.toml")
      const sourcePath = join(root, "cursor-mcp.json")
      const runtimeText = 'model = "existing-model"\n'
      await mkdir(join(root, ".codex"), { recursive: true })
      await writeFile(runtimePath, runtimeText)
      await writeFile(sourcePath, "{not JSON")

      await expect(
        applyConfig({ runtimePath, mcpSourcePath: sourcePath, quiet: true }),
      ).rejects.toThrow("Unable to parse Cursor MCP config")
      expect(await Bun.file(runtimePath).text()).toBe(runtimeText)
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

  test("accepts an MCP source path from the CLI", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-config-cli-mcp-test-"))

    try {
      const sourcePath = join(root, "cursor-mcp.json")
      await writeFile(
        sourcePath,
        JSON.stringify({
          mcpServers: { fixture: { command: "fixture-command" } },
        }),
      )

      const result = await runConfig(root, [
        "--print",
        "--mcp-source",
        sourcePath,
      ])
      expect(result).toMatchObject({ exitCode: 0, stderr: "" })
      expect(result.stdout).toContain("[mcp_servers.fixture]")
      expect(result.stdout).toContain('command = "fixture-command"')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
