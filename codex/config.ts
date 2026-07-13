import { mkdir, rename, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { Command } from "commander"
import { parse, stringify, type TomlTable } from "smol-toml"

/**
 * Portable Codex defaults maintained by this dotfiles repository.
 *
 * See https://developers.openai.com/codex/config-reference for the available
 * configuration fields. Project trust, MCP servers, and onboarding state are
 * intentionally local and are preserved from the runtime config.
 */
export const dotfileConfig = {
  personality: "pragmatic",
  approvals_reviewer: "user",
  model: "gpt-5.6-terra",
  model_reasoning_effort: "medium",
  trust_level: "trusted",
  approval_policy: "never",
  sandbox_mode: "danger-full-access",
  tui: {
    vim_mode_default: true,
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
): TomlTable => mergeTables(runtimeConfig, config)

const serialize = (config: TomlTable): string => `${stringify(config)}\n`

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

interface ApplyOptions {
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
  const nextConfig = mergeRuntimeConfig(runtimeConfig)
  const currentText = serialize(runtimeConfig)
  const afterText = serialize(nextConfig)

  if (currentText === afterText) {
    if (!quiet) {
      console.log(`Codex runtime config is already current: ${runtimePath}`)
    }

    return false
  }

  if (!quiet) {
    console.log(`Codex runtime config differs: ${runtimePath}`)
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
  const nextConfig = mergeRuntimeConfig(runtimeConfig)

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
    .option("--print", "print the generated runtime config TOML")
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
