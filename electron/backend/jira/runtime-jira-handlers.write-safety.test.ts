import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AppState } from "../../shared/types/state.js";
import {
  jiraAttachmentUploadResultDtoSchema,
  jiraConnectionDtoSchema,
  jiraWriteExecuteSchema,
  jiraWritePreviewSchema,
} from "../ipc-schemas.js";
import { createJiraCache } from "./jira-cache.js";
import type { JiraConnection } from "./jira-manager.js";
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

function dcConnection(id: string, profileId: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    profileId,
    label: id,
    enabled: true,
    deployment: "data-center",
    webUrl: "https://jira.example.com",
    apiBaseUrl: "https://jira.example.com/jira",
    auth: { kind: "dc-pat", secretRef: `jira:${id}:pat` },
    accountPurpose: "personal",
    verifiedIdentity: { kind: "data-center", name: "alice", displayName: "Alice" },
    ownIdentity: { kind: "data-center", name: "alice", displayName: "Alice" },
    ...extra,
  };
}

type Route = (url: string, init: RequestInit | undefined) => Response | undefined;

function setup(options: { profiles?: Record<string, string>; route?: Route } = {}) {
  const profileOfWindow: Record<string, string> = {
    "window-a": "profile-a",
    "window-b": "profile-b",
    ...options.profiles,
  };
  const state = {
    settings: {
      integrations: {
        jira: {
          connections: [dcConnection("conn-a", "profile-a"), dcConnection("conn-b", "profile-b")],
          queries: [],
          repoBindings: [],
        },
      },
    },
    profiles: [
      { id: "profile-a", name: "Alpha" },
      { id: "profile-b", name: "Beta" },
    ],
    workspaces: [],
  } as unknown as AppState;
  const secrets = new Map([
    ["jira:conn-a:pat", "token-a"],
    ["jira:conn-b:pat", "token-b"],
  ]);
  const requests: Array<{ method: string; url: string }> = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({ method: init?.method || "GET", url });
    const routed = options.route?.(url, init);
    if (routed) return routed;
    if (init?.method === "POST" || init?.method === "PUT") return new Response(null, { status: 204 });
    return new Response(JSON.stringify(ISSUE));
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a loose handler context, as in the sibling tests
  const context: Record<string, any> = {
    credentialStore: {
      isEncryptionAvailable: () => true,
      getSecret: (ref: string) => secrets.get(ref) || "",
      hasSecret: (ref: string) => secrets.has(ref),
      listRefs: () => [...secrets.keys()],
      setSecret: vi.fn(async (ref: string, value: string) => {
        secrets.set(ref, value);
      }),
      deleteSecret: vi.fn(async (ref: string) => {
        secrets.delete(ref);
      }),
    },
    store: { mutate: async (mutator: (draft: AppState) => void) => mutator(state) },
    fetchImpl,
    getState: () => state,
    getViewerProfileId: (windowId: string) => profileOfWindow[windowId] || null,
    log: { info: vi.fn(), warn: vi.fn() },
    broadcastState: vi.fn(),
  };
  return { state, secrets, requests, context, profileOfWindow, handlers: createJiraHandlers(context) };
}

const journalEntries = (secrets: Map<string, string>, profileId: string) =>
  (JSON.parse(secrets.get(`jira:write-journal:${profileId}`) || '{"entries":[]}') as { entries: Array<{ id: string }> })
    .entries;

afterEach(() => vi.useRealTimers());

describe("write safety follows the window's current profile", () => {
  it("journals a write from a window that switched profile under the new profile", async () => {
    const { handlers, secrets, profileOfWindow } = setup();
    profileOfWindow["window-x"] = "profile-a";
    const commentOn = async (connectionId: string) => {
      const ref = { ...REF, connectionId };
      const confirmation = await handlers.jiraPreviewComment(
        { ref, body: "A note", intent: "User confirmed note" },
        "window-x",
      );
      return handlers.jiraExecuteComment({ ref, body: "A note", confirmation }, "window-x");
    };
    await expect(commentOn("conn-a")).resolves.toMatchObject({ ok: true });
    expect(journalEntries(secrets, "profile-a")).toHaveLength(1);

    profileOfWindow["window-x"] = "profile-b";
    await expect(commentOn("conn-b")).resolves.toMatchObject({ ok: true });

    expect(journalEntries(secrets, "profile-a")).toHaveLength(1);
    expect(journalEntries(secrets, "profile-b")).toHaveLength(1);
    expect(journalEntries(secrets, "profile-b")[0]).toMatchObject({ profileId: "profile-b", connectionId: "conn-b" });
    await expect(handlers.jiraGetWriteHistory({}, "window-x")).resolves.toMatchObject([{ profileId: "profile-b" }]);
  });
});

