import { describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, stat, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parse } from "smol-toml"
import { hasTomlComments, planUnion, resolveDefinitions, type Inventory, type Platform } from "./sync.ts"
import { applyPlan } from "../cursor/mcp.ts"
import { writeDiscordClaude } from "./discord.ts"
import { launcherEntry } from "./servers.ts"
import { jiyuuMcpPins } from "./pins.ts"

const ctx = { bunPath: "/bin/bun", launcherPath: "/repo/claude/mcp-launch.ts", sourcePath: "/codex.toml" }
const inventory = (): Inventory => ({ codex: {}, claude: {}, cursor: {} })
const url = (value: string) => ({ url: `https://${value}.example/mcp` })

async function plan(raw: Inventory, from?: Platform) {
  const { definitions } = await resolveDefinitions(raw, ctx.sourcePath)
  return planUnion(raw, definitions, ctx, from)
}

describe("MCP union", () => {
  test("combines disjoint sets across every platform and is idempotent", async () => {
    const raw = { codex: { a: url("a") }, claude: { b: url("b") }, cursor: { c: url("c") } }
    const first = await plan(raw)
    expect(Object.keys(first.codex).sort()).toEqual(["a", "b", "c"])
    const next: Inventory = { codex: first.codex, claude: {}, cursor: {} }
    for (const p of ["claude", "cursor"] as const) {
      next[p] = (applyPlan({}, raw[p], first.targets[p]).mcpServers ?? {}) as Record<string, unknown>
    }
    const second = await plan(next)
    expect(second.targets.claude.add).toEqual([])
    expect(second.targets.cursor.add).toEqual([])
    expect(second.warnings).toEqual([])
    expect(second.codex).toEqual(first.codex)
  })

  test("preserves differences; fills missing platform from Codex", async () => {
    const raw = { codex: { x: url("one") }, claude: { x: url("two") }, cursor: {} }
    const result = await plan(raw)
    expect(result.codex).toEqual(raw.codex)
    expect(result.targets.claude.update).toEqual([])
    expect(result.targets.cursor.add[0]?.entry.url).toBe(url("one").url)
    expect(result.warnings.join()).toContain("fields: url")
    expect(result.warnings.join()).not.toContain("one.example")
  })

  for (const source of ["codex", "claude", "cursor"] as const) {
    test(`directional ${source} replaces overlaps and retains destination-only entries`, async () => {
      const raw = {
        codex: { x: url("codex"), only: url("only") },
        claude: { x: url("claude") }, cursor: { x: url("cursor") },
      }
      const result = await plan(raw, source)
      expect(result.codex.x?.url).toBe(url(source).url)
      expect(result.codex.only).toEqual(url("only"))
      for (const target of ["claude", "cursor"] as const) {
        expect(result.targets[target].update.length).toBe(target === source ? 0 : 1)
        expect(result.targets[target].remove).toEqual([])
      }
    })
  }

  test("normalizes generated launchers and platform HTTP syntax", async () => {
    const raw = { codex: { local: { command: "server" }, http: url("http") }, claude: {
      local: launcherEntry("local", ctx), http: { type: "http", ...url("http") },
    }, cursor: {} }
    expect((await plan(raw)).warnings).toEqual([])
  })

  test("restores independent copies, preserves disabled and unsupported entries", async () => {
    const raw = { codex: { off: { ...url("off"), enabled: false } }, claude: {
      x: url("x"), off: url("other"), sse: { type: "sse", ...url("sse") },
    }, cursor: {} }
    const result = await plan(raw)
    expect(result.codex.x).toEqual(url("x"))
    expect(result.codex.sse).toBeUndefined()
    expect(result.codex.off).toEqual(raw.codex.off)
    expect(result.targets.cursor.add.map(x => x.name)).toEqual(["x"])
  })

  test("dangling launchers are not imported or removed", async () => {
    const raw = inventory()
    raw.claude.lost = launcherEntry("lost", ctx)
    const { definitions, warnings } = await resolveDefinitions(raw, ctx.sourcePath)
    expect(warnings.join()).toContain("dangling launcher")
    const result = planUnion(raw, definitions, ctx)
    expect(result.codex).toEqual({})
    expect(result.targets.claude.remove).toEqual([])
  })
})

const script = join(import.meta.dir, "sync.ts")
async function run(args: string[]) {
  const p = Bun.spawn([process.execPath, script, ...args], {
    env: { ...process.env, MCP_SYNC_SKIP_PIN_CHECK: "1" }, stdout: "pipe", stderr: "pipe",
  })
  return { code: await p.exited, output: await new Response(p.stdout).text() + await new Response(p.stderr).text() }
}

test("CLI preview, check, apply, permissions, and advisory health", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-union-"))
  try {
    const codex = join(dir, "config.toml")
    const claude = join(dir, ".claude.json")
    const cursor = join(dir, "cursor.json")
    const secret = crypto.randomUUID()
    const text = `[mcp_servers.x]\nurl = "https://one.example"\nhttp_headers = { token = "${secret}" }\n`
    await Bun.write(codex, text)
    await Bun.write(claude, JSON.stringify({ mcpServers: { x: url("two") } }))
    const args = ["--codex-config", codex, "--claude-config", claude, "--cursor-config", cursor]
    const preview = await run([...args, "--dry-run"])
    expect(preview.code).toBe(0)
    expect(preview.output).not.toContain(secret)
    expect(await Bun.file(codex).text()).toBe(text)
    expect(await Bun.file(cursor).exists()).toBe(false)
    expect((await run([...args, "--check"])).code).toBe(1)
    // Use actual Claude config location under an isolated HOME. No Claude
    // writes are necessary: all Claude names already exist.
    const proc = Bun.spawn([process.execPath, script, ...args, "--run"], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: dir }, stdout: "pipe", stderr: "pipe",
    })
    expect(await proc.exited).toBe(0)
    expect((await stat(cursor)).mode & 0o777).toBe(0o600)
    const checked = await run([...args, "--check"])
    expect(checked.code).toBe(0)
    expect(checked.output).toContain("settings differ")
    expect(checked.output).not.toContain(secret)
    expect(parse(await Bun.file(codex).text()).mcp_servers).toBeDefined()
  } finally { await rm(dir, { recursive: true, force: true }) }
})

