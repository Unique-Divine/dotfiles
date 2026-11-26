import { describe, expect, test } from "bun:test"
import {
  dedupeCbm, docRefPath, localRefRepo, refCandidates, isDistinctCrate, isWeakCbmMatch, joinRepoPath,
  type Link, ownerOf, parseCargoName, parseGoModule, parseNpmName,
  parseRemote, parseRgLine,
} from "./xrepo"

describe("manifest parsing", () => {
  test("go.mod module path", () => {
    expect(parseGoModule("module github.com/NibiruChain/nibiru/v2\n\ngo 1.22"))
      .toBe("github.com/NibiruChain/nibiru/v2")
    expect(parseGoModule("go 1.22\n")).toBeUndefined()
  })

  test("Cargo package name, not a dependency's", () => {
    const toml = [
      "[package]", 'name = "nibiru-std"', 'version = "0.6.0"', "",
      "[dependencies]", 'name = "not-this"',
    ].join("\n")
    expect(parseCargoName(toml)).toBe("nibiru-std")
    expect(parseCargoName('[workspace]\nmembers = ["a"]\n')).toBeUndefined()
  })

  test("npm names: scoped only", () => {
    expect(parseNpmName('{"name": "@nibiruchain/nibijs"}'))
      .toBe("@nibiruchain/nibijs")
    expect(parseNpmName('{"name": "docs"}')).toBeUndefined()
    expect(parseNpmName("{not json")).toBeUndefined()
  })

  test("crate names need a separator", () => {
    expect(isDistinctCrate("nibiru-std")).toBe(true)
    expect(isDistinctCrate("utils")).toBe(false)
  })

  test("git remotes, SSH and HTTPS", () => {
    expect(parseRemote("git@github.com:SaiDotFun/ts-sdk.git\n"))
      .toBe("saidotfun/ts-sdk")
    expect(parseRemote("https://github.com/Unique-Divine/boku"))
      .toBe("unique-divine/boku")
    expect(parseRemote("")).toBe("")
  })
})

describe("matching", () => {
  test("rg lines keep colons inside the match", () => {
    expect(parseRgLine("a/b.go:12:\"x:y\"")).toEqual(
      { file: "a/b.go", line: 12, match: "\"x:y\"" })
    expect(parseRgLine("garbage")).toBeUndefined()
  })

  test("ownerOf picks the longest matching package", () => {
    const owners = [
      { key: "github.com/NibiruChain/nibiru/v2", repo: "nibiru" },
      { key: "github.com/NibiruChain/nibiru/v2/x/sub", repo: "other" },
    ]
    expect(ownerOf("github.com/NibiruChain/nibiru/v2/x/mint", owners)?.repo)
      .toBe("nibiru")
    expect(ownerOf("github.com/NibiruChain/nibiru/v2/x/sub/k", owners)?.repo)
      .toBe("other")
    expect(ownerOf("github.com/NibiruChain/nibiru/v22", owners))
      .toBeUndefined()
  })

  test("import subpaths join the package dir", () => {
    expect(joinRepoPath("", "/x/mint")).toBe("x/mint")
    expect(joinRepoPath("saidb", "")).toBe("saidb")
    expect(joinRepoPath("", "")).toBe("")
  })

  test("doc references become repo paths", () => {
    expect(docRefPath("/blob/23db897/packages/nibijs/src/chain.ts#L4"))
      .toBe("packages/nibijs/src/chain.ts")
    expect(docRefPath("/api/handlers/markets.go.")).toBe(
      "api/handlers/markets.go")
    expect(docRefPath("")).toBe("")
    expect(docRefPath("/api/handlers/markets.go:42")).toBe(
      "api/handlers/markets.go")
    expect(docRefPath("/blob/main/x/mint/keeper.go#L10-L20")).toBe(
      "x/mint/keeper.go")
  })
})

describe("localRefRepo", () => {
  const names = ["gh", "gh-io-ud", "sai-keeper", "sai-perps", "boku"]

  test("plain checkout", () => {
    expect(localRefRepo("/sai-keeper/api/x.go", names))
      .toEqual({ repo: "sai-keeper", path: "api/x.go" })
  })

  test("worktree folders resolve to the base repo", () => {
    expect(localRefRepo("/sai-perps-1400-ref-intents/contracts", names))
      .toEqual({ repo: "sai-perps", path: "contracts" })
  })

  test("old ~/ki root", () => {
    expect(localRefRepo("/ki/sai-keeper-points-api/api", names))
      .toEqual({ repo: "sai-keeper", path: "api" })
    expect(localRefRepo("/ki/boku", names)).toEqual({ repo: "boku", path: "" })
  })

  test("the longest repo name wins", () => {
    expect(localRefRepo("/gh-io-ud/src", names)?.repo).toBe("gh-io-ud")
    expect(localRefRepo("/gh/nibiruchain__sai-web", names)?.repo).toBe("gh")
  })

  test("unknown folders are not repos", () => {
    expect(localRefRepo("/Downloads/x", names)).toBeUndefined()
    expect(localRefRepo("/ki", names)).toBeUndefined()
  })
})

describe("refCandidates", () => {
  test("GitHub refs may hold slashes", () => {
    expect(refCandidates({ toPath: "v1.51.0/contracts/perp/src/msgs.rs",
      via: "github.com/x/sai-perps/blob/wasm-contracts/v1.51.0/contracts/perp/src/msgs.rs" }))
      .toEqual(["v1.51.0/contracts/perp/src/msgs.rs",
        "contracts/perp/src/msgs.rs", "perp/src/msgs.rs"])
  })

  test("local paths are taken as written", () => {
    expect(refCandidates({ toPath: "x/evm", via: "~/nibiru/x/evm" }))
      .toEqual(["x/evm"])
  })
})

describe("Codebase Memory edges", () => {
  const link = (over: Partial<Link> & { caller: boolean }) => ({
    kind: "cbm-call" as const, fromRepo: "sai-web", fromFile: "a.ts", line: 1,
    toRepo: "sai-keeper", toPath: "h.go", via: "CROSS_HTTP_CALLS /x", ...over,
  })

  test("keeps the caller's record of a pair recorded twice", () => {
    const kept = dedupeCbm([
      link({ fromRepo: "sai-keeper", fromFile: "h.go", toRepo: "sai-web",
        toPath: "a.ts", caller: false }),
      link({ caller: true }),
    ])
    expect(kept).toHaveLength(1)
    expect(kept[0].fromRepo).toBe("sai-web")
    expect("caller" in kept[0]).toBe(false)
  })

  test("weak: host-only URL or one-letter target", () => {
    expect(isWeakCbmMatch("https://rpc.nibiru.fi:443{}", "s")).toBe(true)
    expect(isWeakCbmMatch("/social/x/auth/start", "HandleXAuthStart"))
      .toBe(false)
    expect(isWeakCbmMatch("/", "main")).toBe(true)
    expect(isWeakCbmMatch("", "useBench")).toBe(true)
  })
})
