#!/usr/bin/env bun
/**
 * mem/health.ts: report where this machine's RAM goes, grouped by what each
 * process is (language servers, agent sessions, MCP servers, dev servers) and
 * which app started it. Read-only: it never stops a process.
 *
 * Usage: bun run mem/health.ts [--json] [--min-mb N]
 * Data: /proc/meminfo, /proc/<pid>/{status,stat,cmdline}, `ss -ltnp`.
 */
import { readdirSync, readFileSync } from "node:fs"

export interface MemInfo {
  totalMb: number
  availableMb: number
  swapTotalMb: number
  swapUsedMb: number
}

export interface Proc {
  pid: number
  ppid: number
  comm: string
  args: string
  rssMb: number
  swapMb: number
  ageHours: number
}

export interface GroupRow {
  group: string
  owner: string
  count: number
  rssMb: number
  swapMb: number
  maxAgeHours: number
  pids: number[]
}

export interface Finding {
  level: "warn" | "info"
  message: string
}

const kbToMb = (kb: number): number => Math.round(kb / 1024)

/** Parse /proc/meminfo text into MiB totals. */
export function parseMeminfo(text: string): MemInfo {
  const kb = (key: string): number => {
    const m = text.match(new RegExp(`^${key}:\\s+(\\d+) kB`, "m"))
    return m ? Number(m[1]) : 0
  }
  return {
    totalMb: kbToMb(kb("MemTotal")),
    availableMb: kbToMb(kb("MemAvailable")),
    swapTotalMb: kbToMb(kb("SwapTotal")),
    swapUsedMb: kbToMb(kb("SwapTotal") - kb("SwapFree")),
  }
}

/** Parse VmRSS and VmSwap (kB) from /proc/<pid>/status text. */
export function parseStatus(text: string): { rssMb: number; swapMb: number } {
  const kb = (key: string): number => {
    const m = text.match(new RegExp(`^${key}:\\s+(\\d+) kB`, "m"))
    return m ? Number(m[1]) : 0
  }
  return { rssMb: kbToMb(kb("VmRSS")), swapMb: kbToMb(kb("VmSwap")) }
}

/**
 * Parse ppid and start time (clock ticks since boot) from /proc/<pid>/stat.
 * The command name sits in parentheses and may contain spaces, so fields are
 * counted from the last ")".
 */
export function parseStat(text: string): { ppid: number; startTicks: number } {
  const rest = text.slice(text.lastIndexOf(")") + 2).split(" ")
  // rest[0] is field 3 (state); ppid is field 4, starttime is field 22.
  return { ppid: Number(rest[1]), startTicks: Number(rest[19]) }
}

interface Rule {
  group: string
  test: (p: Proc) => boolean
}

/**
 * First matching rule wins, so order matters. Specific rows precede the broad
 * ones whose patterns also match them: tsserver before "Other language
 * servers", and mcp-discord and Playwright before "Other MCP servers", whose
 * `mcp-` pattern matches both. tsserver and mcp-discord get their own rows
 * because they caused the two memory incidents this tool was written for: a
 * multi-GB tsserver started by Claude Code, and dozens of duplicate
 * mcp-discord servers (https://github.com/Unique-Divine/jiyuu/issues/106).
 */
export const RULES: Rule[] = [
  { group: "TypeScript server (tsserver)", test: (p) => /tsserver\.js/.test(p.args) },
  {
    group: "Other language servers",
    test: (p) => /language-server|-ls\b|lua-language|rust-analyzer|gopls|pyright/.test(p.args),
  },
  // Launchers first: claude/mcp-launch.ts takes the server name as an
  // argument, so a launcher for a server named mcp-discord would otherwise
  // count as a second Discord server beside its own child.
  { group: "MCP launchers (mcp-launch.ts)", test: (p) => /mcp-launch\.ts\b/.test(p.args) },
  { group: "Discord MCP (mcp-discord)", test: (p) => /mcp-discord\b/.test(p.args) },
  { group: "Playwright MCP", test: (p) => /playwright-mcp/.test(p.args) },
  { group: "Other MCP servers", test: (p) => /\bmcp[-_]|[-_]mcp\b|mcp-launch/.test(p.args) },
  { group: "Codex sessions", test: (p) => p.comm === "codex" || /^codex\b/.test(p.args) },
  { group: "Claude sessions", test: (p) => p.comm === "claude" || /^claude\b/.test(p.args) },
  {
    group: "Dev servers",
    test: (p) => /\b(next|astro|vite|expo|webpack)\b.*\b(dev|start|serve)\b|firebase.*emulators/.test(p.args),
  },
  { group: "Test runners", test: (p) => /\b(bun test|playwright test|vitest|jest)\b/.test(p.args) },
  { group: "Browsers", test: (p) => /chrom(e|ium)|firefox|headless_shell/.test(p.args) },
  { group: "Docker and containers", test: (p) => /dockerd|containerd|docker-proxy/.test(p.args) },
  { group: "Databases", test: (p) => /postgres|redis-server|ollama/.test(p.args) },
]

