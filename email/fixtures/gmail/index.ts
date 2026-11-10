/**
 * Golden Gmail and Google OAuth responses, captured live on 2026-11-10 and
 * anonymized (ids, Message-IDs, subjects, snippets, addresses, counts, and
 * tokens replaced; field names, nesting, and value types kept). Each fixture
 * is checked against its binding with `satisfies`, so `bun check` fails when
 * a fixture and its type drift apart.
 */
import type {
  GmailErrorResponse,
  GmailListMessagesResponse,
  GmailMessageMetadata,
  GmailProfile,
  OAuthTokenResponse,
} from "../../mail-state-sync.ts";
import error403Quota from "./error-403-quota.json";
import error404 from "./error-404.json";
import sourceList from "./source-list.json";
import sourceMessage from "./source-message-metadata.json";
import sourceProfile from "./source-profile.json";
import sourceTokenRefresh from "./source-token-refresh.json";
import targetListEmpty from "./target-list-empty.json";
import targetList from "./target-list.json";
import targetMessage from "./target-message-metadata.json";
import targetProfile from "./target-profile.json";
import targetTokenRefresh from "./target-token-refresh.json";

export const gmailFixtures = {
  sourceList: sourceList satisfies GmailListMessagesResponse,
  targetList: targetList satisfies GmailListMessagesResponse,
  targetListEmpty: targetListEmpty satisfies GmailListMessagesResponse,
  sourceMessage: sourceMessage satisfies GmailMessageMetadata,
  targetMessage: targetMessage satisfies GmailMessageMetadata,
  sourceProfile: sourceProfile satisfies GmailProfile,
  targetProfile: targetProfile satisfies GmailProfile,
  error404: error404 satisfies GmailErrorResponse,
  /** Code and message verbatim from a live run; body was truncated. */
  error403Quota: error403Quota satisfies GmailErrorResponse,
  sourceTokenRefresh: sourceTokenRefresh satisfies OAuthTokenResponse,
  targetTokenRefresh: targetTokenRefresh satisfies OAuthTokenResponse,
};
