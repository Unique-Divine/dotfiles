import { resolve } from "node:path"
import { Command } from "commander"
import { parse, type TomlTable } from "smol-toml"

import { serialize } from "../codex/config.ts"
import {
  applyClaudePlan, backupReplacedEntries, claudeConfigPath,
  readClaudeUserMcpServers,
} from "../claude/mcp.ts"
import { cursorMcpConfigPath, readCursorMcpFile, writeCursorFile } from "../cursor/mcp.ts"
import {
  applyJiyuuPins, isLegacyJiyuuLaunch, jiyuuCheckoutDir, jiyuuMcpPins,
  localEnvVar, parseLocalNames, type JiyuuMcpPin,
} from "./pins.ts"
import { describePlan, hasChanges, sameEntry, writePrivateFile, type McpPlan } from "./plan.ts"
import {
  classifyServer, codexConfigPath, defaultLauncherContext, desiredEntries,
  isLauncherEntry, isStringRecord, launcherEntry,
  isRecord, jsonToCodex, transportFields, transportView, type LauncherContext,
  type McpServer, type McpServers,
} from "./servers.ts"

export const platforms = ["codex", "claude", "cursor"] as const
export type Platform = typeof platforms[number]
export type Inventory = Record<Platform, Record<string, unknown>>
export interface UnionPlan {
  codex: McpServers
  targets: Record<"claude" | "cursor", McpPlan>
  warnings: string[]
}

// Inputs are normalized definitions. Launchers are resolved by the reader.
export const planUnion = (
  raw: Inventory,
  definitions: Inventory,
  ctx: LauncherContext,
  from?: Platform,
): UnionPlan => {
  const codex: McpServers = { ...raw.codex } as McpServers
  const targets = {
    claude: { add: [], update: [], remove: [], skip: [] } as McpPlan,
    cursor: { add: [], update: [], remove: [], skip: [] } as McpPlan,
  }
  const warnings: string[] = []
  const names = [...new Set(platforms.flatMap(p => Object.keys(raw[p])))].sort()
  for (const name of names) {
    const available = platforms.filter(p => isRecord(definitions[p][name]))
    if (isRecord(raw.codex[name]) && raw.codex[name].enabled === false) {
      warnings.push(`${name}: disabled in codex; preserved without propagation`)
      continue
    }
    const authority = from && available.includes(from) ? from : available[0]
    if (!authority) continue
    const chosen = definitions[authority][name] as McpServer
    const different = available.filter(p =>
      !sameEntry(transportView(definitions[p][name] as McpServer), transportView(chosen)))
    if (different.length) {
      const fields = [...new Set(available.flatMap(p =>
        Object.keys(transportView(definitions[p][name] as McpServer))))]
        .filter(key => available.some(p => !sameEntry(
          { value: (definitions[p][name] as McpServer)[key] },
          { value: chosen[key] },
        )))
      warnings.push(`${name}: settings differ across ${available.join(", ")} ` +
        `(fields: ${fields.join(", ")}); ${from ? `source ${from} selected where present` : "existing definitions preserved"}`)
    }
    const directional = from !== undefined && available.includes(from)
    if (raw.codex[name] === undefined || (directional && authority !== "codex")) {
      const old = isRecord(raw.codex[name]) ? raw.codex[name] : {}
      codex[name] = {
        ...Object.fromEntries(Object.entries(old).filter(([key]) =>
          !(transportFields as readonly string[]).includes(key))),
        ...transportView(chosen),
      }
    }
    for (const target of ["claude", "cursor"] as const) {
      const existing = raw[target][name]
      if (existing !== undefined && !directional) continue
      if (existing !== undefined && definitions[target][name] === undefined) {
        warnings.push(`${target}/${name}: cannot safely reconcile unsupported entry`)
        continue
      }
      const desired = desiredEntries({ [name]: chosen }, target, ctx)
      targets[target].skip.push(...desired.skip)
      const entry = desired.entries[name]
      if (!entry) continue
      // A launcher reads Codex at runtime. Do not point a differing source
      // definition at a Codex definition we intentionally preserved.
      const normalized = definitions[target][name]
      const executableTransportMatches = !isLauncherEntry(existing) ||
        classifyServer(chosen) === "stdio"
      if (existing !== undefined && executableTransportMatches &&
        isRecord(normalized) &&
        sameEntry(transportView(normalized), transportView(chosen))) continue
      if (existing === undefined) targets[target].add.push({ name, entry })
      else targets[target].update.push({ name, entry, replacesUnmanaged: true })
    }
  }
  return { codex, targets, warnings }
}

