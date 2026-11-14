import { describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { commandsIn, deadShims, fallbackFinder } from "./dead-shims"

function executable(path: string): void {
  writeFileSync(path, "#!/bin/sh\n")
  chmodSync(path, 0o755)
}

/** Builds a layout like the laptop on 2026-11-14 (dotfiles#128). */
function layout() {
  const root = mkdtempSync(join(tmpdir(), "dead-shims-"))
  const miseBinary = join(root, "mise")
  const shimDir = join(root, "shims")
  const localBin = join(root, "local-bin")
  const activeBin = join(root, "installs", "rg")
  for (const dir of [shimDir, localBin, activeBin]) {
    mkdirSync(dir, { recursive: true })
  }
  executable(miseBinary)
  for (const name of ["rg", "node", "npm", "npx"]) {
    symlinkSync(miseBinary, join(shimDir, name))
  }
  executable(join(activeBin, "rg"))
  // Bun-backed node wrapper: the inactive node shim falls back to it.
  executable(join(localBin, "node"))
  // A ~/.local/bin link back into mise is not a fallback.
  symlinkSync(join(shimDir, "npx"), join(localBin, "npx"))
  return { root, miseBinary, shimDir, localBin, activeBin }
}

describe("deadShims", () => {
  test("reports inactive shims without a fallback", () => {
    const { miseBinary, shimDir, localBin, activeBin } = layout()
    const dead = deadShims(
      ["rg", "node", "npm", "npx"],
      commandsIn([activeBin]),
      fallbackFinder([shimDir, localBin, "/nonexistent"], shimDir, miseBinary),
    )
    expect(dead.map((d) => d.name)).toEqual(["npm", "npx"])
  })

  test("a real executable later on PATH revives a shim", () => {
    const { root, miseBinary, shimDir, localBin, activeBin } = layout()
    const nodeBin = join(root, "node-bin")
    mkdirSync(nodeBin)
    executable(join(nodeBin, "npm"))
    executable(join(nodeBin, "npx"))
    const dead = deadShims(
      ["rg", "node", "npm", "npx"],
      commandsIn([activeBin]),
      fallbackFinder([shimDir, localBin, nodeBin], shimDir, miseBinary),
    )
    expect(dead).toEqual([])
  })

  test("active commands are never dead", () => {
    const dead = deadShims(["rg"], new Set(["rg"]), () => null)
    expect(dead).toEqual([])
  })

  test("commandsIn skips missing directories", () => {
    expect(commandsIn(["/nonexistent"]).size).toBe(0)
  })
})
