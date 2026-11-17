import { bash } from "@uniquedivine/bash"
import { constants } from "node:fs"
import {
  access, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm,
  stat, symlink, writeFile,
} from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { tmpdir } from "node:os"
import { parse as parseToml } from "smol-toml"

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

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true } catch { return false }
}

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK)
    return (await stat(path)).isFile()
  } catch { return false }
}

/**
 * Real path of `path`, or its resolved text when it does not exist. Links made
 * through a symlinked checkout path (old path -> new path) name the same files
 * as links made through the real path, so ownership checks compare these.
 */
async function canonicalPath(path: string): Promise<string> {
  return realpath(path).catch(() => resolve(path))
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
    runtimeDir, binDir,
    pluginDir: join(env.XDG_DATA_HOME ?? join(home, ".local", "share"),
      "ud", "plugins"),
    env,
  }
}

/**
 * The `bun/` directory of the checkout that owns the live installation:
 * `$DOTFILES/bun`, as `symlinks.sh` links from `$DOTFILES`. Falls back to the
 * script's own directory only when `DOTFILES` is unset.
 */
export function installRoot(
  env: Environment = process.env, scriptDir = dirname(import.meta.path),
): string {
  return env.DOTFILES ? resolve(env.DOTFILES, "bun") : resolve(scriptDir)
}

/**
 * Refuse `--run` from a checkout other than `$DOTFILES`, such as a PR
 * worktree, unless `allowOther` is set. Following a repair hint there would
 * otherwise look like it restores this checkout's tools while it changes the
 * live installation. With `allowOther`, sync still installs from `$DOTFILES`.
 */
export async function runCheckoutProblem(
  env: Environment = process.env, scriptDir = dirname(import.meta.path),
  allowOther = false,
): Promise<string | undefined> {
  if (allowOther || !env.DOTFILES) return undefined
  const canonical = async (path: string): Promise<string> =>
    realpath(path).catch(() => resolve(path))
  const live = await canonical(installRoot(env, scriptDir))
  const here = await canonical(scriptDir)
  if (live === here) return undefined
  return `Refusing --run: this script is in ${dirname(here)}, but ` +
    `DOTFILES is ${dirname(live)}. Run just bun-sync from $DOTFILES, or ` +
    "pass --allow-other-checkout to sync $DOTFILES from here."
}

/** An exact registry release, such as 1.2.3 or 1.2.3-beta.1. */
export const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

/** A specifier that names a file on one machine rather than a release. */
function machinePath(spec: string): boolean {
  return /^(file:|link:|\/|\.\.?\/|~\/)/.test(spec) ||
    /\.(tgz|tar\.gz)$/.test(spec)
}

/**
 * Every managed dependency must be an exact registry release. `bun add -g`
 * writes ranges such as `^2.21.2` and local tarball paths into the tracked
 * manifest; a range lets the lock drift, and a path breaks other machines.
 * Each problem names the package and the one command that fixes it.
 */
export function manifestPolicyProblems(pkg: Package): string[] {
  const problems: string[] = []
  for (const [name, spec] of Object.entries(pkg.dependencies ?? {})) {
    if (exactVersion.test(spec)) continue
    if (machinePath(spec)) {
      problems.push(`${name}: "${spec}" is a path on this machine, not a ` +
        "registry release; run git checkout -- bun/global")
      continue
    }
    const version = spec.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/)?.[0]
    problems.push(`${name}: "${spec}" is not an exact version; run ` +
      `just bun-add ${name}@${version ?? "VERSION"}`)
  }
  return problems
}

/**
 * Per-package differences between the manifest and the lock's root
 * workspace, each with both specifiers and one command that reconciles them.
 * Packages in `skip` already have a policy problem with its own fix.
 */
