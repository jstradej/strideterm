import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { nextTick } from "vue";
import { useAppStore } from "./app.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApi = any;

const ALIAS = "attached-primary:ws-task";
const SOURCE_SESSION = "ws-source:panel-primary";
const COMPANION_SESSION = "ws-task:panel-judge";
const DASHBOARD_VIEW = "task-dashboard:panel-dashboard";

function sourceWorkspace(overrides: AnyApi = {}): AnyApi {
  return {
    id: "ws-source",
    name: "Live conversation",
    kind: "terminal",
    cwd: "/tmp",
    profileId: "default",
    panels: [
      { id: "panel-primary", title: "Claude", command: "claude" },
      { id: "panel-other", title: "Shell", command: "bash" },
    ],
    ...overrides,
  };
}

function taskWorkspace(state: string, overrides: AnyApi = {}): AnyApi {
  return {
    id: "ws-task",
    name: "Reviewer: Live conversation",
    kind: "task",
    cwd: "/tmp",
    profileId: "default",
    panels: [
      { id: "panel-dashboard", title: "Dashboard", command: "__task-dashboard__" },
      { id: "panel-judge", title: "Reviewer", command: "codex" },
    ],
    task: {
      mode: "attached",
      state,
      workerWorkspaceId: "ws-source",
      workerPanelId: "panel-primary",
      judgePanelId: "panel-judge",
      companionRole: "reviewer",
    },
    ...overrides,
  };
}

/** Payload whose ACTIVE workspace is the companion task workspace. */
function taskPayload(state: string, taskOverrides: AnyApi = {}): AnyApi {
  const task = taskWorkspace(state, taskOverrides);
  return {
    appState: {
      activeWorkspaceId: "ws-task",
      profiles: [{ id: "default", name: "Default", color: "#fff", workspaceIds: [] }],
      workspaces: [sourceWorkspace(), task],
      windowSlots: [],
      settings: {},
    },
    workspace: {
      workspace: task,
      sessions: [{ sessionId: COMPANION_SESSION, panelId: "panel-judge", title: "Reviewer", status: "running" }],
    },
    attention: { sessions: {}, byWorkspace: {} },
    taskRunner: {},
  };
}

/** Payload whose ACTIVE workspace is the source workspace. */
function sourcePayload(state: string, sourceOverrides: AnyApi = {}): AnyApi {
  const source = sourceWorkspace(sourceOverrides);
  return {
    appState: {
      activeWorkspaceId: "ws-source",
      profiles: [{ id: "default", name: "Default", color: "#fff", workspaceIds: [] }],
      workspaces: [source, taskWorkspace(state)],
      windowSlots: [],
      settings: {},
    },
    workspace: {
      workspace: source,
      sessions: [
        { sessionId: SOURCE_SESSION, panelId: "panel-primary", title: "Claude", status: "running" },
        { sessionId: "ws-source:panel-other", panelId: "panel-other", title: "Shell", status: "running" },
      ],
    },
    attention: { sessions: {}, byWorkspace: {} },
    taskRunner: {},
  };
}

function makeTransport(payload: AnyApi) {
  return {
    isRemote: false,
    getState: vi.fn(() => Promise.resolve(payload)),
    onStateUpdated: vi.fn(),
    onConnectionState: vi.fn(),
    activateWorkspace: vi.fn(() => Promise.resolve(payload)),
    activateSession: vi.fn(() => Promise.resolve(payload)),
    setWorkspaceUIState: vi.fn(() => Promise.resolve(payload)),
  };
}

async function makeStore(payload: AnyApi) {
  const transport = makeTransport(payload);
  const store = useAppStore();
  store.init(transport as AnyApi);
  await Promise.resolve();
  await Promise.resolve();
  // Go through the real activation path so splitGroup / activeViewId are
  // restored from the persisted workspace entry, exactly as on startup.
  await store.activateWorkspace(payload.appState.activeWorkspaceId);
  await nextTick();
  return { store, transport };
}

