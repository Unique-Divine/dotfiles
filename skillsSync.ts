import { createHash } from "node:crypto"
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
} from "node:fs/promises"
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path"
import { bash } from "@uniquedivine/bash"
import { Command } from "commander"
import matter from "gray-matter"

/**
 * Named ANSI foreground codes, the only colors this script prints.
 *
 * Why named codes: each one picks a palette slot (code minus 30), not a
 * color. The reader's terminal theme decides what that slot looks like, so
 * the output matches whatever theme they chose: onedark yellow in a onedark
 * terminal, a darker yellow that stays readable in a light theme, and a new
 * palette when the terminal swaps themes with the system's light or dark
 * mode. Hardcoded RGB would ignore the theme and assume a background.
 *
 * `RESET` restores the default foreground color.
 */
export const ANSI_COLOR = {
  BLACK: 30,
  RED: 31,
  GREEN: 32,
  YELLOW: 33,
  BLUE: 34,
  MAGENTA: 35,
  CYAN: 36,
  WHITE: 37,
  RESET: 39,
} as const

type AnsiColorName = Exclude<keyof typeof ANSI_COLOR, "RESET">

/**
 * What each color means in terminal output. Use names from `ANSI_COLOR`
 * (see there for why), never 24-bit RGB such as `\x1b[38;2;R;G;Bm`.
 *
 * Keep color sparse so a warning stands out: secondary text stays in the
 * default color (no gray or dim), and each role below has one meaning.
 * - `warning` (yellow): something to review, such as a diverged team export.
 * - `success` (green): the label of a final summary line, after a 💚; the
 *   details that follow stay plain.
 * - `command` (cyan): a command or flag to run, such as `--run`. Paths
 *   stay in the default color.
 */
export const TERM_COLORS = {
  warning: "YELLOW",
  success: "GREEN",
  command: "CYAN",
} as const satisfies Record<string, AnsiColorName>

type TermColor = keyof typeof TERM_COLORS

/** Whether to color a stream: NO_COLOR wins, FORCE_COLOR forces, else a TTY. */
export const colorEnabled = (
  env: Record<string, string | undefined>,
  isTTY: boolean | undefined,
): boolean => {
  if (env.NO_COLOR) return false
  if (env.FORCE_COLOR && env.FORCE_COLOR !== "0") return true
  return isTTY === true && env.TERM !== "dumb"
}

/** Wrap text in a named ANSI foreground color, or return it unchanged. */
export const paint = (
  text: string,
  color: TermColor,
  enabled: boolean,
): string => {
  if (!enabled) return text
  const code = ANSI_COLOR[TERM_COLORS[color]]
  return `\x1b[${code}m${text}\x1b[${ANSI_COLOR.RESET}m`
}

const stdoutColor = (): boolean =>
  colorEnabled(process.env, process.stdout.isTTY)
const stderrColor = (): boolean =>
  colorEnabled(process.env, process.stderr.isTTY)

interface SkillsConfig {
  claudeSkillsDir: string
  cursorSkillsDir: string
  codexSkillsDir: string
  repoRootDir: string
  unionSkillsDir: string
  linkedSources: readonly LinkedSkillSource[]
}

interface LinkedSkillSource {
  label: string
  skillsDir: string
}

interface TeamSkillExport {
  checkoutDir: string
  ghRepo: string
  name: string
  sourceDir: string
}

interface ResolvedTeamSkillExport extends TeamSkillExport {
  destinationDir: string
  discoveryDir: string
  repositoryRoot: string
  skillsDir: string
}

interface SkillsSyncOptions {
  health?: boolean
  migrate?: boolean
  run?: boolean
}

