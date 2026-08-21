import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "bun:test"

import {
  NVMRC_SET_ALLOW,
  NVMRC_SET_DENY,
  findNvmrcFiles,
  nvmrcSetDecision,
  parseLevel,
  readNvmrc,
  setNvmrcFiles,
} from "./nvmrc.ts"

const scriptPath = join(import.meta.dir, "nvmrc.ts")

const tempRoots: string[] = []

const makeRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "nvmrc-cli-"))
  tempRoots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

const writeNvmrc = async (
  filePath: string,
  pin: string,
): Promise<void> => {
  await mkdir(join(filePath, ".."), { recursive: true })
  await writeFile(filePath, `${pin}\n`)
}

const depthTree = async (root: string): Promise<{
  rootFile: string
  repo: string
  child: string
  deep: string
}> => {
  const rootFile = join(root, ".nvmrc")
  const repo = join(root, "repo", ".nvmrc")
  const child = join(root, "repo", "child", ".nvmrc")
  const deep = join(root, "repo", "child", "deep", ".nvmrc")
  await writeNvmrc(rootFile, "root-pin")
  await writeNvmrc(repo, "repo-pin")
  await writeNvmrc(child, "child-pin")
  await writeNvmrc(deep, "deep-pin")
  await writeNvmrc(
    join(root, "repo", "node_modules", ".nvmrc"),
    "hidden",
  )
  return { rootFile, repo, child, deep }
}

const runCli = async (
  args: string[],
): Promise<{
  exitCode: number
  stdout: string
  stderr: string
}> => {
  const proc = Bun.spawn(["bun", scriptPath, ...args], {
    cwd: import.meta.dir,
    stderr: "pipe",
    stdout: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

describe("nvmrc lists and set decisions", () => {
  test("exported allow and deny lists cover first-party and upstream", () => {
    expect(NVMRC_SET_ALLOW).toContain("nibi-chain")
    expect(NVMRC_SET_ALLOW).toContain("sai-perps")
    expect(NVMRC_SET_DENY).toContain("gmx-synthetics")
    expect(NVMRC_SET_DENY).toContain("nibi-z-archive")
    expect(nvmrcSetDecision("/ki/nibi-chain/.nvmrc")).toBe("allow")
    expect(nvmrcSetDecision("/ki/sai-web-docs/.nvmrc")).toBe("allow")
    expect(nvmrcSetDecision("/ki/metamask-core/.nvmrc")).toBe("deny")
    expect(nvmrcSetDecision("/ki/random-app/.nvmrc")).toBe(
      "not-allowlisted",
    )
    expect(nvmrcSetDecision("/ki/metamask-core/.nvmrc", true)).toBe(
      "allow",
    )
  })

  test("parseLevel rejects values below 1", () => {
    expect(parseLevel("3")).toBe(3)
    expect(() => parseLevel("0")).toThrow("-L must be an integer >= 1")
    expect(() => parseLevel("nope")).toThrow("-L must be an integer >= 1")
  })

  test("-L matches tree depth and skips node_modules", async () => {
    const root = await makeRoot()
    const files = await depthTree(root)

    expect(await findNvmrcFiles(root, 2)).toEqual([
      files.rootFile,
      files.repo,
    ])
    expect(await findNvmrcFiles(root, 3)).toEqual([
      files.rootFile,
      files.repo,
      files.child,
    ])
    expect(await findNvmrcFiles(root, 3)).not.toContain(files.deep)
  })

  test("list CLI prints path and pin", async () => {
    const root = await makeRoot()
    await writeNvmrc(join(root, "nibi-chain", ".nvmrc"), "lts/jod")

    const result = await runCli(["list", "--root", root, "-L", "2"])

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.stdout).toBe(
      `${join(root, "nibi-chain", ".nvmrc")}  lts/jod\n`,
    )
  })

  test("set without a version prints Usage and exits 1", async () => {
    const result = await runCli(["set"])

    expect(result.exitCode).toBe(1)
    expect(`${result.stdout}${result.stderr}`).toContain("Usage")
  })

  test("set writes allowlisted pins and skips deny-listed files", async () => {
    const root = await makeRoot()
    const allowed = join(root, "nibi-chain", ".nvmrc")
    const denied = join(root, "metamask-core", ".nvmrc")
    await writeNvmrc(allowed, "lts/jod")
    await writeNvmrc(denied, "v24.13")

    const result = await runCli([
      "set",
      "lts/krypton",
      "--root",
      root,
      "-L",
      "2",
    ])

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain(
      `${allowed}  lts/jod -> lts/krypton`,
    )
    expect(result.stdout).toContain(`skip  ${denied}  deny`)
    expect(await readNvmrc(allowed)).toBe("lts/krypton")
    expect(await readNvmrc(denied)).toBe("v24.13")
  })

  test("setNvmrcFiles dry-run does not write", async () => {
    const root = await makeRoot()
    const allowed = join(root, "sai-perps", ".nvmrc")
    await writeNvmrc(allowed, "lts/jod")

    const lines = await setNvmrcFiles({
      root,
      level: 2,
      version: "lts/krypton",
      dryRun: true,
    })

    expect(lines).toEqual([`${allowed}  lts/jod -> lts/krypton`])
    expect(await readNvmrc(allowed)).toBe("lts/jod")
  })
})
