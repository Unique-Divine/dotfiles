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
