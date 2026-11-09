import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import {
  mkdir, mkdtemp, readdir, readFile, rm, writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { redact, redactLines } from "./runlog.ts"

// Runs one corpus through both redaction paths and asserts they agree:
// the bash writer's jq filters (event lines and _runlog_redact_file) and
// redact() in runlog.ts. See redact-patterns.md for the shared rules.

const writerPath = join(import.meta.dir, "runlog.sh")

const randAlnum = (n: number, alphabet =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"): string => {
  const bytes = randomBytes(n)
  let s = ""
  for (let i = 0; i < n; i++) s += alphabet[bytes[i]! % alphabet.length]
  return s
}

/** One token of every shape in redact-patterns.json, made at test time. */
const tokens = (): string[] => {
  const upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
  return [
    `ghp_${randAlnum(36)}`,
    `GHO_${randAlnum(36)}`,
    `github_pat_${randAlnum(22)}_${randAlnum(59)}`,
    `sk-ant-${randAlnum(48)}`,
    `sk-${randAlnum(40)}`,
    `SK-${randAlnum(40)}`,
    `xoxb-${randAlnum(12)}-${randAlnum(24)}`,
    `AKIA${randAlnum(16, upper)}`,
    `glpat-${randAlnum(20)}`,
    `npm_${randAlnum(36)}`,
    `NPM_${randAlnum(36)}`,
    `eyJ${randAlnum(20)}.eyJ${randAlnum(30)}.${randAlnum(40)}`,
    `Authorization: Bearer ${randAlnum(32)}`,
    `authorization: bearer ${randAlnum(32)}`,
    `BEARER ${randAlnum(32)}`,
  ]
}

/** Env-style assignments of sensitive names, in several cases. */
const envForms = (): string[] => {
  const names = ["token", "TOKEN", "API_TOKEN", "api_token", "Api_Token",
    "GITHUB_TOKEN", "secret", "SECRET", "Client_Secret", "AWS_SECRET",
    "SECRET_KEY", "secret_key", "Django_Secret_Key", "password",
    "PASSWORD", "DB_PASSWORD", "Db_Password", "api_key", "API_KEY",
    "X_API_KEY", "x_Api_Key"]
  const out: string[] = []
  for (const name of names) {
    out.push(`${name}=${randAlnum(24)}`)
    out.push(`export ${name}="${randAlnum(24)}"`)
    out.push(`${name}='${randAlnum(24)}' next=1`)
    out.push(`https://x.test/?${name}=${randAlnum(16)}&page=2`)
  }
  out.push(`GITHUB_TOKEN=ghp_${randAlnum(36)}`)
  out.push("token= empty, tokens are fine, password=")
  return out
}

/** JSON-style keys, plain and escaped inside another JSON string. */
const jsonForms = (): string[] => {
  const keys = ["password", "PASSWORD", "db_password", "token", "Token",
    "access_token", "secret", "Client_Secret", "api_key", "API_KEY"]
  const out: string[] = []
  for (const key of keys) {
    out.push(`{"${key}": "${randAlnum(20)}", "user": "me"}`)
    out.push(`{"${key}":"${randAlnum(10)}\\"${randAlnum(10)}"}`)
    out.push(JSON.stringify({ msg: `{"${key}": "${randAlnum(20)}"}` }))
    out.push(`"${key}": "${randAlnum(12)}\n"next": "line"`)
  }
  out.push(`{"token": "ghp_${randAlnum(36)}"}`)
  out.push(`{"password": ""}`)
  return out
}

/** Key names added for wallet and cloud keys, in env, JSON, and YAML. */
const keyForms = (): string[] => {
  const hex = (n: number): string => randAlnum(n, "0123456789abcdef")
  const words = (): string => Array.from({ length: 12 },
    () => randAlnum(6, "abcdefghijklmnopqrstuvwxyz")).join(" ")
  return [
    `PRIVATE_KEY=0x${hex(64)}`,
    `export DEPLOYER_PRIVATE_KEY="0x${hex(64)}"`,
    `private_key='${hex(64)}' next=1`,
    `AWS_SECRET_ACCESS_KEY=${randAlnum(40)}`,
    `aws_access_key=${randAlnum(20)}`,
    `MNEMONIC="${words()}"`,
    `mnemonic='${words()}'`,
    `MNEMONIC=${words()}`,
    `{"private_key": "0x${hex(64)}"}`,
    `{"Access_Key":"${randAlnum(20)}"}`,
    `{"mnemonic": "${words()}"}`,
    `password: ${randAlnum(16)}`,
    `  db_password: "${randAlnum(16)} two"`,
    `token: '${randAlnum(16)}'`,
    `- api_token: ${randAlnum(16)}`,
    `secret: ${randAlnum(16)}`,
    `API_KEY: ${randAlnum(16)}`,
    `private_key: 0x${hex(64)}`,
    `mnemonic: ${words()}`,
    `mnemonic: "${words()}"`,
  ]
}

/**
 * Agent stream lines: JSON whose strings hold `KEY="value"` and quoted
 * URLs, so the raw line reads `KEY=\"value\"`.
 */
const streamForms = (): string[] => [
  JSON.stringify({ type: "user", message: { content: [{
    type: "tool_result", tool_use_id: "t1",
    content: `DB_PASSWORD="hunter2-${randAlnum(12)}"\n`
      + `API_KEY="${randAlnum(12)}"\nPRIVATE_KEY="0x${randAlnum(40)}"`,
  }] } }),
  JSON.stringify({ type: "assistant", message: { content: [{
    type: "tool_use", id: "t2", name: "Bash",
    input: { command: `curl "https://x/?token=${randAlnum(12)}"` },
  }] } }),
  JSON.stringify({ cmd: `echo 'secret=${randAlnum(12)}'`, n: 1 }),
  JSON.stringify([`export TOKEN="${randAlnum(12)}"`, 2]),
  `KEY_FILE contents: PASSWORD=\"${randAlnum(12)}\" done`,
  `{"broken": "json, token=\"${randAlnum(12)}\"`,
]

/** Words that hold a token prefix after other word characters. */
const lookalikes = [
  "task-add-run-log-feature-for-sync",
  "/home/u/risk-assessment-notes-for-q3.md",
  "boku/runlog-fix3-task-redaction-ask-sk-followups",
  "desk-npm_install_all_the_things_for_the_whole_monorepo_x",
  "mask_ghp_placeholder_value_with_more_chars",
  "keyJ eyJ_not_a_jwt_because_no_dots_here_at_all",
]

/** Whitespace both engines must agree on where a value ends. */
const whitespace = ["\t", "\r", "\v", "\f", "\u0085", " ", " ",
  " ", " ", " ", " ", " ", " ", "　",
  "﻿"]

const corpus = (): string[] => {
  const out = [...tokens(), ...envForms(), ...jsonForms(), ...keyForms(),
    ...streamForms(), ...lookalikes]
  for (const ws of whitespace) {
    out.push(`token=${randAlnum(12)}${ws}after`)
    out.push(`PASSWORD=${randAlnum(12)}${ws}after`)
    out.push(`Bearer ${randAlnum(16)}${ws}after`)
    out.push(`"secret": "${randAlnum(8)}${ws}${randAlnum(8)}"`)
  }
  out.push("plain text with no secrets", "[redacted:token-value]", "")
  return out
}

interface JqOutputs {
  events: string[]
  file: string
}

let tmp: string
let items: string[]
let jq: JqOutputs

/** Runs `items` through the bash writer's two jq paths. */
const runJq = async (): Promise<JqOutputs> => {
  const home = join(tmp, "home")
  await mkdir(home, { mode: 0o700 })
  await writeFile(join(tmp, "corpus.bin"), items.join("\0") + "\0")
  await writeFile(join(tmp, "corpus.txt"), items.join("\n") + "\n")
  // A failing boku-runs makes _runlog_redact_file use its jq fallback.
  const script = `set -Eeuo pipefail
source ${JSON.stringify(writerPath)}
boku-runs() { return 1; }
runlog_start parity
while IFS= read -r -d '' s; do
  runlog_event probe "s=$s"
done <corpus.bin
_runlog_redact_file corpus.txt
runlog_end 0
`
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith("BOKU_")) env[k] = v
  }
  const proc = Bun.spawn(["bash", "-c", script], {
    cwd: tmp, env: { ...env, BOKU_HOME: home },
    stdout: "pipe", stderr: "pipe",
  })
  const [stderr, code] = await Promise.all([
    new Response(proc.stderr).text(), proc.exited,
  ])
  expect(stderr).toBe("")
  expect(code).toBe(0)
  const day = (await readdir(join(home, "runs")))[0]!
  const runFile = (await readdir(join(home, "runs", day)))
    .find((f) => f.endsWith(".jsonl") && f !== "index.jsonl")!
  const lines = (await readFile(join(home, "runs", day, runFile), "utf8"))
    .trimEnd().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>)
  return {
    events: lines.filter((l) => l.event === "probe").map((l) => String(l.s)),
    file: await readFile(join(tmp, "corpus.txt"), "utf8"),
  }
}

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "redact-parity-"))
  items = corpus()
  jq = await runJq()
}, 60_000)

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true })
})

