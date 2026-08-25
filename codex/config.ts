import { mkdir, rename, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { Command } from "commander"
import { parse, stringify, type TomlTable } from "smol-toml"

/**
 * Portable Codex defaults maintained by this dotfiles repository.
 *
 * See https://developers.openai.com/codex/config-reference for the available
 * configuration fields. Project trust and onboarding state are intentionally
 * local and are preserved from the runtime config. Cursor-provided MCP servers
 * are merged in separately at generation time.
 */
export const dotfileConfig = {
  personality: "pragmatic",
  approvals_reviewer: "user",
  model: "gpt-5.6-luna",
  model_reasoning_effort: "xhigh",
  trust_level: "trusted",
  approval_policy: "never",
  sandbox_mode: "danger-full-access",
  tui: {
    vim_mode_default: true,
    // Keep rendered output enabled by default. Toggle raw scrollback during a
    // session with `/raw` or Alt-R when terminal-native selection is needed.
    raw_output_mode: false,
  },
} satisfies TomlTable

export const runtimeConfigPath = (
  env: NodeJS.ProcessEnv = process.env,
): string => {
  const home = env.HOME

  if (!home) {
    throw new Error("HOME is not set")
  }

  return resolve(home, ".codex/config.toml")
}

export const cursorMcpConfigPath = (
  env: NodeJS.ProcessEnv = process.env,
): string => {
  const home = env.HOME

  if (!home) {
    throw new Error("HOME is not set")
  }

  return resolve(home, ".cursor/mcp.json")
}

const isTomlTable = (value: unknown): value is TomlTable =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isTomlValue = (value: unknown): boolean => {
  if (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return true
  }

  if (Array.isArray(value)) {
    return value.every(isTomlValue)
  }

  if (isTomlTable(value)) {
    return Object.values(value).every(isTomlValue)
  }

  return false
}

export const readCursorMcpServers = async (
  path: string,
): Promise<TomlTable> => {
  const file = Bun.file(path)

  if (!(await file.exists())) {
    return {}
  }

  let config: unknown

  try {
    config = JSON.parse(await file.text())
  } catch (error) {
    throw new Error(`Unable to parse Cursor MCP config at ${path}`, {
      cause: error,
    })
  }

  if (!isTomlTable(config)) {
    throw new Error(`${path} must contain a JSON object`)
  }

  if (!("mcpServers" in config)) {
    return {}
  }

  const servers = config.mcpServers

  if (!isTomlTable(servers)) {
    throw new Error(`${path} mcpServers must be an object`)
  }

  for (const [name, server] of Object.entries(servers)) {
    if (!isTomlTable(server) || !isTomlValue(server)) {
      throw new Error(
        `${path} mcpServers.${name} must be a TOML-compatible object`,
      )
    }
  }

  return servers
}

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
  cursorMcpServers: TomlTable = {},
): TomlTable => {
  const merged = mergeTables(runtimeConfig, config)

  if (Object.keys(cursorMcpServers).length === 0) {
    return merged
  }

  const runtimeMcpServers = isTomlTable(merged.mcp_servers)
    ? merged.mcp_servers
    : {}

  return {
    ...merged,
    mcp_servers: { ...runtimeMcpServers, ...cursorMcpServers },
  }
}

const schemaDirective =
  "#:schema https://developers.openai.com/codex/config-schema.json"

const serialize = (config: TomlTable): string =>
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

export const unifiedDiff = (
  beforeText: string,
  afterText: string,
  beforeLabel = "runtime config.toml",
  afterLabel = "generated config.toml",
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

  const beforeEnd = beforeLines.length - suffix
  const afterEnd = afterLines.length - suffix
  const out = [`--- ${beforeLabel}`, `+++ ${afterLabel}`, "@@"]

  for (const line of beforeLines.slice(prefix, beforeEnd)) {
    out.push(`-${line}`)
  }

  for (const line of afterLines.slice(prefix, afterEnd)) {
    out.push(`+${line}`)
  }

  return `${out.join("\n")}\n`
}

export interface ApplyOptions {
  runtimePath?: string
  mcpSourcePath?: string
  dryRun?: boolean
  quiet?: boolean
}

export const applyConfig = async ({
  runtimePath = runtimeConfigPath(),
  mcpSourcePath = cursorMcpConfigPath(),
  dryRun = false,
  quiet = false,
}: ApplyOptions = {}): Promise<boolean> => {
  const { config: runtimeConfig, text: beforeText } =
    await readRuntimeConfig(runtimePath)
  const cursorMcpServers = await readCursorMcpServers(mcpSourcePath)
  const nextConfig = mergeRuntimeConfig(
    runtimeConfig,
    dotfileConfig,
    cursorMcpServers,
  )
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
    process.stdout.write(unifiedDiff(beforeText, nextText))
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
  mcpSource?: string
  print?: boolean
  quiet?: boolean
  run?: boolean
}

const runConfig = async (options: ConfigOptions): Promise<void> => {
  const runtimePath = runtimeConfigPath()
  const mcpSourcePath = options.mcpSource ?? cursorMcpConfigPath()
  const { config: runtimeConfig } = await readRuntimeConfig(runtimePath)
  const cursorMcpServers = await readCursorMcpServers(mcpSourcePath)
  const nextConfig = mergeRuntimeConfig(
    runtimeConfig,
    dotfileConfig,
    cursorMcpServers,
  )

  if (options.print) {
    process.stdout.write(serialize(nextConfig))
    return
  }

  const changed = await applyConfig({
    runtimePath,
    mcpSourcePath,
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
    .option("--print", "print the generated runtime config TOML")
    .option(
      "--mcp-source <path>",
      "read Cursor MCP servers from this JSON file",
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
