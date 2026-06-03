import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useAppStore } from "./app.js";
import type { StatePayload } from "../../electron/shared/types/state.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApi = any;

const BASE_WORKSPACES = [
  { id: "ws-A", name: "Alpha", cwd: "/a", panels: [], icon: "A", color: "#fff" },
  { id: "ws-B", name: "Beta", cwd: "/b", panels: [], icon: "B", color: "#fff" },
  { id: "ws-C", name: "Gamma", cwd: "/c", panels: [], icon: "C", color: "#fff" },
  { id: "ws-D", name: "Delta", cwd: "/d", panels: [], icon: "D", color: "#fff" },
];

function makePayload(appStateOverrides: AnyApi = {}): StatePayload {
  return {
    appState: {
      workspaces: BASE_WORKSPACES,
      activeWorkspaceId: "ws-A",
      activeProfileId: "default",
      workspaceGrid: null,
      ...appStateOverrides,
    },
  } as AnyApi;
}

function makeApi(overrides: AnyApi = {}) {
  return {
    onStateUpdated: vi.fn(),
    onConnectionState: vi.fn(),
    getState: vi.fn(async () => null),
    enableWorkspaceGrid: vi.fn(async () => undefined),
    disableWorkspaceGrid: vi.fn(async () => undefined),
    setGridLayout: vi.fn(async () => undefined),
    setGridCell: vi.fn(async () => undefined),
    swapGridCells: vi.fn(async () => undefined),
    activateWorkspace: vi.fn(async () => ({ appState: { workspaces: BASE_WORKSPACES } })),
    ...overrides,
  };
}

describe("workspace grid store — computed properties", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("workspaceGrid returns null when appState has no grid", () => {
    const store = useAppStore();
    store.payload = makePayload();
    expect(store.workspaceGrid).toBeNull();
  });

  it("workspaceGrid returns the grid state when present", () => {
    const store = useAppStore();
    store.payload = makePayload({ workspaceGrid: { layout: "cols", cellWorkspaceIds: ["ws-A", "ws-B"] } });
    expect(store.workspaceGrid).toEqual({ layout: "cols", cellWorkspaceIds: ["ws-A", "ws-B"] });
  });

  it("isGridVisible is false when workspaceGrid is null", () => {
    const store = useAppStore();
    store.payload = makePayload();
    expect(store.isGridVisible).toBe(false);
  });

  it("isGridVisible is false when activeWorkspaceId is not in grid", () => {
    const store = useAppStore();
    store.payload = makePayload({
      workspaceGrid: { layout: "cols", cellWorkspaceIds: ["ws-B", "ws-C"] },
      activeWorkspaceId: "ws-A",
    });
    expect(store.isGridVisible).toBe(false);
  });

  it("isGridVisible is true when activeWorkspaceId is in grid", () => {
    const store = useAppStore();
    store.payload = makePayload({
      workspaceGrid: { layout: "cols", cellWorkspaceIds: ["ws-A", "ws-B"] },
      activeWorkspaceId: "ws-A",
    });
    expect(store.isGridVisible).toBe(true);
  });

  it("isGridVisible reacts to activeWorkspaceId changing into the grid", () => {
    const store = useAppStore();
    store.payload = makePayload({
      workspaceGrid: { layout: "cols", cellWorkspaceIds: ["ws-A", "ws-B"] },
      activeWorkspaceId: "ws-C",
    });
    expect(store.isGridVisible).toBe(false);

    store.payload = makePayload({
      workspaceGrid: { layout: "cols", cellWorkspaceIds: ["ws-A", "ws-B"] },
      activeWorkspaceId: "ws-A",
    });
    expect(store.isGridVisible).toBe(true);
  });

  it("isGridVisible reacts to activeWorkspaceId changing out of the grid", () => {
    const store = useAppStore();
    store.payload = makePayload({
      workspaceGrid: { layout: "cols", cellWorkspaceIds: ["ws-A", "ws-B"] },
      activeWorkspaceId: "ws-A",
    });
    expect(store.isGridVisible).toBe(true);

    store.payload = makePayload({
      workspaceGrid: { layout: "cols", cellWorkspaceIds: ["ws-A", "ws-B"] },
      activeWorkspaceId: "ws-D",
    });
    expect(store.isGridVisible).toBe(false);
  });

  it("focusedGridCellIndex returns -1 when grid is null", () => {
    const store = useAppStore();
    store.payload = makePayload();
    expect(store.focusedGridCellIndex).toBe(-1);
  });

  it("focusedGridCellIndex returns -1 when active ws not in grid", () => {
    const store = useAppStore();
    store.payload = makePayload({
      workspaceGrid: { layout: "cols", cellWorkspaceIds: ["ws-B", "ws-C"] },
      activeWorkspaceId: "ws-A",
    });
    expect(store.focusedGridCellIndex).toBe(-1);
  });

  it("focusedGridCellIndex returns the correct index", () => {
    const store = useAppStore();
    store.payload = makePayload({
      workspaceGrid: { layout: "grid", cellWorkspaceIds: ["ws-A", "ws-B", "ws-C", "ws-D"] },
      activeWorkspaceId: "ws-C",
    });
    expect(store.focusedGridCellIndex).toBe(2);
  });

  it("gridCellWorkspaces maps cellWorkspaceIds to workspace entries", () => {
    const store = useAppStore();
    store.payload = makePayload({
      workspaceGrid: { layout: "cols", cellWorkspaceIds: ["ws-A", null] },
    });
    const cells = store.gridCellWorkspaces;
    expect(cells).toHaveLength(2);
    expect(cells[0]).not.toBeNull();
    expect((cells[0] as AnyApi).id).toBe("ws-A");
    expect(cells[1]).toBeNull();
  });
});