interface CliResult { code: number; output: string; stdout: string; stderr: string }
type Invoke = (args: string[], env?: Record<string, string>, stdin?: string) => Promise<CliResult>

async function withCliFixture(
  check: (dir: string, invoke: Invoke) => Promise<void>,
) {
  const dir = await mkdtemp(join(tmpdir(), "mcp-union-cli-"))
  try {
    // A real subprocess substitute for Claude's configuration commands.
    // It edits a private test profile, never the workstation configuration.
    await Bun.write(join(dir, "claude"), `#!${process.execPath}
const file = process.env.CLAUDE_CONFIG_DIR + '/.claude.json'
const config = JSON.parse(await Bun.file(file).text())
const args = process.argv.slice(2)
const name = args[4]
if (args[0] !== 'mcp' || args[2] !== '--scope' || args[3] !== 'user') process.exit(2)
if (args[1] === 'remove') {
  delete config.mcpServers[name]
  if (name === 'race-first') config.mcpServers['race-later'] = { url: 'https://concurrent.example' }
}
else if (args[1] === 'add-json') {
  if (name === process.env.FAIL_SERVER) { console.error(args[5]); process.exit(3) }
  config.mcpServers[name] = JSON.parse(args[5])
} else process.exit(2)
await Bun.write(file, JSON.stringify(config))
`)
    await chmod(join(dir, "claude"), 0o700)
    await Bun.write(join(dir, ".claude.json"), JSON.stringify({ mcpServers: {}, unrelated: true }))
    const invoke: Invoke = async (args, extraEnv = {}, stdin) => {
      const preload = extraEnv.FIXTURE_PRELOAD
        ? ["--preload", extraEnv.FIXTURE_PRELOAD] : []
      const p = Bun.spawn([process.execPath, ...preload, script,
        "--codex-config", join(dir, "config.toml"),
        "--claude-config", join(dir, ".claude.json"),
        "--cursor-config", join(dir, "cursor.json"), ...args,
      ], {
        env: {
          ...process.env, JIYUU_MCP_LOCAL: "", CLAUDE_CONFIG_DIR: dir,
          MCP_SYNC_SKIP_PIN_CHECK: "1",
          PATH: `${dir}:${process.env.PATH}`, ...extraEnv,
        },
        stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
        stdout: "pipe", stderr: "pipe",
      })
      const [code, stdout, stderr] = await Promise.all([
        p.exited, new Response(p.stdout).text(), new Response(p.stderr).text(),
      ])
      return { code, output: stdout + stderr, stdout, stderr }
    }
    await check(dir, invoke)
  } finally { await rm(dir, { recursive: true, force: true }) }
}

test("CLI adds through user-scoped Claude commands, then repeats without changes", async () => {
  await withCliFixture(async (dir, invoke) => {
    await Bun.write(join(dir, "config.toml"), '[mcp_servers.local]\ncommand = "server"\n')
    expect((await invoke(["--run"])).code).toBe(0)
    const claude = await Bun.file(join(dir, ".claude.json")).json()
    expect(claude.unrelated).toBe(true)
    expect(claude.mcpServers.local.args[3]).toBe("local")
    expect((await invoke(["--check"])).code).toBe(0)
    expect((await invoke(["--run"])).output).toContain("MCP union is current")
  })
})

test("directional CLI writes source settings, preserves unrelated settings, and backs up", async () => {
  await withCliFixture(async (dir, invoke) => {
    const secret = crypto.randomUUID()
    await Bun.write(join(dir, "config.toml"), 'model = "keep"\n[mcp_servers.x]\nurl = "https://old.example"\nstartup_timeout_sec = 45\n')
    await Bun.write(join(dir, ".claude.json"), JSON.stringify({ mcpServers: {
      x: { type: "http", url: "https://new.example", headers: { token: secret } },
    } }))
    await Bun.write(join(dir, "cursor.json"), JSON.stringify({ unrelated: true, mcpServers: { x: url("cursor"), only: url("only") } }))
    const result = await invoke(["--from", "claude", "--run"])
    expect(result.code).toBe(0)
    expect(result.output).not.toContain(secret)
    const config = parse(await Bun.file(join(dir, "config.toml")).text()) as any
    expect(config.model).toBe("keep")
    expect(config.mcp_servers.x.url).toBe("https://new.example")
    expect(config.mcp_servers.x.startup_timeout_sec).toBe(45)
    const cursor = await Bun.file(join(dir, "cursor.json")).json()
    expect(cursor.unrelated).toBe(true)
    expect(cursor.mcpServers.x.url).toBe("https://new.example")
    expect(cursor.mcpServers.only).toEqual(url("only"))
    const { readdir } = await import("node:fs/promises")
    const backups = (await readdir(dir)).filter(name => name.includes("before-"))
    expect(backups.length).toBeGreaterThanOrEqual(2)
    for (const name of backups) expect((await stat(join(dir, name))).mode & 0o777).toBe(0o600)
    expect((await invoke(["--check"])).code).toBe(0)
  })
})

test("malformed inputs fail before writing and do not echo parser credentials", async () => {
  await withCliFixture(async (dir, invoke) => {
    const secret = crypto.randomUUID()
    const original = '[mcp_servers.x]\nurl = "https://one.example"\n'
    await Bun.write(join(dir, "config.toml"), original)
    await Bun.write(join(dir, ".claude.json"), `{ ${secret}`)
    const result = await invoke(["--run"])
    expect(result.code).toBe(1)
    expect(result.output).not.toContain(secret)
    expect(await Bun.file(join(dir, "config.toml")).text()).toBe(original)
    expect(await Bun.file(join(dir, "cursor.json")).exists()).toBe(false)
  })
})