describe("comment attribution", () => {
  const TECH_REF = { ...REF, connectionId: "conn-t" };
  const withTechnical = () => {
    const ctx = setup();
    (ctx.state.settings.integrations.jira.connections as unknown[]).push(
      dcConnection("conn-t", "profile-a", {
        accountPurpose: "technical",
        verifiedIdentity: { kind: "data-center", name: "bot", displayName: "Jira Bot" },
      }),
    );
    ctx.secrets.set("jira:conn-t:pat", "token-t");
    return ctx;
  };
  const preview = async (handlers: ReturnType<typeof setup>["handlers"], ref: typeof REF) =>
    (await handlers.jiraPreviewComment({ ref, body: "Body", intent: "User confirmed note" }, "window-a")).preview;

  it("applies the default text to a technical account only, using the own identity name", async () => {
    const { handlers } = withTechnical();
    await expect(preview(handlers, TECH_REF)).resolves.toBe("On behalf of Alice\n\nBody");
    await expect(preview(handlers, { ...REF, connectionId: "conn-a" })).resolves.toBe("Body");
  });

  it("uses the current setting at preview time and falls back to the profile name", async () => {
    const { handlers, state } = withTechnical();
    await expect(
      handlers.jiraSetCommentAttribution({ enabled: true, text: "{user} / {account}", position: "after" }, "window-a"),
    ).resolves.toEqual({ enabled: true, text: "{user} / {account}", position: "after" });
    await expect(preview(handlers, TECH_REF)).resolves.toBe("Body\n\nAlice / Jira Bot");
    const connection = (state.settings.integrations.jira.connections as unknown as Array<Record<string, unknown>>).find(
      (item) => item.id === "conn-t",
    )!;
    delete connection.ownIdentity;
    await expect(preview(handlers, TECH_REF)).resolves.toBe("Body\n\nAlpha / Jira Bot");
    await handlers.jiraSetCommentAttribution({ enabled: false, text: "x", position: "before" }, "window-a");
    await expect(preview(handlers, TECH_REF)).resolves.toBe("Body");
  });

  it("saves only the attribution field, normalised, and needs a desktop window", async () => {
    const { handlers, state } = withTechnical();
    const jira = state.settings.integrations.jira as unknown as Record<string, unknown>;
    const connectionsBefore = jira.connections;
    await handlers.jiraSetCommentAttribution({ enabled: true, text: "  ab  ", position: "before" }, "window-a");
    expect(jira.commentAttribution).toEqual({ enabled: true, text: "ab", position: "before" });
    expect(jira.connections).toBe(connectionsBefore);
    await expect(
      handlers.jiraSetCommentAttribution({ enabled: true, text: "x", position: "before" }, ""),
    ).rejects.toThrow("desktop window");
  });
});

describe("moving a deleted profile's write history", () => {
  it("carries the recorded writes to the fallback profile and drops the old journal", async () => {
    const { handlers, secrets, state } = setup();
    const ref = { ...REF, connectionId: "conn-a" };
    const body = "A note";
    const confirmation = await handlers.jiraPreviewComment({ ref, body, intent: "User confirmed note" }, "window-a");
    await expect(handlers.jiraExecuteComment({ ref, body, confirmation }, "window-a")).resolves.toMatchObject({
      ok: true,
    });
    expect(journalEntries(secrets, "profile-a")).toHaveLength(1);

    for (const connection of state.settings.integrations.jira.connections as Array<{ profileId: string }>)
      connection.profileId = "profile-b";
    await expect(handlers.moveJiraProfileWriteJournal("profile-a", "profile-b")).resolves.toBe(1);

    expect(secrets.has("jira:write-journal:profile-a")).toBe(false);
    expect(journalEntries(secrets, "profile-b")).toMatchObject([{ profileId: "profile-b", connectionId: "conn-a" }]);
    await expect(handlers.jiraGetWriteHistory({}, "window-b")).resolves.toMatchObject([
      { profileId: "profile-b", connectionId: "conn-a", state: "succeeded" },
    ]);
  });
});

