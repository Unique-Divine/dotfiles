import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const zshDir = import.meta.dir
const dotfilesDir = join(zshDir, "..")

describe("Zsh completion setup", () => {
  test("uses native completion as the fzf fallback", () => {
    const testHome = mkdtempSync(join(tmpdir(), "dotfiles-zsh-completion-"))

    try {
      const result = Bun.spawnSync(
        [
          "zsh",
          "-f",
          "-c",
          'source "$DOTFILES/zsh/completions.zsh"; print -r -- "$fzf_default_completion"',
        ],
        {
          env: {
            ...process.env,
            DOTFILES: dotfilesDir,
            HOME: testHome,
            XDG_CACHE_HOME: join(testHome, ".cache"),
          },
          stderr: "pipe",
          stdout: "pipe",
        },
      )

      expect(result.stderr.toString()).toBe("")
      expect(result.exitCode).toBe(0)
      expect(result.stdout.toString().trim()).toBe("expand-or-complete")
    } finally {
      rmSync(testHome, { force: true, recursive: true })
    }
  })

  test("matches case-insensitive substrings alongside prefixes", () => {
    const testHome = mkdtempSync(join(tmpdir(), "dotfiles-zsh-completion-"))

    try {
      const result = Bun.spawnSync(
        [
          "zsh",
          "-f",
          "-c",
          'source "$DOTFILES/zsh/completions.zsh"; zstyle -a ":completion:*" matcher-list reply; print -rl -- "${reply[@]}"',
        ],
        {
          env: {
            ...process.env,
            DOTFILES: dotfilesDir,
            HOME: testHome,
            XDG_CACHE_HOME: join(testHome, ".cache"),
          },
          stderr: "pipe",
          stdout: "pipe",
        },
      )

      expect(result.stderr.toString()).toBe("")
      expect(result.exitCode).toBe(0)
      expect(result.stdout.toString().trim().split("\n")).toEqual([
        "m:{a-z}={A-Za-z} l:|=* r:|=*",
      ])
    } finally {
      rmSync(testHome, { force: true, recursive: true })
    }
  })

  test("the lazy widget invokes native completion directly", async () => {
    const zshrc = await Bun.file(join(zshDir, "zshrc.zsh")).text()

    expect(zshrc).toContain("zle expand-or-complete")
    expect(zshrc).not.toContain("_dotfiles_original_complete")
  })

  test("keeps Backspace compatible with Oh My Zsh vi insert mode", async () => {
    const zshrc = await Bun.file(join(zshDir, "zshrc.zsh")).text()

    expect(zshrc).toContain("bindkey -M viins '^?' backward-delete-char")
  })
})
