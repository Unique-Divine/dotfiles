/**
 * Mirror "archived" (Done) state from one Gmail account to another.
 *
 * Mail from the source account already sits in the target account (import
 * plus forwarding), but it lands in the target INBOX even when it was
 * archived in the source. This script archives a target inbox message only
 * when a source message with the same Message-ID header is archived
 * (positive evidence). Target messages without a source match are never
 * touched.
 *
 * Dry run by default; `--run` applies changes.
 *
 * Usage:
 *   bun run email/mail-state-sync.ts --source a@gmail.com \
 *     --target b@example.com [--run] [--include-junk]
 *     [--junk-action archive|trash] [--target-query 'in:inbox']
 *     [--no-cache] [--limit N] [--credentials PATH]
 */
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
export const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const SCOPE_READONLY =
  "https://www.googleapis.com/auth/gmail.readonly";
export const SCOPE_MODIFY = "https://www.googleapis.com/auth/gmail.modify";

export const SOURCE_ARCHIVED_QUERY = "-in:inbox -in:spam -in:trash";
export const DEFAULT_TARGET_QUERY = "in:inbox";
export const BATCH_MODIFY_MAX = 1000;
export const FETCH_CONCURRENCY = 20;
export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

const SCRIPT = "email/mail-state-sync.ts";

// ---------------------------------------------------------------------------
// Colors (named ANSI only)
// ---------------------------------------------------------------------------

const useColor: boolean =
  !process.env.NO_COLOR && Boolean(process.stdout.isTTY);

function paint(code: number, text: string): string {
  return useColor ? `\x1b[${code}m${text}\x1b[0m` : text;
}

export const c = {
  red: (s: string): string => paint(31, s),
  green: (s: string): string => paint(32, s),
  yellow: (s: string): string => paint(33, s),
  cyan: (s: string): string => paint(36, s),
  bold: (s: string): string => paint(1, s),
};

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

export type JunkAction = "archive" | "trash";

export interface Options {
  source: string;
  target: string;
  run: boolean;
  includeJunk: boolean;
  junkAction: JunkAction;
  targetQuery: string;
  useCache: boolean;
  limit: number | null;
  credentials: string;
  help: boolean;
}

export const USAGE = `Usage: bun run ${SCRIPT} --source EMAIL --target EMAIL
  [--run] [--include-junk] [--junk-action archive|trash]
  [--target-query 'in:inbox'] [--no-cache] [--limit N]
  [--credentials PATH]

Archives target inbox messages whose Message-ID is archived in the source.
Dry run unless --run is given.`;

export function defaultCredentialsPath(home: string = homedir()): string {
  return join(home, ".config", "gmailctl-ud", "credentials.json");
}

function isEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

