import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { stringify } from "smol-toml"

import {
  classifyServer,
  codexUrlToJson,
  desiredEntries,
  isLauncherEntry,
  jsonToCodex,
  launcherEntry,
  readCodexMcpServers,
  type LauncherContext,
} from "./servers.ts"

const fixtureCtx: LauncherContext = {
  bunPath: "/opt/bun/bin/bun",
  launcherPath: "/home/u/dotfiles/claude/mcp-launch.ts",
  sourcePath: "/home/u/.codex/config.toml",
}

const withTempDir = async (
  run: (dir: string) => Promise<void>,
): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-servers-"))

  try {
    await run(dir)
  } finally {
    await rm(dir, { force: true, recursive: true })
  }
}

describe("readCodexMcpServers", () => {
  test("returns enabled servers and drops disabled ones", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "config.toml")
      await writeFile(path, stringify({
        model: "m",
        mcp_servers: {
          on: { command: "on-cmd", env: { K: "v" } },
          off: { command: "off-cmd", enabled: false },
          docs: { url: "https://docs.example.com/mcp", enabled: true },
        },
      }))

      expect(await readCodexMcpServers(path)).toEqual({
        on: { command: "on-cmd", env: { K: "v" } },
        docs: { url: "https://docs.example.com/mcp", enabled: true },
      })
    })
  })

  test("a missing file or table yields no servers", async () => {
    await withTempDir(async (dir) => {
      expect(await readCodexMcpServers(join(dir, "missing.toml"))).toEqual({})
      const path = join(dir, "config.toml")
      await writeFile(path, 'model = "m"\n')
      expect(await readCodexMcpServers(path)).toEqual({})
    })
  })

  test("rejects malformed TOML and non-table servers", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "config.toml")
      await writeFile(path, "mcp_servers = [\n")
      await expect(readCodexMcpServers(path))
        .rejects.toThrow("Unable to parse Codex config")
      await writeFile(path, 'mcp_servers = "x"\n')
      await expect(readCodexMcpServers(path))
        .rejects.toThrow("mcp_servers must be a table")
      await writeFile(path, '[mcp_servers]\nbad = "x"\n')
      await expect(readCodexMcpServers(path))
        .rejects.toThrow("mcp_servers.bad must be a table")
    })
  })
})

describe("server mapping", () => {
  test("classifies stdio, url, and invalid servers", () => {
    expect(classifyServer({ command: "x" })).toBe("stdio")
    expect(classifyServer({ url: "https://x" })).toBe("url")
    expect(classifyServer({ command: "" })).toBe("invalid")
    expect(classifyServer("x")).toBe("invalid")
  })

  test("maps Codex url servers to Claude and Cursor shapes", () => {
    const server = {
      url: "https://mcp.example.com/mcp",
      http_headers: { "X-Team": "ops" },
      startup_timeout_sec: 20,
    }

    expect(codexUrlToJson(server, "claude")).toEqual({
      ok: true,
      entry: {
        type: "http",
        url: "https://mcp.example.com/mcp",
        headers: { "X-Team": "ops" },
      },
    })
    expect(codexUrlToJson({ url: "https://x" }, "cursor"))
      .toEqual({ ok: true, entry: { url: "https://x" } })
  })

  test("skips url servers with env-based auth", () => {
    for (const field of ["bearer_token_env_var", "env_http_headers"]) {
      const mapped = codexUrlToJson({ url: "https://x", [field]: "T" }, "claude")
      expect(mapped.ok).toBe(false)
    }
  })

  test("maps JSON entries to Codex servers for ingest", () => {
    expect(jsonToCodex({
      type: "stdio", command: "npx", args: ["srv"], env: { K: "v" },
    })).toEqual({
      ok: true, entry: { command: "npx", args: ["srv"], env: { K: "v" } },
    })
    expect(jsonToCodex({ type: "stdio", command: "srv", args: [], env: {} }))
      .toEqual({ ok: true, entry: { command: "srv" } })
    expect(jsonToCodex({
      type: "http", url: "https://mail.example.com/mcp",
    })).toEqual({ ok: true, entry: { url: "https://mail.example.com/mcp" } })
    expect(jsonToCodex({
      url: "https://x", headers: { Authorization: "Bearer t" },
    })).toEqual({
      ok: true,
      entry: { url: "https://x", http_headers: { Authorization: "Bearer t" } },
    })
    expect(jsonToCodex({ type: "sse", url: "https://x" }).ok).toBe(false)
    expect(jsonToCodex({ type: "stdio", command: "x", env: { K: 1 } }).ok)
      .toBe(false)
  })

  test("url mapping round-trips through Codex", () => {
    const claude = {
      type: "http", url: "https://x/mcp", headers: { A: "b" },
    }
    const codex = jsonToCodex(claude)
    expect(codex.ok).toBe(true)
    if (codex.ok) {
      expect(codexUrlToJson(codex.entry, "claude"))
        .toEqual({ ok: true, entry: claude })
    }
  })
})

describe("desiredEntries", () => {
  test("builds launcher and url entries per target", () => {
    const servers = {
      notion: { command: "notion", env: { NOTION_TOKEN: "s" } },
      docs: { url: "https://docs.example.com/mcp" },
      broken: { args: ["x"] },
    }
    const claude = desiredEntries(servers, "claude", fixtureCtx)
    const cursor = desiredEntries(servers, "cursor", fixtureCtx)

    expect(claude.entries).toEqual({
      docs: { type: "http", url: "https://docs.example.com/mcp" },
      notion: launcherEntry("notion", fixtureCtx, "claude"),
    })
    expect(claude.urlNames).toEqual(["docs"])
    expect(claude.skip).toEqual([
      { name: "broken", reason: "no command or url" },
    ])
    expect(cursor.entries.notion).toEqual({
      command: fixtureCtx.bunPath,
      args: [fixtureCtx.launcherPath, "--source", fixtureCtx.sourcePath, "notion"],
    })
    expect(JSON.stringify([claude, cursor])).not.toContain("NOTION_TOKEN")
  })

  test("recognizes launcher entries by script location", () => {
    expect(isLauncherEntry(launcherEntry("x", fixtureCtx))).toBe(true)
    expect(isLauncherEntry(launcherEntry("x", fixtureCtx, "cursor")))
      .toBe(true)
    expect(isLauncherEntry({ command: "bun", args: ["mcp-launch.ts"] }))
      .toBe(false)
    expect(isLauncherEntry({ url: "https://example.com" })).toBe(false)
  })
})
