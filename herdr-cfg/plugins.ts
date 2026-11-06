import { bash } from "@uniquedivine/bash"
import { constants } from "node:fs"
import { access, stat } from "node:fs/promises"
import { isAbsolute, join } from "node:path"

/** One action or pane entry from `herdr plugin list --json`. */
export interface PluginEntry {
  id: string
  command: string[]
}

/** The plugin fields this check reads from `herdr plugin list --json`. */
export interface HerdrPlugin {
  plugin_id: string
  enabled: boolean
  plugin_root: string
  source?: { kind?: string }
  build?: { command: string[] }[]
  actions?: PluginEntry[]
  panes?: PluginEntry[]
}

/** A plugin entry whose executable Herdr cannot launch. */
export interface MissingExecutable {
  pluginId: string
  kind: "action" | "pane"
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

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK)
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/** Describe how to restore a plugin's missing executables. */
export function repairHint(plugin: HerdrPlugin): string {
  const quote = (value: string): string =>
    /^[\w./=-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`
  const build = plugin.build?.map((step) => step.command.map(quote).join(" "))
  if (plugin.source?.kind === "local" && build?.length) {
    return `cd ${quote(plugin.plugin_root)} && ${build.join(" && ")}`
  }
  if (plugin.source?.kind === "local") {
    return `rebuild the plugin in ${plugin.plugin_root}`
  }
  return `herdr plugin uninstall ${plugin.plugin_id}, then reinstall it`
}

/** List enabled plugin actions and panes whose executable is unavailable. */
export async function findMissingExecutables(
  plugins: HerdrPlugin[], env: Environment = process.env,
): Promise<MissingExecutable[]> {
  const missing: MissingExecutable[] = []
  for (const plugin of plugins) {
    if (!plugin.enabled) continue
    const entries = [
      ...(plugin.actions ?? []).map((entry) => ({ kind: "action", entry })),
      ...(plugin.panes ?? []).map((entry) => ({ kind: "pane", entry })),
    ] as { kind: MissingExecutable["kind"], entry: PluginEntry }[]
    for (const { kind, entry } of entries) {
      const program = entry.command[0]
      if (!program) continue
      const resolved = resolveProgram(program, plugin.plugin_root, env)
      if (resolved && await isExecutableFile(resolved)) continue
      missing.push({
        pluginId: plugin.plugin_id, kind, entryId: entry.id,
        executable: resolved ?? program, repair: repairHint(plugin),
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
    console.log("Herdr plugins: every enabled action and pane can launch")
  } catch (error) {
    console.error(String(error))
    process.exitCode = 1
  }
}
