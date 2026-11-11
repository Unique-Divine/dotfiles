import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parse, type TomlTable } from "smol-toml"

import {
  applyConfig,
  dotfileConfig,
  dotfilePager,
  mergeRuntimeConfig,
  statusLinePath,
} from "./config.ts"

const scriptPath = join(import.meta.dir, "config.ts")
const statusScript = join(import.meta.dir, "statusline.sh")

const runConfig = async (
  homeDir: string,
  args: string[] = [],
): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  const proc = Bun.spawn(["bun", scriptPath, ...args], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, HOME: homeDir, GROK_HOME: "" },
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

describe("grok config", () => {
  test("sets portable defaults and keeps local tables", () => {
    const merged = mergeRuntimeConfig({
      marketplace: { official_marketplace_auto_installed: true },
      privacy: { privacy_banner_acked: "2026-11-10T00:00:00Z" },
      keys: { vim: "nav" },
      ui: {
        yolo: false,
        permission_mode: "ask",
        status_line: { type: "builtin", items: ["cwd"] },
        max_thoughts_width: 120,
      },
      mcp_servers: {
        private: { command: "launch", env: { TOKEN: "secret-value" } },
      },
    })

    expect(merged).toMatchObject({
      ...dotfileConfig,
      marketplace: { official_marketplace_auto_installed: true },
      privacy: { privacy_banner_acked: "2026-11-10T00:00:00Z" },
    })
    expect(merged.ui).toEqual({
      yolo: false,
      permission_mode: "auto",
      max_thoughts_width: 120,
      status_line: {
        type: "command",
        command: statusLinePath,
      },
    })
    expect(merged.mcp_servers).toEqual({
      private: { command: "launch", env: { TOKEN: "secret-value" } },
    })
    expect(mergeRuntimeConfig({ terminal: { fps: 30 } }, dotfilePager))
      .toEqual({
        terminal: { fps: 30, alt_screen: "never" },
      })
  })

  test("creates both runtime files, mode 0600, and is idempotent", async () => {
    const root = await mkdtemp(join(tmpdir(), "grok-config-test-"))
    const configFile = join(root, "config.toml")
    const pagerFile = join(root, "pager.toml")

    try {
      expect(
        await applyConfig({ configFile, pagerFile, quiet: true }),
      ).toBe(true)
      const configText = await Bun.file(configFile).text()
      const pagerText = await Bun.file(pagerFile).text()
      expect(parse(configText) as TomlTable).toEqual(dotfileConfig)
      expect(parse(pagerText) as TomlTable).toEqual(dotfilePager)
      expect((await stat(configFile)).mode & 0o777).toBe(0o600)
      expect((await stat(pagerFile)).mode & 0o777).toBe(0o600)
      expect(
        await applyConfig({ configFile, pagerFile, quiet: true }),
      ).toBe(false)
      expect(await Bun.file(configFile).text()).toBe(configText)
      expect(await Bun.file(pagerFile).text()).toBe(pagerText)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("preserves marketplace, privacy, and MCP servers on write", async () => {
    const root = await mkdtemp(join(tmpdir(), "grok-config-merge-test-"))
    const configFile = join(root, "config.toml")
    const pagerFile = join(root, "pager.toml")

    try {
      await writeFile(
        configFile,
        [
          "[marketplace]",
          "official_marketplace_auto_installed = true",
          "",
          "[privacy]",
          'privacy_banner_acked = "2026-11-10T00:00:00Z"',
          "",
          "[keys]",
          'vim = "nav"',
          "",
          "[ui]",
          "yolo = false",
          "",
          "[mcp_servers.private]",
          'command = "launch"',
          "",
          "[mcp_servers.private.env]",
          'TOKEN = "secret-value"',
          "",
        ].join("\n"),
      )
      await writeFile(pagerFile, "[terminal]\nfps = 30\n")

      await applyConfig({ configFile, pagerFile, quiet: true })
      const config = parse(await Bun.file(configFile).text()) as TomlTable
      const pager = parse(await Bun.file(pagerFile).text()) as TomlTable
      expect(config.marketplace).toEqual({
        official_marketplace_auto_installed: true,
      })
      expect(config.privacy).toEqual({
        privacy_banner_acked: "2026-11-10T00:00:00Z",
      })
      expect(config.mcp_servers).toEqual({
        private: { command: "launch", env: { TOKEN: "secret-value" } },
      })
      expect(config.keys).toEqual({ vim: "all" })
      expect(pager).toEqual({ terminal: { fps: 30, alt_screen: "never" } })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("rejects malformed TOML without changing it", async () => {
    const root = await mkdtemp(join(tmpdir(), "grok-config-invalid-test-"))
    const configFile = join(root, "config.toml")
    const pagerFile = join(root, "pager.toml")
    const invalidToml = "keys = [\n"

    try {
      await writeFile(configFile, invalidToml)
      await writeFile(pagerFile, "[terminal]\nalt_screen = \"never\"\n")
      await expect(
        applyConfig({ configFile, pagerFile, quiet: true }),
      ).rejects.toThrow()
      expect(await Bun.file(configFile).text()).toBe(invalidToml)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("prints help by default and checks drift without writing", async () => {
    const root = await mkdtemp(join(tmpdir(), "grok-config-cli-test-"))

    try {
      const help = await runConfig(root)
      expect(help).toMatchObject({ exitCode: 0, stderr: "" })
      expect(help.stdout).toContain("Usage:")
      expect(await Bun.file(join(root, ".grok/config.toml")).exists())
        .toBe(false)

      const check = await runConfig(root, ["--check"])
      expect(check.exitCode).toBe(1)
      expect(check.stdout).toContain("Grok config differs")
      expect(check.stdout).toContain("Grok pager differs")
      expect(await Bun.file(join(root, ".grok/config.toml")).exists())
        .toBe(false)

      const run = await runConfig(root, ["--run", "--quiet"])
      expect(run).toEqual({ exitCode: 0, stdout: "", stderr: "" })
      expect(await runConfig(root, ["--check"])).toMatchObject({
        exitCode: 0,
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("dry-run names changed keys and never prints MCP tokens", async () => {
    const root = await mkdtemp(join(tmpdir(), "grok-config-leak-test-"))
    const secret = `secret-${crypto.randomUUID()}`

    try {
      const dir = join(root, ".grok")
      await mkdir(dir, { recursive: true })
      await writeFile(
        join(dir, "config.toml"),
        [
          "[keys]",
          'vim = "nav"',
          "",
          "[mcp_servers.private.env]",
          `TOKEN = "${secret}"`,
          "",
        ].join("\n"),
      )
      await writeFile(
        join(dir, "pager.toml"),
        "[terminal]\nother = true\n",
      )

      const dryRun = await runConfig(root, ["--dry-run"])
      expect(dryRun.exitCode).toBe(0)
      expect(dryRun.stdout).toContain("~ keys.vim")
      expect(dryRun.stdout).toContain("+ terminal.alt_screen")
      expect(dryRun.stdout).not.toContain(secret)
      expect(await Bun.file(join(dir, "config.toml")).text())
        .toContain(secret)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

/** Run the status line script and strip ANSI colors. */
const renderStatusLine = async (
  session: object,
  homeDir: string,
): Promise<string> => {
  const proc = Bun.spawn(["bash", statusScript], {
    env: { ...process.env, HOME: homeDir },
    stdin: new TextEncoder().encode(JSON.stringify(session)),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, out, err] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  expect({ code, err }).toEqual({ code: 0, err: "" })
  return out.replace(/\x1b\[[0-9;]*m/g, "")
}

describe("grok status line", () => {
  test("shows the ~ path, branch, model, and context from JSON", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "grok-statusline-"))

    try {
      const repo = join(homeDir, "code", "repo")
      const text = await renderStatusLine(
        {
          workspace: {
            current_dir: repo,
            branch: "grok-portable-config",
          },
          model: { display_name: "Grok 4.7" },
          context_window: { used_percentage: 12.4 },
        },
        homeDir,
      )
      expect(text).toBe(
        `~/code/repo  \u{e0a0} grok-portable-config  Grok 4.7  12%`,
      )
    } finally {
      await rm(homeDir, { recursive: true, force: true })
    }
  })
})