test("unsupported WebSocket entries stay local and emit a warning", async () => {
  const raw = inventory()
  raw.claude.ws = { type: "ws", url: "ws://localhost:1234" }
  raw.claude.unknown = { type: "future", url: "https://example.com" }
  raw.cursor.websocket = { url: "ws://localhost:1234" }
  const { definitions, warnings } = await resolveDefinitions(raw, ctx.sourcePath)
  expect(warnings.join()).toContain("unsupported transport type")
  const result = planUnion(raw, definitions, ctx)
  expect(result.codex).toEqual({})
  expect(result.targets.cursor.add).toEqual([])
  expect(result.targets.claude.update).toEqual([])
})


test("concurrent Claude edit during an earlier write survives and stops reconciliation", async () => {
  await withCliFixture(async (dir, invoke) => {
    await Bun.write(join(dir, "config.toml"), '[mcp_servers.race-first]\nurl = "https://source.example"\n[mcp_servers.race-later]\nurl = "https://source.example"\n')
    await Bun.write(join(dir, ".claude.json"), JSON.stringify({ mcpServers: {
      "race-first": url("old"), "race-later": url("old"),
    } }))
    const result = await invoke(["--from", "codex", "--run"])
    expect(result.code).toBe(1)
    expect(result.output).toContain("race-later changed during sync")
    const config = await Bun.file(join(dir, ".claude.json")).json()
    expect(config.mcpServers["race-later"].url).toBe("https://concurrent.example")
  })
})

test("HTTP definition behind a stdio launcher warns by default and repairs directionally", async () => {
  const raw = inventory()
  raw.codex.x = url("new-http")
  raw.claude.x = launcherEntry("x", ctx)
  raw.cursor.x = launcherEntry("x", ctx, "cursor")
  const { definitions, warnings } = await resolveDefinitions(raw, ctx.sourcePath)
  expect(warnings.filter(w => w.includes("launcher requires a command"))).toHaveLength(2)
  const normal = planUnion(raw, definitions, ctx)
  expect(normal.targets.claude.update).toEqual([])
  expect(normal.targets.cursor.update).toEqual([])
  const repaired = planUnion(raw, definitions, ctx, "codex")
  expect(repaired.targets.claude.update[0]?.entry).toEqual({ type: "http", ...url("new-http") })
  expect(repaired.targets.cursor.update[0]?.entry).toEqual(url("new-http"))
})

test("CLI resumes a partial command-to-HTTP reconciliation", async () => {
  await withCliFixture(async (dir, invoke) => {
    const sourcePath = join(dir, "config.toml")
    const context = { ...ctx, sourcePath }
    await Bun.write(sourcePath, '[mcp_servers.x]\nurl = "https://new.example"\n')
    await Bun.write(join(dir, ".claude.json"), JSON.stringify({ mcpServers: {
      x: launcherEntry("x", context),
    } }))
    await Bun.write(join(dir, "cursor.json"), JSON.stringify({ mcpServers: {
      x: launcherEntry("x", context, "cursor"),
    } }))
    const preview = await invoke(["--dry-run"])
    expect(preview.output).toContain("launcher requires a command")
    expect((await invoke(["--from", "codex", "--run"])).code).toBe(0)
    const claude = await Bun.file(join(dir, ".claude.json")).json()
    const cursor = await Bun.file(join(dir, "cursor.json")).json()
    expect(claude.mcpServers.x).toEqual({ type: "http", url: "https://new.example" })
    expect(cursor.mcpServers.x).toEqual({ url: "https://new.example" })
    const after = await invoke(["--check"])
    expect(after.code).toBe(0)
    expect(after.output).not.toContain("launcher requires a command")
  })
})

test("scoped directional sync changes only the selected server and pin", async () => {
  await withCliFixture(async (dir, invoke) => {
    const codex = [
      '[mcp_servers.discord-mcp]',
      'url = "http://127.0.0.1:8123/mcp"',
      '[mcp_servers.slack]',
      'command = "slack-mcp"',
    ].join("\n")
    await Bun.write(join(dir, "config.toml"), codex)
    const claude = { mcpServers: { slack: url("independent") } }
    await Bun.write(join(dir, ".claude.json"), JSON.stringify(claude))

    const args = ["--from", "codex", "--servers", "discord-mcp", "--run"]
    expect((await invoke(args)).code).toBe(0)
    expect(await Bun.file(join(dir, "config.toml")).text()).toBe(codex)
    const updated = await Bun.file(join(dir, ".claude.json")).json()
    expect(updated.mcpServers).toEqual({
      slack: claude.mcpServers.slack,
      "discord-mcp": { type: "http", url: "http://127.0.0.1:8123/mcp" },
    })
    const cursor = await Bun.file(join(dir, "cursor.json")).json()
    expect(Object.keys(cursor.mcpServers)).toEqual(["discord-mcp"])
    expect((await invoke(["--from", "codex", "--servers", "unknown"])).code).toBe(1)
  })
})

test("Discord migration refuses a launcher tied to a different Codex profile", async () => {
  await withCliFixture(async (dir, invoke) => {
    const token = crypto.randomUUID()
    const configPath = join(dir, "config.toml")
    const config = [
      '[mcp_servers.discord-mcp]',
      'command = "mcp-discord"',
      `env = { DISCORD_TOKEN = "${token}" }`,
    ].join("\n")
    await Bun.write(configPath, config)
    const other = { ...ctx, sourcePath: join(dir, "other.toml") }
    const claude = JSON.stringify({ mcpServers: {
      "discord-mcp": launcherEntry("discord-mcp", other),
    } })
    await Bun.write(join(dir, ".claude.json"), claude)
    const result = await invoke([
      "--from", "codex", "--servers", "discord-mcp", "--discord-mode", "stdio", "--run",
    ], { HOME: dir, BOKU_HOME: "" })
    expect(result.code).toBe(1)
    expect(result.output).toContain("launcher uses a different source or server")
    expect(result.output).not.toContain(token)
    expect(await Bun.file(configPath).text()).toBe(config)
    expect(await Bun.file(join(dir, ".claude.json")).text()).toBe(claude)
    expect(await Bun.file(join(dir, ".config/mcp-discord/boku-home")).exists()).toBe(false)
  })
})

