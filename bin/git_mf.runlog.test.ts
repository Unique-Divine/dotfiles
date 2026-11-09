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
const FIXTURE_TOKEN = "fixture-fake-7Qm2Xr9LpT4vK8"

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
    // The fixture plants this exact token; only redaction removes it.
    expect(copy.join("\n")).not.toContain(FIXTURE_TOKEN)
    expect(copy.join("\n")).toContain("[redacted:")
    // The report reaches the terminal, with a pointer to the run.
    expect(res.stderr).toContain("----- agent report")
    expect(res.stderr).toContain("run log: boku-runs show ")
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

    // A fresh TMPDIR must end up empty: the temp prompt is cleaned up.
    const tmp = await mkdtemp(join(tmpdir(), "git-mf-tmp-"))
    const res = await sh(r.clone, `${gitMf} main --agent`, {
      PATH, BOKU_HOME: home, BOKU_RUNLOG: "0", TMPDIR: tmp,
    })
    expect(res.code, res.stderr).toBe(0)
    expect(res.stderr).toContain("agent outcome: merged")
    expect(await readdir(home)).toEqual([])
    expect(await readdir(tmp)).toEqual([])
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

/** Snapshot of what a run could change in the repository. */
const repoState = (dir: string) =>
  ok(dir, "git rev-parse HEAD; git status --porcelain; git stash list")

/** The newest file in the run folder of the single git_mf run. */
async function runFile(home: string, name: string): Promise<string> {
  const day = (await readdir(join(home, "runs")))[0]!
  const events = await runEvents(home)
  return readFile(join(home, "runs", day, events[0]!.run_id, name), "utf8")
}

describe("git_mf --agent verify rows", () => {
  test("an agent that moves HEAD without the upstream is failed", async () => {
    const r = await conflict()
    const home = await mkdtemp(join(tmpdir(), "boku-home-"))
    const PATH = await agentPath(r.root, "claude",
      "printf x > other.txt && git add other.txt && git commit -qm other")
    const res = await sh(r.clone, `${gitMf} main --agent`, { PATH, BOKU_HOME: home })
    expect(res.code, res.stderr).toBe(1)
    const events = await runEvents(home)
    expect(events.find((e) => e.event === "agent")).toMatchObject({ outcome: "failed" })
    expect(events.at(-1)).toMatchObject({ event: "end", exit: 1, status: "failed" })
  })

  test("a non-zero agent exit after a landed merge is merged, with a warning", async () => {
    const r = await conflict()
    const home = await mkdtemp(join(tmpdir(), "boku-home-"))
    const PATH = await agentPath(r.root, "claude", resolveTheirs)
    // Make the fake agent exit 2 after printing its stream.
    const fake = join(r.root, "fake-bin", "claude")
    await writeFile(fake, (await readFile(fake, "utf8")) + "exit 2\n", { mode: 0o755 })
    const res = await sh(r.clone, `${gitMf} main --agent`, { PATH, BOKU_HOME: home })
    expect(res.code, res.stderr).toBe(0)
    const events = await runEvents(home)
    expect(events.find((e) => e.event === "agent")).toMatchObject({ outcome: "merged", exit: 2 })
    expect(events.some((e) => e.code === "agent-exit-nonzero")).toBe(true)
  })

  test("a dirty tree already up to date is no-change, exit 0", async () => {
    const r = await repoPair()
    await ok(r.clone, "printf local > file.txt")
    const home = await mkdtemp(join(tmpdir(), "boku-home-"))
    const PATH = await agentPath(r.root, "claude", "true")
    const res = await sh(r.clone, `${gitMf} main --agent`, { PATH, BOKU_HOME: home })
    expect(res.code, res.stderr).toBe(0)
    const events = await runEvents(home)
    expect(events.find((e) => e.name === "plan")).toMatchObject({ action: "dirty" })
    expect(events.find((e) => e.event === "agent")).toMatchObject({ outcome: "no-change" })
  })

  test("with no upstream commit to check, verify says so", async () => {
    const r = await repoPair()
    await ok(r.clone, "printf local > file.txt")
    const home = await mkdtemp(join(tmpdir(), "boku-home-"))
    const PATH = await agentPath(r.root, "claude", "true")
    const res = await sh(r.clone, `${gitMf} nope --agent`, { PATH, BOKU_HOME: home })
    const events = await runEvents(home)
    expect(events.find((e) => e.name === "plan")!.upstream_sha).toBe("")
    expect(events.some((e) => e.code === "upstream-unknown")).toBe(true)
    expect(res.code).toBe(3)
  })

  test("origin moving during the run doesn't fail a good merge", async () => {
    const r = await conflict()
    const home = await mkdtemp(join(tmpdir(), "boku-home-"))
    const PATH = await agentPath(r.root, "claude",
      `${resolveTheirs}; (cd ${r.peer} && printf later > later.txt && git add . && git commit -qm later && git push -q); git fetch -q`)
    const res = await sh(r.clone, `${gitMf} main --agent`, { PATH, BOKU_HOME: home })
    expect(res.code, res.stderr).toBe(0)
    expect((await runEvents(home)).find((e) => e.event === "agent"))
      .toMatchObject({ outcome: "merged" })
  })

  test("--dry-run --agent names the agent and runs nothing", async () => {
    const r = await conflict()
    const home = await mkdtemp(join(tmpdir(), "boku-home-"))
    const PATH = await agentPath(r.root, "claude", "touch AGENT_RAN")
    const res = await sh(r.clone, `${gitMf} main --agent --dry-run`, { PATH, BOKU_HOME: home })
    expect(res.code, res.stderr).toBe(0)
    expect(res.stderr).toContain("RUN claude")
    expect(await Bun.file(join(r.clone, "AGENT_RAN")).exists()).toBe(false)
    const events = await runEvents(home)
    expect(events.find((e) => e.name === "agent")).toMatchObject({ msg: "dry-run" })
    expect(events.some((e) => e.event === "agent")).toBe(false)
  })

  test("conflicts in .env and secrets/ never reach a saved diff", async () => {
    const r = await repoPair()
    await r.pushUpstream("base", ".env")
    await ok(r.clone, "git pull -q && git switch -q -c feature")
    await ok(r.clone,
      "printf 'DB_PASSWORD=mine-0001\\n' > .env && printf 'export K=mine-0003\\n' > .envrc && printf mine > file.txt && git add . && git commit -qam mine")
    await r.pushUpstream("DB_PASSWORD=theirs-0002", ".env")
    await r.pushUpstream("export K=theirs-0004", ".envrc")
    await r.pushUpstream("theirs")
    const home = await mkdtemp(join(tmpdir(), "boku-home-"))
    const PATH = await agentPath(r.root, "claude",
      "git merge -q origin/main >/dev/null 2>&1; git checkout -q --theirs .env .envrc file.txt && git add .env .envrc file.txt && git commit -q --no-edit")
    const res = await sh(r.clone, `${gitMf} main --agent`, { PATH, BOKU_HOME: home })
    expect(res.code, res.stderr).toBe(0)
    const diff = await runFile(home, "remerge.diff")
    // The other conflicted file is there, so the diff was really saved.
    expect(diff).toContain("file.txt")
    expect(diff).not.toContain("mine-0001")
    expect(diff).not.toContain("mine-0003")
    expect(diff).not.toContain("theirs-0004")
    expect(diff).not.toContain("theirs-0002")
  })
})

