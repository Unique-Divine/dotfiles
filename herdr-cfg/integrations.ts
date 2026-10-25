import { bash } from "@uniquedivine/bash"
import { parse } from "smol-toml"
import { access, mkdir, readFile, writeFile } from "node:fs/promises"
import { constants } from "node:fs"
import { join, resolve } from "node:path"

import { stringify } from "../claude/settings"

export interface Harness {
  name: string
  commands: string[]
  homeVariable: string
  directory: string
  script: string
  config: string
  event: string
}

export const harnesses: Harness[] = [
  { name: "codex", commands: ["codex"], homeVariable: "CODEX_HOME",
    directory: ".codex", script: "herdr-agent-state.sh",
    config: "hooks.json", event: "SessionStart" },
  { name: "claude", commands: ["claude"], homeVariable: "CLAUDE_CONFIG_DIR",
    directory: ".claude", script: "hooks/herdr-agent-state.sh",
    config: "settings.json", event: "SessionStart" },
  { name: "cursor", commands: ["cursor-agent", "agent"],
    homeVariable: "CURSOR_CONFIG_DIR", directory: ".cursor",
    script: "herdr-agent-state.sh", config: "hooks.json",
    event: "sessionStart" },
]

export type Environment = Record<string, string | undefined>
type JsonObject = Record<string, unknown>
const quote = (value: string): string =>
  `'${value.replaceAll("'", "'\"'\"'")}'`

export function configDirectory(
  harness: Harness, env: Environment,
): string {
  if (!env.HOME) throw new Error("HOME is required")
  const value = env[harness.homeVariable] || join(env.HOME, harness.directory)
  return resolve(value.startsWith("~")
    ? join(env.HOME, value.slice(1)) : value)
}

export function missingTools(env: Environment): string[] {
  return [["herdr"], ...harnesses.map((harness) => harness.commands)]
    .filter((commands) => !commands.some((name) =>
      Bun.which(name, { PATH: env.PATH ?? "" })))
    .map((commands) => commands.join(" or "))
}

async function run(args: string[], env: Environment): Promise<string> {
  const keys = ["HOME", "PATH", ...harnesses.map((h) => h.homeVariable)]
  const unset = keys.flatMap((key) => ["-u", key])
  const values = keys.filter((key) => env[key] !== undefined)
    .map((key) => `${key}=${env[key]}`)
  const command = ["env", ...unset, ...values, ...args]
    .map(quote).join(" ")
  const result = await bash(`${command} 2>&1`)
  if (result.exitCode !== 0) {
    throw new Error(result.stdout.trim() || result.stderr.trim() ||
      `${args[0]} failed with exit ${result.exitCode}`)
  }
  return result.stdout
}

async function optionalText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as JsonObject
}

export async function readConfig(
  harness: Harness, env: Environment,
): Promise<JsonObject | undefined> {
  const path = join(configDirectory(harness, env), harness.config)
  const text = await optionalText(path)
  if (text === undefined) return undefined
  const config = object(JSON.parse(text), path)
  if (config.hooks !== undefined) {
    const hooks = object(config.hooks, `${path}: hooks`)
    for (const [event, entries] of Object.entries(hooks)) {
      if (!Array.isArray(entries)) {
        throw new Error(`${path}: hooks.${event} must be an array`)
      }
    }
  }
  return config
}

export function registered(
  harness: Harness, config: JsonObject, script: string,
): boolean {
  if (config.disableAllHooks === true) return false
  if (harness.name === "cursor" && config.version !== 1) return false
  const hooks = config.hooks as JsonObject | undefined
  const entries = hooks?.[harness.event]
  if (!Array.isArray(entries)) return false
  const expected = `bash ${quote(script)} session`
  return entries.some((entry: unknown) => {
    if (!entry || typeof entry !== "object") return false
    const value = entry as JsonObject
    if (harness.name === "cursor") return value.command === expected
    // Claude's matcher must include startup as well as resume events.
    if (harness.name === "claude" && value.matcher !== undefined) {
      if (typeof value.matcher !== "string") return false
      try {
        const matcher = new RegExp(value.matcher)
        if (!["startup", "resume"].every((source) => matcher.test(source))) {
          return false
        }
      } catch { return false }
    }
    return Array.isArray(value.hooks) && value.hooks.some((hook: unknown) => {
      if (!hook || typeof hook !== "object") return false
      const command = hook as JsonObject
      return command.type === "command" && command.command === expected
    })
  })
}

