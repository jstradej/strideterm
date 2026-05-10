import { describe, it, expect, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import SidebarPanel from "./SidebarPanel.vue";
import { useAppStore } from "../../stores/app.js";
import type { StatePayload } from "../../../electron/shared/types/state.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApi = any;

const BASE_WORKSPACES = [
  { id: "ws-A", name: "Alpha", cwd: "/a", panels: [], icon: "A", color: "#fff", profileId: "default" },
  { id: "ws-B", name: "Beta", cwd: "/b", panels: [], icon: "B", color: "#fff", profileId: "default" },
  { id: "ws-C", name: "Gamma", cwd: "/c", panels: [], icon: "C", color: "#fff", profileId: "default" },
  { id: "ws-D", name: "Delta", cwd: "/d", panels: [], icon: "D", color: "#fff", profileId: "default" },
];

function makePayload(appStateOverrides: AnyApi = {}): StatePayload {
  return {
    appState: {
      workspaces: BASE_WORKSPACES,
      activeWorkspaceId: "ws-A",
      activeProfileId: "default",
      profiles: [{ id: "default", name: "Default" }],
      workspaceGrid: null,
      ...appStateOverrides,
    },
  } as AnyApi;
}

describe("SidebarPanel — ghost rendering for grid workspaces", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("renders all workspaces in tree when grid is empty (no ghosts)", () => {
    const store = useAppStore();
    store.payload = makePayload({ workspaceGrid: null });

    const wrapper = mount(SidebarPanel);
    const ghosts = wrapper.findAll(".workspace-card--in-grid");
    expect(ghosts.length).toBe(0);

    // All four workspaces visible in the tree.
    const cards = wrapper.findAll("[data-workspace-id]");
    expect(cards.length).toBe(4);
  });

  it("keeps a grid workspace visible in the tree as a dimmed ghost (preserves parent/child)", () => {
    const store = useAppStore();
    store.payload = makePayload({
      workspaceGrid: { layout: "cols", cellWorkspaceIds: ["ws-A", "ws-B"] },
      activeWorkspaceId: "ws-A",
    });

    const wrapper = mount(SidebarPanel);

    // Tree (the second WorkspaceCard for ws-A and ws-B, after the split-group).
    // ws-A and ws-B should appear inside the regular tree with --in-grid class,
    // not be filtered out — the whole point of the ghost design.
    const tree = wrapper.find('[data-role="workspace-list"]');
    const treeGhosts = tree.findAll(
      ".workspace-card--in-grid:not(.workspace-list__split-group .workspace-card--in-grid)",
    );
    // jsdom doesn't always honour the :not() with descendant — fall back to
    // counting cards by data attribute + class manually.
    const allInGrid = wrapper.findAll(".workspace-card--in-grid");
    // Two grid workspaces × two render sites (split-group + tree ghost) = 4 cards
    // with the in-grid class.
    expect(allInGrid.length).toBe(4);

    // The split-group section is rendered.
    expect(wrapper.find(".workspace-list__split-group").exists()).toBe(true);

    // Sanity: treeGhosts is informational; the absolute count above already
    // verifies presence in tree.
    void treeGhosts;
  });

  it("ghost in tree carries the correct slot index", () => {
    const store = useAppStore();
    store.payload = makePayload({
      workspaceGrid: { layout: "grid", cellWorkspaceIds: ["ws-A", "ws-B", "ws-C", "ws-D"] },
      activeWorkspaceId: "ws-A",
    });

    const wrapper = mount(SidebarPanel);

    const slotBadges = wrapper.findAll(".workspace-card__slot");
    // Each grid workspace renders twice (split-group + tree ghost) and each
    // instance shows the slot index, so 4 grid workspaces → 8 slot badges.
    expect(slotBadges.length).toBe(8);

    // The slot index numerals across all instances should cover 1..4.
    const numerals = slotBadges.map((b) => b.text()).sort();
    expect(numerals).toEqual(["1", "1", "2", "2", "3", "3", "4", "4"]);
  });

  it("workspaces not in grid have no in-grid class and no slot index", () => {
    const store = useAppStore();
    store.payload = makePayload({
      workspaceGrid: { layout: "cols", cellWorkspaceIds: ["ws-A", "ws-B"] },
      activeWorkspaceId: "ws-A",
    });

    const wrapper = mount(SidebarPanel);

    // ws-C and ws-D are not in any grid cell. They render once each in the
    // tree (no split-group entry) and have neither --in-grid class nor a
    // slot badge.
    const cardsC = wrapper.findAll('[data-workspace-id="ws-C"]');
    const cardsD = wrapper.findAll('[data-workspace-id="ws-D"]');
    expect(cardsC.length).toBe(1);
    expect(cardsD.length).toBe(1);
    expect(cardsC[0].classes()).not.toContain("workspace-card--in-grid");
    expect(cardsD[0].classes()).not.toContain("workspace-card--in-grid");
    expect(cardsC[0].find(".workspace-card__slot").exists()).toBe(false);
  });
});
