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

interface SkillsConfig {
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

const directorySnapshot = async (root: string): Promise<string[] | undefined> => {
  if (!(await pathExists(root))) return undefined
  const rootInfo = await lstat(root)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return []

  const snapshot: string[] = []
  const walk = async (dir: string, prefix: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))

    for (const entry of entries) {
      const path = join(dir, entry.name)
      const relativePath = join(prefix, entry.name)
      const info = await lstat(path)
      const mode = (info.mode & 0o777).toString(8)
      if (info.isDirectory()) {
        snapshot.push(`d ${mode} ${relativePath}`)
        await walk(path, relativePath)
      } else if (info.isFile()) {
        const digest = createHash("sha256")
          .update(await readFile(path))
          .digest("hex")
        snapshot.push(`f ${mode} ${digest} ${relativePath}`)
      } else if (info.isSymbolicLink()) {
        snapshot.push(`l ${await readlink(path)} ${relativePath}`)
      } else {
        throw new Error(`Unsupported file in skill export: ${path}`)
      }
    }
  }

  await walk(root, "")
  return snapshot
}

const syncTeamSkillExport = async (
  skillExport: ResolvedTeamSkillExport,
  apply: boolean,
): Promise<boolean> => {
  const sourceSnapshot = await directorySnapshot(skillExport.sourceDir)
  const destinationSnapshot = await directorySnapshot(
    skillExport.destinationDir,
  )
  if (
    sourceSnapshot &&
    destinationSnapshot &&
    sourceSnapshot.join("\n") === destinationSnapshot.join("\n")
  ) {
    return true
  }

  console.log(`Team skill export differs: ${skillExport.destinationDir}`)
  if (!apply) return false

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
    await rm(skillExport.destinationDir, { force: true, recursive: true })
    await rename(stagedSkill, skillExport.destinationDir)
  } finally {
    await rm(temporaryDir, { force: true, recursive: true })
  }
  return false
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
  for (const skillExport of exports) {
    if (!(await syncTeamSkillExport(skillExport, apply))) {
      exportsHealthy = false
    }
  }

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

  if (health) {
    if (
      exportsHealthy &&
      discoveryHealthy &&
      unionHealthy &&
      cursorHealthy &&
      codexHealthy
    ) {
      console.log("Skills links are healthy.")
    } else {
      process.exitCode = 1
    }
    return
  }

  if (!apply) {
    console.log("Dry run complete. Run with --run to apply changes.")
  }
}

export const createProgram = (): Command =>
  new Command()
    .name("skills-sync")
    .description("Manage skill links and optional team repository exports.")
    .option("-r, --run", "apply changes")
    .option(
      "--migrate",
      "replace matching legacy runtime directories with links",
    )
    .option("--health", "fail when managed skill links or exports drift")
    .action(runSkillsSync)

if (import.meta.main) await createProgram().parseAsync()
