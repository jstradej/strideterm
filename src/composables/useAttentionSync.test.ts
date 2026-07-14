import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { nextTick } from "vue";
import { setActivePinia, createPinia } from "pinia";
import { useAppStore } from "../stores/app.js";
import { deriveAttentionSync, deriveGridSessionIds, useAttentionSync } from "./useAttentionSync.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = Record<string, any>;

function makeStore(overrides: AnyRecord = {}): AnyRecord {
  return {
    isGridVisible: true,
    gridCellWorkspaces: [],
    activeViewId: null,
    activeWorkspace: null,
    ...overrides,
  };
}

describe("deriveGridSessionIds — grid-cell terminals join the remote subscription", () => {
  test("returns empty when the grid is not visible", () => {
    const store = makeStore({
      isGridVisible: false,
      gridCellWorkspaces: [{ id: "ws2", activeViewId: "ws2:shell" }],
    });
    expect(deriveGridSessionIds(store as never)).toEqual([]);
  });

  test("includes non-focused cells' persisted terminal views", () => {
    const store = makeStore({
      activeWorkspace: { id: "ws1" },
      activeViewId: "ws1:shell",
      gridCellWorkspaces: [
        { id: "ws1", activeViewId: "stale-should-not-be-used" },
        { id: "ws2", activeViewId: "ws2:agent" },
        { id: "ws3", activeViewId: "ws3:shell" },
      ],
    });
    // Focused cell (ws1) uses the LIVE activeViewId; others use persisted.
    expect(deriveGridSessionIds(store as never)).toEqual(["ws1:shell", "ws2:agent", "ws3:shell"]);
  });

  test("skips empty cells and non-terminal views (git/docker/files/...)", () => {
    const store = makeStore({
      activeWorkspace: { id: "ws1" },
      activeViewId: "git:ws1", // focused cell shows the git pane → not a terminal
      gridCellWorkspaces: [
        { id: "ws1", activeViewId: "ws1:shell" },
        null, // empty cell
        { id: "ws2", activeViewId: "docker:ws2" },
        { id: "ws3", activeViewId: "files:ws3" },
        { id: "ws4", activeViewId: "ws4:worker" },
      ],
    });
    expect(deriveGridSessionIds(store as never)).toEqual(["ws4:worker"]);
  });

  test("deduplicates when two cells resolve to the same session", () => {
    const store = makeStore({
      activeWorkspace: { id: "ws1" },
      activeViewId: "ws1:shell",
      gridCellWorkspaces: [
        { id: "ws1", activeViewId: "ignored" },
        { id: "ws1", activeViewId: "ignored-too" }, // duplicate cell of the same workspace
      ],
    });
    expect(deriveGridSessionIds(store as never)).toEqual(["ws1:shell"]);
  });

  test("skips cells whose view id is missing", () => {
    const store = makeStore({
      activeWorkspace: { id: "ws9" },
      activeViewId: null,
      gridCellWorkspaces: [{ id: "ws2", activeViewId: null }, { id: "ws9" }],
    });
    expect(deriveGridSessionIds(store as never)).toEqual([]);
  });

  test("excludes a headless-copilot judge panel (rendered as headless-judge, not a streaming terminal)", () => {
    // The judge panel's view id looks like a terminal id but WorkspaceCell
    // mounts it as a headless-judge pane, so it must not join the terminal
    // stream subscription. classifyViewType reads the workspace's live
    // task-runner state from payload to make that call — same as the cell.
    const store = makeStore({
      activeWorkspace: { id: "ws1" },
      activeViewId: "ws1:worker",
      gridCellWorkspaces: [
        { id: "ws1", activeViewId: "ignored" }, // focused → uses live activeViewId
        { id: "ws2", activeViewId: "ws2:panel-judge" }, // this is ws2's headless judge
      ],
      payload: {
        taskRunner: {
          ws2: { judgeExecutionMode: "headless-copilot", judgePanelId: "panel-judge" },
        },
      },
    });
    // ws1:worker streams; ws2's judge panel is filtered out.
    expect(deriveGridSessionIds(store as never)).toEqual(["ws1:worker"]);
  });

  test("narrow viewport streams only the focused cell (hidden cells are display:none)", () => {
    // On a phone-width viewport WorkspaceGridStage v-shows only the focused
    // cell, so the non-focused cells' terminals are hidden and must not stream.
    const store = makeStore({
      activeWorkspace: { id: "ws1" },
      activeViewId: "ws1:shell",
      gridCellWorkspaces: [
        { id: "ws1", activeViewId: "stale-should-not-be-used" },
        { id: "ws2", activeViewId: "ws2:agent" },
        { id: "ws3", activeViewId: "ws3:shell" },
      ],
    });
    // Desktop: every cell streams.
    expect(deriveGridSessionIds(store as never, false)).toEqual(["ws1:shell", "ws2:agent", "ws3:shell"]);
    // Narrow: only the focused cell (ws1) streams.
    expect(deriveGridSessionIds(store as never, true)).toEqual(["ws1:shell"]);
  });
});