describe("git_mf fail-open", () => {
  /** Runs one conflict hand-off and returns its exit, stdout, and repo state. */
  async function handOff(env: Record<string, string>, tap: "real" | "dies" = "real") {
    const r = await conflict()
    const PATH = await agentPath(r.root, "claude", resolveTheirs, tap)
    const res = await sh(r.clone, `${gitMf} main --agent`, { PATH, ...env })
    return { code: res.code, stdout: res.stdout, files: await ok(r.clone, "git ls-files; git status --porcelain") }
  }

  test("an unwritable BOKU_HOME matches BOKU_RUNLOG=0", async () => {
    const home = await mkdtemp(join(tmpdir(), "boku-home-"))
    await Bun.$`chmod 500 ${home}`
    const off = await handOff({ BOKU_RUNLOG: "0" })
    const broken = await handOff({ BOKU_HOME: home })
    await Bun.$`chmod 700 ${home}`
    expect(broken).toEqual(off)
  })

  test("a jq that fails matches BOKU_RUNLOG=0", async () => {
    const off = await handOff({ BOKU_RUNLOG: "0" })
    const r = await conflict()
    const PATH = await agentPath(r.root, "claude", resolveTheirs)
    await writeFile(join(r.root, "fake-bin", "jq"), "#!/bin/sh\nexit 127\n", { mode: 0o755 })
    const home = await mkdtemp(join(tmpdir(), "boku-home-"))
    const res = await sh(r.clone, `${gitMf} main --agent`, { PATH, BOKU_HOME: home })
    expect({ code: res.code, stdout: res.stdout, files: await ok(r.clone, "git ls-files; git status --porcelain") })
      .toEqual(off)
  })
})

describe("git_mf signals", () => {
  test("a run killed with TERM ends with exit 143, not ok", async () => {
    const r = await conflict()
    const home = await mkdtemp(join(tmpdir(), "boku-home-"))
    const PATH = await agentPath(r.root, "claude", "sleep 1")
    const proc = Bun.spawn(["bash", "-c", `exec ${gitMf} main --agent`], {
      cwd: r.clone,
      env: { ...process.env, PATH, BOKU_HOME: home, GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "T",
        GIT_COMMITTER_EMAIL: "t@e" },
      stdout: "pipe", stderr: "pipe",
    })
    await Bun.sleep(500)
    proc.kill("SIGTERM")
    expect(await proc.exited).toBe(143)
    const end = (await runEvents(home)).at(-1)!
    expect(end).toMatchObject({ event: "end", exit: 143, status: "failed" })
  })
})

describe("git_mf --json", () => {
  test("the plain agent path keeps stdout pure JSONL", async () => {
    const r = await conflict()
    const home = await mkdtemp(join(tmpdir(), "boku-home-"))
    // No boku-runs on PATH: the agent runs in plain mode and prints text.
    const PATH = await agentPath(r.root, "claude", `${resolveTheirs}; echo agent says hi`)
    await Bun.$`rm ${join(r.root, "fake-bin", "boku-runs")}`
    const res = await sh(r.clone, `${gitMf} main --agent --json`, { PATH, BOKU_HOME: home })
    expect(res.code, res.stderr).toBe(0)
    for (const l of res.stdout.trim().split("\n")) {
      expect(() => JSON.parse(l)).not.toThrow()
    }
    expect(res.stderr).toContain("agent says hi")
  })

  test("the no-target path keeps stdout pure JSONL", async () => {
    const r = await repoPair()
    await r.pushUpstream("two")
    const home = await mkdtemp(join(tmpdir(), "boku-home-"))
    const res = await sh(r.clone, `${gitMf} --json`, { BOKU_HOME: home })
    expect(res.code, res.stderr).toBe(0)
    const lines = res.stdout.trim().split("\n")
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow()
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ event: "end" })
  })
})
