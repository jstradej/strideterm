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

describe("workspace grid store — actions", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
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
