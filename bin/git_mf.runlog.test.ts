// End-to-end run logging for `git_mf --agent`: fake claude and codex CLIs
// change a real repository and print real-shaped stream fixtures, which go
// through the real `boku-runs tap`. Checks what lands in BOKU_HOME.
import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { cleanup, ok, repoPair, sh } from "./git-test-repo"

const root = resolve(import.meta.dir, "..")
const gitMf = join(root, "bin", "git_mf")
const fixtures = join(root, "runlog", "fixtures")
const bunBin = join(homedir(), ".bun", "bin")

afterEach(cleanup)

type Event = Record<string, any> & { event: string }

/** Every event of the single git_mf run written under `home`. */
async function runEvents(home: string): Promise<Event[]> {
  const days = await readdir(join(home, "runs"))
  const lines: Event[] = []
  for (const day of days) {
    for (const f of await readdir(join(home, "runs", day))) {
      if (f.includes("-git_mf-") && f.endsWith(".jsonl")) {
        const text = await readFile(join(home, "runs", day, f), "utf8")
        lines.push(...text.trim().split("\n").map((l) => JSON.parse(l)))
      }
    }
  }
  return lines
}

async function runDirFiles(home: string): Promise<string[]> {
  const days = await readdir(join(home, "runs"))
  for (const day of days) {
    for (const f of await readdir(join(home, "runs", day))) {
      if (f.includes("-git_mf-") && !f.endsWith(".jsonl")) {
        return (await readdir(join(home, "runs", day, f))).sort()
      }
    }
  }
  return []
}

/**
 * A PATH with fake agent CLIs and `boku-runs`. `action` is shell run in the
 * repository before the fixture stream is printed.
 */
async function agentPath(
  dir: string,
  cli: "claude" | "codex",
  action: string,
  tap: "real" | "dies" = "real",
) {
  const bin = join(dir, "fake-bin")
  await mkdir(bin, { recursive: true })
  const fixture = join(fixtures, `${cli}-stream.jsonl`)
  const script =
    cli === "claude"
      ? `#!/bin/bash
sid=""; while [[ $# -gt 0 ]]; do [[ "$1" == --session-id ]] && sid="$2"; shift; done
cat > /dev/null
${action}
sed "s/5d0c8a3e-2f4b-4c1a-9e7d-1b2c3d4e5f60/$sid/g" "${fixture}"
`
      : `#!/bin/bash
out=""; while [[ $# -gt 0 ]]; do [[ "$1" == -o ]] && out="$2"; shift; done
cat > /dev/null
${action}
printf '# Report\\n\\nAuthorization: Bearer abcdefghij0123456789\\n\\n## Challenges\\n\\nNone\\n' > "$out"
cat "${fixture}"
`
  await writeFile(join(bin, cli), script, { mode: 0o755 })
  if (tap === "real") {
    await symlink(join(root, "runlog", "cli.ts"), join(bin, "boku-runs"))
  } else {
    await writeFile(join(bin, "boku-runs"), "#!/bin/sh\nexit 1\n", {
      mode: 0o755,
    })
  }
  return `${bin}:${bunBin}:/usr/bin:/bin`
}

/** A feature branch whose file.txt conflicts with origin/main. */
async function conflict() {
  const r = await repoPair()
  await ok(r.clone, "git switch -q -c feature")
  await ok(r.clone, "printf mine > file.txt && git commit -qam mine")
  await r.pushUpstream("theirs")
  return r
}

const resolveTheirs =
  "git merge -q origin/main >/dev/null 2>&1; git checkout -q --theirs file.txt && git add file.txt && git commit -q --no-edit"

