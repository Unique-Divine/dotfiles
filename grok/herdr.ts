import { mkdir } from "node:fs/promises"

import { Command } from "commander"

import { grokDirectory } from "./config.ts"

/**
 * Herdr's own installer owns the Grok session hook. It writes
 * `hooks/herdr.json` and `hooks/herdr-agent-state.sh` under `$GROK_HOME` or
 * `~/.grok`, and it does not edit other hook files.
 */
export const grokHookCurrent = (status: string): boolean =>
  status.split("\n").some((line) => /^grok:\s+current\b/.test(line))

const missing = (name: string): string =>
  `Missing required CLI: ${name}. Install it and rerun just sync.`

const repair =
  "grok: Herdr session hook is not current. Repair: just herdr-integrations"

interface CommandResult {
  stdout: string
  stderr: string
  exitCode: number
}

const runHerdr = async (
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<CommandResult> => {
  const herdr = Bun.which("herdr", { PATH: env.PATH ?? "" })

  if (!herdr) {
    throw new Error(missing("herdr"))
  }

  const proc = Bun.spawn([herdr, ...args], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])

  return { exitCode, stdout, stderr }
}

const requireGrok = (env: NodeJS.ProcessEnv): void => {
  if (!Bun.which("grok", { PATH: env.PATH ?? "" })) {
    throw new Error(missing("grok"))
  }
}

export const readHerdrStatus = async (
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> => {
  const result = await runHerdr(["integration", "status"], env)

  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || "herdr integration status failed")
  }

  return result.stdout
}

export const ensureGrokHook = async (
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> => {
  requireGrok(env)
  const status = await readHerdrStatus(env)

  if (grokHookCurrent(status)) {
    return false
  }

  // Herdr refuses to install until this directory exists.
  await mkdir(grokDirectory(env), { recursive: true })

  const installed = await runHerdr(["integration", "install", "grok"], env)

  if (installed.exitCode !== 0) {
    throw new Error(
      installed.stderr.trim() || "herdr integration install grok failed",
    )
  }

  if (!grokHookCurrent(await readHerdrStatus(env))) {
    throw new Error(repair)
  }

  return true
}

export const checkGrokHook = async (
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> => {
  if (!grokHookCurrent(await readHerdrStatus(env))) {
    throw new Error(repair)
  }
}

interface HerdrOptions {
  check?: boolean
  run?: boolean
}

const runCommand = async (options: HerdrOptions): Promise<void> => {
  if (options.run) {
    if (await ensureGrokHook()) {
      console.log("Herdr integration: installed the Grok session hook")
    }
  } else {
    await checkGrokHook()
  }

  console.log("Herdr integration: Grok is current")
}

export const createProgram = (): Command => {
  const program = new Command()

  program
    .name("grok-herdr")
    .description("Install or check the Herdr session hook for Grok.")
    .option("--run", "install the hook when it is not current")
    .option("--check", "exit with code 1 when the hook is not current")
    .action(async (options: HerdrOptions) => {
      if (!options.run && !options.check) {
        program.outputHelp()
        return
      }

      try {
        await runCommand(options)
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error))
        process.exitCode = 1
      }
    })

  return program
}

if (import.meta.main) {
  await createProgram().parseAsync()
}