test("Discord migration rejects inline Codex entries before writing", async () => {
  await withCliFixture(async (dir, invoke) => {
    const token = crypto.randomUUID()
    const config = `mcp_servers = { discord-mcp = { command = "mcp-discord", env = { DISCORD_TOKEN = "${token}" } } }\n`
    const path = join(dir, "config.toml")
    await Bun.write(path, config)
    const result = await invoke([
      "--from", "codex", "--servers", "discord-mcp", "--discord-mode", "shared", "--run",
    ], { HOME: dir, BOKU_HOME: "" })
    expect(result.code).toBe(1)
    expect(result.output).toContain("Move the Discord MCP entry to its own TOML table")
    expect(result.output).not.toContain(token)
    expect(await Bun.file(path).text()).toBe(config)
    expect(await Bun.file(join(dir, ".config/mcp-discord/boku-home")).exists()).toBe(false)
  })
})

test("Discord Claude write preserves changes made after reading the profile", async () => {
  await withCliFixture(async dir => {
    const path = join(dir, ".claude.json")
    const original = await Bun.file(path).text()
    const later = JSON.stringify({ mcpServers: {}, newProject: true })
    await Bun.write(path, later)
    await expect(writeDiscordClaude(path, original, url("shared")))
      .rejects.toThrow("Claude state changed during Discord migration")
    expect(await Bun.file(path).text()).toBe(later)
  })
})