describe("assign", () => {
  const assignee = (current: unknown) => (url: string) =>
    url.endsWith("fields=assignee") ? new Response(JSON.stringify({ fields: { assignee: current } })) : undefined;

  it("validates the payloads with the real schemas", () => {
    expect(
      jiraWritePreviewSchema.safeParse({
        action: "assign",
        ref: REF,
        assignee: { kind: "user", id: "bob", displayName: "Bob" },
        intent: "Assign it to Bob",
      }).success,
    ).toBe(true);
    expect(
      jiraWritePreviewSchema.safeParse({ action: "assign", ref: REF, assignee: { kind: "me" }, intent: "Assign to me" })
        .success,
    ).toBe(true);
    expect(
      jiraWritePreviewSchema.safeParse({
        action: "assign",
        ref: REF,
        assignee: { kind: "nobody" },
        intent: "Assign to me",
      }).success,
    ).toBe(false);
    expect(
      jiraWriteExecuteSchema.safeParse({
        action: "assign",
        ref: REF,
        assignee: { kind: "unassigned" },
        confirmation: { token: "t", intent: "Unassign it", preview: "p" },
      }).success,
    ).toBe(true);
  });

  it("previews, confirms and executes through the journal, sending a Data Center user name", async () => {
    const { handlers, requests, secrets } = setup({ route: assignee({ name: "carol", displayName: "Carol" }) });
    const confirmation = await handlers.jiraPreviewAssign(
      { ref: REF, assignee: { kind: "user", id: "bob", displayName: "Bob" }, intent: "Assign it to Bob" },
      "window-a",
    );
    expect(confirmation.preview).toContain("Assign OPS-1 to Bob");
    expect(confirmation.preview).toContain("Currently: Carol");
    await expect(
      handlers.jiraExecuteAssign({ ref: REF, assignee: { kind: "user", id: "bob" }, confirmation }, "window-a"),
    ).resolves.toMatchObject({ ok: true, data: { status: "succeeded" } });
    const put = requests.find((request) => request.method === "PUT")!;
    expect(put.url).toContain("/issue/1/assignee");
    expect(journalEntries(secrets, "profile-a")[0]).toMatchObject({
      kind: "assign",
      state: "succeeded",
      metadata: { kind: "assign", target: "bob", beforeAssignee: "carol" },
    });
  });

  it("a confirmation only fits the assignee it was previewed for", async () => {
    const { handlers, requests } = setup({ route: assignee(null) });
    const confirmation = await handlers.jiraPreviewAssign(
      { ref: REF, assignee: { kind: "user", id: "bob" }, intent: "Assign it to Bob" },
      "window-a",
    );
    await expect(
      handlers.jiraExecuteAssign({ ref: REF, assignee: { kind: "user", id: "mallory" }, confirmation }, "window-a"),
    ).resolves.toMatchObject({ ok: false });
    expect(requests.some((request) => request.method === "PUT")).toBe(false);
  });

  it("assigns to the user's own identity and unassigns", async () => {
    const { handlers, requests } = setup({ route: assignee({ name: "carol", displayName: "Carol" }) });
    const me = await handlers.jiraPreviewAssign(
      { ref: REF, assignee: { kind: "me" }, intent: "Assign to myself" },
      "window-a",
    );
    expect(me.preview).toContain("Assign OPS-1 to Alice (you)");
    await handlers.jiraExecuteAssign({ ref: REF, assignee: { kind: "me" }, confirmation: me }, "window-a");
    const unassign = await handlers.jiraPreviewAssign(
      { ref: REF, assignee: { kind: "unassigned" }, intent: "Remove the assignee" },
      "window-a",
    );
    await handlers.jiraExecuteAssign(
      { ref: REF, assignee: { kind: "unassigned" }, confirmation: unassign },
      "window-a",
    );
    const bodies = requests.filter((request) => request.method === "PUT");
    expect(bodies).toHaveLength(2);
  });

  it("sends the Cloud account id and null to unassign", async () => {
    const bodies: unknown[] = [];
    const { handlers, state, context, secrets } = setup({
      route: (url, init) => {
        if (init?.method === "PUT") bodies.push(JSON.parse(String(init.body)));
        return url.endsWith("fields=assignee")
          ? new Response(JSON.stringify({ fields: { assignee: { accountId: "acc-1" } } }))
          : undefined;
      },
    });
    Object.assign(state.settings.integrations.jira.connections[0], {
      deployment: "cloud",
      cloudId: "cloud-1",
      auth: { kind: "cloud-api-token", secretRef: "jira:conn-a:api-token", email: "me@example.com" },
      verifiedIdentity: { kind: "cloud", accountId: "acc-me", displayName: "Me" },
      ownIdentity: { kind: "cloud", accountId: "acc-me", displayName: "Me" },
    });
    secrets.set("jira:conn-a:api-token", "api-token-value");
    const cloud = createJiraHandlers(context);
    const user = await cloud.jiraPreviewAssign(
      { ref: REF, assignee: { kind: "user", id: "acc-2" }, intent: "Assign to account two" },
      "window-a",
    );
    await cloud.jiraExecuteAssign(
      { ref: REF, assignee: { kind: "user", id: "acc-2" }, confirmation: user },
      "window-a",
    );
    const none = await cloud.jiraPreviewAssign(
      { ref: REF, assignee: { kind: "unassigned" }, intent: "Remove the assignee" },
      "window-a",
    );
    await cloud.jiraExecuteAssign({ ref: REF, assignee: { kind: "unassigned" }, confirmation: none }, "window-a");
    expect(bodies).toEqual([{ accountId: "acc-2" }, { accountId: null }]);
    void handlers;
  });

  it("refuses a no-op, a missing own identity, and reconciles an unknown outcome as applied", async () => {
    let current: unknown = { name: "bob", displayName: "Bob" };
    let putStatus = 503;
    const { handlers, state, secrets } = setup({
      route: (url, init) => {
        if (init?.method === "PUT") return new Response(putStatus === 204 ? null : "x", { status: putStatus });
        return url.endsWith("fields=assignee")
          ? new Response(JSON.stringify({ fields: { assignee: current } }))
          : undefined;
      },
    });
    await expect(
      handlers.jiraPreviewAssign(
        { ref: REF, assignee: { kind: "user", id: "bob" }, intent: "Assign it to Bob" },
        "window-a",
      ),
    ).rejects.toThrow("already assigned");
    delete (state.settings.integrations.jira.connections[0] as { ownIdentity?: unknown }).ownIdentity;
    await expect(
      handlers.jiraPreviewAssign({ ref: REF, assignee: { kind: "me" }, intent: "Assign to myself" }, "window-a"),
    ).rejects.toThrow("verify your Jira identity");

    const confirmation = await handlers.jiraPreviewAssign(
      { ref: REF, assignee: { kind: "user", id: "dave" }, intent: "Assign it to Dave" },
      "window-a",
    );
    const result = await handlers.jiraExecuteAssign(
      { ref: REF, assignee: { kind: "user", id: "dave" }, confirmation },
      "window-a",
    );
    expect(result).toMatchObject({ ok: false, error: { code: "jira-write-unknown" } });
    current = { name: "dave", displayName: "Dave" };
    putStatus = 204;
    const journalId = journalEntries(secrets, "profile-a")[0].id as string;
    await expect(handlers.jiraReconcileWrite(journalId, "window-a")).resolves.toMatchObject({ outcome: "applied" });
    // A set-assignee write is repeatable once it is no longer unresolved.
    current = { name: "bob", displayName: "Bob" };
    const again = await handlers.jiraPreviewAssign(
      { ref: REF, assignee: { kind: "user", id: "dave" }, intent: "Assign it to Dave" },
      "window-a",
    );
    await expect(
      handlers.jiraExecuteAssign({ ref: REF, assignee: { kind: "user", id: "dave" }, confirmation: again }, "window-a"),
    ).resolves.toMatchObject({
      ok: true,
    });
  });
});

