/**
 * TS writer for the Boku run log. See docs/run-log-design.md.
 *
 * Every writer function fails open: the first error turns the writer off for
 * the rest of this process, and nothing here ever throws to the caller.
 */
import { createHash, randomBytes } from "node:crypto"
import {
  appendFileSync, chmodSync, mkdirSync, readFileSync,
  renameSync, statSync, writeFileSync,
} from "node:fs"
import { homedir, hostname } from "node:os"
import { basename, join, resolve, sep } from "node:path"

import patternsJson from "./redact-patterns.json"

export const schemaVersion = 1
/** Strings longer than this are cut and marked with `[cut]`. */
export const maxStringChars = 512
/** A line is at most this many bytes, not counting its newline. */
export const maxLineBytes = 4095
/** Artifacts are copied up to this many bytes. */
export const maxArtifactBytes = 20 * 1024 * 1024

export type Env = Record<string, string | undefined>
export type Fields = Record<string, unknown>
export type RunStatus = "ok" | "stopped" | "failed"

export interface RedactPattern {
  kind: string
  regex: string
}

/** Fields every event line starts with. */
export interface CommonFields {
  v: number
  ts: string
  source: string
  run_id: string
  parent_run_id: string | null
  root_run_id: string
  tool: string
  event: string
}

/** The identity of a run, shared by all its events. */
export interface RunIdentity {
  source: string
  runId: string
  parentRunId: string | null
  rootRunId: string
  tool: string
}

export interface GitInfo {
  repo: string
  branch: string
  head: string
}

export interface StartOptions {
  /** Arguments to log, redacted. Defaults to `process.argv.slice(2)`. */
  argv?: string[]
  cwd?: string
  /** Environment to read and export to. Defaults to `process.env`. */
  env?: Env
  /** Producer name. Defaults to `dotfiles`. */
  source?: string
  /** Dotfiles revision. Defaults to `git rev-parse --short HEAD` here. */
  rev?: string | null
  git?: GitInfo
  now?: () => Date
}

export interface EndOptions {
  status?: RunStatus
}

export interface RunLog {
  /** False when logging is off or the start event failed. */
  readonly active: boolean
  readonly runId: string | null
  readonly rootRunId: string | null
  /** Blob folder for this run, such as `<day>/<run_id>/`. */
  readonly runDir: string | null
  event(kind: string, fields?: Fields): void
  /** Runs `fn`, timing it, and logs a step with exit 0, or 1 if it throws. */
  step<T>(name: string, fn: () => T | Promise<T>, fields?: Fields): Promise<T>
  /** Copies `src` (capped, redacted) into the run folder. */
  artifact(kind: string, src: string): void
  end(exit: number, opts?: EndOptions): void
}

/** Per-process writer state: once off, the writer stays off. */
const writerState = { disabled: false }

export const redactPatterns: RedactPattern[] = patternsJson

/** Every pattern matches case-insensitively, in both writers. */
const compiledPatterns = (patterns: RedactPattern[]): [RegExp, string][] =>
  patterns.map((p) => [new RegExp(p.regex, "gi"), `[redacted:${p.kind}]`])

const defaultCompiled = compiledPatterns(redactPatterns)

/** Replaces every token shape in `text` with `[redacted:<kind>]`. */
export const redact = (
  text: string,
  patterns: RedactPattern[] = redactPatterns,
): string => {
  const compiled = patterns === redactPatterns
    ? defaultCompiled : compiledPatterns(patterns)
  let out = text
  for (const [regex, replacement] of compiled) {
    regex.lastIndex = 0
    out = out.replace(regex, replacement)
  }
  return out
}

/** Cuts a string to 512 characters plus `[cut]`. */
export const cutString = (text: string, max = maxStringChars): string =>
  text.length > max ? `${text.slice(0, max)}[cut]` : text

/** Redacts and cuts every string in a JSON-like value. */
export const cleanValue = (value: unknown): unknown => {
  if (typeof value === "string") return cutString(redact(value))
  if (Array.isArray(value)) return value.map(cleanValue)
  if (value !== null && typeof value === "object") {
    const out: Fields = {}
    for (const [key, inner] of Object.entries(value)) {
      if (inner !== undefined) out[key] = cleanValue(inner)
    }
    return out
  }
  return value
}