const defaultConfig = (env: NodeJS.ProcessEnv): SkillsConfig => {
  if (!env.HOME) throw new Error("HOME is not set")
  if (!env.REPO) throw new Error("REPO is not set")

  const bokuDir = resolve(env.REPO, "boku")
  return {
    claudeSkillsDir: resolve(env.HOME, ".claude/skills"),
    cursorSkillsDir: resolve(env.HOME, ".cursor/skills"),
    codexSkillsDir: resolve(env.HOME, ".agents/skills"),
    repoRootDir: resolve(env.REPO),
    unionSkillsDir: resolve(bokuDir, "priv-skills"),
    linkedSources: [
      {
        label: "boku-public",
        skillsDir: resolve(bokuDir, "jiyuu/ai-skills"),
      },
    ],
  }
}

const isMissing = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException).code === "ENOENT"

const sorted = (names: Iterable<string>): string[] => [...names].sort()

const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", `'"'"'`)}'`

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}

const skillNames = async (dir: string): Promise<Set<string>> => {
  const entries = await readdir(dir, { withFileTypes: true })
  const names = new Set<string>()

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    try {
      const skillFile = await lstat(join(dir, entry.name, "SKILL.md"))
      if (skillFile.isFile()) names.add(entry.name)
    } catch (error) {
      if (!isMissing(error)) throw error
    }
  }

  return names
}

