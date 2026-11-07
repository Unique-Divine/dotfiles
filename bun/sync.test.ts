import { afterEach, describe, expect, test } from "bun:test"
import { bash } from "@uniquedivine/bash"
import {
  chmod, lstat, mkdir, mkdtemp, readFile, readlink, readdir, realpath,
  rm, symlink, writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  check, checkoutPinnedSource, configuration, ensureDiscord,
  inspectPackages, lockProblems, refreshLock,
  synchronize, type Config,
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
  })
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

  test("checks out a fresh pinned clone and protects subsequent local edits", async () => {
    const config = await fixture()
    const repository = join(config.root, "upstream")
    const stream = join(config.root, "fixture.git-import")
    await mkdir(repository)
    // A real one-file Git repository, without changing the workspace history.
    await writeFile(stream,
      "commit refs/heads/main\n" +
      "committer Fixture <fixture@example.invalid> 1 +0000\n" +
      "data 7\nfixture\n" +
      "M 100644 inline tracked.txt\ndata 5\nhello\n\ndone\n")
    const init = await bash(`git init --quiet '${repository}' && ` +
      `git -C '${repository}' fast-import --quiet < '${stream}'`)
    expect(init.exitCode).toBe(0)
    const revision = await bash(`git -C '${repository}' rev-parse main`)
    const checkout = join(config.root, "fresh-source")
    await checkoutPinnedSource(checkout, repository, revision.stdout.trim(),
      config.root)
    expect(await readFile(join(checkout, "tracked.txt"), "utf8")).toBe("hello")
    await writeFile(join(checkout, "tracked.txt"), "local changes")
    await expect(checkoutPinnedSource(checkout, repository,
      revision.stdout.trim(), config.root)).rejects.toThrow("local changes")
    expect(await readFile(join(checkout, "tracked.txt"), "utf8"))
      .toBe("local changes")
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

  const discordTest = process.env.BUN_DISCORD_INTEGRATION === "1"
    ? test : test.skip
  discordTest("builds pinned Discord and repairs deleted source dependencies", async () => {
    const config = await fixture()
    await writeFile(join(config.globalDir, "package.json"),
      JSON.stringify({ private: true, dependencies: {
        "mcp-discord": "file:../sources/mcp-discord/mcp-discord-1.3.8.tgz",
      } }))
    await ensureDiscord(config)
    expect(await readFile(join(config.sourceDir, "build", "index.js"), "utf8"))
      .toContain("#!/usr/bin/env node")
    await refreshLock(config)
    const before = await readFile(join(config.sourceDir,
      ".dotfiles-build.json"), "utf8")
    const sourceIssues = async (): Promise<string[]> =>
      (await check(config)).filter((line) => line.includes("Discord source:") ||
        line.includes("mcp-discord source build"))
    expect(await sourceIssues()).toEqual([])
    await rm(join(config.sourceDir, "node_modules"), { recursive: true })
    expect((await sourceIssues()).length).toBeGreaterThan(0)
    await ensureDiscord(config)
    expect(JSON.parse(await readFile(join(config.sourceDir,
      ".dotfiles-build.json"), "utf8")).archiveHash)
      .toBe(JSON.parse(before).archiveHash)
    expect(await sourceIssues()).toEqual([])
  }, 120_000)
})
