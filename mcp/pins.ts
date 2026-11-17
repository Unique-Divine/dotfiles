import { readFileSync } from "node:fs"
import { basename, join, resolve } from "node:path"

import { isRecord, type McpServer, type McpServers } from "./servers.ts"

/**
 * Pinned launch commands for the MCP servers published from Jiyuu
 * (https://github.com/Unique-Divine/jiyuu/issues/124).
 *
 * This table is the single source of truth. `just mcp-sync`, and so
 * `just sync`, rewrites `command` and `args` of each named Codex
 * `[mcp_servers.<name>]` entry to run the pinned release. It leaves `env`
 * and every other field alone. Claude Code and the Cursor CLI use launcher
 * entries that read the Codex definition, so they follow without changes.
 *
 * Bump a release by editing its `version` line, then run `ud boku sync`.
 */
export const jiyuuMcpPins = {
  "discord-mcp": {
    runner: "bunx",
    package: "@uniquedivine/mcp-discord",
    version: "1.3.8",
    local: { command: "bun", entry: "mcp/discord/src/index.ts" },
    legacy: { commands: ["mcp-discord"], component: "mcp/discord" },
  },
  slack: {
    runner: "bunx",
    package: "@uniquedivine/mcp-slack",
    version: "4.4.3",
    local: { command: "bun", entry: "mcp/slack/src/cli.js" },
    legacy: {
      commands: ["slack-mcp", "slack-mcp-server"], component: "mcp/slack",
    },
  },
  "telegram-mcp": {
    runner: "uvx",
    package: "uniquedivine-telegram-mcp",
    version: "2.0.2",
    auth: {
      prefix: "TELEGRAM_",
      required: ["TELEGRAM_API_ID", "TELEGRAM_API_HASH"],
      session: "TELEGRAM_SESSION_STRING",
      fileSession: "TELEGRAM_SESSION_NAME",
    },
    local: { command: "uv", directory: "mcp/telegram", entry: "main.py" },
    legacy: { commands: [], component: "mcp/telegram" },
  },
} as const satisfies Record<string, JiyuuMcpPin>

export type PinnedServerName = keyof typeof jiyuuMcpPins

export interface JiyuuMcpPin {
  runner: "bunx" | "uvx"
  package: string
  version: string
  /**
   * Credentials a checkout launch may have read from `.env` or a
   * `*.session` file in its directory, which a registry launch never sees.
   * `session` also matches `<session>_<LABEL>`.
   */
  auth?: {
    prefix: string
    required: readonly string[]
    session: string
    /** Env naming a session file, resolved from the launch directory. */
    fileSession?: string
  }
  /** How to run the server from a Jiyuu checkout, relative to its root. */
  local:
    | { command: "bun"; entry: string }
    | { command: "uv"; directory: string; entry: string }
  /**
   * Launches used before the pins: global command names linked to Jiyuu,
   * and the component directory that checkout launches point into.
   */
  legacy: { commands: readonly string[]; component: string }
}

/**
 * Reports whether a Claude or Cursor entry is a pre-pin Jiyuu stdio launch,
 * such as `mcp-discord`, `slack-mcp`, `bun <jiyuu>/mcp/slack/src/cli.js`, or
 * `uv --directory <jiyuu>/mcp/telegram run main.py`. Remote and unrecognized
 * definitions return false, so sync never replaces them on its own.
 */
export const isLegacyJiyuuLaunch = (
  entry: unknown, pin: JiyuuMcpPin,
): boolean => {
  if (!isRecord(entry) || typeof entry.command !== "string") return false
  if (entry.url !== undefined) return false
  if (entry.type !== undefined && entry.type !== "stdio") return false
  if (pin.legacy.commands.includes(basename(entry.command))) return true
  const args = Array.isArray(entry.args) ? entry.args : []
  const component = pin.legacy.component
  return [entry.command, ...args].some((value) =>
    typeof value === "string" &&
    (value.endsWith(`/${component}`) || value.includes(`/${component}/`)))
}

