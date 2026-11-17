import { describe, expect, test } from "bun:test"

import {
  applyJiyuuPins, jiyuuCheckoutDir, jiyuuMcpPins, localLaunch,
  parseLocalNames, pinnedLaunch, type JiyuuMcpPin,
} from "./pins.ts"

const bunPin: JiyuuMcpPin = {
  runner: "bunx", package: "@scope/server", version: "1.2.3",
  local: { command: "bun", entry: "mcp/server/src/index.ts" },
}
const uvPin: JiyuuMcpPin = {
  runner: "uvx", package: "py-server", version: "2.0.1", with: ["dep<2"],
  local: { command: "uv", directory: "mcp/py", entry: "main.py" },
}
const pins = { node: bunPin, py: uvPin }

describe("pinned and local launches", () => {
  test("pin exact versions, with uvx requirements before the package", () => {
    expect(pinnedLaunch(bunPin)).toEqual(
      { command: "bunx", args: ["@scope/server@1.2.3"] })
    expect(pinnedLaunch(uvPin)).toEqual(
      { command: "uvx", args: ["--with", "dep<2", "py-server@2.0.1"] })
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
      command: "uvx", args: ["--with", "dep<2", "py-server@2.0.1"],
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