/** Env names whose values differ between two definitions, sorted. */
export const differingEnvKeys = (a: unknown, b: unknown): string[] => {
  const envA = isRecord(a) && isStringRecord(a.env) ? a.env : {}
  const envB = isRecord(b) && isStringRecord(b.env) ? b.env : {}
  return [...new Set([...Object.keys(envA), ...Object.keys(envB)])]
    .filter(key => envA[key] !== envB[key]).sort()
}

/** Direct-entry fields a Codex launcher reproduces without loss. */
const migratableFields = new Set(["type", "command", "args", "env"])

/**
 * Replaces direct Claude or Cursor definitions of pinned servers with Codex
 * launchers when they are recognized pre-pin Jiyuu launches. Default sync otherwise preserves them, so a client could keep
 * running a checkout after Codex is pinned. The caller backs up each replaced
 * entry. Returns warnings that name differing env keys, never values.
 */
export const migrateDirectPins = (
  plan: UnionPlan,
  raw: Inventory,
  definitions: Inventory,
  ctx: LauncherContext,
  pins: Record<string, JiyuuMcpPin> = jiyuuMcpPins,
): string[] => {
  const warnings: string[] = []
  for (const [name, pin] of Object.entries(pins)) {
    if (classifyServer(plan.codex[name]) !== "stdio") continue
    // The launcher skips disabled Codex entries, so a migrated client entry
    // would stop starting. Leave the working client definition alone.
    if (plan.codex[name]?.enabled === false) continue
    for (const target of ["claude", "cursor"] as const) {
      const existing = raw[target][name]
      if (existing === undefined || isLauncherEntry(existing)) continue
      if (!isLegacyJiyuuLaunch(existing, pin)) {
        warnings.push(`${target}/${name}: direct entry is not a known Jiyuu ` +
          "checkout launch; preserved. Remove it to use the pinned Codex " +
          "launcher")
        continue
      }
      // The launcher reproduces only command, args, and env from Codex.
      const extra = Object.keys(existing as McpServer)
        .filter(key => !migratableFields.has(key)).sort()
      if (extra.length) {
        warnings.push(`${target}/${name}: Jiyuu checkout launch also sets ` +
          `${extra.join(", ")}, which the Codex launcher can't reproduce; ` +
          "preserved. Move them into the Codex entry or remove the entry")
        continue
      }
      const targetPlan = plan.targets[target]
      targetPlan.update = targetPlan.update.filter(u => u.name !== name)
      targetPlan.add = targetPlan.add.filter(a => a.name !== name)
      targetPlan.update.push({
        name, entry: launcherEntry(name, ctx, target), replacesUnmanaged: true,
      })
      const keys = differingEnvKeys(definitions[target][name] ?? existing,
        plan.codex[name])
      if (keys.length) {
        warnings.push(`${target}/${name}: direct entry replaced by the pinned ` +
          `Codex launcher; env differs (keys: ${keys.join(", ")}); check the ` +
          "backup and move needed values into the Codex entry")
      }
    }
  }
  return warnings
}

/** True when TOML text has comment lines other than the schema directive. */
export const hasTomlComments = (text: string): boolean =>
  text.split("\n").some(line => {
    const trimmed = line.trimStart()
    return trimmed.startsWith("#") && !trimmed.startsWith("#:schema")
  })

