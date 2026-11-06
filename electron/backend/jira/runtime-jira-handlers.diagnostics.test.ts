import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AppState } from "../../shared/types/state.js";
import { jiraConnectionDtoSchema, jiraWriteInvokeResultDtoSchema } from "../ipc-schemas.js";
import { createJiraCache } from "./jira-cache.js";
import { JiraRequestError } from "./jira-request-error.js";
import { createJiraHandlers } from "./runtime-jira-handlers.js";

const ISSUE = {
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
const REF = { connectionId: "conn-a", issueId: "1", issueKey: "OPS-1" };

function dcConnection(extra: Record<string, unknown> = {}) {
  return {
    id: "conn-a",
    profileId: "profile-a",
    label: "A",
    enabled: true,
    deployment: "data-center",
    webUrl: "https://jira.example.com",
    apiBaseUrl: "https://jira.example.com/jira",
    auth: { kind: "dc-pat", secretRef: "jira:conn-a:pat" },
    accountPurpose: "personal",
    status: "connected",
    health: { state: "verified", checkedAt: "2026-10-23T00:00:00.000Z" },
    verifiedIdentity: { kind: "data-center", name: "alice", displayName: "Alice" },
    ownIdentity: { kind: "data-center", name: "alice", displayName: "Alice" },
    ...extra,
  };
}

type Route = (url: string, init: RequestInit | undefined) => Response | Promise<Response> | undefined;
type Logged = [string, Record<string, unknown> | undefined];

function setup(route?: Route) {
  const state = {
    settings: { integrations: { jira: { connections: [dcConnection()], queries: [], repoBindings: [] } } },
    profiles: [{ id: "profile-a", name: "Alpha" }],
    workspaces: [],
  } as unknown as AppState;
  const secrets = new Map([["jira:conn-a:pat", "token-a"]]);
  let encrypted = true;
  const mutate = vi.fn(async (mutator: (draft: AppState) => void) => mutator(state));
  const log = {
    info: vi.fn<(m: string, f?: Record<string, unknown>) => void>(),
    warn: vi.fn<(m: string, f?: Record<string, unknown>) => void>(),
  };
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const routed = await route?.(String(input), init);
    if (routed) return routed;
    if (init?.method === "POST" || init?.method === "PUT") return new Response(null, { status: 204 });
    return new Response(JSON.stringify(ISSUE));
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a loose handler context, as in the sibling tests
  const context: Record<string, any> = {
    credentialStore: {
      isEncryptionAvailable: () => encrypted,
      getSecret: (ref: string) => secrets.get(ref) || "",
      hasSecret: (ref: string) => secrets.has(ref),
      listRefs: () => [...secrets.keys()],
      setSecret: vi.fn(async (ref: string, value: string) => {
        if (!encrypted) throw new Error("Encrypted storage is required.");
        secrets.set(ref, value);
      }),
      deleteSecret: vi.fn(async (ref: string) => {
        secrets.delete(ref);
      }),
    },
    store: { mutate },
    fetchImpl,
    getState: () => state,
    getViewerProfileId: (windowId: string) => (windowId === "window-a" ? "profile-a" : null),
    log: { info: vi.fn(), warn: vi.fn() },
    jiraLog: log,
    broadcastState: vi.fn(),
  };
  const connection = () => state.settings.integrations.jira.connections[0];
  const logged = (level: "info" | "warn", message: string) =>
    (log[level].mock.calls as Logged[]).filter(([event]) => event === message).map(([, fields]) => fields);
  return {
    state,
    secrets,
    context,
    log,
    mutate,
    connection,
    logged,
    setEncrypted: (value: boolean) => {
      encrypted = value;
    },
    handlers: createJiraHandlers(context),
  };
}

const sinkErrors = () => Object.assign(new Error("fetch failed"), { cause: undefined as unknown });

afterEach(() => vi.useRealTimers());

describe("connection health follows what any read finds out", () => {
  it("persists needs-login once when a read gets a 401, and connected again when one succeeds", async () => {
    let status = 401;
    const { handlers, connection, logged, mutate, context } = setup(() =>
      status === 200 ? undefined : new Response("{}", { status }),
    );
    await expect(
      handlers.jiraGetIssue({ connectionId: "conn-a", issueId: "1", forceRefresh: true }, "window-a"),
    ).rejects.toMatchObject({
      code: "auth-expired",
    });
    await vi.waitFor(() => expect(connection().status).toBe("needs-login"));
    expect(connection().health).toMatchObject({ state: "auth-expired" });
    expect(logged("warn", "jira connection needs sign-in")).toEqual([
      { connectionId: "conn-a", profileId: "profile-a", code: "auth-expired" },
    ]);
    expect(context.broadcastState).toHaveBeenCalled();

    const writes = mutate.mock.calls.length;
    await expect(
      handlers.jiraGetIssue({ connectionId: "conn-a", issueId: "1", forceRefresh: true }, "window-a"),
    ).rejects.toBeInstanceOf(JiraRequestError);
    expect(mutate.mock.calls.length).toBe(writes);
    expect(logged("warn", "jira connection needs sign-in")).toHaveLength(1);

    status = 200;
    await handlers.jiraGetIssue({ connectionId: "conn-a", issueId: "1", forceRefresh: true }, "window-a");
    await vi.waitFor(() => expect(connection().status).toBe("connected"));
    expect(connection().health).toMatchObject({ state: "verified" });
    expect(logged("info", "jira connection sign-in works again")).toHaveLength(1);
    // The persisted record still passes the connection schema the renderer receives.
    expect(jiraConnectionDtoSchema.safeParse({ ...connection(), auth: { kind: "dc-pat" } }).success).toBe(true);
  });

  it("a 403 on one resource or a plain network error leaves the connection's sign-in state alone", async () => {
    let answer: () => Response | Promise<Response> = () => new Response("{}", { status: 403 });
    const { handlers, connection, logged, mutate } = setup(() => answer());
    const writes = mutate.mock.calls.length;
    const status = connection().status;
    await expect(
      handlers.jiraGetIssue({ connectionId: "conn-a", issueId: "1", forceRefresh: true }, "window-a"),
    ).rejects.toMatchObject({
      code: "permission-denied",
    });
    answer = () => {
      throw Object.assign(sinkErrors(), { cause: Object.assign(new Error("x"), { code: "ECONNRESET" }) });
    };
    await expect(
      handlers.jiraGetIssue({ connectionId: "conn-a", issueId: "1", forceRefresh: true }, "window-a"),
    ).rejects.toMatchObject({
      code: "network",
    });
    expect(connection().status).toBe(status);
    expect(mutate.mock.calls.length).toBe(writes);
    expect(logged("warn", "jira connection needs sign-in")).toEqual([]);
  });
});

describe("a write that fails answers with what happened", () => {
  async function executeComment(handlers: ReturnType<typeof setup>["handlers"]) {
    const confirmation = await handlers.jiraPreviewComment(
      { ref: REF, body: "A private note", intent: "User confirmed note" },
      "window-a",
    );
    return handlers.jiraExecuteComment({ ref: REF, body: "A private note", confirmation }, "window-a");
  }
  const post =
    (answer: () => Response | Promise<Response>): Route =>
    (_url, init) =>
      init?.method === "POST" ? answer() : undefined;
  const journal = (secrets: Map<string, string>) =>
    (
      JSON.parse(secrets.get("jira:write-journal:profile-a") || '{"entries":[]}') as {
        entries: Array<{ state: string; reconciliation?: string; safeCode?: string }>;
      }
    ).entries;

  it.each([
    [401, "auth-expired", /sign-in has expired/i, "reconciled", "auth-expired:401"],
    [403, "permission-denied", /not allowed to make that change/i, "reconciled", "permission-denied:403"],
    [404, "not-found", /could not find/i, "reconciled", "not-found:404"],
  ] as const)("%i: not applied, specific code, retry allowed", async (status, code, message, state, safeCode) => {
    const { handlers, secrets } = setup(post(() => new Response("{}", { status })));
    const result = await executeComment(handlers);
    expect(jiraWriteInvokeResultDtoSchema.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({
      ok: false,
      error: { code, status: "failed", message: expect.stringMatching(message) },
    });
    expect(journal(secrets)[0]).toMatchObject({ state, reconciliation: "not-applied", safeCode });
  });

  it("429 carries Jira's wait", async () => {
    const { handlers, secrets } = setup(
      post(() => new Response("{}", { status: 429, headers: { "retry-after": "9" } })),
    );
    const result = await executeComment(handlers);
    expect(result).toMatchObject({ ok: false, error: { code: "rate-limited", status: "failed", retryAfterMs: 9000 } });
    expect(journal(secrets)[0]).toMatchObject({
      state: "reconciled",
      reconciliation: "not-applied",
      safeCode: "rate-limited:429",
    });
  });

  it("400 explains itself with Jira's own message", async () => {
    const { handlers } = setup(
      post(
        () => new Response(JSON.stringify({ errors: { comment: "Comment body cannot be empty." } }), { status: 400 }),
      ),
    );
    const result = await executeComment(handlers);
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "jira-write-rejected",
        status: "failed",
        message: expect.stringContaining("Comment body cannot be empty."),
      },
    });
  });

  it("a host that cannot be found was never contacted: failed, not unknown, and the same write can be repeated", async () => {
    let up = false;
    const { handlers, secrets } = setup(
      post(() => {
        if (up) return new Response(null, { status: 204 });
        throw Object.assign(new TypeError("fetch failed"), {
          cause: Object.assign(new Error("x"), { code: "ENOTFOUND" }),
        });
      }),
    );
    const result = await executeComment(handlers);
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "host-unreachable",
        status: "failed",
        message: expect.stringContaining("Nothing was sent to Jira"),
      },
    });
    expect(journal(secrets)[0]).toMatchObject({ state: "failed", safeCode: "not-sent:host-unreachable" });
    up = true;
    await expect(executeComment(handlers)).resolves.toMatchObject({ ok: true });
  });

  it("a connection reset after sending stays unknown and blocks the repeat", async () => {
    const { handlers, secrets } = setup(
      post(() => {
        throw Object.assign(new TypeError("fetch failed"), {
          cause: Object.assign(new Error("x"), { code: "ECONNRESET" }),
        });
      }),
    );
    const result = await executeComment(handlers);
    expect(result).toMatchObject({ ok: false, error: { code: "jira-write-unknown", status: "unknown" } });
    expect(journal(secrets)[0]).toMatchObject({ state: "unknown", safeCode: "network" });
    await expect(executeComment(handlers)).resolves.toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("already recorded or unresolved") },
    });
  });

  it("says what is wrong with secure storage instead of the generic text", async () => {
    const { handlers, setEncrypted } = setup();
    const confirmation = await handlers.jiraPreviewComment(
      { ref: REF, body: "A private note", intent: "User confirmed note" },
      "window-a",
    );
    setEncrypted(false);
    const result = await handlers.jiraExecuteComment({ ref: REF, body: "A private note", confirmation }, "window-a");
    expect(result).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("needs secure storage") },
    });
    expect((result as { error: { message: string } }).error.message).not.toMatch(/Review the issue/);
  });

  it("keeps a stale confirmation's real reason instead of the generic one", async () => {
    const { handlers } = setup();
    const result = await handlers.jiraExecuteComment(
      {
        ref: REF,
        body: "A private note",
        confirmation: { token: "nope", intent: "User confirmed note", preview: "x" },
      },
      "window-a",
    );
    expect(result).toMatchObject({ ok: false, error: { message: expect.stringContaining("confirmation is missing") } });
  });

  it("logs a refused write by code only, never its message", async () => {
    const { handlers, logged } = setup();
    await handlers.jiraExecuteComment(
      {
        ref: REF,
        body: "A private note",
        confirmation: { token: "nope", intent: "User confirmed note", preview: "x" },
      },
      "window-a",
    );
    const [fields] = logged("warn", "jira write was refused before it started");
    expect(fields).toMatchObject({ code: "validation-failed" });
    expect(fields).not.toHaveProperty("reason");
    expect(JSON.stringify(fields)).not.toContain("confirmation is missing");
  });

  it("logs one info line for a success and one warn line for a failure, never the text written", async () => {
    let fail = true;
    const { handlers, log } = setup(
      post(() => (fail ? new Response("{}", { status: 403 }) : new Response(null, { status: 204 }))),
    );
    await executeComment(handlers);
    fail = false;
    await executeComment(handlers);
    const text = JSON.stringify([...log.info.mock.calls, ...log.warn.mock.calls]);
    expect(text).not.toContain("A private note");
    expect(text).not.toContain("token-a");
  });
});

