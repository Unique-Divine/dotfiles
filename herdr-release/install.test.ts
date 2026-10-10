import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  ASSETS,
  getRelease,
  installRelease,
  normalizeVersion,
  parseArgs,
  platformAsset,
  verify,
} from "./install"
import { validateTag, writeMetadata } from "./publish"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  )
})
async function temp() {
  const p = await mkdtemp(join(tmpdir(), "herdr-test-"))
  roots.push(p)
  return p
}
const asset = "herdr-linux-x86_64"
const binary =
  '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "herdr 0.9.4"; fi\n'
function fixture() {
  const hash = createHash("sha256").update(binary).digest("hex")
  return {
    [asset]: binary,
    "checksums.txt": `${hash}  ${asset}\n`,
    "release-metadata.json": JSON.stringify({
      version: "0.9.4",
      tag: "herdr-ud/v0.9.4",
      commit: "a".repeat(40),
      assets: { [asset]: hash },
    }),
  }
}
async function server(files: Record<string, string>) {
  let requests = 0
  const http = Bun.serve({
    port: 0,
    fetch(request) {
      requests++
      const content = files[new URL(request.url).pathname.slice(1)]
      return new Response(content ?? "missing", {
        status: content === undefined ? 404 : 200,
      })
    },
  })
  const download = async (_tag: string, _asset: string, dir: string) => {
    for (const name of [asset, "checksums.txt", "release-metadata.json"]) {
      const response = await fetch(new URL(name, http.url))
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      await writeFile(
        join(dir, name),
        new Uint8Array(await response.arrayBuffer()),
      )
    }
  }
  return { http, download, requests: () => requests }
}
test("versions, flags and source compatibility", () => {
  for (const v of ["0.9.4", "v0.9.4", "herdr-ud/v0.9.4"])
    expect(normalizeVersion(v)).toBe("0.9.4")
  expect(parseArgs([])).toEqual({ mode: "source" })
  expect(parseArgs(["--ver", "source"])).toEqual({ mode: "source" })
  expect(parseArgs(["--get", "v0.9.4"])).toEqual({
    mode: "get",
    version: "0.9.4",
  })
  expect(parseArgs(["--ver", "0.9.4"])).toEqual({
    mode: "install",
    version: "0.9.4",
  })
  for (const args of [
    ["--get"],
    ["--get", "source"],
    ["--ver", "0.9.4", "--get", "0.9.4"],
    ["--ver", "../0.9.4"],
  ])
    expect(() => parseArgs(args)).toThrow()
})
test("platform selection", () => {
  for (const os of ["linux", "darwin"] as const)
    for (const arch of ["x64", "arm64"] as const) {
      expect(platformAsset(os, arch)).toBe(
        `herdr-${os === "darwin" ? "macos" : os}-${arch === "x64" ? "x86_64" : "aarch64"}`,
      )
    }
  expect(() => platformAsset("win32", "x64")).toThrow()
  expect(() => platformAsset("linux", "ia32")).toThrow()
})
test("HTTP download, cache reuse, repair, atomic installation", async () => {
  const root = await temp()
  const s = await server(fixture())
  try {
    const path = await getRelease("0.9.4", asset, root, s.download)
    expect(await readFile(path, "utf8")).toBe(binary)
    await getRelease("0.9.4", asset, root, s.download)
    expect(s.requests()).toBe(3)
    await writeFile(path, "damaged")
    await getRelease("0.9.4", asset, root, s.download)
    expect(s.requests()).toBe(6)
    const destination = join(root, "bin/herdr")
    await installRelease(path, destination, "0.9.4")
    await writeFile(path, '#!/bin/sh\necho "herdr 0.9.3"\n')
    await expect(installRelease(path, destination, "0.9.4")).rejects.toThrow(
      "Unexpected binary version",
    )
    expect(await readFile(destination, "utf8")).toBe(binary)
  } finally {
    s.http.stop(true)
  }
})
test("tampered download and missing assets fail without a usable cache", async () => {
  const root = await temp()
  const files = fixture()
  files[asset] = "tampered"
  const s = await server(files)
  try {
    await expect(getRelease("0.9.4", asset, root, s.download)).rejects.toThrow(
      "checksum",
    )
    await expect(
      verify(join(root, "0.9.4", asset), "0.9.4", asset),
    ).rejects.toThrow()
    delete (files as Partial<typeof files>)[asset]
    await expect(getRelease("0.9.4", asset, root, s.download)).rejects.toThrow(
      "HTTP 404",
    )
  } finally {
    s.http.stop(true)
  }
})
test("metadata and checksum manifest agree", async () => {
  const root = await temp()
  for (const [name, content] of Object.entries(fixture()))
    await writeFile(join(root, name), content)
  await expect(verify(root, "0.9.3", asset)).rejects.toThrow("metadata")
  await writeFile(join(root, "checksums.txt"), "")
  await expect(verify(root, "0.9.4", asset)).rejects.toThrow("manifest")
})
test("Cargo validation and complete metadata", async () => {
  expect(await validateTag("herdr-ud/v0.9.4")).toBe("0.9.4")
  await expect(validateTag("herdr-ud/v0.9.3")).rejects.toThrow("match")
  await expect(validateTag("v0.9.4")).rejects.toThrow("Tag must")
  const root = await temp()
  for (const name of ASSETS) await writeFile(join(root, name), name)
  await writeMetadata(root, "herdr-ud/v0.9.4", "b".repeat(40), "v0.9.3")
  const m = JSON.parse(
    await readFile(join(root, "release-metadata.json"), "utf8"),
  )
  expect(Object.keys(m.assets)).toEqual(ASSETS)
  expect(m.upstream).toBe("v0.9.3")
  await rm(join(root, ASSETS[0]!))
  await expect(
    writeMetadata(root, "herdr-ud/v0.9.4", "b".repeat(40), "v0.9.3"),
  ).rejects.toThrow()
})
test("just forwards flags", async () => {
  for (const args of [[], ["--ver", "source"], ["--get", "0.9.4"]]) {
    const p = Bun.spawn(["just", "--dry-run", "herdr-install", ...args], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const output = await new Response(p.stderr).text()
    expect(await p.exited).toBe(0)
    expect(output).toContain(
      `bun run herdr-release/install.ts ${args.join(" ")}`.trim(),
    )
  }
})

test("draft retries and uploaded digest checks", async () => {
  const { checkUploadedAssets, requireUnpublished } = await import("./publish")
  const { digest } = await import("./install")
  expect(() => requireUnpublished()).not.toThrow()
  expect(() => requireUnpublished({ draft: true })).not.toThrow()
  expect(() => requireUnpublished({ draft: false })).toThrow("published")
  const root = await temp()
  for (const name of ASSETS) await writeFile(join(root, name), name)
  await writeMetadata(root, "herdr-ud/v0.9.4", "b".repeat(40), "v0.9.3")
  const uploaded = await Promise.all(
    [...ASSETS, "checksums.txt", "release-metadata.json", "build-info.md"].map(
      async (name) => ({
        name,
        digest: `sha256:${await digest(join(root, name))}`,
      }),
    ),
  )
  await checkUploadedAssets(root, uploaded)
  uploaded[0]!.digest = "sha256:wrong"
  await expect(checkUploadedAssets(root, uploaded)).rejects.toThrow(
    "mismatched",
  )
  await expect(checkUploadedAssets(root, [])).rejects.toThrow("Missing")
})
test("workflow publishes only after all builds with five expected assets", async () => {
  const yaml = (Bun as typeof Bun & { YAML: { parse(input: string): unknown } })
    .YAML
  const workflow = yaml.parse(
    await readFile(".github/workflows/herdr-release.yml", "utf8"),
  ) as any
  expect(workflow.on.push.tags).toEqual(["herdr-ud/*"])
  expect(
    workflow.jobs.validate.steps.some(
      (step: { uses?: string }) => step.uses === "taiki-e/install-action@just",
    ),
  ).toBe(true)
  expect(workflow.jobs.build.needs).toBe("validate")
  expect(workflow.jobs.publish.needs).toBe("build")
  expect(
    workflow.jobs.build.strategy.matrix.include.map((item: any) => item.asset),
  ).toEqual(ASSETS)
  expect(workflow.permissions.contents).toBe("read")
  expect(workflow.jobs.publish.permissions.contents).toBe("write")
})

test("public release API download uses encoded tag and real asset responses", async () => {
  const { downloadPublicRelease } = await import("./install")
  const root = await temp()
  const files = fixture()
  let tagRequested = false
  const http = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname
      if (path === "/releases/tags/herdr-ud%2Fv0.9.4") {
        tagRequested = true
        return Response.json({
          assets: Object.keys(files).map((name) => ({
            name,
            browser_download_url:
              new URL(name, request.url).origin + "/" + name,
          })),
        })
      }
      const value = files[path.slice(1) as keyof typeof files]
      return new Response(value ?? "not found", { status: value ? 200 : 404 })
    },
  })
  try {
    await downloadPublicRelease(
      http.url.toString().replace(/\/$/, ""),
      "herdr-ud/v0.9.4",
      asset,
      root,
    )
    expect(tagRequested).toBe(true)
    await verify(root, "0.9.4", asset)
  } finally {
    http.stop(true)
  }
})

