import { afterEach, expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const roots: string[] = []
const script = join(import.meta.dir, "native.sh")

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  )
})

/** An empty HOME and a fake installer reachable through a file:// URL. */
async function fixture(installer: string) {
  const home = await mkdtemp(join(tmpdir(), "codex-native-"))
  roots.push(home)
  const bin = join(home, ".local/bin")
  await mkdir(bin, { recursive: true })
  const installerPath = join(home, "install.sh")
  await writeFile(installerPath, installer)
  return { home, bin, url: `file://${installerPath}` }
}

// Mirrors what the real installer leaves: a codex command in ~/.local/bin.
const workingInstaller = `
mkdir -p "$HOME/.local/bin"
printf '#!/bin/sh\\necho "codex-cli 9.9.9"\\n' > "$HOME/.local/bin/codex"
chmod +x "$HOME/.local/bin/codex"
echo "noninteractive=$CODEX_NON_INTERACTIVE" > "$HOME/installer.log"
`

async function run(f: { home: string; bin: string; url: string }, mode: string) {
  const proc = Bun.spawn(["bash", script, mode], {
    env: {
      HOME: f.home,
      PATH: `${f.bin}:/usr/bin:/bin`,
      CODEX_INSTALL_URL: f.url,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
  ])
  return { code, stderr }
}

test("--run installs a missing codex with the installer, non-interactively", async () => {
  const f = await fixture(workingInstaller)
  expect(await run(f, "--run")).toEqual({ code: 0, stderr: "" })
  expect(await readFile(join(f.home, "installer.log"), "utf8")).toBe(
    "noninteractive=1\n",
  )
  expect(await run(f, "--check")).toEqual({ code: 0, stderr: "" })
})

test("--run leaves a working codex alone", async () => {
  const f = await fixture("echo ran > \"$HOME/installer.log\"\n")
  await writeFile(join(f.bin, "codex"), "#!/bin/sh\necho codex-cli 1.0.0\n", {
    mode: 0o755,
  })
  expect(await run(f, "--run")).toEqual({ code: 0, stderr: "" })
  expect(await Bun.file(join(f.home, "installer.log")).exists()).toBe(false)
})

test("--check reports a missing codex without installing", async () => {
  const f = await fixture(workingInstaller)
  const r = await run(f, "--check")
  expect(r.code).toBe(1)
  expect(r.stderr).toContain("just codex-install")
  expect(await Bun.file(join(f.bin, "codex")).exists()).toBe(false)
})

test("--run fails with a repair hint when the installer leaves no codex", async () => {
  const f = await fixture("exit 0\n")
  const r = await run(f, "--run")
  expect(r.code).toBe(1)
  expect(r.stderr).toContain("just codex-install")
})
