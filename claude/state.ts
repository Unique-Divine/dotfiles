import { bash } from "@uniquedivine/bash"
import { Command } from "commander"
import { mkdir, rename, rm, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

import { unifiedDiff } from "../configDiff"
import { readJsonObject, stringify, type JsonObject } from "./settings"

// These internal Claude fields were verified with Claude Code 2.1.310.
// Authentication, MCPs, project trust, and machine identity stay host-local.
export const dotfileState = {
  editorMode: "vim",
  showExpandedTodos: true,
  hasCompletedOnboarding: true,
} as const

export const runtimeStatePath = (env: NodeJS.ProcessEnv = process.env): string => {
  if (!env.HOME) throw new Error("HOME is not set")
  return resolve(env.HOME, ".claude.json")
}

export const mergeRuntimeState = (state: JsonObject): JsonObject => ({
  ...state,
  ...dotfileState,
})

export const ownedState = (state: JsonObject): JsonObject =>
  Object.fromEntries(Object.keys(dotfileState)
    .filter((key) => Object.hasOwn(state, key))
    .map((key) => [key, state[key]]))

export const stateHasDrift = (state: JsonObject): boolean =>
  Object.entries(dotfileState).some(([key, value]) => state[key] !== value)

export async function assertClaudeStopped(): Promise<void> {
  const uid = process.getuid?.()
  if (uid === undefined) throw new Error("Claude state sync requires Unix")
  const result = await bash(`pgrep -u ${uid} -x claude`)
  if (result.exitCode === 0) {
    throw new Error("Claude is running. Exit Claude sessions before repairing " +
      "state with just claude state --run; existing sessions were left alone.")
  }
  if (result.exitCode !== 1) {
    throw new Error("Unable to check running Claude processes; no state written")
  }
}

/** Write an already-planned merge after the caller checks for running Claude. */
export async function writeState(
  path: string, before: string, merged: JsonObject,
): Promise<void> {
  const latest = await readJsonObject(path)
  if (latest.text !== before) {
    throw new Error("Claude state changed during sync; rerun after exiting Claude")
  }
  await mkdir(dirname(path), { recursive: true })
  const suffix = crypto.randomUUID()
  const temporary = `${path}.${suffix}.tmp`
  try {
    if (before) {
      await writeFile(`${path}.before-dotfiles-${suffix}`, before,
        { mode: 0o600, flag: "wx" })
    }
    await writeFile(temporary, stringify(merged), { mode: 0o600, flag: "wx" })
    // Check again before replacing a file Claude can rewrite independently.
    if ((await readJsonObject(path)).text !== before) {
      throw new Error("Claude state changed during sync; refusing to replace it")
    }
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

export interface StateOptions {
  runtimePath?: string
  dryRun?: boolean
  quiet?: boolean
}

export async function applyState({
  runtimePath = runtimeStatePath(), dryRun = false, quiet = false,
}: StateOptions = {}): Promise<boolean> {
  const { config, text } = await readJsonObject(runtimePath)
  if (!stateHasDrift(config)) {
    if (!quiet) console.log(`Claude state is already current: ${runtimePath}`)
    return false
  }
  const merged = mergeRuntimeState(config)
  if (!quiet) {
    console.log(`Claude state differs: ${runtimePath}`)
    process.stdout.write(unifiedDiff(
      stringify(ownedState(config)), stringify(ownedState(merged)),
      "runtime Claude state (managed keys)", "desired Claude state (managed keys)",
    ))
  }
  if (!dryRun) {
    await assertClaudeStopped()
    await writeState(runtimePath, text, merged)
  }
  return true
}

export function createProgram(): Command {
  return new Command()
    .name("claude-state")
    .description("Enforce portable Claude preferences and onboarding state")
    .option("--run", "repair managed state; requires Claude to be stopped")
    .option("--check", "report drift without writing")
    .option("--dry-run", "show the managed-key diff without writing")
    .option("--quiet", "suppress normal output")
    .action(async (options: {
      run?: boolean; check?: boolean; dryRun?: boolean; quiet?: boolean,
    }, command: Command) => {
      if (!options.run && !options.check && !options.dryRun) {
        command.outputHelp()
        return
      }
      try {
        const changed = await applyState({
          dryRun: !options.run || options.check || options.dryRun,
          quiet: options.quiet,
        })
        if (options.check && changed) process.exitCode = 1
      } catch (error) {
        console.error(error instanceof Error ? error.message : "State sync failed")
        process.exitCode = 1
      }
    })
}

if (import.meta.main) await createProgram().parseAsync()