/** Parse CLI args. Throws an Error with a user-facing message. */
export function parseArgs(
  argv: string[],
  home: string = homedir(),
): Options {
  const opts: Options = {
    source: "",
    target: "",
    run: false,
    includeJunk: false,
    junkAction: "archive",
    targetQuery: DEFAULT_TARGET_QUERY,
    useCache: true,
    limit: null,
    credentials: defaultCredentialsPath(home),
    help: false,
  };
  const takeValue = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) {
      throw new Error(`${flag} needs a value`);
    }
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!;
    const eq = raw.indexOf("=");
    const flag = raw.startsWith("--") && eq > 0 ? raw.slice(0, eq) : raw;
    const inline = raw.startsWith("--") && eq > 0 ? raw.slice(eq + 1) : null;
    const value = (): string => {
      if (inline !== null) return inline;
      const v = takeValue(i, flag);
      i++;
      return v;
    };
    switch (flag) {
      case "-h":
      case "--help":
        opts.help = true;
        break;
      case "--source":
        opts.source = value().trim().toLowerCase();
        break;
      case "--target":
        opts.target = value().trim().toLowerCase();
        break;
      case "--run":
        opts.run = true;
        break;
      case "--include-junk":
        opts.includeJunk = true;
        break;
      case "--junk-action": {
        const v = value();
        if (v !== "archive" && v !== "trash") {
          throw new Error(`--junk-action must be archive or trash: ${v}`);
        }
        opts.junkAction = v;
        break;
      }
      case "--target-query":
        opts.targetQuery = value();
        break;
      case "--no-cache":
        opts.useCache = false;
        break;
      case "--limit": {
        const v = value();
        const n = Number(v);
        if (!Number.isInteger(n) || n <= 0) {
          throw new Error(`--limit must be a positive integer: ${v}`);
        }
        opts.limit = n;
        break;
      }
      case "--credentials":
        opts.credentials = value();
        break;
      default:
        throw new Error(`unknown argument: ${raw}`);
    }
  }
  if (opts.help) return opts;
  if (!opts.source || !opts.target) {
    throw new Error("--source and --target are required");
  }
  for (const [k, v] of [
    ["--source", opts.source],
    ["--target", opts.target],
  ] as const) {
    if (!isEmail(v)) throw new Error(`${k} is not an email address: ${v}`);
  }
  if (opts.source === opts.target) {
    throw new Error("--source and --target must differ");
  }
  if (opts.junkAction === "trash" && !opts.includeJunk) {
    throw new Error("--junk-action trash requires --include-junk");
  }
  return opts;
}

/** Quote a word for zsh/bash when it holds shell-special characters. */
export function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The exact command that applies the dry-run plan. */
export function formatRunCommand(opts: Options): string {
  const parts = [
    "bun",
    "run",
    SCRIPT,
    "--source",
    opts.source,
    "--target",
    opts.target,
  ];
  if (opts.includeJunk) parts.push("--include-junk");
  if (opts.junkAction !== "archive") {
    parts.push("--junk-action", opts.junkAction);
  }
  if (opts.targetQuery !== DEFAULT_TARGET_QUERY) {
    parts.push("--target-query", opts.targetQuery);
  }
  if (!opts.useCache) parts.push("--no-cache");
  if (opts.limit !== null) parts.push("--limit", String(opts.limit));
  if (opts.credentials !== defaultCredentialsPath()) {
    parts.push("--credentials", opts.credentials);
  }
  parts.push("--run");
  return parts.map(shellQuote).join(" ");
}

// ---------------------------------------------------------------------------
// Message-ID handling and planning (pure)
// ---------------------------------------------------------------------------

/**
 * Normalize a Message-ID header: trim, strip angle brackets, lowercase.
 * Returns null when nothing usable remains.
 */
export function normalizeMessageId(
  raw: string | null | undefined,
): string | null {
  if (raw == null) return null;
  let s = raw.trim();
  const m = /<([^<>]*)>/.exec(s);
  if (m) s = m[1]!;
  s = s.replace(/^<+|>+$/g, "").trim().toLowerCase();
  return s.length > 0 ? s : null;
}

/** Cached header data for one Gmail message, keyed by Gmail id. */
// ---------------------------------------------------------------------------
// Gmail REST v1 and Google OAuth response bindings
// ---------------------------------------------------------------------------
// Shapes match responses captured live on 2026-11-10; anonymized copies live
// in email/fixtures/gmail/ and keep these types honest in tests.

/** An entry in users.messages.list. */
export interface GmailMessageRef {
  id: string;
  threadId: string;
}

/** users.messages.list. `messages` is absent when nothing matches. */
export interface GmailListMessagesResponse {
  messages?: GmailMessageRef[];
  nextPageToken?: string;
  resultSizeEstimate: number;
}

export interface GmailHeader {
  name: string;
  value: string;
}

/** users.messages.get with format=metadata. */
export interface GmailMessageMetadata {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet: string;
  payload: { mimeType: string; headers: GmailHeader[] };
  sizeEstimate: number;
  /** Decimal string, not a number. */
  historyId: string;
  /** Epoch milliseconds as a decimal string. */
  internalDate: string;
}

