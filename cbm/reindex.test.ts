import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  acquireLock, type Command, execute, launchBackground, lockHolder,
  planReindex, readOutcome, readStatus, runLocked, type RunResult,
} from "./reindex.ts"

const bin = "/bin/cbm"
const argv = [bin, "cli", "--quiet", "--json", "index_repository"]

// Trimmed from real `cli --json index_repository` output on 2026-11-17.
const indexed = (nodes: number): RunResult => ({
  exitCode: 0,
  stderr: "",
  stdout: JSON.stringify({
    content: [{ type: "text", text: "{}" }],
    structuredContent: {
      project: "home-realu-open-sai", nodes, edges: 1156, status: "indexed",
    },
  }),
})
const linked: RunResult = {
  exitCode: 0,
  stderr: "",
  stdout: JSON.stringify({
    structuredContent: {
      status: "success", mode: "cross-repo-intelligence",
      project: "home-realu-boku", projects_scanned: 9, total_cross_edges: 41,
    },
  }),
}
const aborted: RunResult = {
  exitCode: 0,
  stderr: "",
  stdout: JSON.stringify({
    structuredContent: {
      project: "home-realu-boku", status: "aborted_previous_preserved",
    },
  }),
}

const plan = (repos: string[], present: string[], link = true) =>
  planReindex({
    home: "/h",
    repos,
    link,
    bin,
    exists: (path) => present.some((repo) => path === `/h/${repo}/.git`),
  })

describe("planReindex", () => {
  test("indexes every present repo before linking any, Boku last", () => {
    const got = plan(["boku", "sai-web", "gone"], ["boku", "sai-web"])
    expect(got.missing).toEqual(["gone"])
    expect(got.commands.map((cmd) => [cmd.kind, cmd.repo])).toEqual([
      ["index", "/h/boku"],
      ["index", "/h/sai-web"],
      ["link", "/h/sai-web"],
      ["link", "/h/boku"],
    ])
    expect(got.commands[0]).toEqual({
      kind: "index", repo: "/h/boku", argv,
      input: JSON.stringify({ repo_path: "/h/boku" }),
    })
    expect(JSON.parse(got.commands[3]!.input)).toEqual({
      repo_path: "/h/boku",
      mode: "cross-repo-intelligence",
      target_projects: ["*"],
    })
  })

  test("--no-link plans only index runs", () => {
    const got = plan(["boku"], ["boku"], false)
    expect(got.commands.map((cmd) => cmd.kind)).toEqual(["index"])
  })
})

describe("readOutcome", () => {
  const index: Command = { kind: "index", repo: "/h/x", argv, input: "" }
  const link: Command = { ...index, kind: "link" }

  test("accepts indexed and success results", () => {
    expect(readOutcome(index, indexed(312)))
      .toEqual({ ok: true, summary: "312 nodes, 1156 edges" })
    expect(readOutcome(link, linked))
      .toEqual({ ok: true, summary: "41 cross-repo edges" })
  })

  test("retries an aborted run", () => {
    expect(readOutcome(index, aborted)).toMatchObject({ ok: false, retry: true })
  })

  test("does not retry tool errors or unreadable output", () => {
    const toolError: RunResult = {
      exitCode: 1, stderr: "",
      stdout: JSON.stringify({
        isError: true, content: [{ type: "text", text: "no such path" }],
      }),
    }
    expect(readOutcome(index, toolError))
      .toEqual({ ok: false, retry: false, reason: "no such path" })
    expect(readOutcome(index, { exitCode: 2, stdout: "", stderr: "boom" }))
      .toEqual({ ok: false, retry: false, reason: "boom" })
  })
})

