import { describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { JiraSavedWorkspaceView } from "../../shared/types/jira-workspace-views.js";
import type { AppState } from "../../shared/types/state.js";
import { createStore } from "../store.js";
import { createJiraHandlers } from "./runtime-jira-handlers.js";
import { createJiraCache } from "./jira-cache.js";
import { createJiraAttachmentCache } from "./jira-attachment-cache.js";
import { JiraManager, type JiraConnection } from "./jira-manager.js";
import { fileURLToPath } from "node:url";

function setup() {
  const state = {
    settings: {
      integrations: {
        jira: {
          connections: [
            {
              id: "same-host-a",
              profileId: "profile-a",
              label: "A",
              enabled: true,
              deployment: "data-center",
              webUrl: "https://jira.example.com",
              apiBaseUrl: "https://jira.example.com/jira",
              auth: { kind: "dc-pat", secretRef: "jira:a:pat" },
              accountPurpose: "personal",
            },
            {
              id: "same-host-b",
              profileId: "profile-b",
              label: "B",
              enabled: true,
              deployment: "data-center",
              webUrl: "https://jira.example.com",
              apiBaseUrl: "https://jira.example.com/jira",
              auth: { kind: "dc-pat", secretRef: "jira:b:pat" },
              accountPurpose: "personal",
            },
          ],
          queries: [],
        },
      },
    },
    workspaces: [],
  } as unknown as AppState;
  const secrets = new Map([
    ["jira:a:pat", "token-a"],
    ["jira:b:pat", "token-b"],
  ]);
  const credentialStore = {
    isEncryptionAvailable: () => true,
    getSecret: (ref: string) => secrets.get(ref) || "",
    hasSecret: (ref: string) => secrets.has(ref),
    listRefs: () => [...secrets.keys()],
    setSecret: vi.fn(async (ref: string, value: string, _options?: { requireEncryptedStorage?: boolean }) => {
      secrets.set(ref, value);
    }),
    deleteSecret: vi.fn(async (ref: string) => {
      secrets.delete(ref);
    }),
  };
  const store = { mutate: async (mutator: (draft: AppState) => void) => mutator(state) };
  const fetchImpl = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ issues: [] })),
  );
  const log = {
    info: vi.fn((_event: string, _fields?: Record<string, unknown>) => undefined),
    warn: vi.fn((_event: string, _fields?: Record<string, unknown>) => undefined),
  };
  const context: {
    credentialStore: typeof credentialStore;
    store: typeof store;
    fetchImpl: typeof fetchImpl;
    getState: () => AppState;
    getViewerProfileId: (windowId: string) => string | null;
    log: typeof log;
    jiraLog?: typeof log;
    jiraCache?: ReturnType<typeof createJiraCache>;
    jiraManager?:
      | JiraManager
      | {
          boardView?: ReturnType<typeof vi.fn>;
          searchPage?: ReturnType<typeof vi.fn>;
          verifyUserIdentity?: ReturnType<typeof vi.fn>;
          invalidate?: ReturnType<typeof vi.fn>;
        };
    broadcastState?: ReturnType<typeof vi.fn>;
  } = {
    credentialStore,
    store,
    fetchImpl,
    getState: () => state,
    getViewerProfileId: (windowId: string) =>
      (({ "window-a": "profile-a", "window-b": "profile-b" }) as Record<string, string>)[windowId] || null,
    log,
    jiraLog: log,
  };
  const handlers = createJiraHandlers(context);
  return { handlers, state, secrets, credentialStore, fetchImpl, context, log };
}

