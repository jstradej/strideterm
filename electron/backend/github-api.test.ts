import { describe, expect, test, vi } from "vitest";
import { createGitHubApi } from "./github-api.js";

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

describe("GitHub API - 304 with evicted cache entry", () => {
  test("re-issues the request without If-None-Match when a 304 arrives with no cached entry", async () => {
    // Simulates the LRU-eviction race: a 304 comes back for a URL the cache
    // has no entry for (rather than actually triggering eviction under
    // concurrency, we just never populate the cache for this URL).
    const fetchImpl = createMockFetch([
      { status: 304, body: null },
      { status: 200, body: { id: 99 }, headers: { etag: '"fresh"' } },
    ]);

    const api = createGitHubApi(fetchImpl as unknown as typeof fetch);
    const url = "https://api.github.com/repos/acme/widgets/pulls/1";

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: test assertion on untyped API response
    const result = (await api.requestJson(url, { token: "pat" })) as any;

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.id).toBe(99);
    // Neither call carries If-None-Match since nothing was ever cached for this URL
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: test assertion on mock call args
    expect((fetchImpl.mock.calls[0][1] as any).headers["If-None-Match"]).toBeUndefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: test assertion on mock call args
    expect((fetchImpl.mock.calls[1][1] as any).headers["If-None-Match"]).toBeUndefined();
  });
});
