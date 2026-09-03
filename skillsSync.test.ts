import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import {
  lstat,
  mkdir,
  mkdtemp,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const scriptPath = join(import.meta.dir, "skillsSync.ts")

const makeSkill = async (root: string, name: string): Promise<void> => {
  await mkdir(join(root, name), { recursive: true })
  await writeFile(join(root, name, "SKILL.md"), `---\nname: ${name}\n---\n`)
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
  let keeperSkillsDir: string
  let keeperDiscoveryDir: string
  let cursorDir: string
  let codexDir: string

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "skills-links-test-"))
    homeDir = join(root, "home")
    repoDir = join(root, "repo")
    const bokuDir = join(repoDir, "boku")
    publicDir = join(bokuDir, "jiyuu/ai-skills")
    privateDir = join(bokuDir, "priv-skills")
    keeperSkillsDir = join(repoDir, "sai-keeper/ai-skills")
    keeperDiscoveryDir = join(repoDir, "sai-keeper/.agents/skills")
    cursorDir = join(homeDir, ".cursor/skills")
    codexDir = join(homeDir, ".agents/skills")
  })

  test("creates a flat repository union and both runtime links", async () => {
    await makeSkill(publicDir, "public-skill")
    await makeSkill(privateDir, "private-skill")
    await makeSkill(keeperSkillsDir, "keeper-skill")
    await writeFile(join(keeperSkillsDir, "README.md"), "Repository skills\n")

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
    expect(
      resolve(privateDir, await readlink(join(privateDir, "keeper-skill"))),
    ).toBe(join(keeperSkillsDir, "keeper-skill"))
    expect(
      resolve(
        join(repoDir, "sai-keeper/.agents"),
        await readlink(keeperDiscoveryDir),
      ),
    ).toBe(keeperSkillsDir)
    for (const runtimeDir of [cursorDir, codexDir]) {
      expect((await lstat(runtimeDir)).isSymbolicLink()).toBe(true)
      expect(resolve(await readlink(runtimeDir))).toBe(privateDir)
      expect(
        resolve(privateDir, await readlink(join(runtimeDir, "keeper-skill"))),
      ).toBe(join(keeperSkillsDir, "keeper-skill"))
    }
  })

  test("dry run reports a missing repository skill without linking it", async () => {
    const unionPath = join(privateDir, "keeper-skill")
    await rm(unionPath)

    const result = await run(homeDir, repoDir, [])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain(`Missing linked skill: ${unionPath}`)
    await expect(lstat(unionPath)).rejects.toMatchObject({ code: "ENOENT" })

    expect(await run(homeDir, repoDir, ["--run"])).toMatchObject({
      exitCode: 0,
      stderr: "",
    })
  })

  test("health detects a broken runtime target", async () => {
    await rm(cursorDir)
    await symlink(join(root, "wrong"), cursorDir, "dir")
    const result = await run(homeDir, repoDir, ["--health"])
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("unexpected target")
    await rm(cursorDir)
    await symlink(privateDir, cursorDir, "dir")
  })

  test("refuses public and private skill name collisions", async () => {
    await rm(join(privateDir, "public-skill"))
    await makeSkill(privateDir, "public-skill")
    const result = await run(homeDir, repoDir, ["--run"])
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("collision")
    await rm(join(privateDir, "public-skill"), { recursive: true })
  })

  test("refuses collisions between linked repositories", async () => {
    await makeSkill(keeperSkillsDir, "public-skill")
    await rm(keeperDiscoveryDir)
    const result = await run(homeDir, repoDir, ["--run"])
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("Linked skill name collision")
    await expect(lstat(keeperDiscoveryDir)).rejects.toMatchObject({
      code: "ENOENT",
    })
    await rm(join(keeperSkillsDir, "public-skill"), { recursive: true })
    await symlink("../ai-skills", keeperDiscoveryDir, "dir")
  })

  test("refuses a real repository discovery directory", async () => {
    await rm(keeperDiscoveryDir)
    await mkdir(keeperDiscoveryDir, { recursive: true })

    const result = await run(homeDir, repoDir, ["--run"])
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain(
      "Repository skill discovery path is not a symlink",
    )

    await rm(keeperDiscoveryDir, { recursive: true })
    await symlink("../ai-skills", keeperDiscoveryDir, "dir")
  })

  test("detects and removes stale linked skills", async () => {
    const stalePath = join(privateDir, "stale-skill")
    await symlink(join(root, "removed-skill"), stalePath, "dir")

    const health = await run(homeDir, repoDir, ["--health"])
    expect(health.exitCode).toBe(1)
    expect(health.stdout).toContain(`Stale linked skill: ${stalePath}`)

    expect(await run(homeDir, repoDir, ["--run"])).toMatchObject({
      exitCode: 0,
      stderr: "",
    })
    await expect(lstat(stalePath)).rejects.toMatchObject({ code: "ENOENT" })
  })

  test("migrates only a matching legacy runtime directory", async () => {
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

  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })
})
