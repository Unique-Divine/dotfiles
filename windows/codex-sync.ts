import { createHash } from "node:crypto"
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"
import { Command } from "commander"
import { parse, stringify, type TomlTable } from "smol-toml"

type Files = Map<string, Buffer>
type Definitions = Record<string, TomlTable>
interface SkillPlan { name: string; files: Files; previous?: string }
export interface Bridge {
  distro: string
  user: string
  bun: string
  launcher: string
  config: string
  path: string
}

const managedGroup = "wsl-synced"
const manifestName = ".dotfiles-skill-hashes.json"
const home = homedir()
const safeName = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

// Exact endpoints intentionally exclude URLs that can carry credentials in a
// path, query, or userinfo. Other remote servers can be set up in Windows.
const directEndpoints: Record<string, string> = {
  openaiDeveloperDocs: "https://developers.openai.com/mcp",
  "superhuman-mail": "https://mcp.mail.superhuman.com/mcp",
}
const credentialFiles = /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.pypirc|auth\.json|(?:credentials?|secrets?|tokens?)\.(?:json|toml|ya?ml)|id_(?:rsa|ed25519)|(?:.*\.)?(?:pem|pfx|p12|key|session))$/i
const ignoredDirectories = new Set([
  ".git", ".cache", ".pytest_cache", ".ruff_cache", ".ssh", ".venv",
  "__pycache__", "node_modules", "target",
])

async function fileType(path: string) {
  return lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
}

async function regularDirectory(path: string): Promise<boolean> {
  const stat = await fileType(path)
  if (!stat) return false
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error(`Expected a regular directory at ${path}`)
  return true
}

export async function readSkill(path: string, source: boolean): Promise<Files> {
  const files: Files = new Map()
  async function walk(directory: string, prefix: string) {
    const names = await readdir(directory, { withFileTypes: true })
    const windowsNames = new Set<string>()
    for (const entry of names.sort((a, b) => a.name.localeCompare(b.name))) {
      if (source && (credentialFiles.test(entry.name) ||
        ignoredDirectories.has(entry.name.toLowerCase()))) continue
      const folded = entry.name.toLowerCase()
      if (windowsNames.has(folded) || /[<>:"/\\|?*\x00-\x1f]|[ .]$/.test(entry.name)
        || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(entry.name))
        throw new Error(`Unsupported Windows filename in ${basename(path)}`)
      windowsNames.add(folded)
      const relative = prefix + entry.name
      const absolute = join(directory, entry.name)
      if (entry.isDirectory()) {
        await walk(absolute, relative + "/")
      } else if (entry.isFile()) {
        files.set(relative, await readFile(absolute))
      } else {
        throw new Error(`Non-regular file in ${basename(path)}`)
      }
    }
  }
  await walk(path, "")
  return files
}

function digest(files: Files) {
  const hash = createHash("sha256")
  for (const [name, body] of files) {
    hash.update(JSON.stringify([name, body.length])).update(body)
  }
  return hash.digest("hex")
}

async function readManifest(path: string): Promise<Record<string, string>> {
  const stat = await fileType(path)
  if (!stat) return {}
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Invalid skill manifest")
  const manifest: unknown = JSON.parse(await readFile(path, "utf8"))
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest) ||
    Object.entries(manifest).some(([name, value]) => !safeName.test(name) ||
      typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value))) {
    throw new Error("Invalid skill manifest")
  }
  return manifest as Record<string, string>
}

