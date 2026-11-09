import { describe, expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import {
  appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  statSync, writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  artifactName, attachRun, buildEvent, checkedRunPaths, indexPath, isRunId, maxLineBytes,
  newRunId, readCapped, redact, runFilePath, safeToolName, startRun, statusFor, type Env,
  type RunIdentity,
} from "./runlog.ts"

const writerPath = join(import.meta.dir, "runlog.ts")

const withHome = (run: (home: string) => void | Promise<void>) =>
  async (): Promise<void> => {
    const home = mkdtempSync(join(tmpdir(), "boku-runlog-"))
    try {
      await run(home)
    } finally {
      chmodSync(home, 0o700)
      rmSync(home, { force: true, recursive: true })
    }
  }

const readLines = (file: string): Record<string, unknown>[] =>
  readFileSync(file, "utf8").trimEnd().split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>)

/** Fake tokens built at test time, so no literal secret sits in the repo. */
const fakeTokens = (): Record<string, string> => {
  const alnum = (n: number): string =>
    randomBytes(n).toString("base64").replace(/[^A-Za-z0-9]/g, "a").slice(0, n)
  return {
    "github-token": `ghp_${alnum(36)}`,
    "github-pat": `github_pat_${alnum(40)}`,
    "anthropic-key": `sk-ant-${alnum(30)}`,
    "slack-token": `xoxb-${alnum(20)}`,
    "aws-key": `AKIA${alnum(16).toUpperCase()}`,
  }
}

