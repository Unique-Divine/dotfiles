/**
 * Find dead mise shims: shims whose command no active tool provides and no
 * later PATH entry provides.
 *
 * Usage: bun mise/dead-shims.ts --check
 *
 * zsh/zshenv puts the shims directory first on PATH. mise creates shims for
 * every installed tool, active or not. An inactive shim falls back to the
 * next executable of the same name on PATH, and exits 1 with "No version is
 * set for shim" when there is none. That shim then shadows the command for
 * every caller, including tools like Mason that spawn it directly.
 * https://github.com/Unique-Divine/dotfiles/issues/128
 */
import { accessSync, constants, readdirSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, join } from "node:path"

export interface DeadShim {
  name: string
}

/**
 * Returns the shims that are inactive and have no fallback, sorted by name.
 * `fallback` returns the executable a shim would fall back to, or null.
 */
export function deadShims(
  shims: string[],
  active: Set<string>,
  fallback: (name: string) => string | null,
): DeadShim[] {
  return [...shims]
    .sort()
    .filter((name) => !active.has(name) && fallback(name) === null)
    .map((name) => ({ name }))
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

/**
 * Returns a fallback finder over `pathDirs`. It skips the shims directory and
 * any entry that resolves to the mise binary, since both lead back to mise.
 */
export function fallbackFinder(
  pathDirs: string[],
  shimDir: string,
  miseBinary: string,
): (name: string) => string | null {
  const miseReal = realpathOrNull(miseBinary) ?? miseBinary
  const shimReal = realpathOrNull(shimDir) ?? shimDir
  const dirs = pathDirs.filter(
    (dir) => dir !== "" && (realpathOrNull(dir) ?? dir) !== shimReal,
  )
  return (name) => {
    for (const dir of dirs) {
      const candidate = join(dir, name)
      if (!isExecutable(candidate)) continue
      const real = realpathOrNull(candidate)
      if (real !== null && real !== miseReal) return candidate
    }
    return null
  }
}

/** Lists the command names in each directory `mise bin-paths` prints. */
export function commandsIn(binPaths: string[]): Set<string> {
  const names = new Set<string>()
  for (const dir of binPaths) {
    try {
      for (const name of readdirSync(dir)) names.add(name)
    } catch {
      // A missing bin path is a mise/health.ts problem, not a dead shim.
    }
  }
  return names
}

function check(): number {
  const mise = join(homedir(), ".local", "bin", "mise")
  const shimDir = join(homedir(), ".local", "share", "mise", "shims")
  const proc = Bun.spawnSync([mise, "bin-paths"])
  if (proc.exitCode !== 0) {
    console.error(
      `mise: bin-paths failed: ${proc.stderr.toString().trim()} ` +
        "(repair: just mise-install)",
    )
    return 1
  }

  let shims: string[]
  try {
    shims = readdirSync(shimDir)
  } catch {
    return 0
  }

  const binPaths = proc.stdout.toString().split("\n").filter(Boolean)
  const pathDirs = (process.env.PATH ?? "").split(delimiter)
  const dead = deadShims(
    shims,
    commandsIn(binPaths),
    fallbackFinder(pathDirs, shimDir, mise),
  )
  for (const { name } of dead) {
    console.error(
      `mise: dead shim ${join(shimDir, name)}: no active tool provides ` +
        `\`${name}\` and nothing later on PATH does, so \`${name}\` always ` +
        "fails. Activate its tool in mise/config.toml, or uninstall the " +
        "inactive tool and run `mise reshim`.",
    )
  }
  return dead.length > 0 ? 1 : 0
}

if (import.meta.main) {
  const mode = process.argv[2] ?? "--check"
  if (mode !== "--check") {
    console.error("Usage: bun mise/dead-shims.ts --check")
    process.exit(2)
  }
  process.exit(check())
}