describe("attachment upload goes through the write journal", () => {
  const file = { fileName: "report.txt", mediaType: "text/plain", bytes: new Uint8Array([1, 2, 3]) };

  it("a timeout followed by a retry is blocked instead of creating a duplicate, and can be reconciled", async () => {
    let attachments: unknown[] = [];
    const { handlers, requests, secrets } = setup({
      route: (url, init) => {
        if (url.endsWith("/attachments") && init?.method === "POST") return new Response("temporary", { status: 503 });
        if (url.endsWith("fields=attachment"))
          return new Response(JSON.stringify({ fields: { attachment: attachments } }));
        return undefined;
      },
    });
    const failed = await handlers.jiraUploadAttachment({ connectionId: "conn-a", issueId: "1" }, "window-a", file);
    expect(jiraAttachmentUploadResultDtoSchema.safeParse(failed).success).toBe(true);
    expect(failed).toMatchObject({
      ok: false,
      error: { status: "unknown", journalId: expect.any(String), message: expect.stringContaining("Reconcile") },
    });
    const posts = () => requests.filter((request) => request.method === "POST").length;
    expect(posts()).toBe(1);
    await expect(
      handlers.jiraUploadAttachment({ connectionId: "conn-a", issueId: "1" }, "window-a", file),
    ).resolves.toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("already recorded or unresolved") },
    });
    expect(posts()).toBe(1);
    const entry = journalEntries(secrets, "profile-a")[0];
    expect(entry).toMatchObject({ kind: "attachment", state: "unknown" });
    expect(JSON.stringify(entry)).not.toContain("report.txt");

    attachments = [{ id: "10", filename: "report.txt", size: 3, mimeType: "text/plain" }];
    await expect(handlers.jiraReconcileWrite(entry.id, "window-a")).resolves.toMatchObject({ outcome: "applied" });
  });

  it("a finished upload does not block uploading the same file again later", async () => {
    const { handlers, requests } = setup({
      route: (url) =>
        url.endsWith("fields=attachment") ? new Response(JSON.stringify({ fields: { attachment: [] } })) : undefined,
    });
    await expect(
      handlers.jiraUploadAttachment({ connectionId: "conn-a", issueId: "1" }, "window-a", file),
    ).resolves.toMatchObject({ ok: true, data: { status: "succeeded", journalId: expect.any(String) } });
    await handlers.jiraUploadAttachment({ connectionId: "conn-a", issueId: "1" }, "window-a", file);
    expect(requests.filter((request) => request.method === "POST")).toHaveLength(2);
  });
});

