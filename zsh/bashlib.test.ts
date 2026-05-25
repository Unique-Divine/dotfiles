import { bash } from "@uniquedivine/bash"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"

const bashlibPath = join(import.meta.dir, "bashlib.sh")
const testRoot = "/tmp/bashlib"
const procVersionPath = join(testRoot, "proc_version")

const runIsWsl = async (
  env: Record<string, string | undefined> = {},
): Promise<{
  exitCode: number
  stderr: string
  stdout: string
}> => {
  const envPrefix = Object.entries(env)
    .map(([key, value]) => {
      if (value === undefined) {
        return `unset ${key};`
      }
      return `export ${key}=${JSON.stringify(value)};`
    })
    .join(" ")

  return await bash(
    `${envPrefix} source ${JSON.stringify(bashlibPath)}; is_wsl`,
  )
}

describe("is_wsl", () => {
  beforeAll(async () => {
    await mkdir(testRoot, { recursive: true })
  })

  afterAll(async () => {
    await rm(testRoot, { recursive: true, force: true })
  })

  test("detects WSL from WSL_DISTRO_NAME", async () => {
    const out = await runIsWsl({
      WSL_DISTRO_NAME: "Ubuntu-24.04",
      PROC_VERSION: procVersionPath,
    })

    expect(out).toMatchObject({
      exitCode: 0,
      stderr: "",
      stdout: "WSL_DISTRO_NAME=Ubuntu-24.04\n",
    })
  })

  test("detects WSL from a proc version marker", async () => {
    await writeFile(
      procVersionPath,
      "Linux version 5.15.167.4-microsoft-standard-WSL2\n",
    )

    const out = await runIsWsl({
      WSL_DISTRO_NAME: "",
      PROC_VERSION: procVersionPath,
    })

    expect(out).toMatchObject({
      exitCode: 0,
      stderr: "",
      stdout: `${procVersionPath} WSL marker=microsoft-standard-WSL2\n`,
    })
  })

  test("returns nonzero outside WSL", async () => {
    await writeFile(procVersionPath, "Linux version 6.8.0-generic\n")

    const out = await runIsWsl({
      WSL_DISTRO_NAME: "",
      PROC_VERSION: procVersionPath,
    })

    expect(out.exitCode).toBe(1)
    expect(out.stderr).toBe("")
    expect(out.stdout).toContain("not WSL: { uname -s:")
  })
})