test("just release flags use the XDG cache and install into a temporary home", async () => {
  const { mkdir } = await import("node:fs/promises")
  const root = await temp()
  const hostAsset = platformAsset()
  const dir = join(root, "cache/herdr-ud/0.9.4", hostAsset)
  await mkdir(dir, { recursive: true })
  const hash = createHash("sha256").update(binary).digest("hex")
  await writeFile(join(dir, hostAsset), binary)
  await writeFile(join(dir, "checksums.txt"), `${hash}  ${hostAsset}\n`)
  await writeFile(
    join(dir, "release-metadata.json"),
    JSON.stringify({
      version: "0.9.4",
      tag: "herdr-ud/v0.9.4",
      commit: "a".repeat(40),
      assets: { [hostAsset]: hash },
    }),
  )
  const env = {
    ...process.env,
    HOME: root,
    XDG_CACHE_HOME: join(root, "cache"),
  }
  for (const flag of ["--get", "--ver"]) {
    const proc = Bun.spawn(["just", "herdr-install", flag, "v0.9.4"], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    expect(await proc.exited).toBe(0)
    expect(stderr).not.toContain("error:")
    expect(stdout).toContain(
      flag === "--get" ? join(dir, hostAsset) : join(root, ".local/bin/herdr"),
    )
  }
  expect(await readFile(join(root, ".local/bin/herdr"), "utf8")).toBe(binary)
})
