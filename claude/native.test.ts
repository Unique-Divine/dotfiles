import { afterEach, expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const roots: string[] = []
const script = join(import.meta.dir, "native.sh")

afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })))
})

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "claude-native-"))
  roots.push(home)
  const bin = join(home, ".local/bin")
  const versions = join(home, ".local/share/claude/versions")
  await mkdir(bin, { recursive: true })
  await mkdir(versions, { recursive: true })
  const target = join(versions, "fixture")
  await writeFile(target, "#!/bin/sh\nprintf '1.0.0 (Claude Code)\\n'\n", { mode: 0o755 })
  return { home, bin, target }
}

async function run(
  home: string,
  bin: string,
  mode = "--check",
  extraEnv: Record<string, string> = {},
) {
  const proc = Bun.spawn(["bash", script, mode], {
    env: {
      ...process.env,
      HOME: home,
      PATH: `${bin}:/usr/bin:/bin`,
      ...extraEnv,
    },
    stdout: "pipe", stderr: "pipe",
  })
  const [code, stderr] = await Promise.all([
    proc.exited, new Response(proc.stderr).text(),
  ])
  return { code, stderr }
}

test("checks native Claude without changing its executable", async () => {
  const f = await fixture()
  await symlink(f.target, join(f.bin, "claude"))
  const before = await readFile(f.target)
  expect(await run(f.home, f.bin)).toEqual({ code: 0, stderr: "" })
  expect(await run(f.home, f.bin, "--run")).toEqual({ code: 0, stderr: "" })
  expect(await readFile(f.target)).toEqual(before)
})

test("missing native Claude reports a repair without installing", async () => {
  const f = await fixture()
  const result = await run(f.home, f.bin)
  expect(result.code).toBe(1)
  expect(result.stderr).toContain("just claude-install")
  expect(await Bun.file(join(f.bin, "claude")).exists()).toBe(false)
})

test("detects a shadowing executable on PATH", async () => {
  const f = await fixture()
  await symlink(f.target, join(f.bin, "claude"))
  const other = join(f.home, "other")
  await mkdir(other)
  await writeFile(join(other, "claude"), "#!/bin/sh\nexit 0\n", { mode: 0o755 })
  const result = await run(f.home, `${other}:${f.bin}`)
  expect(result.code).toBe(1)
  expect(result.stderr).toContain("Claude resolves to")
})

test("refuses to replace an unrelated executable", async () => {
  const f = await fixture()
  const executable = join(f.bin, "claude")
  await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 })
  const before = await readFile(executable)
  const result = await run(f.home, f.bin, "--run")
  expect(result.code).toBe(1)
  expect(result.stderr).toContain("Unexpected Claude installation")
  expect(await readFile(executable)).toEqual(before)
})

test("--run installs a missing Claude with the native installer", async () => {
  const f = await fixture()
  // Mirrors the real installer: a versioned binary and a launcher symlink.
  const installer = join(f.home, "install.sh")
  await writeFile(
    installer,
    [
      'v="$HOME/.local/share/claude/versions/9.9.9"',
      `printf '#!/bin/sh\\necho "9.9.9 (Claude Code)"\\n' > "$v"`,
      'chmod +x "$v"',
      'ln -sf "$v" "$HOME/.local/bin/claude"',
      "",
    ].join("\n"),
  )
  const env = { CLAUDE_INSTALL_URL: `file://${installer}` }
  expect(await run(f.home, f.bin, "--run", env)).toEqual({ code: 0, stderr: "" })
  expect(await run(f.home, f.bin)).toEqual({ code: 0, stderr: "" })
})
