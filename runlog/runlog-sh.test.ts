import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createHash, randomBytes } from "node:crypto"
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const writerPath = join(import.meta.dir, "runlog.sh")

/** The prelude every test script runs under, as real producers will. */
const prelude = `set -Eeuo pipefail
trap 'echo "ERR-TRAP line $LINENO" >&2' ERR
source ${JSON.stringify(writerPath)}
`

interface RunResult {
  code: number
  stdout: string
  stderr: string
}

interface LogLine {
  raw: string
  file: string
  json: Record<string, unknown>
}

let tmp: string
let home: string

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "runlog-sh-"))
  home = join(tmp, "home")
  await mkdir(home, { mode: 0o700 })
})

afterEach(async () => {
  await chmod(home, 0o700).catch(() => {})
  await rm(tmp, { recursive: true, force: true })
})

/** Env without any inherited BOKU_* variables, pointed at `home`. */
const baseEnv = (
  extra: Record<string, string> = {},
): Record<string, string> => {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith("BOKU_")) env[k] = v
  }
  return { ...env, BOKU_HOME: home, ...extra }
}

/** Writes `body` (after the prelude) to a script file and returns its path. */
const writeScript = async (name: string, body: string): Promise<string> => {
  const path = join(tmp, name)
  await writeFile(path, `#!/usr/bin/env bash\n${prelude}${body}\n`)
  await chmod(path, 0o755)
  return path
}

/** Runs a real bash process on a script path. */
const runScript = async (
  path: string,
  env: Record<string, string> = baseEnv(),
  args: string[] = [],
): Promise<RunResult> => {
  const proc = Bun.spawn(["bash", path, ...args], {
    cwd: tmp,
    env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, stdout, stderr }
}

const runBash = async (
  body: string,
  env: Record<string, string> = baseEnv(),
): Promise<RunResult> => runScript(await writeScript("t.sh", body), env)

/** Every file under `dir`, recursively. */
const walk = async (dir: string): Promise<string[]> => {
  const out: string[] = []
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      out.push(p, ...(await walk(p)))
    } else {
      out.push(p)
    }
  }
  return out
}

/**
 * Reads every JSONL line the writer wrote and checks the line contract:
 * it parses, carries the common fields, and is at most 4,096 bytes with
 * its newline.
 */
const readLines = async (): Promise<LogLine[]> => {
  const files = (await walk(join(home, "runs"))).filter(
    (f) => f.endsWith(".jsonl") && f.split("/").length ===
      join(home, "runs", "d", "f").split("/").length,
  )
  const lines: LogLine[] = []
  for (const file of files) {
    const buf = await readFile(file)
    const text = buf.toString("utf8")
    expect(text.endsWith("\n")).toBe(true)
    for (const raw of text.slice(0, -1).split("\n")) {
      expect(Buffer.byteLength(raw, "utf8") + 1).toBeLessThanOrEqual(4096)
      const json = JSON.parse(raw) as Record<string, unknown>
      expect(json.v).toBe(1)
      expect(json.ts).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)
      expect(json.source).toBe("dotfiles")
      expect(json.run_id).toMatch(/^\d{6}T\d{6}Z-[A-Za-z0-9_.-]+-[0-9a-f]{4}$/)
      expect(json.root_run_id).toEqual(expect.any(String))
      expect("parent_run_id" in json).toBe(true)
      expect(json.tool).toEqual(expect.any(String))
      if (file.endsWith("index.jsonl")) {
        expect(json.event).toBeUndefined()
      } else {
        expect(json.event).toEqual(expect.any(String))
      }
      lines.push({ raw, file, json })
    }
  }
  return lines
}

const events = async (): Promise<Record<string, unknown>[]> =>
  (await readLines())
    .filter((l) => !l.file.endsWith("index.jsonl"))
    .map((l) => l.json)

const indexLines = async (): Promise<Record<string, unknown>[]> =>
  (await readLines())
    .filter((l) => l.file.endsWith("index.jsonl"))
    .map((l) => l.json)

/** All bytes the writer stored, as one string, for leak checks. */
const allStoredText = async (): Promise<string> => {
  let text = ""
  for (const f of await walk(home)) {
    const s = await stat(f)
    if (s.isFile()) text += (await readFile(f)).toString("utf8")
  }
  return text
}

