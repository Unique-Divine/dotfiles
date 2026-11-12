/** Gmail JSONL bridge v1. stdout is reserved for protocol responses. */
import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  applyTokenRefresh, backoffMs, chunk, defaultCredentialsPath,
  isRetryableStatus, loopbackAuth, parseClientCredentials, scopeCovers,
  SCOPE_MODIFY, tokenPath, tokenRequest, writePrivateJson,
  type ClientCredentials, type StoredToken,
} from "./mail-state-sync.ts";

export type Json = Record<string, any>;
export interface BridgeRequest {
  version: 1; request_id: string; account: string; op: string; args: Json;
}
export class BridgeError extends Error {
  constructor(readonly code: string, message: string,
    readonly retryable = false, readonly status = 0) { super(message); }
}
export interface Runtime {
  fetch: typeof fetch;
  sleep(ms: number): Promise<void>;
  now(): number;
  random(): number;
}
const runtime: Runtime = {
  fetch, sleep: (ms) => Bun.sleep(ms), now: Date.now, random: Math.random,
};
// Current Gmail costs, including the May 2026 full/minimal distinction.
// https://developers.google.com/workspace/gmail/api/reference/quota
export const COST = {
  profile: 1, list: 5, history: 2, labels: 1, createLabel: 5,
  full: 60, minimal: 20, threadFull: 120, threadMinimal: 40,
  attachment: 20, modify: 50,
};
export class QuotaPacer {
  private projectNext = 0;
  private accounts = new Map<string, number>();
  constructor(readonly rt: Runtime = runtime,
    readonly accountBudget = 6000, readonly projectBudget = 1200000) {
    if (!(accountBudget > 0 && projectBudget > 0)) {
      throw new BridgeError("configuration", "Quota budgets must be positive");
    }
  }
  async reserve(account: string, units: number): Promise<void> {
    const now = this.rt.now();
    const start = Math.max(now, this.projectNext,
      this.accounts.get(account) ?? 0);
    this.projectNext = start + units * 60000 / this.projectBudget;
    this.accounts.set(account, start + units * 60000 / this.accountBudget);
    if (start > now) await this.rt.sleep(start - now);
  }
}
export function retryAfterMs(value: string | null, now: number): number {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}
function providerCode(status: number, text: string): string {
  try {
    const error = JSON.parse(text).error;
    const reason = error?.errors?.[0]?.reason ?? error?.status;
    if (typeof reason === "string" && new Set([
      "rateLimitExceeded", "userRateLimitExceeded", "quotaExceeded",
      "dailyLimitExceeded", "forbidden", "notFound", "insufficientPermissions",
      "PERMISSION_DENIED", "RESOURCE_EXHAUSTED", "NOT_FOUND",
      "INVALID_ARGUMENT", "UNAUTHENTICATED", "backendError",
    ]).has(reason)) {
      return reason;
    }
  } catch { /* Never expose arbitrary provider response text. */ }
  return `http_${status}`;
}
function retryableStatus(status: number, text: string): boolean {
  return isRetryableStatus(status, text) || status === 403 &&
    /quotaExceeded|RESOURCE_EXHAUSTED/i.test(text);
}
export function httpError(status: number, text: string): BridgeError {
  return new BridgeError(status === 401 ? "auth_required" :
    providerCode(status, text), `Gmail HTTP ${status}`,
    retryableStatus(status, text), status);
}
function stringArg(args: Json, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value) {
    throw new BridgeError("invalid_request", `${key} must be a nonempty string`);
  }
  return value;
}
function idArg(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new BridgeError("invalid_request", "Invalid provider ID");
  }
  return value;
}
function strings(args: Json, key: string): string[] {
  const value = args[key];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || !v)) {
    throw new BridgeError("invalid_request", `${key} must be an array of strings`);
  }
  return value;
}
export interface BatchChild {
  key: string; path: string; cost: number;
}
export interface ChildResult {
  key: string; status: number; data?: Json; text: string;
  retryAfter: string | null;
}
export function multipartRequest(children: BatchChild[], boundary: string): string {
  return children.map((child, index) =>
    `--${boundary}\r\nContent-Type: application/http\r\n` +
    `Content-ID: <req-${index}>\r\n\r\n` +
    `GET ${child.path} HTTP/1.1\r\n\r\n`).join("") +
    `--${boundary}--\r\n`;
}
export function parseMultipart(contentType: string, body: string,
  children: BatchChild[]): ChildResult[] {
  const boundary = /boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  const delimiter = boundary?.[1] ?? boundary?.[2];
  if (!delimiter) throw new BridgeError("batch_protocol", "Missing batch boundary");
  const results = new Map<number, ChildResult>();
  const escaped = delimiter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = body.split(new RegExp(`(?:^|\\r?\\n)--${escaped}(?:--)?(?:\\r?\\n|$)`));
  for (const part of parts.slice(1)) {
    if (!part.trim()) continue;
    const normalized = part.replace(/\r\n/g, "\n");
    const headEnd = normalized.indexOf("\n\n");
    if (headEnd < 0) throw new BridgeError("batch_protocol", "Invalid MIME child");
    const mimeHeaders = normalized.slice(0, headEnd);
    const cid = /^content-id:\s*<response-req-(\d+)>\s*$/im.exec(mimeHeaders);
    const index = cid ? Number(cid[1]) : -1;
    if (!children[index] || results.has(index)) {
      throw new BridgeError("batch_protocol", "Unknown or duplicate child ID");
    }
    const http = normalized.slice(headEnd + 2);
    const statusMatch = /^HTTP\/\d(?:\.\d)?\s+(\d{3})\b/.exec(http);
    const httpEnd = http.indexOf("\n\n");
    if (!statusMatch || httpEnd < 0) {
      throw new BridgeError("batch_protocol", "Invalid HTTP child");
    }
    const text = http.slice(httpEnd + 2).trim();
    const status = Number(statusMatch[1]);
    let data: Json | undefined;
    if (status >= 200 && status < 300) {
      try { data = text ? JSON.parse(text) : {}; }
      catch { throw new BridgeError("batch_protocol", "Invalid child JSON"); }
    }
    results.set(index, { key: children[index]!.key, status, text, data,
      retryAfter: /^retry-after:\s*(.+)$/im.exec(http.slice(0, httpEnd))?.[1] ?? null });
  }
  return children.map((child, index) => results.get(index) ?? {
    key: child.key, status: 0, text: "", retryAfter: null,
  });
}

