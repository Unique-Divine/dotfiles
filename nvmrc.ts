import { readdir, readFile, writeFile } from "node:fs/promises"
import { isAbsolute, join, resolve, sep } from "node:path"
import { Command } from "commander"

/** Directory names that `set` may rewrite when they appear in the path. */
export const NVMRC_SET_ALLOW = [
  "nibi-chain",
  "nibi-home-site",
  "docs-v2",
  "ecosystem",
  "sai-perps",
  "nibi-ts-sdk",
  "nibi-ui-nibi",
  "gh-io-ud",
  "coded-estate-evm",
] as const

/** Path-segment prefixes treated as first-party sai-web clones. */
export const NVMRC_SET_ALLOW_PREFIXES = ["sai-web"] as const

/** Directory names that `set` must not rewrite. */
export const NVMRC_SET_DENY = [
  "gmx-synthetics",
  "eth-rainbowkit",
  "eth-web3auth-web",
  "sei-sei-js",
  "nibi-z-archive",
  "workshops-nibiru",
  "nibi-x-airdrop",
] as const

/** Path-segment prefixes that `set` must not rewrite. */
export const NVMRC_SET_DENY_PREFIXES = ["metamask-"] as const

export interface NvmrcHit {
  path: string
  pin: string
}

export interface FindNvmrcOptions {
  root: string
  level: number
}

export interface SetNvmrcOptions extends FindNvmrcOptions {
  version: string
  all?: boolean
  dryRun?: boolean
}

const skipDirNames = new Set(["node_modules", ".git"])

export const parseLevel = (value: string): number => {
  const level = Number.parseInt(value, 10)
  if (!Number.isFinite(level) || level < 1) {
    throw new Error(`-L must be an integer >= 1, got ${value}`)
  }
  return level
}

export const resolveRoot = (root: string): string =>
  isAbsolute(root) ? root : resolve(root)

const pathSegments = (filePath: string): string[] =>
  filePath.split(sep).filter((part) => part.length > 0)

export const nvmrcSetDecision = (
  filePath: string,
  all = false,
): "allow" | "deny" | "not-allowlisted" => {
  if (all) return "allow"

  const segments = pathSegments(filePath)
  const denied = segments.some(
    (part) =>
      (NVMRC_SET_DENY as readonly string[]).includes(part) ||
      NVMRC_SET_DENY_PREFIXES.some((prefix) => part.startsWith(prefix)),
  )
  if (denied) return "deny"

  const allowed = segments.some(
    (part) =>
      (NVMRC_SET_ALLOW as readonly string[]).includes(part) ||
      NVMRC_SET_ALLOW_PREFIXES.some((prefix) => part.startsWith(prefix)),
  )
  return allowed ? "allow" : "not-allowlisted"
}

export const readNvmrc = async (filePath: string): Promise<string> => {
  const text = await readFile(filePath, "utf8")
  for (const line of text.split(/\r?\n/)) {
    const pin = line.trim()
    if (pin.length > 0) return pin
  }
  return ""
}

export const findNvmrcFiles = async (
  root: string,
  level: number,
): Promise<string[]> => {
  if (level < 1) {
    throw new Error(`-L must be an integer >= 1, got ${level}`)
  }

  const absRoot = resolveRoot(root)
  const found: string[] = []

  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (dir === absRoot) {
        throw new Error(`Cannot read --root ${absRoot}: ${String(error)}`)
      }
      if (code === "EACCES") return
      throw error
    }

    for (const entry of entries) {
      if (skipDirNames.has(entry.name)) continue
      if (entry.isSymbolicLink()) continue

      const full = join(dir, entry.name)
      if (entry.isFile() && entry.name === ".nvmrc") {
        if (depth + 1 <= level) found.push(full)
        continue
      }

      if (entry.isDirectory() && depth + 1 < level) {
        await walk(full, depth + 1)
      }
    }
  }

  await walk(absRoot, 0)
  found.sort()
  return found
}

export const listNvmrcFiles = async (
  options: FindNvmrcOptions,
): Promise<NvmrcHit[]> => {
  const paths = await findNvmrcFiles(options.root, options.level)
  const hits: NvmrcHit[] = []
  for (const filePath of paths) {
    hits.push({ path: filePath, pin: await readNvmrc(filePath) })
  }
  return hits
}

const formatHit = (hit: NvmrcHit): string => `${hit.path}  ${hit.pin}`

export const formatNvmrcList = (hits: NvmrcHit[]): string =>
  hits.map(formatHit).join("\n") + (hits.length > 0 ? "\n" : "")

export const setNvmrcFiles = async (
  options: SetNvmrcOptions,
): Promise<string[]> => {
  const hits = await listNvmrcFiles(options)
  const lines: string[] = []

  for (const hit of hits) {
    const decision = nvmrcSetDecision(hit.path, options.all ?? false)
    if (decision !== "allow") {
      lines.push(`skip  ${hit.path}  ${decision}`)
      continue
    }
    if (hit.pin === options.version) {
      lines.push(`skip  ${hit.path}  unchanged`)
      continue
    }

    if (!options.dryRun) {
      await writeFile(hit.path, `${options.version}\n`)
    }
    lines.push(`${hit.path}  ${hit.pin} -> ${options.version}`)
  }

  return lines
}

interface SharedCliOptions {
  root: string
  level: string
}

const addSharedOptions = (cmd: Command): Command =>
  cmd
    .option("--root <dir>", "search root", process.cwd())
    .option("-L, --level <n>", "max tree depth, same as tree -L", "3")

const sharedFromOpts = (opts: SharedCliOptions): FindNvmrcOptions => ({
  root: opts.root,
  level: parseLevel(opts.level),
})

const runList = async (opts: SharedCliOptions): Promise<void> => {
  const hits = await listNvmrcFiles(sharedFromOpts(opts))
  process.stdout.write(formatNvmrcList(hits))
}

const runSet = async (
  version: string,
  opts: SharedCliOptions & { all?: boolean; dryRun?: boolean },
): Promise<void> => {
  const lines = await setNvmrcFiles({
    ...sharedFromOpts(opts),
    version,
    all: opts.all,
    dryRun: opts.dryRun,
  })
  if (lines.length > 0) {
    process.stdout.write(`${lines.join("\n")}\n`)
  }
}

export const createProgram = (): Command => {
  const program = new Command()
    .name("nvmrc")
    .description("Locate and rewrite .nvmrc files.")
    .showHelpAfterError()

  addSharedOptions(
    program
      .command("list")
      .description("Print each .nvmrc path and pin")
      .action(runList),
  )

  addSharedOptions(
    program
      .command("set")
      .description("Write a pin into allowlisted .nvmrc files")
      .argument("<version>", "nvm version pin to write")
      .option("--all", "write every hit, ignore allow/deny")
      .option("--dry-run", "print writes without changing files")
      .action(runSet),
  )

  return program
}

if (import.meta.main) await createProgram().parseAsync()
