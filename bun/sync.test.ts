import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { bash } from "@uniquedivine/bash"
import {
  chmod, lstat, mkdir, mkdtemp, readFile, readlink, readdir, realpath,
  rm, symlink, writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  activateMdtoc, adoptPackage, check, configuration, dropPackage,
  inspectPackages, manifestPolicyProblems, parseSpec, pathShadowProblem,
  installRoot, lockProblems, refreshLock, runCheckoutProblem, synchronize,
  type Config,
} from "./sync"

const temporary: string[] = []
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })))
})

const mdtocCli = `#!/usr/bin/env bun
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
`

interface Release {
  manifest: Record<string, unknown>
  tarball: ArrayBuffer
  integrity: string
}

/**
 * A local npm registry serving packed fixture packages, so the managed
 * manifest holds exact registry pins as the policy requires. `ghost@1.0.0`
 * answers the release lookup but has no packument, so a lock refresh that
 * needs it fails.
 */
const registry = {
  dir: "", url: "",
  releases: new Map<string, Map<string, Release>>(),
  server: undefined as ReturnType<typeof Bun.serve> | undefined,
}

async function publish(
  manifest: Record<string, unknown>, files: Record<string, string>,
  executable: string[] = [],
): Promise<void> {
  const name = String(manifest.name)
  const version = String(manifest.version)
  const dir = join(registry.dir, "src", `${name.replace("/", "+")}@${version}`)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, "package.json"), JSON.stringify(manifest))
  for (const [file, text] of Object.entries(files)) {
    await writeFile(join(dir, file), text)
  }
  for (const file of executable) await chmod(join(dir, file), 0o755)
  const packed = join(registry.dir, `${dir.split("/").at(-1)}.tgz`)
  const result = await bash(`cd '${dir}' && '${process.execPath}' pm pack ` +
    `--ignore-scripts --filename '${packed}'`)
  if (result.exitCode) throw new Error(result.stderr)
  const tarball = await Bun.file(packed).arrayBuffer()
  const versions = registry.releases.get(name) ?? new Map<string, Release>()
  versions.set(version, { manifest, tarball, integrity: "sha512-" +
    new Bun.CryptoHasher("sha512").update(tarball).digest("base64") })
  registry.releases.set(name, versions)
}

function versionDocument(name: string, version: string, release: Release) {
  return { ...release.manifest, name, version, dist: {
    tarball: `${registry.url}/-/${encodeURIComponent(name)}/${version}.tgz`,
    integrity: release.integrity,
  } }
}

beforeAll(async () => {
  registry.dir = await mkdtemp(join(tmpdir(), "dotfiles-bun-registry-"))
  await publish({ name: "fixture-helper", version: "1.0.0", type: "module",
    main: "index.js" }, { "index.js": 'export const bullet = "-"\n' })
  await publish({ name: "fixture-helper", version: "2.0.0", type: "module",
    main: "index.js" }, { "index.js": 'export const bullet = "-"\n' })
  await publish({ name: "dotfiles-fixture-only", version: "1.0.0" },
    { "index.js": "export {}\n" })
  await publish({ name: "@uniquedivine/ud-mdtoc", version: "0.1.0",
    type: "module", bin: { "ud-mdtoc": "cli.js" },
    dependencies: { "fixture-helper": "1.0.0" } }, { "cli.js": mdtocCli },
    ["cli.js"])
  registry.server = Bun.serve({ port: 0, fetch(request) {
    const path = decodeURIComponent(new URL(request.url).pathname).slice(1)
    const tarball = path.match(/^-\/(.+)\/([^/]+)\.tgz$/)
    if (tarball) {
      const release = registry.releases.get(tarball[1]!)?.get(tarball[2]!)
      return release ? new Response(release.tarball)
        : new Response("missing", { status: 404 })
    }
    const versions = registry.releases.get(path)
    if (versions) {
      return Response.json({ name: path,
        "dist-tags": { latest: [...versions.keys()].at(-1) },
        versions: Object.fromEntries([...versions].map(([version, release]) =>
          [version, versionDocument(path, version, release)])) })
    }
    const slash = path.lastIndexOf("/")
    const name = path.slice(0, slash)
    const version = path.slice(slash + 1)
    if (name === "ghost" && version === "1.0.0") {
      return Response.json({ name, version })
    }
    const release = registry.releases.get(name)?.get(version)
    return release ? Response.json(versionDocument(name, version, release))
      : new Response("missing", { status: 404 })
  } })
  registry.url = registry.server.url.href.replace(/\/$/, "")
})