/** Maps an exit code to a status. An explicit status wins. */
export const statusFor = (exit: number, status?: RunStatus): RunStatus => {
  if (status) return status
  if (exit === 0) return "ok"
  if (exit >= 2 && exit <= 5) return "stopped"
  return "failed"
}

/** `yymmddTHHMMSSZ` for a date, in UTC. */
export const compactStamp = (date: Date): string =>
  date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").slice(2)

/**
 * Keeps a tool name safe for file names, as `_runlog_new_id` does: other
 * characters become `-`, 40 characters at most, `run` when empty.
 */
export const safeToolName = (tool: string): string =>
  tool.replace(/[^A-Za-z0-9_.-]/gu, "-").slice(0, 40) || "run"

/** The exact run id shape both writers emit. */
export const runIdPattern = /^\d{6}T\d{6}Z-[A-Za-z0-9_.-]{1,40}-[0-9a-f]{4}$/

export const isRunId = (value: string): boolean => runIdPattern.test(value)

/** `<yymmddTHHMMSSZ>-<tool>-<4 hex>`. */
export const newRunId = (
  tool: string,
  now: Date = new Date(),
  hex: string = randomBytes(2).toString("hex"),
): string => `${compactStamp(now)}-${safeToolName(tool)}-${hex}`

/** The UTC day folder name, `yymmdd`, encoded in a run id. */
export const dayOfRunId = (runId: string): string => runId.slice(0, 6)

/**
 * Builds one event line, without its newline. Strings are redacted and cut;
 * a line over 4,095 bytes falls back to the common fields plus
 * `"truncated": true`.
 */
export const buildEvent = (
  id: RunIdentity,
  kind: string,
  fields: Fields = {},
  now: Date = new Date(),
): string => {
  const common: CommonFields = {
    v: schemaVersion,
    ts: now.toISOString(),
    source: id.source,
    run_id: id.runId,
    parent_run_id: id.parentRunId,
    root_run_id: id.rootRunId,
    tool: id.tool,
    event: kind,
  }
  const cleanCommon = cleanValue(common) as Fields
  const own = cleanValue(fields) as Fields
  for (const key of Object.keys(common)) delete own[key]
  const line = JSON.stringify({ ...cleanCommon, ...own })
  if (Buffer.byteLength(line) <= maxLineBytes) return line
  return JSON.stringify({ ...cleanCommon, truncated: true })
}

export const bokuHome = (env: Env = process.env): string =>
  env.BOKU_HOME || join(homedir(), ".boku")

export const runsDir = (env: Env = process.env): string =>
  join(bokuHome(env), "runs")

export const runFilePath = (home: string, runId: string): string =>
  join(home, "runs", dayOfRunId(runId), `${runId}.jsonl`)

export const runDirPath = (home: string, runId: string): string =>
  join(home, "runs", dayOfRunId(runId), runId)

export const indexPath = (home: string, day: string): string =>
  join(home, "runs", day, "index.jsonl")

/**
 * A run's file and folder, after checking the whole id and that both paths
 * stay under `<home>/runs/`. Throws on anything else, so an id read from
 * the environment or an index line can't point outside the run log.
 */
export const checkedRunPaths = (
  home: string, runId: string,
): { file: string; dir: string } => {
  if (!isRunId(runId)) {
    throw new Error(`not a run id: ${JSON.stringify(cutString(runId, 80))}`)
  }
  const root = `${resolve(home, "runs")}${sep}`
  const file = resolve(runFilePath(home, runId))
  const dir = resolve(runDirPath(home, runId))
  if (!file.startsWith(root) || !dir.startsWith(root)) {
    throw new Error(`run id ${runId} leaves ${root}`)
  }
  return { file, dir }
}

/** Field 22 of `/proc/<pid>/stat`: start time in clock ticks since boot. */
export const readPidStart = (pid: number): number | null => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
    const value = Number(fields[22 - 3])
    return Number.isFinite(value) ? value : null
  } catch {
    return null
  }
}

export const readBootId = (): string | null => {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()
  } catch {
    return null
  }
}

const dotfilesRev = (): string | null => {
  try {
    const proc = Bun.spawnSync(
      ["git", "-C", import.meta.dir, "rev-parse", "--short", "HEAD"],
      { stdout: "pipe", stderr: "ignore" },
    )
    const rev = proc.stdout.toString().trim()
    return proc.exitCode === 0 && rev ? rev : null
  } catch {
    return null
  }
}

