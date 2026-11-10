import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BATCH_MODIFY_MAX,
  SCOPE_MODIFY,
  SCOPE_READONLY,
  backoffMs,
  buildAuthUrl,
  cachePath,
  chunk,
  defaultCredentialsPath,
  formatRunCommand,
  isPrivateMode,
  isRetryableStatus,
  REQUEST_INTERVAL_MS,
  QUERY_COST_LIMIT_PER_MIN,
  messageIdSet,
  normalizeMessageId,
  parseArgs,
  parseClientCredentials,
  pkceChallenge,
  planSync,
  scopeCovers,
  shellQuote,
  tokenPath,
  writePrivateJson,
  type TargetMessage,
} from "./mail-state-sync.ts";

const SRC = "realuniquedivine@gmail.com";
const TGT = "ud@uniquedivine.com";
const HOME = "/home/test";

describe("normalizeMessageId", () => {
  test("trims, strips brackets, lowercases", () => {
    expect(normalizeMessageId("  <ABC.123@Mail.Gmail.com>  ")).toBe(
      "abc.123@mail.gmail.com",
    );
  });
  test("accepts ids without brackets", () => {
    expect(normalizeMessageId("Foo@Bar")).toBe("foo@bar");
  });
  test("takes the bracketed part when surrounded by noise", () => {
    expect(normalizeMessageId("(comment) <x@y>")).toBe("x@y");
  });
  test("missing or empty yields null", () => {
    expect(normalizeMessageId(undefined)).toBeNull();
    expect(normalizeMessageId(null)).toBeNull();
    expect(normalizeMessageId("   ")).toBeNull();
    expect(normalizeMessageId("<>")).toBeNull();
  });
});

describe("messageIdSet", () => {
  test("collects known, non-null ids", () => {
    const set = messageIdSet(["a", "b", "c"], {
      a: { mid: "1@x" },
      b: { mid: null },
    });
    expect([...set]).toEqual(["1@x"]);
  });
});

function tgt(id: string, mid: string | null, subject?: string): TargetMessage {
  return { id, mid, subject };
}

describe("planSync", () => {
  test("archives matches and leaves others untouched", () => {
    const plan = planSync({
      sourceArchived: new Set(["a@x", "b@x"]),
      target: [
        tgt("t1", "a@x", "Hello"),
        tgt("t2", "z@x", "Other"),
        tgt("t3", "b@x"),
      ],
      junkAction: "archive",
    });
    expect(plan.archive).toEqual(["t1", "t3"]);
    expect(plan.trash).toEqual([]);
    expect(plan.matchedArchived).toBe(2);
    expect(plan.unmatched).toBe(1);
    expect(plan.samples).toEqual(["Hello"]);
  });

  test("skips messages without a Message-ID", () => {
    const plan = planSync({
      sourceArchived: new Set(["a@x"]),
      target: [tgt("t1", null), tgt("t2", "a@x")],
      junkAction: "archive",
    });
    expect(plan.archive).toEqual(["t2"]);
    expect(plan.skippedNoMessageId).toBe(1);
  });

  test("no source sets means nothing happens", () => {
    const plan = planSync({
      sourceArchived: new Set(),
      target: [tgt("t1", "a@x")],
      junkAction: "trash",
    });
    expect(plan.archive).toEqual([]);
    expect(plan.trash).toEqual([]);
    expect(plan.unmatched).toBe(1);
  });

  test("junk matches archive by default", () => {
    const plan = planSync({
      sourceArchived: new Set(),
      sourceSpam: new Set(["s@x"]),
      sourceTrash: new Set(["d@x"]),
      target: [tgt("t1", "s@x"), tgt("t2", "d@x")],
      junkAction: "archive",
    });
    expect(plan.archive).toEqual(["t1", "t2"]);
    expect(plan.matchedSpam).toBe(1);
    expect(plan.matchedTrash).toBe(1);
  });

  test("junk matches trash only with junkAction trash", () => {
    const plan = planSync({
      sourceArchived: new Set(["a@x"]),
      sourceSpam: new Set(["s@x"]),
      sourceTrash: new Set(["d@x"]),
      target: [tgt("t1", "s@x"), tgt("t2", "d@x"), tgt("t3", "a@x")],
      junkAction: "trash",
    });
    expect(plan.trash).toEqual(["t1", "t2"]);
    expect(plan.archive).toEqual(["t3"]);
  });

  test("archived source state wins over junk", () => {
    const plan = planSync({
      sourceArchived: new Set(["a@x"]),
      sourceTrash: new Set(["a@x"]),
      target: [tgt("t1", "a@x")],
      junkAction: "trash",
    });
    expect(plan.archive).toEqual(["t1"]);
    expect(plan.trash).toEqual([]);
  });

  test("duplicate target ids are planned once", () => {
    const plan = planSync({
      sourceArchived: new Set(["a@x"]),
      target: [tgt("t1", "a@x"), tgt("t1", "a@x")],
      junkAction: "archive",
    });
    expect(plan.archive).toEqual(["t1"]);
  });
});

