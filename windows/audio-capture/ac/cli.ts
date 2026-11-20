#!/usr/bin/env bun
/**
 * ac: find, open, and annotate audio-capture recordings from WSL.
 *
 * Usage: ac [--dry-run] <command> [options]
 *
 * Reads the app's log and config under %USERPROFILE%\.audio-capture and the
 * recordings in its output folders. Sync links ~/.local/bin/ac here. See
 * "Terminal Access" in windows/audio-capture/README.md.
 */
import { Command } from "commander"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { indexEntry, updateIndex } from "./catalog"
import {
  colorEnabled, formatDetail, formatRow, painter, type Paint,
} from "./format"
import {
  listRecordings, loadContext, outputDirFor, parseSince, resolveId,
  type Context, type Recording, type RecordingDetail,
} from "./recordings"
import {
  applySidecarChange, readSidecar, sidecarPath, writeSidecar,
  type SidecarChange,
} from "./sidecar"
import { createSystem, quoteArg, spawnRun, type Run } from "./system"

export interface Io {
  out: (text: string) => void
  err: (text: string) => void
  env: Record<string, string | undefined>
  stdoutIsTTY: boolean | undefined
  /** Asks a question on the terminal; null when there's no answer. */
  ask: (question: string) => string | null
  stderrIsTTY: boolean | undefined
  now: () => Date
}

export interface Deps {
  run: Run
  io: Io
}

export const PICK_KEYS = ["ctrl-o", "ctrl-y", "ctrl-n"]

/** fzf arguments for `ac pick`; the preview runs `ac show` on field 1. */
export const pickArgs = (showCommand: string[]): string[] => [
  "--expect=" + PICK_KEYS.join(","),
  "--delimiter=\t",
  "--with-nth=2",
  "--no-sort",
  "--preview=" + [...showCommand, "show", "{1}"].map(quoteArg).join(" ")
    .replace("'{1}'", "{1}"),
  "--preview-window=right,55%,wrap",
  "--header=enter: print path  ctrl-o: open  ctrl-y: copy path  ctrl-n: note",
]

const json = (value: unknown): string => JSON.stringify(value, null, 2)

/** `ac show --json`: the recording row plus file, log, and sidecar facts. */
export const showJson = (detail: RecordingDetail) => ({
  recording: detail.recording,
  file: {
    path: detail.recording.path,
    win_path: detail.recording.win_path,
    size_bytes: detail.recording.size_bytes,
    modified: detail.recording.modified,
  },
  log: detail.facts,
  sidecar: detail.sidecar,
  sidecar_path: detail.sidecar_path,
  sidecar_error: detail.sidecar_error,
})

interface State {
  ctx: Context | null
  recordings: RecordingDetail[] | null
}

