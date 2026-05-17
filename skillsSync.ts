import { bash } from "@uniquedivine/bash"
import matter from "gray-matter"
import { basename, dirname, join, resolve } from "node:path"
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"

interface SkillSets {
  publicSkills: Set<string>
  privateSkills: Set<string>
}

interface SkillsSyncConfig {
  skillsRuntime: string
  publicSkillsDir: string
  privateSkillsDir: string
}

const args = new Set(Bun.argv.slice(2))
const help = args.has("--help") || args.has("-h")
const runSync = args.has("--run") || args.has("-r")
const dryRun = !runSync

const printUsage = (): void => {
  console.log(`Usage: bun run skillsSync.ts [--run]

Sync Cursor skills from ~/.cursor/skills into version-controlled skill dirs.

Default behavior is a dry run. Pass --run to write changes.

Options:
  -r, --run      Apply changes with rsync
  -n, --dry-run  Preview changes only (default)
  -h, --help     Show this help text`)
}

if (help) {
  printUsage()
  process.exit(0)
}

const defaultConfig = (env: NodeJS.ProcessEnv): SkillsSyncConfig => {
  const home = env.HOME
  const bokuPath = env.BOKU_PATH

  if (!home) {
    throw new Error("HOME is not set")
  }

  if (!bokuPath) {
    throw new Error("BOKU_PATH is not set")
  }

  return {
    skillsRuntime: resolve(home, ".cursor/skills"),
    publicSkillsDir: resolve(bokuPath, "jiyuu/ai-skills"),
    privateSkillsDir: resolve(bokuPath, "priv-skills"),
  }
}

const cfg = defaultConfig(process.env)

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
  return parsed.data.private === true
}

const classifySkills = async (cfg: SkillsSyncConfig): Promise<SkillSets> => {
  const publicSkills = new Set<string>()
  const privateSkills = new Set<string>()
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
  await mkdir(destDir, { recursive: true })

  const dryRunFlags = dryRun ? " --dry-run --itemize-changes" : ""
  await run(
    [
      "rsync",
      "-aL",
      "--delete",
      "--exclude=.git/",
      "--exclude=.gitignore",
      "--exclude=.marksman.toml",
      "--exclude=README.md",
      "--exclude=LICENSE",
      dryRunFlags,
      shellQuote(`${stageDir}/`),
      shellQuote(`${destDir}/`),
    ].join(" "),
  )
}

const printSummary = (label: string, skills: Set<string>, dest: string): void => {
  const names = [...skills].sort()
  console.log(`${label}: ${names.length} skill(s) -> ${dest}`)

  for (const name of names) {
    console.log(`  ${name}`)
  }
}

assertSafePath(cfg.publicSkillsDir, "/jiyuu/ai-skills", "public skills dir")
assertSafePath(cfg.privateSkillsDir, "/priv-skills", "private skills dir")

const tmpRoot = await mkdtemp(join(tmpdir(), "skills-sync-"))
const tmpPublic = join(tmpRoot, "public")
const tmpPrivate = join(tmpRoot, "private")

try {
  const { publicSkills, privateSkills } = await classifySkills(cfg)

  await stageSkills(cfg, publicSkills, tmpPublic)
  await stageSkills(cfg, privateSkills, tmpPrivate)

  printSummary("public", publicSkills, cfg.publicSkillsDir)
  printSummary("private", privateSkills, cfg.privateSkillsDir)

  await rsyncStage(tmpPublic, cfg.publicSkillsDir)
  await rsyncStage(tmpPrivate, cfg.privateSkillsDir)

  if (dryRun) {
    console.log("Dry run complete. No files were changed.")
    console.log("Run with --run to apply these changes.")
  }
} finally {
  await rm(tmpRoot, { recursive: true, force: true })
}
