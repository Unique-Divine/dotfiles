import { afterEach, expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { grokHookCurrent } from "./herdr.ts"

const roots: string[] = []
const script = join(import.meta.dir, "herdr.ts")

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  )
})

test("reads the Grok line from herdr integration status", () => {
  const current = [
    "claude: current (v10) (/tmp/claude)",
    "grok: current (v2) (/tmp/grok)",
  ].join("\n")
  const missing = "grok: not installed (/tmp/grok)\n"

  expect(grokHookCurrent(current)).toBe(true)
  expect(grokHookCurrent(missing)).toBe(false)
  expect(grokHookCurrent("claude: current (v10) (/tmp)\n")).toBe(false)
})

const fakeHerdr = `#!/bin/sh
printf '%s\\n' "$*" >> "$HERDR_LOG"
if [ "$1" = integration ] && [ "$2" = status ]; then
  cat "$HERDR_STATUS_FILE"
  exit 0
fi
if [ "$1" = integration ] && [ "$2" = install ] && [ "$3" = grok ]; then
  if [ ! -d "$HOME/.grok" ]; then
    echo "grok config directory not found at $HOME/.grok" >&2
    exit 1
  fi
  printf '%s\\n' "grok: current (v2) (/tmp/grok)" > "$HERDR_STATUS_FILE"
  exit 0
fi
echo "unexpected: $*" >&2
exit 1
`

async function fixture(status: string) {
  const root = await mkdtemp(join(tmpdir(), "grok-herdr-"))
  roots.push(root)
  const bin = join(root, "bin")
  await mkdir(bin)
  await writeFile(join(bin, "herdr"), fakeHerdr, { mode: 0o755 })
  await writeFile(join(bin, "grok"), "#!/bin/sh\necho grok 1\n", {
    mode: 0o755,
  })
  const statusFile = join(root, "status")
  await writeFile(statusFile, `${status}\n`)
  return {
    env: {
      ...process.env,
      HOME: root,
      GROK_HOME: "",
      PATH: `${bin}:/usr/bin:/bin`,
      HERDR_LOG: join(root, "log"),
      HERDR_STATUS_FILE: statusFile,
    },
    log: join(root, "log"),
  }
}

const run = async (
  env: NodeJS.ProcessEnv,
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  const proc = Bun.spawn([process.execPath, script, ...args], {
    cwd: join(import.meta.dir, ".."),
    env,
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

test("--check accepts a current hook and rejects a missing one", async () => {
  const current = await fixture("grok: current (v2) (/tmp/grok)")
  expect(await run(current.env, ["--check"])).toMatchObject({
    exitCode: 0,
    stderr: "",
  })

  const missing = await fixture("grok: not installed (/tmp/grok)")
  const result = await run(missing.env, ["--check"])
  expect(result.exitCode).toBe(1)
  expect(result.stderr).toContain("just herdr-integrations")
  expect(await Bun.file(missing.log).exists()).toBe(true)
  expect(await readFile(missing.log, "utf8")).toBe("integration status\n")
})

test("--run installs only when the hook is not current", async () => {
  const missing = await fixture("grok: not installed (/tmp/grok)")
  const installed = await run(missing.env, ["--run"])
  expect(installed.exitCode).toBe(0)
  expect(installed.stdout).toContain("installed the Grok session hook")
  expect(await readFile(missing.log, "utf8")).toBe(
    "integration status\nintegration install grok\nintegration status\n",
  )

  const current = await fixture("grok: current (v2) (/tmp/grok)")
  expect(await run(current.env, ["--run"])).toMatchObject({ exitCode: 0 })
  expect(await readFile(current.log, "utf8")).toBe("integration status\n")
})