describe("saved view sync reports why it failed", () => {
  it("puts the failure time and code in the payload slice and the polling status beside it", async () => {
    const { context, state } = setup();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-jira-diagnostics-"));
    const cache = createJiraCache(path.join(root, "jira.sqlite"));
    context.jiraCache = cache;
    state.workspaces.push({ id: "jira-ws", kind: "jira", profileId: "profile-a" } as AppState["workspaces"][number]);
    let outcome: "limited" | "ok" = "limited";
    context.jiraManager = {
      boardView: vi.fn(async () => {
        if (outcome === "limited") throw new JiraRequestError("rate-limited", "Jira rate limit reached.", 4000, 429);
        return { boardId: 42, issues: [], hasMore: false, truncated: false };
      }),
      setHealthObserver: vi.fn(),
    };
    context.getJiraPollingStatus = (profileId: string) =>
      profileId === "profile-a"
        ? {
            "query-1": {
              connectionId: "conn-a",
              status: "error",
              lastSuccessAt: 1000,
              lastError: { code: "auth-expired", at: 2000 },
            },
          }
        : {};
    const handlers = createJiraHandlers(context);
    const before = Date.now();
    const saved = await handlers.saveJiraWorkspaceView(
      { workspaceId: "jira-ws", view: { kind: "board", connectionId: "conn-a", boardId: 42, boardName: "Platform" } },
      "window-a",
    );
    const viewId = saved.views.find((view) => view.kind === "board")!.viewId;
    await vi.waitFor(() =>
      expect(handlers.getJiraWorkspaceViewsSnapshot()["jira-ws"]?.syncByViewId[viewId]?.state).toBe("error"),
    );
    const snapshot = handlers.getJiraWorkspaceViewsSnapshot()["jira-ws"]!;
    expect(snapshot.syncByViewId[viewId]).toMatchObject({
      state: "error",
      code: "rate-limited",
      retryAfterMs: 4000,
      error: "Jira rate limit reached.",
    });
    expect(snapshot.syncByViewId[viewId].failedAt).toBeGreaterThanOrEqual(before);
    expect(snapshot.pollingByQueryId).toEqual({
      "query-1": {
        connectionId: "conn-a",
        status: "error",
        lastSuccessAt: 1000,
        lastError: { code: "auth-expired", at: 2000 },
      },
    });

    outcome = "ok";
    await handlers.refreshJiraWorkspaceViews({ workspaceId: "jira-ws", viewId }, "window-a");
    expect(handlers.getJiraWorkspaceViewsSnapshot()["jira-ws"]?.syncByViewId[viewId]).toMatchObject({ state: "idle" });
    expect(handlers.getJiraWorkspaceViewsSnapshot()["jira-ws"]?.syncByViewId[viewId]).not.toHaveProperty("code");
    cache.close();
    await fs.rm(root, { recursive: true, force: true });
  });
});

