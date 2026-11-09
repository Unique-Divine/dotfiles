/**
 * TS writer for the Boku run log. See docs/run-log-design.md.
 *
 * Every writer function fails open: the first write error turns the writer
 * off for the rest of this process, and nothing here ever throws to the
 * caller. A failed artifact only logs `warn artifact-failed`.
 */
import { createHash, randomBytes } from "node:crypto"
import {
  accessSync, chmodSync, closeSync, constants, lstatSync, mkdirSync,
  openSync, readFileSync, readSync, renameSync, rmSync, statSync,
  writeFileSync, writeSync,
} from "node:fs"
import { homedir, hostname } from "node:os"
import { join, resolve, sep } from "node:path"

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

/**
 * Every pattern matches case-insensitively, in both writers. A pattern jq
 * or JS can't compile is skipped; redact-parity.test.ts fails on it.
 */
const compiledPatterns = (patterns: RedactPattern[]): [RegExp, string][] => {
  const out: [RegExp, string][] = []
  for (const p of patterns) {
    try {
      out.push([new RegExp(p.regex, "gi"), `[redacted:${p.kind}]`])
    } catch {
      // Skipped, as runlog_start skips a pattern jq rejects.
    }
  }
  return out
}

const defaultCompiled = compiledPatterns(redactPatterns)

/**
 * A PEM or PGP private key header, as `pem_lines` in runlog.sh finds it:
 * `PRIVATE KEY-----` or `PRIVATE KEY BLOCK-----`.
 */
const pemBegin = /-----BEGIN [A-Z ]{0,30}PRIVATE KEY(?: BLOCK)?-----/i
/**
 * One base64 body line. The kept prefix is a diff mark, indentation (a
 * YAML `|` block), and a Read tool line number (`     2\t`).
 */
const pemBody = /^([-+ ]?[ \t]*(?:[0-9]+\t)?)[A-Za-z0-9+/=]{16,100}(\r?)$/
/** A blank or armor header line inside a block, with the same prefix. */
const pemKeep = new RegExp("^[-+ ]?[ \t]*(?:[0-9]+\t)?"
  + "(?:(?:Proc-Type|DEK-Info|Version|Comment|Charset|Hash):[^\n]*)?\r?$", "i")

/**
 * Replaces the body lines that follow a PEM private key header with
 * `[redacted:pem]`. A block ends at the first line that is neither a body
 * line, a blank line, nor an armor header (`Proc-Type:`, `DEK-Info:`,
 * `Version:`, `Comment:`, `Charset:`, `Hash:`), so a lone
 * header in code never eats the lines after it. Matches `pem_lines` in
 * runlog.sh.
 */
export const redactPemLines = (lines: string[]): string[] => {
  let inBlock = false
  return lines.map((line) => {
    if (line.includes("-----") && pemBegin.test(line)) {
      inBlock = true
      return line
    }
    if (!inBlock) return line
    const body = pemBody.exec(line)
    if (body) return `${body[1]}[redacted:pem]${body[2]}`
    if (!pemKeep.test(line)) inBlock = false
    return line
  })
}

/** `redactPemLines` on a multi-line string; other strings pass through. */
const redactPemText = (text: string): string =>
  text.includes("\n") && pemBegin.test(text)
    ? redactPemLines(text.split("\n")).join("\n") : text

/**
 * The replacement for one match: a `keep` group, when the pattern has one
 * and it took part, stays readable in front of `[redacted:<kind>]`, as
 * `"\(.keep // "")"` does in jq.
 */
const replacer = (replacement: string) =>
  (...args: unknown[]): string => {
    const groups = args.at(-1)
    const keep = groups !== null && typeof groups === "object"
      ? (groups as Record<string, string | undefined>).keep ?? "" : ""
    return `${keep}${replacement}`
  }

/**
 * Replaces every token shape in `text` with `[redacted:<kind>]`, after
 * redacting PEM body lines.
 */
export const redact = (
  text: string,
  patterns: RedactPattern[] = redactPatterns,
): string => {
  const compiled = patterns === redactPatterns
    ? defaultCompiled : compiledPatterns(patterns)
  let out = redactPemText(text)
  for (const [regex, replacement] of compiled) {
    regex.lastIndex = 0
    out = out.replace(regex, replacer(replacement))
  }
  return out
}

/** Redacts every string in a JSON value, at any depth, without a cut. */
export const redactValue = (value: unknown): unknown => {
  if (typeof value === "string") return redact(value)
  if (Array.isArray(value)) return value.map(redactValue)
  if (value !== null && typeof value === "object") {
    // fromEntries keeps a `__proto__` key as data, as JSON.parse does.
    return Object.fromEntries(Object.entries(value)
      .map(([key, inner]) => [key, redactValue(inner)]))
  }
  return value
}