describe("git_mf --agent run log", () => {
  test("a merged conflict leaves the stream, report, diffs, and a verified outcome", async () => {
    const r = await conflict()
    const home = await mkdtemp(join(tmpdir(), "boku-home-"))
    const PATH = await agentPath(r.root, "claude", resolveTheirs)

    const res = await sh(r.clone, `${gitMf} main --agent`, { PATH, BOKU_HOME: home })
    expect(res.code, res.stderr).toBe(0)
    expect(res.stderr).toContain("agent outcome: merged")

    const events = await runEvents(home)
    const kinds = events.map((e) => e.event)
    expect(kinds[0]).toBe("start")
    expect(kinds.at(-1)).toBe("end")
    expect(events.at(-1)).toMatchObject({ exit: 0, status: "ok" })

    const plan = events.find((e) => e.name === "plan")!
    expect(plan.conflicts).toEqual(["file.txt"])
    expect(plan.upstream_sha).toMatch(/^[0-9a-f]{40}$/)

    const session = events.find((e) => e.event === "agent-session")!
    const agent = events.find((e) => e.event === "agent")!
    expect(agent).toMatchObject({ cli: "claude", outcome: "merged", exit: 0 })
    expect(agent.session_id).toBe(session.session_id)
    expect(events.some((e) => e.code === "session-mismatch")).toBe(false)

    const failed = events.find((e) => e.event === "agent-command" && e.exit !== 0)!
    expect(failed.ref.file).toBe("agent.jsonl")

    const files = await runDirFiles(home)
    expect(files).toEqual(
      expect.arrayContaining(["agent.jsonl", "prompt.md", "remerge.diff", "report.md"]),
    )
    const copy = (await readFile(
      join(home, "runs", (await readdir(join(home, "runs")))[0],
        events[0].run_id, "agent.jsonl"), "utf8")).split("\n")
    expect(copy[failed.ref.line - 1]).toContain("tool_result")
    expect(copy.join("\n")).not.toContain("token=sk")
  })

  test("an agent that stops mid-merge exits 5 and saves the conflict", async () => {
    const r = await conflict()
    const home = await mkdtemp(join(tmpdir(), "boku-home-"))
    const PATH = await agentPath(r.root, "claude", "git merge -q origin/main >/dev/null 2>&1 || true")

    const res = await sh(r.clone, `${gitMf} main --agent`, { PATH, BOKU_HOME: home })
    expect(res.code, res.stderr).toBe(5)
    const events = await runEvents(home)
    expect(events.some((e) => e.code === "agent-left-merge")).toBe(true)
    expect(events.at(-1)).toMatchObject({ event: "end", exit: 5, status: "stopped" })
    expect(await runDirFiles(home)).toContain("conflict.diff")
    await ok(r.clone, "git merge --abort")
  })

  test("codex: the -o report is redacted and the thread id is recorded", async () => {
    const r = await conflict()
    const home = await mkdtemp(join(tmpdir(), "boku-home-"))
    const PATH = await agentPath(r.root, "codex", resolveTheirs)

    const res = await sh(r.clone, `${gitMf} main --agent`, { PATH, BOKU_HOME: home })
    expect(res.code, res.stderr).toBe(0)
    const events = await runEvents(home)
    const agent = events.find((e) => e.event === "agent")!
    expect(agent).toMatchObject({ cli: "codex", outcome: "merged" })
    expect(agent.session_id).toBe("019a6f2e-1c3b-7d40-8a5e-2f6b7c8d9e01")
    expect(agent.challenges).toContain("None")
    const day = (await readdir(join(home, "runs")))[0]
    const report = await readFile(
      join(home, "runs", day, events[0].run_id, "report.md"), "utf8")
    expect(report).not.toContain("abcdefghij0123456789")
    expect(report).toContain("[redacted:bearer]")
  })

  test("a tap that dies at startup costs a warning, not the merge", async () => {
    const r = await conflict()
    const home = await mkdtemp(join(tmpdir(), "boku-home-"))
    const PATH = await agentPath(r.root, "claude", resolveTheirs, "dies")

    const res = await sh(r.clone, `${gitMf} main --agent`, { PATH, BOKU_HOME: home })
    expect(res.code, res.stderr).toBe(0)
    const events = await runEvents(home)
    expect(events.filter((e) => e.code === "tap-exited")).toHaveLength(1)
    expect(events.find((e) => e.event === "agent")).toMatchObject({ outcome: "merged" })
    expect(events.at(-1)).toMatchObject({ event: "end", status: "ok" })
  })

  test("with logging off the agent runs as before and nothing is written", async () => {
    const r = await conflict()
    const home = await mkdtemp(join(tmpdir(), "boku-home-"))
    const PATH = await agentPath(r.root, "claude", resolveTheirs)

    const res = await sh(r.clone, `${gitMf} main --agent`, {
      PATH, BOKU_HOME: home, BOKU_RUNLOG: "0",
    })
    expect(res.code, res.stderr).toBe(0)
    expect(res.stderr).toContain("agent outcome: merged")
    expect(await readdir(home)).toEqual([])
    expect((await readdir(tmpdir())).length).toBeGreaterThan(0)
  })

  test("--json prints the run's events on stdout", async () => {
    const r = await repoPair()
    await r.pushUpstream("two")
    const home = await mkdtemp(join(tmpdir(), "boku-home-"))
    const res = await sh(r.clone, `${gitMf} main --json`, { BOKU_HOME: home })
    expect(res.code, res.stderr).toBe(0)
    const out = res.stdout.trim().split("\n").map((l) => JSON.parse(l))
    expect(out[0].event).toBe("start")
    expect(out.at(-1)).toMatchObject({ event: "end", status: "ok" })
    expect(out.some((e) => e.name === "plan" && e.action === "fast-forward")).toBe(true)
  })

  test("--help writes no run", async () => {
    const home = await mkdtemp(join(tmpdir(), "boku-home-"))
    const r = await repoPair()
    await sh(r.clone, `${gitMf} --help`, { BOKU_HOME: home })
    expect(await readdir(home)).toEqual([])
  })
})
