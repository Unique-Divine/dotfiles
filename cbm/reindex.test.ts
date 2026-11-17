import { describe, expect, test } from "bun:test"
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync,
} from "node:fs"
import { spawn } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  type Command, execute, isLocked, launchBackground, lockPath, planReindex, readOutcome,
  readStatus, runPlan, type RunResult,
} from "./reindex.ts"

const scriptPath = join(import.meta.dir, "reindex.ts")

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

describe("runPlan", () => {
  test("the status file records a failed repo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cbm-reindex-test-"))
    let tick = 0
    const code = await runPlan(plan(["a", "b"], ["a", "b"]), dir, {
      run: async () => [aborted, aborted, indexed(1), linked][tick++]!,
      attempts: 2,
      retryDelayMs: 0,
      sleep: async () => {},
      log: () => {},
    }, 4242, () => "t")
    expect(code).toBe(1)
    const status = JSON.parse(readFileSync(join(dir, "status.json"), "utf8"))
    expect(status).toEqual({
      pid: 4242,
      started: "t",
      ended: "t",
      exitCode: 1,
      missing: [],
      repos: {
        "/h/a": { index: "failed: status aborted_previous_preserved, exit 0" },
        "/h/b": { index: "1 nodes, 1156 edges", link: "41 cross-repo edges" },
      },
    })
  })
})

/**
 * A real `--run` against a fake `codebase-memory-mcp` on PATH that records
 * each call and sleeps for FAKE_SLEEP seconds.
 */
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "cbm-reindex-run-"))
  mkdirSync(join(root, "home/x/.git"), { recursive: true })
  mkdirSync(join(root, "bin"))
  const fake = join(root, "bin/codebase-memory-mcp")
  writeFileSync(fake, [
    "#!/bin/sh",
    `echo call >> '${root}/calls'`,
    "sleep \"${FAKE_SLEEP:-0}\"",
    `echo '{"structuredContent":{"status":"indexed","nodes":1,"edges":1}}'`,
  ].join("\n") + "\n")
  chmodSync(fake, 0o755)
  const { CBM_REINDEX_LOCKED: _locked, ...base } = process.env
  const env = (sleep: number) => ({
    ...base,
    HOME: join(root, "home"),
    XDG_CACHE_HOME: join(root, "cache"),
    PATH: `${join(root, "bin")}:${process.env.PATH}`,
    FAKE_SLEEP: String(sleep),
  })
  const argv = [process.execPath, scriptPath, "--run", "--repos", "x",
    "--no-link"]
  const calls = () => existsSync(join(root, "calls"))
    ? readFileSync(join(root, "calls"), "utf8").trim().split("\n").length
    : 0
  return { root, env, argv, calls, dir: join(root, "cache/cbm-reindex") }
}

describe("the run lock", () => {
  test("of two runs started at once, exactly one runs", async () => {
    const box = sandbox()
    const start = () => Bun.spawn(box.argv,
      { env: box.env(2), stdout: "pipe", stderr: "pipe" })
    const runs = [start(), start()]
    const codes = await Promise.all(runs.map((run) => run.exited))
    expect(codes.sort()).toEqual([0, 2])
    expect(box.calls()).toBe(1)
    expect(existsSync(lockPath(box.dir))).toBe(true)
  })

  test("a killed run releases the lock for the next one", async () => {
    const box = sandbox()
    // Its own process group, so the kill takes the fake indexer with it.
    const victim = spawn(box.argv[0]!, box.argv.slice(1),
      { env: box.env(60), detached: true, stdio: "ignore" })
    const exited = new Promise((resolve) => victim.on("exit", resolve))
    while (box.calls() === 0) await Bun.sleep(20)
    expect(isLocked(box.dir)).toBe(true)
    process.kill(-victim.pid!, "SIGKILL")
    await exited
    // The interrupted run left its lock file and an unfinished status.
    expect(readStatus(box.dir)?.ended).toBeNull()
    expect(isLocked(box.dir)).toBe(false)
    const next = Bun.spawn(box.argv,
      { env: box.env(0), stdout: "pipe", stderr: "pipe" })
    expect(await next.exited).toBe(0)
    expect(box.calls()).toBe(2)
    expect(readStatus(box.dir)?.exitCode).toBe(0)
  })
})

describe("launchBackground", () => {
  test("starts a run under the lock with its output in last.log", () => {
    const dir = mkdtempSync(join(tmpdir(), "cbm-reindex-test-"))
    const spawned: string[][] = []
    const got = launchBackground(dir, ["bun", "reindex.ts", "--run"],
      (argv) => { spawned.push(argv); return 777 }, () => false)
    expect(got).toEqual({ started: true, pid: 777, log: join(dir, "last.log") })
    expect(spawned).toEqual([["flock", "-n", "-E", "75", lockPath(dir),
      "bun", "reindex.ts", "--run"]])
  })

  test("does not start a second run while one holds the lock", () => {
    const dir = mkdtempSync(join(tmpdir(), "cbm-reindex-test-"))
    const got = launchBackground(dir, ["bun"], () => {
      throw new Error("must not spawn")
    }, () => true)
    expect(got).toEqual({ started: false, pid: -1 })
  })
})