describe("Companion Primary relocation — store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    (window as AnyApi).strideterm = { startupFlags: { windowId: "" } };
  });

  it("shows Dashboard / Primary / Companion inside the task workspace", async () => {
    const { store } = await makeStore(taskPayload("running"));
    expect((store.workspaceTabs as AnyApi[]).map((t) => t.title)).toEqual(["Dashboard", "Primary", "Reviewer"]);
  });

  it("activating the alias keeps the task workspace and points the session at the source PTY", async () => {
    const { store, transport } = await makeStore(taskPayload("running"));

    await store.activateView(ALIAS);

    expect(store.activeViewId).toBe(ALIAS);
    expect(store.activeSessionId).toBe(SOURCE_SESSION);
    expect(store.myActiveWorkspaceId).toBe("ws-task");
    // Routing through activateSession would have derived the SOURCE workspace
    // from the session-id prefix and yanked the viewer over to it.
    expect(transport.activateSession).not.toHaveBeenCalled();
    expect(transport.setWorkspaceUIState).toHaveBeenCalledWith("ws-task", { activeViewId: ALIAS });
  });

  it("refuses another workspace's alias", async () => {
    const { store } = await makeStore(taskPayload("running"));
    expect(store.resolveSessionIdForView(ALIAS, "ws-task")).toBe(SOURCE_SESSION);
    expect(store.resolveSessionIdForView(ALIAS, "ws-source")).toBeNull();
    expect(store.resolveSessionIdForView("attached-primary:ws-other", "ws-task")).toBeNull();
    expect(store.resolveSessionIdForView(SOURCE_SESSION, "ws-source")).toBe(SOURCE_SESSION);
  });

  it("defaults the hosting task workspace to a three-pane top-split", async () => {
    const { store } = await makeStore(taskPayload("running"));
    expect(store.splitGroup).toEqual({ layout: "top-split", viewIds: [DASHBOARD_VIEW, ALIAS, COMPANION_SESSION] });
  });

  it("completion returns the tab, falls back to the Dashboard and clears the stale session", async () => {
    const { store } = await makeStore(taskPayload("running"));
    await store.activateView(ALIAS);
    expect(store.activeSessionId).toBe(SOURCE_SESSION);

    store.payload = taskPayload("completed") as AnyApi;
    await nextTick();

    expect((store.workspaceTabs as AnyApi[]).map((t) => t.title)).toEqual(["Dashboard", "Reviewer"]);
    expect(store.activeViewId).toBe(DASHBOARD_VIEW);
    // A leftover activeSessionId here is what would let the mobile composer
    // write into a conversation that is no longer on screen.
    expect(store.activeSessionId).toBeNull();
    expect(store.splitGroup).toEqual({ layout: "cols", viewIds: [DASHBOARD_VIEW, COMPANION_SESSION] });
  });

  it("send back re-hosts the alias and restores the system three-pane layout", async () => {
    const { store } = await makeStore(taskPayload("completed"));
    await nextTick();
    expect(store.splitGroup).toEqual({ layout: "cols", viewIds: [DASHBOARD_VIEW, COMPANION_SESSION] });

    store.payload = taskPayload("running") as AnyApi;
    await nextTick();

    expect((store.workspaceTabs as AnyApi[]).map((t) => t.id)).toContain(ALIAS);
    expect(store.splitGroup).toEqual({ layout: "top-split", viewIds: [DASHBOARD_VIEW, ALIAS, COMPANION_SESSION] });
  });

  // State written before the alias was persistable had it stripped by
  // normalizeState, leaving `top-split` holding two panes: the split rendered
  // with an empty quadrant and the Primary was missing from it entirely. It is
  // the hosting shape minus its alias, so activation repairs it.
  it("repairs a hosting layout whose alias was stripped by an older state file", async () => {
    const damaged = { splitLayout: "top-split", splitViewIds: [DASHBOARD_VIEW, COMPANION_SESSION] };
    const { store } = await makeStore(taskPayload("capturing-context", damaged));
    await nextTick();

    expect(store.splitGroup).toEqual({ layout: "top-split", viewIds: [DASHBOARD_VIEW, ALIAS, COMPANION_SESSION] });
    expect(store.renderedSplitGroup).toEqual({
      layout: "top-split",
      viewIds: [DASHBOARD_VIEW, ALIAS, COMPANION_SESSION],
    });
  });

  it("normalises the stripped shape down to two panes when the loop is not hosting", async () => {
    const damaged = { splitLayout: "top-split", splitViewIds: [DASHBOARD_VIEW, COMPANION_SESSION] };
    const { store } = await makeStore(taskPayload("completed", damaged));
    await nextTick();

    expect(store.splitGroup).toEqual({ layout: "cols", viewIds: [DASHBOARD_VIEW, COMPANION_SESSION] });
  });

  it("never rewrites a task layout the user arranged themselves", async () => {
    const { store } = await makeStore(taskPayload("running"));
    const custom = { layout: "rows", viewIds: [COMPANION_SESSION, DASHBOARD_VIEW] };
    store.splitGroup = { ...custom };
    await nextTick();

    store.payload = taskPayload("completed") as AnyApi;
    await nextTick();

    expect(store.splitGroup).toEqual(custom);
  });

  it("keeps the source workspace's own layout when its Primary is hosted elsewhere", async () => {
    const persisted = { splitLayout: "cols", splitViewIds: [SOURCE_SESSION, "ws-source:panel-other"] };
    const { store } = await makeStore(sourcePayload("running", persisted));
    await nextTick();

    // The hidden Primary is dormant, not deleted — pruning it here would
    // persist a truncated layout and the tab would never come back to its slot.
    expect(store.splitGroup).toEqual({ layout: "cols", viewIds: [SOURCE_SESSION, "ws-source:panel-other"] });
    expect((store.workspaceTabs as AnyApi[]).map((t) => t.id)).toEqual(["ws-source:panel-other"]);
    // Only the drawable pane is rendered, and the layout steps down with it.
    expect(store.renderedSplitGroup).toBeNull();
    expect((store.visibleTabs as AnyApi[]).map((t) => t.id)).toEqual(["ws-source:panel-other"]);
  });

  it("returns the source tab to its original position once the loop ends", async () => {
    const persisted = { splitLayout: "cols", splitViewIds: [SOURCE_SESSION, "ws-source:panel-other"] };
    const { store } = await makeStore(sourcePayload("running", persisted));
    await nextTick();

    store.payload = sourcePayload("failed", persisted) as AnyApi;
    await nextTick();

    expect((store.workspaceTabs as AnyApi[]).map((t) => t.id)).toEqual([SOURCE_SESSION, "ws-source:panel-other"]);
    expect(store.renderedSplitGroup).toEqual({ layout: "cols", viewIds: [SOURCE_SESSION, "ws-source:panel-other"] });
  });

  it("deleting the companion task returns the source tab", async () => {
    const { store } = await makeStore(sourcePayload("running"));
    await nextTick();
    expect((store.workspaceTabs as AnyApi[]).map((t) => t.id)).toEqual(["ws-source:panel-other"]);

    const withoutTask = sourcePayload("running");
    withoutTask.appState.workspaces = [sourceWorkspace()];
    store.payload = withoutTask as AnyApi;
    await nextTick();

    expect((store.workspaceTabs as AnyApi[]).map((t) => t.id)).toEqual([SOURCE_SESSION, "ws-source:panel-other"]);
  });

  it("exposes the host binding to the source workspace so it can point at the loop", async () => {
    const { store } = await makeStore(sourcePayload("running"));
    const host = store.getCompanionPrimaryHost("ws-source");
    expect(host?.taskWorkspaceId).toBe("ws-task");
    expect(host?.sourceSessionId).toBe(SOURCE_SESSION);
    expect(store.getCompanionPrimaryHost("ws-source", "panel-other")).toBeNull();
  });

  it("restores a persisted alias on workspace activation, and falls back when it is dormant", async () => {
    const { store } = await makeStore(taskPayload("running", { activeViewId: ALIAS, activePanelId: "panel-judge" }));
    await store.activateWorkspace("ws-task");
    expect(store.activeViewId).toBe(ALIAS);
    expect(store.activeSessionId).toBe(SOURCE_SESSION);
  });

  it("does not adopt a persisted alias once the loop has finished", async () => {
    const { store } = await makeStore(taskPayload("completed", { activeViewId: ALIAS, activePanelId: "panel-judge" }));
    await store.activateWorkspace("ws-task");
    expect(store.activeViewId).not.toBe(ALIAS);
    expect(store.activeSessionId).not.toBe(SOURCE_SESSION);
  });

  it("leaves standard task workspaces and ordinary terminals untouched", async () => {
    const payload = taskPayload("running");
    payload.appState.workspaces[1].task.mode = "standard";
    payload.workspace.workspace.task.mode = "standard";
    const { store } = await makeStore(payload);
    await nextTick();

    // No alias, no reordering: the strip is exactly what it was before.
    expect((store.workspaceTabs as AnyApi[]).map((t) => t.title)).toEqual(["Reviewer", "Dashboard"]);
    for (const tab of store.workspaceTabs as AnyApi[]) expect(tab.borrowed).toBeUndefined();
  });
});