export interface GmailClientOptions {
  apiBase?: string; batchUrl?: string; rt?: Runtime; pacer?: QuotaPacer;
  refresh?: () => Promise<string>;
}
/** Authenticated HTTP client. No provider bodies enter diagnostics/errors. */
export class GmailClient {
  readonly rt: Runtime;
  readonly pacer: QuotaPacer;
  readonly apiBase: string;
  readonly batchUrl: string;
  private invalidToken = false;
  constructor(readonly account: string,
    private getToken: () => Promise<string>, options: GmailClientOptions = {}) {
    this.rt = options.rt ?? runtime;
    this.pacer = options.pacer ?? new QuotaPacer(this.rt);
    this.apiBase = options.apiBase ?? "https://gmail.googleapis.com/gmail/v1/users/me";
    this.batchUrl = options.batchUrl ?? "https://gmail.googleapis.com/batch/gmail/v1";
    this.refresh = options.refresh;
  }
  private refresh?: () => Promise<string>;
  async request(url: string, cost: number, init: RequestInit = {},
    safeRetry = true): Promise<Response> {
    for (let attempt = 0; attempt < 5; attempt++) {
      await this.pacer.reserve(this.account, cost);
      let token: string;
      try {
        token = this.invalidToken && this.refresh
          ? await this.refresh() : await this.getToken();
        this.invalidToken = false;
      } catch {
        throw new BridgeError("auth_required", "Gmail authorization needs renewal");
      }
      let response: Response;
      try {
        response = await this.rt.fetch(url, { ...init,
          signal: AbortSignal.timeout(60000),
          headers: { ...Object.fromEntries(new Headers(init.headers)),
            authorization: `Bearer ${token}` } });
      } catch {
        if (!safeRetry) throw new BridgeError("uncertain_result",
          "Request outcome is unknown; reconcile before retrying");
        if (attempt === 4) throw new BridgeError("network_error",
          "Gmail network request failed", true);
        await this.rt.sleep(backoffMs(attempt, this.rt.random()));
        continue;
      }
      if (response.ok) return response;
      const text = await response.text();
      if (response.status === 401 && attempt < 4 && this.refresh) {
        this.invalidToken = true;
        continue;
      }
      const error = httpError(response.status, text);
      if (error.retryable && (safeRetry || response.status === 403 ||
        response.status === 429) && attempt < 4) {
        await this.rt.sleep(Math.max(
          retryAfterMs(response.headers.get("retry-after"), this.rt.now()),
          backoffMs(attempt, this.rt.random())));
        continue;
      }
      if (!safeRetry && response.status >= 500) {
        throw new BridgeError("uncertain_result",
          "Gmail server result is unknown; reconcile before retrying");
      }
      throw error;
    }
    throw new BridgeError("auth_required", "Gmail authorization failed");
  }
  async call(path: string, cost: number, method = "GET", body?: Json,
    safeRetry = true): Promise<Json> {
    const response = await this.request(this.apiBase + path, cost, {
      method, ...(body ? { headers: { "content-type": "application/json" },
        body: JSON.stringify(body) } : {}),
    }, safeRetry);
    let text: string;
    try { text = await response.text(); }
    catch { throw new BridgeError(safeRetry ? "network_error" : "uncertain_result",
      safeRetry ? "Gmail response could not be read" :
        "Gmail response is unreadable; reconcile before retrying", safeRetry); }
    try { return text ? JSON.parse(text) : {}; }
    catch { throw new BridgeError(safeRetry ? "provider_protocol" : "uncertain_result",
      safeRetry ? "Invalid Gmail JSON" :
        "Gmail response is invalid; reconcile before retrying"); }
  }
  async batch(children: BatchChild[]): Promise<ChildResult[]> {
    const complete: ChildResult[] = [];
    for (const group of chunk(children, 50)) {
      let pending = group;
      for (let attempt = 0; pending.length && attempt < 5; attempt++) {
        const boundary = `ud_mail_${randomUUID().replaceAll("-", "")}`;
        const response = await this.request(this.batchUrl,
          pending.reduce((n, child) => n + child.cost, 0), {
            method: "POST", headers: {
              "content-type": `multipart/mixed; boundary=${boundary}`,
            }, body: multipartRequest(pending, boundary),
          });
        const results = parseMultipart(response.headers.get("content-type") ?? "",
          await response.text(), pending);
        const retry: BatchChild[] = [];
        let wait = 0;
        for (let i = 0; i < results.length; i++) {
          const result = results[i]!;
          const retryable = result.status === 0 || result.status === 401 ||
            retryableStatus(result.status, result.text);
          if (retryable && attempt < 4) {
            if (result.status === 401 && this.refresh) this.invalidToken = true;
            retry.push(pending[i]!);
            wait = Math.max(wait, retryAfterMs(result.retryAfter, this.rt.now()));
          } else complete.push(result);
        }
        pending = retry;
        if (pending.length) await this.rt.sleep(Math.max(wait,
          backoffMs(attempt, this.rt.random())));
      }
    }
    return complete;
  }
  childPath(path: string): string {
    return new URL(this.apiBase).pathname + path;
  }
}

