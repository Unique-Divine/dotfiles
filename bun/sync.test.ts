import { afterEach, describe, expect, test } from "bun:test"
import { bash } from "@uniquedivine/bash"
import {
  chmod, lstat, mkdir, mkdtemp, readFile, readlink, readdir, realpath,
  rm, symlink, writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  check, configuration, discordBin, discordComponentDir, discordProblems,
  inspectPackages, lockReferenceProblems, pathShadowProblem, installRoot, lockProblems, refreshLock,
  runCheckoutProblem, synchronize, type Config,
} from "./sync"

const temporary: string[] = []
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })))
})

async function fixture(): Promise<Config> {
  const root = await mkdtemp(join(tmpdir(), "dotfiles-bun-"))
  temporary.push(root)
  const managed = join(root, "repo", "bun")
  const home = join(root, "home")
  await mkdir(join(managed, "global"), { recursive: true })
  const binDir = join(home, ".bun", "bin")
  await mkdir(binDir, { recursive: true })
  const config = await configuration(managed, {
    ...process.env, HOME: home, BUN_INSTALL: join(home, ".bun"),
    BUN_INSTALL_GLOBAL_DIR: join(home, "runtime-global"),
    BUN_INSTALL_BIN: binDir,
    XDG_DATA_HOME: join(home, "xdg"),
    PATH: `${binDir}:${process.env.PATH}`,
    REPO: join(root, "workspace"),
  })
  await jiyuuDiscord(config)
  const helper = join(managed, "sources", "fixture-helper")
  await mkdir(helper, { recursive: true })
  await writeFile(join(helper, "package.json"), JSON.stringify({
    name: "fixture-helper", version: "1.0.0", type: "module",
    main: "index.js",
  }))
  await writeFile(join(helper, "index.js"), 'export const bullet = "-"\n')
  const cli = join(managed, "sources", "fixture-mdtoc")
  await mkdir(cli, { recursive: true })
  await writeFile(join(cli, "package.json"), JSON.stringify({
    name: "@uniquedivine/ud-mdtoc", version: "0.1.0", type: "module",
    bin: { "ud-mdtoc": "cli.js" },
    dependencies: { "fixture-helper": "1.0.0" },
  }))
  await writeFile(join(cli, "cli.js"), `#!/usr/bin/env bun
import { bullet } from "fixture-helper"
if (process.argv.includes("--plugin-info")) {
  console.log(JSON.stringify({apiVersion:1,name:"mdtoc",description:"Fixture"}))
} else {
  const lines = (await Bun.stdin.text()).trim().split("\\n").slice(1)
  console.log(lines.map(line => {
    const [, hashes, text] = /^(#+) (.*)$/.exec(line)
    return "  ".repeat(hashes.length - 2) + bullet + " [" + text + "](#" +
      text.toLowerCase() + ")"
  }).join("\\n"))
}
`)
  await chmod(join(cli, "cli.js"), 0o755)
  const packed = await bash(`cd '${cli}' && '${process.execPath}' pm pack ` +
    `--ignore-scripts --filename '${join(managed, "sources", "mdtoc.tgz")}'`)
  if (packed.exitCode) throw new Error(packed.stderr)
  await writeFile(join(config.globalDir, "package.json"),
    JSON.stringify({ name: "fixture-global", private: true,
      overrides: { "fixture-helper": "file:../sources/fixture-helper" },
      dependencies: {
      "@uniquedivine/ud-mdtoc": "file:../sources/mdtoc.tgz",
      "fixture-helper": "file:../sources/fixture-helper",
    } }, null, 2) + "\n")
  await refreshLock(config)
  return config
}

/** Jiyuu's marker: mcp/upstreams.json listing the mcp/discord component. */
async function jiyuuMarker(jiyuuRoot: string): Promise<void> {
  await mkdir(join(jiyuuRoot, "mcp"), { recursive: true })
  await writeFile(join(jiyuuRoot, "mcp", "upstreams.json"), JSON.stringify({
    targetRepository: "Unique-Divine/jiyuu",
    components: [{ path: "mcp/discord" }],
  }))
}