// Regression: when a window is on a profile whose `workspaceGrid` is explicitly
// `null` (post-migration "no grid"), the top-level `appState.workspaceGrid`
// (which may reflect a different profile's grid) MUST NOT leak in. Otherwise
// the IN SPLIT sidebar section in profile A shows profile B's workspaces and
// clicks re-route activations into the wrong profile.
describe("workspace grid store — per-profile grid resolution", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    (window as AnyApi).strideterm = { startupFlags: { windowId: "test-win" } };
  });

  function makeMultiProfilePayload(overrides: AnyApi = {}): StatePayload {
    const profileId: string = overrides.activeProfileId ?? "other";
    return {
      appState: {
        workspaces: BASE_WORKSPACES,
        activeWorkspaceId: "ws-A",
        workspaceGrid: { layout: "cols", cellWorkspaceIds: ["ws-C", "ws-D"] },
        profiles: [
          { id: "current", name: "Current", color: "#fff", workspaceIds: [], workspaceGrid: null },
          {
            id: "other",
            name: "Other",
            color: "#fff",
            workspaceIds: [],
            workspaceGrid: { layout: "cols", cellWorkspaceIds: ["ws-C", "ws-D"] },
          },
        ],
        windowSlots: [
          {
            id: "test-win",
            profileId,
            activeWorkspaceId: "ws-A",
            activeSessionId: "",
            bounds: { x: 0, y: 0, width: 1280, height: 800 },
            lastFocusedAt: 0,
          },
        ],
        ...overrides,
      },
    } as AnyApi;
  }

  it("returns null for a profile whose workspaceGrid is explicitly null (does not leak global)", () => {
    const store = useAppStore();
    store.payload = makeMultiProfilePayload({ activeProfileId: "current" });
    // "current" profile has workspaceGrid: null; must NOT fall back to the global grid.
    expect(store.workspaceGrid).toBeNull();
  });

  it("returns the profile's grid when set (ignoring global)", () => {
    const store = useAppStore();
    store.payload = makeMultiProfilePayload({ activeProfileId: "other" });
    expect(store.workspaceGrid).toEqual({ layout: "cols", cellWorkspaceIds: ["ws-C", "ws-D"] });
  });

  it("falls back to the global only when the profile entry has no workspaceGrid field (pre-migration)", () => {
    const store = useAppStore();
    store.payload = {
      appState: {
        workspaces: BASE_WORKSPACES,
        activeWorkspaceId: "ws-A",
        workspaceGrid: { layout: "cols", cellWorkspaceIds: ["ws-A", "ws-B"] },
        // Profile entry omits `workspaceGrid` entirely — legacy compat path.
        profiles: [{ id: "legacy", name: "Legacy", color: "#fff", workspaceIds: [] }],
        windowSlots: [
          {
            id: "test-win",
            profileId: "legacy",
            activeWorkspaceId: "ws-A",
            activeSessionId: "",
            bounds: { x: 0, y: 0, width: 1280, height: 800 },
            lastFocusedAt: 0,
          },
        ],
      },
    } as AnyApi;
    expect(store.workspaceGrid).toEqual({ layout: "cols", cellWorkspaceIds: ["ws-A", "ws-B"] });
  });

  it("isGridVisible is false in a null-grid profile even if global has matching cells", () => {
    const store = useAppStore();
    store.payload = makeMultiProfilePayload({
      activeProfileId: "current",
      // ws-A is in the GLOBAL grid (and would make isGridVisible=true if the
      // fallback leaked) but it MUST NOT — "current" profile has no grid.
      workspaceGrid: { layout: "cols", cellWorkspaceIds: ["ws-A", "ws-B"] },
      activeWorkspaceId: "ws-A",
    });
    expect(store.isGridVisible).toBe(false);
  });
});