describe("connection and profile hygiene", () => {
  it("two windows asking for the Jira inbox at once end with one inbox", async () => {
    const { handlers, state } = setup();
    const [first, second] = await Promise.all([
      handlers.jiraEnsureWorkspace("window-a"),
      handlers.jiraEnsureWorkspace("window-a"),
    ]);
    expect(state.workspaces.filter((workspace) => workspace.kind === "jira")).toHaveLength(1);
    expect(first.id).toBe(second.id);
  });

  it("deleting a connection also removes its watches, saved views, pinned boards and repo bindings", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-jira-delete-"));
    const cache = createJiraCache(path.join(root, "jira.sqlite"));
    const { handlers, state, context } = setup();
    context.jiraCache = cache;
    context.removeJiraPollingForConnection = vi.fn(async () => undefined);
    context.finalizeWorkspaceRemoval = vi.fn(async () => undefined);
    const jira = state.settings.integrations.jira as unknown as { repoBindings: Array<Record<string, unknown>> };
    jira.repoBindings = [
      { profileId: "profile-a", jiraConnectionId: "conn-a", projectKey: "OPS" },
      { profileId: "profile-b", jiraConnectionId: "conn-b", projectKey: "OPS" },
    ];
    state.workspaces.push(
      ...([
        { id: "inbox-a", kind: "jira", profileId: "profile-a" },
        {
          id: "board-a",
          kind: "jira-board",
          profileId: "profile-a",
          jiraBoard: { connectionId: "conn-a", boardId: 1 },
        },
        {
          id: "board-b",
          kind: "jira-board",
          profileId: "profile-b",
          jiraBoard: { connectionId: "conn-b", boardId: 1 },
        },
      ] as unknown as AppState["workspaces"]),
    );
    cache.saveView({
      profileId: "profile-a",
      workspaceId: "inbox-a",
      viewId: "v-a",
      value: { connectionId: "conn-a" },
      active: false,
    });
    cache.saveView({
      profileId: "profile-a",
      workspaceId: "inbox-a",
      viewId: "v-keep",
      value: { connectionId: "other" },
      active: false,
    });
    cache.setWorkspaceProjectScope({
      profileId: "profile-a",
      workspaceId: "inbox-a",
      connectionId: "conn-a",
      projectKeys: ["OPS"],
    });
    const handlersWithCache = createJiraHandlers(context);

    await handlersWithCache.jiraDeleteConnection("conn-a", "window-a");

    expect(context.removeJiraPollingForConnection).toHaveBeenCalledWith("profile-a", "conn-a");
    expect(cache.listSavedViews("profile-a", "inbox-a").map((view) => view.viewId)).toEqual(["v-keep"]);
    expect(cache.getWorkspaceProjectScope("profile-a", "inbox-a", "conn-a")).toBeUndefined();
    expect(state.workspaces.map((workspace) => workspace.id)).toEqual(["inbox-a", "board-b"]);
    expect(context.finalizeWorkspaceRemoval).toHaveBeenCalledWith(expect.objectContaining({ id: "board-a" }));
    expect(jira.repoBindings).toEqual([{ profileId: "profile-b", jiraConnectionId: "conn-b", projectKey: "OPS" }]);
    void handlers;
    cache.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("the remote connection list does not expose gateway coordinates or local certificate paths", async () => {
    const { handlers, state } = setup();
    Object.assign(state.settings.integrations.jira.connections[0], {
      subscriptionHeaderName: "Ocp-Apim-Subscription-Key",
      clientCertificatePath: "C:\\private\\client.pfx",
    });
    const remote = await handlers.jiraRemoteListConnections("profile-a");
    expect(JSON.stringify(remote)).not.toContain("client.pfx");
    expect(remote[0]).not.toHaveProperty("clientCertificatePath");
    expect(remote[0]).not.toHaveProperty("subscriptionHeaderName");
    expect(remote[0].apiBaseUrl).toBe("");
    expect(jiraConnectionDtoSchema.safeParse(remote[0]).success).toBe(true);
    const desktop = await handlers.jiraListConnections("window-a");
    expect(desktop[0].apiBaseUrl).toBe("https://jira.example.com/jira");
  });

  it("a slow Jira gets at most one queued background sync per view instead of one per tick", async () => {
    vi.useFakeTimers();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-jira-sync-pile-"));
    const cache = createJiraCache(path.join(root, "jira.sqlite"));
    const { state, context } = setup();
    context.jiraCache = cache;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let hold = false;
    const boardView = vi.fn(async () => {
      if (hold) await gate;
      return { cache: {} };
    });
    context.jiraManager = { boardView, invalidate: vi.fn(), verifyUserIdentity: vi.fn() };
    state.workspaces.push({
      id: "inbox-a",
      kind: "jira",
      profileId: "profile-a",
    } as unknown as AppState["workspaces"][0]);
    const handlers = createJiraHandlers(context);
    for (const boardId of [1, 2, 3])
      await handlers.saveJiraWorkspaceView(
        {
          workspaceId: "inbox-a",
          view: { kind: "board", connectionId: "conn-a", boardId, boardName: `B${boardId}` },
        } as never,
        "window-a",
      );
    await vi.advanceTimersByTimeAsync(10);
    boardView.mockClear();

    hold = true;
    context.getActiveJiraProfileIds = () => new Set(["profile-a"]);
    handlers.startJiraWorkspaceViewSync();
    await vi.advanceTimersByTimeAsync(10);
    for (let tick = 0; tick < 4; tick += 1) await vi.advanceTimersByTimeAsync(120_000);
    release();
    await vi.advanceTimersByTimeAsync(10);
    expect(boardView.mock.calls.length).toBeLessThanOrEqual(3);
    handlers.stopJiraWorkspaceViewSync();
    cache.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("background view sync only touches profiles that are open in a window or bound to a remote session", async () => {
    vi.useFakeTimers();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-jira-sync-scope-"));
    const cache = createJiraCache(path.join(root, "jira.sqlite"));
    const { state, context } = setup();
    context.jiraCache = cache;
    const searchPage = vi.fn(async () => ({ issues: [], hasMore: false, truncated: false, cache: {} }));
    context.jiraManager = { searchPage, invalidate: vi.fn(), verifyUserIdentity: vi.fn() };
    state.workspaces.push(
      ...([
        { id: "inbox-a", kind: "jira", profileId: "profile-a" },
        { id: "inbox-b", kind: "jira", profileId: "profile-b" },
      ] as unknown as AppState["workspaces"]),
    );
    const handlers = createJiraHandlers(context);
    await handlers.saveJiraWorkspaceView(
      { workspaceId: "inbox-a", view: { kind: "personal", connectionId: "conn-a" } },
      "window-a",
    );
    await handlers.saveJiraWorkspaceView(
      { workspaceId: "inbox-b", view: { kind: "personal", connectionId: "conn-b" } },
      "window-b",
    );
    await vi.advanceTimersByTimeAsync(10);
    searchPage.mockClear();

    context.getActiveJiraProfileIds = () => new Set(["profile-a"]);
    handlers.startJiraWorkspaceViewSync();
    await vi.advanceTimersByTimeAsync(10);
    const touched = searchPage.mock.calls.map((call) => (call as unknown as [{ id: string }])[0].id);
    expect(touched).toEqual(["conn-a"]);

    // pollSeconds is read again on every tick: a later change of cadence is honoured.
    state.settings.integrations.jira.connections[0].pollSeconds = 3600;
    context.getActiveJiraProfileIds = () => new Set(["profile-a", "profile-b"]);
    searchPage.mockClear();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(searchPage.mock.calls.map((call) => (call as unknown as [{ id: string }])[0].id).sort()).toEqual([
      "conn-a",
      "conn-b",
    ]);
    handlers.stopJiraWorkspaceViewSync();
    cache.close();
    await fs.rm(root, { recursive: true, force: true });
  });
});

describe("Jira Cloud API token connections", () => {
  const SITE = "https://example.atlassian.net";
  const input = {
    label: "Cloud",
    deployment: "cloud" as const,
    webUrl: SITE,
    apiBaseUrl: SITE,
    email: "me@example.com",
    apiToken: "api-token-value",
  };
  const identity = () => new Response(JSON.stringify({ accountId: "acc-1", displayName: "Me" }));
  const siteOnly = (url: string) => (url === `${SITE}/rest/api/3/myself` ? identity() : undefined);
  const gatewayOnly = (url: string) => {
    if (url === `${SITE}/rest/api/3/myself`) return new Response("{}", { status: 401 });
    if (url === `${SITE}/_edge/tenant_info`) return new Response(JSON.stringify({ cloudId: "cloud-1" }));
    if (url === "https://api.atlassian.com/ex/jira/cloud-1/rest/api/3/myself") return identity();
    return undefined;
  };
  const saved = (state: AppState) =>
    (state.settings.integrations.jira.connections as unknown as Array<JiraConnection>).find(
      (item) => item.deployment === "cloud",
    );

  it("saves a verified connection with the token under a ref derived from its id", async () => {
    const { handlers, state, secrets } = setup({ route: siteOnly });
    const result = await handlers.jiraSaveConnection(input, "window-a");
    const connection = saved(state)!;
    expect(result).toMatchObject({
      ok: true,
      connection: { auth: { kind: "cloud-api-token", email: "me@example.com" } },
    });
    expect(connection).toMatchObject({
      profileId: "profile-a",
      deployment: "cloud",
      webUrl: SITE,
      apiBaseUrl: SITE,
      accountPurpose: "personal",
      auth: { kind: "cloud-api-token", email: "me@example.com", secretRef: `jira:${connection.id}:api-token` },
      verifiedIdentity: { kind: "cloud", accountId: "acc-1" },
      ownIdentity: { kind: "cloud", accountId: "acc-1" },
    });
    expect(connection).not.toHaveProperty("cloudId");
    expect(secrets.get(connection.auth.secretRef!)).toBe("api-token-value");
    expect([...secrets.keys()].filter((ref) => ref.includes(":verify:"))).toEqual([]);
    expect(JSON.stringify(state)).not.toContain("api-token-value");
  });

  it("persists the gateway root and cloud id when the site refuses the token", async () => {
    const { handlers, state, requests } = setup({ route: gatewayOnly });
    await handlers.jiraSaveConnection(input, "window-a");
    expect(saved(state)).toMatchObject({ cloudId: "cloud-1", webUrl: SITE });
    expect(requests.map((request) => request.url)).toEqual([
      `${SITE}/rest/api/3/myself`,
      `${SITE}/_edge/tenant_info`,
      "https://api.atlassian.com/ex/jira/cloud-1/rest/api/3/myself",
    ]);
    requests.length = 0;
    await handlers.jiraGetIssue({ connectionId: saved(state)!.id, issueId: "1" }, "window-a").catch(() => undefined);
    expect(requests.every((request) => request.url.startsWith("https://api.atlassian.com/ex/jira/cloud-1/"))).toBe(
      true,
    );
  });

  it("keeps the technical account's own identity unset", async () => {
    const { handlers, state } = setup({ route: siteOnly });
    await handlers.jiraSaveConnection({ ...input, accountPurpose: "technical" }, "window-a");
    expect(saved(state)).toMatchObject({ accountPurpose: "technical", verifiedIdentity: { accountId: "acc-1" } });
    expect(saved(state)).not.toHaveProperty("ownIdentity");
  });

  it("stores nothing when verification fails, and says what to check", async () => {
    const { handlers, state, secrets } = setup({
      route: (url) =>
        url.endsWith("/_edge/tenant_info")
          ? new Response("nope", { status: 404 })
          : new Response("{}", { status: 401 }),
    });
    await expect(handlers.jiraSaveConnection(input, "window-a")).rejects.toMatchObject({
      code: "auth-expired",
      message: expect.stringMatching(/email or API token/),
    });
    expect(saved(state)).toBeUndefined();
    expect([...secrets.keys()].filter((ref) => ref.includes("cloud") || ref.includes("verify"))).toEqual([]);
  });

  it("keeps the saved token when an edit leaves it blank, and replaces it when one is typed", async () => {
    const { handlers, state, secrets } = setup({ route: siteOnly });
    await handlers.jiraSaveConnection(input, "window-a");
    const id = saved(state)!.id;
    await handlers.jiraSaveConnection({ ...input, id, apiToken: "", email: "other@example.com" }, "window-a");
    expect(saved(state)).toMatchObject({ id, auth: { email: "other@example.com" } });
    expect(secrets.get(`jira:${id}:api-token`)).toBe("api-token-value");
    await handlers.jiraSaveConnection({ ...input, id, apiToken: "rotated-token" }, "window-a");
    expect(secrets.get(`jira:${id}:api-token`)).toBe("rotated-token");
    expect(state.settings.integrations.jira.connections.filter((item) => item.id === id)).toHaveLength(1);
  });

  it("never sends the saved token to a different site", async () => {
    const { handlers, state, requests } = setup({ route: siteOnly });
    await handlers.jiraSaveConnection(input, "window-a");
    const id = saved(state)!.id;
    requests.length = 0;
    const moved = { ...input, id, apiToken: "", webUrl: "https://other.atlassian.net" };
    await expect(handlers.jiraSaveConnection(moved, "window-a")).rejects.toThrow(/different Jira site/);
    await expect(handlers.jiraTestConnection(moved, "window-a")).resolves.toMatchObject({ ok: false });
    expect(requests).toEqual([]);
    expect(saved(state)).toMatchObject({ webUrl: SITE });
  });

  it("refuses an insecure site, a missing email and a missing token before any request", async () => {
    const { handlers, requests } = setup({ route: siteOnly });
    await expect(
      handlers.jiraSaveConnection({ ...input, webUrl: "http://example.atlassian.net" }, "window-a"),
    ).rejects.toThrow(/HTTPS/);
    await expect(handlers.jiraSaveConnection({ ...input, email: " " }, "window-a")).rejects.toThrow(/email/);
    await expect(handlers.jiraSaveConnection({ ...input, apiToken: "" }, "window-a")).rejects.toThrow(/API token/);
    expect(requests).toEqual([]);
  });

  it("tests a draft without saving anything", async () => {
    const { handlers, state, secrets } = setup({ route: siteOnly });
    const before = new Set(secrets.keys());
    await expect(handlers.jiraTestConnection(input, "window-a")).resolves.toMatchObject({
      ok: true,
      identity: { kind: "cloud", accountId: "acc-1" },
      serverTitle: "Jira Cloud",
    });
    expect(saved(state)).toBeUndefined();
    expect(new Set(secrets.keys())).toEqual(before);
    const failing = setup({ route: () => new Response("{}", { status: 403 }) });
    await expect(failing.handlers.jiraTestConnection(input, "window-a")).resolves.toMatchObject({
      ok: false,
      error: { code: "permission-denied" },
    });
  });

  it("removes the token with the connection", async () => {
    const { handlers, state, secrets } = setup({ route: siteOnly });
    await handlers.jiraSaveConnection(input, "window-a");
    const { id, auth } = saved(state)!;
    await handlers.jiraDeleteConnection(id, "window-a");
    expect(saved(state)).toBeUndefined();
    expect(secrets.has(auth.secretRef!)).toBe(false);
  });
});

describe("writes from remote viewers", () => {
  const profiles = { "remote:s1": "profile-a", "remote:s2": "profile-a", "remote:s3": "profile-b" };
  const note = { ref: { ...REF, connectionId: "conn-a" }, body: "From my phone", intent: "User confirmed note" };

  it("previews, executes and journals in the viewer's own profile", async () => {
    const { handlers, secrets, requests } = setup({ profiles });
    const confirmation = await handlers.jiraPreviewComment(note, "remote:s1");
    await expect(
      handlers.jiraExecuteComment({ ref: note.ref, body: note.body, confirmation }, "remote:s1"),
    ).resolves.toMatchObject({ ok: true });
    expect(requests.some((request) => request.method === "POST" && request.url.includes("/comment"))).toBe(true);
    expect(journalEntries(secrets, "profile-a")).toHaveLength(1);
    await expect(handlers.jiraGetWriteHistory({}, "remote:s1")).resolves.toMatchObject([{ profileId: "profile-a" }]);
  });

  it("refuses a connection of another profile at preview, execute, transitions and history", async () => {
    const { handlers, requests } = setup({ profiles });
    const foreign = { ...note, ref: { ...REF, connectionId: "conn-b" } };
    await expect(handlers.jiraPreviewComment(foreign, "remote:s1")).rejects.toThrow("another profile");
    await expect(handlers.jiraListTransitions(foreign.ref, "remote:s1")).rejects.toThrow("another profile");
    await expect(handlers.jiraGetWriteHistory({ connectionId: "conn-b" }, "remote:s1")).rejects.toThrow(
      "another profile",
    );
    expect(requests.filter((request) => request.method !== "GET")).toHaveLength(0);
  });

  it("does not honour a confirmation previewed by another viewer", async () => {
    const { handlers, requests } = setup({ profiles });
    const confirmation = await handlers.jiraPreviewComment(note, "remote:s1");
    const attempt = handlers.jiraExecuteComment({ ref: note.ref, body: note.body, confirmation }, "remote:s2");
    await expect(attempt.then((result: { ok?: boolean }) => result.ok === true)).resolves.toBe(false);
    expect(requests.filter((request) => request.method === "POST")).toHaveLength(0);
  });

  it("refuses an unbound remote viewer", async () => {
    const { handlers } = setup({ profiles });
    await expect(handlers.jiraPreviewComment(note, "remote:unknown")).rejects.toThrow("Jira profile");
  });

  it("composes the technical-account attribution into the previewed text", async () => {
    const { handlers, state, secrets } = setup({ profiles });
    (state.settings.integrations.jira.connections as unknown[]).push(
      dcConnection("conn-t", "profile-a", {
        accountPurpose: "technical",
        verifiedIdentity: { kind: "data-center", name: "bot", displayName: "Jira Bot" },
      }),
    );
    secrets.set("jira:conn-t:pat", "token-t");
    const confirmation = await handlers.jiraPreviewComment(
      { ...note, ref: { ...REF, connectionId: "conn-t" } },
      "remote:s1",
    );
    expect(confirmation.preview).toBe("On behalf of Alice\n\nFrom my phone");
  });
});