/** Write a Discord stand-in's manifest and lock it with Bun. */
async function lockDiscord(
  dir: string, dependencies: Record<string, string>,
): Promise<void> {
  await writeFile(join(dir, "package.json"), JSON.stringify({
    name: "mcp-discord", private: true, bin: { "mcp-discord": "src/index.ts" },
    dependencies,
  }))
  if (!Object.keys(dependencies).length) {
    // Bun deletes a lockfile without packages, so write the empty one.
    await writeFile(join(dir, "bun.lock"), JSON.stringify({ lockfileVersion: 1,
      workspaces: { "": { name: "mcp-discord" } }, packages: {} }))
    return
  }
  const locked = await bash(`cd '${dir}' && '${process.execPath}' install ` +
    "--lockfile-only --ignore-scripts")
  if (locked.exitCode) throw new Error(locked.stderr)
}

/** A Jiyuu mcp/discord stand-in: an executable entry and no dependencies. */
async function jiyuuDiscord(config: Config): Promise<string> {
  const dir = config.discordDir!
  await mkdir(join(dir, "src"), { recursive: true })
  await jiyuuMarker(join(dir, "..", ".."))
  await lockDiscord(dir, {})
  const entry = join(dir, "src", "index.ts")
  await writeFile(entry, '#!/usr/bin/env bun\nconsole.log("fixture discord")\n')
  await chmod(entry, 0o755)
  return entry
}

async function snapshot(root: string): Promise<Record<string, string>> {
  const data: Record<string, string> = {}
  async function visit(path: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name)
      const info = await lstat(child)
      data[child] = String(info.mtimeMs) + ":" + String(info.size)
      if (entry.isDirectory()) await visit(child)
      else if (entry.isSymbolicLink()) data[child] += await readlink(child)
      else data[child] += await readFile(child, "utf8")
    }
  }
  await visit(root)
  return data
}