/** Runs ac with argv (without the program name); returns the exit code. */
export const main = async (argv: string[], deps: Deps): Promise<number> => {
  const { io } = deps
  const paint: Paint = painter(colorEnabled(io.env, io.stdoutIsTTY))
  const paintErr: Paint = painter(colorEnabled(io.env, io.stderrIsTTY))
  const warn = (message: string) =>
    io.err(`${paintErr("warning:", "warning")} ${message}`)
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

  const saveNote = (recording: Recording, change: SidecarChange): void => {
    const next = applySidecarChange(readSidecar(recording.path), recording.name,
      change, io.now())
    writeSidecar(recording.path, next)
    io.out(`💚 ${paint("Saved", "success")} ${sidecarPath(recording.path)}`)
    // Keep an existing index current; never create one as a side effect.
    const indexPath = join(context().stateDir, "index.jsonl")
    if (existsSync(indexPath)) {
      state.recordings = null
      updateIndex(indexPath, recordings().map(indexEntry), false)
    }
  }

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

  program.command("show")
    .description("print everything known about a recording")
    .argument("<id>", "last, a name prefix such as 26-11-18__1137, or a path")
    .option("--json", "print JSON")
    .action((id: string, opts: { json?: boolean }) => {
      const detail = find(id)
      io.out(opts.json ? json(showJson(detail)) : formatDetail(detail))
    })

  program.command("open")
    .description("show a recording in Explorer, or this month's folder")
    .argument("[id]", "last, a name prefix, or a path")
    .action((id: string | undefined) => {
      const ctx = context()
      if (id !== undefined) {
        const { recording } = find(id)
        ctx.system.explorer([`/select,${recording.win_path}`])
        return
      }
      const month = outputDirFor(ctx, io.now())
      if (month === null) throw new Error("the recordings folder is unknown")
      let folder = month
      if (!existsSync(month)) {
        warn(`no folder for this month yet: ${month}`)
        if (!ctx.root || !existsSync(ctx.root.wsl)) {
          throw new Error(`recordings folder not found: ${ctx.root?.wsl ?? month}`)
        }
        folder = ctx.root.wsl
      }
      ctx.system.explorer([ctx.system.toWin(folder)])
    })

  program.command("note")
    .description("write or update a recording's sidecar")
    .argument("<id>", "last, a name prefix, or a path")
    .argument("[text]", 'the note; "" clears it')
    .option("--tag <tags>", "add comma-separated tags")
    .option("--link <url>", "add a link (repeatable)",
      (value: string, all: string[]) => [...all, value], [] as string[])
    .action((id: string, text: string | undefined,
      opts: { tag?: string; link: string[] }) => {
      const tags = opts.tag?.split(",") ?? []
      if (text === undefined && tags.length === 0 && opts.link.length === 0) {
        throw new Error('nothing to change; give a note, --tag, or --link')
      }
      saveNote(find(id).recording,
        { note: text, addTags: tags, addLinks: opts.link })
    })

  program.command("pick")
    .description("choose a recording with fzf, then print, open, copy, or note it")
    .option("--limit <n>", "offer at most n recordings", "200")
    .action((opts: { limit: string }) => {
      const ctx = context()
      const rows = recordings().slice(0, Number(opts.limit) || 200)
      if (rows.length === 0) throw new Error("no recordings found")
      const lines = rows.map(({ recording }) =>
        `${recording.name}\t${formatRow(recording)}`)
      const result = ctx.system.fzf(lines,
        pickArgs([process.execPath, import.meta.path]))
      // 130: Esc or ctrl-c; 1: nothing matched.
      if (result.code === 130 || result.code === 1) return
      if (result.code !== 0) throw new Error(`fzf exited ${result.code}`)
      const [key = "", line = ""] = result.stdout.replace(/\n$/, "").split("\n")
      const name = line.split("\t")[0] ?? ""
      if (name === "") return
      const { recording } = find(name)
      switch (key) {
        case "ctrl-o":
          ctx.system.explorer([`/select,${recording.win_path}`])
          break
        case "ctrl-y":
          ctx.system.copy(recording.win_path)
          io.out(recording.win_path)
          break
        case "ctrl-n": {
          const text = io.ask(`Note for ${recording.name}: `)
          if (text === null || text.trim() === "") {
            warn("no note given; nothing saved")
            break
          }
          saveNote(recording, { note: text })
          break
        }
        default:
          io.out(recording.path)
      }
    })

  program.command("index")
    .description("write the derived index.jsonl in %USERPROFILE%\\.audio-capture")
    .option("--rebuild", "ignore the old index and write it from scratch")
    .action((opts: { rebuild?: boolean }) => {
      const ctx = context()
      if (!existsSync(ctx.stateDir)) {
        throw new Error(`no audio-capture folder at ${ctx.stateDir}`)
      }
      const path = join(ctx.stateDir, "index.jsonl")
      const plan = updateIndex(path, recordings().map(indexEntry),
        opts.rebuild === true)
      io.out(`💚 ${paint("Indexed", "success")} ${path}: ` +
        `${plan.added} added, ${plan.updated} updated, ${plan.removed} removed, ` +
        `${plan.unchanged} unchanged`)
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
      stdoutIsTTY: process.stdout.isTTY,
      stderrIsTTY: process.stderr.isTTY,
      now: () => new Date(),
      ask: (question) => prompt(question),
    },
  })
  process.exit(code)
}