test("Discord vault migration retries without plaintext client backups", async () => {
  await withCliFixture(async (dir, invoke) => {
    const secret = crypto.randomUUID()
    const name = "discord-mcp"
    const launcher = join(dir, ".local/bin/mcp-discord-launch")
    const helper = join(dir, ".local/bin/local-secret-store")
    const bun = join(dir, ".bun/bin/bun")
    const storeHome = join(dir, "custom boku")
    const fixtureStore = join(storeHome, "discord-mcp/secrets/fixture")
    const state = join(dir, "service.log")
    const preload = join(dir, "health-preload.ts")
    const invocation = crypto.randomUUID().replaceAll("-", "")
    await mkdir(join(dir, ".local/bin"), { recursive: true })
    await mkdir(join(dir, ".bun/bin"), { recursive: true })
    await symlink(join(import.meta.dir, "../bin/mcp-discord-launch"), launcher)
    // The fixture covers the real helper's FIFO requirement and reports its
    // credential-free errors. The payload is a synthetic test value.
    await Bun.write(helper, `#!/usr/bin/env bash
set -Eeuo pipefail
[[ "$1" = --store && "$4" = discord-token ]]
case "$3" in
  get)
    [[ -p /dev/stdout ]]
    if [[ ! -f "$2/fixture" ]]; then
      echo 'local-secret-store: encrypted entry does not exist' >&2
      exit 1
    fi
    cat "$2/fixture" ;;
  put)
    [[ -p /dev/stdin ]]
    mkdir -p "$2"
    cat > "$2/fixture" ;;
esac
`)
    await Bun.write(bun, `#!/usr/bin/env bash
set -Eeuo pipefail
[[ "$PWD" = / && "$DISCORD_TOKEN" = "$FIXTURE_TOKEN" ]]
printf '%s\n' "$@"
`)
    const systemctl = join(dir, "systemctl")
    await Bun.write(systemctl, `#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FIXTURE_SYSTEMCTL"
case "$2" in
  show) printf '%s\n' "$FIXTURE_INVOCATION" ;;
  disable) exit "\${FIXTURE_STOP_EXIT:-0}" ;;
esac
`)
    const pgrep = join(dir, "pgrep")
    await Bun.write(pgrep, "#!/bin/sh\nexit 1\n")
    const claudeCommand = join(dir, "claude")
    await Bun.write(claudeCommand, `#!/usr/bin/env bash
mkdir -p "$HOME/.claude/backups"
cp "$CLAUDE_CONFIG_DIR/.claude.json" "$HOME/.claude/backups/.claude.json.backup"
exit 1
`)
    await Bun.write(preload, `
globalThis.fetch = async () => new Response(null, {
  status: 200,
  headers: { "X-Discord-MCP-Invocation-ID": process.env.FIXTURE_READY_ID },
})
`)
    for (const executable of [helper, bun, systemctl, pgrep, claudeCommand]) {
      await chmod(executable, 0o700)
    }

    const original = [
      "#:schema https://example.com/schema.json",
      "# Keep this user comment.",
      '[mcp_servers.discord-mcp]',
      'command = "mcp-discord"',
      'startup_timeout_sec = 30',
      '# Keep the Slack comment.',
      '[mcp_servers.slack]',
      'command = "slack-mcp"',
      '["mcp_servers"."discord-mcp".env]',
      `DISCORD_TOKEN = "${secret}"`,
      '[projects."/example path"]',
      'trust_level = "trusted"',
      '',
    ].join("\r\n")
    await Bun.write(join(dir, "config.toml"), original)
    const clients = { projects: { "/example path": { isTrusted: true } }, mcpServers: {
      [name]: { command: "mcp-discord", env: { DISCORD_TOKEN: secret } },
      slack: url("independent"),
    } }
    await Bun.write(join(dir, ".claude.json"), JSON.stringify(clients))
    await Bun.write(join(dir, "cursor.json"), JSON.stringify(clients))
    const env = {
      HOME: dir, BOKU_HOME: storeHome, FIXTURE_SYSTEMCTL: state,
      FIXTURE_INVOCATION: invocation, FIXTURE_PRELOAD: preload,
    }
    const args = ["--from", "codex", "--servers", name, "--discord-mode"]

    const preview = await invoke([...args, "shared"], env)
    expect(preview.stderr).toBe("")
    expect(preview.code).toBe(0)
    expect(preview.output).not.toContain(secret)
    expect(await Bun.file(fixtureStore).exists()).toBe(false)
    expect(await Bun.file(join(dir, "config.toml")).text()).toBe(original)

    const wrong = await invoke([...args, "shared", "--run"], {
      ...env, FIXTURE_READY_ID: crypto.randomUUID().replaceAll("-", ""),
    })
    expect(wrong.code).toBe(1)
    expect(wrong.output).toContain("readiness from a different invocation")
    expect(wrong.output).not.toContain(secret)
    expect(await Bun.file(join(dir, "config.toml")).text()).toBe(original)
    expect(await Bun.file(join(dir, ".claude.json")).json()).toEqual(clients)
    expect(await Bun.file(join(dir, "cursor.json")).json()).toEqual(clients)
    expect(await Bun.file(state).text()).not.toContain("--user enable")

    const shared = await invoke([...args, "shared", "--run"], {
      ...env, FIXTURE_READY_ID: invocation,
    })
    expect(shared.code).toBe(0)
    expect(shared.output).not.toContain(secret)
    expect(await Bun.file(state).text()).toContain("--user enable mcp-discord.service")
    expect((await Bun.file(join(dir, ".claude.json")).json()).mcpServers[name])
      .toEqual({ type: "http", url: "http://127.0.0.1:8123/mcp" })

    const failed = await invoke([...args, "stdio", "--run"], {
      ...env, FIXTURE_STOP_EXIT: "1",
    })
    expect(failed.code).toBe(1)
    expect(failed.output).not.toContain(secret)
    expect(failed.output).toContain("Unable to disable")
    expect(await Bun.file(fixtureStore).text()).toBe(secret)

    const retry = await invoke([...args, "stdio", "--run"], { ...env, BOKU_HOME: "" })
    expect(retry.code).toBe(0)
    expect(retry.output).not.toContain(secret)
    expect(await Bun.file(state).text()).toEndWith("--user disable --now mcp-discord.service\n")
    const files = await Array.fromAsync(new Bun.Glob("**/*").scan({
      cwd: dir, absolute: true, dot: true,
    }))
    for (const file of files) {
      if (file === fixtureStore || file === launcher) continue
      expect(file).not.toMatch(/backup|before-/)
      expect(await Bun.file(file).text()).not.toContain(secret)
    }
    const code = await Bun.file(join(dir, "config.toml")).text()
    expect(code).not.toContain(secret)
    expect(code).toStartWith("#:schema https://example.com/schema.json\r\n# Keep this user comment.\r\n")
    expect(code).toContain('# Keep the Slack comment.\r\n[mcp_servers.slack]\r\ncommand = "slack-mcp"\r\n')
    expect(code).toEndWith('[projects."/example path"]\r\ntrust_level = "trusted"\r\n')
    expect(parse(code).mcp_servers).toEqual({
      [name]: { command: launcher, args: ["stdio"], startup_timeout_sec: 30 },
      slack: { command: "slack-mcp" },
    })
    for (const file of [".claude.json", "cursor.json"]) {
      const text = await Bun.file(join(dir, file)).text()
      expect(text).not.toContain(secret)
      expect(JSON.parse(text).projects).toEqual(clients.projects)
      expect(JSON.parse(text).mcpServers.slack).toEqual(clients.mcpServers.slack)
      expect(JSON.parse(text).mcpServers[name].args[3]).toBe(name)
    }
    const runtime = Bun.spawn([launcher, "stdio"], {
      env: { ...process.env, HOME: dir, FIXTURE_TOKEN: secret },
      stdout: "pipe", stderr: "pipe",
    })
    const [status, output, error] = await Promise.all([
      runtime.exited, new Response(runtime.stdout).text(), new Response(runtime.stderr).text(),
    ])
    expect(status).toBe(0)
    expect(error).toBe("")
    const version = (await Bun.file(join(import.meta.dir, "discord-pin.txt")).text()).trim()
    expect(output.split("\n")).toEqual([
      "--no-env-file", "x", "--bun", `@uniquedivine/mcp-discord@${version}`,
      "--transport", "stdio", "",
    ])
  })
})

