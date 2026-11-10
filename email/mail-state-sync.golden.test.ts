/**
 * Golden tests over anonymized live Gmail and OAuth responses; see
 * fixtures/gmail/index.ts. No HTTP calls.
 */
import { describe, expect, test } from "bun:test";

import {
  error403Quota,
  error404,
  sourceList,
  sourceMessage,
  sourceProfile,
  sourceTokenRefresh,
  targetListEmpty,
  targetMessage,
  targetProfile,
  targetTokenRefresh,
} from "./fixtures/gmail";
import {
  applyTokenRefresh,
  idsFromListPage,
  isQuotaExceeded,
  isRetryableStatus,
  metaFromMessage,
  parseGmailError,
  planSync,
  retryDelayMs,
  type StoredToken,
} from "./mail-state-sync.ts";

describe("users.messages.list", () => {
  test("returns the ids of a page", () => {
    expect(idsFromListPage(sourceList)).toEqual(
      sourceList.messages.map((m) => m.id),
    );
    expect(sourceList.nextPageToken).toBeString();
  });

  test("an empty match omits the messages key", () => {
    expect("messages" in targetListEmpty).toBe(false);
    expect(idsFromListPage(targetListEmpty)).toEqual([]);
  });
});

describe("users.messages.get format=metadata", () => {
  test("reads Message-Id in Gmail's casing and normalizes it", () => {
    const names = targetMessage.payload.headers.map((h) => h.name);
    expect(names).toContain("Message-Id");
    expect(metaFromMessage(targetMessage)).toEqual({
      mid: "fixture-target-2@mail.example.com",
      subject: "Fixture subject 2",
    });
  });

  test("ids and dates are strings, size is a number", () => {
    expect(sourceMessage.historyId).toBeString();
    expect(sourceMessage.internalDate).toMatch(/^\d+$/);
    expect(sourceMessage.sizeEstimate).toBeNumber();
  });
});

describe("users.getProfile", () => {
  test("carries the signed-in address", () => {
    expect(sourceProfile.emailAddress).toContain("@");
    expect(targetProfile.historyId).toBeString();
  });
});

describe("errors", () => {
  test("parses the 404 envelope and leaves it non-retryable", () => {
    const text = JSON.stringify(error404);
    expect(parseGmailError(text)?.error.status).toBe("NOT_FOUND");
    expect(isRetryableStatus(404, text)).toBe(false);
  });

  test("a quota 403 is retryable and waits out the minute", () => {
    const text = JSON.stringify(error403Quota);
    expect(parseGmailError(text)?.error.code).toBe(403);
    expect(isQuotaExceeded(403, text)).toBe(true);
    expect(isRetryableStatus(403, text)).toBe(true);
    expect(retryDelayMs(403, text, 0, 0)).toBeGreaterThanOrEqual(60_000);
  });

  test("non-JSON bodies parse to null", () => {
    expect(parseGmailError("<html>bad gateway</html>")).toBeNull();
  });
});

describe("OAuth token refresh", () => {
  test("updates the access token and expiry only", () => {
    const stored: StoredToken = {
      email: "target.user@example.com",
      scope: targetTokenRefresh.scope,
      refreshToken: "fixture-refresh-token",
      accessToken: "old",
      expiresAt: 0,
    };
    const next = applyTokenRefresh(stored, targetTokenRefresh, 1_000);
    expect(next.accessToken).toBe(targetTokenRefresh.access_token);
    expect(next.expiresAt).toBe(1_000 + targetTokenRefresh.expires_in * 1000);
    expect(next.refreshToken).toBe(stored.refreshToken);
  });

  test("Testing-mode apps get 7-day refresh tokens", () => {
    expect(sourceTokenRefresh.refresh_token_expires_in).toBe(604_800);
  });
});

describe("end to end over fixtures", () => {
  test("archives a target copy of a source-archived message", () => {
    // The same email delivered to both accounts shares its Message-Id; a
    // target copy is modeled by reusing the source message's headers.
    const sourceMeta = metaFromMessage(sourceMessage);
    const plan = planSync({
      sourceArchived: new Set([sourceMeta.mid!]),
      target: [
        { id: targetMessage.id, ...sourceMeta },
        { id: "unmatched-target", ...metaFromMessage(targetMessage) },
      ],
      junkAction: "archive",
    });
    expect(plan.archive).toEqual([targetMessage.id]);
    expect(plan.unmatched).toBe(1);
  });
});
