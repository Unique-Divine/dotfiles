#!/usr/bin/env bun
/**
 * xclip replacement that reads and writes the Windows clipboard on WSL.
 *
 * The real xclip writes to the X11 clipboard, which never reaches Windows.
 * This program implements the xclip 0.13 command line on top of `pbcopy`
 * and `pbpaste` (the `wsl-clipboard` bridge) and does not need the real
 * xclip installed. Windows has one clipboard, so every selection (primary,
 * secondary, clipboard, buffer-cut) maps to it.
 *
 * `bin/xclip` is a symlink to this file. See "xclip replacement" in
 * README.md for the supported options and known differences.
 */

import { readFileSync } from "node:fs"

export type Mode = "in" | "out"

export type Selection = "primary" | "secondary" | "clipboard" | "buffer-cut"

export interface XclipArgs {
  mode: Mode
  selection: Selection
  /** Value of -target, or null when not given. */
  target: string | null
  filter: boolean
  rmlastnl: boolean
  verbose: boolean
  help: boolean
  version: boolean
  /** Input files, in order. Ignored in output mode, as in xclip. */
  files: string[]
}

/** Option names from xclip 0.13, without the leading dash. */
export const OPTION_NAMES: readonly string[] = [
  "in",
  "out",
  "loops",
  "display",
  "help",
  "selection",
  "noutf8",
  "target",
  "rmlastnl",
  "version",
  "silent",
  "quiet",
  "verbose",
  "filter",
]

/** Options that consume the following argument as their value. */
export const VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "loops",
  "display",
  "selection",
  "target",
])

/** Targets the Windows clipboard bridge can carry as text. */
export const TEXT_TARGETS: ReadonlySet<string> = new Set([
  "UTF8_STRING",
  "STRING",
  "TEXT",
  "COMPOUND_TEXT",
  "text/plain",
  "text/plain;charset=utf-8",
  "text/plain;charset=UTF-8",
])

/** Output of `xclip -o -t TARGETS`, matching xclip 0.13 for text. */
export const TARGETS_LISTING = "TARGETS\nUTF8_STRING\n"

/** An error that maps to an xclip exit code and stderr message. */
export class XclipError extends Error {
  constructor(
    message: string,
    readonly exitCode: number = 1,
  ) {
    super(message)
  }
}

/**
 * Resolve a command-line word to a full option name the way xclip's Xlib
 * parser does: an exact name, or a prefix that matches exactly one name.
 * Returns null for non-options and ambiguous prefixes such as `-s`.
 */
export const resolveOption = (word: string): string | null => {
  if (!word.startsWith("-") || word.length < 2) return null
  const key = word.slice(1)
  if (OPTION_NAMES.includes(key)) return key
  const matches = OPTION_NAMES.filter((name) => name.startsWith(key))
  return matches.length === 1 ? matches[0]! : null
}

/**
 * Map a -selection value to a selection. xclip reads only the first
 * letter, case-insensitively, and falls back to primary.
 */
export const selectionFromValue = (value: string): Selection => {
  switch (value.charAt(0).toLowerCase()) {
    case "c":
      return "clipboard"
    case "s":
      return "secondary"
    case "b":
      return "buffer-cut"
    default:
      return "primary"
  }
}

/**
 * Parse xclip arguments. Repeated options keep the last value, and words
 * that are not options become input files. A value option at the end of
 * the arguments, with nothing to consume, is also treated as a file.
 */
export const parseArgs = (argv: readonly string[]): XclipArgs => {
  const args: XclipArgs = {
    mode: "in",
    selection: "primary",
    target: null,
    filter: false,
    rmlastnl: false,
    verbose: false,
    help: false,
    version: false,
    files: [],
  }

  for (let i = 0; i < argv.length; i++) {
    const word = argv[i]!
    const option = resolveOption(word)

    if (option === null) {
      args.files.push(word)
      continue
    }

    if (VALUE_OPTIONS.has(option)) {
      if (i + 1 >= argv.length) {
        args.files.push(word)
        continue
      }
      const value = argv[++i]!
      if (option === "selection") args.selection = selectionFromValue(value)
      if (option === "target") args.target = value
      continue
    }

    switch (option) {
      case "in":
        args.mode = "in"
        break
      case "out":
        args.mode = "out"
        break
      case "help":
        args.help = true
        break
      case "version":
        args.version = true
        break
      case "filter":
        args.filter = true
        break
      case "rmlastnl":
        args.rmlastnl = true
        break
      case "verbose":
        args.verbose = true
        break
      // noutf8, silent, and quiet change nothing for the Windows bridge.
    }
  }

  return args
}

