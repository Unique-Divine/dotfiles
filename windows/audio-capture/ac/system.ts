/**
 * The one place `ac` runs other programs: wslpath, cmd.exe, powershell.exe,
 * explorer.exe, clip.exe, and fzf. Everything else in `ac` is plain file
 * reads and pure functions, and takes a `WinSystem` to reach Windows.
 *
 * Tests put stub executables first on PATH; the real `spawnRun` finds them
 * by name like any other program.
 */
import { existsSync } from "node:fs"

export interface RunOptions {
  /** Text for the program's stdin; without it, stdin is closed. */
  input?: string
  /** Let the program draw on the terminal through stderr (fzf). */
  interactive?: boolean
}

export interface RunResult {
  /** Exit code; 127 when the program isn't on PATH. */
  code: number
  stdout: string
  stderr: string
}

export type Run = (argv: string[], options?: RunOptions) => RunResult

/** Runs a program synchronously with Bun.spawnSync. */
export const spawnRun: Run = (argv, options = {}) => {
  const [program, ...rest] = argv
  const resolved = program ? Bun.which(program) : null
  if (!program || !resolved) {
    return { code: 127, stdout: "", stderr: `${program}: not found on PATH` }
  }
  // cmd.exe warns about a UNC working folder (\\wsl$\...); start Windows
  // programs from the C: drive when it is mounted.
  const cwd = program.endsWith(".exe") && existsSync("/mnt/c")
    ? "/mnt/c"
    : undefined
  const result = Bun.spawnSync({
    cmd: [resolved, ...rest],
    cwd,
    stdin: options.input === undefined
      ? "ignore"
      : new TextEncoder().encode(options.input),
    stdout: "pipe",
    stderr: options.interactive ? "inherit" : "pipe",
  })
  return {
    code: result.exitCode ?? 1,
    stdout: result.stdout?.toString() ?? "",
    stderr: result.stderr?.toString() ?? "",
  }
}

