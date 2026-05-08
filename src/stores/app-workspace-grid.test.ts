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

  it("enableWorkspaceGrid calls api.enableWorkspaceGrid with layout and ids", async () => {
    const api = makeApi();
    const store = useAppStore();
    store.init(api as AnyApi);
    store.payload = makePayload();

    await store.enableWorkspaceGrid("cols");
    expect(api.enableWorkspaceGrid).toHaveBeenCalledWith("cols", undefined);
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
