import { writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { Command } from "commander"

import {
  applyWithManagedState, describePlan, hasChanges, managedNames,
  managedStatePath, planSync, readManagedState, writePrivateFile,
  type McpPlan,
} from "../mcp/plan.ts"
import {
  codexConfigPath, defaultLauncherContext, desiredEntries, isRecord,
  readCodexMcpServers,
} from "../mcp/servers.ts"

/**
 * Syncs Codex MCP servers into the Cursor CLI's `$HOME/.cursor/mcp.json`.
 *
 * Stdio servers become launcher entries with no `env`; url servers are
 * copied. Entries this sync does not own are kept. Cursor does not rewrite
 * this file while it runs, so the script edits it directly with an atomic,
 * private replacement and a timestamped backup before replacing user entries.
 */

export const cursorMcpConfigPath = (
  env: NodeJS.ProcessEnv = process.env,
): string => {
  if (!env.HOME) {
    throw new Error("HOME is not set")
  }

  return resolve(env.HOME, ".cursor/mcp.json")
}

export interface CursorMcpFile {
  config: Record<string, unknown>
  servers: Record<string, unknown>
  text: string
}

export const readCursorMcpFile = async (
  path: string,
): Promise<CursorMcpFile> => {
  const file = Bun.file(path)

  if (!(await file.exists())) {
    return { config: {}, servers: {}, text: "" }
  }

  const text = await file.text()

  if (text.trim() === "") {
    return { config: {}, servers: {}, text }
  }

  let config: unknown

  try {
    config = JSON.parse(text)
  } catch (error) {
    throw new Error(`Unable to parse Cursor MCP config at ${path}`, {
      cause: error,
    })
  }

  if (!isRecord(config)) {
    throw new Error(`${path} must contain a JSON object`)
  }

  const servers = config.mcpServers ?? {}

  if (!isRecord(servers)) {
    throw new Error(`${path} mcpServers must be an object`)
  }

  return { config, servers, text }
}

/** Applies a plan to the parsed file, keeping every other key. */
export const applyPlan = (
  config: Record<string, unknown>,
  servers: Record<string, unknown>,
  plan: McpPlan,
): Record<string, unknown> => {
  const next = { ...servers }

  for (const name of plan.remove) delete next[name]
  for (const { name, entry } of [...plan.update, ...plan.add]) {
    next[name] = entry
  }

  return { ...config, mcpServers: next }
}

const writeCursorFile = async (
  path: string,
  before: CursorMcpFile,
  plan: McpPlan,
): Promise<void> => {
  const latest = await readCursorMcpFile(path)

  if (latest.text !== before.text) {
    throw new Error(`${path} changed during sync; rerun it`)
  }

  if (before.text && plan.update.some((u) => u.replacesUnmanaged)) {
    // The old file can hold tokens, so the backup is private too.
    await writeFile(`${path}.before-dotfiles-${Date.now()}`, before.text, {
      mode: 0o600, flag: "wx",
    })
  }

  const next = applyPlan(before.config, before.servers, plan)
  await writePrivateFile(path, `${JSON.stringify(next, null, 2)}\n`)
}

interface McpOptions {
  check?: boolean
  cursorConfig?: string
  dryRun?: boolean
  mcpSource?: string
  print?: boolean
  quiet?: boolean
  run?: boolean
  state?: string
}

export const createProgram = (): Command => {
  const program = new Command()

  program
    .name("cursor-mcp")
    .description(
      "Write Codex MCP servers to the Cursor CLI's ~/.cursor/mcp.json. " +
        "Stdio servers run through a launcher that keeps env in Codex.",
    )
    .option("--run", "write the Cursor MCP config if it differs")
    .option("--dry-run", "print the plan without changing anything")
    .option("--check", "exit with code 1 if the plan has changes")
    .option("--print", "print the generated Cursor entries as JSON")
    .option("--mcp-source <path>", "read MCP servers from this Codex config")
    .option("--cursor-config <path>", "Cursor MCP JSON file to sync")
    .option("--state <path>", "managed url server state file")
    .option("--quiet", "suppress normal output with --run")
    .action(async (options: McpOptions) => {
      const hasAction =
        options.run || options.dryRun || options.check || options.print

      if (!hasAction) {
        program.outputHelp()
        return
      }

      const ctx = defaultLauncherContext(
        options.mcpSource ?? codexConfigPath(),
      )
      const codexServers = await readCodexMcpServers(ctx.sourcePath)
      const desired = desiredEntries(codexServers, "cursor", ctx)

      if (options.print) {
        process.stdout.write(`${JSON.stringify(desired.entries, null, 2)}\n`)
        return
      }

      const targetPath = resolve(options.cursorConfig ?? cursorMcpConfigPath())
      const statePath = options.state ?? managedStatePath()
      const current = await readCursorMcpFile(targetPath)
      const managed = managedNames(
        await readManagedState(statePath),
        targetPath,
      )
      const plan = planSync(desired, current.servers, managed)

      if (!options.quiet || !options.run) {
        console.log(hasChanges(plan)
          ? "Cursor CLI MCP servers differ from the Codex config:"
          : "Cursor CLI MCP servers are already current")

        for (const line of describePlan(plan, "Cursor")) console.log(line)
      }

      if (options.check) {
        if (hasChanges(plan)) process.exitCode = 1
        return
      }

      if (options.run && !options.dryRun) {
        await applyWithManagedState({
          statePath,
          targetPath,
          desired,
          plan,
          apply: () => writeCursorFile(targetPath, current, plan),
        })
      }
    })

  return program
}

if (import.meta.main) {
  await createProgram().parseAsync()
}
