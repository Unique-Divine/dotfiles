import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { parseLaunchArgs, resolveLaunchSpec } from "./mcp-launch.ts"
import {
  describePlan,
  isLauncherEntry,
  launcherEntry,
  planCommands,
  planMcpSync,
  type LauncherContext,
} from "./mcp.ts"

const mcpScript = join(import.meta.dir, "mcp.ts")
const launchScript = join(import.meta.dir, "mcp-launch.ts")

const ctx: LauncherContext = {
  bunPath: "/opt/bun/bin/bun",
  launcherPath: "/home/u/dotfiles/claude/mcp-launch.ts",
  sourcePath: "/home/u/.cursor/mcp.json",
}

const secret = `secret-${crypto.randomUUID()}`

const cursorServers = {
  notion: { command: "notion-mcp-server", env: { NOTION_TOKEN: secret } },
  telegram: {
    command: "uv",
    args: ["--directory", "/srv/telegram", "run", "main.py"],
    env: { TELEGRAM_API_HASH: secret },
  },
  remote: {
    url: "https://mcp.example.com",
    headers: { Authorization: `Bearer ${secret}` },
  },
}

const withTempDir = async (
  run: (dir: string) => Promise<void>,
): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), "claude-mcp-"))

  try {
    await run(dir)
  } finally {
    await rm(dir, { force: true, recursive: true })
  }
}

const runScript = async (
  cmd: string[],
  input?: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  const proc = Bun.spawn(cmd, {
    cwd: join(import.meta.dir, ".."),
    stdin: input === undefined ? "ignore" : new Blob([input]),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])

  return { exitCode, stdout, stderr }
}

describe("claude mcp plan", () => {
  test("adds stdio servers and skips remote servers", () => {
    const plan = planMcpSync(cursorServers, {}, ctx)

    expect(plan.add.map(({ name }) => name)).toEqual(["notion", "telegram"])
    expect(plan.skip).toEqual([{ name: "remote", reason: "no stdio command" }])
    expect(plan.add[0].entry).toEqual({
      type: "stdio",
      command: ctx.bunPath,
      args: [ctx.launcherPath, "--source", ctx.sourcePath, "notion"],
    })
  })

  test("generated entries and commands contain no server env", () => {
    const plan = planMcpSync(cursorServers, {}, ctx)
    const serialized = JSON.stringify([plan, planCommands(plan)])

    expect(serialized).not.toContain(secret)
    expect(serialized).not.toContain("NOTION_TOKEN")
    expect(describePlan(plan).join("\n")).not.toContain(secret)
  })

  test("is empty when Claude already matches", () => {
    const claudeServers = {
      notion: { ...launcherEntry("notion", ctx), env: {} },
      telegram: launcherEntry("telegram", ctx),
    }
    const plan = planMcpSync(cursorServers, claudeServers, ctx)

    expect(plan.add).toEqual([])
    expect(plan.update).toEqual([])
    expect(plan.remove).toEqual([])
  })

  test("updates entries from a moved checkout", () => {
    const moved = {
      ...ctx,
      launcherPath: "/old/dotfiles/claude/mcp-launch.ts",
    }
    const plan = planMcpSync(
      { notion: cursorServers.notion },
      { notion: launcherEntry("notion", moved) },
      ctx,
    )

    expect(plan.update).toEqual([
      {
        name: "notion",
        entry: launcherEntry("notion", ctx),
        replacesUnmanaged: false,
      },
    ])
  })

  test("replaces a same-named unmanaged entry", () => {
    const plan = planMcpSync(
      { notion: cursorServers.notion },
      { notion: { type: "stdio", command: "npx", args: ["notion"] } },
      ctx,
    )

    expect(plan.update[0].replacesUnmanaged).toBe(true)
    expect(describePlan(plan)).toEqual([
      "~ replace notion (unmanaged Claude entry)",
    ])
  })

  test("removes only launcher entries that left the Cursor config", () => {
    const plan = planMcpSync(
      {},
      {
        stale: launcherEntry("stale", ctx),
        mine: { type: "http", url: "https://example.com/mcp" },
      },
      ctx,
    )

    expect(plan.remove).toEqual(["stale"])
  })

  test("commands remove before add for updates", () => {
    const entry = launcherEntry("notion", ctx)
    const commands = planCommands({
      add: [],
      update: [{ name: "notion", entry, replacesUnmanaged: false }],
      remove: ["stale"],
      skip: [],
    })

    expect(commands).toEqual([
      ["claude", "mcp", "remove", "--scope", "user", "stale"],
      ["claude", "mcp", "remove", "--scope", "user", "notion"],
      [
        "claude", "mcp", "add-json", "--scope", "user", "notion",
        JSON.stringify(entry),
      ],
    ])
  })

  test("recognizes launcher entries by script location", () => {
    expect(isLauncherEntry(launcherEntry("x", ctx))).toBe(true)
    expect(isLauncherEntry({ command: "bun", args: ["mcp-launch.ts"] }))
      .toBe(false)
    expect(isLauncherEntry({ url: "https://example.com" })).toBe(false)
  })
})

