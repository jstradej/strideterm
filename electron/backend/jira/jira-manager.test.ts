import { describe, expect, it, vi } from "vitest";
import {
  applyJiraProjectScope,
  JiraManager,
  JiraRequestError,
  jiraWriteTextFingerprint,
  normalizeJiraProjectKeys,
  withinJiraCallBudget,
  type JiraConnection,
} from "./jira-manager.js";
import type { CredentialStore } from "../shared/credential-store.js";
import { Agent } from "undici";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createJiraCache } from "./jira-cache.js";

const dc: JiraConnection = {
  id: "jira-a",
  profileId: "default",
  label: "DC",
  enabled: true,
  deployment: "data-center",
  webUrl: "https://jira.example.com",
  apiBaseUrl: "https://jira.example.com/jira",
  auth: { kind: "dc-pat", secretRef: "jira:jira-a:pat" },
  accountPurpose: "personal",
};
const credentials = { getSecret: () => "secret-pat" } as unknown as CredentialStore;
const basicAuth = (email: string, token: string) => `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;

describe("JiraManager", () => {
  it("adds validated project scope before only a top-level ORDER BY", () => {
    expect(normalizeJiraProjectKeys([" ops ", "APP", "ops"])).toEqual(["APP", "OPS"]);
    expect(applyJiraProjectScope('summary ~ "ORDER BY" AND (project = OLD)', ["Ops"])).toBe(
      '(summary ~ "ORDER BY" AND (project = OLD)) AND project IN ("OPS")',
    );
    expect(
      applyJiraProjectScope(
        "project = OPS OR (assignee = currentUser() OR reporter = currentUser()) ORDER BY updated DESC",
        ["OPS"],
      ),
    ).toBe(
      '(project = OPS OR (assignee = currentUser() OR reporter = currentUser())) AND project IN ("OPS") ORDER BY updated DESC',
    );
    expect(applyJiraProjectScope('assignee = "a\\"ORDER BY x" ORDER BY updated DESC', ["A"])).toBe(
      '(assignee = "a\\"ORDER BY x") AND project IN ("A") ORDER BY updated DESC',
    );
    expect(applyJiraProjectScope("ORDER BY updated DESC", ["A"])).toBe('project IN ("A") ORDER BY updated DESC');
    const scoped = applyJiraProjectScope("assignee = currentUser()", ["OPS"]);
    expect(applyJiraProjectScope(scoped, ["OPS"])).toBe(scoped);
    const quoted = applyJiraProjectScope('summary ~ "(a) OR (b)"', ["OPS"]);
    expect(applyJiraProjectScope(quoted, ["OPS"])).toBe(quoted);
    expect(applyJiraProjectScope('assignee = alice OR assignee = bob AND project IN ("OPS")', ["OPS"])).toBe(
      '(assignee = alice OR assignee = bob AND project IN ("OPS")) AND project IN ("OPS")',
    );
    expect(applyJiraProjectScope('(assignee = alice) OR (assignee = bob AND project IN ("OPS"))', ["OPS"])).toBe(
      '((assignee = alice) OR (assignee = bob AND project IN ("OPS"))) AND project IN ("OPS")',
    );
    expect(() => normalizeJiraProjectKeys(["OPS; DELETE"])).toThrow(/invalid/i);
    expect(() => applyJiraProjectScope("x".repeat(1990), ["OPS"])).toThrow(/2000/);
  });

  it("bounds and persists the project catalog in SQLite", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "jira-manager-project-catalog-"));
    const cachePath = path.join(directory, "cache.sqlite");
    let persistentCache = createJiraCache(cachePath);
    const rows = Array.from({ length: 600 }, (_, index) => ({
      id: String(index + 1),
      key: `P${index + 1}`,
      name: `Project ${index + 1}`,
    }));
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify(rows)));
    try {
      const first = new JiraManager(credentials, fetchImpl as typeof fetch, persistentCache);
      expect((await first.projects(dc)).length).toBe(500);
      expect(new URL(String(fetchImpl.mock.calls[0]?.[0])).searchParams.get("maxResults")).toBe("500");
      await first.projects(dc);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      persistentCache.close();
      persistentCache = createJiraCache(cachePath);
      const restarted = new JiraManager(credentials, fetchImpl as typeof fetch, persistentCache);
      expect((await restarted.projects(dc)).length).toBe(500);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      persistentCache.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses the server-side project catalog search endpoint for Jira Cloud", async () => {
    const cloud: JiraConnection = {
      ...dc,
      deployment: "cloud",
      cloudId: "cloud-1",
      apiBaseUrl: "https://api.atlassian.com/ex/jira/cloud-1/rest/api/3",
      webUrl: "https://example.atlassian.net",
      auth: { kind: "cloud-api-token", secretRef: "jira:cloud:token", email: "me@example.com" },
    };
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      expect(new URL(String(input)).pathname).toBe("/ex/jira/cloud-1/rest/api/3/project/search");
      return new Response(JSON.stringify({ values: [{ id: "1", key: "OPS", name: "Operations" }], total: 1 }));
    });
    const manager = new JiraManager(credentials, fetchImpl as typeof fetch);
    await expect(manager.projects(cloud)).resolves.toEqual([{ id: "1", key: "OPS", name: "Operations" }]);
  });

  it("scopes issue search upstream and distinguishes inherited, selected, and all-project cache keys", async () => {
    const connection: JiraConnection = { ...dc, projectKeys: ["OPS"] };
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL) => new Response(JSON.stringify({ issues: [], total: 0, startAt: 0 })),
    );
    const manager = new JiraManager(credentials, fetchImpl as typeof fetch);
    await manager.searchPage(connection, "assignee = currentUser() ORDER BY updated DESC", 10);
    expect(new URL(String(fetchImpl.mock.calls[0]?.[0])).searchParams.get("jql")).toBe(
      '(assignee = currentUser()) AND project IN ("OPS") ORDER BY updated DESC',
    );
    await manager.searchPage(connection, "assignee = currentUser() ORDER BY updated DESC", 10, undefined, {
      projectKeys: ["APP"],
    });
    expect(new URL(String(fetchImpl.mock.calls[1]?.[0])).searchParams.get("jql")).toBe(
      '(assignee = currentUser()) AND project IN ("APP") ORDER BY updated DESC',
    );
    await manager.searchPage(connection, "assignee = currentUser() ORDER BY updated DESC", 10, undefined, {
      projectKeys: [],
    });
    expect(new URL(String(fetchImpl.mock.calls[2]?.[0])).searchParams.get("jql")).toBe(
      "assignee = currentUser() ORDER BY updated DESC",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("does not share a completed native board page between different project scopes", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "jira-manager-board-project-scope-"));
    const cache = createJiraCache(path.join(directory, "cache.sqlite"));
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/configuration")) return new Response("{}");
      return new Response(JSON.stringify({ issues: [], total: 0, isLast: true }));
    });
    try {
      const manager = new JiraManager(credentials, fetchImpl as typeof fetch, cache);
      await manager.boardView(dc, 17, "issues", undefined, undefined, { projectKeys: ["OPS"] });
      await manager.boardView(dc, 17, "issues", undefined, undefined, { projectKeys: ["APP"] });
      const afterTwoScopes = fetchImpl.mock.calls.length;
      expect(afterTwoScopes).toBe(4);
      const issueQueries = fetchImpl.mock.calls
        .map(([input]) => new URL(String(input)))
        .filter((url) => url.pathname.endsWith("/issue"));
      expect(issueQueries.map((url) => url.searchParams.get("jql"))).toEqual([
        'project IN ("OPS")',
        'project IN ("APP")',
      ]);
      await manager.boardView(dc, 17, "issues", undefined, undefined, { projectKeys: ["OPS"] });
      expect(fetchImpl).toHaveBeenCalledTimes(afterTwoScopes);
    } finally {
      cache.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("canonicalizes project order and duplicate keys for issue cache identity", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "jira-manager-search-project-scope-"));
    const cache = createJiraCache(path.join(directory, "cache.sqlite"));
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ issues: [], total: 0, startAt: 0 })));
    try {
      const manager = new JiraManager(credentials, fetchImpl as typeof fetch, cache);
      await manager.searchPage(dc, "ORDER BY updated DESC", 10, undefined, { projectKeys: ["OPS", "APP"] });
      await manager.searchPage(dc, "ORDER BY updated DESC", 10, undefined, { projectKeys: [" app ", "OPS", "ops"] });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      cache.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps an in-flight broad issue search separate from a narrowed scope", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "jira-manager-search-flight-scope-"));
    const cache = createJiraCache(path.join(directory, "cache.sqlite"));
    const resolvers: Array<(response: Response) => void> = [];
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL) =>
        new Promise<Response>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    try {
      const manager = new JiraManager(credentials, fetchImpl as typeof fetch, cache);
      const broadPending = manager.searchPage(dc, "ORDER BY updated DESC", 10);
      const scopedPending = manager.searchPage(dc, "ORDER BY updated DESC", 10, undefined, { projectKeys: ["OPS"] });
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
      expect(new URL(String(fetchImpl.mock.calls[0]?.[0])).searchParams.get("jql")).toBe("ORDER BY updated DESC");
      expect(new URL(String(fetchImpl.mock.calls[1]?.[0])).searchParams.get("jql")).toBe(
        'project IN ("OPS") ORDER BY updated DESC',
      );
      const makeResponse = (id: string, key: string) =>
        new Response(
          JSON.stringify({
            issues: [
              {
                id,
                key,
                fields: {
                  summary: key,
                  status: { name: "Open" },
                  issuetype: { name: "Task" },
                  project: { key: "OPS" },
                  updated: "2026-10-28T00:00:00Z",
                },
              },
            ],
            total: 1,
            startAt: 0,
          }),
        );
      resolvers[0]?.(makeResponse("1", "BROAD-1"));
      resolvers[1]?.(makeResponse("2", "OPS-2"));
      const [broad, scoped] = await Promise.all([broadPending, scopedPending]);
      expect(broad?.issues.map((issue) => issue.ref.issueKey)).toEqual(["BROAD-1"]);
      expect(scoped?.issues.map((issue) => issue.ref.issueKey)).toEqual(["OPS-2"]);
    } finally {
      cache.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("scopes board discovery upstream and retains project-associated boards independent of location", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const projectKey = url.searchParams.get("projectKeyOrId");
      return new Response(
        JSON.stringify({
          total: 2,
          isLast: true,
          values:
            projectKey === "OTHER"
              ? [{ id: 2, name: "Ops-located", type: "scrum", location: { projectKey: "OPS" } }]
              : [
                  { id: 1, name: "App-located", type: "kanban", location: { projectKey: "APP" } },
                  { id: 3, name: "Shared", type: "kanban" },
                ],
        }),
      );
    });
    const manager = new JiraManager(credentials, fetchImpl as typeof fetch);
    const one = await manager.searchBoards(dc, { projectKeys: ["OPS"] });
    expect(new URL(String(fetchImpl.mock.calls[0]?.[0])).searchParams.get("projectKeyOrId")).toBe("OPS");
    expect(one.boards.map((board) => board.id)).toEqual([1, 3]);
    const many = await manager.searchBoards(dc, { projectKeys: ["OPS", "OTHER"] });
    expect(many.boards.map((board) => board.id)).toEqual([1, 2, 3]);
    expect(
      fetchImpl.mock.calls.slice(1).map(([input]) => new URL(String(input)).searchParams.get("projectKeyOrId")),
    ).toEqual(["OPS", "OTHER"]);
  });

  it("bounds multi-project board discovery to eight projects and surfaces truncated one-page results", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      return new Response(
        JSON.stringify({
          total: 100,
          isLast: false,
          values: [{ id: url.searchParams.get("projectKeyOrId") === "OPS" ? 1 : 2, name: "Board", type: "kanban" }],
        }),
      );
    });
    const manager = new JiraManager(credentials, fetchImpl as typeof fetch);
    const page = await manager.searchBoards(dc, { projectKeys: ["OPS", "APP"] });
    expect(page).toMatchObject({ boards: [{ id: 1 }, { id: 2 }], hasMore: false, truncated: true });
    expect(page.nextCursor).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await expect(
      manager.searchBoards(dc, { projectKeys: Array.from({ length: 9 }, (_, index) => `P${index}`) }),
    ).rejects.toThrow(/up to 8 projects/i);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("reads one board's metadata through its scoped cached endpoint", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "jira-manager-board-metadata-"));
    const persistentCache = createJiraCache(path.join(directory, "cache.sqlite"));
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/jira/rest/agile/1.0/board/42");
      return new Response(
        JSON.stringify({ id: 42, name: "Platform", type: "scrum", location: { projectKey: "PLAT" } }),
      );
    });
    try {
      const manager = new JiraManager(credentials, fetchImpl as typeof fetch, persistentCache);

      await expect(manager.boardMetadata(dc, 42)).resolves.toEqual({
        id: 42,
        name: "Platform",
        type: "scrum",
        location: { projectKey: "PLAT" },
      });
      await manager.boardMetadata(dc, 42);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      persistentCache.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("loads bounded continuation pages for multi-project board catalogs and deduplicates boards", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const projectKey = url.searchParams.get("projectKeyOrId");
      const startAt = Number(url.searchParams.get("startAt") || 0);
      const total = projectKey === "OPS" ? 120 : 100;
      const values = Array.from({ length: Math.min(100, total - startAt) }, (_, index) => {
        const offset = startAt + index;
        return {
          id: projectKey === "OPS" ? offset + 1 : offset + 101,
          name: `${projectKey} board ${offset}`,
          type: "kanban",
        };
      });
      return new Response(JSON.stringify({ total, startAt, isLast: startAt + values.length >= total, values }));
    });
    const manager = new JiraManager(credentials, fetchImpl as typeof fetch);

    const boards = await manager.boards(dc, ["OPS", "APP"]);

    expect(boards).toHaveLength(200);
    expect(boards.map((board) => board.id)).toEqual(
      [...new Set(boards.map((board) => board.id))].sort((a, b) => a - b),
    );
    expect(boards.some((board) => board.id === 120)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(
      fetchImpl.mock.calls
        .map(([input]) => {
          const url = new URL(String(input));
          return [url.searchParams.get("projectKeyOrId"), url.searchParams.get("startAt")];
        })
        .sort((left, right) => `${left[0]}:${left[1]}`.localeCompare(`${right[0]}:${right[1]}`)),
    ).toEqual([
      ["APP", "0"],
      ["OPS", "0"],
      ["OPS", "100"],
    ]);
  });

  it("bounds aggregate multi-project board catalog reads by one shared deadline", async () => {
    const fetchImpl = vi.fn(async () => new Promise<Response>(() => undefined));
    const manager = new JiraManager(credentials, fetchImpl as typeof fetch);

    await expect(manager.boards(dc, ["OPS", "APP"], { maxDurationMs: 5 })).rejects.toMatchObject({ code: "network" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("bounds single-project legacy board catalog reads by one shared deadline", async () => {
    const fetchImpl = vi.fn(async () => new Promise<Response>(() => undefined));
    const manager = new JiraManager(credentials, fetchImpl as typeof fetch);

    await expect(manager.boards(dc, ["OPS"], { maxDurationMs: 5 })).rejects.toMatchObject({ code: "network" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("supports key-only API gateways without creating a client-certificate dispatcher", async () => {
    const connection: JiraConnection = {
      ...dc,
      apiBaseUrl: "https://gateway.example.test/jira-prefix",
      subscriptionHeaderName: "Ocp-Apim-Subscription-Key",
      auth: { kind: "dc-apim", secretRef: "jira:key" },
    };
    const store = { getSecret: () => "test-only-subscription-key" } as unknown as CredentialStore;
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ name: "user" })),
    );
    const manager = new JiraManager(store, fetchImpl as typeof fetch);
    await manager.verify(connection);
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit & { dispatcher?: unknown };
    expect(init.dispatcher).toBeUndefined();
    expect(new Headers(init.headers).get("Ocp-Apim-Subscription-Key")).toBe("test-only-subscription-key");
  });

  it("reports missing saved certificate metadata before a passworded APIM request reaches the gateway", async () => {
    const connection: JiraConnection = {
      ...dc,
      apiBaseUrl: "https://gateway.example.test/jira-prefix",
      subscriptionHeaderName: "Ocp-Apim-Subscription-Key",
      auth: { kind: "dc-apim", secretRef: "jira:key", passphraseRef: "jira:passphrase" },
    };
    const fetchImpl = vi.fn(async () => new Response("", { status: 403 }));
    const manager = new JiraManager(credentials, fetchImpl as typeof fetch);

    await expect(manager.verify(connection)).rejects.toMatchObject({
      code: "configuration-incomplete",
      message: expect.stringContaining("client certificate file is missing"),
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("uses the gateway prefix, subscription header, and client certificate for reads and writes", async () => {
    const key = "test-only-subscription-key";
    const pfxPath = fileURLToPath(new URL("./__fixtures__/jira-test-client.pfx", import.meta.url));
    const connection: JiraConnection = {
      ...dc,
      apiBaseUrl: "https://gateway.example.test/it/operation/jira-5/v1",
      clientCertificatePath: pfxPath,
      subscriptionHeaderName: "Ocp-Apim-Subscription-Key",
      auth: { kind: "dc-apim", secretRef: "jira:test:key", passphraseRef: "jira:test:pass" },
    };
    const secretStore = {
      getSecret: (ref: string) => (ref.endsWith(":key") ? key : "test-only-passphrase"),
    } as unknown as CredentialStore;
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ name: "Test user", displayName: "Test user" })),
    );
    const manager = new JiraManager(secretStore, fetchImpl as typeof fetch);
    const closeAgent = vi.spyOn(Agent.prototype, "close");
    const destroyAgent = vi.spyOn(Agent.prototype, "destroy");

    try {
      await manager.verify(connection);
      const readInit = fetchImpl.mock.calls[0]?.[1] as RequestInit & { dispatcher?: unknown };
      expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
        "https://gateway.example.test/it/operation/jira-5/v1/rest/api/latest/myself",
      );
      expect(new Headers(readInit.headers).get("Ocp-Apim-Subscription-Key")).toBe(key);
      expect(new Headers(readInit.headers).has("Authorization")).toBe(false);
      expect(readInit.dispatcher).toBeInstanceOf(Agent);

      fetchImpl.mockClear();
      fetchImpl
        .mockImplementationOnce(async () => new Response("", { status: 429, headers: { "retry-after": "0" } }))
        .mockImplementationOnce(async () => new Response(JSON.stringify({ name: "Test user" })));
      await manager.verify(connection);
      const firstRetryDispatcher = (fetchImpl.mock.calls[0]?.[1] as RequestInit & { dispatcher?: unknown }).dispatcher;
      const secondRetryDispatcher = (fetchImpl.mock.calls[1]?.[1] as RequestInit & { dispatcher?: unknown }).dispatcher;
      expect(firstRetryDispatcher).toBe(secondRetryDispatcher);

      fetchImpl.mockClear();
      await manager.addComment(connection, "100", "test comment");
      const writeInit = fetchImpl.mock.calls[0]?.[1] as RequestInit & { dispatcher?: unknown };
      expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
        "https://gateway.example.test/it/operation/jira-5/v1/rest/api/latest/issue/100/comment",
      );
      expect(new Headers(writeInit.headers).get("Ocp-Apim-Subscription-Key")).toBe(key);
      expect(writeInit.dispatcher).toBeInstanceOf(Agent);
      expect(closeAgent.mock.calls.length).toBeGreaterThanOrEqual(2);

      fetchImpl.mockRejectedValueOnce(new Error("local simulated transport failure"));
      await expect(manager.verify(connection)).rejects.toMatchObject({ code: "network" });
      expect(destroyAgent).toHaveBeenCalled();
    } finally {
      closeAgent.mockRestore();
      destroyAgent.mockRestore();
    }
  });

  it("maps Jira-host attachment metadata onto the configured APIM gateway for mTLS downloads", async () => {
    const key = "attachment-test-key";
    const pfxPath = fileURLToPath(new URL("./__fixtures__/jira-test-client.pfx", import.meta.url));
    const connection: JiraConnection = {
      ...dc,
      apiBaseUrl: "https://gateway.example.test/it/operation/jira-5/v1",
      clientCertificatePath: pfxPath,
      subscriptionHeaderName: "Ocp-Apim-Subscription-Key",
      auth: { kind: "dc-apim", secretRef: "jira:attachment:key", passphraseRef: "jira:attachment:pass" },
    };
    const secretStore = {
      getSecret: (ref: string) => (ref.endsWith(":key") ? key : "test-only-passphrase"),
    } as unknown as CredentialStore;
    let contentInit: RequestInit | undefined;
    let contentUrl: URL | undefined;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/issue/100"))
        return new Response(
          JSON.stringify({
            fields: {
              attachment: [
                {
                  id: "5",
                  filename: "a.txt",
                  size: 3,
                  mimeType: "text/plain",
                  content: "https://jira.example.com/jira/secure/attachment/5/a.txt",
                },
              ],
            },
          }),
        );
      contentUrl = url;
      contentInit = init;
      return new Response(new Uint8Array([1, 2, 3]));
    });
    const manager = new JiraManager(secretStore, fetchImpl as typeof fetch);
    const downloaded = await manager.attachmentBytes(connection, "100", "5");
    expect(fetchImpl.mock.calls.map(([input]) => String(input))).toEqual([
      "https://gateway.example.test/it/operation/jira-5/v1/rest/api/latest/issue/100?fields=attachment",
      "https://gateway.example.test/it/operation/jira-5/v1/secure/attachment/5/a.txt",
    ]);
    expect(contentUrl?.origin).toBe("https://gateway.example.test");
    expect(contentUrl?.pathname).toBe("/it/operation/jira-5/v1/secure/attachment/5/a.txt");
    expect(contentInit?.redirect).toBe("error");
    expect(new Headers(contentInit?.headers).get("Ocp-Apim-Subscription-Key")).toBe(key);
    expect((contentInit as RequestInit & { dispatcher?: unknown }).dispatcher).toBeInstanceOf(Agent);
    expect(downloaded).toMatchObject({
      fileName: "a.txt",
      mediaType: "text/plain",
      bytes: new Uint8Array([1, 2, 3]),
    });
  });

  it("uploads bounded Jira attachments using the gateway path, subscription key, and client certificate", async () => {
    const key = "upload-test-key";
    const pfxPath = fileURLToPath(new URL("./__fixtures__/jira-test-client.pfx", import.meta.url));
    const connection: JiraConnection = {
      ...dc,
      apiBaseUrl: "https://gateway.example.test/it/operation/jira-5/v1",
      clientCertificatePath: pfxPath,
      subscriptionHeaderName: "Ocp-Apim-Subscription-Key",
      auth: { kind: "dc-apim", secretRef: "jira:upload:key", passphraseRef: "jira:upload:pass" },
    };
    const secretStore = {
      getSecret: (ref: string) => (ref.endsWith(":key") ? key : "test-only-passphrase"),
    } as unknown as CredentialStore;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/it/operation/jira-5/v1/rest/api/latest/issue/ABC-1/attachments");
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get("Ocp-Apim-Subscription-Key")).toBe(key);
      expect(new Headers(init?.headers).get("X-Atlassian-Token")).toBe("no-check");
      expect((init as RequestInit & { dispatcher?: unknown }).dispatcher).toBeInstanceOf(Agent);
      expect(init?.body).toBeInstanceOf(FormData);
      const file = (init?.body as FormData).get("file") as File;
      expect(file.name).toBe("report.txt");
      expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
      return new Response("[]");
    });
    const manager = new JiraManager(secretStore, fetchImpl as typeof fetch);
    await manager.uploadAttachment(connection, "ABC-1", "report.txt", "text/plain", new Uint8Array([1, 2, 3]));
    await expect(
      manager.uploadAttachment(connection, "ABC-1", "report.txt", "text/plain", new Uint8Array()),
    ).rejects.toThrow("between 1 byte and 10 MiB");
  });

  it("loads bounded Jira-owned favorite filters on the selected instance", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/filter/favourite"))
        return new Response(
          JSON.stringify([
            { id: "42", name: "My work" },
            { id: "../../bad", name: "bad" },
          ]),
        );
      throw new Error(`Unexpected eager filter lookup: ${url.pathname}`);
    });
    const manager = new JiraManager(credentials, fetchImpl as typeof fetch);
    await expect(manager.favoriteFilters(dc)).resolves.toEqual([{ id: "42", name: "My work" }]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("normalizes bounded attachment metadata on issue details without forwarding content URLs", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: "100",
            key: "ABC-1",
            fields: {
              summary: "Issue",
              attachment: [
                {
                  id: "5",
                  filename: "report.pdf",
                  mimeType: "application/pdf",
                  size: 321,
                  content: "https://jira.example.com/jira/secure/attachment/5/report.pdf",
                },
                { id: "../bad", filename: "ignored", size: 2 },
              ],
            },
          }),
        ),
    );
    const manager = new JiraManager(credentials, fetchImpl as typeof fetch);
    const result = await manager.issue(dc, "ABC-1");
    expect(result.attachments).toEqual([
      { id: "5", fileName: "report.pdf", mediaType: "application/pdf", sizeBytes: 321 },
    ]);
    expect(JSON.stringify(result)).not.toContain("secure/attachment");
  });
  it("reconciles a timed-out comment by bounded paginated body hash and actual author", async () => {
    const first = Array.from({ length: 100 }, (_, index) => ({
      id: String(index),
      created: "2026-10-23T11:00:00.000Z",
      author: { name: "alice" },
      body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "other" }] }] },
    }));
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/jira/rest/api/2/issue/100/comment");
      if (url.searchParams.get("startAt") === "0")
        return new Response(JSON.stringify({ startAt: 0, total: 101, comments: first }));
      return new Response(
        JSON.stringify({
          startAt: 100,
          total: 101,
          comments: [
            {
              id: "101",
              created: "2026-10-23T11:01:00.000Z",
              author: { name: "alice" },
              body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Posted" }] }] },
            },
          ],
        }),
      );
    });
    const manager = new JiraManager(credentials, fetchImpl as typeof fetch);
    await expect(
      manager.reconcileCommentWrite(dc, "100", {
        fingerprint: jiraWriteTextFingerprint("Posted"),
        actor: { kind: "data-center", name: "alice" },
        submittedAt: Date.parse("2026-10-23T11:00:30.000Z"),
      }),
    ).resolves.toBe("applied");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not report comment absence when bounded reconciliation pages are incomplete", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ total: 1000, comments: Array.from({ length: 100 }, (_, id) => ({ id, body: "no match" })) }),
        ),
    );
    const manager = new JiraManager(credentials, fetchImpl as typeof fetch);
    await expect(
      manager.reconcileCommentWrite(dc, "100", {
        fingerprint: jiraWriteTextFingerprint("not present"),
        submittedAt: Date.now(),
      }),
    ).resolves.toBe("unknown");
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });

  it("reconciles worklogs by exact fingerprint and returns exact remote-link globalId presence", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/worklog"))
        return new Response(
          JSON.stringify({
            total: 1,
            startAt: 0,
            worklogs: [
              {
                created: "2026-10-23T11:00:00.000Z",
                started: "2026-10-23T10:00:00.000Z",
                timeSpentSeconds: 600,
                author: { name: "alice" },
                comment: "Checked the deployment",
              },
            ],
          }),
        );
      expect(url.searchParams.get("globalId")).toBe("https://github.com/org/repo/pull/1");
      return new Response(JSON.stringify([{ id: "8", globalId: "https://github.com/org/repo/pull/1" }]));
    });
    const manager = new JiraManager(credentials, fetchImpl as typeof fetch);
    const submittedAt = Date.parse("2026-10-23T11:00:30.000Z");
    await expect(
      manager.reconcileWorklogWrite(dc, "100", {
        fingerprint: "worklog-fingerprint",
        submittedAt,
        actor: { kind: "data-center", name: "alice" },
        seconds: 600,
        started: "2026-10-23T10:00:00.000Z",
        commentHash: jiraWriteTextFingerprint("Checked the deployment"),
      }),
    ).resolves.toBe("applied");
    await expect(manager.hasRemoteLink(dc, "100", "https://github.com/org/repo/pull/1")).resolves.toBe(true);
  });

  it("uses the DC context path, bearer PAT, and normalizes stable issue identity", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(new URL(String(input)).pathname).toBe("/jira/rest/api/2/issue/10001");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret-pat");
      return new Response(
        JSON.stringify({
          id: "10001",
          key: "OPS-2",
          fields: {
            summary: "Fix",
            status: { name: "Open" },
            issuetype: { name: "Task" },
            project: { key: "OPS" },
            updated: "2026-10-23T00:00:00.000Z",
          },
        }),
      );
    });
    const manager = new JiraManager(credentials, fetchImpl as typeof fetch);
    const issue = await manager.issue(dc, "10001");
    expect(issue.ref).toEqual({ provider: "jira", connectionId: "jira-a", issueId: "10001", issueKey: "OPS-2" });
    expect(issue.url).toBe("https://jira.example.com/browse/OPS-2");
  });

  it("preserves the Data Center context path in the browser issue URL", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ id: "1", key: "OPS-1", fields: {} })));
    const manager = new JiraManager(credentials, fetchImpl as typeof fetch);
    const issue = await manager.issue({ ...dc, webUrl: "https://jira.example.com/jira" }, "1");
    expect(issue.url).toBe("https://jira.example.com/jira/browse/OPS-1");
  });

  it("normalizes ADF and Data Center wiki descriptions to bounded plain text", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: "1",
            key: "OPS-1",
            fields: {
              summary: "Safe",
              status: { name: "Open" },
              issuetype: { name: "Task" },
              project: { key: "OPS" },
              updated: "2026-10-23T00:00:00Z",
              description: {
                type: "doc",
                content: [
                  { type: "heading", content: [{ type: "text", text: "Title" }] },
                  { type: "paragraph", content: [{ type: "text", text: "ADF body" }] },
                  {
                    type: "paragraph",
                    content: [
                      { type: "text", text: `h2. Wiki\n*bold* [link|https://example.invalid]\n${"x".repeat(40_000)}` },
                    ],
                  },
                ],
              },
            },
          }),
        ),
    );
    const manager = new JiraManager(credentials, fetchImpl as typeof fetch);
    const issue = await manager.issue(dc, "1");
    expect(issue.description).toContain("Title");
    expect(issue.description).toContain("ADF body");
    expect(issue.description).toContain("Wiki");
    expect(issue.description).toContain("bold link");
    expect(issue.description!.length).toBeLessThanOrEqual(32_000);
    expect(issue.description).not.toContain("*bold*");
    expect(issue.description).not.toContain("https://example.invalid");
    expect(issue.descriptionMarkdown).toContain("# Title");
    expect(issue.descriptionMarkdown).toContain("\\*bold\\*");
    expect(issue.descriptionMarkdown).toContain("\\[link\\|https://example\\.invalid\\]");
  });

  it("asks Jira for rendered HTML and bounds it", async () => {
    const urls: string[] = [];
    const big = `<p>${"x".repeat(200_001)}</p>`;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      urls.push(`${url.pathname}${url.search}`);
      if (url.pathname.endsWith("/comment"))
        return new Response(
          JSON.stringify({
            comments: [
              { id: "1", author: { displayName: "A" }, body: "raw", renderedBody: "<p><b>raw</b></p>" },
              { id: "2", author: { displayName: "B" }, body: "raw2", renderedBody: big },
            ],
          }),
        );
      return new Response(
        JSON.stringify({
          id: "1",
          key: "OPS-1",
          fields: { description: "*d*" },
          renderedFields: { description: "<p><b>d</b></p>" },
        }),
      );
    });
    const manager = new JiraManager(credentials, fetchImpl as typeof fetch);
    const issue = await manager.issue(dc, "1");
    expect(urls[0]).toContain("expand=renderedFields");
    expect(issue.descriptionHtml).toBe("<p><b>d</b></p>");
    expect(issue.description).toBe("d");
    const comments = await manager.comments(dc, "1");
    expect(urls[1]).toContain("expand=renderedBody");
    expect(comments[0]?.bodyHtml).toBe("<p><b>raw</b></p>");
    expect(comments[1]?.bodyHtml).toBeUndefined();
    expect(comments[1]?.body).toBe("raw2");
  });

  it("pages through every comment and keeps the newest ones of a thread longer than the cap", async () => {
    const urls: string[] = [];
    const makeFetch = (total: number) =>
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        urls.push(`${url.pathname}${url.search}`);
        const startAt = Number(url.searchParams.get("startAt") || 0);
        const maxResults = Number(url.searchParams.get("maxResults") || 0);
        const comments = Array.from({ length: Math.max(0, Math.min(maxResults, total - startAt)) }, (_, index) => ({
          id: String(startAt + index + 1),
          author: { displayName: "A" },
          body: `c${startAt + index + 1}`,
        }));
        return new Response(JSON.stringify({ comments, total, startAt, maxResults }));
      });

    const small = new JiraManager(credentials, makeFetch(250) as typeof fetch);
    const all = await small.commentsWithTotal(dc, "1");
    expect(all.comments).toHaveLength(250);
    expect(all.comments[0]?.id).toBe("1");
    expect(all.comments[249]?.id).toBe("250");
    expect(all).toMatchObject({ total: 250, truncated: false });

    urls.length = 0;
    const large = new JiraManager(credentials, makeFetch(1234) as typeof fetch);
    const cut = await large.commentsWithTotal(dc, "1");
    expect(cut.comments).toHaveLength(1000);
    expect(cut.comments[0]?.id).toBe("235");
    expect(cut.comments[999]?.id).toBe("1234");
    expect(cut).toMatchObject({ total: 1234, truncated: true });
    expect(urls.length).toBeLessThanOrEqual(12);
    expect((await large.comments(dc, "1"))[0]?.id).toBe("235");
  });

  it("refuses non-image attachments when only images are wanted", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            fields: {
              attachment: [{ id: "5", filename: "a.txt", size: 3, mimeType: "text/plain", content: "" }],
            },
          }),
        ),
    );
    const manager = new JiraManager(credentials, fetchImpl as typeof fetch);
    await expect(manager.attachmentBytes(dc, "100", "5", { imageOnly: true })).rejects.toThrow("not an image");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await expect(manager.attachmentBytes(dc, "100", "6", { imageOnly: true })).rejects.toThrow("not found");
  });

  it("keeps wiki emphasis characters inside links and words of the plain-text description", async () => {
    const url = "https://app.example.test/search?ftq=primary_user_set&ft=SYSTEM_CALL_REQUEST&q=a+b+c&r=x~y~z";
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: "1",
            key: "OPS-1",
            fields: { description: `Link: ${url} and snake_case_name, but *bold* and _italic_ lose their marks.` },
          }),
        ),
    );
    const manager = new JiraManager(credentials, fetchImpl as typeof fetch);
    const issue = await manager.issue(dc, "1");
    expect(issue.description).toContain(url);
    expect(issue.description).toContain("snake_case_name");
    expect(issue.description).toContain("but bold and italic lose");
  });

  it("preserves ADF semantic blocks as bounded safe Markdown", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: "1",
            key: "OPS-1",
            fields: {
              summary: "Safe",
              description: {
                type: "doc",
                content: [
                  { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Plan" }] },
                  {
                    type: "bulletList",
                    content: [
                      {
                        type: "listItem",
                        content: [
                          {
                            type: "paragraph",
                            content: [{ type: "text", text: "first", marks: [{ type: "strong" }] }],
                          },
                        ],
                      },
                    ],
                  },
                  { type: "blockquote", content: [{ type: "paragraph", content: [{ type: "text", text: "quoted" }] }] },
                  { type: "codeBlock", content: [{ type: "text", text: "const x = 1" }] },
                  {
                    type: "table",
                    content: [
                      {
                        type: "tableRow",
                        content: [
                          { type: "tableHeader", content: [{ type: "text", text: "Name" }] },
                          { type: "tableCell", content: [{ type: "text", text: "Value" }] },
                        ],
                      },
                    ],
                  },
                ],
              },
            },
          }),
        ),
    );
    const manager = new JiraManager(credentials, fetchImpl as typeof fetch);
    const issue = await manager.issue(dc, "1");
    expect(issue.descriptionMarkdown).toContain("## Plan");
    expect(issue.descriptionMarkdown).toContain("- **first**");
    expect(issue.descriptionMarkdown).toContain("> quoted");
    expect(issue.descriptionMarkdown).toContain("```\nconst x = 1\n```");
    expect(issue.descriptionMarkdown).toContain("| Name | Value |");
    expect(issue.descriptionMarkdown).toContain("| --- | --- |");
  });

  it("does not interpret HTML, image syntax, or unsafe ADF links as active Markdown", async () => {
    const html = "<p>literal <strong>content</strong></p> ![remote](https://tracker.invalid/pixel.png)";
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ id: "1", key: "OPS-1", fields: { description: html } })),
    );
    const manager = new JiraManager(credentials, fetchImpl as typeof fetch);
    const issue = await manager.issue(dc, "1");
    expect(issue.descriptionMarkdown).toBeUndefined();
    expect(issue.description).toContain("literal content");
  });

  it("retains ADF attributes-only descriptions without requiring plain text content", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: "1",
            key: "OPS-1",
            fields: {
              description: {
                type: "doc",
                content: [
                  {
                    type: "paragraph",
                    content: [
                      { type: "mention", attrs: { text: "@Alice" } },
                      { type: "inlineCard", attrs: { url: "https://example.com/runbook" } },
                    ],
                  },
                  { type: "mediaSingle", content: [{ type: "media" }] },
                ],
              },
            },
          }),
        ),
    );
    const issue = await new JiraManager(credentials, fetchImpl as typeof fetch).issue(dc, "1");
    expect(issue.descriptionMarkdown).toContain("@Alice");
    expect(issue.descriptionMarkdown).toContain("https://example.com/runbook");
    expect(issue.descriptionMarkdown).toContain("\\[Attachment\\]");
  });

  it("renders wiki panels, mentions, code macros, and links as readable text", async () => {
    const description =
      "{panel:title=Status note|borderColor=#9eb6d4}Posted by the Acme technical account on behalf of [~JDOE1]{panel}\n" +
      '{code:java}\n  const token_value = { foo: "<T>", star: "*" };  \n{code}\n' +
      "{noformat}\n  literal {x}_y <tag> *bold*\n{noformat}\n" +
      "See [the runbook|https://docs.example.invalid/runbook].";
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: "91868",
            key: "ABC-91868",
            fields: { summary: "Readable macros", status: { name: "Open" }, description },
          }),
        ),
    );
    const manager = new JiraManager(credentials, fetchImpl as typeof fetch);

    const issue = await manager.issue(dc, "ABC-91868");

    expect(issue.description).toContain("Status note");
    expect(issue.description).toContain("Posted by the Acme technical account on behalf of @JDOE1");
    expect(issue.description).toContain('  const token_value = { foo: "<T>", star: "*" };  ');
    expect(issue.description).toContain("  literal {x}_y <tag> *bold*");
    expect(issue.description).not.toContain("```");
    expect(issue.description).toContain("the runbook");
    expect(issue.description).not.toMatch(/panel(?::|\})|\{code(?::|\})/i);
  });

  it("preserves ADF codeBlock text through plain-text normalization", async () => {
    const code = "  if (has_value) {\n  const x: Box<T> = left * right * scale;\n}  ";
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: "91869",
            key: "ABC-91869",
            fields: {
              summary: "ADF code block",
              description: { type: "doc", content: [{ type: "codeBlock", content: [{ type: "text", text: code }] }] },
            },
          }),
        ),
    );
    const manager = new JiraManager(credentials, fetchImpl as typeof fetch);

    const issue = await manager.issue(dc, "ABC-91869");

    expect(issue.description).toContain(code);
  });

  it("preserves edge spaces in a root-level wiki code macro", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: "91871",
            key: "ABC-91871",
            fields: { summary: "Wiki code edges", description: "{code}  x  {code}" },
          }),
        ),
    );
    const manager = new JiraManager(credentials, fetchImpl as typeof fetch);

    const issue = await manager.issue(dc, "ABC-91871");

    expect(issue.description).toBe("  x  ");
  });

  it("keeps surrounding prose when malformed or unmatched wiki code macros occur", async () => {
    const description = "keep before {codec} keep after {code}  x  {code} tail {code}unterminated";
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: "91872",
            key: "ABC-91872",
            fields: { summary: "Malformed wiki code", description },
          }),
        ),
    );
    const manager = new JiraManager(credentials, fetchImpl as typeof fetch);

    const issue = await manager.issue(dc, "ABC-91872");

    expect(issue.description).toContain("keep before codec keep after");
    expect(issue.description).toContain("  x  ");
    expect(issue.description).toContain("tail codeunterminated");
  });

  it("keeps ADF codeBlock output within the description character budget", async () => {
    const code = "x".repeat(32_000);
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: "91870",
            key: "ABC-91870",
            fields: {
              summary: "Bounded ADF code block",
              description: { type: "doc", content: [{ type: "codeBlock", content: [{ type: "text", text: code }] }] },
            },
          }),
        ),
    );
    const manager = new JiraManager(credentials, fetchImpl as typeof fetch);

    const issue = await manager.issue(dc, "ABC-91870");

    expect(issue.description).toHaveLength(32_000);
  });

  it("decodes Jira HTML entities and preserves compact paragraph, link, and list structure", async () => {
    const html =
      '<p>Powerpass&nbsp;request:&nbsp;<a href="https://jira.example.com/browse/OPS-4">OPS-4</a>&nbsp;</p>' +
      "<p>&nbsp;</p><p>Second&#32;paragraph &#x2014; readable &amp; safe.</p>" +
      "<ul><li>First item</li><li>Second item</li></ul>" +
      "<p>&lt;script&gt;not executable&lt;/script&gt;</p>";
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: "1",
            key: "OPS-1",
            fields: {
              summary: "Safe",
              status: { name: "Open" },
              issuetype: { name: "Task" },
              project: { key: "OPS" },
              description: html,
            },
          }),
        ),
    );
    const manager = new JiraManager(credentials, fetchImpl as typeof fetch);
    const issue = await manager.issue(dc, "1");

    expect(issue.description).toBe(
      "Powerpass request: OPS-4 (https://jira.example.com/browse/OPS-4)\n\n" +
        "Second paragraph — readable & safe.\n- First item\n- Second item\n\n" +
        "<script>not executable</script>",
    );
  });

  it("pins Cloud paths to the validated cloudId prefix", async () => {
    const cloud = {
      ...dc,
      deployment: "cloud" as const,
      webUrl: "https://team.atlassian.net",
      apiBaseUrl: "",
      cloudId: "tenant-42",
      auth: { kind: "cloud-api-token" as const, secretRef: "jira:cloud:token", email: "me@example.com" },
    };
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.origin).toBe("https://api.atlassian.com");
      expect(url.pathname).toBe("/ex/jira/tenant-42/rest/api/3/myself");
      expect(new Headers(init?.headers).get("authorization")).toBe(basicAuth("me@example.com", "secret-pat"));
      return new Response(JSON.stringify({ accountId: "acct", displayName: "Alex" }));
    });
    const manager = new JiraManager(credentials, fetchImpl as typeof fetch);
    await expect(manager.verify(cloud)).resolves.toMatchObject({ identity: { kind: "cloud", accountId: "acct" } });
  });

  it("rejects redirects and insecure remote API roots", async () => {
    const manager = new JiraManager(credentials, vi.fn() as typeof fetch);
    await expect(manager.issue({ ...dc, apiBaseUrl: "http://jira.example.com" }, "OPS-2")).rejects.toThrow("HTTPS");
  });

  it("returns bounded Cloud nextPageToken and Data Center startAt cursors with truncation flags", async () => {
    const issue = {
      id: "1",
      key: "OPS-1",
      fields: {
        summary: "One",
        status: { name: "Open" },
        issuetype: { name: "Task" },
        project: { key: "OPS" },
        updated: "2026-10-23T00:00:00Z",
      },
    };
    const cloud: JiraConnection = {
      ...dc,
      deployment: "cloud",
      webUrl: "https://team.atlassian.net",
      apiBaseUrl: "",
      cloudId: "tenant-42",
      auth: { kind: "cloud-api-token", secretRef: "jira:cloud:token", email: "me@example.com" },
    };
    const cloudFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/ex/jira/tenant-42/rest/api/3/search/jql");
      if (url.searchParams.has("nextPageToken")) expect(url.searchParams.get("nextPageToken")).toBe("opaque-next");
      return new Response(JSON.stringify({ issues: [issue], nextPageToken: "opaque-next", isLast: false }));
    });
    const cloudManager = new JiraManager(credentials, cloudFetch as typeof fetch);
    const first = await cloudManager.searchPage(cloud, "project = OPS", 1);
    expect(first).toMatchObject({ hasMore: true, truncated: true, nextCursor: "opaque-next" });
    await cloudManager.searchPage(cloud, "project = OPS", 1, first.nextCursor);

    const dcFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/jira/rest/api/2/search");
      expect(url.searchParams.get("startAt")).toBe("1");
      return new Response(JSON.stringify({ startAt: 1, total: 4, issues: [issue] }));
    });
    const dcManager = new JiraManager(credentials, dcFetch as typeof fetch);
    await expect(dcManager.searchPage(dc, "project = OPS", 1, "1")).resolves.toMatchObject({
      hasMore: true,
      truncated: true,
      nextCursor: "2",
    });
  });

  it("paginates board issue pages and emits typed columns and capabilities", async () => {
    const issue = {
      id: "1",
      key: "OPS-1",
      fields: {
        summary: "One",
        status: { name: "Open" },
        issuetype: { name: "Task" },
        project: { key: "OPS" },
        updated: "2026-10-23T00:00:00Z",
      },
    };
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/board/9/configuration"))
        return new Response(
          JSON.stringify({ columnConfig: { columns: [{ name: "To Do", statuses: [{ id: "1", name: "Open" }] }] } }),
        );
      expect(["0", "1"]).toContain(url.searchParams.get("startAt"));
      const startAt = Number(url.searchParams.get("startAt"));
      return new Response(JSON.stringify({ issues: [issue], total: 18, startAt }));
    });
    const manager = new JiraManager(credentials, fetchImpl as typeof fetch);
    const first = await manager.boardView(dc, 9, "issues");
    expect(first).toMatchObject({
      hasMore: true,
      nextCursor: "1",
      truncated: true,
      capabilities: { issues: "available" },
      columns: [{ name: "To Do", statuses: [{ id: "1", name: "Open" }] }],
    });
    await manager.boardView(dc, 9, "issues", first.nextCursor);
    expect(fetchImpl.mock.calls.some(([input]) => new URL(String(input)).searchParams.get("startAt") === "1")).toBe(
      true,
    );
  });

  it("preserves status IDs when board configuration omits status names", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/board/9/configuration"))
        return new Response(
          JSON.stringify({
            columnConfig: {
              columns: [{ name: "To Do", statuses: [{ id: "10001", self: "https://jira.example.com/status/10001" }] }],
            },
          }),
        );
      return new Response(
        JSON.stringify({
          issues: [
            {
              id: "1",
              key: "OPS-1",
              fields: {
                summary: "One",
                status: { id: "10001", name: "Open" },
                issuetype: { name: "Task" },
                project: { key: "OPS" },
              },
            },
          ],
          total: 1,
          isLast: true,
        }),
      );
    });
    const manager = new JiraManager(credentials, fetchImpl as typeof fetch);

    await expect(manager.boardView(dc, 9, "issues")).resolves.toMatchObject({
      issues: [{ ref: { issueKey: "OPS-1" }, statusId: "10001", status: "Open" }],
      columns: [{ name: "To Do", statuses: [{ id: "10001", name: "" }] }],
    });
  });

  it("names nameless board column statuses from Jira's status list, once per connection", async () => {
    let statusResponse = () =>
      new Response(
        JSON.stringify([
          { id: "10001", name: "Open" },
          { id: "10002", name: "Closed" },
        ]),
      );
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/configuration"))
        return new Response(
          JSON.stringify({
            columnConfig: {
              columns: [
                { name: "To Do", statuses: [{ id: "10001" }] },
                { name: "Done", statuses: [{ id: "10002" }] },
              ],
            },
          }),
        );
      if (url.pathname.endsWith("/rest/api/2/status")) return statusResponse();
      return new Response(JSON.stringify({ issues: [], total: 0, isLast: true }));
    });
    const statusRequests = () =>
      fetchImpl.mock.calls.filter(([input]) => new URL(String(input)).pathname.endsWith("/rest/api/2/status")).length;

    const manager = new JiraManager(credentials, fetchImpl as typeof fetch);
    await expect(
      manager.boardView(dc, 9, "issues", undefined, undefined, { forceRefresh: true }),
    ).resolves.toMatchObject({
      columns: [
        { name: "To Do", statuses: [{ id: "10001", name: "Open" }] },
        { name: "Done", statuses: [{ id: "10002", name: "Closed" }] },
      ],
    });
    await manager.boardView(dc, 9, "issues", undefined, undefined, { forceRefresh: true });
    expect(statusRequests()).toBe(1);

    statusResponse = () => new Response("{}", { status: 500 });
    const failing = new JiraManager(credentials, fetchImpl as typeof fetch);
    await expect(
      failing.boardView(dc, 9, "issues", undefined, undefined, { forceRefresh: true }),
    ).resolves.toMatchObject({
      columns: [
        { name: "To Do", statuses: [{ id: "10001", name: "" }] },
        { name: "Done", statuses: [{ id: "10002", name: "" }] },
      ],
    });
  });

  it("imports quick filters and applies selected quick-filter JQL plus stable assignee ids on the board request", async () => {
    const requests: URL[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      requests.push(url);
      if (url.pathname.endsWith("/board/9/configuration"))
        return new Response(
          JSON.stringify({
            columnConfig: { columns: [] },
            filter: { id: 3, name: "Engineering filter", jql: "project = OPS" },
            owner: { displayName: "Board Owner", accountId: "owner-account" },
          }),
        );
      if (url.pathname.endsWith("/board/9/quickfilter"))
        return new Response(
          JSON.stringify({
            values: [{ id: 7, name: "Mine", jql: 'assignee = "my-account"', position: 0 }],
            total: 1,
            isLast: true,
          }),
        );
      if (url.pathname.endsWith("/board/9/issue"))
        return new Response(
          JSON.stringify({
            issues: [
              {
                id: "4",
                key: "OPS-4",
                fields: {
                  summary: "Card",
                  status: { name: "Open" },
                  issuetype: { name: "Task" },
                  project: { key: "OPS" },
                  assignee: { name: "alice", key: "alice-key", displayName: "Alice", accountId: "cloud-alice" },
                },
              },
            ],
            total: 1,
            isLast: true,
          }),
        );
      throw new Error(`Unexpected Jira URL: ${url}`);
    });
    const manager = new JiraManager(credentials, fetchImpl as typeof fetch);
    const filters = await manager.boardQuickFilters(dc, 9);
    expect(filters).toMatchObject({
      filters: [{ id: 7, name: "Mine", jql: 'assignee = "my-account"' }],
      capability: "available",
    });
    const result = await manager.boardView(dc, 9, "issues", undefined, undefined, {
      quickFilterIds: [7],
      assignee: { kind: "user", id: "alice-key" },
    });
    const boardRequest = requests.find((url) => url.pathname.endsWith("/board/9/issue"));
    expect(boardRequest?.searchParams.get("jql")).toBe('(assignee = "my-account") AND assignee = "alice-key"');
    expect(boardRequest?.searchParams.get("fields")).toContain("assignee");
    expect(result.issues[0]?.assigneeRef).toEqual({
      kind: "data-center",
      key: "alice-key",
      name: "alice",
      displayName: "Alice",
    });
    expect(result).toMatchObject({
      filter: { id: 3, name: "Engineering filter", jql: "project = OPS" },
      owner: { displayName: "Board Owner", accountId: "owner-account" },
    });
    await manager.boardView(dc, 9, "issues", undefined, undefined, {
      assignee: { kind: "user", id: 'ali" OR project = OPS' },
    });
    const escapedRequest = [...requests].reverse().find((url) => url.pathname.endsWith("/board/9/issue"));
    expect(escapedRequest?.searchParams.get("jql")).toContain('assignee = "ali\\" OR project = OPS"');
    await manager.boardView(dc, 9, "issues", undefined, undefined, { doneWithinDays: 14 });
    const recentRequest = [...requests].reverse().find((url) => url.pathname.endsWith("/board/9/issue"));
    expect(recentRequest?.searchParams.get("jql")).toBe("(statusCategory != Done OR updated >= -14d)");
    await expect(
      manager.boardView(dc, 9, "issues", undefined, undefined, { doneWithinDays: 3, forceRefresh: true }),
    ).rejects.toThrow("Invalid Jira completed-issue window.");
  });

  it("returns no quick filters with a permission capability when Jira hides filter configuration", async () => {
    const fetchImpl = vi.fn(async () => new Response('{"errorMessages":["denied"]}', { status: 403 }));
    const manager = new JiraManager(credentials, fetchImpl as typeof fetch);
    await expect(manager.boardQuickFilters(dc, 9)).resolves.toMatchObject({
      filters: [],
      capability: "permission-denied",
      hasMore: false,
    });
  });

  it("searches assignees by deployment-specific stable identifiers", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      return new Response(
        JSON.stringify(
          url.pathname.includes("/api/3/")
            ? [{ accountId: "cloud-id", displayName: "Alice" }]
            : [{ key: "dc-key", name: "alice", displayName: "Alice" }],
        ),
      );
    });
    const cloud = {
      ...dc,
      deployment: "cloud" as const,
      cloudId: "cloud-site",
      apiBaseUrl: "https://api.atlassian.com/ex/jira/cloud-site",
      auth: { kind: "cloud-api-token" as const, secretRef: "jira:cloud:token", email: "me@example.com" },
    };
    const manager = new JiraManager(credentials, fetchImpl as typeof fetch);
    await expect(manager.searchUsers(dc, "ali")).resolves.toEqual([
      { kind: "data-center", key: "dc-key", name: "alice", displayName: "Alice" },
    ]);
    await expect(manager.searchUsers(cloud, "ali")).resolves.toEqual([
      { kind: "cloud", accountId: "cloud-id", displayName: "Alice" },
    ]);
  });

  it("serves cached detail immediately, returns stale detail with safe refresh metadata, and drops pre-invalidation results", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "jira-manager-cache-"));
    const persistentCache = createJiraCache(path.join(directory, "cache.sqlite"));
    let fail = false;
    let holdResponse = false;
    let releaseResponse: (() => void) | undefined;
    const responseGate = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (fail) {
        if (holdResponse) await responseGate;
        return new Response("{}", { status: 503 });
      }
      return new Response(
        JSON.stringify({
          id: "1",
          key: "OPS-1",
          fields: {
            summary: "Cached title",
            status: { name: "Open" },
            issuetype: { name: "Task" },
            project: { key: "OPS" },
            assignee: { key: "dc-a", name: "alice", displayName: "Alice" },
          },
        }),
      );
    });
    const manager = new JiraManager(credentials, fetchImpl as typeof fetch, persistentCache);
    try {
      const fresh = await manager.issue(dc, "OPS-1");
      expect(fresh.cache).toMatchObject({ source: "network", stale: false });
      expect(await manager.issue(dc, "OPS-1", { cacheOnly: true })).toMatchObject({
        summary: "Cached title",
        cache: { source: "cache", stale: false },
      });
      fail = true;
      const stale = await manager.issue(dc, "OPS-1", { forceRefresh: true });
      expect(stale).toMatchObject({
        summary: "Cached title",
        cache: {
          source: "cache",
          stale: true,
          refreshError: { code: "network", message: "Jira could not be reached while refreshing this data." },
        },
      });

      fail = false;
      await manager.issue(dc, "OPS-1", { forceRefresh: true });
      fail = true;
      holdResponse = true;
      const pending = manager.issue(dc, "OPS-1", { forceRefresh: true });
      await new Promise((resolve) => setTimeout(resolve, 10));
      manager.invalidate(dc.id);
      releaseResponse?.();
      await expect(pending).rejects.toBeInstanceOf(JiraRequestError);
      expect(await manager.issue(dc, "OPS-1", { cacheOnly: true })).toBeNull();
    } finally {
      persistentCache.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("returns cached detail before a deduplicated background refresh and persists bounded profile history", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "jira-manager-background-cache-"));
    let cacheNow = Date.now();
    const persistentCache = createJiraCache(path.join(directory, "cache.sqlite"), { now: () => cacheNow });
    let releaseRefresh!: () => void;
    let refreshStarted!: () => void;
    const gate = new Promise<void>((resolve) => (releaseRefresh = resolve));
    const started = new Promise<void>((resolve) => (refreshStarted = resolve));
    let shouldHold = false;
    const fetchImpl = vi.fn(async () => {
      if (shouldHold) {
        refreshStarted();
        await gate;
      }
      return new Response(
        JSON.stringify({
          id: "1",
          key: "OPS-1",
          fields: {
            summary: "Cached title",
            status: { name: "Open" },
            issuetype: { name: "Task" },
            project: { key: "OPS" },
          },
        }),
      );
    });
    const manager = new JiraManager(credentials, fetchImpl as typeof fetch, persistentCache);
    try {
      const issue = await manager.issue(dc, "OPS-1");
      manager.rememberViewedIssue(dc, issue!.ref);
      for (let index = 0; index < 35; index++) manager.rememberSearch(dc, { jql: `project = P${index}` });
      expect(manager.getRecentSearches(dc)).toHaveLength(10);
      expect(manager.getRecentSearches({ ...dc, profileId: "other-profile" })).toEqual([]);
      expect(manager.getRecentIssues(dc)).toMatchObject([
        { summary: "Cached title", status: "Open", ref: { issueId: "1" } },
      ]);

      await manager.issue(dc, "OPS-1", { refreshInBackground: true });
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      cacheNow += 61_000;
      shouldHold = true;
      const result = await manager.issue(dc, "OPS-1", { refreshInBackground: true });
      expect(result).toMatchObject({ summary: "Cached title", cache: { source: "cache" } });
      const duplicate = await manager.issue(dc, "OPS-1", { refreshInBackground: true });
      expect(duplicate).toMatchObject({ summary: "Cached title", cache: { source: "cache", stale: true } });
      await started;
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      releaseRefresh();
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      persistentCache.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("returns a stale board before its background refresh completes", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "jira-manager-board-background-"));
    let cacheNow = Date.now();
    const persistentCache = createJiraCache(path.join(directory, "cache.sqlite"), { now: () => cacheNow });
    let releaseRefresh!: () => void;
    let refreshStarted!: () => void;
    const gate = new Promise<void>((resolve) => (releaseRefresh = resolve));
    const started = new Promise<void>((resolve) => (refreshStarted = resolve));
    let holdRefresh = false;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (holdRefresh) {
        refreshStarted();
        await gate;
      }
      if (url.pathname.endsWith("/configuration"))
        return new Response(
          JSON.stringify({ columnConfig: { columns: [{ name: "To Do", statuses: [{ id: "1", name: "Open" }] }] } }),
        );
      return new Response(
        JSON.stringify({
          issues: [
            {
              id: "1",
              key: "OPS-1",
              fields: {
                summary: "Board issue",
                status: { name: "Open", id: "1" },
                issuetype: { name: "Task" },
                project: { key: "OPS" },
              },
            },
          ],
          total: 1,
          isLast: true,
        }),
      );
    });
    const manager = new JiraManager(credentials, fetchImpl as typeof fetch, persistentCache);
    try {
      const first = await manager.boardView(dc, 3);
      expect(first?.issues).toHaveLength(1);
      const initialRequests = fetchImpl.mock.calls.length;
      cacheNow += 31_000;
      holdRefresh = true;
      const refreshing = manager.boardView(dc, 3, "issues", undefined, undefined, { refreshInBackground: true });
      const stale = await Promise.race([
        refreshing,
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error("Background board refresh blocked the caller.")), 100),
        ),
      ]);
      expect(stale?.cache).toMatchObject({ source: "cache", stale: true });
      await started;
      expect(fetchImpl.mock.calls.length).toBeGreaterThan(initialRequests);
    } finally {
      releaseRefresh();
      persistentCache.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("drops an in-flight first read on global cache invalidation", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "jira-manager-cache-race-"));
    const persistentCache = createJiraCache(path.join(directory, "cache.sqlite"));
    let markStarted!: () => void;
    let releaseResponse!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const responseGate = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    const fetchImpl = vi.fn(async () => {
      markStarted();
      await responseGate;
      return new Response(
        JSON.stringify({
          id: "1",
          key: "OPS-1",
          fields: {
            summary: "Old response",
            status: { name: "Open" },
            issuetype: { name: "Task" },
            project: { key: "OPS" },
          },
        }),
      );
    });
    const manager = new JiraManager(credentials, fetchImpl as typeof fetch, persistentCache);
    try {
      const pending = manager.issue(dc, "OPS-1", { forceRefresh: true });
      await started;
      manager.invalidate();
      releaseResponse();
      await expect(pending).rejects.toBeInstanceOf(JiraRequestError);
      expect(await manager.issue(dc, "OPS-1", { cacheOnly: true })).toBeNull();
    } finally {
      persistentCache.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("normalizes standard issue details and links from the lazy detail response", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.searchParams.get("fields")).toContain("issuelinks");
      return new Response(
        JSON.stringify({
          id: "1",
          key: "OPS-1",
          fields: {
            summary: "Details",
            status: { id: "10001", name: "Open" },
            issuetype: { name: "Task" },
            project: { key: "OPS" },
            created: "2026-10-01T00:00:00.000Z",
            updated: "2026-10-02T00:00:00.000Z",
            assignee: { displayName: "Assigned" },
            reporter: { displayName: "Reported" },
            priority: { name: "High" },
            resolution: { name: "Fixed" },
            labels: ["customer", "urgent"],
            components: [{ name: "Desktop" }],
            fixVersions: [{ name: "1.2.0" }],
            issuelinks: [
              {
                type: { name: "Blocks" },
                outwardIssue: { key: "OPS-2", fields: { summary: "Blocked issue", status: { name: "Open" } } },
              },
              { type: { name: "Relates" }, inwardIssue: { key: "OPS-3" } },
            ],
          },
        }),
      );
    });
    const manager = new JiraManager(credentials, fetchImpl as typeof fetch);

    await expect(manager.issue(dc, "OPS-1")).resolves.toMatchObject({
      statusId: "10001",
      priority: "High",
      reporter: "Reported",
      created: "2026-10-01T00:00:00.000Z",
      resolution: "Fixed",
      labels: ["customer", "urgent"],
      components: ["Desktop"],
      versions: ["1.2.0"],
      issueLinks: [
        { type: "Blocks", direction: "outward", issueKey: "OPS-2", summary: "Blocked issue", status: "Open" },
        { type: "Relates", direction: "inward", issueKey: "OPS-3" },
      ],
    });
  });

  it("accepts enriched issue fields through the IPC DTO schema", async () => {
    const { jiraIssueDtoSchema } = await import("../ipc-schemas.js");
    const issue = {
      ref: { provider: "jira", connectionId: "jira-a", issueId: "1", issueKey: "OPS-1" },
      summary: "Details",
      status: "Open",
      statusId: "10001",
      issueType: "Task",
      projectKey: "OPS",
      updated: "",
      url: "https://jira.example.com/browse/OPS-1",
      priority: "High",
      reporter: "Reported",
      created: "2026-10-01",
      resolution: "Fixed",
      labels: ["urgent"],
      components: ["Desktop"],
      versions: ["1.2"],
      issueLinks: [{ type: "Blocks", direction: "outward", issueKey: "OPS-2", summary: "Other", status: "Open" }],
    };
    expect(jiraIssueDtoSchema.parse(issue)).toMatchObject(issue);
  });

  it("searches boards server-side with one bounded page and an explicit continuation cursor", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/jira/rest/agile/1.0/board");
      expect(url.searchParams.get("name")).toBe("Engineering & Platform");
      expect(url.searchParams.get("maxResults")).toBe("2");
      if (url.searchParams.get("startAt") === "0")
        return new Response(
          JSON.stringify({
            startAt: 0,
            total: 3,
            values: [
              { id: 11, name: "Engineering board", type: "scrum" },
              { id: 12, name: "Platform board", type: "kanban" },
            ],
          }),
        );
      expect(url.searchParams.get("startAt")).toBe("2");
      return new Response(
        JSON.stringify({
          startAt: 2,
          total: 3,
          isLast: true,
          values: [{ id: 13, name: "Engineering platform", type: "scrum" }],
        }),
      );
    });
    const manager = new JiraManager(credentials, fetchImpl as typeof fetch);

    const firstPage = await manager.searchBoards(dc, { query: "Engineering & Platform", limit: 2 });
    expect(firstPage).toMatchObject({
      boards: [{ id: 11 }, { id: 12 }],
      hasMore: true,
      nextCursor: "2",
      truncated: true,
    });
    const secondPage = await manager.searchBoards(dc, {
      query: "Engineering & Platform",
      limit: 2,
      cursor: firstPage.nextCursor,
    });
    expect(secondPage).toMatchObject({ boards: [{ id: 13 }], hasMore: false, truncated: false });
    expect(secondPage).not.toHaveProperty("nextCursor");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("reports another board page when Jira omits total and returns a full page", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ startAt: 0, values: [{ id: 7, name: "Board", type: "scrum" }] })),
    );
    const manager = new JiraManager(credentials, fetchImpl as typeof fetch);
    await expect(manager.searchBoards(dc, { limit: 1 })).resolves.toMatchObject({
      hasMore: true,
      nextCursor: "1",
      truncated: true,
    });
  });

  it("persists paged board catalog reads by query, cursor, and limit across manager restarts", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "jira-manager-board-search-cache-"));
    const cachePath = path.join(directory, "cache.sqlite");
    let persistentCache = createJiraCache(cachePath);
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const query = url.searchParams.get("name") || "All boards";
      const startAt = Number(url.searchParams.get("startAt") || 0);
      const maximum = Number(url.searchParams.get("maxResults") || 50);
      return new Response(
        JSON.stringify({
          startAt,
          total: query === "All boards" ? 1 : 2,
          isLast: query === "All boards" || startAt > 0 || maximum > 1,
          values: [{ id: startAt > 0 ? 42 : 41, name: `${query} ${startAt}`.trim(), type: "kanban" }],
        }),
      );
    });
    try {
      const firstManager = new JiraManager(credentials, fetchImpl as typeof fetch, persistentCache);
      const first = await firstManager.searchBoards(dc, { query: "Alpha", limit: 1 });
      expect(first.boards).toMatchObject([{ id: 41, name: "Alpha 0" }]);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      await firstManager.searchBoards(dc, { query: "Alpha", limit: 1 });
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      persistentCache.close();
      persistentCache = createJiraCache(cachePath);
      const restartedManager = new JiraManager(credentials, fetchImpl as typeof fetch, persistentCache);
      await restartedManager.searchBoards(dc, { query: "Alpha", limit: 1 });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      await restartedManager.searchBoards(dc, { query: "Beta", limit: 1 });
      await restartedManager.searchBoards(dc, { query: "Beta", limit: 1, cursor: "1" });
      await restartedManager.searchBoards(dc, { query: "Beta", limit: 2 });
      expect(fetchImpl).toHaveBeenCalledTimes(4);

      await restartedManager.boards(dc);
      expect(fetchImpl).toHaveBeenCalledTimes(5);
      await restartedManager.searchBoards(dc, { limit: 50 });
      expect(fetchImpl).toHaveBeenCalledTimes(5);
    } finally {
      persistentCache.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reports board configuration and backlog permission/capability failures without discarding the page", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/configuration")) return new Response("{}", { status: 403 });
      return new Response("{}", { status: 404 });
    });
    const manager = new JiraManager(credentials, fetchImpl as typeof fetch);
    await expect(manager.boardView(dc, 9, "backlog")).resolves.toMatchObject({
      issues: [],
      hasMore: false,
      truncated: false,
      capabilities: { configuration: "permission-denied", backlog: "unsupported" },
    });
  });

  it("marks a successfully loaded Scrum backlog capability available", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/configuration")) return new Response("{}");
      return new Response(JSON.stringify({ issues: [], total: 0, isLast: true }));
    });
    const manager = new JiraManager(credentials, fetchImpl as typeof fetch);
    await expect(manager.boardView(dc, 9, "backlog")).resolves.toMatchObject({
      capabilities: { backlog: "available" },
    });
  });

  it("maps Jira's recognized Kanban backlog and unsupported sprint errors to capability states", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/configuration")) return new Response("{}");
      if (url.pathname.endsWith("/backlog"))
        return new Response(JSON.stringify({ errorMessages: ["The backlog is not available on Kanban boards"] }), {
          status: 400,
        });
      return new Response(JSON.stringify({ errorMessages: ["The board doesn't support sprints."] }), { status: 400 });
    });
    const manager = new JiraManager(credentials, fetchImpl as typeof fetch);
    await expect(manager.boardView(dc, 9, "backlog")).resolves.toMatchObject({
      capabilities: { backlog: "unsupported" },
    });
    await expect(manager.boardView(dc, 9, "sprints")).resolves.toMatchObject({
      capabilities: { sprints: "unsupported" },
    });
  });

  it("does not hide unrelated Jira 400 errors as unsupported capabilities", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/configuration")) return new Response("{}");
      return new Response(JSON.stringify({ errorMessages: ["The request is malformed"] }), { status: 400 });
    });
    const manager = new JiraManager(credentials, fetchImpl as typeof fetch);
    await expect(manager.boardView(dc, 9, "backlog")).rejects.toMatchObject({ code: "unknown", statusCode: 400 });
  });

  it("loads bounded issues for a selected sprint after checking the sprint belongs to the board", async () => {
    const issue = {
      id: "11",
      key: "OPS-11",
      fields: {
        summary: "Sprint item",
        status: { name: "In Progress" },
        issuetype: { name: "Task" },
        project: { key: "OPS" },
        updated: "2026-10-23T00:00:00Z",
      },
    };
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/board/9/configuration"))
        return new Response(JSON.stringify({ columnConfig: { columns: [] } }));
      if (url.pathname.endsWith("/board/9/sprint/42/issue")) {
        const startAt = Number(url.searchParams.get("startAt"));
        return new Response(JSON.stringify({ issues: [issue], total: 101, startAt }));
      }
      if (url.pathname.endsWith("/board/9/sprint"))
        return new Response(
          JSON.stringify({ values: [{ id: 42, name: "Sprint 42", state: "active" }], total: 1, isLast: true }),
        );
      throw new Error(`Unexpected Jira URL: ${url}`);
    });
    const manager = new JiraManager(credentials, fetchImpl as typeof fetch);
    const first = await manager.boardView(dc, 9, "sprints", undefined, 42);
    expect(first).toMatchObject({
      mode: "sprints",
      selectedSprintId: 42,
      issues: [{ ref: { issueId: "11" } }],
      hasMore: true,
      nextCursor: "1",
      truncated: true,
      sprints: [{ id: "42", state: "active" }],
      capabilities: { issues: "available", sprints: "available" },
    });
    await manager.boardView(dc, 9, "sprints", first.nextCursor, 42);
    expect(
      fetchImpl.mock.calls.some(([input]) => {
        const url = new URL(String(input));
        return url.pathname.endsWith("/sprint/42/issue") && url.searchParams.get("startAt") === "1";
      }),
    ).toBe(true);
  });

  it("names the selected sprint even when it is not on the first page of the board's sprints", async () => {
    const closedSprints = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      name: `Closed ${index + 1}`,
      state: "closed",
    }));
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/board/9/configuration"))
        return new Response(JSON.stringify({ columnConfig: { columns: [] } }));
      if (url.pathname.endsWith("/board/9/sprint/4242/issue"))
        return new Response(JSON.stringify({ issues: [], total: 0, startAt: 0 }));
      if (url.pathname.endsWith("/board/9/sprint"))
        return new Response(JSON.stringify({ values: closedSprints, total: 180, isLast: false }));
      if (url.pathname.endsWith("/sprint/4242"))
        return new Response(
          JSON.stringify({
            id: 4242,
            name: "Orders in progress 26/22",
            state: "active",
            startDate: "2026-10-26T08:00:00Z",
            endDate: "2026-11-09T16:00:00Z",
          }),
        );
      throw new Error(`Unexpected Jira URL: ${url}`);
    });
    const manager = new JiraManager(credentials, fetchImpl as typeof fetch);
    const view = await manager.boardView(dc, 9, "sprints", undefined, 4242);
    expect(view.sprints?.[0]).toEqual({
      id: "4242",
      name: "Orders in progress 26/22",
      state: "active",
      startDate: "2026-10-26T08:00:00Z",
      endDate: "2026-11-09T16:00:00Z",
    });
    expect(view.sprints).toHaveLength(101);
  });

  it("finds an active sprint beyond the first page before choosing a default sprint", async () => {
    const closedSprints = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      name: `Closed ${index + 1}`,
      state: "closed",
    }));
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/board/9/configuration")) return new Response("{}");
      if (url.pathname.endsWith("/board/9/sprint")) {
        if (url.searchParams.get("state") === "active,future")
          return new Response(JSON.stringify({ values: [{ id: 501, name: "Current sprint", state: "active" }] }));
        return new Response(JSON.stringify({ values: closedSprints, total: 101, isLast: false }));
      }
      throw new Error(`Unexpected Jira URL: ${url}`);
    });
    const manager = new JiraManager(credentials, fetchImpl as typeof fetch);
    const result = await manager.boardView(dc, 9, "sprints");
    expect(result.sprints?.[0]).toMatchObject({ id: "501", state: "active" });
    expect(result.sprintsHasMore).toBe(true);
    expect(
      fetchImpl.mock.calls.some(([input]) => new URL(String(input)).searchParams.get("state") === "active,future"),
    ).toBe(true);
  });

  it("rewinds the next sprint cursor when adding an active sprint displaced the last page entry", async () => {
    const firstPageSprints = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      name: `Closed ${index + 1}`,
      state: "closed",
    }));
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/board/9/configuration")) return new Response("{}");
      if (url.pathname.endsWith("/board/9/sprint")) {
        if (url.searchParams.get("state") === "active,future")
          return new Response(JSON.stringify({ values: [{ id: 501, name: "Current sprint", state: "active" }] }));
        const startAt = Number(url.searchParams.get("startAt"));
        const values =
          startAt === 0
            ? firstPageSprints
            : [
                { id: 100, name: "Closed 100", state: "closed" },
                { id: 101, name: "Closed 101", state: "closed" },
              ];
        return new Response(JSON.stringify({ values, total: 101, isLast: startAt > 0 }));
      }
      throw new Error(`Unexpected Jira URL: ${url}`);
    });
    const manager = new JiraManager(credentials, fetchImpl as typeof fetch);
    const firstPage = await manager.boardView(dc, 9, "sprints");
    expect(firstPage.sprints).toHaveLength(100);
    expect(firstPage.sprintsNextCursor).toBe("99");
    const secondPage = await manager.boardView(dc, 9, "sprints", firstPage.sprintsNextCursor);
    expect(secondPage.sprints?.map((sprint) => sprint.id)).toEqual(["100", "101"]);
  });

  it("lists every parallel open sprint first, also beside a selected sprint, and never repeats them later", async () => {
    const history = [
      { id: 1, name: "Old 1", state: "closed" },
      { id: 7, name: "Kanban Devops 26/22", state: "active" },
      { id: 2, name: "Old 2", state: "closed" },
    ];
    const open = [
      { id: 9, name: "Planned 26/24", state: "future" },
      { id: 7, name: "Kanban Devops 26/22", state: "active" },
      { id: 8, name: "Messagehub in progress 26/23", state: "active" },
    ];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/board/9/configuration")) return new Response("{}");
      if (url.pathname.endsWith("/board/9/sprint/7/issue"))
        return new Response(JSON.stringify({ issues: [], total: 0, startAt: 0 }));
      if (url.pathname.endsWith("/board/9/sprint")) {
        if (url.searchParams.get("state") === "active,future") return new Response(JSON.stringify({ values: open }));
        const startAt = Number(url.searchParams.get("startAt"));
        if (startAt === 0) return new Response(JSON.stringify({ values: history, total: 5, isLast: false }));
        return new Response(
          JSON.stringify({
            values: [
              { id: 8, name: "Messagehub in progress 26/23", state: "active" },
              { id: 3, name: "Old 3", state: "closed" },
            ],
            total: 5,
            isLast: true,
          }),
        );
      }
      throw new Error(`Unexpected Jira URL: ${url}`);
    });
    const manager = new JiraManager(credentials, fetchImpl as typeof fetch);
    const firstPage = await manager.boardView(dc, 9, "sprints");
    expect(firstPage.sprints?.map((sprint) => sprint.id)).toEqual(["7", "8", "9", "1", "2"]);
    expect(firstPage.sprintsNextCursor).toBe("3");
    const secondPage = await manager.boardView(dc, 9, "sprints", firstPage.sprintsNextCursor);
    expect(secondPage.sprints?.map((sprint) => sprint.id)).toEqual(["3"]);
    const selected = await manager.boardView(dc, 9, "sprints", undefined, 7);
    expect(selected.sprints?.map((sprint) => sprint.id)).toEqual(["7", "8", "9", "1", "2"]);
  });

  it("reports a board-scoped sprint issue endpoint as unsupported without falling back to unscoped issue data", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/board/9/configuration")) return new Response("{}");
      if (url.pathname.endsWith("/board/9/sprint/42/issue")) return new Response("{}", { status: 404 });
      if (url.pathname.endsWith("/board/9/sprint"))
        return new Response(JSON.stringify({ values: [], total: 0, isLast: true }));
      throw new Error(`Unexpected Jira URL: ${url}`);
    });
    const manager = new JiraManager(credentials, fetchImpl as typeof fetch);
    await expect(manager.boardView(dc, 9, "sprints", undefined, 42)).resolves.toMatchObject({
      issues: [],
      selectedSprintId: 42,
      capabilities: { issues: "unsupported" },
    });
    expect(
      fetchImpl.mock.calls.some(([input]) =>
        new URL(String(input)).pathname.endsWith("/rest/agile/1.0/sprint/42/issue"),
      ),
    ).toBe(false);
  });

  it("retries bounded Jira reads using Retry-After and reports machine-readable terminal errors", async () => {
    const issue = {
      id: "1",
      key: "OPS-1",
      fields: {
        summary: "One",
        status: { name: "Open" },
        issuetype: { name: "Task" },
        project: { key: "OPS" },
        updated: "2026-10-23T00:00:00Z",
      },
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 429, headers: { "Retry-After": "0" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ issues: [issue], total: 1, startAt: 0 })));
    const manager = new JiraManager(credentials, fetchImpl as typeof fetch);
    await expect(manager.searchPage(dc, "project = OPS", 10)).resolves.toMatchObject({
      issues: [{ ref: { issueKey: "OPS-1" } }],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const limited = new JiraManager(
      credentials,
      vi.fn(async () => new Response("{}", { status: 429, headers: { "Retry-After": "0" } })) as typeof fetch,
    );
    await expect(limited.issue(dc, "OPS-1")).rejects.toMatchObject({
      code: "rate-limited",
      statusCode: 429,
      retryAfterMs: 0,
    });
    expect(() => {
      throw new JiraRequestError("permission-denied", "no", undefined, 403);
    }).toThrow();
  });

  it("keeps recent history after a write and drops only the failing key on a 404", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "jira-manager-invalidate-"));
    const cache = createJiraCache(path.join(directory, "cache.sqlite"));
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (init?.method === "POST") return new Response("{}", { status: 201 });
      if (url.searchParams.get("jql") === "missing") return new Response("{}", { status: 404 });
      return new Response(JSON.stringify({ issues: [], total: 0, startAt: 0 }));
    });
    try {
      const manager = new JiraManager(credentials, fetchImpl as typeof fetch, cache);
      manager.rememberSearch(dc, { jql: "project = OPS" });
      await manager.searchPage(dc, "project = OPS", 10);
      await manager.searchPage(dc, "project = APP", 10);
      const reads = fetchImpl.mock.calls.length;
      await manager.addComment(dc, "OPS-1", "hello");
      expect(manager.getRecentSearches(dc)).toHaveLength(1);
      await manager.searchPage(dc, "project = OPS", 10);
      expect(fetchImpl.mock.calls.length).toBe(reads + 2);

      await manager.searchPage(dc, "project = OPS", 10);
      const afterRefill = fetchImpl.mock.calls.length;
      await expect(manager.searchPage(dc, "missing", 10)).rejects.toMatchObject({ code: "not-found" });
      expect(manager.getRecentSearches(dc)).toHaveLength(1);
      await manager.searchPage(dc, "project = OPS", 10);
      expect(fetchImpl.mock.calls.length).toBe(afterRefill + 1);
    } finally {
      cache.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reports a 429 whose Retry-After no longer fits the deadline as rate-limited with its wait", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 429, headers: { "Retry-After": "5" } }));
    const manager = new JiraManager(credentials, fetchImpl as unknown as typeof fetch);
    await expect(manager.boards(dc, undefined, { maxDurationMs: 200 })).rejects.toMatchObject({
      code: "rate-limited",
      statusCode: 429,
      retryAfterMs: 5000,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([429, 500])("does not retry mutating Jira POST after HTTP %i", async (status) => {
    const fetchImpl = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () => new Response("{}", { status, headers: { "Retry-After": "0" } }),
    );
    const manager = new JiraManager(credentials, fetchImpl as typeof fetch);
    await expect(manager.addComment(dc, "OPS-1", "comment body")).rejects.toBeInstanceOf(JiraRequestError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[1]?.method).toBe("POST");
  });

  it("bounds a caller's requests by one budget and never sends a write the caller can no longer hear back", async () => {
    const fetchImpl = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () => new Response("{}", { status: 201 }),
    );
    const manager = new JiraManager(credentials, fetchImpl as typeof fetch);

    // Less than the write's minimum window left: the write does not leave, and says so.
    await expect(
      withinJiraCallBudget(4_000, () => manager.addComment(dc, "OPS-1", "comment body")),
    ).rejects.toMatchObject({ code: "network", notSent: true });
    // A request that would start after the budget ran out is not sent either.
    await expect(
      withinJiraCallBudget(20, async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return manager.boards(dc);
      }),
    ).rejects.toMatchObject({ notSent: true });
    expect(fetchImpl).not.toHaveBeenCalled();

    // Once the budgeted call is over, nothing it started is cut by it.
    let late: Promise<unknown> | undefined;
    await withinJiraCallBudget(10, async () => {
      late = new Promise((resolve) => setTimeout(resolve, 30)).then(() =>
        manager.addComment(dc, "OPS-1", "comment body"),
      );
    });
    await late;
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not retry a timed-out mutating Jira POST", async () => {
    const fetchImpl = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => {
      throw new DOMException("Timed out", "TimeoutError");
    });
    const manager = new JiraManager(credentials, fetchImpl as typeof fetch);
    await expect(manager.addComment(dc, "OPS-1", "comment body")).rejects.toMatchObject({ code: "network" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("keeps Retry-After and response body reads inside one 25 second deadline", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(async () => new Response("{}", { status: 429, headers: { "Retry-After": "30" } }));
      const manager = new JiraManager(credentials, fetchImpl as typeof fetch);
      const request = manager.searchPage(dc, "project = OPS");
      const rejected = expect(request).rejects.toMatchObject({ code: "rate-limited", retryAfterMs: 30_000 });
      await vi.advanceTimersByTimeAsync(25_000);
      await rejected;
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      const bodyFetch = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ pull() {} })));
      const bodyManager = new JiraManager(credentials, bodyFetch as typeof fetch);
      const bodyRequest = bodyManager.searchPage(dc, "project = OPS");
      const bodyRejected = expect(bodyRequest).rejects.toMatchObject({ code: "network" });
      await vi.advanceTimersByTimeAsync(25_000);
      await bodyRejected;
      expect(bodyFetch).toHaveBeenCalledTimes(1);
      bodyFetch.mockImplementation(
        async () =>
          new Response(
            JSON.stringify({
              issues: [
                {
                  id: "1",
                  key: "OPS-1",
                  fields: {
                    summary: "One",
                    status: { name: "Open" },
                    issuetype: { name: "Task" },
                    project: { key: "OPS" },
                    updated: "2026-10-23T00:00:00Z",
                  },
                },
              ],
              total: 1,
            }),
          ),
      );
      await expect(bodyManager.searchPage(dc, "project = OPS")).resolves.toMatchObject({
        issues: [{ ref: { issueKey: "OPS-1" } }],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not reset a board operation deadline between configuration and issue requests", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/board/9/configuration")) return new Response(JSON.stringify({}));
        return new Response(new ReadableStream<Uint8Array>({ pull() {} }));
      });
      const manager = new JiraManager(credentials, fetchImpl as typeof fetch);
      const request = manager.boardView(dc, 9, "issues");
      const rejected = expect(request).rejects.toMatchObject({ code: "network" });
      await vi.advanceTimersByTimeAsync(24_900);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(100);
      await rejected;
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shares global and per-connection read limits across JiraManager instances", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
              once: true,
            });
          }),
      );
      const firstManager = new JiraManager(credentials, fetchImpl as typeof fetch);
      const secondManager = new JiraManager(credentials, fetchImpl as typeof fetch);
      const jiraA = { ...dc, id: "shared-a" };
      const jiraB = { ...dc, id: "shared-b" };
      const requests = [
        ...Array.from({ length: 4 }, () => firstManager.searchPage(jiraA, "project = OPS").catch(() => undefined)),
        secondManager.searchPage(jiraA, "project = OPS").catch(() => undefined),
      ];
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchImpl).toHaveBeenCalledTimes(4);
      requests.push(
        ...Array.from({ length: 4 }, () => secondManager.searchPage(jiraB, "project = OPS").catch(() => undefined)),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchImpl).toHaveBeenCalledTimes(8);
      requests.push(secondManager.searchPage({ ...dc, id: "shared-c" }, "project = OPS").catch(() => undefined));
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchImpl).toHaveBeenCalledTimes(8);
      await vi.advanceTimersByTimeAsync(25_000);
      await Promise.all(requests);
    } finally {
      vi.useRealTimers();
    }
  });

  it("streams attachments and cancels at the configured byte cap even without Content-Length", async () => {
    let canceled = false;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/issue/100") && url.searchParams.get("fields") === "attachment") {
        return new Response(
          JSON.stringify({
            fields: {
              attachment: [
                {
                  id: "5",
                  filename: "a.txt",
                  mimeType: "text/plain",
                  content: "https://jira.example.com/jira/secure/attachment/5/a.txt",
                },
              ],
            },
          }),
        );
      }
      expect(url.pathname).toBe("/jira/secure/attachment/5/a.txt");
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret-pat");
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2]));
            controller.enqueue(new Uint8Array([3, 4]));
          },
          cancel() {
            canceled = true;
          },
        }),
      );
    });
    const manager = new JiraManager(credentials, fetchImpl as typeof fetch);
    await expect(manager.attachmentBytes(dc, "100", "5", { maxBytes: 3 })).rejects.toThrow("configured size limit");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(canceled).toBe(true);
  });

  it("downloads Cloud attachment content by ID through the pinned API path", async () => {
    const cloud: JiraConnection = {
      ...dc,
      deployment: "cloud",
      webUrl: "https://team.atlassian.net",
      apiBaseUrl: "",
      cloudId: "tenant-42",
      auth: { kind: "cloud-api-token", secretRef: "jira:cloud:token", email: "me@example.com" },
    };
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/issue/100"))
        return new Response(
          JSON.stringify({
            fields: { attachment: [{ id: "5", filename: "a.txt", content: "https://untrusted.invalid/a.txt" }] },
          }),
        );
      expect(url.origin).toBe("https://api.atlassian.com");
      expect(url.pathname).toBe("/ex/jira/tenant-42/rest/api/3/attachment/content/5");
      expect(url.searchParams.get("redirect")).toBe("false");
      return new Response(new Uint8Array([1, 2, 3]));
    });
    const manager = new JiraManager(credentials, fetchImpl as typeof fetch);
    await expect(manager.attachmentBytes(cloud, "100", "5")).resolves.toMatchObject({
      fileName: "a.txt",
      bytes: new Uint8Array([1, 2, 3]),
    });
  });

  it("rejects Data Center attachment metadata that points outside its host/context before fetching it", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            fields: {
              attachment: [
                { id: "5", filename: "a.txt", content: "https://attacker.invalid/jira/secure/attachment/5/a.txt" },
              ],
            },
          }),
        ),
    );
    const manager = new JiraManager(credentials, fetchImpl as typeof fetch);
    await expect(manager.attachmentBytes(dc, "100", "5")).rejects.toThrow(
      "outside the configured host and context path",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("gives quick-filter resolution and the board fetch one shared 25 s deadline", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/board/7/quickfilter")) {
          await new Promise((resolve) => setTimeout(resolve, 9000));
          return new Response(
            JSON.stringify({ values: [{ id: 1, name: "Mine", jql: "assignee = currentUser()" }], isLast: true }),
          );
        }
        return new Promise<Response>(() => undefined);
      });
      const manager = new JiraManager(credentials, fetchImpl as unknown as typeof fetch);
      let settled: unknown = "pending";
      const view = manager.boardView(dc, 7, "issues", undefined, undefined, { quickFilterIds: [1] }).then(
        (value) => (settled = value),
        (error: unknown) => (settled = error),
      );
      await vi.advanceTimersByTimeAsync(24_000);
      expect(settled).toBe("pending");
      await vi.advanceTimersByTimeAsync(1_500);
      await view;
      expect(settled).toBeInstanceOf(JiraRequestError);
      expect((settled as JiraRequestError).code).toBe("network");
    } finally {
      vi.useRealTimers();
    }
  });
});