export function driftProblems(
  desired: Record<string, string>, locked: Record<string, string>,
  skip = new Set<string>(),
): string[] {
  const problems: string[] = []
  const names = [...new Set([...Object.keys(desired), ...Object.keys(locked)])]
    .sort((a, b) => a.localeCompare(b))
  for (const name of names) {
    if (skip.has(name) || desired[name] === locked[name]) continue
    if (locked[name] === undefined) {
      problems.push(`${name}: package.json has ${desired[name]}, bun.lock ` +
        `has none; run just bun-add ${name}@${desired[name]}`)
    } else if (desired[name] === undefined) {
      problems.push(`${name}: bun.lock has ${locked[name]}, package.json ` +
        `has none; run just bun-drop ${name}`)
    } else {
      problems.push(`${name}: package.json has ${desired[name]}, bun.lock ` +
        `has ${locked[name]}; run just bun-add ${name}@${desired[name]}`)
    }
  }
  return problems
}

/**
 * The manifest must follow the exact-pin policy and agree with the lock
 * before sync changes an installation. Reads only the two committed files.
 */
export async function lockProblems(config: Config): Promise<string[]> {
  try {
    const pkg = await manifest(config)
    const policy = manifestPolicyProblems(pkg)
    const flagged = new Set(policy.map((problem) => problem.split(": ")[0]!))
    const lock = Bun.JSON5.parse(await readFile(
      join(config.globalDir, "bun.lock"), "utf8")) as {
      workspaces?: Record<string, { dependencies?: Record<string, string> }>
    }
    const locked = lock.workspaces?.[""]?.dependencies ?? {}
    return [...policy,
      ...driftProblems(pkg.dependencies ?? {}, locked, flagged)]
  } catch (error) {
    return [`Bun manifest or lockfile is unavailable or invalid: ${error}; ` +
      "run git checkout -- bun/global"]
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

/**
 * Inspect the dependency tree without invoking package code or the registry.
 * A package with no bun.lock record passes at any version within its
 * parent's range.
 */
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

/**
 * PATH shadowing only: `name` resolves to a file outside `binDir`, or to
 * nothing while the managed link exists. A wrong or missing link in `binDir`
 * is reported separately; comparing PATH with the link's target instead made
 * health print "PATH resolves X to <bin>, expected <bin>" when only the link
 * was wrong.
 */
export async function pathShadowProblem(
  name: string, binDir: string, env: Environment,
): Promise<string | undefined> {
  const bin = join(binDir, name)
  const resolved = Bun.which(name, { PATH: env.PATH ?? "" })
  if (resolved) {
    if (await canonicalPath(dirname(resolved)) === await canonicalPath(binDir)) {
      return undefined
    }
  } else if (!await exists(bin)) {
    return undefined
  }
  return `PATH resolves ${name} to ${resolved ?? "nothing"}, expected ${bin}; ` +
    `put ${binDir} before competing tools on PATH`
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
  // Lock problems carry their own fix command; sync cannot repair them.
  const lock = await lockProblems(config)
  const problems: string[] = []
  const inspection = await inspectPackages(config)
  problems.push(...inspection.problems)
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
    const shadow = await pathShadowProblem(name, config.binDir, config.env)
    if (shadow) problems.push(shadow)
  }
  if (inspection.bins["ud-mdtoc"] && !await sameTarget(
    join(config.pluginDir, "ud-mdtoc"), inspection.bins["ud-mdtoc"]!)) {
    problems.push("ud mdtoc plugin link is missing or incorrect")
  }
  problems.push(...await checkMdtoc(config, inspection.bins))
  return [...lock, ...problems.map((problem) => `${problem} (${repair})`)]
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
  const ownedModules = [
    (await canonicalPath(config.runtimeDir)) + "/node_modules/",
    (await canonicalPath(config.globalDir)) + "/node_modules/",
  ]
  for (const name of Object.keys(installed.bins)) {
    const path = join(config.binDir, name)
    if (await exists(path) && !(await lstat(path)).isSymbolicLink()) {
      throw new Error(`Refusing to replace non-symlink executable: ${path}`)
    }
    if (await exists(path)) {
      const target = resolve(dirname(path), await readlink(path))
      const realTarget = await canonicalPath(target)
      const previousBin = previous?.bins[name]
      if (!ownedModules.some((dir) => realTarget.startsWith(dir)) &&
          target !== previousBin &&
          !(previousBin && realTarget === await canonicalPath(previousBin))) {
        throw new Error(`Refusing unrelated executable symlink: ${path} -> ${target}`)
      }
    }
  }
  const pluginPath = join(config.pluginDir, "ud-mdtoc")
  if (installed.bins["ud-mdtoc"] && await exists(pluginPath)) {
    if (!(await lstat(pluginPath)).isSymbolicLink()) {
      throw new Error(`Refusing non-symlink plugin: ${pluginPath}`)
    }
    const target = await canonicalPath(
      resolve(dirname(pluginPath), await readlink(pluginPath)))
    const owned = [
      installed.bins["ud-mdtoc"], join(config.binDir, "ud-mdtoc"),
      previous?.plugin,
    ].filter((path): path is string => Boolean(path))
    const ownedReal = await Promise.all(owned.map(canonicalPath))
    if (!owned.includes(target) && !ownedReal.includes(target)) {
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

async function writeLock(config: Config): Promise<void> {
  await command([process.execPath, "install", "--cwd", config.globalDir,
    "--lockfile-only", "--ignore-scripts"], config.root)
}

/**
 * Update the committed lock only after an intentional manifest edit. Refuses
 * a manifest that breaks the exact-pin policy, so a range never reaches the
 * lock.
 */
export async function refreshLock(config: Config): Promise<void> {
  const policy = manifestPolicyProblems(await manifest(config))
  if (policy.length) throw new Error(policy.join("\n"))
  await writeLock(config)
}

/**
 * Apply `edit` to the managed manifest and refresh the lock, restoring both
 * files if the refresh fails or `accept` rejects the new lock. Other packages
 * are not policy-checked here, so each problem `--check` lists can be fixed
 * with its own command.
 */
async function editManifest(
  config: Config, edit: (dependencies: Record<string, string>) => void,
  accept: () => Promise<string | undefined> = async () => undefined,
): Promise<void> {
  const path = join(config.globalDir, "package.json")
  const original = await readFile(path, "utf8")
  const lockPath = join(config.globalDir, "bun.lock")
  const originalLock = await readFile(lockPath).catch(() => undefined)
  const desired = JSON.parse(original) as Package
  desired.dependencies = { ...desired.dependencies }
  edit(desired.dependencies)
  await writeFile(path, JSON.stringify(desired, null, 2) + "\n")
  try {
    await writeLock(config)
    const rejected = await accept()
    if (rejected) throw new Error(rejected)
  } catch (error) {
    await writeFile(path, original)
    if (originalLock) await writeFile(lockPath, originalLock)
    else await rm(lockPath, { force: true })
    throw error
  }
}

/** Split `name@1.2.3` or `@scope/name@1.2.3` into a name and exact version. */
export function parseSpec(spec: string): { name: string; version: string } {
  const at = spec.lastIndexOf("@")
  const name = at > 0 ? spec.slice(0, at) : ""
  const version = at > 0 ? spec.slice(at + 1) : ""
  if (!/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(name) ||
      !exactVersion.test(version)) {
    throw new Error(`Supply NAME@VERSION with an exact version, such as ` +
      `prettier@3.9.6; got ${spec}`)
  }
  return { name, version }
}

/**
 * Pin an exact registry release in the managed manifest and refresh the
 * lock. Bun's own resolution is the release check, so it uses the same
 * registry and credentials as every other install, including those in
 * bunfig.toml. `verify` may reject the locked package metadata. Nothing
 * changes unless Bun locks exactly `name@version` and `verify` accepts it.
 */
export async function adoptPackage(
  config: Config, name: string, version: string,
  verify: (locked: Package) => string | undefined = () => undefined,
): Promise<void> {
  parseSpec(`${name}@${version}`)
  try {
    await editManifest(config, (dependencies) => {
      dependencies[name] = version
    }, async () => {
      const lock = Bun.JSON5.parse(await readFile(
        join(config.globalDir, "bun.lock"), "utf8")) as {
        packages?: Record<string, unknown[]>
      }
      const entry = lock.packages?.[name]
      if (entry?.[0] !== `${name}@${version}`) {
        return `bun.lock does not record ${name}@${version}`
      }
      const info = entry.find((part): part is Package =>
        typeof part === "object" && part !== null && !Array.isArray(part))
      return verify({ ...info, name, version })
    })
  } catch (error) {
    throw new Error(`Could not adopt ${name}@${version}; nothing changed: ${
      error}`)
  }
}

/** Remove a package from the managed manifest and refresh the lock. */
export async function dropPackage(config: Config, name: string): Promise<void> {
  await editManifest(config, (dependencies) => { delete dependencies[name] })
}

/** Activate only a release that already exists on the npm registry. */
export async function activateMdtoc(
  config: Config, version: string,
): Promise<void> {
  if (!exactVersion.test(version)) {
    throw new Error("Supply an exact ud-mdtoc release version")
  }
  await adoptPackage(config, mdtocPackage, version, (published) =>
    "ud-mdtoc" in packageBins(published) ? undefined
      : "Published package does not declare the ud-mdtoc executable")
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2)
    const allowOther = args.includes("--allow-other-checkout")
    const rest = args.filter((arg) => arg !== "--allow-other-checkout")
    // --check and --run act on the live installation, so they read
    // $DOTFILES. --lock, --add, --drop, and --activate-mdtoc edit files in
    // this checkout; --policy reads them.
    const live = () => configuration(installRoot())
    const local = () => configuration()
    if (rest.length === 1 && rest[0] === "--check") {
      const problems = await check(await live())
      if (problems.length) throw new Error(problems.join("\n"))
      console.log("Bun tools: manifest, packages, executables, and plugins match")
    } else if (rest.length === 1 && rest[0] === "--run") {
      const problem = await runCheckoutProblem(process.env,
        dirname(import.meta.path), allowOther)
      if (problem) throw new Error(problem)
      await synchronize(await live())
      console.log("Bun tools: installation and links restored")
    } else if (rest.length === 1 && rest[0] === "--lock") {
      await refreshLock(await local())
      console.log("Bun lock refreshed; review the diff, then run just bun-sync")
    } else if (rest.length === 1 && rest[0] === "--policy") {
      const problems = await lockProblems(await local())
      if (problems.length) throw new Error(problems.join("\n"))
      console.log("Bun manifest: exact pins that match bun.lock")
    } else if (rest.length === 2 && rest[0] === "--add") {
      const { name, version } = parseSpec(rest[1]!)
      await adoptPackage(await local(), name, version)
      console.log(`${name}@${version} pinned; review the diff, then run ` +
        "just bun-sync")
    } else if (rest.length === 2 && rest[0] === "--drop") {
      await dropPackage(await local(), rest[1]!)
      console.log(`${rest[1]} removed; review the diff, then run just bun-sync`)
    } else if (rest.length === 2 && rest[0] === "--activate-mdtoc") {
      await activateMdtoc(await local(), rest[1]!)
      console.log("ud-mdtoc release pinned; run just bun-sync")
    } else {
      throw new Error("Usage: bun --no-install bun/sync.ts " +
        "--check | --run [--allow-other-checkout] | --lock | --policy | " +
        "--add NAME@VERSION | --drop NAME | --activate-mdtoc VERSION")
    }
  } catch (error) {
    console.error(String(error))
    process.exitCode = 1
  }
}
