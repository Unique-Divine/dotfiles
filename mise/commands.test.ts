import { describe, expect, test } from "bun:test"
import { activeCommandNames, parseCommandNames } from "./commands"

const entry = (name: string) => ({ name, path: `/tools/${name}`, symlink: false })

describe("active command discovery", () => {
  test("keeps secondary executables and deduplicates names", () => {
    expect(parseCommandNames(JSON.stringify([
      entry("buf"), entry("protoc-gen-buf-lint"), entry("buf"),
    ]))).toEqual(["buf", "protoc-gen-buf-lint"])
  })

  test("accepts an empty configuration", () => {
    expect(parseCommandNames("[]")).toEqual([])
  })

  test("rejects malformed output and unsafe executable names", () => {
    for (const json of ["broken", "{}", "[null]", '[{"name":"gh"}]',
      JSON.stringify([entry("../gh")]), JSON.stringify([entry("..")]),
      JSON.stringify([entry("a\\b")]), JSON.stringify([entry("a\0b")])]) {
      expect(() => parseCommandNames(json)).toThrow()
    }
  })

  test("reports a failing discovery command", () => {
    expect(() => activeCommandNames("/usr/bin/false")).toThrow(
      "mise bin-paths failed",
    )
  })
})