/** Remove one trailing newline, if present. */
export const stripLastNewline = (data: Uint8Array): Uint8Array =>
  data.length > 0 && data[data.length - 1] === 0x0a
    ? data.subarray(0, data.length - 1)
    : data

/** Fail unless the target, if any, can be carried as text. */
export const requireTextTarget = (target: string | null): void => {
  if (target !== null && !TEXT_TARGETS.has(target)) {
    throw new XclipError(`target '${target}' is not supported (text only)`)
  }
}

export const HELP_TEXT = `Usage: xclip [OPTION] [FILE]...
Read or write the Windows clipboard (xclip 0.13 command line).
Every selection maps to the Windows clipboard through pbcopy and pbpaste.

  -i, -in          read text into the clipboard from standard input or files
                   (default)
  -o, -out         print the clipboard to standard out
  -l, -loops       accepted and ignored
  -d, -display     accepted and ignored
  -h, -help        usage information
      -selection   "primary", "secondary", "clipboard", or "buffer-cut";
                   all map to the Windows clipboard
      -noutf8      accepted and ignored
  -t, -target      text targets only; -o -t TARGETS lists them
  -r, -rmlastnl    remove the last newline character if present
  -f, -filter      also print the input to standard out
      -version     version information
      -silent      accepted and ignored
      -quiet       accepted and ignored
      -verbose     running commentary
`

export const VERSION_TEXT =
  "xclip version 0.13 (dotfiles Windows clipboard bridge via pbcopy/pbpaste)\n"

const errnoMessages: Record<string, string> = {
  ENOENT: "No such file or directory",
  EACCES: "Permission denied",
  EISDIR: "Is a directory",
}

/** Read the input files, or stdin when there are none. */
const readInput = async (files: readonly string[]): Promise<Uint8Array> => {
  if (files.length === 0) return await Bun.stdin.bytes()

  const chunks: Uint8Array[] = []
  for (const file of files) {
    try {
      chunks.push(readFileSync(file))
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? ""
      throw new XclipError(`${file}: ${errnoMessages[code] ?? String(err)}`)
    }
  }
  return Buffer.concat(chunks)
}

/** Resolve a helper command on PATH or fail with a clear message. */
const requireCommand = (name: string): string => {
  const path = Bun.which(name)
  if (path === null) throw new XclipError(`${name} not found on PATH`)
  return path
}

/** Write bytes to the Windows clipboard. */
const copyToWindows = async (data: Uint8Array): Promise<void> => {
  // pbcopy rejects empty input; clip.exe with no input clears the clipboard.
  const command =
    data.length > 0 ? requireCommand("pbcopy") : requireCommand("clip.exe")
  const proc = Bun.spawn([command], {
    stdin: data.length > 0 ? new Blob([new Uint8Array(data)]) : "ignore",
    stdout: "ignore",
    stderr: "inherit",
  })
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    throw new XclipError(`${command} exited with status ${exitCode}`)
  }
}

/** Read the Windows clipboard as bytes. */
const pasteFromWindows = async (): Promise<Uint8Array> => {
  const proc = Bun.spawn([requireCommand("pbpaste")], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit",
  })
  const [data, exitCode] = await Promise.all([
    new Response(proc.stdout).bytes(),
    proc.exited,
  ])
  if (exitCode !== 0) {
    throw new XclipError(`pbpaste exited with status ${exitCode}`)
  }
  return data
}

/** Run xclip with the given arguments. Returns the exit code. */
export const run = async (argv: readonly string[]): Promise<number> => {
  const args = parseArgs(argv)

  if (args.help) {
    process.stderr.write(HELP_TEXT)
    return 0
  }
  if (args.version) {
    process.stderr.write(VERSION_TEXT)
    return 0
  }

  try {
    if (args.verbose) {
      process.stderr.write(
        `Using selection: ${args.selection} (Windows clipboard)\n`,
      )
    }

    if (args.mode === "out") {
      if (args.target === "TARGETS") {
        await Bun.write(Bun.stdout, TARGETS_LISTING)
        return 0
      }
      requireTextTarget(args.target)
      const data = await pasteFromWindows()
      await Bun.write(Bun.stdout, args.rmlastnl ? stripLastNewline(data) : data)
      return 0
    }

    requireTextTarget(args.target)
    const input = await readInput(args.files)
    const data = args.rmlastnl ? stripLastNewline(input) : input
    await copyToWindows(data)
    if (args.filter) await Bun.write(Bun.stdout, data)
    return 0
  } catch (err) {
    if (!(err instanceof XclipError)) throw err
    process.stderr.write(`xclip: ${err.message}\n`)
    return err.exitCode
  }
}

if (import.meta.main) {
  process.exit(await run(process.argv.slice(2)))
}