export interface BodyObservation {
  message_id: string; part_id: string; attachment_id: string;
  mime_type: string; body: Json;
}
function textBodies(message: Json): { part: Json; path: string }[] {
  const found: { part: Json; path: string }[] = [];
  function visit(part: Json): void {
    const disposition = part.headers?.find((h: Json) =>
      String(h.name).toLowerCase() === "content-disposition")?.value ?? "";
    if (/^text\/(plain|html)$/i.test(part.mimeType ?? "") &&
      !part.filename && !/^attachment\b/i.test(disposition) &&
      part.body?.attachmentId && part.body?.data === undefined) {
      found.push({ part, path: `/messages/${idArg(message.id)}/attachments/` +
        encodeURIComponent(idArg(part.body.attachmentId)) });
    }
    for (const child of part.parts ?? []) visit(child);
  }
  if (message.payload) visit(message.payload);
  return found;
}
export async function fetchMessages(client: GmailClient, ids: string[],
  format: "full" | "minimal", entity: "messages" | "threads" = "messages"): Promise<Json> {
  const unique = [...new Set(ids.map(idArg))];
  const messages: Json[] = [];
  const failures: Json[] = [];
  const observations: BodyObservation[] = [];
  const missing = new Map<string, string[]>();
  for (const group of chunk(unique, 50)) {
    let results: ChildResult[];
    try {
      results = await client.batch(group.map((id) => ({ key: id,
        path: client.childPath(`/${entity}/${id}?format=${format}`),
        cost: entity === "messages" ? COST[format] :
          format === "full" ? COST.threadFull : COST.threadMinimal })));
    } catch (error) {
      const e = safeError(error);
      failures.push(...group.map((id) => ({ id, status:
        error instanceof BridgeError ? error.status : 0, ...e })));
      continue;
    }
    for (const result of results) {
      if (result.status >= 200 && result.status < 300 && result.data?.id === result.key) {
        messages.push(result.data);
      } else failures.push({ id: result.key, status: result.status,
        code: result.status === 0 ? "missing_batch_part" :
          result.status >= 200 && result.status < 300 ? "identity_mismatch" :
          providerCode(result.status, result.text),
        message: `Message fetch failed with status ${result.status}` });
    }
  }
  if (format === "full") {
    const sourceMessages = entity === "messages" ? messages :
      messages.flatMap((thread) => thread.messages ?? []);
    const bodies = sourceMessages.flatMap((message) => textBodies(message).map((body) =>
      ({ ...body, message_id: message.id })));
    for (const group of chunk(bodies, 50)) {
      let results: ChildResult[];
      try {
        results = await client.batch(group.map((body, i) => ({ key: String(i),
          path: client.childPath(body.path), cost: COST.attachment })));
      } catch (error) {
        for (const body of group) {
          const parts = missing.get(body.message_id) ?? [];
          parts.push(String(body.part.partId ?? body.part.body.attachmentId));
          missing.set(body.message_id, parts);
        }
        continue;
      }
      for (const result of results) {
        const body = group[Number(result.key)]!;
        const ok = result.status >= 200 && result.status < 300 &&
          typeof result.data?.data === "string";
        if (ok) observations.push({ message_id: body.message_id,
          part_id: String(body.part.partId ?? ""),
          attachment_id: body.part.body.attachmentId,
          mime_type: body.part.mimeType, body: result.data! });
        else {
          const parts = missing.get(body.message_id) ?? [];
          parts.push(String(body.part.partId ?? body.part.body.attachmentId));
          missing.set(body.message_id, parts);
        }
      }
    }
  }
  return { [entity]: messages, failures, text_parts: observations,
    completeness: format === "minimal" ? [] :
      (entity === "messages" ? messages : messages.flatMap((thread) =>
        thread.messages ?? [])).map((message: Json) => ({
      id: message.id, content_complete: Boolean(message.payload) && !missing.has(message.id),
      missing_text_parts: message.payload ? missing.get(message.id) ?? [] : ["missing_payload"],
    })) };
}