export async function syncSkills(source: string, roots: string[], apply: boolean) {
  const targetRoot = roots[0]!
  const managed = join(targetRoot, managedGroup)
  const manifestPath = join(managed, manifestName)
  if (await regularDirectory(dirname(targetRoot))) await regularDirectory(targetRoot)
  const managedExists = await regularDirectory(managed)
  const manifest = await readManifest(manifestPath)
  const occupied = new Set<string>()
  for (const root of new Set(roots)) {
    if (!await regularDirectory(root)) continue
    for (const name of await readdir(root)) {
      if (root !== targetRoot || name !== managedGroup) occupied.add(name.toLowerCase())
    }
  }
  const existing = new Map((managedExists ? await readdir(managed) : [])
    .map((name) => [name.toLowerCase(), name]))
  const plans: SkillPlan[] = []
  const lines: string[] = []
  let current = 0
  for (const name of (await readdir(source)).sort()) {
    if (!safeName.test(name)) continue
    if (occupied.has(name.toLowerCase())) {
      lines.push(`skill ${name}: kept Windows copy`)
      continue
    }
    try {
      const origin = await realpath(join(source, name))
      const skill = await fileType(join(origin, "SKILL.md"))
      if (!skill?.isFile() || skill.isSymbolicLink()) continue
      const files = await readSkill(origin, true)
      const installed = existing.get(name.toLowerCase())
      if (installed) {
        if (installed !== name || !Object.hasOwn(manifest, name) ||
          !await regularDirectory(join(managed, name)) ||
          digest(await readSkill(join(managed, name), false)) !== manifest[name]) {
          lines.push(`skill ${name}: kept changed or unmanaged Windows copy`)
          continue
        }
        if (digest(files) === manifest[name]) {
          current++
          continue
        }
      }
      plans.push({ name, files, previous: installed ? manifest[name] : undefined })
      lines.push(`skill ${name}: ${installed ? "update" : "add"}`)
    } catch {
      lines.push(`skill ${name}: skipped unreadable or non-portable files`)
    }
  }
  if (apply && plans.length) {
    await mkdir(managed, { recursive: true })
    for (const { name, files, previous } of plans) {
      const target = join(managed, name)
      // Stage beside the target so NTFS renames never cross a volume.
      const staging = join(managed, `.${name}.${crypto.randomUUID()}`)
      const backup = staging + ".previous"
      await mkdir(staging)
      try {
        for (const [relative, body] of files) {
          const path = join(staging, relative)
          await mkdir(dirname(path), { recursive: true })
          await writeFile(path, body, { mode: 0o600, flag: "wx" })
        }
        if (previous) {
          if (!await regularDirectory(target) ||
            digest(await readSkill(target, false)) !== previous)
            throw new Error(`Windows skill ${name} changed during sync`)
          await rename(target, backup)
        } else if (await fileType(target)) {
          throw new Error(`Windows skill ${name} appeared during sync`)
        }
        try {
          await rename(staging, target)
          await replaceFile(manifestPath, JSON.stringify({
            ...manifest, [name]: digest(files),
          }) + "\n")
          manifest[name] = digest(files)
        } catch (error) {
          if (await fileType(target) && !await fileType(staging))
            await rename(target, staging)
          if (previous) await rename(backup, target)
          throw error
        }
        if (previous) await rm(backup, { recursive: true })
      } finally {
        await rm(staging, { recursive: true, force: true })
      }
    }
  }
  return [...lines, `Skills: ${plans.length} additions or updates, ${current} current.`]
}

async function replaceFile(path: string, text: string) {
  const temp = path + "." + crypto.randomUUID() + ".tmp"
  try {
    await writeFile(temp, text, { mode: 0o600, flag: "wx" })
    await rename(temp, path)
  } finally {
    await rm(temp, { force: true })
  }
}

function table(value: unknown): TomlTable {
  if (typeof value !== "object" || !value || Array.isArray(value))
    throw new Error("Expected a TOML table")
  return value as TomlTable
}

function readToml(text: string, label: string) {
  try { return table(parse(text.replace(/^\uFEFF/, ""))) }
  catch { throw new Error(`Unable to parse ${label} Codex configuration`) }
}

export function planMcp(source: string, destination: string, selected: Set<string>, bridge?: Bridge) {
  const from = table(readToml(source, "WSL").mcp_servers ?? {})
  const existing = table(readToml(destination, "Windows").mcp_servers ?? {})
  const additions: Definitions = Object.create(null)
  const lines: string[] = []
  for (const [name, value] of Object.entries(from)) {
    if (!safeName.test(name)) continue
    if (Object.hasOwn(existing, name)) {
      lines.push(`MCP ${name}: kept Windows entry`)
      continue
    }
    const server = table(value)
    if (server.enabled === false) {
      lines.push(`MCP ${name}: skipped disabled entry`)
    } else if (server.url === directEndpoints[name] &&
      Object.keys(server).every((key) => key === "url" || key === "enabled") &&
      typeof server.url === "string") {
      additions[name] = { url: server.url }
      lines.push(`MCP ${name}: add native HTTP entry`)
    } else if (bridge && selected.has(name) && typeof server.command === "string") {
      additions[name] = {
        command: "wsl.exe",
        args: ["--distribution", bridge.distro, "--user", bridge.user,
          "--exec", "/usr/bin/env", `PATH=${bridge.path}`, bridge.bun,
          bridge.launcher, "--source", bridge.config, name],
      }
      lines.push(`MCP ${name}: add opt-in WSL bridge`)
    } else {
      lines.push(`MCP ${name}: skipped platform-specific or credential-bearing entry`)
    }
  }
  if (!Object.keys(additions).length) return { lines, next: destination }
  // Preserve all native comments, tables, and entries byte-for-byte.
  // In particular, avoid expanding the native node_repl definition.
  const next = destination + "\n" + stringify({ mcp_servers: additions }) + "\n"
  readToml(next, "merged Windows")
  return { lines, next }
}

