import { mkdir, rename, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

type JsonPrimitive = string | number | boolean | null
type JsonValue = JsonPrimitive | JsonValue[] | JsonObject
type JsonObject = { [key: string]: JsonValue | undefined }

/** Tool permission patterns enforced by the Cursor CLI. */
export interface CursorCliPermissions {
  /** Tool-call patterns that the CLI may run without additional approval. */
  allow: string[]
  /** Tool-call patterns that the CLI must refuse. */
  deny: string[]
}

/** Stable editor behavior managed by this dotfiles repository. */
export interface CursorCliEditorConfig {
  /** Enables Vim-style keybindings in the Cursor CLI prompt editor. */
  vimMode: boolean
}

/** Controls whether Cursor adds agent attribution to Git operations. */
export interface CursorCliAttributionConfig {
  /** Adds agent attribution to commits created through Cursor when enabled. */
  attributeCommitsToAgent: boolean
  /** Adds agent attribution to pull requests created through Cursor when enabled. */
  attributePRsToAgent: boolean
}

/** Sandbox preferences applied to shell commands run by the Cursor CLI. */
export interface CursorCliSandboxConfig {
  /** Enables or disables Cursor's command sandbox. */
  mode: "disabled" | "enabled"
}

/** Network transport preferences for the Cursor CLI agent connection. */
export interface CursorCliNetworkConfig {
  /** Uses HTTP/1.1 instead of HTTP/2 for agent connections when enabled. */
  useHttp1ForAgent: boolean
}

/**
 * Portable Cursor CLI preferences owned by this dotfiles repository.
 *
 * Runtime-managed model, authentication, privacy, and cache fields are
 * intentionally excluded and preserved when the generated config is merged.
 */
export interface CursorCliManagedConfig {
  /** Cursor CLI configuration schema version. */
  version: 1
  /** Tool permission allow and deny patterns. */
  permissions: CursorCliPermissions
  /** Prompt-editor behavior that should remain consistent across machines. */
  editor: CursorCliEditorConfig
  /** Enables terminal notifications from the Cursor CLI. */
  notifications: boolean
  /** Shows contextual usage hints in the Cursor CLI. */
  hints: boolean
  /** Enables the conversation rewind control when supported. */
  rewind: boolean
  /** Allows Cursor to suggest a follow-up prompt after a response. */
  suggestNextPrompt: boolean
  /** Enables max mode globally when supported by the selected model. */
  maxMode: boolean
  /** Controls whether tools outside the permission allowlist require approval. */
  approvalMode: "allowlist" | "unrestricted"
  /** Shell-command sandbox preferences. */
  sandbox: CursorCliSandboxConfig
  /** Agent network transport preferences. */
  network: CursorCliNetworkConfig
  /** Commit and pull-request attribution preferences. */
  attribution: CursorCliAttributionConfig
}

export const runtimeConfigPath = (
  env: NodeJS.ProcessEnv = process.env,
): string => {
  const home = env.HOME

  if (!home) {
    throw new Error("HOME is not set")
  }

  return resolve(home, ".cursor/cli-config.json")
}

export const dotfileConfig = {
  version: 1,
  permissions: {
    allow: ["Shell(ls)"],
    deny: [],
  },
  editor: {
    vimMode: true,
  },
  notifications: true,
  hints: true,
  rewind: false,
  suggestNextPrompt: false,
  maxMode: false,
  approvalMode: "unrestricted",
  sandbox: {
    mode: "disabled",
  },
  network: {
    useHttp1ForAgent: false,
  },
  attribution: {
    attributeCommitsToAgent: false,
    attributePRsToAgent: false,
  },
} satisfies CursorCliManagedConfig

const ownedTopLevelFields = [
  "version",
  "permissions",
  "editor",
  "notifications",
  "hints",
  "rewind",
  "suggestNextPrompt",
  "maxMode",
  "approvalMode",
  "sandbox",
  "network",
  "display",
  "channel",
  "attribution",
  "webFetchDomainAllowlist",
  "bedrock",
] as const

const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const parseJsonObject = (json: string, path: string): JsonObject => {
  const parsed = JSON.parse(json) as unknown

  if (!isJsonObject(parsed)) {
    throw new Error(`${path} must contain a JSON object`)
  }

  return parsed
}

const stripUndefined = (
  value: JsonValue | undefined,
): JsonValue | undefined => {
  if (value === undefined) {
    return undefined
  }

  if (Array.isArray(value)) {
    return value
      .map((entry) => stripUndefined(entry))
      .filter((entry): entry is JsonValue => entry !== undefined)
  }

  if (isJsonObject(value)) {
    const out: JsonObject = {}

    for (const [key, entry] of Object.entries(value)) {
      const cleaned = stripUndefined(entry)

      if (cleaned !== undefined) {
        out[key] = cleaned
      }
    }

    return out
  }

  return value
}

export const mergeRuntimeConfig = (
  runtimeConfig: JsonObject,
  config: JsonObject = dotfileConfig,
): JsonObject => {
  const owned = new Set<string>(ownedTopLevelFields)
  const out: JsonObject = {}

  for (const [key, value] of Object.entries(runtimeConfig)) {
    if (owned.has(key)) {
      if (Object.hasOwn(config, key)) {
        out[key] = config[key]
      }

      continue
    }

    out[key] = value
  }

  for (const [key, value] of Object.entries(config)) {
    if (!Object.hasOwn(out, key)) {
      out[key] = value
    }
  }

  return stripUndefined(out) as JsonObject
}

const stringify = (config: JsonObject): string =>
  `${JSON.stringify(config, null, 2)}\n`

const readRuntimeConfig = async (
  path: string,
): Promise<{
  config: JsonObject
  text: string
}> => {
  const file = Bun.file(path)

  if (!(await file.exists())) {
    return { config: {}, text: "" }
  }

  const text = await file.text()

  if (text.trim() === "") {
    return { config: {}, text }
  }

  return { config: parseJsonObject(text, path), text }
}

export const changedTopLevelFields = (
  before: JsonObject,
  after: JsonObject,
): string[] => {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  const changed: string[] = []

  for (const key of [...keys].sort()) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      changed.push(key)
    }
  }

  return changed
}

