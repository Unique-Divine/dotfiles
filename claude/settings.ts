import { mkdir, rename, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { Command } from "commander"

import { unifiedDiff } from "../configDiff.ts"

type JsonPrimitive = string | number | boolean | null
type JsonValue = JsonPrimitive | JsonValue[] | JsonObject
export type JsonObject = { [key: string]: JsonValue | undefined }

/**
 * Commit and pull-request attribution added by Claude Code.
 *
 * See https://code.claude.com/docs/en/settings-reference.md. An empty string
 * hides that attribution. `sessionUrl` controls the claude.ai session link
 * appended from cloud and Remote Control sessions.
 */
export interface ClaudeAttributionConfig {
  /** Git trailer for commits, such as `Co-Authored-By`. */
  commit: string
  /** Text appended to pull request descriptions. */
  pr: string
  /** Appends the claude.ai session link when enabled. */
  sessionUrl: boolean
}

/** Status line command. See https://code.claude.com/docs/en/statusline.md. */
export interface ClaudeStatusLineConfig {
  type: "command"
  /** Shell command that reads the session JSON on stdin. */
  command: string
}

/**
 * Status line script in this checkout. Like the MCP launcher, the runtime
 * entry holds an absolute path, so rerun `just sync` after moving the checkout.
 */
export const statusLinePath = resolve(import.meta.dir, "statusline.sh")

/**
 * Portable Claude Code settings owned by this dotfiles repository.
 *
 * Every other key in `$HOME/.claude/settings.json`, including values written
 * by `/config`, `/model`, and permission prompts, is preserved.
 */
export interface ClaudeManagedSettings {
  /** Commit and pull-request attribution preferences. */
  attribution: ClaudeAttributionConfig
  /** Status line styled after the lualine setup in `nvim/init.lua`. */
  statusLine: ClaudeStatusLineConfig
  /**
   * Terminal UI renderer. `"default"` draws on the normal terminal screen, so
   * tmux and Herdr copy mode can scroll earlier output. `"fullscreen"` uses the
   * alternate screen, which keeps output out of the multiplexer's scrollback.
   */
  tui: "default" | "fullscreen"
}

export const dotfileSettings = {
  attribution: {
    commit: "",
    pr: "",
    sessionUrl: false,
  },
  statusLine: {
    type: "command",
    command: `bash ${statusLinePath}`,
  },
  // Like Codex's `alternate_screen = "never"`: keep chat output in the
  // multiplexer's scrollback.
  tui: "default",
} satisfies ClaudeManagedSettings

/**
 * Top-level keys this repository owns. An owned key missing from
 * `dotfileSettings` is removed from the runtime file. `includeCoAuthoredBy`
 * is the deprecated predecessor of `attribution`.
 */
const ownedTopLevelFields = [
  "attribution",
  "includeCoAuthoredBy",
  "statusLine",
  "tui",
] as const

/**
 * Rules sync adds to `permissions.allow`. Unlike owned keys, the runtime rules
 * stay, because `/permissions` and permission prompts also write that list.
 */
export const managedAllowRules: readonly string[] = ["Bash(rg:*)"]

/**
 * Returns runtime `permissions` with every managed allow rule present. Other
 * fields, such as `deny` and `defaultMode`, and existing rule order are kept.
 */
export const mergePermissions = (
  runtimePermissions: JsonValue | undefined,
  rules: readonly string[] = managedAllowRules,
): JsonObject => {
  const permissions = isJsonObject(runtimePermissions)
    ? runtimePermissions
    : {}
  const allow = Array.isArray(permissions.allow) ? permissions.allow : []
  const missing = rules.filter((rule) => !allow.includes(rule))

  return { ...permissions, allow: [...allow, ...missing] }
}

export const runtimeSettingsPath = (
  env: NodeJS.ProcessEnv = process.env,
): string => {
  const home = env.HOME

  if (!home) {
    throw new Error("HOME is not set")
  }

  return resolve(home, ".claude/settings.json")
}

export const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const parseJsonObject = (json: string, path: string): JsonObject => {
  let parsed: unknown

  try {
    parsed = JSON.parse(json)
  } catch (error) {
    throw new Error(`Unable to parse JSON at ${path}`, { cause: error })
  }

  if (!isJsonObject(parsed)) {
    throw new Error(`${path} must contain a JSON object`)
  }

  return parsed
}

export const readJsonObject = async (
  path: string,
): Promise<{ config: JsonObject; text: string }> => {
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

export const mergeRuntimeSettings = (
  runtimeSettings: JsonObject,
  settings: JsonObject = dotfileSettings,
): JsonObject => {
  const owned = new Set<string>(ownedTopLevelFields)
  const out: JsonObject = {}

  for (const [key, value] of Object.entries(runtimeSettings)) {
    if (owned.has(key)) {
      if (Object.hasOwn(settings, key)) {
        out[key] = settings[key]
      }

      continue
    }

    out[key] = value
  }

  for (const [key, value] of Object.entries(settings)) {
    if (!Object.hasOwn(out, key)) {
      out[key] = value
    }
  }

  out.permissions = mergePermissions(runtimeSettings.permissions)

  return out
}

/**
 * Returns only the owned keys and `permissions` of a settings object. Diffs
 * use this view so unmanaged values, such as an `env` block holding tokens,
 * never print.
 */
export const ownedView = (settings: JsonObject): JsonObject => {
  const out: JsonObject = {}

  for (const key of [...ownedTopLevelFields, "permissions"]) {
    if (Object.hasOwn(settings, key)) {
      out[key] = settings[key]
    }
  }

  return out
}

export const stringify = (config: JsonObject): string =>
  `${JSON.stringify(config, null, 2)}\n`

export interface ApplyOptions {
  runtimePath?: string
  dryRun?: boolean
  quiet?: boolean
}

export const applySettings = async ({
  runtimePath = runtimeSettingsPath(),
  dryRun = false,
  quiet = false,
}: ApplyOptions = {}): Promise<boolean> => {
  const { config: runtimeSettings, text: beforeText } =
    await readJsonObject(runtimePath)
  const nextSettings = mergeRuntimeSettings(runtimeSettings)
  const afterText = stringify(nextSettings)

  if (beforeText === afterText) {
    if (!quiet) {
      console.log(`Claude Code settings are already current: ${runtimePath}`)
    }

    return false
  }

  if (!quiet) {
    console.log(`Claude Code settings differ: ${runtimePath}`)
    process.stdout.write(
      unifiedDiff(
        stringify(ownedView(runtimeSettings)),
        stringify(ownedView(nextSettings)),
        "runtime settings.json (managed keys)",
        "generated settings.json (managed keys)",
      ),
    )
  }

  if (!dryRun) {
    await mkdir(dirname(runtimePath), { recursive: true })
    const tmpPath = `${runtimePath}.${process.pid}.tmp`
    await writeFile(tmpPath, afterText, { mode: 0o600 })
    await rename(tmpPath, runtimePath)
  }

  return true
}

interface SettingsOptions {
  check?: boolean
  dryRun?: boolean
  print?: boolean
  quiet?: boolean
  run?: boolean
}

export const createProgram = (): Command => {
  const program = new Command()

  program
    .name("claude-settings")
    .description(
      "Merge managed keys into ~/.claude/settings.json and keep the rest.",
    )
    .option("--run", "write the runtime settings if they differ")
    .option("--dry-run", "print the managed-key diff without writing")
    .option("--check", "exit with code 1 if the runtime settings would change")
    .option("--print", "print the managed keys of the generated settings")
    .option("--quiet", "suppress normal output with --run")
    .action(async (options: SettingsOptions) => {
      const hasAction =
        options.run || options.dryRun || options.check || options.print

      if (!hasAction) {
        program.outputHelp()
        return
      }

      const runtimePath = runtimeSettingsPath()

      if (options.print) {
        const { config } = await readJsonObject(runtimePath)
        process.stdout.write(stringify(ownedView(mergeRuntimeSettings(config))))
        return
      }

      const changed = await applySettings({
        runtimePath,
        dryRun: !options.run || options.dryRun || options.check,
        quiet: options.quiet,
      })

      if (options.check && changed) {
        process.exitCode = 1
      }
    })

  return program
}

if (import.meta.main) {
  await createProgram().parseAsync()
}
