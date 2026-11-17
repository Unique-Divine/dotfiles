import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  applyJiyuuPins, isLegacyJiyuuLaunch, readDotEnvKeysFrom, jiyuuCheckoutDir, launchDirectory, jiyuuMcpPins, localLaunch,
  parseLocalNames, pinnedLaunch, type JiyuuMcpPin,
} from "./pins.ts"

const bunPin: JiyuuMcpPin = {
  runner: "bunx", package: "@scope/server", version: "1.2.3",
  local: { command: "bun", entry: "mcp/server/src/index.ts" },
  legacy: { commands: ["server-mcp"], component: "mcp/server" },
}
const uvPin: JiyuuMcpPin = {
  runner: "uvx", package: "py-server", version: "2.0.1",
  local: { command: "uv", directory: "mcp/py", entry: "main.py" },
  legacy: { commands: [], component: "mcp/py" },
}
const pins = { node: bunPin, py: uvPin }

describe("pinned and local launches", () => {
  test("pin exact versions", () => {
    expect(pinnedLaunch(bunPin)).toEqual(
      { command: "bunx", args: ["@scope/server@1.2.3"] })
    expect(pinnedLaunch(uvPin)).toEqual(
      { command: "uvx", args: ["py-server@2.0.1"] })
  })

  test("local launches run sources from the Jiyuu checkout", () => {
    expect(localLaunch(bunPin, "/j")).toEqual(
      { command: "bun", args: ["/j/mcp/server/src/index.ts"] })
    expect(localLaunch(uvPin, "/j")).toEqual(
      { command: "uv", args: ["--directory", "/j/mcp/py", "run", "main.py"] })
  })

  test("every real pin is an exact semver release", () => {
    for (const pin of Object.values(jiyuuMcpPins)) {
      expect(pin.version).toMatch(/^\d+\.\d+\.\d+$/)
    }
  })

  test("the Jiyuu checkout sits at $REPO/boku/jiyuu", () => {
    expect(jiyuuCheckoutDir({ REPO: "/home/me" })).toBe("/home/me/boku/jiyuu")
    expect(jiyuuCheckoutDir({})).toBeUndefined()
  })
})

describe("parseLocalNames", () => {
  test("accepts names, all, and empty values", () => {
    expect([...parseLocalNames("node, py", pins)]).toEqual(["node", "py"])
    expect([...parseLocalNames("all", pins)].sort()).toEqual(["node", "py"])
    expect(parseLocalNames(undefined, pins).size).toBe(0)
    expect(parseLocalNames("", pins).size).toBe(0)
  })

  test("rejects unknown names", () => {
    expect(() => parseLocalNames("nod", pins)).toThrow("unknown server nod")
  })
})