describe("execute", () => {
  const opts = (results: RunResult[], calls: Command[]) => ({
    run: async (cmd: Command) => {
      calls.push(cmd)
      const next = results.shift()
      if (!next) throw new Error(`unexpected ${cmd.kind} ${cmd.repo}`)
      return next
    },
    attempts: 3,
    retryDelayMs: 0,
    sleep: async () => {},
    log: () => {},
  })

  test("retries an aborted index, then links", async () => {
    const calls: Command[] = []
    const failed = await execute(plan(["boku"], ["boku"]),
      opts([aborted, indexed(74905), linked], calls))
    expect(failed).toEqual([])
    expect(calls.map((cmd) => cmd.kind)).toEqual(["index", "index", "link"])
  })

  test("a failed repo skips its link step but not the others", async () => {
    const calls: Command[] = []
    const failed = await execute(plan(["a", "b"], ["a", "b"]),
      opts([aborted, aborted, aborted, indexed(1), linked], calls))
    expect(failed).toEqual(["/h/a"])
    expect(calls.map((cmd) => [cmd.kind, cmd.repo])).toEqual([
      ["index", "/h/a"], ["index", "/h/a"], ["index", "/h/a"],
      ["index", "/h/b"], ["link", "/h/b"],
    ])
  })
})

describe("runLocked", () => {
  const tempDir = () => mkdtempSync(join(tmpdir(), "cbm-reindex-test-"))
  const fakeRun = (results: RunResult[]) => ({
    run: async (cmd: Command) => {
      const next = results.shift()
      if (!next) throw new Error(`unexpected ${cmd.kind} ${cmd.repo}`)
      return next
    },
    attempts: 2,
    retryDelayMs: 0,
    sleep: async () => {},
    log: () => {},
  })

  test("a held lock blocks a second run without running anything", async () => {
    const dir = tempDir()
    // The test runner's own PID is alive, so it holds the lock.
    expect(acquireLock(dir, process.pid)).toEqual({ ok: true })
    const code = await runLocked(plan(["boku"], ["boku"]), dir, fakeRun([]),
      process.pid + 1)
    expect(code).toBe(2)
    expect(lockHolder(dir)).toBe(process.pid)
    expect(readStatus(dir)).toBeUndefined()
  })

  test("a stale lock from a dead PID is cleared", async () => {
    const dir = tempDir()
    writeFileSync(join(dir, "lock"), "999999999\n")
    const code = await runLocked(plan(["boku"], ["boku"]), dir,
      fakeRun([indexed(5), linked]), 4242)
    expect(code).toBe(0)
    // The run released its own lock at the end.
    expect(lockHolder(dir)).toBeUndefined()
    expect(readStatus(dir)?.pid).toBe(4242)
  })

  test("the status file records a failed repo", async () => {
    const dir = tempDir()
    let tick = 0
    const now = () => `t${tick++}`
    const code = await runLocked(plan(["a", "b"], ["a", "b"]), dir,
      fakeRun([aborted, aborted, indexed(1), linked]), 4242, now)
    expect(code).toBe(1)
    const status = JSON.parse(readFileSync(join(dir, "status.json"), "utf8"))
    expect(status).toEqual({
      pid: 4242,
      started: "t0",
      ended: "t1",
      exitCode: 1,
      missing: [],
      repos: {
        "/h/a": { index: "failed: status aborted_previous_preserved, exit 0" },
        "/h/b": { index: "1 nodes, 1156 edges", link: "41 cross-repo edges" },
      },
    })
  })
})

describe("launchBackground", () => {
  test("starts a run with its output in last.log", () => {
    const dir = mkdtempSync(join(tmpdir(), "cbm-reindex-test-"))
    const spawned: string[][] = []
    const got = launchBackground(dir, ["bun", "reindex.ts", "--run"],
      (argv) => { spawned.push(argv); return 777 })
    expect(got).toEqual({ started: true, pid: 777, log: join(dir, "last.log") })
    expect(spawned).toEqual([["bun", "reindex.ts", "--run"]])
  })

  test("does not start a second run while one holds the lock", () => {
    const dir = mkdtempSync(join(tmpdir(), "cbm-reindex-test-"))
    acquireLock(dir, process.pid)
    const got = launchBackground(dir, ["bun"], () => {
      throw new Error("must not spawn")
    })
    expect(got).toEqual({ started: false, pid: process.pid })
  })
})
