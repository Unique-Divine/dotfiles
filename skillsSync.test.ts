import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative, resolve } from "node:path"

const scriptPath = join(import.meta.dir, "skillsSync.ts")

interface SkillMetadata {
  ghRepo?: string
  private?: boolean
  repoDir?: string
}

const makeSkill = async (
  root: string,
  name: string,
  metadata?: SkillMetadata,
): Promise<void> => {
  const skillDir = join(root, name)
  await mkdir(skillDir, { recursive: true })
  const metadataLines = metadata
    ? [
        "metadata:",
        ...(metadata.private === undefined
          ? []
          : [`  private: ${metadata.private}`]),
        ...(metadata.ghRepo ? [`  gh-repo: ${metadata.ghRepo}`] : []),
        ...(metadata.repoDir ? [`  repo-dir: ${metadata.repoDir}`] : []),
      ]
    : []
  await writeFile(
    join(skillDir, "SKILL.md"),
    [
      "---",
      `name: ${name}`,
      `description: Test skill ${name}.`,
      ...metadataLines,
      "---",
      "",
      `# ${name}`,
      "",
    ].join("\n"),
  )
}

const runCommand = async (
  command: string[],
  cwd: string,
): Promise<void> => {
  const proc = Bun.spawn(command, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  })
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    throw new Error(await new Response(proc.stderr).text())
  }
}

const initializeRepository = async (
  repositoryDir: string,
  remote = "git@github.com:NibiruChain/sai-keeper.git",
): Promise<void> => {
  await mkdir(repositoryDir, { recursive: true })
  await runCommand(["git", "init", "--quiet"], repositoryDir)
  await runCommand(["git", "remote", "add", "origin", remote], repositoryDir)
}

const run = async (
  homeDir: string,
  repoDir: string,
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  const proc = Bun.spawn(["bun", scriptPath, ...args], {
    cwd: import.meta.dir,
    env: { ...process.env, HOME: homeDir, REPO: repoDir },
    stdout: "pipe",
    stderr: "pipe",
  })
  return {
    exitCode: await proc.exited,
    stdout: await new Response(proc.stdout).text(),
    stderr: await new Response(proc.stderr).text(),
  }
}

