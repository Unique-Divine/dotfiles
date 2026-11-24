import { access, mkdir } from "node:fs/promises"
import { constants } from "node:fs"
import { dirname, isAbsolute, join } from "node:path"

import { writePrivateFile } from "./plan.ts"
import {
  classifyServer, codexConfigPath, isLauncherEntry, isRecord,
  readCodexMcpServers, transportFields, type McpServer,
} from "./servers.ts"
import type { Inventory } from "./sync.ts"

export const discordServer = "discord-mcp"
export const discordUrl = "http://127.0.0.1:8123/mcp"
const healthUrl = new URL("/healthz", discordUrl)
const unit = "mcp-discord.service"
const secretName = "discord-token"
const tokenField = "DISCORD_TOKEN"
export type DiscordMode = "shared" | "stdio"

interface DiscordPaths {
  bokuHome: string
  marker: string
  launcher: string
  helper: string
  store: string
  bun: string
}

export const discordPaths = async (
  env: NodeJS.ProcessEnv = process.env,
): Promise<DiscordPaths> => {
  if (!env.HOME) throw new Error("HOME is not set")
  const marker = join(env.HOME, ".config/mcp-discord/boku-home")
  const file = Bun.file(marker)
  const existing = await file.exists()
    ? (await file.text()).replace(/\n$/, "") : undefined
  if (existing && env.BOKU_HOME && existing !== env.BOKU_HOME) {
    throw new Error("The configured Discord MCP store uses a different BOKU_HOME")
  }
  const bokuHome = existing ?? (env.BOKU_HOME || join(env.HOME, ".boku"))
  if (!isAbsolute(bokuHome) || /[\r\n]/.test(bokuHome)) {
    throw new Error("BOKU_HOME must be an absolute path on one line")
  }
  return {
    bokuHome,
    marker,
    launcher: join(env.HOME, ".local/bin/mcp-discord-launch"),
    helper: join(env.HOME, ".local/bin/local-secret-store"),
    store: join(bokuHome, "discord-mcp/secrets"),
    bun: join(env.HOME, ".bun/bin/bun"),
  }
}

/** Only the known Discord credential qualifies for this migration. */
export const discordToken = (entry: unknown): string | undefined => {
  if (!isRecord(entry) || entry.env === undefined) return undefined
  if (!isRecord(entry.env) ||
    Object.keys(entry.env).some(key => key !== tokenField)) {
    throw new Error("Discord MCP has extra environment settings; review them before switching")
  }
  const token = entry.env[tokenField]
  if (token === undefined) return undefined
  if (typeof token !== "string" || !token.length || /\s|\0/.test(token)) {
    throw new Error("Discord MCP DISCORD_TOKEN must be a nonempty token without whitespace")
  }
  return token
}

/**
 * Preserve Codex preferences such as timeouts, enabled tools, and approval
 * settings. The service and managed launcher own the transport.
 */
export const discordDefinition = (
  current: unknown,
  mode: DiscordMode,
  launcher: string,
): McpServer => {
  const entry = isRecord(current) ? current : {}
  if (entry.enabled === false) throw new Error("Discord MCP is disabled in Codex")
  if (entry.url !== undefined && entry.url !== discordUrl) {
    throw new Error("Discord MCP points to a different HTTP server")
  }
  if (Array.isArray(entry.args) && entry.args.some(
    arg => typeof arg === "string" && /^--config(?:=|$)/.test(arg),
  )) {
    throw new Error("Discord MCP uses --config; move its token to DISCORD_TOKEN first")
  }
  const preferences = Object.fromEntries(Object.entries(entry).filter(
    ([key]) => !(transportFields as readonly string[]).includes(key),
  ))
  return mode === "shared"
    ? { ...preferences, url: discordUrl }
    : { ...preferences, command: launcher, args: ["stdio"] }
}

/** Legacy direct entries may hold a copy of the Codex token. */
export const discordClientTokens = (raw: Inventory): string[] => {
  const tokens: string[] = []
  for (const target of ["claude", "cursor"] as const) {
    const entry = raw[target][discordServer]
    if (entry === undefined || isLauncherEntry(entry)) continue
    if (!isRecord(entry) ||
      (classifyServer(entry) !== "stdio" && entry.url !== discordUrl)) {
      throw new Error(`Review the independent ${target} Discord MCP entry before switching`)
    }
    discordDefinition(entry, "shared", "")
    const token = discordToken(entry)
    if (token !== undefined) tokens.push(token)
  }
  return tokens
}

