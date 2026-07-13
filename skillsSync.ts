import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { bash } from "@uniquedivine/bash"
import { Command } from "commander"
import matter from "gray-matter"

interface SkillSets {
  publicSkills: Set<string>
  privateSkills: Set<string>
}

interface SkillsSyncConfig {
  skillsRuntime: string
  publicSkillsDir: string
  privateSkillsDir: string
  codexSkillsDir: string
}

const codexOwnershipMarker = ".dotfiles-cursor-skills-sync"

let dryRun = true

const defaultConfig = (env: NodeJS.ProcessEnv): SkillsSyncConfig => {
  const home = env.HOME
  const repo = env.REPO

  if (!home) {
    throw new Error("HOME is not set")
  }

  if (!repo) {
    throw new Error("REPO is not set")
  }

  const bokuPath = resolve(repo, "boku")

  return {
    skillsRuntime: resolve(home, ".cursor/skills"),
    publicSkillsDir: resolve(bokuPath, "jiyuu/ai-skills"),
    privateSkillsDir: resolve(bokuPath, "priv-skills"),
    codexSkillsDir: resolve(home, ".agents/skills"),
  }
}

const shellQuote = (value: string): string => JSON.stringify(value)

const run = async (cmd: string): Promise<void> => {
  const out = await bash(cmd)

  if (out.stdout.trim() !== "") {
    process.stdout.write(out.stdout)
  }

  if (out.stderr.trim() !== "") {
    process.stderr.write(out.stderr)
  }

  if (out.exitCode !== 0) {
    throw new Error(`Command failed with exit code ${out.exitCode}: ${cmd}`)
  }
}

const assertSafePath = (
  path: string,
  expectedSuffix: string,
  label: string,
): void => {
  if (!path.endsWith(expectedSuffix)) {
    throw new Error(`${label} has unexpected path: ${path}`)
  }
}

const hasPrivateTrue = (markdown: string): boolean => {
  const parsed = matter(markdown)
  const privateFlag = parsed.data.metadata?.private

  if (typeof privateFlag === "boolean") {
    return privateFlag
  }

  if (typeof privateFlag === "number") {
    return false
  }

  if (typeof privateFlag === "string") {
    return privateFlag.trim().toLowerCase() === "true"
  }

  return false
}

const classifySkills = async (cfg: SkillsSyncConfig): Promise<SkillSets> => {
  const publicSkills = new Set<string>()
  const privateSkills = new Set<string>()
  // Cursor discovers skills only as direct children of ~/.cursor/skills.
  // Nested SKILL.md files are deliberately ignored to preserve that flat layout.
  const glob = new Bun.Glob("*/SKILL.md")

  for await (const relPath of glob.scan({ cwd: cfg.skillsRuntime })) {
    const skillFile = join(cfg.skillsRuntime, relPath)
    const skillDir = dirname(skillFile)
    const skillName = basename(skillDir)
    const markdown = await Bun.file(skillFile).text()

    if (hasPrivateTrue(markdown)) {
      privateSkills.add(skillName)
    } else {
      publicSkills.add(skillName)
    }
  }

  return { publicSkills, privateSkills }
}

const stageSkills = async (
  cfg: SkillsSyncConfig,
  skills: Set<string>,
  stageDir: string,
): Promise<void> => {
  await mkdir(stageDir, { recursive: true })

  for (const skillName of skills) {
    await symlink(
      join(cfg.skillsRuntime, skillName),
      join(stageDir, skillName),
      "dir",
    )
  }
}

const rsyncStage = async (stageDir: string, destDir: string): Promise<void> => {
  if (dryRun) {
    try {
      await lstat(destDir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        console.log(`Would create directory ${destDir}`)
        return
      }
      throw error
    }
  }

  if (!dryRun) {
    await mkdir(destDir, { recursive: true })
  }

  const dryRunFlags = dryRun ? " --dry-run --itemize-changes" : ""
  await run(
    [
      "rsync",
      "-aL",
      "--delete",
      "--exclude=/.git/",
      "--exclude=/.gitignore",
      "--exclude=/.marksman.toml",
      "--exclude=/README.md",
      "--exclude=/LICENSE",
      `--exclude=/${codexOwnershipMarker}`,
      dryRunFlags,
      shellQuote(`${stageDir}/`),
      shellQuote(`${destDir}/`),
    ].join(" "),
  )
}

const healthRsyncStage = async (
  stageDir: string,
  destDir: string,
): Promise<boolean> => {
  try {
    await lstat(destDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      console.error(`Skills destination is missing: ${destDir}`)
      return false
    }
    throw error
  }

  const out = await bash(
    [
      "rsync",
      "-aL",
      "--delete",
      "--dry-run",
      "--itemize-changes",
      "--omit-dir-times",
      "--exclude=/.git/",
      "--exclude=/.gitignore",
      "--exclude=/.marksman.toml",
      "--exclude=/README.md",
      "--exclude=/LICENSE",
      `--exclude=/${codexOwnershipMarker}`,
      shellQuote(`${stageDir}/`),
      shellQuote(`${destDir}/`),
    ].join(" "),
  )

  if (out.exitCode !== 0) {
    throw new Error(
      `Skills health rsync failed with exit code ${out.exitCode}: ${destDir}`,
    )
  }

  if (out.stdout.trim() === "") {
    return true
  }

  process.stdout.write(out.stdout)
  return false
}

