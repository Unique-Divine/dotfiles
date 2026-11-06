import { bash } from "@uniquedivine/bash"
import { constants } from "node:fs"
import { access, stat } from "node:fs/promises"
import { isAbsolute, join } from "node:path"

/** A platform name as Herdr manifests spell it. */
export type HerdrPlatform = "linux" | "macos" | "windows"

/** A manifest command with an optional platform restriction. */
export interface PlatformCommand {
  command: string[]
  platforms?: HerdrPlatform[]
}

/** One action or pane entry from `herdr plugin list --json`. */
export interface PluginEntry extends PlatformCommand {
  id: string
}

/** One event hook from `herdr plugin list --json`. */
export interface EventHook extends PlatformCommand {
  on: string
}

/** The plugin fields this check reads from `herdr plugin list --json`. */
export interface HerdrPlugin {
  plugin_id: string
  enabled: boolean
  plugin_root: string
  platforms?: HerdrPlatform[]
  source?: { kind?: string }
  build?: PlatformCommand[]
  startup?: PlatformCommand[]
  actions?: PluginEntry[]
  events?: EventHook[]
  panes?: PluginEntry[]
}

/** A plugin command whose executable Herdr cannot launch. */
export interface MissingExecutable {
  pluginId: string
  kind: "startup" | "action" | "event" | "pane"
  entryId: string
  executable: string
  repair: string
}

export type Environment = Record<string, string | undefined>

/** Parse `herdr plugin list --json` output into its plugin records. */
export function parsePluginList(text: string): HerdrPlugin[] {
  const data = JSON.parse(text) as { result?: { plugins?: unknown } }
  const plugins = data.result?.plugins
  if (!Array.isArray(plugins)) {
    throw new Error("herdr plugin list --json returned no plugins array")
  }
  return plugins as HerdrPlugin[]
}

/**
 * Resolve a plugin program the way Herdr does: a relative path containing a
 * separator runs from the plugin root, an absolute path runs as is, and a bare
 * name is looked up on PATH. Returns undefined when PATH lookup fails.
 */
export function resolveProgram(
  program: string, root: string, env: Environment,
): string | undefined {
  if (isAbsolute(program)) return program
  if (program.includes("/")) return join(root, program)
  return Bun.which(program, { PATH: env.PATH ?? "" }) ?? undefined
}

/** Map a Node platform to Herdr's name, which treats non-Unix as Windows. */
export function herdrPlatform(
  platform: NodeJS.Platform = process.platform,
): HerdrPlatform {
  if (platform === "linux") return "linux"
  if (platform === "darwin") return "macos"
  return "windows"
}

/**
 * Report whether Herdr runs a command on the host: the command's own
 * platforms win, else the plugin's, and no list means every platform.
 */
export function runsOn(
  item: PlatformCommand, plugin: HerdrPlugin, host: HerdrPlatform,
): boolean {
  const platforms = item.platforms ?? plugin.platforms
  return !platforms || platforms.includes(host)
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK)
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/** Describe how to restore a plugin's missing executables. */
export function repairHint(
  plugin: HerdrPlugin, host: HerdrPlatform = herdrPlatform(),
): string {
  const quote = (value: string): string =>
    /^[\w./=-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`
  const build = plugin.build?.filter((step) => runsOn(step, plugin, host))
    .map((step) => step.command.map(quote).join(" "))
  if (plugin.source?.kind === "local" && build?.length) {
    return `cd ${quote(plugin.plugin_root)} && ${build.join(" && ")}`
  }
  if (plugin.source?.kind === "local") {
    return `rebuild the plugin in ${plugin.plugin_root}`
  }
  return `herdr plugin uninstall ${plugin.plugin_id}, then reinstall it`
}

interface LaunchedCommand {
  kind: MissingExecutable["kind"]
  entryId: string
  item: PlatformCommand
}

/** List every command Herdr launches for a plugin, labeled for reports. */
function launchedCommands(plugin: HerdrPlugin): LaunchedCommand[] {
  return [
    ...(plugin.startup ?? []).map((item, index) =>
      ({ kind: "startup" as const, entryId: `#${index + 1}`, item })),
    ...(plugin.actions ?? []).map((item) =>
      ({ kind: "action" as const, entryId: item.id, item })),
    ...(plugin.events ?? []).map((item) =>
      ({ kind: "event" as const, entryId: item.on, item })),
    ...(plugin.panes ?? []).map((item) =>
      ({ kind: "pane" as const, entryId: item.id, item })),
  ]
}

/**
 * List enabled plugin startup hooks, actions, event hooks, and panes that run
 * on the host but whose executable is unavailable.
 */
export async function findMissingExecutables(
  plugins: HerdrPlugin[], env: Environment = process.env,
  host: HerdrPlatform = herdrPlatform(),
): Promise<MissingExecutable[]> {
  const missing: MissingExecutable[] = []
  for (const plugin of plugins) {
    if (!plugin.enabled) continue
    for (const { kind, entryId, item } of launchedCommands(plugin)) {
      if (!runsOn(item, plugin, host)) continue
      const program = item.command[0]
      if (!program) continue
      const resolved = resolveProgram(program, plugin.plugin_root, env)
      if (resolved && await isExecutableFile(resolved)) continue
      missing.push({
        pluginId: plugin.plugin_id, kind, entryId,
        executable: resolved ?? program, repair: repairHint(plugin, host),
      })
    }
  }
  return missing
}

/** Format one problem line per plugin, listing its broken entries. */
export function formatProblems(missing: MissingExecutable[]): string[] {
  const byPlugin = new Map<string, MissingExecutable[]>()
  for (const item of missing) {
    byPlugin.set(item.pluginId, [...(byPlugin.get(item.pluginId) ?? []), item])
  }
  return [...byPlugin.entries()].map(([pluginId, items]) => {
    const executables = [...new Set(items.map((item) => item.executable))]
    const entries = items.map((item) => `${item.kind} ${item.entryId}`)
    return `Herdr plugin ${pluginId} cannot launch ${entries.join(", ")}: ` +
      `missing executable ${executables.join(", ")} ` +
      `(repair: ${items[0]!.repair})`
  })
}

/** Read live plugin registrations and report entries that cannot launch. */
export async function checkPlugins(
  env: Environment = process.env,
): Promise<string[]> {
  const result = await bash("herdr plugin list --json")
  if (result.exitCode !== 0) {
    throw new Error(`herdr plugin list --json failed with exit ${
      result.exitCode}`)
  }
  return formatProblems(
    await findMissingExecutables(parsePluginList(result.stdout), env))
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2)
    if (args.length !== 1 || args[0] !== "--check") {
      throw new Error("Usage: bun run herdr-cfg/plugins.ts --check")
    }
    const problems = await checkPlugins()
    if (problems.length) throw new Error(problems.join("\n"))
    console.log("Herdr plugins: every enabled startup hook, action, " +
      "event hook, and pane can launch")
  } catch (error) {
    console.error(String(error))
    process.exitCode = 1
  }
}
