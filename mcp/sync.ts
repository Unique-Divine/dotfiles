import { existsSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"
import { Command } from "commander"
import { parse, type TomlTable } from "smol-toml"

import { serialize } from "../codex/config.ts"
import {
  applyClaudePlan, backupReplacedEntries, claudeConfigPath,
  readClaudeUserMcpServers,
} from "../claude/mcp.ts"
import { cursorMcpConfigPath, readCursorMcpFile, writeCursorFile } from "../cursor/mcp.ts"
import {
  discordClientTokens, discordDefinition, discordPaths, discordServer,
  discordToken, lockDiscord, prepareDiscordCredential, startDiscord, stopDiscord,
  type DiscordMode,
} from "./discord.ts"
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
  selected?: string[],
): UnionPlan => {
  const codex: McpServers = { ...raw.codex } as McpServers
  const targets = {
    claude: { add: [], update: [], remove: [], skip: [] } as McpPlan,
    cursor: { add: [], update: [], remove: [], skip: [] } as McpPlan,
  }
  const warnings: string[] = []
  const names = selected ??
    [...new Set(platforms.flatMap(p => Object.keys(raw[p])))].sort()
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

/** Version of the `--export` payload that `--import` accepts. */
export const transferVersion = 1

export interface TransferPayload {
  version: typeof transferVersion
  mcp_servers: Record<string, McpServer>
}

/** Parses `--servers a,b` into names; undefined means every server. */
export const parseServerNames = (value: string | undefined): string[] | undefined => {
  if (value === undefined) return undefined
  const names = value.split(",").map(name => name.trim()).filter(name => name !== "")
  return [...new Set(names)]
}

/** Keeps the named servers; an unknown name is an error. */
export const selectServers = (
  servers: Record<string, unknown>,
  names: string[] | undefined,
): Record<string, McpServer> => {
  const chosen = names ?? Object.keys(servers).sort()
  const unknown = chosen.filter(name => !isRecord(servers[name]))
  if (unknown.length) throw new Error(`Unknown MCP server: ${unknown.join(", ")}`)
  return Object.fromEntries(chosen.map(name => [name, servers[name] as McpServer]))
}

/** The `--export` payload: Codex entries as they are, env included. */
export const exportPayload = (
  servers: Record<string, unknown>,
  names?: string[],
): TransferPayload => ({
  version: transferVersion, mcp_servers: selectServers(servers, names),
})

/**
 * Validates `--import` input. Errors never quote the input, which carries
 * credentials.
 */
export const parseTransferPayload = (text: string): TransferPayload => {
  let value: unknown
  try { value = JSON.parse(text) }
  catch { throw new Error("Import is not valid JSON") }
  if (!isRecord(value)) throw new Error("Import must be a JSON object")
  if (value.version !== transferVersion) {
    throw new Error(`Import version must be ${transferVersion}`)
  }
  if (!isRecord(value.mcp_servers)) throw new Error("Import mcp_servers must be an object")
  for (const [name, server] of Object.entries(value.mcp_servers)) {
    if (!isRecord(server)) throw new Error(`Import server ${name} must be an object`)
  }
  return value as unknown as TransferPayload
}

/**
 * Names of the fields that differ between two entries. A differing `env`
 * lists its key names as `env.KEY`, never values.
 */
export const differingFields = (a: McpServer, b: McpServer): string[] => {
  const fields = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()
  return fields.flatMap(field => {
    if (sameEntry({ value: a[field] }, { value: b[field] })) return []
    if (field === "env" && isStringRecord(a.env ?? {}) && isStringRecord(b.env ?? {})) {
      return differingEnvKeys(a, b).map(key => `env.${key}`)
    }
    return [field]
  })
}

export interface ImportResult {
  servers: Record<string, unknown>
  /** Credential-free report lines: names and env key names only. */
  lines: string[]
}

/**
 * Merges imported entries into Codex `mcp_servers`. Missing servers are
 * added. A differing existing server stays unless `overwrite` is set.
 */
export const mergeImport = (
  current: Record<string, unknown>,
  incoming: Record<string, McpServer>,
  overwrite = false,
): ImportResult => {
  const servers: Record<string, unknown> = { ...current }
  const lines: string[] = []
  for (const name of Object.keys(incoming).sort()) {
    const entry = incoming[name]!
    const existing = current[name]
    if (existing === undefined) {
      servers[name] = entry
      const keys = isRecord(entry.env) ? Object.keys(entry.env).sort() : []
      lines.push(`+ add ${name} (env keys: ${keys.length ? keys.join(", ") : "none"})`)
    } else if (sameEntry(existing, entry)) {
      lines.push(`= unchanged ${name}`)
    } else if (overwrite) {
      servers[name] = entry
      lines.push(`~ replace ${name}`)
    } else {
      const fields = differingFields(isRecord(existing) ? existing : {}, entry)
      lines.push(`~ differs ${name} (keys: ${fields.join(", ")}); kept, ` +
        "add --overwrite to replace")
    }
  }
  return { servers, lines }
}

export interface HostProbe {
  which: (command: string) => string | null
  exists: (path: string) => boolean
}

const hostProbe: HostProbe = { which: command => Bun.which(command), exists: existsSync }

/**
 * Warnings for an entry that can't start here: a missing command, or an
 * absolute path in `args` or `cwd` that doesn't exist.
 */
export const hostWarnings = (
  name: string,
  entry: McpServer,
  probe: HostProbe = hostProbe,
): string[] => {
  const warnings: string[] = []
  if (typeof entry.command === "string" && entry.command !== "") {
    const found = isAbsolute(entry.command)
      ? probe.exists(entry.command) : probe.which(entry.command) !== null
    if (!found) {
      warnings.push(`! warning ${name}: command ${entry.command} not found on this machine`)
    }
  }
  const args = Array.isArray(entry.args) ? entry.args : []
  const paths = [...args, entry.cwd].filter((value): value is string =>
    typeof value === "string" && isAbsolute(value) && value !== entry.command)
  for (const path of [...new Set(paths)]) {
    if (!probe.exists(path)) warnings.push(`! warning ${name}: path ${path} does not exist`)
  }
  return warnings
}

const readImport = async (source: string): Promise<string> => {
  if (source === "-") return Bun.stdin.text()
  const file = Bun.file(resolve(source))
  if (!(await file.exists())) throw new Error(`Import file not found: ${source}`)
  return file.text()
}

/**
 * Test hook: set to `1` so `--check` doesn't fail on missing pinned servers.
 * Fixtures for unrelated union behavior use it instead of carrying stubs.
 */
export const skipPinCheckEnvVar = "MCP_SYNC_SKIP_PIN_CHECK"

/** Pinned Jiyuu servers absent from Codex `mcp_servers`, sorted. */
export const missingPins = (
  codex: Record<string, unknown>,
  pins: Record<string, JiyuuMcpPin> = jiyuuMcpPins,
): string[] => Object.keys(pins).filter(name => codex[name] === undefined).sort()

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
  .option("--export", "print Codex MCP servers as JSON on stdout")
  .option("--import <file>", "merge servers from an --export file, or - for stdin")
  .option("--servers <names>", "comma-separated servers for --export, --import, or --from")
  .option("--overwrite", "with --import, replace servers that differ")
  .option("--discord-mode <mode>", "switch Discord MCP to shared or stdio")
  .action(async options => {
    if (options.from && !platforms.includes(options.from)) throw new Error("Invalid --from platform")
    const exclusive = ["export", "import", "check", "from"].filter(key => options[key] !== undefined)
    if ((options.export || options.import !== undefined) && exclusive.length > 1) {
      throw new Error(`--${exclusive.join(", --")} can't be combined`)
    }
    if (options.export && (options.run || options.dryRun)) {
      throw new Error("--export writes nothing; drop --run and --dry-run")
    }
    if (options.servers !== undefined && !options.from &&
      !options.export && options.import === undefined) {
      throw new Error("--servers needs --export, --import, or --from")
    }
    if (options.overwrite && options.import === undefined) throw new Error("--overwrite needs --import")
    const serverNames = parseServerNames(options.servers)
    const scoped = options.from ? serverNames : undefined
    const mode: DiscordMode | undefined = options.discordMode
    if (mode !== undefined && (
      (mode !== "shared" && mode !== "stdio") || options.from !== "codex" ||
      scoped?.length !== 1 || scoped[0] !== discordServer || options.check
    )) {
      throw new Error("--discord-mode needs shared or stdio and --from codex --servers discord-mcp")
    }
    const paths: Record<Platform, string> = {
      codex: resolve(options.codexConfig), claude: resolve(options.claudeConfig),
      cursor: resolve(options.cursorConfig),
    }
    if (options.run && !options.dryRun && !options.check &&
      paths.claude !== resolve(claudeConfigPath())) {
      throw new Error("Claude writes require its user config; set CLAUDE_CONFIG_DIR")
    }
    if (options.export) {
      // stdout carries only the payload; diagnostics go to stderr.
      let exported: TomlTable
      try { exported = parse(await readText(resolve(options.codexConfig))) }
      catch { throw new Error(`Unable to parse Codex config at ${options.codexConfig}`) }
      const servers = isRecord(exported.mcp_servers) ? exported.mcp_servers : {}
      process.stdout.write(`${JSON.stringify(exportPayload(servers, serverNames))}\n`)
      return
    }
    const imported = options.import === undefined ? undefined
      : selectServers(parseTransferPayload(await readImport(options.import)).mcp_servers,
        serverNames)
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
    const discord = mode === undefined ? undefined : await discordPaths()
    const sourceToken = discord ? discordToken(original[discordServer]) : undefined
    const clientTokens = discord ? discordClientTokens(raw) : []
    if (mode && discord) {
      raw.codex = {
        ...raw.codex,
        [discordServer]: discordDefinition(original[discordServer], mode, discord.launcher),
      }
      console.log(`Discord MCP mode: ${mode}`)
    }
    if (imported) {
      const merged = mergeImport(original, imported, options.overwrite)
      for (const line of merged.lines) console.log(line)
      for (const [name, entry] of Object.entries(imported)) {
        if (merged.servers[name] !== entry) continue
        for (const warning of hostWarnings(name, entry)) console.log(warning)
      }
      raw.codex = merged.servers
    }
    const pins = scoped
      ? Object.fromEntries(Object.entries(jiyuuMcpPins).filter(([name]) => scoped.includes(name)))
      : jiyuuMcpPins
    const pinOptions = {
      local: parseLocalNames(process.env[localEnvVar]),
      jiyuuDir: jiyuuCheckoutDir(process.env),
      pins,
    }
    const pinned = applyJiyuuPins(raw.codex, pinOptions)
    raw.codex = pinned.servers
    for (const warning of pinned.warnings) console.log(`! warning ${warning}`)
    for (const change of pinned.changes) console.log(change)
    const inputs = scoped ? {
      codex: raw.codex,
      claude: Object.fromEntries(Object.entries(raw.claude).filter(([name]) => scoped.includes(name))),
      cursor: Object.fromEntries(Object.entries(raw.cursor).filter(([name]) => scoped.includes(name))),
    } : raw
    const { definitions, warnings } = await resolveDefinitions(inputs, paths.codex)
    if (scoped) selectServers(definitions[options.from as Platform], scoped)
    if (discord && (["claude", "cursor"] as const).some(target =>
      raw[target][discordServer] !== undefined && definitions[target][discordServer] === undefined
    )) {
      throw new Error("Review the unsupported Discord MCP client entry before switching")
    }
    const ctx = defaultLauncherContext(paths.codex)
    if (options.launcherPath) ctx.launcherPath = resolve(options.launcherPath)
    const plan = planUnion(raw, definitions, ctx, options.from, scoped)
    // A directional source can carry an old launch command; pins still win.
    plan.codex = applyJiyuuPins(plan.codex, pinOptions).servers as McpServers
    const migrated = migrateDirectPins(plan, raw, definitions, ctx, pins)
    for (const warning of [...warnings, ...plan.warnings, ...migrated]) console.log(`! warning ${warning}`)
    const codexChanged = !sameEntry(original, plan.codex)
    if (codexChanged) console.log("~ update codex MCP definitions")
    for (const target of ["claude", "cursor"] as const) {
      for (const line of describePlan(plan.targets[target], target)) console.log(`${target}: ${line}`)
    }
    const changed = codexChanged || hasChanges(plan.targets.claude) || hasChanges(plan.targets.cursor)
    // Sync can't create a pinned server, since its env is machine-local, so
    // --check is the place that fails until someone adds or imports it.
    const missing = options.check && process.env[skipPinCheckEnvVar] !== "1"
      ? missingPins(original) : []
    if (missing.length) {
      console.log(`! missing pinned servers in Codex: ${missing.join(", ")}`)
    } else if (!changed) console.log("MCP union is current")
    if (options.check) { if (changed || missing.length) process.exitCode = 1; return }
    if (!options.run || options.dryRun) {
      if (imported) console.log("Dry run: nothing written; add --run to apply")
      return
    }
    // Preflight every input before the first write. Each target also gets a
    // fresh check immediately before its write, including between CLI calls.
    const assertUnchanged = async (p: Platform) => {
      if (await readText(paths[p]) !== before[p]) throw new Error(`${p} config changed during sync; rerun it`)
    }
    const unlock = discord ? await lockDiscord(discord) : undefined
    try {
      for (const p of platforms) await assertUnchanged(p)
      if (discord) {
        await prepareDiscordCredential(discord, sourceToken, clientTokens)
        if (mode === "shared") await startDiscord()
        for (const p of platforms) await assertUnchanged(p)
      }
      if (codexChanged) {
        const next = serialize({ ...config, mcp_servers: plan.codex as TomlTable })
        // Discord mode changes have a vault-backed fallback. A copy of the
        // previous config could retain the credential we just migrated.
        if (!discord && before.codex && next !== before.codex) {
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
        const backup = await writeCursorFile(paths.cursor, cursor, plan.targets.cursor, plan.codex, !discord)
        if (backup) console.log(`Saved previous Cursor file to ${backup}`)
      }
      if (hasChanges(plan.targets.claude)) {
        await assertUnchanged("claude")
        const backup = discord ? undefined : await backupReplacedEntries(
          plan.targets.claude, raw.claude, plan.codex, paths.claude,
          resolve(paths.claude, "../mcp-sync-state.json"),
        )
        if (backup) console.log(`Saved previous Claude entries to ${backup}`)
        await applyClaudePlan(plan.targets.claude, raw.claude, "claude",
          async (name, expected) => {
            const latest = await readClaudeUserMcpServers(paths.claude)
            if (expected === undefined ? latest[name] !== undefined :
              !isRecord(expected) || !sameEntry(latest[name], expected)) {
              throw new Error(`claude/${name} changed during sync; rerun it`)
            }
          }, !discord)
      }
      if (mode === "stdio") await stopDiscord()
    } finally {
      await unlock?.()
    }
  })

if (import.meta.main) {
  try { await createProgram().parseAsync() }
  catch (error) {
    console.error(error instanceof Error ? error.message : "MCP sync failed")
    process.exitCode = 1
  }
}