/** users.getProfile. */
export interface GmailProfile {
  emailAddress: string;
  messagesTotal: number;
  threadsTotal: number;
  historyId: string;
}

/** Error envelope for non-2xx Gmail responses. */
export interface GmailErrorResponse {
  error: {
    code: number;
    message: string;
    errors: { message: string; domain?: string; reason?: string }[];
    status?: string;
  };
}

/** Google OAuth token endpoint response (code exchange or refresh). */
export interface OAuthTokenResponse {
  access_token: string;
  expires_in: number;
  scope: string;
  token_type: string;
  /** Present on code exchange; usually absent on refresh. */
  refresh_token?: string;
  /** Present for apps in Testing mode, where refresh tokens last 7 days. */
  refresh_token_expires_in?: number;
}

/** Gmail ids from one list page; an empty match has no `messages` key. */
export function idsFromListPage(page: GmailListMessagesResponse): string[] {
  return (page.messages ?? []).map((m) => m.id);
}

/** Message-ID and Subject from a metadata response, header names any case. */
export function metaFromMessage(
  msg: Pick<GmailMessageMetadata, "payload">,
): MessageMeta {
  const headers = msg.payload?.headers ?? [];
  const get = (name: string): string | undefined =>
    headers.find((h) => h.name.toLowerCase() === name)?.value;
  return {
    mid: normalizeMessageId(get("message-id")),
    subject: get("subject"),
  };
}

/** Parse a Gmail error body, or null when it is not the JSON envelope. */
export function parseGmailError(text: string): GmailErrorResponse | null {
  try {
    const body = JSON.parse(text) as Partial<GmailErrorResponse>;
    return body.error && typeof body.error.code === "number"
      ? (body as GmailErrorResponse)
      : null;
  } catch {
    return null;
  }
}

/** Apply a token refresh response to a stored token. */
export function applyTokenRefresh(
  token: StoredToken,
  body: OAuthTokenResponse,
  now: number,
): StoredToken {
  return {
    ...token,
    accessToken: body.access_token,
    expiresAt: now + body.expires_in * 1000,
  };
}

export interface MessageMeta {
  /** Normalized Message-ID, or null when the header is missing. */
  mid: string | null;
  subject?: string;
}

export type MetaMap = Record<string, MessageMeta>;

/** Collect the normalized Message-IDs of the given Gmail ids. */
export function messageIdSet(ids: string[], meta: MetaMap): Set<string> {
  const out = new Set<string>();
  for (const id of ids) {
    const mid = meta[id]?.mid;
    if (mid) out.add(mid);
  }
  return out;
}

export interface TargetMessage {
  id: string;
  mid: string | null;
  subject?: string;
}

export interface PlanInput {
  sourceArchived: Set<string>;
  sourceSpam?: Set<string>;
  sourceTrash?: Set<string>;
  target: TargetMessage[];
  junkAction: JunkAction;
}

export interface Plan {
  /** Target Gmail ids to archive (remove INBOX). */
  archive: string[];
  /** Target Gmail ids to move to trash (only with junkAction trash). */
  trash: string[];
  matchedArchived: number;
  matchedSpam: number;
  matchedTrash: number;
  /** Target messages without a Message-ID header. */
  skippedNoMessageId: number;
  /** Target messages with no source match; left alone. */
  unmatched: number;
  /** Subjects of a few planned messages, for display. */
  samples: string[];
}

/**
 * Decide what to do with each target message. Archive state in the source
 * wins over junk state, since archiving is the least destructive action.
 */