async function codexEnabled(env: Environment): Promise<boolean> {
  const path = join(configDirectory(harnesses[0]!, env), "config.toml")
  const text = await optionalText(path)
  if (text === undefined) return false
  const config = parse(text) as JsonObject
  const features = config.features as JsonObject | undefined
  const profiles = config.profiles as Record<string, JsonObject> | undefined
  const profile = typeof config.profile === "string"
    ? profiles?.[config.profile] : undefined
  const overrides = profile?.features as JsonObject | undefined
  return features?.hooks === true && overrides?.hooks !== false
}

export async function checkIntegrations(
  env: Environment = process.env,
): Promise<string[]> {
  const problems = missingTools(env).map((tool) =>
    `Missing required CLI: ${tool}. Install it and rerun just sync.`)
  const hasHerdr = !!Bun.which("herdr", { PATH: env.PATH ?? "" })
  let status = ""
  if (hasHerdr) {
    try { status = await run(["herdr", "integration", "status"], env) }
    catch (error) { problems.push(String(error)) }
  }
  for (const harness of harnesses) {
    try {
      const directory = configDirectory(harness, env)
      const script = join(directory, harness.script)
      const config = await readConfig(harness, env)
      if (!new RegExp(`^${harness.name}: current \\(v\\d+\\) \\(`, "m")
        .test(status)) throw new Error("hook is missing or not current")
      await access(script, constants.R_OK)
      await run(["bash", "-n", script], env)
      if (!config || !registered(harness, config, script)) {
        throw new Error("session-start hook is not correctly registered")
      }
      if (harness.name === "codex" && !await codexEnabled(env)) {
        throw new Error("Codex features.hooks must be enabled, including profile")
      }
    } catch (error) {
      problems.push(`${harness.name}: ${String(error)}. ` +
        "Repair: just herdr-integrations")
    }
  }
  return problems
}

export async function installIntegrations(
  env: Environment = process.env,
): Promise<void> {
  const missing = missingTools(env)
  if (missing.length) throw new Error(`Missing required CLI: ${missing.join(", ")}`)
  // Parse every configuration before any installer can write to it.
  for (const harness of harnesses) await readConfig(harness, env)
  await codexEnabled(env)
  for (const harness of harnesses) {
    await mkdir(configDirectory(harness, env), { recursive: true })
    await run(["herdr", "integration", "install", harness.name], env)
    if (harness.name === "claude") {
      // Herdr rewrites JSON without our settings sync's trailing newline.
      // Normalize formatting so health does not report false settings drift.
      const config = await readConfig(harness, env)
      if (config) {
        const path = join(configDirectory(harness, env), harness.config)
        const formatted = stringify(config as Parameters<typeof stringify>[0])
        if (await readFile(path, "utf8") !== formatted) {
          await writeFile(path, formatted)
        }
      }
    }
  }
  const problems = await checkIntegrations(env)
  if (problems.length) throw new Error(problems.join("\n"))
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2)
    if (args.length !== 1 || !["--run", "--check"].includes(args[0]!)) {
      throw new Error("Usage: bun run herdr-cfg/integrations.ts --run|--check")
    }
    if (args[0] === "--run") await installIntegrations()
    const problems = await checkIntegrations()
    if (problems.length) throw new Error(problems.join("\n"))
    console.log("Herdr integrations: Codex, Claude Code, Cursor are current")
  } catch (error) {
    console.error(String(error))
    process.exitCode = 1
  }
}