const randAlnum = (n: number, alphabet =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"): string => {
  const bytes = randomBytes(n)
  let s = ""
  for (let i = 0; i < n; i++) s += alphabet[bytes[i]! % alphabet.length]
  return s
}

interface Planted {
  text: string
  secret: string
}

/** One random token per shape in redact-patterns.json, made at test time. */
const plantTokens = (): Planted[] => {
  const upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
  const tok = (prefix: string, secret: string): Planted => ({
    text: prefix + secret,
    secret,
  })
  return [
    tok("ghp_", randAlnum(36)),
    tok("gho_", randAlnum(36)),
    tok("github_pat_", `${randAlnum(22)}_${randAlnum(59)}`),
    tok("sk-ant-", randAlnum(48)),
    tok("sk-", randAlnum(40)),
    tok("xoxb-", `${randAlnum(12)}-${randAlnum(24)}`),
    tok("AKIA", randAlnum(16, upper)),
    tok("glpat-", randAlnum(20)),
    tok("eyJ", `${randAlnum(20)}.eyJ${randAlnum(30)}.${randAlnum(40)}`),
    tok("npm_", randAlnum(36)),
    tok("Bearer ", randAlnum(32)),
    tok("bearer ", randAlnum(32)),
    tok("token=", randAlnum(24)),
    tok("secret=", randAlnum(24)),
    tok("password=", randAlnum(24)),
    tok("api_key=", randAlnum(24)),
    tok("API_TOKEN=", randAlnum(24)),
    tok("PASSWORD=", randAlnum(24)),
    tok("SECRET_KEY=", randAlnum(24)),
    tok("Deploy_Secret=", randAlnum(24)),
    tok("X_API_KEY=", randAlnum(24)),
    tok('"password": "', randAlnum(24)),
    tok('"Token":"', randAlnum(24)),
    tok('"secret": "', randAlnum(24)),
    tok('"API_KEY": "', randAlnum(24)),
  ]
}

const sq = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`

describe("line contract", () => {
  test("huge multibyte msg is cut; every line fits 4 KiB", async () => {
    const huge = "é漢🙂".repeat(15000) // about 100 KiB
    await writeFile(join(tmp, "huge.txt"), huge)
    const r = await runBash(`
huge="$(cat huge.txt)"
runlog_start caps "$huge"
runlog_event warn code=big msg="$huge"
runlog_event step name=many a="$huge" b="$huge" c="$huge" d="$huge"
runlog_end 0
`)
    expect(r.stderr).toBe("")
    expect(r.code).toBe(0)
    const evs = await events()
    expect(evs.map((e) => e.event)).toEqual(["start", "warn", "step", "end"])
    const warn = evs[1]!
    const msg = warn.msg as string
    expect(msg.endsWith("[cut]")).toBe(true)
    expect([...msg].length).toBe(512 + 5)
    expect((evs[0]!.argv as string[])[0]!.endsWith("[cut]")).toBe(true)
    // 4 x 512 four-byte characters can't fit: common fields + truncated.
    const many = evs[2]!
    expect(many.truncated).toBe(true)
    expect(many.a).toBeUndefined()
    expect(many.event).toBe("step")
    expect(await indexLines()).toHaveLength(1)
  })

  test("start carries host, pid, pid_start, boot_id, rev", async () => {
    const r = await runBash(`runlog_start meta x y
echo "$$"
runlog_end 0`)
    expect(r.code).toBe(0)
    const start = (await events())[0]!
    expect(start.argv).toEqual(["x", "y"])
    expect(start.cwd).toBe(tmp)
    expect(start.pid).toBe(Number(r.stdout.trim()))
    expect(start.host).toEqual(expect.any(String))
    expect(start.pid_start).toEqual(expect.any(Number))
    expect(start.boot_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(start.rev).toMatch(/^[0-9a-f]{4,}$/)
    expect(start.parent_run_id).toBeNull()
    expect(start.root_run_id).toBe(start.run_id)
    const id = start.run_id as string
    expect(id).toMatch(/^\d{6}T\d{6}Z-meta-[0-9a-f]{4}$/)
    // The id names its own day folder.
    const files = await walk(join(home, "runs", id.slice(0, 6)))
    expect(files).toContain(join(home, "runs", id.slice(0, 6), `${id}.jsonl`))
  })

  test("files are 0600 and folders 0700", async () => {
    await writeFile(join(tmp, "a.txt"), "hello\n")
    const r = await runBash(`runlog_start perms