export function planSync(input: PlanInput, sampleCount = 5): Plan {
  const plan: Plan = {
    archive: [],
    trash: [],
    matchedArchived: 0,
    matchedSpam: 0,
    matchedTrash: 0,
    skippedNoMessageId: 0,
    unmatched: 0,
    samples: [],
  };
  const spam = input.sourceSpam ?? new Set<string>();
  const trash = input.sourceTrash ?? new Set<string>();
  const seen = new Set<string>();
  for (const msg of input.target) {
    if (seen.has(msg.id)) continue;
    seen.add(msg.id);
    if (!msg.mid) {
      plan.skippedNoMessageId++;
      continue;
    }
    let action: "archive" | "trash" | null = null;
    if (input.sourceArchived.has(msg.mid)) {
      plan.matchedArchived++;
      action = "archive";
    } else if (spam.has(msg.mid) || trash.has(msg.mid)) {
      if (spam.has(msg.mid)) plan.matchedSpam++;
      else plan.matchedTrash++;
      action = input.junkAction;
    }
    if (action === null) {
      plan.unmatched++;
      continue;
    }
    plan[action].push(msg.id);
    if (plan.samples.length < sampleCount && msg.subject) {
      plan.samples.push(msg.subject);
    }
  }
  return plan;
}

/** Split a list into chunks of at most `size`. */
export function chunk<T>(items: T[], size: number): T[][] {
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error(`chunk size must be a positive integer: ${size}`);
  }
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Paths and permissions
// ---------------------------------------------------------------------------

export function tokenPath(email: string, home: string = homedir()): string {
  return join(home, ".config", "mail-state-sync", `${email}.json`);
}

export function cachePath(email: string, home: string = homedir()): string {
  return join(home, ".cache", "mail-state-sync", `${email}.json`);
}

/** True when no group or other permission bits are set. */
export function isPrivateMode(mode: number): boolean {
  return (mode & 0o077) === 0;
}

