import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const modulePath = join(import.meta.dir, "ssh-agent.zsh")

// Each test starts a real ssh-agent and generates real keys.
setDefaultTimeout(30_000)

type Fixture = {
  home: string
  runtimeDir: string
  socket: string
  agentPid: number
}

const fixtures: Fixture[] = []

const spawn = async (
  argv: string[],
  env: Record<string, string>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  const proc = Bun.spawn(argv, {
    env: { PATH: process.env.PATH ?? "", ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { exitCode, stdout, stderr }
}

/** A temporary HOME with the named passphrase-free keys and its own agent. */
const makeFixture = async (keyNames: string[]): Promise<Fixture> => {
  const root = await mkdtemp(join(tmpdir(), "ssh-agent-test-"))
  const home = join(root, "home")
  const runtimeDir = join(root, "run")
  await mkdir(join(home, ".ssh"), { recursive: true, mode: 0o700 })
  await mkdir(runtimeDir, { mode: 0o700 })
  for (const name of keyNames) {
    const r = await spawn(
      ["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", name,
        "-f", join(home, ".ssh", name)],
      {},
    )
    expect(r.exitCode).toBe(0)
  }
  const socket = join(runtimeDir, "agent.sock")
  const agent = await spawn(["ssh-agent", "-a", socket, "-s"], {})
  expect(agent.exitCode).toBe(0)
  const pid = Number(/SSH_AGENT_PID=(\d+)/.exec(agent.stdout)?.[1])
  const fixture = { home: root, runtimeDir, socket, agentPid: pid }
  fixtures.push(fixture)
  return { ...fixture, home }
}

const envFor = (f: Fixture): Record<string, string> => ({
  HOME: f.home,
  SSH_AUTH_SOCK: f.socket,
  XDG_RUNTIME_DIR: f.runtimeDir,
})

/** Run zsh without startup files, with the module sourced first. */
const zsh = (f: Fixture, body: string, env: Record<string, string> = {}) =>
  spawn(["zsh", "-f", "-c", `source ${modulePath}; ${body}`], {
    ...envFor(f),
    ...env,
  })

/** Quote one argument for a POSIX shell. */
const shellQuote = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`

/** Run zsh as an interactive shell on a real pty, as a new terminal does. */
const zshOnTerminal = (f: Fixture, body: string) => {
  const inner = `source ${modulePath}; ${body}`
  return spawn(
    ["script", "-qec", `zsh -f -i -c ${JSON.stringify(inner)}`, "/dev/null"],
    envFor(f),
  )
}

const loadedComments = async (f: Fixture): Promise<string[]> => {
  const r = await spawn(["ssh-add", "-l"], envFor(f))
  if (r.exitCode !== 0) return []
  return r.stdout
    .trim()
    .split("\n")
    .map((line) => line.split(" ")[2])
    .sort()
}

afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    if (f.agentPid) process.kill(f.agentPid)
    await rm(f.home, { recursive: true, force: true })
  }
})

describe("ssh_setup", () => {
  test("loads only the listed keys that exist on this machine", async () => {
    const f = await makeFixture(["id_ed25519", "peggyWSL", "unlisted_key"])
    const r = await zsh(f, "ssh_setup")
    expect(r.exitCode).toBe(0)
    expect(await loadedComments(f)).toEqual(["id_ed25519", "peggyWSL"])
  })

  test("fails with a hint when no agent socket exists", async () => {
    const f = await makeFixture(["id_ed25519"])
    const r = await zsh(f, "ssh_setup", {
      SSH_AUTH_SOCK: join(f.runtimeDir, "missing.sock"),
    })
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain("systemctl --user start ssh-agent")
  })
})

describe("ssh_auto_setup", () => {
  test("loads keys in a new terminal when the agent is empty", async () => {
    const f = await makeFixture(["id_ed25519"])
    const r = await zshOnTerminal(f, "ssh_auto_setup")
    expect(r.exitCode).toBe(0)
    expect(await loadedComments(f)).toEqual(["id_ed25519"])
  })

  test("does nothing in a shell with no terminal", async () => {
    const f = await makeFixture(["id_ed25519"])
    const r = await zsh(f, "ssh_auto_setup")
    expect(r.exitCode).toBe(0)
    expect(await loadedComments(f)).toEqual([])
  })

  test("leaves an agent that already holds keys alone", async () => {
    const f = await makeFixture(["id_ed25519", "peggyWSL"])
    const add = await spawn(
      ["ssh-add", join(f.home, ".ssh", "peggyWSL")],
      envFor(f),
    )
    expect(add.exitCode).toBe(0)
    await zshOnTerminal(f, "ssh_auto_setup")
    expect(await loadedComments(f)).toEqual(["peggyWSL"])
  })

  test("Ctrl-C at the passphrase prompt lets the shell carry on", async () => {
    const f = await makeFixture([])
    const key = join(f.home, ".ssh", "id_ed25519")
    const keygen = await spawn(
      ["ssh-keygen", "-q", "-t", "ed25519", "-N", "secret", "-f", key],
      {},
    )
    expect(keygen.exitCode).toBe(0)
    const lock = join(f.runtimeDir, "ssh-setup.lock")
    // After ssh_auto_setup, the shell must keep running zshrc (the marker)
    // and must have released the lock, so a later terminal can take it.
    const inner =
      `source ${modulePath}; ssh_auto_setup; echo AFTER-SETUP; ` +
      `zsh -f -c "zmodload zsh/system; ` +
      `zsystem flock -t 0 -f fd ${lock} && echo LOCK-FREE"`
    const terminal =
      `script -qec ${shellQuote(`zsh -f -i -c ${shellQuote(inner)}`)} ` +
      "/dev/null"
    // Wait for the passphrase prompt, then press Ctrl-C.
    const r = await spawn(
      ["bash", "-c", `(sleep 1; printf '\\003'; sleep 2) | ${terminal}`],
      envFor(f),
    )
    expect(r.stdout).toContain("AFTER-SETUP")
    expect(r.stdout).toContain("LOCK-FREE")
    expect(await loadedComments(f)).toEqual([])
  })

  test("skips while another terminal holds the lock", async () => {
    const f = await makeFixture(["id_ed25519"])
    const lock = join(f.runtimeDir, "ssh-setup.lock")
    // The outer shell takes the lock, so the inner terminal must skip. Exit
    // code 7 means the outer shell never got the lock, which would make an
    // empty agent prove nothing.
    const r = await zshOnTerminal(
      f,
      `: > ${lock}; zmodload zsh/system; ` +
        `zsystem flock -t 0 -f fd ${lock} || exit 7; ` +
        `zsh -f -i -c "source ${modulePath}; ssh_auto_setup"`,
    )
    expect(r.exitCode).toBe(0)
    expect(await loadedComments(f)).toEqual([])
  })
})
