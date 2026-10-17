import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { parse } from "smol-toml"

import { ASSETS, digest, normalizeVersion, quote, REPO, run } from "./install"

export async function candidateVersion(root = "."): Promise<string> {
  const manifest = parse(await readFile(join(root, "herdr/Cargo.toml"), "utf8"))
  const version = normalizeVersion(
    (manifest.package as { version: string }).version,
  )
  return validateTag(`herdr-ud/v${version}`, root)
}

export async function validateTag(tag: string, root = "."): Promise<string> {
  const version = normalizeVersion(tag)
  if (tag !== `herdr-ud/v${version}`)
    throw new Error("Tag must be herdr-ud/vX.Y.Z")
  const manifest = parse(await readFile(join(root, "herdr/Cargo.toml"), "utf8"))
  const lock = parse(await readFile(join(root, "herdr/Cargo.lock"), "utf8"))
  const packages = lock.package as Array<{
    name: string
    version: string
    source?: string
  }>
  const local = packages.filter((p) => p.name === "herdr" && !p.source)
  if (
    (manifest.package as { version: string }).version !== version ||
    local.length !== 1 ||
    local[0]!.version !== version
  ) {
    throw new Error("Tag must match Herdr Cargo.toml and Cargo.lock")
  }
  return version
}
export async function writeMetadata(
  dir: string,
  tag: string,
  commit: string,
  upstream: string,
): Promise<void> {
  const version = normalizeVersion(tag)
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Invalid source commit")
  const assets: Record<string, string> = {}
  for (const asset of ASSETS) assets[asset] = await digest(join(dir, asset))
  await writeFile(
    join(dir, "checksums.txt"),
    Object.entries(assets)
      .map(([name, hash]) => `${hash}  ${name}\n`)
      .join(""),
  )
  await writeFile(
    join(dir, "release-metadata.json"),
    JSON.stringify(
      {
        version,
        tag,
        commit,
        upstream,
        assets,
        targets: [
          "x86_64-unknown-linux-musl",
          "aarch64-unknown-linux-musl",
          "x86_64-apple-darwin",
          "aarch64-apple-darwin",
          "x86_64-pc-windows-msvc",
        ],
      },
      null,
      2,
    ) + "\n",
  )
  await writeFile(
    join(dir, "build-info.md"),
    `# Herdr UD ${version}\n\nTag: \`${tag}\`\n\nDotfiles commit: \`${commit}\`\n\n` +
      `Upstream base:\n\n${upstream}\n\nBuilt from the recorded vendored Rust source commit.\n`,
  )
}
export function requireUnpublished(release?: { draft: boolean }): void {
  if (release && !release.draft)
    throw new Error("Refusing to overwrite a published release")
}
export function draftReleaseId(
  releases: Array<{ id: number; tag_name: string; draft: boolean }>,
  tag: string,
): number {
  const release = releases.find((release) => release.tag_name === tag)
  if (!release) throw new Error("Uploaded draft release is missing")
  requireUnpublished(release)
  return release.id
}
export async function checkUploadedAssets(
  dir: string,
  assets: Array<{ name: string; digest?: string }>,
): Promise<void> {
  for (const file of [
    ...ASSETS,
    "checksums.txt",
    "release-metadata.json",
    "build-info.md",
  ]) {
    const remote = assets.find((asset) => asset.name === file)
    if (
      !remote ||
      remote.digest !== `sha256:${await digest(join(dir, file))}`
    ) {
      throw new Error(`Missing or mismatched uploaded asset: ${file}`)
    }
  }
}
export async function publish(dir: string, tag: string): Promise<void> {
  const args = `${quote(tag)} --repo ${REPO}`
  // gh API distinguishes a missing release from authentication/network errors.
  const releases = JSON.parse(
    await run(`gh api repos/${REPO}/releases --paginate --slurp`),
  ).flat() as Array<{ id: number; tag_name: string; draft: boolean }>
  const existing = releases.find((r) => r.tag_name === tag)
  requireUnpublished(existing)
  if (!existing)
    await run(
      `gh release create ${args} --verify-tag --draft ` +
        `--title ${quote(tag)} --notes-file ${quote(join(dir, "build-info.md"))}`,
    )
  const files = [
    ...ASSETS,
    "checksums.txt",
    "release-metadata.json",
    "build-info.md",
  ]
  await run(
    `gh release upload ${args} --clobber ${files.map((f) => quote(join(dir, f))).join(" ")}`,
  )
  // Drafts are discoverable in the release list, not by the public tag API.
  const updated = JSON.parse(
    await run(`gh api repos/${REPO}/releases --paginate --slurp`),
  ).flat() as Array<{ id: number; tag_name: string; draft: boolean }>
  const releaseId = draftReleaseId(updated, tag)
  const remote = JSON.parse(
    await run(`gh api repos/${REPO}/releases/${releaseId}`),
  )
  await checkUploadedAssets(dir, remote.assets)
  await run(`gh release edit ${args} --draft=false --latest=false`)
}
if (import.meta.main) {
  const [command, tag, dir = "release-assets"] = process.argv.slice(2)
  ;(async () => {
    if (command === "validate") {
      console.log(tag ? await validateTag(tag) : await candidateVersion())
      return
    }
    if (command !== "prepare" && command !== "publish")
      throw new Error("Expected validate, prepare, or publish")
    if (!tag) throw new Error("Expected a release tag")
    await validateTag(tag)
    const commit = await run("git rev-parse HEAD")
    const upstream = await readFile("herdr/UPSTREAM.md", "utf8")
    await writeMetadata(
      dir,
      tag,
      commit,
      upstream.split("## Local changes")[0]!.trim(),
    )
    if (command === "publish") await publish(dir, tag)
  })().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
