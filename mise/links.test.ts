import {
  lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"
import { type Entry, planLinks, reconcileLinks } from "./links"

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


async function withFixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "mise-active-links-"))
  try { await run(root) } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe("active command filesystem reconciliation", () => {
  test("preserves inactive installations and prunes only managed links", async () => {
    await withFixture(async (root) => {
      const shims = join(root, "shims")
      const bin = join(root, "bin")
      await mkdir(shims)
      await mkdir(bin)
      for (const name of ["gh", "protoc-gen-buf-lint", "node", "uv", "uvx", "npm"]) {
        await writeFile(join(shims, name), "shim")
      }
      await symlink("/my/dotfiles/bin/node", join(bin, "node"))
      await writeFile(join(bin, "uv"), "existing uv")
      await writeFile(join(bin, "uvx"), "existing uvx")
      await symlink(join(shims, "npm"), join(bin, "npm"))
      const active = ["gh", "protoc-gen-buf-lint"]
      expect(await reconcileLinks("--run", shims, bin, active)).toBe(0)
      expect(await readlink(join(bin, "node"))).toBe("/my/dotfiles/bin/node")
      expect(await readFile(join(bin, "uv"), "utf8")).toBe("existing uv")
      expect(await readFile(join(bin, "uvx"), "utf8")).toBe("existing uvx")
      await expect(lstat(join(bin, "npm"))).rejects.toMatchObject({ code: "ENOENT" })
      expect(await readlink(join(bin, active[1]))).toBe(join(shims, active[1]))
      const before = await lstat(join(bin, "gh"))
      expect(await reconcileLinks("--run", shims, bin, active)).toBe(0)
      expect((await lstat(join(bin, "gh"))).ino).toBe(before.ino)
      expect(await reconcileLinks("--check", shims, bin, active)).toBe(0)
    })
  })

  test("active conflicts remain errors and preserve originals", async () => {
    await withFixture(async (root) => {
      const shims = join(root, "shims")
      const bin = join(root, "bin")
      await mkdir(shims)
      await mkdir(bin)
      await writeFile(join(shims, "gh"), "shim")
      await writeFile(join(bin, "gh"), "my gh")
      expect(await reconcileLinks("--run", shims, bin, ["gh"])).toBe(1)
      expect(await readFile(join(bin, "gh"), "utf8")).toBe("my gh")
    })
  })

  test("missing active shims fail before pruning existing links", async () => {
    await withFixture(async (root) => {
      const bin = join(root, "bin")
      await mkdir(bin)
      await symlink(join(root, "shims", "npm"), join(bin, "npm"))
      await expect(reconcileLinks("--run", join(root, "shims"), bin, ["gh"]))
        .rejects.toMatchObject({ code: "ENOENT" })
      expect(await readlink(join(bin, "npm"))).toBe(join(root, "shims", "npm"))
    })
  })

  test("CLI discovery failure leaves existing links untouched", async () => {
    await withFixture(async (home) => {
      const bin = join(home, ".local", "bin")
      await mkdir(bin, { recursive: true })
      const target = join(home, ".local", "share", "mise", "shims", "npm")
      await symlink(target, join(bin, "npm"))
      const proc = Bun.spawnSync([
        process.execPath, join(import.meta.dir, "links.ts"), "--run",
      ], { env: { ...process.env, HOME: home } })
      expect(proc.exitCode).toBe(1)
      expect(proc.stderr.toString()).toContain("mise:")
      expect(await readlink(join(bin, "npm"))).toBe(target)
    })
  })
})
