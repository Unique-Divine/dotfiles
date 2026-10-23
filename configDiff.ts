/**
 * Change reports for the config sync scripts.
 *
 * Runtime config files such as `~/.codex/config.toml` and
 * `~/.cursor/cli-config.json` hold tokens. Reports for those files use
 * `changedKeyPaths`, which names what changed without printing any value.
 * `unifiedDiff` prints values and is only for text known to hold no secrets.
 */

export type KeyChangeKind = "added" | "removed" | "changed"

export interface KeyChange {
  path: string
  kind: KeyChangeKind
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  !(value instanceof Date)

/** Formats one key for a dotted path, quoting keys that need it. */
const pathSegment = (key: string): string =>
  /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key)

/**
 * Lists the leaf key paths that differ between two config objects. Nested
 * objects are walked; arrays and scalars are compared as whole values. A key
 * whose value is an object on one side only reports as one change.
 */
export const changedKeyPaths = (
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  prefix = "",
): KeyChange[] => {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])]
  const changes: KeyChange[] = []

  for (const key of keys.sort()) {
    const path = prefix === "" ? pathSegment(key) : `${prefix}.${pathSegment(key)}`
    const inBefore = Object.hasOwn(before, key)
    const inAfter = Object.hasOwn(after, key)

    if (!inBefore) {
      changes.push({ path, kind: "added" })
      continue
    }

    if (!inAfter) {
      changes.push({ path, kind: "removed" })
      continue
    }

    const left = before[key]
    const right = after[key]

    if (isPlainObject(left) && isPlainObject(right)) {
      changes.push(...changedKeyPaths(left, right, path))
    } else if (JSON.stringify(left) !== JSON.stringify(right)) {
      changes.push({ path, kind: "changed" })
    }
  }

  return changes
}

const kindMarker: Record<KeyChangeKind, string> = {
  added: "+",
  removed: "-",
  changed: "~",
}

/** Renders key changes as indented `+`, `-`, and `~` lines, values hidden. */
export const formatKeyChanges = (changes: KeyChange[]): string => {
  if (changes.length === 0) {
    return "Changed keys: none (formatting only)\n"
  }

  const lines = changes.map(({ path, kind }) => `  ${kindMarker[kind]} ${path}`)

  return `Changed keys (values hidden):\n${lines.join("\n")}\n`
}

/**
 * Line diff with three lines of context. It prints values, so callers must
 * pass only text that holds no secrets.
 */
export const unifiedDiff = (
  beforeText: string,
  afterText: string,
  beforeLabel = "before",
  afterLabel = "after",
): string => {
  if (beforeText === afterText) {
    return ""
  }

  const beforeLines = beforeText === "" ? [] : beforeText.split("\n")
  const afterLines = afterText === "" ? [] : afterText.split("\n")
  let prefix = 0

  while (
    prefix < beforeLines.length &&
    prefix < afterLines.length &&
    beforeLines[prefix] === afterLines[prefix]
  ) {
    prefix += 1
  }

  let suffix = 0

  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] ===
      afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix += 1
  }

  const contextBeforeStart = Math.max(0, prefix - 3)
  const beforeChangeEnd = beforeLines.length - suffix
  const afterChangeEnd = afterLines.length - suffix
  const contextAfterEnd = Math.min(beforeLines.length, beforeChangeEnd + 3)
  const out = [`--- ${beforeLabel}`, `+++ ${afterLabel}`, "@@"]

  for (const line of beforeLines.slice(contextBeforeStart, prefix)) {
    out.push(` ${line}`)
  }

  for (const line of beforeLines.slice(prefix, beforeChangeEnd)) {
    out.push(`-${line}`)
  }

  for (const line of afterLines.slice(prefix, afterChangeEnd)) {
    out.push(`+${line}`)
  }

  for (const line of beforeLines.slice(beforeChangeEnd, contextAfterEnd)) {
    out.push(` ${line}`)
  }

  return `${out.join("\n")}\n`
}
