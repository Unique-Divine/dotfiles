/**
 * Cross-repo map: collect the links between the Codebase Memory projects and
 * serve them as one page.
 *
 * Codebase Memory links repos only through service calls it can match
 * (CROSS_* edges), which misses most of how these repos depend on each
 * other. This adds the links each repo already declares:
 *
 * - code imports of another repo's Go module, npm package, or Rust crate;
 * - CROSS_* edges from the Codebase Memory graph;
 * - Markdown references to another repo's files (`~/repo/...`, GitHub URLs).
 *
 * Usage: bun run cbm/xrepo.ts [--json] [--serve [port]]
 *
 * Projects come from the Codebase Memory store
 * (`~/.cache/codebase-memory-mcp`). Every read is local and read-only.
 */
import { spawnSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join, posix } from "node:path"
import { Database } from "bun:sqlite"
import { Command as Program } from "commander"
import { manifestDirs } from "./repos"

export type LinkKind =
  | "go-import" | "npm-import" | "crate-dep" | "cbm-call" | "doc-ref"

export interface Link {
  kind: LinkKind
  fromRepo: string
  fromFile: string
  line: number
  toRepo: string
  /** Path inside the target repo, when the link names one. */
  toPath: string
  /** Module, package, crate, URL path, or GitHub URL that made the link. */
  via: string
  /** A guess the source can't back: see isWeakCbmMatch. */
  weak?: boolean
  /** Doc references: the path no longer exists in the target checkout. */
  missing?: boolean
}

export interface Repo {
  name: string
  root: string
  project: string
  /** "owner/name" of the origin remote, lowercase. */
  remote: string
  goModules: { path: string; dir: string }[]
  npmPackages: { name: string; dir: string }[]
  crates: { name: string; dir: string }[]
  /** Globs that drop submodules duplicating another indexed repo. */
  skipGlobs: string[]
}

export interface CrossRepoMap {
  generatedAt: string
  repos: Omit<Repo, "skipGlobs">[]
  links: Link[]
}

/** Older docs still use these owners for repos that moved. */
const extraOwners = ["nibiruchain"]

/** Folders under ~ that held checkouts and worktrees before (as in ~/ki/boku). */
const oldCheckoutRoots = ["ki"]

const sourceGlobs = {
  go: ["*.go"],
  npm: ["*.{ts,tsx,js,jsx,mjs,cjs,astro,vue,svelte}"],
  rust: ["*.rs", "Cargo.toml"],
  docs: ["*.{md,mdx}"],
}

// ---------------------------------------------------------------- parsing

export const parseGoModule = (text: string): string | undefined =>
  /^module\s+(\S+)/m.exec(text)?.[1]

export const parseCargoName = (text: string): string | undefined => {
  const pkg = /^\[package\]([\s\S]*?)(?=^\[|$(?![\s\S]))/m.exec(text)?.[1]
  return pkg ? /^name\s*=\s*"([^"]+)"/m.exec(pkg)?.[1] : undefined
}

/** Scoped names only: bare names like "docs" or "web-app" are ambiguous. */
export const parseNpmName = (text: string): string | undefined => {
  try {
    const name = JSON.parse(text)?.name
    return typeof name === "string" && name.startsWith("@") ? name : undefined
  } catch {
    return undefined
  }
}

/** Crate names with a separator; single words like "utils" collide. */
export const isDistinctCrate = (name: string): boolean => /[-_]/.test(name)

export const parseRemote = (url: string): string => {
  const m = /github\.com[:/]([^/]+)\/([^/\s]+?)(?:\.git)?\s*$/.exec(url.trim())
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : ""
}

/** Parse one `rg -n -o --no-heading` line: file:line:match. */
export const parseRgLine = (
  line: string,
): { file: string; line: number; match: string } | undefined => {
  const m = /^(.*?):(\d+):(.*)$/.exec(line)
  return m ? { file: m[1], line: Number(m[2]), match: m[3] } : undefined
}

export const escapeRegex = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")