/** Write a JSON file atomically in a 700 dir with mode 600. */
export async function writePrivateJson(
  path: string,
  data: unknown,
): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  await chmod(dir, PRIVATE_DIR_MODE);
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(data), { mode: PRIVATE_FILE_MODE });
  await chmod(tmp, PRIVATE_FILE_MODE);
  await rename(tmp, path);
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`cannot read ${path}: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// HTTP retry helpers
// ---------------------------------------------------------------------------

export function isRetryableStatus(status: number, body = ""): boolean {
  if (status === 429 || status >= 500) return true;
  // Gmail reports per-user quota exhaustion as 403, not 429.
  return (
    status === 403 &&
    /rateLimitExceeded|Quota exceeded|RATE_LIMIT_EXCEEDED/i.test(body)
  );
}

/** Exponential backoff in ms, capped; `jitter` in [0, 1). */
export function backoffMs(
  attempt: number,
  jitter = 0,
  baseMs = 500,
  capMs = 32_000,
): number {
  const exp = Math.min(capMs, baseMs * 2 ** attempt);
  return Math.round(exp * (0.5 + jitter / 2));
}

/**
 * 125 ms spacing = 8 requests/s = 480 gets/min. The ud-tooling-2611
 * project's per-user `total_query_cost` limit is 6,000 units/min (checked
 * 2026-11-10 via serviceusage consumerQuotaMetrics). Runs at 40/s and 16.7/s
 * still exceeded it, so this pace leaves room even if a metadata get costs
 * more than the documented 5 units.
 */
export const REQUEST_INTERVAL_MS = 125;

/** Per-user query-cost limit for this project, in units per minute. */
export const QUERY_COST_LIMIT_PER_MIN = 6_000;

/** True for Gmail's per-user quota 403, which resets each minute. */
export function isQuotaExceeded(status: number, body = ""): boolean {
  return status === 403 && /Quota exceeded|RATE_LIMIT_EXCEEDED/i.test(body);
}

/**
 * Delay before retrying. A quota 403 waits out the one-minute window;
 * other retryable errors back off exponentially.
 */
export function retryDelayMs(
  status: number,
  body: string,
  attempt: number,
  jitter = 0,
): number {
  if (isQuotaExceeded(status, body)) return 61_000 + Math.round(jitter * 4_000);
  return backoffMs(attempt, jitter);
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// OAuth (loopback + PKCE)
// ---------------------------------------------------------------------------

export interface ClientCredentials {
  clientId: string;
  clientSecret: string;
}

export interface StoredToken {
  email: string;
  scope: string;
  refreshToken: string;
  accessToken: string;
  /** Epoch ms when the access token expires. */
  expiresAt: number;
}

export function parseClientCredentials(json: unknown): ClientCredentials {
  const root = json as Record<string, Record<string, unknown> | undefined>;
  const block = root?.installed ?? root?.web;
  const clientId = block?.client_id;
  const clientSecret = block?.client_secret;
  if (typeof clientId !== "string" || typeof clientSecret !== "string") {
    throw new Error("credentials JSON lacks installed.client_id/secret");
  }
  return { clientId, clientSecret };
}

export function base64Url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function pkceChallenge(verifier: string): string {
  return base64Url(createHash("sha256").update(verifier).digest());
}

export function buildAuthUrl(p: {
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
  challenge: string;
  loginHint: string;
}): string {
  const q = new URLSearchParams({
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    response_type: "code",
    scope: p.scope,
    state: p.state,
    code_challenge: p.challenge,
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: "consent",
    login_hint: p.loginHint,
  });
  return `${AUTH_URL}?${q.toString()}`;
}

/** True when the granted scope string covers the required scope. */
export function scopeCovers(granted: string, required: string): boolean {
  const have = new Set(granted.split(/\s+/).filter(Boolean));
  if (have.has(required)) return true;
  // gmail.modify is a superset of gmail.readonly.
  return required === SCOPE_READONLY && have.has(SCOPE_MODIFY);
}

function tryOpenBrowser(url: string): void {
  for (const cmd of ["wslview", "xdg-open", "open"]) {
    try {
      const p = Bun.spawnSync([cmd, url], {
        stdout: "ignore",
        stderr: "ignore",
      });
      if (p.exitCode === 0) return;
    } catch {
      // Command not found; try the next one.
    }
  }
}

async function tokenRequest(
  params: Record<string, string>,
): Promise<OAuthTokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const body = (await res.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  if (!res.ok) {
    // Print only the error code and description, never tokens.
    const desc = body.error_description ? `: ${body.error_description}` : "";
    throw new Error(
      `token endpoint ${res.status} ${String(body.error ?? "")}${desc}`,
    );
  }
  return body as unknown as OAuthTokenResponse;
}

async function loopbackAuth(
  creds: ClientCredentials,
  email: string,
  scope: string,
  role: string,
): Promise<StoredToken> {
  const verifier = base64Url(randomBytes(48));
  const state = base64Url(randomBytes(16));
  let resolveCode!: (code: string) => void;
  let rejectCode!: (err: Error) => void;
  const codePromise = new Promise<string>((res, rej) => {
    resolveCode = res;
    rejectCode = rej;
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req: Request): Response {
      const url = new URL(req.url);
      if (url.pathname !== "/") return new Response("", { status: 404 });
      const err = url.searchParams.get("error");
      if (err) {
        rejectCode(new Error(`authorization denied: ${err}`));
        return new Response("Authorization failed. Close this tab.");
      }
      if (url.searchParams.get("state") !== state) {
        return new Response("State mismatch.", { status: 400 });
      }
      const code = url.searchParams.get("code");
      if (!code) return new Response("Missing code.", { status: 400 });
      resolveCode(code);
      return new Response(
        "mail-state-sync: signed in. You can close this tab.",
      );
    },
  });
  const redirectUri = `http://127.0.0.1:${server.port}`;
  try {
    const url = buildAuthUrl({
      clientId: creds.clientId,
      redirectUri,
      scope,
      state,
      challenge: pkceChallenge(verifier),
      loginHint: email,
    });
    console.log(
      `Sign in as the ${role} account ${c.bold(email)} ` +
        `(scope ${scope.split("/").pop()}):`,
    );
    console.log(c.cyan(url));
    tryOpenBrowser(url);
    const code = await codePromise;
    const body = await tokenRequest({
      code,
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      code_verifier: verifier,
    });
    if (typeof body.refresh_token !== "string") {
      throw new Error("no refresh token returned; revoke access and retry");
    }
    return {
      email,
      scope: String(body.scope ?? scope),
      refreshToken: body.refresh_token,
      accessToken: String(body.access_token),
      expiresAt: Date.now() + Number(body.expires_in ?? 0) * 1000,
    };
  } finally {
    server.stop(true);
  }
}

