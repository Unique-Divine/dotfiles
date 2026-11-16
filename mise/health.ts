/**
 * Check that the CLI tools pinned in mise/config.toml are installed and that
 * every mise shim wins on PATH.
 *
 * Usage: bun mise/health.ts --check
 *
 * Fails when a pinned tool is missing or at a version other than the pin,
 * or when another copy of a command (apt, cargo, ~/go/bin, brew) shadows
 * its mise shim.
 */
import { lstatSync, readlinkSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { activeCommandNames } from "./commands"

const repair = "repair: just mise-install"

/** One entry of `mise ls --current --json` for a tool. */
export interface MiseToolVersion {
  version: string
  requested_version?: string
  installed: boolean
}

export type MiseLs = Record<string, MiseToolVersion[]>

/**
 * Returns a problem line for each tool that isn't installed, or whose
 * installed version differs from the version config.toml requests.
 */
export function toolProblems(ls: MiseLs): string[] {
  const problems: string[] = []
  for (const [tool, versions] of Object.entries(ls)) {
    const current = versions[0]
    if (!current) {
      problems.push(`${tool}: no version configured`)
    } else if (!current.installed) {
      problems.push(`${tool}@${current.requested_version ?? current.version}: not installed`)
    } else if (
      current.requested_version !== undefined &&
      current.requested_version !== current.version
    ) {
      problems.push(
        `${tool}: installed ${current.version}, pinned ${current.requested_version}`,
      )
    }
  }
  return problems
}

/**
 * Returns a problem line for each shim whose command resolves outside mise,
 * given `resolve` (for example `Bun.which`). A command may resolve to its
 * shim, or, inside a process mise started (such as a `just` recipe, since
 * `just` is itself a shim), directly to a binary under the installs dir.
 */
export function shadowProblems(
  shimDir: string,
  installsDir: string,
  shims: string[],
  resolve: (command: string) => string | null,
): string[] {
  const problems: string[] = []
  for (const shim of [...shims].sort()) {
    const expected = join(shimDir, shim)
    const actual = resolve(shim)
    const fromMise =
      actual === expected || (actual !== null && actual.startsWith(installsDir + "/"))
    if (!fromMise) {
      problems.push(
        `${shim}: resolves to ${actual ?? "nothing"}, not the mise shim ${expected}`,
      )
    }
  }
  return problems
}

async function check(): Promise<number> {
  const mise = join(homedir(), ".local", "bin", "mise")
  if (!(await Bun.file(mise).exists())) {
    console.error(`mise is not installed at ${mise} (${repair})`)
    return 1
  }
  const proc = Bun.spawnSync([mise, "ls", "--current", "--json"])
  if (proc.exitCode !== 0) {
    console.error(`mise ls failed: ${proc.stderr.toString().trim()} (${repair})`)
    return 1
  }
  const problems = toolProblems(JSON.parse(proc.stdout.toString()) as MiseLs)

  const miseData = join(homedir(), ".local", "share", "mise")
  const shimDir = join(miseData, "shims")
  const shims = activeCommandNames(mise)
  problems.push(
    ...shadowProblems(shimDir, join(miseData, "installs"), shims, (command) => {
      // A ~/.local/bin link to the shim (mise/links.ts) counts as the shim;
      // bash and sh find tools through it.
      const found = Bun.which(command)
      if (found && lstatSync(found).isSymbolicLink() && readlinkSync(found) === join(shimDir, command)) {
        return join(shimDir, command)
      }
      return found
    }),
  )

  for (const problem of problems) console.error(`mise: ${problem}`)
  if (problems.length > 0) {
    console.error(
      `mise: fix missing or outdated tools with \`just mise-install\`; remove ` +
        "or reorder copies that shadow a shim (see mise/README.md).",
    )
    return 1
  }
  return 0
}

if (import.meta.main) {
  const mode = process.argv[2] ?? "--check"
  if (mode !== "--check") {
    console.error("Usage: bun mise/health.ts --check")
    process.exit(2)
  }
  try {
    process.exit(await check())
  } catch (error) {
    console.error(`mise: ${error} (${repair})`)
    process.exit(1)
  }
}
