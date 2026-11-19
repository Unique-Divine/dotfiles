/**
 * Finds recordings: files in the `[output] dir` folders that fit the
 * `[output] name` template, plus files the log says were saved, joined with
 * log facts and sidecars.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { basename, join } from "node:path"
import { parse as parseToml } from "smol-toml"
import {
  factsByOutputName, readLog, sessionFacts, winBaseName, type SessionFacts,
} from "./log"
import { readSidecar, sidecarPath, type Sidecar } from "./sidecar"
import type { WinSystem } from "./system"
import {
  DEFAULT_DIR, DEFAULT_NAME, expandDates, expandFolders, folderTokens,
  parseNameTime, splitDir, templateMatcher, type OutputTemplates,
} from "./templates"

export type Warn = (message: string) => void

export interface Context {
  system: WinSystem
  warn: Warn
  /** WSL path of %USERPROFILE%\.audio-capture. */
  stateDir: string
  stateDirWin: string
  templates: OutputTemplates
  /** Fixed part of the output dir, before date folders. */
  root: { win: string; wsl: string } | null
  /** Windows folder tokens, resolved only when the dir template needs them. */
  folders: Record<string, string>
}

/** Reads `[output] dir` and `name` from config text; defaults otherwise. */
export const parseTemplates = (text: string | null, warn: Warn): OutputTemplates => {
  const templates = { dir: DEFAULT_DIR, name: DEFAULT_NAME }
  if (text === null) return templates
  try {
    const config = parseToml(text) as { output?: Record<string, unknown> }
    const output = config.output ?? {}
    if (typeof output.dir === "string" && output.dir !== "") templates.dir = output.dir
    if (typeof output.name === "string" && output.name !== "") templates.name = output.name
  } catch (error) {
    warn(`config.toml: ${(error as Error).message}; using default output paths`)
  }
  return templates
}

/** Resolves the profile, config, and output root through the system. */
export const loadContext = (system: WinSystem, warn: Warn): Context => {
  const profileWin = system.profileWin()
  const profileWsl = system.toWsl(profileWin)
  system.addPair({ win: profileWin, wsl: profileWsl })
  const stateDirWin = `${profileWin.replace(/\\+$/, "")}\\.audio-capture`
  const stateDir = join(profileWsl, ".audio-capture")
  if (!existsSync(stateDir)) {
    warn(`no audio-capture folder at ${stateDir}; using default settings`)
  }
  const configPath = join(stateDir, "config.toml")
  const templates = parseTemplates(
    existsSync(configPath) ? readFileSync(configPath, "utf8") : null,
    warn,
  )
  const folders: Record<string, string> = { home: profileWin }
  if (folderTokens(templates.dir).some((token) => token !== "home")) {
    try {
      Object.assign(folders, system.knownFolders(), { home: profileWin })
    } catch (error) {
      warn(`${(error as Error).message}; recordings folder unknown`)
    }
  }
  let root: Context["root"] = null
  try {
    const rootWin = expandFolders(splitDir(templates.dir).root.join("\\"), folders)
    const rootWsl = system.toWsl(rootWin)
    system.addPair({ win: rootWin, wsl: rootWsl })
    root = { win: rootWin, wsl: rootWsl }
  } catch (error) {
    warn(`recordings folder unknown: ${(error as Error).message}`)
  }
  return { system, warn, stateDir, stateDirWin, templates, root, folders }
}

/** WSL path of the dated output folder for a time (this month's, say). */
export const outputDirFor = (ctx: Context, date: Date): string | null => {
  if (!ctx.root) return null
  const { dated } = splitDir(ctx.templates.dir)
  return join(ctx.root.wsl, ...dated.map((segment) => expandDates(segment, date)))
}

/** Files that fit the dir and name templates under the root. */
export const scanFiles = (rootWsl: string, templates: OutputTemplates): string[] => {
  const { dated } = splitDir(templates.dir)
  const nameMatcher = templateMatcher(templates.name).regex
  let dirs = [rootWsl]
  for (const segment of dated) {
    const matcher = templateMatcher(segment).regex
    dirs = dirs.flatMap((dir) => {
      try {
        return readdirSync(dir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && matcher.test(entry.name))
          .map((entry) => join(dir, entry.name))
      } catch {
        return []
      }
    })
  }
  return dirs.flatMap((dir) => {
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && nameMatcher.test(entry.name))
        .map((entry) => join(dir, entry.name))
    } catch {
      return []
    }
  })
}

export interface Recording {
  name: string
  path: string
  win_path: string
  /** ISO time the recording started (name, then log, then file time). */
  time: string
  size_bytes: number
  modified: string
  duration_s: number | null
  session: string | null
  segments: number | null
  mics: string[]
  note: string | null
  tags: string[]
  links: string[]
}

export interface RecordingDetail {
  recording: Recording
  facts: SessionFacts | null
  sidecar: Sidecar | null
  sidecar_path: string
  sidecar_error: string | null
}

const durationOf = (facts: SessionFacts | null): number | null =>
  facts?.saved?.duration_s ?? facts?.stop_at ?? null