test("CLI pins Jiyuu servers in Codex, keeps env, and checks clean after", async () => {
  await withCliFixture(async (dir, invoke) => {
    const secret = crypto.randomUUID()
    await Bun.write(join(dir, "config.toml"), [
      '[mcp_servers.telegram-mcp]',
      'command = "uv"',
      'args = ["--directory", "/old/jiyuu/mcp/telegram", "run", "main.py"]',
      'startup_timeout_sec = 30',
      `env = { TELEGRAM_API_ID = "1", TELEGRAM_API_HASH = "${secret}", TELEGRAM_SESSION_STRING = "s" }`,
      '[mcp_servers.discord-mcp]',
      'url = "http://127.0.0.1:8123/mcp"',
      '',
    ].join("\n"))
    expect((await invoke(["--check"])).code).toBe(1)
    const result = await invoke(["--run"])
    expect(result.code).toBe(0)
    expect(result.output).toContain("~ pin telegram-mcp to uniquedivine-telegram-mcp@")
    expect(result.output).toContain("! warning slack: not in the Codex config")
    expect(result.output).not.toContain(secret)
    const config = parse(await Bun.file(join(dir, "config.toml")).text()) as any
    const telegram = config.mcp_servers["telegram-mcp"]
    const pin = jiyuuMcpPins["telegram-mcp"]
    expect(telegram.command).toBe("uvx")
    expect(telegram.args.at(-1)).toBe(`${pin.package}@${pin.version}`)
    expect(telegram.env).toEqual({
      TELEGRAM_API_ID: "1", TELEGRAM_API_HASH: secret, TELEGRAM_SESSION_STRING: "s",
    })
    expect(telegram.startup_timeout_sec).toBe(30)
    expect(config.mcp_servers["discord-mcp"]).toEqual({ url: "http://127.0.0.1:8123/mcp" })
    const claude = await Bun.file(join(dir, ".claude.json")).json()
    expect(claude.mcpServers["telegram-mcp"].args[3]).toBe("telegram-mcp")
    expect((await invoke(["--check"])).code).toBe(0)

    const local = { JIYUU_MCP_LOCAL: "telegram-mcp", REPO: "/repos" }
    expect((await invoke(["--check"], local)).code).toBe(1)
    expect((await invoke(["--run"], local)).code).toBe(0)
    const dev = parse(await Bun.file(join(dir, "config.toml")).text()) as any
    expect(dev.mcp_servers["telegram-mcp"].args).toEqual(
      ["--directory", "/repos/boku/jiyuu/mcp/telegram", "run", "main.py"])
    expect((await invoke(["--check"], local)).code).toBe(0)
    expect((await invoke(["--check"])).code).toBe(1)

    const typo = await invoke(["--dry-run"], { JIYUU_MCP_LOCAL: "telegram" })
    expect(typo.code).toBe(1)
    expect(typo.output).toContain("unknown server telegram")
  })
})

test("CLI migrates direct client entries of pinned servers to Codex launchers", async () => {
  await withCliFixture(async (dir, invoke) => {
    const codexToken = crypto.randomUUID()
    const directToken = crypto.randomUUID()
    await Bun.write(join(dir, "config.toml"), [
      '[mcp_servers.slack]',
      'command = "slack-mcp"',
      `env = { SLACK_TOKEN = "${codexToken}" }`,
      '',
    ].join("\n"))
    const direct = {
      command: "slack-mcp", env: { SLACK_TOKEN: directToken, EXTRA: "x" },
    }
    await Bun.write(join(dir, ".claude.json"), JSON.stringify({ mcpServers: {
      slack: { type: "stdio", ...direct },
    } }))
    await Bun.write(join(dir, "cursor.json"), JSON.stringify({ mcpServers: {
      slack: direct,
    } }))
    const pending = await invoke(["--check"])
    expect(pending.code).toBe(1)
    expect(pending.output).toContain("claude: ~ replace slack")
    const result = await invoke(["--run"])
    expect(result.code).toBe(0)
    expect(result.output).toContain("env differs (keys: EXTRA, SLACK_TOKEN)")
    expect(result.output).not.toContain(codexToken)
    expect(result.output).not.toContain(directToken)
    const claude = await Bun.file(join(dir, ".claude.json")).json()
    const cursor = await Bun.file(join(dir, "cursor.json")).json()
    expect(claude.mcpServers.slack.args.slice(1)).toEqual(
      ["--source", join(dir, "config.toml"), "slack"])
    expect(cursor.mcpServers.slack.args[3]).toBe("slack")
    const { readdir, readFile } = await import("node:fs/promises")
    const files = await readdir(dir)
    const claudeBackup = files.find(f => f.startsWith("claude-mcp-before-dotfiles-"))
    const cursorBackup = files.find(f => f.startsWith("cursor.json.before-dotfiles-"))
    expect(claudeBackup).toBeDefined()
    expect(cursorBackup).toBeDefined()
    expect(await readFile(join(dir, claudeBackup!), "utf8")).toContain(directToken)
    expect(await readFile(join(dir, cursorBackup!), "utf8")).toContain(directToken)
    expect((await invoke(["--check"])).code).toBe(0)
  })
})

test("CLI backs up the Codex config before a default rewrite and flags lost comments", async () => {
  await withCliFixture(async (dir, invoke) => {
    const original = [
      '# keep me: model notes',
      'model = "keep"',
      '[mcp_servers.slack]',
      'command = "slack-mcp"',
      '',
    ].join("\n")
    await Bun.write(join(dir, "config.toml"), original)
    const result = await invoke(["--run"])
    expect(result.code).toBe(0)
    expect(result.output).toContain("Saved previous Codex config to")
    expect(result.output).toContain("comments in")
    const { readdir, readFile } = await import("node:fs/promises")
    const backups = (await readdir(dir)).filter(f => f.startsWith("config.toml.before-mcp-sync-"))
    expect(backups).toHaveLength(1)
    expect(await readFile(join(dir, backups[0]!), "utf8")).toBe(original)
    expect((await stat(join(dir, backups[0]!))).mode & 0o777).toBe(0o600)
    // A current config is not rewritten, so it gets no further backup.
    expect((await invoke(["--run"])).output).not.toContain("Saved previous Codex config")
  })
})

test("hasTomlComments ignores the schema directive", () => {
  expect(hasTomlComments("#:schema https://x\na = 1\n")).toBe(false)
  expect(hasTomlComments("a = 1\n  # note\n")).toBe(true)
})

test("CLI leaves direct client entries alone when the Codex entry is disabled", async () => {
  await withCliFixture(async (dir, invoke) => {
    await Bun.write(join(dir, "config.toml"),
      '[mcp_servers.slack]\ncommand = "slack-mcp"\nenabled = false\n')
    const direct = { type: "stdio", command: "slack-mcp" }
    await Bun.write(join(dir, ".claude.json"), JSON.stringify({ mcpServers: { slack: direct } }))
    expect((await invoke(["--run"])).code).toBe(0)
    const claude = await Bun.file(join(dir, ".claude.json")).json()
    expect(claude.mcpServers.slack).toEqual(direct)
    const check = await invoke(["--check"])
    expect(check.output).not.toContain("replace slack")
    expect(check.code).toBe(0)
  })
})