describe("applyJiyuuPins", () => {
  const secret = crypto.randomUUID()
  const servers = () => ({
    node: { command: "node-mcp", env: { TOKEN: secret }, startup_timeout_sec: 9 },
    py: {
      command: "uv", args: ["--directory", "/old", "run", "main.py"],
      enabled: false,
    },
    other: { command: "other" },
  })

  test("changes only command and args, and keeps the input intact", () => {
    const input = servers()
    const result = applyJiyuuPins(input, { pins })
    expect(result.servers.node).toEqual({
      command: "bunx", args: ["@scope/server@1.2.3"], env: { TOKEN: secret },
      startup_timeout_sec: 9,
    })
    expect(result.servers.py).toEqual({
      command: "uvx", args: ["py-server@2.0.1"],
      enabled: false,
    })
    expect(result.servers.other).toEqual({ command: "other" })
    expect(input).toEqual(servers())
    expect(result.changes).toEqual([
      "~ pin node to @scope/server@1.2.3", "~ pin py to py-server@2.0.1",
    ])
    expect(result.changes.join()).not.toContain(secret)
  })

  test("is idempotent", () => {
    const once = applyJiyuuPins(servers(), { pins })
    const twice = applyJiyuuPins(once.servers, { pins })
    expect(twice.servers).toEqual(once.servers)
    expect(twice.changes).toEqual([])
  })

  test("local names switch to the checkout and require REPO", () => {
    const local = new Set(["node"])
    const result = applyJiyuuPins(servers(), { pins, local, jiyuuDir: "/j" })
    expect(result.servers.node).toMatchObject(
      { command: "bun", args: ["/j/mcp/server/src/index.ts"] })
    expect(result.changes[0]).toBe("~ pin node to local Jiyuu checkout")
    expect(() => applyJiyuuPins(servers(), { pins, local }))
      .toThrow("REPO is unset")
  })

  test("leaves shared url servers alone and warns about missing ones", () => {
    const shared = { node: { url: "http://127.0.0.1:8123/mcp" } }
    const result = applyJiyuuPins(shared, { pins })
    expect(result.servers.node).toEqual(shared.node)
    expect(result.servers.py).toBeUndefined()
    expect(result.changes).toEqual([])
    expect(result.warnings).toEqual([
      "py: not in the Codex config; add it with its env to run py-server@2.0.1",
    ])
  })

  test("warns instead of guessing for malformed entries", () => {
    const result = applyJiyuuPins({ node: { args: [] }, py: "bad" }, { pins })
    expect(result.warnings).toHaveLength(2)
    expect(result.changes).toEqual([])
  })
})