describe("deriveAttentionSync — subscription/attention scopes and dedup key", () => {
  function makeSyncStore(overrides: AnyRecord = {}): AnyRecord {
    return {
      isGridVisible: false,
      gridCellWorkspaces: [],
      activeViewId: null,
      activeWorkspace: null,
      attentionSummary: { count: 0, waitingCount: 0 },
      activeProfile: { id: "default" },
      visibleTabs: [],
      ...overrides,
    };
  }

  test("out of grid mode both scopes equal the active workspace's terminal tabs", () => {
    const store = makeSyncStore({
      visibleTabs: [
        { id: "ws1:a", type: "terminal" },
        { id: "ws1:git", type: "git" }, // non-terminal → excluded from both scopes
        { id: "ws1:b", type: "terminal" },
      ],
    });
    const { visibleSessionIds, subscriptionIds } = deriveAttentionSync(store as never, true);
    expect(visibleSessionIds).toEqual(["ws1:a", "ws1:b"]);
    // No grid → the stream subscription mirrors attention scope exactly.
    expect(subscriptionIds).toEqual(["ws1:a", "ws1:b"]);
  });

  test("grid mode diverges: subscription is grid cells, attention stays active-workspace", () => {
    const store = makeSyncStore({
      isGridVisible: true,
      activeWorkspace: { id: "ws1" },
      activeViewId: "ws1:a",
      // Active workspace still has hidden/split terminal tabs; only the grid
      // cells are on screen, so those hidden tabs must NOT join the subscription.
      visibleTabs: [
        { id: "ws1:a", type: "terminal" },
        { id: "ws1:hidden", type: "terminal" },
      ],
      gridCellWorkspaces: [
        { id: "ws1", activeViewId: "ignored" }, // focused → live activeViewId (ws1:a)
        { id: "ws2", activeViewId: "ws2:shell" },
      ],
    });
    const { visibleSessionIds, subscriptionIds } = deriveAttentionSync(store as never, true);
    // Attention keeps its active-workspace scope (incl. the hidden split tab).
    expect(visibleSessionIds).toEqual(["ws1:a", "ws1:hidden"]);
    // The stream subscription is exactly the rendered grid cells — no ws1:hidden.
    expect(subscriptionIds).toEqual(["ws1:a", "ws2:shell"]);
  });

  test("dedup key changes when attention scope changes even if grid cells are unchanged", () => {
    // Regression: the key used to include only subscriptionIds, so an
    // attention-visibility change in grid mode (visibleTabs) that left the grid
    // cells untouched slipped through the dedup guard → the backend kept stale
    // visibility. The key must react to visibleSessionIds too.
    const base = {
      isGridVisible: true,
      activeWorkspace: { id: "ws1" },
      activeViewId: "ws1:a",
      gridCellWorkspaces: [
        { id: "ws1", activeViewId: "ignored" },
        { id: "ws2", activeViewId: "ws2:shell" },
      ],
    };
    const before = deriveAttentionSync(
      makeSyncStore({ ...base, visibleTabs: [{ id: "ws1:a", type: "terminal" }] }) as never,
      true,
    );
    const after = deriveAttentionSync(
      makeSyncStore({ ...base, visibleTabs: [{ id: "ws1:b", type: "terminal" }] }) as never,
      true,
    );
    // Grid cells (subscription scope) are identical across both...
    expect(before.subscriptionIds).toEqual(after.subscriptionIds);
    // ...but the attention scope changed, so the dedup key MUST differ.
    expect(before.syncKey).not.toBe(after.syncKey);
  });

  test("narrow viewport collapses the grid subscription to the focused cell", () => {
    const store = makeSyncStore({
      isGridVisible: true,
      activeWorkspace: { id: "ws1" },
      activeViewId: "ws1:a",
      visibleTabs: [{ id: "ws1:a", type: "terminal" }],
      gridCellWorkspaces: [
        { id: "ws1", activeViewId: "ignored" }, // focused → live activeViewId (ws1:a)
        { id: "ws2", activeViewId: "ws2:shell" },
      ],
    });
    // Desktop: both grid cells stream.
    expect(deriveAttentionSync(store as never, true, false).subscriptionIds).toEqual(["ws1:a", "ws2:shell"]);
    // Narrow: only the focused cell streams; the hidden ws2 cell drops out.
    expect(deriveAttentionSync(store as never, true, true).subscriptionIds).toEqual(["ws1:a"]);
  });
});