const resolvesTo = async (path: string, expected: string): Promise<boolean> => {
  try {
    return resolve(dirname(path), await readlink(path)) === resolve(expected)
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}

const linkedSkillTargets = async (
  sources: readonly LinkedSkillSource[],
): Promise<Map<string, string>> => {
  const targets = new Map<string, string>()
  const owners = new Map<string, string>()

  for (const source of sources) {
    const names = await skillNames(source.skillsDir)
    for (const name of names) {
      const previousOwner = owners.get(name)
      if (previousOwner) {
        throw new Error(
          `Linked skill name collision: ${name} is exported by ` +
            `${previousOwner} and ${source.label}`,
        )
      }
      owners.set(name, source.label)
      targets.set(name, join(source.skillsDir, name))
    }
  }

  return targets
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const resolveCheckoutDir = (
  cfg: SkillsConfig,
  ghRepo: string,
  repoDirValue: unknown,
): string => {
  const defaultRepoDir = basename(ghRepo)
  const repoDir = repoDirValue ?? defaultRepoDir
  if (typeof repoDir !== "string" || !repoDir.trim()) {
    throw new Error("metadata.repo-dir must be a non-empty string")
  }
  if (isAbsolute(repoDir)) {
    throw new Error("metadata.repo-dir must be relative to REPO")
  }

  const checkoutDir = resolve(cfg.repoRootDir, repoDir)
  const checkoutRelative = relative(cfg.repoRootDir, checkoutDir)
  if (
    !checkoutRelative ||
    checkoutRelative === ".." ||
    checkoutRelative.startsWith(`..${sep}`) ||
    isAbsolute(checkoutRelative)
  ) {
    throw new Error("metadata.repo-dir must resolve beneath REPO")
  }
  return checkoutDir
}

const teamSkillExports = async (
  cfg: SkillsConfig,
): Promise<TeamSkillExport[]> => {
  const exports: TeamSkillExport[] = []
  const entries = await readdir(cfg.unionSkillsDir, { withFileTypes: true })

  for (const entry of entries) {
    if (entry.name.startsWith(".") || !entry.isDirectory()) continue
    const sourceDir = join(cfg.unionSkillsDir, entry.name)
    const skillFile = join(sourceDir, "SKILL.md")
    if (!(await pathExists(skillFile))) continue

    const frontmatter = matter(await readFile(skillFile, "utf8")).data
    const metadata = frontmatter.metadata
    if (!isRecord(metadata)) continue
    if (
      metadata["repo-dir"] !== undefined &&
      metadata["gh-repo"] === undefined
    ) {
      throw new Error(
        `Skill ${entry.name} metadata.repo-dir requires metadata.gh-repo`,
      )
    }
    if (metadata["gh-repo"] === undefined) continue

    if (metadata.private !== true) {
      throw new Error(
        `Skill ${entry.name} must set metadata.private: true when ` +
          "metadata.gh-repo is present",
      )
    }
    const ghRepo = metadata["gh-repo"]
    if (
      typeof ghRepo !== "string" ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(ghRepo)
    ) {
      throw new Error(
        `Skill ${entry.name} metadata.gh-repo must use owner/repository form`,
      )
    }
    exports.push({
      checkoutDir: resolveCheckoutDir(cfg, ghRepo, metadata["repo-dir"]),
      ghRepo,
      name: entry.name,
      sourceDir,
    })
  }

  return exports
}

const commandOutput = async (
  command: string,
  failureMessage: string,
): Promise<string> => {
  const result = await bash(command)
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim()
    throw new Error(detail ? `${failureMessage}: ${detail}` : failureMessage)
  }
  return result.stdout.trim()
}

const normalizeGitHubRemote = (remote: string): string | undefined => {
  const prefixes = [
    "git@github.com:",
    "ssh://git@github.com/",
    "https://github.com/",
    "http://github.com/",
  ]
  const prefix = prefixes.find((candidate) =>
    remote.toLowerCase().startsWith(candidate),
  )
  if (!prefix) return undefined

  const slug = remote
    .slice(prefix.length)
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
  return /^[^/]+\/[^/]+$/.test(slug) ? slug : undefined
}

const validateExportPaths = async (
  skillExport: ResolvedTeamSkillExport,
): Promise<void> => {
  if (await pathExists(skillExport.skillsDir)) {
    const skillsInfo = await lstat(skillExport.skillsDir)
    if (!skillsInfo.isDirectory() || skillsInfo.isSymbolicLink()) {
      throw new Error(
        `Repository skills path is not a real directory: ${skillExport.skillsDir}`,
      )
    }
  }

  if (await pathExists(skillExport.destinationDir)) {
    const destinationInfo = await lstat(skillExport.destinationDir)
    if (destinationInfo.isSymbolicLink()) {
      throw new Error(
        "Refusing to replace symlinked team skill export: " +
          skillExport.destinationDir,
      )
    }
  }

  if (!(await pathExists(skillExport.discoveryDir))) return
  const discoveryInfo = await lstat(skillExport.discoveryDir)
  if (!discoveryInfo.isSymbolicLink()) {
    throw new Error(
      `Repository skill discovery path is not a symlink: ${skillExport.discoveryDir}`,
    )
  }
  if (!(await resolvesTo(skillExport.discoveryDir, skillExport.skillsDir))) {
    throw new Error(
      "Repository skill discovery link has unexpected target: " +
        skillExport.discoveryDir,
    )
  }
}

const resolveTeamSkillExports = async (
  exports: readonly TeamSkillExport[],
): Promise<ResolvedTeamSkillExport[]> => {
  const resolvedExports: ResolvedTeamSkillExport[] = []

  for (const skillExport of exports) {
    if (!(await pathExists(skillExport.checkoutDir))) {
      console.log(
        `Skipping team skill export ${skillExport.name}; checkout is missing: ` +
          skillExport.checkoutDir,
      )
      continue
    }
    const checkoutInfo = await stat(skillExport.checkoutDir)
    if (!checkoutInfo.isDirectory()) {
      throw new Error(
        `Team repository checkout is not a directory: ${skillExport.checkoutDir}`,
      )
    }

    const repositoryRootOutput = await commandOutput(
      `git -C ${shellQuote(skillExport.checkoutDir)} rev-parse --show-toplevel`,
      `Team repository checkout is not a Git repository: ${skillExport.checkoutDir}`,
    )
    const repositoryRoot = await realpath(repositoryRootOutput)
    if ((await realpath(skillExport.checkoutDir)) !== repositoryRoot) {
      throw new Error(
        `Team repository checkout must name its Git root: ${skillExport.checkoutDir}`,
      )
    }

    const remote = await commandOutput(
      `git -C ${shellQuote(repositoryRoot)} remote get-url origin`,
      `Team repository checkout has no origin remote: ${repositoryRoot}`,
    )
    const actualGhRepo = normalizeGitHubRemote(remote)
    if (actualGhRepo?.toLowerCase() !== skillExport.ghRepo.toLowerCase()) {
      throw new Error(
        `Team repository origin ${remote} does not match metadata.gh-repo ` +
          skillExport.ghRepo,
      )
    }

    const skillsDir = join(repositoryRoot, "ai-skills")
    const resolvedExport: ResolvedTeamSkillExport = {
      ...skillExport,
      destinationDir: join(skillsDir, skillExport.name),
      discoveryDir: join(repositoryRoot, ".agents/skills"),
      repositoryRoot,
      skillsDir,
    }
    await validateExportPaths(resolvedExport)
    resolvedExports.push(resolvedExport)
  }

  return resolvedExports
}

/** Relative path -> entry signature (kind, mode, digest or link target). */
type DirectorySnapshot = Map<string, string>

const directorySnapshot = async (
  root: string,
): Promise<DirectorySnapshot | undefined> => {
  if (!(await pathExists(root))) return undefined
  const snapshot: DirectorySnapshot = new Map()
  const rootInfo = await lstat(root)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return snapshot

  const walk = async (dir: string, prefix: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))

    for (const entry of entries) {
      const path = join(dir, entry.name)
      const relativePath = join(prefix, entry.name)
      const info = await lstat(path)
      const mode = (info.mode & 0o777).toString(8)
      if (info.isDirectory()) {
        snapshot.set(relativePath, `d ${mode}`)
        await walk(path, relativePath)
      } else if (info.isFile()) {
        const digest = createHash("sha256")
          .update(await readFile(path))
          .digest("hex")
        snapshot.set(relativePath, `f ${mode} ${digest}`)
      } else if (info.isSymbolicLink()) {
        snapshot.set(relativePath, `l ${await readlink(path)}`)
      } else {
        throw new Error(`Unsupported file in skill export: ${path}`)
      }
    }
  }

  await walk(root, "")
  return snapshot
}