describe("Jira runtime profile ownership", () => {
  it("my issues: open issues of the verified identity per connection of this profile only, cache-only unless asked", async () => {
    const { state, context } = setup();
    const connections = state.settings.integrations.jira.connections as unknown as Array<Record<string, unknown>>;
    connections[0].ownIdentity = { kind: "data-center", name: "alice", displayName: "Alice" };
    connections[1].ownIdentity = { kind: "data-center", name: "bob", displayName: "Bob" };
    connections.push({ ...connections[0], id: "no-identity", label: "C", ownIdentity: undefined });
    connections.push({ ...connections[0], id: "broken", label: "D" });
    const issue = {
      ref: { provider: "jira", connectionId: "same-host-a", issueId: "1", issueKey: "OPS-1" },
      summary: "Mine",
      status: "To Do",
      statusCategory: "new",
      issueType: "Task",
      projectKey: "OPS",
      updated: "2026-11-10T10:00:00.000Z",
      url: "https://jira.example.com/browse/OPS-1",
    };
    const searchPage = vi.fn(async (connection: { id: string }, ..._rest: unknown[]) => {
      if (connection.id === "broken") throw Object.assign(new Error("Jira said no"), { code: "auth-expired" });
      return {
        issues: [issue],
        hasMore: true,
        truncated: false,
        cache: { source: "cache", fetchedAt: 1, stale: false },
      };
    });
    context.jiraManager = { searchPage, invalidate: vi.fn(), verifyUserIdentity: vi.fn() };
    const handlers = createJiraHandlers(context);

    const result = await handlers.jiraMyIssues({}, "window-a");
    expect(result.connections.map((row: { connectionId: string }) => row.connectionId)).toEqual([
      "same-host-a",
      "broken",
    ]);
    expect(result.connections[0]).toMatchObject({ label: "A", hasMore: true, issues: [{ summary: "Mine" }] });
    expect(result.connections[1]).toMatchObject({ issues: [], cache: null, error: { code: expect.any(String) } });
    const [connection, jql, limit, cursor, options] = searchPage.mock.calls[0] as unknown as [
      { id: string },
      string,
      number,
      undefined,
      Record<string, unknown>,
    ];
    expect(connection.id).toBe("same-host-a");
    expect(jql).toBe('(statusCategory != Done) AND assignee = "alice" ORDER BY updated DESC');
    expect([limit, cursor, options]).toEqual([50, undefined, { cacheOnly: true }]);

    searchPage.mockClear();
    await handlers.jiraMyIssues({ refresh: "if-stale" }, "window-a");
    expect(searchPage.mock.calls[0][4]).toEqual({ forceRefresh: false });
    await handlers.jiraMyIssues({ refresh: "force" }, "window-a");
    expect(searchPage.mock.calls.at(-1)?.[4]).toEqual({ forceRefresh: true });

    const remote = await handlers.jiraRemoteMyIssues({}, "profile-b");
    expect(remote.connections.map((row: { connectionId: string }) => row.connectionId)).toEqual(["same-host-b"]);
    await expect(handlers.jiraRemoteMyIssues({}, "")).rejects.toThrow("authenticated profile");
  });

  it("persists per-workspace project scope and applies saved personal scope in the canonical query", async () => {
    const { state, context, fetchImpl } = setup();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-jira-project-scope-"));
    const cache = createJiraCache(path.join(root, "jira.sqlite"));
    context.jiraCache = cache;
    state.workspaces.push(
      { id: "jira-workspace-a", kind: "jira", profileId: "profile-a" } as AppState["workspaces"][number],
      { id: "jira-workspace-b", kind: "jira", profileId: "profile-b" } as AppState["workspaces"][number],
    );
    const connection = state.settings.integrations.jira.connections[0] as JiraConnection;
    connection.projectKeys = ["DEFAULT"];
    connection.ownIdentity = { kind: "data-center", name: "alice", displayName: "Alice" };
    context.jiraManager = new JiraManager(context.credentialStore, fetchImpl as typeof fetch, cache);
    const handlers = createJiraHandlers(context);
    expect(
      await handlers.getJiraWorkspaceProjectScope(
        { workspaceId: "jira-workspace-a", connectionId: "same-host-a" },
        "window-a",
      ),
    ).toBeNull();
    await handlers.setJiraWorkspaceProjectScope(
      { workspaceId: "jira-workspace-a", connectionId: "same-host-a", projectKeys: ["ops", "APP", "ops"] },
      "window-a",
    );
    expect(
      await handlers.getJiraWorkspaceProjectScope(
        { workspaceId: "jira-workspace-a", connectionId: "same-host-a" },
        "window-a",
      ),
    ).toEqual(["APP", "OPS"]);
    await expect(
      handlers.getJiraWorkspaceProjectScope(
        { workspaceId: "jira-workspace-a", connectionId: "same-host-a" },
        "window-b",
      ),
    ).rejects.toThrow(/profile/i);

    const first = await handlers.saveJiraWorkspaceView(
      {
        workspaceId: "jira-workspace-a",
        view: { kind: "personal", connectionId: "same-host-a", projectKeys: ["OPS"] },
      },
      "window-a",
    );
    const personal = first.views.find((view) => view.kind === "personal");
    if (!personal || personal.kind !== "personal") throw new Error("Expected a personal Jira view.");
    expect(personal.projectKeys).toEqual(["OPS"]);
    const expected = await handlers.buildJiraOwnIssuesQuery(
      { connectionId: "same-host-a", projectKeys: ["OPS"] },
      "window-a",
    );
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    const searchRequest = fetchImpl.mock.calls
      .map(([input]) => new URL(String(input)))
      .find((url) => url.pathname.endsWith("/search"));
    expect(searchRequest?.searchParams.get("jql")).toBe(expected.jql);
    await handlers.saveJiraWorkspaceView(
      {
        workspaceId: "jira-workspace-a",
        view: { kind: "personal", connectionId: "same-host-a", boardId: null },
      },
      "window-a",
    );
    const preserved = handlers
      .getJiraWorkspaceViewsSnapshot()
      ["jira-workspace-a"]?.views.find((view): view is JiraSavedWorkspaceView => view.kind === "personal");
    expect(preserved?.projectKeys).toEqual(["OPS"]);
    await handlers.saveJiraWorkspaceView(
      {
        workspaceId: "jira-workspace-a",
        view: { kind: "personal", connectionId: "same-host-a", boardId: null, projectKeys: null },
      },
      "window-a",
    );
    expect(
      handlers
        .getJiraWorkspaceViewsSnapshot()
        ["jira-workspace-a"]?.views.find((view): view is JiraSavedWorkspaceView => view.kind === "personal")
        ?.projectKeys,
    ).toBeUndefined();

    await handlers.setJiraWorkspaceProjectScope(
      { workspaceId: "jira-workspace-a", connectionId: "same-host-a", projectKeys: [] },
      "window-a",
    );
    expect(
      await handlers.getJiraWorkspaceProjectScope(
        { workspaceId: "jira-workspace-a", connectionId: "same-host-a" },
        "window-a",
      ),
    ).toEqual([]);
    cache.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("carries project scope into new and legacy pinned Jira board views", async () => {
    const { state, context } = setup();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-jira-pinned-project-scope-"));
    const cache = createJiraCache(path.join(root, "jira.sqlite"));
    context.jiraCache = cache;
    const boardView = vi.fn(async (..._args: unknown[]) => ({
      boardId: 42,
      issues: [],
      hasMore: false,
      truncated: false,
    }));
    context.jiraManager = { boardView };
    state.workspaces.push(
      {
        id: "pinned-all",
        kind: "jira-board",
        profileId: "profile-a",
        jiraBoard: {
          parentWorkspaceId: "jira-inbox",
          connectionId: "same-host-a",
          boardId: "42",
          boardName: "Platform",
          projectKeys: [],
        },
      } as unknown as AppState["workspaces"][number],
      {
        id: "pinned-legacy",
        kind: "jira-board",
        profileId: "profile-a",
        jiraBoard: {
          parentWorkspaceId: "jira-inbox",
          connectionId: "same-host-a",
          boardId: "43",
          boardName: "Operations",
          projectKeys: ["OPS"],
        },
      } as unknown as AppState["workspaces"][number],
    );
    cache.saveView({
      profileId: "profile-a",
      workspaceId: "pinned-legacy",
      viewId: "legacy-board",
      active: true,
      value: {
        viewId: "legacy-board",
        kind: "board",
        connectionId: "same-host-a",
        boardId: 43,
        boardName: "Operations",
        title: "Operations",
        mode: "issues",
        sprintId: null,
        quickFilterIds: [],
        assignee: null,
        doneWithinDays: null,
        createdAt: 1,
        updatedAt: 1,
      },
    });
    const handlers = createJiraHandlers(context);
    const allState = await handlers.getJiraWorkspaceViews({ workspaceId: "pinned-all" }, "window-a");
    const allView = allState.views.find((view) => view.kind === "board");
    if (!allView || allView.kind !== "board") throw new Error("Expected a pinned board view.");
    expect(allView.projectKeys).toEqual([]);
    await handlers.saveJiraWorkspaceView(
      {
        workspaceId: "pinned-all",
        view: { kind: "board", connectionId: "same-host-a", boardId: 42, mode: "backlog" },
      },
      "window-a",
    );
    const savedAll = handlers
      .getJiraWorkspaceViewsSnapshot()
      ["pinned-all"]?.views.find((view) => view.kind === "board");
    expect(savedAll?.kind === "board" ? savedAll.projectKeys : undefined).toEqual([]);
    await handlers.saveJiraWorkspaceView(
      {
        workspaceId: "pinned-all",
        view: { kind: "board", connectionId: "same-host-a", boardId: 42, projectKeys: null },
      },
      "window-a",
    );
    expect(state.workspaces.find((workspace) => workspace.id === "pinned-all")?.jiraBoard?.projectKeys).toBeUndefined();
    const reopenedHandlers = createJiraHandlers(context);
    const reopened = await reopenedHandlers.getJiraWorkspaceViews({ workspaceId: "pinned-all" }, "window-a");
    const reopenedView = reopened.views.find((view) => view.kind === "board");
    expect(reopenedView?.kind === "board" ? reopenedView.projectKeys : undefined).toBeUndefined();
    const legacyState = await handlers.getJiraWorkspaceViews({ workspaceId: "pinned-legacy" }, "window-a");
    const migrated = legacyState.views.find((view) => view.kind === "board");
    expect(migrated?.kind === "board" ? migrated.projectKeys : undefined).toEqual(["OPS"]);
    await vi.waitFor(() => expect(boardView).toHaveBeenCalled());
    const allCall = boardView.mock.calls.find((call) => call[1] === 42);
    expect(allCall?.[5]).toMatchObject({ projectKeys: [] });
    cache.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("persists view presentation, title, and order without restarting an in-flight Jira sync", async () => {
    const { state, context } = setup();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-jira-view-presentation-"));
    const cache = createJiraCache(path.join(root, "jira.sqlite"));
    context.jiraCache = cache;
    state.workspaces.push({
      id: "jira-workspace-a",
      kind: "jira",
      profileId: "profile-a",
    } as AppState["workspaces"][number]);
    let finishSync!: (value: unknown) => void;
    const boardView = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          finishSync = resolve;
        }),
    );
    context.jiraManager = { boardView };
    const handlers = createJiraHandlers(context);
    const saved = await handlers.saveJiraWorkspaceView(
      {
        workspaceId: "jira-workspace-a",
        view: { kind: "board", connectionId: "same-host-a", boardId: 42, boardName: "Platform" },
      },
      "window-a",
    );
    const viewId = saved.views.find((view) => view.kind === "board")!.viewId;
    await vi.waitFor(() => expect(boardView).toHaveBeenCalledTimes(1));
    const originalValue = cache.listSavedViews("profile-a", "jira-workspace-a").find((view) => view.viewId === viewId)!
      .value as { updatedAt: number };
    const originalUpdatedAt = originalValue.updatedAt;
    const renamed = await handlers.renameJiraWorkspaceView(
      { workspaceId: "jira-workspace-a", viewId, title: "My platform" },
      "window-a",
    );
    expect(renamed.views.find((view) => view.viewId === viewId)?.title).toBe("My platform");
    await handlers.saveJiraWorkspaceView(
      {
        workspaceId: "jira-workspace-a",
        view: {
          kind: "board",
          connectionId: "same-host-a",
          boardId: 42,
          boardName: "Platform",
          mode: "issues",
          presentation: "list",
          statusFilter: "In Progress",
        },
      },
      "window-a",
    );
    const stored = cache.listSavedViews("profile-a", "jira-workspace-a").find((view) => view.viewId === viewId)!.value;
    expect(stored).toMatchObject({
      title: "My platform",
      presentation: "list",
      statusFilter: "In Progress",
      updatedAt: originalUpdatedAt,
    });
    await handlers.reorderJiraWorkspaceViews({ workspaceId: "jira-workspace-a", viewIds: [viewId] }, "window-a");
    expect(boardView).toHaveBeenCalledTimes(1);
    expect(handlers.getJiraWorkspaceViewsSnapshot()["jira-workspace-a"]?.syncByViewId[viewId]?.state).toBe("syncing");
    finishSync({ boardId: 42, issues: [], hasMore: false, truncated: false });
    await vi.waitFor(() =>
      expect(handlers.getJiraWorkspaceViewsSnapshot()["jira-workspace-a"]?.syncByViewId[viewId]?.state).toBe("idle"),
    );
    cache.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("persists workspace board views, reuses their identity, and scopes them to the owning profile", async () => {
    const { state, context } = setup();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-jira-view-"));
    const cache = createJiraCache(path.join(root, "jira.sqlite"));
    context.jiraCache = cache;
    context.broadcastState = vi.fn();
    state.workspaces.push({
      id: "jira-workspace-a",
      kind: "jira",
      profileId: "profile-a",
    } as AppState["workspaces"][number]);
    context.jiraManager = {
      boardView: vi.fn(async () => ({ boardId: 42, issues: [], hasMore: false, truncated: false })),
    };
    const handlers = createJiraHandlers(context);
    const first = await handlers.saveJiraWorkspaceView(
      {
        workspaceId: "jira-workspace-a",
        view: { kind: "board", connectionId: "same-host-a", boardId: 42, boardName: "Operations" },
      },
      "window-a",
    );
    const firstBoard = first.views.find((view) => view.kind === "board");
    if (!firstBoard || firstBoard.kind !== "board") throw new Error("Expected a saved Jira board view.");
    expect(firstBoard).toMatchObject({ viewId: expect.any(String), boardId: 42, title: "Operations", mode: "issues" });
    expect(first.activeViewId).toBe(firstBoard.viewId);
    expect(first.syncByViewId[firstBoard.viewId]?.state).toBe("syncing");
    const again = await handlers.saveJiraWorkspaceView(
      {
        workspaceId: "jira-workspace-a",
        view: { kind: "board", connectionId: "same-host-a", boardId: 42, title: "Ops board" },
      },
      "window-a",
    );
    expect(again.views.filter((view) => view.kind === "board")).toHaveLength(1);
    expect(again.views.find((view) => view.kind === "board")?.viewId).toBe(firstBoard?.viewId);
    cache.saveView({
      profileId: "profile-a",
      workspaceId: "jira-workspace-a",
      viewId: "malformed",
      value: { viewId: "malformed", kind: "personal", connectionId: "same-host-a", title: "bad" },
      active: false,
    });
    const reloaded = await handlers.getJiraWorkspaceViews({ workspaceId: "jira-workspace-a" }, "window-a");
    expect(reloaded.views.some((view) => view.viewId === "malformed")).toBe(false);
    expect(cache.listSavedViews("profile-a", "jira-workspace-a")).toHaveLength(2);
    const snapshot = handlers.getJiraWorkspaceViewsSnapshot();
    expect(Object.keys(snapshot)).toContain("jira-workspace-a");
    expect(snapshot["jira-workspace-a"]).toMatchObject({ workspaceId: "jira-workspace-a", profileId: "profile-a" });
    await expect(handlers.getJiraWorkspaceViews({ workspaceId: "jira-workspace-a" }, "window-b")).rejects.toThrow(
      "Jira workspace was not found in this profile",
    );
    expect(cache.listSavedViews("profile-a", "jira-workspace-a")).toHaveLength(2);
    cache.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("refreshes the exact personal query used by My issues and does not publish status after stop/remove", async () => {
    const { state, context } = setup();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-jira-personal-view-"));
    const cache = createJiraCache(path.join(root, "jira.sqlite"));
    context.jiraCache = cache;
    context.broadcastState = vi.fn();
    state.workspaces.push({
      id: "jira-workspace-a",
      kind: "jira",
      profileId: "profile-a",
    } as AppState["workspaces"][number]);
    state.settings.integrations.jira.connections[0]!.ownIdentity = {
      kind: "data-center",
      name: "alice",
      displayName: "Alice",
    };
    let resolveBoard!: (value: unknown) => void;
    context.jiraManager = {
      searchPage: vi.fn(async () => ({
        issues: [],
        hasMore: false,
        truncated: false,
        cache: { refreshError: undefined },
      })),
      boardView: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveBoard = resolve;
          }),
      ),
    };
    const handlers = createJiraHandlers(context);
    const personal = await handlers.saveJiraWorkspaceView(
      {
        workspaceId: "jira-workspace-a",
        view: { kind: "personal", connectionId: "same-host-a" },
      },
      "window-a",
    );
    const query = await handlers.buildJiraOwnIssuesQuery({ connectionId: "same-host-a" }, "window-a");
    expect(query.jql).toBe('(statusCategory != Done) AND assignee = "alice"');
    expect(context.jiraManager?.searchPage).toHaveBeenCalledWith(
      expect.objectContaining({ id: "same-host-a" }),
      query.jql,
      50,
      undefined,
      { forceRefresh: false },
    );
    expect(personal.views.find((view) => view.kind === "personal")).toMatchObject({ kind: "personal", boardId: null });
    const personalId = personal.views.find((view) => view.kind === "personal")!.viewId;
    await vi.waitFor(() => expect(context.jiraManager?.searchPage).toHaveBeenCalledTimes(1));
    const all = await handlers.saveJiraWorkspaceView(
      {
        workspaceId: "jira-workspace-a",
        view: { kind: "personal", connectionId: "same-host-a", personalScope: "all" },
      },
      "window-a",
    );
    await vi.waitFor(() => expect(context.jiraManager?.searchPage).toHaveBeenCalledTimes(2));
    expect(all.views.find((view) => view.viewId === personalId)).toMatchObject({ personalScope: "all" });
    expect((context.jiraManager?.searchPage as ReturnType<typeof vi.fn>).mock.calls[1][1]).toBe('assignee = "alice"');
    await expect(
      handlers.buildJiraOwnIssuesQuery({ connectionId: "same-host-a", personalScope: "all" }, "window-a"),
    ).resolves.toMatchObject({ jql: 'assignee = "alice"' });

    const board = await handlers.saveJiraWorkspaceView(
      {
        workspaceId: "jira-workspace-a",
        view: { kind: "board", connectionId: "same-host-a", boardId: 42 },
      },
      "window-a",
    );
    const boardId = board.views.find((view) => view.kind === "board")!.viewId;
    expect(board.syncByViewId[boardId]?.state).toBe("syncing");
    await handlers.removeJiraWorkspaceView({ workspaceId: "jira-workspace-a", viewId: boardId }, "window-a");
    handlers.stopJiraWorkspaceViewSync();
    const broadcastCount = (context.broadcastState as ReturnType<typeof vi.fn>).mock.calls.length;
    resolveBoard({ boardId: 42, issues: [], hasMore: false, truncated: false });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(handlers.getJiraWorkspaceViewsSnapshot()["jira-workspace-a"]?.syncByViewId).not.toHaveProperty(boardId);
    expect((context.broadcastState as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(broadcastCount);
    cache.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("keeps the active view when an inactive saved view's filters are updated", async () => {
    const { state, context } = setup();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-jira-view-active-"));
    const dbPath = path.join(root, "jira.sqlite");
    const cache = createJiraCache(dbPath);
    context.jiraCache = cache;
    context.broadcastState = vi.fn();
    state.workspaces.push({
      id: "jira-workspace-a",
      kind: "jira",
      profileId: "profile-a",
    } as AppState["workspaces"][number]);
    context.jiraManager = {
      boardView: vi.fn(async () => ({ boardId: 42, issues: [], hasMore: false, truncated: false })),
    };
    const handlers = createJiraHandlers(context);
    const viewA = await handlers.saveJiraWorkspaceView(
      { workspaceId: "jira-workspace-a", view: { kind: "board", connectionId: "same-host-a", boardId: 42 } },
      "window-a",
    );
    const viewAId = viewA.views.find((view) => view.kind === "board")!.viewId;
    const viewB = await handlers.saveJiraWorkspaceView(
      {
        workspaceId: "jira-workspace-a",
        view: { kind: "board", connectionId: "same-host-a", boardId: 43, title: "Platform" },
      },
      "window-a",
    );
    const viewBId = viewB.views.find((view) => view.kind === "board" && view.boardId === 43)!.viewId;
    expect(viewB.activeViewId).toBe(viewBId);

    const updatedA = await handlers.saveJiraWorkspaceView(
      {
        workspaceId: "jira-workspace-a",
        view: {
          kind: "board",
          connectionId: "same-host-a",
          boardId: 42,
          mode: "backlog",
          quickFilterIds: [7],
        },
      },
      "window-a",
    );
    expect(updatedA.activeViewId).toBe(viewBId);
    expect(updatedA.views.find((view) => view.viewId === viewAId)).toMatchObject({
      mode: "backlog",
      quickFilterIds: [7],
    });
    handlers.stopJiraWorkspaceViewSync();
    await new Promise((resolve) => setTimeout(resolve, 0));
    cache.close();

    const reopened = createJiraCache(dbPath);
    expect(reopened.getActiveView("profile-a", "jira-workspace-a")).toBe(viewBId);
    reopened.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("drops sprint selection from backlog mode in new and legacy saved views", async () => {
    const { state, context } = setup();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-jira-view-sprint-mode-"));
    const cache = createJiraCache(path.join(root, "jira.sqlite"));
    context.jiraCache = cache;
    state.workspaces.push({
      id: "jira-workspace-a",
      kind: "jira",
      profileId: "profile-a",
    } as AppState["workspaces"][number]);
    context.jiraManager = {
      boardView: vi.fn(async () => ({ boardId: 42, issues: [], hasMore: false, truncated: false })),
    };
    const handlers = createJiraHandlers(context);
    const saved = await handlers.saveJiraWorkspaceView(
      {
        workspaceId: "jira-workspace-a",
        view: { kind: "board", connectionId: "same-host-a", boardId: 42, mode: "backlog", sprintId: 51 },
      },
      "window-a",
    );
    const view = saved.views.find((item) => item.kind === "board");
    if (!view || view.kind !== "board") throw new Error("Expected the backlog board view.");
    expect(view).toMatchObject({ mode: "backlog", sprintId: null });
    expect(context.jiraManager?.boardView).toHaveBeenCalledWith(
      expect.objectContaining({ id: "same-host-a" }),
      42,
      "backlog",
      undefined,
      undefined,
      expect.objectContaining({ forceRefresh: false }),
    );

    cache.saveView({
      profileId: "profile-a",
      workspaceId: "jira-workspace-a",
      viewId: view.viewId,
      value: { ...view, sprintId: 51 },
      active: false,
    });
    const loaded = await handlers.getJiraWorkspaceViews({ workspaceId: "jira-workspace-a" }, "window-a");
    expect(loaded.views.find((item) => item.viewId === view.viewId)).toMatchObject({ mode: "backlog", sprintId: null });
    expect(cache.listSavedViews("profile-a", "jira-workspace-a")[0]?.value).toMatchObject({ sprintId: null });
    expect(cache.getActiveView("profile-a", "jira-workspace-a")).toBe(view.viewId);
    handlers.stopJiraWorkspaceViewSync();
    cache.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("does not re-read views that were synced minutes ago when workspace views are reloaded, but refresh still reads", async () => {
    const { state, context } = setup();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-jira-view-fresh-"));
    const cache = createJiraCache(path.join(root, "jira.sqlite"));
    context.jiraCache = cache;
    state.workspaces.push({
      id: "jira-workspace-a",
      kind: "jira",
      profileId: "profile-a",
    } as AppState["workspaces"][number]);
    const boardView = vi.fn(async () => ({ boardId: 42, issues: [], hasMore: false, truncated: false }));
    context.jiraManager = { boardView };
    const handlers = createJiraHandlers(context);
    const saved = await handlers.saveJiraWorkspaceView(
      { workspaceId: "jira-workspace-a", view: { kind: "board", connectionId: "same-host-a", boardId: 42 } },
      "window-a",
    );
    const viewId = saved.views.find((view) => view.kind === "board")!.viewId;
    const syncState = () => handlers.getJiraWorkspaceViewsSnapshot()["jira-workspace-a"]?.syncByViewId[viewId]?.state;
    await vi.waitFor(() => expect(syncState()).toBe("idle"));
    const initialReads = boardView.mock.calls.length;

    await handlers.getJiraWorkspaceViews({ workspaceId: "jira-workspace-a" }, "window-a");
    await handlers.getJiraWorkspaceViews({ workspaceId: "jira-workspace-a" }, "window-a");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(boardView).toHaveBeenCalledTimes(initialReads);

    await handlers.refreshJiraWorkspaceViews({ workspaceId: "jira-workspace-a", viewId }, "window-a");
    await vi.waitFor(() => expect(boardView.mock.calls.length).toBeGreaterThan(initialReads));
    handlers.stopJiraWorkspaceViewSync();
    cache.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("uses warm SQLite snapshots, reports refresh failures, and recovers on the next refresh", async () => {
    const { state, context } = setup();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-jira-view-warm-"));
    const cache = createJiraCache(path.join(root, "jira.sqlite"));
    context.jiraCache = cache;
    state.workspaces.push({
      id: "jira-workspace-a",
      kind: "jira",
      profileId: "profile-a",
    } as AppState["workspaces"][number]);
    const manager = new JiraManager(context.credentialStore, context.fetchImpl, cache);
    context.jiraManager = manager;
    const handlers = createJiraHandlers(context);
    const saved = await handlers.saveJiraWorkspaceView(
      { workspaceId: "jira-workspace-a", view: { kind: "board", connectionId: "same-host-a", boardId: 42 } },
      "window-a",
    );
    const viewId = saved.views.find((view) => view.kind === "board")!.viewId;
    await vi.waitFor(() => {
      expect(handlers.getJiraWorkspaceViewsSnapshot()["jira-workspace-a"]?.syncByViewId[viewId]?.state).toBe("idle");
    });
    const warmFetchCount = context.fetchImpl.mock.calls.length;

    await handlers.getJiraWorkspaceViews({ workspaceId: "jira-workspace-a" }, "window-a");
    await handlers.setJiraWorkspaceActiveView({ workspaceId: "jira-workspace-a", viewId }, "window-a");
    await vi.waitFor(() => {
      expect(handlers.getJiraWorkspaceViewsSnapshot()["jira-workspace-a"]?.syncByViewId[viewId]?.state).toBe("idle");
    });
    expect(context.fetchImpl).toHaveBeenCalledTimes(warmFetchCount);

    const lastSuccessfulSync =
      handlers.getJiraWorkspaceViewsSnapshot()["jira-workspace-a"]?.syncByViewId[viewId]?.syncedAt;
    context.fetchImpl.mockImplementation(
      async () => new Response(JSON.stringify({ error: "fixture unavailable" }), { status: 503 }),
    );
    await handlers.refreshJiraWorkspaceViews({ workspaceId: "jira-workspace-a", viewId }, "window-a");
    await vi.waitFor(() => expect(context.fetchImpl.mock.calls.length).toBeGreaterThan(warmFetchCount));
    await vi.waitFor(() => {
      expect(handlers.getJiraWorkspaceViewsSnapshot()["jira-workspace-a"]?.syncByViewId[viewId]?.state).toBe("error");
    });
    expect(handlers.getJiraWorkspaceViewsSnapshot()["jira-workspace-a"]?.syncByViewId[viewId]?.syncedAt).toBe(
      lastSuccessfulSync,
    );
    expect(handlers.getJiraWorkspaceViewsSnapshot()["jira-workspace-a"]?.activeViewId).toBe(viewId);
    const failureFetchCount = context.fetchImpl.mock.calls.length;
    await handlers.setJiraWorkspaceActiveView({ workspaceId: "jira-workspace-a", viewId }, "window-a");
    await vi.waitFor(() => expect(context.fetchImpl.mock.calls.length).toBeGreaterThan(failureFetchCount));
    await vi.waitFor(() => {
      expect(handlers.getJiraWorkspaceViewsSnapshot()["jira-workspace-a"]?.syncByViewId[viewId]?.state).toBe("error");
    });
    const cachedBoard = await manager.boardView(
      state.settings.integrations.jira.connections[0]!,
      42,
      "issues",
      undefined,
      undefined,
      { cacheOnly: true },
    );
    expect(cachedBoard?.cache.source).toBe("cache");

    context.fetchImpl.mockImplementation(
      async () => new Response(JSON.stringify({ issues: [], values: [], total: 0, isLast: true })),
    );
    await handlers.refreshJiraWorkspaceViews({ workspaceId: "jira-workspace-a", viewId }, "window-a");
    await vi.waitFor(() => {
      expect(handlers.getJiraWorkspaceViewsSnapshot()["jira-workspace-a"]?.syncByViewId[viewId]?.state).toBe("idle");
    });
    handlers.stopJiraWorkspaceViewSync();
    cache.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("ensures one Jira inbox workspace per explicitly scoped profile", async () => {
    const { handlers, state } = setup();

    const first = await handlers.jiraRemoteEnsureWorkspace("profile-a");
    const repeated = await handlers.jiraRemoteEnsureWorkspace("profile-a");
    const otherProfile = await handlers.jiraRemoteEnsureWorkspace("profile-b");

    expect(first).toMatchObject({ kind: "jira", profileId: "profile-a", name: "Jira", panels: [] });
    expect(repeated.id).toBe(first.id);
    expect(otherProfile.profileId).toBe("profile-b");
    expect(state.workspaces).toHaveLength(2);
    expect(state.workspaces.map((workspace) => workspace.profileId)).toEqual(["profile-a", "profile-b"]);
  });

  it("passes cache options through profile-checked board/detail and lookup routes", async () => {
    const { context, state } = setup();
    const issueResult = {
      ref: { provider: "jira", connectionId: "same-host-a", issueId: "7", issueKey: "OPS-7" },
      summary: "Cached",
      status: "Open",
      issueType: "Task",
      projectKey: "OPS",
      updated: "",
      url: "https://jira.example.com/browse/OPS-7",
      cache: { source: "cache", fetchedAt: 10, stale: true },
    };
    const boardResult = {
      boardId: 4,
      mode: "issues",
      issues: [],
      hasMore: false,
      truncated: false,
      capabilities: {
        configuration: "available",
        quickFilters: "available",
        issues: "available",
        backlog: "available",
        sprints: "available",
      },
      cache: { source: "cache", fetchedAt: 10, stale: true },
    };
    const jiraManager = {
      issue: vi.fn(async () => issueResult),
      boardView: vi.fn(async () => boardResult),
      boardQuickFilters: vi.fn(async () => ({
        filters: [],
        hasMore: false,
        truncated: false,
        capability: "available",
        cache: { source: "cache", fetchedAt: 10, stale: true },
      })),
      searchUsers: vi.fn(async () => [{ kind: "data-center", name: "alice", displayName: "Alice" }]),
    };
    Object.assign(context, { jiraManager });
    const handlers = createJiraHandlers(context);
    await expect(
      handlers.jiraGetIssue({ connectionId: "same-host-a", issueId: "7", cacheOnly: true }, "window-a"),
    ).resolves.toMatchObject({ cache: { stale: true } });
    await expect(
      handlers.jiraGetBoardView(
        {
          connectionId: "same-host-a",
          boardId: 4,
          quickFilterIds: [9],
          assignee: { kind: "unassigned" },
          forceRefresh: true,
        },
        "window-a",
      ),
    ).resolves.toMatchObject({ cache: { stale: true } });
    await expect(
      handlers.jiraListBoardQuickFilters({ connectionId: "same-host-a", boardId: 4, cacheOnly: true }, "window-a"),
    ).resolves.toMatchObject({ cache: { stale: true } });
    await expect(
      handlers.jiraSearchUsers({ connectionId: "same-host-a", query: "ali" }, "window-a"),
    ).resolves.toHaveLength(1);
    expect(jiraManager.issue).toHaveBeenCalledWith(state.settings.integrations.jira.connections[0], "7", {
      cacheOnly: true,
      forceRefresh: undefined,
    });
    expect(jiraManager.boardView).toHaveBeenCalledWith(
      state.settings.integrations.jira.connections[0],
      4,
      undefined,
      undefined,
      undefined,
      { quickFilterIds: [9], assignee: { kind: "unassigned" }, cacheOnly: undefined, forceRefresh: true },
    );
    await expect(handlers.jiraGetIssue({ connectionId: "same-host-b", issueId: "7" }, "window-a")).rejects.toThrow(
      /another profile/,
    );
  });

  it("searches Jira boards on the owning profile and returns a paged result", async () => {
    const { handlers, fetchImpl } = setup();
    fetchImpl.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({ startAt: 0, total: 2, values: [{ id: 31, name: "Platform board", type: "kanban" }] }),
        ),
    );

    await expect(
      handlers.jiraSearchBoards({ connectionId: "same-host-a", query: "Platform", limit: 1 }, "window-a"),
    ).resolves.toEqual({
      boards: [{ id: 31, name: "Platform board", type: "kanban" }],
      hasMore: true,
      nextCursor: "1",
      truncated: true,
    });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      "https://jira.example.com/jira/rest/agile/1.0/board?startAt=0&maxResults=1&name=Platform",
    );
    expect(new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe("Bearer token-a");

    await handlers.jiraRemoteSearchBoards(
      { connectionId: "same-host-b", query: "Platform", cursor: "1", limit: 1 },
      "profile-b",
    );
    expect(new Headers(fetchImpl.mock.calls[1]?.[1]?.headers).get("Authorization")).toBe("Bearer token-b");
  });

  it("persists APIM certificate metadata through the real store and reload before saved-row verification", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "jira-apim-store-roundtrip-"));
    try {
      const statePath = path.join(tempDir, "strideterm-state.json");
      const store = await createStore(statePath);
      const initial = structuredClone(store.getState());
      initial.settings.integrations.jira.connections = [
        {
          id: "jira-apim-roundtrip",
          profileId: "profile-a",
          label: "Gateway Jira",
          enabled: true,
          deployment: "data-center",
          webUrl: "https://jira.example.com",
          apiBaseUrl: "https://jira.example.com/jira",
          auth: { kind: "dc-pat", secretRef: "jira:roundtrip:old-pat" },
          accountPurpose: "personal",
        },
      ];
      await store.replace(initial);
      const secrets = new Map<string, string>([["jira:roundtrip:old-pat", "old-token"]]);
      const credentialStore = {
        isEncryptionAvailable: () => true,
        getSecret: (ref: string) => secrets.get(ref) || "",
        setSecret: vi.fn(async (ref: string, value: string) => {
          secrets.set(ref, value);
        }),
        deleteSecret: vi.fn(async (ref: string) => {
          secrets.delete(ref);
        }),
      };
      const fetchImpl = vi.fn(
        async (_input: RequestInfo | URL, _init?: RequestInit) =>
          new Response(JSON.stringify({ name: "api-user", displayName: "API user" })),
      );
      const log = {
        info: vi.fn((_event: string, _fields?: Record<string, unknown>) => undefined),
        warn: vi.fn((_event: string, _fields?: Record<string, unknown>) => undefined),
      };
      const context = {
        credentialStore,
        store,
        fetchImpl,
        getState: () => store.getState(),
        getViewerProfileId: (windowId: string) => (windowId === "window-a" ? "profile-a" : null),
        log,
        jiraLog: log,
      };
      const handlers = createJiraHandlers(context);
      const existing = store.getState().settings.integrations.jira.connections[0]!;
      const pfxPath = fileURLToPath(new URL("./__fixtures__/jira-test-client.pfx", import.meta.url));
      const key = "roundtrip-gateway-key";
      const password = "test-only-passphrase";

      await handlers.jiraSaveConnection(
        {
          id: existing.id,
          label: "Gateway Jira",
          deployment: "data-center",
          authMode: "apim",
          webUrl: existing.webUrl,
          apiBaseUrl: "https://gateway.example.com/it/operation/jira-5/v1",
          subscriptionKey: key,
          subscriptionHeaderName: "Ocp-Apim-Subscription-Key",
          clientCertificatePath: pfxPath,
          clientCertificatePassword: password,
        },
        "window-a",
      );

      const reloadedStore = await createStore(statePath);
      const saved = reloadedStore
        .getState()
        .settings.integrations.jira.connections.find((item) => item.id === existing.id)!;
      expect(saved.clientCertificatePath).toBe(pfxPath);
      expect(saved.subscriptionHeaderName).toBe("Ocp-Apim-Subscription-Key");
      expect(saved.auth.kind).toBe("dc-apim");
      expect(saved.auth.secretRef).toBeTruthy();
      expect(saved.auth.passphraseRef).toBeTruthy();
      expect(secrets.get(saved.auth.secretRef!)).toBe(key);
      expect(secrets.get(saved.auth.passphraseRef!)).toBe(password);

      const reloadedHandlers = createJiraHandlers({
        ...context,
        store: reloadedStore,
        getState: () => reloadedStore.getState(),
      });
      const result = await reloadedHandlers.jiraVerifyConnection(existing.id, "window-a");
      expect(result).toMatchObject({ ok: true });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      for (const [, init] of fetchImpl.mock.calls) {
        const request = init as RequestInit & { dispatcher?: unknown };
        expect(new Headers(request.headers).get("Ocp-Apim-Subscription-Key")).toBe(key);
        expect(request.dispatcher).toBeDefined();
      }
      const saveStages = log.info.mock.calls
        .map(([event, fields]) => ({
          event,
          operation: fields?.operation,
          stage: fields?.stage,
        }))
        .filter((entry) => entry.operation === "save")
        .map((entry) => entry.stage);
      expect(saveStages).toEqual([
        "save-start",
        "certificate-read-started",
        "certificate-read-complete",
        "certificate-parse-complete",
        "candidate-credentials-stored",
        "candidate-verification-started",
        "candidate-verification-complete",
        "permanent-credentials-stored",
        "persistence-readback",
        "save-complete",
      ]);
      const persistenceReadback = log.info.mock.calls.find(
        ([, fields]) =>
          (fields as Record<string, unknown>)?.operation === "save" &&
          (fields as Record<string, unknown>)?.stage === "persistence-readback",
      );
      expect(persistenceReadback?.[1]).toMatchObject({
        source: "persisted",
        window: expect.stringMatching(/^[0-9a-f]{8}$/),
        gatewayKeyPresent: true,
        clientCertificatePresent: true,
        certificatePasswordPresent: true,
        persistedConnectionFound: true,
        persistedAuthModeMatchesCandidate: true,
        persistedKeyMatchesCandidate: true,
        persistedPasswordMatchesCandidate: true,
        persistedCertificatePathMatchesCandidate: true,
        persistedHeaderMatchesCandidate: true,
        persistedApiBaseUrlMatchesCandidate: true,
        outcome: "readback-consistent",
      });
      const savedVerifyStart = log.info.mock.calls.find(
        ([, fields]) => (fields as Record<string, unknown>)?.operation === "saved-verify",
      );
      expect(savedVerifyStart?.[1]).toMatchObject({
        source: "persisted",
        connectionId: existing.id,
        profileId: "profile-a",
        window: expect.stringMatching(/^[0-9a-f]{8}$/),
        authMode: "apim",
        gatewayKeyPresent: true,
        clientCertificatePresent: true,
        certificatePasswordPresent: true,
      });
      const diagnostics = JSON.stringify([...log.info.mock.calls, ...log.warn.mock.calls]);
      for (const sensitive of [key, password, pfxPath, "gateway.example.com"])
        expect(diagnostics).not.toContain(sensitive);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("tests APIM credentials without mutating state or leaving temporary refs", async () => {
    const { handlers, state, secrets, fetchImpl, context, credentialStore, log } = setup();
    const before = structuredClone(state.settings.integrations.jira.connections);
    const mutate = vi.spyOn(context.store, "mutate");
    const pfxPath = fileURLToPath(new URL("./__fixtures__/jira-test-client.pfx", import.meta.url));
    fetchImpl.mockImplementationOnce(
      async () => new Response(JSON.stringify({ name: "api-user", displayName: "API user" })),
    );

    const result = await handlers.jiraTestConnection(
      {
        label: "Gateway Jira",
        deployment: "data-center",
        authMode: "apim",
        webUrl: "https://jira.example.com",
        apiBaseUrl: "https://gateway.example.com/it/operation/jira-5/v1",
        subscriptionKey: "temporary-test-key",
        subscriptionHeaderName: "Ocp-Apim-Subscription-Key",
        clientCertificatePath: pfxPath,
        clientCertificatePassword: "test-only-passphrase",
      },
      "window-a",
    );

    expect(result).toMatchObject({ ok: true, identity: { displayName: "API user" } });
    expect(mutate).not.toHaveBeenCalled();
    expect(state.settings.integrations.jira.connections).toEqual(before);
    expect([...secrets.keys()].some((ref) => /test-(key|pass|pat)/.test(ref))).toBe(false);
    expect(
      credentialStore.setSecret.mock.calls.every(([, , options]) => options?.requireEncryptedStorage === true),
    ).toBe(true);
    const diagnosticCalls = JSON.stringify([...log.info.mock.calls, ...log.warn.mock.calls]);
    expect(diagnosticCalls).not.toContain("temporary-test-key");
    expect(diagnosticCalls).not.toContain("test-only-passphrase");
    expect(diagnosticCalls).not.toContain(pfxPath);
  });

  it("reports invalid PFX locally, makes no network request, and leaves saved secrets unchanged", async () => {
    const { handlers, state, secrets, fetchImpl, context, credentialStore } = setup();
    const existing = state.settings.integrations.jira.connections[0]!;
    existing.auth = { kind: "dc-apim", secretRef: "jira:a:apim-key", passphraseRef: "jira:a:apim-passphrase" };
    const savedKey = "saved-gateway-key";
    const savedPass = "saved-certificate-password";
    secrets.set(existing.auth.secretRef!, savedKey);
    secrets.set(existing.auth.passphraseRef!, savedPass);
    const mutate = vi.spyOn(context.store, "mutate");
    const pfxPath = fileURLToPath(new URL("./__fixtures__/jira-test-client.pfx", import.meta.url));

    const result = await handlers.jiraTestConnection(
      {
        id: existing.id,
        label: existing.label,
        deployment: "data-center",
        authMode: "apim",
        webUrl: existing.webUrl,
        apiBaseUrl: existing.apiBaseUrl,
        clientCertificatePath: pfxPath,
        clientCertificatePassword: "incorrect-test-password",
      },
      "window-a",
    );

    expect(result).toMatchObject({ ok: false, error: { message: expect.stringContaining("password is correct") } });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
    expect(secrets.get(existing.auth.secretRef!)).toBe(savedKey);
    expect(secrets.get(existing.auth.passphraseRef!)).toBe(savedPass);
    expect([...secrets.keys()].some((ref) => /test-(key|pass|pat)/.test(ref))).toBe(false);
    expect(credentialStore.setSecret.mock.calls).toHaveLength(0);
  });

  it("tests an existing PAT without asking for or replacing its stored token", async () => {
    const { handlers, state, secrets, fetchImpl, context } = setup();
    const existing = state.settings.integrations.jira.connections[0]!;
    const mutate = vi.spyOn(context.store, "mutate");
    fetchImpl.mockImplementationOnce(
      async () => new Response(JSON.stringify({ name: "jira-user", displayName: "Jira User" })),
    );

    const result = await handlers.jiraTestConnection(
      {
        id: existing.id,
        label: existing.label,
        deployment: "data-center",
        webUrl: existing.webUrl,
        apiBaseUrl: existing.apiBaseUrl,
      },
      "window-a",
    );

    expect(result).toMatchObject({ ok: true });
    expect(mutate).not.toHaveBeenCalled();
    expect(secrets.get("jira:a:pat")).toBe("token-a");
    expect([...secrets.keys()].some((ref) => ref.includes("test-pat"))).toBe(false);
  });

  it("rejects a cross-profile test before reading credentials or making a request", async () => {
    const { handlers, fetchImpl, credentialStore } = setup();
    await expect(
      handlers.jiraTestConnection(
        {
          id: "same-host-b",
          label: "B",
          deployment: "data-center",
          webUrl: "https://jira.example.com",
          apiBaseUrl: "https://jira.example.com/jira",
          pat: "should-not-be-stored",
        },
        "window-a",
      ),
    ).rejects.toThrow("another profile");
    expect(credentialStore.setSecret).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("cleans temporary credentials after a Jira HTTP verification failure", async () => {
    const { handlers, secrets, fetchImpl, credentialStore, context } = setup();
    const mutate = vi.spyOn(context.store, "mutate");
    fetchImpl.mockImplementationOnce(async () => new Response("", { status: 403 }));

    const result = await handlers.jiraTestConnection(
      {
        label: "New Jira",
        deployment: "data-center",
        webUrl: "https://jira.example.com",
        apiBaseUrl: "https://jira.example.com/rest/api",
        pat: "temporary-pat",
      },
      "window-a",
    );

    expect(result).toMatchObject({ ok: false, error: { code: "permission-denied" } });
    expect(mutate).not.toHaveBeenCalled();
    expect([...secrets.keys()].some((ref) => ref.includes("test-pat"))).toBe(false);
    expect([...secrets.values()]).not.toContain("temporary-pat");
    expect(credentialStore.deleteSecret).toHaveBeenCalled();
  });

  it("stores APIM key and certificate password as encrypted secret refs and deletes them on disconnect", async () => {
    const { handlers, state, secrets, fetchImpl } = setup();
    fetchImpl.mockImplementationOnce(
      async () => new Response(JSON.stringify({ name: "api-user", displayName: "API user" })),
    );
    const result = await handlers.jiraSaveConnection(
      {
        label: "Gateway Jira",
        deployment: "data-center",
        authMode: "apim",
        webUrl: "https://jira.example.com",
        apiBaseUrl: "https://gateway.example.com/it/operation/jira-5/v1",
        subscriptionKey: "apim-test-key",
        subscriptionHeaderName: "Ocp-Apim-Subscription-Key",
        clientCertificatePath: fileURLToPath(new URL("./__fixtures__/jira-test-client.pfx", import.meta.url)),
        clientCertificatePassword: "test-only-passphrase",
      },
      "window-a",
    );
    const connection = state.settings.integrations.jira.connections.find((item) => item.auth.kind === "dc-apim")!;
    expect(connection.auth.secretRef).toMatch(/:apim-key$/);
    expect(connection.auth.passphraseRef).toMatch(/:apim-passphrase$/);
    expect(secrets.get(connection.auth.secretRef!)).toBe("apim-test-key");
    expect(secrets.get(connection.auth.passphraseRef!)).toBe("test-only-passphrase");
    expect(JSON.stringify(result)).not.toContain("apim-test-key");
    expect(JSON.stringify(result)).not.toContain("test-only-passphrase");
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      "https://gateway.example.com/it/operation/jira-5/v1/rest/api/latest/myself",
    );
    const listed = await handlers.jiraListConnections("window-a");
    expect(JSON.stringify(listed)).not.toContain("apim-key");
    expect(JSON.stringify(listed)).not.toContain("apim-passphrase");

    await handlers.jiraDeleteConnection(connection.id, "window-a");
    expect(secrets.has(connection.auth.secretRef!)).toBe(false);
    expect(secrets.has(connection.auth.passphraseRef!)).toBe(false);
  });

  it("restores previously working APIM secrets when connection persistence fails", async () => {
    const { handlers, state, secrets, fetchImpl, context } = setup();
    const pfxPath = fileURLToPath(new URL("./__fixtures__/jira-test-client.pfx", import.meta.url));
    const replacementPfxPath = fileURLToPath(
      new URL("./__fixtures__/jira-test-client-replacement.pfx", import.meta.url),
    );
    const existing = state.settings.integrations.jira.connections[0]!;
    existing.apiBaseUrl = "https://gateway.example.com/prefix";
    existing.clientCertificatePath = pfxPath;
    existing.auth = { kind: "dc-apim", secretRef: "jira:a:apim-key", passphraseRef: "jira:a:apim-passphrase" };
    secrets.set("jira:a:apim-key", "previous-key");
    secrets.set("jira:a:apim-passphrase", "test-only-passphrase");
    fetchImpl.mockImplementationOnce(
      async () => new Response(JSON.stringify({ name: "api-user", displayName: "API user" })),
    );
    vi.spyOn(context.store, "mutate").mockRejectedValueOnce(new Error("state write failed"));

    await expect(
      handlers.jiraSaveConnection(
        {
          id: existing.id,
          label: existing.label,
          deployment: "data-center",
          authMode: "apim",
          webUrl: existing.webUrl,
          apiBaseUrl: existing.apiBaseUrl,
          subscriptionKey: "replacement-key",
          clientCertificatePath: replacementPfxPath,
          clientCertificatePassword: "replacement-test-passphrase",
        },
        "window-a",
      ),
    ).rejects.toThrow("state write failed");
    expect(secrets.get("jira:a:apim-key")).toBe("previous-key");
    expect(secrets.get("jira:a:apim-passphrase")).toBe("test-only-passphrase");
    expect([...secrets.keys()].some((ref) => ref.includes("verify-key") || ref.includes("verify-pass"))).toBe(false);
    expect(existing.auth.secretRef).toBe("jira:a:apim-key");
  });

  it("uses newly persisted APIM key and certificate for requests after a successful edit", async () => {
    const { handlers, state, secrets, fetchImpl } = setup();
    const existing = state.settings.integrations.jira.connections[0]!;
    const oldKeyRef = "jira:a:old-apim-key";
    const oldPassRef = "jira:a:old-apim-passphrase";
    const pfxPath = fileURLToPath(new URL("./__fixtures__/jira-test-client.pfx", import.meta.url));
    secrets.set(oldKeyRef, "old-gateway-key");
    secrets.set(oldPassRef, "old-test-passphrase");
    existing.apiBaseUrl = "https://gateway.example.com/it/operation/jira-5/v1";
    existing.clientCertificatePath = pfxPath;
    existing.auth = { kind: "dc-apim", secretRef: oldKeyRef, passphraseRef: oldPassRef };
    fetchImpl
      .mockImplementationOnce(async () => new Response(JSON.stringify({ name: "api-user", displayName: "API user" })))
      .mockImplementationOnce(async () => new Response("", { status: 403 }));

    await handlers.jiraSaveConnection(
      {
        id: existing.id,
        label: "Updated Jira",
        deployment: "data-center",
        authMode: "apim",
        webUrl: existing.webUrl,
        apiBaseUrl: existing.apiBaseUrl,
        subscriptionKey: "new-gateway-key",
        subscriptionHeaderName: "Ocp-Apim-Subscription-Key",
        clientCertificatePath: pfxPath,
        clientCertificatePassword: "test-only-passphrase",
      },
      "window-a",
    );

    const saved = state.settings.integrations.jira.connections.find((item) => item.id === existing.id)!;
    expect(saved.auth).toMatchObject({ kind: "dc-apim", secretRef: `jira:${existing.id}:apim-key` });
    expect(saved.auth.passphraseRef).toBe(`jira:${existing.id}:apim-passphrase`);
    expect(secrets.get(saved.auth.secretRef!)).toBe("new-gateway-key");
    expect(secrets.get(saved.auth.passphraseRef!)).toBe("test-only-passphrase");
    expect(secrets.has(oldKeyRef)).toBe(false);
    expect(secrets.has(oldPassRef)).toBe(false);

    await expect(handlers.jiraListBoards(existing.id, "window-a")).rejects.toMatchObject({
      code: "permission-denied",
      message: "Jira denied access to board data.",
    });
    const [verifyCall, boardsCall] = fetchImpl.mock.calls;
    expect(String(verifyCall?.[0])).toBe("https://gateway.example.com/it/operation/jira-5/v1/rest/api/latest/myself");
    expect(String(boardsCall?.[0])).toBe(
      "https://gateway.example.com/it/operation/jira-5/v1/rest/agile/1.0/board?startAt=0&maxResults=50",
    );
    for (const call of [verifyCall, boardsCall]) {
      const init = call?.[1] as RequestInit & { dispatcher?: unknown };
      expect(new Headers(init.headers).get("Ocp-Apim-Subscription-Key")).toBe("new-gateway-key");
      expect(init.dispatcher).toBeDefined();
    }
  });

  it("uses newly persisted APIM refs in the saved-row verify handler", async () => {
    const { handlers, state, secrets, fetchImpl, log } = setup();
    const existing = state.settings.integrations.jira.connections[0]!;
    const oldKeyRef = "jira:a:old-card-key";
    const oldPassRef = "jira:a:old-card-passphrase";
    const pfxPath = fileURLToPath(new URL("./__fixtures__/jira-test-client.pfx", import.meta.url));
    secrets.set(oldKeyRef, "old-card-key");
    secrets.set(oldPassRef, "old-card-passphrase");
    existing.apiBaseUrl = "https://gateway.example.com/it/operation/jira-5/v1";
    existing.clientCertificatePath = pfxPath;
    existing.auth = { kind: "dc-apim", secretRef: oldKeyRef, passphraseRef: oldPassRef };
    fetchImpl
      .mockImplementationOnce(async () => new Response(JSON.stringify({ name: "api-user", displayName: "API user" })))
      .mockImplementationOnce(async () => new Response("", { status: 403 }));

    await handlers.jiraSaveConnection(
      {
        id: existing.id,
        label: "Updated Jira",
        deployment: "data-center",
        authMode: "apim",
        webUrl: existing.webUrl,
        apiBaseUrl: existing.apiBaseUrl,
        subscriptionKey: "  new-card-key  ",
        subscriptionHeaderName: " Ocp-Apim-Subscription-Key ",
        clientCertificatePath: pfxPath,
        clientCertificatePassword: "test-only-passphrase",
      },
      "window-a",
    );

    const result = await handlers.jiraVerifyConnection(existing.id, "window-a");
    expect(result).toMatchObject({ ok: false, error: { code: "permission-denied" } });
    expect(state.settings.integrations.jira.connections.find((item) => item.id === existing.id)?.health).toMatchObject({
      state: "permission-denied",
    });
    const [saveVerifyCall, savedVerifyCall] = fetchImpl.mock.calls;
    expect(String(saveVerifyCall?.[0])).toBe(
      "https://gateway.example.com/it/operation/jira-5/v1/rest/api/latest/myself",
    );
    expect(String(savedVerifyCall?.[0])).toBe(
      "https://gateway.example.com/it/operation/jira-5/v1/rest/api/latest/myself",
    );
    for (const call of [saveVerifyCall, savedVerifyCall]) {
      const init = call?.[1] as RequestInit & { dispatcher?: unknown };
      expect(new Headers(init.headers).get("Ocp-Apim-Subscription-Key")).toBe("new-card-key");
      expect(init.dispatcher).toBeDefined();
    }
    const failedVerify = log.warn.mock.calls.find(
      ([event, fields]) =>
        event === "jira connection verification failed" &&
        (fields as Record<string, unknown>)?.operation === "saved-verify",
    );
    expect(failedVerify?.[1]).toMatchObject({
      operation: "saved-verify",
      connectionId: existing.id,
      profileId: "profile-a",
      authMode: "apim",
      stage: "verification_http",
      routeFamily: "jira-rest-api",
      endpoint: "/rest/api/latest/myself",
      resource: "myself",
      method: "GET",
      outcome: "failed",
      code: "permission-denied",
      statusCode: 403,
    });
    expect(failedVerify?.[1]).toHaveProperty("requestId", expect.any(String));
    const diagnosticCalls = JSON.stringify([...log.info.mock.calls, ...log.warn.mock.calls]);
    for (const sensitive of ["new-card-key", "test-only-passphrase", pfxPath, "gateway.example.com"])
      expect(diagnosticCalls).not.toContain(sensitive);
  });

  it("marks a connection whose saved credential is missing as needing sign-in, like an expired one", async () => {
    const { handlers, state, secrets } = setup();
    const existing = state.settings.integrations.jira.connections[0]!;
    secrets.delete(existing.auth.secretRef!);

    const result = await handlers.jiraVerifyConnection(existing.id, "window-a");

    expect(result).toMatchObject({ ok: false, error: { code: "credential-missing" } });
    const stored = state.settings.integrations.jira.connections.find((item) => item.id === existing.id);
    expect(stored).toMatchObject({ status: "needs-login", health: { state: "credential-missing" } });
  });

  it("reports a passworded saved APIM connection with a lost certificate path before HTTP", async () => {
    const { handlers, state, secrets, fetchImpl, log } = setup();
    const existing = state.settings.integrations.jira.connections[0]!;
    existing.apiBaseUrl = "https://gateway.example.com/it/operation/jira-5/v1";
    existing.auth = { kind: "dc-apim", secretRef: "jira:a:apim-key", passphraseRef: "jira:a:apim-passphrase" };
    secrets.set(existing.auth.secretRef!, "saved-test-key");
    secrets.set(existing.auth.passphraseRef!, "saved-test-password");

    const result = await handlers.jiraVerifyConnection(existing.id, "window-a");

    expect(result).toMatchObject({
      ok: false,
      health: { state: "configuration-incomplete" },
      error: {
        code: "configuration-incomplete",
        message: expect.stringContaining("saved client certificate file is missing"),
      },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    const failedVerify = log.warn.mock.calls.find(
      ([event, fields]) =>
        event === "jira connection verification failed" &&
        (fields as Record<string, unknown>)?.operation === "saved-verify",
    );
    expect(failedVerify?.[1]).toMatchObject({
      source: "persisted",
      window: expect.stringMatching(/^[0-9a-f]{8}$/),
      gatewayKeyPresent: true,
      clientCertificatePresent: false,
      certificatePasswordPresent: true,
      code: "configuration-incomplete",
    });
    const diagnostics = JSON.stringify([...log.info.mock.calls, ...log.warn.mock.calls]);
    expect(diagnostics).not.toContain("saved-test-key");
    expect(diagnostics).not.toContain("saved-test-password");
    expect(diagnostics).not.toContain("gateway.example.com");
  });

  it("lists only the caller window's profile even when both profiles use the same host", async () => {
    const { handlers } = setup();
    await expect(handlers.jiraListConnections("window-a")).resolves.toMatchObject([{ id: "same-host-a" }]);
    await expect(handlers.jiraListConnections("window-b")).resolves.toMatchObject([{ id: "same-host-b" }]);
  });

  it("rejects cross-profile issue access before making a Jira request", async () => {
    const { handlers, fetchImpl } = setup();
    await expect(handlers.jiraSearchIssues({ connectionId: "same-host-b", jql: "" }, "window-a")).rejects.toThrow(
      "another profile",
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects another profile's connection id before replacing its credential", async () => {
    const { handlers, secrets, credentialStore } = setup();
    await expect(
      handlers.jiraSaveConnection(
        {
          id: "same-host-b",
          label: "hijack",
          deployment: "data-center",
          webUrl: "https://jira.example.com",
          apiBaseUrl: "https://jira.example.com/jira",
          pat: "attacker",
        },
        "window-a",
      ),
    ).rejects.toThrow("another profile");
    expect(credentialStore.setSecret).not.toHaveBeenCalled();
    expect(secrets.get("jira:b:pat")).toBe("token-b");
  });

  it("fails closed when a caller window cannot be resolved", async () => {
    const { handlers } = setup();
    await expect(handlers.jiraListConnections("")).rejects.toThrow("trusted desktop window context");
  });

  it("saves Jira routing prefixes only on the selected profile connection", async () => {
    const { handlers, state } = setup();
    await handlers.jiraUpdateConnectionMetadata(
      {
        connectionId: "same-host-a",
        label: "Alpha",
        accountPurpose: "personal",
        issueKeyPrefixes: ["ops", "APP"],
        defaultJql: "project = OPS",
        projectKeys: ["ops"],
        pollSeconds: 300,
      },
      "window-a",
    );
    expect(
      state.settings.integrations.jira.connections.find((item) => item.id === "same-host-a")?.issueKeyPrefixes,
    ).toEqual(["OPS", "APP"]);
    expect(state.settings.integrations.jira.connections.find((item) => item.id === "same-host-a")).toMatchObject({
      defaultJql: "project = OPS",
      projectKeys: ["OPS"],
      pollSeconds: 300,
    });
    expect(
      state.settings.integrations.jira.connections.find((item) => item.id === "same-host-b")?.issueKeyPrefixes,
    ).toBeUndefined();
  });

  it("returns remembered repository targets only for the selected Jira connection profile", async () => {
    const { handlers, state } = setup();
    state.settings.integrations.jira.repoBindings = [
      {
        profileId: "profile-a",
        jiraConnectionId: "same-host-a",
        projectKey: "OPS",
        provider: "github",
        connectionId: "github-a",
        repoId: "repo-a",
        repoName: "org/repo",
        remoteUrl: "https://github.com/org/repo.git",
        baseBranch: "main",
      },
    ];
    await expect(
      handlers.jiraGetRepoBindingPreference({ connectionId: "same-host-a", projectKey: "ops" }, "window-a"),
    ).resolves.toMatchObject({ repoId: "repo-a", projectKey: "OPS" });
    await expect(
      handlers.jiraGetRepoBindingPreference({ connectionId: "same-host-a", projectKey: "OPS" }, "window-b"),
    ).rejects.toThrow("another profile");
  });

  it("builds smart-filter JQL from the verified identity, never currentUser(), scoped and ordered", async () => {
    const { handlers, state } = setup();
    const connection = state.settings.integrations.jira.connections.find((item) => item.id === "same-host-a")!;
    connection.accountPurpose = "technical";
    connection.verifiedIdentity = { kind: "data-center", name: "jira-bot", displayName: "Jira Bot" };
    connection.ownIdentity = { kind: "data-center", name: "alice", displayName: "Alice" };
    const build = (smartFilters: string[], projectKeys?: string[]) =>
      handlers.buildJiraOwnIssuesQuery({ connectionId: "same-host-a", smartFilters, projectKeys } as never, "window-a");
    const combined = await build(["assigned-to-me", "open", "updated-week", "current-sprint"], ["OPS"]);
    expect(combined.jql).toBe(
      '((((assignee = "alice") AND statusCategory != Done) AND updated >= startOfWeek()) AND sprint in openSprints()) AND project IN ("OPS") ORDER BY updated DESC',
    );
    expect(combined.jql).not.toMatch(/currentUser/i);
    expect((await build(["reported-by-me"], [])).jql).toBe('reporter = "alice" ORDER BY updated DESC');
    expect((await build(["watching"], [])).jql).toBe('watcher = "alice" ORDER BY updated DESC');
    expect((await build(["unassigned", "done-14d"], [])).jql).toBe(
      "(assignee is EMPTY) AND statusCategory = Done AND resolved >= -14d ORDER BY updated DESC",
    );
    expect((await build(["in-progress", "due-7d"], [])).jql).toBe(
      '(statusCategory = "In Progress") AND due >= startOfDay() AND due <= endOfDay("+7d") ORDER BY updated DESC',
    );
    expect((await build(["open", "in-progress"], [])).jql).toBe('statusCategory = "In Progress" ORDER BY updated DESC');
    await expect(
      handlers.jiraRemoteBuildOwnIssuesQuery(
        { connectionId: "same-host-a", smartFilters: ["watching"], projectKeys: [] },
        "profile-a",
      ),
    ).resolves.toMatchObject({ jql: 'watcher = "alice" ORDER BY updated DESC' });
  });

  it("refuses person-based smart filters without a verified identity but allows the others", async () => {
    const { handlers, state } = setup();
    const connection = state.settings.integrations.jira.connections.find((item) => item.id === "same-host-a")!;
    delete connection.ownIdentity;
    const build = (smartFilters: string[]) =>
      handlers.buildJiraOwnIssuesQuery(
        { connectionId: "same-host-a", smartFilters, projectKeys: [] } as never,
        "window-a",
      );
    for (const id of ["assigned-to-me", "reported-by-me", "watching"])
      await expect(build([id])).rejects.toThrow(/identity/i);
    await expect(build(["unassigned", "open"])).resolves.toMatchObject({
      jql: "(assignee is EMPTY) AND statusCategory != Done ORDER BY updated DESC",
    });
  });

  it("builds a safe personal issue filter from verified ownIdentity even under a technical API account", async () => {
    const { handlers, state } = setup();
    const connection = state.settings.integrations.jira.connections.find((item) => item.id === "same-host-a");
    expect(connection).toBeDefined();
    if (!connection) throw new Error("Expected Jira connection fixture");
    connection.accountPurpose = "technical";
    connection.verifiedIdentity = { kind: "data-center", name: "jira-bot", displayName: "Jira Bot" };
    connection.ownIdentity = { kind: "data-center", name: 'alice" OR project IS NOT EMPTY', displayName: "Alice" };
    await expect(
      handlers.buildJiraOwnIssuesQuery(
        { connectionId: "same-host-a", baseJql: "project = OPS OR currentUser() = currentUser()" },
        "window-a",
      ),
    ).resolves.toMatchObject({
      jql: '((project = OPS OR currentUser() = currentUser()) AND statusCategory != Done) AND assignee = "alice\\" OR project IS NOT EMPTY"',
      identityLabel: "Alice",
    });
    await expect(handlers.buildJiraOwnIssuesQuery({ connectionId: "same-host-b" }, "window-a")).rejects.toThrow(
      "another profile",
    );
    await expect(
      handlers.jiraRemoteBuildOwnIssuesQuery({ connectionId: "same-host-a" }, "profile-a"),
    ).resolves.toMatchObject({
      jql: '(statusCategory != Done) AND assignee = "alice\\" OR project IS NOT EMPTY"',
      identityLabel: "Alice",
    });
    await expect(handlers.jiraRemoteBuildOwnIssuesQuery({ connectionId: "same-host-a" }, "profile-b")).rejects.toThrow(
      "not found in this profile",
    );
  });

  it("verifies and saves remote personal identity only for the authenticated profile and a still-present connection", async () => {
    const { state, context } = setup();
    const identity = { kind: "data-center" as const, name: "alice", displayName: "Alice" };
    let finish!: (value: typeof identity) => void;
    const verifyUserIdentity = vi.fn(
      () =>
        new Promise<typeof identity>((resolve) => {
          finish = resolve;
        }),
    );
    const invalidate = vi.fn();
    context.jiraManager = { verifyUserIdentity, invalidate };
    const handlers = createJiraHandlers(context);
    const verification = handlers.jiraRemoteVerifyOwnIdentity(
      { connectionId: "same-host-a", userId: "alice" },
      "profile-a",
    );
    await vi.waitFor(() => expect(verifyUserIdentity).toHaveBeenCalledTimes(1));
    finish(identity);
    await expect(verification).resolves.toEqual(identity);
    await expect(
      handlers.jiraRemoteVerifyOwnIdentity({ connectionId: "same-host-a", userId: "alice" }, "profile-b"),
    ).rejects.toThrow("not found in this profile");

    const saving = handlers.jiraRemoteSetOwnIdentity({ connectionId: "same-host-a", userId: "alice" }, "profile-a");
    await vi.waitFor(() => expect(verifyUserIdentity).toHaveBeenCalledTimes(2));
    state.settings.integrations.jira.connections = state.settings.integrations.jira.connections.filter(
      (item) => item.id !== "same-host-a",
    );
    finish(identity);
    await expect(saving).rejects.toThrow("not found in this profile");
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("resyncs only this profile's personal views after changing its verified identity", async () => {
    const { state, context } = setup();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-jira-identity-refresh-"));
    const cache = createJiraCache(path.join(root, "jira.sqlite"));
    context.jiraCache = cache;
    state.workspaces.push(
      { id: "jira-workspace-a", kind: "jira", profileId: "profile-a" } as AppState["workspaces"][number],
      { id: "jira-workspace-b", kind: "jira", profileId: "profile-b" } as AppState["workspaces"][number],
    );
    const connA = state.settings.integrations.jira.connections.find((item) => item.id === "same-host-a")!;
    const connB = state.settings.integrations.jira.connections.find((item) => item.id === "same-host-b")!;
    connA.ownIdentity = { kind: "data-center", name: "alice", displayName: "Alice" };
    connB.ownIdentity = { kind: "data-center", name: "bob", displayName: "Bob" };
    const searchPage = vi.fn(async (_connection: unknown, _jql: string) => ({
      issues: [],
      hasMore: false,
      truncated: false,
      cache: { refreshError: undefined },
    }));
    const manager = {
      searchPage,
      verifyUserIdentity: vi.fn(async () => ({
        kind: "data-center" as const,
        name: "alice-new",
        displayName: "Alice New",
      })),
      invalidate: vi.fn(),
    };
    context.jiraManager = manager;
    const handlers = createJiraHandlers(context);
    const viewA = await handlers.saveJiraWorkspaceView(
      { workspaceId: "jira-workspace-a", view: { kind: "personal", connectionId: "same-host-a" } },
      "window-a",
    );
    const viewB = await handlers.saveJiraWorkspaceView(
      { workspaceId: "jira-workspace-b", view: { kind: "personal", connectionId: "same-host-b" } },
      "window-b",
    );
    const personalA = viewA.views.find((view) => view.kind === "personal")!;
    const personalB = viewB.views.find((view) => view.kind === "personal")!;
    await vi.waitFor(() => expect(searchPage).toHaveBeenCalledTimes(2));
    searchPage.mockClear();
    await handlers.jiraRemoteSetOwnIdentity({ connectionId: "same-host-a", userId: "alice-new" }, "profile-a");
    await vi.waitFor(() => expect(searchPage).toHaveBeenCalledTimes(1));
    expect(searchPage.mock.calls[0][0]).toMatchObject({ id: "same-host-a", profileId: "profile-a" });
    expect(searchPage.mock.calls[0][1]).toBe('(statusCategory != Done) AND assignee = "alice-new"');
    expect(handlers.getJiraWorkspaceViewsSnapshot()["jira-workspace-a"]?.syncByViewId[personalA.viewId]?.state).toBe(
      "idle",
    );
    expect(handlers.getJiraWorkspaceViewsSnapshot()["jira-workspace-b"]?.syncByViewId[personalB.viewId]?.state).toBe(
      "idle",
    );
    cache.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("persists ambiguous writes privately and blocks a duplicate after handler restart", async () => {
    const { context, secrets, credentialStore } = setup();
    const requests: Array<{ method: string; url: string }> = [];
    context.fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ method: init?.method || "GET", url });
      if (init?.method === "POST") return new Response("temporary", { status: 503 });
      if (url.includes("/comment?")) return new Response(JSON.stringify({ comments: [], total: 0, startAt: 0 }));
      if (url.includes("/issue/1"))
        return new Response(
          JSON.stringify({
            id: "1",
            key: "OPS-1",
            fields: {
              summary: "One",
              status: { name: "Open" },
              issuetype: { name: "Task" },
              project: { key: "OPS" },
              updated: "2026-10-23T00:00:00Z",
            },
          }),
        );
      return new Response(JSON.stringify({ comments: [], total: 0, startAt: 0 }));
    });
    const first = createJiraHandlers(context);
    const ref = { connectionId: "same-host-a", issueId: "1", issueKey: "OPS-1" };
    const confirmation = await first.jiraPreviewComment(
      { ref, body: "Add a note", intent: "User confirmed note" },
      "window-a",
    );
    await expect(
      first.jiraExecuteComment({ ref, body: "Add a note", confirmation }, "window-a"),
    ).resolves.toMatchObject({ ok: false, error: { code: "jira-write-unknown", status: "unknown" } });
    const journalRef = "jira:write-journal:profile-a";
    expect(secrets.has(journalRef)).toBe(true);
    expect(secrets.get(journalRef)).not.toContain("Add a note");
    expect(credentialStore.setSecret).toHaveBeenCalledWith(journalRef, expect.any(String), {
      requireEncryptedStorage: true,
    });
    const postCount = requests.filter((request) => request.method === "POST").length;

    const resumed = createJiraHandlers(context);
    const retryConfirmation = await resumed.jiraPreviewComment(
      { ref, body: "Add a note", intent: "User confirmed note" },
      "window-a",
    );
    await expect(
      resumed.jiraExecuteComment({ ref, body: "Add a note", confirmation: retryConfirmation }, "window-a"),
    ).resolves.toMatchObject({ ok: false, error: { code: "validation-failed" } });
    expect(requests.filter((request) => request.method === "POST")).toHaveLength(postCount);
    await expect(resumed.jiraGetWriteHistory({}, "window-b")).resolves.toEqual([]);
    await expect(resumed.jiraGetWriteHistory({}, "window-a")).resolves.toMatchObject([
      { state: "unknown", kind: "comment" },
    ]);
    await expect(
      resumed.jiraReconcileWrite(
        (JSON.parse(secrets.get(journalRef)!) as { entries: Array<{ id: string }> }).entries[0].id,
        "window-a",
      ),
    ).resolves.toMatchObject({ status: "reconciled", outcome: "not-applied" });
  });

  it("rejects malformed private task and saved-query outputs at the runtime DTO boundary", async () => {
    const { handlers, state } = setup();
    state.settings.integrations.jira.queries.push({
      id: "bad-query",
      profileId: "profile-a",
      connectionId: "same-host-a",
      name: "Q",
      jql: "project = OPS",
      notificationsEnabled: false,
      updatedAt: new Date().toISOString(),
      secretRef: "leak",
    } as unknown as (typeof state.settings.integrations.jira.queries)[number]);
    await expect(handlers.jiraListQueries("same-host-a", "window-a")).rejects.toThrow();
    state.settings.integrations.jira.queries = [];
    state.workspaces.push({
      id: "task-private",
      profileId: "profile-a",
      task: {
        jiraIssueRefs: [{ provider: "jira", connectionId: "same-host-a", issueId: "1", issueKey: "OPS-1" }],
        jiraPreparedSnapshot: [
          {
            ref: { provider: "jira", connectionId: "same-host-a", issueId: "1", issueKey: "OPS-1" },
            fields: { summary: "Safe", secretRef: "credential-leak" },
          },
        ],
        jiraIssueSnapshots: [],
      },
    } as unknown as (typeof state.workspaces)[number]);
    await expect(handlers.jiraGetTaskContext("task-private", "window-a")).rejects.toThrow();
  });

  it("returns an issue thread longer than one page from both the desktop and the remote handler", async () => {
    const { context } = setup();
    const total = 150;
    context.fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const startAt = Number(url.searchParams.get("startAt") || 0);
      const end = Math.min(total, startAt + Number(url.searchParams.get("maxResults") || 100));
      const comments = Array.from({ length: end - startAt }, (_, index) => ({
        id: String(startAt + index + 1),
        author: { displayName: "Ann" },
        created: "2026-10-23T00:00:00Z",
        body: "text",
      }));
      return new Response(JSON.stringify({ startAt, total, comments }));
    });
    const handlers = createJiraHandlers(context);
    const desktop = await handlers.jiraListComments(
      { ref: { connectionId: "same-host-a", issueId: "1", issueKey: "OPS-1" } },
      "window-a",
    );
    const remote = await handlers.jiraRemoteListComments({ connectionId: "same-host-a", issueId: "1" }, "profile-a");
    expect(desktop).toHaveLength(total);
    expect(remote).toHaveLength(total);
    expect(desktop.at(-1)?.id).toBe(String(total));
  });

  it("returns only normalized Jira issue fields despite hostile extra provider fields", async () => {
    const { handlers, context } = setup();
    context.fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: "1",
            key: "OPS-1",
            secretRef: "credential-leak",
            accessToken: "provider-token",
            fields: {
              summary: "Safe",
              status: { name: "Open" },
              issuetype: { name: "Task" },
              project: { key: "OPS" },
              updated: "2026-10-23T00:00:00Z",
              description: "<script>bad()</script>safe text",
            },
          }),
        ),
    );
    const normalized = createJiraHandlers(context);
    const issue = await normalized.jiraGetIssue({ connectionId: "same-host-a", issueId: "1" }, "window-a");
    expect(issue).not.toBeNull();
    if (!issue) throw new Error("Expected the Jira issue to be available.");
    expect(JSON.stringify(issue)).not.toMatch(/secretRef|credential-leak|accessToken|provider-token/);
    expect(issue.description).not.toContain("<script>");
  });
});

describe("Jira attachment image content", () => {
  async function imageSetup() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-jira-attachment-"));
    const { context } = setup();
    const attachmentBytes = vi.fn(async (_connection: unknown, _issueId: string, _id: string, _options: unknown) => ({
      fileName: "a.png",
      mediaType: "image/png",
      bytes: new Uint8Array([1, 2, 3]),
    }));
    const manager = { attachmentBytes, binding: "binding-1", cacheBinding: () => manager.binding };
    context.jiraManager = manager as never;
    (context as Record<string, unknown>).jiraAttachmentCache = createJiraAttachmentCache(root);
    return { handlers: createJiraHandlers(context), attachmentBytes, root, manager };
  }

  it("asks the manager for an image only, within 10 MiB, and serves the second read from disk", async () => {
    const { handlers, attachmentBytes, root } = await imageSetup();
    const payload = { connectionId: "same-host-a", issueId: "100", attachmentId: "5" };
    const first = await handlers.jiraGetAttachmentImage(payload, "window-a");
    expect(first).toEqual({ mediaType: "image/png", bytes: new Uint8Array([1, 2, 3]) });
    expect(attachmentBytes.mock.calls[0]?.[3]).toMatchObject({ imageOnly: true, maxBytes: 10 * 1024 * 1024 });
    const second = await handlers.jiraRemoteGetAttachmentImage(payload, "profile-a");
    expect(second).toEqual({ mediaType: "image/png", base64: Buffer.from([1, 2, 3]).toString("base64") });
    expect(attachmentBytes).toHaveBeenCalledTimes(1);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("misses the cache after a credential change and clears the connection when the manager invalidates it", async () => {
    const { handlers, attachmentBytes, root, manager } = await imageSetup();
    const payload = { connectionId: "same-host-a", issueId: "100", attachmentId: "5" };
    await handlers.jiraGetAttachmentImage(payload, "window-a");
    manager.binding = "binding-2";
    await handlers.jiraGetAttachmentImage(payload, "window-a");
    expect(attachmentBytes).toHaveBeenCalledTimes(2);
    (manager as unknown as { onConnectionInvalidated: (id: string) => void }).onConnectionInvalidated("same-host-a");
    await vi.waitFor(async () => {
      await handlers.jiraGetAttachmentImage(payload, "window-a");
      expect(attachmentBytes).toHaveBeenCalledTimes(3);
    });
    await fs.rm(root, { recursive: true, force: true });
  });

  it("does not serve another profile's connection and surfaces the manager's refusal without caching", async () => {
    const { handlers, attachmentBytes, root } = await imageSetup();
    await expect(
      handlers.jiraRemoteGetAttachmentImage(
        { connectionId: "same-host-b", issueId: "100", attachmentId: "5" },
        "profile-a",
      ),
    ).rejects.toThrow();
    attachmentBytes.mockRejectedValueOnce(new Error("Jira attachment is not an image."));
    const payload = { connectionId: "same-host-a", issueId: "100", attachmentId: "7" };
    await expect(handlers.jiraGetAttachmentImage(payload, "window-a")).rejects.toThrow("not an image");
    await handlers.jiraGetAttachmentImage(payload, "window-a");
    expect(attachmentBytes).toHaveBeenCalledTimes(2);
    await fs.rm(root, { recursive: true, force: true });
  });
});
