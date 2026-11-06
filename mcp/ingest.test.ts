import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parse, stringify, type TomlTable } from "smol-toml"

import { planMcpSync } from "../claude/mcp.ts"
import { applyIngest, describeIngest, planIngest } from "./ingest.ts"
import { launcherEntry, readCodexMcpServers } from "./servers.ts"

const script = join(import.meta.dir, "ingest.ts")
const secret = `secret-${crypto.randomUUID()}`

const ctx = {
  bunPath: "/opt/bun/bin/bun",
  launcherPath: "/home/u/dotfiles/claude/mcp-launch.ts",
  sourcePath: "/home/u/.codex/config.toml",
}

const claudeServers = {
  local: { type: "stdio", command: "npx", args: ["srv"], env: { K: secret } },
  mail: { type: "http", url: "https://mail.example.com/mcp" },
  notion: launcherEntry("notion", ctx),
  stream: { type: "sse", url: "https://sse.example.com" },
}

const withTempDir = async (
  run: (dir: string) => Promise<void>,
): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-ingest-"))

  try {
    await run(dir)
  } finally {
    await rm(dir, { force: true, recursive: true })
  }
}

const runIngest = async (args: string[]) => {
  const proc = Bun.spawn(["bun", script, ...args], {
    stdout: "pipe", stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

describe("planIngest", () => {
  test("adds stdio and http servers, ignores launchers, skips SSE", () => {
    const plan = planIngest(claudeServers, {})

    expect(plan.add).toEqual([
      { name: "local", server: { command: "npx", args: ["srv"], env: { K: secret } } },
      { name: "mail", server: { url: "https://mail.example.com/mcp" } },
    ])
    expect(plan.skip.map(({ name }) => name)).toEqual(["stream"])
    expect(describeIngest(plan).join("\n")).not.toContain(secret)
  })

  test("same definitions are no-ops; different ones clash", () => {
    const codex = {
      mail: { url: "https://mail.example.com/mcp", startup_timeout_sec: 30 },
      local: { command: "other" },
    }
    const plan = planIngest(claudeServers, codex)

    expect(plan.add).toEqual([])
    expect(plan.clash.map(({ name }) => name)).toEqual(["local"])
    expect(describeIngest(plan)).toContain(
      "! clash local: differs from Codex; --force replaces it",
    )
  })

  test("an unmappable entry under a name Codex holds is a clash", () => {
    const source = {
      mail: { type: "http", url: "https://x", headers: { A: "${TOKEN}" } },
      stream: { type: "sse", url: "https://sse.example.com" },
    }
    const codex = { mail: { url: "https://mail.example.com/mcp" } }

    for (const force of [false, true]) {
      const plan = planIngest(source, codex, force)
      expect(plan.clash.map(({ name }) => name)).toEqual(["mail"])
      expect(plan.skip.map(({ name }) => name)).toEqual(["stream"])
      expect(plan.replace).toEqual([])
    }
    expect(describeIngest(planIngest(source, codex))[0])
      .toStartWith("! clash mail: cannot ingest (uses ${...} interpolation")
  })

  test("no clash when the export would leave the entry alone", () => {
    const source = {
      gh: {
        type: "http", url: "https://gh.example.com/mcp",
        headers: { Authorization: "Bearer ${GH_TOKEN}" },
      },
      off: { type: "stdio", command: "x", envFile: "/e" },
      other: { type: "stdio", command: "mine" },
    }
    const codex = {
      gh: { url: "https://gh.example.com/mcp", bearer_token_env_var: "GH" },
      off: { command: "x", enabled: false },
      other: { url: "https://o", env_http_headers: { A: "B" } },
    }
    const plan = planIngest(source, codex)

    expect(plan.clash).toEqual([])
    expect(plan.skip.map(({ name }) => name)).toEqual(["gh", "off", "other"])
    expect(plan.skip[2].reason).toContain("--force replaces it")
    expect(planIngest(source, codex, true).replace.map(({ name }) => name))
      .toEqual(["other"])
  })

  test("--force replaces transport fields and keeps Codex-only fields", () => {
    const config: TomlTable = {
      model: "m",
      mcp_servers: {
        local: { command: "other", env: { OLD: "x" }, startup_timeout_sec: 9 },
      },
    }
    const plan = planIngest(
      claudeServers,
      config.mcp_servers as TomlTable,
      true,
    )
    const next = applyIngest(config, plan)

    expect(plan.replace.map(({ name }) => name)).toEqual(["local"])
    expect((next.mcp_servers as TomlTable).local).toEqual({
      command: "npx", args: ["srv"], env: { K: secret }, startup_timeout_sec: 9,
    })
    expect(next.model).toBe("m")
  })

  test("--force drops Codex auth fields from the replaced server", () => {
    const config: TomlTable = {
      mcp_servers: {
        mail: {
          url: "https://old.example.com/mcp",
          bearer_token_env_var: "MAIL_TOKEN",
          env_http_headers: { "X-Key": "MAIL_KEY" },
          tool_timeout_sec: 5,
        },
      },
    }
    const plan = planIngest(claudeServers, config.mcp_servers as TomlTable, true)
    const next = applyIngest(config, plan)

    expect((next.mcp_servers as TomlTable).mail).toEqual({
      url: "https://mail.example.com/mcp", tool_timeout_sec: 5,
    })
  })
})

describe("mcp ingest CLI", () => {
  test("writes Codex privately, then export leaves no env in Claude", async () => {
    await withTempDir(async (dir) => {
      const claudeConfig = join(dir, "claude.json")
      const codexConfig = join(dir, "config.toml")
      await writeFile(claudeConfig, JSON.stringify({ mcpServers: claudeServers }))
      await writeFile(codexConfig, stringify({
        model: "m",
        mcp_servers: { notion: { command: "notion" } },
      }))
      const base = [
        "--from", "claude", "--path", claudeConfig,
        "--codex-config", codexConfig,
      ]

      const check = await runIngest([...base, "--check"])
      expect(check.exitCode).toBe(1)
      expect(check.stdout).toContain("+ add local")
      expect(check.stdout).toContain("+ mcp_servers.local")

      const run = await runIngest([...base, "--run"])
      expect(run.exitCode).toBe(0)

      for (const result of [check, run]) {
        expect(result.stdout).not.toContain(secret)
        expect(result.stderr).not.toContain(secret)
      }

      const written = parse(await Bun.file(codexConfig).text())
      expect(written.model).toBe("m")
      expect(Object.keys(written.mcp_servers as TomlTable).sort())
        .toEqual(["local", "mail", "notion"])
      expect((await stat(codexConfig)).mode & 0o777).toBe(0o600)
      expect((await runIngest([...base, "--check"])).exitCode).toBe(0)

      // The export turns Claude's ingested stdio entry into a launcher entry.
      const exportPlan = planMcpSync(
        await readCodexMcpServers(codexConfig),
        claudeServers,
        { ...ctx, sourcePath: codexConfig },
      )
      expect(exportPlan.update.map(({ name, replacesUnmanaged }) =>
        [name, replacesUnmanaged])).toEqual([["local", true], ["notion", false]])
      expect(JSON.stringify(exportPlan)).not.toContain(secret)
      expect(exportPlan.add).toEqual([])
    })
  })

  test("--run exits 1 on a clash but still writes clean additions", async () => {
    await withTempDir(async (dir) => {
      const claudeConfig = join(dir, "claude.json")
      const codexConfig = join(dir, "config.toml")
      await writeFile(claudeConfig, JSON.stringify({ mcpServers: claudeServers }))
      await writeFile(codexConfig, stringify({
        mcp_servers: { local: { command: "other" } },
      }))

      const result = await runIngest([
        "--from", "claude", "--path", claudeConfig,
        "--codex-config", codexConfig, "--run",
      ])

      expect(result.exitCode).toBe(1)
      expect(result.stdout).toContain("! clash local")
      expect(result.stderr).toContain("1 clashing server(s) were not ingested")
      const written = parse(await Bun.file(codexConfig).text())
      expect(written.mcp_servers).toEqual({
        local: { command: "other" },
        mail: { url: "https://mail.example.com/mcp" },
      })
    })
  })

  test("rejects an unknown source tool", async () => {
    const result = await runIngest(["--from", "vim", "--dry-run"])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("--from must be claude or cursor")
  })
})
