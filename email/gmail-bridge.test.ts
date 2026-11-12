import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BridgeError, connectAccount, COST, fetchMessages, GmailBridge, GmailClient,
  multipartRequest, parseMultipart, QuotaPacer, retryAfterMs, unsubscribe,
  unsubscribeTarget, type BatchChild, type Json, type Runtime,
} from "./gmail-bridge.ts";
const ACCOUNT = "reader@example.org";
const TOKEN = "synthetic-test-token";
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => { for (const server of servers.splice(0)) server.stop(true); });
function clock(): { rt: Runtime; waits: number[] } {
  let now = 0;
  const waits: number[] = [];
  return { waits, rt: { fetch, now: () => now, random: () => 0,
    sleep: async (ms) => { waits.push(ms); now += ms; } } };
}
function local(handler: (request: Request) => Response | Promise<Response>,
  refresh?: () => Promise<string>): { client: GmailClient; waits: number[] } {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  servers.push(server);
  const { rt, waits } = clock();
  return { waits, client: new GmailClient(ACCOUNT, async () => TOKEN, { rt,
    refresh, pacer: new QuotaPacer(rt), apiBase: `${server.url}gmail/v1/users/me`,
    batchUrl: `${server.url}batch/gmail/v1` }) };
}
function batchResponse(rows: { index: number; status?: number; body: Json;
  retryAfter?: number }[]): Response {
  const boundary = "response_boundary";
  const body = rows.map((row) => `--${boundary}\r\n` +
    `Content-Type: application/http\r\nContent-ID: <response-req-${row.index}>\r\n\r\n` +
    `HTTP/1.1 ${row.status ?? 200} status\r\nContent-Type: application/json\r\n` +
    (row.retryAfter ? `Retry-After: ${row.retryAfter}\r\n` : "") +
    `\r\n${JSON.stringify(row.body)}\r\n`).join("") + `--${boundary}--\r\n`;
  return new Response(body, { headers: { "content-type":
    `multipart/mixed; boundary="${boundary}"` } });
}
function childRequests(body: string): string[] {
  return [...body.matchAll(/GET (\S+) HTTP\/1.1/g)].map((m) => m[1]!);
}
const envelope = (op: string, args: Json = {}): Json =>
  ({ version: 1, request_id: "job-1", account: ACCOUNT, op, args });

describe("quota and multipart", () => {
  test("reserves weighted account and shared project costs", async () => {
    const { rt, waits } = clock();
    const pacer = new QuotaPacer(rt, 6000, 6000);
    await pacer.reserve("a", 3000);
    await pacer.reserve("b", 20);
    await pacer.reserve("a", 60);
    expect(waits).toEqual([30000, 200]);
    expect(COST.full).toBe(60);
    expect(COST.minimal).toBe(20);
  });
  test("Retry-After supports seconds and dates", () => {
    expect(retryAfterMs("3", 0)).toBe(3000);
    expect(retryAfterMs("Thu, 01 Jan 1970 00:01:00 GMT", 5000)).toBe(55000);
    expect(retryAfterMs("bogus", 0)).toBe(0);
  });
  test("correlates out-of-order child IDs and detects missing children", async () => {
    const children = ["a", "b", "c"].map((key) => ({ key, path: "/x", cost: 20 }));
    const response = batchResponse([{ index: 2, body: { id: "c" } },
      { index: 0, status: 404, body: { error: { code: 404 } } }]);
    const result = parseMultipart(response.headers.get("content-type")!,
      await response.text(), children);
    expect(result.map((r) => [r.key, r.status])).toEqual([
      ["a", 404], ["b", 0], ["c", 200],
    ]);
    expect(multipartRequest(children, "test")).toContain("Content-ID: <req-2>");
  });
  test("rejects duplicate response IDs", async () => {
    const response = batchResponse([{ index: 0, body: {} }, { index: 0, body: {} }]);
    const text = await response.text();
    expect(() => parseMultipart(response.headers.get("content-type")!, text,
      [{ key: "a", path: "/x", cost: 20 }])).toThrow("duplicate");
  });
});