/** A Gmail client bound to one signed-in account. */
export class GmailAccount {
  constructor(
    readonly email: string,
    private token: StoredToken,
    private creds: ClientCredentials,
  ) {}

  private async accessToken(): Promise<string> {
    if (Date.now() < this.token.expiresAt - 60_000) {
      return this.token.accessToken;
    }
    const body = await tokenRequest({
      client_id: this.creds.clientId,
      client_secret: this.creds.clientSecret,
      refresh_token: this.token.refreshToken,
      grant_type: "refresh_token",
    });
    this.token = applyTokenRefresh(this.token, body, Date.now());
    await writePrivateJson(tokenPath(this.email), this.token);
    return this.token.accessToken;
  }

  /**
   * Earliest start time for the next request. Requests are spaced
   * REQUEST_INTERVAL_MS apart so a messages.get (5 quota units) stays under
   * Gmail's 15,000 units per minute per user.
   */
  private nextRequestAt = 0;

  private async pace(): Promise<void> {
    const now = Date.now();
    const start = Math.max(now, this.nextRequestAt);
    this.nextRequestAt = start + REQUEST_INTERVAL_MS;
    if (start > now) await sleep(start - now);
  }

  /** Call the Gmail API with retry on 429, 5xx, and rate-limit 403s. */
  async call<T>(
    path: string,
    init: { method?: string; body?: unknown } = {},
    maxAttempts = 10,
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      await this.pace();
      const token = await this.accessToken();
      let res: Response;
      try {
        res = await fetch(`${GMAIL_API}${path}`, {
          method: init.method ?? "GET",
          headers: {
            authorization: `Bearer ${token}`,
            ...(init.body ? { "content-type": "application/json" } : {}),
          },
          body: init.body ? JSON.stringify(init.body) : undefined,
        });
      } catch (err) {
        if (attempt + 1 >= maxAttempts) throw err;
        await sleep(backoffMs(attempt, Math.random()));
        continue;
      }
      if (res.ok) {
        const text = await res.text();
        return (text ? JSON.parse(text) : {}) as T;
      }
      const text = await res.text();
      if (res.status === 401 && attempt === 0) {
        this.token.expiresAt = 0;
        continue;
      }
      if (isRetryableStatus(res.status, text) && attempt + 1 < maxAttempts) {
        const after = Number(res.headers.get("retry-after"));
        const wait =
          after > 0
            ? after * 1000
            : retryDelayMs(res.status, text, attempt, Math.random());
        await sleep(wait);
        continue;
      }
      throw new Error(
        `Gmail ${init.method ?? "GET"} ${path.split("?")[0]} -> ` +
          `${res.status}: ${text.slice(0, 300)}`,
      );
    }
  }

  async profileEmail(): Promise<string> {
    const p = await this.call<GmailProfile>("/profile");
    return p.emailAddress.toLowerCase();
  }
}

/** Load or create a token for `email` and verify the signed-in identity. */
export async function connect(
  creds: ClientCredentials,
  email: string,
  scope: string,
  role: string,
): Promise<GmailAccount> {
  const path = tokenPath(email);
  let token = await readJson<StoredToken>(path);
  let fresh = false;
  if (!token || !token.refreshToken || !scopeCovers(token.scope, scope)) {
    token = await loopbackAuth(creds, email, scope, role);
    fresh = true;
  }
  const account = new GmailAccount(email, token, creds);
  const actual = await account.profileEmail();
  if (actual !== email) {
    throw new Error(
      `${role} sign-in is ${actual}, expected ${email}; ` +
        `refusing to continue` + (fresh ? "" : ` (delete ${path})`),
    );
  }
  if (fresh) {
    await writePrivateJson(path, token);
    console.log(`${c.green("Saved token")} ${path}`);
  }
  return account;
}

