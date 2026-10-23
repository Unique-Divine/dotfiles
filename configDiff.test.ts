import { describe, expect, test } from "bun:test"

import { changedKeyPaths, formatKeyChanges, unifiedDiff } from "./configDiff.ts"

describe("changedKeyPaths", () => {
  test("walks nested objects and reports leaf changes", () => {
    expect(
      changedKeyPaths(
        {
          model: "a",
          old: 1,
          mcp_servers: { notion: { env: { TOKEN: "x" }, command: "n" } },
        },
        {
          model: "b",
          added: true,
          mcp_servers: { notion: { env: { TOKEN: "y" }, command: "n" } },
        },
      ),
    ).toEqual([
      { path: "added", kind: "added" },
      { path: "mcp_servers.notion.env.TOKEN", kind: "changed" },
      { path: "model", kind: "changed" },
      { path: "old", kind: "removed" },
    ])
  })

  test("treats arrays and object-to-scalar swaps as one change", () => {
    expect(
      changedKeyPaths({ args: ["a"], tui: { x: 1 } }, { args: ["b"], tui: 2 }),
    ).toEqual([
      { path: "args", kind: "changed" },
      { path: "tui", kind: "changed" },
    ])
  })

  test("quotes keys that are not plain identifiers", () => {
    expect(
      changedKeyPaths({ projects: {} }, { projects: { "/tmp/a.b": 1 } }),
    ).toEqual([{ path: 'projects."/tmp/a.b"', kind: "added" }])
  })

  test("reports nothing for equal objects", () => {
    expect(changedKeyPaths({ a: { b: [1] } }, { a: { b: [1] } })).toEqual([])
  })
})

describe("formatKeyChanges", () => {
  test("renders markers and never values", () => {
    const secret = `secret-${crypto.randomUUID()}`
    const text = formatKeyChanges(
      changedKeyPaths({ env: { TOKEN: secret } }, { env: { TOKEN: "next" } }),
    )

    expect(text).toBe("Changed keys (values hidden):\n  ~ env.TOKEN\n")
    expect(text).not.toContain(secret)
  })

  test("says when only formatting changed", () => {
    expect(formatKeyChanges([])).toBe("Changed keys: none (formatting only)\n")
  })
})

describe("unifiedDiff", () => {
  test("produces a compact diff with context", () => {
    const diff = unifiedDiff(
      '{\n  "editor": { "vimMode": true }\n}\n',
      '{\n  "editor": { "vimMode": false }\n}\n',
      "runtime",
      "generated",
    )

    expect(diff).toContain("--- runtime")
    expect(diff).toContain("+++ generated")
    expect(diff).toContain('-  "editor": { "vimMode": true }')
    expect(diff).toContain('+  "editor": { "vimMode": false }')
    expect(diff).toContain(" {")
  })

  test("is empty for equal text", () => {
    expect(unifiedDiff("a\n", "a\n")).toBe("")
  })
})