export function unsubscribeTarget(message: Json): URL {
  const headers = message.payload?.headers ?? [];
  const values = (name: string): string[] => headers.filter((h: Json) =>
    String(h.name).toLowerCase() === name).map((h: Json) => String(h.value));
  const from = values("from").join(" ");
  if (values("x-google-group-id").length || values("x-groupsio-msgnum").length ||
    values("x-beenthere").length || values("x-mailman-version").length ||
    values("list-post").some((v) => !/^\s*NO\s*$/i.test(v)) ||
    /@(googlegroups\.com|groups\.io|groups\.google\.com)\b/i.test(from) ||
    values("list-id").some((v) => /\.(googlegroups\.com|groups\.io)>?\s*$/i.test(v))) {
    throw new BridgeError("group_unsubscribe", "Group membership unsubscribe is unsupported");
  }
  if (values("list-unsubscribe-post").length !== 1 ||
    !/^\s*List-Unsubscribe=One-Click\s*$/i.test(values("list-unsubscribe-post")[0]!)) {
    throw new BridgeError("unsupported_unsubscribe", "Declared HTTP one-click is required");
  }
  const unsub = values("list-unsubscribe");
  if (unsub.length !== 1) throw new BridgeError("unsupported_unsubscribe",
    "A single List-Unsubscribe header is required");
  const urls = [...unsub[0]!.matchAll(/<([^<>]+)>/g)].map((m) => m[1]!)
    .filter((url) => /^https:/i.test(url));
  if (urls.length !== 1) throw new BridgeError("unsupported_unsubscribe",
    "A single HTTPS unsubscribe URL is required");
  let url: URL;
  try { url = new URL(urls[0]!); }
  catch { throw new BridgeError("unsupported_unsubscribe", "Invalid unsubscribe URL"); }
  // Never contact workstation/local services based on untrusted mail headers.
  if (/(^|\.)(groups\.google\.com|googlegroups\.com|groups\.io)$/i.test(url.hostname)) {
    throw new BridgeError("group_unsubscribe", "Group destination unsubscribe is unsupported");
  }
  if (url.username || url.password || url.port && url.port !== "443" ||
    !url.hostname.includes(".") || /^\d+(\.\d+){3}$/.test(url.hostname) ||
    url.hostname.startsWith("[") ||
    /\.(localhost|local|internal|test|invalid)$/i.test(url.hostname)) {
    throw new BridgeError("unsupported_unsubscribe", "Unsupported unsubscribe host");
  }
  return url;
}
export function publicAddress(address: string): boolean {
  if (address.includes(":")) {
    // IPv6 global unicast only. Reject mapped IPv4 and local/link-local space.
    return /^[23][0-9a-f]{0,3}:/i.test(address) &&
      !/^2001:db8:/i.test(address);
  }
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts;
  return a !== 0 && a !== 10 && a !== 127 && a! < 224 &&
    !(a === 169 && b === 254) && !(a === 172 && b! >= 16 && b! <= 31) &&
    !(a === 192 && b === 168) && !(a === 100 && b! >= 64 && b! <= 127);
}
export async function unsubscribe(client: GmailClient, messageId: string,
  externalFetch: typeof fetch = fetch,
  resolveHost: (host: string) => Promise<string[]> = async (host) =>
    (await lookup(host, { all: true })).map((record) => record.address)): Promise<Json> {
  const message = await client.call(`/messages/${idArg(messageId)}?format=full`, COST.full);
  if (message.id !== messageId) throw new BridgeError("identity_mismatch", "Message ID mismatch");
  const url = unsubscribeTarget(message);
  let addresses: string[];
  try { addresses = await resolveHost(url.hostname); }
  catch { return { method: "http_one_click", outcome: "not_attempted", reason: "dns_failed" }; }
  if (!addresses.length || addresses.some((address) => !publicAddress(address))) {
    throw new BridgeError("unsupported_unsubscribe", "Unsubscribe host is not public");
  }
  try {
    const response = await externalFetch(url, {
      method: "POST", redirect: "manual", credentials: "omit",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "List-Unsubscribe=One-Click", signal: AbortSignal.timeout(30000),
    });
    await response.body?.cancel();
    return { method: "http_one_click", outcome: response.ok ? "success" :
      response.status >= 500 ? "uncertain" : "rejected", status: response.status };
  } catch {
    return { method: "http_one_click", outcome: "uncertain" };
  }
}

