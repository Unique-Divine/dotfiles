import { bash } from "@uniquedivine/bash"
import { constants } from "node:fs"
import {
  access, chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm,
  stat, symlink, writeFile,
} from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { tmpdir } from "node:os"
import { parse as parseToml } from "smol-toml"

export const discordCommit =
  "5c67e9d714971490aaedf8fab21753d7704bd4fa"
const discordRepository = "https://github.com/barryyip0625/mcp-discord.git"
const discordArchive = "mcp-discord-1.3.8.tgz"
const mdtocPackage = "@uniquedivine/ud-mdtoc"
const repair = "repair: just bun-sync"

type Environment = Record<string, string | undefined>
interface Package {
  name?: string
  version?: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  bin?: string | Record<string, string>
}
interface InstalledState {
  bins: Record<string, string>
  plugin?: string
  manifest: string
  lock: string
}
export interface Config {
  root: string
  globalDir: string
  runtimeDir: string
  binDir: string
  pluginDir: string
  sourceDir: string
  env: Environment
}
interface Inspection {
  problems: string[]
  packages: Record<string, Package>
  bins: Record<string, string>
}

const quote = (value: string): string =>
  `'${value.replaceAll("'", "'\\''")}'`

/** Execute an argv command without treating its arguments as shell code. */
async function command(
  argv: string[], cwd: string, env: Environment = {},
  input?: string,
): Promise<string> {
  const assignments = Object.entries(env).filter(([key, value]) =>
    value !== undefined && value !== process.env[key] &&
    /^(HOME|PATH|BUN_.*|XDG_.*|UD_PLUGIN_PATH)$/.test(key))
    .map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Invalid environment key: ${key}`)
    }
    return `${key}=${quote(value!)}`
  })
  const stdin = input === undefined ? "" : `printf '%s' ${quote(input)} | `
  const logs = await mkdtemp(join(tmpdir(), "bun-tools-command-"))
  try {
    const stdout = join(logs, "stdout")
    const stderr = join(logs, "stderr")
    // The shared bash helper waits before draining pipes. File redirection
    // prevents verbose dependency installs from filling those pipes.
    const result = await bash(`cd ${quote(cwd)} && ${stdin}env ${
      assignments.join(" ")} ${argv.map(quote).join(" ")} >${
      quote(stdout)} 2>${quote(stderr)}`)
    const out = await readFile(stdout, "utf8").catch(() => "")
    const err = await readFile(stderr, "utf8").catch(() => "")
    if (result.exitCode !== 0) {
      throw new Error(`${argv.slice(0, 3).join(" ")} failed in ${cwd}:\n` +
        err.trim() + result.stderr.trim() + "\n" + out.trim())
    }
    return out.trim()
  } finally { await rm(logs, { recursive: true, force: true }) }
}

async function buildHash(root: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256")
  async function visit(path: string): Promise<void> {
    for (const entry of (await readdir(path, { withFileTypes: true }))
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const child = join(path, entry.name)
      hasher.update(relative(root, child))
      if (entry.isDirectory()) await visit(child)
      else hasher.update(await readFile(child))
    }
  }
  await visit(root)
  return hasher.digest("hex")
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true } catch { return false }
}

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK)
    return (await stat(path)).isFile()
  } catch { return false }
}

async function sameTarget(a: string, b: string): Promise<boolean> {
  try { return await realpath(a) === await realpath(b) } catch { return false }
}

async function json<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T
}

async function manifest(config: Config): Promise<Package> {
  return json<Package>(join(config.globalDir, "package.json"))
}

async function lockHash(config: Config): Promise<string> {
  return new Bun.CryptoHasher("sha256").update(await readFile(
    join(config.globalDir, "bun.lock"))).digest("hex")
}

async function fileHash(path: string): Promise<string> {
  return new Bun.CryptoHasher("sha256").update(await readFile(path))
    .digest("hex")
}

/** Match Bun's Unix global settings, with environment overrides first. */
export async function configuration(
  root = dirname(import.meta.path), env: Environment = process.env,
): Promise<Config> {
  if (!env.HOME) throw new Error("HOME must be set")
  const home = env.HOME
  const expand = (path: string, base = process.cwd()): string => resolve(base,
    path.startsWith("~/") ? join(home, path.slice(2)) : path)
  const bunRoot = expand(env.BUN_INSTALL ?? join(home, ".bun"))
  let settings: Record<string, unknown> = {}
  const configPath = join(env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME)
    ? env.XDG_CONFIG_HOME : home, ".bunfig.toml")
  if (await exists(configPath)) {
    const parsed = parseToml(await readFile(configPath, "utf8"))
    const install = parsed.install
    if (install && typeof install === "object") {
      settings = { ...settings, ...install }
    }
  }
  const runtimeDir = env.BUN_INSTALL_GLOBAL_DIR
    ? expand(env.BUN_INSTALL_GLOBAL_DIR)
    : expand(String(settings.globalDir ?? join(bunRoot, "install", "global")),
      dirname(configPath))
  const binDir = env.BUN_INSTALL_BIN ? expand(env.BUN_INSTALL_BIN)
    : expand(String(settings.globalBinDir ?? join(bunRoot, "bin")),
      dirname(configPath))
  const canonicalRoot = resolve(root)
  return {
    root: canonicalRoot,
    globalDir: join(canonicalRoot, "global"),
    sourceDir: join(canonicalRoot, "sources", "mcp-discord"),
    runtimeDir, binDir,
    pluginDir: join(env.XDG_DATA_HOME ?? join(home, ".local", "share"),
      "ud", "plugins"),
    env,
  }
}

/** The manifest and lock must agree before sync changes an installation. */
export async function lockProblems(config: Config): Promise<string[]> {
  try {
    const desired = (await manifest(config)).dependencies ?? {}
    const lock = Bun.JSON5.parse(await readFile(
      join(config.globalDir, "bun.lock"), "utf8")) as {
      workspaces?: Record<string, { dependencies?: Record<string, string> }>
    }
    const locked = lock.workspaces?.[""]?.dependencies ?? {}
    const normalize = (value: Record<string, string>): string =>
      JSON.stringify(Object.entries(value).sort(([a], [b]) =>
        a.localeCompare(b)))
    if (normalize(desired) !== normalize(locked)) {
      return ["Bun manifest differs from bun.lock; run just bun-lock, " +
        "review the lockfile, then just bun-sync"]
    }
    return []
  } catch (error) {
    return [`Bun lockfile is unavailable or invalid: ${error}; ` +
      "run just bun-lock"]
  }
}

function packageBins(pkg: Package): Record<string, string> {
  if (typeof pkg.bin === "string") {
    return { [pkg.name!.split("/").at(-1)!]: pkg.bin }
  }
  return pkg.bin ?? {}
}

function safeBin(name: string, file: string, packageDir: string): string {
  if (!name || name.includes("/") || name === "." || name === "..") {
    throw new Error(`Invalid executable name: ${name}`)
  }
  const target = resolve(packageDir, file)
  if (relative(packageDir, target).startsWith("..") || isAbsolute(file)) {
    throw new Error(`Executable ${name} escapes its package: ${file}`)
  }
  return target
}

/** Resolve dependencies only within this global installation. */
async function dependencyDir(
  name: string, from: string, globalDir: string,
): Promise<string | undefined> {
  let current = from
  while (current === globalDir || current.startsWith(globalDir + "/")) {
    const candidate = join(current, "node_modules", name)
    if (await exists(join(candidate, "package.json"))) return candidate
    if (current === globalDir) break
    current = dirname(current)
  }
  return undefined
}

/** Inspect the dependency tree without invoking package code or the registry. */
export async function inspectPackages(config: Config): Promise<Inspection> {
  const problems: string[] = []
  const packages: Record<string, Package> = {}
  const bins: Record<string, string> = {}
  const checked = new Set<string>()
  const lock = await readFile(join(config.globalDir, "bun.lock"), "utf8")
    .then((text) => Bun.JSON5.parse(text) as {
      packages?: Record<string, unknown[]>
    }).catch(() => undefined)
  async function visit(path: string): Promise<void> {
    if (checked.has(path)) return
    checked.add(path)
    const pkg = await json<Package>(join(path, "package.json"))
    const key = relative(join(config.globalDir, "node_modules"), path)
      .replaceAll("/node_modules/", "/")
    const record = lock?.packages?.[key]?.[0]
    const pinned = typeof record === "string" ? record.match(/@([^@]+)$/)?.[1]
      : undefined
    if (pinned && /^\d+\.\d+\.\d+/.test(pinned) && pkg.version !== pinned) {
      problems.push(`${pkg.name}: installed ${pkg.version}, lock requires ${pinned}`)
    }
    for (const [name, range] of Object.entries(pkg.dependencies ?? {})) {
      if (name in (pkg.optionalDependencies ?? {})) continue
      const dependency = await dependencyDir(name, path, config.globalDir)
      if (!dependency) {
        problems.push(`${pkg.name}: dependency ${name} is missing`)
        continue
      }
      const installed = await json<Package>(join(dependency, "package.json"))
      if (/^[~^<>=*\d]/.test(range) && installed.version &&
          !Bun.semver.satisfies(installed.version, range)) {
        problems.push(`${pkg.name} at ${path}: dependency ${name}@${
          installed.version} does not satisfy ${range}`)
      }
      await visit(dependency)
    }
  }
  const desired = (await manifest(config)).dependencies ?? {}
  for (const [name, version] of Object.entries(desired)) {
    const packageDir = join(config.globalDir, "node_modules", name)
    try {
      const pkg = await json<Package>(join(packageDir, "package.json"))
      packages[name] = pkg
      if (pkg.name !== name || (!version.startsWith("file:") &&
          !Bun.semver.satisfies(pkg.version ?? "", version))) {
        problems.push(`${name}: installed ${pkg.version}, expected ${version}`)
      }
      for (const [bin, file] of Object.entries(packageBins(pkg))) {
        const target = safeBin(bin, file, packageDir)
        if (bins[bin] && bins[bin] !== target) {
          problems.push(`Executable ${bin} is provided by multiple packages`)
        }
        bins[bin] = target
        if (!await executable(target)) {
          problems.push(`${name}: executable ${target} is missing or not executable`)
        }
      }
      await visit(packageDir)
    } catch (error) {
      problems.push(`${name}: package is unavailable or invalid: ${error}`)
    }
  }
  return { problems, packages, bins }
}

async function sourceDependencyProblems(config: Config): Promise<string[]> {
  const sourceConfig = { ...config, globalDir: config.sourceDir }
  // Keep the pinned checkout ready for rebuilding the runtime archive.
  const inspection = await inspectPackages(sourceConfig)
  return inspection.problems.map((problem) => `Discord source: ${problem}`)
}

async function sourceProblems(config: Config): Promise<string[]> {
  const desired = (await manifest(config)).dependencies ?? {}
  if (!desired["mcp-discord"]?.startsWith("file:")) return []
  try {
    const installed = await json<{
      commit: string; buildHash: string; archiveHash: string
    }>(
      join(config.sourceDir, ".dotfiles-build.json"))
    if (installed.commit !== discordCommit ||
        !await executable(join(config.sourceDir, "build", "index.js"))) {
      throw new Error("source revision or build is stale")
    }
    const actual = await command(["git", "rev-parse", "HEAD"],
      config.sourceDir)
    if (actual !== discordCommit) throw new Error("source revision differs")
    if (await command(["git", "--no-optional-locks", "status", "--porcelain",
      "--untracked-files=no"], config.sourceDir)) {
      throw new Error("source checkout has local changes")
    }
    if (installed.buildHash !== await buildHash(join(config.sourceDir, "build"))) {
      throw new Error("built files differ from the recorded build")
    }
    if (installed.archiveHash !== await fileHash(
      join(config.sourceDir, discordArchive))) {
      throw new Error("packed archive differs from the recorded build")
    }
    const dependencies = await sourceDependencyProblems(config)
    if (dependencies.length) return dependencies
    return []
  } catch (error) {
    return [`mcp-discord source build is unavailable: ${error}`]
  }
}

/** Build only the explicitly selected Discord source revision. */
export async function ensureDiscord(config: Config): Promise<void> {
  const desired = (await manifest(config)).dependencies ?? {}
  if (!desired["mcp-discord"]?.startsWith("file:")) return
  if (!(await sourceProblems(config)).length) return
  await checkoutPinnedSource(config.sourceDir, discordRepository,
    discordCommit, config.root)
  await command([process.execPath, "install", "--frozen-lockfile",
    "--ignore-scripts"], config.sourceDir)
  await command([process.execPath, "run", "build"], config.sourceDir)
  await chmod(join(config.sourceDir, "build", "index.js"), 0o755)
  // A folder dependency exposes source-file symlinks and mixes its development
  // dependencies with the global tree. Install the packed runtime instead.
  await command([process.execPath, "pm", "pack", "--ignore-scripts",
    "--filename", join(config.sourceDir, discordArchive)], config.sourceDir)
  await writeFile(join(config.sourceDir, ".dotfiles-build.json"),
    JSON.stringify({ commit: discordCommit,
      buildHash: await buildHash(join(config.sourceDir, "build")),
      archiveHash: await fileHash(join(config.sourceDir, discordArchive)),
    }) + "\n")
}

/** Restore a pinned manager-owned checkout without overwriting local edits. */
export async function checkoutPinnedSource(
  path: string, repository: string, commit: string, cwd: string,
): Promise<void> {
  let created = false
  if (!await exists(path)) {
    await mkdir(dirname(path), { recursive: true })
    await command(["git", "clone", "--no-checkout", repository, path], cwd)
    created = true
  }
  const origin = await command(["git", "remote", "get-url", "origin"],
    path)
  if (origin !== repository) {
    throw new Error(`Refusing unexpected source checkout: ${path}`)
  }
  const dirty = created ? "" : await command(["git", "status", "--porcelain",
    "--untracked-files=no"], path)
  if (dirty) throw new Error(`Source checkout has local changes: ${path}`)
  try { await command(["git", "cat-file", "-e", `${commit}^{commit}`], path) }
  catch { await command(["git", "fetch", "origin", commit], path) }
  await command(["git", "checkout", "--detach", commit], path)
}

async function readState(config: Config): Promise<InstalledState | undefined> {
  try {
    return await json<InstalledState>(
      join(config.globalDir, ".installed.json"))
  } catch { return undefined }
}

/** Exercise the installed Markdown CLI outside the checkout. */
async function checkMdtoc(
  config: Config, bins: Record<string, string>,
): Promise<string[]> {
  const target = bins["ud-mdtoc"]
  if (!target) return []
  try {
    const metadata = JSON.parse(await command([process.execPath,
      "--no-install", target, "--plugin-info"],
      "/tmp", config.env)) as { apiVersion: number; name: string }
    if (metadata.apiVersion !== 1 || metadata.name !== "mdtoc") {
      throw new Error("invalid ud plugin metadata")
    }
    const source = "# Title\n## First\n### Nested\n"
    const result = await command([process.execPath, "--no-install", target,
      "-", "--bullets=-",
      "--maxdepth=3", "--no-firsth1"], "/tmp", config.env, source)
    if (result !==
        "- [First](#first)\n  - [Nested](#nested)") {
      throw new Error("Markdown output differs from the expected bullets and links")
    }
    return []
  } catch (error) { return [`ud-mdtoc behavior check failed: ${error}`] }
}

/** Read-only, offline diagnosis with repair commands. */
export async function check(config: Config): Promise<string[]> {
  const problems = await lockProblems(config)
  const inspection = await inspectPackages(config)
  problems.push(...inspection.problems, ...await sourceProblems(config))
  if (!await sameTarget(config.runtimeDir, config.globalDir)) {
    problems.push(`Bun global directory does not point to ${config.globalDir}`)
  }
  const state = await readState(config)
  if (!state || state.lock !== await lockHash(config) ||
      state.manifest !== await readFile(
        join(config.globalDir, "package.json"), "utf8")) {
    problems.push("Managed executable ownership is missing or stale")
  }
  for (const [name, target] of Object.entries(inspection.bins)) {
    const bin = join(config.binDir, name)
    if (!await sameTarget(bin, target)) {
      problems.push(`Executable link is missing or incorrect: ${bin}`)
    }
    const resolved = Bun.which(name, { PATH: config.env.PATH ?? "" })
    if (!resolved || !await sameTarget(resolved, target)) {
      problems.push(`PATH resolves ${name} to ${resolved ?? "nothing"}, ` +
        `expected ${bin}; put ${config.binDir} before competing tools on PATH`)
    }
  }
  if (inspection.bins["ud-mdtoc"] && !await sameTarget(
    join(config.pluginDir, "ud-mdtoc"), inspection.bins["ud-mdtoc"]!)) {
    problems.push("ud mdtoc plugin link is missing or incorrect")
  }
  problems.push(...await checkMdtoc(config, inspection.bins))
  return problems.map((problem) => `${problem} (${repair})`)
}

async function replaceOwnedLink(path: string, target: string): Promise<void> {
  if (await sameTarget(path, target)) return
  if (await exists(path)) {
    if (!(await lstat(path)).isSymbolicLink()) {
      throw new Error(`Refusing to replace non-symlink executable: ${path}`)
    }
    await rm(path)
  }
  await mkdir(dirname(path), { recursive: true })
  await symlink(target, path)
}

/** Remove only symlinks that still have the target previously recorded. */
async function removeOwnedLink(path: string, target: string): Promise<void> {
  if (!await exists(path) || !(await lstat(path)).isSymbolicLink()) return
  const old = await readlink(path)
  if (resolve(dirname(path), old) === target) await rm(path)
}

/** Reconcile the manifest, retaining the old global directory for rollback. */
export async function synchronize(config: Config): Promise<void> {
  const mismatch = await lockProblems(config)
  if (mismatch.length) throw new Error(mismatch.join("\n"))
  await ensureDiscord(config)
  const before = await inspectPackages(config)
  const previous = await readState(config)
  if (before.problems.length ||
      (await checkMdtoc(config, before.bins)).length ||
      previous?.lock !== await lockHash(config) ||
      previous?.manifest !== await readFile(
        join(config.globalDir, "package.json"), "utf8")) {
    await command([process.execPath, "install", "--cwd", config.globalDir,
      "--frozen-lockfile", "--ignore-scripts", "--force"], config.root)
  }
  const installed = await inspectPackages(config)
  const behavior = await checkMdtoc(config, installed.bins)
  if (installed.problems.length || behavior.length) {
    throw new Error([...installed.problems, ...behavior].join("\n"))
  }
  // Check command collisions before moving the existing installation.
  for (const name of Object.keys(installed.bins)) {
    const path = join(config.binDir, name)
    if (await exists(path) && !(await lstat(path)).isSymbolicLink()) {
      throw new Error(`Refusing to replace non-symlink executable: ${path}`)
    }
    if (await exists(path)) {
      const target = resolve(dirname(path), await readlink(path))
      if (!target.startsWith(config.runtimeDir + "/node_modules/") &&
          !target.startsWith(config.globalDir + "/node_modules/") &&
          target !== previous?.bins[name]) {
        throw new Error(`Refusing unrelated executable symlink: ${path} -> ${target}`)
      }
    }
  }
  const pluginPath = join(config.pluginDir, "ud-mdtoc")
  if (installed.bins["ud-mdtoc"] && await exists(pluginPath)) {
    if (!(await lstat(pluginPath)).isSymbolicLink()) {
      throw new Error(`Refusing non-symlink plugin: ${pluginPath}`)
    }
    const target = resolve(dirname(pluginPath), await readlink(pluginPath))
    if (target !== installed.bins["ud-mdtoc"] &&
        target !== join(config.binDir, "ud-mdtoc") &&
        target !== previous?.plugin) {
      throw new Error(`Refusing unrelated plugin symlink: ${pluginPath}`)
    }
  }
  const claudePath = join(config.binDir, "claude")
  if (await exists(claudePath)) {
    const info = await lstat(claudePath)
    const target = info.isSymbolicLink()
      ? resolve(dirname(claudePath), await readlink(claudePath)) : ""
    if (!target.includes("/node_modules/@anthropic-ai/claude-code/")) {
      throw new Error(`Unexpected competing Claude executable: ${claudePath}; ` +
        "preserve or remove it explicitly so native Claude can run")
    }
  }
  const needsLink = !await sameTarget(config.runtimeDir, config.globalDir)
  // Unmanaged commands may still traverse the directory being replaced.
  // Preserve their resolved packages rather than leave dangling links.
  const retained = new Map<string, string>()
  const oldRuntime = await realpath(config.runtimeDir).catch(() => undefined)
  const runtimeWasDirectory = await lstat(config.runtimeDir)
    .then((info) => info.isDirectory()).catch(() => false)
  if (needsLink) {
    for (const name of await readdir(config.binDir).catch(() => [])) {
      if (name in installed.bins || name in (previous?.bins ?? {}) ||
          name === "claude") continue
      const path = join(config.binDir, name)
      if (!(await lstat(path)).isSymbolicLink()) continue
      const target = await realpath(path).catch(() => undefined)
      const link = resolve(dirname(path), await readlink(path))
      if (target && link.startsWith(config.runtimeDir + "/")) {
        retained.set(path, target)
      }
    }
  }
  let backup: string | undefined
  const savedLinks = new Map<string, string | undefined>()
  async function saveLink(path: string): Promise<void> {
    if (!savedLinks.has(path)) {
      savedLinks.set(path, await exists(path) ? await readlink(path) : undefined)
    }
  }
  try {
    if (needsLink) {
      await mkdir(dirname(config.runtimeDir), { recursive: true })
      if (await exists(config.runtimeDir)) {
        backup = `${config.runtimeDir}.before-dotfiles-${Date.now()}`
        await rename(config.runtimeDir, backup)
      }
      await symlink(config.globalDir, config.runtimeDir)
    }
    for (const [path, target] of retained) {
      await saveLink(path)
      const preserved = backup && runtimeWasDirectory && oldRuntime &&
        target.startsWith(oldRuntime + "/")
        ? join(backup, relative(oldRuntime, target)) : target
      await replaceOwnedLink(path, preserved)
    }
    for (const [name, target] of Object.entries(installed.bins)) {
      const path = join(config.binDir, name)
      await saveLink(path)
      await replaceOwnedLink(path, target)
    }
    for (const [name, target] of Object.entries(previous?.bins ?? {})) {
      if (!(name in installed.bins)) {
        const path = join(config.binDir, name)
        if (!await exists(path) || !(await lstat(path)).isSymbolicLink()) continue
        await saveLink(path)
        await removeOwnedLink(path, target)
      }
    }
    const plugin = join(config.pluginDir, "ud-mdtoc")
    if (installed.bins["ud-mdtoc"]) {
      await saveLink(plugin)
      await replaceOwnedLink(plugin, installed.bins["ud-mdtoc"]!)
    } else if (previous?.plugin && await exists(plugin) &&
        (await lstat(plugin)).isSymbolicLink()) {
      await saveLink(plugin)
      await removeOwnedLink(plugin, previous.plugin)
    }
    // Retire only the known npm Claude link, leaving the native CLI alone.
    const oldClaude = join(config.binDir, "claude")
    if (await exists(oldClaude) && (await lstat(oldClaude)).isSymbolicLink()) {
      const target = resolve(dirname(oldClaude), await readlink(oldClaude))
      if (target.includes("/node_modules/@anthropic-ai/claude-code/")) {
        await saveLink(oldClaude)
        await rm(oldClaude)
      }
    }
    await writeFile(join(config.globalDir, ".installed.json"),
      JSON.stringify({ bins: installed.bins,
        plugin: installed.bins["ud-mdtoc"],
        manifest: await readFile(join(config.globalDir, "package.json"), "utf8"),
        lock: await lockHash(config),
      } satisfies InstalledState, null, 2) + "\n")
    if (backup) console.log(`Previous Bun installation retained at ${backup}`)
  } catch (error) {
    for (const [path, target] of savedLinks) {
      if (await exists(path)) await rm(path, { force: true })
      if (target !== undefined) await symlink(target, path)
    }
    if (needsLink) {
      await rm(config.runtimeDir, { force: true })
      if (backup) await rename(backup, config.runtimeDir)
    }
    throw error
  }
}

/** Update the committed lock only after an intentional manifest edit. */
export async function refreshLock(config: Config): Promise<void> {
  await ensureDiscord(config)
  await command([process.execPath, "install", "--cwd", config.globalDir,
    "--lockfile-only", "--ignore-scripts"], config.root)
}

/** Activate only a release that already exists on the npm registry. */
export async function activateMdtoc(
  config: Config, version: string,
): Promise<void> {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error("Supply an exact ud-mdtoc release version")
  }
  const result = await fetch(`https://registry.npmjs.org/${
    encodeURIComponent(mdtocPackage)}/${encodeURIComponent(version)}`)
  if (!result.ok) {
    throw new Error(`${mdtocPackage}@${version} is not published; ` +
      "publish with the package's just publish recipe first")
  }
  const published = await result.json() as Package
  if (published.name !== mdtocPackage || published.version !== version ||
      !("ud-mdtoc" in packageBins(published))) {
    throw new Error("Published package has unexpected name, version, or bin")
  }
  const path = join(config.globalDir, "package.json")
  const original = await readFile(path, "utf8")
  const lockPath = join(config.globalDir, "bun.lock")
  const originalLock = await readFile(lockPath).catch(() => undefined)
  const desired = JSON.parse(original) as Package
  desired.dependencies = { ...desired.dependencies, [mdtocPackage]: version }
  await writeFile(path, JSON.stringify(desired, null, 2) + "\n")
  try { await refreshLock(config) } catch (error) {
    await writeFile(path, original)
    if (originalLock) await writeFile(lockPath, originalLock)
    else await rm(lockPath, { force: true })
    throw error
  }
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2)
    const config = await configuration()
    if (args.length === 1 && args[0] === "--check") {
      const problems = await check(config)
      if (problems.length) throw new Error(problems.join("\n"))
      console.log("Bun tools: manifest, packages, executables, and plugins match")
    } else if (args.length === 1 && args[0] === "--run") {
      await synchronize(config)
      console.log("Bun tools: installation and links restored")
    } else if (args.length === 1 && args[0] === "--lock") {
      await refreshLock(config)
      console.log("Bun lock refreshed; review the diff, then run just bun-sync")
    } else if (args.length === 2 && args[0] === "--activate-mdtoc") {
      await activateMdtoc(config, args[1]!)
      console.log("ud-mdtoc release pinned; run just bun-sync")
    } else {
      throw new Error("Usage: bun --no-install bun/sync.ts " +
        "--check | --run | --lock | --activate-mdtoc VERSION")
    }
  } catch (error) {
    console.error(String(error))
    process.exitCode = 1
  }
}
