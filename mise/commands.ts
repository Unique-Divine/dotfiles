/** Discover executables owned by the active mise configuration. */
export function parseCommandNames(json: string): string[] {
  const entries: unknown = JSON.parse(json)
  if (!Array.isArray(entries)) throw new Error("expected an executable array")
  const names = new Set<string>()
  for (const entry of entries) {
    if (
      !entry || typeof entry !== "object" ||
      typeof entry.name !== "string" || !entry.name ||
      entry.name === "." || entry.name === ".." ||
      /[/\\\x00]/.test(entry.name) ||
      typeof entry.path !== "string" || !entry.path ||
      typeof entry.symlink !== "boolean"
    ) {
      throw new Error("invalid mise executable entry")
    }
    names.add(entry.name)
  }
  return [...names].sort()
}

/** Fail closed: stale global shims never substitute for failed discovery. */
export function activeCommandNames(mise: string): string[] {
  const proc = Bun.spawnSync([mise, "bin-paths", "--json"])
  if (proc.exitCode !== 0) {
    throw new Error(`mise bin-paths failed: ${proc.stderr.toString().trim()}`)
  }
  return parseCommandNames(proc.stdout.toString())
}
