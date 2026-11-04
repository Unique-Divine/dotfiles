import { describe, expect, test } from "bun:test"
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { stringify } from "smol-toml"

import { isLauncherEntry } from "../mcp/servers.ts"
import { applyPlan, cursorMcpConfigPath, readCursorMcpFile } from "./mcp.ts"

const script = join(import.meta.dir, "mcp.ts")
const secret = `secret-${crypto.randomUUID()}`

const codexServers = {
  notion: { command: "notion-mcp-server", env: { NOTION_TOKEN: secret } },
  docs: { url: "https://docs.example.com/mcp" },
  keyed: {
    url: "https://keyed.example.com/mcp",
    http_headers: { "X-Api-Key": `header-${secret}` },
  },
}

/** Today's Cursor file: full copies with env, written by hand. */
const legacyCursorFile = {
  version: 1,
  mcpServers: {
    notion: { command: "notion-mcp-server", env: { NOTION_TOKEN: secret } },
    personal: { command: "my-server", env: { MY_TOKEN: secret } },
  },
}

interface Fixture {
  dir: string
  source: string
  cursorConfig: string
  statePath: string
  run: (flag: string) => Promise<{
    exitCode: number; stdout: string; stderr: string
  }>
}

const withFixture = async (
  test: (fixture: Fixture) => Promise<void>,
): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), "cursor-mcp-"))
  const source = join(dir, "config.toml")
  const cursorConfig = join(dir, "mcp.json")
  const statePath = join(dir, "state.json")
  const run = async (flag: string) => {
    const proc = Bun.spawn([
      "bun", script, flag, "--mcp-source", source,
      "--cursor-config", cursorConfig, "--state", statePath,
    ], { stdout: "pipe", stderr: "pipe" })
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    return { exitCode, stdout, stderr }
  }

  try {
    await writeFile(source, stringify({ mcp_servers: codexServers }))
    await test({ dir, source, cursorConfig, statePath, run })
  } finally {
    await rm(dir, { force: true, recursive: true })
  }
}

describe("cursor mcp", () => {
  test("defaults to the Cursor CLI file under HOME", () => {
    expect(cursorMcpConfigPath({ HOME: "/h" })).toBe("/h/.cursor/mcp.json")
  })

  test("applyPlan keeps other keys and unplanned servers", () => {
    const next = applyPlan(
      { version: 1, mcpServers: {} },
      { keep: { command: "k" }, gone: { command: "g" } },
      {
        add: [{ name: "new", entry: { url: "https://x" } }],
        update: [],
        remove: ["gone"],
        skip: [],
      },
    )
    expect(next).toEqual({
      version: 1,
      mcpServers: { keep: { command: "k" }, new: { url: "https://x" } },
    })
  })

  test("converts a legacy file, backs it up, and is idempotent", async () => {
    await withFixture(async ({ dir, cursorConfig, statePath, run }) => {
      await writeFile(cursorConfig, JSON.stringify(legacyCursorFile))

      const check = await run("--check")
      expect(check.exitCode).toBe(1)
      expect(check.stdout).toContain("+ add docs")
      expect(check.stdout).not.toContain(secret)
      expect(check.stdout).toContain("~ replace notion (unmanaged Cursor entry)")
      expect(check.stdout).not.toContain("personal")

      const result = await run("--run")
      expect(result.exitCode).toBe(0)

      const { config, servers } = await readCursorMcpFile(cursorConfig)
      expect(config.version).toBe(1)
      expect(isLauncherEntry(servers.notion)).toBe(true)
      expect(servers.notion).not.toHaveProperty("type")
      expect(servers.docs).toEqual({ url: "https://docs.example.com/mcp" })
      expect(servers.personal).toEqual(legacyCursorFile.mcpServers.personal)
      expect((await stat(cursorConfig)).mode & 0o777).toBe(0o600)

      const backups = (await readdir(dir))
        .filter((name) => name.startsWith("mcp.json.before-dotfiles-"))
      expect(backups.length).toBe(1)
      expect(await Bun.file(join(dir, backups[0])).json())
        .toEqual(legacyCursorFile)
      expect(await Bun.file(statePath).json()).toEqual({
        version: 1, targets: { [cursorConfig]: ["docs", "keyed"] },
      })

      const again = await run("--check")
      expect(again.exitCode).toBe(0)
      expect(again.stdout).toContain("already current")
    })
  })

  test("removes owned servers that left Codex and keeps the rest", async () => {
    await withFixture(async ({ source, cursorConfig, run }) => {
      await run("--run")
      await writeFile(source, "")
      const { servers: before } = await readCursorMcpFile(cursorConfig)
      await writeFile(cursorConfig, JSON.stringify({
        mcpServers: { ...before, mine: { url: "https://mine.example.com" } },
      }))

      const result = await run("--run")
      expect(result.exitCode).toBe(0)
      const { servers } = await readCursorMcpFile(cursorConfig)
      expect(servers).toEqual({ mine: { url: "https://mine.example.com" } })
    })
  })

  test("creates a missing file; only --print shows header values", async () => {
    await withFixture(async ({ cursorConfig, run }) => {
      for (const flag of ["--dry-run", "--check", "--run"]) {
        const result = await run(flag)
        expect(result.stdout).not.toContain(secret)
        expect(result.stderr).not.toContain(secret)
      }

      const text = await Bun.file(cursorConfig).text()
      expect(text).not.toContain("NOTION_TOKEN")
      expect(JSON.parse(text).mcpServers.keyed.headers)
        .toEqual({ "X-Api-Key": `header-${secret}` })
      const printed = await run("--print")
      expect(Object.keys(JSON.parse(printed.stdout)))
        .toEqual(["docs", "keyed", "notion"])
      expect(printed.stdout).not.toContain("NOTION_TOKEN")
    })
  })

  test("rejects a malformed Cursor file without writing", async () => {
    await withFixture(async ({ cursorConfig, run }) => {
      await writeFile(cursorConfig, '{"mcpServers": []}')
      const result = await run("--run")
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain("mcpServers must be an object")
      expect(await Bun.file(cursorConfig).text()).toBe('{"mcpServers": []}')
    })
  })
})