const readToken = async (paths: DiscordPaths): Promise<string | undefined> => {
  // Bash command substitution gives the Rust helper a FIFO. Bun's native
  // subprocess pipes can be sockets, which the helper deliberately refuses.
  const child = Bun.spawn([
    "bash", "-c", 'value=$("$@") || exit; printf "%s" "$value"',
    "discord-secret", paths.helper, "--store", paths.store, "get", secretName,
  ], { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const [status, value, error] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ])
  if (status === 0 && value.length && !/\s|\0/.test(value)) return value
  if (status !== 0 &&
    error.trim() === "local-secret-store: encrypted entry does not exist") return undefined
  throw new Error("Unable to read the encrypted Discord MCP token")
}

const writeToken = async (paths: DiscordPaths, token: string): Promise<void> => {
  const child = Bun.spawn([
    "bash", "-o", "pipefail", "-c", 'cat | "$@"',
    "discord-secret", paths.helper, "--store", paths.store, "put", secretName,
  ], { stdin: new Blob([token]), stdout: "ignore", stderr: "ignore" })
  if (await child.exited !== 0 || await readToken(paths) !== token) {
    throw new Error("Unable to store and verify the Discord MCP token")
  }
}

export const prepareDiscordCredential = async (
  paths: DiscordPaths,
  sourceToken: string | undefined,
  clientTokens: string[],
): Promise<void> => {
  for (const executable of [paths.helper, paths.bun, paths.launcher]) {
    try {
      await access(executable, constants.X_OK)
    } catch {
      throw new Error(`Required executable is missing: ${executable}`)
    }
  }
  const marker = Bun.file(paths.marker)
  const location = `${paths.bokuHome}\n`
  if (await marker.exists() && await marker.text() !== location) {
    throw new Error("The configured Discord MCP store uses a different BOKU_HOME")
  }
  const stored = await readToken(paths)
  if (stored !== undefined && sourceToken !== undefined && stored !== sourceToken) {
    throw new Error("The encrypted Discord token differs from Codex DISCORD_TOKEN")
  }
  const token = stored ?? sourceToken
  if (token === undefined) throw new Error("Discord MCP DISCORD_TOKEN is missing from Codex and the store")
  if (clientTokens.some(value => value !== token)) {
    throw new Error("A direct Discord MCP client has a different DISCORD_TOKEN")
  }
  if (stored === undefined) await writeToken(paths, token)
  await writePrivateFile(paths.marker, location)
}

/** Hold a host-local lock until sync closes the child's stdin pipe. */
export const lockDiscord = async (paths: DiscordPaths): Promise<() => Promise<void>> => {
  const directory = dirname(paths.marker)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const child = Bun.spawn([
    "flock", "--nonblock", join(directory, "migration.lock"),
    "sh", "-c", "printf x; cat >/dev/null",
  ], { stdin: "pipe", stdout: "pipe", stderr: "ignore" })
  const reader = child.stdout.getReader()
  const { done } = await reader.read()
  reader.releaseLock()
  if (done) {
    child.stdin.end()
    await child.exited
    throw new Error("Unable to lock Discord MCP migration; check for another running migration")
  }
  return async () => {
    child.stdin.end()
    await child.exited
  }
}

const systemctl = async (...args: string[]): Promise<boolean> => {
  const child = Bun.spawn(["systemctl", "--user", ...args], {
    stdin: "ignore", stdout: "ignore", stderr: "ignore",
  })
  return await child.exited === 0
}

const healthy = async (): Promise<boolean> => {
  if (!await systemctl("is-active", "--quiet", unit)) return false
  try {
    const res = await fetch(healthUrl, {
      redirect: "error", signal: AbortSignal.timeout(1_000),
    })
    await res.body?.cancel()
    return res.status === 200
  } catch {
    return false
  }
}

export const startDiscord = async (): Promise<void> => {
  if (!await systemctl("daemon-reload") || !await systemctl("start", unit)) {
    throw new Error(`Unable to start ${unit}; check systemctl --user status ${unit}`)
  }
  const deadline = Date.now() + 30_000
  do {
    if (await healthy()) {
      if (!await systemctl("enable", unit)) {
        throw new Error(`Unable to enable ${unit}`)
      }
      return
    }
    await Bun.sleep(500)
  } while (Date.now() < deadline)
  throw new Error(`Discord MCP is not ready at ${healthUrl}; check journalctl --user -u ${unit}`)
}

export const stopDiscord = async (): Promise<void> => {
  if (!await systemctl("disable", "--now", unit)) {
    throw new Error(`Unable to disable ${unit}; retry the stdio switch`)
  }
}

if (import.meta.main) {
  try {
    const servers = await readCodexMcpServers(codexConfigPath())
    if (servers[discordServer]?.url === discordUrl) {
      if (!await healthy()) {
        throw new Error(`Discord MCP is not ready at ${healthUrl}; check systemctl --user status ${unit}`)
      }
      console.log(`Discord MCP is ready at ${discordUrl}`)
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Discord MCP health check failed")
    process.exitCode = 1
  }
}