/** Environment variable that opts servers into a local Jiyuu checkout. */
export const localEnvVar = "JIYUU_MCP_LOCAL"

export interface Launch {
  command: string
  args: string[]
}

/** The registry launch for one pin, such as `bunx pkg@1.2.3`. */
export const pinnedLaunch = (pin: JiyuuMcpPin): Launch => ({
  command: pin.runner,
  args: [`${pin.package}@${pin.version}`],
})

/** The development launch for one pin from a Jiyuu checkout. */
export const localLaunch = (pin: JiyuuMcpPin, jiyuuDir: string): Launch =>
  pin.local.command === "uv"
    ? {
      command: "uv",
      args: [
        "--directory", resolve(jiyuuDir, pin.local.directory),
        "run", pin.local.entry,
      ],
    }
    : { command: "bun", args: [resolve(jiyuuDir, pin.local.entry)] }

/**
 * Parses `JIYUU_MCP_LOCAL`: a comma-separated list of pinned server names,
 * or `all`. Unknown names are errors so a typo can't silently pin.
 */
export const parseLocalNames = (
  value: string | undefined,
  pins: Record<string, JiyuuMcpPin> = jiyuuMcpPins,
): Set<string> => {
  const names = (value ?? "").split(",").map((name) => name.trim())
    .filter((name) => name !== "")

  if (names.includes("all")) return new Set(Object.keys(pins))

  for (const name of names) {
    if (!Object.hasOwn(pins, name)) {
      throw new Error(`${localEnvVar} names unknown server ${name}; ` +
        `expected all or ${Object.keys(pins).join(", ")}`)
    }
  }

  return new Set(names)
}

/** Jiyuu checkout at `$REPO/boku/jiyuu`, as `zsh/sync-jiyuu.sh` uses. */
export const jiyuuCheckoutDir = (
  env: Record<string, string | undefined>,
): string | undefined =>
  env.REPO ? resolve(env.REPO, "boku", "jiyuu") : undefined

export interface PinOptions {
  local?: Set<string>
  jiyuuDir?: string
  pins?: Record<string, JiyuuMcpPin>
  /** Names defined by `<dir>/.env`; never values. */
  readDotEnvKeys?: (dir: string) => string[]
}

/** Variable names assigned in dotenv text, such as `A=1` or `export B=2`. */
export const dotEnvKeys = (text: string): string[] =>
  text.split("\n").flatMap((line) => {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)
    return match ? [match[1]!] : []
  })

/** Names defined by `<dir>/.env`, or none when it's missing or unreadable. */
export const readDotEnvKeysFrom = (dir: string): string[] => {
  try { return dotEnvKeys(readFileSync(join(dir, ".env"), "utf8")) }
  catch { return [] }
}

/** Directory a stdio entry runs from: `uv --directory <dir>`, else `cwd`. */
export const launchDirectory = (server: McpServer): string | undefined => {
  const args = Array.isArray(server.args) ? server.args : []
  const flag = args.indexOf("--directory")
  const dir = flag >= 0 ? args[flag + 1] : server.cwd
  return typeof dir === "string" && dir !== "" ? dir : undefined
}

/**
 * Reasons a registry launch could lose credentials that the old checkout
 * launch had: `.env` keys the Codex env lacks, or required env (API keys and
 * a session string) that may come from `.env` or a `*.session` file. A stray
 * `*.session` file alone, with complete env, is no reason.
 */
export const authGaps = (
  server: McpServer,
  auth: NonNullable<JiyuuMcpPin["auth"]>,
  dotEnv: string[],
): { missing: string[]; dotEnvOnly: string[]; fileSessions: string[] } => {
  const env = isRecord(server.env) ? Object.keys(server.env) : []
  const missing = auth.required.filter((key) => !env.includes(key))
  if (!env.some((key) =>
    key === auth.session || key.startsWith(`${auth.session}_`))) {
    missing.push(auth.session)
  }
  const dotEnvOnly = [...new Set(dotEnv)].filter((key) =>
    key.startsWith(auth.prefix) && !env.includes(key)).sort()
  const file = auth.fileSession
  const fileSessions = file ? env.filter((key) =>
    key === file || key.startsWith(`${file}_`)).sort() : []
  return { missing, dotEnvOnly, fileSessions }
}

