import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { Command } from "commander"

import {
  applyWithManagedState, describePlan, hasChanges, managedNames,
  managedStatePath, planSync, readManagedState, type McpPlan,
} from "../mcp/plan.ts"
import {
  codexConfigPath, defaultLauncherContext, desiredEntries, isRecord,
  readCodexMcpServers, type LauncherContext, type McpServers,
} from "../mcp/servers.ts"
import { readJsonObject, runtimeStatePath } from "./config.ts"

/**
 * Syncs Codex MCP servers into Claude Code's user scope.
 *
 * Each Codex stdio server becomes a Claude entry that runs `mcp-launch.ts`,
 * which reads the server definition from the Codex config at startup. Those
 * entries hold no `env`, so stdio secrets stay in `$HOME/.codex/config.toml`.
 * Url servers are copied with their headers.
 *
 * Writes go through `claude mcp add-json` and `claude mcp remove` because
 * Claude Code rewrites `$HOME/.claude.json` on its own; editing that file
 * directly could race with a running session.
 */

export const claudeConfigPath = runtimeStatePath

export const planMcpSync = (
  codexServers: McpServers,
  claudeServers: Record<string, unknown>,
  ctx: LauncherContext,
  managedUrlNames: ReadonlySet<string> = new Set(),
): McpPlan =>
  planSync(
    desiredEntries(codexServers, "claude", ctx),
    claudeServers,
    managedUrlNames,
  )

export const readClaudeUserMcpServers = async (
  path: string,
): Promise<Record<string, unknown>> => {
  const { config } = await readJsonObject(path)
  const servers = config.mcpServers ?? {}

  if (!isRecord(servers)) {
    throw new Error(`${path} mcpServers must be an object`)
  }

  return servers
}

/** Runs one `claude` command. Errors never include an add-json payload. */
const runClaude = async (cmd: string[]): Promise<void> => {
  // Argument vectors avoid shell quoting of the JSON payload.
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" })
  const [exitCode, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
  ])

  if (exitCode !== 0) {
    const label = `${cmd.slice(0, 3).join(" ")} ${cmd[5]}`
    // The CLI may echo an add-json payload, which can hold url headers.
    const detail = cmd[2] === "add-json" ? "" : `: ${stderr.trim()}`
    throw new Error(`${label} failed (${exitCode})${detail}`)
  }
}

/**
 * Saves the Claude entries a plan replaces but does not own, as private JSON
 * beside the managed-state file. Returns the backup path, if one was written.
 */
export const backupReplacedEntries = async (
  plan: McpPlan,
  current: Record<string, unknown>,
  targetPath: string,
  statePath: string,
): Promise<string | undefined> => {
  const replaced = plan.update.filter((u) => u.replacesUnmanaged)

  if (replaced.length === 0) return undefined

  const path = resolve(
    dirname(statePath),
    `claude-mcp-before-dotfiles-${Date.now()}.json`,
  )
  const mcpServers = Object.fromEntries(
    replaced.map(({ name }) => [name, current[name]]),
  )
  await mkdir(dirname(path), { recursive: true })
  await writeFile(
    path,
    `${JSON.stringify({ targetPath, mcpServers }, null, 2)}\n`,
    { mode: 0o600, flag: "wx" },
  )

  return path
}

/**
 * Applies a plan through the `claude` CLI. An update removes and re-adds the
 * entry; if the add fails, the previous entry is restored before throwing.
 */
export const applyClaudePlan = async (
  plan: McpPlan,
  current: Record<string, unknown>,
  claudeBin = "claude",
): Promise<void> => {
  const remove = (name: string) =>
    runClaude([claudeBin, "mcp", "remove", "--scope", "user", name])
  const add = (name: string, entry: unknown) => runClaude([
    claudeBin, "mcp", "add-json", "--scope", "user", name,
    JSON.stringify(entry),
  ])

  for (const name of plan.remove) await remove(name)

  for (const { name, entry } of plan.update) {
    await remove(name)

    try {
      await add(name, entry)
    } catch (error) {
      await add(name, current[name]).catch(() => undefined)
      throw error
    }
  }

  for (const { name, entry } of plan.add) await add(name, entry)
}

interface McpOptions {
  check?: boolean
  claudeConfig?: string
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
    .name("claude-mcp")
    .description(
      "Register Codex MCP servers in Claude Code's user scope. Stdio " +
        "servers run through a launcher that keeps env in the Codex config.",
    )
    .option("--run", "apply the plan with the claude CLI")
    .option("--dry-run", "print the plan without changing anything")
    .option("--check", "exit with code 1 if the plan has changes")
    .option(
      "--print",
      "print the generated Claude entries, including url header values",
    )
    .option("--mcp-source <path>", "read MCP servers from this Codex config")
    .option(
      "--claude-config <path>",
      "read current Claude user servers from this JSON file",
    )
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
      const desired = desiredEntries(codexServers, "claude", ctx)

      if (options.print) {
        process.stdout.write(`${JSON.stringify(desired.entries, null, 2)}\n`)
        return
      }

      if (options.run && options.claudeConfig &&
        resolve(options.claudeConfig) !== resolve(claudeConfigPath())) {
        // --run writes through the claude CLI, which uses its own config.
        throw new Error("--claude-config with --run must be the file the " +
          "claude CLI uses; set CLAUDE_CONFIG_DIR for another profile")
      }

      const targetPath = options.claudeConfig ?? claudeConfigPath()
      const statePath = options.state ?? managedStatePath()
      const claudeServers = await readClaudeUserMcpServers(targetPath)
      const managed = managedNames(
        await readManagedState(statePath),
        targetPath,
      )
      const plan = planSync(desired, claudeServers, managed)

      if (!options.quiet || !options.run) {
        console.log(hasChanges(plan)
          ? "Claude Code MCP servers differ from the Codex config:"
          : "Claude Code MCP servers are already current")

        for (const line of describePlan(plan, "Claude")) console.log(line)
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
          apply: async () => {
            const backup = await backupReplacedEntries(
              plan, claudeServers, targetPath, statePath,
            )

            if (backup && !options.quiet) {
              console.log(`Saved replaced Claude entries to ${backup}`)
            }

            await applyClaudePlan(plan, claudeServers)
          },
        })
      }
    })

  return program
}

if (import.meta.main) {
  await createProgram().parseAsync()
}
