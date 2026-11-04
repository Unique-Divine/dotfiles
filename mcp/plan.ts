import { mkdir, rename, rm, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

import {
  isLauncherEntry, isRecord, type DesiredEntries, type McpServer,
} from "./servers.ts"

/**
 * Plans a one-way sync from Codex-derived entries into one target's
 * `mcpServers` object.
 *
 * Ownership: a launcher entry is always ours. A url entry is ours only when
 * the managed-state file lists its name for this target, because a copied url
 * entry is otherwise indistinguishable from one the user added by hand. Only
 * entries we own are removed when their server leaves the Codex config.
 */

export interface PlannedEntry {
  name: string
  entry: McpServer
}

export interface McpPlan {
  add: PlannedEntry[]
  update: (PlannedEntry & { replacesUnmanaged: boolean })[]
  remove: string[]
  skip: { name: string; reason: string }[]
}

/** Drops fields that tools add or omit without changing meaning. */
const normalize = (entry: McpServer): McpServer => {
  const out: McpServer = {}

  for (const [key, value] of Object.entries(entry)) {
    if (isRecord(value) && Object.keys(value).length === 0) continue
    if (key === "type" && value === "stdio") continue
    out[key] = value
  }

  return out
}

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, inner: unknown) =>
    isRecord(inner)
      ? Object.fromEntries(
        Object.entries(inner).sort(([a], [b]) => a.localeCompare(b)),
      )
      : inner,
  )

export const sameEntry = (current: unknown, desired: McpServer): boolean =>
  isRecord(current) &&
  canonical(normalize(current)) === canonical(normalize(desired))

export const isManagedEntry = (
  name: string,
  entry: unknown,
  managedUrlNames: ReadonlySet<string>,
): boolean => isLauncherEntry(entry) || managedUrlNames.has(name)

export const planSync = (
  desired: DesiredEntries,
  current: Record<string, unknown>,
  managedUrlNames: ReadonlySet<string> = new Set(),
): McpPlan => {
  const plan: McpPlan = {
    add: [], update: [], remove: [], skip: [...desired.skip],
  }
  // A Codex server that cannot be mapped still exists, so its old copy stays.
  const keep = new Set([
    ...Object.keys(desired.entries),
    ...desired.skip.map(({ name }) => name),
  ])

  for (const name of Object.keys(desired.entries).sort()) {
    const entry = desired.entries[name]
    const existing = current[name]

    if (existing === undefined) {
      plan.add.push({ name, entry })
    } else if (!sameEntry(existing, entry)) {
      plan.update.push({
        name,
        entry,
        replacesUnmanaged: !isManagedEntry(name, existing, managedUrlNames),
      })
    }
  }

  for (const name of Object.keys(current).sort()) {
    if (!keep.has(name) &&
      isManagedEntry(name, current[name], managedUrlNames)) {
      plan.remove.push(name)
    }
  }

  return plan
}

export const hasChanges = (plan: McpPlan): boolean =>
  plan.add.length + plan.update.length + plan.remove.length > 0

/** One line per planned change. Lines carry server names only. */
export const describePlan = (plan: McpPlan, target: string): string[] => [
  ...plan.add.map(({ name }) => `+ add ${name}`),
  ...plan.update.map(({ name, replacesUnmanaged }) =>
    replacesUnmanaged
      ? `~ replace ${name} (unmanaged ${target} entry)`
      : `~ update ${name}`,
  ),
  ...plan.remove.map((name) => `- remove ${name}`),
  ...plan.skip.map(({ name, reason }) => `! skip ${name}: ${reason}`),
]

/**
 * Managed url names per target config path, kept outside the tool configs:
 * `{ "version": 1, "targets": { "/abs/.claude.json": ["docs"] } }`.
 */
export interface ManagedState {
  version: 1
  targets: Record<string, string[]>
}

export const managedStatePath = (
  env: NodeJS.ProcessEnv = process.env,
): string => {
  const stateHome = env.XDG_STATE_HOME ||
    (env.HOME ? resolve(env.HOME, ".local/state") : undefined)

  if (!stateHome) {
    throw new Error("HOME is not set")
  }

  return resolve(stateHome, "dotfiles/mcp-managed.json")
}

export const readManagedState = async (
  path: string,
): Promise<ManagedState> => {
  const file = Bun.file(path)

  if (!(await file.exists())) {
    return { version: 1, targets: {} }
  }

  let parsed: unknown

  try {
    parsed = JSON.parse(await file.text())
  } catch (error) {
    throw new Error(`Unable to parse MCP managed state at ${path}`, {
      cause: error,
    })
  }

  if (!isRecord(parsed) || !isRecord(parsed.targets)) {
    throw new Error(`${path} must hold { version, targets }`)
  }

  const targets: Record<string, string[]> = {}

  for (const [target, names] of Object.entries(parsed.targets)) {
    if (!Array.isArray(names) ||
      !names.every((name) => typeof name === "string")) {
      throw new Error(`${path} targets entries must be name lists`)
    }
    targets[target] = names
  }

  return { version: 1, targets }
}

export const managedNames = (
  state: ManagedState,
  targetPath: string,
): Set<string> => new Set(state.targets[resolve(targetPath)] ?? [])

export const withManagedNames = (
  state: ManagedState,
  targetPath: string,
  names: Iterable<string>,
): ManagedState => {
  const sorted = [...new Set(names)].sort()
  const targets = { ...state.targets }

  if (sorted.length === 0) {
    delete targets[resolve(targetPath)]
  } else {
    targets[resolve(targetPath)] = sorted
  }

  return { version: 1, targets }
}

/** Atomic private write. Returns false when the file already matches. */
export const writePrivateFile = async (
  path: string,
  text: string,
): Promise<boolean> => {
  const file = Bun.file(path)

  if ((await file.exists()) && (await file.text()) === text) {
    return false
  }

  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${crypto.randomUUID()}.tmp`

  try {
    await writeFile(temporary, text, { mode: 0o600, flag: "wx" })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }

  return true
}

export const writeManagedState = async (
  path: string,
  state: ManagedState,
): Promise<boolean> =>
  writePrivateFile(path, `${JSON.stringify(state, null, 2)}\n`)

/**
 * Applies a plan through `apply` and keeps the managed-state file honest
 * across a partial failure: names we may add are recorded before any write,
 * and the final set (the desired url names) is recorded after success.
 */
export const applyWithManagedState = async ({
  statePath,
  targetPath,
  desired,
  plan,
  apply,
}: {
  statePath: string
  targetPath: string
  desired: DesiredEntries
  plan: McpPlan
  apply: () => Promise<void>
}): Promise<void> => {
  const state = await readManagedState(statePath)
  const before = managedNames(state, targetPath)

  if (hasChanges(plan)) {
    await writeManagedState(
      statePath,
      withManagedNames(state, targetPath, [...before, ...desired.urlNames]),
    )
    await apply()
  }

  // A skipped server keeps its old copy, so it also keeps its ownership.
  const skipped = new Set(desired.skip.map(({ name }) => name))
  const final = new Set([
    ...desired.urlNames,
    ...[...before].filter((name) => skipped.has(name)),
  ])
  const latest = await readManagedState(statePath)
  const current = managedNames(latest, targetPath)

  if (current.size !== final.size ||
    [...final].some((name) => !current.has(name))) {
    await writeManagedState(
      statePath,
      withManagedNames(latest, targetPath, final),
    )
  }
}