describe("useAttentionSync — terminal:removed resyncs deterministically (finding 3)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setActivePinia(createPinia());
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function makeApi() {
    let removedHandler: ((e: { sessionId: string }) => void) | null = null;
    return {
      subscribeTerminals: vi.fn(),
      syncAttentionContext: vi.fn(),
      onTerminalRemoved: (h: (e: { sessionId: string }) => void) => {
        removedHandler = h;
      },
      fireRemoved: (sessionId: string) => removedHandler?.({ sessionId }),
    };
  }

  // A fresh, distinct full-snapshot payload each call — mirrors how the store
  // reassigns its shallowRef on every state:updated broadcast.
  function pushState(appStore: unknown) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (appStore as any).payload = { appState: { profiles: [], workspaces: [] } };
  }

  async function mount() {
    const appStore = useAppStore();
    // Minimal well-formed appState so the store's derived getters (activeProfile,
    // attentionSummary, visibleTabs) resolve cleanly. Set BEFORE wiring the
    // composable so its watcher sees no change and never schedules its own sync —
    // the only syncs in these tests come from the removal-resync path.
    pushState(appStore);
    await nextTick();
    const api = makeApi();
    useAttentionSync(api as never);
    return { api, appStore };
  }

  test("does NOT resync on a timer over stale state; waits for the next state:updated", async () => {
    const { api, appStore } = await mount();

    // Server prunes a panel and notifies while a large state:updated is still in
    // flight — our payload has not changed yet (it may still list the removed id).
    api.fireRemoved("ws1:a");

    // A timer-based resync (the old 50ms deferral) would fire around here and
    // subscribe over stale state. It must NOT: advancing well past any old window
    // proves the resync is not timer-driven and nothing is sent prematurely.
    vi.advanceTimersByTime(1000);
    expect(api.subscribeTerminals).not.toHaveBeenCalled();

    // The next payload arrives (a state:updated the client actually applies).
    // Only now does the resync run, over server-consistent state.
    pushState(appStore);
    await nextTick();
    expect(api.subscribeTerminals).toHaveBeenCalledTimes(1);
  });

  test("re-arms per removal: each terminal:removed is honored by its next payload", async () => {
    const { api, appStore } = await mount();

    // First removal → next payload resyncs once.
    api.fireRemoved("ws1:a");
    pushState(appStore);
    await nextTick();
    expect(api.subscribeTerminals).toHaveBeenCalledTimes(1);

    // A payload with NO pending removal must NOT go through the removal-resync
    // path (ordinary syncs are owned by the debounced watcher, not this one).
    pushState(appStore);
    await nextTick();
    expect(api.subscribeTerminals).toHaveBeenCalledTimes(1);

    // A later removal re-arms it → the following payload resyncs again.
    api.fireRemoved("ws1:a");
    pushState(appStore);
    await nextTick();
    expect(api.subscribeTerminals).toHaveBeenCalledTimes(2);
  });
});
