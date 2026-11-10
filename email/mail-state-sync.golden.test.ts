/**
 * Golden tests: real Gmail and Google OAuth responses, captured live on
 * 2026-11-10 and anonymized (ids, Message-IDs, subjects, snippets, addresses,
 * counts, and tokens replaced; field names, nesting, and value types kept).
 * Each import is checked against its binding with `satisfies`, so `bun check`
 * fails if a fixture and its type drift apart. No HTTP calls.
 */
import { describe, expect, test } from "bun:test";

import error403Quota from "./fixtures/gmail/error-403-quota.json";
import error404 from "./fixtures/gmail/error-404.json";
import sourceList from "./fixtures/gmail/source-list.json";
import sourceMessage from "./fixtures/gmail/source-message-metadata.json";
import sourceProfile from "./fixtures/gmail/source-profile.json";
import sourceTokenRefresh from "./fixtures/gmail/source-token-refresh.json";
import targetListEmpty from "./fixtures/gmail/target-list-empty.json";
import targetList from "./fixtures/gmail/target-list.json";
import targetMessage from "./fixtures/gmail/target-message-metadata.json";
import targetProfile from "./fixtures/gmail/target-profile.json";
import targetTokenRefresh from "./fixtures/gmail/target-token-refresh.json";
import {
  applyTokenRefresh,
  idsFromListPage,
  isQuotaExceeded,
  isRetryableStatus,
  metaFromMessage,
  parseGmailError,
  planSync,
  retryDelayMs,
  type GmailErrorResponse,
  type GmailListMessagesResponse,
  type GmailMessageMetadata,
  type GmailProfile,
  type OAuthTokenResponse,
  type StoredToken,
} from "./mail-state-sync.ts";

const fx = {
  sourceList: sourceList satisfies GmailListMessagesResponse,
  targetList: targetList satisfies GmailListMessagesResponse,
  targetListEmpty: targetListEmpty satisfies GmailListMessagesResponse,
  sourceMessage: sourceMessage satisfies GmailMessageMetadata,
  targetMessage: targetMessage satisfies GmailMessageMetadata,
  sourceProfile: sourceProfile satisfies GmailProfile,
  targetProfile: targetProfile satisfies GmailProfile,
  error404: error404 satisfies GmailErrorResponse,
  error403Quota: error403Quota satisfies GmailErrorResponse,
  sourceTokenRefresh: sourceTokenRefresh satisfies OAuthTokenResponse,
  targetTokenRefresh: targetTokenRefresh satisfies OAuthTokenResponse,
};

describe("users.messages.list", () => {
  test("returns the ids of a page", () => {
    expect(idsFromListPage(fx.sourceList)).toEqual(
      fx.sourceList.messages.map((m) => m.id),
    );
    expect(fx.sourceList.nextPageToken).toBeString();
  });

  test("an empty match omits the messages key", () => {
    expect("messages" in fx.targetListEmpty).toBe(false);
    expect(idsFromListPage(fx.targetListEmpty)).toEqual([]);
  });
});

describe("users.messages.get format=metadata", () => {
  test("reads Message-Id in Gmail's casing and normalizes it", () => {
    const names = fx.targetMessage.payload.headers.map((h) => h.name);
    expect(names).toContain("Message-Id");
    expect(metaFromMessage(fx.targetMessage)).toEqual({
      mid: "fixture-target-2@mail.example.com",
      subject: "Fixture subject 2",
    });
  });

  test("ids and dates are strings, size is a number", () => {
    expect(fx.sourceMessage.historyId).toBeString();
    expect(fx.sourceMessage.internalDate).toMatch(/^\d+$/);
    expect(fx.sourceMessage.sizeEstimate).toBeNumber();
  });
});

describe("users.getProfile", () => {
  test("carries the signed-in address", () => {
    expect(fx.sourceProfile.emailAddress).toContain("@");
    expect(fx.targetProfile.historyId).toBeString();
  });
});

describe("errors", () => {
  test("parses the 404 envelope and leaves it non-retryable", () => {
    const text = JSON.stringify(fx.error404);
    expect(parseGmailError(text)?.error.status).toBe("NOT_FOUND");
    expect(isRetryableStatus(404, text)).toBe(false);
  });

  test("a quota 403 is retryable and waits out the minute", () => {
    const text = JSON.stringify(fx.error403Quota);
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
      scope: fx.targetTokenRefresh.scope,
      refreshToken: "fixture-refresh-token",
      accessToken: "old",
      expiresAt: 0,
    };
    const next = applyTokenRefresh(stored, fx.targetTokenRefresh, 1_000);
    expect(next.accessToken).toBe(fx.targetTokenRefresh.access_token);
    expect(next.expiresAt).toBe(1_000 + fx.targetTokenRefresh.expires_in * 1000);
    expect(next.refreshToken).toBe(stored.refreshToken);
  });

  test("Testing-mode apps get 7-day refresh tokens", () => {
    expect(fx.sourceTokenRefresh.refresh_token_expires_in).toBe(604_800);
  });
});

describe("end to end over fixtures", () => {
  test("archives a target copy of a source-archived message", () => {
    // The same email delivered to both accounts shares its Message-Id; a
    // target copy is modeled by reusing the source message's headers.
    const sourceMeta = metaFromMessage(fx.sourceMessage);
    const plan = planSync({
      sourceArchived: new Set([sourceMeta.mid!]),
      target: [
        { id: fx.targetMessage.id, ...sourceMeta },
        { id: "unmatched-target", ...metaFromMessage(fx.targetMessage) },
      ],
      junkAction: "archive",
    });
    expect(plan.archive).toEqual([fx.targetMessage.id]);
    expect(plan.unmatched).toBe(1);
  });
});