describe("claude mcp CLI", () => {
  test("--dry-run, --check, and --print never print secrets", async () => {
    await withTempDir(async (dir) => {
      const source = join(dir, "cursor-mcp.json")
      const claudeConfig = join(dir, "claude.json")
      await writeFile(source, JSON.stringify({ mcpServers: cursorServers }))
      await writeFile(claudeConfig, JSON.stringify({ mcpServers: {} }))
      const base = [
        "bun", mcpScript, "--mcp-source", source,
        "--claude-config", claudeConfig,
      ]

      for (const flag of ["--dry-run", "--check", "--print"]) {
        const result = await runScript([...base, flag])

        expect(result.stdout).not.toContain(secret)
        expect(result.stderr).not.toContain(secret)
      }

      const check = await runScript([...base, "--check"])
      expect(check.exitCode).toBe(1)
      expect(check.stdout).toContain("+ add telegram")

      const printed = JSON.parse((await runScript([...base, "--print"])).stdout)
      expect(Object.keys(printed)).toEqual(["notion", "telegram"])
    })
  })
})

describe("mcp launcher", () => {
  test("merges server env over the base env", () => {
    const spec = resolveLaunchSpec(
      { s: { command: "definitely-not-on-path", args: ["a"], env: { K: "v" } } },
      "s",
      { PATH: "", HOME: "/h", K: "old" },
    )

    expect(spec).toEqual({
      cmd: ["definitely-not-on-path", "a"],
      env: { PATH: "", HOME: "/h", K: "v" },
    })
  })

  test("errors name the server without env values", () => {
    expect(() => resolveLaunchSpec({}, "missing", {})).toThrow(
      "MCP server missing is not defined in the Cursor config",
    )
    expect(() =>
      resolveLaunchSpec({ s: { env: { K: secret } } }, "s", {}),
    ).toThrow("MCP server s has no command")
  })

  test("parses --source and one server name", () => {
    expect(parseLaunchArgs(["--source", "/x.json", "notion"])).toEqual({
      name: "notion",
      sourcePath: "/x.json",
    })
    expect(() => parseLaunchArgs([])).toThrow("Usage")
  })

  test("child gets env and stdio, and its exit code propagates", async () => {
    await withTempDir(async (dir) => {
      const source = join(dir, "cursor-mcp.json")
      // The child proves it saw the secret without echoing it, reads one
      // stdin line the way an MCP server reads a request, then exits 7.
      const child = [
        "const ok = process.env.PROBE === process.argv[1];",
        "const line = (await Bun.stdin.text()).trim();",
        "process.stdout.write(`env=${ok} stdin=${line}`);",
        "process.exit(7);",
      ].join("")
      await writeFile(
        source,
        JSON.stringify({
          mcpServers: {
            probe: {
              command: process.execPath,
              args: ["-e", child, secret],
              env: { PROBE: secret },
            },
          },
        }),
      )

      const result = await runScript(
        ["bun", launchScript, "--source", source, "probe"],
        "ping\n",
      )

      expect(result.stdout).toBe("env=true stdin=ping")
      expect(result.exitCode).toBe(7)
    })
  })

  test("unknown server exits 2 with a stderr message", async () => {
    await withTempDir(async (dir) => {
      const source = join(dir, "cursor-mcp.json")
      await writeFile(source, JSON.stringify({ mcpServers: {} }))

      const result = await runScript([
        "bun", launchScript, "--source", source, "nope",
      ])

      expect(result.exitCode).toBe(2)
      expect(result.stdout).toBe("")
      expect(result.stderr).toContain("MCP server nope is not defined")
    })
  })
})