afterAll(async () => {
  registry.server?.stop(true)
  await rm(registry.dir, { recursive: true, force: true })
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
  // Bun reads the registry and cache from bunfig.toml in the --cwd directory;
  // a private cache keeps fixture releases out of the workstation's cache.
  await writeFile(join(config.globalDir, "bunfig.toml"),
    `[install]\nregistry = "${registry.url}/"\n` +
    `[install.cache]\ndir = "${join(root, "cache")}"\n`)
  await writeManifest(config, {
    "@uniquedivine/ud-mdtoc": "0.1.0",
    "fixture-helper": "1.0.0",
  })
  await refreshLock(config)
  return config
}

async function writeManifest(
  config: Config, dependencies: Record<string, string>,
): Promise<void> {
  await writeFile(join(config.globalDir, "package.json"), JSON.stringify({
    name: "fixture-global", private: true, dependencies,
  }, null, 2) + "\n")
}

async function managedFiles(config: Config): Promise<string[]> {
  return Promise.all(["package.json", "bun.lock"].map((file) =>
    readFile(join(config.globalDir, file), "utf8")))
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
    expect(await lockProblems(config)).toEqual(["fixture-helper: bun.lock " +
      "has 1.0.0, package.json has none; run just bun-drop fixture-helper"])
    await expect(synchronize(config)).rejects.toThrow("just bun-drop")
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
    // A checkout moved behind a symlink (old path -> new path) leaves links
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
    const bin = join(config.binDir, "ud-mdtoc")
    const elsewhere = join(config.root, "elsewhere")
    await writeFile(elsewhere, "#!/bin/sh\n")
    await chmod(elsewhere, 0o755)
    await rm(bin)
    await symlink(elsewhere, bin)
    const problems = (await check(config)).join("\n")
    expect(problems).toContain(`Executable link is missing or incorrect: ${bin}`)
    expect(problems).not.toContain("PATH resolves")
    expect(await pathShadowProblem("ud-mdtoc", config.binDir, config.env))
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

describe("exact-pin policy", () => {
  test("rejects ranges and tags, naming the package and its fix", () => {
    expect(manifestPolicyProblems({ dependencies: {
      "@nibiruchain/nibiru": "^2.21.2", prettier: "~3.9.6",
      typescript: ">=6.0.0 <7", "ts-node": "latest",
      "auto-pandoc": "1.1.2", "beta-tool": "1.0.0-rc.1",
    } })).toEqual([
      '@nibiruchain/nibiru: "^2.21.2" is not an exact version; run ' +
        "just bun-add @nibiruchain/nibiru@2.21.2",
      'prettier: "~3.9.6" is not an exact version; run ' +
        "just bun-add prettier@3.9.6",
      'typescript: ">=6.0.0 <7" is not an exact version; run ' +
        "just bun-add typescript@6.0.0",
      'ts-node: "latest" is not an exact version; run ' +
        "just bun-add ts-node@VERSION",
    ])
  })

  test("rejects machine paths with a restore command", () => {
    const tarball = "/home/someone/tg-sai/uniquedivine-tg-sai-0.3.2.tgz"
    const hint = "is a path on this machine, not a registry release; " +
      "run git checkout -- bun/global"
    expect(manifestPolicyProblems({ dependencies: {
      "@uniquedivine/tg-sai": tarball, a: "file:../sources/a",
      b: "link:b", c: "./c.tgz",
    } })).toEqual([
      `@uniquedivine/tg-sai: "${tarball}" ${hint}`,
      `a: "file:../sources/a" ${hint}`, `b: "link:b" ${hint}`,
      `c: "./c.tgz" ${hint}`,
    ])
  })

  test("the committed manifest uses exact pins that match its lock",
    async () => {
      const config = await configuration(import.meta.dir)
      expect(await lockProblems(config)).toEqual([])
    })

  test("a range blocks check, sync, and lock refresh", async () => {
    const config = await fixture()
    await writeManifest(config, {
      "@uniquedivine/ud-mdtoc": "0.1.0", "fixture-helper": "^1.0.0",
    })
    const message = 'fixture-helper: "^1.0.0" is not an exact version; ' +
      "run just bun-add fixture-helper@1.0.0"
    // The policy problem replaces the drift line for the same package.
    expect(await lockProblems(config)).toEqual([message])
    expect(await check(config)).toContain(message)
    await expect(synchronize(config)).rejects.toThrow(message)
    expect(await lstat(config.runtimeDir).catch(() => undefined)).toBeUndefined()
    await expect(refreshLock(config)).rejects.toThrow(message)
  })

  test("drift lists added, removed, and changed packages", async () => {
    const config = await fixture()
    await writeManifest(config, { "fixture-helper": "2.0.0", ghost: "1.0.0" })
    expect(await lockProblems(config)).toEqual([
      "@uniquedivine/ud-mdtoc: bun.lock has 0.1.0, package.json has none; " +
        "run just bun-drop @uniquedivine/ud-mdtoc",
      "fixture-helper: package.json has 2.0.0, bun.lock has 1.0.0; " +
        "run just bun-add fixture-helper@2.0.0",
      "ghost: package.json has 1.0.0, bun.lock has none; " +
        "run just bun-add ghost@1.0.0",
    ])
  })

  test("a clean fixture passes", async () => {
    const config = await fixture()
    expect(await lockProblems(config)).toEqual([])
  })
})

describe("adopt and drop", () => {
  test("parses scoped and plain exact specs", () => {
    expect(parseSpec("@nibiruchain/nibiru@2.21.2"))
      .toEqual({ name: "@nibiruchain/nibiru", version: "2.21.2" })
    expect(parseSpec("prettier@3.9.6"))
      .toEqual({ name: "prettier", version: "3.9.6" })
    for (const bad of ["prettier", "prettier@^3.9.6", "@scope/x", "Bad@1.0.0"]) {
      expect(() => parseSpec(bad)).toThrow("exact version")
    }
  })

  test("adopt writes an exact pin and its lock, then syncs", async () => {
    const config = await fixture()
    await adoptPackage(config, "fixture-helper", "2.0.0")
    const [pkg, lock] = await managedFiles(config)
    expect(JSON.parse(pkg!).dependencies["fixture-helper"]).toBe("2.0.0")
    expect(lock).toContain('"fixture-helper@2.0.0"')
    expect(await lockProblems(config)).toEqual([])
    await synchronize(config)
    expect(await check(config)).toEqual([])
  })

  test("adopt resolves through the registry that bunfig.toml names",
    async () => {
      // Only the fixture registry has this package, and only the fixture's
      // bunfig.toml points at it.
      const config = await fixture()
      await adoptPackage(config, "dotfiles-fixture-only", "1.0.0")
      expect(JSON.parse((await managedFiles(config))[0]!)
        .dependencies["dotfiles-fixture-only"]).toBe("1.0.0")
      expect(await lockProblems(config)).toEqual([])
    })

  test("adopt fixes a range that bun add -g wrote", async () => {
    const config = await fixture()
    await writeManifest(config, {
      "@uniquedivine/ud-mdtoc": "0.1.0", "fixture-helper": "^1.0.0",
    })
    await adoptPackage(config, "fixture-helper", "1.0.0")
    expect(await lockProblems(config)).toEqual([])
  })

  test("adopt changes nothing when the release or lock refresh fails",
    async () => {
      const config = await fixture()
      const before = await managedFiles(config)
      await expect(adoptPackage(config, "fixture-helper", "9.9.9"))
        .rejects.toThrow("Could not adopt fixture-helper@9.9.9")
      expect(await managedFiles(config)).toEqual(before)
      // ghost@1.0.0 has a release document but no packument.
      await expect(adoptPackage(config, "ghost", "1.0.0")).rejects.toThrow()
      expect(await managedFiles(config)).toEqual(before)
      await expect(adoptPackage(config, "fixture-helper", "2.0.0",
        () => "rejected by verify")).rejects.toThrow("rejected by verify")
      expect(await managedFiles(config)).toEqual(before)
    })

  test("activate-mdtoc adopts a release that declares its executable",
    async () => {
      const config = await fixture()
      await dropPackage(config, "@uniquedivine/ud-mdtoc")
      await activateMdtoc(config, "0.1.0")
      expect(JSON.parse((await managedFiles(config))[0]!)
        .dependencies["@uniquedivine/ud-mdtoc"]).toBe("0.1.0")
      await expect(activateMdtoc(config, "^0.1.0")).rejects.toThrow("exact")
    })

  test("drop removes a package and refreshes the lock", async () => {
    const config = await fixture()
    await dropPackage(config, "@uniquedivine/ud-mdtoc")
    const [pkg, lock] = await managedFiles(config)
    expect(JSON.parse(pkg!).dependencies)
      .toEqual({ "fixture-helper": "1.0.0" })
    expect(lock).not.toContain("ud-mdtoc")
    expect(await lockProblems(config)).toEqual([])
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
