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

describe("Azure DevOps pull request actions", () => {
  test("posts the current user's approval vote to the reviewer endpoint", async () => {
    const fetchImpl = createMockFetch([{ status: 200, body: { vote: 10 } }]);
    const api = createAzureApi(fetchImpl as unknown as typeof fetch);

    await api.approvePullRequest(
      { orgUrl: "https://dev.azure.com/acme", login: "user" },
      "pat",
      "Project One",
      "repo-id",
      42,
      "reviewer-id",
    );

    const [url, options] = fetchImpl.mock.calls[0] as unknown as [string, { method: string; body: string }];
    expect(url).toBe(
      "https://dev.azure.com/acme/Project%20One/_apis/git/repositories/repo-id/pullRequests/42/reviewers/reviewer-id?api-version=7.1",
    );
    expect(options.method).toBe("PUT");
    expect(JSON.parse(options.body)).toEqual({ id: "reviewer-id", vote: 10 });
  });

  test("updates PR status and draft fields without completion options", async () => {
    const fetchImpl = createMockFetch([{ status: 200, body: { status: "completed" } }]);
    const api = createAzureApi(fetchImpl as unknown as typeof fetch);

    await api.updatePullRequest(
      { orgUrl: "https://dev.azure.com/acme", login: "user" },
      "pat",
      "Project One",
      "repo-id",
      42,
      { status: "completed", isDraft: false, lastMergeSourceCommit: { commitId: "expected-head" } },
    );

    const [url, options] = fetchImpl.mock.calls[0] as unknown as [string, { method: string; body: string }];
    expect(url).toBe(
      "https://dev.azure.com/acme/Project%20One/_apis/git/repositories/repo-id/pullRequests/42?api-version=7.1",
    );
    expect(options.method).toBe("PATCH");
    expect(JSON.parse(options.body)).toEqual({
      status: "completed",
      isDraft: false,
      lastMergeSourceCommit: { commitId: "expected-head" },
    });
  });
});