describe("jq and JS redact the same way", () => {
  test("the corpus stays under the 512-character cut", () => {
    for (const item of items) expect(item.length).toBeLessThan(512)
  })

  test("event lines match redact() item by item", () => {
    expect(jq.events).toHaveLength(items.length)
    const pairs = items.map((item, i) => ({
      item, jq: jq.events[i], js: redact(item),
    }))
    expect(pairs.filter((p) => p.jq !== p.js)).toEqual([])
  })

  test("_runlog_redact_file matches redactLines() on the whole file", () => {
    expect(jq.file).toBe(redactLines(items.join("\n") + "\n"))
  })

  /** The redacted file's line for each one-line item. */
  const fileLine = (): Map<string, string> => {
    const lines = jq.file.split("\n")
    const out = new Map<string, string>()
    let at = 0
    for (const item of items) {
      if (!item.includes("\n")) out.set(item, lines[at]!)
      at += item.split("\n").length
    }
    return out
  }

  test("JSON lines stay JSON, with no planted value left", () => {
    const lines = fileLine()
    for (const item of items) {
      if (item.includes("\n")) continue
      let parsed = true
      try {
        JSON.parse(item)
      } catch {
        parsed = false
      }
      if (parsed) expect(() => JSON.parse(lines.get(item)!)).not.toThrow()
    }
    for (const form of streamForms()) {
      const out = redactLines(form)
      expect(out).not.toMatch(/hunter2-[A-Za-z0-9]/)
      expect(out).not.toMatch(
        /(token|secret|password|api_key|private_key)=\\?["']?[A-Za-z0-9]/i)
    }
  })

  test("token prefixes inside words are left alone", () => {
    const lines = fileLine()
    for (const word of lookalikes) {
      expect(lines.get(word)).toBe(word)
      expect(redact(word)).toBe(word)
    }
  })

  test("every token, env, and JSON secret is redacted", () => {
    const keyNames = "(token|secret|secret_key|password|api_key|private_key"
      + "|access_key|mnemonic)"
    const out = jq.events.join("\n")
    expect(out).not.toMatch(/gh[pousr]_[A-Za-z0-9]{20}/i)
    expect(out).not.toMatch(/npm_[A-Za-z0-9]{36}/i)
    expect(out).not.toMatch(/bearer [A-Za-z0-9]{8}/i)
    expect(out).not.toMatch(
      new RegExp(`${keyNames}=\\\\?["']?[A-Za-z0-9]`, "i"))
    expect(out).not.toMatch(new RegExp(
      "(token|secret|password|api_key|private_key|mnemonic): [\"']?[A-Za-z0-9]",
      "i"))
    expect(out).not.toMatch(/0x[0-9a-f]{64}/i)
    expect(out).not.toMatch(
      new RegExp(`${keyNames}\\\\?": ?\\\\?"[A-Za-z0-9]`, "i"))
  })
})

describe("long inputs stay linear", () => {
  /** 200,000 characters of `eyJ` runs with no dot, so never a JWT. */
  const long = "eyJ".repeat(66_667)

  test("jq redacts them in under 2 s", async () => {
    const file = join(tmp, "long.txt")
    await writeFile(file, `${long}\n`)
    const script = `set -Eeuo pipefail
source ${JSON.stringify(writerPath)}
boku-runs() { return 1; }
_runlog_patterns=${JSON.stringify(join(import.meta.dir, "redact-patterns.json"))}
_runlog_redact_file ${JSON.stringify(file)}
`
    const started = performance.now()
    const proc = Bun.spawn(["bash", "-c", script], {
      stdout: "pipe", stderr: "pipe",
    })
    expect(await proc.exited).toBe(0)
    expect(performance.now() - started).toBeLessThan(2000)
    expect(await readFile(file, "utf8")).toBe(`${long}\n`)
  }, 60_000)

  test("JS redacts them in under 2 s", () => {
    const started = performance.now()
    expect(redactLines(long)).toBe(long)
    expect(performance.now() - started).toBeLessThan(2000)
  }, 60_000)

  // A 1 MiB, 16,000-line diff: one jq gsub per line took about 52 s, which
  // stalled git_mf after the merge whenever boku-runs was broken.
  test("jq redacts a 1 MiB many-line diff in under 15 s, same as JS", async () => {
    const lines = Array.from({ length: 16_000 }, (_, i) =>
      `+ line ${i} of a diff with some words and paths/like/this.ts x=${i}`)
    lines[500] = "+ API_TOKEN=supersecretvalue123"
    lines[900] = JSON.stringify({ content: 'DB_PASSWORD="hunter2-xyz" ok' })
    const text = `${lines.join("\n")}\n`
    const file = join(tmp, "big.diff")
    await writeFile(file, text)
    const script = `set -Eeuo pipefail
source ${JSON.stringify(writerPath)}
boku-runs() { return 1; }
_runlog_patterns=${JSON.stringify(join(import.meta.dir, "redact-patterns.json"))}
_runlog_redact_file ${JSON.stringify(file)}
`
    const started = performance.now()
    const proc = Bun.spawn(["bash", "-c", script], {
      stdout: "pipe", stderr: "pipe",
    })
    expect(await proc.exited).toBe(0)
    expect(performance.now() - started).toBeLessThan(15_000)
    const out = await readFile(file, "utf8")
    expect(out).not.toContain("supersecretvalue123")
    expect(out).not.toContain("hunter2-xyz")
    expect(out).toBe(redactLines(text))
  }, 120_000)
})