test("CLI preserves unrecognized direct entries of pinned servers with a warning", async () => {
  await withCliFixture(async (dir, invoke) => {
    await Bun.write(join(dir, "config.toml"), '[mcp_servers.slack]\ncommand = "slack-mcp"\n')
    const remote = { type: "http", url: "https://slack.example/mcp", headers: { A: "b" } }
    const custom = { command: "npx", args: ["some-other-slack"] }
    await Bun.write(join(dir, ".claude.json"), JSON.stringify({ mcpServers: { slack: remote } }))
    await Bun.write(join(dir, "cursor.json"), JSON.stringify({ mcpServers: { slack: custom } }))
    const result = await invoke(["--run"])
    expect(result.code).toBe(0)
    expect(result.output).toContain("claude/slack: direct entry is not a known Jiyuu checkout launch")
    expect(result.output).toContain("cursor/slack: direct entry is not a known Jiyuu checkout launch")
    expect((await Bun.file(join(dir, ".claude.json")).json()).mcpServers.slack).toEqual(remote)
    expect((await Bun.file(join(dir, "cursor.json")).json()).mcpServers.slack).toEqual(custom)
    expect((await invoke(["--check"])).code).toBe(0)
  })
})

test("CLI preserves a recognized Jiyuu launch that sets fields the launcher can't reproduce", async () => {
  await withCliFixture(async (dir, invoke) => {
    await Bun.write(join(dir, "config.toml"), '[mcp_servers.slack]\ncommand = "slack-mcp"\n')
    const direct = { command: "slack-mcp", envFile: "/secrets/slack.env" }
    await Bun.write(join(dir, "cursor.json"), JSON.stringify({ mcpServers: { slack: direct } }))
    const result = await invoke(["--run"])
    expect(result.code).toBe(0)
    expect(result.output).toContain("cursor/slack: Jiyuu checkout launch also sets envFile")
    expect((await Bun.file(join(dir, "cursor.json")).json()).mcpServers.slack).toEqual(direct)
    expect((await invoke(["--check"])).code).toBe(0)
  })
})

test("CLI check fails while a pinned Jiyuu server is missing from Codex", async () => {
  await withCliFixture(async (dir, invoke) => {
    const enforce = { MCP_SYNC_SKIP_PIN_CHECK: "" }
    await Bun.write(join(dir, "config.toml"), '[mcp_servers.local]\ncommand = "server"\n')
    expect((await invoke(["--run"])).code).toBe(0)
    expect((await invoke(["--check"])).code).toBe(0)
    const check = await invoke(["--check"], enforce)
    expect(check.code).toBe(1)
    expect(check.output).toContain(
      "! missing pinned servers in Codex: discord-mcp, slack, telegram-mcp")
    expect(check.output).not.toContain("MCP union is current")
    const pinned = Object.entries(jiyuuMcpPins).map(([name, pin]) => [
      `[mcp_servers.${name}]`, `command = "${pin.runner}"`,
      `args = ["${pin.package}@${pin.version}"]`,
    ].join("\n")).join("\n")
    await Bun.write(join(dir, "config.toml"),
      `[mcp_servers.local]\ncommand = "server"\n${pinned}\n`)
    expect((await invoke(["--run"])).code).toBe(0)
    expect((await invoke(["--check"], enforce)).code).toBe(0)
  })
})