// The grid is viewer-owned: each desktop window renders its own slot's grid.
// Two windows of the same profile must not share layout state — the slot
// field wins over the legacy per-profile grid and the deprecated global.
describe("workspace grid store — per-window (viewer-owned) grid resolution", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    (window as AnyApi).strideterm = { startupFlags: { windowId: "win-1" } };
  });

  function makeTwoWindowPayload(): StatePayload {
    return {
      appState: {
        workspaces: BASE_WORKSPACES,
        activeWorkspaceId: "ws-A",
        workspaceGrid: { layout: "cols", cellWorkspaceIds: ["ws-C", "ws-D"] },
        profiles: [
          {
            id: "p1",
            name: "P1",
            color: "#fff",
            workspaceIds: ["ws-A", "ws-B", "ws-C", "ws-D"],
            workspaceGrid: { layout: "cols", cellWorkspaceIds: ["ws-C", "ws-D"] },
          },
        ],
        windowSlots: [
          {
            id: "win-1",
            profileId: "p1",
            activeWorkspaceId: "ws-A",
            activeSessionId: "",
            workspaceGrid: { layout: "cols", cellWorkspaceIds: ["ws-A", "ws-B"] },
          },
          {
            id: "win-2",
            profileId: "p1",
            activeWorkspaceId: "ws-C",
            activeSessionId: "",
            workspaceGrid: { layout: "cols", cellWorkspaceIds: ["ws-C", "ws-D"] },
          },
        ],
      },
    } as AnyApi;
  }

  it("reads this window's slot grid, not the sibling window's or the profile grid", () => {
    const store = useAppStore();
    store.payload = makeTwoWindowPayload();
    expect(store.workspaceGrid).toEqual({ layout: "cols", cellWorkspaceIds: ["ws-A", "ws-B"] });
  });

  it("slot grid explicitly null does not fall back to the profile/global grid", () => {
    const store = useAppStore();
    const payload = makeTwoWindowPayload() as AnyApi;
    payload.appState.windowSlots[0].workspaceGrid = null;
    store.payload = payload;
    expect(store.workspaceGrid).toBeNull();
  });

  it("remote client reads its own grid from remoteClient, not desktop slots", () => {
    const store = useAppStore();
    store.init(
      makeApi({
        isRemote: true,
        getState: vi.fn(() => new Promise(() => undefined)),
      }) as AnyApi,
    );
    const payload = makeTwoWindowPayload() as AnyApi;
    payload.remoteClient = {
      id: "remote-1",
      profileId: "p1",
      activeWorkspaceId: "ws-D",
      activeSessionId: "",
      workspaceGrid: { layout: "cols", cellWorkspaceIds: ["ws-D", null] },
    };
    store.payload = payload;
    expect(store.workspaceGrid).toEqual({ layout: "cols", cellWorkspaceIds: ["ws-D", null] });
  });
});