describe("managed Bun installation", () => {
  test("restores a fresh global installation and ud plugin", async () => {
    const config = await fixture()
    expect((await check(config)).length).toBeGreaterThan(0)
    await synchronize(config)
    expect(await realpath(config.runtimeDir)).toBe(config.globalDir)
    expect(await realpath(join(config.binDir, "ud-mdtoc")))
      .toBe(await realpath(join(config.globalDir, "node_modules",
        "@uniquedivine", "ud-mdtoc", "cli.js")))
    expect(await realpath(join(config.pluginDir, "ud-mdtoc")))
      .toBe(await realpath(join(config.binDir, "ud-mdtoc")))
    expect(await check(config)).toEqual([])
  })

  test("health is read-only and healthy sync does not reinstall", async () => {
    const config = await fixture()
    await synchronize(config)
    const before = await snapshot(config.root)
    expect(await check(config)).toEqual([])
    expect(await snapshot(config.root)).toEqual(before)
    const installedBefore = await lstat(join(config.globalDir,
      "node_modules", "fixture-helper", "index.js"))
    await synchronize(config)
    expect((await lstat(join(config.globalDir, "node_modules",
      "fixture-helper", "index.js"))).mtimeMs).toBe(installedBefore.mtimeMs)
  })

  test("repairs a deleted dependency subtree", async () => {
    const config = await fixture()
    await synchronize(config)
    await rm(join(config.globalDir, "node_modules", "fixture-helper"),
      { recursive: true })
    expect((await check(config)).join("\n")).toContain("fixture-helper")
    await synchronize(config)
    expect(await check(config)).toEqual([])
  })

  test("repairs deleted dependency code while package.json survives", async () => {
    const config = await fixture()
    await synchronize(config)
    await rm(join(config.globalDir, "node_modules", "fixture-helper",
      "index.js"))
    expect((await check(config)).join("\n"))
      .toContain("ud-mdtoc behavior check failed")
    await synchronize(config)
    expect(await check(config)).toEqual([])
  })

  test("repairs missing executable and plugin links", async () => {
    const config = await fixture()
    await synchronize(config)
    await rm(join(config.binDir, "ud-mdtoc"))
    await rm(join(config.pluginDir, "ud-mdtoc"))
    expect((await check(config)).join("\n")).toContain("Executable link")
    await synchronize(config)
    expect(await check(config)).toEqual([])
  })

  test("rejects a stale lock before changing the runtime installation", async () => {
    const config = await fixture()
    const path = join(config.globalDir, "package.json")
    const desired = JSON.parse(await readFile(path, "utf8"))
    delete desired.dependencies["fixture-helper"]
    await writeFile(path, JSON.stringify(desired))
    expect((await lockProblems(config)).join("\n")).toContain("just bun-lock")
    await expect(synchronize(config)).rejects.toThrow("just bun-lock")
    expect(await lstat(config.runtimeDir).catch(() => undefined)).toBeUndefined()
  })

  test("backs up an existing global directory and preserves unrelated bins", async () => {
    const config = await fixture()
    await mkdir(config.runtimeDir, { recursive: true })
    await writeFile(join(config.runtimeDir, "old.txt"), "old installation")
    const other = join(config.root, "local-command")
    await writeFile(other, "#!/bin/sh\nexit 0\n")
    await chmod(other, 0o755)
    await symlink(other, join(config.binDir, "unmanaged-tool"))
    const oldPackage = join(config.runtimeDir, "node_modules", "unmanaged")
    await mkdir(oldPackage, { recursive: true })
    await writeFile(join(oldPackage, "cli"), "#!/bin/sh\nprintf retained\n")
    await chmod(join(oldPackage, "cli"), 0o755)
    await symlink(join(oldPackage, "cli"), join(config.binDir, "old-package"))
    await synchronize(config)
    const backups = (await readdir(join(config.runtimeDir, "..")))
      .filter((name) => name.startsWith("runtime-global.before-dotfiles-"))
    expect(backups.length).toBe(1)
    expect(await readFile(join(config.runtimeDir, "..", backups[0]!,
      "old.txt"), "utf8")).toBe("old installation")
    expect(await realpath(join(config.binDir, "unmanaged-tool"))).toBe(other)
    const retained = await bash(`'${join(config.binDir, "old-package")}'`)
    expect(retained.exitCode).toBe(0)
    expect(retained.stdout).toBe("retained")
  })

  test("rejects foreign bin symlinks without switching the global dir", async () => {
    const config = await fixture()
    const foreign = join(config.root, "foreign")
    await writeFile(foreign, "#!/bin/sh\nexit 0\n")
    await chmod(foreign, 0o755)
    await symlink(foreign, join(config.binDir, "ud-mdtoc"))
    await expect(synchronize(config)).rejects.toThrow("unrelated executable")
    expect(await realpath(join(config.binDir, "ud-mdtoc"))).toBe(foreign)
    expect(await lstat(config.runtimeDir).catch(() => undefined)).toBeUndefined()
  })

  test("accepts owned bin links that reach the install through a symlinked path", async () => {
    // A checkout moved behind a symlink (~/ki/boku -> ~/boku) leaves links
    // whose text names the old path but whose files are the same.
    const config = await fixture()
    await synchronize(config)
    const bin = join(config.binDir, "ud-mdtoc")
    const realTarget = await realpath(bin)
    const alias = join(config.root, "..", "alias-root")
    await symlink(join(config.root, ".."), alias)
    const viaAlias = realTarget.replace(join(config.root, ".."), alias)
    expect(viaAlias).not.toBe(realTarget)
    await rm(bin)
    await symlink(viaAlias, bin)
    await synchronize(config)
    expect(await realpath(bin)).toBe(realTarget)
  })

  test("rejects foreign plugin links before changing runtime paths", async () => {
    const config = await fixture()
    const foreign = join(config.root, "foreign-plugin")
    await writeFile(foreign, "#!/bin/sh\nexit 0\n")
    await mkdir(config.pluginDir, { recursive: true })
    await symlink(foreign, join(config.pluginDir, "ud-mdtoc"))
    await expect(synchronize(config)).rejects.toThrow("unrelated plugin")
    expect(await realpath(join(config.pluginDir, "ud-mdtoc"))).toBe(foreign)
    expect(await lstat(config.runtimeDir).catch(() => undefined)).toBeUndefined()
  })

  test("restores the old directory and bins after a late link failure", async () => {
    const config = await fixture()
    const old = join(config.runtimeDir, "node_modules", "old-mdtoc", "cli")
    await mkdir(join(old, ".."), { recursive: true })
    await writeFile(old, "#!/bin/sh\nprintf old\n")
    await chmod(old, 0o755)
    await symlink(old, join(config.binDir, "ud-mdtoc"))
    await mkdir(join(config.pluginDir, ".."), { recursive: true })
    await writeFile(config.pluginDir, "blocks plugin directory creation")
    await expect(synchronize(config)).rejects.toThrow()
    expect((await lstat(config.runtimeDir)).isDirectory()).toBe(true)
    expect(await readlink(join(config.binDir, "ud-mdtoc"))).toBe(old)
    expect((await bash(`'${join(config.binDir, "ud-mdtoc")}'`)).stdout).toBe("old")
  })

  test("reports PATH shadowing without executing the shadow command", async () => {
    const config = await fixture()
    await synchronize(config)
    const shadow = join(config.root, "shadow")
    await mkdir(shadow)
    await writeFile(join(shadow, "ud-mdtoc"), "#!/bin/sh\nexit 90\n")
    await chmod(join(shadow, "ud-mdtoc"), 0o755)
    config.env.PATH = `${shadow}:${config.env.PATH}`
    expect((await check(config)).join("\n"))
      .toContain(`PATH resolves ud-mdtoc to ${join(shadow, "ud-mdtoc")}`)
  })

  test("reports a wrong link once, without a PATH message", async () => {
    const config = await fixture()
    await synchronize(config)
    const bin = join(config.binDir, discordBin)
    const elsewhere = join(config.root, "elsewhere")
    await writeFile(elsewhere, "#!/bin/sh\n")
    await chmod(elsewhere, 0o755)
    await rm(bin)
    await symlink(elsewhere, bin)
    const problems = (await check(config)).join("\n")
    expect(problems).toContain("does not reach Jiyuu")
    expect(problems).not.toContain("PATH resolves")
    expect(await pathShadowProblem(discordBin, config.binDir, config.env))
      .toBeUndefined()
  })

  test("reports a managed bin directory missing from PATH", async () => {
    const config = await fixture()
    await synchronize(config)
    expect(await pathShadowProblem("ud-mdtoc", config.binDir,
      { PATH: "/usr/bin:/bin" }))
      .toContain("PATH resolves ud-mdtoc to nothing")
    expect(await pathShadowProblem("not-managed", config.binDir, config.env))
      .toBeUndefined()
  })

  test("removes only previously owned bins when a package is removed", async () => {
    const config = await fixture()
    await synchronize(config)
    const path = join(config.globalDir, "package.json")
    const desired = JSON.parse(await readFile(path, "utf8"))
    delete desired.dependencies["@uniquedivine/ud-mdtoc"]
    await writeFile(path, JSON.stringify(desired))
    await refreshLock(config)
    await synchronize(config)
    expect(await lstat(join(config.binDir, "ud-mdtoc"))
      .catch(() => undefined)).toBeUndefined()
    expect(await lstat(join(config.pluginDir, "ud-mdtoc"))
      .catch(() => undefined)).toBeUndefined()
    expect(await check(config)).toEqual([])
  })

  test("preserves user replacements when an owned package is removed", async () => {
    const config = await fixture()
    await synchronize(config)
    const bin = join(config.binDir, "ud-mdtoc")
    await rm(bin)
    await writeFile(bin, "user-managed replacement")
    const path = join(config.globalDir, "package.json")
    const desired = JSON.parse(await readFile(path, "utf8"))
    delete desired.dependencies["@uniquedivine/ud-mdtoc"]
    await writeFile(path, JSON.stringify(desired))
    await refreshLock(config)
    await synchronize(config)
    expect(await readFile(bin, "utf8")).toBe("user-managed replacement")
  })

  test("reports an installed root version differing from the manifest", async () => {
    const config = await fixture()
    await synchronize(config)
    const path = join(config.globalDir, "package.json")
    const desired = JSON.parse(await readFile(path, "utf8"))
    desired.dependencies["fixture-helper"] = "2.0.0"
    await writeFile(path, JSON.stringify(desired))
    expect((await inspectPackages(config)).problems.join("\n"))
      .toContain("installed 1.0.0, expected 2.0.0")
  })

  test("honors global paths in Bun config and explicit environment overrides", async () => {
    const config = await fixture()
    const home = config.env.HOME!
    await writeFile(join(home, ".bunfig.toml"),
      '[install]\nglobalDir="~/custom-global"\nglobalBinDir="~/custom-bin"\n')
    const configured = await configuration(config.root, {
      HOME: home,
    })
    expect(configured.runtimeDir).toBe(join(home, "custom-global"))
    expect(configured.binDir).toBe(join(home, "custom-bin"))
    const overridden = await configuration(config.root, config.env)
    expect(overridden.runtimeDir).toBe(config.runtimeDir)
    expect(overridden.binDir).toBe(config.binDir)
    const xdg = join(home, "config")
    await mkdir(xdg)
    await writeFile(join(xdg, ".bunfig.toml"),
      '[install]\nglobalDir="relative-global"\nglobalBinDir="relative-bin"\n')
    const xdgConfig = await configuration(config.root, {
      HOME: home, XDG_CONFIG_HOME: xdg,
    })
    expect(xdgConfig.runtimeDir).toBe(join(xdg, "relative-global"))
    expect(xdgConfig.binDir).toBe(join(xdg, "relative-bin"))
  })
})