describe("Move servers between machines", () => {
  const secrets = {
    hash: crypto.randomUUID(), session: crypto.randomUUID(),
    tool: crypto.randomUUID(), header: crypto.randomUUID(), local: crypto.randomUUID(),
  }
  // Each test spawns several CLI processes, slow on a loaded machine.
  const slow = 20_000
  const telegramPin = jiyuuMcpPins["telegram-mcp"]
  const source = [
    "[mcp_servers.telegram-mcp]",
    `command = "${telegramPin.runner}"`,
    `args = ["${telegramPin.package}@${telegramPin.version}"]`,
    "startup_timeout_sec = 30",
    `env = { TELEGRAM_API_ID = "1", TELEGRAM_API_HASH = "${secrets.hash}", ` +
      `TELEGRAM_SESSION_STRING = "${secrets.session}" }`,
    "[mcp_servers.tool]",
    'command = "bun"',
    'args = ["/nonexistent-mcp-xfer/config.json"]',
    `env = { TOOL_TOKEN = "${secrets.tool}" }`,
    "[mcp_servers.ghost]",
    'command = "no-such-mcp-command-xfer"',
    "[mcp_servers.remote]",
    'url = "https://remote.example/mcp"',
    `http_headers = { Authorization = "${secrets.header}" }`,
    "",
  ].join("\n")

  const expectNoSecrets = (...texts: string[]) => {
    for (const text of texts) {
      for (const secret of Object.values(secrets)) expect(text).not.toContain(secret)
    }
  }

  /** Exports `source` from a second config in the fixture directory. */
  const exportFrom = async (dir: string, invoke: Invoke, extra: string[] = []) => {
    await Bun.write(join(dir, "source.toml"), source)
    const result = await invoke(["--export", ...extra, "--codex-config", join(dir, "source.toml")])
    expectNoSecrets(result.stderr)
    return result
  }

  test("export prints only the payload; unknown names fail", async () => {
    await withCliFixture(async (dir, invoke) => {
      const result = await exportFrom(dir, invoke)
      expect(result.code).toBe(0)
      expect(result.stderr).toBe("")
      const payload = JSON.parse(result.stdout)
      expect(payload.version).toBe(1)
      expect(Object.keys(payload.mcp_servers)).toEqual(["ghost", "remote", "telegram-mcp", "tool"])
      expect(payload.mcp_servers.tool.env).toEqual({ TOOL_TOKEN: secrets.tool })
      const some = await exportFrom(dir, invoke, ["--servers", "tool,remote"])
      expect(Object.keys(JSON.parse(some.stdout).mcp_servers)).toEqual(["tool", "remote"])
      const unknown = await exportFrom(dir, invoke, ["--servers", "tool,nope"])
      expect(unknown.code).toBe(1)
      expect(unknown.stdout).toBe("")
      expect(unknown.stderr).toContain("Unknown MCP server: nope")
    })
  }, slow)

  test("dry run reports and writes nothing", async () => {
    await withCliFixture(async (dir, invoke) => {
      const payload = join(dir, "payload.json")
      await Bun.write(payload, (await exportFrom(dir, invoke)).stdout)
      const original = 'model = "keep"\n'
      await Bun.write(join(dir, "config.toml"), original)
      const claudeBefore = await Bun.file(join(dir, ".claude.json")).text()
      const result = await invoke(["--import", payload])
      expect(result.code).toBe(0)
      expectNoSecrets(result.output)
      expect(result.stdout).toContain("+ add telegram-mcp (env keys: TELEGRAM_API_HASH, " +
        "TELEGRAM_API_ID, TELEGRAM_SESSION_STRING)")
      expect(result.stdout).toContain("+ add tool (env keys: TOOL_TOKEN)")
      expect(result.stdout).toContain("+ add remote (env keys: none)")
      expect(result.stdout).toContain(
        "! warning ghost: command no-such-mcp-command-xfer not found on this machine")
      expect(result.stdout).toContain(
        "! warning tool: path /nonexistent-mcp-xfer/config.json does not exist")
      expect(result.stdout).toContain("Dry run: nothing written")
      expect(await Bun.file(join(dir, "config.toml")).text()).toBe(original)
      expect(await Bun.file(join(dir, ".claude.json")).text()).toBe(claudeBefore)
      expect(await Bun.file(join(dir, "cursor.json")).exists()).toBe(false)
    })
  }, slow)

  test("import into an empty config adds servers with env intact, then repeats unchanged", async () => {
    await withCliFixture(async (dir, invoke) => {
      const payload = join(dir, "payload.json")
      await Bun.write(payload, (await exportFrom(dir, invoke)).stdout)
      const result = await invoke(["--import", payload, "--run"])
      expect(result.code).toBe(0)
      expectNoSecrets(result.output)
      const config = parse(await Bun.file(join(dir, "config.toml")).text()) as any
      expect(config.mcp_servers).toEqual((parse(source) as any).mcp_servers)
      expect((await stat(join(dir, "config.toml"))).mode & 0o777).toBe(0o600)
      const claude = await Bun.file(join(dir, ".claude.json")).json()
      expect(claude.mcpServers["telegram-mcp"].args[3]).toBe("telegram-mcp")
      const cursor = await Bun.file(join(dir, "cursor.json")).json()
      expect(cursor.mcpServers.tool.args[3]).toBe("tool")
      const again = await invoke(["--import", payload, "--run"])
      expect(again.code).toBe(0)
      for (const name of ["ghost", "remote", "telegram-mcp", "tool"]) {
        expect(again.stdout).toContain(`= unchanged ${name}`)
      }
      expect(again.stdout).toContain("MCP union is current")
    })
  }, slow)

  test("a differing server is kept and reported, then replaced with --overwrite", async () => {
    await withCliFixture(async (dir, invoke) => {
      const payload = join(dir, "payload.json")
      await Bun.write(payload, (await exportFrom(dir, invoke, ["--servers", "tool"])).stdout)
      const local = `[mcp_servers.tool]\ncommand = "bun"\nenv = { TOOL_TOKEN = "${secrets.local}", OTHER = "x" }\n`
      await Bun.write(join(dir, "config.toml"), local)
      const kept = await invoke(["--import", payload, "--run"])
      expect(kept.code).toBe(0)
      expectNoSecrets(kept.output)
      expect(kept.stdout).toContain("~ differs tool (keys: args, env.OTHER, env.TOOL_TOKEN)")
      const keptConfig = parse(await Bun.file(join(dir, "config.toml")).text()) as any
      expect(keptConfig.mcp_servers.tool.env.TOOL_TOKEN).toBe(secrets.local)
      const replaced = await invoke(["--import", payload, "--overwrite", "--run"])
      expect(replaced.code).toBe(0)
      expectNoSecrets(replaced.output)
      expect(replaced.stdout).toContain("~ replace tool")
      const config = parse(await Bun.file(join(dir, "config.toml")).text()) as any
      expect(config.mcp_servers.tool.env).toEqual({ TOOL_TOKEN: secrets.tool })
      const { readdir, readFile } = await import("node:fs/promises")
      const backups = (await readdir(dir)).filter(f => f.startsWith("config.toml.before-mcp-sync-"))
      const texts = await Promise.all(backups.map(f => readFile(join(dir, f), "utf8")))
      expect(texts.some(text => text.includes(secrets.local))).toBe(true)
    })
  }, slow)

  test("import reads stdin and rejects invalid input without echoing it", async () => {
    await withCliFixture(async (dir, invoke) => {
      const exported = (await exportFrom(dir, invoke)).stdout
      const result = await invoke(["--import", "-", "--servers", "remote", "--run"], {}, exported)
      expect(result.code).toBe(0)
      expectNoSecrets(result.output)
      expect(result.stdout).toContain("+ add remote (env keys: none)")
      const config = parse(await Bun.file(join(dir, "config.toml")).text()) as any
      expect(Object.keys(config.mcp_servers)).toEqual(["remote"])
      expect(config.mcp_servers.remote.http_headers.Authorization).toBe(secrets.header)
      const broken = await invoke(["--import", "-"], {}, `{ "token": "${secrets.tool}"`)
      expect(broken.code).toBe(1)
      expect(broken.stderr).toContain("not valid JSON")
      expectNoSecrets(broken.output)
      const future = await invoke(["--import", "-"], {},
        JSON.stringify({ version: 2, mcp_servers: {} }))
      expect(future.code).toBe(1)
      expect(future.stderr).toContain("version must be 1")
    })
  }, slow)
})
