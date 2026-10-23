import { cursorMcpConfigPath, readCursorMcpServers } from "../codex/config.ts"

/**
 * Starts one Cursor-defined MCP server for Claude Code.
 *
 * Claude Code's user-scope entry runs `mcp-launch.ts --source <path> <name>`.
 * The server's `env` stays in `$HOME/.cursor/mcp.json`; this launcher reads it
 * when Claude starts the server and hands it only to the child process.
 *
 * Stdout belongs to the MCP protocol, so the launcher never writes to it.
 * Errors name the server and never include env values.
 */

/** Executable, arguments, and environment for one server process. */
export interface LaunchSpec {
  cmd: string[]
  env: Record<string, string>
}

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string")

const isStringRecord = (value: unknown): value is Record<string, string> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value).every((entry) => typeof entry === "string")

export const resolveLaunchSpec = (
  servers: Record<string, unknown>,
  name: string,
  baseEnv: Record<string, string | undefined>,
): LaunchSpec => {
  if (!Object.hasOwn(servers, name)) {
    throw new Error(`MCP server ${name} is not defined in the Cursor config`)
  }

  const server = servers[name] as Record<string, unknown>
  const command = server.command
  const args = server.args ?? []
  const serverEnv = server.env ?? {}

  if (typeof command !== "string" || command === "") {
    throw new Error(`MCP server ${name} has no command`)
  }

  if (!isStringArray(args)) {
    throw new Error(`MCP server ${name} args must be strings`)
  }

  if (!isStringRecord(serverEnv)) {
    throw new Error(`MCP server ${name} env values must be strings`)
  }

  const env: Record<string, string> = {}

  for (const [key, value] of Object.entries(baseEnv)) {
    if (value !== undefined) env[key] = value
  }

  Object.assign(env, serverEnv)

  const executable = Bun.which(command, { PATH: env.PATH ?? "" }) ?? command

  return { cmd: [executable, ...args], env }
}

interface LaunchArgs {
  name: string
  sourcePath: string
}

export const parseLaunchArgs = (argv: string[]): LaunchArgs => {
  let sourcePath = cursorMcpConfigPath()
  const positional: string[] = []

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]

    if (arg === "--source") {
      const value = argv[i + 1]

      if (value === undefined) {
        throw new Error("--source requires a path")
      }

      sourcePath = value
      i += 1
      continue
    }

    positional.push(arg)
  }

  if (positional.length !== 1) {
    throw new Error("Usage: mcp-launch.ts [--source <path>] <server-name>")
  }

  return { name: positional[0], sourcePath }
}

const main = async (): Promise<void> => {
  let spec: LaunchSpec

  try {
    const { name, sourcePath } = parseLaunchArgs(Bun.argv.slice(2))
    const servers = await readCursorMcpServers(sourcePath)
    spec = resolveLaunchSpec(servers, name, process.env)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`mcp-launch: ${message}\n`)
    process.exit(2)
  }

  const child = Bun.spawn(spec.cmd, {
    env: spec.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => child.kill(signal))
  }

  process.exit(await child.exited)
}

if (import.meta.main) {
  await main()
}
