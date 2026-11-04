import { mkdir, rename, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { Command } from "commander"
import { parse, stringify, type TomlTable } from "smol-toml"

import { changedKeyPaths, formatKeyChanges } from "../configDiff.ts"

/**
 * Portable Codex defaults maintained by this dotfiles repository.
 *
 * See https://developers.openai.com/codex/config-reference for the available
 * configuration fields. Project trust, onboarding state, and `mcp_servers` are
 * local and are preserved from the runtime config. The MCP servers are the
 * source that `mcp/` exports to Claude Code and the Cursor CLI.
 */
export const dotfileConfig = {
  personality: "pragmatic",
  approvals_reviewer: "user",
  model: "gpt-6-luna",
  model_reasoning_effort: "medium",
  approval_policy: "never",
  sandbox_mode: "danger-full-access",
  tui: {
    vim_mode_default: true,
    // Use the normal terminal screen so Herdr copy mode can scroll chat output.
    alternate_screen: "never",
    // Keep rendered output enabled by default. Toggle raw scrollback during a
    // session with `/raw` or Alt-R when terminal-native selection is needed.
    raw_output_mode: false,
    status_line: [
      "current-dir",
      "model-with-reasoning",
      "git-branch",
      "context-used",
    ],
    status_line_use_colors: true,
  },
} satisfies TomlTable

const userOwnedConfigKeys = new Set(["model", "model_reasoning_effort"])

export const runtimeConfigPath = (
  env: NodeJS.ProcessEnv = process.env,
): string => {
  const home = env.HOME

  if (!home) {
    throw new Error("HOME is not set")
  }

  return resolve(home, ".codex/config.toml")
}

const isTomlTable = (value: unknown): value is TomlTable =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const parseTomlTable = (toml: string, path: string): TomlTable => {
  const parsed = parse(toml) as unknown

  if (!isTomlTable(parsed)) {
    throw new Error(`${path} must contain a TOML table`)
  }

  return parsed
}

const mergeTables = (runtime: TomlTable, owned: TomlTable): TomlTable => {
  const merged: TomlTable = { ...runtime }

  for (const [key, value] of Object.entries(owned)) {
    const existing = merged[key]

    if (isTomlTable(existing) && isTomlTable(value)) {
      merged[key] = mergeTables(existing, value)
      continue
    }

    merged[key] = value
  }

  return merged
}

export const mergeRuntimeConfig = (
  runtimeConfig: TomlTable,
  config: TomlTable = dotfileConfig,
): TomlTable => {
  const cleanedRuntimeConfig = { ...runtimeConfig }
  // Project trust belongs under projects.<path>; remove the old top-level key.
  delete cleanedRuntimeConfig.trust_level

  const managedConfig = { ...config }
  for (const key of userOwnedConfigKeys) {
    if (key in cleanedRuntimeConfig) delete managedConfig[key]
  }

  return mergeTables(cleanedRuntimeConfig, managedConfig)
}

const schemaDirective =
  "#:schema https://developers.openai.com/codex/config-schema.json"

/** Canonical on-disk format, including the schema directive used by health. */
export const serialize = (config: TomlTable): string =>
  `${schemaDirective}\n${stringify(config)}\n`

const readRuntimeConfig = async (
  path: string,
): Promise<{ config: TomlTable; text: string }> => {
  const file = Bun.file(path)

  if (!(await file.exists())) {
    return { config: {}, text: "" }
  }

  const text = await file.text()

  if (text.trim() === "") {
    return { config: {}, text }
  }

  return { config: parseTomlTable(text, path), text }
}

export interface ApplyOptions {
  runtimePath?: string
  dryRun?: boolean
  quiet?: boolean
}

export const applyConfig = async ({
  runtimePath = runtimeConfigPath(),
  dryRun = false,
  quiet = false,
}: ApplyOptions = {}): Promise<boolean> => {
  const { config: runtimeConfig, text: beforeText } =
    await readRuntimeConfig(runtimePath)
  const nextConfig = mergeRuntimeConfig(runtimeConfig, dotfileConfig)
  const currentText = serialize(runtimeConfig)
  const afterText = serialize(nextConfig)
  const hasSchemaDirective = beforeText.startsWith(`${schemaDirective}\n`)
  const nextText =
    currentText === afterText && !hasSchemaDirective
      ? `${schemaDirective}\n${beforeText}`
      : afterText

  if (currentText === afterText && hasSchemaDirective) {
    if (!quiet) {
      console.log(`Codex runtime config is already current: ${runtimePath}`)
    }

    return false
  }

  if (!quiet) {
    console.log(`Codex runtime config differs: ${runtimePath}`)
    // The runtime file holds MCP tokens, so report key paths, not values.
    process.stdout.write(
      formatKeyChanges(changedKeyPaths(runtimeConfig, nextConfig)),
    )
  }

  if (!dryRun) {
    await mkdir(dirname(runtimePath), { recursive: true })
    const tmpPath = `${runtimePath}.${process.pid}.tmp`
    await writeFile(tmpPath, nextText, { mode: 0o600 })
    await rename(tmpPath, runtimePath)
  }

  return true
}

interface ConfigOptions {
  check?: boolean
  dryRun?: boolean
  print?: boolean
  quiet?: boolean
  run?: boolean
}

const runConfig = async (options: ConfigOptions): Promise<void> => {
  const runtimePath = runtimeConfigPath()
  const { config: runtimeConfig } = await readRuntimeConfig(runtimePath)
  const nextConfig = mergeRuntimeConfig(runtimeConfig, dotfileConfig)

  if (options.print) {
    process.stdout.write(serialize(nextConfig))
    return
  }

  const changed = await applyConfig({
    runtimePath,
    dryRun: !options.run || options.dryRun || options.check,
    quiet: options.quiet,
  })

  if (options.check && changed) {
    process.exitCode = 1
  }
}

export const createProgram = (): Command => {
  const program = new Command()

  program
    .name("codex-config")
    .description(
      "Generate ~/.codex/config.toml while preserving local Codex state.",
    )
    .option("--run", "write the runtime config if it differs")
    .option("--dry-run", "print the diff without writing")
    .option("--check", "exit with code 1 if the runtime config would change")
    .option(
      "--print",
      "print the generated runtime config TOML, including secrets",
    )
    .option("--quiet", "suppress normal output with --run")
    .action(async (options: ConfigOptions) => {
      const hasAction =
        options.run || options.dryRun || options.check || options.print

      if (!hasAction) {
        program.outputHelp()
        return
      }

      await runConfig(options)
    })

  return program
}

if (import.meta.main) {
  await createProgram().parseAsync()
}
