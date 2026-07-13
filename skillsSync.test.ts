import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
  repoPath: string,
  args: string[] = ["--run"],
): Promise<void> => {
  const proc = Bun.spawn(["bun", scriptPath, ...args], {
    cwd: import.meta.dir,
    env: {
      ...process.env,
      HOME: homeDir,
      REPO: repoPath,
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

const skillsSyncResult = async (
  homeDir: string,
  repoPath: string,
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  const proc = Bun.spawn(["bun", scriptPath, ...args], {
    cwd: import.meta.dir,
    env: {
      ...process.env,
      HOME: homeDir,
      REPO: repoPath,
    },
    stderr: "pipe",
    stdout: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])

  return { exitCode, stdout, stderr }
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
    syncRepoPath: string
    syncPublicDir: string
    syncPrivateDir: string
    syncCodexDir: string
    dryRunHomeDir: string
    dryRunRepoPath: string
    dryRunPublicDir: string
  }

  test("setup fixtures", async () => {
    const root = await mkdtemp(join(tmpdir(), "skills-sync-test-"))

    const syncHomeDir = join(root, "sync-home")
    const syncRepoPath = join(root, "sync-repo")
    const syncBokuPath = join(syncRepoPath, "boku")
    const syncRuntimeDir = join(syncHomeDir, ".cursor/skills")
    const syncPublicDir = join(syncBokuPath, "jiyuu/ai-skills")
    const syncPrivateDir = join(syncBokuPath, "priv-skills")
    const syncCodexDir = join(syncHomeDir, ".agents/skills")

    await mkdir(syncRuntimeDir, { recursive: true })
    await mkdir(join(syncPublicDir, "stale-public"), { recursive: true })
    await mkdir(join(syncPrivateDir, "stale-private"), { recursive: true })
    await writeFile(join(syncPublicDir, ".marksman.toml"), "[core]\n")

    await makeSkill(syncRuntimeDir, "public-missing", "---\n---\n")
    await makeSkill(
      syncRuntimeDir,
      "public-false",
      "---\nmetadata:\n  private: false\n---\n",
    )
    await makeSkill(
      syncRuntimeDir,
      "private-true",
      "---\nmetadata:\n  private: true\n---\n",
    )
    await makeSkill(
      syncRuntimeDir,
      "private-string-true",
      '---\nmetadata:\n  private: "true"\n---\n',
    )
    await writeFile(
      join(syncRuntimeDir, "public-false", "README.md"),
      "public skill readme\n",
    )
    await writeFile(
      join(syncRuntimeDir, "public-false", "LICENSE"),
      "public skill license\n",
    )

    await mkdir(join(syncRuntimeDir, "nested/hidden"), { recursive: true })
    await writeFile(
      join(syncRuntimeDir, "nested/hidden/SKILL.md"),
      "---\nmetadata:\n  private: true\n---\n# Hidden\n",
    )

    const dryRunHomeDir = join(root, "dry-run-home")
    const dryRunRepoPath = join(root, "dry-run-repo")
    const dryRunBokuPath = join(dryRunRepoPath, "boku")
    const dryRunRuntimeDir = join(dryRunHomeDir, ".cursor/skills")
    const dryRunPublicDir = join(dryRunBokuPath, "jiyuu/ai-skills")

    await mkdir(dryRunRuntimeDir, { recursive: true })
    await mkdir(join(dryRunPublicDir, "stale-public"), { recursive: true })
    await makeSkill(dryRunRuntimeDir, "public-missing", "---\n---\n")

    testCfg = {
      root,
      syncHomeDir,
      syncRepoPath,
      syncPublicDir,
      syncPrivateDir,
      syncCodexDir,
      dryRunHomeDir,
      dryRunRepoPath,
      dryRunPublicDir,
    }
  })

  test("defaults to dry run unless --run is passed", async () => {
    await runSkillsSync(testCfg.dryRunHomeDir, testCfg.dryRunRepoPath, [])

    expect(await dirNames(testCfg.dryRunPublicDir)).toEqual(["stale-public"])
  })

  test("syncs direct runtime skills to public and private repos", async () => {
    await runSkillsSync(testCfg.syncHomeDir, testCfg.syncRepoPath)

    expect(await dirNames(testCfg.syncPublicDir)).toEqual([
      "public-false",
      "public-missing",
    ])
    expect(await dirNames(testCfg.syncPrivateDir)).toEqual([
      "private-string-true",
      "private-true",
    ])
    expect(await dirNames(testCfg.syncCodexDir)).toEqual([
      "private-string-true",
      "private-true",
      "public-false",
      "public-missing",
    ])

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
    expect(
      await Bun.file(
        join(testCfg.syncCodexDir, "public-false/reference.md"),
      ).text(),
    ).toBe("public-false reference\n")
  })

  test("copies skill-local readme and license files", async () => {
    expect(
      await Bun.file(
        join(testCfg.syncPublicDir, "public-false/README.md"),
      ).text(),
    ).toBe("public skill readme\n")
    expect(
      await Bun.file(
        join(testCfg.syncPublicDir, "public-false/LICENSE"),
      ).text(),
    ).toBe("public skill license\n")
  })

  test("reports healthy only when every destination is synchronized", async () => {
    const healthy = await skillsSyncResult(
      testCfg.syncHomeDir,
      testCfg.syncRepoPath,
      ["--health"],
    )
    expect(healthy).toMatchObject({ exitCode: 0, stderr: "" })
    expect(healthy.stdout).toContain("Skills sync is healthy.")

    await writeFile(
      join(testCfg.syncCodexDir, "public-false/reference.md"),
      "out of sync\n",
    )
    const drifted = await skillsSyncResult(
      testCfg.syncHomeDir,
      testCfg.syncRepoPath,
      ["--health"],
    )
    expect(drifted.exitCode).toBe(1)
    expect(drifted.stdout).toContain("public-false/reference.md")
  })

  test("keeps marksman config in destination dirs", async () => {
    expect(
      await Bun.file(join(testCfg.syncPublicDir, ".marksman.toml")).text(),
    ).toBe("[core]\n")
  })

  test("cleanup fixtures", async () => {
    await rm(testCfg.root, { recursive: true, force: true })
  })
})
