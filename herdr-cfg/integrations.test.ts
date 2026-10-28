import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { applySettings } from "../claude/config"
import { applyConfig } from "../codex/config"
import { applyCliConfig } from "../cursor/cli-config"

import {
  checkIntegrations, configDirectory, harnesses, installIntegrations,
  missingTools, readCodexConfig, readConfig, registered, type Environment,
} from "./integrations"

const homes: string[] = []
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) =>
    rm(home, { recursive: true, force: true })))
})

async function environment(): Promise<Environment> {
  const home = await mkdtemp(join(tmpdir(), "herdr hooks ' "))
  homes.push(home)
  return { HOME: home, PATH: process.env.PATH,
    CODEX_HOME: join(home, "custom codex"),
    CLAUDE_CONFIG_DIR: join(home, "custom claude"),
    CURSOR_CONFIG_DIR: join(home, "custom cursor") }
}

async function snapshot(env: Environment): Promise<string[]> {
  const texts: string[] = []
  for (const harness of harnesses) {
    const directory = configDirectory(harness, env)
    for (const relative of [harness.config, harness.script,
      ...(harness.name === "codex" ? ["config.toml"] : [])]) {
      texts.push(await readFile(join(directory, relative), "utf8"))
    }
  }
  return texts
}

test("required executables never silently skip a harness", async () => {
  const env = await environment()
  env.PATH = ""
  expect(missingTools(env)).toEqual([
    "herdr", "codex", "claude", "cursor-agent or agent",
  ])
  await expect(installIntegrations(env)).rejects.toThrow("Missing required CLI")
})

test("config directories honor defaults and tilde overrides", () => {
  const codex = harnesses[0]!
  expect(configDirectory(codex, { HOME: "/test" })).toBe("/test/.codex")
  expect(configDirectory(codex, {
    HOME: "/test", CODEX_HOME: "~/custom codex",
  })).toBe("/test/custom codex")
})

test("registration rejects disabled hooks and restrictive matchers", () => {
  const claude = harnesses[1]!
  const command = "bash '/test/hook.sh' session"
  const config = { hooks: { SessionStart: [
    { matcher: "^(startup|resume)$", hooks: [{ type: "command", command }] },
  ] } }
  expect(registered(claude, config, "/test/hook.sh")).toBe(true)
  expect(registered(claude, { ...config, disableAllHooks: true },
    "/test/hook.sh")).toBe(false)
  config.hooks.SessionStart[0]!.matcher = "^resume$"
  expect(registered(claude, config, "/test/hook.sh")).toBe(false)
})

test("malformed JSON and TOML diagnostics never contain source values",
  async () => {
    const env = await environment()
    const sentinel = `secret_${crypto.randomUUID().replaceAll("-", "")}`
    const cases = [
      { harness: harnesses[1]!, format: "JSON", file: "settings.json",
        text: `{"env":{"TOKEN":${sentinel}}}`,
        read: () => readConfig(harnesses[1]!, env) },
      { harness: harnesses[0]!, format: "TOML", file: "config.toml",
        text: `[mcp_servers.private.env]\nTOKEN = "${sentinel}" trailing\n`,
        read: () => readCodexConfig(env) },
    ]
    for (const entry of cases) {
      const directory = configDirectory(entry.harness, env)
      await mkdir(directory, { recursive: true })
      const path = join(directory, entry.file)
      await writeFile(path, entry.text)
      let diagnostic = ""
      try { await entry.read() }
      catch (error) { diagnostic = String(error) }
      expect(diagnostic).toContain(`Unable to parse ${entry.format}`)
      expect(diagnostic).toContain(path)
      expect(diagnostic).not.toContain(sentinel)
      expect(await readFile(path, "utf8")).toBe(entry.text)
    }
  })