describe("real HTTP batching", () => {
  test("50-child limit, partial 404, and selective quota retry", async () => {
    const sizes: number[] = [];
    let calls = 0;
    const { client, waits } = local(async (request) => {
      expect(request.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
      const paths = childRequests(await request.text());
      sizes.push(paths.length);
      calls++;
      return batchResponse(paths.map((path, index) => {
        const id = /messages\/([^?]+)/.exec(path)![1]!;
        return { index, status: id === "m1" ? 404 : calls === 1 && id === "m2" ? 403 : 200,
          retryAfter: calls === 1 && id === "m2" ? 2 : undefined,
          body: id === "m1" ? { error: { errors: [{ reason: "notFound" }] } } :
            calls === 1 && id === "m2" ? { error: { errors: [{ reason: "rateLimitExceeded" }] } } :
            { id, labelIds: ["INBOX"] } };
      }).reverse());
    });
    const data = await fetchMessages(client,
      Array.from({ length: 51 }, (_, i) => `m${i}`), "minimal");
    expect(sizes).toEqual([50, 1, 1]);
    expect(data.messages).toHaveLength(50);
    expect(data.failures).toEqual([{ id: "m1", status: 404,
      code: "notFound", message: "Message fetch failed with status 404" }]);
    expect(waits).toContain(2000);
    expect(data.completeness).toEqual([]);
  });
  test("fetches separate text only and preserves original JSON", async () => {
    const source = { id: "a", payload: { mimeType: "multipart/mixed", parts: [
      { partId: "0", mimeType: "text/plain", body: { attachmentId: "text", size: 5 } },
      { partId: "1", mimeType: "application/pdf", filename: "receipt.pdf",
        body: { attachmentId: "binary", size: 100 } },
      { partId: "2", mimeType: "text/plain", filename: "notes.txt",
        body: { attachmentId: "file", size: 5 } },
    ] } };
    const original = JSON.stringify(source);
    const paths: string[] = [];
    const { client } = local(async (request) => {
      const current = childRequests(await request.text()); paths.push(...current);
      return batchResponse(current.map((path, index) => ({ index,
        body: path.includes("attachments") ? { data: "aGVsbG8", size: 5 } : source })));
    });
    const result = await fetchMessages(client, ["a"], "full");
    expect(result.messages).toEqual([source]);
    expect(JSON.stringify(source)).toBe(original);
    expect(paths).toHaveLength(2);
    expect(paths[1]).toEndWith("/attachments/text");
    expect(result.text_parts).toEqual([{ message_id: "a", part_id: "0",
      attachment_id: "text", mime_type: "text/plain", body: { data: "aGVsbG8", size: 5 } }]);
    expect(result.completeness).toEqual([{ id: "a", content_complete: true,
      missing_text_parts: [] }]);
  });
  test("threads refresh includes new members and resolves text bodies", async () => {
    const thread = { id: "thread1", historyId: "999", messages: [
      { id: "old", threadId: "thread1", labelIds: ["INBOX"] },
      { id: "new", threadId: "thread1", labelIds: ["INBOX"], payload: {
        partId: "0", mimeType: "text/plain", body: { attachmentId: "body" },
      } },
    ] };
    const paths: string[] = [];
    const { client } = local(async (request) => {
      const current = childRequests(await request.text()); paths.push(...current);
      return batchResponse(current.map((path, index) => ({ index,
        body: path.includes("attachments") ? { data: "bmV3", size: 3 } : thread })));
    });
    const bridge = new GmailBridge(async () => client);
    const result = await bridge.handle(envelope("threads", { ids: ["thread1"], format: "full" }));
    expect(result.data.threads).toEqual([thread]);
    expect(result.data.threads[0].messages.map((m: Json) => m.id)).toEqual(["old", "new"]);
    expect(paths[0]).toContain("/threads/thread1?format=full");
    expect(paths[1]).toContain("/messages/new/attachments/body");
    expect(result.data.text_parts[0].message_id).toBe("new");
    expect(result.data.completeness).toHaveLength(2);
  });
  test("failed text body marks message incomplete", async () => {
    const { client } = local(async (request) => {
      const path = childRequests(await request.text())[0]!;
      return batchResponse([{ index: 0, status: path.includes("attachments") ? 404 : 200,
        body: path.includes("attachments") ? {} : { id: "a", payload:
          { partId: "0", mimeType: "text/html", body: { attachmentId: "body" } } } }]);
    });
    const data = await fetchMessages(client, ["a"], "full");
    expect(data.text_parts).toEqual([]);
    expect(data.completeness).toEqual([{ id: "a", content_complete: false,
      missing_text_parts: ["0"] }]);
  });
  test("refreshes expired auth and does not retry permission failures", async () => {
    let calls = 0; let refreshed = 0;
    const { client } = local(() => {
      calls++;
      return calls === 1 ? new Response("", { status: 401 }) :
        Response.json({ error: { errors: [{ reason: "forbidden" }] } }, { status: 403 });
    }, async () => { refreshed++; return "refreshed-test-token"; });
    await expect(client.call("/profile", 1)).rejects.toThrow("HTTP 403");
    expect(calls).toBe(2); expect(refreshed).toBe(1);
  });
  test("does not retry uncertain writes or expose provider secrets", async () => {
    let calls = 0;
    const { client } = local(() => { calls++; return new Response(
      "synthetic-secret-response", { status: 503 }); });
    await expect(client.call("/messages/batchModify", 50, "POST", { ids: ["a"] }, false))
      .rejects.toThrow("reconcile");
    expect(calls).toBe(1);
    const bridge = new GmailBridge(async () => client);
    const response = await bridge.handle(envelope("profile"));
    expect(JSON.stringify(response)).not.toContain("synthetic-secret-response");
    expect(JSON.stringify(response)).not.toContain(TOKEN);
  });
});

describe("bridge operations", () => {
  test("caches accounts and preserves list/history provider fields", async () => {
    let connected = 0; const urls: URL[] = [];
    const { client } = local((request) => {
      const url = new URL(request.url); urls.push(url);
      return url.pathname.endsWith("history") ? new Response("{}", { status: 404 }) :
        Response.json({ messages: [{ id: "a" }], nextPageToken: "opaque" });
    });
    const bridge = new GmailBridge(async () => { connected++; return client; });
    const first = await bridge.handle(envelope("list", { query: "after:2026/01/01" }));
    expect(first.data.nextPageToken).toBe("opaque");
    expect(urls[0]!.searchParams.get("includeSpamTrash")).toBe("true");
    const second = await bridge.handle(envelope("history", { start_history_id: "123" }));
    expect(second.error.code).toBe("history_expired");
    expect(connected).toBe(1);
  });
  test("creates missing labels only and bounds modify before sending", async () => {
    const writes: Json[] = [];
    const { client } = local(async (request) => {
      if (request.method === "POST") {
        const data = await request.json() as Json; writes.push(data);
        return Response.json({ id: "Label_2", ...data });
      }
      return Response.json({ labels: [{ id: "Label_1", name: "existing" }] });
    });
    const bridge = new GmailBridge(async () => client);
    const created = await bridge.handle(envelope("create_labels", { names: ["existing", "new", "new"] }));
    expect(created.data.labels).toHaveLength(2);
    expect(writes).toEqual([{ name: "new" }]);
    const args = { ids: Array.from({ length: 1001 }, (_, i) => `m${i}`),
      add_label_ids: ["Label_1"], remove_label_ids: [] };
    expect((await bridge.handle(envelope("modify", args))).error.code).toBe("invalid_request");
    args.ids.pop();
    expect((await bridge.handle(envelope("modify", args))).ok).toBe(true);
    expect(writes[1]!.ids).toHaveLength(1000);
  });
  test("malformed successful writes remain uncertain", async () => {
    let calls = 0;
    const { client } = local(() => { calls++; return new Response("not JSON"); });
    const bridge = new GmailBridge(async () => client);
    const result = await bridge.handle(envelope("modify", { ids: ["a"],
      add_label_ids: ["INBOX"], remove_label_ids: [] }));
    expect(result.error.code).toBe("uncertain_result");
    expect(result.error.retryable).toBe(false);
    expect(calls).toBe(1);
  });
  test("noninteractive missing auth returns auth_required without reading credentials", async () => {
    const home = await mkdtemp(join(tmpdir(), "gmail-bridge-"));
    try { await expect(connectAccount(ACCOUNT, false, { home })).rejects.toThrow("authorization is required"); }
    finally { await rm(home, { recursive: true, force: true }); }
  });
  test("persistent JSONL process survives malformed request and keeps stdout JSON only", async () => {
    const proc = Bun.spawn(["bun", "email/gmail-bridge.ts"], {
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
      env: { ...process.env, UD_MAIL_TOKEN_DIR: "/nonexistent-bridge-test" },
    });
    proc.stdin.write("bad json\n" + JSON.stringify(envelope("connect", { interactive: false })) + "\n");
    proc.stdin.end();
    const output = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    const rows = output.trim().split("\n").map((line) => JSON.parse(line));
    expect(rows).toHaveLength(2);
    expect(rows[0].error.code).toBe("invalid_json");
    expect(rows[1].request_id).toBe("job-1");
    expect(rows[1].error.code).toBe("auth_required");
  });
});

function listMessage(extra: Json[] = []): Json {
  return { id: "a", payload: { headers: [
    { name: "List-Unsubscribe", value: "<mailto:leave@example.org>, <https://mail.example.org/unsubscribe?token=opaque>" },
    { name: "List-Unsubscribe-Post", value: "List-Unsubscribe=One-Click" }, ...extra,
  ] } };
}
describe("one-click unsubscribe", () => {
  test("requires declaration and rejects group relays and local URLs", () => {
    expect(unsubscribeTarget(listMessage()).protocol).toBe("https:");
    expect(() => unsubscribeTarget(listMessage([{ name: "From", value: "team@googlegroups.com" }])))
      .toThrow("Group");
    const message = listMessage();
    message.payload.headers[0].value = "<https://127.0.0.1/unsubscribe>";
    expect(() => unsubscribeTarget(message)).toThrow("host");
    message.payload.headers.pop();
    expect(() => unsubscribeTarget(message)).toThrow("one-click");
  });
  test("rejects custom-domain group relays and group destination URLs", () => {
    expect(() => unsubscribeTarget(listMessage([
      { name: "X-BeenThere", value: "finance@example.org" },
      { name: "List-Id", value: "<finance.example.org>" },
    ]))).toThrow("Group");
    const message = listMessage();
    message.payload.headers[0].value =
      "<https://groups.google.com/a/example.org/g/finance/subscribe>";
    expect(() => unsubscribeTarget(message)).toThrow("Group destination");
  });
  test("external POST has no Gmail auth, no redirect, and uncertain errors do not retry", async () => {
    const { client } = local(() => Response.json(listMessage()));
    let calls = 0;
    const external = (async (_url: unknown, init: RequestInit) => {
      calls++;
      expect(new Headers(init.headers).get("authorization")).toBeNull();
      expect(init.redirect).toBe("manual");
      expect(init.credentials).toBe("omit");
      expect(init.body).toBe("List-Unsubscribe=One-Click");
      throw new Error("network outcome unknown");
    }) as unknown as typeof fetch;
    expect(await unsubscribe(client, "a", external, async () => ["8.8.8.8"])).toEqual({ method: "http_one_click", outcome: "uncertain" });
    expect(calls).toBe(1);
  });
});
