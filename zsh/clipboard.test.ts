import { bash } from "@uniquedivine/bash"
import { describe, expect, test } from "bun:test"

const hasCommand = async (cmd: string): Promise<boolean> => {
  const out = await bash(`which ${cmd}`)
  return out.exitCode === 0
}

const hasClipboardBridge =
  (await hasCommand("pbcopy")) && (await hasCommand("pbpaste"))

const clipboardTest = hasClipboardBridge ? test : test.skip
const clipboardDescribe = hasClipboardBridge ? describe : describe.skip

clipboardTest("commands present: pbcopy, pbpaste", async () => {
  let out = await bash(`which pbcopy`)
  expect(out.stdout).not.toBeEmpty()
  expect(out.stderr).toBeEmpty()
  out = await bash(`which pbpaste`)
  expect(out.stdout).not.toBeEmpty()
  expect(out.stderr).toBeEmpty()
})

clipboardTest(
  "pbpaste correctly retrieves a single line without extra newlines",
  async () => {
    // Copy "one line output" to the clipboard (equivalent to pbcopy)
    await bash(`echo "one line output" | pbcopy`)
    const output = await bash("pbpaste")
    expect(output.stdout).toBe("one line output\n")
  },
)

clipboardDescribe("pbpaste correctly retrieves a multiple lines", async () => {
  clipboardTest("with trailing newlines", async () => {
    await bash(`printf "line0\nline1\n\n\n" | pbcopy`)
    const output = await bash("pbpaste")
    expect(output.stdout).toBe("line0\nline1\n\n\n")
  })
  clipboardTest("without trailing newlines", async () => {
    await bash(`printf "line0\nline1" | pbcopy`)
    let output = await bash("pbpaste")
    expect(output.stdout).toBe("line0\nline1")
  })
})

clipboardDescribe("echo suite", async () => {
  const cases: { given: string; want: string }[] = [
    { given: "sanity check", want: "sanity check" },
    { given: "HJK 日本語", want: "HJK 日本語" },
    {
      given: `この職場は、経験よりも腕を優先する考え方だ。
職場 (しょくば)
`,
      want: `この職場は、経験よりも腕を優先する考え方だ。
職場 (しょくば)
`,
    },
  ]
  for (let { given, want } of cases) {
    clipboardTest(`input: "${given}", want: "${want}"`, async () => {
      await bash(`printf "${given}" | pbcopy`)
      const out = await bash("pbpaste")
      expect(out.stdout).toBe(want)
    })
  }
})
