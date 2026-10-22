import { describe, expect, test } from "bun:test"
import { bash } from "@uniquedivine/bash"

import {
  parseArgs,
  parsePane,
  parsePaneList,
  planFlatten,
  quoteArg,
  type Pane,
} from "./flatten"

function pane(index: number, overrides: Partial<Pane> = {}): Pane {
  return {
    pane_id: `w1:p${index}`,
    tab_id: "w1:t1",
    workspace_id: "w1",
    terminal_id: `term_${index}`,
    agent: "codex",
    focused: false,
    ...overrides,
  }
}

describe("flatten planning", () => {
  test("keeps one agent per tab and ignores other workspaces", () => {
    const panes = [
      pane(1),
      pane(2),
      pane(3),
      pane(4, { tab_id: "w1:t2" }),
      pane(5, { tab_id: "w1:t2", agent: "claude" }),
      pane(6, { workspace_id: "w2", tab_id: "w2:t1" }),
      pane(7, { workspace_id: "w2", tab_id: "w2:t1" }),
    ]
    const original = structuredClone(panes)
    expect(planFlatten(panes, "w1").moves.map((p) => p.pane_id)).toEqual([
      "w1:p2",
      "w1:p3",
      "w1:p5",
    ])
    expect(panes).toEqual(original)
  })

  test("keeps the focused agent even when it appears later", () => {
    const panes = [pane(1), pane(2, { focused: true }), pane(3)]
    expect(planFlatten(panes, "w1").moves.map((p) => p.pane_id)).toEqual([
      "w1:p1",
      "w1:p3",
    ])
  })

  test("reports non-agent panes without moving them", () => {
    const shell = pane(1, { agent: undefined, focused: true })
    const panes = [shell, pane(2), pane(3)]
    const plan = planFlatten(panes, "w1")
    expect(plan.moves).toEqual([panes[2]!])
    expect(plan.nonAgentPanes).toEqual([shell])
  })

  test("is a no-op after each planned pane has its own new tab", () => {
    const panes = Array.from({ length: 9 }, (_, i) =>
      pane(i + 1, {
        tab_id: `w1:t${Math.floor(i / 3) + 1}`,
      }),
    )
    const plan = planFlatten(panes, "w1")
    expect(plan.moves).toHaveLength(6)
    const movingIds = new Set(plan.moves.map((item) => item.pane_id))
    const flattened = panes.map((item) =>
      movingIds.has(item.pane_id)
        ? { ...item, tab_id: `w1:new-${item.pane_id}` }
        : item,
    )
    expect(planFlatten(flattened, "w1").moves).toEqual([])
    expect(planFlatten([], "w1").moves).toEqual([])
  })
})

describe("Herdr response validation", () => {
  test("reads agent and shell panes from JSON", () => {
    const panes = [pane(1), pane(2, { agent: undefined })]
    expect(parsePaneList(JSON.parse(JSON.stringify({ panes })))).toEqual(panes)
  })

  test("rejects malformed responses before planning", () => {
    for (const value of [null, [], {}, { panes: {} }]) {
      expect(() => parsePaneList(value)).toThrow()
    }
    for (const key of [
      "pane_id",
      "tab_id",
      "workspace_id",
      "terminal_id",
      "focused",
    ]) {
      const invalid: Record<string, unknown> = { ...pane(1) }
      delete invalid[key]
      expect(() => parsePane(invalid)).toThrow()
    }
    expect(() => parsePane({ ...pane(1), agent: 3 })).toThrow()
    expect(() => parsePaneList({ panes: [pane(1), pane(1)] })).toThrow()
  })
})

describe("command interface", () => {
  test("defaults to preview and only accepts explicit run", () => {
    expect(parseArgs([])).toBe("preview")
    expect(parseArgs(["--run"])).toBe("run")
    expect(parseArgs(["--help"])).toBe("help")
    expect(parseArgs(["-h"])).toBe("help")
    for (const args of [["--all"], ["--run", "--oops"], ["run"], ["--apply"]]) {
      expect(() => parseArgs(args)).toThrow("Usage:")
    }
  })

  test("shell quoting preserves quotes and shell syntax literally", async () => {
    const literal = "pane's $(printf injected) `printf injected`; $HOME\nnext"
    const result = await bash(`printf '%s' ${quoteArg(literal)}`)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe(literal)
  })

  test("help works outside Herdr, but session access is refused", async () => {
    const cli = quoteArg(`${import.meta.dir}/flatten.ts`)
    for (const arg of ["", "--run", "--help", "--unknown"]) {
      const result = await bash(`env -u HERDR_ENV bun run ${cli} ${arg} 2>&1`)
      expect(result.exitCode).toBe(arg === "--help" ? 0 : 1)
      if (arg === "" || arg === "--run") {
        expect(result.stdout).toContain("inside a Herdr-managed pane")
      } else {
        expect(result.stdout + result.stderr).toContain("Usage:")
      }
    }
  })
})