/** Builds one recording from its file, log facts, and sidecar. */
export const describe = (
  ctx: Context,
  path: string,
  facts: SessionFacts | null,
): RecordingDetail => {
  const stat = statSync(path)
  const name = basename(path)
  let sidecar: Sidecar | null = null
  let sidecarError: string | null = null
  try {
    sidecar = readSidecar(path)
  } catch (error) {
    sidecarError = (error as Error).message
    ctx.warn(sidecarError)
  }
  const fromName = parseNameTime(name, ctx.templates.name)
  const time = fromName ?? (facts?.started ? new Date(facts.started) : stat.mtime)
  return {
    recording: {
      name,
      path,
      win_path: ctx.system.toWin(path),
      time: time.toISOString(),
      size_bytes: stat.size,
      modified: stat.mtime.toISOString(),
      duration_s: durationOf(facts),
      session: facts?.session ?? null,
      segments: facts ? facts.segments.length : null,
      mics: facts?.mics ?? [],
      note: sidecar?.note ?? null,
      tags: sidecar?.tags ?? [],
      links: sidecar?.links ?? [],
    },
    facts,
    sidecar,
    sidecar_path: sidecarPath(path),
    sidecar_error: sidecarError,
  }
}

/** Every recording on disk, newest first. */
export const listRecordings = (ctx: Context): RecordingDetail[] => {
  const logsDir = join(ctx.stateDir, "logs")
  const byName = factsByOutputName(sessionFacts(readLog(logsDir)))
  if (!existsSync(join(logsDir, "audio-capture.jsonl"))) {
    ctx.warn(`no log at ${join(logsDir, "audio-capture.jsonl")}; ` +
      "durations, mics, and sessions are unknown")
  }

  const paths = new Set<string>()
  if (ctx.root) {
    if (existsSync(ctx.root.wsl)) {
      for (const path of scanFiles(ctx.root.wsl, ctx.templates)) paths.add(path)
    } else {
      ctx.warn(`recordings folder not found: ${ctx.root.wsl}`)
    }
  }
  for (const facts of byName.values()) {
    const output = facts.saved?.output
    if (!output) continue
    try {
      const path = ctx.system.toWsl(output)
      if (existsSync(path)) paths.add(path)
    } catch {
      // A path wslpath can't map (another drive gone); skip it.
    }
  }
  return [...paths]
    .map((path) => describe(ctx, path, byName.get(winBaseName(path)) ?? null))
    .sort((a, b) =>
      b.recording.time.localeCompare(a.recording.time) ||
      b.recording.name.localeCompare(a.recording.name))
}

const DURATION_UNITS: Record<string, number> = {
  m: 60_000, h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000,
}

/**
 * `--since`: `30m`, `12h`, `2d`, `1w` before now, or a local date
 * (`2026-11-01`) or date-time (`2026-11-01T09:30`).
 */
export const parseSince = (value: string, now: Date): Date => {
  const relative = /^(\d+)([mhdw])$/.exec(value.trim())
  if (relative) {
    return new Date(now.getTime() - Number(relative[1]) *
      (DURATION_UNITS[relative[2] ?? "d"] ?? 0))
  }
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim())
  if (date) {
    return new Date(Number(date[1]), Number(date[2]) - 1, Number(date[3]))
  }
  if (/^\d{4}-\d{2}-\d{2}T/.test(value.trim())) {
    const parsed = new Date(value.trim())
    if (!Number.isNaN(parsed.getTime())) return parsed
  }
  throw new Error(
    `invalid --since ${JSON.stringify(value)}; use 30m, 12h, 2d, 1w, ` +
      "2026-11-01, or 2026-11-01T09:30",
  )
}

const looksLikePath = (id: string): boolean =>
  id.includes("/") || id.includes("\\") || /^[a-z]:/i.test(id)

/**
 * Finds the recording an id names: `last`, a path (WSL or Windows), or a
 * prefix of a file name such as `26-11-18__1137`. A prefix that fits more
 * than one recording is an error that lists them.
 */
export const resolveId = (
  id: string,
  recordings: RecordingDetail[],
  toWsl: (winPath: string) => string,
): RecordingDetail => {
  if (id === "last") {
    const newest = recordings[0]
    if (!newest) throw new Error("no recordings found")
    return newest
  }
  if (looksLikePath(id)) {
    const path = id.includes("\\") || /^[a-z]:/i.test(id) ? toWsl(id) : id
    const found = recordings.find((r) => r.recording.path === path)
    if (found) return found
    throw new Error(`not a known recording: ${id}`)
  }
  const exact = recordings.filter((r) =>
    r.recording.name === id || r.recording.name.replace(/\.[^.]+$/, "") === id)
  if (exact.length === 1 && exact[0]) return exact[0]
  const matches = recordings.filter((r) => r.recording.name.startsWith(id))
  if (matches.length === 1 && matches[0]) return matches[0]
  if (matches.length === 0) throw new Error(`no recording matches ${JSON.stringify(id)}`)
  const names = matches.map((r) => `  ${r.recording.name}`).join("\n")
  throw new Error(
    `${JSON.stringify(id)} matches ${matches.length} recordings:\n${names}`,
  )
}