describe("Telegram checkout credentials", () => {
  const authPin: JiyuuMcpPin = {
    ...uvPin,
    auth: { prefix: "TG_", fileSession: "TG_SESSION_NAME" },
  }
  const full = { TG_ID: "1", TG_HASH: "h", TG_SESSION: "s" }
  const oldEntry = (env: Record<string, string>) => ({
    tg: {
      command: "uv", args: ["--directory", "/old/tg", "run", "main.py"], env,
    },
  })
  const run = (env: Record<string, string>, dotEnv: string[] = []) =>
    applyJiyuuPins(oldEntry(env), {
      pins: { tg: authPin }, readDotEnvKeys: () => dotEnv,
    })
  const command = (result: ReturnType<typeof run>) =>
    (result.servers.tg as { command: string }).command

  test("pins with complete env and no extra .env keys (the laptop shape)", () => {
    expect(command(run(full))).toBe("uvx")
    expect(command(run(full, ["TG_ID", "OTHER"]))).toBe("uvx")
  })

  test("pins inherited credentials: no env table and no .env", () => {
    const servers = { tg: {
      command: "uv", args: ["--directory", "/old/tg", "run", "main.py"],
    } }
    const result = applyJiyuuPins(servers, {
      pins: { tg: authPin }, readDotEnvKeys: () => [],
    })
    expect(command(result)).toBe("uvx")
    expect(result.warnings).toEqual([])
  })

  test("env_vars count as providing .env keys", () => {
    const servers = { tg: {
      command: "uv", args: ["--directory", "/old/tg", "run", "main.py"],
      env_vars: ["TG_ID", "TG_HASH"],
    } }
    const result = applyJiyuuPins(servers, {
      pins: { tg: authPin }, readDotEnvKeys: () => ["TG_ID", "TG_HASH"],
    })
    expect(command(result)).toBe("uvx")
  })

  test("holds the pin when .env defines keys the Codex env lacks", () => {
    const result = run(full, ["TG_SESSION_NAME", "TG_ID"])
    expect(command(result)).toBe("uv")
    expect(result.changes).toEqual([])
    expect(result.warnings[0]).toContain(
      "tg: not pinned; /old/tg/.env defines TG_SESSION_NAME")
    expect(result.warnings[0]).toContain("[mcp_servers.tg].env")
  })

  test("holds the pin while env names a session file in the old directory", () => {
    const result = run({ ...full, TG_SESSION_NAME_WORK: "work" })
    expect(command(result)).toBe("uv")
    expect(result.warnings[0]).toContain(
      "tg: not pinned; TG_SESSION_NAME_WORK name session files relative to the old launch directory")
  })

  test("never prints values", () => {
    const secret = crypto.randomUUID()
    const result = run({ TG_ID: secret }, ["TG_HASH"])
    expect(result.warnings.join()).not.toContain(secret)
  })

  test("an already pinned entry is not rechecked", () => {
    const pinned = { tg: { command: "uvx", args: ["py-server@2.0.0"] } }
    const result = applyJiyuuPins(pinned, {
      pins: { tg: authPin }, readDotEnvKeys: () => ["TG_X"],
    })
    expect((result.servers.tg as { args: string[] }).args)
      .toEqual(["py-server@2.0.1"])
  })

  test("readDotEnvKeysFrom reads names from a real .env", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pins-dotenv-"))
    try {
      expect(readDotEnvKeysFrom(dir)).toEqual([])
      await writeFile(join(dir, "test_session.session"), "")
      expect(readDotEnvKeysFrom(dir)).toEqual([])
      await writeFile(join(dir, ".env"),
        "# note\nTG_ID=1\nexport TG_HASH = 'x'\n\nnot a line\n")
      expect(readDotEnvKeysFrom(dir)).toEqual(["TG_ID", "TG_HASH"])
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  test("the real Telegram pin checks API keys and the session string", () => {
    const result = applyJiyuuPins({ "telegram-mcp": {
      command: "uv", args: ["--directory", "/j/mcp/telegram", "run", "main.py"],
      env: { TELEGRAM_API_ID: "1", TELEGRAM_API_HASH: "h",
        TELEGRAM_SESSION_STRING: "s", TELEGRAM_EXPOSED_TOOLS: "x" },
    } }, { readDotEnvKeys: () => [] })
    expect(result.changes).toContain(
      "~ pin telegram-mcp to uniquedivine-telegram-mcp@" +
      jiyuuMcpPins["telegram-mcp"].version)
  })

  test("launchDirectory reads uv --directory, then cwd", () => {
    expect(launchDirectory({ command: "uv", args: ["--directory", "/a"] }))
      .toBe("/a")
    expect(launchDirectory({ command: "x", cwd: "/b" })).toBe("/b")
    expect(launchDirectory({ command: "x" })).toBeUndefined()
  })
})

describe("isLegacyJiyuuLaunch", () => {
  const pins = jiyuuMcpPins
  test("recognizes pre-pin Jiyuu launches", () => {
    expect(isLegacyJiyuuLaunch({ command: "mcp-discord" }, pins["discord-mcp"]))
      .toBe(true)
    expect(isLegacyJiyuuLaunch({ type: "stdio", command: "/home/u/.bun/bin/slack-mcp" },
      pins.slack)).toBe(true)
    expect(isLegacyJiyuuLaunch({ command: "bun",
      args: ["/home/u/boku/jiyuu/mcp/slack/src/cli.js"] }, pins.slack)).toBe(true)
    expect(isLegacyJiyuuLaunch({ command: "uv", args: ["--directory",
      "/home/u/boku/jiyuu/mcp/telegram", "run", "main.py"] },
    pins["telegram-mcp"])).toBe(true)
  })

  test("rejects remote and unrecognized definitions", () => {
    expect(isLegacyJiyuuLaunch({ type: "http", url: "https://slack.example" },
      pins.slack)).toBe(false)
    expect(isLegacyJiyuuLaunch({ type: "sse", command: "slack-mcp" },
      pins.slack)).toBe(false)
    expect(isLegacyJiyuuLaunch({ command: "npx", args: ["other-slack"] },
      pins.slack)).toBe(false)
    expect(isLegacyJiyuuLaunch({ command: "slack-mcp" }, pins["discord-mcp"]))
      .toBe(false)
  })
})
