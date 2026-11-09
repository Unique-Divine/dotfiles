#!/usr/bin/env bun
/**
 * boku-runs: reader, tap, prune, and redact-file for the Boku run log.
 * See docs/run-log-design.md.
 */
import {
  appendFileSync, chmodSync, existsSync, lstatSync, readFileSync, readdirSync,
  renameSync, rmSync, writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"
import { Command } from "commander"

import {
  attachRun, bokuHome, checkedRunPaths, cutString, ensureDir, indexLine,
  indexPath, isRunId, readBootId, readPidStart, redact, runFilePath,
  startRun, type Env, type Fields, type RunIdentity,
} from "./runlog.ts"

const dayMs = 24 * 60 * 60 * 1000
/** Stream lines longer than this are cut in place. */
export const maxStreamLineChars = 16384
/** The tap stops copying the stream after this many bytes. */
export const maxCopyBytes = 20 * 1024 * 1024
/** Prune removes the oldest days while `runs/` is larger than this. */
export const maxRunsBytes = 512 * 1024 * 1024
export const tapNotice =
  "boku-runs tap: progress display stopped; output still saved"

export type Event = Fields & { event?: string; ts?: string; run_id?: string }
export type ListStatus = "ok" | "stopped" | "failed" | "running" | "incomplete"

export interface RunSummary {
  runId: string
  parentRunId: string | null
  rootRunId: string
  tool: string
  /** Start time, ISO UTC. */
  ts: string
  durMs: number | null
  exit: number | null
  status: ListStatus | string
  warns: number
  errors: number
  agent: { cli: unknown; session_id: unknown } | null
}

/** What `running` versus `incomplete` depends on, read from this machine. */
export interface LiveProbe {
  linux: boolean
  bootId: string | null
  pidStart(pid: number): number | null
}

export const systemProbe = (): LiveProbe => ({
  linux: process.platform === "linux",
  bootId: readBootId(),
  pidStart: readPidStart,
})

// ---------------------------------------------------------------- days

/** `yymmdd` for a date in UTC. */
export const dayOf = (date: Date): string =>
  date.toISOString().slice(2, 10).replace(/-/g, "")

/** Midnight UTC of a `yymmdd` day. */
export const dayToDate = (day: string): Date =>
  new Date(Date.UTC(2000 + Number(day.slice(0, 2)),
    Number(day.slice(2, 4)) - 1, Number(day.slice(4, 6))))

/** Today and yesterday in UTC: days whose files may still be appended to. */
export const recentDays = (now: Date): Set<string> =>
  new Set([dayOf(now), dayOf(new Date(now.getTime() - dayMs))])

/** Whole days between a day folder and today, in UTC. */
export const dayAge = (day: string, now: Date): number =>
  Math.round(
    (dayToDate(dayOf(now)).getTime() - dayToDate(day).getTime()) / dayMs)

const isDay = (name: string): boolean => /^\d{6}$/.test(name)
const isRunFile = (name: string): boolean =>
  name.endsWith(".jsonl") && isRunId(name.slice(0, -".jsonl".length))

export const listDays = (home: string): string[] => {
  try {
    return readdirSync(join(home, "runs")).filter(isDay).sort()
  } catch {
    return []
  }
}

// ---------------------------------------------------------------- reading

/** Parses JSONL leniently: bad lines are skipped. */
export const parseJsonl = (text: string): Event[] => {
  const out: Event[] = []
  for (const line of text.split("\n")) {
    if (!line.trim()) continue
    try {
      const value = JSON.parse(line) as unknown
      if (value && typeof value === "object") out.push(value as Event)
    } catch {
      // A torn or foreign line; skip it.
    }
  }
  return out
}

const readJsonl = (file: string): Event[] => {
  try {
    return parseJsonl(readFileSync(file, "utf8"))
  } catch {
    return []
  }
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null)
const num = (v: unknown): number | null => (typeof v === "number" ? v : null)

/** Status of a run with no `end`: alive with the same start, or not. */
export const liveStatus = (
  start: Event, probe: LiveProbe, now: Date,
): "running" | "incomplete" => {
  if (!probe.linux) {
    const startMs = Date.parse(str(start.ts) ?? "")
    return now.getTime() - startMs < dayMs ? "running" : "incomplete"
  }
  const pid = num(start.pid)
  const pidStart = num(start.pid_start)
  if (pid === null || pidStart === null) return "incomplete"
  if (!probe.bootId || start.boot_id !== probe.bootId) return "incomplete"
  return probe.pidStart(pid) === pidStart ? "running" : "incomplete"
}

/** Summarizes a run from its own events. */
export const summarizeEvents = (
  runId: string,
  events: Event[],
  noEnd: (start: Event) => ListStatus,
): RunSummary => {
  const start = events.find((e) => e.event === "start") ?? events[0] ?? {}
  const end = events.find((e) => e.event === "end")
  let agent: RunSummary["agent"] = null
  for (const e of events) {
    if (e.event === "agent" || e.event === "agent-session") {
      agent = { cli: e.cli ?? null, session_id: e.session_id ?? null }
    }
  }
  const count = (kind: string): number =>
    events.filter((e) => e.event === kind).length
  return {
    runId,
    parentRunId: str(start.parent_run_id),
    rootRunId: str(start.root_run_id) ?? runId,
    tool: str(start.tool) ?? runId.split("-").slice(1, -1).join("-"),
    ts: str(start.ts) ?? "",
    durMs: end ? num(end.dur_ms) : null,
    exit: end ? num(end.exit) : null,
    status: end ? str(end.status) ?? "ok" : noEnd(start),
    warns: num(end?.warns) ?? count("warn"),
    errors: num(end?.errors) ?? count("error"),
    agent,
  }
}

export const summaryFromIndex = (line: Event): RunSummary | null => {
  const runId = str(line.run_id)
  // An id that isn't the exact shape could name a path outside runs/.
  if (!runId || !isRunId(runId)) return null
  return {
    runId,
    parentRunId: str(line.parent_run_id),
    rootRunId: str(line.root_run_id) ?? runId,
    tool: str(line.tool) ?? "",
    ts: str(line.ts) ?? "",
    durMs: num(line.dur_ms),
    exit: num(line.exit),
    status: str(line.status) ?? "ok",
    warns: num(line.warns) ?? 0,
    errors: num(line.errors) ?? 0,
    agent: (line.agent as RunSummary["agent"]) ?? null,
  }
}

/** Ids of a day's run files, sorted. */
export const runFileIds = (home: string, day: string): string[] => {
  try {
    return readdirSync(join(home, "runs", day)).filter(isRunFile)
      .map((name) => name.slice(0, -".jsonl".length)).sort()
  } catch {
    return []
  }
}

/** Summaries from a day's run files, read directly, except `skip`. */
export const scanDay = (
  home: string, day: string, noEnd: (start: Event) => ListStatus,
  skip: ReadonlySet<string> = new Set(),
): RunSummary[] => runFileIds(home, day)
  .filter((runId) => !skip.has(runId))
  .map((runId) => summarizeEvents(
    runId, readJsonl(runFilePath(home, runId)), noEnd))

/** A past day's index summaries, one per run id. */
const indexSummaries = (home: string, day: string): RunSummary[] => {
  const byId = new Map<string, RunSummary>()
  for (const line of readJsonl(indexPath(home, day))) {
    const summary = summaryFromIndex(line)
    if (summary && !byId.has(summary.runId)) byId.set(summary.runId, summary)
  }
  return [...byId.values()]
}

/** True when a day has run files its index is missing, or no index. */
export const indexIncomplete = (home: string, day: string): boolean => {
  const ids = runFileIds(home, day)
  if (!ids.length) return false
  if (!existsSync(indexPath(home, day))) return true
  const listed = new Set(indexSummaries(home, day).map((r) => r.runId))
  return ids.some((runId) => !listed.has(runId))
}

/**
 * Every run, oldest first. Today and yesterday are read from run files.
 * Older days come from their index, plus any run file the index lacks: a
 * killed run never writes its index line.
 */
export const loadRuns = (
  home: string, now: Date = new Date(), probe: LiveProbe = systemProbe(),
): RunSummary[] => {
  const recent = recentDays(now)
  const live = (start: Event): ListStatus => liveStatus(start, probe, now)
  const runs: RunSummary[] = []
  for (const day of listDays(home)) {
    if (recent.has(day)) {
      runs.push(...scanDay(home, day, live))
      continue
    }
    const indexed = indexSummaries(home, day)
    runs.push(...indexed)
    const skip = new Set(indexed.map((r) => r.runId))
    runs.push(...scanDay(home, day, () => "incomplete", skip))
  }
  return runs.sort(compareRuns)
}

/** Milliseconds of the `yymmddTHHMMSSZ` stamp a run id starts with. */
export const stampMs = (runId: string): number => {
  const m = /^(\d{2})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/.exec(runId)
  if (!m) return 0
  const [y, mo, d, h, mi, se] = m.slice(1).map(Number) as number[]
  return Date.UTC(2000 + y!, mo! - 1, d!, h!, mi!, se!)
}

/** A run's start time in ms: its `ts`, else the stamp in its id. */
export const startMs = (run: RunSummary): number => {
  const ms = Date.parse(run.ts)
  return Number.isFinite(ms) ? ms : stampMs(run.runId)
}

/**
 * Oldest first by start time. The id only breaks ties: its 4 hex digits
 * are random, so runs started in the same second would sort at random.
 */
export const compareRuns = (a: RunSummary, b: RunSummary): number =>
  startMs(a) - startMs(b)
    || (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0)

/** Resolves `last` or any unique suffix of a run id. */
export const resolveRunId = (runs: RunSummary[], query: string): string => {
  if (query === "last") {
    const top = runs.filter((r) => r.parentRunId === null)
    const last = top.at(-1)
    if (!last) throw new Error("no runs yet")
    return last.runId
  }
  const ids = [...new Set(runs.map((r) => r.runId))]
  const exact = ids.find((id) => id === query)
  if (exact) return exact
  const matches = ids.filter((id) => id.endsWith(query))
  if (matches.length === 1) return matches[0]!
  if (matches.length === 0) throw new Error(`no run matches "${query}"`)
  throw new Error(`"${query}" matches ${matches.length} runs:\n  ${
    matches.join("\n  ")}`)
}

// ---------------------------------------------------------------- format

export const formatDuration = (ms: number | null): string => {
  if (ms === null) return "-"
  if (ms < 1000) return `${ms}ms`
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`
}

/** Warns and errors summed over a run and its descendants. */
export const treeCounts = (
  runs: RunSummary[], runId: string,
): { warns: number; errors: number } => {
  const byParent = childrenByParent(runs)
  const total = { warns: 0, errors: 0 }
  const visit = (id: string): void => {
    const run = runs.find((r) => r.runId === id)
    if (run) {
      total.warns += run.warns
      total.errors += run.errors
    }
    for (const child of byParent.get(id) ?? []) visit(child.runId)
  }
  visit(runId)
  return total
}

const childrenByParent = (runs: RunSummary[]): Map<string, RunSummary[]> => {
  const map = new Map<string, RunSummary[]>()
  for (const run of runs) {
    if (!run.parentRunId) continue
    map.set(run.parentRunId, [...(map.get(run.parentRunId) ?? []), run])
  }
  return map
}

export const formatSummary = (
  run: RunSummary, counts = { warns: run.warns, errors: run.errors },
): string => [
  run.ts.slice(0, 19).replace("T", " ") || "-".padEnd(19),
  run.status.padEnd(10),
  `exit=${run.exit ?? "-"}`.padEnd(8),
  formatDuration(run.durMs).padStart(7),
  `w${counts.warns} e${counts.errors}`.padEnd(7),
  run.runId,
].join("  ")

/** The last `limit` top-level runs, newest first. */
export const listLines = (runs: RunSummary[], limit = 20): string[] =>
  runs.filter((r) => r.parentRunId === null).slice(-limit).reverse()
    .map((r) => formatSummary(r, treeCounts(runs, r.runId)))

const commonKeys = new Set([
  "v", "ts", "source", "run_id", "parent_run_id", "root_run_id", "tool",
  "event",
])

const formatValue = (value: unknown): string =>
  typeof value === "string" && /^[^\s"=]+$/.test(value)
    ? value : JSON.stringify(value)

/** One readable line for an event. */
export const formatEvent = (event: Event): string => {
  const time = str(event.ts)?.slice(11, 23) ?? "-"
  const fields = Object.entries(event)
    .filter(([key]) => !commonKeys.has(key))
    .map(([key, value]) => `${key}=${formatValue(value)}`)
  return `${time}  ${String(event.event ?? "?").padEnd(13)} ${
    fields.join(" ")}`.trimEnd()
}

export const showLines = (
  home: string, runs: RunSummary[], runId: string, tree: boolean,
  depth = 0,
): string[] => {
  const pad = "  ".repeat(depth)
  const run = runs.find((r) => r.runId === runId)
  const header = run
    ? `${run.runId}  ${run.tool}  ${run.status}  exit=${run.exit ?? "-"}  ${
      formatDuration(run.durMs)}`
    : runId
  const lines = [`${pad}${header}`]
  for (const event of readJsonl(checkedRunPaths(home, runId).file)) {
    lines.push(`${pad}  ${formatEvent(event)}`)
  }
  if (tree) {
    for (const child of childrenByParent(runs).get(runId) ?? []) {
      lines.push(...showLines(home, runs, child.runId, true, depth + 1))
    }
  }
  return lines
}

// ---------------------------------------------------------------- agent view

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content.map((c) => str((c as Fields)?.text) ?? "").join("\n")
  }
  return ""
}

const oneLine = (text: string, max = 100): string => {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max)}...` : flat
}

const toolArg = (input: Fields): string =>
  str(input.command) ?? str(input.file_path) ?? str(input.pattern)
    ?? str(input.path) ?? str(input.description) ?? ""

/** One readable line for a Claude or Codex stream line. */
export const describeStreamLine = (line: string): string => {
  let obj: Fields
  try {
    obj = JSON.parse(line) as Fields
  } catch {
    return `(not JSON) ${oneLine(line)}`
  }
  const type = str(obj.type) ?? "?"
  const message = (obj.message ?? {}) as Fields
  const item = (obj.item ?? {}) as Fields
  if (type === "system") {
    const sid = obj.session_id ? ` session=${obj.session_id}` : ""
    return `system ${obj.subtype ?? ""}${sid}`
  }
  if (type === "assistant" || type === "user") {
    const parts = (Array.isArray(message.content) ? message.content : [])
      .map((block) => {
        const b = block as Fields
        if (b.type === "text") return `text: ${oneLine(str(b.text) ?? "")}`
        if (b.type === "tool_use") {
          return `${b.name}: ${oneLine(toolArg((b.input ?? {}) as Fields))}`
        }
        if (b.type === "tool_result") {
          const flag = b.is_error ? " error" : ""
          return `result${flag}: ${oneLine(textOf(b.content))}`
        }
        return String(b.type ?? "?")
      })
    if (typeof message.content === "string") {
      parts.push(`text: ${oneLine(message.content)}`)
    }
    return `${type} ${parts.join(" | ")}`.trimEnd()
  }
  if (type === "result") {
    return `result ${obj.subtype ?? ""}: ${oneLine(str(obj.result) ?? "")}`
  }
  if (type === "thread.started") return `thread.started ${obj.thread_id}`
  if (type.startsWith("item.")) {
    if (item.type === "command_execution") {
      const exit = item.exit_code === null || item.exit_code === undefined
        ? "" : ` exit=${item.exit_code}`
      return `${type} $ ${oneLine(unwrapShell(str(item.command) ?? ""))}${exit}`
    }
    if (item.type === "agent_message") {
      return `${type} message: ${oneLine(str(item.text) ?? "")}`
    }
    return `${type} ${item.type ?? "?"}`
  }
  return type
}

export const agentLines = (
  stream: string, at: number | null, context = 3,
): string[] => {
  const lines = stream.split("\n")
  if (lines.at(-1) === "") lines.pop()
  if (at === null) {
    return lines.map((line, i) => `${String(i + 1).padStart(5)}  ${
      describeStreamLine(line)}`)
  }
  if (at < 1 || at > lines.length) {
    throw new Error(`line ${at} is out of range 1-${lines.length}`)
  }
  const out: string[] = []
  const from = Math.max(1, at - context)
  const to = Math.min(lines.length, at + context)
  for (let n = from; n <= to; n++) {
    const mark = n === at ? ">" : " "
    const text = describeStreamLine(lines[n - 1]!)
    out.push(`${mark}${String(n).padStart(4)}  ${text}`)
    if (n === at) {
      let full = lines[n - 1]!
      try {
        full = JSON.stringify(JSON.parse(full), null, 2)
      } catch {
        // Show the raw line.
      }
      out.push(...full.split("\n").map((l) => `        ${l}`))
    }
  }
  return out
}

// ---------------------------------------------------------------- challenges

/** The body of the `## Challenges` section, or null. */
export const extractChallenges = (markdown: string): string | null => {
  const match = /^##[ \t]+Challenges[ \t]*$/im.exec(markdown)
  if (!match) return null
  const rest = markdown.slice(match.index + match[0].length)
  const next = /^#{1,2}[ \t]/m.exec(rest)
  return (next ? rest.slice(0, next.index) : rest).trim()
}

/** `30d`, `12h`, or a date; returns the cutoff time. */
export const parseSince = (since: string, now: Date = new Date()): Date => {
  const rel = /^(\d+)([dh])$/.exec(since.trim())
  if (rel) {
    const unit = rel[2] === "d" ? dayMs : dayMs / 24
    return new Date(now.getTime() - Number(rel[1]) * unit)
  }
  const date = new Date(since)
  if (Number.isNaN(date.getTime())) {
    throw new Error(`bad --since "${since}": use 30d, 12h, or a date`)
  }
  return date
}

export const challengeLines = (
  home: string, runs: RunSummary[], since: Date,
): string[] => {
  const out: string[] = []
  for (const run of [...runs].reverse()) {
    if (Date.parse(run.ts) < since.getTime()) continue
    let report: string
    try {
      const file = join(checkedRunPaths(home, run.runId).dir, "report.md")
      report = readFileSync(file, "utf8")
    } catch {
      continue
    }
    const body = extractChallenges(report)
    out.push(`== ${run.runId}  ${run.ts.slice(0, 19).replace("T", " ")}`)
    out.push(body ?? "(no Challenges section)", "")
  }
  return out
}

// ---------------------------------------------------------------- files

/** Redacts a file in place through a temp file and rename; mode `0600`. */
export const redactFile = (file: string): boolean => {
  const before = readFileSync(file, "utf8")
  const after = redact(before)
  const tmp = join(dirname(file), `.${process.pid}.redact.tmp`)
  writeFileSync(tmp, after, { mode: 0o600 })
  renameSync(tmp, file)
  chmodSync(file, 0o600)
  return before !== after
}

/** Total bytes under a path, without following links. */
export const pathBytes = (path: string): number => {
  try {
    const stat = lstatSync(path)
    if (!stat.isDirectory()) return stat.size
    return readdirSync(path)
      .reduce((sum, name) => sum + pathBytes(join(path, name)), stat.size)
  } catch {
    return 0
  }
}

/**
 * Rebuilds a past day's index from its run files: temp file, then rename.
 * Today and yesterday are refused, since their files may still grow.
 */
export const reindexDay = (
  home: string, day: string, now: Date = new Date(),
): number => {
  if (recentDays(now).has(day)) {
    throw new Error(`${day} is today or yesterday; its files are read directly`)
  }
  const runs = scanDay(home, day, () => "incomplete")
  const lines = runs.map((r) => {
    const id: RunIdentity = {
      source: "dotfiles", runId: r.runId, parentRunId: r.parentRunId,
      rootRunId: r.rootRunId, tool: r.tool,
    }
    const start = readJsonl(runFilePath(home, r.runId))[0]
    if (start && typeof start.source === "string") id.source = start.source
    return indexLine({
      id, ts: r.ts, durMs: r.durMs, exit: r.exit, status: r.status,
      warns: r.warns, errors: r.errors, agent: r.agent,
    })
  })
  const target = indexPath(home, day)
  const tmp = `${target}.${process.pid}.tmp`
  writeFileSync(tmp, lines.map((l) => `${l}\n`).join(""), { mode: 0o600 })
  renameSync(tmp, target)
  return lines.length
}

export interface PruneOptions {
  days: number
  maxBytes: number
  now: Date
}

export interface PruneResult {
  removedDays: string[]
  bytesFreed: number
  /** Days removed only because `runs/` was over the size cap. */
  cappedDays: string[]
  /** Bytes left in `runs/`. */
  bytesLeft: number
  /** Past days whose index was missing a run, rebuilt. */
  reindexedDays: string[]
}

/**
 * Deletes day folders older than `days`, then the oldest days while `runs/`
 * is over `maxBytes`. Never touches today or yesterday (UTC). Then rebuilds
 * the index of each kept past day that is missing one or lacks a run.
 */
export const pruneRuns = (home: string, opts: PruneOptions): PruneResult => {
  const runs = join(home, "runs")
  const keep = recentDays(opts.now)
  const candidates = listDays(home).filter((day) => !keep.has(day))
  const result: PruneResult = {
    removedDays: [], bytesFreed: 0, cappedDays: [], bytesLeft: 0,
    reindexedDays: [],
  }
  const remove = (day: string): void => {
    const path = join(runs, day)
    const bytes = pathBytes(path)
    rmSync(path, { recursive: true, force: true })
    result.removedDays.push(day)
    result.bytesFreed += bytes
  }
  for (const day of candidates) {
    if (dayAge(day, opts.now) > opts.days) remove(day)
  }
  let total = pathBytes(runs)
  for (const day of candidates) {
    if (total <= opts.maxBytes) break
    if (result.removedDays.includes(day)) continue
    const before = result.bytesFreed
    remove(day)
    result.cappedDays.push(day)
    total -= result.bytesFreed - before
  }
  result.bytesLeft = total
  for (const day of candidates) {
    if (result.removedDays.includes(day)) continue
    if (!indexIncomplete(home, day)) continue
    reindexDay(home, day, opts.now)
    result.reindexedDays.push(day)
  }
  return result
}

// ---------------------------------------------------------------- tap

export type TapCli = "claude" | "codex"

export type TapAction =
  | { kind: "session"; sessionId: string }
  | { kind: "command"; cmd: string; exit: number | null; unparsed: boolean }
  | { kind: "progress"; text: string }
  | { kind: "report"; text: string }

/** Turns Codex's `bash -lc '...'` wrapper back into the command. */
export const unwrapShell = (command: string): string => {
  const match = /^(?:\S*\/)?(?:ba|z)?sh -l?c '([\s\S]*)'$/.exec(command)
  if (!match) return command
  return match[1]!.replace(/'"'"'/g, "'").replace(/'\\''/g, "'")
}

/** Parses "Exit code N" from a failed Claude Bash result. */
export const parseExitCode = (text: string): number | null => {
  const match = /Exit code (-?\d+)/.exec(text)
  return match ? Number(match[1]) : null
}

/**
 * Actions for one Claude stream-json line. `pending` maps Bash
 * `tool_use_id` to its command until the result arrives.
 */
export const claudeActions = (
  obj: Fields, pending: Map<string, string>,
): TapAction[] => {
  const out: TapAction[] = []
  const content = (obj.message as Fields | undefined)?.content
  const blocks = Array.isArray(content) ? (content as Fields[]) : []
  if (obj.type === "system" && obj.subtype === "init") {
    const sid = str(obj.session_id)
    if (sid) out.push({ kind: "session", sessionId: sid })
  } else if (obj.type === "assistant") {
    for (const block of blocks) {
      if (block?.type !== "tool_use") continue
      const input = (block.input ?? {}) as Fields
      const name = str(block.name) ?? "?"
      out.push({
        kind: "progress", text: `agent: ${name} ${oneLine(toolArg(input), 80)}`,
      })
      const id = str(block.id)
      if (name === "Bash" && id) pending.set(id, str(input.command) ?? "")
    }
  } else if (obj.type === "user") {
    for (const block of blocks) {
      if (block?.type !== "tool_result") continue
      const id = str(block.tool_use_id)
      if (!id || !pending.has(id)) continue
      const cmd = pending.get(id)!
      pending.delete(id)
      if (block.is_error === true) {
        const exit = parseExitCode(textOf(block.content))
        out.push({ kind: "command", cmd, exit, unparsed: exit === null })
      } else {
        out.push({ kind: "command", cmd, exit: 0, unparsed: false })
      }
    }
  } else if (obj.type === "result") {
    const report = str(obj.result)
    if (report !== null) out.push({ kind: "report", text: report })
  }
  return out
}

/** Actions for one Codex `exec --json` line. */
export const codexActions = (obj: Fields): TapAction[] => {
  const item = (obj.item ?? {}) as Fields
  if (obj.type === "thread.started") {
    const sid = str(obj.thread_id)
    return sid ? [{ kind: "session", sessionId: sid }] : []
  }
  if (item.type !== "command_execution") {
    if (obj.type === "item.completed" && item.type
      && item.type !== "agent_message" && item.type !== "reasoning") {
      return [{ kind: "progress", text: `agent: ${item.type}` }]
    }
    return []
  }
  const cmd = unwrapShell(str(item.command) ?? "")
  if (obj.type === "item.started") {
    return [{ kind: "progress", text: `agent: Bash ${oneLine(cmd, 80)}` }]
  }
  if (obj.type !== "item.completed") return []
  const exit = num(item.exit_code)
  return [{ kind: "command", cmd, exit, unparsed: exit === null }]
}

/** Cuts a stream line over the limit, keeping it valid JSON if it was. */
export const cutStreamLine = (
  line: string, max: number = maxStreamLineChars,
): string => {
  if (line.length <= max) return line
  let obj: unknown
  try {
    obj = JSON.parse(line)
  } catch {
    return `${line.slice(0, max - 5)}[cut]`
  }
  const cutAll = (value: unknown, n: number): unknown => {
    if (typeof value === "string") return cutString(value, n)
    if (Array.isArray(value)) return value.map((v) => cutAll(v, n))
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, cutAll(v, n)]))
    }
    return value
  }
  for (const n of [4096, 1024, 256, 64]) {
    const out = JSON.stringify(cutAll(obj, n))
    if (out.length <= max) return out
  }
  const type = (obj as Fields)?.type ?? null
  return JSON.stringify({ type, boku_cut: true, chars: line.length })
}