describe("Jiyuu Discord MCP link", () => {
  test("locates Jiyuu under REPO the way just sync does", () => {
    expect(discordComponentDir({ REPO: "/work" }))
      .toBe("/work/boku/jiyuu/mcp/discord")
    expect(discordComponentDir({})).toBeUndefined()
  })

  test("sync links mcp-discord to the Jiyuu entrypoint", async () => {
    const config = await fixture()
    const entry = join(config.discordDir!, "src", "index.ts")
    expect((await discordProblems(config)).join("\n"))
      .toContain("Executable link is missing or does not reach Jiyuu")
    await synchronize(config)
    expect(await readlink(join(config.binDir, discordBin))).toBe(entry)
    expect(await discordProblems(config)).toEqual([])
    expect(await check(config)).toEqual([])
    expect((await bash(`'${join(config.binDir, discordBin)}'`)).stdout.trim())
      .toBe("fixture discord")
  })

  test("reports a missing, non-executable or unlocatable entrypoint", async () => {
    const config = await fixture()
    const entry = join(config.discordDir!, "src", "index.ts")
    await chmod(entry, 0o644)
    expect(await discordProblems(config)).toEqual([
      `Jiyuu Discord MCP entrypoint is not executable: ${entry}; ` +
      "update Jiyuu with just i-jiyuu"])
    await expect(synchronize(config)).rejects.toThrow("not executable")
    expect(await lstat(join(config.binDir, discordBin)).catch(() => undefined))
      .toBeUndefined()
    await rm(entry)
    expect((await discordProblems(config)).join("\n"))
      .toContain("entrypoint is missing")
    expect(await discordProblems({ ...config, discordDir: undefined }))
      .toEqual(["REPO is unset, so Jiyuu's mcp/discord cannot be found"])
  })

  test("installs missing Jiyuu dependencies from its lock", async () => {
    const config = await fixture()
    const dir = config.discordDir!
    await lockDiscord(dir, { "fixture-helper": `file:${
      join(config.root, "sources", "fixture-helper")}` })
    expect((await discordProblems(config)).join("\n"))
      .toContain("Jiyuu mcp/discord dependencies: fixture-helper")
    await synchronize(config)
    expect(await discordProblems(config)).toEqual([])
    await rm(join(dir, "node_modules"), { recursive: true })
    expect((await check(config)).join("\n")).toContain("fixture-helper")
  })

  test("replaces the retired package link and a Jiyuu link at another path", async () => {
    const config = await fixture()
    await synchronize(config)
    const bin = join(config.binDir, discordBin)
    const entry = join(config.discordDir!, "src", "index.ts")
    await rm(bin)
    await symlink(join(config.runtimeDir, "node_modules", discordBin, "build",
      "index.js"), bin)
    expect((await discordProblems(config)).join("\n"))
      .toContain("does not reach Jiyuu")
    await synchronize(config)
    expect(await readlink(bin)).toBe(entry)
    const other = join(config.root, "old-boku", "jiyuu", "mcp", "discord",
      "src", "index.ts")
    await mkdir(dirname(other), { recursive: true })
    await jiyuuMarker(join(config.root, "old-boku", "jiyuu"))
    await writeFile(other, "#!/usr/bin/env bun\n")
    await rm(bin)
    await symlink(other, bin)
    await synchronize(config)
    expect(await readlink(bin)).toBe(entry)
  })

  test("refuses another project's mcp/discord/src/index.ts", async () => {
    const config = await fixture()
    const bin = join(config.binDir, discordBin)
    const foreign = join(config.root, "other-project", "mcp", "discord", "src",
      "index.ts")
    await mkdir(dirname(foreign), { recursive: true })
    await writeFile(foreign, "#!/bin/sh\necho other\n")
    await chmod(foreign, 0o755)
    await symlink(foreign, bin)
    await expect(synchronize(config)).rejects.toThrow(
      "Refusing unrelated executable symlink")
    expect(await readlink(bin)).toBe(foreign)
  })

  test("requires a readable Jiyuu lock that records every dependency", async () => {
    const config = await fixture()
    const dir = config.discordDir!
    await lockDiscord(dir, { "fixture-helper": `file:${
      join(config.root, "sources", "fixture-helper")}` })
    await synchronize(config)
    expect(await discordProblems(config)).toEqual([])
    const lock = await readFile(join(dir, "bun.lock"), "utf8")

    await rm(join(dir, "bun.lock"))
    expect((await discordProblems(config)).join("\n"))
      .toContain("Jiyuu mcp/discord lock: bun.lock or package.json is unavailable")
    await expect(synchronize(config)).rejects.toThrow("Jiyuu mcp/discord lock")

    await writeFile(join(dir, "bun.lock"), "{ not a lock")
    expect((await discordProblems(config)).join("\n"))
      .toContain("unavailable or invalid")

    const parsed = Bun.JSON5.parse(lock) as { packages: Record<string, unknown> }
    delete parsed.packages["fixture-helper"]
    await writeFile(join(dir, "bun.lock"), JSON.stringify(parsed))
    expect(await discordProblems(config)).toEqual([
      "Jiyuu mcp/discord lock: bun.lock has no record for fixture-helper; " +
      "update Jiyuu"])
  })

  /** Jiyuu stand-in depending on fixture-parent, which needs fixture-helper. */
  async function parentFixture(config: Config): Promise<string> {
    const parent = join(config.root, "sources", "fixture-parent")
    await mkdir(parent, { recursive: true })
    await writeFile(join(parent, "package.json"), JSON.stringify({
      name: "fixture-parent", version: "1.0.0",
      dependencies: { "fixture-helper": `file:${
        join(config.root, "sources", "fixture-helper")}` },
    }))
    await lockDiscord(config.discordDir!, { "fixture-parent": `file:${parent}` })
    return parent
  }

  test("refuses a lock missing a record its own packages reference", async () => {
    const config = await fixture()
    await parentFixture(config)
    await synchronize(config)
    expect(await discordProblems(config)).toEqual([])
    const lockPath = join(config.discordDir!, "bun.lock")
    const parsed = Bun.JSON5.parse(await readFile(lockPath, "utf8")) as {
      packages: Record<string, unknown>
    }
    // Bun may nest the transitive record under its parent.
    const transitive = Object.keys(parsed.packages)
      .filter((key) => key !== "fixture-parent")
    expect(transitive.length).toBe(1)
    expect(transitive[0]!.endsWith("fixture-helper")).toBe(true)
    delete parsed.packages[transitive[0]!]
    await writeFile(lockPath, JSON.stringify(parsed))
    const message = "Jiyuu mcp/discord lock: bun.lock has no record for " +
      "fixture-helper, required by fixture-parent; update Jiyuu"
    expect(await discordProblems(config)).toEqual([message])
    await expect(synchronize(config)).rejects.toThrow(message)
  })

  test("repairs installed packages that a lock update dropped", async () => {
    const config = await fixture()
    const dir = config.discordDir!
    await parentFixture(config)
    await synchronize(config)
    // Jiyuu drops fixture-parent and depends on fixture-helper directly; the
    // old fixture-parent tree is still installed.
    await lockDiscord(dir, { "fixture-helper": `file:${
      join(config.root, "sources", "fixture-helper")}` })
    const drift = (await discordProblems(config)).join("\n")
    expect(drift).toContain("Jiyuu mcp/discord dependencies: fixture-helper")
    await synchronize(config)
    expect(await discordProblems(config)).toEqual([])
    expect(await lstat(join(dir, "node_modules", "fixture-parent"))
      .catch(() => undefined)).toBeUndefined()
  })

  test("refuses to remove a node_modules symlink that leaves Jiyuu", async () => {
    const config = await fixture()
    const dir = config.discordDir!
    await parentFixture(config)
    const outside = join(config.root, "outside-modules")
    await mkdir(join(outside, "keep"), { recursive: true })
    await writeFile(join(outside, "keep", "file"), "keep")
    await symlink(outside, join(dir, "node_modules"))
    await expect(synchronize(config)).rejects.toThrow(
      "not a plain directory inside Jiyuu's mcp/discord")
    expect(await readFile(join(outside, "keep", "file"), "utf8")).toBe("keep")
    expect((await lstat(join(dir, "node_modules"))).isSymbolicLink()).toBe(true)
  })

  test("repair removes symlinks inside node_modules without following them", async () => {
    const config = await fixture()
    const dir = config.discordDir!
    await parentFixture(config)
    await synchronize(config)
    const outside = join(config.root, "outside-package")
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, "file"), "keep")
    await mkdir(join(dir, "node_modules", "@scope"), { recursive: true })
    await symlink(outside, join(dir, "node_modules", "@scope", "linked"))
    await symlink(outside, join(dir, "node_modules", "linked"))
    await rm(join(dir, "node_modules", "fixture-parent"), { recursive: true })
    expect((await discordProblems(config)).length).toBeGreaterThan(0)
    await synchronize(config)
    expect(await discordProblems(config)).toEqual([])
    expect(await readFile(join(outside, "file"), "utf8")).toBe("keep")
    expect(await lstat(join(dir, "node_modules", "linked"))
      .catch(() => undefined)).toBeUndefined()
  })

  test("lockReferenceProblems resolves nested and scoped records", () => {
    const packages = {
      "@s/a": ["@s/a@1.0.0", "", { dependencies: { b: "^1", c: "^1" } }],
      "@s/a/b": ["b@1.0.0", "", {}],
      c: ["c@1.0.0", "", { dependencies: { d: "^1" },
        optionalDependencies: { d: "^1" } }],
    }
    expect(lockReferenceProblems(packages, { "@s/a": "^1" })).toEqual([])
    expect(lockReferenceProblems(packages, { "@s/a": "^1", e: "^1" }))
      .toEqual(["bun.lock has no record for e"])
    const { "@s/a/b": _, ...withoutB } = packages
    expect(lockReferenceProblems(withoutB, { "@s/a": "^1" }))
      .toEqual(["bun.lock has no record for b, required by @s/a"])
  })

  test("refuses an unrelated mcp-discord command", async () => {
    const config = await fixture()
    const bin = join(config.binDir, discordBin)
    const foreign = join(config.root, "foreign-discord")
    await writeFile(foreign, "#!/bin/sh\necho foreign\n")
    await chmod(foreign, 0o755)
    await symlink(foreign, bin)
    await expect(synchronize(config)).rejects.toThrow(
      "Refusing unrelated executable symlink")
    expect(await readlink(bin)).toBe(foreign)
    await rm(bin)
    await writeFile(bin, "#!/bin/sh\n")
    await expect(synchronize(config)).rejects.toThrow("non-symlink")
  })
})