export function classify(p: Proc): string {
  return RULES.find((r) => r.test(p))?.group ?? "Other"
}

const OWNER_COMMS = ["claude", "codex", "nvim", "herdr", "code", "cursor"]

/**
 * Name the nearest ancestor app (Claude, Codex, Neovim...) that started p.
 * The walk starts at the parent, so a session is never its own owner. Owner
 * matters because the same server costs differently per client: the tsserver
 * incident came from Claude Code, not Neovim. The hop limit bounds the walk
 * if PID reuse ever forms a cycle in this snapshot.
 */
export function ownerOf(p: Proc, byPid: Map<number, Proc>): string {
  return ownerProc(p, byPid)?.name ?? "-"
}

/** The ancestor app process that `ownerOf` names, with its PID. */
export function ownerProc(
  p: Proc, byPid: Map<number, Proc>,
): { name: string; proc: Proc } | undefined {
  let cur = byPid.get(p.ppid)
  for (let hops = 0; cur && hops < 32; hops++) {
    const name = OWNER_COMMS.find((c) => cur!.comm === c || cur!.args.startsWith(`${c} `))
    if (name) return { name, proc: cur }
    cur = byPid.get(cur.ppid)
  }
  return undefined
}

/** Group processes by (group, owner) and sort by resident memory. */
export function aggregate(procs: Proc[]): GroupRow[] {
  const byPid = new Map(procs.map((p) => [p.pid, p]))
  const rows = new Map<string, GroupRow>()
  for (const p of procs) {
    const group = classify(p)
    if (group === "Other") continue
    // Sessions are owners themselves; their parent is a shell or terminal.
    const owner = /sessions$/.test(group) ? "-" : ownerOf(p, byPid)
    const key = `${group}\u0000${owner}`
    const row = rows.get(key) ?? { group, owner, count: 0, rssMb: 0, swapMb: 0, maxAgeHours: 0, pids: [] }
    row.count++
    row.rssMb += p.rssMb
    row.swapMb += p.swapMb
    row.maxAgeHours = Math.max(row.maxAgeHours, p.ageHours)
    row.pids.push(p.pid)
    rows.set(key, row)
  }
  return [...rows.values()].sort((a, b) => b.rssMb - a.rssMb)
}

/**
 * Flag the patterns that have wasted memory on this machine before. The
 * 2 GiB line for one process's RAM plus swap sits far above a healthy MCP
 * server (60 to 80 MB) or Codex session (0.1 to 0.4 GB) and well below the
 * 7 GB tsserver incident. Each client should run one mcp-discord, so more than
 * one under the same app process is the duplicate-server leak from
 * https://github.com/Unique-Divine/jiyuu/issues/106.
 */