describe("skills-sync", () => {
  let root: string
  let homeDir: string
  let repoDir: string
  let publicDir: string
  let privateDir: string
  let keeperDir: string
  let keeperSkillsDir: string
  let keeperDiscoveryDir: string
  let cursorDir: string
  let codexDir: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "skills-links-test-"))
    homeDir = join(root, "home")
    repoDir = join(root, "repo")
    const bokuDir = join(repoDir, "boku")
    publicDir = join(bokuDir, "jiyuu/ai-skills")
    privateDir = join(bokuDir, "priv-skills")
    keeperDir = join(repoDir, "sai-keeper")
    keeperSkillsDir = join(keeperDir, "ai-skills")
    keeperDiscoveryDir = join(keeperDir, ".agents/skills")
    cursorDir = join(homeDir, ".cursor/skills")
    codexDir = join(homeDir, ".agents/skills")

    await makeSkill(publicDir, "public-skill")
    await makeSkill(privateDir, "private-skill", { private: true })
    await makeSkill(privateDir, "keeper-skill", {
      ghRepo: "NibiruChain/sai-keeper",
      private: true,
    })
    await mkdir(join(privateDir, "keeper-skill", "references"))
    await writeFile(
      join(privateDir, "keeper-skill", "references", "workflow.md"),
      "Canonical workflow\n",
    )
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  test("creates the union, exports a team skill, and links discovery", async () => {
    await initializeRepository(keeperDir)

    expect(await run(homeDir, repoDir, ["--run"])).toMatchObject({
      exitCode: 0,
      stderr: "",
    })

    expect(
      (await lstat(join(privateDir, "public-skill"))).isSymbolicLink(),
    ).toBe(true)
    expect(
      resolve(privateDir, await readlink(join(privateDir, "public-skill"))),
    ).toBe(join(publicDir, "public-skill"))
    expect((await lstat(join(privateDir, "keeper-skill"))).isDirectory()).toBe(
      true,
    )
    expect(
      await readFile(join(keeperSkillsDir, "keeper-skill", "SKILL.md"), "utf8"),
    ).toBe(await readFile(join(privateDir, "keeper-skill", "SKILL.md"), "utf8"))
    expect(
      resolve(
        join(keeperDir, ".agents"),
        await readlink(keeperDiscoveryDir),
      ),
    ).toBe(keeperSkillsDir)
    for (const runtimeDir of [cursorDir, codexDir]) {
      expect((await lstat(runtimeDir)).isSymbolicLink()).toBe(true)
      expect(resolve(await readlink(runtimeDir))).toBe(privateDir)
    }
  })

  test("skips an absent team checkout without failing health", async () => {
    const sync = await run(homeDir, repoDir, ["--run"])
    expect(sync.exitCode).toBe(0)
    expect(sync.stderr).toBe("")
    expect(sync.stdout).toContain(
      `Skipping team skill export keeper-skill; checkout is missing: ${keeperDir}`,
    )

    const health = await run(homeDir, repoDir, ["--health"])
    expect(health.exitCode).toBe(0)
    expect(health.stdout).toContain("checkout is missing")
    expect(health.stdout).toContain("Skills links are healthy.")
    await expect(lstat(keeperSkillsDir)).rejects.toMatchObject({ code: "ENOENT" })
  })

  test("dry run reports an export without writing it", async () => {
    await initializeRepository(keeperDir)

    const result = await run(homeDir, repoDir, [])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain(
      `Team skill export differs: ${join(keeperSkillsDir, "keeper-skill")}`,
    )
    await expect(
      lstat(join(keeperSkillsDir, "keeper-skill")),
    ).rejects.toMatchObject({ code: "ENOENT" })
  })

  test("health detects drift and run replaces destination content", async () => {
    await initializeRepository(keeperDir)
    await run(homeDir, repoDir, ["--run"])
    const destination = join(keeperSkillsDir, "keeper-skill")
    await writeFile(join(destination, "SKILL.md"), "uncommitted edit\n")
    await writeFile(join(destination, "untracked.txt"), "remove me\n")

    const health = await run(homeDir, repoDir, ["--health"])
    expect(health.exitCode).toBe(1)
    expect(health.stdout).toContain(`Team skill export differs: ${destination}`)

    expect(await run(homeDir, repoDir, ["--run"])).toMatchObject({
      exitCode: 0,
      stderr: "",
    })
    expect(await readFile(join(destination, "SKILL.md"), "utf8")).toBe(
      await readFile(join(privateDir, "keeper-skill", "SKILL.md"), "utf8"),
    )
    await expect(lstat(join(destination, "untracked.txt"))).rejects.toMatchObject(
      { code: "ENOENT" },
    )
  })

  test("supports a repository directory override beneath REPO", async () => {
    const customDir = join(repoDir, "teams/keeper-local")
    await makeSkill(privateDir, "keeper-skill", {
      ghRepo: "NibiruChain/sai-keeper",
      private: true,
      repoDir: "teams/keeper-local",
    })
    await initializeRepository(customDir)

    expect(await run(homeDir, repoDir, ["--run"])).toMatchObject({
      exitCode: 0,
      stderr: "",
    })
    expect(
      await readFile(
        join(customDir, "ai-skills/keeper-skill/SKILL.md"),
        "utf8",
      ),
    ).toContain("repo-dir: teams/keeper-local")
  })

  test("rejects a checkout whose origin does not match gh-repo", async () => {
    await initializeRepository(
      keeperDir,
      "https://github.com/NibiruChain/different.git",
    )

    const result = await run(homeDir, repoDir, ["--run"])
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("does not match metadata.gh-repo")
  })

  test("rejects a repository directory that escapes REPO", async () => {
    await makeSkill(privateDir, "keeper-skill", {
      ghRepo: "NibiruChain/sai-keeper",
      private: true,
      repoDir: "../sai-keeper",
    })

    const result = await run(homeDir, repoDir, ["--run"])
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("must resolve beneath REPO")
  })

  test("rejects repo-dir without gh-repo", async () => {
    await makeSkill(privateDir, "keeper-skill", {
      private: true,
      repoDir: "sai-keeper",
    })

    const result = await run(homeDir, repoDir, ["--run"])
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("requires metadata.gh-repo")
  })

  test("refuses a real repository discovery directory", async () => {
    await initializeRepository(keeperDir)
    await mkdir(keeperDiscoveryDir, { recursive: true })

    const result = await run(homeDir, repoDir, ["--run"])
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain(
      "Repository skill discovery path is not a symlink",
    )
  })

  test("repairs a Git-materialized public skill link", async () => {
    await run(homeDir, repoDir, ["--run"])
    const unionPath = join(privateDir, "public-skill")
    await rm(unionPath)
    await writeFile(
      unionPath,
      relative(privateDir, join(publicDir, "public-skill")),
    )

    const health = await run(homeDir, repoDir, ["--health"])
    expect(health.exitCode).toBe(1)
    expect(health.stdout).toContain(`Git-materialized linked skill: ${unionPath}`)

    await run(homeDir, repoDir, ["--run"])
    expect((await lstat(unionPath)).isSymbolicLink()).toBe(true)
  })

  test("refuses public and private skill name collisions", async () => {
    await makeSkill(privateDir, "public-skill", { private: true })

    const result = await run(homeDir, repoDir, ["--run"])
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("collision")
  })

  test("detects and removes stale linked skills", async () => {
    await run(homeDir, repoDir, ["--run"])
    const stalePath = join(privateDir, "stale-skill")
    await symlink(join(root, "removed-skill"), stalePath, "dir")

    const health = await run(homeDir, repoDir, ["--health"])
    expect(health.exitCode).toBe(1)
    expect(health.stdout).toContain(`Stale linked skill: ${stalePath}`)

    await run(homeDir, repoDir, ["--run"])
    await expect(lstat(stalePath)).rejects.toMatchObject({ code: "ENOENT" })
  })

  test("migrates only a matching legacy runtime directory", async () => {
    await run(homeDir, repoDir, ["--run"])
    await rm(codexDir)
    await mkdir(codexDir, { recursive: true })
    await makeSkill(codexDir, "public-skill")
    await makeSkill(codexDir, "private-skill")
    await makeSkill(codexDir, "keeper-skill")

    expect((await run(homeDir, repoDir, ["--run"])).stdout).toContain(
      "requires migration",
    )
    expect((await lstat(codexDir)).isDirectory()).toBe(true)

    expect(await run(homeDir, repoDir, ["--run", "--migrate"])).toMatchObject({
      exitCode: 0,
      stderr: "",
    })
    expect((await lstat(codexDir)).isSymbolicLink()).toBe(true)
  })
})
