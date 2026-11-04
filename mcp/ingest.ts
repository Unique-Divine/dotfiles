import { resolve } from "node:path"
import { Command } from "commander"
import { parse, type TomlTable } from "smol-toml"

import { serialize } from "../codex/config.ts"
import { changedKeyPaths, formatKeyChanges } from "../configDiff.ts"
import { readClaudeUserMcpServers, claudeConfigPath } from "../claude/mcp.ts"
import { cursorMcpConfigPath, readCursorMcpFile } from "../cursor/mcp.ts"
import { sameEntry, writePrivateFile } from "./plan.ts"
import {
  codexConfigPath, isLauncherEntry, isRecord, jsonToCodex, transportFields,
  transportView, type McpServer,
} from "./servers.ts"

/**
 * Copies MCP servers that exist only in Claude Code or the Cursor CLI into
 * `$HOME/.codex/config.toml`, so the normal export can manage them.
 *
 * Launcher entries already come from Codex and are ignored. A name that Codex
 * already has is a clash: it is reported and left alone unless `--force`
 * replaces its transport fields. Output names servers and key paths only.
 */

export type IngestSource = "claude" | "cursor"

export interface IngestPlan {
  add: { name: string; server: McpServer }[]
  replace: { name: string; server: McpServer }[]
  clash: { name: string; reason: string }[]
  skip: { name: string; reason: string }[]
}

export const planIngest = (
  sourceServers: Record<string, unknown>,
  codexServers: Record<string, unknown>,
  force = false,
): IngestPlan => {
  const plan: IngestPlan = { add: [], replace: [], clash: [], skip: [] }

  for (const name of Object.keys(sourceServers).sort()) {
    const entry = sourceServers[name]

    if (isLauncherEntry(entry)) continue

    const mapped = jsonToCodex(entry)

    const existing = codexServers[name]

    if (!mapped.ok) {
      if (existing === undefined) {
        plan.skip.push({ name, reason: mapped.reason })
      } else {
        // Codex holds the name, so the export would replace this entry.
        plan.clash.push({
          name,
          reason: `cannot ingest (${mapped.reason}); rename it or move it ` +
            "to Codex by hand",
        })
      }
      continue
    }

    if (existing === undefined) {
      plan.add.push({ name, server: mapped.entry })
    } else if (!isRecord(existing) ||
      !sameEntry(transportView(existing), mapped.entry)) {
      if (force) {
        plan.replace.push({ name, server: mapped.entry })
      } else {
        plan.clash.push({
          name,
          reason: "differs from Codex; --force replaces it",
        })
      }
    }
  }

  return plan
}

export const ingestHasChanges = (plan: IngestPlan): boolean =>
  plan.add.length + plan.replace.length > 0

/** Returns the Codex config with planned servers written in. */
export const applyIngest = (
  config: TomlTable,
  plan: IngestPlan,
): TomlTable => {
  const servers: TomlTable = isRecord(config.mcp_servers)
    ? { ...(config.mcp_servers as TomlTable) }
    : {}

  for (const { name, server } of plan.add) {
    servers[name] = server as TomlTable
  }

  for (const { name, server } of plan.replace) {
    const existing = isRecord(servers[name]) ? servers[name] as TomlTable : {}
    const kept = Object.fromEntries(Object.entries(existing).filter(
      ([key]) => !(transportFields as readonly string[]).includes(key),
    )) as TomlTable
    servers[name] = { ...kept, ...(server as TomlTable) }
  }

  return { ...config, mcp_servers: servers }
}

export const describeIngest = (plan: IngestPlan): string[] => [
  ...plan.add.map(({ name }) => `+ add ${name}`),
  ...plan.replace.map(({ name }) => `~ replace ${name}`),
  ...plan.clash.map(({ name, reason }) => `! clash ${name}: ${reason}`),
  ...plan.skip.map(({ name, reason }) => `! skip ${name}: ${reason}`),
]

const readSourceServers = async (
  source: IngestSource,
  path: string,
): Promise<Record<string, unknown>> =>
  source === "claude"
    ? readClaudeUserMcpServers(path)
    : (await readCursorMcpFile(path)).servers

const readCodexFile = async (
  path: string,
): Promise<{ config: TomlTable; text: string }> => {
  const file = Bun.file(path)

  if (!(await file.exists())) return { config: {}, text: "" }

  const text = await file.text()

  try {
    return { config: parse(text), text }
  } catch (error) {
    throw new Error(`Unable to parse Codex config at ${path}`, {
      cause: error,
    })
  }
}

interface IngestOptions {
  check?: boolean
  codexConfig?: string
  dryRun?: boolean
  force?: boolean
  from: string
  path?: string
  quiet?: boolean
  run?: boolean
}

export const createProgram = (): Command => {
  const program = new Command()

  program
    .name("mcp-ingest")
    .description(
      "Copy MCP servers that only Claude Code or the Cursor CLI has into " +
        "~/.codex/config.toml. Run just sync afterward to export them. " +
        "Exits 1 when a same-named Codex server differs, unless --force.",
    )
    .requiredOption("--from <tool>", "source tool: claude or cursor")
    .option("--path <file>", "source config file (default: the tool's)")
    .option("--codex-config <file>", "Codex config to write")
    .option("--force", "replace Codex servers whose definition differs")
    .option("--run", "write the Codex config if it changes")
    .option("--dry-run", "print the plan without writing")
    .option("--check", "exit with code 1 if the plan has changes")
    .option("--quiet", "suppress normal output with --run")
    .action(async (options: IngestOptions) => {
      if (options.from !== "claude" && options.from !== "cursor") {
        throw new Error("--from must be claude or cursor")
      }

      const source: IngestSource = options.from
      const sourcePath = options.path ??
        (source === "claude" ? claudeConfigPath() : cursorMcpConfigPath())
      const codexPath = resolve(options.codexConfig ?? codexConfigPath())
      const sourceServers = await readSourceServers(source, sourcePath)
      const codex = await readCodexFile(codexPath)
      const codexServers = isRecord(codex.config.mcp_servers)
        ? codex.config.mcp_servers
        : {}
      const plan = planIngest(sourceServers, codexServers, options.force)
      const next = applyIngest(codex.config, plan)

      if (!options.quiet || !options.run) {
        console.log(ingestHasChanges(plan)
          ? `Servers to copy from ${source} into ${codexPath}:`
          : `Codex already has every ${source} server it can hold`)

        for (const line of describeIngest(plan)) console.log(line)

        if (ingestHasChanges(plan)) {
          // Key paths only: the new servers can carry tokens.
          process.stdout.write(formatKeyChanges(changedKeyPaths(
            { mcp_servers: codexServers },
            { mcp_servers: next.mcp_servers as TomlTable },
          )))
        }
      }

      if (options.check) {
        if (ingestHasChanges(plan)) process.exitCode = 1
        return
      }

      if (options.run && !options.dryRun && ingestHasChanges(plan)) {
        if ((await readCodexFile(codexPath)).text !== codex.text) {
          throw new Error(`${codexPath} changed during ingest; rerun it`)
        }

        await writePrivateFile(codexPath, serialize(next))
      }

      if (plan.clash.length > 0) {
        // Fail so `just mcp-ingest` stops before an export overwrites the
        // clashing entries in the source tool.
        console.error(`${plan.clash.length} clashing server(s) were not ` +
          "ingested. See the ! clash lines above.")
        process.exitCode = 1
      }
    })

  return program
}

if (import.meta.main) {
  await createProgram().parseAsync()
}