runlog_artifact report a.txt
runlog_end 0`)
    expect(r.code).toBe(0)
    const all = await walk(join(home, "runs"))
    expect(all.length).toBeGreaterThanOrEqual(5)
    for (const f of [join(home, "runs"), ...all]) {
      const s = await stat(f)
      expect(s.mode & 0o777).toBe(s.isDirectory() ? 0o700 : 0o600)
    }
  })
})

describe("linking", () => {
  test("parent and root link across nested bash processes", async () => {
    const inner = await writeScript("inner.sh", `runlog_start inner
echo "inner=$BOKU_RUN_ID root=$BOKU_ROOT_RUN_ID"
runlog_end 0`)
    const mid = await writeScript("mid.sh", `runlog_start mid
bash ${sq(inner)}
runlog_end 0`)
    const outer = await writeScript("outer.sh", `runlog_start outer
bash ${sq(mid)}
runlog_end 0`)
    const r = await runScript(outer)
    expect(r.stderr).toBe("")
    expect(r.code).toBe(0)
    const starts = (await events()).filter((e) => e.event === "start")
    const by = Object.fromEntries(starts.map((e) => [e.tool, e]))
    const o = by.outer!, m = by.mid!, i = by.inner!
    expect(o.parent_run_id).toBeNull()
    expect(o.root_run_id).toBe(o.run_id)
    expect(m.parent_run_id).toBe(o.run_id)
    expect(m.root_run_id).toBe(o.run_id)
    expect(i.parent_run_id).toBe(m.run_id)
    expect(i.root_run_id).toBe(o.run_id)
    expect(r.stdout.trim()).toBe(`inner=${i.run_id} root=${o.run_id}`)
    const idx = await indexLines()
    expect(idx.map((l) => l.tool).sort()).toEqual(["inner", "mid", "outer"])
  })

  test("no BOKU_RUN_ID is exported before start or when off", async () => {
    const r = await runBash(`echo "before=\${BOKU_RUN_ID:-none}"
runlog_start offrun
echo "after=\${BOKU_RUN_ID:-none}"
runlog_end 0`, baseEnv({ BOKU_RUNLOG: "0", BOKU_RUN_ID: "x-inherited" }))
    expect(r.stdout).toBe("before=x-inherited\nafter=none\n")
    expect(await walk(home)).toEqual([])
  })
})

test("50 concurrent processes append 50 valid index lines", async () => {
  const path = await writeScript("one.sh", `runlog_start conc "$1"
runlog_event warn code=busy msg="worker $1"
runlog_end 0`)
  const results = await Promise.all(
    Array.from({ length: 50 }, (_, i) => runScript(path, baseEnv(), [`${i}`])),
  )
  for (const r of results) {
    expect(r.code).toBe(0)
    expect(r.stderr).toBe("")
  }
  const idx = await indexLines()
  expect(idx).toHaveLength(50)
  expect(new Set(idx.map((l) => l.run_id)).size).toBe(50)
  for (const l of idx) {
    expect(l.status).toBe("ok")
    expect(l.warns).toBe(1)
  }
  const evs = await events()
  expect(evs.filter((e) => e.event === "end")).toHaveLength(50)
}, 60_000)

describe("fail open", () => {
  /** A producer touching every writer function, with its own exit code. */
  const producer = `on_exit() {
  local -r code=$?
  runlog_end "$code"
}
runlog_start fo a b
trap on_exit EXIT
echo "id=\${BOKU_RUN_ID:-none} active=$(runlog_active && echo y || echo n)"
runlog_event warn code=w msg=hello
runlog_step ok true
rc=0
runlog_step bad bash -c 'echo from-step; exit 6' || rc=$?
echo "rc=$rc"
printf 'x\\n' > art.txt
runlog_artifact report art.txt
if d="$(runlog_dir)"; then echo "dir"; else echo "no-dir"; fi
if f="$(runlog_file)"; then echo "file"; else echo "no-file"; fi
exit 4`

  const expectSameAsOff = async (
    env: Record<string, string>,
  ): Promise<void> => {
    const path = await writeScript("fo.sh", producer)
    const off = await runScript(path, { ...env, BOKU_RUNLOG: "0" })
    const broken = await runScript(path, env)
    expect(off.code).toBe(4)
    expect(broken.code).toBe(off.code)
    expect(broken.stdout).toBe(off.stdout)
    expect(broken.stderr).toBe(off.stderr)
    expect(off.stdout).toBe(
      "id=none active=n\nfrom-step\nrc=6\nno-dir\nno-file\n",
    )
  }

  test("BOKU_HOME is a file", async () => {
    const file = join(tmp, "home-file")
    await writeFile(file, "")
    await expectSameAsOff(baseEnv({ BOKU_HOME: file }))
    expect(await readFile(file, "utf8")).toBe("")
  })

  test("BOKU_HOME is chmod 0500", async () => {
    await chmod(home, 0o500)
    await expectSameAsOff(baseEnv())
    await chmod(home, 0o700)
    expect(await walk(home)).toEqual([])
  })

  test("jq is missing from PATH", async () => {
    const bin = join(tmp, "bin")
    await mkdir(bin)
    const tools = ["bash", "cat", "mkdir", "mktemp", "head", "tail", "mv",
      "rm", "wc", "awk", "sha256sum", "chmod", "uname", "date", "git",
      "dirname", "env"]
    for (const t of tools) {
      const found = Bun.which(t)
      if (found) await symlink(found, join(bin, t))
    }
    expect(Bun.which("jq", { PATH: bin })).toBeNull()
    await expectSameAsOff(baseEnv({ PATH: bin }))
    expect(await walk(home)).toEqual([])
  })

  test("a later write error turns the writer off for the process", async () => {
    const r = await runBash(`runlog_start later
