#!/usr/bin/env bun
/**
 * ac: find, open, and annotate audio-capture recordings from WSL.
 *
 * Usage: ac [--dry-run] <command> [options]
 *
 * Reads the app's log and config under %USERPROFILE%\.audio-capture and the
 * recordings in its output folders. `bin/ac` links here. See "Terminal
 * Access" in windows/audio-capture/README.md.
 */
import { Command } from "commander"
import { colorEnabled, formatRow, painter, type Paint } from "./format"
import {
  listRecordings, loadContext, parseSince, resolveId, type Context,
  type RecordingDetail,
} from "./recordings"
import { createSystem, spawnRun, type Run } from "./system"

export interface Io {
  out: (text: string) => void
  err: (text: string) => void
  env: Record<string, string | undefined>
  stderrIsTTY: boolean | undefined
  now: () => Date
}

export interface Deps {
  run: Run
  io: Io
}

const json = (value: unknown): string => JSON.stringify(value, null, 2)

interface State {
  ctx: Context | null
  recordings: RecordingDetail[] | null
}

/** Runs ac with argv (without the program name); returns the exit code. */
export const main = async (argv: string[], deps: Deps): Promise<number> => {
  const { io } = deps
  const paint: Paint = painter(colorEnabled(io.env, io.stderrIsTTY))
  const warn = (message: string) => io.err(`${paint("warning:", "warning")} ${message}`)
  const state: State = { ctx: null, recordings: null }
  const program = new Command("ac")

  const context = (): Context => {
    if (state.ctx) return state.ctx
    const dryRun = program.opts<{ dryRun?: boolean }>().dryRun === true
    const system = createSystem({ run: deps.run, dryRun, print: io.out })
    state.ctx = loadContext(system, warn)
    return state.ctx
  }
  const recordings = (): RecordingDetail[] => {
    state.recordings ??= listRecordings(context())
    return state.recordings
  }
  const find = (id: string): RecordingDetail =>
    resolveId(id, recordings(), (win) => context().system.toWsl(win))

  program
    .description("Find, open, and annotate audio-capture recordings.")
    .option("--dry-run", "print the commands open and --copy would run")
    .configureOutput({ writeOut: (s) => io.out(s.trimEnd()), writeErr: (s) => io.err(s.trimEnd()) })
    .exitOverride()

  program.command("last")
    .description("print the latest recording's path")
    .option("--win", "print the Windows path")
    .option("--copy", "copy the path to the Windows clipboard")
    .option("--json", "print the recording as JSON")
    .action((opts: { win?: boolean; copy?: boolean; json?: boolean }) => {
      const { recording } = find("last")
      const path = opts.win ? recording.win_path : recording.path
      if (opts.copy) context().system.copy(path)
      io.out(opts.json ? json(recording) : path)
    })

  program.command("ls")
    .description("list recordings, newest first")
    .option("--since <when>", "only since 30m, 12h, 2d, 1w, or 2026-11-01")
    .option("--limit <n>", "at most n recordings")
    .option("--json", "print a JSON array")
    .action((opts: { since?: string; limit?: string; json?: boolean }) => {
      let rows = recordings().map((detail) => detail.recording)
      if (opts.since !== undefined) {
        const since = parseSince(opts.since, io.now()).getTime()
        rows = rows.filter((r) => new Date(r.time).getTime() >= since)
      }
      if (opts.limit !== undefined) {
        const limit = Number(opts.limit)
        if (!Number.isInteger(limit) || limit < 0) {
          throw new Error(`invalid --limit ${JSON.stringify(opts.limit)}`)
        }
        rows = rows.slice(0, limit)
      }
      if (opts.json) io.out(json(rows))
      else for (const row of rows) io.out(formatRow(row))
    })

  try {
    await program.parseAsync(argv, { from: "user" })
    return 0
  } catch (error) {
    const err = error as Error & { code?: string; exitCode?: number }
    if (err.code?.startsWith("commander.")) {
      return err.code === "commander.helpDisplayed" ||
        err.code === "commander.version" ||
        err.code === "commander.help"
        ? 0
        : (err.exitCode ?? 1)
    }
    io.err(`ac: ${err.message}`)
    return 1
  }
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2), {
    run: spawnRun,
    io: {
      out: (text) => process.stdout.write(text + "\n"),
      err: (text) => process.stderr.write(text + "\n"),
      env: process.env,
      stderrIsTTY: process.stderr.isTTY,
      now: () => new Date(),
    },
  })
  process.exit(code)
}