export interface TapOptions {
  cli: TapCli
  env: Env
  sessionId?: string
  maxCopyBytes?: number
  stderr?: (text: string) => void
}

export interface Tap {
  line(text: string): void
  finish(): void
}

/** The tap's state machine: copy, parse, and log one line at a time. */
export const createTap = (opts: TapOptions): Tap => {
  const stderr = opts.stderr ?? ((t: string) => process.stderr.write(t))
  const run = attachRun(opts.env)
  const cap = opts.maxCopyBytes ?? maxCopyBytes
  const agentFile = run.runDir ? join(run.runDir, "agent.jsonl") : null
  const pending = new Map<string, string>()
  const state = {
    lineNo: 0, copiedBytes: 0, copying: agentFile !== null, failed: false,
    session: false,
  }

  const fail = (error: unknown): void => {
    if (state.failed) return
    state.failed = true
    const msg = error instanceof Error ? error.message : String(error)
    run.event("warn", { code: "tap-failed", msg })
    stderr(`${tapNotice}\n`)
  }

  const copy = (text: string): boolean => {
    if (!state.copying || !agentFile) return false
    const line = `${cutStreamLine(redact(text))}\n`
    const bytes = Buffer.byteLength(line)
    if (state.copiedBytes + bytes > cap) {
      state.copying = false
      return false
    }
    appendFileSync(agentFile, line, { mode: 0o600 })
    state.copiedBytes += bytes
    return true
  }

  const apply = (action: TapAction, copied: boolean): void => {
    if (action.kind === "progress") {
      stderr(`${redact(action.text)}\n`)
    } else if (action.kind === "session") {
      if (state.session) return
      state.session = true
      run.event("agent-session", { cli: opts.cli, session_id: action.sessionId })
      if (opts.sessionId && opts.sessionId !== action.sessionId) {
        run.event("warn", {
          code: "session-mismatch",
          msg: `expected ${opts.sessionId}, stream has ${action.sessionId}`,
        })
      }
    } else if (action.kind === "command") {
      const ref = copied ? { file: "agent.jsonl", line: state.lineNo } : null
      run.event("agent-command", {
        cmd: action.cmd, exit: action.exit, ref,
        truncated: agentFile && !copied ? true : undefined,
      })
      if (action.unparsed) {
        run.event("warn", {
          code: "exit-unparsed", msg: `no exit code for: ${action.cmd}`,
        })
      }
    } else if (action.kind === "report" && run.runDir) {
      writeFileSync(join(run.runDir, "report.md"), redact(action.text), {
        mode: 0o600,
      })
    }
  }

  if (agentFile) {
    try {
      ensureDir(run.runDir!)
    } catch (error) {
      fail(error)
    }
  }

  return {
    line(text: string): void {
      state.lineNo += 1
      if (state.failed) {
        try {
          copy(text)
        } catch {
          // Draining quietly.
        }
        return
      }
      try {
        const copied = copy(text)
        let obj: Fields
        try {
          obj = JSON.parse(text) as Fields
        } catch {
          return
        }
        if (!obj || typeof obj !== "object") return
        const actions = opts.cli === "claude"
          ? claudeActions(obj, pending) : codexActions(obj)
        for (const action of actions) apply(action, copied)
      } catch (error) {
        fail(error)
      }
    },
    finish(): void {
      if (state.failed) return
      try {
        for (const cmd of pending.values()) {
          run.event("agent-command", { cmd, exit: null, ref: null })
        }
        pending.clear()
      } catch (error) {
        fail(error)
      }
    },
  }
}