const debug = (env: Env, error: unknown): void => {
  if (env.BOKU_RUNLOG_DEBUG !== "1") return
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`boku runlog: off: ${message}\n`)
}

export const ensureDir = (dir: string): void => {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
}

/** Appends one line with a single write; the file is created `0600`. */
export const appendLine = (file: string, line: string): void => {
  appendFileSync(file, `${line}\n`, { mode: 0o600 })
}

export const isLoggingOff = (env: Env): boolean => env.BOKU_RUNLOG === "0"

/** Writes this run's events; shared by `startRun` and `attachRun`. */
interface Sink {
  write(kind: string, fields: Fields): boolean
}

const makeSink = (
  env: Env, home: string, id: RunIdentity, now: () => Date,
): Sink => ({
  write(kind, fields) {
    if (writerState.disabled) return false
    try {
      ensureDir(join(home, "runs", dayOfRunId(id.runId)))
      const line = buildEvent(id, kind, fields, now())
      appendLine(runFilePath(home, id.runId), line)
      return true
    } catch (error) {
      writerState.disabled = true
      debug(env, error)
      return false
    }
  },
})

const inactiveRun = (): RunLog => ({
  active: false,
  runId: null,
  rootRunId: null,
  runDir: null,
  event() {},
  async step(_name, fn) {
    return await fn()
  },
  artifact() {},
  end() {},
})

/**
 * Starts a run: writes `start` and exports `BOKU_RUN_ID` and
 * `BOKU_ROOT_RUN_ID` so child processes link to it.
 */
export const startRun = (tool: string, opts: StartOptions = {}): RunLog => {
  const env = opts.env ?? process.env
  const now = opts.now ?? (() => new Date())
  if (isLoggingOff(env) || writerState.disabled) {
    if (writerState.disabled) {
      delete env.BOKU_RUN_ID
      delete env.BOKU_ROOT_RUN_ID
    }
    return inactiveRun()
  }

  const startedAt = now()
  const parentRunId = env.BOKU_RUN_ID || null
  const runId = newRunId(tool, startedAt)
  const id: RunIdentity = {
    source: opts.source ?? "dotfiles",
    runId,
    parentRunId,
    rootRunId: (parentRunId && env.BOKU_ROOT_RUN_ID) || parentRunId || runId,
    tool: safeToolName(tool),
  }
  const home = bokuHome(env)
  const sink = makeSink(env, home, id, now)
  const runDir = runDirPath(home, runId)
  const counts = { warns: 0, errors: 0 }
  let agent: { cli: unknown; session_id: unknown } | null = null
  let ended = false

  try {
    ensureDir(home)
  } catch (error) {
    writerState.disabled = true
    debug(env, error)
  }
  const started = sink.write("start", {
    argv: opts.argv ?? process.argv.slice(2),
    cwd: opts.cwd ?? process.cwd(),
    host: hostname(),
    pid: process.pid,
    pid_start: readPidStart(process.pid),
    boot_id: readBootId(),
    rev: opts.rev === undefined ? dotfilesRev() : opts.rev,
    git: opts.git,
  })
  if (!started) {
    delete env.BOKU_RUN_ID
    delete env.BOKU_ROOT_RUN_ID
    return inactiveRun()
  }
  env.BOKU_RUN_ID = id.runId
  env.BOKU_ROOT_RUN_ID = id.rootRunId

  const event = (kind: string, fields: Fields = {}): void => {
    if (ended) return
    if (kind === "warn") counts.warns += 1
    if (kind === "error") counts.errors += 1
    if (kind === "agent" || kind === "agent-session") {
      agent = { cli: fields.cli, session_id: fields.session_id }
    }
    sink.write(kind, fields)
  }

  return {
    active: true,
    runId: id.runId,
    rootRunId: id.rootRunId,
    runDir,
    event,
    async step<T>(
      name: string, fn: () => T | Promise<T>, fields: Fields = {},
    ): Promise<T> {
      const t0 = Date.now()
      try {
        const value = await fn()
        event("step", { name, ...fields, exit: 0, dur_ms: Date.now() - t0 })
        return value
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        event("step", {
          name, ...fields, exit: 1, dur_ms: Date.now() - t0, msg,
        })
        throw error
      }
    },
    artifact(kind: string, src: string): void {
      if (ended || writerState.disabled) return
      try {
        ensureDir(runDir)
        const dest = join(runDir, basename(src))
        const size = statSync(src).size
        const truncated = size > maxArtifactBytes
        const raw = readFileSync(src).subarray(0, maxArtifactBytes)
        const text = redact(raw.toString("utf8"))
        const tmp = `${dest}.tmp-${process.pid}`
        writeFileSync(tmp, text, { mode: 0o600 })
        renameSync(tmp, dest)
        chmodSync(dest, 0o600)
        event("artifact", {
          kind,
          path: basename(dest),
          bytes: Buffer.byteLength(text),
          sha256: createHash("sha256").update(text).digest("hex"),
          truncated,
        })
      } catch (error) {
        writerState.disabled = true
        debug(env, error)
      }
    },
    end(exit: number, endOpts: EndOptions = {}): void {
      if (ended) return
      const status = statusFor(exit, endOpts.status)
      const durMs = now().getTime() - startedAt.getTime()
      const wrote = sink.write("end", {
        exit, status, dur_ms: durMs, warns: counts.warns, errors: counts.errors,
      })
      ended = true
      if (!wrote) return
      const index = indexLine({
        id, ts: startedAt.toISOString(), durMs, exit, status,
        warns: counts.warns, errors: counts.errors, agent,
      })
      try {
        appendLine(indexPath(home, dayOfRunId(id.runId)), index)
      } catch (error) {
        writerState.disabled = true
        debug(env, error)
      }
    },
  }
}

