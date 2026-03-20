import { describe, expect, test, vi } from "vitest";
import { createAzureApi } from "./azure-devops-api.js";

function createMockFetch(responses = []) {
  let callIndex = 0;
  return vi.fn(async (url, options) => {
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

    const api = createAzureApi(fetchImpl);
    const connection = { orgUrl: "https://dev.azure.com/org" };
    const authOpts = { login: "user", token: "pat" };

    // First call — no etag
    const result1 = await api.requestJson(
      api.buildProjectsUrl(connection),
      authOpts,
    );
    expect(result1.value).toHaveLength(1);
    expect(fetchImpl.mock.calls[0][1].headers["If-None-Match"]).toBeUndefined();

    // Second call — should send If-None-Match and return cached data on 304
    const result2 = await api.requestJson(
      api.buildProjectsUrl(connection),
      authOpts,
    );
    expect(fetchImpl.mock.calls[1][1].headers["If-None-Match"]).toBe('"abc123"');
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

    const api = createAzureApi(fetchImpl);
    await api.requestJson("https://example.com/api", {
      login: "user",
      token: "pat",
      method: "POST",
      body: { content: "hello" },
    });

    expect(fetchImpl.mock.calls[0][1].headers["If-None-Match"]).toBeUndefined();
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

    const api = createAzureApi(fetchImpl);
    const url = "https://dev.azure.com/org/proj/_apis/git/pullrequests";
    const auth = { login: "user", token: "pat" };

    const result1 = await api.requestJson(url, auth);
    expect(result1.value).toHaveLength(1);

    const result2 = await api.requestJson(url, auth);
    expect(result2.value).toHaveLength(2);
  });
});