/** Runs a short TS script against the writer in its own process. */
const runScript = async (
  dir: string, body: string, env: Env,
): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  const script = join(dir, `script-${randomBytes(3).toString("hex")}.ts`)
  const header = `import * as w from ${JSON.stringify(writerPath)}\n`
  writeFileSync(script, `${header}${body}`)
  const proc = Bun.spawn(["bun", script], {
    env: { ...process.env, BOKU_RUN_ID: "", BOKU_ROOT_RUN_ID: "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  rmSync(script, { force: true })
  return { exitCode, stdout, stderr }
}

const id: RunIdentity = {
  source: "dotfiles",
  runId: "261109T142030Z-test-8b9c",
  parentRunId: null,
  rootRunId: "261109T142030Z-test-8b9c",
  tool: "test",
}

describe("pure helpers", () => {
  test("statusFor maps exit codes and lets an explicit status win", () => {
    expect(statusFor(0)).toBe("ok")
    for (const exit of [2, 3, 4, 5]) expect(statusFor(exit)).toBe("stopped")
    for (const exit of [1, 6, 101, 130, -1]) {
      expect(statusFor(exit)).toBe("failed")
    }
    expect(statusFor(0, "stopped")).toBe("stopped")
    expect(statusFor(5, "failed")).toBe("failed")
  })

  test("newRunId sorts by time and names its day and tool", () => {
    const at = new Date("2026-11-09T14:20:30.101Z")
    const runId = newRunId("git_mf", at, "8b9c")
    expect(runId).toBe("261109T142030Z-git_mf-8b9c")
    expect(newRunId("a b/c")).toMatch(/^\d{6}T\d{6}Z-a-b-c-[0-9a-f]{4}$/)
  })

  test("safeToolName matches the bash writer", () => {
    expect(safeToolName("git_mf")).toBe("git_mf")
    expect(safeToolName("a b/c:d")).toBe("a-b-c-d")
    expect(safeToolName("naïve😀")).toBe("na-ve-")
    expect(safeToolName("x".repeat(50))).toBe("x".repeat(40))
    expect(safeToolName("")).toBe("run")
  })

  test("isRunId takes only the exact id shape", () => {
    for (const ok of [
      "261109T142030Z-git_mf-8b9c", "261109T142030Z-a.b-c-0000",
      `261109T142030Z-${"x".repeat(40)}-ffff`, "261109T142030Z-..-abcd",
    ]) expect(isRunId(ok)).toBe(true)
    for (const bad of [
      "261109T000000Z-x/../../../../escaped", "261109T142030Z-git_mf-8B9C",
      "261109T142030Z--8b9c", `261109T142030Z-${"x".repeat(41)}-ffff`,
      "261109T142030Z-git_mf-8b9c\n", "../261109T142030Z-git_mf-8b9c",
    ]) expect(isRunId(bad)).toBe(false)
  })

  test("redact replaces every planted token", () => {
    const tokens = fakeTokens()
    const text = Object.values(tokens).join(" and ")
      + " Bearer abcdefgh12345 url?token=s3cr3tvalue&x=1"
    const out = redact(text)
    for (const [kind, token] of Object.entries(tokens)) {
      expect(out).not.toContain(token)
      expect(out).toContain(`[redacted:${kind}]`)
    }
    expect(out).toContain("Bearer [redacted:bearer]")
    expect(out).toContain("token=[redacted:token-value]&x=1")
  })

  test("redact ignores case", () => {
    const out = redact("API_TOKEN=abcdef123456 PASSWORD=hunter2hunter2 "
      + "Authorization: bearer abcdefgh12345")
    expect(out).toBe("API_TOKEN=[redacted:token-value] "
      + "PASSWORD=[redacted:password-value] "
      + "Authorization: bearer [redacted:bearer]")
  })

  test("buildEvent cuts strings and keeps multibyte lines in the cap", () => {
    const msg = "ü€😀".repeat(100 * 1024 / 9)
    const line = buildEvent(id, "step", { name: "big", msg })
    expect(Buffer.byteLength(`${line}\n`)).toBeLessThanOrEqual(4096)
    const event = JSON.parse(line)
    expect(event.msg.endsWith("[cut]")).toBe(true)
    expect(event.msg.length).toBe(512 + 5)

    const many: Record<string, string> = {}
    for (let i = 0; i < 20; i++) many[`f${i}`] = "😀".repeat(400)
    const fallback = JSON.parse(buildEvent(id, "step", many))
    expect(fallback).toMatchObject({ v: 1, run_id: id.runId, truncated: true })
    expect(fallback.f0).toBeUndefined()
  })

  test("buildEvent never lets fields replace the common ones", () => {
    const event = JSON.parse(buildEvent(id, "warn", { run_id: "x", code: "c" }))
    expect(event.run_id).toBe(id.runId)
    expect(event.event).toBe("warn")
  })
})

describe("startRun", () => {
  test("writes start, events, end, and an index line", withHome((home) => {
    const env: Env = { BOKU_HOME: home }
    const tokens = fakeTokens()
    const run = startRun("demo", {
      env, argv: ["--key", tokens["github-token"]!], rev: "abc1234",
    })
    expect(run.active).toBe(true)
    expect(env.BOKU_RUN_ID).toBe(run.runId!)
    expect(env.BOKU_ROOT_RUN_ID).toBe(run.runId!)
    run.event("warn", { code: "needs-judgment", msg: "😀".repeat(5000) })
    run.event("step", { name: "fetch", exit: 0 })
    run.end(3)
    run.event("step", { name: "after-end" })

    const file = runFilePath(home, run.runId!)
    const raw = readFileSync(file, "utf8")
    expect(raw).not.toContain(tokens["github-token"]!)
    for (const line of raw.trimEnd().split("\n")) {
      expect(Buffer.byteLength(line)).toBeLessThanOrEqual(maxLineBytes)
      JSON.parse(line)
    }
    const events = readLines(file)
    expect(events.map((e) => e.event)).toEqual(["start", "warn", "step", "end"])
    expect(events[0]).toMatchObject({
      v: 1, source: "dotfiles", parent_run_id: null, tool: "demo",
      argv: ["--key", "[redacted:github-token]"], pid: process.pid,
      rev: "abc1234",
    })
    expect(typeof events[0]!.pid_start).toBe("number")
    expect(typeof events[0]!.boot_id).toBe("string")
    expect(events[3]).toMatchObject({
      exit: 3, status: "stopped", warns: 1, errors: 0,
    })
    const index = readLines(indexPath(home, run.runId!.slice(0, 6)))
    expect(index).toHaveLength(1)
    expect(index[0]).toMatchObject({
      run_id: run.runId, tool: "demo", exit: 3, status: "stopped", warns: 1,
    })

    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(home).mode & 0o777).toBe(0o700)
    expect(statSync(join(home, "runs")).mode & 0o777).toBe(0o700)
  }))

  test("end counts warns and errors other processes wrote",
    withHome((home) => {
      const run = startRun("git_mf", { env: { BOKU_HOME: home }, rev: null })
      run.event("warn", { code: "own" })
      const tap = attachRun({ BOKU_HOME: home, BOKU_RUN_ID: run.runId! })
      tap.event("warn", { code: "session-mismatch" })
      tap.event("error", { code: "tap-failed" })
      // A torn line doesn't count or break the count.
      appendFileSync(runFilePath(home, run.runId!), '{"event":"warn"\n')
      run.end(0)
      const last = readFileSync(runFilePath(home, run.runId!), "utf8")
        .trimEnd().split("\n").at(-1)!
      expect(JSON.parse(last)).toMatchObject({
        event: "end", warns: 2, errors: 1,
      })
      const index = readLines(indexPath(home, run.runId!.slice(0, 6)))
      expect(index[0]).toMatchObject({ warns: 2, errors: 1 })
    }))

  test("explicit end status wins over the exit mapping", withHome((home) => {
    const run = startRun("demo", { env: { BOKU_HOME: home }, rev: null })
    run.end(0, { status: "stopped" })
    const events = readLines(runFilePath(home, run.runId!))
    expect(events.at(-1)).toMatchObject({ exit: 0, status: "stopped" })
  }))

  test("inherits parent and root from the environment", withHome((home) => {
    const env: Env = {
      BOKU_HOME: home,
      BOKU_RUN_ID: "261109T141203Z-sync-a1b2",
      BOKU_ROOT_RUN_ID: "261109T141000Z-cron-0000",
    }
    const run = startRun("git_mf", { env, rev: null })
    const start = readLines(runFilePath(home, run.runId!))[0]!
    expect(start.parent_run_id).toBe("261109T141203Z-sync-a1b2")
    expect(start.root_run_id).toBe("261109T141000Z-cron-0000")
    expect(env.BOKU_RUN_ID).toBe(run.runId!)
    expect(env.BOKU_ROOT_RUN_ID).toBe("261109T141000Z-cron-0000")
  }))

  test("links a child process through exported ids", withHome(async (home) => {
    const parent = startRun("sync", { env: { BOKU_HOME: home }, rev: null })
    const result = await runScript(home, `
      const run = w.startRun("child", { rev: null })
      run.end(0)
      console.log(run.runId)
    `, {
      BOKU_HOME: home,
      BOKU_RUN_ID: parent.runId!,
      BOKU_ROOT_RUN_ID: parent.rootRunId!,
    })
    parent.end(0)
    const childId = result.stdout.trim()
    const start = readLines(runFilePath(home, childId))[0]!
    expect(start).toMatchObject({
      parent_run_id: parent.runId, root_run_id: parent.runId, tool: "child",
    })
  }))

  test("step logs a throw as exit 1", withHome(async (home) => {
    const run = startRun("demo", { env: { BOKU_HOME: home }, rev: null })
    expect(await run.step("ok", () => 42)).toBe(42)
    await expect(run.step("bad", () => {
      throw new Error("boom")
    })).rejects.toThrow("boom")
    run.end(1)
    const steps = readLines(runFilePath(home, run.runId!))
      .filter((e) => e.event === "step")
    expect(steps[0]).toMatchObject({ name: "ok", exit: 0 })
    expect(steps[1]).toMatchObject({ name: "bad", exit: 1, msg: "boom" })
    expect(typeof steps[0]!.dur_ms).toBe("number")
  }))

  test("artifact copies a redacted file", withHome((home) => {
    const tokens = fakeTokens()
    const src = join(home, "report.md")
    writeFileSync(src, `# Report\nkey ${tokens["slack-token"]}\n`)
    const run = startRun("demo", { env: { BOKU_HOME: home }, rev: null })
    run.artifact("report", src)
    run.end(0)
    const dest = join(run.runDir!, "report.md")
    const text = readFileSync(dest, "utf8")
    expect(text).toContain("[redacted:slack-token]")
    expect(statSync(dest).mode & 0o777).toBe(0o600)
    const artifact = readLines(runFilePath(home, run.runId!))
      .find((e) => e.event === "artifact")!
    expect(artifact).toMatchObject({
      kind: "report", path: "report.md", bytes: Buffer.byteLength(text),
      truncated: false,
    })
    expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/)
  }))

  test("artifact names follow the kind, as in bash", () => {
    expect(artifactName("remerge-diff", "/tmp/x")).toBe("remerge.diff")
    expect(artifactName("conflict-diff", "/tmp/a.txt")).toBe("conflict.diff")
    expect(artifactName("prompt", "/tmp/tmp.Xy12.md")).toBe("prompt.md")
    expect(artifactName("report", "/tmp/a.tar.gz")).toBe("report.gz")
    expect(artifactName("report", "/tmp/.bashrc")).toBe("report")
    expect(artifactName("report", "/tmp/noext")).toBe("report")
    expect(artifactName("report", "/tmp/x.m-d")).toBe("report")
    expect(artifactName("a b-c d", "")).toBe("a-b-c.d")
    expect(artifactName(".hidden", "x.md")).toBe("hidden.md")
    expect(artifactName("", "x")).toBe("artifact")
  })

  test("a capped artifact ends at its last full line", withHome((home) => {
    const tokens = fakeTokens()
    const src = join(home, "big.log")
    const first = "line one\n"
    // The cap falls inside the token on line two.
    writeFileSync(src, `${first}key ${tokens["github-token"]} tail\nthree\n`)
    const env: Env = {
      BOKU_HOME: home, BOKU_RUNLOG_ARTIFACT_MAX: String(first.length + 12),
    }
    const run = startRun("demo", { env, rev: null })
    run.artifact("big-log", src)
    run.end(0)
    expect(readFileSync(join(run.runDir!, "big.log"), "utf8")).toBe(first)
    const artifact = readLines(runFilePath(home, run.runId!))
      .find((e) => e.event === "artifact")!
    expect(artifact).toMatchObject({
      kind: "big-log", path: "big.log", truncated: true, bytes: first.length,
    })
  }))

  test("a capped one-line artifact is empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "boku-runlog-"))
    try {
      const src = join(dir, "one")
      writeFileSync(src, "x".repeat(100))
      expect(readCapped(src, 10)).toEqual({
        data: Buffer.alloc(0), truncated: true,
      })
      writeFileSync(src, "abc\ndef\n")
      expect(readCapped(src, 8).data.toString()).toBe("abc\ndef\n")
      expect(readCapped(src, 4).data.toString()).toBe("abc\n")
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  })

  test("a failed artifact warns and the writer stays on", withHome((home) => {
    const src = join(home, "report.md")
    writeFileSync(src, "# Report\n")
    const run = startRun("demo", { env: { BOKU_HOME: home }, rev: null })
    // A folder in the way makes the final rename fail.
    mkdirSync(join(run.runDir!, "report.md", "x"), { recursive: true })
    run.artifact("report", src)
    run.artifact("gone", join(home, "missing.txt"))
    run.event("step", { name: "after" })
    run.end(0)
    const events = readLines(runFilePath(home, run.runId!))
    expect(events.map((e) => [e.event, e.code ?? e.name ?? null])).toEqual([
      ["start", null], ["warn", "artifact-failed"],
      ["warn", "artifact-missing"], ["step", "after"], ["end", null],
    ])
    expect(events.at(-1)).toMatchObject({ warns: 2 })
    expect(readdirSync(run.runDir!)).toEqual(["report.md"])
  }))

  test("an artifact from the run folder replaces its source",
    withHome((home) => {
      const run = startRun("demo", { env: { BOKU_HOME: home }, rev: null })
      mkdirSync(run.runDir!, { recursive: true })
      const src = join(run.runDir!, "draft.txt")
      writeFileSync(src, "draft\n")
      run.artifact("prompt", src)
      run.end(0)
      expect(readdirSync(run.runDir!)).toEqual(["prompt.txt"])
    }))

  test("BOKU_RUNLOG=0 writes nothing and exports nothing", withHome((home) => {
    const env: Env = { BOKU_HOME: home, BOKU_RUNLOG: "0" }
    const run = startRun("demo", { env, rev: null })
    run.event("warn", { code: "x" })
    run.end(1)
    expect(run.active).toBe(false)
    expect(env.BOKU_RUN_ID).toBeUndefined()
    expect(readdirSync(home)).toEqual([])
  }))
})

