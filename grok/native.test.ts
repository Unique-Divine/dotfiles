import { afterEach, expect, test } from "bun:test"
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
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
  const home = await mkdtemp(join(tmpdir(), "grok-native-"))
  roots.push(home)
  const bin = join(home, ".local/bin")
  await mkdir(bin, { recursive: true })
  const installerPath = join(home, "install.sh")
  await writeFile(installerPath, installer)
  return { home, bin, url: `file://${installerPath}` }
}

// Mirrors what the real installer leaves: a grok command in ~/.local/bin.
const workingInstaller = `
if [ "$(basename "\${SHELL:-}")" != sh ]; then
  target="$HOME/.zshrc"
  if [ -L "$target" ]; then
    target="$(readlink "$target")"
  fi
  printf '\\n# grok installer\\n' >> "$target"
  echo "refusing SHELL=\${SHELL:-}" >&2
  exit 1
fi
mkdir -p "$HOME/.local/bin"
printf '#!/bin/sh\\necho "grok 9.9.9"\\n' > "$HOME/.local/bin/grok"
chmod +x "$HOME/.local/bin/grok"
echo ran > "$HOME/installer.log"
`

async function run(
  f: { home: string; bin: string; url: string },
  mode: string,
) {
  const proc = Bun.spawn(["bash", script, mode], {
    env: {
      HOME: f.home,
      PATH: `${f.bin}:/usr/bin:/bin`,
      GROK_INSTALL_URL: f.url,
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

test("--run installs a missing grok with the installer", async () => {
  const f = await fixture(workingInstaller)
  const zshrc = join(f.home, "repo", "zshrc.zsh")
  await mkdir(join(f.home, "repo"))
  await writeFile(zshrc, "marker\n")
  await symlink(zshrc, join(f.home, ".zshrc"))
  expect(await run(f, "--run")).toEqual({ code: 0, stderr: "" })
  expect(await readFile(join(f.home, "installer.log"), "utf8")).toBe("ran\n")
  expect(await readFile(zshrc, "utf8")).toBe("marker\n")
  expect(await run(f, "--check")).toEqual({ code: 0, stderr: "" })
})

test("--run leaves a working grok alone", async () => {
  const f = await fixture("echo ran > \"$HOME/installer.log\"\n")
  await writeFile(join(f.bin, "grok"), "#!/bin/sh\necho grok 1.0.0\n", {
    mode: 0o755,
  })
  expect(await run(f, "--run")).toEqual({ code: 0, stderr: "" })
  expect(await Bun.file(join(f.home, "installer.log")).exists()).toBe(false)
})

test("--check reports a missing grok without installing", async () => {
  const f = await fixture(workingInstaller)
  const result = await run(f, "--check")
  expect(result.code).toBe(1)
  expect(result.stderr).toContain("just grok-install")
  expect(await Bun.file(join(f.bin, "grok")).exists()).toBe(false)
})

test(
  "--run fails with a repair hint when the installer leaves no grok",
  async () => {
    const f = await fixture("exit 0\n")
    const result = await run(f, "--run")
    expect(result.code).toBe(1)
    expect(result.stderr).toContain("just grok-install")
  },
)
