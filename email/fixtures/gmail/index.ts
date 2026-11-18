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
import error403QuotaJson from "./error-403-quota.json";
import error404Json from "./error-404.json";
import sourceListJson from "./source-list.json";
import sourceMessageJson from "./source-message-metadata.json";
import sourceProfileJson from "./source-profile.json";
import sourceTokenRefreshJson from "./source-token-refresh.json";
import targetListEmptyJson from "./target-list-empty.json";
import targetListJson from "./target-list.json";
import targetMessageJson from "./target-message-metadata.json";
import targetProfileJson from "./target-profile.json";
import targetTokenRefreshJson from "./target-token-refresh.json";

export const sourceList = sourceListJson satisfies GmailListMessagesResponse;
export const targetList = targetListJson satisfies GmailListMessagesResponse;
export const targetListEmpty =
  targetListEmptyJson satisfies GmailListMessagesResponse;
export const sourceMessage = sourceMessageJson satisfies GmailMessageMetadata;
export const targetMessage = targetMessageJson satisfies GmailMessageMetadata;
export const sourceProfile = sourceProfileJson satisfies GmailProfile;
export const targetProfile = targetProfileJson satisfies GmailProfile;
export const error404 = error404Json satisfies GmailErrorResponse;
/** Code and message verbatim from a live run; body was truncated. */
export const error403Quota = error403QuotaJson satisfies GmailErrorResponse;
export const sourceTokenRefresh =
  sourceTokenRefreshJson satisfies OAuthTokenResponse;
export const targetTokenRefresh =
  targetTokenRefreshJson satisfies OAuthTokenResponse;