function run(args: string[]): string {
  const result = Bun.spawnSync(args, { cwd: "/mnt/c", stderr: "ignore" })
  if (result.exitCode !== 0) throw new Error(`Failed to run ${basename(args[0]!)}`)
  return result.stdout.toString().trim()
}

function windowsPaths() {
  const discovered = run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", `
    $p=[Environment]::GetEnvironmentVariable('CODEX_HOME','User')
    if (!$p) {$p=$env:CODEX_HOME}
    if (!$p) {$p=Join-Path $env:USERPROFILE '.codex'}
    [Console]::WriteLine($env:USERPROFILE)
    [Console]::WriteLine($p)
  `]).split(/\r?\n/)
  if (discovered.length !== 2) throw new Error("Unable to discover Windows Codex paths")
  return discovered.map((path) => run(["wslpath", "-u", path])) as [string, string]
}

async function readConfig(path: string, required: boolean) {
  const stat = await fileType(path)
  if (!stat && !required) return ""
  if (!stat?.isFile() || stat.isSymbolicLink())
    throw new Error(`Expected a regular config file at ${path}`)
  return readFile(path, "utf8")
}

interface Options {
  apply?: boolean
  installTimer?: boolean
  sourceConfig?: string
  windowsHome?: string
  windowsCodexHome?: string
  wslServers: string[]
}

function unitArgument(value: string) {
  if (/[\r\n]/.test(value)) throw new Error("Unsupported newline in timer path")
  return '"' + value.replace(/[\\"]/g, "\\$&").replace(/%/g, "%%").replace(/\$/g, "$$$$") + '"'
}

async function installTimer(windowsHome: string, codexHome: string, sourceConfig: string) {
  const units = join(home, ".config/systemd/user")
  const installed = join(home, ".local/share/dotfiles/windows-codex-sync")
  const installedScript = join(installed, "codex-sync.js")
  const bun = join(home, ".bun/bin/bun")
  const executable = await fileType(bun) ? bun : await realpath(process.execPath)
  const unit = "dotfiles-windows-codex-sync"
  const result = await Bun.build({ entrypoints: [import.meta.path], target: "bun" })
  if (!result.success || !result.outputs[0]) throw new Error("Could not build the sync program")
  await mkdir(units, { recursive: true })
  await mkdir(installed, { mode: 0o700, recursive: true })
  await replaceFile(installedScript, await result.outputs[0].text())
  const command = [executable, installedScript, "--apply", "--windows-home", windowsHome,
    "--windows-codex-home", codexHome, "--source-config", sourceConfig].map(unitArgument)
  await replaceFile(join(units, unit + ".service"), [
    "# Managed by just windows-codex-sync --install-timer",
    "[Unit]",
    "Description=Copy WSL skills and portable MCP entries to Windows Codex",
    "",
    "[Service]",
    "Type=oneshot",
    "ExecStart=" + command.join(" "),
    "",
  ].join("\n"))
  await replaceFile(join(units, unit + ".timer"), [
    "# Managed by just windows-codex-sync --install-timer",
    "[Unit]",
    "Description=Refresh Windows Codex configuration every six hours",
    "",
    "[Timer]",
    "OnCalendar=*-*-* 00/6:00:00",
    "Persistent=true",
    "",
    "[Install]",
    "WantedBy=timers.target",
    "",
  ].join("\n"))
  for (const args of [["daemon-reload"], ["enable", "--now", unit + ".timer"],
    ["start", unit + ".service"]]) {
    const status = Bun.spawnSync(["systemctl", "--user", ...args], { stderr: "inherit" })
    if (status.exitCode !== 0) throw new Error(`Could not run systemctl --user ${args[0]}`)
  }
  console.log(`Installed ${unit}.timer and ran its first sync.`)
}

async function main(options: Options) {
  if (Boolean(options.windowsHome) !== Boolean(options.windowsCodexHome))
    throw new Error("Specify both Windows home paths together")
  const windows = options.windowsHome && options.windowsCodexHome
    ? [options.windowsHome, options.windowsCodexHome] : windowsPaths()
  const [windowsHome, windowsCodexHome] = windows as [string, string]
  if (![windowsHome, windowsCodexHome].every(isAbsolute) ||
    !await regularDirectory(windowsHome) || !await regularDirectory(windowsCodexHome))
    throw new Error("Windows profile and Codex home must be existing absolute paths")

  const sourcePath = options.sourceConfig ? resolve(options.sourceConfig) :
    resolve(process.env.CODEX_HOME ?? join(home, ".codex"), "config.toml")
  if (options.installTimer) {
    if (options.apply || options.wslServers.length)
      throw new Error("Install the timer separately from manual sync or WSL bridge setup")
    return installTimer(windowsHome, windowsCodexHome, sourcePath)
  }
  const configPath = join(windowsCodexHome, "config.toml")
  const [source, destination] = await Promise.all([
    readConfig(sourcePath, true), readConfig(configPath, false),
  ])
  const selected = new Set(options.wslServers.flatMap((name) => name.split(",")))
  let bridge: Bridge | undefined
  if (selected.size) {
    const distro = process.env.WSL_DISTRO_NAME
    const user = process.env.USER
    if (!distro || !user) throw new Error("Run bridge setup inside WSL")
    const root = join(home, "boku/dotfiles")
    const launcher = join(root, "claude/mcp-launch.ts")
    if (!await fileType(launcher)) throw new Error("Stable dotfiles MCP launcher is missing")
    bridge = {
      distro, user, bun: await realpath(process.execPath), launcher, config: sourcePath,
      path: (process.env.PATH ?? "").split(":")
        .filter((part) => part.startsWith("/") && !part.startsWith("/mnt/")).join(":"),
    }
  }
  const mcp = planMcp(source, destination, selected, bridge)
  const skills = await syncSkills(join(home, ".agents/skills"), [
    join(windowsHome, ".agents/skills"), join(windowsCodexHome, "skills"),
  ], options.apply ?? false)
  if (options.apply && mcp.next !== destination) {
    if (await readConfig(configPath, false) !== destination)
      throw new Error("Windows Codex configuration changed during sync")
    await replaceFile(configPath, mcp.next)
  }
  console.log([...skills, ...mcp.lines].join("\n"))
}

async function runSync(options: Options) {
  const lockFlag = "DOTFILES_WINDOWS_CODEX_SYNC_LOCKED"
  if (!options.apply || process.env[lockFlag] === "1") return main(options)
  const state = join(home, ".local/state/dotfiles")
  await mkdir(state, { mode: 0o700, recursive: true })
  const child = Bun.spawn(["flock", "--exclusive", join(state, "windows-codex-sync.lock"),
    process.execPath, import.meta.path, ...Bun.argv.slice(2)], {
    env: { ...process.env, [lockFlag]: "1" },
    stdout: "inherit",
    stderr: "inherit",
  })
  process.exitCode = await child.exited
}

if (import.meta.main) {
  const program = new Command()
    .description("Preview WSL skill and portable MCP sync to native Windows Codex.")
    .option("--apply", "write the Windows copies")
    .option("--install-timer", "install and run a six-hour WSL user systemd timer")
    .option("--source-config <path>", "WSL Codex config or exported MCP TOML")
    .option("--windows-home <path>", "Windows user profile as a WSL mount path")
    .option("--windows-codex-home <path>", "Windows Codex home as a WSL mount path")
    .option("--wsl-servers <names...>", "explicitly bridge named local MCP servers", [])
  try {
    program.parse(Bun.argv)
    await runSync(program.opts<Options>())
  } catch (error) {
    const message = error instanceof Error ? error.message : "unexpected failure"
    console.error(`windows-codex-sync: ${message.replace(/[\r\n].*$/s, "")}`)
    process.exitCode = 1
  }
}