f="$(runlog_file)"
rm -f "$f"; mkdir "$f"
runlog_event warn code=a
echo "active=$(runlog_active && echo y || echo n)"
runlog_event warn code=b
runlog_end 1`)
    expect(r.code).toBe(0)
    expect(r.stdout).toBe("active=n\n")
    expect(r.stderr).toBe("")
  })
})

describe("runlog_step", () => {
  test("returns the command's status and logs exit and dur_ms", async () => {
    const r = await runBash(`runlog_start steps
rc=0
runlog_step fails bash -c 'exit 7' || rc=$?
echo "rc=$rc"
runlog_step sleeps sleep 0.2
runlog_end 0`)
    expect(r.stderr).toBe("")
    expect(r.stdout).toBe("rc=7\n")
    const steps = (await events()).filter((e) => e.event === "step")
    expect(steps[0]).toMatchObject({ name: "fails", exit: 7,
      cmd: "bash -c exit 7" })
    expect(steps[0]!.dur_ms).toEqual(expect.any(Number))
    expect(steps[1]).toMatchObject({ name: "sleeps", exit: 0 })
    expect(steps[1]!.dur_ms as number).toBeGreaterThanOrEqual(150)
  })

  test("a failing step under set -e still writes end", async () => {
    const r = await runBash(`on_exit() {
  local -r code=$?
  runlog_end "$code"
}
runlog_start sync
trap on_exit EXIT
runlog_step gh-rev-install bash -c 'exit 101'
echo unreachable`)
    expect(r.code).toBe(101)
    expect(r.stdout).toBe("")
    const evs = await events()
    expect(evs.at(-1)).toMatchObject({ event: "end", exit: 101,
      status: "failed" })
    expect(await indexLines()).toHaveLength(1)
  })

  test("runs the command when logging is off", async () => {
    const r = await runBash(`rc=0
runlog_step x bash -c 'echo hi; exit 3' || rc=$?
echo "rc=$rc"`)
    expect(r.stdout).toBe("hi\nrc=3\n")
    expect(await walk(home)).toEqual([])
  })
})

describe("runlog_end status", () => {
  const cases: [string, string, unknown][] = [
    ["0", "ok", 0], ["1", "failed", 1], ["2", "stopped", 2],
    ["3", "stopped", 3], ["4", "stopped", 4], ["5", "stopped", 5],
    ["6", "failed", 6], ["101", "failed", 101], ["130", "failed", 130],
    ["0 status=failed", "failed", 0], ["1 status=stopped", "stopped", 1],
    ["5 status=ok", "ok", 5], ["bogus", "failed", null],
  ]
  test("maps exit codes, and an explicit status wins", async () => {
    const path = await writeScript("end.sh", `runlog_start st
