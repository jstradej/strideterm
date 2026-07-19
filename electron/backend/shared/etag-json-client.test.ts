import { describe, expect, test, vi } from "vitest";
import { createEtagJsonClient } from "./etag-json-client.js";

interface MockResponse {
  status: number;
  statusText?: string;
  headers?: Record<string, string>;
  body: unknown;
}

function createMockFetch(responses: MockResponse[] = []) {
  let callIndex = 0;
  return vi.fn(async (_url: unknown, _options: unknown) => {
    const response = responses[callIndex++] || { status: 200, body: {} };
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      statusText: response.statusText || "OK",
      headers: new Map(Object.entries(response.headers || {})),
      json: async () => response.body,
      text: async () => (typeof response.body === "string" ? response.body : JSON.stringify(response.body)),
    };
  });
}

// A synthetic (non-Azure, non-GitHub) provider config, to prove the shared
// core is correct independent of either real provider. Auth is a made-up
// "Token <token>" scheme; errors carry their message under `reason`.
interface WidgetOptions {
  token?: string;
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

function createWidgetClient(
  fetchImpl: typeof globalThis.fetch,
  opts: {
    auditLogger?: (entry: {
      method: string;
      url: string;
      statusCode: number;
      success: boolean;
      durationMs: number;
      errorMessage?: string;
    }) => void;
    maxCacheSize?: number;
    treatNoContentAsNull?: boolean;
    withTextSupport?: boolean;
  } = {},
) {
  return createEtagJsonClient<WidgetOptions>(fetchImpl, {
    buildJsonHeaders: ({ token, headers = {} }) => ({
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Token ${token}`,
      ...headers,
    }),
    buildTextHeaders: opts.withTextSupport
      ? ({ token, headers = {} }) => ({
          Accept: "text/plain",
          Authorization: `Token ${token}`,
          ...headers,
        })
      : undefined,
    errorPrefix: "Widget",
    extractErrorMessage: (parsed, fallback) => (parsed as { reason?: string })?.reason || fallback,
    treatNoContentAsNull: opts.treatNoContentAsNull,
    auditLogger: opts.auditLogger,
    maxCacheSize: opts.maxCacheSize,
  });
}

describe("createEtagJsonClient - ETag caching", () => {
  test("sends If-None-Match on subsequent GET requests and returns cached data on 304", async () => {
    const fetchImpl = createMockFetch([
      { status: 200, body: { value: [1] }, headers: { etag: '"abc123"' } },
      { status: 304, body: null, headers: { etag: '"abc123"' } },
    ]);
    const client = createWidgetClient(fetchImpl as unknown as typeof fetch);

    const result1 = await client.requestJson("https://widgets.example/things", { token: "t" });
    expect(result1).toEqual({ value: [1] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test assertion on mock call args
    expect((fetchImpl.mock.calls[0][1] as any).headers["If-None-Match"]).toBeUndefined();

    const result2 = await client.requestJson("https://widgets.example/things", { token: "t" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test assertion on mock call args
    expect((fetchImpl.mock.calls[1][1] as any).headers["If-None-Match"]).toBe('"abc123"');
    expect(result2).toEqual({ value: [1] });
  });

  test("does not send If-None-Match for non-GET requests", async () => {
    const fetchImpl = createMockFetch([{ status: 200, body: { id: 1 } }]);
    const client = createWidgetClient(fetchImpl as unknown as typeof fetch);

    await client.requestJson("https://widgets.example/things", { token: "t", method: "POST", body: { a: 1 } });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test assertion on mock call args
    expect((fetchImpl.mock.calls[0][1] as any).headers["If-None-Match"]).toBeUndefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test assertion on mock call args
    expect((fetchImpl.mock.calls[0][1] as any).body).toBe(JSON.stringify({ a: 1 }));
  });

  test("refreshes cached data when the server returns a new etag", async () => {
    const fetchImpl = createMockFetch([
      { status: 200, body: { n: 1 }, headers: { etag: '"v1"' } },
      { status: 200, body: { n: 2 }, headers: { etag: '"v2"' } },
    ]);
    const client = createWidgetClient(fetchImpl as unknown as typeof fetch);
    const url = "https://widgets.example/things";

    expect(await client.requestJson(url, { token: "t" })).toEqual({ n: 1 });
    expect(await client.requestJson(url, { token: "t" })).toEqual({ n: 2 });
  });

  test("evicts the oldest cache entry once maxCacheSize is reached", async () => {
    const fetchImpl = createMockFetch([
      { status: 200, body: { id: "a" }, headers: { etag: '"eta"' } },
      { status: 200, body: { id: "b" }, headers: { etag: '"etb"' } },
      { status: 200, body: { id: "c" }, headers: { etag: '"etc"' } }, // triggers eviction of "a"
      { status: 200, body: { id: "a-refetched" }, headers: { etag: '"eta2"' } }, // "a" has no cache anymore
    ]);
    const client = createWidgetClient(fetchImpl as unknown as typeof fetch, { maxCacheSize: 2 });

    await client.requestJson("https://widgets.example/a", { token: "t" });
    await client.requestJson("https://widgets.example/b", { token: "t" });
    await client.requestJson("https://widgets.example/c", { token: "t" });
    await client.requestJson("https://widgets.example/a", { token: "t" });

    // The 4th call re-requests "a" — since it was evicted, no If-None-Match is sent.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test assertion on mock call args
    expect((fetchImpl.mock.calls[3][1] as any).headers["If-None-Match"]).toBeUndefined();
  });

  test("re-issues the request without If-None-Match when a 304 arrives with no cached entry", async () => {
    // Simulates the LRU-eviction race: a 304 comes back for a URL the cache
    // has no entry for (rather than actually triggering eviction under
    // concurrency, we just never populate the cache for this URL).
    const fetchImpl = createMockFetch([
      { status: 304, body: null },
      { status: 200, body: { id: 99 }, headers: { etag: '"fresh"' } },
    ]);
    const client = createWidgetClient(fetchImpl as unknown as typeof fetch);

    const result = await client.requestJson("https://widgets.example/things", { token: "t" });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ id: 99 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test assertion on mock call args
    expect((fetchImpl.mock.calls[0][1] as any).headers["If-None-Match"]).toBeUndefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test assertion on mock call args
    expect((fetchImpl.mock.calls[1][1] as any).headers["If-None-Match"]).toBeUndefined();
  });
});

describe("createEtagJsonClient - error handling", () => {
  test("uses the configured errorPrefix and extractErrorMessage for non-ok responses", async () => {
    const fetchImpl = createMockFetch([{ status: 403, body: { reason: "insufficient scope" } }]);
    const client = createWidgetClient(fetchImpl as unknown as typeof fetch);

    await expect(client.requestJson("https://widgets.example/things", { token: "t" })).rejects.toThrow(
      "Widget request failed (403): insufficient scope",
    );
  });

  test("falls back to raw text/statusText when the error body isn't JSON", async () => {
    const fetchImpl = vi.fn(async (_url: unknown, _options: unknown) => ({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      headers: new Map(),
      json: async () => {
        throw new Error("not json");
      },
      text: async () => "not-json-body",
    }));
    const client = createWidgetClient(fetchImpl as unknown as typeof fetch);

    await expect(client.requestJson("https://widgets.example/things", { token: "t" })).rejects.toThrow(
      "Widget request failed (500): not-json-body",
    );
  });
});

describe("createEtagJsonClient - audit logging", () => {
  test("logs a success entry with method/url/statusCode/durationMs", async () => {
    const fetchImpl = createMockFetch([{ status: 200, body: { ok: true } }]);
    const auditLogger = vi.fn();
    const client = createWidgetClient(fetchImpl as unknown as typeof fetch, { auditLogger });

    await client.requestJson("https://widgets.example/things", { token: "t", method: "GET" });

    expect(auditLogger).toHaveBeenCalledTimes(1);
    const entry = auditLogger.mock.calls[0][0];
    expect(entry).toMatchObject({ method: "GET", url: "https://widgets.example/things", statusCode: 200, success: true });
    expect(entry.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("logs a failure entry with the thrown error's message", async () => {
    const fetchImpl = createMockFetch([{ status: 401, body: { reason: "bad token" } }]);
    const auditLogger = vi.fn();
    const client = createWidgetClient(fetchImpl as unknown as typeof fetch, { auditLogger });

    await expect(client.requestJson("https://widgets.example/things", { token: "t" })).rejects.toThrow();

    expect(auditLogger).toHaveBeenCalledTimes(1);
    const entry = auditLogger.mock.calls[0][0];
    expect(entry.success).toBe(false);
    expect(entry.statusCode).toBe(401);
    expect(entry.errorMessage).toContain("bad token");
  });

  test("swallows exceptions thrown by the audit logger itself", async () => {
    const fetchImpl = createMockFetch([{ status: 200, body: { ok: true } }]);
    const auditLogger = vi.fn(() => {
      throw new Error("logger blew up");
    });
    const client = createWidgetClient(fetchImpl as unknown as typeof fetch, { auditLogger });

    await expect(client.requestJson("https://widgets.example/things", { token: "t" })).resolves.toEqual({ ok: true });
  });
});

describe("createEtagJsonClient - 204 handling", () => {
  test("treatNoContentAsNull: true returns null for a 204 response without parsing a body", async () => {
    const fetchImpl = createMockFetch([{ status: 204, body: null }]);
    const client = createWidgetClient(fetchImpl as unknown as typeof fetch, { treatNoContentAsNull: true });

    const result = await client.requestJson("https://widgets.example/things", { token: "t", method: "DELETE" });
    expect(result).toBeNull();
  });

  test("treatNoContentAsNull: false (default) still attempts to parse a JSON body for 204", async () => {
    const fetchImpl = vi.fn(async (_url: unknown, _options: unknown) => ({
      ok: true,
      status: 204,
      statusText: "No Content",
      headers: new Map(),
      json: async () => ({ parsed: true }),
      text: async () => "",
    }));
    const client = createWidgetClient(fetchImpl as unknown as typeof fetch);

    const result = await client.requestJson("https://widgets.example/things", { token: "t", method: "DELETE" });
    expect(result).toEqual({ parsed: true });
  });
});

describe("createEtagJsonClient - requestText", () => {
  test("fetches plain text via buildTextHeaders, with no ETag cache involved", async () => {
    const fetchImpl = vi.fn(async (_url: unknown, _options: unknown) => ({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Map(),
      json: async () => {
        throw new Error("should not be called for text responses");
      },
      text: async () => "plain log output",
    }));
    const client = createWidgetClient(fetchImpl as unknown as typeof fetch, { withTextSupport: true });

    const body = await client.requestText("https://widgets.example/log", { token: "t" });

    expect(body).toBe("plain log output");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test assertion on mock call args
    const sentHeaders = (fetchImpl.mock.calls[0][1] as any).headers;
    expect(sentHeaders.Accept).toBe("text/plain");
    expect(sentHeaders.Authorization).toBe("Token t");
    expect(sentHeaders["If-None-Match"]).toBeUndefined();
  });

  test("throws and audits on a non-ok response, same error shape as requestJson", async () => {
    const fetchImpl = createMockFetch([{ status: 404, body: { reason: "log not found" } }]);
    const auditLogger = vi.fn();
    const client = createWidgetClient(fetchImpl as unknown as typeof fetch, { withTextSupport: true, auditLogger });

    await expect(client.requestText("https://widgets.example/log", { token: "t" })).rejects.toThrow(
      "Widget request failed (404): log not found",
    );
    expect(auditLogger).toHaveBeenCalledWith(expect.objectContaining({ method: "GET", success: false }));
  });

  test("throws a clear configuration error when buildTextHeaders was never supplied", async () => {
    const fetchImpl = createMockFetch();
    const client = createWidgetClient(fetchImpl as unknown as typeof fetch); // withTextSupport defaults to false

    await expect(client.requestText("https://widgets.example/log", { token: "t" })).rejects.toThrow(
      /requestText is not configured/,
    );
  });
});
