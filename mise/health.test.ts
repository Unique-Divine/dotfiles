import { describe, expect, test } from "bun:test"
import { shadowProblems, toolProblems, type MiseLs } from "./health"

describe("toolProblems", () => {
  test("accepts installed tools at their pinned versions", () => {
    const ls: MiseLs = {
      gh: [{ version: "2.103.3", requested_version: "2.103.3", installed: true }],
      ripgrep: [{ version: "15.2.0", requested_version: "15.2.0", installed: true }],
    }
    expect(toolProblems(ls)).toEqual([])
  })

  test("reports missing tools, version drift, and empty entries", () => {
    const ls: MiseLs = {
      gh: [{ version: "2.103.3", requested_version: "2.103.3", installed: false }],
      just: [{ version: "1.50.0", requested_version: "1.59.0", installed: true }],
      jq: [],
    }
    expect(toolProblems(ls)).toEqual([
      "gh@2.103.3: not installed",
      "just: installed 1.50.0, pinned 1.59.0",
      "jq: no version configured",
    ])
  })
})

describe("shadowProblems", () => {
  const shimDir = "/home/u/.local/share/mise/shims"
  const installsDir = "/home/u/.local/share/mise/installs"

  test("accepts commands that resolve to their shims", () => {
    const resolve = (command: string) => `${shimDir}/${command}`
    expect(shadowProblems(shimDir, installsDir, ["rg", "gh"], resolve)).toEqual([])
  })

  test("reports commands shadowed by another copy or missing from PATH", () => {
    const paths: Record<string, string | null> = {
      gh: `${shimDir}/gh`,
      just: "/home/u/.cargo/bin/just",
      rg: null,
    }
    const resolve = (command: string) => paths[command] ?? null
    expect(shadowProblems(shimDir, installsDir, ["rg", "just", "gh"], resolve)).toEqual([
      `just: resolves to /home/u/.cargo/bin/just, not the mise shim ${shimDir}/just`,
      `rg: resolves to nothing, not the mise shim ${shimDir}/rg`,
    ])
  })

  test("accepts install paths a mise-started process sees", () => {
    const resolve = (command: string) =>
      `${installsDir}/ripgrep/15.2.0/ripgrep-15.2.0-aarch64-unknown-linux-gnu/${command}`
    expect(shadowProblems(shimDir, installsDir, ["rg"], resolve)).toEqual([])
  })
})