describe("chunk", () => {
  test("splits into batchModify-sized chunks", () => {
    const ids = Array.from({ length: 2500 }, (_, i) => `id${i}`);
    const parts = chunk(ids, BATCH_MODIFY_MAX);
    expect(parts.map((p) => p.length)).toEqual([1000, 1000, 500]);
    expect(parts.flat()).toEqual(ids);
  });
  test("empty input gives no chunks", () => {
    expect(chunk([], 10)).toEqual([]);
  });
  test("rejects bad sizes", () => {
    expect(() => chunk([1], 0)).toThrow();
  });
});

describe("parseArgs", () => {
  const base = ["--source", SRC, "--target", TGT];

  test("defaults to a dry run", () => {
    const o = parseArgs(base, HOME);
    expect(o.run).toBe(false);
    expect(o.includeJunk).toBe(false);
    expect(o.junkAction).toBe("archive");
    expect(o.targetQuery).toBe("in:inbox");
    expect(o.useCache).toBe(true);
    expect(o.limit).toBeNull();
    expect(o.credentials).toBe(defaultCredentialsPath(HOME));
  });

  test("parses every flag", () => {
    const o = parseArgs(
      [
        ...base,
        "--run",
        "--include-junk",
        "--junk-action",
        "trash",
        "--target-query=in:inbox newer_than:1y",
        "--no-cache",
        "--limit",
        "50",
        "--credentials",
        "/tmp/c.json",
      ],
      HOME,
    );
    expect(o.run).toBe(true);
    expect(o.includeJunk).toBe(true);
    expect(o.junkAction).toBe("trash");
    expect(o.targetQuery).toBe("in:inbox newer_than:1y");
    expect(o.useCache).toBe(false);
    expect(o.limit).toBe(50);
    expect(o.credentials).toBe("/tmp/c.json");
  });

  test("lowercases emails", () => {
    const o = parseArgs(["--source", "A@Gmail.com", "--target", TGT], HOME);
    expect(o.source).toBe("a@gmail.com");
  });

  test("rejects bad input", () => {
    expect(() => parseArgs([], HOME)).toThrow(/required/);
    expect(() => parseArgs([...base, "--bogus"], HOME)).toThrow(/unknown/);
    expect(() => parseArgs([...base, "--limit", "0"], HOME)).toThrow();
    expect(() => parseArgs([...base, "--limit"], HOME)).toThrow(/value/);
    expect(() =>
      parseArgs([...base, "--include-junk", "--junk-action", "spam"], HOME),
    ).toThrow(/junk-action/);
    expect(() => parseArgs([...base, "--junk-action", "trash"], HOME)).toThrow(
      /include-junk/,
    );
    expect(() => parseArgs(["--source", SRC, "--target", SRC], HOME)).toThrow(
      /differ/,
    );
    expect(() => parseArgs(["--source", "nope", "--target", TGT], HOME))
      .toThrow(/email/);
  });

  test("help skips validation", () => {
    expect(parseArgs(["--help"], HOME).help).toBe(true);
  });
});

describe("formatRunCommand", () => {
  test("appends --run and keeps non-default flags", () => {
    const o = parseArgs(
      [
        "--source",
        SRC,
        "--target",
        TGT,
        "--include-junk",
        "--target-query",
        "in:inbox older_than:1y",
        "--limit",
        "100",
      ],
    );
    expect(formatRunCommand(o)).toBe(
      `bun run email/mail-state-sync.ts --source ${SRC} --target ${TGT} ` +
        `--include-junk --target-query 'in:inbox older_than:1y' ` +
        `--limit 100 --run`,
    );
  });
  test("round-trips through parseArgs", () => {
    const o = parseArgs(["--source", SRC, "--target", TGT, "--no-cache"]);
    const argv = formatRunCommand(o).split(" ").slice(3);
    expect(parseArgs(argv)).toEqual({ ...o, run: true });
  });
});

