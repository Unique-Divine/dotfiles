import { describe, expect, test } from "bun:test"

import {
  buildPersistentPowerShellScript,
  decodeClipboardResponse,
  parseOptions,
  summarizeTimings,
} from "./clipboard.bench"

describe("parseOptions", () => {
  test("uses benchmark defaults", () => {
    expect(parseOptions([])).toEqual({
      iterations: 10,
      payloadBytes: 128,
      warmups: 2,
    })
  })

  test("parses each numeric option", () => {
    expect(
      parseOptions([
        "--iters",
        "20",
        "--warmups",
        "3",
        "--in-bz",
        "4096",
      ]),
    ).toEqual({
      iterations: 20,
      payloadBytes: 4096,
      warmups: 3,
    })
  })

  test("rejects invalid options", () => {
    expect(() => parseOptions(["--iters", "zero"])).toThrow(
      "--iters must be a positive integer",
    )
    expect(() => parseOptions(["--unknown", "1"])).toThrow(
      "Unknown option: --unknown",
    )
  })
})

describe("summarizeTimings", () => {
  test("calculates stable timing statistics", () => {
    expect(summarizeTimings("sample", [5, 1, 4, 2, 3])).toEqual({
      label: "sample",
      iterations: 5,
      minMs: 1,
      medianMs: 3,
      meanMs: 3,
      p95Ms: 5,
      maxMs: 5,
    })
  })

  test("averages the middle values for an even sample count", () => {
    expect(summarizeTimings("sample", [4, 1, 3, 2]).medianMs).toBe(2.5)
  })

  test("rejects an empty sample set", () => {
    expect(() => summarizeTimings("sample", [])).toThrow(
      "Cannot summarize an empty sample set",
    )
  })
})

describe("persistent PowerShell protocol", () => {
  test("decodes multiline Unicode clipboard text", () => {
    const text = "line one\n日本語\n"
    const encoded = Buffer.from(text, "utf8").toString("base64")
    expect(decodeClipboardResponse(encoded)).toBe(text)
  })

  test("uses a constrained paste protocol with explicit flushing", () => {
    const script = buildPersistentPowerShellScript()
    expect(script).toContain(`$line -eq 'PASTE'`)
    expect(script).toContain("Get-Clipboard -Raw")
    expect(script).toContain("ToBase64String")
    expect(script).toContain("[Console]::Out.Flush()")
    expect(script).not.toContain("Invoke-Expression")
  })
})