export function findings(procs: Proc[], mem: MemInfo): Finding[] {
  const out: Finding[] = []
  const byPid = new Map(procs.map((p) => [p.pid, p]))
  for (const p of procs) {
    if (p.rssMb + p.swapMb >= 2048) {
      out.push({
        level: "warn",
        message: `PID ${p.pid} (${classify(p)}, started by ${ownerOf(p, byPid)}) holds ${p.rssMb} MiB RAM + ${p.swapMb} MiB swap, ${Math.round(p.ageHours)} h old`,
      })
    }
  }
  const dev = procs.filter((p) => classify(p) === "Dev servers")
  if (dev.length) out.push({ level: "info", message: `${dev.length} dev server process(es): ${dev.map((p) => p.pid).join(", ")}` })
  // Count per owning app process, not per parent: Claude starts each MCP
  // server through its own mcp-launch.ts wrapper, so duplicates under one
  // Claude session have different parents. Without an owner, fall back to
  // the parent.
  const perOwner = new Map<string, number>()
  for (const p of procs) {
    if (classify(p) !== "Discord MCP (mcp-discord)") continue
    const owner = ownerProc(p, byPid)
    const key = owner ? `${owner.name} ${owner.proc.pid}` : `parent ${p.ppid}`
    perOwner.set(key, (perOwner.get(key) ?? 0) + 1)
  }
  const dupes = [...perOwner.entries()].filter(([, n]) => n > 1)
  if (dupes.length) {
    out.push({
      level: "warn",
      message: `${dupes.length} app process(es) run more than one mcp-discord: ${dupes.map(([key, n]) => `${key} x${n}`).join(", ")}`,
    })
  }
  if (mem.totalMb && mem.availableMb / mem.totalMb < 0.15) {
    out.push({ level: "warn", message: `Only ${mem.availableMb} MiB of ${mem.totalMb} MiB RAM available` })
  }
  return out
}

function readProcs(): Proc[] {
  const ticks = 100 // USER_HZ on Linux
  const uptimeSec = Number(readFileSync("/proc/uptime", "utf8").split(" ")[0])
  const procs: Proc[] = []
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue
    try {
      const status = readFileSync(`/proc/${name}/status`, "utf8")
      const stat = parseStat(readFileSync(`/proc/${name}/stat`, "utf8"))
      const args = readFileSync(`/proc/${name}/cmdline`, "utf8").split("\0").join(" ").trim()
      const comm = status.match(/^Name:\s+(.+)$/m)?.[1] ?? ""
      procs.push({
        pid: Number(name),
        ppid: stat.ppid,
        comm,
        args: args || `[${comm}]`,
        ...parseStatus(status),
        ageHours: Math.max(0, uptimeSec - stat.startTicks / ticks) / 3600,
      })
    } catch {
      // The process exited while we read it, or belongs to another user.
    }
  }
  return procs
}

/** Listening TCP ports with the owning process, from `ss -ltnp`. */
function listeningPorts(): string[] {
  try {
    const r = Bun.spawnSync(["ss", "-ltnpH"])
    return new TextDecoder()
      .decode(r.stdout)
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const cols = line.trim().split(/\s+/)
        const proc = line.match(/users:\(\("([^"]+)",pid=(\d+)/)
        return `${cols[3]}${proc ? `  ${proc[1]} (PID ${proc[2]})` : ""}`
      })
  } catch {
    return []
  }
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length)
}

function main(): void {
  const argv = process.argv.slice(2)
  const json = argv.includes("--json")
  const minIdx = argv.indexOf("--min-mb")
  const minMb = minIdx >= 0 ? Number(argv[minIdx + 1]) : 50

  const mem = parseMeminfo(readFileSync("/proc/meminfo", "utf8"))
  const procs = readProcs()
  const rows = aggregate(procs).filter((r) => r.rssMb + r.swapMb >= minMb)
  const found = findings(procs, mem)
  const ports = listeningPorts()

  if (json) {
    console.log(JSON.stringify({ mem, rows, findings: found, ports }, null, 2))
    return
  }
  console.log(
    `RAM: ${mem.totalMb - mem.availableMb} MiB used of ${mem.totalMb} MiB, ${mem.availableMb} MiB available. ` +
      `Swap: ${mem.swapUsedMb} of ${mem.swapTotalMb} MiB used.\n`,
  )
  console.log(`${pad("Group", 30)} ${pad("Started by", 10)} ${pad("Count", 5)} ${pad("RAM MiB", 8)} ${pad("Swap MiB", 8)} Oldest`)
  for (const r of rows) {
    console.log(
      `${pad(r.group, 30)} ${pad(r.owner, 10)} ${pad(String(r.count), 5)} ${pad(String(r.rssMb), 8)} ${pad(String(r.swapMb), 8)} ${Math.round(r.maxAgeHours)} h`,
    )
  }
  console.log("\nFindings:")
  if (!found.length) console.log("  none")
  for (const f of found) console.log(`  ${f.level === "warn" ? "\x1b[33mwarn\x1b[0m" : "info"} ${f.message}`)
  console.log("\nListening TCP ports:")
  for (const p of ports) console.log(`  ${p}`)
  console.log("\nRead-only. Stop a process with: kill <PID>")
}

if (import.meta.main) main()