// ---------------------------------------------------------------------------
// Gmail listing and metadata
// ---------------------------------------------------------------------------

export async function listIds(
  acct: GmailAccount,
  q: string,
  limit: number | null = null,
): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({ q, maxResults: "500" });
    if (pageToken) params.set("pageToken", pageToken);
    const page = await acct.call<GmailListMessagesResponse>(
      `/messages?${params.toString()}`,
    );
    ids.push(...idsFromListPage(page));
    pageToken = page.nextPageToken;
    if (limit !== null && ids.length >= limit) return ids.slice(0, limit);
  } while (pageToken);
  return ids;
}

/** Run `fn` over items with at most `n` in flight. */
export async function mapPool<T>(
  items: T[],
  n: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next++]!;
      await fn(item);
    }
  };
  const count = Math.min(n, items.length);
  await Promise.all(Array.from({ length: count }, worker));
}

interface CacheFile {
  version: 1;
  meta: MetaMap;
}

export async function loadCache(email: string): Promise<MetaMap> {
  const data = await readJson<CacheFile>(cachePath(email));
  return data?.version === 1 ? data.meta : {};
}

async function saveCache(email: string, meta: MetaMap): Promise<void> {
  const file: CacheFile = { version: 1, meta };
  await writePrivateJson(cachePath(email), file);
}


/** Fill `meta` with Message-ID and Subject for ids not yet cached. */
export async function fetchMeta(
  acct: GmailAccount,
  ids: string[],
  meta: MetaMap,
  persist: boolean,
  label: string,
): Promise<void> {
  const missing = ids.filter((id) => !(id in meta));
  if (missing.length === 0) return;
  console.log(
    `Fetching headers for ${missing.length} ${label} messages ` +
      `(${ids.length - missing.length} cached)`,
  );
  let done = 0;
  let lastSave = Date.now();
  const tick = async (): Promise<void> => {
    done++;
    if (done % 500 === 0 || done === missing.length) {
      process.stdout.write(`\r  ${done}/${missing.length}`);
    }
    if (persist && Date.now() - lastSave > 15_000) {
      lastSave = Date.now();
      await saveCache(acct.email, meta);
    }
  };
  try {
  await mapPool(missing, FETCH_CONCURRENCY, async (id) => {
    const params = new URLSearchParams({ format: "metadata" });
    params.append("metadataHeaders", "Message-ID");
    params.append("metadataHeaders", "Subject");
    try {
      const msg = await acct.call<GmailMessageMetadata>(
        `/messages/${id}?${params.toString()}`,
      );
      meta[id] = metaFromMessage(msg);
    } catch (err) {
      if (/-> 404/.test((err as Error).message)) return; // Deleted since.
      throw err;
    }
    await tick();
  });
  } finally {
    // Keep progress even when a fetch fails, so a rerun resumes.
    process.stdout.write("\n");
    if (persist) await saveCache(acct.email, meta);
  }
}

async function batchArchive(
  acct: GmailAccount,
  ids: string[],
): Promise<void> {
  for (const part of chunk(ids, BATCH_MODIFY_MAX)) {
    await acct.call("/messages/batchModify", {
      method: "POST",
      body: { ids: part, removeLabelIds: ["INBOX"] },
    });
  }
}

