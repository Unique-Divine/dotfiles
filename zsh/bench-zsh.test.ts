import { describe, expect, test } from "bun:test"

import { buildPromptZshrc, parseArgs, summarize } from "./bench-zsh"

describe("parseArgs", () => {
  test("uses the synchronous startup benchmark by default", () => {
    expect(parseArgs([])).toMatchObject({ mode: "init", runs: 10, warmups: 2 })
  })

  test("accepts the prompt benchmark", () => {
    expect(parseArgs(["--mode", "prompt"])).toMatchObject({ mode: "prompt" })
  })

  test("rejects an unknown benchmark mode", () => {
    expect(() => parseArgs(["--mode", "idle"])).toThrow(
      "--mode requires init or prompt",
    )
  })
})

describe("buildPromptZshrc", () => {
  test("sources the real configuration before registering the readiness hook", () => {
    const config = buildPromptZshrc("/home/tester", "__READY__")
    expect(config).toContain("source '/home/tester/.zshrc'")
    expect(config).toContain("zle -N zle-line-init _zsh_benchmark_line_init")
    expect(config).toContain("print -r -- '__READY__'")
  })
})

describe("summarize", () => {
  test("reports the requested percentiles", () => {
    expect(summarize([4, 1, 3, 2])).toEqual({
      maxMs: 4,
      meanMs: 2.5,
      medianMs: 2,
      minMs: 1,
      p95Ms: 4,
    })
  })
})