/** Shell-style quoting, for printing a command a person could paste. */
export const quoteArg = (arg: string): string =>
  /^[\w@%+=:,./\\-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'"'"'`)}'`

export const formatCommand = (argv: string[], input?: string): string => {
  const command = argv.map(quoteArg).join(" ")
  return input === undefined ? command : `printf %s ${quoteArg(input)} | ${command}`
}

/** A Windows path and the WSL path of the same folder. */
export interface PathPair {
  win: string
  wsl: string
}

const trimSlash = (path: string, sep: string): string =>
  path.length > 1 && path.endsWith(sep) ? path.slice(0, -1) : path

/**
 * Maps a WSL path to Windows through a known folder pair, or returns null.
 * Pure, so listing many files needs no wslpath call per file.
 */
export const wslToWinVia = (path: string, pairs: PathPair[]): string | null => {
  for (const pair of pairs) {
    const root = trimSlash(pair.wsl, "/")
    if (path === root || path.startsWith(root + "/")) {
      const rest = path.slice(root.length).replaceAll("/", "\\")
      return trimSlash(pair.win, "\\") + rest
    }
  }
  return null
}

/** Maps a Windows path to WSL through a known folder pair, or null. */
export const winToWslVia = (path: string, pairs: PathPair[]): string | null => {
  const lower = path.toLowerCase()
  for (const pair of pairs) {
    const root = trimSlash(pair.win, "\\")
    const rootLower = root.toLowerCase()
    if (lower === rootLower || lower.startsWith(rootLower + "\\")) {
      const rest = path.slice(root.length).replaceAll("\\", "/")
      return trimSlash(pair.wsl, "/") + rest
    }
  }
  return null
}

/** Folder tokens of `[output] dir` and their .NET SpecialFolder names. */
export const FOLDER_TOKENS: Record<string, string> = {
  documents: "MyDocuments",
  music: "MyMusic",
  videos: "MyVideos",
  desktop: "DesktopDirectory",
  home: "UserProfile",
  appdata: "ApplicationData",
  localappdata: "LocalApplicationData",
}

export interface FzfResult {
  code: number
  stdout: string
}

export interface WinSystem {
  /** %USERPROFILE% as a Windows path. */
  profileWin(): string
  /** Windows paths of the folder tokens, by token name. */
  knownFolders(): Record<string, string>
  toWsl(winPath: string): string
  toWin(wslPath: string): string
  /** Remembers a folder pair so paths under it convert without wslpath. */
  addPair(pair: PathPair): void
  /** Runs explorer.exe with these arguments (prints them on --dry-run). */
  explorer(args: string[]): void
  /** Puts text on the Windows clipboard (prints the command on --dry-run). */
  copy(text: string): void
  fzf(lines: string[], args: string[]): FzfResult
}

export interface SystemOptions {
  run: Run
  dryRun: boolean
  /** Where --dry-run prints commands. */
  print: (line: string) => void
}

const firstLine = (text: string): string =>
  text.replaceAll("\r", "").split("\n")[0]?.trim() ?? ""

/** Builds the WinSystem on top of a runner. */
export const createSystem = (options: SystemOptions): WinSystem => {
  const { run, dryRun, print } = options
  const pairs: PathPair[] = []
  let profile: string | null = null
  let folders: Record<string, string> | null = null

  const must = (argv: string[], what: string): string => {
    const result = run(argv)
    if (result.code !== 0) {
      const detail = firstLine(result.stderr) || `exit code ${result.code}`
      throw new Error(`${what} failed: ${detail}`)
    }
    return result.stdout
  }

  const wslpath = (flag: "-u" | "-w", path: string): string => {
    const out = firstLine(must(["wslpath", flag, path], `wslpath ${flag}`))
    if (out === "") throw new Error(`wslpath ${flag} printed nothing for ${path}`)
    return out
  }

  const system: WinSystem = {
    profileWin() {
      if (profile !== null) return profile
      const out = firstLine(
        must(["cmd.exe", "/c", "echo %USERPROFILE%"], "reading %USERPROFILE%"),
      )
      if (out === "" || out.includes("%USERPROFILE%")) {
        throw new Error("cmd.exe did not expand %USERPROFILE%")
      }
      profile = out
      return out
    },
    knownFolders() {
      if (folders !== null) return folders
      const names = Object.values(FOLDER_TOKENS).map((n) => `'${n}'`).join(",")
      const script =
        `$f=[ordered]@{}; foreach($n in ${names})` +
        `{ $f[$n]=[Environment]::GetFolderPath($n) }; $f | ConvertTo-Json -Compress`
      const out = must(
        ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive",
          "-Command", script],
        "reading Windows known folders",
      )
      const parsed = JSON.parse(out.replaceAll("\r", "").trim()) as
        Record<string, string>
      const byToken: Record<string, string> = {}
      for (const [token, name] of Object.entries(FOLDER_TOKENS)) {
        const value = parsed[name]
        if (typeof value === "string" && value !== "") byToken[token] = value
      }
      folders = byToken
      return byToken
    },
    toWsl(winPath) {
      const mapped = winToWslVia(winPath, pairs)
      return mapped ?? wslpath("-u", winPath)
    },
    toWin(wslPath) {
      const mapped = wslToWinVia(wslPath, pairs)
      return mapped ?? wslpath("-w", wslPath)
    },
    addPair(pair) {
      pairs.push(pair)
    },
    explorer(args) {
      const argv = ["explorer.exe", ...args]
      if (dryRun) {
        print(formatCommand(argv))
        return
      }
      // Explorer exits 1 after handing the request to a running Explorer.
      const result = run(argv)
      if (result.code !== 0 && result.code !== 1) {
        throw new Error(`explorer.exe exited ${result.code}`)
      }
    },
    copy(text) {
      const argv = ["clip.exe"]
      if (dryRun) {
        print(formatCommand(argv, text))
        return
      }
      const result = run(argv, { input: text })
      if (result.code !== 0) {
        throw new Error(`clip.exe failed: ${firstLine(result.stderr)}`)
      }
    },
    fzf(lines, args) {
      const result = run(["fzf", ...args], {
        input: lines.join("\n") + "\n",
        interactive: true,
      })
      if (result.code === 127) throw new Error("fzf is not on PATH")
      return { code: result.code, stdout: result.stdout }
    },
  }
  return system
}
