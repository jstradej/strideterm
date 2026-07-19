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

describe("GitHub API - paginate helper", () => {
  test("aggregates every page and stops once a short page signals the end", async () => {
    const fetchImpl = createMockFetch([
      { status: 200, body: [{ id: 1 }, { id: 2 }] },
      { status: 200, body: [{ id: 3 }, { id: 4 }] },
      { status: 200, body: [{ id: 5 }] }, // short page (< perPage) => last page
    ]);
    const api = createGitHubApi(fetchImpl as unknown as typeof fetch);

    const urls: string[] = [];
    const result = await api.paginate(
      (page) => {
        const url = `https://api.github.com/things?page=${page}`;
        urls.push(url);
        return url;
      },
      "pat",
      2,
    );

    expect(result).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(urls).toEqual([
      "https://api.github.com/things?page=1",
      "https://api.github.com/things?page=2",
      "https://api.github.com/things?page=3",
    ]);
  });

  test("stops immediately when the first page is empty", async () => {
    const fetchImpl = createMockFetch([{ status: 200, body: [] }]);
    const api = createGitHubApi(fetchImpl as unknown as typeof fetch);

    const result = await api.paginate((page) => `https://api.github.com/things?page=${page}`, "pat", 100);

    expect(result).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("stops when a page is exactly perPage-full followed by an empty page", async () => {
    // A full page never triggers the short-page early exit, so paginate must
    // fetch the next page and stop there once it comes back empty.
    const fetchImpl = createMockFetch([
      { status: 200, body: [{ id: 1 }, { id: 2 }] },
      { status: 200, body: [] },
    ]);
    const api = createGitHubApi(fetchImpl as unknown as typeof fetch);

    const result = await api.paginate((page) => `https://api.github.com/things?page=${page}`, "pat", 2);

    expect(result).toEqual([{ id: 1 }, { id: 2 }]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("GitHub API - paginated call sites use the shared paginate helper", () => {
  test("listPullRequestFiles aggregates multi-page file lists identically to before", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ filename: `file-${i}.ts` }));
    const page2 = [{ filename: "last-file.ts" }];
    const fetchImpl = createMockFetch([
      { status: 200, body: page1 },
      { status: 200, body: page2 },
    ]);
    const api = createGitHubApi(fetchImpl as unknown as typeof fetch);

    const files = await api.listPullRequestFiles({}, "pat", "acme", "widgets", 42);

    expect(files).toHaveLength(101);
    expect(files[0]).toEqual({ filename: "file-0.ts" });
    expect(files[100]).toEqual({ filename: "last-file.ts" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: test assertion on mock call args
    const firstUrl = (fetchImpl.mock.calls[0][0] as any).toString();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: test assertion on mock call args
    const secondUrl = (fetchImpl.mock.calls[1][0] as any).toString();
    expect(firstUrl).toBe("https://api.github.com/repos/acme/widgets/pulls/42/files?per_page=100&page=1");
    expect(secondUrl).toBe("https://api.github.com/repos/acme/widgets/pulls/42/files?per_page=100&page=2");
  });

  test("listBranches aggregates multi-page branch lists identically to before", async () => {
    const fetchImpl = createMockFetch([
      { status: 200, body: [{ name: "main" }, { name: "dev" }] },
      { status: 200, body: [{ name: "feature/x" }] },
    ]);
    const api = createGitHubApi(fetchImpl as unknown as typeof fetch);

    const branches = await api.listBranches({}, "pat", "acme", "widgets", { perPage: 2 });

    expect(branches).toEqual([{ name: "main" }, { name: "dev" }, { name: "feature/x" }]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: test assertion on mock call args
    const firstUrl = (fetchImpl.mock.calls[0][0] as any).toString();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: test assertion on mock call args
    const secondUrl = (fetchImpl.mock.calls[1][0] as any).toString();
    expect(firstUrl).toBe("https://api.github.com/repos/acme/widgets/branches?per_page=2&page=1");
    expect(secondUrl).toBe("https://api.github.com/repos/acme/widgets/branches?per_page=2&page=2");
  });
});

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
