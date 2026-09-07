import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const hookPath = join(import.meta.dir, "commit-msg")
const cursorTrailer = "Co-authored-by: Cursor <cursoragent@cursor.com>"

const runHook = async (
  message: string,
): Promise<{ exitCode: number; text: string }> => {
  const dir = await mkdtemp(join(tmpdir(), "commit-msg-"))
  const msgFile = join(dir, "COMMIT_EDITMSG")
  await writeFile(msgFile, message)

  const proc = Bun.spawn([hookPath, msgFile], {
    cwd: dir,
    stderr: "pipe",
    stdout: "pipe",
  })

  const [exitCode] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])

  return { exitCode, text: await readFile(msgFile, "utf8") }
}

describe("cursor commit-msg hook", () => {
  test("removes the Cursor Co-authored-by trailer", async () => {
    const { exitCode, text } = await runHook(
      `chore(deps): bump s3 in /lib/sai-trading\n\n${cursorTrailer}\n`,
    )

    expect(exitCode).toBe(0)
    expect(text).toBe("chore(deps): bump s3 in /lib/sai-trading\n\n")
    expect(text).not.toContain(cursorTrailer)
  })

  test("keeps a human Co-authored-by line", async () => {
    const human = "Co-authored-by: Unique Divine <realuniquedivine@gmail.com>"
    const { exitCode, text } = await runHook(
      `fix: restore sender authority\n\n${human}\n${cursorTrailer}\n`,
    )

    expect(exitCode).toBe(0)
    expect(text).toBe(`fix: restore sender authority\n\n${human}\n`)
  })

  test("leaves a clean message alone", async () => {
    const message = "docs: note attribution workaround\n"
    const { exitCode, text } = await runHook(message)

    expect(exitCode).toBe(0)
    expect(text).toBe(message)
  })
})