describe("attachRun", () => {
  test("a crafted BOKU_RUN_ID writes nothing outside BOKU_HOME",
    withHome((dir) => {
      const home = join(dir, "home")
      const runId = "261109T000000Z-x/../../../../escaped"
      const run = attachRun({ BOKU_HOME: home, BOKU_RUN_ID: runId })
      run.event("warn", { code: "x" })
      expect(run.active).toBe(false)
      expect(run.runDir).toBeNull()
      expect(readdirSync(dir)).toEqual([])
      expect(() => checkedRunPaths(home, runId)).toThrow("not a run id")
    }))

  test("a valid id writes into its run file", withHome((home) => {
    const host = startRun("git_mf", { env: { BOKU_HOME: home }, rev: null })
    const run = attachRun({ BOKU_HOME: home, BOKU_RUN_ID: host.runId! })
    run.event("agent-session", { cli: "claude", session_id: "s1" })
    host.end(0)
    expect(run.runDir).toBe(host.runDir)
    const events = readLines(runFilePath(home, host.runId!))
    expect(events.map((e) => e.event)).toEqual(["start", "agent-session", "end"])
  }))
})

describe("fail open", () => {
  const body = `
    const run = w.startRun("demo", { rev: null })
    run.event("warn", { code: "x" })
    await run.step("s", () => 1)
    run.end(7)
    const id = process.env.BOKU_RUN_ID ?? null
    console.log(JSON.stringify({ active: run.active, id }))
    process.exit(7)
  `

  test("a file as BOKU_HOME keeps the exit code", withHome(async (dir) => {
    const home = join(dir, "not-a-dir")
    writeFileSync(home, "x")
    const result = await runScript(dir, body, {
      BOKU_HOME: home, BOKU_RUN_ID: "261109T141203Z-sync-a1b2",
    })
    expect(result.exitCode).toBe(7)
    expect(JSON.parse(result.stdout)).toEqual({ active: false, id: null })
    expect(result.stderr).toBe("")
    expect(readFileSync(home, "utf8")).toBe("x")
  }))

  test("a read-only BOKU_HOME keeps the exit code", withHome(async (dir) => {
    const home = join(dir, "ro")
    const scripts = join(dir, "scripts")
    for (const d of [home, scripts]) Bun.spawnSync(["mkdir", "-p", d])
    chmodSync(home, 0o500)
    try {
      const result = await runScript(scripts, body, {
        BOKU_HOME: home, BOKU_RUNLOG_DEBUG: "1",
      })
      expect(result.exitCode).toBe(7)
      expect(JSON.parse(result.stdout)).toEqual({ active: false, id: null })
      expect(result.stderr.trim().split("\n")).toHaveLength(1)
      expect(result.stderr).toContain("boku runlog: off:")
      expect(readdirSync(home)).toEqual([])
    } finally {
      chmodSync(home, 0o700)
    }
  }))

  test("the writer stays off after a mid-run error", withHome(async (dir) => {
    const home = join(dir, "home")
    const result = await runScript(dir, `
      const run = w.startRun("demo", { rev: null })
      const { chmodSync } = await import("node:fs")
      const { join } = await import("node:path")
      const day = join(process.env.BOKU_HOME, "runs", run.runId.slice(0, 6))
      chmodSync(join(day, run.runId + ".jsonl"), 0o400)
      run.event("warn", { code: "lost" })
      chmodSync(join(day, run.runId + ".jsonl"), 0o600)
      run.event("warn", { code: "after" })
      run.end(0)
      console.log(run.runId)
    `, { BOKU_HOME: home })
    expect(result.exitCode).toBe(0)
    const events = readLines(runFilePath(home, result.stdout.trim()))
    expect(events.map((e) => e.event)).toEqual(["start"])
  }))
})