// Real installers and CLI version probes are required; no substitute binaries.
// Minimal CI environments still run the pure and preflight tests above.
describe.skipIf(missingTools(process.env).length > 0)("real Herdr installer", () => {
  test("both CLI modes sanitize parser failures without changing files",
    async () => {
      const env = await environment()
      await installIntegrations(env)
      const codexPath = join(configDirectory(harnesses[0]!, env), "config.toml")
      const claudePath = join(configDirectory(harnesses[1]!, env), "settings.json")
      const originalToml = await readFile(codexPath, "utf8")
      const originalJson = await readFile(claudePath, "utf8")
      const sentinel = `secret_${crypto.randomUUID().replaceAll("-", "")}`
      for (const format of ["JSON", "TOML"]) {
        const path = format === "JSON" ? claudePath : codexPath
        await writeFile(claudePath, originalJson)
        await writeFile(codexPath, originalToml)
        await writeFile(path, format === "JSON"
          ? `{"env":{"TOKEN":${sentinel}}}`
          : `[features]\nhooks = true\n` +
            `[mcp_servers.private.env]\nTOKEN = "${sentinel}" trailing\n`)
        const before = await snapshot(env)
        for (const mode of ["--check", "--run"]) {
          const proc = Bun.spawn([process.execPath,
            join(import.meta.dir, "integrations.ts"), mode], {
            env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe",
          })
          const [stdout, stderr, code] = await Promise.all([
            new Response(proc.stdout).text(), new Response(proc.stderr).text(),
            proc.exited,
          ])
          expect(code).toBe(1)
          expect(stdout + stderr).toContain(`Unable to parse ${format}`)
          expect(stdout + stderr).toContain(path)
          expect(stdout + stderr).not.toContain(sentinel)
          expect(await snapshot(env)).toEqual(before)
        }
      }
    }, 60000)

  test("repair preserves unrelated settings and is repeatable/read-only", async () => {
    const env = await environment()
    for (const harness of harnesses) {
      const directory = configDirectory(harness, env)
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, harness.config), JSON.stringify({
        custom: "preserve me", hooks: { unrelated: [{ command: "true" }] },
      }))
    }
    await installIntegrations(env)
    expect(await checkIntegrations(env)).toEqual([])
    await applySettings({ runtimePath: join(configDirectory(harnesses[1]!, env),
      "settings.json"), quiet: true })
    await applyConfig({ runtimePath: join(configDirectory(harnesses[0]!, env),
      "config.toml"), mcpSourcePath: join(env.HOME!, "missing-mcp.json"),
      quiet: true })
    await applyCliConfig({ runtimePath: join(configDirectory(harnesses[2]!, env),
      "cli-config.json"), quiet: true })
    expect(await checkIntegrations(env)).toEqual([])
    const before = await snapshot(env)
    await checkIntegrations(env)
    expect(await snapshot(env)).toEqual(before)
    await installIntegrations(env)
    expect(await snapshot(env)).toEqual(before)
    for (const harness of harnesses) {
      const config = JSON.parse(await readFile(join(
        configDirectory(harness, env), harness.config), "utf8"))
      expect(config.custom).toBe("preserve me")
      expect(config.hooks.unrelated).toEqual([{ command: "true" }])
    }

    const codex = harnesses[0]!
    const codexDirectory = configDirectory(codex, env)
    await writeFile(join(codexDirectory, "hooks.json"), "{}")
    expect((await checkIntegrations(env)).join()).toContain("not correctly registered")
    await installIntegrations(env)
    const script = join(codexDirectory, codex.script)
    await writeFile(script, (await readFile(script, "utf8")) + "\nif\n")
    expect((await checkIntegrations(env)).join()).toContain("codex:")
    await installIntegrations(env)
    await writeFile(script, (await readFile(script, "utf8"))
      .replace(/HERDR_INTEGRATION_VERSION=\d+/, "HERDR_INTEGRATION_VERSION=0"))
    expect((await checkIntegrations(env)).join()).toContain("not current")
    await installIntegrations(env)
    await writeFile(join(codexDirectory, "config.toml"),
      '[features]\nhooks = false\n')
    expect((await checkIntegrations(env)).join()).toContain("must be enabled")
    await installIntegrations(env)
    expect(await checkIntegrations(env)).toEqual([])
  }, 60000)

  test("malformed configuration fails before writing other harnesses", async () => {
    const env = await environment()
    await installIntegrations(env)
    const claude = harnesses[1]!
    const path = join(configDirectory(claude, env), claude.config)
    await writeFile(path, "{broken")
    const before = await snapshot(env)
    expect((await checkIntegrations(env)).join()).toContain("claude:")
    await expect(installIntegrations(env)).rejects.toThrow()
    expect(await snapshot(env)).toEqual(before)
  }, 60000)
})