describe("checkout selection", () => {
  const script = join(import.meta.dir, "sync.ts")

  async function checkouts() {
    const root = await mkdtemp(join(tmpdir(), "dotfiles-bun-checkouts-"))
    temporary.push(root)
    const live = join(root, "dotfiles")
    const worktree = join(root, "dotfiles-pr")
    await mkdir(join(live, "bun", "global"), { recursive: true })
    await mkdir(join(worktree, "bun", "global"), { recursive: true })
    const home = join(root, "home")
    await mkdir(home)
    return { root, live, worktree, home }
  }

  test("installs from $DOTFILES and falls back to the script directory", () => {
    expect(installRoot({ DOTFILES: "/x/dotfiles" }, "/y/dotfiles-pr/bun"))
      .toBe("/x/dotfiles/bun")
    expect(installRoot({}, "/y/dotfiles-pr/bun")).toBe("/y/dotfiles-pr/bun")
  })

  test("refuses --run from a second checkout unless allowed", async () => {
    const c = await checkouts()
    const env = { DOTFILES: c.live }
    const problem = await runCheckoutProblem(env, join(c.worktree, "bun"))
    expect(problem).toContain("Refusing --run")
    expect(problem).toContain(c.worktree)
    expect(await runCheckoutProblem(env, join(c.worktree, "bun"), true))
      .toBeUndefined()
    expect(await runCheckoutProblem(env, join(c.live, "bun")))
      .toBeUndefined()
    const alias = join(c.root, "dotfiles-link")
    await symlink(c.live, alias)
    expect(await runCheckoutProblem({ DOTFILES: alias }, join(c.live, "bun")))
      .toBeUndefined()
    expect(await runCheckoutProblem({}, join(c.worktree, "bun")))
      .toBeUndefined()
  })

  test("the CLI leaves the live installation alone from a second checkout",
    async () => {
      const c = await checkouts()
      const runtime = join(c.home, "runtime-global")
      await symlink(join(c.live, "bun", "global"), runtime)
      const env = {
        ...process.env, HOME: c.home, DOTFILES: c.live,
        BUN_INSTALL: join(c.home, ".bun"), BUN_INSTALL_GLOBAL_DIR: runtime,
        BUN_INSTALL_BIN: join(c.home, ".bun", "bin"),
        XDG_DATA_HOME: join(c.home, "xdg"),
      }
      // This test file runs from a checkout other than c.live.
      const run = Bun.spawn(["bun", "--no-install", script, "--run"], {
        cwd: c.worktree, env, stdout: "pipe", stderr: "pipe",
      })
      const [code, stderr] = await Promise.all([
        run.exited, new Response(run.stderr).text(),
      ])
      expect(code).toBe(1)
      expect(stderr).toContain("Refusing --run")
      expect(await readlink(runtime)).toBe(join(c.live, "bun", "global"))
      // Bun may create its own cache under HOME; sync must not have backed
      // up the runtime link or written executable links.
      expect((await readdir(c.home)).filter((name) =>
        name.startsWith("runtime-global"))).toEqual(["runtime-global"])
      expect(await readdir(env.BUN_INSTALL_BIN).catch(() => []))
        .toEqual([])

      const checked = Bun.spawn(["bun", "--no-install", script, "--check"], {
        cwd: c.worktree, env, stdout: "pipe", stderr: "pipe",
      })
      const [checkCode, checkErr] = await Promise.all([
        checked.exited, new Response(checked.stderr).text(),
      ])
      expect(checkCode).toBe(1)
      expect(checkErr).toContain(join(c.live, "bun", "global"))
      expect(checkErr).not.toContain(import.meta.dir)
    }, 30000)
})
