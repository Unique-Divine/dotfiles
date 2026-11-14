import { describe, expect, test } from "bun:test"

import { aggregate, classify, findings, ownerOf, parseMeminfo, parseStat, parseStatus, type Proc } from "./health"

const proc = (over: Partial<Proc>): Proc => ({
  pid: 1,
  ppid: 0,
  comm: "bun",
  args: "",
  rssMb: 10,
  swapMb: 0,
  ageHours: 1,
  ...over,
})

describe("parsers", () => {
  test("parseMeminfo converts kB to MiB and derives swap used", () => {
    const text = "MemTotal:       32542720 kB\nMemFree: 1 kB\nMemAvailable:   11515904 kB\nSwapTotal:       8388608 kB\nSwapFree:        6291456 kB\n"
    expect(parseMeminfo(text)).toEqual({ totalMb: 31780, availableMb: 11246, swapTotalMb: 8192, swapUsedMb: 2048 })
  })

  test("parseStatus reads VmRSS and VmSwap", () => {
    expect(parseStatus("Name:\tbun\nVmRSS:\t 7141248 kB\nVmSwap:\t 1495932 kB\n")).toEqual({ rssMb: 6974, swapMb: 1461 })
  })

  test("parseStat handles a command name with spaces and parentheses", () => {
    const fields = Array.from({ length: 50 }, (_, i) => String(i + 3))
    fields[1] = "4122" // field 4: ppid
    fields[19] = "987654" // field 22: starttime
    expect(parseStat(`2376590 (weird (name) x) ${fields.join(" ")}`)).toEqual({ ppid: 4122, startTicks: 987654 })
  })
})

describe("classify and owner", () => {
  test("groups known process kinds", () => {
    expect(classify(proc({ args: "bun /x/typescript/lib/tsserver.js --stdio" }))).toBe("TypeScript server (tsserver)")
    expect(classify(proc({ args: "/home/u/.bun/bin/bun /home/u/.bun/bin/mcp-discord" }))).toBe("Discord MCP (mcp-discord)")
    expect(classify(proc({ comm: "codex", args: "codex --no-daemon" }))).toBe("Codex sessions")
    expect(classify(proc({ args: "bun --bun next dev --webpack -p 3472" }))).toBe("Dev servers")
    expect(classify(proc({ args: "/usr/bin/sleep 10" }))).toBe("Other")
  })

  test("ownerOf walks ancestors to the nearest app", () => {
    const claude = proc({ pid: 4122, comm: "claude", args: "claude --resume abc" })
    const ls = proc({ pid: 2376530, ppid: 4122, args: "bun typescript-language-server --stdio" })
    const ts = proc({ pid: 2376590, ppid: 2376530, args: "bun tsserver.js" })
    const byPid = new Map([claude, ls, ts].map((p) => [p.pid, p]))
    expect(ownerOf(ts, byPid)).toBe("claude")
    expect(ownerOf(proc({ ppid: 999 }), byPid)).toBe("-")
  })
})

describe("aggregate and findings", () => {
  const codexA = proc({ pid: 10, comm: "codex", args: "codex --no-daemon", rssMb: 300 })
  const codexB = proc({ pid: 20, comm: "codex", args: "codex --no-daemon", rssMb: 200 })
  const discord = (pid: number, ppid: number) => proc({ pid, ppid, args: "bun /b/mcp-discord", rssMb: 64 })
  const bigTs = proc({ pid: 30, ppid: 10, args: "bun tsserver.js", rssMb: 7000, swapMb: 1400, ageHours: 51 })
  const procs = [codexA, codexB, discord(11, 10), discord(12, 10), discord(21, 20), bigTs]

  test("sums by group and owner, largest first", () => {
    const rows = aggregate(procs)
    expect(rows[0]).toMatchObject({ group: "TypeScript server (tsserver)", owner: "codex", count: 1, rssMb: 7000 })
    expect(rows.find((r) => r.group === "Discord MCP (mcp-discord)")).toMatchObject({ owner: "codex", count: 3, rssMb: 192 })
    expect(rows.find((r) => r.group === "Codex sessions")).toMatchObject({ count: 2, rssMb: 500 })
  })

  test("flags big processes, duplicate Discord servers, and low RAM", () => {
    const msgs = findings(procs, { totalMb: 32000, availableMb: 2000, swapTotalMb: 0, swapUsedMb: 0 }).map((f) => f.message)
    expect(msgs.some((m) => m.startsWith("PID 30 (TypeScript server (tsserver), started by codex)"))).toBe(true)
    expect(msgs).toContain("1 parent(s) run more than one mcp-discord: 10x2")
    expect(msgs).toContain("Only 2000 MiB of 32000 MiB RAM available")
  })

  test("reports nothing for a quiet machine", () => {
    expect(findings([codexA], { totalMb: 32000, availableMb: 20000, swapTotalMb: 0, swapUsedMb: 0 })).toEqual([])
  })
})