export interface PinResult {
  servers: Record<string, unknown>
  /** Credential-free lines for entries this run changes. */
  changes: string[]
  /** Credential-free lines for pins that could not be applied. */
  warnings: string[]
}

const sameArgs = (a: unknown, b: string[]): boolean =>
  Array.isArray(a) && a.length === b.length &&
  a.every((value, i) => value === b[i])

/**
 * Returns Codex `mcp_servers` with each pinned stdio entry launching its
 * pin. The input is not modified; the only read is `readDotEnvKeys`.
 *
 * - Only `command` and `args` change. `env`, `cwd`, `enabled`, and timeouts
 *   stay as they are, so secret wiring never moves.
 * - A missing entry is not created, because its `env` must be added by hand.
 * - A `url` entry, such as the planned shared Discord server, is left alone.
 */
export const applyJiyuuPins = (
  servers: Record<string, unknown>,
  {
    local = new Set(), jiyuuDir, pins = jiyuuMcpPins,
    readDotEnvKeys = readDotEnvKeysFrom,
  }: PinOptions = {},
): PinResult => {
  const next: Record<string, unknown> = { ...servers }
  const changes: string[] = []
  const warnings: string[] = []

  for (const [name, pin] of Object.entries(pins)) {
    const server = servers[name]
    const useLocal = local.has(name)
    const label = useLocal ? "local Jiyuu checkout"
      : `${pin.package}@${pin.version}`

    if (server === undefined) {
      warnings.push(`${name}: not in the Codex config; add it with its env ` +
        `to run ${label}`)
      continue
    }

    // A shared server reached by url launches elsewhere; nothing to pin here.
    if (isRecord(server) && server.command === undefined &&
      typeof server.url === "string") {
      continue
    }

    if (!isRecord(server) || typeof server.command !== "string") {
      warnings.push(`${name}: not a stdio entry; ${label} not applied`)
      continue
    }

    if (useLocal && !jiyuuDir) {
      throw new Error(`${localEnvVar} selects ${name}, but REPO is unset, ` +
        "so the Jiyuu checkout cannot be found")
    }

    const launch = useLocal ? localLaunch(pin, jiyuuDir!) : pinnedLaunch(pin)

    // A registry launch runs from the uv cache, so credentials read from
    // files beside the old checkout launch would silently stop working.
    if (!useLocal && pin.auth && server.command !== launch.command) {
      const oldDir = launchDirectory(server)
      const gaps = authGaps(server, pin.auth,
        oldDir ? readDotEnvKeys(oldDir) : [])
      const entry = `[mcp_servers.${name}].env in the Codex config`
      if (gaps.dotEnvOnly.length) {
        warnings.push(`${name}: not pinned; ${oldDir}/.env defines ` +
          `${gaps.dotEnvOnly.join(", ")}, which ${entry} lacks. Move them ` +
          "there, then rerun just mcp-sync --run")
        continue
      }
      if (gaps.fileSessions.length && oldDir) {
        warnings.push(`${name}: not pinned; ${gaps.fileSessions.join(", ")} ` +
          `name session files relative to ${oldDir}. Replace them with ` +
          `session strings in ${entry}, then rerun just mcp-sync --run`)
        continue
      }
      if (gaps.missing.length) {
        warnings.push(`${name}: not pinned; ${entry} lacks ` +
          `${gaps.missing.join(", ")}, so the checkout may authenticate ` +
          "from .env or a *.session file. Add them there, then rerun " +
          "just mcp-sync --run")
        continue
      }
    }

    if (server.command === launch.command &&
      sameArgs(server.args, launch.args)) {
      continue
    }

    const updated: McpServer = { ...server, command: launch.command }
    if (launch.args.length > 0) updated.args = launch.args
    else delete updated.args
    next[name] = updated
    changes.push(`~ pin ${name} to ${label}`)
  }

  return { servers: next as McpServers, changes, warnings }
}
