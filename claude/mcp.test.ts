import { describe, expect, test } from "bun:test"
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { stringify } from "smol-toml"

import { launcherEntry, type LauncherContext } from "../mcp/servers.ts"
import { parseLaunchArgs, resolveLaunchSpec } from "./mcp-launch.ts"
import { claudeConfigPath, planMcpSync } from "./mcp.ts"

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
  remote: {
    url: "https://mcp.example.com/mcp",
    http_headers: { "X-Api-Key": `header-${secret}` },
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
    expect(plan.add[1].entry).toEqual({
      type: "http",
      url: "https://mcp.example.com/mcp",
      headers: { "X-Api-Key": `header-${secret}` },
    })
  })

  test("generated stdio entries contain no env", () => {
    const plan = planMcpSync(codexServers, {}, ctx)
    const stdio = plan.add.filter(({ name }) => name !== "remote")

    expect(JSON.stringify(stdio)).not.toContain(secret)
    expect(JSON.stringify(stdio)).not.toContain("NOTION_TOKEN")
  })
})

describe("claude mcp CLI", () => {
  test("--dry-run and --check never print secrets; --print shows headers",
    async () => {
      await withTempDir(async (dir) => {
        const source = join(dir, "config.toml")
        const claudeConfig = join(dir, "claude.json")
        await writeFile(source, stringify({ mcp_servers: codexServers }))
        await writeFile(claudeConfig, JSON.stringify({ mcpServers: {} }))
        const base = [
          "bun", mcpScript, "--mcp-source", source,
          "--claude-config", claudeConfig, "--state", join(dir, "state.json"),
        ]

        for (const flag of ["--dry-run", "--check"]) {
          const result = await runScript([...base, flag])

          expect(result.stdout).not.toContain(secret)
          expect(result.stderr).not.toContain(secret)
        }

        const check = await runScript([...base, "--check"])
        expect(check.exitCode).toBe(1)
        expect(check.stdout).toContain("+ add telegram")

        // --print is documented to include url header values, never stdio env.
        const printed = await runScript([...base, "--print"])
        expect(Object.keys(JSON.parse(printed.stdout)))
          .toEqual(["notion", "remote", "telegram"])
        expect(printed.stdout).toContain(`header-${secret}`)
        expect(printed.stdout).not.toContain("NOTION_TOKEN")
        expect(await Bun.file(join(dir, "state.json")).exists()).toBe(false)
      })
    })

  test("--claude-config with --run must match the claude CLI file", async () => {
    await withTempDir(async (dir) => {
      const result = await runScript([
        "bun", mcpScript, "--run", "--mcp-source", join(dir, "c.toml"),
        "--claude-config", join(dir, "other.json"),
        "--state", join(dir, "state.json"),
      ], undefined, { ...process.env, HOME: dir, CLAUDE_CONFIG_DIR: "" })

      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain("set CLAUDE_CONFIG_DIR")
    })
  })
})

interface RunFixture {
  dir: string
  claudeConfig: string
  statePath: string
  log: string
  run: () => Promise<{ exitCode: number; stdout: string; stderr: string }>
  calls: () => Promise<string[]>
}

/**
 * Runs `claude/mcp.ts --run` against a stub `claude` on PATH that logs its
 * arguments. With `failAddOf`, the stub fails add-json for launcher entries
 * of that server, the way a CLI validation error would.
 */
const withRunFixture = async (
  claudeServers: Record<string, unknown>,
  test: (fixture: RunFixture) => Promise<void>,
  failAddOf?: string,
): Promise<void> => {
  await withTempDir(async (dir) => {
    const source = join(dir, "config.toml")
    const claudeConfig = join(dir, ".claude.json")
    const statePath = join(dir, "state/mcp-managed.json")
    const log = join(dir, "claude.log")
    const bin = join(dir, "bin")
    const fail = failAddOf
      ? `if [ "$2" = add-json ] && [ "$5" = '${failAddOf}' ] && ` +
        `printf '%s' "$6" | grep -q mcp-launch.ts; then ` +
        `echo "bad payload $6" >&2; exit 3; fi\n`
      : ""
    await Bun.write(join(bin, "claude"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n${fail}`)
    await Bun.spawn(["chmod", "+x", join(bin, "claude")]).exited
    await writeFile(source, stringify({ mcp_servers: codexServers }))
    await writeFile(claudeConfig, JSON.stringify({ mcpServers: claudeServers }))
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      CLAUDE_CONFIG_DIR: dir,
    }

    await test({
      dir, claudeConfig, statePath, log,
      run: () => runScript([
        "bun", mcpScript, "--run", "--mcp-source", source,
        "--state", statePath,
      ], undefined, env),
      calls: async () => (await Bun.file(log).text()).trim().split("\n")
        .map((line) => line.split(" ").slice(0, 5).join(" ")),
    })
  })
}

describe("claude mcp --run", () => {
  test("applies through the claude CLI and records owned url servers", async () => {
    await withRunFixture({
      stale: launcherEntry("stale", ctx),
      mine: { type: "http", url: "https://mine.example.com/mcp" },
    }, async ({ claudeConfig, statePath, run, calls, log }) => {
      const result = await run()

      expect(result.exitCode).toBe(0)
      expect(await calls()).toEqual([
        "mcp remove --scope user stale",
        "mcp add-json --scope user notion",
        "mcp add-json --scope user remote",
        "mcp add-json --scope user telegram",
      ])
      expect(await Bun.file(log).text()).not.toContain("NOTION_TOKEN")
      expect(await Bun.file(statePath).json()).toEqual({
        version: 1,
        targets: { [claudeConfig]: ["remote"] },
      })
    })
  })

  test("backs up a hand-added entry before replacing it", async () => {
    const handAdded = {
      type: "stdio", command: "npx", args: ["notion"], env: { T: secret },
    }

    await withRunFixture({ notion: handAdded }, async ({ dir, run }) => {
      const result = await run()
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain("~ replace notion (unmanaged Claude entry)")
      expect(result.stdout).not.toContain(secret)

      const stateDir = join(dir, "state")
      const backups = (await readdir(stateDir))
        .filter((name) => name.startsWith("claude-mcp-before-dotfiles-"))
      expect(backups.length).toBe(1)
      const backupPath = join(stateDir, backups[0])
      expect((await stat(backupPath)).mode & 0o777).toBe(0o600)
      expect((await Bun.file(backupPath).json()).mcpServers)
        .toEqual({ notion: handAdded })
    })
  })

  test("restores the old entry when add-json fails after remove", async () => {
    const handAdded = { type: "stdio", command: "npx", args: ["notion"] }

    await withRunFixture({ notion: handAdded }, async ({ run, log }) => {
      const result = await run()

      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain("claude mcp add-json notion failed (3)")
      expect(result.stderr).not.toContain("bad payload")
      const lines = (await Bun.file(log).text()).trim().split("\n")
      expect(lines.slice(0, 3).map((l) => l.split(" ").slice(0, 5).join(" ")))
        .toEqual([
          "mcp remove --scope user notion",
          "mcp add-json --scope user notion",
          "mcp add-json --scope user notion",
        ])
      expect(lines[2]).toEndWith(JSON.stringify(handAdded))
    }, "notion")
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
