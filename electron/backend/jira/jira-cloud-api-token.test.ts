import { describe, expect, it, vi } from "vitest";
import type { CredentialStore } from "../shared/credential-store.js";
import { JiraManager, type JiraConnection } from "./jira-manager.js";
import { JiraRequestError } from "./jira-request-error.js";

const SITE = "https://example.atlassian.net";
const GATEWAY = "https://api.atlassian.com/ex/jira/cloud-1";
const credentials = { getSecret: () => "api-token-value" } as unknown as CredentialStore;
const basic = `Basic ${Buffer.from("me@example.com:api-token-value").toString("base64")}`;

const cloud: JiraConnection = {
  id: "cloud-a",
  profileId: "default",
  label: "Cloud",
  enabled: true,
  deployment: "cloud",
  webUrl: SITE,
  apiBaseUrl: SITE,
  auth: { kind: "cloud-api-token", secretRef: "jira:cloud-a:api-token", email: "me@example.com" },
  accountPurpose: "personal",
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const self = () => json({ accountId: "acct-1", displayName: "Me" });

type Call = { url: string; authorization: string | null };
function recorder(route: (url: string) => Response | undefined) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, authorization: new Headers(init?.headers).get("authorization") });
    return route(url) ?? json({}, 404);
  });
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

describe("Jira Cloud API token authentication", () => {
  it("sends Basic email:token to the site and verifies the identity", async () => {
    const { calls, fetchImpl } = recorder((url) => (url === `${SITE}/rest/api/3/myself` ? self() : undefined));
    const result = await new JiraManager(credentials, fetchImpl).verify(cloud);
    expect(result).toEqual({
      identity: { kind: "cloud", accountId: "acct-1", displayName: "Me" },
      serverTitle: "Jira Cloud",
    });
    expect(calls).toEqual([{ url: `${SITE}/rest/api/3/myself`, authorization: basic }]);
  });

  it("encodes a non-ASCII email as UTF-8", async () => {
    const { calls, fetchImpl } = recorder(() => self());
    const unicode = { ...cloud, auth: { ...cloud.auth, email: "zoë@example.com" } };
    await new JiraManager(credentials, fetchImpl).verify(unicode);
    expect(calls[0]?.authorization).toBe(`Basic ${Buffer.from("zoë@example.com:api-token-value").toString("base64")}`);
  });

  it("falls back to the gateway on a 401: tenant_info is read without credentials and the cloud id is reported", async () => {
    const { calls, fetchImpl } = recorder((url) => {
      if (url === `${SITE}/rest/api/3/myself`) return json({}, 401);
      if (url === `${SITE}/_edge/tenant_info`) return json({ cloudId: "cloud-1" });
      if (url === `${GATEWAY}/rest/api/3/myself`) return self();
      return undefined;
    });
    const result = await new JiraManager(credentials, fetchImpl).verify(cloud);
    expect(result.cloudId).toBe("cloud-1");
    expect(calls).toEqual([
      { url: `${SITE}/rest/api/3/myself`, authorization: basic },
      { url: `${SITE}/_edge/tenant_info`, authorization: null },
      { url: `${GATEWAY}/rest/api/3/myself`, authorization: basic },
    ]);
  });

  it("uses the persisted gateway root for later requests and never touches the site again", async () => {
    const { calls, fetchImpl } = recorder((url) => {
      if (url === `${GATEWAY}/rest/api/3/project/search?startAt=0&maxResults=500`)
        return json({ values: [{ id: "1", key: "OPS", name: "Ops" }], total: 1 });
      if (url.startsWith(`${GATEWAY}/rest/agile/1.0/board`)) return json({ values: [], isLast: true });
      return undefined;
    });
    const manager = new JiraManager(credentials, fetchImpl);
    const persisted = { ...cloud, cloudId: "cloud-1" };
    await expect(manager.projects(persisted)).resolves.toEqual([{ id: "1", key: "OPS", name: "Ops" }]);
    await manager.searchBoards(persisted).catch(() => undefined);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.url.startsWith(`${GATEWAY}/`) && call.authorization === basic)).toBe(true);
  });

  it("uses the site root, agile root included, when no cloud id is persisted", async () => {
    const { calls, fetchImpl } = recorder(() => json({ values: [], isLast: true }));
    await new JiraManager(credentials, fetchImpl).searchBoards(cloud).catch(() => undefined);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.url.startsWith(`${SITE}/rest/agile/1.0/`))).toBe(true);
  });

  it("does not look the cloud id up again when the persisted gateway root rejects the token", async () => {
    const { calls, fetchImpl } = recorder(() => json({}, 401));
    await expect(
      new JiraManager(credentials, fetchImpl).verify({ ...cloud, cloudId: "cloud-1" }),
    ).rejects.toMatchObject({
      code: "auth-expired",
      statusCode: 401,
    });
    expect(calls.map((call) => call.url)).toEqual([`${GATEWAY}/rest/api/3/myself`]);
  });

  it.each([
    ["a path traversal", "../evil"],
    ["a slash", "a/b"],
    ["a dot", "a.b"],
    ["whitespace", "a b"],
    ["an empty id", ""],
    ["a number", 42],
    ["a very long id", "a".repeat(200)],
  ])("rejects tenant_info answering %s and never sends the token to the gateway", async (_label, cloudId) => {
    const { calls, fetchImpl } = recorder((url) => {
      if (url === `${SITE}/rest/api/3/myself`) return json({}, 401);
      if (url === `${SITE}/_edge/tenant_info`) return json({ cloudId });
      return self();
    });
    await expect(new JiraManager(credentials, fetchImpl).verify(cloud)).rejects.toMatchObject({
      code: "auth-expired",
      message: expect.stringMatching(/cloud id/),
    });
    expect(calls.some((call) => call.url.startsWith("https://api.atlassian.com"))).toBe(false);
    expect(calls.filter((call) => call.authorization !== null).map((call) => call.url)).toEqual([
      `${SITE}/rest/api/3/myself`,
    ]);
  });

  it.each([
    ["an HTTP error", () => json({}, 500)],
    ["a page instead of JSON", () => new Response("<html>sign in</html>")],
    ["a body without a cloud id", () => json({ other: true })],
  ])("explains a tenant_info failure (%s) together with the rejected credentials", async (_label, answer) => {
    const { fetchImpl } = recorder((url) =>
      url === `${SITE}/rest/api/3/myself` ? json({}, 401) : url.endsWith("/_edge/tenant_info") ? answer() : undefined,
    );
    const error = await new JiraManager(credentials, fetchImpl).verify(cloud).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(JiraRequestError);
    expect(error).toMatchObject({ code: "auth-expired", statusCode: 401 });
    expect((error as Error).message).toMatch(/email or API token/);
    expect((error as Error).message).toMatch(/example\.atlassian\.net/);
  });

  it("reports a network failure of tenant_info without leaking the token", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/rest/api/3/myself")) return json({}, 401);
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const error = await new JiraManager(credentials, fetchImpl).verify(cloud).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: "auth-expired" });
    expect((error as Error).message).not.toContain("api-token-value");
  });

  it("explains a gateway 401 and a 403 with what to check", async () => {
    const unauthorized = recorder((url) =>
      url.endsWith("/_edge/tenant_info") ? json({ cloudId: "cloud-1" }) : json({}, 401),
    );
    await expect(new JiraManager(credentials, unauthorized.fetchImpl).verify(cloud)).rejects.toMatchObject({
      code: "auth-expired",
      statusCode: 401,
      message: expect.stringMatching(/not expired or been revoked/),
    });
    const forbidden = recorder(() => json({}, 403));
    await expect(new JiraManager(credentials, forbidden.fetchImpl).verify(cloud)).rejects.toMatchObject({
      code: "permission-denied",
      statusCode: 403,
      message: expect.stringMatching(/read:jira-user/),
    });
    expect(forbidden.calls).toHaveLength(1);
  });

  it("sends credentials to no host other than the site or the gateway of its own cloud id", async () => {
    const { calls, fetchImpl } = recorder((url) => {
      if (url === `${SITE}/rest/api/3/myself`) return json({}, 401);
      if (url === `${SITE}/_edge/tenant_info`) return json({ cloudId: "cloud-1" });
      return url.endsWith("/myself") ? self() : json({ fields: { attachment: [] } });
    });
    const manager = new JiraManager(credentials, fetchImpl);
    await manager.verify(cloud);
    await manager.verify({ ...cloud, cloudId: "cloud-1" });
    for (const call of calls.filter((entry) => entry.authorization !== null))
      expect(call.url.startsWith(`${SITE}/rest/api/3/`) || call.url.startsWith(`${GATEWAY}/rest/api/3/`)).toBe(true);
  });

  it("refuses an insecure or credential-carrying site URL before any request", async () => {
    const { calls, fetchImpl } = recorder(() => self());
    const manager = new JiraManager(credentials, fetchImpl);
    await expect(manager.verify({ ...cloud, webUrl: "http://example.atlassian.net" })).rejects.toThrow(/HTTPS/);
    await expect(manager.verify({ ...cloud, webUrl: "https://user:pw@example.atlassian.net" })).rejects.toThrow(
      /credentials/,
    );
    expect(calls).toEqual([]);
  });

  it("refuses a persisted cloud id that is not a plain id", async () => {
    const { calls, fetchImpl } = recorder(() => self());
    await expect(new JiraManager(credentials, fetchImpl).verify({ ...cloud, cloudId: "../x" })).rejects.toThrow(
      /invalid cloudId/,
    );
    expect(calls).toEqual([]);
  });

  it("never follows a redirect with the credentials", async () => {
    const seen: Array<RequestInit | undefined> = [];
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(init);
      return self();
    }) as unknown as typeof fetch;
    await new JiraManager(credentials, fetchImpl).verify(cloud);
    expect(seen.every((init) => init?.redirect === "error")).toBe(true);
  });

  it("reports a missing token or email as a not-sent configuration problem", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const empty = { getSecret: () => "" } as unknown as CredentialStore;
    await expect(new JiraManager(empty, fetchImpl).verify(cloud)).rejects.toMatchObject({
      code: "credential-missing",
      notSent: true,
    });
    const noEmail = { ...cloud, auth: { kind: "cloud-api-token" as const, secretRef: "jira:cloud-a:api-token" } };
    await expect(new JiraManager(credentials, fetchImpl).verify(noEmail)).rejects.toMatchObject({
      code: "configuration-incomplete",
      notSent: true,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
