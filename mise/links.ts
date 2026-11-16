/**
 * Link active mise shims into ~/.local/bin so pinned tools work in every
 * shell, not only zsh.
 *
 * Usage: bun mise/links.ts --run | --check
 *
 * zshenv puts the shims directory first on PATH, but bash and sh never read
 * zshenv, and long-running agents keep the PATH they started with. Almost
 * every PATH includes ~/.local/bin (Ubuntu's ~/.profile adds it for bash
 * login shells), so a link there reaches those shells too. A link to a shim
 * runs the pinned tool because mise picks the tool from the name it was
 * called by.
 *
 * Only active commands are linked. Obsolete links into the shims directory
 * are removed, even when their inactive shim still exists. A real file
 * or a link elsewhere in ~/.local/bin is left alone and reported.
 */
import { lstat, mkdir, readdir, readlink, symlink, unlink } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { activeCommandNames } from "./commands"

const repair = "repair: just mise-install"

/** What currently sits at ~/.local/bin/<name>. */
export type Entry =
  | { kind: "missing" }
  | { kind: "link"; target: string }
  | { kind: "file" }

export interface LinkPlan {
  /** Shim names to link (missing, or a stale link into the shims dir). */
  create: string[]
  /** Managed links whose shim no longer exists. */
  remove: string[]
  /** Names held by a real file or a link elsewhere; left alone. */
  conflicts: string[]
}

/**
 * Plans link changes from the shim names and what ~/.local/bin holds for
 * each relevant name. `existing` covers every name in ~/.local/bin that is
 * either a shim name or a link into `shimDir`.
 */
export function planLinks(
  shimDir: string,
  shims: string[],
  existing: Map<string, Entry>,
): LinkPlan {
  const plan: LinkPlan = { create: [], remove: [], conflicts: [] }
  const shimSet = new Set(shims)
  for (const shim of [...shims].sort()) {
    const entry = existing.get(shim) ?? { kind: "missing" }
    const wanted = join(shimDir, shim)
    if (entry.kind === "missing") {
      plan.create.push(shim)
    } else if (entry.kind === "link" && entry.target === wanted) {
      continue
    } else if (entry.kind === "link" && entry.target.startsWith(shimDir + "/")) {
      plan.create.push(shim)
    } else {
      plan.conflicts.push(shim)
    }
  }
  for (const [name, entry] of [...existing].sort(([a], [b]) => a.localeCompare(b))) {
    if (
      !shimSet.has(name) &&
      entry.kind === "link" &&
      entry.target.startsWith(shimDir + "/")
    ) {
      plan.remove.push(name)
    }
  }
  return plan
}

async function readEntry(path: string): Promise<Entry> {
  try {
    const stats = await lstat(path)
    if (stats.isSymbolicLink()) return { kind: "link", target: await readlink(path) }
    return { kind: "file" }
  } catch {
    return { kind: "missing" }
  }
}

/** Reconcile only active commands, preserving unrelated installations. */
export async function reconcileLinks(
  mode: "--run" | "--check",
  shimDir: string,
  binDir: string,
  shims: string[],
): Promise<number> {
  // Validate all active shims before changing any existing links.
  for (const name of shims) {
    await lstat(join(shimDir, name))
  }

  const names = new Set([...shims, ...(await readdir(binDir).catch(() => []))])
  const existing = new Map<string, Entry>()
  for (const name of names) {
    const entry = await readEntry(join(binDir, name))
    if (shims.includes(name) || (entry.kind === "link" && entry.target.startsWith(shimDir + "/"))) {
      existing.set(name, entry)
    }
  }
  const plan = planLinks(shimDir, shims, existing)

  for (const name of plan.conflicts) {
    console.error(
      `mise: ${join(binDir, name)} is not a mise shim link; remove it so ` +
        `\`${name}\` resolves to the pinned version in every shell`,
    )
  }

  if (mode === "--check") {
    for (const name of plan.create) console.error(`mise: missing link ${join(binDir, name)} (${repair})`)
    for (const name of plan.remove) console.error(`mise: stale link ${join(binDir, name)} (${repair})`)
    return plan.create.length + plan.remove.length + plan.conflicts.length > 0 ? 1 : 0
  }

  await mkdir(binDir, { recursive: true })
  for (const name of plan.create) {
    const path = join(binDir, name)
    await unlink(path).catch(() => {})
    await symlink(join(shimDir, name), path)
  }
  for (const name of plan.remove) await unlink(join(binDir, name))
  if (plan.create.length + plan.remove.length > 0) {
    console.log(
      `mise: linked ${plan.create.length} and removed ${plan.remove.length} shim ` +
        `links in ${binDir}`,
    )
  }
  return plan.conflicts.length > 0 ? 1 : 0
}

if (import.meta.main) {
  const mode = process.argv[2] ?? "--check"
  if (mode !== "--run" && mode !== "--check") {
    console.error("Usage: bun mise/links.ts --run | --check")
    process.exit(2)
  }
  try {
    const home = homedir()
    const names = activeCommandNames(join(home, ".local", "bin", "mise"))
    process.exit(await reconcileLinks(
      mode,
      join(home, ".local", "share", "mise", "shims"),
      join(home, ".local", "bin"),
      names,
    ))
  } catch (error) {
    console.error(`mise: ${error} (${repair})`)
    process.exit(1)
  }
}
