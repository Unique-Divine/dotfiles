import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { stringify } from "smol-toml"

import { launcherEntry, type LauncherContext } from "../mcp/servers.ts"
import { parseLaunchArgs, resolveLaunchSpec } from "./mcp-launch.ts"
import { claudeConfigPath, planCommands, planMcpSync } from "./mcp.ts"

const mcpScript = join(import.meta.dir, "mcp.ts")
const launchScript = join(import.meta.dir, "mcp-launch.ts")

const ctx: LauncherContext = {
  bunPath: "/opt/bun/bin/bun",
  launcherPath: "/home/u/dotfiles/claude/mcp-launch.ts",
  sourcePath: "/home/u/.codex/config.toml",
}

const secret = `secret-${crypto.randomUUID()}`

const codexServers = {
  notion: { command: "notion-mcp-server", env: { NOTION_TOKEN: secret } },
  telegram: {
    command: "uv",
    args: ["--directory", "/srv/telegram", "run", "main.py"],
    env: { TELEGRAM_API_HASH: secret },
  },
  remote: { url: "https://mcp.example.com/mcp" },
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
  env?: NodeJS.ProcessEnv,
): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  const proc = Bun.spawn(cmd, {
    cwd: join(import.meta.dir, ".."),
    stdin: input === undefined ? "ignore" : new Blob([input]),
    stdout: "pipe",
    stderr: "pipe",
    env: env ?? process.env,
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])

  return { exitCode, stdout, stderr }
}

describe("claude mcp plan", () => {
  test("MCP reads use the same alternate Claude root as configuration", async () => {
    await withTempDir(async (home) => {
      const directory = join(home, "alternate profile")
      await Bun.write(join(directory, ".claude.json"), JSON.stringify({
        mcpServers: { stale: launcherEntry("stale", ctx) },
      }))
      const source = join(home, "empty-config.toml")
      await writeFile(source, "")
      await writeFile(join(home, ".claude.json"), "{}")
      const env = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: directory }
      expect(claudeConfigPath(env)).toBe(join(directory, ".claude.json"))
      expect(claudeConfigPath({ HOME: home, CLAUDE_CONFIG_DIR: "" }))
        .toBe(join(home, ".claude.json"))
      const result = await runScript([
        process.execPath, mcpScript, "--check", "--mcp-source", source,
      ], undefined, env)
      expect(result.exitCode).toBe(1)
      expect(result.stdout).toContain("stale")
      expect(await Bun.file(join(home, ".claude.json")).text()).toBe("{}")
    })
  })

  test("adds stdio launcher entries and copies url servers", () => {
    const plan = planMcpSync(codexServers, {}, ctx)

    expect(plan.add.map(({ name }) => name))
      .toEqual(["notion", "remote", "telegram"])
    expect(plan.add[0].entry).toEqual({
      type: "stdio",
      command: ctx.bunPath,
      args: [ctx.launcherPath, "--source", ctx.sourcePath, "notion"],
    })
    expect(plan.add[1].entry)
      .toEqual({ type: "http", url: "https://mcp.example.com/mcp" })
  })

  test("generated entries and commands contain no stdio env", () => {
    const plan = planMcpSync(codexServers, {}, ctx)
    const serialized = JSON.stringify([plan, planCommands(plan)])

    expect(serialized).not.toContain(secret)
    expect(serialized).not.toContain("NOTION_TOKEN")
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
})

describe("claude mcp CLI", () => {
  test("--dry-run, --check, and --print never print secrets", async () => {
    await withTempDir(async (dir) => {
      const source = join(dir, "config.toml")
      const claudeConfig = join(dir, "claude.json")
      await writeFile(source, stringify({ mcp_servers: codexServers }))
      await writeFile(claudeConfig, JSON.stringify({ mcpServers: {} }))
      const base = [
        "bun", mcpScript, "--mcp-source", source,
        "--claude-config", claudeConfig, "--state", join(dir, "state.json"),
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
      expect(Object.keys(printed)).toEqual(["notion", "remote", "telegram"])
      expect(await Bun.file(join(dir, "state.json")).exists()).toBe(false)
    })
  })
})

describe("claude mcp --run", () => {
  test("applies through the claude CLI and records owned url servers", async () => {
    await withTempDir(async (dir) => {
      const source = join(dir, "config.toml")
      const claudeConfig = join(dir, "claude.json")
      const statePath = join(dir, "state.json")
      const log = join(dir, "claude.log")
      const bin = join(dir, "bin")
      await Bun.write(join(bin, "claude"),
        `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n`)
      await Bun.spawn(["chmod", "+x", join(bin, "claude")]).exited
      await writeFile(source, stringify({ mcp_servers: codexServers }))
      await writeFile(claudeConfig, JSON.stringify({
        mcpServers: {
          stale: launcherEntry("stale", ctx),
          mine: { type: "http", url: "https://mine.example.com/mcp" },
        },
      }))
      const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` }

      const result = await runScript([
        "bun", mcpScript, "--run", "--quiet", "--mcp-source", source,
        "--claude-config", claudeConfig, "--state", statePath,
      ], undefined, env)

      expect(result).toMatchObject({ exitCode: 0, stdout: "", stderr: "" })
      const calls = (await Bun.file(log).text()).trim().split("\n")
      expect(calls.map((line) => line.split(" ").slice(0, 5).join(" ")))
        .toEqual([
          "mcp remove --scope user stale",
          "mcp add-json --scope user notion",
          "mcp add-json --scope user remote",
          "mcp add-json --scope user telegram",
        ])
      expect(calls.join("\n")).not.toContain(secret)
      expect(await Bun.file(statePath).json()).toEqual({
        version: 1,
        targets: { [claudeConfig]: ["remote"] },
      })
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

  test("passes cwd through and rejects a non-string cwd", () => {
    expect(resolveLaunchSpec({ s: { command: "c", cwd: "/srv" } }, "s", {}).cwd)
      .toBe("/srv")
    expect(() => resolveLaunchSpec({ s: { command: "c", cwd: 1 } }, "s", {}))
      .toThrow("MCP server s cwd must be a string")
  })

  test("errors name the server without env values", () => {
    expect(() => resolveLaunchSpec({}, "missing", {})).toThrow(
      "MCP server missing is not defined or is disabled in the Codex config",
    )
    expect(() =>
      resolveLaunchSpec({ s: { env: { K: secret } } }, "s", {}),
    ).toThrow("MCP server s has no command")
  })

  test("parses --source and one server name", () => {
    expect(parseLaunchArgs(["--source", "/x.toml", "notion"])).toEqual({
      name: "notion",
      sourcePath: "/x.toml",
    })
    expect(() => parseLaunchArgs([])).toThrow("Usage")
  })

  test("child gets env and stdio, and its exit code propagates", async () => {
    await withTempDir(async (dir) => {
      const source = join(dir, "config.toml")
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
        stringify({
          mcp_servers: {
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
      const source = join(dir, "config.toml")
      await writeFile(source, stringify({
        mcp_servers: { off: { command: "x", enabled: false } },
      }))

      for (const name of ["nope", "off"]) {
        const result = await runScript([
          "bun", launchScript, "--source", source, name,
        ])

        expect(result.exitCode).toBe(2)
        expect(result.stdout).toBe("")
        expect(result.stderr).toContain(`MCP server ${name} is not defined`)
      }
    })
  })
})
