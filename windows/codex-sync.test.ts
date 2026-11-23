import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parse } from "smol-toml"
import { planMcp, syncCodex, syncSkills, type Bridge } from "./codex-sync"

test("copies named skills and keeps Windows ownership and edits", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-sync-"))
  try {
    const source = join(root, "source")
    const origin = join(root, "external-skill")
    const native = join(root, "Windows", ".agents", "skills")
    const legacy = join(root, "Windows", ".codex", "skills")
    await Promise.all([source, origin, native, legacy].map((path) => mkdir(path, { recursive: true })))
    await symlink(origin, join(source, "linked-skill"), "dir")
    await symlink(origin, join(source, "collision"), "dir")
    await mkdir(join(legacy, "Collision"))
    await writeFile(join(origin, "SKILL.md"), "v1")
    await writeFile(join(origin, "auth.json"), "credential")
    await mkdir(join(origin, "references"))
    await writeFile(join(origin, "references", "guide.md"), "reference")
    const managed = join(native, "wsl-synced", "linked-skill")
    expect((await syncSkills(source, [native, legacy], false)).join("\n")).toContain("1 additions")
    expect(await Bun.file(join(managed, "SKILL.md")).exists()).toBe(false)
    await syncSkills(source, [native, legacy], true)
    expect(await readFile(join(managed, "references", "guide.md"), "utf8")).toBe("reference")
    expect(await Bun.file(join(managed, "auth.json")).exists()).toBe(false)
    expect((await syncSkills(source, [native, legacy], true)).join("\n")).toContain("1 current")
    await writeFile(join(origin, "SKILL.md"), "v2")
    await syncSkills(source, [native, legacy], true)
    expect(await readFile(join(managed, "SKILL.md"), "utf8")).toBe("v2")
    await writeFile(join(managed, "SKILL.md"), "Windows edit")
    await writeFile(join(origin, "SKILL.md"), "v3")
    expect((await syncSkills(source, [native, legacy], true)).join("\n")).toContain("kept changed")
    expect(await readFile(join(managed, "SKILL.md"), "utf8")).toBe("Windows edit")
    await symlink(join(root, "missing"), join(origin, "escape"))
    expect((await syncSkills(source, [native, legacy], true)).join("\n")).toContain("skipped")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("recovers interrupted replacement on either side of the skill rename", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-sync-interrupted-"))
  try {
    const name = "portable-skill"
    const source = join(root, "source")
    const native = join(root, "Windows", ".agents", "skills")
    const managed = join(native, "wsl-synced")
    const target = join(managed, name)
    const manifestPath = join(managed, ".dotfiles-skill-hashes.json")
    const id = crypto.randomUUID()
    const recordPath = join(root, "Windows", ".agents", ".dotfiles-wsl-skill-update.json")
    const work = join(root, "Windows", ".agents", `.dotfiles-wsl-skill-update-${id}`)
    const staging = join(work, "staging")
    const backup = join(work, "backup")
    const sourceFile = join(source, name, "SKILL.md")
    const targetFile = join(target, "SKILL.md")
    const old = "old Windows skill"
    const updated = "updated Windows skill"
    await mkdir(join(source, name), { recursive: true })
    await writeFile(sourceFile, old)
    await syncSkills(source, [native], true)
    const previous = JSON.parse(await readFile(manifestPath, "utf8"))[name] as string
    const next = createHash("sha256").update(JSON.stringify(["SKILL.md", Buffer.byteLength(updated)]))
      .update(updated).digest("hex")

    async function prepareInterruptedUpdate() {
      await mkdir(staging, { recursive: true })
      await writeFile(join(staging, "SKILL.md"), updated)
      await writeFile(recordPath, JSON.stringify({ id, name, previous, registered: previous, next }))
      await rename(target, backup)
    }

    await prepareInterruptedUpdate()
    await expect(syncSkills(source, [native], false)).rejects.toThrow("Interrupted Windows skill update")
    expect(await Bun.file(targetFile).exists()).toBe(false)
    await syncSkills(source, [native], true)
    expect(await readFile(targetFile, "utf8")).toBe(old)
    expect(await Bun.file(recordPath).exists()).toBe(false)

    await prepareInterruptedUpdate()
    await writeFile(sourceFile, updated)
    await rename(staging, target)
    await writeFile(targetFile, "Windows edit")
    await expect(syncSkills(source, [native], true)).rejects.toThrow("changed")
    expect(await readFile(targetFile, "utf8")).toBe("Windows edit")
    expect(await readFile(join(backup, "SKILL.md"), "utf8")).toBe(old)
    expect(JSON.parse(await readFile(manifestPath, "utf8"))[name]).toBe(previous)

    await writeFile(targetFile, updated)
    await syncSkills(source, [native], true)
    expect(await readFile(targetFile, "utf8")).toBe(updated)
    expect(JSON.parse(await readFile(manifestPath, "utf8"))[name]).toBe(next)
    expect(await Bun.file(recordPath).exists()).toBe(false)
    expect(await Bun.file(join(backup, "SKILL.md")).exists()).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

const sourceConfig = `
[mcp_servers.openaiDeveloperDocs]
url = "https://developers.openai.com/mcp"

[mcp_servers.superhuman-mail]
url = "https://mcp.mail.superhuman.com/mcp"
bearer_token_env_var = "SECRET"

[mcp_servers.local]
command = "local-command"
env = { TOKEN = "linux-only-secret" }
`
const windowsConfig = `# Windows config
[mcp_servers.native]
command = "a-windows-command"
env = { TOKEN = "native-secret" }
`

test("only adds reviewed direct HTTP entries and preserves the original Windows TOML", () => {
  const { next } = planMcp(sourceConfig, windowsConfig, new Set())
  expect(next.startsWith(windowsConfig)).toBe(true)
  expect(Object.keys(parse(next).mcp_servers as object)).toEqual(["native", "openaiDeveloperDocs"])
  expect(next).not.toContain("SECRET")
  expect(next).not.toContain("linux-only-secret")
  expect(planMcp(sourceConfig, next, new Set()).next).toBe(next)
})

test("keeps syncing skills when existing inline MCP definitions prevent an append", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-sync-inline-"))
  try {
    const paths = {
      sourceSkills: join(root, "source"),
      skillRoots: [join(root, "native-skills")],
      sourceConfig: join(root, "source.toml"),
      windowsConfig: join(root, "windows.toml"),
    }
    const skill = join(paths.sourceSkills, "portable-skill")
    await mkdir(skill, { recursive: true })
    await writeFile(join(skill, "SKILL.md"), "portable skill")
    const original = '# Keep Windows settings\nmcp_servers = { native = { command = "native-tool" } }\n'
    await writeFile(paths.sourceConfig, sourceConfig)
    await writeFile(paths.windowsConfig, original)

    await expect(syncCodex(paths, true, new Set())).rejects.toThrow("Cannot append MCP entries")
    expect(await readFile(paths.windowsConfig, "utf8")).toBe(original)
    expect(await readFile(join(paths.skillRoots[0], "wsl-synced", "portable-skill", "SKILL.md"), "utf8"))
      .toBe("portable skill")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a named opt-in bridge references the Linux config without storing its values", () => {
  const bridge: Bridge = {
    distro: "Ubuntu-24.04", user: "realu", bun: "/home/realu/.bun/bin/bun",
    launcher: "/home/realu/dotfiles/claude/mcp-launch.ts",
    config: "/home/realu/.codex/config.toml", path: "/usr/bin",
  }
  const { next } = planMcp(sourceConfig, windowsConfig, new Set(["local"]), bridge)
  expect(next).toContain('command = "wsl.exe"')
  expect(next).toContain(bridge.config)
  expect(next).not.toContain("linux-only-secret")
})