describe("app store — multi-window payload scoping", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    (window as AnyApi).strideterm = { startupFlags: { windowId: "win-a" } };
  });

  it("keeps this window rendered on its slot workspace when another window activates a different workspace", async () => {
    let onStateUpdated: ((_payload: StatePayload) => void) | null = null;
    const api = makeApi({
      onStateUpdated: vi.fn((cb: (_payload: StatePayload) => void) => {
        onStateUpdated = cb;
      }),
      getState: vi.fn(() => new Promise(() => undefined)),
    });
    const store = useAppStore();
    store.init(api as AnyApi);
    store.payload = {
      appState: {
        activeWorkspaceId: "ws-A",
        activeProfileId: "default",
        workspaces: [
          {
            id: "ws-A",
            name: "Alpha",
            cwd: "/a",
            profileId: "default",
            panels: [{ id: "shell-a", title: "Shell A", command: "", shell: true, startup: "default" }],
            activePanelId: "shell-a",
          },
          {
            id: "ws-B",
            name: "Beta",
            cwd: "/b",
            profileId: "default",
            panels: [{ id: "shell-b", title: "Shell B", command: "", shell: true, startup: "default" }],
            activePanelId: "shell-b",
          },
        ],
        windowSlots: [
          { id: "win-a", profileId: "default", activeWorkspaceId: "ws-A" },
          { id: "win-b", profileId: "default", activeWorkspaceId: "ws-B" },
        ],
      },
      workspace: {
        workspace: {
          id: "ws-A",
          name: "Alpha",
          cwd: "/a",
          panels: [{ id: "shell-a", title: "Shell A", command: "", shell: true, startup: "default" }],
          activePanelId: "shell-a",
        },
        project: {
          id: "ws-A",
          name: "Alpha",
          cwd: "/a",
          panels: [{ id: "shell-a", title: "Shell A", command: "", shell: true, startup: "default" }],
          activePanelId: "shell-a",
        },
        sessions: [{ sessionId: "ws-A:shell-a", panelId: "shell-a", title: "Shell A", status: "idle" }],
      },
    } as AnyApi;

    expect(onStateUpdated).not.toBeNull();
    (onStateUpdated as unknown as (_payload: StatePayload) => void)({
      appState: {
        ...(store.payload as AnyApi).appState,
        activeWorkspaceId: "ws-B",
      },
      workspace: {
        workspace: {
          id: "ws-B",
          name: "Beta",
          cwd: "/b",
          panels: [{ id: "shell-b", title: "Shell B", command: "", shell: true, startup: "default" }],
          activePanelId: "shell-b",
        },
        project: {
          id: "ws-B",
          name: "Beta",
          cwd: "/b",
          panels: [{ id: "shell-b", title: "Shell B", command: "", shell: true, startup: "default" }],
          activePanelId: "shell-b",
        },
        sessions: [{ sessionId: "ws-B:shell-b", panelId: "shell-b", title: "Shell B", status: "idle" }],
      },
    } as AnyApi);
    await Promise.resolve();

    expect(store.myActiveWorkspaceId).toBe("ws-A");
    expect(store.activeWorkspace?.id).toBe("ws-A");
    expect(store.workspaceTabs.map((tab: AnyApi) => tab.id)).toEqual(["ws-A:shell-a"]);
  });

  it.each([
    ["azure", "azure:az-1"],
    ["github", "github:gh-1"],
  ])("forces the canonical %s inbox view id after activation", async (kind, expectedViewId) => {
    const workspaceId = kind === "azure" ? "az-1" : "gh-1";
    const nextPayload = {
      appState: {
        activeWorkspaceId: workspaceId,
        activeProfileId: "default",
        workspaces: [
          {
            id: workspaceId,
            name: kind,
            kind,
            cwd: "",
            profileId: "default",
            panels: [{ id: "legacy-panel", title: "Legacy", command: "", shell: true, startup: "default" }],
            activePanelId: "legacy-panel",
          },
        ],
      },
      workspace: {
        workspace: {
          id: workspaceId,
          name: kind,
          kind,
          panels: [{ id: "legacy-panel", title: "Legacy", command: "", shell: true, startup: "default" }],
          activePanelId: "legacy-panel",
        },
        project: {
          id: workspaceId,
          name: kind,
          kind,
          panels: [{ id: "legacy-panel", title: "Legacy", command: "", shell: true, startup: "default" }],
          activePanelId: "legacy-panel",
        },
        sessions: [],
      },
    };
    const api = makeApi({ activateWorkspace: vi.fn(async () => nextPayload) });
    const store = useAppStore();
    store.init(api as AnyApi);
    store.payload = makePayload({
      workspaces: nextPayload.appState.workspaces,
      activeWorkspaceId: workspaceId,
    });

    await store.activateWorkspace(workspaceId);

    expect(store.activeViewId).toBe(expectedViewId);
    expect(store.activeSessionId).toBeNull();
  });
});

