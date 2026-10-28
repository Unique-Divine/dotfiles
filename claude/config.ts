import { bash } from "@uniquedivine/bash"
import { mkdir, rename, rm, writeFile } from "node:fs/promises"
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

export interface ClaudePaths {
  directory: string
  settings: string
  state: string
}

/** Claude stores default state beside .claude, but override state inside it. */
export const claudePaths = (
  env: NodeJS.ProcessEnv = process.env,
): ClaudePaths => {
  if (!env.HOME) throw new Error("HOME is not set")
  const override = env.CLAUDE_CONFIG_DIR
  const directory = resolve(override || resolve(env.HOME, ".claude"))
  return {
    directory,
    settings: resolve(directory, "settings.json"),
    state: resolve(override ? directory : env.HOME, ".claude.json"),
  }
}

export const runtimeSettingsPath = (
  env: NodeJS.ProcessEnv = process.env,
): string => claudePaths(env).settings

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

// These internal Claude fields were verified with Claude Code 2.1.310.
// Authentication, MCPs, project trust, and machine identity stay host-local.
export const dotfileState = {
  editorMode: "vim",
  showExpandedTodos: true,
  hasCompletedOnboarding: true,
} as const

export const runtimeStatePath = (
  env: NodeJS.ProcessEnv = process.env,
): string => claudePaths(env).state

export const mergeRuntimeState = (state: JsonObject): JsonObject => ({
  ...state,
  ...dotfileState,
})

export const ownedState = (state: JsonObject): JsonObject =>
  Object.fromEntries(Object.keys(dotfileState)
    .filter((key) => Object.hasOwn(state, key))
    .map((key) => [key, state[key]]))

export const stateHasDrift = (state: JsonObject): boolean =>
  Object.entries(dotfileState).some(([key, value]) => state[key] !== value)

export async function assertClaudeStopped(): Promise<void> {
  const uid = process.getuid?.()
  if (uid === undefined) throw new Error("Claude state sync requires Unix")
  const result = await bash(`pgrep -u ${uid} -x claude`)
  if (result.exitCode === 0) {
    throw new Error("Claude is running. Exit Claude sessions before repairing " +
      "state with just claude config --run; existing sessions were left alone.")
  }
  if (result.exitCode !== 1) {
    throw new Error("Unable to check running Claude processes; no state written")
  }
}

/** Write an already-planned merge after the caller checks for running Claude. */
export async function writeState(
  path: string, before: string, merged: JsonObject,
): Promise<void> {
  const latest = await readJsonObject(path)
  if (latest.text !== before) {
    throw new Error("Claude state changed during sync; rerun after exiting Claude")
  }
  await mkdir(dirname(path), { recursive: true })
  const suffix = crypto.randomUUID()
  const temporary = `${path}.${suffix}.tmp`
  try {
    if (before) {
      await writeFile(`${path}.before-dotfiles-${suffix}`, before,
        { mode: 0o600, flag: "wx" })
    }
    await writeFile(temporary, stringify(merged), { mode: 0o600, flag: "wx" })
    // Check again before replacing a file Claude can rewrite independently.
    if ((await readJsonObject(path)).text !== before) {
      throw new Error("Claude state changed during sync; refusing to replace it")
    }
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

export interface StateOptions {
  runtimePath?: string
  dryRun?: boolean
  quiet?: boolean
}

export async function applyState({
  runtimePath = runtimeStatePath(), dryRun = false, quiet = false,
}: StateOptions = {}): Promise<boolean> {
  const { config, text } = await readJsonObject(runtimePath)
  if (!stateHasDrift(config)) {
    if (!quiet) console.log(`Claude state is already current: ${runtimePath}`)
    return false
  }
  const merged = mergeRuntimeState(config)
  if (!quiet) {
    console.log(`Claude state differs: ${runtimePath}`)
    process.stdout.write(unifiedDiff(
      stringify(ownedState(config)), stringify(ownedState(merged)),
      "runtime Claude state (managed keys)", "desired Claude state (managed keys)",
    ))
  }
  if (!dryRun) {
    await assertClaudeStopped()
    await writeState(runtimePath, text, merged)
  }
  return true
}

export interface ConfigOptions {
  settingsPath?: string
  statePath?: string
  dryRun?: boolean
  quiet?: boolean
}

/** Preflight both files before applying either part of Claude configuration. */
export async function applyConfig({
  settingsPath = runtimeSettingsPath(), statePath = runtimeStatePath(),
  dryRun = false, quiet = false,
}: ConfigOptions = {}): Promise<boolean> {
  await Promise.all([readJsonObject(settingsPath), readJsonObject(statePath)])
  // State repair can be blocked by running Claude. Check it before settings
  // writes so that a blocked setup leaves both files untouched.
  const stateChanged = await applyState({
    runtimePath: statePath, dryRun, quiet,
  })
  const settingsChanged = await applySettings({
    runtimePath: settingsPath, dryRun, quiet,
  })
  return stateChanged || settingsChanged
}

interface CliOptions {
  check?: boolean
  dryRun?: boolean
  print?: boolean
  quiet?: boolean
  run?: boolean
}

export const createProgram = (): Command => {
  const program = new Command()
  program
    .name("claude-config")
    .description("Manage Claude settings, portable preferences, and onboarding")
    .option("--run", "repair managed configuration in both runtime files")
    .option("--dry-run", "show managed-key diffs without writing")
    .option("--check", "exit with code 1 if either file has managed drift")
    .option("--print", "print the desired managed keys for both files")
    .option("--quiet", "suppress normal output")
    .action(async (options: CliOptions) => {
      if (!options.run && !options.dryRun && !options.check && !options.print) {
        program.outputHelp()
        return
      }
      try {
        const settingsPath = runtimeSettingsPath()
        const statePath = runtimeStatePath()
        if (options.print) {
          const [settings, state] = await Promise.all([
            readJsonObject(settingsPath), readJsonObject(statePath),
          ])
          process.stdout.write(stringify({
            settings: ownedView(mergeRuntimeSettings(settings.config)),
            state: ownedState(mergeRuntimeState(state.config)),
          }))
          return
        }
        const changed = await applyConfig({
          settingsPath, statePath,
          dryRun: !options.run || options.dryRun || options.check,
          quiet: options.quiet,
        })
        if (options.check && changed) process.exitCode = 1
      } catch (error) {
        console.error(error instanceof Error ? error.message : "Config sync failed")
        process.exitCode = 1
      }
    })
  return program
}

if (import.meta.main) await createProgram().parseAsync()