describe("shellQuote", () => {
  test("quotes special characters", () => {
    expect(shellQuote("in:inbox")).toBe("in:inbox");
    expect(shellQuote("a b")).toBe("'a b'");
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });
});

describe("paths and modes", () => {
  test("token and cache paths are per email", () => {
    expect(tokenPath(TGT, HOME)).toBe(
      `${HOME}/.config/mail-state-sync/${TGT}.json`,
    );
    expect(cachePath(SRC, HOME)).toBe(
      `${HOME}/.cache/mail-state-sync/${SRC}.json`,
    );
  });
  test("isPrivateMode", () => {
    expect(isPrivateMode(0o600)).toBe(true);
    expect(isPrivateMode(0o700)).toBe(true);
    expect(isPrivateMode(0o644)).toBe(false);
    expect(isPrivateMode(0o100600)).toBe(true);
  });
  test("writePrivateJson sets 700 dir and 600 file", async () => {
    const root = await mkdtemp(join(tmpdir(), "mss-"));
    try {
      const path = join(root, "sub", "tok.json");
      await writePrivateJson(path, { a: 1 });
      expect((await stat(join(root, "sub"))).mode & 0o777).toBe(0o700);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(await Bun.file(path).json()).toEqual({ a: 1 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("rate limits", () => {
  test("treats Gmail per-user quota 403s as retryable", () => {
    const body =
      "Quota exceeded for quota metric 'Total Query Cost' and limit " +
      "'Units per minute per user' of service 'gmail.googleapis.com'";
    expect(isRetryableStatus(403, body)).toBe(true);
    expect(isRetryableStatus(403, "Insufficient Permission")).toBe(false);
  });
  test("request spacing stays under the project's per-user limit", () => {
    const getsPerMinute = 60_000 / REQUEST_INTERVAL_MS;
    expect(getsPerMinute * 5).toBeLessThan(QUERY_COST_LIMIT_PER_MIN);
  });
});

describe("oauth helpers", () => {
  test("PKCE S256 is base64url(sha256(verifier))", () => {
    // RFC 7636 Appendix B test vector.
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(pkceChallenge(verifier)).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });
  test("auth url carries PKCE, offline access, and login hint", () => {
    const url = new URL(
      buildAuthUrl({
        clientId: "cid",
        redirectUri: "http://127.0.0.1:5555",
        scope: SCOPE_READONLY,
        state: "st",
        challenge: "ch",
        loginHint: SRC,
      }),
    );
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("login_hint")).toBe(SRC);
    expect(url.searchParams.get("redirect_uri")).toBe(
      "http://127.0.0.1:5555",
    );
  });
  test("scopeCovers treats modify as a superset of readonly", () => {
    expect(scopeCovers(SCOPE_MODIFY, SCOPE_READONLY)).toBe(true);
    expect(scopeCovers(SCOPE_READONLY, SCOPE_MODIFY)).toBe(false);
    expect(scopeCovers(`openid ${SCOPE_MODIFY}`, SCOPE_MODIFY)).toBe(true);
  });
  test("parseClientCredentials reads installed block", () => {
    expect(
      parseClientCredentials({
        installed: { client_id: "i", client_secret: "s" },
      }),
    ).toEqual({ clientId: "i", clientSecret: "s" });
    expect(() => parseClientCredentials({})).toThrow();
  });
});

describe("retry helpers", () => {
  test("isRetryableStatus", () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(404)).toBe(false);
    expect(isRetryableStatus(403, '{"reason":"userRateLimitExceeded"}'))
      .toBe(true);
    expect(isRetryableStatus(403, "forbidden")).toBe(false);
  });
  test("backoffMs grows and caps", () => {
    expect(backoffMs(0, 1)).toBe(500);
    expect(backoffMs(3, 1)).toBe(4000);
    expect(backoffMs(20, 1)).toBe(32_000);
    expect(backoffMs(1, 0)).toBe(500);
  });
});
