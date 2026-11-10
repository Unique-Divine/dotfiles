import { afterEach, describe, expect, test } from "bun:test"
import {
  lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { bash } from "@uniquedivine/bash"

type ManagedLink = {
  destinationRelative: string
  sourceRelative: string
}

const dotfilesRoot = resolve(import.meta.dir, "..")
const manifestPath = join(dotfilesRoot, "zsh", "managed-links.txt")
const temporaryHomes: string[] = []

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`

const readManagedLinks = async (): Promise<ManagedLink[]> => {
  const manifest = await readFile(manifestPath, "utf8")
  return manifest
    .split("\n")
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const [sourceRelative, destinationRelative] = line.split(" ")
      if (!/^[^\s]+ [^\s]+$/.test(line)) {
        throw new Error(`Invalid managed-links entry: ${line}`)
      }
      return { destinationRelative, sourceRelative }
    })
}

const runSync = async (home: string): Promise<string> => {
  const scriptPath = join(dotfilesRoot, "symlinks.sh")
  const output = await bash(
    `DOTFILES=${shellQuote(dotfilesRoot)} HOME=${shellQuote(home)} bash ${shellQuote(scriptPath)}`,
  )
  expect(output.exitCode).toBe(0)
  expect(output.stderr).toBeEmpty()
  return output.stdout
}

const newHome = async (): Promise<string> => {
  const home = await mkdtemp(join(tmpdir(), "dotfiles-links-"))
  temporaryHomes.push(home)
  return home
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

    await expect(
      lstat(join(dotfilesRoot, "cursor", "hooks", "hooks")),
    ).rejects.toMatchObject({ code: "ENOENT" })

    const repairedLink = links.at(0)
    if (!repairedLink) throw new Error("Managed-links manifest is empty")

    const destination = join(home, repairedLink.destinationRelative)
    const wrongTarget = join(home, "wrong-target")
    await rm(destination, { force: true })
    await symlink(wrongTarget, destination)

    await runSync(home)
    await expectManagedLinks(home, links)
  })

  describe("retires the old ud-runs plugin link", () => {
    const relative = join(".local", "share", "ud", "plugins", "ud-runs")
    const placeAt = async (home: string): Promise<string> => {
      const path = join(home, relative)
      await mkdir(join(path, ".."), { recursive: true })
      return path
    }

    test("removes a link that resolves to runlog/cli.ts", async () => {
      const home = await newHome()
      const path = await placeAt(home)
      await symlink(join(dotfilesRoot, "runlog", "cli.ts"), path)

      const stdout = await runSync(home)
      await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" })
      expect(stdout).toContain(`removed retired link: ${path}`)

      expect(await runSync(home)).not.toContain("removed retired link")
    })

    test("keeps a link that points elsewhere", async () => {
      const home = await newHome()
      const path = await placeAt(home)
      const other = join(home, "my-runs")
      await writeFile(other, "#!/bin/sh\n")
      await symlink(other, path)

      expect(await runSync(home)).not.toContain("removed retired link")
      expect(await readlink(path)).toBe(other)
    })

    test("keeps a regular file", async () => {
      const home = await newHome()
      const path = await placeAt(home)
      await writeFile(path, "mine\n")

      expect(await runSync(home)).not.toContain("removed retired link")
      expect(await readFile(path, "utf8")).toBe("mine\n")
    })
  })
})