async function trashAll(acct: GmailAccount, ids: string[]): Promise<void> {
  await mapPool(ids, FETCH_CONCURRENCY, async (id) => {
    await acct.call(`/messages/${id}/trash`, { method: "POST" });
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(argv: string[]): Promise<number> {
  let opts: Options;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(`${c.red("error:")} ${(err as Error).message}\n`);
    console.error(USAGE);
    return 2;
  }
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }

  const credsJson = await readJson<unknown>(opts.credentials);
  if (credsJson === null) {
    throw new Error(`missing OAuth client file ${opts.credentials}`);
  }
  const creds = parseClientCredentials(credsJson);
  const source = await connect(creds, opts.source, SCOPE_READONLY, "source");
  const target = await connect(creds, opts.target, SCOPE_MODIFY, "target");

  const sourceMeta = opts.useCache ? await loadCache(source.email) : {};
  const targetMeta = opts.useCache ? await loadCache(target.email) : {};

  console.log(`Listing source archived: ${c.cyan(SOURCE_ARCHIVED_QUERY)}`);
  const archivedIds = await listIds(source, SOURCE_ARCHIVED_QUERY);
  await fetchMeta(source, archivedIds, sourceMeta, opts.useCache, "source");
  let spamIds: string[] = [];
  let trashIds: string[] = [];
  if (opts.includeJunk) {
    spamIds = await listIds(source, "in:spam");
    trashIds = await listIds(source, "in:trash");
    await fetchMeta(
      source,
      [...spamIds, ...trashIds],
      sourceMeta,
      opts.useCache,
      "source junk",
    );
  }

  console.log(`Listing target: ${c.cyan(opts.targetQuery)}`);
  const targetIds = await listIds(target, opts.targetQuery, opts.limit);
  await fetchMeta(target, targetIds, targetMeta, opts.useCache, "target");

  const plan = planSync({
    sourceArchived: messageIdSet(archivedIds, sourceMeta),
    sourceSpam: opts.includeJunk
      ? messageIdSet(spamIds, sourceMeta)
      : undefined,
    sourceTrash: opts.includeJunk
      ? messageIdSet(trashIds, sourceMeta)
      : undefined,
    target: targetIds
      .filter((id) => id in targetMeta)
      .map((id) => ({ id, ...targetMeta[id]! })),
    junkAction: opts.junkAction,
  });

  console.log("");
  console.log(`Source archived:        ${archivedIds.length}`);
  if (opts.includeJunk) {
    console.log(
      `Source spam / trash:    ${spamIds.length} / ${trashIds.length}`,
    );
  }
  console.log(`Target scanned:         ${targetIds.length}`);
  console.log(`Matched archived:       ${plan.matchedArchived}`);
  if (opts.includeJunk) {
    console.log(
      `Matched spam / trash:   ${plan.matchedSpam} / ${plan.matchedTrash}`,
    );
  }
  console.log(`Unmatched (untouched):  ${plan.unmatched}`);
  if (plan.skippedNoMessageId > 0) {
    console.log(
      c.yellow(`Skipped, no Message-ID: ${plan.skippedNoMessageId}`),
    );
  }
  const verb = opts.run ? "To archive" : "Would archive";
  const pad = (label: string): string =>
    `${label}:${" ".repeat(23 - label.length)}`;
  console.log(`${pad(verb)}${plan.archive.length}`);
  if (plan.trash.length > 0) {
    const t = opts.run ? "To trash" : "Would trash";
    console.log(`${pad(t)}${plan.trash.length}`);
  }
  if (plan.samples.length > 0) {
    console.log("Samples:");
    for (const s of plan.samples) console.log(`  - ${s}`);
  }

  if (!opts.run) {
    if (plan.archive.length + plan.trash.length > 0) {
      console.log(`\n${c.yellow("Dry run.")} Apply with:`);
      console.log(c.cyan(formatRunCommand(opts)));
    } else {
      console.log(`\n${c.green("Nothing to do.")}`);
    }
    return 0;
  }

  await batchArchive(target, plan.archive);
  console.log(`${c.green("Archived")} ${plan.archive.length} messages`);
  if (plan.trash.length > 0) {
    await trashAll(target, plan.trash);
    console.log(`${c.green("Trashed")} ${plan.trash.length} messages`);
  }
  return 0;
}

if (import.meta.main) {
  try {
    process.exit(await main(process.argv.slice(2)));
  } catch (err) {
    console.error(`${c.red("error:")} ${(err as Error).message}`);
    process.exit(1);
  }
}