/** The package that owns an import specifier: exact, or a subpath of it. */
export const ownerOf = <T extends { key: string }>(
  spec: string, owners: T[],
): T | undefined =>
  owners
    .filter((o) => spec === o.key || spec.startsWith(`${o.key}/`))
    .sort((a, b) => b.key.length - a.key.length)[0]

export const joinRepoPath = (dir: string, sub: string): string =>
  posix.normalize(posix.join(dir || ".", sub)).replace(/^\.\/?/, "")

/**
 * Turn a Markdown reference into a repo-relative path.
 * GitHub: /owner/name/(blob|tree)/<ref>/<path>; local: ~/repo/<path>.
 */
export const docRefPath = (rest: string): string => {
  const gh = /^\/(?:blob|tree)\/[^/]+\/(.+)$/.exec(rest)
  const path = gh ? gh[1] : rest.replace(/^\//, "")
  return path.replace(/[#?].*$/, "").replace(/[.,;:]+$/, "")
    .replace(/:\d+(?::\d+)?(?:-\d+)?$/, "")
}

/**
 * Resolve a local path after `~` to a repo. Worktree folders are named
 * `<repo>-<branch>` (`sai-perps-1400-ref-intents`), and older notes used
 * `~/ki/<repo>`; both resolve to the base repo.
 */
export const localRefRepo = (
  rest: string, names: string[], roots = oldCheckoutRoots,
): { repo: string; path: string } | undefined => {
  let parts = rest.replace(/^\/+/, "").split("/")
  if (parts.length > 1 && roots.includes(parts[0])) parts = parts.slice(1)
  const [seg, ...path] = parts
  const lower = seg.toLowerCase()
  const repo = names.find((n) => n.toLowerCase() === lower) ??
    names.filter((n) => lower.startsWith(`${n.toLowerCase()}-`))
      .sort((a, b) => b.length - a.length)[0]
  return repo ? { repo, path: path.join("/") } : undefined
}

/**
 * Paths to try for a doc reference. A GitHub ref can contain slashes
 * (`blob/wasm-contracts/v1.51.0/contracts/...`), so the first segments of
 * the parsed path may still belong to the ref.
 */
export const refCandidates = (link: Pick<Link, "toPath" | "via">): string[] => {
  if (!/github\.com\/[^/]+\/[^/]+\/(?:blob|tree)\//i.test(link.via)) {
    return [link.toPath]
  }
  const parts = link.toPath.split("/")
  return [0, 1, 2].filter((n) => n < parts.length)
    .map((n) => parts.slice(n).join("/"))
}

/**
 * Codebase Memory matches a full URL to a server by host alone and then
 * picks an arbitrary symbol (often a one-letter minified name) as the
 * target. A bare "/" or a channel with no route says nothing either. A
 * route path matched to a named handler is a real link.
 */
export const isWeakCbmMatch = (
  urlPath: string, targetFunction: string,
): boolean =>
  /^[a-z]+:\/\//i.test(urlPath) || urlPath.replace(/\/+$/, "") === ""
  || targetFunction.length <= 1

/**
 * Codebase Memory records a cross-repo call in both projects. Keep one per
 * pair and URL, preferring the record whose source is the caller.
 */
export const dedupeCbm = (
  rows: (Link & { caller: boolean })[],
): Link[] => {
  const best = new Map<string, Link & { caller: boolean }>()
  for (const row of rows) {
    const ends = [`${row.fromRepo}:${row.fromFile}`,
      `${row.toRepo}:${row.toPath}`].sort()
    const key = `${ends.join("|")}|${row.via}`
    const seen = best.get(key)
    if (!seen || (!seen.caller && row.caller)) best.set(key, row)
  }
  return [...best.values()].map(({ caller: _, ...link }) => link)
}

// --------------------------------------------------------------- discovery

const cacheDir = (): string =>
  join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"),
    "codebase-memory-mcp")

const rg = (args: string[], cwd: string): string[] => {
  const r = spawnSync("rg", args, {
    cwd, encoding: "utf8", maxBuffer: 512 << 20,
  })
  // 1: no match. A repo with no files of a language reports none searched.
  if (r.status === 1 || /No files were searched/.test(r.stderr)) return []
  // Status 2 with output means some files were unreadable; keep the rest.
  if (r.status !== 0 && !r.stdout) {
    throw new Error(`rg failed in ${cwd}: ${r.stderr.trim() || r.error}`)
  }
  return r.stdout.split("\n").filter(Boolean)
}

const globArgs = (globs: string[]): string[] =>
  globs.flatMap((g) => ["-g", g])

/** Respect the project's .cbmignore, so the map covers what is indexed. */
const indexedArgs = (repo: Repo): string[] => [
  ...(existsSync(join(repo.root, ".cbmignore"))
    ? ["--ignore-file", join(repo.root, ".cbmignore")] : []),
  ...globArgs(repo.skipGlobs),
]

export const listProjects = (dir = cacheDir()): Map<string, string> => {
  const projects = new Map<string, string>()
  for (const file of readdirSync(dir)) {
    if (!/^[^_].*\.db$/.test(file) || file === "activity.db") continue
    const db = new Database(join(dir, file), { readonly: true })
    try {
      const rows = db.query("SELECT name, root_path FROM projects")
        .all() as { name: string; root_path: string }[]
      for (const r of rows) projects.set(r.name, r.root_path)
    } catch {
      // Not a project store.
    } finally {
      db.close()
    }
  }
  return projects
}

const submodulePaths = (root: string): string[] => {
  const path = join(root, ".gitmodules")
  if (!existsSync(path)) return []
  return [...readFileSync(path, "utf8").matchAll(/^\s*path\s*=\s*(\S+)/gm)]
    .map((m) => m[1])
}

export const loadRepos = (projects: Map<string, string>): Repo[] => {
  const names = new Set([...projects.values()].map((r) => basename(r)))
  return [...projects].filter(([, root]) => existsSync(root))
    .map(([project, root]) => {
      const origin = spawnSync("git", ["-C", root, "remote", "get-url",
        "origin"], { encoding: "utf8" }).stdout ?? ""
      const skipGlobs = submodulePaths(root)
        .filter((p) => names.has(basename(p)))
        .map((p) => `!${p}/**`)
      const repo: Repo = {
        name: basename(root), root, project, remote: parseRemote(origin),
        goModules: [], npmPackages: [], crates: [], skipGlobs,
      }
      const manifests = rg(["--files", ...globArgs(["go.mod", "package.json",
        "Cargo.toml", "!**/node_modules/**", ...skipGlobs])], root)
      for (const file of manifests) {
        const text = readFileSync(join(root, file), "utf8")
        const dir = dirname(file) === "." ? "" : dirname(file)
        if (file.endsWith("go.mod")) {
          const path = parseGoModule(text)
          if (path) repo.goModules.push({ path, dir })
        } else if (file.endsWith("package.json")) {
          const name = parseNpmName(text)
          if (name) repo.npmPackages.push({ name, dir })
        } else {
          const name = parseCargoName(text)
          if (name && isDistinctCrate(name)) repo.crates.push({ name, dir })
        }
      }
      return repo
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

// ------------------------------------------------------------------ links

interface Owner { key: string; repo: string; dir: string }

const scan = (
  repo: Repo, kind: LinkKind, globs: string[], pattern: string,
  resolve: (match: string) => Omit<Link, "kind" | "fromRepo" | "fromFile"
    | "line"> | undefined,
): Link[] => {
  const lines = rg(["-n", "-o", "--no-heading", "-P", ...indexedArgs(repo),
    ...globArgs(globs), "-e", pattern], repo.root)
  const links: Link[] = []
  for (const raw of lines) {
    const hit = parseRgLine(raw)
    const target = hit && resolve(hit.match)
    if (hit && target && target.toRepo !== repo.name) {
      links.push({ kind, fromRepo: repo.name, fromFile: hit.file,
        line: hit.line, ...target })
    }
  }
  return links
}

const alternation = (keys: string[]): string =>
  keys.sort((a, b) => b.length - a.length).map(escapeRegex).join("|")

export const importLinks = (repos: Repo[]): Link[] => {
  const goOwners: Owner[] = repos.flatMap((r) =>
    r.goModules.map((m) => ({ key: m.path, repo: r.name, dir: m.dir })))
  const npmOwners: Owner[] = repos.flatMap((r) =>
    r.npmPackages.map((p) => ({ key: p.name, repo: r.name, dir: p.dir })))
  const crateOwners: Owner[] = repos.flatMap((r) => r.crates.flatMap((c) => [
    { key: c.name, repo: r.name, dir: c.dir },
    { key: c.name.replace(/-/g, "_"), repo: r.name, dir: c.dir },
  ]))
  const links: Link[] = []
  for (const repo of repos) {
    const foreign = (owners: Owner[]) =>
      owners.filter((o) => o.repo !== repo.name)
    const go = foreign(goOwners)
    if (go.length) {
      links.push(...scan(repo, "go-import", sourceGlobs.go,
        `"(?:${alternation(go.map((o) => o.key))})(?:/[^"]*)?"`, (m) => {
          const spec = m.slice(1, -1)
          const o = ownerOf(spec, go)
          return o && { toRepo: o.repo, via: o.key,
            toPath: joinRepoPath(o.dir, spec.slice(o.key.length)) }
        }))
    }
    const npm = foreign(npmOwners)
    if (npm.length) {
      links.push(...scan(repo, "npm-import", sourceGlobs.npm,
        `(?:from\\s+|require\\(\\s*|import\\(\\s*)["'](?:${
          alternation(npm.map((o) => o.key))})(?:/[^"']*)?["']`, (m) => {
          const spec = /["']([^"']+)["']/.exec(m)?.[1] ?? ""
          const o = ownerOf(spec, npm)
          return o && { toRepo: o.repo, via: o.key,
            toPath: joinRepoPath(o.dir, spec.slice(o.key.length)) }
        }))
    }
    const crates = foreign(crateOwners)
    if (crates.length) {
      const names = alternation(crates.map((o) => o.key))
      links.push(...scan(repo, "crate-dep", sourceGlobs.rust,
        `^(?:${names})(?=\\s*=)|\\b(?:${names})(?=::)`, (m) => {
          const o = crates.find((c) => c.key === m)
          return o && { toRepo: o.repo, via: o.key.replace(/_/g, "-"),
            toPath: o.dir }
        }))
    }
  }
  return links
}

export const docLinks = (repos: Repo[]): Link[] => {
  const home = homedir()
  const names = repos.map((r) => r.name)
  const byGh = new Map<string, string>()
  const owners = new Set(extraOwners)
  for (const r of repos) {
    if (!r.remote) continue
    const [owner, name] = r.remote.split("/")
    owners.add(owner)
    byGh.set(name, r.name)
  }
  const local = alternation(repos.map((r) => r.name))
  const gh = alternation([...byGh.keys()])
  const pattern = [
    `(?:~|${escapeRegex(home)})/(?:(?:${alternation([...oldCheckoutRoots])})/)?`
      + `(?:${local})(?:-[\\w.-]+)?(?:/[\\w./@-]*)?`,
    `github\\.com/(?i:${alternation([...owners])})/(?i:${gh})`
      + `(?:/(?:blob|tree)/[^/\\s)]+/[^\\s)#>"'\\]\`]*)?`,
  ].join("|")
  const roots = new Map(repos.map((r) => [r.name, r.root]))
  const exists = new Map<string, boolean>()
  const markMissing = (link: Link): Link => {
    if (!link.toPath) return link
    const root = roots.get(link.toRepo) ?? ""
    const found = refCandidates(link).find((path) => {
      const abs = join(root, path)
      if (!exists.has(abs)) exists.set(abs, existsSync(abs))
      return exists.get(abs)
    })
    if (found === undefined) return { ...link, missing: true }
    return found === link.toPath ? link : { ...link, toPath: found }
  }
  return repos.flatMap((repo) =>
    scan(repo, "doc-ref", sourceGlobs.docs, pattern, (m) => {
      const ghHit = /github\.com\/[^/]+\/([^/\s)]+)(.*)$/i.exec(m)
      if (ghHit) {
        const toRepo = byGh.get(ghHit[1].toLowerCase())
        return toRepo
          ? { toRepo, toPath: docRefPath(ghHit[2]), via: m } : undefined
      }
      const hit = localRefRepo(
        m.startsWith(home) ? m.slice(home.length) : m.slice(1), names)
      return hit ? { toRepo: hit.repo, toPath: docRefPath(`/${hit.path}`),
        via: m } : undefined
    }).map(markMissing))
}

export const cbmLinks = (repos: Repo[], dir = cacheDir()): Link[] => {
  const byProject = new Map(repos.map((r) => [r.project, r.name]))
  const rows: (Link & { caller: boolean })[] = []
  for (const repo of repos) {
    const path = join(dir, `${repo.project}.db`)
    if (!existsSync(path)) continue
    const db = new Database(path, { readonly: true })
    try {
      const found = db.query(`
        SELECT e.type, s.name, s.file_path, s.start_line, e.properties,
          EXISTS(SELECT 1 FROM edges h WHERE h.source_id = s.id
            AND h.type IN ('HTTP_CALLS', 'ASYNC_CALLS')) AS caller
        FROM edges e JOIN nodes s ON s.id = e.source_id
        WHERE e.project = ?1 AND e.type LIKE 'CROSS_%'`).all(repo.project) as {
        type: string; name: string; file_path: string; start_line: number
        properties: string; caller: number
      }[]
      for (const f of found) {
        const p = JSON.parse(f.properties || "{}")
        rows.push({
          kind: "cbm-call", fromRepo: repo.name, fromFile: f.file_path,
          line: f.start_line,
          toRepo: byProject.get(p.target_project) ??
            `${p.target_project} (stale)`,
          toPath: p.target_file ?? "",
          via: `${f.type} ${p.url_path ?? ""}`.trim(),
          weak: isWeakCbmMatch(p.url_path ?? "", p.target_function ?? ""),
          caller: f.caller === 1,
        })
      }
    } finally {
      db.close()
    }
  }
  return dedupeCbm(rows)
}

/**
 * Map the repos in the manifest (cbm/repos.json). Codebase Memory also
 * indexes any folder a session starts in, such as worktrees; those are
 * copies of a manifest repo, not repos of their own.
 */
export const buildMap = (): CrossRepoMap => {
  const home = homedir()
  const wanted = new Set(manifestDirs().map((d) => join(home, d)))
  const projects = new Map([...listProjects()]
    .filter(([, root]) => wanted.has(root)))
  const repos = loadRepos(projects)
  return {
    generatedAt: new Date().toISOString(),
    repos: repos.map(({ skipGlobs: _, ...r }) => r),
    links: [...importLinks(repos), ...cbmLinks(repos), ...docLinks(repos)],
  }
}

// -------------------------------------------------------------------- CLI

const serve = (port: number): void => {
  let cached: CrossRepoMap | undefined
  const page = join(import.meta.dir, "xrepo.html")
  Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === "/api/map") {
        try {
          if (!cached || url.searchParams.has("refresh")) cached = buildMap()
          return Response.json(cached)
        } catch (err) {
          return new Response(String(err), { status: 500 })
        }
      }
      if (url.pathname === "/") return new Response(Bun.file(page))
      return new Response("not found", { status: 404 })
    },
  })
  console.log(`cross-repo map: http://127.0.0.1:${port}`)
}

if (import.meta.main) {
  const program = new Program()
    .description("Map links between Codebase Memory projects.")
    .option("--json", "print the map as JSON")
    .option("--serve [port]", "serve the map page (default port 9750)")
    .parse()
  const opts = program.opts<{ json?: boolean; serve?: string | boolean }>()
  try {
    if (opts.serve) {
      serve(opts.serve === true ? 9750 : Number(opts.serve))
    } else if (opts.json) {
      console.log(JSON.stringify(buildMap(), null, 2))
    } else {
      const map = buildMap()
      const counts = new Map<string, number>()
      for (const l of map.links) {
        const key = `${l.fromRepo} -> ${l.toRepo}  ${l.kind}`
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
      for (const [key, n] of [...counts].sort((a, b) => b[1] - a[1])) {
        console.log(`${String(n).padStart(6)}  ${key}`)
      }
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  }
}
