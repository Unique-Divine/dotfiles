/**
 * Facts about each recording from the app's JSONL log,
 * `%USERPROFILE%\.audio-capture\logs\audio-capture.jsonl`, and its rotated
 * copies `audio-capture.1.jsonl` (newest) to `audio-capture.N.jsonl`.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

export interface LogEvent {
  ts: string
  event: string
  session?: string
  [field: string]: unknown
}

export interface SegmentFact {
  kind: string
  device: string | null
  file: string | null
  /** Seconds after the recording started. */
  start: number | null
  media_seconds: number | null
}

export interface SessionFacts {
  session: string
  /** `recording.start` time. */
  started: string | null
  /** `recording.stop` time. */
  stopped: string | null
  /** Seconds from start to stop, from `recording.stop`. */
  stop_at: number | null
  /** Raw session folder (Windows path). */
  session_dir: string | null
  mic_policy: string | null
  segments: SegmentFact[]
  /** Distinct mic devices, in the order they appeared. */
  mics: string[]
  /** `mix.done`: whether the save worked, where, and its length. */
  saved: {
    ok: boolean
    output: string | null
    duration_s: number | null
    at: string
    msg: string | null
  } | null
}

/** Log files oldest first: audio-capture.N.jsonl ... .1.jsonl, then live. */
export const logFiles = (logsDir: string): string[] => {
  if (!existsSync(logsDir)) return []
  const rotated = readdirSync(logsDir)
    .map((name) => ({ name, n: /^audio-capture\.(\d+)\.jsonl$/.exec(name)?.[1] }))
    .filter((entry): entry is { name: string; n: string } => entry.n !== undefined)
    .sort((a, b) => Number(b.n) - Number(a.n))
    .map((entry) => join(logsDir, entry.name))
  const live = join(logsDir, "audio-capture.jsonl")
  return existsSync(live) ? [...rotated, live] : rotated
}

/** Parses JSONL, skipping lines that aren't JSON objects with an event. */
export const parseLogLines = (text: string): LogEvent[] => {
  const events: LogEvent[] = []
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue
    try {
      const value = JSON.parse(line) as unknown
      if (
        typeof value === "object" && value !== null &&
        typeof (value as LogEvent).event === "string"
      ) {
        events.push(value as LogEvent)
      }
    } catch {
      // A half-written last line or a stray line; skip it.
    }
  }
  return events
}

export const readLog = (logsDir: string): LogEvent[] =>
  logFiles(logsDir).flatMap((file) => parseLogLines(readFileSync(file, "utf8")))

const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null
const str = (value: unknown): string | null =>
  typeof value === "string" ? value : null

/** "saved C:\…\x.mp3 (15.6 s, expected …" gives 15.6. */
export const savedSeconds = (msg: string | null): number | null => {
  const match = msg ? /\((\d+(?:\.\d+)?) s\b/.exec(msg) : null
  return match ? Number(match[1]) : null
}

/** Groups events by session into facts. */
export const sessionFacts = (events: LogEvent[]): Map<string, SessionFacts> => {
  const sessions = new Map<string, SessionFacts>()
  const get = (session: string): SessionFacts => {
    let facts = sessions.get(session)
    if (!facts) {
      facts = {
        session, started: null, stopped: null, stop_at: null,
        session_dir: null, mic_policy: null, segments: [], mics: [],
        saved: null,
      }
      sessions.set(session, facts)
    }
    return facts
  }
  for (const event of events) {
    if (typeof event.session !== "string") continue
    switch (event.event) {
      case "recording.start": {
        const facts = get(event.session)
        facts.started = str(event.ts)
        facts.session_dir = str(event.dir)
        facts.mic_policy = str(event.mic_policy)
        break
      }
      case "recording.stop": {
        const facts = get(event.session)
        facts.stopped = str(event.ts)
        facts.stop_at = num(event.stop_at)
        break
      }
      case "segment.start": {
        const device = str(event.device)
        const facts = get(event.session)
        if (event.kind === "mic" && device && !facts.mics.includes(device)) {
          facts.mics.push(device)
        }
        break
      }
      case "mix.segment": {
        const facts = get(event.session)
        const device = str(event.device)
        facts.segments.push({
          kind: str(event.kind) ?? "unknown",
          device,
          file: str(event.file),
          start: num(event.start),
          media_seconds: num(event.media_seconds),
        })
        if (event.kind === "mic" && device && !facts.mics.includes(device)) {
          facts.mics.push(device)
        }
        break
      }
      case "mix.done": {
        const facts = get(event.session)
        const msg = str(event.msg)
        facts.saved = {
          ok: event.ok === true,
          output: str(event.output),
          duration_s: savedSeconds(msg),
          at: event.ts,
          msg,
        }
        break
      }
    }
  }
  return sessions
}

/** Windows file name of a path, lowercased, for matching. */
export const winBaseName = (path: string): string =>
  (path.split(/[\\/]/).pop() ?? path).toLowerCase()

/** Facts of saved recordings by output file name (lowercased). */
export const factsByOutputName = (
  sessions: Map<string, SessionFacts>,
): Map<string, SessionFacts> => {
  const out = new Map<string, SessionFacts>()
  for (const facts of sessions.values()) {
    if (facts.saved?.ok && facts.saved.output) {
      out.set(winBaseName(facts.saved.output), facts)
    }
  }
  return out
}
