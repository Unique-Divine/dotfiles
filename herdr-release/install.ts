import { createHash } from "node:crypto"
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
} from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { bash } from "@uniquedivine/bash"

export const REPO = "Unique-Divine/dotfiles"
export const ASSETS = [
  "herdr-linux-x86_64",
  "herdr-linux-aarch64",
  "herdr-macos-x86_64",
  "herdr-macos-aarch64",
  "herdr-windows-x86_64.zip",
]
export interface Metadata {
  version: string
  tag: string
  commit: string
  assets: Record<string, string>
}
export const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
export async function run(command: string): Promise<string> {
  const result = await bash(command)
  if (result.exitCode !== 0)
    throw new Error(result.stderr || result.stdout || command)
  return result.stdout.trim()
}
export function normalizeVersion(input: string): string {
  const version = input.replace(/^herdr-ud\//, "").replace(/^v/, "")
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error("Expected X.Y.Z, vX.Y.Z, or herdr-ud/vX.Y.Z")
  }
  return version
}
export function platformAsset(
  platform = process.platform,
  arch = process.arch,
): string {
  const os =
    platform === "linux" ? "linux" : platform === "darwin" ? "macos" : undefined
  const cpu =
    arch === "x64" ? "x86_64" : arch === "arm64" ? "aarch64" : undefined
  if (!os || !cpu)
    throw new Error(`Unsupported installation platform: ${platform}/${arch}`)
  return `herdr-${os}-${cpu}`
}
export function parseArgs(args: string[]): {
  mode: "source" | "get" | "install"
  version?: string
} {
  if (!args.length) return { mode: "source" }
  if (args.length !== 2 || !["--ver", "--get"].includes(args[0]!)) {
    throw new Error(
      "Usage: just herdr-install [--ver VERSION|source | --get VERSION]",
    )
  }
  if (args[0] === "--ver" && args[1] === "source") return { mode: "source" }
  return {
    mode: args[0] === "--get" ? "get" : "install",
    version: normalizeVersion(args[1]!),
  }
}
export async function digest(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex")
}
export async function verify(
  dir: string,
  version: string,
  asset: string,
): Promise<Metadata> {
  const metadata: Metadata = JSON.parse(
    await readFile(join(dir, "release-metadata.json"), "utf8"),
  )
  if (
    metadata.version !== version ||
    metadata.tag !== `herdr-ud/v${version}` ||
    !/^[a-f0-9]{40}$/.test(metadata.commit)
  )
    throw new Error("Release metadata mismatch")
  const hash = metadata.assets[asset]
  if (!hash || !/^[a-f0-9]{64}$/.test(hash))
    throw new Error("Missing asset checksum")
  const checksums = (await readFile(join(dir, "checksums.txt"), "utf8")).split(
    "\n",
  )
  if (checksums.filter((line) => line === `${hash}  ${asset}`).length !== 1) {
    throw new Error("Checksum manifest mismatch")
  }
  if ((await digest(join(dir, asset))) !== hash)
    throw new Error("Asset checksum mismatch")
  return metadata
}
export type Download = (
  tag: string,
  asset: string,
  dir: string,
) => Promise<void>
export const githubDownload: Download = async (tag, asset, dir) => {
  let authenticated = false
  try {
    await run("gh auth status >/dev/null 2>&1")
    authenticated = true
  } catch {
    /* Public releases can be downloaded without authentication. */
  }
  if (authenticated) {
    await run(
      `gh release download ${quote(tag)} --repo ${REPO} --dir ${quote(dir)} ` +
        `--pattern ${quote(asset)} --pattern checksums.txt --pattern release-metadata.json`,
    )
    return
  }
  await downloadPublicRelease(
    `https://api.github.com/repos/${REPO}`,
    tag,
    asset,
    dir,
  )
}
export async function downloadPublicRelease(
  apiRoot: string,
  tag: string,
  asset: string,
  dir: string,
): Promise<void> {
  const response = await fetch(
    `${apiRoot}/releases/tags/${encodeURIComponent(tag)}`,
    { signal: AbortSignal.timeout(60_000) },
  )
  if (!response.ok)
    throw new Error(
      `GitHub release lookup failed: HTTP ${response.status}. For private releases, run gh auth login.`,
    )
  const release = (await response.json()) as {
    assets: Array<{ name: string; browser_download_url: string }>
  }
  for (const name of [asset, "checksums.txt", "release-metadata.json"]) {
    const remote = release.assets.find((file) => file.name === name)
    if (!remote) throw new Error(`Missing release asset: ${name}`)
    const response = await fetch(remote.browser_download_url, {
      signal: AbortSignal.timeout(60_000),
    })
    if (!response.ok)
      throw new Error(`Download failed: HTTP ${response.status}`)
    await Bun.write(join(dir, name), response)
  }
}
export async function getRelease(
  version: string,
  asset: string,
  cacheRoot: string,
  download: Download = githubDownload,
): Promise<string> {
  version = normalizeVersion(version)
  if (!ASSETS.includes(asset)) throw new Error("Unsupported release asset")
  const dir = join(cacheRoot, version, asset)
  try {
    await verify(dir, version, asset)
    await chmod(join(dir, asset), 0o755)
    return join(dir, asset)
  } catch {
    /* Incomplete or damaged cache requires a verified download. */
  }
  await mkdir(dirname(dir), { recursive: true })
  const staging = await mkdtemp(join(dirname(dir), ".download-"))
  try {
    await download(`herdr-ud/v${version}`, asset, staging)
    await verify(staging, version, asset)
    await chmod(join(staging, asset), 0o755)
    // Keep verified cache entries immutable; competing downloads are equivalent.
    try {
      await rename(staging, dir)
    } catch {
      try {
        await verify(dir, version, asset)
      } catch {
        await rm(dir, { recursive: true, force: true })
        await rename(staging, dir)
      }
    }
    return join(dir, asset)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}
export async function installRelease(
  binary: string,
  destination: string,
  version: string,
): Promise<void> {
  await mkdir(dirname(destination), { recursive: true })
  const staging = await mkdtemp(join(dirname(destination), ".herdr-install-"))
  const candidate = join(staging, "herdr")
  try {
    await copyFile(binary, candidate)
    await chmod(candidate, 0o755)
    const identity = await run(`${quote(candidate)} --version`)
    if (identity !== `herdr ${version}`)
      throw new Error(`Unexpected binary version: ${identity}`)
    await rename(candidate, destination)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}
export async function main(args: string[]): Promise<void> {
  const options = parseArgs(args)
  if (options.mode === "source") {
    const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..")
    await run(
      `just --justfile ${quote(join(repo, "justfile"))} herdr-install-source`,
    )
    return
  }
  const version = options.version!
  const cacheRoot = join(
    process.env.XDG_CACHE_HOME || join(homedir(), ".cache"),
    "herdr-ud",
  )
  const binary = await getRelease(version, platformAsset(), cacheRoot)
  if (options.mode === "get") {
    console.log(binary)
    return
  }
  const destination = join(homedir(), ".local", "bin", "herdr")
  await installRelease(binary, destination, version)
  console.log(
    `Installed ${destination}. Existing Herdr sessions keep their running binary.`,
  )
  const pathBinary = await run("command -v herdr || true")
  if (pathBinary && resolve(pathBinary) !== resolve(destination)) {
    console.warn(`PATH selects ${pathBinary} before ${destination}`)
  }
}
if (import.meta.main) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
