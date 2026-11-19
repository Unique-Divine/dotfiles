// Real temporary Git repositories for the git helper tests: a bare remote
// and a clone with one commit on main.
import { afterAll } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

/** Run-log home for these tests, so nothing writes into the real ~/.boku. */
export const testBokuHome = mkdtempSync(join(tmpdir(), "boku-home-"))
// Removed after the importing test file's last test, passing or failing.
// (bun test does not run process "exit" handlers.)
afterAll(() => {
  rmSync(testBokuHome, { recursive: true, force: true })
})

export type Result = { code: number; stdout: string; stderr: string }

// BOKU_RUNLOG=0: the run log costs about 60 ms per event and most git_mf
// tests never read it. Suites that assert on it pass BOKU_RUNLOG: "1".
const gitEnv = {
  BOKU_RUNLOG: "0",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
}

export async function sh(
  cwd: string,
  command: string,
  env: Record<string, string> = {},
): Promise<Result> {
  const proc = Bun.spawn(["bash", "-c", command], {
    cwd,
    env: { ...process.env, ...gitEnv, BOKU_HOME: testBokuHome, ...env },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, stdout, stderr }
}

export async function ok(cwd: string, command: string): Promise<string> {
  const r = await sh(cwd, command)
  if (r.code !== 0) {
    throw new Error(`${command} failed (${r.code}): ${r.stderr}`)
  }
  return r.stdout.trim()
}

const roots: string[] = []

export async function cleanup() {
  await Promise.all(
    roots.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  )
}

/** A temporary folder that `cleanup` removes, so a failing test leaks none. */
export async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  roots.push(dir)
  return dir
}

/** A bare remote, a `clone` of it on main, and a `peer` clone that can push. */
export async function repoPair() {
  const root = await mkdtemp(join(tmpdir(), "git-helpers-"))
  roots.push(root)
  const remote = join(root, "remote.git")
  const clone = join(root, "clone")
  const peer = join(root, "peer")
  await ok(root, `git init -q --bare --initial-branch=main ${remote}`)
  await ok(root, `git clone -q ${remote} ${peer}`)
  await ok(peer, "git switch -q -c main")
  await ok(peer, "printf 'one\\n' > file.txt && git add . && git commit -qm one")
  await ok(peer, "git push -q -u origin main")
  await ok(root, `git clone -q ${remote} ${clone}`)
  /** Commit `content` to file.txt on the remote's main through the peer. */
  const pushUpstream = async (content: string, file = "file.txt") => {
    await ok(
      peer,
      `printf '${content}\\n' > ${file} && git add . && git commit -qm upstream && git push -q`,
    )
    return ok(peer, "git rev-parse HEAD")
  }
  return { root, remote, clone, peer, pushUpstream }
}

/**
 * The folder holding a real jq binary. Tests that build their own PATH add
 * it, since jq may live outside /usr/bin (a mise install), and its mise shim
 * costs about 170 ms per call.
 */
export const jqDir: string = (() => {
  // spawnSync throws when mise isn't installed, as on CI runners.
  let fromMise = ""
  if (Bun.which("mise")) {
    const viaMise = Bun.spawnSync(["mise", "which", "jq"], {
      stdout: "pipe", stderr: "ignore",
    })
    if (viaMise.exitCode === 0) fromMise = viaMise.stdout.toString().trim()
  }
  if (fromMise) return dirname(fromMise)
  const found = Bun.which("jq")
  return found ? dirname(realpathSync(found)) : "/usr/bin"
})()
