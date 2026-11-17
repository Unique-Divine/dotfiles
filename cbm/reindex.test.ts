import { describe, expect, test } from "bun:test"

import {
  type Command, execute, planReindex, readOutcome, type RunResult,
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
  test("indexes every present repo before linking any", () => {
    const got = plan(["boku", "sai-web", "gone"], ["boku", "sai-web"])
    expect(got.missing).toEqual(["gone"])
    expect(got.commands.map((cmd) => [cmd.kind, cmd.repo])).toEqual([
      ["index", "/h/boku"],
      ["index", "/h/sai-web"],
      ["link", "/h/boku"],
      ["link", "/h/sai-web"],
    ])
    expect(got.commands[0]).toEqual({
      kind: "index", repo: "/h/boku", argv,
      input: JSON.stringify({ repo_path: "/h/boku" }),
    })
    expect(JSON.parse(got.commands[2]!.input)).toEqual({
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