describe("workspace grid store — actions", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    delete (window as AnyApi).strideterm;
  });

  it("enableWorkspaceGrid defaults to [activeWorkspaceId, null, null, null] when no preset given", async () => {
    const api = makeApi();
    const store = useAppStore();
    store.init(api as AnyApi);
    store.payload = makePayload({ activeWorkspaceId: "ws-A" });

    await store.enableWorkspaceGrid("cols");
    expect(api.enableWorkspaceGrid).toHaveBeenCalledWith("cols", ["ws-A", null, null, null]);
  });

  it("enableWorkspaceGrid passes preset workspaceIds to api", async () => {
    const api = makeApi();
    const store = useAppStore();
    store.init(api as AnyApi);
    store.payload = makePayload({ activeWorkspaceId: "ws-A" });

    await store.enableWorkspaceGrid("grid", { workspaceIds: ["ws-A", "ws-B", null, null] });
    expect(api.enableWorkspaceGrid).toHaveBeenCalledWith("grid", ["ws-A", "ws-B", null, null]);
  });

  it("disableWorkspaceGrid calls api.disableWorkspaceGrid", async () => {
    const api = makeApi();
    const store = useAppStore();
    store.init(api as AnyApi);
    store.payload = makePayload();

    await store.disableWorkspaceGrid();
    expect(api.disableWorkspaceGrid).toHaveBeenCalled();
  });

  it("setGridLayout calls api.setGridLayout with new layout", async () => {
    const api = makeApi();
    const store = useAppStore();
    store.init(api as AnyApi);
    store.payload = makePayload();

    await store.setGridLayout("rows");
    expect(api.setGridLayout).toHaveBeenCalledWith("rows");
  });

  it("setGridLayout pre-empts truncation by re-anchoring active before shrink", async () => {
    // Backend setGridLayout truncates cellWorkspaceIds to the new slot count.
    // If the active workspace is in a cell that won't survive (e.g. cell 3 of
    // a 4-cell grid going to cols/2), it would end up not-in-grid and the
    // grid would vanish. The wrapper switches active to the first kept
    // workspace before forwarding to the IPC.
    const api = makeApi();
    const store = useAppStore();
    store.init(api as AnyApi);
    store.payload = makePayload({
      workspaceGrid: { layout: "grid", cellWorkspaceIds: ["ws-A", "ws-B", "ws-C", "ws-D"] },
      activeWorkspaceId: "ws-D",
    });

    await store.setGridLayout("cols");

    expect(api.activateWorkspace).toHaveBeenCalledWith("ws-A");
    expect(api.setGridLayout).toHaveBeenCalledWith("cols");
  });

  it("setGridLayout does not re-anchor if active workspace survives truncation", async () => {
    const api = makeApi();
    const store = useAppStore();
    store.init(api as AnyApi);
    store.payload = makePayload({
      workspaceGrid: { layout: "grid", cellWorkspaceIds: ["ws-A", "ws-B", "ws-C", "ws-D"] },
      activeWorkspaceId: "ws-A",
    });

    await store.setGridLayout("cols");

    expect(api.activateWorkspace).not.toHaveBeenCalled();
    expect(api.setGridLayout).toHaveBeenCalledWith("cols");
  });

  it("setGridCell calls api.setGridCell with cellIndex and workspaceId", async () => {
    const api = makeApi();
    const store = useAppStore();
    store.init(api as AnyApi);
    store.payload = makePayload();

    await store.setGridCell(1, "ws-B");
    expect(api.setGridCell).toHaveBeenCalledWith(1, "ws-B");
  });

  it("setGridCell with null clears the cell via api", async () => {
    const api = makeApi();
    const store = useAppStore();
    store.init(api as AnyApi);
    store.payload = makePayload();

    await store.setGridCell(0, null);
    expect(api.setGridCell).toHaveBeenCalledWith(0, null);
  });

  it("swapGridCells calls api.swapGridCells with indices a and b", async () => {
    const api = makeApi();
    const store = useAppStore();
    store.init(api as AnyApi);
    store.payload = makePayload();

    await store.swapGridCells(0, 2);
    expect(api.swapGridCells).toHaveBeenCalledWith(0, 2);
  });
});

