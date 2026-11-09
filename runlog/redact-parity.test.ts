import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import {
  mkdir, mkdtemp, readdir, readFile, rm, writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { cutString, redact, redactLines } from "./runlog.ts"

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

const hex = (n: number): string => randAlnum(n, "0123456789abcdef")
const b64 = (n: number): string => randAlnum(n,
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/")
const words = (): string => Array.from({ length: 12 },
  () => randAlnum(6, "abcdefghijklmnopqrstuvwxyz")).join(" ")

interface Secret {
  text: string
  /** Parts that must not survive redaction. */
  secrets: string[]
}

const pemBlock = (label: string, prefix = "", headers: string[] = []) => {
  const name = label ? `${label} PRIVATE KEY` : "PRIVATE KEY"
  const body = [b64(64), b64(64), `${b64(20)}==`]
  const text = [`${prefix}-----BEGIN ${name}-----`,
    ...headers.map((h) => `${prefix}${h}`),
    ...body.map((l) => `${prefix}${l}`),
    `${prefix}-----END ${name}-----`].join("\n")
  return { text, secrets: body }
}

/** A PEM block as Claude's Read tool prints it: `     2\t<line>`. */
const lineNumbered = ({ text, secrets }: Secret): Secret => ({
  text: text.split("\n").map((l, i) => `${String(i + 1).padStart(6)}\t${l}`)
    .join("\n"),
  secrets,
})

/** An armored PGP secret key, with a header, a blank line, and a CRC. */
const pgpBlock = (prefix = ""): Secret => {
  const body = [b64(64), b64(64), `${b64(30)}=`]
  const text = ["-----BEGIN PGP PRIVATE KEY BLOCK-----", "Version: x 1",
    "", ...body, `=${b64(4)}`, "-----END PGP PRIVATE KEY BLOCK-----"]
    .map((l) => `${prefix}${l}`).join("\n")
  return { text, secrets: body }
}

/** EVM keys, PEM keys, URL passwords, auth headers, and seed phrases. */
const secretForms = (): Secret[] => {
  const one = (pre: string, secret: string, post = ""): Secret =>
    ({ text: `${pre}${secret}${post}`, secrets: [secret] })
  const pem = pemBlock("OPENSSH")
  const nested = pemBlock("RSA")
  const pgp = pgpBlock()
  // A key in a YAML `|` block, as Kubernetes Secrets and Helm values hold it.
  const indented = pemBlock("", "  ")
  const yamlPem: Secret = {
    text: `tls.key: |\n${indented.text}\ntls.crt: x`,
    secrets: indented.secrets,
  }
  return [
    one("cast send --private-key 0x", hex(64), " --rpc-url x"),
    one("PRIVATE_KEY = 0x", hex(64)),
    one("export DEPLOYER_PK=0x", hex(64)),
    one('{"privateKey": "0x', hex(64), '"}'),
    one('{"PRIVKEY":"', hex(64), '"}'),
    one('accounts: ["0x', hex(64), '"]'),
    one("pk: ", hex(64)),
    one('private_key = "0x', hex(64), '"'),
    pem,
    pemBlock("RSA", "+"),
    pemBlock("RSA", " ", ["Proc-Type: 4,ENCRYPTED",
      "DEK-Info: AES-128-CBC,0011223344556677", ""]),
    { text: JSON.stringify({ type: "tool_result", content: pem.text }),
      secrets: pem.secrets },
    { text: JSON.stringify({ msg: JSON.stringify({ key: nested.text }) }),
      secrets: nested.secrets },
    { text: `echo ${JSON.stringify(nested.text)}`, secrets: nested.secrets },
    one("git clone https://ud:", randAlnum(20), "@github.com/o/r.git"),
    one("DATABASE_URL=postgres://app:", randAlnum(16), "@db:5432/x"),
    one("Authorization: Basic ", b64(24)),
    one('curl -H "authorization: basic ', b64(24), '" x'),
    one("Authorization: token ", randAlnum(40)),
    one('SEED_PHRASE="', words(), '"'),
    one("seed phrase: ", words()),
    one('{"seed_phrase": "', words(), '"}'),
    one("seedphrase=", words()),
    one('{"secret_key": "', randAlnum(24), '"}'),
    one("secret_key: ", randAlnum(24)),
    one('{"apiKey":"', randAlnum(24), '"}'),
    one('{"secretKey": "', randAlnum(24), '"}'),
    one('{"accessKey":"', randAlnum(24), '"}'),
    one("  access_key: ", randAlnum(24)),
    one("PASSWORD = ", randAlnum(24)),
    one('password := "', randAlnum(24), '"'),
    one("API_KEY = '", randAlnum(24), "'"),
    one("token := ", randAlnum(24)),
    one('PASSWORD = "', `hunter2-${randAlnum(8)}`, '"'),
    one("API_TOKEN = ", `abcdef${randAlnum(6)}`),
    yamlPem,
    lineNumbered(pemBlock("RSA")),
    pemBlock("RSA", "+  "),
    pgpBlock(),
    pgpBlock("    "),
    { text: JSON.stringify({ content: pgp.text }), secrets: pgp.secrets },
    one('cast wallet address --mnemonic "', words(), '"'),
    one("cast wallet address --mnemonic=", words()),
    one('{"command": "cast wallet address --mnemonic \\"', words(), '\\""}'),
    one("forge script --private-keys 0x", hex(64), " --broadcast"),
    // Key lists: every key after the first must go too.
    ((a = hex(64), b = hex(64), c = hex(64)): Secret => ({
      text: `forge script --private-keys 0x${a},0x${b},0x${c} --broadcast`,
      secrets: [a, b, c],
    }))(),
    ((a = hex(64), b = hex(64)): Secret => ({
      text: `accounts: ["0x${a}", "0x${b}"],`, secrets: [a, b],
    }))(),
    ((a = hex(64), b = hex(64)): Secret => ({
      text: `PRIVATE_KEYS=0x${a},0x${b}`, secrets: [a, b],
    }))(),
    ((a = hex(64), b = hex(64)): Secret => ({
      text: JSON.stringify({ privateKeys: [`0x${a}`, `0x${b}`] }),
      secrets: [a, b],
    }))(),
    one("REDIS_URL=redis://:", randAlnum(16), "@cache:6379"),
    one("https://", randAlnum(40), ":x-oauth-basic@github.com/o/r"),
    one("git clone https://", randAlnum(40), "@github.com/o/r.git"),
    one("https://u:", `${randAlnum(8)}/${randAlnum(8)}`, "@h/x"),
    one("curl -u admin:", randAlnum(16), " https://x"),
    one('curl --user "admin:', randAlnum(16), '" https://x'),
  ]
}

/** Normal Nibiru, EVM, and code lines that must come through untouched. */
const survivors = (): string[] => {
  const h = () => `0x${hex(64)}`
  const addr = () => `0x${hex(40)}`
  return [
    `nibid q tx ${h().slice(2).toUpperCase()}`,
    `cast tx ${h()} --rpc-url https://evm-rpc.nibiru.fi`,
    JSON.stringify({ transactionHash: h(), blockHash: h(), topics: [
      "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
      `0x000000000000000000000000${hex(40)}`] }),
    `cast storage ${addr()} ${h()}`,
    `+    bytes32 public constant MINTER_ROLE = ${h()};`,
    JSON.stringify({ event: "artifact", sha256: hex(64), bytes: 10 }),
    `${hex(64)}  remerge.diff`,
    `{"pubkey":"${hex(64)}","topic0":"${h()}"}`,
    `accounts: ["${addr()}"]`,
    `merge ${hex(40)} into main`,
    "basic configuration error in the Basic functionality test",
    'const header = "-----BEGIN RSA PRIVATE KEY-----"\n'
      + "func parse(b []byte) error {\n\treturn nil\n}",
    "ssh://git@host:22/repo.git and https://host:8080/a@v1",
    "git@github.com:o/r.git",
    "seed=42 rng seed=1234 torch.manual_seed(42)",
    "pkg: 0x01, pk_index=3",
    "max_token = 4096",
    '+\ttoken := ctx.Value("denom").(string)',
    "password := os.Getenv(\"DB_PASSWORD\")",
    "secret = None",
    'const armor = "-----BEGIN PGP PRIVATE KEY BLOCK-----"\n'
      + "\tif err := parse(b); err != nil {\n\t\treturn err\n\t}",
    "def main():\n    configureLogging()\n    return run_everything_now",
    "     1\tpackage main\n     2\t\n     3\tfunc main() {}",
    "docker run -u 1000:1000 img",
    "http://localhost-development-box:3000/a@b",
  ]
}

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
    ...streamForms(), ...lookalikes, ...secrets.map((x) => x.text),
    ...survivals]
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
let secrets: Secret[]
let survivals: string[]
let jq: JqOutputs

/** Runs `items` through the bash writer's two jq paths. */
const runJq = async (): Promise<JqOutputs> => {
  const home = join(tmp, "home")
  await mkdir(home, { mode: 0o700 })
  await writeFile(join(tmp, "corpus.bin"), items.join("\0") + "\0")
  await writeFile(join(tmp, "corpus.txt"), items.join("\n") + "\n")
  // A failing runs CLI makes _runlog_redact_file use its jq fallback.
  const script = `set -Eeuo pipefail
source ${JSON.stringify(writerPath)}
export BOKU_RUNS_CLI=/bin/false
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
  secrets = secretForms()
  survivals = survivors()
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

  test("normal hashes, topics, and code come through untouched", () => {
    const lines = fileLine()
    for (const item of survivals) {
      expect(jq.events[items.indexOf(item)]).toBe(item)
      expect(redact(item)).toBe(item)
      expect(redactLines(item)).toBe(item)
      if (!item.includes("\n")) expect(lines.get(item)).toBe(item)
    }
  })

  test("EVM, PEM, URL, auth, and seed secrets are redacted", () => {
    for (const { text, secrets: parts } of secrets) {
      const outs = [jq.events[items.indexOf(text)]!, redact(text),
        redactLines(text)]
      for (const out of outs) {
        for (const part of parts) expect(out).not.toContain(part)
        expect(out).toContain("[redacted:")
      }
    }
    expect(jq.file).not.toMatch(
      /^[-+ ]?[ \t]*(?:[0-9]+\t)?[A-Za-z0-9+/]{30,}={0,2}$/m)
  })

  test("every token, env, and JSON secret is redacted", () => {
    const keyNames = "(token|secret|secret_key|password|api_key|private_key"
      + "|access_key|mnemonic)"
    const out = jq.events.filter((_, i) => !survivals.includes(items[i]!))
      .join("\n")
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
export BOKU_RUNS_CLI=/bin/false
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

  // A 14,000-line diff, just under the 1 MiB fallback cap. One jq gsub per
  // line took about 52 s for 1 MiB, which stalled git_mf after the merge
  // whenever the runs CLI was broken.
  test("jq redacts a diff under the cap in under 15 s, as JS", async () => {
    const lines = Array.from({ length: 14_000 }, (_, i) =>
      `+ line ${i} of a diff with some words and paths/like/this.ts x=${i}`)
    lines[500] = "+ API_TOKEN=supersecretvalue123"
    lines[900] = JSON.stringify({ content: 'DB_PASSWORD="hunter2-xyz" ok' })
    const text = `${lines.join("\n")}\n`
    const file = join(tmp, "big.diff")
    await writeFile(file, text)
    const script = `set -Eeuo pipefail
source ${JSON.stringify(writerPath)}
export BOKU_RUNS_CLI=/bin/false
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

describe("the 512-character cut", () => {
  test("both writers cut at 512 code points, never inside a pair",
    async () => {
      const msg = `a${"😀".repeat(600)}`
      const home = join(tmp, "cut-home")
      await mkdir(home, { mode: 0o700 })
      const script = `set -Eeuo pipefail
source ${JSON.stringify(writerPath)}
runlog_start cut
runlog_event probe ${JSON.stringify(`s=${msg}`)}
runlog_end 0
`
      const env: Record<string, string> = {}
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined && !k.startsWith("BOKU_")) env[k] = v
      }
      const proc = Bun.spawn(["bash", "-c", script], {
        env: { ...env, BOKU_HOME: home }, stdout: "pipe", stderr: "pipe",
      })
      expect(await proc.exited).toBe(0)
      const day = (await readdir(join(home, "runs")))[0]!
      const runFile = (await readdir(join(home, "runs", day)))
        .find((f) => f.endsWith(".jsonl") && f !== "index.jsonl")!
      const probe = (await readFile(join(home, "runs", day, runFile), "utf8"))
        .trimEnd().split("\n").map((l) => JSON.parse(l))
        .find((l) => l.event === "probe")
      expect(probe.s).toBe(cutString(redact(msg)))
    })
})

describe("redact-patterns.json", () => {
  test("every pattern compiles in jq and JS on its own", async () => {
    const patterns = JSON.parse(await readFile(
      join(import.meta.dir, "redact-patterns.json"), "utf8",
    )) as { kind: string; regex: string }[]
    const failed: string[] = []
    for (const p of patterns) {
      const proc = Bun.spawn(["jq", "-n", "--arg", "re", p.regex,
        '"" | test($re; "gi")'], { stdout: "pipe", stderr: "pipe" })
      if (await proc.exited !== 0) failed.push(`jq: ${p.kind}`)
      try {
        new RegExp(p.regex, "gi")
      } catch {
        failed.push(`js: ${p.kind}`)
      }
    }
    expect(failed).toEqual([])
  })
})
