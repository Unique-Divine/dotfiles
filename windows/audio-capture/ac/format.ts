/** Terminal formatting for `ac`: named ANSI colors, sizes, and rows. */
import type { Recording, RecordingDetail } from "./recordings"

/**
 * Named ANSI colors, one meaning each: yellow warns, green labels a final
 * summary line, cyan marks a command. Paths stay plain. Never 24-bit RGB.
 */
const CODES = { warning: 33, success: 32, command: 36 } as const

export type Paint = (text: string, role: keyof typeof CODES) => string

/** NO_COLOR wins, FORCE_COLOR forces, else color only a TTY. */
export const colorEnabled = (
  env: Record<string, string | undefined>,
  isTTY: boolean | undefined,
): boolean => {
  if (env.NO_COLOR) return false
  if (env.FORCE_COLOR && env.FORCE_COLOR !== "0") return true
  return isTTY === true && env.TERM !== "dumb"
}

export const painter = (enabled: boolean): Paint => (text, role) =>
  enabled ? `\x1b[${CODES[role]}m${text}\x1b[39m` : text

export const formatSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  const units = ["KB", "MB", "GB"]
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

/** 75.4 → "1:15"; 3725 → "1:02:05"; null → "?". */
export const formatDuration = (seconds: number | null): string => {
  if (seconds === null) return "?"
  const total = Math.round(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, "0")
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`
}

const pad2 = (n: number): string => String(n).padStart(2, "0")

/** Local "2026-11-18 11:37". */
export const formatLocalTime = (iso: string): string => {
  const d = new Date(iso)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

const plural = (n: number, word: string): string =>
  `${n} ${word}${n === 1 ? "" : "s"}`

/** One `ac ls` row: time, duration, size, mics/segments, name, note, tags. */
export const formatRow = (r: Recording): string => {
  const sources = r.segments === null
    ? "no log"
    : `${plural(r.mics.length, "mic")}, ${plural(r.segments, "seg")}`
  const cells = [
    formatLocalTime(r.time),
    formatDuration(r.duration_s).padStart(7),
    formatSize(r.size_bytes).padStart(7),
    sources.padEnd(14),
    r.name,
  ]
  const note = (r.note ?? "").replace(/\s+/g, " ").trim()
  const extra = [
    note.length > 60 ? `${note.slice(0, 59)}…` : note,
    r.tags.length > 0 ? `[${r.tags.join(", ")}]` : "",
  ].filter((s) => s !== "").join(" ")
  return cells.join("  ") + (extra ? `  ${extra}` : "")
}

const seconds = (value: number | null): string =>
  value === null ? "?" : `${value.toFixed(2)} s`

/** `ac show`: labeled lines for one recording. */
export const formatDetail = (detail: RecordingDetail): string => {
  const { recording: r, facts, sidecar } = detail
  const lines: [string, string][] = [
    ["path", r.path],
    ["windows", r.win_path],
    ["time", `${formatLocalTime(r.time)}, ${formatDuration(r.duration_s)}`],
    ["size", `${formatSize(r.size_bytes)}, modified ${formatLocalTime(r.modified)}`],
  ]
  if (facts) {
    lines.push(["session", facts.session])
    if (facts.started) lines.push(["started", facts.started])
    if (facts.stopped) lines.push(["stopped", facts.stopped])
    if (facts.mic_policy) lines.push(["mic policy", facts.mic_policy])
    lines.push(["mics", facts.mics.length > 0 ? facts.mics.join("; ") : "none"])
    facts.segments.forEach((segment, i) => {
      lines.push([i === 0 ? "segments" : "", `${segment.kind} ` +
        `${segment.device ?? "?"}: at ${seconds(segment.start)}, ` +
        `${seconds(segment.media_seconds)} of audio`])
    })
  } else {
    lines.push(["log", "no entry"])
  }
  lines.push(["sidecar", sidecar ? detail.sidecar_path : "none"])
  if (detail.sidecar_error) lines.push(["sidecar error", detail.sidecar_error])
  if (sidecar) {
    if (sidecar.note) lines.push(["note", sidecar.note])
    if (sidecar.tags.length > 0) lines.push(["tags", sidecar.tags.join(", ")])
    sidecar.links.forEach((link, i) => lines.push([i === 0 ? "links" : "", link]))
    lines.push(["updated", sidecar.updated])
  }
  return [r.name, ...lines.map(([label, value]) =>
    `  ${label.padEnd(13)}${value}`)].join("\n")
}