runlog_event warn code=a
runlog_event error code=b
runlog_event error code=c
runlog_end $1`)
    for (const [args, status, exit] of cases) {
      await rm(join(home, "runs"), { recursive: true, force: true })
      const r = await runScript(path, baseEnv(), [args])
      expect(r.code).toBe(0)
      const end = (await events()).at(-1)!
      expect(end).toMatchObject({ event: "end", exit, status, warns: 1,
        errors: 2 })
      const [idx] = await indexLines()
      expect(idx).toMatchObject({ exit, status, warns: 1, errors: 2,
        agent: null, run_id: end.run_id })
    }
  }, 30_000)

  test("index carries the agent and the start time", async () => {
    const r = await runBash(`runlog_start ag
runlog_event agent cli=claude session_id=abc-123 outcome=merged exit:=0
runlog_end 0
runlog_end 1`)
    expect(r.code).toBe(0)
    const evs = await events()
    expect(evs.filter((e) => e.event === "end")).toHaveLength(1)
    const [idx] = await indexLines()
    expect(idx!.agent).toEqual({ cli: "claude", session_id: "abc-123" })
    expect(idx!.ts).toBe(evs[0]!.ts)
    expect(idx!.dur_ms).toEqual(expect.any(Number))
  })
})

describe("end counts warnings in the run file", () => {
  const cliPath = join(import.meta.dir, "cli.ts")

  test("warns from a subshell and the tap process count", async () => {
    const stream = JSON.stringify({ type: "system", subtype: "init",
      session_id: "other-session" })
    const r = await runBash(`runlog_start wc
trap 'runlog_end $?' EXIT
( runlog_event warn code=from-subshell )
( runlog_event error code=from-subshell )
printf '%s\\n' ${sq(stream)} \\
  | bun ${sq(cliPath)} tap --cli claude --session-id my-session
runlog_event warn code=from-main
runlog_event step name=nested detail:='{"event":"warn"}'`)
    expect(r.code).toBe(0)
    const evs = await events()
    const warns = evs.filter((e) => e.event === "warn").map((e) => e.code)
    expect(warns.sort()).toEqual(
      ["from-main", "from-subshell", "session-mismatch"])
    const end = evs.at(-1)!
    expect(end).toMatchObject({ event: "end", warns: 3, errors: 1 })
    const [idx] = await indexLines()
    expect(idx).toMatchObject({ warns: 3, errors: 1 })
  }, 30_000)

  test("falls back to this process's counters without the file",
    async () => {
      const r = await runBash(`runlog_start wc
( runlog_event warn code=lost )
runlog_event warn code=kept
runlog_event error code=kept
rm -f -- "$(runlog_file)"
runlog_end 0`)
      expect(r.code).toBe(0)
      const evs = await events()
      expect(evs).toHaveLength(1)
      expect(evs[0]).toMatchObject({ event: "end", warns: 1, errors: 1 })
    })
})

describe("runlog_trap_signals", () => {
  const cases: [NodeJS.Signals, number][] = [
    ["SIGTERM", 143], ["SIGINT", 130], ["SIGHUP", 129],
  ]
  for (const [signal, exit] of cases) {
    test(`${signal} ends the run with exit=${exit} status=failed`,
      async () => {
        const path = await writeScript(`sig-${signal}.sh`, `runlog_start sig
runlog_trap_signals
trap 'runlog_end $?' EXIT
runlog_event step name=ready
while :; do sleep 0.05; done`)
        const proc = Bun.spawn(["bash", path], {
          cwd: tmp, env: baseEnv(), stdout: "ignore", stderr: "pipe",
        })
        const deadline = Date.now() + 10_000
        while (!(await events().catch(() => [])).some(
          (e) => e.event === "step")) {
          if (Date.now() > deadline) throw new Error("script never started")
          await Bun.sleep(20)
        }
        proc.kill(signal)
        expect(await proc.exited).toBe(exit)
        const end = (await events()).at(-1)!
        expect(end).toMatchObject({ event: "end", exit, status: "failed" })
        const [idx] = await indexLines()
        expect(idx).toMatchObject({ exit, status: "failed" })
      }, 15_000)
  }
})

describe("redaction", () => {
  test("no planted token survives in events or artifacts", async () => {
    const planted = plantTokens()
    const joined = planted.map((p) => p.text).join(" ")
    await writeFile(join(tmp, "leak.txt"),
      planted.map((p) => `line with ${p.text} in it`).join("\n") + "\n")
    const argv = planted.map((p) => sq(p.text)).join(" ")
    const r = await runBash(`runlog_start red ${argv}
