import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parse } from "smol-toml"
import { planUnion, resolveDefinitions, type Inventory, type Platform } from "./sync.ts"
import { applyPlan } from "../cursor/mcp.ts"
import { launcherEntry } from "./servers.ts"

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
  const p = Bun.spawn([process.execPath, script, ...args], { stdout: "pipe", stderr: "pipe" })
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

async function withCliFixture(
  check: (dir: string, invoke: (args: string[]) => Promise<{ code: number; output: string }>) => Promise<void>,
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
    const { chmod } = await import("node:fs/promises")
    await chmod(join(dir, "claude"), 0o700)
    await Bun.write(join(dir, ".claude.json"), JSON.stringify({ mcpServers: {}, unrelated: true }))
    const invoke = async (args: string[]) => {
      const p = Bun.spawn([process.execPath, script,
        "--codex-config", join(dir, "config.toml"),
        "--claude-config", join(dir, ".claude.json"),
        "--cursor-config", join(dir, "cursor.json"), ...args,
      ], {
        env: { ...process.env, CLAUDE_CONFIG_DIR: dir, PATH: `${dir}:${process.env.PATH}` },
        stdout: "pipe", stderr: "pipe",
      })
      const [code, stdout, stderr] = await Promise.all([
        p.exited, new Response(p.stdout).text(), new Response(p.stderr).text(),
      ])
      return { code, output: stdout + stderr }
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