describe("Azure DevOps API - ETag caching", () => {
  test("gets the authenticated identity from the collection root with PAT Basic auth", async () => {
    const fetchImpl = createMockFetch([{ status: 200, body: { authenticatedUser: { id: "vsid-1" } } }]);
    const api = createAzureApi(fetchImpl as unknown as typeof fetch);
    const user = await api.getAuthenticatedUser(
      { orgUrl: "https://tfs.example/tfs/Collection", login: "manual" },
      "pat",
    );
    expect(user).toEqual({ id: "vsid-1" });
    const [url, options] = fetchImpl.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(url).toBe(
      "https://tfs.example/tfs/Collection/_apis/connectionData?connectOptions=0&lastChangeId=-1&lastChangeId64=-1",
    );
    expect(options.headers.Authorization).toBe(`Basic ${Buffer.from(":pat").toString("base64")}`);
  });

  describe("group membership", () => {
    const calls = (fetchImpl: ReturnType<typeof createMockFetch>) => fetchImpl.mock.calls.map(([url]) => String(url));

    test("maps dev.azure.com and visualstudio.com to their identity hosts and keeps an on-prem URL", async () => {
      const cases: Array<[string, string]> = [
        ["https://dev.azure.com/acme", "https://vssps.dev.azure.com/acme/_apis/identities?"],
        ["https://acme.visualstudio.com", "https://acme.vssps.visualstudio.com/_apis/identities?"],
        ["https://tfs.example/tfs/Collection", "https://tfs.example/tfs/Collection/_apis/identities?"],
      ];
      for (const [orgUrl, prefix] of cases) {
        const fetchImpl = createMockFetch([{ status: 200, body: { value: [{ memberOf: [] }] } }]);
        const api = createAzureApi(fetchImpl as unknown as typeof fetch);
        await expect(api.getUserGroupIds({ orgUrl, login: "u" }, "pat", "me-1")).resolves.toEqual([]);
        expect(calls(fetchImpl)[0]).toBe(`${prefix}identityIds=me-1&queryMembership=ExpandedUp&api-version=7.1`);
      }
    });

    test("resolves descriptors in chunks of 25, accepting strings and typed objects", async () => {
      const memberOf = [
        ...Array.from({ length: 26 }, (_, index) => `vssgp.d${index}`),
        { identityType: "Microsoft.TeamFoundation.Identity", identifier: "S-1-9" },
      ];
      const fetchImpl = createMockFetch([
        { status: 200, body: { value: [{ memberOf }] } },
        { status: 200, body: { value: [{ id: "g-a" }, { id: "g-b" }] } },
        { status: 200, body: { value: [{ id: "g-b" }, { id: "g-c" }] } },
      ]);
      const api = createAzureApi(fetchImpl as unknown as typeof fetch);

      const ids = await api.getUserGroupIds({ orgUrl: "https://dev.azure.com/acme", login: "u" }, "pat", "me-1");

      expect(ids.sort()).toEqual(["g-a", "g-b", "g-c"]);
      const urls = calls(fetchImpl);
      expect(urls).toHaveLength(3);
      const first = decodeURIComponent(urls[1].split("descriptors=")[1].split("&")[0]).split(",");
      expect(first).toHaveLength(25);
      expect(decodeURIComponent(urls[2])).toContain("vssgp.d25,Microsoft.TeamFoundation.Identity;S-1-9");
    });

    test("keeps each descriptor query under the IIS query-string limit for long on-prem SIDs", async () => {
      const sid = (index: number) =>
        `Microsoft.TeamFoundation.Identity;S-1-9-1551374245-3661783324-4225370957-2907848618-2523286190-1-1670253583-1618125639-2439500389-${1104673100 + index}`;
      const memberOf = Array.from({ length: 30 }, (_, index) => sid(index));
      const fetchImpl = createMockFetch([
        { status: 200, body: { value: [{ memberOf }] } },
        ...Array.from({ length: 10 }, () => ({ status: 200, body: { value: [] } })),
      ]);
      const api = createAzureApi(fetchImpl as unknown as typeof fetch);

      await api.getUserGroupIds({ orgUrl: "https://tfs.example/tfs/Collection", login: "u" }, "pat", "me-1");

      const lookups = calls(fetchImpl).slice(1);
      for (const url of lookups) expect(new URL(url).search.length).toBeLessThanOrEqual(2048);
      const requested = lookups.flatMap((url) =>
        decodeURIComponent(url.split("descriptors=")[1].split("&")[0]).split(","),
      );
      expect(requested).toEqual(memberOf);
    });

    test("retries once with Expanded after an HTTP 400", async () => {
      const fetchImpl = createMockFetch([
        { status: 400, body: { message: "bad query" } },
        { status: 200, body: { value: [{ memberOf: [] }] } },
      ]);
      const api = createAzureApi(fetchImpl as unknown as typeof fetch);

      await api.getUserGroupIds({ orgUrl: "https://dev.azure.com/acme", login: "u" }, "pat", "me-1");

      expect(calls(fetchImpl)[0]).toContain("queryMembership=ExpandedUp");
      expect(calls(fetchImpl)[1]).toContain("queryMembership=Expanded&");
    });

    test("any other failure is thrown", async () => {
      const fetchImpl = createMockFetch([{ status: 403, body: { message: "denied" } }]);
      const api = createAzureApi(fetchImpl as unknown as typeof fetch);
      await expect(
        api.getUserGroupIds({ orgUrl: "https://dev.azure.com/acme", login: "u" }, "pat", "me-1"),
      ).rejects.toThrow("(403)");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
  });

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
    const url = "https://dev.azure.com/org/_apis/projects?api-version=7.1";
    const authOpts = { login: "user", token: "pat" };

    // First call — no etag
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: test assertion on untyped API response
    const result1 = (await api.requestJson(url, authOpts)) as any;
    expect(result1.value).toHaveLength(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: test assertion on mock call args
    expect((fetchImpl.mock.calls[0][1] as any).headers["If-None-Match"]).toBeUndefined();

    // Second call — should send If-None-Match and return cached data on 304
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: test assertion on untyped API response
    const result2 = (await api.requestJson(url, authOpts)) as any;
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
    const fetchImpl = createMockFetch([{ status: 403, body: { message: "Access denied due to missing PAT scope" } }]);
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
    const fetchImpl = createMockFetch([{ status: 403, body: { message: "Access denied due to missing PAT scope" } }]);
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
