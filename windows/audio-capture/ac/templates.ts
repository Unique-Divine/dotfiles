/**
 * The `[output] dir` and `name` templates from config.toml, read the way
 * the app writes them: {documents}-style tokens are folders, and any other
 * {token} is a .NET date format such as {yyyy-MM} or {HHmmss}.
 */
import { FOLDER_TOKENS } from "./system"

export const DEFAULT_DIR = "{documents}/ShareX/Screenshots/{yyyy-MM}"
export const DEFAULT_NAME = "{yy-MM-dd}__{HHmmss}-audio.mp3"

export interface OutputTemplates {
  dir: string
  name: string
}

const TOKEN = /\{([^{}]*)\}/g
const DATE_CHARS = /^[yMdHhmsf\-_.]+$/

export const isFolderToken = (token: string): boolean =>
  token.toLowerCase() in FOLDER_TOKENS

/** Folder tokens a template uses, lowercased. */
export const folderTokens = (template: string): string[] =>
  [...template.matchAll(TOKEN)]
    .map((m) => (m[1] ?? "").toLowerCase())
    .filter(isFolderToken)

export const hasDateToken = (template: string): boolean =>
  [...template.matchAll(TOKEN)].some((m) => !isFolderToken(m[1] ?? ""))

/** Splits a dir template on either slash. */
export const dirSegments = (dir: string): string[] =>
  dir.split(/[\\/]+/).filter((segment) => segment !== "")

/**
 * Splits a dir template into the fixed root (segments before the first
 * date token) and the dated segments under it.
 */
export const splitDir = (dir: string): { root: string[]; dated: string[] } => {
  const segments = dirSegments(dir)
  const first = segments.findIndex(hasDateToken)
  if (first < 0) return { root: segments, dated: [] }
  return { root: segments.slice(0, first), dated: segments.slice(first) }
}

/** Replaces folder tokens with Windows paths; leaves date tokens. */
export const expandFolders = (
  template: string,
  folders: Record<string, string>,
): string =>
  template.replace(TOKEN, (whole, token: string) => {
    const key = token.toLowerCase()
    if (!isFolderToken(key)) return whole
    const value = folders[key]
    if (value === undefined) throw new Error(`unknown folder {${token}}`)
    return value.replace(/[\\/]+$/, "")
  })

/** Splits a date format into runs of one pattern letter, or literals. */
const runs = (format: string): string[] => format.match(/([yMdHhmsf])\1*|[^yMdHhmsf]+/g) ?? []

const pad = (value: number, width: number): string =>
  String(value).padStart(width, "0")

/** Formats a date with the .NET custom format letters the app allows. */
export const formatDate = (format: string, date: Date): string =>
  runs(format).map((run) => {
    const n = run.length
    switch (run[0]) {
      case "y":
        return n <= 2
          ? pad(date.getFullYear() % 100, n)
          : pad(date.getFullYear(), n)
      case "M": return pad(date.getMonth() + 1, n)
      case "d": return pad(date.getDate(), n)
      case "H": return pad(date.getHours(), n)
      case "h": return pad(date.getHours() % 12 || 12, n)
      case "m": return pad(date.getMinutes(), n)
      case "s": return pad(date.getSeconds(), n)
      case "f": return pad(date.getMilliseconds(), 3).padEnd(n, "0").slice(0, n)
      default: return run
    }
  }).join("")

/** Expands every date token in a template (folder tokens must be gone). */
export const expandDates = (template: string, date: Date): string =>
  template.replace(TOKEN, (whole, token: string) => {
    if (isFolderToken(token)) return whole
    if (!DATE_CHARS.test(token)) throw new Error(`unknown token {${token}}`)
    return formatDate(token, date)
  })

const escapeRegex = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

interface Field {
  letter: string
  width: number
}

/** A regex for names a template produces, with one group per date field. */
export const templateMatcher = (
  template: string,
): { regex: RegExp; fields: Field[] } => {
  const fields: Field[] = []
  let source = ""
  let last = 0
  for (const match of template.matchAll(TOKEN)) {
    source += escapeRegex(template.slice(last, match.index))
    last = (match.index ?? 0) + match[0].length
    const token = match[1] ?? ""
    if (isFolderToken(token) || !DATE_CHARS.test(token)) {
      throw new Error(`cannot match token {${token}}`)
    }
    for (const run of runs(token)) {
      const letter = run[0] ?? ""
      if ("yMdHhmsf".includes(letter)) {
        fields.push({ letter, width: run.length })
        source += run.length === 1 ? "(\\d{1,2})" : `(\\d{${run.length}})`
      } else {
        source += escapeRegex(run)
      }
    }
  }
  source += escapeRegex(template.slice(last))
  return { regex: new RegExp(`^${source}$`, "i"), fields }
}

/** The local time a name encodes, or null when it doesn't fit the template. */
export const parseNameTime = (name: string, template: string): Date | null => {
  const { regex, fields } = templateMatcher(template)
  const match = regex.exec(name)
  if (!match) return null
  const parts = { y: 2000, M: 1, d: 1, H: 0, m: 0, s: 0, f: 0 }
  fields.forEach((field, i) => {
    const value = Number(match[i + 1])
    switch (field.letter) {
      case "y": parts.y = field.width <= 2 ? 2000 + value : value; break
      case "M": parts.M = value; break
      case "d": parts.d = value; break
      case "H": case "h": parts.H = value; break
      case "m": parts.m = value; break
      case "s": parts.s = value; break
      case "f": parts.f = Math.round(value * 10 ** (3 - field.width)); break
    }
  })
  const date = new Date(parts.y, parts.M - 1, parts.d, parts.H, parts.m,
    parts.s, parts.f)
  return Number.isNaN(date.getTime()) ? null : date
}
