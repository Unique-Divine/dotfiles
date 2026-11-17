import { resolve } from "node:path"

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
  },
  slack: {
    runner: "bunx",
    package: "@uniquedivine/mcp-slack",
    version: "4.4.3",
    local: { command: "bun", entry: "mcp/slack/src/cli.js" },
  },
  "telegram-mcp": {
    runner: "uvx",
    package: "uniquedivine-telegram-mcp",
    version: "2.0.2",
    local: { command: "uv", directory: "mcp/telegram", entry: "main.py" },
  },
} as const satisfies Record<string, JiyuuMcpPin>

export type PinnedServerName = keyof typeof jiyuuMcpPins

export interface JiyuuMcpPin {
  runner: "bunx" | "uvx"
  package: string
  version: string
  /** How to run the server from a Jiyuu checkout, relative to its root. */
  local:
    | { command: "bun"; entry: string }
    | { command: "uv"; directory: string; entry: string }
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
 * pin. Pure: the input is not modified.
 *
 * - Only `command` and `args` change. `env`, `cwd`, `enabled`, and timeouts
 *   stay as they are, so secret wiring never moves.
 * - A missing entry is not created, because its `env` must be added by hand.
 * - A `url` entry, such as the planned shared Discord server, is left alone.
 */
export const applyJiyuuPins = (
  servers: Record<string, unknown>,
  { local = new Set(), jiyuuDir, pins = jiyuuMcpPins }: PinOptions = {},
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
