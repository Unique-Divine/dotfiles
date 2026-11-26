/**
 * Reindex the Mori code graph projects and rebuild cross-repo links.
 *
 * The MCP server watches only the repo of the active session, so the other
 * projects go stale until something reindexes them. A full reindex also
 * drops a project's cross-repo links, so linking reruns for every project
 * after all of them are indexed. Boku's reindex can abort with
 * `aborted_previous_preserved` when files change during the run; those runs
 * are retried.
 *
 * Usage: bun run cbm/reindex.ts [--run | --background | --status]
 *   [--repos a,b] [--no-link]
 *
 * Runs keep a lock, `status.json`, and (for --background) `last.log` in
 * `~/.cache/cbm-reindex/`.
 */
import { spawn } from "node:child_process"
import {
  closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync,
  readlinkSync, realpathSync, renameSync, writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { basename, delimiter, join } from "node:path"
import { Command as Program } from "commander"
import { manifestDirs } from "./repos"

/** Repos to index, from the manifest that `cbm/repos.ts` manages. */
export const defaultRepos = manifestDirs()

export interface Command {
  kind: "index" | "link"
  repo: string
  argv: string[]
  input: string
}

export interface Plan {
  commands: Command[]
  /** Repos skipped because their checkout is missing on this machine. */
  missing: string[]
}

export interface PlanOptions {
  home: string
  repos: string[]
  link: boolean
  bin: string
  exists: (path: string) => boolean
}

/**
 * Index every present repo, then link each one against all projects. Boku
 * links last: every refresh deletes a project's links, and Boku, where
 * agents write all day, refreshes most often.
 */
export function planReindex(opts: PlanOptions): Plan {
  const present: string[] = []
  const missing: string[] = []
  for (const repo of opts.repos) {
    const path = join(opts.home, repo)
    if (opts.exists(join(path, ".git"))) present.push(path)
    else missing.push(repo)
  }
  const argv = [opts.bin, "cli", "--quiet", "--json", "index_repository"]
  const commands: Command[] = present.map((path) => ({
    kind: "index",
    repo: path,
    argv,
    input: JSON.stringify({ repo_path: path }),
  }))
  if (opts.link) {
    const linkOrder = [
      ...present.filter((path) => basename(path) !== "boku"),
      ...present.filter((path) => basename(path) === "boku"),
    ]
    for (const path of linkOrder) {
      commands.push({
        kind: "link",
        repo: path,
        argv,
        input: JSON.stringify({
          repo_path: path,
          mode: "cross-repo-intelligence",
          target_projects: ["*"],
        }),
      })
    }
  }
  return { commands, missing }
}

export interface RunResult {
  exitCode: number
  stdout: string
  stderr: string
}

export type Outcome =
  | { ok: true; summary: string }
  | { ok: false; retry: boolean; reason: string }

/** Read the MCP result envelope that `cli --json` prints. */
export function readOutcome(cmd: Command, result: RunResult): Outcome {
  let body: Record<string, unknown> = {}
  try {
    const envelope = JSON.parse(result.stdout)
    if (envelope.isError) {
      const text = String(envelope.content?.[0]?.text ?? "tool error")
      return { ok: false, retry: /abort/i.test(text), reason: text }
    }
    body = envelope.structuredContent ?? JSON.parse(
      envelope.content?.[0]?.text ?? "{}")
  } catch {
    const reason = (result.stderr || result.stdout).trim().slice(0, 300) ||
      `exit ${result.exitCode}`
    return { ok: false, retry: /abort/i.test(reason), reason }
  }
  const status = String(body.status ?? "")
  const wanted = cmd.kind === "index" ? "indexed" : "success"
  if (result.exitCode === 0 && status === wanted) {
    const summary = cmd.kind === "index"
      ? `${body.nodes} nodes, ${body.edges} edges`
      : `${body.total_cross_edges} cross-repo edges`
    return { ok: true, summary }
  }
  const reason = `status ${status || "missing"}, exit ${result.exitCode}`
  return { ok: false, retry: /abort/i.test(JSON.stringify(body)), reason }
}

export type Runner = (cmd: Command) => Promise<RunResult>

/**
 * Run each command as a child. With `lockFd`, the child inherits the run
 * lock's descriptor as fd 3, so the lock stays held until the indexer exits
 * even if this process dies first.
 */
export const spawnRunner = (lockFd?: number): Runner => async (cmd) => {
  const proc = Bun.spawn(cmd.argv, {
    stdio: [new Blob([cmd.input]), "pipe", "pipe",
      ...(lockFd === undefined ? [] : [lockFd])],
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { exitCode, stdout, stderr }
}

export interface ExecuteOptions {
  run: Runner
  attempts: number
  sleep: (ms: number) => Promise<void>
  retryDelayMs: number
  log: (line: string) => void
  /** Called once per command with its final outcome. */
  record?: (cmd: Command, outcome: Outcome) => void
}

/**
 * Run the plan. A failed index skips that repo's link step but the others
 * continue; the returned list names every repo that failed.
 */
export async function execute(
  plan: Plan, opts: ExecuteOptions,
): Promise<string[]> {
  const failed = new Set<string>()
  for (const cmd of plan.commands) {
    if (failed.has(cmd.repo)) continue
    for (let attempt = 1; ; attempt++) {
      const started = Date.now()
      const outcome = readOutcome(cmd, await opts.run(cmd))
      const secs = ((Date.now() - started) / 1000).toFixed(0)
      if (outcome.ok) {
        opts.log(`${cmd.kind} ${cmd.repo}: ${outcome.summary} (${secs} s)`)
        opts.record?.(cmd, outcome)
        break
      }
      if (outcome.retry && attempt < opts.attempts) {
        opts.log(`${cmd.kind} ${cmd.repo}: ${outcome.reason}; retrying`)
        await opts.sleep(opts.retryDelayMs)
        continue
      }
      opts.log(`${cmd.kind} ${cmd.repo} failed: ${outcome.reason}`)
      opts.record?.(cmd, outcome)
      failed.add(cmd.repo)
      break
    }
  }
  return [...failed]
}

/** Where runs keep their lock, status, and log. */
export function stateDir(env: Record<string, string | undefined>): string {
  return join(env.XDG_CACHE_HOME || join(env.HOME || homedir(), ".cache"),
    "cbm-reindex")
}

/**
 * Runs hold an exclusive `flock` on `lock` for their whole life: `--run`
 * re-executes itself under `flock -n`, and the lock stays held while the run
 * or any child it started is alive. The kernel releases it when they exit or
 * are killed, so there is no stale lock to clear and no PID to trust.
 */
export const lockedEnv = "CBM_REINDEX_LOCKED"
/** Exit code `flock -n` returns when another run holds the lock. */
export const busyCode = 75

export function lockPath(dir: string): string {
  return join(dir, "lock")
}

export function underLock(dir: string, argv: string[]): string[] {
  return ["flock", "-n", "-E", String(busyCode), lockPath(dir), ...argv]
}

export interface Status {
  /** For display only; the lock, not this PID, says whether a run is live. */
  pid: number
  started: string
  ended: string | null
  exitCode: number | null
  missing: string[]
  /** Per repo path: "index" and "link" hold a summary or "failed: why". */
  repos: Record<string, { index?: string; link?: string }>
}

export function writeStatus(dir: string, status: Status): void {
  const path = join(dir, "status.json")
  writeFileSync(`${path}.tmp`, `${JSON.stringify(status, null, 2)}\n`)
  renameSync(`${path}.tmp`, path)
}

export function readStatus(dir: string): Status | undefined {
  try {
    return JSON.parse(readFileSync(join(dir, "status.json"), "utf8"))
  } catch {
    return undefined
  }
}

/**
 * Run the plan, recording progress in `status.json`. The caller holds the
 * lock (see `underLock`). Returns 0, or 1 when a repo failed.
 */
export async function runPlan(
  plan: Plan, dir: string, opts: ExecuteOptions,
  pid = process.pid, now = () => new Date().toISOString(),
): Promise<number> {
  const status: Status = {
    pid, started: now(), ended: null, exitCode: null,
    missing: plan.missing, repos: {},
  }
  try {
    writeStatus(dir, status)
    const failed = await execute(plan, {
      ...opts,
      record: (cmd, outcome) => {
        const entry = status.repos[cmd.repo] ??= {}
        entry[cmd.kind] = outcome.ok ? outcome.summary
          : `failed: ${outcome.reason}`
        writeStatus(dir, status)
      },
    })
    status.exitCode = failed.length > 0 ? 1 : 0
    if (failed.length > 0) {
      opts.log(`cbm-reindex failed for: ${failed.join(", ")}`)
    }
  } catch (err) {
    status.exitCode = 1
    opts.log(`cbm-reindex crashed: ${err}`)
  } finally {
    status.ended = now()
    writeStatus(dir, status)
  }
  return status.exitCode ?? 1
}

export type Launch =
  | { started: true; pid: number; log: string }
  | { started: false; pid: number }

/** Start a process that outlives this one, writing to the given log fd. */
export type Spawner = (argv: string[], logFd: number) => number

export const detachedSpawner: Spawner = (argv, logFd) => {
  const child = spawn(argv[0]!, argv.slice(1), {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env, [lockedEnv]: "1" },
  })
  child.unref()
  return child.pid ?? -1
}

/**
 * The descriptor through which this process holds the lock: `flock` opens
 * the lock file and the run inherits it. Undefined without /proc.
 */
export function inheritedLockFd(dir: string): number | undefined {
  try {
    const target = realpathSync(lockPath(dir))
    for (const entry of readdirSync("/proc/self/fd")) {
      try {
        if (readlinkSync(`/proc/self/fd/${entry}`) === target) {
          return Number(entry)
        }
      } catch {
        // The fd closed while listing (readdir's own handle, for one).
      }
    }
  } catch {
    // No /proc or no lock file.
  }
  return undefined
}

/** Whether a run holds the lock right now. */
export function isLocked(dir: string): boolean {
  if (!existsSync(lockPath(dir))) return false
  return Bun.spawnSync(underLock(dir, ["true"])).exitCode === busyCode
}

/**
 * Start a `--run` under the lock in its own session, so it survives the
 * caller (`just sync`) exiting. Returns at once. If two launches race past
 * the `isLocked` check, `flock -n` lets only one of them run.
 */
export function launchBackground(
  dir: string, argv: string[], spawner: Spawner = detachedSpawner,
  locked: (dir: string) => boolean = isLocked,
): Launch {
  if (locked(dir)) {
    return { started: false, pid: readStatus(dir)?.pid ?? -1 }
  }
  mkdirSync(dir, { recursive: true })
  const log = join(dir, "last.log")
  const fd = openSync(log, "w")
  argv = underLock(dir, argv)
  try {
    return { started: true, pid: spawner(argv, fd), log }
  } finally {
    closeSync(fd)
  }
}

export function formatStatus(
  status: Status | undefined, running: boolean,
): string {
  if (!status) return "cbm-reindex has not run yet"
  const state = status.ended === null
    ? (running ? "running" : "interrupted")
    : `exit ${status.exitCode}`
  const lines = [
    `cbm-reindex ${state}: started ${status.started}` +
      (status.ended ? `, ended ${status.ended}` : ""),
  ]
  for (const [repo, result] of Object.entries(status.repos)) {
    lines.push(`  ${repo}: index ${result.index ?? "-"}; ` +
      `link ${result.link ?? "-"}`)
  }
  for (const repo of status.missing) lines.push(`  ${repo}: no checkout`)
  return lines.join("\n")
}

export function formatPlan(plan: Plan): string {
  const lines = plan.commands.map((cmd) =>
    `${cmd.argv.join(" ")} <<< '${cmd.input}'`)
  for (const repo of plan.missing) lines.push(`# skip ${repo}: no checkout`)
  return lines.join("\n")
}

interface CliOptions {
  run?: boolean
  plan?: boolean
  background?: boolean
  status?: boolean
  repos?: string
  link: boolean
  quiet?: boolean
}

function findGraphExecutable(name: string): string | null {
  const mise = Bun.which("mise")
  const misePath = mise ? realpathSync(mise) : null
  for (const directory of process.env.PATH?.split(delimiter) ?? [undefined]) {
    const bin = Bun.which(name, { PATH: directory === "" ? "." : directory })
    if (!bin) continue
    const dispatcher = realpathSync(bin)
    if (basename(dispatcher) !== "mise" && dispatcher !== misePath) return bin

    // A shim can remain on PATH after rollback. Probe the selected version
    // before accepting the shim, then keep searching for the same name.
    const selection = Bun.spawnSync([dispatcher, "which", name], {
      stdout: "ignore", stderr: "ignore",
    })
    if (selection.success) return bin
  }
  return null
}

export function createProgram(): Program {
  return new Program()
    .name("cbm-reindex")
    .description(
      "Reindex Mori code graph projects, then rerun cross-repo linking.",
    )
    .option("--run", "run the plan in the foreground")
    .option("--plan", "print the plan, even with --run")
    .option("--background",
      "start a --run detached and return; see --status")
    .option("--status", "print the last run's result")
    .option("--repos <dirs>", "comma-separated dirs under ~ to index",
      defaultRepos.join(","))
    .option("--no-link", "skip cross-repo linking")
    .option("--quiet", "print only failures with --run")
    .action(async (options: CliOptions) => {
      const dir = stateDir(process.env)
      if (options.status) {
        console.log(formatStatus(readStatus(dir), isLocked(dir)))
        return
      }
      const bin = findGraphExecutable("mori") ??
        findGraphExecutable("codebase-memory-mcp")
      if (!bin) {
        console.log("Mori is not installed; skipping")
        return
      }
      const plan = planReindex({
        home: homedir(),
        repos: (options.repos ?? "").split(",").filter(Boolean),
        link: options.link,
        bin,
        exists: existsSync,
      })
      if (options.plan || !(options.run || options.background)) {
        console.log(formatPlan(plan))
        return
      }
      mkdirSync(dir, { recursive: true })
      if (options.run && !options.background &&
        process.env[lockedEnv] !== "1") {
        // Re-run this command under the lock; flock exits 75 if it's held.
        const proc = Bun.spawn(
          underLock(dir, [process.execPath, import.meta.path,
            ...process.argv.slice(2)]),
          { env: { ...process.env, [lockedEnv]: "1" }, stdio: ["inherit",
            "inherit", "inherit"] })
        const code = await proc.exited
        if (code === busyCode) {
          const pid = readStatus(dir)?.pid ?? "unknown"
          console.log(`cbm-reindex is already running (pid ${pid})`)
          process.exitCode = 2
        } else {
          process.exitCode = code
        }
        return
      }
      if (options.background) {
        const argv = [process.execPath, import.meta.path, "--run",
          "--repos", options.repos ?? "", ...(options.link ? [] : ["--no-link"])]
        const launch = launchBackground(dir, argv)
        console.log(launch.started
          ? `cbm-reindex started in the background (pid ${launch.pid}); ` +
            `log ${launch.log}, result: just cbm-status`
          : `cbm-reindex is already running (pid ${launch.pid})`)
        return
      }
      process.exitCode = await runPlan(plan, dir, {
        run: spawnRunner(inheritedLockFd(dir)),
        attempts: 3,
        retryDelayMs: 15_000,
        sleep: (ms) => Bun.sleep(ms),
        log: (line) => {
          const quiet = options.quiet && !/failed|crashed|running/.test(line)
          if (!quiet) console.log(line)
        },
      })
    })
}

if (import.meta.main) {
  await createProgram().parseAsync()
}