export interface SnapshotDiff {
  changed: string[]
  onlyRepo: string[]
  onlySource: string[]
}

/** Paths that differ between the private source and the repository copy. */
export const diffSnapshots = (
  source: DirectorySnapshot,
  repo: DirectorySnapshot,
): SnapshotDiff => {
  const diff: SnapshotDiff = { changed: [], onlyRepo: [], onlySource: [] }
  for (const [path, signature] of source) {
    const repoSignature = repo.get(path)
    if (repoSignature === undefined) diff.onlySource.push(path)
    else if (repoSignature !== signature) diff.changed.push(path)
  }
  for (const path of repo.keys()) {
    if (!source.has(path)) diff.onlyRepo.push(path)
  }
  for (const paths of Object.values(diff)) paths.sort()
  return diff
}

/**
 * Export a private skill into its team repository, never overwriting it.
 *
 * A missing repository copy is created on --run and fails --health. A copy
 * that diverges from the private source is left alone: the repository version
 * is what teammates share, so divergence is reported as one JSONL warning on
 * stderr and does not fail --health.
 */
const syncTeamSkillExport = async (
  skillExport: ResolvedTeamSkillExport,
  apply: boolean,
): Promise<{ healthy: boolean; diverged: boolean }> => {
  const sourceSnapshot = await directorySnapshot(skillExport.sourceDir)
  if (!sourceSnapshot) {
    throw new Error(`Team skill source is missing: ${skillExport.sourceDir}`)
  }
  const destinationSnapshot = await directorySnapshot(
    skillExport.destinationDir,
  )

  if (destinationSnapshot) {
    const diff = diffSnapshots(sourceSnapshot, destinationSnapshot)
    const diverged =
      diff.changed.length + diff.onlyRepo.length + diff.onlySource.length > 0
    if (diverged) {
      const line = JSON.stringify({
          level: "warn",
          event: "team_skill_export_diverged",
          skill: skillExport.name,
          ghRepo: skillExport.ghRepo,
          source: skillExport.sourceDir,
          destination: skillExport.destinationDir,
          changed: diff.changed,
          onlySource: diff.onlySource,
          onlyRepo: diff.onlyRepo,
      })
      // Color only on a terminal so piped stderr stays plain JSONL.
      console.warn(paint(line, "warning", stderrColor()))
    }
    return { healthy: true, diverged }
  }

  console.log(`Team skill export missing: ${skillExport.destinationDir}`)
  if (!apply) return { healthy: false, diverged: false }

  await mkdir(skillExport.skillsDir, { recursive: true })
  const temporaryDir = await mkdtemp(
    join(skillExport.skillsDir, `.${skillExport.name}.sync-`),
  )
  const stagedSkill = join(temporaryDir, skillExport.name)
  try {
    await cp(skillExport.sourceDir, stagedSkill, {
      recursive: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    })
    await rename(stagedSkill, skillExport.destinationDir)
  } finally {
    await rm(temporaryDir, { force: true, recursive: true })
  }
  return { healthy: true, diverged: false }
}