describe("Cloud API token verification is logged", () => {
  const input = {
    label: "Cloud",
    deployment: "cloud" as const,
    webUrl: "https://example.atlassian.net",
    apiBaseUrl: "https://example.atlassian.net",
    email: "me@example.com",
    apiToken: "api-token-value",
  };

  it("logs the failing stage and code with ids only, never the token or the email", async () => {
    const { handlers, logged, log } = setup(() => new Response("{}", { status: 401 }));
    await expect(handlers.jiraSaveConnection(input, "window-a")).rejects.toMatchObject({ code: "auth-expired" });
    expect(logged("warn", "jira connection verification failed")).toEqual([
      expect.objectContaining({
        profileId: "profile-a",
        authMode: "cloud-api-token",
        code: "auth-expired",
        statusCode: 401,
        endpoint: "/rest/api/3/myself",
      }),
    ]);
    const text = JSON.stringify(log.warn.mock.calls) + JSON.stringify(log.info.mock.calls);
    expect(text).not.toContain("api-token-value");
    expect(text).not.toContain("me@example.com");
  });

  it("logs a verified save without leaking the credentials", async () => {
    const { handlers, logged, log } = setup(
      () => new Response(JSON.stringify({ accountId: "acct", displayName: "Me" })),
    );
    await handlers.jiraSaveConnection(input, "window-a");
    expect(logged("info", "jira connection verification completed")).toEqual([
      expect.objectContaining({ authMode: "cloud-api-token", outcome: "verified", statusCode: 200 }),
    ]);
    const text = JSON.stringify(log.warn.mock.calls) + JSON.stringify(log.info.mock.calls);
    expect(text).not.toContain("api-token-value");
    expect(text).not.toContain("me@example.com");
  });
});
