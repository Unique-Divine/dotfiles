import { Command } from "commander"

import {
  applyWithManagedState, describePlan, hasChanges, managedNames,
  managedStatePath, planSync, readManagedState, type McpPlan,
} from "../mcp/plan.ts"
import {
  codexConfigPath, defaultLauncherContext, desiredEntries, isRecord,
  readCodexMcpServers, type LauncherContext, type McpServer, type McpServers,
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

/** `claude` CLI invocations that apply a plan, in order. */
export const planCommands = (
  plan: McpPlan,
  claudeBin = "claude",
): string[][] => {
  const remove = (name: string) =>
    [claudeBin, "mcp", "remove", "--scope", "user", name]
  const add = (name: string, entry: McpServer) => [
    claudeBin, "mcp", "add-json", "--scope", "user", name,
    JSON.stringify(entry),
  ]

  return [
    ...plan.remove.map(remove),
    ...plan.update.flatMap(({ name, entry }) => [remove(name), add(name, entry)]),
    ...plan.add.map(({ name, entry }) => add(name, entry)),
  ]
}

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

const runCommands = async (commands: string[][]): Promise<void> => {
  for (const cmd of commands) {
    // Argument vectors avoid shell quoting of the JSON payload.
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" })
    const [exitCode, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
    ])

    if (exitCode !== 0) {
      // Name the verb and server, not the add-json payload with url headers.
      throw new Error(
        `${cmd.slice(0, 3).join(" ")} ${cmd[5]} failed (${exitCode}): ` +
          stderr.trim(),
      )
    }
  }
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
    .option("--print", "print the generated Claude entries as JSON")
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
          apply: () => runCommands(planCommands(plan)),
        })
      }
    })

  return program
}

if (import.meta.main) {
  await createProgram().parseAsync()
}