const canonicalSkillNames = async (dir: string): Promise<Set<string>> => {
  const names = new Set<string>()
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name.startsWith(".") || !entry.isDirectory()) continue
    try {
      const skillFile = await lstat(join(dir, entry.name, "SKILL.md"))
      if (skillFile.isFile()) names.add(entry.name)
    } catch (error) {
      if (!isMissing(error)) throw error
    }
  }
  return names
}

const syncRepositoryDiscovery = async (
  discoveryDir: string,
  skillsDir: string,
  apply: boolean,
): Promise<boolean> => {
  try {
    const info = await lstat(discoveryDir)
    if (!info.isSymbolicLink()) {
      throw new Error(
        `Repository skill discovery path is not a symlink: ${discoveryDir}`,
      )
    }
    if (!(await resolvesTo(discoveryDir, skillsDir))) {
      throw new Error(
        `Repository skill discovery link has unexpected target: ${discoveryDir}`,
      )
    }
    return true
  } catch (error) {
    if (!isMissing(error)) throw error
  }

  console.log(`Missing repository skill discovery link: ${discoveryDir}`)
  if (apply) {
    await mkdir(dirname(discoveryDir), { recursive: true })
    await symlink(
      relative(dirname(discoveryDir), skillsDir),
      discoveryDir,
      "dir",
    )
  }
  return false
}

const syncUnion = async (
  cfg: SkillsConfig,
  targets: ReadonlyMap<string, string>,
  apply: boolean,
): Promise<boolean> => {
  const canonicalNames = await canonicalSkillNames(cfg.unionSkillsDir)
  let healthy = true

  for (const [name, sourcePath] of targets) {
    const unionPath = join(cfg.unionSkillsDir, name)
    const relativeTarget = relative(dirname(unionPath), sourcePath)
    try {
      const info = await lstat(unionPath)
      if (info.isSymbolicLink()) {
        if (!(await resolvesTo(unionPath, sourcePath))) {
          throw new Error(`Linked skill has unexpected target: ${unionPath}`)
        }
        continue
      }

      if (
        info.isFile() &&
        (await readFile(unionPath, "utf8")) === relativeTarget
      ) {
        healthy = false
        console.log(`Git-materialized linked skill: ${unionPath}`)
        if (apply) {
          await rm(unionPath)
          await symlink(relativeTarget, unionPath, "dir")
        }
        continue
      }

      throw new Error(
        `Linked/private skill name collision: ${name} is not the expected ` +
          `symlink in ${cfg.unionSkillsDir}`,
      )
    } catch (error) {
      if (!isMissing(error)) throw error
      healthy = false
      console.log(`Missing linked skill: ${unionPath}`)
      if (apply) {
        await symlink(relativeTarget, unionPath, "dir")
      }
    }
  }

  const unionEntries = await readdir(cfg.unionSkillsDir, {
    withFileTypes: true,
  })
  for (const entry of unionEntries) {
    if (!entry.isSymbolicLink() || targets.has(entry.name)) continue

    const unionPath = join(cfg.unionSkillsDir, entry.name)
    const info = await lstat(unionPath)
    if (!info.isSymbolicLink()) continue

    healthy = false
    console.log(`Stale linked skill: ${unionPath}`)
    if (apply) await rm(unionPath)
  }

  const expectedNames = new Set([...canonicalNames, ...targets.keys()])
  const actualNames = await skillNames(cfg.unionSkillsDir)
  if (
    apply &&
    sorted(expectedNames).join("\n") !== sorted(actualNames).join("\n")
  ) {
    throw new Error(
      "Skill union does not contain exactly the public and private skills",
    )
  }

  return healthy
}