/** A line that may be a JSON object or array, as jq's `decode_line` checks. */
const jsonCandidate = /^[ \t\r]*[{[]/

/**
 * Redacts one line. A JSON object or array first has its decoded strings
 * redacted, so `KEY=\"value\"` is seen as `KEY="value"`, and is re-encoded
 * only when a string changed. Every line is then redacted as text, which
 * catches `"password": "..."` pairs; no pattern consumes a backslash or
 * quote, so JSON stays valid. Matches `decode_line` and `redact_lines` in
 * runlog.sh.
 */
export const redactLine = (line: string): string => {
  let text = line
  if (jsonCandidate.test(line)) {
    try {
      const value: unknown = JSON.parse(line)
      const out = JSON.stringify(redactValue(value))
      if (out !== JSON.stringify(value)) text = out
    } catch {
      // Not JSON: text only.
    }
  }
  return redact(text)
}

/**
 * Redacts text one line at a time with `redactLine`, after the PEM body
 * lines across the whole text.
 */
export const redactLines = (text: string): string => {
  const lines = text.split("\n")
  return (pemBegin.test(text) ? redactPemLines(lines) : lines)
    .map(redactLine).join("\n")
}

/**
 * Cuts a string to 512 code points plus `[cut]`, as jq's `.[:512]` counts
 * them, so a surrogate pair is never split.
 */
export const cutString = (text: string, max = maxStringChars): string => {
  // UTF-16 length is at least the code point count.
  if (text.length <= max) return text
  let points = 0
  for (let i = 0; i < text.length; i++) {
    if (points === max) return `${text.slice(0, i)}[cut]`
    const unit = text.charCodeAt(i)
    const next = text.charCodeAt(i + 1)
    if (unit >= 0xd800 && unit <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
      i += 1
    }
    points += 1
  }
  return text
}

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

/**
 * Creates one folder (`0700`) unless it exists. Throws on a symlink or a
 * non-folder, so nothing is written through a planted link.
 */
export const ensureRealDir = (dir: string): void => {
  try {
    mkdirSync(dir, { mode: 0o700 })
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
  }
  const st = lstatSync(dir)
  if (st.isSymbolicLink()) throw new Error(`${dir} is a symlink`)
  if (!st.isDirectory()) throw new Error(`${dir} is not a folder`)
}

/** The `runs/` and day folders for a run, each checked by ensureRealDir. */
export const ensureDayDir = (home: string, runId: string): void => {
  ensureDir(home)
  ensureRealDir(join(home, "runs"))
  ensureRealDir(join(home, "runs", dayOfRunId(runId)))
}

const appendFlags = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT
  | constants.O_NOFOLLOW

/**
 * Appends one line with a single write; the file is created `0600`.
 * `O_NOFOLLOW` refuses a symlinked file.
 */
export const appendLine = (file: string, line: string): void => {
  const fd = openSync(file, appendFlags, 0o600)
  try {
    writeSync(fd, `${line}\n`)
  } finally {
    closeSync(fd)
  }
}

/** Creates `file` (`0600`) and fails if anything, a link too, is there. */
export const createExclusive = (file: string): void => {
  closeSync(openSync(file, constants.O_WRONLY | constants.O_CREAT
    | constants.O_EXCL | constants.O_NOFOLLOW, 0o600))
}

export const isLoggingOff = (env: Env): boolean => env.BOKU_RUNLOG === "0"

/** The artifact cap: `BOKU_RUNLOG_ARTIFACT_MAX` bytes, else 20 MiB. */
export const artifactMax = (env: Env): number => {
  const value = env.BOKU_RUNLOG_ARTIFACT_MAX ?? ""
  return /^\d+$/.test(value) ? Number(value) : maxArtifactBytes
}

/**
 * The file name an artifact gets, as `_runlog_artifact_name` names it. The
 * kind's last `-` becomes `.` (`remerge-diff` is `remerge.diff`); a kind
 * without `-` takes the source's extension, if any (`prompt` and `x.md`
 * give `prompt.md`).
 */
export const artifactName = (kind: string, src: string): string => {
  let name = (kind || "artifact").replace(/[^A-Za-z0-9_.-]/gu, "-")
  if (name.startsWith(".")) name = name.slice(1)
  // Bash would use these too; here they'd name the folder itself.
  if (name === "" || name === "." || name === "..") name = "artifact"
  const dash = name.lastIndexOf("-")
  if (dash >= 0) return `${name.slice(0, dash)}.${name.slice(dash + 1)}`
  const base = src.slice(src.lastIndexOf("/") + 1)
  const dot = base.lastIndexOf(".")
  const ext = base.slice(dot + 1)
  return dot >= 1 && /^[A-Za-z0-9]+$/.test(ext) ? `${name}.${ext}` : name
}

/**
 * Reads up to `max` bytes of a file. A capped copy ends at its last full
 * line, so no token is left half cut for redaction to miss.
 */
export const readCapped = (
  file: string, max: number,
): { data: Buffer; truncated: boolean } => {
  const size = statSync(file).size
  if (size <= max) return { data: readFileSync(file), truncated: false }
  const data = Buffer.alloc(max)
  const fd = openSync(file, "r")
  let got = 0
  try {
    while (got < max) {
      const n = readSync(fd, data, got, max - got, got)
      if (n === 0) break
      got += n
    }
  } finally {
    closeSync(fd)
  }
  const head = data.subarray(0, got)
  if (head.at(-1) === 0x0a) return { data: head, truncated: true }
  return { data: head.subarray(0, head.lastIndexOf(0x0a) + 1), truncated: true }
}

export interface ProblemCounts {
  warns: number
  errors: number
}

/** Counts `warn` and `error` lines in a run file; null if unreadable. */
export const countProblems = (file: string): ProblemCounts | null => {
  let text: string
  try {
    text = readFileSync(file, "utf8")
  } catch {
    return null
  }
  const counts: ProblemCounts = { warns: 0, errors: 0 }
  for (const line of text.split("\n")) {
    if (!line.includes('"event"')) continue
    let kind: unknown
    try {
      kind = (JSON.parse(line) as Fields).event
    } catch {
      continue
    }
    if (kind === "warn") counts.warns += 1
    if (kind === "error") counts.errors += 1
  }
  return counts
}

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
      ensureDayDir(home, id.runId)
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
  const home = bokuHome(env)
  // Claim the run file exclusively (no link followed), with a new id on a
  // clash, as `_runlog_open_files` does.
  let runId = newRunId(tool, startedAt)
  let claimed = false
  try {
    ensureDir(home)
    for (let tries = 1; !claimed; tries++) {
      ensureDayDir(home, runId)
      try {
        createExclusive(runFilePath(home, runId))
        claimed = true
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== "EEXIST" || tries >= 8) throw error
        runId = newRunId(tool, startedAt)
      }
    }
  } catch (error) {
    writerState.disabled = true
    debug(env, error)
  }
  const id: RunIdentity = {
    source: opts.source ?? "dotfiles",
    runId,
    parentRunId,
    rootRunId: (parentRunId && env.BOKU_ROOT_RUN_ID) || parentRunId || runId,
    tool: safeToolName(tool),
  }
  const sink = makeSink(env, home, id, now)
  const runDir = runDirPath(home, runId)
  const counts: ProblemCounts = { warns: 0, errors: 0 }
  let agent: { cli: unknown; session_id: unknown } | null = null
  let ended = false

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
    // No empty run file is left to be listed as incomplete.
    if (claimed) rmSync(runFilePath(home, runId), { force: true })
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
        if (!statSync(src).isFile()) throw new Error("not a file")
        accessSync(src, constants.R_OK)
      } catch {
        event("warn", { code: "artifact-missing", msg: `${kind}: ${src}` })
        return
      }
      try {
        ensureDayDir(home, id.runId)
        ensureRealDir(runDir)
      } catch (error) {
        // As runlog_dir: a run folder we can't use, a symlink among them,
        // turns the file writer off.
        writerState.disabled = true
        debug(env, error)
        return
      }
      let tmp: string | null = null
      try {
        const name = artifactName(kind, src)
        const dest = join(runDir, name)
        const { data, truncated } = readCapped(src, artifactMax(env))
        const text = redactLines(data.toString("utf8"))
        tmp = join(runDir, `.artifact.${process.pid}.${
          randomBytes(3).toString("hex")}`)
        writeFileSync(tmp, text, { mode: 0o600, flag: "wx" })
        renameSync(tmp, dest)
        tmp = null
        chmodSync(dest, 0o600)
        // A source inside the run folder is now replaced by its copy.
        const from = resolve(src)
        if (from.startsWith(`${resolve(runDir)}${sep}`) && from !== dest) {
          rmSync(from, { force: true })
        }
        event("artifact", {
          kind,
          path: name,
          bytes: Buffer.byteLength(text),
          sha256: createHash("sha256").update(text).digest("hex"),
          truncated,
        })
      } catch (error) {
        if (tmp) rmSync(tmp, { force: true })
        // Never leave an unredacted source in the run folder.
        if (resolve(src).startsWith(`${resolve(runDir)}${sep}`)) {
          rmSync(resolve(src), { force: true })
        }
        debug(env, error)
        // One lost artifact is worth a warning, not the rest of the log.
        event("warn", {
          code: "artifact-failed", msg: `cannot save artifact ${kind}`,
        })
      }
    },
    end(exit: number, endOpts: EndOptions = {}): void {
      if (ended) return
      const status = statusFor(exit, endOpts.status)
      const durMs = now().getTime() - startedAt.getTime()
      // Other processes (the tap) write warns too; the file has them all.
      const total = countProblems(runFilePath(home, id.runId)) ?? counts
      const wrote = sink.write("end", {
        exit, status, dur_ms: durMs, warns: total.warns, errors: total.errors,
      })
      ended = true
      if (!wrote) return
      const index = indexLine({
        id, ts: startedAt.toISOString(), durMs, exit, status,
        warns: total.warns, errors: total.errors, agent,
      })
      try {
        ensureDayDir(home, id.runId)
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
  // The common fields, as the bash writer's fallback keeps them.
  return JSON.stringify(cleanValue({
    v: schemaVersion,
    ts: input.ts,
    source: input.id.source,
    run_id: input.id.runId,
    parent_run_id: input.id.parentRunId,
    root_run_id: input.id.rootRunId,
    tool: input.id.tool,
    truncated: true,
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