/** Reads stdin line by line into the tap, then exits 0. */
export const runTap = async (opts: TapOptions): Promise<void> => {
  let tap: Tap | null = null
  try {
    tap = createTap(opts)
  } catch {
    tap = null
  }
  const decoder = new TextDecoder()
  let rest = ""
  for await (const chunk of Bun.stdin.stream()) {
    rest += decoder.decode(chunk, { stream: true })
    let nl = rest.indexOf("\n")
    while (nl >= 0) {
      tap?.line(rest.slice(0, nl))
      rest = rest.slice(nl + 1)
      nl = rest.indexOf("\n")
    }
  }
  rest += decoder.decode()
  if (rest) tap?.line(rest)
  tap?.finish()
}

// ---------------------------------------------------------------- program

const print = (lines: string[]): void => {
  if (lines.length) process.stdout.write(`${lines.join("\n")}\n`)
}

const guard = (fn: () => void | Promise<void>) => async (): Promise<void> => {
  try {
    await fn()
  } catch (error) {
    process.stderr.write(`boku-runs: ${
      error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}

const parseIntArg = (value: string, name: string): number => {
  const n = Number(value)
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${name} must be a whole number, got "${value}"`)
  }
  return n
}

export const createProgram = (env: Env = process.env): Command => {
  const program = new Command()
  const home = (): string => bokuHome(env)
  const listAction = (opts: { limit: string }) => guard(() => {
    print(listLines(loadRuns(home()), parseIntArg(opts.limit, "--limit")))
  })

  program
    .name("boku-runs")
    .description("Read and maintain the Boku run log (~/.boku/runs)")
    .option("-n, --limit <n>", "how many top-level runs to list", "20")
    .action((opts: { limit: string }) => listAction(opts)())

  program.command("list")
    .description("the last top-level runs, newest first")
    .option("-n, --limit <n>", "how many runs", "20")
    .action((opts: { limit: string }) => listAction(opts)())

  program.command("show <id>")
    .description("a run's events; <id> is last or any unique suffix")
    .option("--tree", "include child runs")
    .action((query: string, opts: { tree?: boolean }) => guard(() => {
      const runs = loadRuns(home())
      const runId = resolveRunId(runs, query)
      print(showLines(home(), runs, runId, opts.tree === true))
    })())

  program.command("agent <id>")
    .description("the agent stream, one readable line each")
    .option("--at <n>", "jump to stream line N, with context")
    .option("-C, --context <n>", "lines of context around --at", "3")
    .action((query: string, opts: { at?: string; context: string }) =>
      guard(() => {
        const runId = resolveRunId(loadRuns(home()), query)
        const file = join(checkedRunPaths(home(), runId).dir, "agent.jsonl")
        if (!existsSync(file)) throw new Error(`${runId} has no agent.jsonl`)
        const at = opts.at === undefined ? null : parseIntArg(opts.at, "--at")
        print(agentLines(readFileSync(file, "utf8"), at,
          parseIntArg(opts.context, "--context")))
      })())

  program.command("challenges")
    .description("every Challenges section, newest first")
    .option("--since <when>", "30d, 12h, or a date", "30d")
    .action((opts: { since: string }) => guard(() => {
      print(challengeLines(home(), loadRuns(home()), parseSince(opts.since)))
    })())

  program.command("redact-file <file>")
    .description("redact a file in place")
    .action((file: string) => guard(() => {
      redactFile(file)
    })())

  program.command("reindex [days...]")
    .description("rebuild past days' index files (default: every past day)")
    .action((days: string[]) => guard(() => {
      const now = new Date()
      const recent = recentDays(now)
      const targets = days.length
        ? days : listDays(home()).filter((d) => !recent.has(d))
      for (const day of targets) {
        if (!isDay(day)) throw new Error(`bad day "${day}": use yymmdd`)
        const count = reindexDay(home(), day, now)
        process.stderr.write(`reindexed ${day}: ${count} runs\n`)
      }
    })())

  program.command("prune [days]")
    .description("delete day folders older than DAYS (default 30)")
    .option("--max-bytes <n>", "size cap for runs/", String(maxRunsBytes))
    .action((days: string | undefined, opts: { maxBytes: string }) =>
      guard(() => {
        const keepDays = parseIntArg(days ?? "30", "DAYS")
        const maxBytes = parseIntArg(opts.maxBytes, "--max-bytes")
        const run = startRun("prune", {
          env, argv: process.argv.slice(2),
        })
        const t0 = Date.now()
        try {
          const result = pruneRuns(home(), {
            days: keepDays, maxBytes, now: new Date(),
          })
          if (result.cappedDays.length) {
            run.event("warn", {
              code: "size-cap",
              msg: `removed ${result.cappedDays.length} more days over the ${
                maxBytes}-byte cap`,
            })
          }
          if (result.bytesLeft > maxBytes) {
            run.event("warn", {
              code: "size-cap-unmet",
              msg: `${result.bytesLeft} bytes left in today and yesterday`,
            })
          }
          run.event("step", {
            name: "prune", exit: 0, dur_ms: Date.now() - t0,
            removed_days: result.removedDays.length,
            bytes_freed: result.bytesFreed,
            reindexed_days: result.reindexedDays.length,
          })
          run.end(0)
        } catch (error) {
          run.event("error", {
            code: "prune-failed",
            msg: error instanceof Error ? error.message : String(error),
          })
          run.end(1)
          throw error
        }
      })())

  program.command("tap")
    .description("save and log an agent's JSONL stream read on stdin")
    .requiredOption("--cli <cli>", "claude or codex")
    .option("--session-id <uuid>", "expected session id (warns on mismatch)")
    .option("--max-copy-bytes <n>", "copy cap for agent.jsonl",
      String(maxCopyBytes))
    .action(async (opts: {
      cli: string; sessionId?: string; maxCopyBytes: string
    }) => {
      if (opts.cli !== "claude" && opts.cli !== "codex") {
        process.stderr.write(`boku-runs: --cli must be claude or codex\n`)
        process.exitCode = 2
        return
      }
      await runTap({
        cli: opts.cli, env, sessionId: opts.sessionId,
        maxCopyBytes: Number(opts.maxCopyBytes) || maxCopyBytes,
      })
    })

  return program
}

if (import.meta.main) await createProgram().parseAsync()

