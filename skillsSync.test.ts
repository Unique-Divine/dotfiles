import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { describe, expect, test } from "bun:test"

const scriptPath = join(import.meta.dir, "skillsSync.ts")

const makeSkill = async (
  runtimeDir: string,
  name: string,
  frontmatter: string,
  body = "# Test Skill\n",
): Promise<void> => {
  const skillDir = join(runtimeDir, name)
  await mkdir(skillDir, { recursive: true })
  await writeFile(join(skillDir, "SKILL.md"), `${frontmatter}\n${body}`)
  await writeFile(join(skillDir, "reference.md"), `${name} reference\n`)
}

const runSkillsSync = async (
  homeDir: string,
  bokuPath: string,
  args: string[] = ["--run"],
): Promise<void> => {
  const proc = Bun.spawn(["bun", scriptPath, ...args], {
    cwd: import.meta.dir,
    env: {
      ...process.env,
      HOME: homeDir,
      BOKU_PATH: bokuPath,
    },
    stderr: "pipe",
    stdout: "pipe",
  })

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])

  expect({ exitCode, stdout, stderr }).toMatchObject({
    exitCode: 0,
    stderr: "",
  })
}

const dirNames = async (dir: string): Promise<string[]> => {
  const entries = await readdir(dir, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}

describe("skills-sync", () => {
  let testCfg: {
    root: string
    syncHomeDir: string
    syncBokuPath: string
    syncPublicDir: string
    syncPrivateDir: string
    dryRunHomeDir: string
    dryRunBokuPath: string
    dryRunPublicDir: string
  }

  test("setup fixtures", async () => {
    const root = await mkdtemp(join(tmpdir(), "skills-sync-test-"))

    const syncHomeDir = join(root, "sync-home")
    const syncBokuPath = join(root, "sync-boku")
    const syncRuntimeDir = join(syncHomeDir, ".cursor/skills")
    const syncPublicDir = join(syncBokuPath, "jiyuu/ai-skills")
    const syncPrivateDir = join(syncBokuPath, "priv-skills")

    await mkdir(syncRuntimeDir, { recursive: true })
    await mkdir(join(syncPublicDir, "stale-public"), { recursive: true })
    await mkdir(join(syncPrivateDir, "stale-private"), { recursive: true })
    await writeFile(join(syncPublicDir, ".marksman.toml"), "[core]\n")

    await makeSkill(syncRuntimeDir, "public-missing", "---\n---\n")
    await makeSkill(syncRuntimeDir, "public-false", "---\nprivate: false\n---\n")
    await makeSkill(syncRuntimeDir, "private-true", "---\nprivate: true\n---\n")

    await mkdir(join(syncRuntimeDir, "nested/hidden"), { recursive: true })
    await writeFile(
      join(syncRuntimeDir, "nested/hidden/SKILL.md"),
      "---\nprivate: true\n---\n# Hidden\n",
    )

    const dryRunHomeDir = join(root, "dry-run-home")
    const dryRunBokuPath = join(root, "dry-run-boku")
    const dryRunRuntimeDir = join(dryRunHomeDir, ".cursor/skills")
    const dryRunPublicDir = join(dryRunBokuPath, "jiyuu/ai-skills")

    await mkdir(dryRunRuntimeDir, { recursive: true })
    await mkdir(join(dryRunPublicDir, "stale-public"), { recursive: true })
    await makeSkill(dryRunRuntimeDir, "public-missing", "---\n---\n")

    testCfg = {
      root,
      syncHomeDir,
      syncBokuPath,
      syncPublicDir,
      syncPrivateDir,
      dryRunHomeDir,
      dryRunBokuPath,
      dryRunPublicDir,
    }
  })

  test("defaults to dry run unless --run is passed", async () => {
    await runSkillsSync(testCfg.dryRunHomeDir, testCfg.dryRunBokuPath, [])

    expect(await dirNames(testCfg.dryRunPublicDir)).toEqual(["stale-public"])
  })

  test("syncs direct runtime skills to public and private repos", async () => {
    await runSkillsSync(testCfg.syncHomeDir, testCfg.syncBokuPath)

    expect(await dirNames(testCfg.syncPublicDir)).toEqual([
      "public-false",
      "public-missing",
    ])
    expect(await dirNames(testCfg.syncPrivateDir)).toEqual(["private-true"])

    expect(
      await Bun.file(
        join(testCfg.syncPublicDir, "public-false/reference.md"),
      ).text(),
    ).toBe("public-false reference\n")
    expect(
      await Bun.file(
        join(testCfg.syncPrivateDir, "private-true/reference.md"),
      ).text(),
    ).toBe("private-true reference\n")
  })

  test("keeps marksman config in destination dirs", async () => {
    expect(await Bun.file(join(testCfg.syncPublicDir, ".marksman.toml")).text())
      .toBe("[core]\n")
  })

  test("cleanup fixtures", async () => {
    await rm(testCfg.root, { recursive: true, force: true })
  })
})