const readText = async (path: string): Promise<string> =>
  await Bun.file(path).exists() ? Bun.file(path).text() : ""

export const resolveDefinitions = async (
  raw: Inventory,
  codexPath: string,
): Promise<{ definitions: Inventory; warnings: string[] }> => {
  const definitions: Inventory = { codex: raw.codex, claude: {}, cursor: {} }
  const warnings: string[] = []
  for (const target of ["claude", "cursor"] as const) {
    for (const [name, entry] of Object.entries(raw[target])) {
      if (isLauncherEntry(entry) && isRecord(entry)) {
        const args = entry.args as unknown[]
        const source = args[1] === "--source" && typeof args[2] === "string" ? args[2] : undefined
        const serverName = typeof args[3] === "string" ? args[3] : undefined
        let server: unknown
        if (source && serverName) {
          if (resolve(source) === resolve(codexPath)) server = raw.codex[serverName]
          else {
            try {
              const parsed = parse(await readText(source))
              server = isRecord(parsed.mcp_servers) ? parsed.mcp_servers[serverName] : undefined
            } catch {
              // Never include parser text, which can contain credentials.
            }
          }
        }
        if (isRecord(server)) {
          definitions[target][name] = server
          if (classifyServer(server) !== "stdio") {
            warnings.push(`${target}/${name}: launcher requires a command; ` +
              "use directional sync to repair its transport")
          }
        } else warnings.push(`${target}/${name}: dangling launcher; preserved`)
      } else {
        const mapped = jsonToCodex(entry)
        if (mapped.ok) definitions[target][name] = mapped.entry
        else warnings.push(`${target}/${name}: ${mapped.reason}; preserved`)
      }
    }
  }
  return { definitions, warnings }
}

