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
import { afterAll, beforeAll, describe, expect, test } from "bun:test"

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
  let cursorDir: string
  let codexDir: string

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "skills-links-test-"))
    homeDir = join(root, "home")
    repoDir = join(root, "repo")
    const bokuDir = join(repoDir, "boku")
    publicDir = join(bokuDir, "jiyuu/ai-skills")
    privateDir = join(bokuDir, "priv-skills")
    cursorDir = join(homeDir, ".cursor/skills")
    codexDir = join(homeDir, ".agents/skills")
  })

  test("creates a flat repository union and both runtime links", async () => {
    await makeSkill(publicDir, "public-skill")
    await makeSkill(privateDir, "private-skill")

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
    for (const runtimeDir of [cursorDir, codexDir]) {
      expect((await lstat(runtimeDir)).isSymbolicLink()).toBe(true)
      expect(resolve(await readlink(runtimeDir))).toBe(privateDir)
    }
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

  test("migrates only a matching legacy runtime directory", async () => {
    await rm(codexDir)
    await mkdir(codexDir, { recursive: true })
    await makeSkill(codexDir, "public-skill")
    await makeSkill(codexDir, "private-skill")

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
