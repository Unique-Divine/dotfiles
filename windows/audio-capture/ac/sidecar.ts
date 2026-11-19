/**
 * The sidecar: a JSON file next to a recording that holds what a person
 * adds to it (a note, tags, links). Version 1:
 *
 * ```json
 * {
 *   "version": 1,
 *   "recording": "26-11-18__113708-audio.mp3",
 *   "note": "Call with the infra team",
 *   "tags": ["call", "infra"],
 *   "links": ["https://github.com/Unique-Divine/dotfiles/issues/155"],
 *   "updated": "2026-11-18T11:40:02.123Z"
 * }
 * ```
 *
 * The file is `<recording name without extension>.json`, in the recording's
 * folder. Writers replace it atomically (temp file in the same folder, then
 * rename), write 2-space JSON with a trailing newline, and keep fields they
 * don't know. A reader refuses a version it doesn't know rather than
 * guessing. The C# app is meant to write the same format later.
 */
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { basename, dirname, extname, join } from "node:path"

export const SIDECAR_VERSION = 1

export interface Sidecar {
  version: 1
  /** File name of the recording, without a folder. */
  recording: string
  note: string | null
  tags: string[]
  links: string[]
  /** ISO 8601 time of the last write. */
  updated: string
  /** Fields from other writers, kept as they are. */
  [extra: string]: unknown
}

/** Path of the sidecar for a recording path (either path style). */
export const sidecarPath = (recordingPath: string): string => {
  const ext = extname(recordingPath)
  return recordingPath.slice(0, recordingPath.length - ext.length) + ".json"
}

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string")

/**
 * Lists what is wrong with a parsed sidecar; an empty list means it is a
 * valid version 1 sidecar.
 */
export const validateSidecar = (value: unknown): string[] => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return ["sidecar must be a JSON object"]
  }
  const record = value as Record<string, unknown>
  const errors: string[] = []
  if (record.version !== SIDECAR_VERSION) {
    errors.push(
      `unsupported version ${JSON.stringify(record.version)}; ` +
        `expected ${SIDECAR_VERSION}`,
    )
  }
  if (typeof record.recording !== "string" || record.recording === "") {
    errors.push("recording must be a non-empty string")
  }
  if (record.note !== null && typeof record.note !== "string") {
    errors.push("note must be a string or null")
  }
  if (!isStringArray(record.tags)) errors.push("tags must be strings")
  if (!isStringArray(record.links)) errors.push("links must be strings")
  if (
    typeof record.updated !== "string" ||
    Number.isNaN(Date.parse(record.updated))
  ) {
    errors.push("updated must be an ISO 8601 time")
  }
  return errors
}

/** Parses sidecar text, or throws with every validation error. */
export const parseSidecar = (text: string, source: string): Sidecar => {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new Error(`${source}: invalid JSON: ${(error as Error).message}`)
  }
  const errors = validateSidecar(value)
  if (errors.length > 0) {
    throw new Error(`${source}: ${errors.join("; ")}`)
  }
  return value as Sidecar
}

/** Reads a recording's sidecar, or null when it has none. */
export const readSidecar = (recordingPath: string): Sidecar | null => {
  const path = sidecarPath(recordingPath)
  if (!existsSync(path)) return null
  return parseSidecar(readFileSync(path, "utf8"), path)
}

export interface SidecarChange {
  /** New note; null clears it; undefined leaves it. */
  note?: string | null
  /** Tags to add; existing tags stay, duplicates are dropped. */
  addTags?: string[]
  /** Links to add; existing links stay, duplicates are dropped. */
  addLinks?: string[]
}

const union = (existing: string[], added: string[]): string[] => {
  const out = [...existing]
  for (const item of added) {
    const trimmed = item.trim()
    if (trimmed !== "" && !out.includes(trimmed)) out.push(trimmed)
  }
  return out
}

/**
 * Applies a change to a sidecar (or creates one), keeping unknown fields
 * and their order. Pure: `now` sets `updated`.
 */
export const applySidecarChange = (
  existing: Sidecar | null,
  recording: string,
  change: SidecarChange,
  now: Date,
): Sidecar => {
  const base: Sidecar = existing ?? {
    version: 1,
    recording,
    note: null,
    tags: [],
    links: [],
    updated: now.toISOString(),
  }
  const note = change.note === undefined
    ? base.note
    : change.note === null || change.note.trim() === ""
      ? null
      : change.note
  return {
    ...base,
    version: 1,
    recording,
    note,
    tags: union(base.tags, change.addTags ?? []),
    links: union(base.links, change.addLinks ?? []),
    updated: now.toISOString(),
  }
}

/** 2-space JSON with a trailing newline. */
export const formatSidecar = (sidecar: Sidecar): string =>
  JSON.stringify(sidecar, null, 2) + "\n"

/**
 * Writes a file through a temp file in the same folder and a rename, so a
 * reader sees the old or the new content, never a partial write.
 */
export const writeFileAtomic = (path: string, content: string): void => {
  const temp = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${Date.now()}.tmp`,
  )
  try {
    writeFileSync(temp, content)
    renameSync(temp, path)
  } catch (error) {
    try {
      unlinkSync(temp)
    } catch {
      // The temp file may not exist.
    }
    throw error
  }
}

/** Writes a recording's sidecar atomically. */
export const writeSidecar = (recordingPath: string, sidecar: Sidecar): void => {
  const errors = validateSidecar(sidecar)
  if (errors.length > 0) {
    throw new Error(`refusing to write invalid sidecar: ${errors.join("; ")}`)
  }
  writeFileAtomic(sidecarPath(recordingPath), formatSidecar(sidecar))
}