export const createProgram = (): Command => new Command()
  .description("Union local MCP servers; --from reconciles using one platform")
  .option("--from <platform>", "authoritative source: codex, claude, cursor")
  .option("--run", "apply changes")
  .option("--dry-run", "preview without writing")
  .option("--check", "fail for missing servers; differences are advisory")
  .option("--codex-config <file>", "Codex config", codexConfigPath())
  .option("--claude-config <file>", "Claude user config", claudeConfigPath())
  .option("--cursor-config <file>", "Cursor config", cursorMcpConfigPath())
  .option("--launcher-path <file>", "stable launcher script for exported servers")
  .action(async options => {
    if (options.from && !platforms.includes(options.from)) throw new Error("Invalid --from platform")
    const paths: Record<Platform, string> = {
      codex: resolve(options.codexConfig), claude: resolve(options.claudeConfig),
      cursor: resolve(options.cursorConfig),
    }
    if (options.run && !options.dryRun && !options.check &&
      paths.claude !== resolve(claudeConfigPath())) {
      throw new Error("Claude writes require its user config; set CLAUDE_CONFIG_DIR")
    }
    const before = Object.fromEntries(await Promise.all(platforms.map(async p =>
      [p, await readText(paths[p])])) ) as Record<Platform, string>
    let config: TomlTable
    try { config = before.codex ? parse(before.codex) : {} }
    catch { throw new Error(`Unable to parse Codex config at ${paths.codex}`) }
    if (config.mcp_servers !== undefined && !isRecord(config.mcp_servers)) {
      throw new Error("Codex mcp_servers must be a table")
    }
    const cursor = await readCursorMcpFile(paths.cursor)
    const raw: Inventory = {
      codex: (config.mcp_servers ?? {}) as Record<string, unknown>,
      claude: await readClaudeUserMcpServers(paths.claude), cursor: cursor.servers,
    }
    for (const [name, server] of Object.entries(raw.codex)) {
      if (!isRecord(server)) throw new Error(`Codex server ${name} must be a table`)
    }
    // Jiyuu pins rewrite Codex launch commands before the union, so Claude
    // and Cursor launchers, which read Codex, run the pinned releases too.
    const original = raw.codex
    const pinOptions = {
      local: parseLocalNames(process.env[localEnvVar]),
      jiyuuDir: jiyuuCheckoutDir(process.env),
    }
    const pinned = applyJiyuuPins(original, pinOptions)
    raw.codex = pinned.servers
    for (const warning of pinned.warnings) console.log(`! warning ${warning}`)
    for (const change of pinned.changes) console.log(change)
    const { definitions, warnings } = await resolveDefinitions(raw, paths.codex)
    const ctx = defaultLauncherContext(paths.codex)
    if (options.launcherPath) ctx.launcherPath = resolve(options.launcherPath)
    const plan = planUnion(raw, definitions, ctx, options.from)
    // A directional source can carry an old launch command; pins still win.
    plan.codex = applyJiyuuPins(plan.codex, pinOptions).servers as McpServers
    const migrated = migrateDirectPins(plan, raw, definitions, ctx)
    for (const warning of [...warnings, ...plan.warnings, ...migrated]) console.log(`! warning ${warning}`)
    const codexChanged = !sameEntry(original, plan.codex)
    if (codexChanged) console.log("~ update codex MCP definitions")
    for (const target of ["claude", "cursor"] as const) {
      for (const line of describePlan(plan.targets[target], target)) console.log(`${target}: ${line}`)
    }
    const changed = codexChanged || hasChanges(plan.targets.claude) || hasChanges(plan.targets.cursor)
    if (!changed) console.log("MCP union is current")
    if (options.check) { if (changed) process.exitCode = 1; return }
    if (!options.run || options.dryRun) return
    // Preflight every input before the first write. Each target also gets a
    // fresh check immediately before its write, including between CLI calls.
    const assertUnchanged = async (p: Platform) => {
      if (await readText(paths[p]) !== before[p]) throw new Error(`${p} config changed during sync; rerun it`)
    }
    for (const p of platforms) await assertUnchanged(p)
    if (codexChanged) {
      const next = serialize({ ...config, mcp_servers: plan.codex as TomlTable })
      // The rewrite drops comments and formatting, so keep the original.
      if (before.codex && next !== before.codex) {
        const backup = `${paths.codex}.before-mcp-sync-${Date.now()}`
        await writePrivateFile(backup, before.codex)
        console.log(`Saved previous Codex config to ${backup}`)
        if (hasTomlComments(before.codex)) {
          console.log(`! warning codex: comments in ${paths.codex} were not ` +
            `preserved; they remain in ${backup}`)
        }
      }
      await writePrivateFile(paths.codex, next)
    }
    if (hasChanges(plan.targets.cursor)) {
      await assertUnchanged("cursor")
      const backup = await writeCursorFile(paths.cursor, cursor, plan.targets.cursor, plan.codex)
      if (backup) console.log(`Saved previous Cursor file to ${backup}`)
    }
    if (hasChanges(plan.targets.claude)) {
      await assertUnchanged("claude")
      const backup = await backupReplacedEntries(plan.targets.claude, raw.claude, plan.codex, paths.claude, resolve(paths.claude, "../mcp-sync-state.json"))
      if (backup) console.log(`Saved previous Claude entries to ${backup}`)
      await applyClaudePlan(plan.targets.claude, raw.claude, "claude",
        async (name, expected) => {
          const latest = await readClaudeUserMcpServers(paths.claude)
          if (expected === undefined ? latest[name] !== undefined :
            !isRecord(expected) || !sameEntry(latest[name], expected)) {
            throw new Error(`claude/${name} changed during sync; rerun it`)
          }
        })
    }
  })

if (import.meta.main) {
  try { await createProgram().parseAsync() }
  catch (error) {
    console.error(error instanceof Error ? error.message : "MCP sync failed")
    process.exitCode = 1
  }
}