describe("workspace grid store — activateWorkspaceInGrid", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("when grid is not visible, just delegates to activateWorkspace (no setGridCell)", async () => {
    const api = makeApi();
    const store = useAppStore();
    store.init(api as AnyApi);
    store.payload = makePayload({ workspaceGrid: null, activeWorkspaceId: "ws-A" });

    await store.activateWorkspaceInGrid("ws-B");

    expect(api.setGridCell).not.toHaveBeenCalled();
    expect(api.activateWorkspace).toHaveBeenCalledWith("ws-B");
  });

  it("when target is already in grid, just activates (no cell mutation)", async () => {
    const api = makeApi();
    const store = useAppStore();
    store.init(api as AnyApi);
    store.payload = makePayload({
      workspaceGrid: { layout: "cols", cellWorkspaceIds: ["ws-A", "ws-B"] },
      activeWorkspaceId: "ws-A",
    });

    await store.activateWorkspaceInGrid("ws-B");

    expect(api.setGridCell).not.toHaveBeenCalled();
    expect(api.activateWorkspace).toHaveBeenCalledWith("ws-B");
  });

  it("when grid visible and target not in grid, replaces focused cell first", async () => {
    const api = makeApi();
    const store = useAppStore();
    store.init(api as AnyApi);
    store.payload = makePayload({
      workspaceGrid: { layout: "cols", cellWorkspaceIds: ["ws-A", "ws-B"] },
      activeWorkspaceId: "ws-A",
    });

    await store.activateWorkspaceInGrid("ws-C");

    expect(api.setGridCell).toHaveBeenCalledWith(0, "ws-C");
    expect(api.activateWorkspace).toHaveBeenCalledWith("ws-C");
  });

  it("when grid visible and target not in grid, prefers first empty cell over evicting focused", async () => {
    const api = makeApi();
    const store = useAppStore();
    store.init(api as AnyApi);
    store.payload = makePayload({
      workspaceGrid: { layout: "grid", cellWorkspaceIds: ["ws-A", null, null, null] },
      activeWorkspaceId: "ws-A",
    });

    await store.activateWorkspaceInGrid("ws-D");

    expect(api.setGridCell).toHaveBeenCalledWith(1, "ws-D");
  });

  it("when grid is full and target not in grid, replaces focused cell", async () => {
    const api = makeApi();
    const store = useAppStore();
    store.init(api as AnyApi);
    store.payload = makePayload({
      workspaceGrid: { layout: "grid", cellWorkspaceIds: ["ws-A", "ws-B", "ws-C", "ws-D"] },
      activeWorkspaceId: "ws-C",
    });

    await store.activateWorkspaceInGrid("ws-X");

    expect(api.setGridCell).toHaveBeenCalledWith(2, "ws-X");
  });
});

describe("workspace grid store — profile switch restores grid", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    (window as AnyApi).strideterm = { startupFlags: { windowId: "win-1" } };
  });

  const p1Grid = { columns: 2, rows: 1, cellWorkspaceIds: ["ws-A", "ws-B"], focusedCellIndex: 1 };

  function makeProfilePayload(activeProfileId: string): StatePayload {
    return {
      appState: {
        workspaces: BASE_WORKSPACES,
        activeWorkspaceId: activeProfileId === "p1" ? "ws-B" : "ws-C",
        workspaceGrid: null,
        profiles: [
          { id: "p1", name: "P1", color: "#fff", workspaceIds: ["ws-A", "ws-B"], workspaceGrid: p1Grid },
          { id: "p2", name: "P2", color: "#fff", workspaceIds: ["ws-C"], workspaceGrid: null },
        ],
        windowSlots: [
          {
            id: "win-1",
            profileId: activeProfileId,
            activeWorkspaceId: activeProfileId === "p1" ? "ws-B" : "ws-C",
            activeSessionId: "",
          },
        ],
      },
    } as AnyApi;
  }

  it("switching profile back restores the original grid layout and focused workspace", () => {
    const store = useAppStore();

    // Start on profile p1 (has grid with ws-A / ws-B, ws-B focused)
    store.payload = makeProfilePayload("p1");
    expect(store.workspaceGrid?.cellWorkspaceIds).toEqual(["ws-A", "ws-B"]);
    expect(store.workspaceGrid?.focusedCellIndex).toBe(1);
    expect(store.myActiveWorkspaceId).toBe("ws-B");

    // Switch to profile p2 (no grid)
    store.payload = makeProfilePayload("p2");
    expect(store.workspaceGrid).toBeNull();

    // Switch back to profile p1 — grid and focused workspace must be restored
    store.payload = makeProfilePayload("p1");
    expect(store.workspaceGrid?.cellWorkspaceIds).toEqual(["ws-A", "ws-B"]);
    expect(store.workspaceGrid?.focusedCellIndex).toBe(1);
    expect(store.myActiveWorkspaceId).toBe("ws-B");
  });
});
