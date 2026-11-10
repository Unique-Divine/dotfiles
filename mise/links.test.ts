import { describe, expect, test } from "bun:test"
import { type Entry, planLinks } from "./links"

const shimDir = "/home/u/.local/share/mise/shims"
const link = (name: string): Entry => ({ kind: "link", target: `${shimDir}/${name}` })

describe("planLinks", () => {
  test("creates links for shims that have none", () => {
    const plan = planLinks(shimDir, ["rg", "gh"], new Map())
    expect(plan).toEqual({ create: ["gh", "rg"], remove: [], conflicts: [] })
  })

  test("leaves correct links alone", () => {
    const existing = new Map([["gh", link("gh")]])
    expect(planLinks(shimDir, ["gh"], existing)).toEqual({
      create: [],
      remove: [],
      conflicts: [],
    })
  })

  test("repoints a link that targets a different shim", () => {
    const existing = new Map([["gh", link("rg")]])
    expect(planLinks(shimDir, ["gh"], existing).create).toEqual(["gh"])
  })

  test("removes links whose shim is gone", () => {
    const existing = new Map([["exa", link("exa")]])
    expect(planLinks(shimDir, ["eza"], existing)).toEqual({
      create: ["eza"],
      remove: ["exa"],
      conflicts: [],
    })
  })

  test("never touches real files or links that point elsewhere", () => {
    const existing = new Map<string, Entry>([
      ["just", { kind: "file" }],
      ["nvim", { kind: "link", target: "/opt/nvim/bin/nvim" }],
    ])
    expect(planLinks(shimDir, ["just", "nvim"], existing)).toEqual({
      create: [],
      remove: [],
      conflicts: ["just", "nvim"],
    })
  })
})
