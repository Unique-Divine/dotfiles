import { describe, expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  statSync, writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  cutStreamLine, dayOf, extractChallenges, liveStatus, parseExitCode,
  parseSince, pathBytes, tapNotice, unwrapShell, type Event, type LiveProbe,
} from "./cli.ts"
import {
  buildEvent, indexPath, runFilePath, startRun, type Env,
  type RunIdentity, type RunLog,
} from "./runlog.ts"

const cliPath = join(import.meta.dir, "cli.ts")
const writerPath = join(import.meta.dir, "runlog.ts")
const fixtures = join(import.meta.dir, "fixtures")
const dayMs = 24 * 60 * 60 * 1000
/** The fake token planted in both fixtures. */
const plantedToken = "fixture-fake-7Qm2Xr9LpT4vK8"

interface CliResult {
  exitCode: number
  stdout: string
  stderr: string
}

const baseEnv = (home: string, extra: Env = {}): Env => ({
  ...process.env, BOKU_HOME: home, BOKU_RUN_ID: "", BOKU_ROOT_RUN_ID: "",
  BOKU_RUNLOG: "", ...extra,
})

const runCli = async (
  args: string[], env: Env, stdin?: string,
): Promise<CliResult> => {
  const proc = Bun.spawn(["bun", cliPath, ...args], {
    env,
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

const withHome = (run: (home: string) => Promise<void> | void) =>
  async (): Promise<void> => {
    const home = mkdtempSync(join(tmpdir(), "boku-runs-"))
    try {
      await run(home)
    } finally {
      rmSync(home, { force: true, recursive: true })
    }
  }

const readEvents = (file: string): Event[] =>
  readFileSync(file, "utf8").trimEnd().split("\n")
    .map((line) => JSON.parse(line) as Event)

const fixture = (name: string): string =>
  readFileSync(join(fixtures, name), "utf8")

/** A run hosted by this test process, like `git_mf` hosting the tap. */
const hostRun = (home: string, tool = "git_mf"): RunLog =>
  startRun(tool, { env: { BOKU_HOME: home }, argv: [], rev: null })

const dayAgo = (n: number): string => dayOf(new Date(Date.now() - n * dayMs))

/** Writes a finished or unfinished run file into a day folder. */
const plantRun = (
  home: string, runId: string, opts: {
    parent?: string | null; end?: { exit: number; status: string } | null
    pid?: number; pidStart?: number
  } = {},
): void => {
  const id: RunIdentity = {
    source: "dotfiles", runId, parentRunId: opts.parent ?? null,
    rootRunId: opts.parent ?? runId, tool: runId.split("-")[1]!,
  }
  const startTs = new Date(Date.UTC(
    2000 + Number(runId.slice(0, 2)), Number(runId.slice(2, 4)) - 1,
    Number(runId.slice(4, 6)), 12,
  ))
  const lines = [buildEvent(id, "start", {
    argv: [], pid: opts.pid ?? 999999, pid_start: opts.pidStart ?? 1,
    boot_id: "planted",
  }, startTs)]
  if (opts.end) {
    lines.push(buildEvent(id, "end", {
      ...opts.end, dur_ms: 5, warns: 0, errors: 0,
    }, startTs))
  }
  const dir = join(home, "runs", runId.slice(0, 6))
  mkdirSync(dir, { recursive: true })
  writeFileSync(runFilePath(home, runId), `${lines.join("\n")}\n`)
}

const stampFor = (day: string): string => `${day}T120000Z`

describe("pure helpers", () => {
  test("unwrapShell undoes Codex's login-shell wrapper", () => {
    expect(unwrapShell("/usr/bin/bash -lc 'just test'")).toBe("just test")
    expect(unwrapShell("/usr/bin/zsh -lc 'echo '\"'\"'hi'\"'\"''"))
      .toBe("echo 'hi'")
    expect(unwrapShell("just test")).toBe("just test")
  })

  test("parseExitCode reads Claude's error text", () => {
    expect(parseExitCode("Exit code 2\nls: nope")).toBe(2)
    expect(parseExitCode("Permission denied")).toBeNull()
  })

  test("cutStreamLine keeps long JSON lines valid and in the limit", () => {
    const line = JSON.stringify({ type: "user", text: "é".repeat(40000) })
    const cut = cutStreamLine(line)
    expect(cut.length).toBeLessThanOrEqual(16384)
    expect(JSON.parse(cut).type).toBe("user")
    expect(cutStreamLine("x".repeat(20000)).length).toBe(16384)
  })

  test("extractChallenges takes the section up to the next heading", () => {
    const md = "# R\n\n## Challenges\n\nSlow tests.\n\n## Next\n\nx\n"
    expect(extractChallenges(md)).toBe("Slow tests.")
    expect(extractChallenges("## Summary\n")).toBeNull()
  })

  test("parseSince reads days, hours, and dates", () => {
    const now = new Date("2026-11-09T00:00:00Z")
    expect(parseSince("30d", now).toISOString()).toBe("2026-10-10T00:00:00.000Z")
    expect(parseSince("12h", now).toISOString()).toBe("2026-11-08T12:00:00.000Z")
    expect(() => parseSince("soon", now)).toThrow()
  })

  test("liveStatus checks pid, pid_start, and boot_id", () => {
    const now = new Date()
    const probe: LiveProbe = {
      linux: true, bootId: "b1", pidStart: (pid) => (pid === 10 ? 500 : null),
    }
    const start = { pid: 10, pid_start: 500, boot_id: "b1" }
    expect(liveStatus(start, probe, now)).toBe("running")
    for (const other of [{ pid_start: 499 }, { boot_id: "b0" }]) {
      expect(liveStatus({ ...start, ...other }, probe, now)).toBe("incomplete")
    }
    expect(liveStatus({ ...start, pid: 11 }, probe, now)).toBe("incomplete")
    const offLinux = { ...probe, linux: false }
    expect(liveStatus({ ts: now.toISOString() }, offLinux, now)).toBe("running")
    const old = new Date(now.getTime() - 2 * dayMs).toISOString()
    expect(liveStatus({ ts: old }, offLinux, now)).toBe("incomplete")
  })
})

describe("tap", () => {
  test("claude stream: copy, commands, report", withHome(async (home) => {
    const run = hostRun(home)
    const stream = fixture("claude-stream.jsonl")
    const result = await runCli([
      "tap", "--cli", "claude",
      "--session-id", "5d0c8a3e-2f4b-4c1a-9e7d-1b2c3d4e5f60",
    ], baseEnv(home, { BOKU_RUN_ID: run.runId!, BOKU_ROOT_RUN_ID: run.runId! }),
    stream)
    run.end(0)
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toContain("agent: Bash just test")
    expect(result.stderr).not.toContain(plantedToken)
    expect(result.stderr.trim().split("\n")).toHaveLength(5)

    const copy = readFileSync(join(run.runDir!, "agent.jsonl"), "utf8")
    expect(copy).not.toContain(plantedToken)
    expect(copy).toContain("[redacted:token-value]")
    expect(copy.split("\n").length).toBe(stream.split("\n").length)
    expect(statSync(join(run.runDir!, "agent.jsonl")).mode & 0o777).toBe(0o600)

    const report = readFileSync(join(run.runDir!, "report.md"), "utf8")
    expect(report).toContain("## Challenges")
    expect(report).not.toContain(plantedToken)

    const events = readEvents(runFilePath(home, run.runId!))
    expect(events.at(-1)!.event).toBe("end")
    expect(events.filter((e) => e.event === "warn")).toHaveLength(0)
    expect(events.find((e) => e.event === "agent-session")).toMatchObject({
      cli: "claude", session_id: "5d0c8a3e-2f4b-4c1a-9e7d-1b2c3d4e5f60",
    })
    const commands = events.filter((e) => e.event === "agent-command")
    expect(commands.map((c) => [c.cmd, c.exit])).toEqual([
      ["git status --short", 0],
      ["curl -s 'https://ci.example.com/status?token="
        + "[redacted:token-value]'", 0],
      ["just test", 1],
      ["just test", 0],
    ])
    const failed = commands[2]!
    expect(failed.ref).toEqual({ file: "agent.jsonl", line: 10 })
    const copied = copy.split("\n")[9]!
    expect(JSON.parse(copied).message.content[0].tool_use_id).toBe("toolu_04")
  }))

  test("codex stream: copy, commands, session", withHome(async (home) => {
    const run = hostRun(home)
    const result = await runCli(["tap", "--cli", "codex"],
      baseEnv(home, { BOKU_RUN_ID: run.runId! }), fixture("codex-stream.jsonl"))
    run.end(0)
    expect(result.exitCode).toBe(0)
    const copy = readFileSync(join(run.runDir!, "agent.jsonl"), "utf8")
    expect(copy).not.toContain(plantedToken)
    expect(copy).toContain("Bearer [redacted:bearer]")
    expect(existsSync(join(run.runDir!, "report.md"))).toBe(false)

    const events = readEvents(runFilePath(home, run.runId!))
    expect(events.at(-1)!.event).toBe("end")
    expect(events.find((e) => e.event === "agent-session")).toMatchObject({
      cli: "codex", session_id: "019a6f2e-1c3b-7d40-8a5e-2f6b7c8d9e01",
    })
    const commands = events.filter((e) => e.event === "agent-command")
    expect(commands).toHaveLength(3)
    expect(commands[1]).toMatchObject({
      cmd: "just test", exit: 1, ref: { file: "agent.jsonl", line: 7 },
    })
    expect(String(commands[2]!.cmd)).toContain("Bearer [redacted:bearer]")
  }))

  test("session mismatch and unparsed exit warn", withHome(async (home) => {
    const run = hostRun(home)
    const stream = [
      { type: "system", subtype: "init", session_id: "s-actual" },
      { type: "assistant", message: { content: [
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "rm x" } },
      ] } },
      { type: "user", message: { content: [{
        type: "tool_result", tool_use_id: "t1", is_error: true,
        content: [{ type: "text", text: "Permission to use Bash denied" }],
      }] } },
    ].map((o) => JSON.stringify(o)).join("\n")
    const result = await runCli(
      ["tap", "--cli", "claude", "--session-id", "s-expected"],
      baseEnv(home, { BOKU_RUN_ID: run.runId! }), `${stream}\n`)
    run.end(0)
    expect(result.exitCode).toBe(0)
    const events = readEvents(runFilePath(home, run.runId!))
    expect(events.filter((e) => e.event === "warn").map((e) => e.code))
      .toEqual(["session-mismatch", "exit-unparsed"])
    expect(events.find((e) => e.event === "agent-command")).toMatchObject({
      cmd: "rm x", exit: null, ref: { file: "agent.jsonl", line: 3 },
    })
  }))

  test("long lines are cut; the copy cap nulls refs", withHome(async (home) => {
    const run = hostRun(home)
    const lines: string[] = []
    for (let i = 1; i <= 3; i++) {
      lines.push(JSON.stringify({ type: "item.completed", item: {
        id: `item_${i}`, type: "command_execution", command: `step ${i}`,
        aggregated_output: "x".repeat(i === 1 ? 30000 : 10), exit_code: 0,
      } }))
    }
    // Room for the cut first line only.
    const cap = Buffer.byteLength(cutStreamLine(lines[0]!)) + 1 + 10
    const result = await runCli(
      ["tap", "--cli", "codex", "--max-copy-bytes", String(cap)],
      baseEnv(home, { BOKU_RUN_ID: run.runId! }), `${lines.join("\n")}\n`)
    run.end(0)
    expect(result.exitCode).toBe(0)
    const copy = readFileSync(join(run.runDir!, "agent.jsonl"), "utf8")
      .trimEnd().split("\n")
    expect(copy).toHaveLength(1)
    expect(copy[0]!.length).toBeLessThanOrEqual(16384)
    expect(JSON.parse(copy[0]!).item.command).toBe("step 1")
    const commands = readEvents(runFilePath(home, run.runId!))
      .filter((e) => e.event === "agent-command")
    expect(commands[0]).toMatchObject({ ref: { line: 1 } })
    expect(commands[0]!.truncated).toBeUndefined()
    expect(commands[2]).toMatchObject({ ref: null, truncated: true })
  }))

  test("a run folder deleted mid-stream: tap-failed, drain, exit 0",
    withHome(async (home) => {
      const run = hostRun(home)
      const lines = fixture("claude-stream.jsonl").trimEnd().split("\n")
      const proc = Bun.spawn(["bun", cliPath, "tap", "--cli", "claude"], {
        env: baseEnv(home, { BOKU_RUN_ID: run.runId! }),
        stdin: "pipe", stdout: "pipe", stderr: "pipe",
      })
      const agentFile = join(run.runDir!, "agent.jsonl")
      proc.stdin.write(`${lines.slice(0, 4).join("\n")}\n`)
      await proc.stdin.flush()
      for (let i = 0; i < 200; i++) {
        const text = existsSync(agentFile) ? readFileSync(agentFile, "utf8") : ""
        if (text.split("\n").length > 4) break
        await Bun.sleep(10)
      }
      rmSync(run.runDir!, { recursive: true, force: true })
      proc.stdin.write(`${lines.slice(4).join("\n")}\n`)
      await proc.stdin.end()
      const [exitCode, stderr] = await Promise.all([
        proc.exited, new Response(proc.stderr).text(),
      ])
      run.end(0)
      expect(exitCode).toBe(0)
      expect(stderr.split(tapNotice).length - 1).toBe(1)
      const events = readEvents(runFilePath(home, run.runId!))
      expect(events.filter((e) => e.code === "tap-failed")).toHaveLength(1)
      expect(events.filter((e) => e.event === "agent-command")).toHaveLength(1)
      expect(events.at(-1)!.event).toBe("end")
    }))

  test("a crafted run id writes nothing outside BOKU_HOME",
    withHome(async (dir) => {
      const home = join(dir, "home")
      mkdirSync(home)
      const result = await runCli(["tap", "--cli", "claude"], baseEnv(home, {
        BOKU_RUN_ID: "261109T000000Z-x/../../../../escaped",
      }), fixture("claude-stream.jsonl"))
      expect(result.exitCode).toBe(0)
      expect(result.stderr).toContain("agent: Bash just test")
      expect(readdirSync(dir)).toEqual(["home"])
      expect(readdirSync(home)).toEqual([])
    }))

  test("without a run it only shows progress", withHome(async (home) => {
    const result = await runCli(["tap", "--cli", "codex"], baseEnv(home),
      fixture("codex-stream.jsonl"))
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toContain("agent: Bash just test")
    expect(readdirSync(home)).toEqual([])
  }))
})

describe("reader", () => {
  test("list, show --tree, and suffix ids", withHome(async (home) => {
    const env: Env = { BOKU_HOME: home }
    const parent = startRun("sync", { env, rev: null })
    const child = startRun("git_mf", { env, rev: null })
    child.event("warn", { code: "needs-judgment" })
    child.end(3)
    parent.end(0)

    const list = await runCli([], baseEnv(home))
    expect(list.exitCode).toBe(0)
    const rows = list.stdout.trimEnd().split("\n")
    expect(rows).toHaveLength(1)
    expect(rows[0]).toContain(parent.runId!)
    expect(rows[0]).toContain("w1 e0")

    const show = await runCli(
      ["show", parent.runId!.slice(-4), "--tree"], baseEnv(home))
    expect(show.exitCode).toBe(0)
    expect(show.stdout).toContain(`  ${child.runId}  git_mf  stopped  exit=3`)
    expect(show.stdout).toContain("code=needs-judgment")

    const last = await runCli(["show", "last"], baseEnv(home))
    expect(last.stdout.split("\n")[0]).toContain(parent.runId!)
    const missing = await runCli(["show", "zzzz"], baseEnv(home))
    expect(missing.exitCode).toBe(1)
    expect(missing.stderr).toContain("no run matches")
  }))

  test("an ambiguous suffix lists its matches", withHome(async (home) => {
    const day = dayAgo(0)
    plantRun(home, `${stampFor(day)}-a-0abc`, { end: { exit: 0, status: "ok" } })
    plantRun(home, `${stampFor(day)}-b-1abc`, { end: { exit: 0, status: "ok" } })
    const result = await runCli(["show", "abc"], baseEnv(home))
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("matches 2 runs")
  }))

  test("no end: running, then incomplete", withHome(async (home) => {
    const script = join(home, "hold.ts")
    writeFileSync(script, `import { startRun } from ${JSON.stringify(writerPath)}
      const run = startRun("hold", { rev: null })
      console.log(run.runId)
      for await (const _ of Bun.stdin.stream()) {}
    `)
    const proc = Bun.spawn(["bun", script], {
      env: baseEnv(home), stdin: "pipe", stdout: "pipe",
    })
    const reader = proc.stdout.getReader()
    const { value } = await reader.read()
    const runId = new TextDecoder().decode(value).trim()

    const live = await runCli([], baseEnv(home))
    expect(live.stdout).toMatch(new RegExp(`running .*${runId}`))
    proc.kill(9)
    await proc.exited
    const dead = await runCli([], baseEnv(home))
    expect(dead.stdout).toMatch(new RegExp(`incomplete .*${runId}`))

    // Same pid, other start time: pid reuse reads as incomplete.
    plantRun(home, `${stampFor(dayAgo(0))}-reused-beef`, {
      pid: process.pid, pidStart: 1,
    })
    const reused = await runCli(["show", "beef"], baseEnv(home))
    expect(reused.stdout.split("\n")[0]).toContain("incomplete")
  }))

  test("reindex rebuilds a past day only", withHome(async (home) => {
    const past = dayAgo(10)
    plantRun(home, `${stampFor(past)}-git_mf-aaaa`, {
      end: { exit: 3, status: "stopped" },
    })
    plantRun(home, `${stampFor(past)}-sync-bbbb`)
    const result = await runCli(["reindex"], baseEnv(home))
    expect(result.exitCode).toBe(0)
    const index = readEvents(indexPath(home, past))
    expect(index.map((l) => [l.run_id, l.status])).toEqual([
      [`${stampFor(past)}-git_mf-aaaa`, "stopped"],
      [`${stampFor(past)}-sync-bbbb`, "incomplete"],
    ])
    expect(readdirSync(join(home, "runs", past)).some((n) => n.includes(".tmp")))
      .toBe(false)

    const today = dayAgo(0)
    plantRun(home, `${stampFor(today)}-sync-cccc`)
    const refused = await runCli(["reindex", today], baseEnv(home))
    expect(refused.exitCode).toBe(1)
    expect(existsSync(indexPath(home, today))).toBe(false)

    // Past days are read from their index.
    writeFileSync(indexPath(home, past), `${JSON.stringify({
      run_id: `${stampFor(past)}-from-dddd`, parent_run_id: null,
      ts: `${new Date(Date.now() - 10 * dayMs).toISOString()}`,
      status: "ok", exit: 0, dur_ms: 1, warns: 0, errors: 0,
    })}\n`)
    const list = await runCli([], baseEnv(home))
    expect(list.stdout).toContain("from-dddd")
    expect(list.stdout).not.toContain("git_mf-aaaa")
  }))

  test("agent --at shows the line with context", withHome(async (home) => {
    const run = hostRun(home)
    await runCli(["tap", "--cli", "claude"],
      baseEnv(home, { BOKU_RUN_ID: run.runId! }), fixture("claude-stream.jsonl"))
    run.end(0)
    const all = await runCli(["agent", run.runId!.slice(-4)], baseEnv(home))
    expect(all.stdout.trimEnd().split("\n")).toHaveLength(13)
    const at = await runCli(
      ["agent", run.runId!.slice(-4), "--at", "10"], baseEnv(home))
    expect(at.exitCode).toBe(0)
    const lines = at.stdout.split("\n")
    expect(lines[0]).toMatch(/^ {4}7 {2}assistant Bash: curl/)
    expect(at.stdout).toMatch(/> {2}10 {2}user result error: Exit code 1/)
    expect(at.stdout).toContain("\"tool_use_id\": \"toolu_04\"")
    expect(at.stdout).toMatch(/ {3}13 {2}result success/)
    const bad = await runCli(
      ["agent", run.runId!.slice(-4), "--at", "99"], baseEnv(home))
    expect(bad.exitCode).toBe(1)
  }))

  test("challenges prints each section, newest first", withHome(async (home) => {
    const write = (body: string): string => {
      const run = hostRun(home)
      mkdirSync(run.runDir!, { recursive: true })
      writeFileSync(join(run.runDir!, "report.md"), body)
      run.end(0)
      return run.runId!
    }
    const first = write("## Summary\n\nok\n\n## Challenges\n\nFlaky check.\n")
    await Bun.sleep(1100)
    const second = write("## Challenges\n\nNone\n\n## Notes\n\nx\n")
    const result = await runCli(["challenges", "--since", "1d"], baseEnv(home))
    expect(result.exitCode).toBe(0)
    expect(result.stdout.indexOf(second))
      .toBeLessThan(result.stdout.indexOf(first))
    expect(result.stdout).toContain("Flaky check.")
    expect(result.stdout).toContain("None")
    expect(result.stdout).not.toContain("## Notes")
  }))
})

describe("maintenance", () => {
  test("redact-file redacts in place", withHome(async (home) => {
    const token = `ghp_${randomBytes(24).toString("hex")}`
    const file = join(home, "report.md")
    writeFileSync(file, `x ${token} y\n`)
    const result = await runCli(["redact-file", file], baseEnv(home))
    expect(result.exitCode).toBe(0)
    expect(readFileSync(file, "utf8")).toBe("x [redacted:github-token] y\n")
    expect(statSync(file).mode & 0o777).toBe(0o600)
  }))

  const plantDay = (home: string, day: string, bytes: number): void => {
    plantRun(home, `${stampFor(day)}-old-${day.slice(2)}`,
      { end: { exit: 0, status: "ok" } })
    const blob = join(home, "runs", day, "blob")
    writeFileSync(blob, "x".repeat(bytes))
  }

  test("prune removes old days as a child run", withHome(async (home) => {
    for (const age of [40, 31, 30, 10, 1, 0]) plantDay(home, dayAgo(age), 1000)
    const parent = "261109T141203Z-sync-a1b2"
    const result = await runCli(["prune", "30"],
      baseEnv(home, { BOKU_RUN_ID: parent, BOKU_ROOT_RUN_ID: parent }))
    expect(result.exitCode).toBe(0)
    const days = readdirSync(join(home, "runs")).sort()
    expect(days).toEqual([30, 10, 1, 0].map(dayAgo).sort())

    const runFile = readdirSync(join(home, "runs", dayAgo(0)))
      .find((n) => n.includes("-prune-") && n.endsWith(".jsonl"))!
    const events = readEvents(join(home, "runs", dayAgo(0), runFile))
    expect(events[0]).toMatchObject({
      event: "start", parent_run_id: parent, root_run_id: parent, tool: "prune",
    })
    const step = events.find((e) => e.event === "step")!
    expect(step).toMatchObject({ name: "prune", exit: 0, removed_days: 2 })
    expect(step.bytes_freed).toBeGreaterThan(2000)
    expect(events.at(-1)).toMatchObject({ event: "end", exit: 0, status: "ok" })
  }))

  test("prune enforces the size cap, oldest first", withHome(async (home) => {
    plantDay(home, dayAgo(5), 10000)
    plantDay(home, dayAgo(4), 10000)
    plantDay(home, dayAgo(1), 50000)
    plantDay(home, dayAgo(0), 50000)
    // Over the cap by less than one old day; prune's own run adds ~1 KB.
    const cap = pathBytes(join(home, "runs")) - 3000
    const once = await runCli(
      ["prune", "--max-bytes", String(cap)], baseEnv(home))
    expect(once.exitCode).toBe(0)
    expect(existsSync(join(home, "runs", dayAgo(5)))).toBe(false)
    expect(existsSync(join(home, "runs", dayAgo(4)))).toBe(true)

    const pruneRuns = (): string[] => readdirSync(join(home, "runs", dayAgo(0)))
      .filter((n) => n.includes("-prune-") && n.endsWith(".jsonl"))
    const before = pruneRuns()
    const all = await runCli(["prune", "--max-bytes", "1"], baseEnv(home))
    expect(all.exitCode).toBe(0)
    expect(readdirSync(join(home, "runs")).sort())
      .toEqual([dayAgo(1), dayAgo(0)].sort())
    const second = pruneRuns().find((n) => !before.includes(n))!
    const codes = readEvents(join(home, "runs", dayAgo(0), second))
      .filter((e) => e.event === "warn").map((e) => e.code)
    expect(codes).toEqual(["size-cap", "size-cap-unmet"])
  }))
})