runlog_event warn code=leak msg=${sq(joined)} extra=${sq(planted[0]!.text)}
runlog_event step name=raw detail:=${sq(JSON.stringify({ nested: joined }))}
runlog_step echoes true ${argv}
runlog_artifact report leak.txt
runlog_end 0`)
    expect(r.stderr).toBe("")
    expect(r.code).toBe(0)
    const stored = await allStoredText()
    for (const p of planted) {
      expect(stored).not.toContain(p.secret)
    }
    const evs = await events()
    const start = evs[0]!
    expect((start.argv as string[])[0]).toBe("[redacted:github-token]")
    const kinds = [...stored.matchAll(/\[redacted:([a-z-]+)\]/g)].map(
      (m) => m[1],
    )
    for (const k of ["github-token", "github-pat", "anthropic-key",
      "api-key", "slack-token", "aws-key", "gitlab-token", "npm-token",
      "jwt", "bearer", "token-value", "secret-value", "secret-key-value",
      "password-value", "api-key-value", "token-json", "secret-json",
      "password-json", "api-key-json"]) {
      expect(kinds).toContain(k)
    }
  })
})

describe("runlog_artifact", () => {
  test("copies under the kind's name, capped and redacted", async () => {
    const planted = plantTokens()
    const body = Array.from({ length: 400 }, (_, i) =>
      `row ${i} ${planted[i % planted.length]!.text}`).join("\n") + "\n"
    await writeFile(join(tmp, "big.diff"), body)
    await writeFile(join(tmp, "small"), `one ${planted[0]!.text}\n`)
    await writeFile(join(tmp, "p.md"), "# Prompt\n")
    const r = await runBash(`runlog_start art
runlog_artifact remerge-diff big.diff
runlog_artifact conflict-diff small
runlog_artifact prompt p.md
echo "$(runlog_dir)"`, baseEnv({ BOKU_RUNLOG_ARTIFACT_MAX: "4096" }))
    expect(r.stderr).toBe("")
    const dir = r.stdout.trim()
    const arts = (await events()).filter((e) => e.event === "artifact")
    expect(arts.map((a) => a.path)).toEqual(
      ["remerge.diff", "conflict.diff", "prompt.md"])
    const big = await readFile(join(dir, "remerge.diff"))
    expect(arts[0]).toMatchObject({ kind: "remerge-diff", truncated: true,
      bytes: big.length })
    expect(big.length).toBeLessThanOrEqual(4096)
    expect(big.toString().endsWith("\n")).toBe(true)
    expect(arts[0]!.sha256).toBe(
      createHash("sha256").update(big).digest("hex"))
    const small = await readFile(join(dir, "conflict.diff"), "utf8")
    expect(small).toBe("one [redacted:github-token]\n")
    expect(arts[1]).toMatchObject({ truncated: false,
      bytes: Buffer.byteLength(small) })
    expect(await readFile(join(dir, "prompt.md"), "utf8")).toBe("# Prompt\n")
    const stored = await allStoredText()
    for (const p of planted) expect(stored).not.toContain(p.secret)
  })

  test("a file already in the run folder is redacted in place", async () => {
    const planted = plantTokens()[0]!
    const r = await runBash(`runlog_start inplace
d="$(runlog_dir)"
printf 'hi %s\\n' ${sq(planted.text)} > "$d/prompt.md"
runlog_artifact prompt "$d/prompt.md"
cat "$d/prompt.md"
ls "$d"`)
    expect(r.stdout).toBe("hi [redacted:github-token]\nprompt.md\n")
  })

  test("a missing source logs a warning", async () => {
    await runBash(`runlog_start miss
runlog_artifact report nope.md
runlog_end 0`)
    const evs = await events()
    expect(evs[1]).toMatchObject({ event: "warn", code: "artifact-missing" })
    expect(evs.at(-1)).toMatchObject({ warns: 1 })
  })

  test("a broken boku-runs falls back to jq and keeps the writer on", async () => {
    const bin = join(tmp, "bin")
    await mkdir(bin)
    await writeFile(join(bin, "boku-runs"), "#!/bin/sh\nexit 1\n", {
      mode: 0o755,
    })
    const planted = plantTokens()[0]!
    await runBash(
      `runlog_start broken
