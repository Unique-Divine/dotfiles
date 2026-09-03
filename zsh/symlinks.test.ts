import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, realpath, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { bash } from "@uniquedivine/bash"

type ManagedLink = {
  destinationRelative: string
  sourceRelative: string
}

const dotfilesRoot = resolve(import.meta.dir, "..")
const manifestPath = join(dotfilesRoot, "zsh", "managed-links.tsv")
const temporaryHomes: string[] = []

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`

const readManagedLinks = async (): Promise<ManagedLink[]> => {
  const manifest = await readFile(manifestPath, "utf8")
  return manifest
    .split("\n")
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const [sourceRelative, destinationRelative] = line.split("\t")
      if (!sourceRelative || !destinationRelative) {
        throw new Error(`Invalid managed-links entry: ${line}`)
      }
      return { destinationRelative, sourceRelative }
    })
}

const runSync = async (home: string) => {
  const scriptPath = join(dotfilesRoot, "symlinks.sh")
  const output = await bash(
    `DOTFILES=${shellQuote(dotfilesRoot)} HOME=${shellQuote(home)} bash ${shellQuote(scriptPath)}`,
  )
  expect(output.exitCode).toBe(0)
  expect(output.stderr).toBeEmpty()
}

const expectManagedLinks = async (home: string, links: ManagedLink[]) => {
  for (const link of links) {
    const destination = join(home, link.destinationRelative)
    const source = join(dotfilesRoot, link.sourceRelative)
    expect(await realpath(destination)).toBe(await realpath(source))
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryHomes
      .splice(0)
      .map((home) => rm(home, { force: true, recursive: true })),
  )
})

describe("symlinks.sh", () => {
  test("creates, preserves, and repairs every managed link", async () => {
    const home = await mkdtemp(join(tmpdir(), "dotfiles-links-"))
    temporaryHomes.push(home)
    const links = await readManagedLinks()

    await runSync(home)
    await expectManagedLinks(home, links)

    await runSync(home)
    await expectManagedLinks(home, links)

    const repairedLink = links.at(0)
    if (!repairedLink) throw new Error("Managed-links manifest is empty")

    const destination = join(home, repairedLink.destinationRelative)
    const wrongTarget = join(home, "wrong-target")
    await rm(destination, { force: true })
    await symlink(wrongTarget, destination)

    await runSync(home)
    await expectManagedLinks(home, links)
  })
})
