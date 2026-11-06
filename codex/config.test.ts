import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parse, stringify, type TomlTable } from "smol-toml"

import {
  applyConfig,
  dotfileConfig,
  mergeRuntimeConfig,
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
  test("preserves model preferences and overwrites portable defaults", () => {
    const merged = mergeRuntimeConfig({
      personality: "other",
      model: "other-model",
      model_reasoning_effort: "high",
      tui: {
        vim_mode_default: false,
        model_availability_nux: { "gpt-5.6-sol": 4 },
      },
      projects: { "/tmp/project": { trust_level: "trusted" } },
      mcp_servers: { private: { command: "private-command" } },
    })

    expect(merged).toMatchObject({
      ...dotfileConfig,
      model: "other-model",
      model_reasoning_effort: "high",
    })
    expect(merged.tui).toEqual({
      vim_mode_default: true,
      alternate_screen: "never",
      raw_output_mode: false,
      status_line: [
        "current-dir",
        "model-with-reasoning",
        "git-branch",
        "context-used",
      ],
      status_line_use_colors: true,
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
      expect(
        await applyConfig({ runtimePath, quiet: true }),
      ).toBe(true)
      const firstText = await Bun.file(runtimePath).text()
      expect(firstText).toStartWith(
        "#:schema https://developers.openai.com/codex/config-schema.json\n",
      )
      expect(parse(firstText) as TomlTable).toEqual(dotfileConfig)
      expect(
        await applyConfig({ runtimePath, quiet: true }),
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
      await mkdir(join(root, ".codex"), { recursive: true })
      await writeFile(
        runtimePath,
        '[projects."/tmp/project"]\ntrust_level = "trusted"\n\n' +
          '[mcp_servers.private]\ncommand = "private-command"\n\n' +
          "[tui]\nvim_mode_default = false\n\n" +
          '[tui.model_availability_nux]\n"gpt-5.6-sol" = 4\n',
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
        alternate_screen: "never",
        raw_output_mode: false,
        status_line: [
          "current-dir",
          "model-with-reasoning",
          "git-branch",
          "context-used",
        ],
        status_line_use_colors: true,
        model_availability_nux: { "gpt-5.6-sol": 4 },
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("adds the schema directive and preserves equivalent TOML comments", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-config-comment-test-"))

    try {
      const runtimePath = join(root, ".codex/config.toml")
      const text = `# Portable preferences\n${[
        'personality = "pragmatic"',
        'approvals_reviewer = "user"',
        'model = "gpt-6-luna"',
        'model_reasoning_effort = "medium"',
        'approval_policy = "never"',
        'sandbox_mode = "danger-full-access"',
        "",
        "[tui]",
        "vim_mode_default = true",
        'alternate_screen = "never"',
        "raw_output_mode = false",
        'status_line = ["current-dir", "model-with-reasoning", "git-branch", "context-used"]',
        "status_line_use_colors = true",
      ].join("\n")}\n`
      await mkdir(join(root, ".codex"), { recursive: true })
      await writeFile(runtimePath, text)

      expect(
        await applyConfig({ runtimePath, quiet: true }),
      ).toBe(true)
      const textWithSchema =
        "#:schema https://developers.openai.com/codex/config-schema.json\n" +
        text
      expect(await Bun.file(runtimePath).text()).toBe(textWithSchema)
      expect(
        await applyConfig({ runtimePath, quiet: true }),
      ).toBe(false)
      expect(await Bun.file(runtimePath).text()).toBe(textWithSchema)
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
      await expect(
        applyConfig({ runtimePath, quiet: true }),
      ).rejects.toThrow()
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

  test("keeps MCP servers and never prints their tokens", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-config-leak-test-"))
    const secret = `secret-${crypto.randomUUID()}`

    try {
      const runtimePath = join(root, ".codex/config.toml")
      const servers = {
        fixture: { command: "fixture-command", env: { TOKEN: secret } },
        docs: { url: "https://mcp.example.com/mcp" },
      }
      await mkdir(join(root, ".codex"), { recursive: true })
      await writeFile(
        runtimePath,
        stringify({ personality: "other", mcp_servers: servers }),
      )

      for (const flag of ["--dry-run", "--check", "--run"]) {
        const result = await runConfig(root, [flag])

        expect(result.stdout).not.toContain(secret)
        expect(result.stderr).not.toContain(secret)
        expect(result.stdout).not.toContain("mcp_servers")
      }

      const config = parse(await Bun.file(runtimePath).text()) as TomlTable
      expect(config.mcp_servers).toEqual(servers)
      expect(config.personality).toBe("pragmatic")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("does not report user model preferences as drift", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-config-model-test-"))

    try {
      const runtimePath = join(root, ".codex/config.toml")
      const initial = await runConfig(root, ["--run", "--quiet"])
      expect(initial).toEqual({ exitCode: 0, stdout: "", stderr: "" })

      const text = await Bun.file(runtimePath).text()
      await writeFile(
        runtimePath,
        text
          .replace('model = "gpt-6-luna"', 'model = "other-model"')
          .replace(
            'model_reasoning_effort = "medium"',
            'model_reasoning_effort = "high"',
          ),
      )

      expect(await runConfig(root, ["--check"])).toMatchObject({
        exitCode: 0,
        stderr: "",
      })
      expect(await Bun.file(runtimePath).text()).toContain(
        'model = "other-model"',
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