export interface IndexInput {
  id: RunIdentity
  /** Start time of the run. */
  ts: string
  durMs: number | null
  exit: number | null
  status: string
  warns: number
  errors: number
  agent: { cli: unknown; session_id: unknown } | null
}

/** The per-day index line for a run, cut and capped like an event. */
export const indexLine = (input: IndexInput): string => {
  const line = JSON.stringify(cleanValue({
    v: schemaVersion,
    ts: input.ts,
    source: input.id.source,
    run_id: input.id.runId,
    parent_run_id: input.id.parentRunId,
    root_run_id: input.id.rootRunId,
    tool: input.id.tool,
    dur_ms: input.durMs,
    exit: input.exit,
    status: input.status,
    warns: input.warns,
    errors: input.errors,
    agent: input.agent,
  }))
  if (Buffer.byteLength(line) <= maxLineBytes) return line
  return JSON.stringify(cleanValue({
    v: schemaVersion, ts: input.ts, run_id: input.id.runId,
    status: input.status, truncated: true,
  }))
}

/** Reads the identity of an existing run from its `start` line. */
export const readRunIdentity = (
  home: string, runId: string, rootRunId?: string,
): RunIdentity => {
  let start: Fields = {}
  try {
    const first = readFileSync(runFilePath(home, runId), "utf8").split("\n")[0]
    start = JSON.parse(first ?? "{}") as Fields
  } catch {
    start = {}
  }
  const str = (v: unknown): string | null => (typeof v === "string" ? v : null)
  return {
    source: str(start.source) ?? "dotfiles",
    runId,
    parentRunId: str(start.parent_run_id),
    rootRunId: str(start.root_run_id) ?? rootRunId ?? runId,
    tool: str(start.tool) ?? runId.split("-").slice(1, -1).join("-"),
  }
}

export interface AttachedRun {
  readonly active: boolean
  readonly runId: string | null
  readonly runDir: string | null
  event(kind: string, fields?: Fields): void
}

/**
 * Writes events into a run another process started, named by
 * `BOKU_RUN_ID`. Used by the tap; it writes neither `start` nor `end`.
 */
export const attachRun = (env: Env = process.env): AttachedRun => {
  const inactive: AttachedRun = {
    active: false, runId: null, runDir: null, event() {},
  }
  const runId = env.BOKU_RUN_ID
  if (isLoggingOff(env) || !runId) return inactive
  const home = bokuHome(env)
  let paths: { file: string; dir: string }
  try {
    paths = checkedRunPaths(home, runId)
  } catch (error) {
    debug(env, error)
    return inactive
  }
  const id = readRunIdentity(home, runId, env.BOKU_ROOT_RUN_ID)
  const sink = makeSink(env, home, id, () => new Date())
  return {
    active: true,
    runId,
    runDir: paths.dir,
    event(kind, fields = {}) {
      sink.write(kind, fields)
    },
  }
}