const migrateRuntimeDir = async (
  runtimeDir: string,
  expectedNames: Set<string>,
): Promise<void> => {
  const actualNames = await skillNames(runtimeDir)
  if (sorted(actualNames).join("\n") !== sorted(expectedNames).join("\n")) {
    throw new Error(
      `Refusing to replace non-matching runtime skills directory: ${runtimeDir}`,
    )
  }
  await rm(runtimeDir, { recursive: true })
}

const syncRuntimeLink = async (
  runtimeDir: string,
  cfg: SkillsConfig,
  expectedNames: Set<string>,
  apply: boolean,
  migrate: boolean,
): Promise<boolean> => {
  try {
    const info = await lstat(runtimeDir)
    if (info.isSymbolicLink()) {
      if (await resolvesTo(runtimeDir, cfg.unionSkillsDir)) return true
      throw new Error(
        `Runtime skills link has unexpected target: ${runtimeDir}`,
      )
    }
    if (!info.isDirectory()) {
      throw new Error(
        `Runtime skills path is not a directory or symlink: ${runtimeDir}`,
      )
    }
    if (!migrate) {
      console.log(`Runtime skills directory requires migration: ${runtimeDir}`)
      return false
    }
    if (apply) await migrateRuntimeDir(runtimeDir, expectedNames)
  } catch (error) {
    if (!isMissing(error)) throw error
  }

  if (!apply) {
    console.log(`Missing runtime skills link: ${runtimeDir}`)
    return false
  }

  await mkdir(dirname(runtimeDir), { recursive: true })
  await symlink(cfg.unionSkillsDir, runtimeDir, "dir")
  return false
}

const isWithin = (path: string, dir: string): boolean => {
  const pathRelative = relative(dir, path)
  return (
    pathRelative !== "" &&
    pathRelative !== ".." &&
    !pathRelative.startsWith(`..${sep}`) &&
    !isAbsolute(pathRelative)
  )
}

// Links each union skill into a runtime directory that the runtime also
// writes to, such as Claude Code's synced/ tree. Entries that are not links
// into the union are left untouched.
const syncRuntimeEntryLinks = async (
  runtimeDir: string,
  cfg: SkillsConfig,
  expectedNames: Set<string>,
  apply: boolean,
): Promise<boolean> => {
  if (await pathExists(runtimeDir)) {
    const info = await lstat(runtimeDir)
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(
        `Runtime skills path is not a real directory: ${runtimeDir}`,
      )
    }
  } else {
    console.log(`Missing runtime skills directory: ${runtimeDir}`)
    if (!apply) return false
    await mkdir(runtimeDir, { recursive: true })
  }

  let healthy = true
  for (const name of sorted(expectedNames)) {
    const linkPath = join(runtimeDir, name)
    const target = join(cfg.unionSkillsDir, name)
    if (await pathExists(linkPath)) {
      const info = await lstat(linkPath)
      if (!info.isSymbolicLink()) {
        throw new Error(
          `Runtime/union skill name collision: ${name} is not the expected ` +
            `symlink in ${runtimeDir}`,
        )
      }
      if (!(await resolvesTo(linkPath, target))) {
        throw new Error(`Runtime skill link has unexpected target: ${linkPath}`)
      }
      continue
    }

    healthy = false
    console.log(`Missing runtime skill link: ${linkPath}`)
    if (apply) await symlink(target, linkPath, "dir")
  }

  const entries = await readdir(runtimeDir, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isSymbolicLink() || expectedNames.has(entry.name)) continue
    const linkPath = join(runtimeDir, entry.name)
    const target = resolve(runtimeDir, await readlink(linkPath))
    if (!isWithin(target, cfg.unionSkillsDir)) continue

    healthy = false
    console.log(`Stale runtime skill link: ${linkPath}`)
    if (apply) await rm(linkPath)
  }

  return healthy
}

