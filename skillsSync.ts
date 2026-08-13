import { lstat, mkdir, readdir, readlink, rm, symlink } from "node:fs/promises"
import { basename, dirname, join, relative, resolve } from "node:path"
import { Command } from "commander"

interface SkillsConfig {
  cursorSkillsDir: string
  codexSkillsDir: string
  publicSkillsDir: string
  unionSkillsDir: string
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
    publicSkillsDir: resolve(bokuDir, "jiyuu/ai-skills"),
    unionSkillsDir: resolve(bokuDir, "priv-skills"),
  }
}

const isMissing = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException).code === "ENOENT"

const sorted = (names: Iterable<string>): string[] => [...names].sort()

const skillNames = async (dir: string): Promise<Set<string>> => {
  const entries = await readdir(dir, { withFileTypes: true })
  const names = new Set<string>()

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue
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

const syncUnion = async (
  cfg: SkillsConfig,
  apply: boolean,
): Promise<boolean> => {
  const publicNames = await skillNames(cfg.publicSkillsDir)
  const unionNames = await skillNames(cfg.unionSkillsDir)
  let healthy = true

  for (const name of publicNames) {
    const unionPath = join(cfg.unionSkillsDir, name)
    const publicPath = join(cfg.publicSkillsDir, name)
    try {
      const info = await lstat(unionPath)
      if (!info.isSymbolicLink()) {
        throw new Error(
          `Public/private skill name collision: ${name} is a real directory in ${cfg.unionSkillsDir}`,
        )
      }
      if (!(await resolvesTo(unionPath, publicPath))) {
        throw new Error(`Public skill link has unexpected target: ${unionPath}`)
      }
    } catch (error) {
      if (!isMissing(error)) throw error
      healthy = false
      console.log(`Missing public skill link: ${unionPath}`)
      if (apply) {
        await symlink(
          relative(dirname(unionPath), publicPath),
          unionPath,
          "dir",
        )
      }
    }
  }

  for (const name of unionNames) {
    const unionPath = join(cfg.unionSkillsDir, name)
    const info = await lstat(unionPath)
    if (!info.isSymbolicLink()) continue

    const target = resolve(dirname(unionPath), await readlink(unionPath))
    if (!target.startsWith(`${cfg.publicSkillsDir}/`)) continue
    if (publicNames.has(name) && target === join(cfg.publicSkillsDir, name)) {
      continue
    }

    healthy = false
    console.log(`Stale public skill link: ${unionPath}`)
    if (apply) await rm(unionPath)
  }

  const expectedNames = new Set([...publicNames, ...unionNames])
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

  const unionHealthy = await syncUnion(cfg, apply)
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
    if (unionHealthy && cursorHealthy && codexHealthy) {
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
    .description("Manage the repository-backed Cursor and Codex skill links.")
    .option("-r, --run", "apply changes")
    .option(
      "--migrate",
      "replace matching legacy runtime directories with links",
    )
    .option("--health", "fail when the skill union or runtime links drift")
    .action(runSkillsSync)

if (import.meta.main) await createProgram().parseAsync()