const prepareCodexSkillsDir = async (destDir: string): Promise<void> => {
  await mkdir(dirname(destDir), { recursive: true })

  try {
    const info = await lstat(destDir)
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`Codex skills path must be a real directory: ${destDir}`)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    await mkdir(destDir)
  }

  const entries = await readdir(destDir)
  if (entries.length > 0 && !entries.includes(codexOwnershipMarker)) {
    throw new Error(
      "Refusing to sync into unmanaged non-empty Codex skills directory: " +
        destDir,
    )
  }

  await writeFile(
    join(destDir, codexOwnershipMarker),
    "Managed by dotfiles skills-sync from $HOME/.cursor/skills.\n",
  )
}

const codexSkillsDirIsHealthy = async (destDir: string): Promise<boolean> => {
  try {
    const info = await lstat(destDir)
    if (!info.isDirectory() || info.isSymbolicLink()) {
      console.error(`Codex skills path must be a real directory: ${destDir}`)
      return false
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      console.error(`Codex skills destination is missing: ${destDir}`)
      return false
    }
    throw error
  }

  const entries = await readdir(destDir)
  if (!entries.includes(codexOwnershipMarker)) {
    console.error(`Codex skills destination is unmanaged: ${destDir}`)
    return false
  }

  return true
}

const printSummary = (
  label: string,
  skills: Set<string>,
  dest: string,
): void => {
  const names = [...skills].sort()
  console.log(`${label}: ${names.length} skill(s) -> ${dest}`)

  for (const name of names) {
    console.log(`  ${name}`)
  }
}

interface SkillsSyncOptions {
  dryRun?: boolean
  health?: boolean
  run?: boolean
}

const runSkillsSync = async (options: SkillsSyncOptions): Promise<void> => {
  const cfg = defaultConfig(process.env)
  const health = options.health ?? false
  dryRun = !options.run && !health

  assertSafePath(cfg.publicSkillsDir, "/jiyuu/ai-skills", "public skills dir")
  assertSafePath(cfg.privateSkillsDir, "/priv-skills", "private skills dir")
  assertSafePath(cfg.codexSkillsDir, "/.agents/skills", "Codex skills dir")

  const tmpRoot = await mkdtemp(join(tmpdir(), "skills-sync-"))
  const tmpPublic = join(tmpRoot, "public")
  const tmpPrivate = join(tmpRoot, "private")

  try {
    const { publicSkills, privateSkills } = await classifySkills(cfg)
    const allSkills = new Set([...publicSkills, ...privateSkills])

    await stageSkills(cfg, publicSkills, tmpPublic)
    await stageSkills(cfg, privateSkills, tmpPrivate)
    const tmpCodex = join(tmpRoot, "codex")
    await stageSkills(cfg, allSkills, tmpCodex)

    if (!dryRun) await prepareCodexSkillsDir(cfg.codexSkillsDir)

    printSummary("public", publicSkills, cfg.publicSkillsDir)
    printSummary("private", privateSkills, cfg.privateSkillsDir)
    printSummary("codex", allSkills, cfg.codexSkillsDir)

    if (health) {
      const results = await Promise.all([
        healthRsyncStage(tmpPublic, cfg.publicSkillsDir),
        healthRsyncStage(tmpPrivate, cfg.privateSkillsDir),
        codexSkillsDirIsHealthy(cfg.codexSkillsDir),
        healthRsyncStage(tmpCodex, cfg.codexSkillsDir),
      ])

      if (results.every(Boolean)) {
        console.log("Skills sync is healthy.")
      } else {
        process.exitCode = 1
      }
    } else {
      await rsyncStage(tmpPublic, cfg.publicSkillsDir)
      await rsyncStage(tmpPrivate, cfg.privateSkillsDir)
      await rsyncStage(tmpCodex, cfg.codexSkillsDir)
    }

    if (dryRun && !health) {
      console.log("Dry run complete. No files were changed.")
      console.log("Run with --run to apply these changes.")
    }
  } finally {
    await rm(tmpRoot, { recursive: true, force: true })
  }
}

export const createProgram = (): Command => {
  const program = new Command()

  program
    .name("skills-sync")
    .description(
      "Sync Cursor skills to public, private, and managed Codex destinations.",
    )
    .option("-r, --run", "apply changes with rsync")
    .option("-n, --dry-run", "preview changes without writing")
    .option("--health", "fail when destinations are unsafe or out of sync")
    .action(async (options: SkillsSyncOptions) => {
      await runSkillsSync(options)
    })

  return program
}

if (import.meta.main) {
  await createProgram().parseAsync()
}