const runSkillsSync = async (options: SkillsSyncOptions): Promise<void> => {
  const cfg = defaultConfig(process.env)
  const health = options.health ?? false
  const apply = options.run ?? false
  const migrate = options.migrate ?? false

  if (health && apply) throw new Error("--health and --run cannot be combined")
  if (migrate && !apply) throw new Error("--migrate requires --run")

  // Validate all required sources, exports, and collisions before changing state.
  const targets = await linkedSkillTargets(cfg.linkedSources)
  const exports = await resolveTeamSkillExports(await teamSkillExports(cfg))
  const repositories = new Map<string, ResolvedTeamSkillExport>()
  for (const skillExport of exports) {
    repositories.set(skillExport.repositoryRoot, skillExport)
  }

  const unionHealthy = await syncUnion(cfg, targets, apply)
  let exportsHealthy = true
  let divergedExports = 0
  for (const skillExport of exports) {
    const result = await syncTeamSkillExport(skillExport, apply)
    if (!result.healthy) exportsHealthy = false
    if (result.diverged) divergedExports += 1
  }
  const exportSummary =
    exports.length === 0
      ? ""
      : `; ${exports.length} team export${exports.length === 1 ? "" : "s"}` +
        (divergedExports ? ` (${divergedExports} diverged)` : "")

  let discoveryHealthy = true
  for (const skillExport of repositories.values()) {
    if (
      !(await syncRepositoryDiscovery(
        skillExport.discoveryDir,
        skillExport.skillsDir,
        apply,
      ))
    ) {
      discoveryHealthy = false
    }
  }
  const names = await skillNames(cfg.unionSkillsDir)
  const cursorHealthy = await syncRuntimeLink(
    cfg.cursorSkillsDir,
    cfg,
    names,
    apply,
    migrate,
  )
  const codexHealthy = await syncRuntimeLink(
    cfg.codexSkillsDir,
    cfg,
    names,
    apply,
    migrate,
  )
  const claudeHealthy = await syncRuntimeEntryLinks(
    cfg.claudeSkillsDir,
    cfg,
    names,
    apply,
  )

  if (health) {
    if (
      exportsHealthy &&
      discoveryHealthy &&
      unionHealthy &&
      cursorHealthy &&
      codexHealthy &&
      claudeHealthy
    ) {
      console.log(
        "💚 " +
          paint("Skills links are healthy", "success", stdoutColor()) +
          exportSummary +
          ".",
      )
    } else {
      process.exitCode = 1
    }
    return
  }

  if (!apply) {
    console.log(
      "Dry run complete. Run with " +
        paint("--run", "command", stdoutColor()) +
        " to apply changes.",
    )
    return
  }

  console.log(
    "💚 " +
      paint("Skills synced:", "success", stdoutColor()) +
      ` ${names.size} skills linked into Cursor, Codex, ` +
      "and Claude Code" +
      exportSummary +
      ".",
  )
}

export const createProgram = (): Command =>
  new Command()
    .name("skills-sync")
    .description(
      "Manage Cursor, Codex, and Claude Code skill links and optional team " +
        "repository exports.",
    )
    .option("-r, --run", "apply changes")
    .option(
      "--migrate",
      "replace matching legacy runtime directories with links",
    )
    .option(
      "--health",
      "fail when managed skill links drift or a team export is missing",
    )
    .action(runSkillsSync)

if (import.meta.main) await createProgram().parseAsync()
