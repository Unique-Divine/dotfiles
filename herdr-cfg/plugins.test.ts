import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  findMissingExecutables, formatProblems, parsePluginList, repairHint,
  resolveProgram, type HerdrPlugin,
} from "./plugins"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })))
})

async function pluginRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "herdr plugin ' "))
  roots.push(root)
  return root
}

async function executable(path: string, mode = 0o755): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true })
  await writeFile(path, "#!/bin/sh\n")
  await chmod(path, mode)
}

function plugin(root: string, overrides: Partial<HerdrPlugin> = {}):
  HerdrPlugin {
  return {
    plugin_id: "unique-divine.herdr-tmux",
    enabled: true,
    plugin_root: root,
    source: { kind: "local" },
    build: [{ command: ["cargo", "build", "--release", "--target-dir",
      "target"] }],
    actions: [
      { id: "even-vertical",
        command: ["./target/release/herdr-tmux", "layout", "even-vertical"] },
      { id: "focus-pane",
        command: ["./target/release/herdr-tmux", "plugin", "open", "pane"] },
    ],
    panes: [
      { id: "pane-picker",
        command: ["./target/release/herdr-tmux", "focus-pane"] },
    ],
    ...overrides,
  }
}

describe("parsePluginList", () => {
  test("reads plugins from the CLI envelope", () => {
    const text = JSON.stringify({ id: "cli:plugin", result: {
      type: "plugin_list", plugins: [plugin("/p")] } })
    expect(parsePluginList(text).map((p) => p.plugin_id))
      .toEqual(["unique-divine.herdr-tmux"])
  })

  test("rejects output without a plugins array", () => {
    expect(() => parsePluginList(JSON.stringify({ result: {} })))
      .toThrow("no plugins array")
  })
})

describe("resolveProgram", () => {
  test("joins relative paths with separators to the plugin root", () => {
    expect(resolveProgram("./bin/tool", "/root", {}))
      .toBe(join("/root", "bin/tool"))
    expect(resolveProgram("bin/tool", "/root", {}))
      .toBe(join("/root", "bin/tool"))
  })

  test("keeps absolute paths and looks bare names up on PATH", async () => {
    const root = await pluginRoot()
    await executable(join(root, "bin", "tool"))
    expect(resolveProgram("/usr/bin/x", root, {})).toBe("/usr/bin/x")
    expect(resolveProgram("tool", "/elsewhere", { PATH: join(root, "bin") }))
      .toBe(join(root, "bin", "tool"))
    expect(resolveProgram("tool", root, { PATH: "" })).toBeUndefined()
  })
})

describe("findMissingExecutables", () => {
  test("reports every action and pane when the build output is gone",
    async () => {
      const root = await pluginRoot()
      const missing = await findMissingExecutables([plugin(root)], {})
      expect(missing.map((item) => `${item.kind}:${item.entryId}`)).toEqual([
        "action:even-vertical", "action:focus-pane", "pane:pane-picker",
      ])
      expect(missing[0]!.executable)
        .toBe(join(root, "target/release/herdr-tmux"))
    })

  test("passes once the built executable exists", async () => {
    const root = await pluginRoot()
    await executable(join(root, "target", "release", "herdr-tmux"))
    expect(await findMissingExecutables([plugin(root)], {})).toEqual([])
  })

  test("reports a file without execute permission", async () => {
    const root = await pluginRoot()
    await executable(join(root, "target", "release", "herdr-tmux"), 0o644)
    expect(await findMissingExecutables([plugin(root)], {})).toHaveLength(3)
  })

  test("reports a directory at the executable path", async () => {
    const root = await pluginRoot()
    await mkdir(join(root, "target", "release", "herdr-tmux"),
      { recursive: true })
    expect(await findMissingExecutables([plugin(root)], {})).toHaveLength(3)
  })

  test("skips disabled plugins", async () => {
    const root = await pluginRoot()
    expect(await findMissingExecutables(
      [plugin(root, { enabled: false })], {})).toEqual([])
  })

  test("reports bare commands that PATH cannot resolve", async () => {
    const root = await pluginRoot()
    const missing = await findMissingExecutables([plugin(root, {
      actions: [{ id: "run", command: ["no-such-tool"] }], panes: [],
    })], { PATH: "" })
    expect(missing.map((item) => item.executable)).toEqual(["no-such-tool"])
  })
})

describe("repairHint and formatProblems", () => {
  test("local plugins repair with their manifest build commands", () => {
    expect(repairHint(plugin("/dot files/herdr-tmux"))).toBe(
      "cd '/dot files/herdr-tmux' && " +
      "cargo build --release --target-dir target")
  })

  test("installed plugins repair by reinstalling", () => {
    expect(repairHint(plugin("/p", { source: { kind: "github" } })))
      .toContain("herdr plugin uninstall unique-divine.herdr-tmux")
  })

  test("groups one problem line per plugin", async () => {
    const root = await pluginRoot()
    const problems = formatProblems(
      await findMissingExecutables([plugin(root)], {}))
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain(
      "cannot launch action even-vertical, action focus-pane, " +
      "pane pane-picker")
    expect(problems[0]).toContain(
      `missing executable ${join(root, "target/release/herdr-tmux")} `)
    expect(problems[0]).toContain("(repair: cd ")
  })
})
