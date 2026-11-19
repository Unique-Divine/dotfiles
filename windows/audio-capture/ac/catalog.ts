/**
 * The derived index, `%USERPROFILE%\.audio-capture\index.jsonl`: one line
 * per recording, newest first, built from the files, the log's `mix.done`
 * events, and the sidecars. It is a cache for `rg` and agents, never the
 * source of truth: deleting it loses nothing, and `ac index --rebuild`
 * writes it from scratch.
 */
import { existsSync, readFileSync } from "node:fs"
import type { RecordingDetail } from "./recordings"
import { writeFileAtomic } from "./sidecar"

export const INDEX_VERSION = 1

export interface IndexEntry {
  version: 1
  recording: string
  path: string
  wsl_path: string
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
  sidecar_updated: string | null
}

export const indexEntry = (detail: RecordingDetail): IndexEntry => {
  const r = detail.recording
  return {
    version: INDEX_VERSION,
    recording: r.name,
    path: r.win_path,
    wsl_path: r.path,
    time: r.time,
    size_bytes: r.size_bytes,
    modified: r.modified,
    duration_s: r.duration_s,
    session: r.session,
    segments: r.segments,
    mics: r.mics,
    note: r.note,
    tags: r.tags,
    links: r.links,
    sidecar_updated: detail.sidecar?.updated ?? null,
  }
}

export interface IndexPlan {
  text: string
  added: number
  updated: number
  removed: number
  unchanged: number
}

/**
 * Compares the current entries with the lines of an existing index. The
 * text depends only on `entries`, so an incremental update always equals a
 * rebuild; the counts say what changed. Unparsable old lines count as
 * removed.
 */
export const planIndex = (existing: string | null, entries: IndexEntry[]): IndexPlan => {
  const old = new Map<string, string>()
  let unreadable = 0
  for (const line of (existing ?? "").split("\n")) {
    if (line.trim() === "") continue
    try {
      const value = JSON.parse(line) as { recording?: unknown }
      if (typeof value.recording === "string") old.set(value.recording, line)
      else unreadable++
    } catch {
      unreadable++
    }
  }
  const plan: IndexPlan = { text: "", added: 0, updated: 0, removed: unreadable, unchanged: 0 }
  const lines: string[] = []
  for (const entry of entries) {
    const line = JSON.stringify(entry)
    lines.push(line)
    const before = old.get(entry.recording)
    if (before === undefined) plan.added++
    else if (before === line) plan.unchanged++
    else plan.updated++
    old.delete(entry.recording)
  }
  plan.removed += old.size
  plan.text = lines.length > 0 ? lines.join("\n") + "\n" : ""
  return plan
}

/**
 * Writes the index when its content changed, or always with `rebuild`;
 * the counts compare against the old file either way.
 */
export const updateIndex = (
  path: string,
  entries: IndexEntry[],
  rebuild: boolean,
): IndexPlan => {
  const existing = existsSync(path) ? readFileSync(path, "utf8") : null
  const plan = planIndex(existing, entries)
  if (rebuild || existing !== plan.text) writeFileAtomic(path, plan.text)
  return plan
}
