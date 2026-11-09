import { describe, expect, test } from "bun:test"
import { createHash, randomBytes } from "node:crypto"
import {
  appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  cutStreamLine, cutText, dayOf, describeStreamLine, extractChallenges,
  formatEvent, liveStatus, parseExitCode, parseSince, pathBytes, printable,
  pruneSummary, renderStreamLine, safeSlice, tapNotice, UsageError,
  unwrapShell, type Event, type LiveProbe,
} from "./cli.ts"
import {
  buildEvent, checkedRunPaths, indexLine, indexPath, runFilePath, startRun,
  type Env, type RunIdentity, type RunLog,
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
    const home = mkdtempSync(join(tmpdir(), "ud-runs-"))
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
    pid?: number; pidStart?: number; ts?: Date
    /** Also append the run's line to the day's index. */
    indexed?: boolean
  } = {},
): void => {
  const id: RunIdentity = {
    source: "dotfiles", runId, parentRunId: opts.parent ?? null,
    rootRunId: opts.parent ?? runId, tool: runId.split("-")[1]!,
  }
  const startTs = opts.ts ?? new Date(Date.UTC(
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
  if (opts.indexed) {
    appendFileSync(indexPath(home, runId.slice(0, 6)), `${indexLine({
      id, ts: startTs.toISOString(), durMs: 5, exit: opts.end?.exit ?? null,
      status: opts.end?.status ?? "incomplete", warns: 0, errors: 0,
      agent: null,
    })}\n`)
  }
}

/** Noon UTC of a day plus `ms`, for runs started in the same second. */
const noonPlus = (day: string, ms: number): Date =>
  new Date(Date.UTC(2000 + Number(day.slice(0, 2)),
    Number(day.slice(2, 4)) - 1, Number(day.slice(4, 6)), 12, 0, 0, ms))

const stampFor = (day: string): string => `${day}T120000Z`

/** Appends raw events to a planted run's file. */
const appendEvents = (home: string, runId: string, events: Event[]): void =>
  appendFileSync(runFilePath(home, runId),
    events.map((e) => `${JSON.stringify(e)}\n`).join(""))

const esc = "\x1b"
/** True when text has a raw C0 (other than newline and tab), DEL, or C1. */
const hasControl = (text: string): boolean =>
  /[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(text)
/** True when text has a surrogate that isn't half of a pair. */
const hasLoneSurrogate = (text: string): boolean =>
  /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/
    .test(text)

describe("pure helpers", () => {
  test("renderStreamLine prints Codex items and unknown lines", () => {
    const item = JSON.stringify({ type: "item.completed", item: {
      type: "command_execution", command: "/usr/bin/bash -lc 'just test'",
      aggregated_output: "ok 1\nok 2\n", exit_code: 0,
    } })
    expect(renderStreamLine(item)).toEqual([
      "item.completed command_execution exit=0",
      "  $ just test", "  ok 1", "  ok 2",
    ])
    expect(renderStreamLine('{"type":"turn.started"}')).toEqual([
      "turn.started", "  {", "    \"type\": \"turn.started\"", "  }",
    ])
    expect(renderStreamLine("not json")).toEqual(["not json"])
  })

  test("pruneSummary is one line", () => {
    const base = {
      removedDays: ["261001"], bytesFreed: 2150, cappedDays: [], bytesLeft: 0,
      reindexedDays: [],
    }
    expect(pruneSummary(base)).toBe("removed 1 day (2.1 KB freed)")
    expect(pruneSummary({
      ...base, removedDays: [], bytesFreed: 0, reindexedDays: ["a", "b"],
    })).toBe("removed 0 days (0 B freed); reindexed 2 days")
  })

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
    expect(parseSince("3650d", now).getTime()).toBe(now.getTime() - 3650 * dayMs)
    expect(parseSince("2026-11-01", now).toISOString())
      .toBe("2026-11-01T00:00:00.000Z")
    expect(parseSince("2026-11-01T10:00Z", now).toISOString())
      .toBe("2026-11-01T10:00:00.000Z")
    expect(parseSince("2026-11-01 10:00:30+02:00", now).toISOString())
      .toBe("2026-11-01T08:00:30.000Z")
    expect(parseSince("2026-11-01T10:00", now).getTime())
      .toBe(new Date(2026, 10, 1, 10).getTime())
  })

  test("parseSince refuses anything but Nd, Nh, or an ISO date", () => {
    for (const bad of [
      "7", "Nov 1", "11/01", "2026", "99999999999d", "3651d", "87601h", "0d",
      "-1d", "1.5d", "soon", "", "2026-02-31", "2026-13-01", "2026-11-01T25:00",
    ]) {
      expect(() => parseSince(bad)).toThrow(UsageError)
    }
    expect(() => parseSince("7")).toThrow(/use 30d, 12h, or a date/)
  })

  test("printable escapes C0, DEL, and C1 but keeps newline and tab", () => {
    expect(printable("a\tb\nc")).toBe("a\tb\nc")
    expect(printable(`${esc}]52;c;cHduZWQK\x07`))
      .toBe("\\x1b]52;c;cHduZWQK\\x07")
    expect(printable("\x00\r\x7f\x9b\u00a0é😀"))
      .toBe("\\x00\\x0d\\x7f\\x9b\u00a0é😀")
    expect(printable(printable(`${esc}[31m`))).toBe("\\x1b[31m")
  })

  test("formatEvent escapes an OSC 52 payload in a session id", () => {
    const osc = `x${esc}]52;c;cHduZWQK\x07y`
    const line = formatEvent({
      event: "agent-session", ts: "2026-11-09T00:00:00.000Z", session_id: osc,
    })
    expect(hasControl(line)).toBe(false)
    expect(line).toContain("session_id=x\\x1b]52;c;cHduZWQK\\x07y")
    const spaced = formatEvent({ event: "warn", msg: `a b${esc}[2J\u009b` })
    expect(hasControl(spaced)).toBe(false)
    expect(spaced).toContain("\\u001b[2J\\x9b")
  })

  test("cuts never leave a lone surrogate", () => {
    const emoji = "😀".repeat(10)
    for (let n = 0; n <= emoji.length; n++) {
      expect(hasLoneSurrogate(safeSlice(emoji, 0, n))).toBe(false)
      expect(hasLoneSurrogate(safeSlice(emoji, n))).toBe(false)
      expect(hasLoneSurrogate(cutText(emoji, n))).toBe(false)
    }
    expect(safeSlice("a😀", 0, 2)).toBe("a")
    expect(cutText("a😀b", 2)).toBe("a[cut]")

    // Not JSON: the cut lands mid-pair at 16379 units.
    const plain = `a${"😀".repeat(9000)}`
    const cutPlain = cutStreamLine(plain)
    expect(cutPlain.length).toBeLessThanOrEqual(16384)
    expect(cutPlain.endsWith("[cut]")).toBe(true)
    expect(hasLoneSurrogate(cutPlain)).toBe(false)
    // JSON: every string is cut at an odd unit count.
    const json = JSON.stringify({ type: "user", text: `a${"😀".repeat(9000)}` })
    const cutJson = cutStreamLine(json)
    expect(cutJson.length).toBeLessThanOrEqual(16384)
    const text = JSON.parse(cutJson).text as string
    expect(text.endsWith("[cut]")).toBe(true)
    expect(hasLoneSurrogate(text)).toBe(false)
    expect(hasLoneSurrogate(cutJson)).toBe(false)

    const line = JSON.stringify({ type: "result", subtype: "success",
      result: `a${"😀".repeat(80)}` })
    expect(hasLoneSurrogate(describeStreamLine(line))).toBe(false)
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

    // One artifact event for the stream, after the commands, before `end`.
    const artifacts = events.filter((e) => e.event === "artifact")
    expect(artifacts).toEqual([expect.objectContaining({
      kind: "agent-stream", path: "agent.jsonl",
      bytes: Buffer.byteLength(copy),
      sha256: createHash("sha256").update(copy).digest("hex"),
      truncated: false,
    })])
    const at = events.findIndex((e) => e.event === "artifact")
    expect(at).toBeGreaterThan(
      events.findLastIndex((e) => e.event === "agent-command"))
    expect(at).toBe(events.length - 2)
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

  test("quoted secrets in stream strings: redacted, lines stay JSON",
    withHome(async (home) => {
      const run = hostRun(home)
      const password = `hunter2-${randomBytes(8).toString("hex")}`
      const token = `abc123${randomBytes(8).toString("hex")}`
      const filler = "y".repeat(20000)
      const stream = [
        { type: "assistant", message: { content: [{
          type: "tool_use", id: "t1", name: "Bash",
          input: { command: `curl "https://x/?token=${token}"` },
        }] } },
        { type: "user", message: { content: [{
          type: "tool_result", tool_use_id: "t1",
          content: `DB_PASSWORD="${password}"\nAPI_KEY="${token}"`,
        }] } },
        // Over the 16,384-character line cut.
        { type: "user", message: { content: [{
          type: "tool_result", tool_use_id: "t1",
          content: `SECRET="0x${token}" ${filler}`,
        }] } },
      ].map((o) => JSON.stringify(o)).join("\n")
      const result = await runCli(["tap", "--cli", "claude"],
        baseEnv(home, { BOKU_RUN_ID: run.runId! }), `${stream}\n`)
      run.end(0)
      expect(result.exitCode).toBe(0)
      const copy = readFileSync(join(run.runDir!, "agent.jsonl"), "utf8")
      expect(copy).not.toContain(password)
      expect(copy).not.toContain(token)
      const lines = copy.trimEnd().split("\n")
      expect(lines).toHaveLength(3)
      for (const line of lines) {
        expect(line.length).toBeLessThanOrEqual(16384)
        expect(() => JSON.parse(line)).not.toThrow()
      }
      expect(JSON.parse(lines[0]!).message.content[0].input.command)
        .toBe('curl "https://x/?token=[redacted:token-value]"')
      expect(JSON.parse(lines[1]!).message.content[0].content).toBe(
        'DB_PASSWORD="[redacted:password-value]"\n'
        + 'API_KEY="[redacted:api-key-value]"')
      expect(JSON.parse(lines[2]!).message.content[0].content).toStartWith(
        'SECRET="[redacted:secret-value]" yyy')
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
    const artifact = readEvents(runFilePath(home, run.runId!))
      .find((e) => e.event === "artifact")
    expect(artifact).toMatchObject({
      kind: "agent-stream", path: "agent.jsonl", truncated: true,
      bytes: statSync(join(run.runDir!, "agent.jsonl")).size,
    })
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

  test("progress lines print terminal controls as text",
    withHome(async (home) => {
      const run = hostRun(home)
      const osc = `printf '${esc}]52;c;cHduZWQK\x07' # x`
      const stream = [
        { type: "assistant", message: { content: [{
          type: "tool_use", id: "t1", name: "Bash", input: { command: osc },
        }] } },
      ].map((o) => JSON.stringify(o)).join("\n")
      const result = await runCli(["tap", "--cli", "claude"],
        baseEnv(home, { BOKU_RUN_ID: run.runId! }), `${stream}\n`)
      run.end(0)
      expect(result.exitCode).toBe(0)
      expect(hasControl(result.stderr)).toBe(false)
      expect(result.stderr).toContain("agent: Bash printf '\\x1b]52;c;")
    }))

  /** Runs the Claude fixture through the tap of a run hosted here. */
  const tapInto = async (home: string, run: RunLog): Promise<CliResult> => {
    const result = await runCli(["tap", "--cli", "claude"],
      baseEnv(home, { BOKU_RUN_ID: run.runId! }),
      fixture("claude-stream.jsonl"))
    run.end(0)
    return result
  }

  /** Files under `dir`, by path relative to it. */
  const listTree = (dir: string): string[] =>
    readdirSync(dir, { recursive: true }).map(String).sort()

  test("a symlinked run folder: tap-failed, nothing written through it",
    withHome(async (dir) => {
      const home = join(dir, "home")
      const outside = join(dir, "outside")
      mkdirSync(home)
      mkdirSync(outside)
      const run = hostRun(home)
      symlinkSync(outside, run.runDir!)
      const result = await tapInto(home, run)
      expect(result.exitCode).toBe(0)
      expect(result.stderr.split(tapNotice).length - 1).toBe(1)
      expect(listTree(outside)).toEqual([])
      const events = readEvents(runFilePath(home, run.runId!))
      expect(events.filter((e) => e.code === "tap-failed")).toHaveLength(1)
      expect(events.filter((e) => e.event === "artifact")).toHaveLength(0)
      expect(events.at(-1)!.event).toBe("end")
    }))

  test("symlinked agent.jsonl and report.md: refused, nothing written",
    withHome(async (dir) => {
      const home = join(dir, "home")
      const outside = join(dir, "outside")
      mkdirSync(home)
      mkdirSync(outside)
      const run = hostRun(home)
      mkdirSync(run.runDir!, { mode: 0o700 })
      symlinkSync(join(outside, "stolen"), join(run.runDir!, "agent.jsonl"))
      symlinkSync(join(outside, "rep"), join(run.runDir!, "report.md"))
      const result = await tapInto(home, run)
      expect(result.exitCode).toBe(0)
      expect(result.stderr.split(tapNotice).length - 1).toBe(1)
      expect(listTree(outside)).toEqual([])
      const events = readEvents(runFilePath(home, run.runId!))
      expect(events.filter((e) => e.code === "tap-failed")).toHaveLength(1)
      expect(events.filter((e) => e.event === "artifact")).toHaveLength(0)
      expect(events.at(-1)!.event).toBe("end")
    }))

  test("a symlinked report.md alone: refused, the copy still saved",
    withHome(async (dir) => {
      const home = join(dir, "home")
      const outside = join(dir, "outside")
      mkdirSync(home)
      mkdirSync(outside)
      const run = hostRun(home)
      mkdirSync(run.runDir!, { mode: 0o700 })
      symlinkSync(join(outside, "rep"), join(run.runDir!, "report.md"))
      const result = await tapInto(home, run)
      expect(result.exitCode).toBe(0)
      expect(listTree(outside)).toEqual([])
      const copy = readFileSync(join(run.runDir!, "agent.jsonl"), "utf8")
      expect(copy.trimEnd().split("\n")).toHaveLength(
        fixture("claude-stream.jsonl").trimEnd().split("\n").length)
      const events = readEvents(runFilePath(home, run.runId!))
      expect(events.filter((e) => e.code === "tap-failed")).toHaveLength(1)
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

  test("an empty stream writes no artifact event", withHome(async (home) => {
    const run = hostRun(home)
    await runCli(["tap", "--cli", "codex"],
      baseEnv(home, { BOKU_RUN_ID: run.runId! }), "")
    run.end(0)
    const events = readEvents(runFilePath(home, run.runId!))
    expect(events.filter((e) => e.event === "artifact")).toHaveLength(0)
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

  test("runs in one second sort by start time, not by hex",
    withHome(async (home) => {
      for (const day of [dayAgo(0), dayAgo(10)]) {
        const stamp = stampFor(day)
        const ended = { exit: 0, status: "ok" }
        // Start order is ffff, aaaa, 0000: the reverse of the id order.
        for (const [hex, ms] of [["ffff", 100], ["aaaa", 200], ["0000", 300]]) {
          plantRun(home, `${stamp}-top-${hex}`, {
            end: ended, ts: noonPlus(day, Number(ms)), indexed: true,
          })
        }
        const parent = `${stamp}-top-0000`
        for (const [hex, ms] of [["fff1", 400], ["0001", 500]]) {
          plantRun(home, `${stamp}-kid-${hex}`, {
            parent, end: ended, ts: noonPlus(day, Number(ms)), indexed: true,
          })
        }
      }
      const list = await runCli([], baseEnv(home))
      const ids = list.stdout.trimEnd().split("\n")
        .map((row) => row.split("  ").at(-1)!.slice(-4))
      expect(ids).toEqual(["0000", "aaaa", "ffff", "0000", "aaaa", "ffff"])
      expect(list.stdout.split("\n")[0]).toContain(stampFor(dayAgo(0)))

      const last = await runCli(["show", "last", "--tree"], baseEnv(home))
      const heads = last.stdout.split("\n")
        .filter((l) => /^ *\d{6}T\d{6}Z-/.test(l)).map((l) => l.trim())
      expect(heads.map((h) => h.split(" ")[0]!.slice(-8))).toEqual([
        "top-0000", "kid-fff1", "kid-0001",
      ])
      expect(heads[0]).toContain(stampFor(dayAgo(0)))
    }))

  test("index lines with a bad run id are ignored", withHome(async (home) => {
    const past = dayAgo(10)
    plantRun(home, `${stampFor(past)}-good-aaaa`, {
      end: { exit: 0, status: "ok" }, indexed: true,
    })
    appendFileSync(indexPath(home, past), `${JSON.stringify({
      run_id: `${stampFor(past)}-x/../../../../escaped`, parent_run_id: null,
      ts: noonPlus(past, 1).toISOString(), status: "ok",
    })}\n`)
    const list = await runCli([], baseEnv(home))
    expect(list.stdout).toContain("good-aaaa")
    expect(list.stdout).not.toContain("escaped")
    const show = await runCli(["show", "escaped"], baseEnv(home))
    expect(show.exitCode).toBe(1)
    expect(show.stderr).toContain("no run matches")
  }))

  test("an ambiguous id picks the newest and names the others",
    withHome(async (home) => {
      const day = dayAgo(0)
      const ok = { exit: 0, status: "ok" }
      const older = `${stampFor(day)}-b-1abc`
      const newer = `${stampFor(day)}-a-0abc`
      plantRun(home, older, { end: ok, ts: noonPlus(day, 1) })
      plantRun(home, newer, { end: ok, ts: noonPlus(day, 2) })
      const result = await runCli(["show", "abc"], baseEnv(home))
      expect(result.exitCode).toBe(0)
      expect(result.stdout.split("\n")[0]).toContain(newer)
      expect(result.stderr).toBe(`ud runs: "abc" matches 2 runs; showing ${
        newer}; others: ${older}\n`)
    }))

  test("ids match by prefix or any substring", withHome(async (home) => {
    const ok = { exit: 0, status: "ok" }
    const today = `${stampFor(dayAgo(0))}-git_mf-28b9`
    const past = `${stampFor(dayAgo(10))}-sync-28b9`
    plantRun(home, today, { end: ok })
    plantRun(home, past, { end: ok })
    for (const [query, want] of [
      [dayAgo(10), past], [`${dayAgo(0)}T12`, today], ["git_mf", today],
      ["sync-28", past], ["28b9", today],
    ] as const) {
      const result = await runCli(["show", query], baseEnv(home))
      expect(result.exitCode).toBe(0)
      expect(result.stdout.split("\n")[0]).toContain(want)
    }
  }))

  test("a child whose parent day was pruned is top-level",
    withHome(async (home) => {
      const ok = { exit: 0, status: "ok" }
      const parent = `${stampFor(dayAgo(12))}-sync-aaaa`
      const child = `${stampFor(dayAgo(11))}-git_mf-bbbb`
      const grandchild = `${stampFor(dayAgo(11))}-just-cccc`
      plantRun(home, parent, { end: ok, indexed: true })
      plantRun(home, child, {
        parent, end: { exit: 3, status: "stopped" }, indexed: true,
      })
      plantRun(home, grandchild, { parent: child, end: ok, indexed: true })
      appendEvents(home, grandchild, [{ event: "warn", code: "x" }])
      rmSync(join(home, "runs", dayAgo(12)), { recursive: true, force: true })

      const list = await runCli([], baseEnv(home))
      const rows = list.stdout.trimEnd().split("\n")
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatch(/stopped .*git_mf-bbbb$/)
      const last = await runCli(["show", "last", "--tree"], baseEnv(home))
      expect(last.exitCode).toBe(0)
      expect(last.stdout.split("\n")[0]).toContain(child)
      expect(last.stdout).toContain(`  ${grandchild}  just  ok`)
    }))

  test("a parent cycle prints each run once", withHome(async (home) => {
    const ok = { exit: 0, status: "ok" }
    const a = `${stampFor(dayAgo(0))}-a-aaaa`
    const b = `${stampFor(dayAgo(0))}-b-bbbb`
    plantRun(home, a, { parent: b, end: ok, ts: noonPlus(dayAgo(0), 1) })
    plantRun(home, b, { parent: a, end: ok, ts: noonPlus(dayAgo(0), 2) })
    const tree = await runCli(["show", "aaaa", "--tree"], baseEnv(home))
    expect(tree.exitCode).toBe(0)
    const heads = tree.stdout.split("\n").filter((l) => /^ *\d{6}T/.test(l))
    expect(heads.map((l) => l.trim().split(" ")[0])).toEqual([a, b, a])
    expect(heads[2]).toContain("(cycle: shown above)")
    const list = await runCli([], baseEnv(home))
    expect(list.exitCode).toBe(0)
    expect(list.stdout.trimEnd().split("\n")).toHaveLength(2)
    const self = `${stampFor(dayAgo(0))}-self-cccc`
    plantRun(home, self, { parent: self, end: ok })
    const own = await runCli(["show", "cccc", "--tree"], baseEnv(home))
    expect(own.exitCode).toBe(0)
    expect(own.stdout).toContain("(cycle: shown above)")
  }))

  test("show last on an empty home says so and exits 0",
    withHome(async (home) => {
      for (const args of [["show", "last"], ["show", "last", "--tree"]]) {
        const result = await runCli(args, baseEnv(home))
        expect(result.exitCode).toBe(0)
        expect(result.stdout).toBe("")
        expect(result.stderr).toContain("no runs yet")
      }
    }))

  test("readers escape terminal controls", withHome(async (home) => {
    const ok = { exit: 0, status: "ok" }
    const runId = `${stampFor(dayAgo(0))}-git_mf-e5c0`
    plantRun(home, runId, { end: ok })
    const osc = `x${esc}]52;c;cHduZWQK\x07y`
    const evil = `evil${esc}]0;PWNED\x07.rs`
    appendEvents(home, runId, [
      { event: "agent-session", cli: "claude", session_id: osc },
      { event: "artifact", kind: "remerge-diff", path: evil },
    ])
    const dir = checkedRunPaths(home, runId).dir
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "report.md"),
      `## Challenges\n\nRed ${esc}[31mtext${esc}[0m and ${esc}[2J\n`)
    writeFileSync(join(dir, "agent.jsonl"), [
      { type: "system", subtype: "init", session_id: osc },
      { type: "assistant", message: { content: [
        { type: "text", text: `done ${esc}]0;PWNED-TITLE\x07${esc}[2J` },
        { type: "tool_use", id: "t1", name: "Read",
          input: { file_path: `/repo/${evil}` } },
      ] } },
    ].map((l) => `${JSON.stringify(l)}\n`).join(""))

    const outputs = await Promise.all([
      ["show", "e5c0"], ["show", "last", "--tree"], ["agent", "e5c0"],
      ["agent", "last", "--at", "2"], ["agent", "e5c0", "--at", "1", "--raw"],
      ["challenges"], [],
    ].map((args) => runCli(args, baseEnv(home))))
    for (const out of outputs) {
      expect(out.exitCode).toBe(0)
      expect(hasControl(out.stdout)).toBe(false)
    }
    const [show, , , at, , challenges] = outputs.map((o) => o.stdout)
    expect(show).toContain("session_id=x\\x1b]52;c;cHduZWQK\\x07y")
    expect(show).toContain("path=evil\\x1b]0;PWNED\\x07.rs")
    expect(at).toContain("Read: /repo/evil\\x1b]0;PWNED\\x07.rs")
    expect(at).toContain("done \\x1b]0;PWNED-TITLE\\x07\\x1b[2J")
    expect(challenges).toContain("Red \\x1b[31mtext\\x1b[0m and \\x1b[2J")
    const query = await runCli(["show", `zz${esc}[2J`], baseEnv(home))
    expect(hasControl(query.stderr)).toBe(false)
  }))

  test("an empty log says so", withHome(async (home) => {
    for (const args of [[], ["list"]]) {
      const result = await runCli(args, baseEnv(home))
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe("")
      expect(result.stderr).toBe(
        `ud runs: no runs yet in ${join(home, "runs")}\n`)
    }
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

    const missing = await runCli(["reindex", "251231"], baseEnv(home))
    expect(missing.exitCode).toBe(0)
    expect(missing.stderr).toBe("no runs for 251231\n")
    expect(existsSync(join(home, "runs", "251231"))).toBe(false)

    // Past days are read from their index, plus run files it lacks.
    writeFileSync(indexPath(home, past), `${JSON.stringify({
      run_id: `${stampFor(past)}-git_mf-aaaa`, parent_run_id: null,
      ts: `${new Date(Date.now() - 10 * dayMs).toISOString()}`,
      status: "from-index", exit: 0, dur_ms: 1, warns: 0, errors: 0,
    })}\n`)
    const list = await runCli([], baseEnv(home))
    expect(list.stdout).toMatch(/from-index .*git_mf-aaaa/)
    expect(list.stdout).toMatch(/incomplete .*sync-bbbb/)
  }))

  test("a past day shows killed runs its index lacks, with children",
    withHome(async (home) => {
      const past = dayAgo(10)
      const stamp = stampFor(past)
      const done = { exit: 0, status: "ok" }
      plantRun(home, `${stamp}-done-aaaa`, {
        end: done, indexed: true, ts: noonPlus(past, 1),
      })
      const killed = `${stamp}-sync-bbbb`
      plantRun(home, killed, { ts: noonPlus(past, 2) })
      plantRun(home, `${stamp}-git_mf-cccc`, {
        parent: killed, end: { exit: 3, status: "stopped" }, indexed: true,
        ts: noonPlus(past, 3),
      })
      const list = await runCli([], baseEnv(home))
      const rows = list.stdout.trimEnd().split("\n")
      expect(rows).toHaveLength(2)
      expect(rows[0]).toMatch(new RegExp(`incomplete .*${killed}`))
      expect(rows[1]).toContain("done-aaaa")

      const tree = await runCli(["show", "sync-bbbb", "--tree"], baseEnv(home))
      expect(tree.exitCode).toBe(0)
      expect(tree.stdout).toContain(`  ${stamp}-git_mf-cccc  git_mf  stopped`)
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
    // The line itself: a header, then its text with real newlines.
    const at10 = lines.findIndex((l) => l.startsWith(">  10"))
    expect(lines.slice(at10 + 1, at10 + 5)).toEqual([
      "        user tool_result toolu_04 error",
      "          Exit code 1",
      "          error[E0425]: cannot find value `x` in this scope",
      "           --> src/a.rs:3:5",
    ])
    expect(at.stdout).not.toContain("\\n")
    expect(at.stdout).toMatch(/ {3}13 {2}result success/)

    const tool = await runCli(
      ["agent", run.runId!.slice(-4), "--at", "7", "-C", "0"], baseEnv(home))
    expect(tool.stdout.split("\n").slice(1, 4)).toEqual([
      "        assistant tool_use Bash toolu_03",
      "          command: curl -s 'https://ci.example.com/status?token="
        + "[redacted:token-value]'",
      "          description: Check CI status",
    ])

    const raw = await runCli(
      ["agent", run.runId!.slice(-4), "--at", "10", "--raw"], baseEnv(home))
    expect(raw.stdout).toContain("\"tool_use_id\": \"toolu_04\"")
    expect(raw.stdout).not.toContain("user tool_result toolu_04")
    const bad = await runCli(
      ["agent", run.runId!.slice(-4), "--at", "99"], baseEnv(home))
    expect(bad.exitCode).toBe(1)
  }))

  test("agent last is the newest run with an agent", withHome(async (home) => {
    const none = await runCli(["agent", "last"], baseEnv(home))
    expect(none.exitCode).toBe(1)
    expect(none.stderr).toContain("no agent runs yet")

    const run = hostRun(home)
    await runCli(["tap", "--cli", "claude"],
      baseEnv(home, { BOKU_RUN_ID: run.runId! }), fixture("claude-stream.jsonl"))
    run.end(0)
    const later = hostRun(home, "plain")
    later.end(0)
    const result = await runCli(["agent", "last"], baseEnv(home))
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trimEnd().split("\n")).toHaveLength(13)
    const show = await runCli(["show", "last"], baseEnv(home))
    expect(show.stdout.split("\n")[0]).toContain(later.runId!)
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

  test("challenges: outcome, failed commands as --at lines, no report",
    withHome(async (home) => {
      const day = dayAgo(0)
      const ok = { exit: 0, status: "ok" }
      const reported = `${stampFor(day)}-git_mf-1a2b`
      const crashed = `${stampFor(day)}-git_mf-3c4d`
      const plain = `${stampFor(day)}-sync-5e6f`
      plantRun(home, reported, { end: ok, ts: noonPlus(day, 1) })
      plantRun(home, crashed, {
        end: { exit: 1, status: "failed" }, ts: noonPlus(day, 2),
      })
      plantRun(home, plain, { end: ok, ts: noonPlus(day, 3) })
      appendEvents(home, reported, [
        { event: "agent-session", cli: "claude", session_id: "s1" },
        { event: "agent-command", cmd: "git status", exit: 0,
          ref: { file: "agent.jsonl", line: 4 } },
        { event: "agent-command", cmd: `just\n test ${esc}[2J`, exit: 1,
          ref: { file: "agent.jsonl", line: 10 } },
        { event: "agent-command", cmd: "cargo build", exit: 101, ref: null,
          truncated: true },
        { event: "agent", cli: "claude", outcome: "merged", exit: 0 },
      ])
      const dir = checkedRunPaths(home, reported).dir
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, "report.md"),
        "## Summary\n\nok\n\n## Challenges\n\nFlaky check.\n")
      appendEvents(home, crashed, [
        { event: "agent-session", cli: "codex", session_id: "s2" },
        { event: "agent-command", cmd: "just lint", exit: null,
          ref: { file: "agent.jsonl", line: 7 } },
        { event: "agent", cli: "codex", outcome: "report-missing", exit: 1 },
      ])

      const result = await runCli(["challenges"], baseEnv(home))
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe([
        `== ${crashed}  report-missing  ${day.replace(/^(..)(..)(..)$/,
          "20$1-$2-$3")} 12:00:00`,
        "(no report)",
        "failed commands:",
        "  ud runs agent 3c4d --at 7  # exit ?: just lint",
        "",
        `== ${reported}  merged  ${day.replace(/^(..)(..)(..)$/,
          "20$1-$2-$3")} 12:00:00`,
        "Flaky check.",
        "failed commands:",
        "  ud runs agent 1a2b --at 10  # exit 1: just test \\x1b[2J",
        "  (not in agent.jsonl)  # exit 101: cargo build",
        "", "",
      ].join("\n"))
      expect(result.stdout).not.toContain(plain)
    }))

  test("challenges --since refuses a bad window with exit 2",
    withHome(async (home) => {
      for (const bad of ["7", "Nov 1", "99999999999d"]) {
        const result = await runCli(["challenges", "--since", bad],
          baseEnv(home))
        expect(result.exitCode).toBe(2)
        expect(result.stdout).toBe("")
        expect(result.stderr).toContain(`bad --since "${bad}"`)
      }
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

  test("redact-file keeps JSON lines valid", withHome(async (home) => {
    const secret = randomBytes(8).toString("hex")
    const file = join(home, "agent.jsonl")
    writeFileSync(file, `${JSON.stringify({ out: `TOKEN="${secret}"` })}\n`
      + `TOKEN=\\"${secret}\\" not json\n`)
    const result = await runCli(["redact-file", file], baseEnv(home))
    expect(result.exitCode).toBe(0)
    expect(readFileSync(file, "utf8")).toBe(
      '{"out":"TOKEN=\\"[redacted:token-value]\\""}\n'
      + 'TOKEN=\\"[redacted:token-value]\\" not json\n')
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
    // The planted days have no index, so prune rebuilds the two it keeps.
    expect(result.stderr).toMatch(
      /^removed 2 days \(\d+\.\d KB freed\); reindexed 2 days\n$/)
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

  test("prune reindexes past days with a missing or partial index",
    withHome(async (home) => {
      const partial = dayAgo(10)
      const none = dayAgo(12)
      const done = { exit: 0, status: "ok" }
      plantRun(home, `${stampFor(partial)}-done-aaaa`,
        { end: done, indexed: true })
      plantRun(home, `${stampFor(partial)}-killed-bbbb`)
      plantRun(home, `${stampFor(none)}-done-cccc`, { end: done })
      const full = dayAgo(14)
      plantRun(home, `${stampFor(full)}-done-dddd`, { end: done, indexed: true })
      const fullIndex = readFileSync(indexPath(home, full), "utf8")

      const result = await runCli(["prune", "30"], baseEnv(home))
      expect(result.exitCode).toBe(0)
      expect(readEvents(indexPath(home, partial))
        .map((l) => [l.run_id, l.status])).toEqual([
        [`${stampFor(partial)}-done-aaaa`, "ok"],
        [`${stampFor(partial)}-killed-bbbb`, "incomplete"],
      ])
      expect(readEvents(indexPath(home, none)).map((l) => l.run_id))
        .toEqual([`${stampFor(none)}-done-cccc`])
      expect(readFileSync(indexPath(home, full), "utf8")).toBe(fullIndex)
      const pruneFile = readdirSync(join(home, "runs", dayAgo(0)))
        .find((n) => n.includes("-prune-") && n.endsWith(".jsonl"))!
      const step = readEvents(join(home, "runs", dayAgo(0), pruneFile))
        .find((e) => e.event === "step")!
      expect(step).toMatchObject({ removed_days: 0, reindexed_days: 2 })
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

describe("ud plugin", () => {
  const cli = join(import.meta.dir, "cli.ts")

  test("--plugin-info prints the metadata ud validates", () => {
    const r = Bun.spawnSync(["bun", cli, "--plugin-info"])
    expect(r.exitCode).toBe(0)
    expect(JSON.parse(r.stdout.toString())).toEqual({
      apiVersion: 1,
      name: "runs",
      description: expect.any(String),
    })
  })

  // Runs only where ud is installed: `ud runs` dispatches to ud-runs in
  // UD_PLUGIN_PATH.
  test.skipIf(!Bun.which("ud"))("ud lists and runs it as `ud runs`", () => {
    const dir = mkdtempSync(join(tmpdir(), "ud-plugin-"))
    symlinkSync(cli, join(dir, "ud-runs"))
    const home = mkdtempSync(join(tmpdir(), "boku-home-"))
    const env = {
      ...process.env,
      UD_PLUGIN_PATH: dir,
      BOKU_HOME: home,
      XDG_CACHE_HOME: mkdtempSync(join(tmpdir(), "ud-cache-")),
    }
    const help = Bun.spawnSync(["ud", "--help"], { env })
    expect(help.stdout.toString()).toMatch(/\n\s+runs\s+Read the Boku run log/)
    const list = Bun.spawnSync(["ud", "runs"], { env })
    expect(list.exitCode).toBe(0)
    expect(list.stderr.toString()).toContain("no runs yet")
  })
})
