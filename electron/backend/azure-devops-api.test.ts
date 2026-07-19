import { describe, expect, test, vi } from "vitest";
import { createAzureApi } from "./azure-devops-api.js";

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
      text: async () => JSON.stringify(response.body),
    };
  });
}

describe("Azure DevOps API - ETag caching", () => {
  test("sends If-None-Match header on subsequent GET requests", async () => {
    const fetchImpl = createMockFetch([
      {
        status: 200,
        body: { value: [{ id: 1, name: "Project A" }] },
        headers: { etag: '"abc123"' },
      },
      {
        status: 304,
        body: null,
        headers: { etag: '"abc123"' },
      },
    ]);

    const api = createAzureApi(fetchImpl as unknown as typeof fetch);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const connection = { orgUrl: "https://dev.azure.com/org" } as any;
    const authOpts = { login: "user", token: "pat" };

    // First call — no etag
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: test assertion on untyped API response
    const result1 = (await api.requestJson(api.buildProjectsUrl(connection), authOpts)) as any;
    expect(result1.value).toHaveLength(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: test assertion on mock call args
    expect((fetchImpl.mock.calls[0][1] as any).headers["If-None-Match"]).toBeUndefined();

    // Second call — should send If-None-Match and return cached data on 304
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: test assertion on untyped API response
    const result2 = (await api.requestJson(api.buildProjectsUrl(connection), authOpts)) as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: test assertion on mock call args
    expect((fetchImpl.mock.calls[1][1] as any).headers["If-None-Match"]).toBe('"abc123"');
    expect(result2.value).toHaveLength(1);
  });

  test("does not send If-None-Match for POST requests", async () => {
    const fetchImpl = createMockFetch([
      {
        status: 200,
        body: { id: 1 },
        headers: {},
      },
    ]);

    const api = createAzureApi(fetchImpl as unknown as typeof fetch);
    await api.requestJson("https://example.com/api", {
      login: "user",
      token: "pat",
      method: "POST",
      body: { content: "hello" },
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: test assertion on mock call args
    expect((fetchImpl.mock.calls[0][1] as any).headers["If-None-Match"]).toBeUndefined();
  });

  test("refreshes cached data when server returns new etag", async () => {
    const fetchImpl = createMockFetch([
      {
        status: 200,
        body: { value: [{ id: 1 }] },
        headers: { etag: '"v1"' },
      },
      {
        status: 200,
        body: { value: [{ id: 1 }, { id: 2 }] },
        headers: { etag: '"v2"' },
      },
    ]);

    const api = createAzureApi(fetchImpl as unknown as typeof fetch);
    const url = "https://dev.azure.com/org/proj/_apis/git/pullrequests";
    const auth = { login: "user", token: "pat" };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: test assertion on untyped API response
    const result1 = (await api.requestJson(url, auth)) as any;
    expect(result1.value).toHaveLength(1);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: test assertion on untyped API response
    const result2 = (await api.requestJson(url, auth)) as any;
    expect(result2.value).toHaveLength(2);
  });

  test("re-issues the request without If-None-Match when a 304 arrives with no cached entry", async () => {
    // Simulates the LRU-eviction race: a 304 comes back for a URL the cache
    // has no entry for (rather than actually triggering eviction under
    // concurrency, we just never populate the cache for this URL).
    const fetchImpl = createMockFetch([
      { status: 304, body: null },
      { status: 200, body: { value: [{ id: 99 }] }, headers: { etag: '"fresh"' } },
    ]);

    const api = createAzureApi(fetchImpl as unknown as typeof fetch);
    const url = "https://dev.azure.com/org/proj/_apis/git/pullrequests";
    const authOpts = { login: "user", token: "pat" };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: test assertion on untyped API response
    const result = (await api.requestJson(url, authOpts)) as any;

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.value).toHaveLength(1);
    expect(result.value[0].id).toBe(99);
    // Neither call carries If-None-Match since nothing was ever cached for this URL
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: test assertion on mock call args
    expect((fetchImpl.mock.calls[0][1] as any).headers["If-None-Match"]).toBeUndefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: test assertion on mock call args
    expect((fetchImpl.mock.calls[1][1] as any).headers["If-None-Match"]).toBeUndefined();
  });
});

describe("Azure DevOps API - fetchBuildErrors / fetchBuildDetail error logging", () => {
  test("fetchBuildErrors returns an empty string and logs the failure", async () => {
    const fetchImpl = createMockFetch([
      { status: 403, body: { message: "Access denied due to missing PAT scope" } },
    ]);
    const auditLogger = vi.fn();
    const api = createAzureApi(fetchImpl as unknown as typeof fetch, { auditLogger });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: test connection stub
    const connection = { orgUrl: "https://dev.azure.com/org", login: "user" } as any;

    const result = await api.fetchBuildErrors(connection, "pat", "proj", 42);

    expect(result).toBe("");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: test assertion on mock call args
    const failureCalls = auditLogger.mock.calls.filter(([entry]) => (entry as any).success === false);
    expect(failureCalls.length).toBeGreaterThan(0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: test assertion on mock call args
    expect((failureCalls.at(-1)![0] as any).errorMessage).toContain("403");
  });

  test("fetchBuildDetail returns null and logs the failure", async () => {
    const fetchImpl = createMockFetch([
      { status: 403, body: { message: "Access denied due to missing PAT scope" } },
    ]);
    const auditLogger = vi.fn();
    const api = createAzureApi(fetchImpl as unknown as typeof fetch, { auditLogger });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: test connection stub
    const connection = { orgUrl: "https://dev.azure.com/org", login: "user" } as any;

    const result = await api.fetchBuildDetail(connection, "pat", "proj", 42);

    expect(result).toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: test assertion on mock call args
    const failureCalls = auditLogger.mock.calls.filter(([entry]) => (entry as any).success === false);
    expect(failureCalls.length).toBeGreaterThan(0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: test assertion on mock call args
    expect((failureCalls.at(-1)![0] as any).errorMessage).toContain("403");
  });
});