export const unifiedDiff = (
  beforeText: string,
  afterText: string,
  beforeLabel = "runtime cli-config.json",
  afterLabel = "generated cli-config.json",
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

interface ApplyOptions {
  runtimePath?: string
  dryRun?: boolean
  quiet?: boolean
}

export const applyCliConfig = async ({
  runtimePath = runtimeConfigPath(),
  dryRun = false,
  quiet = false,
}: ApplyOptions = {}): Promise<boolean> => {
  const { config: runtimeConfig, text: beforeText } =
    await readRuntimeConfig(runtimePath)
  const nextConfig = mergeRuntimeConfig(runtimeConfig)
  const afterText = stringify(nextConfig)

  if (beforeText === afterText) {
    if (!quiet) {
      console.log(
        `Cursor CLI runtime config is already current: ${runtimePath}`,
      )
    }

    return false
  }

  if (!quiet) {
    const changed = changedTopLevelFields(runtimeConfig, nextConfig)
    console.log(`Cursor CLI runtime config differs: ${runtimePath}`)
    console.log(`Changed top-level fields: ${changed.join(", ")}`)
    process.stdout.write(unifiedDiff(beforeText, afterText))
  }

  if (!dryRun) {
    await mkdir(dirname(runtimePath), { recursive: true })
    const tmpPath = `${runtimePath}.${process.pid}.tmp`
    await writeFile(tmpPath, afterText, { mode: 0o600 })
    await rename(tmpPath, runtimePath)
  }

  return true
}

const printUsage = (): void => {
  console.log(`Usage: bun run cursor/cli-config.ts [options]

Generate ~/.cursor/cli-config.json from the dotfile config while preserving
Cursor-managed runtime fields.

Options:
  --run      Write the runtime config if it differs
  --dry-run  Print the diff without writing
  --check    Exit with code 1 if the runtime config would change
  --print    Print the generated runtime config JSON
  --quiet    Suppress normal output with --run
  -h, --help Show this help text`)
}

const main = async (): Promise<void> => {
  const args = new Set(Bun.argv.slice(2))

  if (args.size === 0 || args.has("--help") || args.has("-h")) {
    printUsage()
    return
  }

  const runtimePath = runtimeConfigPath()
  const { config: runtimeConfig } = await readRuntimeConfig(runtimePath)
  const nextConfig = mergeRuntimeConfig(runtimeConfig)

  if (args.has("--print")) {
    process.stdout.write(stringify(nextConfig))
    return
  }

  if (!args.has("--run") && !args.has("--dry-run") && !args.has("--check")) {
    printUsage()
    return
  }

  const changed = await applyCliConfig({
    runtimePath,
    dryRun: !args.has("--run") || args.has("--dry-run") || args.has("--check"),
    quiet: args.has("--quiet"),
  })

  if (args.has("--check") && changed) {
    process.exitCode = 1
  }
}

if (import.meta.main) {
  await main()
}
