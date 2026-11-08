import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const dotfilesRoot = join(import.meta.dir, "..")
const scriptPath = join(dotfilesRoot, "zsh", "sync-jiyuu.sh")
const temporaryRoots: string[] = []

type CommandResult = {
  exitCode: number
  stderr: string
  stdout: string
}

const run = async (
  cwd: string,
  command: string,
  env: Record<string, string> = {},
): Promise<CommandResult> => {
  const proc = Bun.spawn(["bash", "-lc", command], {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
      ...env,
    },
    stderr: "pipe",
    stdout: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { exitCode, stderr, stdout }
}

const expectOk = async (
  cwd: string,
  command: string,
  env?: Record<string, string>,
): Promise<string> => {
  const result = await run(cwd, command, env)
  expect(result.exitCode).toBe(0)
  return result.stdout.trim()
}

const createFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "dotfiles-jiyuu-"))
  temporaryRoots.push(root)
  const remote = join(root, "jiyuu.git")
  const source = join(root, "jiyuu-source")
  const bokuSource = join(root, "boku-source")
  const boku = join(root, "boku")

  await expectOk(root, `git init --bare ${remote}`)
  await expectOk(root, `git init --initial-branch=main ${source}`)
  await expectOk(source, "git config user.email test@example.com")
  await expectOk(source, "git config user.name Test")
  await expectOk(
    source,
    "mkdir -p gh-rev && printf '[package]\\nname = \"gh-rev\"\\nversion = \"0.1.0\"\\n' > gh-rev/Cargo.toml",
  )
  await expectOk(source, "git add gh-rev/Cargo.toml && git commit -m initial")
  await expectOk(source, `git remote add origin ${remote} && git push -u origin main`)

  await expectOk(root, `git init --initial-branch=main ${bokuSource}`)
  await expectOk(bokuSource, "git config user.email test@example.com")
  await expectOk(bokuSource, "git config user.name Test")
  await expectOk(
    bokuSource,
    `git -c protocol.file.allow=always submodule add -b main ${remote} jiyuu && git commit -m jiyuu`,
  )

  await writeFile(join(source, "gh-rev", "LATEST"), "latest\n")
  await expectOk(source, "git add gh-rev/LATEST && git commit -m latest && git push")
  const latest = await expectOk(source, "git rev-parse HEAD")

  await expectOk(root, `git clone ${bokuSource} ${boku}`)
  return { boku, latest, root, source }
}

const syncOnce = (root: string) =>
  run(root, `bash ${scriptPath}`, { GIT_ALLOW_PROTOCOL: "file", REPO: root })

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true })),
  )
})

describe("sync-jiyuu.sh", () => {
  test("initializes Jiyuu on main at the latest remote commit", async () => {
    const { boku, latest, root } = await createFixture()
    const result = await run(root, `bash ${scriptPath}`, {
      GIT_ALLOW_PROTOCOL: "file",
      REPO: root,
    })

    expect(result.exitCode, result.stderr).toBe(0)
    expect(await expectOk(boku, "git -C jiyuu rev-parse HEAD")).toBe(latest)
    expect(await expectOk(boku, "git -C jiyuu branch --show-current")).toBe(
      "main",
    )
  })

  test("merges origin/main into the branch Jiyuu is on", async () => {
    const { boku, root, source } = await createFixture()
    await syncOnce(root)
    await expectOk(boku, "git -C jiyuu switch -q -c feature")
    await expectOk(
      boku,
      "printf mine > jiyuu/MINE && git -C jiyuu add MINE && git -C jiyuu commit -qm mine",
    )
    await writeFile(join(source, "UPSTREAM"), "upstream\n")
    await expectOk(source, "git add UPSTREAM && git commit -qm upstream && git push -q")
    const upstream = await expectOk(source, "git rev-parse HEAD")

    const result = await syncOnce(root)
    expect(result.exitCode, result.stderr).toBe(0)
    expect(await expectOk(boku, "git -C jiyuu branch --show-current")).toBe(
      "feature",
    )
    expect(
      await expectOk(boku, `git -C jiyuu merge-base --is-ancestor ${upstream} HEAD && echo yes`),
    ).toBe("yes")
  })

  test("a conflict leaves Jiyuu as it was and the sync continues", async () => {
    const { boku, root, source } = await createFixture()
    await syncOnce(root)
    await expectOk(boku, "git -C jiyuu switch -q -c feature")
    await expectOk(
      boku,
      "printf mine > jiyuu/gh-rev/LATEST && git -C jiyuu commit -qam mine",
    )
    await writeFile(join(source, "gh-rev", "LATEST"), "theirs\n")
    await expectOk(source, "git commit -qam theirs && git push -q")
    const before = await expectOk(boku, "git -C jiyuu rev-parse HEAD")

    const result = await syncOnce(root)
    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.stderr).toContain("conflicts in: gh-rev/LATEST")
    expect(result.stderr).toContain("left Jiyuu as it is")
    expect(await expectOk(boku, "git -C jiyuu rev-parse HEAD")).toBe(before)
    expect(await expectOk(boku, "git -C jiyuu status --porcelain")).toBe("")
  })

  test.each(["staged", "unstaged", "untracked"])(
    "leaves a %s Jiyuu checkout untouched",
    async (state) => {
      const { boku, root } = await createFixture()
      await expectOk(
        boku,
        "git -c protocol.file.allow=always submodule update --init jiyuu",
      )
      const before = await expectOk(boku, "git -C jiyuu rev-parse HEAD")

      if (state === "staged") {
        await expectOk(
          boku,
          "printf staged > jiyuu/gh-rev/LOCAL && git -C jiyuu add gh-rev/LOCAL",
        )
      } else if (state === "unstaged") {
        await expectOk(boku, "printf unstaged > jiyuu/gh-rev/LOCAL")
      } else {
        await expectOk(boku, "printf untracked > jiyuu/LOCAL")
      }

      const result = await run(root, `bash ${scriptPath}`, {
        GIT_ALLOW_PROTOCOL: "file",
        REPO: root,
      })

      expect(result.exitCode, result.stderr).toBe(0)
      expect(result.stderr).toContain("uncommitted changes")
      expect(result.stderr).toContain("left Jiyuu as it is")
      expect(await expectOk(boku, "git -C jiyuu rev-parse HEAD")).toBe(before)
    },
  )
})
