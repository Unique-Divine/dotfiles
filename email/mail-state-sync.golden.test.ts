/**
 * Golden tests over anonymized live Gmail and OAuth responses; see
 * fixtures/gmail/index.ts. No HTTP calls.
 */
import { describe, expect, test } from "bun:test";

import * as gmailFixture from "./fixtures/gmail";
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
    expect(idsFromListPage(gmailFixture.sourceList)).toEqual(
      gmailFixture.sourceList.messages.map((m) => m.id),
    );
    expect(gmailFixture.sourceList.nextPageToken).toBeString();
  });

  test("an empty match omits the messages key", () => {
    expect("messages" in gmailFixture.targetListEmpty).toBe(false);
    expect(idsFromListPage(gmailFixture.targetListEmpty)).toEqual([]);
  });
});

describe("users.messages.get format=metadata", () => {
  test("reads Message-Id in Gmail's casing and normalizes it", () => {
    const names = gmailFixture.targetMessage.payload.headers.map(
      (h) => h.name,
    );
    expect(names).toContain("Message-Id");
    expect(metaFromMessage(gmailFixture.targetMessage)).toEqual({
      mid: "fixture-target-2@mail.example.com",
      subject: "Fixture subject 2",
    });
  });

  test("ids and dates are strings, size is a number", () => {
    expect(gmailFixture.sourceMessage.historyId).toBeString();
    expect(gmailFixture.sourceMessage.internalDate).toMatch(/^\d+$/);
    expect(gmailFixture.sourceMessage.sizeEstimate).toBeNumber();
  });
});

describe("users.getProfile", () => {
  test("carries the signed-in address", () => {
    expect(gmailFixture.sourceProfile.emailAddress).toContain("@");
    expect(gmailFixture.targetProfile.historyId).toBeString();
  });
});

describe("errors", () => {
  test("parses the 404 envelope and leaves it non-retryable", () => {
    const text = JSON.stringify(gmailFixture.error404);
    expect(parseGmailError(text)?.error.status).toBe("NOT_FOUND");
    expect(isRetryableStatus(404, text)).toBe(false);
  });

  test("a quota 403 is retryable and waits out the minute", () => {
    const text = JSON.stringify(gmailFixture.error403Quota);
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
      scope: gmailFixture.targetTokenRefresh.scope,
      refreshToken: "fixture-refresh-token",
      accessToken: "old",
      expiresAt: 0,
    };
    const refresh = gmailFixture.targetTokenRefresh;
    const next = applyTokenRefresh(stored, refresh, 1_000);
    expect(next.accessToken).toBe(refresh.access_token);
    expect(next.expiresAt).toBe(1_000 + refresh.expires_in * 1000);
    expect(next.refreshToken).toBe(stored.refreshToken);
  });

  test("Testing-mode apps get 7-day refresh tokens", () => {
    expect(
      gmailFixture.sourceTokenRefresh.refresh_token_expires_in,
    ).toBe(604_800);
  });
});

describe("end to end over fixtures", () => {
  test("archives a target copy of a source-archived message", () => {
    // The same email delivered to both accounts shares its Message-Id; a
    // target copy is modeled by reusing the source message's headers.
    const sourceMeta = metaFromMessage(gmailFixture.sourceMessage);
    const plan = planSync({
      sourceArchived: new Set([sourceMeta.mid!]),
      target: [
        { id: gmailFixture.targetMessage.id, ...sourceMeta },
        {
          id: "unmatched-target",
          ...metaFromMessage(gmailFixture.targetMessage),
        },
      ],
      junkAction: "archive",
    });
    expect(plan.archive).toEqual([gmailFixture.targetMessage.id]);
    expect(plan.unmatched).toBe(1);
  });
});