export interface ConnectionOptions {
  home?: string; credentialsPath?: string; tokenDir?: string;
  pacer?: QuotaPacer; rt?: Runtime;
}
export async function connectAccount(account: string, interactive: boolean,
  options: ConnectionOptions = {}): Promise<GmailClient> {
  const home = options.home ?? homedir();
  const path = options.tokenDir ? join(options.tokenDir, `${account}.json`) : tokenPath(account, home);
  let token: StoredToken | null = null;
  try { token = JSON.parse(await readFile(path, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new BridgeError("auth_required", "Cannot read stored Gmail authorization");
    }
  }
  const adequate = token?.email?.toLowerCase() === account &&
    token?.refreshToken && scopeCovers(token.scope ?? "", SCOPE_MODIFY);
  if (!adequate && !interactive) {
    throw new BridgeError("auth_required", "Gmail modify authorization is required");
  }
  let creds: ClientCredentials;
  try {
    creds = parseClientCredentials(JSON.parse(await readFile(
      options.credentialsPath ?? defaultCredentialsPath(home), "utf8")));
  } catch {
    throw new BridgeError("auth_required", "Gmail OAuth client credentials are unavailable");
  }
  let fresh = false;
  if (!adequate) {
    try { token = await loopbackAuth(creds, account, SCOPE_MODIFY, "mail", console.error); }
    catch { throw new BridgeError("auth_required", "Gmail authorization failed"); }
    fresh = true;
  }
  const refresh = async (): Promise<string> => {
    const body = await tokenRequest({ client_id: creds.clientId,
      client_secret: creds.clientSecret, refresh_token: token!.refreshToken,
      grant_type: "refresh_token" });
    token = applyTokenRefresh(token!, body, Date.now());
    if (token.email.toLowerCase() !== account || !scopeCovers(token.scope, SCOPE_MODIFY)) {
      throw new BridgeError("auth_required", "Gmail authorization scope or identity changed");
    }
    await writePrivateJson(path, token);
    return token.accessToken;
  };
  const client = new GmailClient(account, async () =>
    Date.now() < token!.expiresAt - 60000 ? token!.accessToken : refresh(), {
      refresh, rt: options.rt, pacer: options.pacer,
    });
  const profile = await client.call("/profile", COST.profile);
  if (String(profile.emailAddress).toLowerCase() !== account) {
    throw new BridgeError("identity_mismatch", "Signed-in mailbox differs from requested account");
  }
  if (fresh) await writePrivateJson(path, token);
  return client;
}
export function safeError(error: unknown): {
  code: string; message: string; retryable: boolean;
} {
  return error instanceof BridgeError ? { code: error.code,
    message: error.message, retryable: error.retryable } : {
    code: "internal_error", message: "Bridge operation failed", retryable: false,
  };
}
export class GmailBridge {
  private clients = new Map<string, GmailClient>();
  constructor(private connector = connectAccount,
    private options: ConnectionOptions = {}) {}
  async handle(input: unknown): Promise<Json> {
    const raw = input as Partial<BridgeRequest> | null;
    const envelope = { version: 1, request_id: typeof raw?.request_id === "string"
      ? raw.request_id : null };
    try {
      if (!raw || raw.version !== 1 || typeof raw.request_id !== "string" ||
        typeof raw.account !== "string" ||
        !/^[A-Za-z0-9.!#$%&'*+=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(raw.account) ||
        !raw.args || typeof raw.args !== "object" || Array.isArray(raw.args)) {
        throw new BridgeError("invalid_request", "Invalid bridge v1 envelope");
      }
      const account = raw.account.toLowerCase();
      const args = raw.args;
      let client = this.clients.get(account);
      if (raw.op === "connect") {
        if (typeof args.interactive !== "boolean") {
          throw new BridgeError("invalid_request", "interactive must be boolean");
        }
        client = await this.connector(account, args.interactive, this.options);
        this.clients.set(account, client);
        return { ...envelope, ok: true,
          data: await client.call("/profile", COST.profile) };
      }
      const allowed = new Set(["profile", "list", "fetch", "threads", "history", "labels",
        "create_labels", "modify", "unsubscribe"]);
      if (!allowed.has(raw.op ?? "")) throw new BridgeError("invalid_request", "Unknown bridge operation");
      if (!client) {
        client = await this.connector(account, false, this.options);
        this.clients.set(account, client);
      }
      let data: Json;
      switch (raw.op) {
        case "profile": data = await client.call("/profile", COST.profile); break;
        case "list": {
          const count = args.max_results ?? 500;
          if (!Number.isInteger(count) || count < 1 || count > 500 ||
            args.include_spam_trash !== undefined && typeof args.include_spam_trash !== "boolean") {
            throw new BridgeError("invalid_request", "Invalid list bounds");
          }
          const query = new URLSearchParams({ maxResults: String(count),
            includeSpamTrash: String(args.include_spam_trash ?? true) });
          if (args.query !== undefined) query.set("q", stringArg(args, "query"));
          if (args.page_token !== undefined) query.set("pageToken", stringArg(args, "page_token"));
          data = await client.call(`/messages?${query}`, COST.list); break;
        }
        case "fetch":
        case "threads": {
          if (args.format !== "full" && args.format !== "minimal") {
            throw new BridgeError("invalid_request", "format must be full or minimal");
          }
          data = await fetchMessages(client, strings(args, "ids"), args.format,
            raw.op === "threads" ? "threads" : "messages"); break;
        }
        case "history": {
          const query = new URLSearchParams({ startHistoryId: stringArg(args, "start_history_id"), maxResults: "500" });
          if (args.page_token !== undefined) query.set("pageToken", stringArg(args, "page_token"));
          try { data = await client.call(`/history?${query}`, COST.history); }
          catch (error) {
            if (error instanceof BridgeError && error.status === 404) {
              throw new BridgeError("history_expired", "Gmail history checkpoint expired");
            }
            throw error;
          }
          break;
        }
        case "labels": data = await client.call("/labels", COST.labels); break;
        case "create_labels": {
          const names = [...new Set(strings(args, "names"))];
          const catalog = await client.call("/labels", COST.labels);
          const labels: Json[] = [];
          for (const name of names) {
            let label = catalog.labels?.find((item: Json) => item.name === name);
            if (!label) {
              try { label = await client.call("/labels", COST.createLabel, "POST", { name }, false); }
              catch (error) {
                if (!(error instanceof BridgeError) || error.status !== 409) throw error;
                const updated = await client.call("/labels", COST.labels);
                label = updated.labels?.find((item: Json) => item.name === name);
                if (!label) throw error;
              }
            }
            labels.push(label);
          }
          data = { labels }; break;
        }
        case "modify": {
          const ids = strings(args, "ids").map(idArg);
          if (!ids.length || ids.length > 1000) {
            throw new BridgeError("invalid_request", "modify requires 1 to 1000 IDs");
          }
          const addLabelIds = strings(args, "add_label_ids").map(idArg);
          const removeLabelIds = strings(args, "remove_label_ids").map(idArg);
          if (addLabelIds.some((id) => removeLabelIds.includes(id))) {
            throw new BridgeError("invalid_request", "Conflicting label changes");
          }
          data = await client.call("/messages/batchModify", COST.modify, "POST",
            { ids, addLabelIds, removeLabelIds }, false); break;
        }
        case "unsubscribe": data = await unsubscribe(client,
          idArg(stringArg(args, "message_id"))); break;
        default: throw new BridgeError("invalid_request", "Unknown bridge operation");
      }
      return { ...envelope, ok: true, data };
    } catch (error) { return { ...envelope, ok: false, error: safeError(error) }; }
  }
}
export async function main(): Promise<void> {
  const positive = (name: string, fallback: number): number => {
    const value = Number(process.env[name] ?? fallback);
    if (!Number.isFinite(value) || value <= 0) throw new Error("Invalid quota configuration");
    return value;
  };
  const bridge = new GmailBridge(connectAccount, {
    credentialsPath: process.env.UD_MAIL_CREDENTIALS,
    tokenDir: process.env.UD_MAIL_TOKEN_DIR,
    pacer: new QuotaPacer(runtime, positive("UD_MAIL_ACCOUNT_QUOTA", 6000),
      positive("UD_MAIL_PROJECT_QUOTA", 1200000)),
  });
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let result: Json;
    try { result = await bridge.handle(JSON.parse(line)); }
    catch { result = { version: 1, request_id: null, ok: false,
      error: { code: "invalid_json", message: "Expected one JSON object per line", retryable: false } }; }
    process.stdout.write(JSON.stringify(result) + "\n");
  }
}
if (import.meta.main) main().catch(() => {
  console.error("Gmail bridge failed to initialize"); process.exitCode = 1;
});
