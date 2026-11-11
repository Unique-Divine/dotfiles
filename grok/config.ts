import { mkdir, rename, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { Command } from "commander"
import { parse, stringify, type TomlTable } from "smol-toml"

import { changedKeyPaths, formatKeyChanges } from "../configDiff.ts"

/**
 * Status line script in this checkout. The runtime entry holds an absolute
 * path, so run `just sync` after moving the checkout.
 */
export const statusLinePath = resolve(import.meta.dir, "statusline.sh")

/**
 * Portable Grok defaults maintained by this dotfiles repository.
 *
 * Authentication, sessions, marketplace state, privacy acknowledgements, and
 * `mcp_servers` stay in the runtime file. MCP servers are exported from Codex
 * and reach Grok through its Claude and Cursor compatibility scans.
 */
export const dotfileConfig = {
  keys: {
    vim: "all",
  },
  ui: {
    permission_mode: "auto",
    status_line: {
      type: "command",
      command: statusLinePath,
    },
  },
} satisfies TomlTable

/**
 * Pager defaults. `alt_screen = "never"` draws on the normal terminal screen
 * so Tmux and Herdr copy mode can scroll earlier output.
 */
export const dotfilePager = {
  terminal: {
    alt_screen: "never",
  },
} satisfies TomlTable

/**
 * Nested tables this repository replaces as a whole. A deep merge would keep
 * sibling keys, such as `items` left behind by a builtin status line.
 */
const replacedTables = new Set(["ui.status_line"])

export const grokDirectory = (
  env: NodeJS.ProcessEnv = process.env,
): string => {
  const home = env.HOME

  if (!home) {
    throw new Error("HOME is not set")
  }

  const override = env.GROK_HOME?.trim()

  if (!override) {
    return resolve(home, ".grok")
  }

  if (override === "~") {
    return resolve(home)
  }

  if (override.startsWith("~/")) {
    return resolve(home, override.slice(2))
  }

  return resolve(override)
}

export const configPath = (env: NodeJS.ProcessEnv = process.env): string =>
  resolve(grokDirectory(env), "config.toml")

export const pagerPath = (env: NodeJS.ProcessEnv = process.env): string =>
  resolve(grokDirectory(env), "pager.toml")

const isTomlTable = (value: unknown): value is TomlTable =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const parseTomlTable = (toml: string, path: string): TomlTable => {
  const parsed = parse(toml) as unknown

  if (!isTomlTable(parsed)) {
    throw new Error(`${path} must contain a TOML table`)
  }

  return parsed
}

const mergeTables = (
  runtime: TomlTable,
  owned: TomlTable,
  prefix = "",
): TomlTable => {
  const merged: TomlTable = { ...runtime }

  for (const [key, value] of Object.entries(owned)) {
    const path = prefix === "" ? key : `${prefix}.${key}`
    const existing = merged[key]

    if (
      !replacedTables.has(path) &&
      isTomlTable(existing) &&
      isTomlTable(value)
    ) {
      merged[key] = mergeTables(existing, value, path)
      continue
    }

    merged[key] = value
  }

  return merged
}

export const mergeRuntimeConfig = (
  runtimeConfig: TomlTable,
  config: TomlTable = dotfileConfig,
): TomlTable => mergeTables(runtimeConfig, config)

/** Canonical on-disk TOML, with one trailing newline. */
export const serialize = (config: TomlTable): string => {
  const text = stringify(config)

  return text.endsWith("\n") ? text : `${text}\n`
}

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

interface ManagedFile {
  label: string
  path: string
  owned: TomlTable
}

const managedFiles = (
  configFile: string,
  pagerFile: string,
): ManagedFile[] => [
  { label: "Grok config", path: configFile, owned: dotfileConfig },
  { label: "Grok pager", path: pagerFile, owned: dotfilePager },
]

const writeAtomic = async (path: string, text: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  const tmpPath = `${path}.${process.pid}.tmp`
  await writeFile(tmpPath, text, { mode: 0o600 })
  await rename(tmpPath, path)
}

export interface ApplyOptions {
  configFile?: string
  pagerFile?: string
  dryRun?: boolean
  quiet?: boolean
}

const applyFile = async (
  file: ManagedFile,
  dryRun: boolean,
  quiet: boolean,
): Promise<boolean> => {
  const { config: runtimeConfig } = await readRuntimeConfig(file.path)
  const nextConfig = mergeRuntimeConfig(runtimeConfig, file.owned)
  const currentText = serialize(runtimeConfig)
  const nextText = serialize(nextConfig)

  if (currentText === nextText) {
    if (!quiet) {
      console.log(`${file.label} is already current: ${file.path}`)
    }

    return false
  }

  if (!quiet) {
    console.log(`${file.label} differs: ${file.path}`)
    process.stdout.write(
      formatKeyChanges(
        changedKeyPaths(
          runtimeConfig as Record<string, unknown>,
          nextConfig as Record<string, unknown>,
        ),
      ),
    )
  }

  if (!dryRun) {
    await writeAtomic(file.path, nextText)
  }

  return true
}

export const applyConfig = async ({
  configFile = configPath(),
  pagerFile = pagerPath(),
  dryRun = false,
  quiet = false,
}: ApplyOptions = {}): Promise<boolean> => {
  let changed = false

  for (const file of managedFiles(configFile, pagerFile)) {
    if (await applyFile(file, dryRun, quiet)) {
      changed = true
    }
  }

  return changed
}

export const renderManaged = async (
  configFile = configPath(),
  pagerFile = pagerPath(),
): Promise<string> => {
  const parts: string[] = []

  for (const file of managedFiles(configFile, pagerFile)) {
    const { config } = await readRuntimeConfig(file.path)
    const next = mergeRuntimeConfig(config, file.owned)
    parts.push(`# ${file.path}\n${serialize(next)}`)
  }

  return parts.join("\n")
}

interface ConfigOptions {
  check?: boolean
  dryRun?: boolean
  print?: boolean
  quiet?: boolean
  run?: boolean
}

const runConfig = async (options: ConfigOptions): Promise<void> => {
  const configFile = configPath()
  const pagerFile = pagerPath()

  if (options.print) {
    process.stdout.write(await renderManaged(configFile, pagerFile))
    return
  }

  const changed = await applyConfig({
    configFile,
    pagerFile,
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
    .name("grok-config")
    .description(
      "Write ~/.grok config and pager files, preserving local state.",
    )
    .option("--run", "write the runtime files if they differ")
    .option("--dry-run", "print the diff without writing")
    .option("--check", "exit with code 1 if a runtime file would change")
    .option(
      "--print",
      "print the generated runtime TOML, including any secrets",
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
