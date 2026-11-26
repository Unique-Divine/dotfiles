/**
 * The Codebase Memory repo manifest: the minimum set of checkouts under ~
 * to index on every machine where they are present, where each comes from,
 * and its personal `.cbmignore`. Codebase Memory's auto-index still adds any
 * other folder a session starts in.
 *
 * `.cbmignore` files are local (each repo lists them in .git/info/exclude),
 * so a new machine has none. This keeps a copy of each in `cbm/repos/` and
 * restores them, so a second machine indexes the same projects the same way.
 *
 * Usage: bun run cbm/repos.ts [--capture] [--add <dir>]
 *   [--restore [--clone] [--run]]
 *
 * With no flag it prints each repo's status. `--restore` prints the plan
 * (write `.cbmignore`, exclude it from Git; with `--clone`, also clone
 * missing checkouts) and applies it only with `--run`. Index afterwards with
 * `just cbm-reindex`, which skips repos that aren't on this machine.
 */
import { spawnSync } from "node:child_process"
import {
  appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { Command as Program } from "commander"

export interface RepoEntry {
  /** Directory under ~. Also the Codebase Memory project's last segment. */
  dir: string
  /** Clone URL; absent for folders that are not Git checkouts. */
  remote?: string
  note?: string
}

export interface Manifest {
  repos: RepoEntry[]
}

export type IgnoreState =
  | "tracked" | "in-sync" | "differs" | "unsaved" | "not-restored" | "none"

export interface RepoStatus {
  dir: string
  present: boolean
  ignore: IgnoreState
  indexed: boolean
}

export type Action =
  | { kind: "clone"; dir: string; remote: string }
  | { kind: "write-ignore"; dir: string; from: string }
  | { kind: "exclude"; dir: string }
  | { kind: "skip"; dir: string; reason: string }

export const manifestPath = join(import.meta.dir, "repos.json")
export const savedIgnoreDir = join(import.meta.dir, "repos")

export const savedIgnorePath = (dir: string, base = savedIgnoreDir): string =>
  join(base, `${dir}.cbmignore`)

export const projectName = (home: string, dir: string): string =>
  join(home, dir).replace(/^\//, "").replace(/[/.]/g, "-")

export const parseManifest = (text: string): Manifest => {
  const raw = JSON.parse(text)
  if (!Array.isArray(raw?.repos)) throw new Error("repos.json: no repos list")
  const seen = new Set<string>()
  const repos = raw.repos.map((r: unknown, i: number): RepoEntry => {
    const e = r as RepoEntry
    if (typeof e?.dir !== "string" || !/^[\w.-]+$/.test(e.dir)) {
      throw new Error(`repos.json: entry ${i} needs a plain dir name`)
    }
    if (seen.has(e.dir)) throw new Error(`repos.json: ${e.dir} is listed twice`)
    seen.add(e.dir)
    return { dir: e.dir, remote: e.remote || undefined, note: e.note }
  })
  return { repos }
}

export const loadManifest = (path = manifestPath): Manifest =>
  parseManifest(readFileSync(path, "utf8"))

/** Dirs to index, in manifest order. */
export const manifestDirs = (path = manifestPath): string[] =>
  loadManifest(path).repos.map((r) => r.dir)

/**
 * Compare a repo's local `.cbmignore` with the saved copy.
 * `tracked`: the repo commits its own, so there is nothing to save.
 */
export const ignoreState = (o: {
  tracked: boolean; local?: string; saved?: string
}): IgnoreState => {
  if (o.tracked) return "tracked"
  if (o.local === undefined) {
    return o.saved === undefined ? "none" : "not-restored"
  }
  if (o.saved === undefined) return "unsaved"
  return o.local === o.saved ? "in-sync" : "differs"
}

/** What `--restore` does for one repo, given what is on disk. */
export const planRepo = (e: RepoEntry, disk: {
  present: boolean; isGit: boolean; ignore: IgnoreState; excluded: boolean
}, clone = false): Action[] => {
  if (!disk.present) {
    if (!clone) return [{ kind: "skip", dir: e.dir, reason: "not on this machine" }]
    if (!e.remote) {
      return [{ kind: "skip", dir: e.dir, reason: "missing; no remote to clone" }]
    }
    // After the clone the repo has no .cbmignore and no exclude line yet.
    return [
      { kind: "clone", dir: e.dir, remote: e.remote },
      ...planRepo(e, { present: true, isGit: true, excluded: false,
        ignore: disk.ignore === "none" ? "none" : "not-restored" }),
    ]
  }
  const actions: Action[] = []
  if (disk.ignore === "not-restored") {
    actions.push({ kind: "write-ignore", dir: e.dir,
      from: savedIgnorePath(e.dir) })
  }
  if (disk.ignore === "differs") {
    actions.push({ kind: "skip", dir: e.dir,
      reason: "local .cbmignore differs from the saved one; --capture keeps "
        + "the local one, or delete it to restore" })
  }
  const hasIgnore = disk.ignore !== "none" && disk.ignore !== "tracked"
  if (disk.isGit && hasIgnore && !disk.excluded) {
    actions.push({ kind: "exclude", dir: e.dir })
  }
  return actions
}

// ------------------------------------------------------------------- disk

const read = (path: string): string | undefined =>
  existsSync(path) ? readFileSync(path, "utf8") : undefined

const git = (cwd: string, args: string[]) =>
  spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" })

const isGitRepo = (root: string): boolean =>
  git(root, ["rev-parse", "--is-inside-work-tree"]).stdout.trim() === "true"
    && git(root, ["rev-parse", "--show-toplevel"]).stdout.trim() === root

const isTracked = (root: string): boolean =>
  git(root, ["ls-files", "--error-unmatch", ".cbmignore"]).status === 0

const excludeFile = (root: string): string =>
  join(root, git(root, ["rev-parse", "--git-path", "info/exclude"])
    .stdout.trim())

const isExcluded = (root: string): boolean =>
  /^\/?\.cbmignore$/m.test(read(excludeFile(root)) ?? "")

const cacheDir = (): string =>
  join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"),
    "codebase-memory-mcp")

export const inspect = (e: RepoEntry, home = homedir()) => {
  const root = join(home, e.dir)
  const present = existsSync(root)
  const isGit = present && isGitRepo(root)
  const ignore = ignoreState({
    tracked: isGit && isTracked(root),
    local: present ? read(join(root, ".cbmignore")) : undefined,
    saved: read(savedIgnorePath(e.dir)),
  })
  return {
    root, present, isGit, ignore,
    excluded: isGit && isExcluded(root),
    indexed: existsSync(join(cacheDir(), `${projectName(home, e.dir)}.db`)),
  }
}

const apply = (a: Action, home: string): void => {
  const root = join(home, a.dir)
  if (a.kind === "clone") {
    const r = spawnSync("git", ["clone", a.remote, root], { stdio: "inherit" })
    if (r.status !== 0) throw new Error(`git clone ${a.remote} failed`)
  } else if (a.kind === "write-ignore") {
    copyFileSync(a.from, join(root, ".cbmignore"))
  } else if (a.kind === "exclude") {
    const file = excludeFile(root)
    mkdirSync(dirname(file), { recursive: true })
    const text = read(file) ?? ""
    appendFileSync(file, `${text && !text.endsWith("\n") ? "\n" : ""}/.cbmignore\n`)
  }
}

const describe = (a: Action): string => {
  switch (a.kind) {
    case "clone": return `clone ${a.remote} -> ~/${a.dir}`
    case "write-ignore": return `write ~/${a.dir}/.cbmignore`
    case "exclude": return `add /.cbmignore to ~/${a.dir}/.git/info/exclude`
    case "skip": return `skip ~/${a.dir}: ${a.reason}`
  }
}

// -------------------------------------------------------------------- CLI

const printStatus = (m: Manifest): void => {
  const w = Math.max(...m.repos.map((r) => r.dir.length))
  console.log(`${"repo".padEnd(w)}  on disk  indexed  .cbmignore`)
  for (const e of m.repos) {
    const s = inspect(e)
    console.log(`${e.dir.padEnd(w)}  ${(s.present ? "yes" : "NO").padEnd(7)}`
      + `  ${(s.indexed ? "yes" : "no").padEnd(7)}  ${s.ignore}`)
  }
}

const capture = (m: Manifest): void => {
  mkdirSync(savedIgnoreDir, { recursive: true })
  for (const e of m.repos) {
    const s = inspect(e)
    if (s.ignore === "unsaved" || s.ignore === "differs") {
      copyFileSync(join(s.root, ".cbmignore"), savedIgnorePath(e.dir))
      console.log(`saved ~/${e.dir}/.cbmignore`)
    }
  }
}

const add = (dir: string, path = manifestPath): void => {
  const m = loadManifest(path)
  if (m.repos.some((r) => r.dir === dir)) {
    console.log(`${dir} is already in the manifest`)
    return
  }
  const root = join(homedir(), dir)
  if (!existsSync(root)) throw new Error(`~/${dir} does not exist`)
  const remote = isGitRepo(root)
    ? git(root, ["remote", "get-url", "origin"]).stdout.trim() || undefined
    : undefined
  // Keep Boku last: reindex links it after the repos it points into.
  const at = m.repos.findIndex((r) => r.dir === "boku")
  m.repos.splice(at === -1 ? m.repos.length : at, 0, { dir, remote })
  writeFileSync(path, `${JSON.stringify(m, null, 2)}\n`)
  console.log(`added ${dir}${remote ? ` (${remote})` : ""}`)
  capture({ repos: [{ dir, remote }] })
}

const restore = (m: Manifest, run: boolean, clone: boolean): void => {
  const home = homedir()
  const plan = m.repos.flatMap((e) => planRepo(e, inspect(e, home), clone))
  if (!plan.length) {
    console.log("nothing to restore")
    return
  }
  for (const a of plan) {
    console.log(`${run && a.kind !== "skip" ? "" : "would "}${describe(a)}`)
    if (run) apply(a, home)
  }
  if (!run) console.log("\ndry run: pass --run to apply")
  else console.log("\nnext: just cbm-reindex")
}

if (import.meta.main) {
  const opts = new Program()
    .description("Manage the Codebase Memory repo manifest.")
    .option("--capture", "save each repo's local .cbmignore into dotfiles")
    .option("--add <dir>", "add ~/<dir> to the manifest and save its .cbmignore")
    .option("--restore", "clone missing repos and restore .cbmignore files")
    .option("--clone", "with --restore, also clone missing checkouts")
    .option("--run", "apply --restore (default: print the plan)")
    .parse().opts<{ capture?: boolean; add?: string; restore?: boolean
      run?: boolean; clone?: boolean }>()
  try {
    if (opts.add) add(opts.add)
    else if (opts.capture) capture(loadManifest())
    else if (opts.restore) restore(loadManifest(), !!opts.run, !!opts.clone)
    else printStatus(loadManifest())
  } catch (err) {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  }
}