printf 'x %s\\n' ${sq(planted.text)} > a.diff
runlog_artifact remerge-diff a.diff
runlog_event step name=after
runlog_end 0`,
      baseEnv({ PATH: `${bin}:${process.env.PATH}` }),
    )
    const evs = await events()
    expect(evs.map((e) => e.event)).toEqual([
      "start", "artifact", "step", "end",
    ])
    expect(await allStoredText()).not.toContain(planted.secret)
  })
})

describe("field values", () => {
  test("multi-line values and values containing = are kept whole", async () => {
    await runBash(`runlog_start multi
runlog_event agent challenges=$'\\nNone\\nsecond line' pair="a=b"
runlog_end 0`)
    const agent = (await events()).find((e) => e.event === "agent")!
    expect(agent).toMatchObject({
      challenges: "\nNone\nsecond line",
      pair: "a=b",
    })
  })
})

describe("runlog_dir and runlog_file", () => {
  test("print paths while active and return 1 otherwise", async () => {
    const r = await runBash(`if d="$(runlog_dir)"; then echo "dir=$d"; \
else echo "no-dir:[$d]"; fi
if f="$(runlog_file)"; then echo "f=$f"; else echo "no-file:[$f]"; fi
runlog_start paths
d="$(runlog_dir)"; f="$(runlog_file)"
echo "$d"; echo "$f"; [[ -d "$d" ]] && echo isdir
runlog_end 0
runlog_dir || echo "ended-no-dir"`)
    expect(r.stderr).toBe("")
    const out = r.stdout.trim().split("\n")
    expect(out[0]).toBe("no-dir:[]")
    expect(out[1]).toBe("no-file:[]")
    const id = (await events())[0]!.run_id as string
    const day = join(home, "runs", id.slice(0, 6))
    expect(out[2]).toBe(join(day, id))
    expect(out[3]).toBe(join(day, `${id}.jsonl`))
    expect(out[4]).toBe("isdir")
    expect(out[5]).toBe("ended-no-dir")
    expect((await stat(join(day, id))).mode & 0o777).toBe(0o700)
  })
})

describe("callers that never start", () => {
  test("--help writes nothing, even with an exit handler", async () => {
    const path = await writeScript("tool.sh", `on_exit() {
  local -r code=$?
  runlog_end "$code"
}
trap on_exit EXIT
if [[ "\${1:-}" == --help ]]; then echo "usage: tool"; exit 0; fi
runlog_start tool "$@"`)
    const r = await runScript(path, baseEnv(), ["--help"])
    expect(r).toEqual({ code: 0, stdout: "usage: tool\n", stderr: "" })
    expect(await walk(home)).toEqual([])
    const e = await runBash(`runlog_event warn code=x
runlog_artifact report /etc/hostname
runlog_end 1
runlog_active || echo inactive`)
    expect(e.stdout).toBe("inactive\n")
    expect(await walk(home)).toEqual([])
  })
})

describe("BOKU_RUNLOG_STDOUT", () => {
  test("prints events, even when off, but not for children", async () => {
    const child = await writeScript("child.sh", `runlog_start child
echo "child-stdout=\${BOKU_RUNLOG_STDOUT:-unset}"
runlog_end 0`)
    for (const off of [false, true]) {
      await rm(join(home, "runs"), { recursive: true, force: true })
      const env = baseEnv({ BOKU_RUNLOG_STDOUT: "1",
        ...(off ? { BOKU_RUNLOG: "0" } : {}) })
      const r = await runBash(`runlog_start parent
bash ${sq(child)}
runlog_event warn code=x
runlog_end 0`, env)
      expect(r.stderr).toBe("")
      const out = r.stdout.trim().split("\n")
      expect(out[1]).toBe("child-stdout=unset")
      const printed = [out[0]!, ...out.slice(2)].map((l) => JSON.parse(l))
      expect(printed.map((e) => e.event)).toEqual(["start", "warn", "end"])
      const stored = await events()
      if (off) {
        expect(stored).toEqual([])
      } else {
        expect(stored.filter((e) => e.tool === "parent")).toEqual(printed)
      }
    }
  })
})
