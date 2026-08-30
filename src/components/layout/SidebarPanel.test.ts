import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { nextTick } from "vue";
import { createPinia, setActivePinia } from "pinia";
import SidebarPanel from "./SidebarPanel.vue";
import { useAppStore } from "../../stores/app.js";
import { useNotificationStore } from "../../stores/notifications.js";
import type { StatePayload } from "../../../electron/shared/types/state.js";
import { apiKey } from "../../types/keys.js";

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
      windowSlots: [{ id: "win-test", profileId: "default", activeWorkspaceId: "ws-A" }],
      ...appStateOverrides,
    },
  } as AnyApi;
}

describe("SidebarPanel — ghost rendering for grid workspaces", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    (window as AnyApi).strideterm = { startupFlags: { windowId: "win-test" } };
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

  it("renders split-group cards without inherited child indentation", () => {
    const store = useAppStore();
    store.payload = makePayload({
      workspaces: [BASE_WORKSPACES[0], { ...BASE_WORKSPACES[1], name: "Alpha / branch", notes: "Worktree of Alpha" }],
      workspaceGrid: { layout: "cols", cellWorkspaceIds: ["ws-A", "ws-B"] },
      activeWorkspaceId: "ws-A",
    });

    const wrapper = mount(SidebarPanel);

    const splitChild = wrapper.find('.workspace-list__split-group [data-workspace-id="ws-B"]');
    const treeChild = wrapper.find('[data-role="workspace-list"] > [data-workspace-id="ws-B"]');
    expect(splitChild.classes()).not.toContain("workspace-card--sub");
    expect(treeChild.classes()).toContain("workspace-card--sub");
  });
});

describe("SidebarPanel — workspace name filter", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    (window as AnyApi).strideterm = { startupFlags: { windowId: "win-test" } };
  });

  it("keeps only workspaces whose name contains the query (case-insensitive substring)", () => {
    const store = useAppStore();
    store.payload = makePayload();
    store.workspaceSearchQuery = "ET";

    const wrapper = mount(SidebarPanel);
    const cards = wrapper.findAll("[data-workspace-id]");
    // "Beta" matches mid-name and case-insensitively; Alpha / Gamma / Delta do not.
    expect(cards.map((card) => card.attributes("data-workspace-id"))).toEqual(["ws-B"]);
  });

  it("keeps the parent visible when only a child matches", () => {
    const store = useAppStore();
    store.payload = makePayload({
      workspaces: [
        ...BASE_WORKSPACES,
        {
          id: "ws-E",
          name: "Mobile task",
          cwd: "/e",
          panels: [],
          icon: "E",
          color: "#fff",
          profileId: "default",
          task: { parentWorkspaceId: "ws-A" },
        },
      ],
    });
    store.workspaceSearchQuery = "mobile";

    const wrapper = mount(SidebarPanel);
    const cards = wrapper.findAll("[data-workspace-id]");
    expect(cards.map((card) => card.attributes("data-workspace-id"))).toEqual(["ws-A", "ws-E"]);
  });

  it("shows a no-match hint when nothing matches", () => {
    const store = useAppStore();
    store.payload = makePayload();
    store.workspaceSearchQuery = "zzz";

    const wrapper = mount(SidebarPanel);
    expect(wrapper.findAll("[data-workspace-id]").length).toBe(0);
    expect(wrapper.find(".workspace-list__no-match").exists()).toBe(true);
  });

  it("renders every workspace again once the query is cleared", async () => {
    const store = useAppStore();
    store.payload = makePayload();
    store.workspaceSearchQuery = "alpha";

    const wrapper = mount(SidebarPanel);
    expect(wrapper.findAll("[data-workspace-id]").length).toBe(1);

    store.workspaceSearchQuery = "";
    await nextTick();
    expect(wrapper.findAll("[data-workspace-id]").length).toBe(4);
  });
});

describe("SidebarPanel — multi-window active state", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    (window as AnyApi).strideterm = { startupFlags: { windowId: "win-a" } };
  });

  it("highlights this window's slot workspace instead of the global last-active workspace", () => {
    const store = useAppStore();
    store.payload = makePayload({
      activeWorkspaceId: "ws-B",
      windowSlots: [
        { id: "win-a", profileId: "default", activeWorkspaceId: "ws-A" },
        { id: "win-b", profileId: "default", activeWorkspaceId: "ws-B" },
      ],
    });

    const wrapper = mount(SidebarPanel);

    expect(wrapper.find('[data-workspace-id="ws-A"]').classes()).toContain("workspace-card--active");
    expect(wrapper.find('[data-workspace-id="ws-B"]').classes()).not.toContain("workspace-card--active");
  });
});

describe("SidebarPanel — workspace activate emits immediately (mobile sidebar close)", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    (window as AnyApi).strideterm = { startupFlags: { windowId: "win-test" } };
  });

  it("emits 'activate' before store.activateWorkspace resolves", async () => {
    const store = useAppStore();
    store.payload = makePayload();

    // Never-resolving promise so we can check ordering synchronously.
    let activateStarted = false;
    vi.spyOn(store, "activateWorkspace").mockImplementation(async () => {
      activateStarted = true;
      await new Promise(() => {}); // never resolves
    });

    const wrapper = mount(SidebarPanel, { attachTo: document.body });

    // Click on workspace ws-B (not the active one) to trigger onActivate.
    await wrapper.find('[data-workspace-id="ws-B"]').trigger("click");

    // The 'activate' event must have been emitted even though activateWorkspace is still pending.
    expect(activateStarted).toBe(true);
    const emitted = wrapper.emitted("activate");
    expect(emitted).toBeTruthy();
    expect(emitted![0]).toEqual(["ws-B"]);

    // Unmount to clean up Teleport content from document.body.
    wrapper.unmount();
  });
});

describe("SidebarPanel — workspace activate loading overlay", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    (window as AnyApi).strideterm = { startupFlags: { windowId: "win-test" } };
  });

  it("shows loading overlay while activateWorkspace is pending, hides it after resolve", async () => {
    const store = useAppStore();
    store.payload = makePayload();

    let resolveActivate!: () => void;
    vi.spyOn(store, "activateWorkspace").mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveActivate = resolve;
        }),
    );

    const wrapper = mount(SidebarPanel, { attachTo: document.body });

    await wrapper.find('[data-workspace-id="ws-B"]').trigger("click");

    // Overlay must be present in the document while activation is pending.
    expect(document.querySelector(".ws-activate-overlay")).not.toBeNull();

    // Resolve activation — overlay must disappear after the promise chain settles.
    resolveActivate();
    await flushPromises();
    await nextTick();
    expect(document.querySelector(".ws-activate-overlay")).toBeNull();

    wrapper.unmount();
  });
});

describe("SidebarPanel — workspace activate failure surfaces a toast", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    window.localStorage.removeItem("strideterm-notifications-v2");
    (window as AnyApi).strideterm = { startupFlags: { windowId: "win-test" } };
  });

  it("shows an error toast and clears the loading overlay when activateWorkspace rejects", async () => {
    const store = useAppStore();
    store.payload = makePayload();
    vi.spyOn(store, "activateWorkspace").mockRejectedValueOnce(new Error("workspace missing"));

    const wrapper = mount(SidebarPanel, { attachTo: document.body });

    await wrapper.find('[data-workspace-id="ws-B"]').trigger("click");
    await flushPromises();

    const notifications = useNotificationStore();
    expect(notifications.sessions).toHaveLength(1);
    expect(notifications.sessions[0].events[0].title).toBe("Activate workspace failed");
    expect(notifications.sessions[0].events[0].body).toBe("workspace missing");

    // Loading overlay must clear even though activation failed.
    expect(document.querySelector(".ws-activate-overlay")).toBeNull();

    wrapper.unmount();
  });
});

describe("SidebarPanel — detach from PR review menu entry", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    (window as AnyApi).strideterm = { startupFlags: { windowId: "win-test" } };
  });

  function menuItemLabels(): string[] {
    return [...document.querySelectorAll(".context-menu .context-menu__item")].map((el) =>
      (el.textContent || "").trim(),
    );
  }

  async function openMenuFor(wrapper: AnyApi, workspaceId: string): Promise<void> {
    await wrapper.find(`[data-workspace-id="${workspaceId}"] .workspace-card__action--menu`).trigger("click");
    await nextTick();
  }

  it("offers detach for a PR-linked workspace and hides it for a plain one", async () => {
    const store = useAppStore();
    store.payload = makePayload({
      workspaces: [
        // Attached to a PR as the author — GitPane treats author links as
        // unlocked, so the Git tab shows no detach banner for this one.
        {
          ...BASE_WORKSPACES[0],
          review: {
            provider: "azure-devops",
            prKey: "ado-main:repo-1:29456",
            role: "author",
            checkout: { mode: "linked-existing-workspace", rootPath: "/a", cacheRepoPath: "" },
          },
        },
        BASE_WORKSPACES[1],
      ],
    });

    const wrapper = mount(SidebarPanel, { attachTo: document.body });

    await openMenuFor(wrapper, "ws-A");
    expect(menuItemLabels()).toContain("🔗 Detach from PR review");

    // "✎ Edit" is unconditional, so asserting on it proves the menu really
    // reopened for ws-B rather than the detach entry being absent because the
    // whole menu was dismissed.
    await openMenuFor(wrapper, "ws-B");
    expect(menuItemLabels()).toContain("✎ Edit");
    expect(menuItemLabels()).not.toContain("🔗 Detach from PR review");

    wrapper.unmount();
  });

  it("detaches only after the confirm is accepted", async () => {
    const store = useAppStore();
    store.payload = makePayload({
      workspaces: [
        { ...BASE_WORKSPACES[0], review: { provider: "azure-devops", prKey: "ado-main:repo-1:29456" } },
        BASE_WORKSPACES[1],
      ],
    });
    const detach = vi.spyOn(store, "detachWorkspaceReview").mockResolvedValue(undefined);
    const confirm = vi.spyOn(store, "confirmInApp").mockResolvedValue(false);

    const wrapper = mount(SidebarPanel, { attachTo: document.body });
    await openMenuFor(wrapper, "ws-A");

    const detachButton = [...document.querySelectorAll(".context-menu .context-menu__item")].find((el) =>
      (el.textContent || "").includes("Detach from PR review"),
    ) as HTMLElement;
    detachButton.click();
    await flushPromises();

    expect(confirm).toHaveBeenCalled();
    expect(detach).not.toHaveBeenCalled();

    // Accepting the confirm goes through to the store action.
    confirm.mockResolvedValue(true);
    await openMenuFor(wrapper, "ws-A");
    (
      [...document.querySelectorAll(".context-menu .context-menu__item")].find((el) =>
        (el.textContent || "").includes("Detach from PR review"),
      ) as HTMLElement
    ).click();
    await flushPromises();

    expect(detach).toHaveBeenCalledWith("ws-A");

    wrapper.unmount();
  });
});

describe("SidebarPanel — remote profile fallback", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    (window as AnyApi).strideterm = { startupFlags: { windowId: "" } };
  });

  it("renders first real profile workspaces when remoteClient profile id is stale", async () => {
    const store = useAppStore();
    const payload = makePayload({
      profiles: [
        { id: "default", name: "Default 2" },
        { id: "profile-asdf", name: "asdf" },
      ],
      workspaces: [
        {
          id: "ws-default-1",
          name: "temp",
          cwd: "/tmp",
          panels: [{ id: "p1", title: "Shell" }],
          icon: "PR",
          color: "#fff",
          profileId: "default",
        },
        {
          id: "ws-default-2",
          name: "GitHub",
          cwd: "/tmp/gh",
          panels: [],
          icon: "GH",
          color: "#fff",
          profileId: "default",
          kind: "github",
        },
        {
          id: "ws-asdf-1",
          name: "test",
          cwd: "/tmp/test",
          panels: [],
          icon: "T",
          color: "#fff",
          profileId: "profile-asdf",
        },
      ],
      windowSlots: [{ id: "desktop-win", profileId: "default", activeWorkspaceId: "ws-default-1" }],
    }) as AnyApi;
    payload.remoteClient = {
      id: "mobile-session",
      profileId: "deleted-profile",
      activeWorkspaceId: "",
      activeSessionId: "",
    };
    const transport = {
      isRemote: true,
      getState: vi.fn(() => Promise.resolve(payload)),
      onStateUpdated: vi.fn(),
      onConnectionState: vi.fn(),
      activateWorkspace: vi.fn(() => Promise.resolve(payload)),
      activateProfile: vi.fn(() => Promise.resolve(payload)),
      activateSession: vi.fn(() => Promise.resolve(payload)),
    };
    store.init(transport as AnyApi);
    await Promise.resolve();
    await Promise.resolve();

    const wrapper = mount(SidebarPanel);

    const cards = wrapper.findAll("[data-workspace-id]");
    expect(cards.map((card) => card.attributes("data-workspace-id"))).toEqual(["ws-default-1", "ws-default-2"]);
    expect(wrapper.text()).toContain("temp");
    expect(wrapper.text()).toContain("GitHub");
    expect(wrapper.text()).not.toContain("test");
  });

  it("clears stale starred-only filter immediately when the active profile has no starred workspaces", async () => {
    const store = useAppStore();
    const payload = makePayload({
      profiles: [{ id: "default", name: "Default 2" }],
      workspaces: [
        { id: "ws-default-1", name: "temp", cwd: "/tmp", panels: [], icon: "PR", color: "#fff", profileId: "default" },
        {
          id: "ws-default-2",
          name: "GitHub",
          cwd: "/tmp/gh",
          panels: [],
          icon: "GH",
          color: "#fff",
          profileId: "default",
        },
      ],
      windowSlots: [{ id: "desktop-win", profileId: "default", activeWorkspaceId: "ws-default-1" }],
    }) as AnyApi;
    payload.remoteClient = {
      id: "mobile-session",
      profileId: "default",
      activeWorkspaceId: "ws-default-1",
      activeSessionId: "",
    };
    const transport = {
      isRemote: true,
      getState: vi.fn(() => Promise.resolve(payload)),
      onStateUpdated: vi.fn(),
      onConnectionState: vi.fn(),
      activateWorkspace: vi.fn(() => Promise.resolve(payload)),
      activateProfile: vi.fn(() => Promise.resolve(payload)),
      activateSession: vi.fn(() => Promise.resolve(payload)),
    };
    store.starFilterActive = true;
    store.init(transport as AnyApi);
    await Promise.resolve();
    await Promise.resolve();

    const wrapper = mount(SidebarPanel);

    expect(store.starFilterActive).toBe(false);
    expect(wrapper.findAll("[data-workspace-id]").map((card) => card.attributes("data-workspace-id"))).toEqual([
      "ws-default-1",
      "ws-default-2",
    ]);
  });
});

// V2 plan, Fáze 5 — the sidebar's recent mode is now "compact shortcuts on
// top of the untouched canonical tree", not a separate, time-bucketed
// replacement for it. Tree mode is unchanged; recent mode ADDS a section.
describe("SidebarPanel — recently worked shortcuts", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    (window as AnyApi).strideterm = { startupFlags: { windowId: "win-test" } };
  });

  const MINUTE = 60 * 1000;

  function recentPayload(overrides: AnyApi = {}): StatePayload {
    return makePayload({
      profiles: [{ id: "default", name: "Default", sidebarWorkspaceViewMode: "recent" }],
      ...overrides,
    });
  }

  /** BASE_WORKSPACES with a `lastWorkedAt` on the first `count` of them. */
  function workedWorkspaces(count: number, now = Date.now()): AnyApi[] {
    return BASE_WORKSPACES.map((ws, i) =>
      i < count ? { ...ws, lastWorkedAt: new Date(now - (i + 1) * MINUTE).toISOString() } : { ...ws },
    );
  }

  /** N synthetic workspaces, each worked in one minute further back. */
  function manyWorked(count: number, now = Date.now()): AnyApi[] {
    return Array.from({ length: count }, (_, i) => ({
      id: `ws-${i}`,
      name: `Workspace ${i}`,
      cwd: `/w${i}`,
      panels: [],
      icon: "W",
      color: "#fff",
      profileId: "default",
      lastWorkedAt: new Date(now - (i + 1) * MINUTE).toISOString(),
    }));
  }

  /** Minimal DataTransfer stand-in that actually round-trips setData/getData. */
  function makeDataTransfer(): AnyApi {
    const store = new Map<string, string>();
    return {
      effectAllowed: "",
      dropEffect: "",
      setData: (key: string, value: string) => store.set(key, value),
      getData: (key: string) => store.get(key) || "",
    };
  }

  function recentIds(wrapper: AnyApi): string[] {
    return wrapper
      .findAll('.recent-shortcuts [data-role="activity-node-row"]')
      .map((row: AnyApi) => row.attributes("data-workspace-id"));
  }

  function treeIds(wrapper: AnyApi): string[] {
    return wrapper
      .findAll('[data-role="workspace-list"] > .workspace-card[data-workspace-id]')
      .map((card: AnyApi) => card.attributes("data-workspace-id"));
  }

  it("tree mode is unchanged: no shortcut section, canonical order preserved", () => {
    const store = useAppStore();
    store.payload = makePayload({ workspaces: workedWorkspaces(4) });
    const wrapper = mount(SidebarPanel);

    expect(wrapper.find('[data-role="recent-shortcuts"]').exists()).toBe(false);
    expect(treeIds(wrapper)).toEqual(["ws-A", "ws-B", "ws-C", "ws-D"]);
  });

  it("recent mode shows the shortcuts AND the complete tree, recent workspaces included", () => {
    const store = useAppStore();
    const now = Date.now();
    store.payload = recentPayload({
      workspaces: [
        { id: "ws-root", name: "Root", cwd: "/r", panels: [], icon: "R", color: "#fff", profileId: "default" },
        {
          id: "ws-child",
          name: "Child",
          cwd: "/c",
          panels: [],
          icon: "C",
          color: "#fff",
          profileId: "default",
          task: { parentWorkspaceId: "ws-root" },
          lastWorkedAt: new Date(now - 5 * MINUTE).toISOString(),
        },
      ],
    });

    const wrapper = mount(SidebarPanel);

    // The shortcut, inside its cluster, under a clickable parent context row.
    expect(recentIds(wrapper)).toEqual(["ws-child"]);
    expect(wrapper.get('.recent-shortcuts [data-role="activity-context-row"]').get(".activity-row__label").text()).toBe(
      "Root",
    );
    // …and the canonical tree still holds BOTH the parent and the child.
    expect(treeIds(wrapper)).toEqual(["ws-root", "ws-child"]);
    expect(wrapper.get(".recent-shortcuts__title").text()).toContain("Recently worked · 24h (1)");
    expect(wrapper.get(".recent-shortcuts__all-title").text()).toContain("All workspaces (2)");
  });

  it("the tree keeps its manual order and depth after work and after activation", () => {
    const store = useAppStore();
    const now = Date.now();
    // ws-D is the most recently worked one, ws-A the least.
    store.payload = recentPayload({
      workspaces: BASE_WORKSPACES.map((ws, i) => ({
        ...ws,
        lastWorkedAt: new Date(now - (4 - i) * MINUTE).toISOString(),
      })),
      activeWorkspaceId: "ws-D",
      windowSlots: [{ id: "win-test", profileId: "default", activeWorkspaceId: "ws-D" }],
    });

    const wrapper = mount(SidebarPanel);

    expect(recentIds(wrapper)).toEqual(["ws-D", "ws-C", "ws-B", "ws-A"]);
    // The tree below is NOT reordered by time.
    expect(treeIds(wrapper)).toEqual(["ws-A", "ws-B", "ws-C", "ws-D"]);
  });

  it("search renders exactly one result set — the canonical tree, with no shortcuts", () => {
    const store = useAppStore();
    store.payload = recentPayload({ workspaces: workedWorkspaces(4) });
    store.workspaceSearchQuery = "alpha";

    const wrapper = mount(SidebarPanel);

    expect(wrapper.find('[data-role="recent-shortcuts"]').exists()).toBe(false);
    expect(treeIds(wrapper)).toEqual(["ws-A"]);
    // The stored mode itself is untouched by searching.
    expect(store.activeProfile.sidebarWorkspaceViewMode).toBe("recent");
  });

  it("the star filter narrows both surfaces with the same set", () => {
    const store = useAppStore();
    const now = Date.now();
    store.payload = recentPayload({
      workspaces: [
        {
          id: "ws-star",
          name: "Starred",
          cwd: "/s",
          panels: [],
          icon: "S",
          color: "#fff",
          profileId: "default",
          starred: true,
          lastWorkedAt: new Date(now - MINUTE).toISOString(),
        },
        {
          id: "ws-plain",
          name: "Plain",
          cwd: "/p",
          panels: [],
          icon: "P",
          color: "#fff",
          profileId: "default",
          lastWorkedAt: new Date(now - 2 * MINUTE).toISOString(),
        },
      ],
    });
    store.starFilterActive = true;

    const wrapper = mount(SidebarPanel);

    expect(recentIds(wrapper)).toEqual(["ws-star"]);
    expect(treeIds(wrapper)).toEqual(["ws-star"]);
  });

  it("collapsing the section hides the rows but never the tree, and the data is unchanged", async () => {
    const store = useAppStore();
    store.payload = recentPayload({ workspaces: workedWorkspaces(2) });
    const wrapper = mount(SidebarPanel);

    expect(recentIds(wrapper)).toEqual(["ws-A", "ws-B"]);

    await wrapper.get(".recent-shortcuts__toggle").trigger("click");
    expect(recentIds(wrapper)).toEqual([]);
    // Header count still reports the full set, and ALL WORKSPACES is intact.
    expect(wrapper.get(".recent-shortcuts__title").text()).toContain("(2)");
    expect(treeIds(wrapper)).toEqual(["ws-A", "ws-B", "ws-C", "ws-D"]);

    await wrapper.get(".recent-shortcuts__toggle").trigger("click");
    expect(recentIds(wrapper)).toEqual(["ws-A", "ws-B"]);
  });

  it("shows no 'Show more' at seven items or fewer", () => {
    const store = useAppStore();
    store.payload = recentPayload({ workspaces: manyWorked(7) });
    const wrapper = mount(SidebarPanel);

    expect(recentIds(wrapper)).toHaveLength(7);
    expect(wrapper.find('[data-role="recent-shortcuts-more"]').exists()).toBe(false);
  });

  it("at eight items shows seven plus 'Show 1 more', expands to all eight, and 'Show less' returns exactly seven", async () => {
    const store = useAppStore();
    store.payload = recentPayload({ workspaces: manyWorked(8) });
    const wrapper = mount(SidebarPanel);

    expect(recentIds(wrapper)).toHaveLength(7);
    expect(wrapper.get(".recent-shortcuts__title").text()).toContain("(8)");
    const more = wrapper.get('[data-role="recent-shortcuts-more"]');
    expect(more.text()).toBe("Show 1 more");

    await more.trigger("click");
    expect(recentIds(wrapper)).toHaveLength(8);
    expect(wrapper.get('[data-role="recent-shortcuts-more"]').text()).toBe("Show less");

    await wrapper.get('[data-role="recent-shortcuts-more"]').trigger("click");
    expect(recentIds(wrapper)).toHaveLength(7);
    expect(wrapper.get('[data-role="recent-shortcuts-more"]').text()).toBe("Show 1 more");
  });

  it("a newer arrival re-slices the first seven while collapsed to the limit", async () => {
    const store = useAppStore();
    const now = Date.now();
    store.payload = recentPayload({ workspaces: manyWorked(8, now) });
    const wrapper = mount(SidebarPanel);

    expect(recentIds(wrapper)).toEqual(["ws-0", "ws-1", "ws-2", "ws-3", "ws-4", "ws-5", "ws-6"]);

    // The oldest workspace is worked in again and becomes the newest.
    const bumped = manyWorked(8, now).map((ws) =>
      ws.id === "ws-7" ? { ...ws, lastWorkedAt: new Date(now).toISOString() } : ws,
    );
    store.payload = recentPayload({ workspaces: bumped });
    await nextTick();

    expect(recentIds(wrapper)).toEqual(["ws-7", "ws-0", "ws-1", "ws-2", "ws-3", "ws-4", "ws-5"]);
    expect(wrapper.get('[data-role="recent-shortcuts-more"]').text()).toBe("Show 1 more");
  });

  it("a newer arrival shows up without re-collapsing a fully expanded list", async () => {
    const store = useAppStore();
    const now = Date.now();
    store.payload = recentPayload({ workspaces: manyWorked(8, now) });
    const wrapper = mount(SidebarPanel);
    await wrapper.get('[data-role="recent-shortcuts-more"]').trigger("click");
    expect(recentIds(wrapper)).toHaveLength(8);

    const bumped = manyWorked(9, now);
    store.payload = recentPayload({ workspaces: bumped });
    await nextTick();

    expect(recentIds(wrapper)).toHaveLength(9);
    expect(wrapper.get('[data-role="recent-shortcuts-more"]').text()).toBe("Show less");
  });

  it("the collapsed icon strip shows the tree's icons only — no duplicates", async () => {
    const store = useAppStore();
    store.payload = recentPayload({ workspaces: workedWorkspaces(4) });
    const wrapper = mount(SidebarPanel);
    expect(recentIds(wrapper)).toHaveLength(4);

    store.sidebarCollapsed = true;
    await nextTick();

    expect(wrapper.find('[data-role="recent-shortcuts"]').exists()).toBe(false);
    expect(recentIds(wrapper)).toEqual([]);
    // Every workspace appears exactly once, from the canonical tree.
    const ids = wrapper
      .findAll(".workspace-card[data-workspace-id]")
      .map((c: AnyApi) => c.attributes("data-workspace-id"));
    expect(ids).toEqual(["ws-A", "ws-B", "ws-C", "ws-D"]);
  });

  it("drag-and-drop reorders the canonical tree in recent mode", async () => {
    const store = useAppStore();
    store.payload = recentPayload({ workspaces: workedWorkspaces(4) });
    const reorder = vi.spyOn(store, "reorderWorkspaces").mockResolvedValue(undefined);

    const wrapper = mount(SidebarPanel);
    const cards = wrapper.findAll('[data-role="workspace-list"] > .workspace-card');
    const dataTransfer = makeDataTransfer();

    await cards[0].trigger("dragstart", { dataTransfer });
    await cards[2].trigger("dragover", { dataTransfer, clientY: 0 });
    await cards[2].trigger("drop", { dataTransfer, clientY: 0 });
    await flushPromises();

    expect(reorder).toHaveBeenCalled();
  });

  it("a recent shortcut is neither a drag source nor a drop target", async () => {
    const store = useAppStore();
    store.payload = recentPayload({ workspaces: workedWorkspaces(4) });
    const reorder = vi.spyOn(store, "reorderWorkspaces").mockResolvedValue(undefined);

    const wrapper = mount(SidebarPanel);
    const row = wrapper.get('.recent-shortcuts [data-role="activity-node-row"]');
    expect(row.attributes("draggable")).toBeUndefined();

    const dataTransfer = makeDataTransfer();
    await row.trigger("dragstart", { dataTransfer });
    await row.trigger("dragover", { dataTransfer, clientY: 0 });
    await row.trigger("drop", { dataTransfer, clientY: 0 });
    await flushPromises();

    expect(reorder).not.toHaveBeenCalled();
  });

  it("the shared minute clock retires a row at the 24h boundary without a reload", async () => {
    vi.useFakeTimers();
    try {
      const now = Date.now();
      const store = useAppStore();
      store.payload = recentPayload({
        workspaces: [
          { ...BASE_WORKSPACES[0], lastWorkedAt: new Date(now - 23 * 60 * MINUTE - 59 * MINUTE).toISOString() },
          { ...BASE_WORKSPACES[1], lastWorkedAt: new Date(now - MINUTE).toISOString() },
        ],
      });

      const wrapper = mount(SidebarPanel);
      expect(recentIds(wrapper)).toEqual(["ws-B", "ws-A"]);

      // Two minutes of wall clock: ws-A crosses 24h, nothing else changes.
      await vi.advanceTimersByTimeAsync(2 * MINUTE);
      await nextTick();

      expect(recentIds(wrapper)).toEqual(["ws-B"]);
      expect(wrapper.get(".recent-shortcuts__title").text()).toContain("(1)");
      // The canonical tree is untouched by the row dropping out.
      expect(treeIds(wrapper)).toEqual(["ws-A", "ws-B"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ten passes through different workspaces change neither membership nor order", async () => {
    const store = useAppStore();
    const now = Date.now();
    // Only ws-A and ws-B were ever worked in.
    store.payload = recentPayload({
      workspaces: [
        { ...BASE_WORKSPACES[0], lastWorkedAt: new Date(now - 2 * MINUTE).toISOString() },
        { ...BASE_WORKSPACES[1], lastWorkedAt: new Date(now - MINUTE).toISOString() },
        { ...BASE_WORKSPACES[2] },
        { ...BASE_WORKSPACES[3] },
      ],
    });
    vi.spyOn(store, "activateWorkspace").mockResolvedValue(undefined);

    const wrapper = mount(SidebarPanel);
    const before = { recent: recentIds(wrapper), tree: treeIds(wrapper) };
    expect(before.recent).toEqual(["ws-B", "ws-A"]);

    // Click through every workspace — including the two that were never
    // worked in — ten times over. Activation is not work, so nothing moves.
    const cards = wrapper.findAll('[data-role="workspace-list"] > .workspace-card');
    for (let pass = 0; pass < 10; pass++) {
      for (const card of cards) {
        await card.trigger("click");
      }
    }
    await flushPromises();

    expect({ recent: recentIds(wrapper), tree: treeIds(wrapper) }).toEqual(before);
  });

  it("clicking a shortcut activates the workspace through the usual chain", async () => {
    const store = useAppStore();
    store.payload = recentPayload({ workspaces: workedWorkspaces(2) });
    const activate = vi.spyOn(store, "activateWorkspace").mockResolvedValue(undefined);

    const wrapper = mount(SidebarPanel);
    await wrapper.get('.recent-shortcuts [data-role="activity-node-row"]').trigger("click");
    await flushPromises();

    expect(wrapper.emitted("activate")?.[0]).toEqual(["ws-A"]);
    expect(activate).toHaveBeenCalledWith("ws-A");
  });

  it("active, grid and attention state tint a row without changing membership or order", () => {
    const store = useAppStore();
    const now = Date.now();
    store.payload = {
      ...recentPayload({
        workspaces: workedWorkspaces(3, now),
        activeWorkspaceId: "ws-B",
        windowSlots: [
          {
            id: "win-test",
            profileId: "default",
            activeWorkspaceId: "ws-B",
            workspaceGrid: { layout: "cols", cellWorkspaceIds: ["ws-C", null] },
          },
        ],
      }),
      attention: {
        sessions: {},
        byWorkspace: { "ws-A": { count: 2, latestAt: new Date(now).toISOString(), alerts: [{}, {}] } },
      },
    } as AnyApi;

    const wrapper = mount(SidebarPanel);

    // Membership and order are still purely lastWorkedAt-driven.
    expect(recentIds(wrapper)).toEqual(["ws-A", "ws-B", "ws-C"]);
    const rows = wrapper.findAll('.recent-shortcuts [data-role="activity-node-row"]');
    expect(rows[0].find(".activity-row__attention-count").text()).toBe("2");
    expect(rows[1].classes()).toContain("activity-row--active");
    expect(rows[2].classes()).toContain("activity-row--in-grid");
    expect(rows[2].get(".activity-row__slot").text()).toBe("1");
  });
});

describe("SidebarPanel — RUNNING agents surface", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    (window as AnyApi).strideterm = { startupFlags: { windowId: "win-test" } };
  });

  /**
   * V3 review, Fáze 1 — RUNNING means SUPERVISED. The fixtures below are task
   * workspaces; a plain agent-like session is exercised separately and must
   * produce no row at all.
   */
  const TASK_STARTED_AT = Date.now() - 3 * 60 * 60 * 1000;

  function taskWorkspace(id: string, name: string, state: string, taskOverrides: AnyApi = {}): AnyApi {
    return {
      id,
      name,
      cwd: `/${id}`,
      icon: "T",
      color: "#fff",
      profileId: "default",
      kind: "task",
      panels: [
        { id: "worker", title: "Worker Claude" },
        { id: "judge", title: "Judge Codex" },
      ],
      task: {
        taskId: `t-${id}`,
        state,
        workerPanelId: "worker",
        judgePanelId: "judge",
        startedAt: TASK_STARTED_AT,
        totalPausedMs: 0,
        pausedAt: null,
        finishedAt: null,
        ...taskOverrides,
      },
    };
  }

  /** A live agent-like session in a plain workspace — never a RUNNING row. */
  const PLAIN_SESSION = {
    "ws-C:claude": {
      workspaceId: "ws-C",
      panelId: "claude",
      activity: "running",
      agentLike: true,
      hasUserInput: true,
      activityStartedAt: Date.now() - 3 * 60 * 60 * 1000,
    },
  };

  /** `payload` with a running supervised agent in ws-B. */
  function withAgents(payload: StatePayload, taskRunner: AnyApi = { "ws-B": { state: "running" } }): StatePayload {
    const appState = (payload as AnyApi).appState;
    const workspaces = (appState.workspaces as AnyApi[]).map((ws) =>
      ws.id === "ws-B" ? { ...taskWorkspace("ws-B", ws.name, "running"), ...pickRecent(ws) } : ws,
    );
    return { ...payload, appState: { ...appState, workspaces }, taskRunner } as AnyApi;
  }

  /** Keep a fixture's `lastWorkedAt` when swapping a workspace for a task one. */
  function pickRecent(ws: AnyApi): AnyApi {
    return ws.lastWorkedAt ? { lastWorkedAt: ws.lastWorkedAt } : {};
  }

  /** Everything the sidebar renders BELOW the surface, as a comparable snapshot. */
  function listSnapshot(wrapper: AnyApi) {
    return {
      cards: wrapper
        .findAll(".workspace-card[data-workspace-id]")
        .map((c: AnyApi) => c.attributes("data-workspace-id")),
      recentRows: wrapper
        .findAll('.recent-shortcuts [data-role="activity-node-row"]')
        .map((r: AnyApi) => r.attributes("data-workspace-id")),
      recentTitle: wrapper.find(".recent-shortcuts__title").exists()
        ? wrapper.get(".recent-shortcuts__title").text()
        : "",
      allTitle: wrapper.find(".recent-shortcuts__all-title").exists()
        ? wrapper.get(".recent-shortcuts__all-title").text()
        : "",
      splitTitle: wrapper.find(".workspace-list__split-title").exists()
        ? wrapper.get(".workspace-list__split-title").text()
        : "",
      splitCards: wrapper
        .findAll(".workspace-list__split-group [data-workspace-id]")
        .map((c: AnyApi) => c.attributes("data-workspace-id")),
      depths: wrapper.findAll(".workspace-card[data-workspace-id]").map((c: AnyApi) => c.attributes("style") || ""),
    };
  }

  function recentPayload(overrides: AnyApi = {}): StatePayload {
    return makePayload({
      profiles: [{ id: "default", name: "Default", sidebarWorkspaceViewMode: "recent" }],
      ...overrides,
    });
  }

  it("renders one row per supervised agent, with the elapsed and the workspace it runs in", () => {
    const store = useAppStore();
    store.payload = withAgents(makePayload());

    const wrapper = mount(SidebarPanel);
    const surface = wrapper.get('[data-role="running-agents"]');
    const rows = surface.findAll('.running-agents [data-role="activity-node-row"]');
    expect(rows.length).toBe(1);
    expect(rows[0].attributes("data-row-key")).toBe("ws-B:worker");
    expect(rows[0].text()).toContain("Beta");
    expect(surface.get(".running-agents .activity-row__trailing").text()).toBe("3h 00m");
    expect(surface.get(".running-agents__title").text()).toContain("Running (1)");
  });

  it("a plain agent-like Claude Code session produces no RUNNING row at all", () => {
    const store = useAppStore();
    // ws-C has a live agent session and no task. Its state belongs to the tab
    // and the workspace card, not to a navigation surface (V3 review, Fáze 1).
    store.payload = { ...makePayload(), attention: { sessions: PLAIN_SESSION } } as AnyApi;

    const wrapper = mount(SidebarPanel);
    expect(wrapper.find('[data-role="running-agents"]').exists()).toBe(false);
  });

  it("an attached/Companion task is one row hosted in the task workspace", () => {
    const store = useAppStore();
    store.payload = makePayload({
      workspaces: [
        {
          id: "ws-src",
          name: "Source",
          cwd: "/s",
          panels: [{ id: "primary", title: "Primary Claude" }],
          icon: "S",
          color: "#fff",
          profileId: "default",
        },
        {
          id: "ws-comp",
          name: "Companion",
          cwd: "/c",
          icon: "C",
          color: "#fff",
          profileId: "default",
          kind: "task",
          panels: [{ id: "judge", title: "Companion" }],
          task: {
            taskId: "t-comp",
            state: "running",
            mode: "attached",
            workerWorkspaceId: "ws-src",
            workerPanelId: "primary",
            judgePanelId: "judge",
            startedAt: TASK_STARTED_AT,
            totalPausedMs: 0,
            pausedAt: null,
            finishedAt: null,
          },
        },
      ],
      activeWorkspaceId: "ws-src",
      windowSlots: [{ id: "win-test", profileId: "default", activeWorkspaceId: "ws-src" }],
    });

    const wrapper = mount(SidebarPanel);
    const rows = wrapper.findAll('.running-agents [data-role="activity-node-row"]');
    expect(rows).toHaveLength(1);
    expect(rows[0].text()).toContain("Companion");
  });

  it("paused, completed and failed tasks are not in RUNNING", async () => {
    const store = useAppStore();
    const wrapper = mount(SidebarPanel);
    for (const state of ["paused", "completed", "failed", "stopped"]) {
      store.payload = withAgents(makePayload(), { "ws-B": { state } });
      await nextTick();
      expect(wrapper.find('[data-role="running-agents"]').exists()).toBe(false);
    }
  });

  it("a worker → judge transition keeps the same row key in the same position", async () => {
    const store = useAppStore();
    store.payload = withAgents(makePayload(), { "ws-B": { state: "running", startedAt: TASK_STARTED_AT } });
    const wrapper = mount(SidebarPanel);
    const keys = () =>
      wrapper.findAll('.running-agents [data-role="activity-node-row"]').map((r) => r.attributes("data-row-key"));
    expect(keys()).toEqual(["ws-B:worker"]);

    store.payload = withAgents(makePayload(), {
      "ws-B": { state: "judge-evaluating", startedAt: TASK_STARTED_AT },
    });
    await nextTick();

    expect(keys()).toEqual(["ws-B:worker"]);
    // V6: the reserved slot shows the SHORT label — "judge-evaluating" is
    // sixteen characters and either squeezed the name to nothing or wrapped
    // and changed the row's height mid-gesture.
    expect(wrapper.get(".running-agents .activity-row__state").text()).toBe("judging");
  });

  // V5 review, §4 — RUNNING and the top RECENT are DISJOINT: a task that
  // starts moves out of the recent list and into this surface, and the freed
  // slot goes to another workspace instead of a duplicate. The canonical tree
  // is the one place that always holds everything, and it must not move.
  it("a task that starts leaves the top recent for RUNNING, and the canonical tree is untouched", () => {
    const now = Date.now();
    const workspaces = [
      {
        id: "ws-root",
        name: "Azure DevOps",
        cwd: "/root",
        panels: [],
        icon: "AZ",
        color: "#fff",
        profileId: "default",
        kind: "azure",
      },
      {
        id: "ws-task",
        name: "task-1",
        cwd: "/t",
        panels: [
          { id: "worker", title: "Worker Claude" },
          { id: "judge", title: "Judge Codex" },
        ],
        icon: "T",
        color: "#fff",
        profileId: "default",
        kind: "task",
        task: {
          taskId: "t-1",
          state: "running",
          parentWorkspaceId: "ws-root",
          workerPanelId: "worker",
          judgePanelId: "judge",
          startedAt: now - 60_000,
          totalPausedMs: 0,
          pausedAt: null,
          finishedAt: null,
        },
        lastWorkedAt: new Date(now - 5 * 60 * 1000).toISOString(),
      },
    ];
    const base = recentPayload({
      workspaces,
      activeWorkspaceId: "ws-task",
      windowSlots: [{ id: "win-test", profileId: "default", activeWorkspaceId: "ws-task" }],
    });

    const quiet = useAppStore();
    quiet.payload = { ...base, taskRunner: { "ws-task": { state: "paused" } } } as AnyApi;
    const quietWrapper = mount(SidebarPanel);
    const quietSnapshot = listSnapshot(quietWrapper);
    expect(quietWrapper.find('[data-role="running-agents"]').exists()).toBe(false);
    // Paused: nowhere in RUNNING, so it belongs to the recent list.
    expect(quietSnapshot.recentRows).toEqual(["ws-task"]);

    setActivePinia(createPinia());
    const busy = useAppStore();
    busy.payload = {
      ...base,
      taskRunner: { "ws-task": { state: "running", startedAt: now - 60_000 } },
    } as AnyApi;
    const busyWrapper = mount(SidebarPanel);
    const busySnapshot = listSnapshot(busyWrapper);

    expect(busyWrapper.find('[data-role="running-agents"]').exists()).toBe(true);
    // The SAME task, in one section only.
    expect(busySnapshot.recentRows).toEqual([]);
    expect(
      busyWrapper.findAll('.running-agents [data-role="activity-node-row"]').map((r) => r.attributes("data-row-key")),
    ).toEqual(["ws-task:worker"]);
    // Everything below the two surfaces is byte-for-byte the same.
    expect(busySnapshot.cards).toEqual(quietSnapshot.cards);
    expect(busySnapshot.depths).toEqual(quietSnapshot.depths);
    expect(busySnapshot.allTitle).toEqual(quietSnapshot.allTitle);
    expect(busySnapshot.splitCards).toEqual(quietSnapshot.splitCards);
  });

  it("is additive: the tree list, its depths and the In-split group are identical with and without it", () => {
    const grid = { layout: "cols", cellWorkspaceIds: ["ws-A", "ws-B"] };

    const quiet = useAppStore();
    quiet.payload = makePayload({ workspaceGrid: grid });
    const quietSnapshot = listSnapshot(mount(SidebarPanel));

    setActivePinia(createPinia());
    const busy = useAppStore();
    busy.payload = withAgents(makePayload({ workspaceGrid: grid }));
    const busyWrapper = mount(SidebarPanel);

    expect(busyWrapper.find('[data-role="running-agents"]').exists()).toBe(true);
    expect(listSnapshot(busyWrapper)).toEqual(quietSnapshot);
  });

  it("a running workspace keeps its usual place in the tree, with ghost + slot badge in the grid", () => {
    const store = useAppStore();
    store.payload = withAgents(makePayload({ workspaceGrid: { layout: "cols", cellWorkspaceIds: ["ws-A", "ws-B"] } }));

    const wrapper = mount(SidebarPanel);
    // Still in the tree (and in the In-split group) — the canonical tree never
    // loses a workspace to a surface above it.
    expect(wrapper.findAll('.workspace-card[data-workspace-id="ws-B"]').length).toBe(2);

    const row = wrapper.get('.running-agents [data-role="activity-node-row"]');
    expect(row.classes()).toContain("activity-row--in-grid");
    expect(row.get(".activity-row__slot").text()).toBe("2");
  });

  it("renders in both view modes, renders nothing at zero, and hides in the collapsed icon strip", async () => {
    const store = useAppStore();
    store.payload = withAgents(makePayload());
    expect(mount(SidebarPanel).find('[data-role="running-agents"]').exists()).toBe(true);

    setActivePinia(createPinia());
    const recentStore = useAppStore();
    recentStore.payload = withAgents(recentPayload());
    expect(mount(SidebarPanel).find('[data-role="running-agents"]').exists()).toBe(true);

    setActivePinia(createPinia());
    const idleStore = useAppStore();
    idleStore.payload = withAgents(makePayload(), { "ws-B": { state: "paused" } });
    expect(mount(SidebarPanel).find('[data-role="running-agents"]').exists()).toBe(false);

    setActivePinia(createPinia());
    const collapsedStore = useAppStore();
    collapsedStore.payload = withAgents(makePayload());
    collapsedStore.sidebarCollapsed = true;
    const collapsed = mount(SidebarPanel);
    await nextTick();
    expect(collapsed.find('[data-role="running-agents"]').exists()).toBe(false);
  });

  it("when the run ends the row disappears and nothing else in the sidebar changes", async () => {
    const store = useAppStore();
    store.payload = withAgents(makePayload());
    const wrapper = mount(SidebarPanel);
    const beforeList = listSnapshot(wrapper);
    expect(wrapper.find('[data-role="running-agents"]').exists()).toBe(true);

    store.payload = withAgents(makePayload(), { "ws-B": { state: "completed" } });
    await nextTick();

    expect(wrapper.find('[data-role="running-agents"]').exists()).toBe(false);
    expect(listSnapshot(wrapper)).toEqual(beforeList);
  });

  it("the star filter leaves the surface and the lists exactly as they were; a search suspends it", async () => {
    const starred = [
      { ...BASE_WORKSPACES[0], starred: true },
      BASE_WORKSPACES[1],
      BASE_WORKSPACES[2],
      BASE_WORKSPACES[3],
    ];
    const store = useAppStore();
    store.payload = withAgents(makePayload({ workspaces: starred }));
    const wrapper = mount(SidebarPanel);
    const surfaceKeys = () =>
      wrapper.findAll('.running-agents [data-role="activity-node-row"]').map((r) => r.attributes("data-row-key"));
    expect(surfaceKeys()).toEqual(["ws-B:worker"]);

    // Star filter: ws-B is NOT starred, yet the surface still shows its agent —
    // the filter has no new effect on the surface.
    store.starFilterActive = true;
    await nextTick();
    expect(surfaceKeys()).toEqual(["ws-B:worker"]);
    expect(wrapper.findAll(".workspace-card[data-workspace-id]").map((c) => c.attributes("data-workspace-id"))).toEqual(
      ["ws-A"],
    );

    // V6: a search is its own single-answer mode. RUNNING is SUSPENDED rather
    // than left unfiltered above the results, where a matching task would have
    // appeared twice (V6 review, §"P2 UX — search má být jeden explicitní
    // režim").
    store.starFilterActive = false;
    store.workspaceSearchQuery = "alpha";
    await nextTick();
    expect(surfaceKeys()).toEqual([]);
    expect(wrapper.find('[data-role="running-agents"]').exists()).toBe(false);
    expect(wrapper.findAll(".workspace-card[data-workspace-id]").map((c) => c.attributes("data-workspace-id"))).toEqual(
      ["ws-A"],
    );

    // Clearing the query brings it straight back, unchanged.
    store.workspaceSearchQuery = "";
    await nextTick();
    expect(surfaceKeys()).toEqual(["ws-B:worker"]);
  });

  it("clicking a row emits 'activate' (the mobile-drawer chain) and navigates without acknowledging anything", async () => {
    const store = useAppStore();
    const notifStore = useNotificationStore();
    store.payload = withAgents(makePayload());
    const inGrid = vi.fn().mockResolvedValue(undefined);
    const view = vi.fn().mockResolvedValue(undefined);
    (store as AnyApi).activateWorkspaceInGrid = inGrid;
    (store as AnyApi).activateView = view;
    const setState = vi.spyOn(notifStore, "setState");
    const clearOnBackend = vi.spyOn(notifStore, "clearOnBackend");

    const wrapper = mount(SidebarPanel);
    await wrapper.get('.running-agents [data-role="activity-node-row"]').trigger("click");
    await flushPromises();

    // App.vue listens to this emit and closes the mobile drawer.
    expect(wrapper.emitted("activate")?.[0]).toEqual(["ws-B"]);
    expect(inGrid).toHaveBeenCalledWith("ws-B");
    expect(view).toHaveBeenCalledWith("ws-B:worker");
    expect(setState).not.toHaveBeenCalled();
    expect(clearOnBackend).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// V3 review, §2 — hit-target stability
//
// While the user is aiming at the workspace list, no BACKGROUND update may
// change which rows exist in the two dynamic surfaces, in what order, or how
// tall the sections are. Explicit user commands are never deferred.
// ---------------------------------------------------------------------------

describe("SidebarPanel — interaction lock", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    (window as AnyApi).strideterm = { startupFlags: { windowId: "win-test" } };
  });

  const MINUTE = 60 * 1000;
  const GRACE_MS = 500;

  function recentPayload(overrides: AnyApi = {}): StatePayload {
    return makePayload({
      profiles: [{ id: "default", name: "Default", sidebarWorkspaceViewMode: "recent" }],
      ...overrides,
    });
  }

  function taskWs(id: string, name: string, startedAt: number, extra: AnyApi = {}): AnyApi {
    return {
      id,
      name,
      cwd: `/${id}`,
      icon: "T",
      color: "#fff",
      profileId: "default",
      kind: "task",
      panels: [
        { id: "worker", title: "Worker Claude" },
        { id: "judge", title: "Judge Codex" },
      ],
      task: {
        taskId: `t-${id}`,
        state: "running",
        workerPanelId: "worker",
        judgePanelId: "judge",
        startedAt,
        totalPausedMs: 0,
        pausedAt: null,
        finishedAt: null,
      },
      ...extra,
    };
  }

  function agentKeys(wrapper: AnyApi): string[] {
    return wrapper
      .findAll('.running-agents [data-role="activity-node-row"]')
      .map((r: AnyApi) => r.attributes("data-row-key"));
  }

  function recentIds(wrapper: AnyApi): string[] {
    return wrapper
      .findAll('.recent-shortcuts [data-role="activity-node-row"]')
      .map((r: AnyApi) => r.attributes("data-workspace-id"));
  }

  /** Enter the list with the pointer — the desktop aiming gesture. */
  async function pointerEnter(wrapper: AnyApi): Promise<void> {
    await wrapper.get('[data-role="workspace-list"]').trigger("pointerenter");
  }

  async function pointerLeave(wrapper: AnyApi): Promise<void> {
    await wrapper.get('[data-role="workspace-list"]').trigger("pointerleave");
  }

  it("a task finishing under the pointer leaves both rows and the section height in place", async () => {
    const store = useAppStore();
    const now = Date.now();
    const workspaces = [taskWs("ws-1", "One", now - 2 * MINUTE), taskWs("ws-2", "Two", now - MINUTE)];
    const running = (states: AnyApi): StatePayload =>
      ({ ...makePayload({ workspaces }), taskRunner: states }) as AnyApi;

    store.payload = running({
      "ws-1": { state: "running", startedAt: now - 2 * MINUTE },
      "ws-2": { state: "running", startedAt: now - MINUTE },
    });
    const wrapper = mount(SidebarPanel);
    expect(agentKeys(wrapper)).toEqual(["ws-1:worker", "ws-2:worker"]);

    // The user aims at the second row, and the FIRST one finishes.
    await pointerEnter(wrapper);
    store.payload = running({
      "ws-1": { state: "completed", startedAt: now - 2 * MINUTE },
      "ws-2": { state: "running", startedAt: now - MINUTE },
    });
    await nextTick();

    // Both rows are still there, in the same order, so nothing moved.
    expect(agentKeys(wrapper)).toEqual(["ws-1:worker", "ws-2:worker"]);
    expect(wrapper.get(".running-agents__title").text()).toContain("Running (2)");
  });

  it("a new task started during the lock is not inserted", async () => {
    const store = useAppStore();
    const now = Date.now();
    const one = taskWs("ws-1", "One", now - 2 * MINUTE);
    const two = taskWs("ws-2", "Two", now - MINUTE);

    store.payload = { ...makePayload({ workspaces: [one] }), taskRunner: { "ws-1": { state: "running" } } } as AnyApi;
    const wrapper = mount(SidebarPanel);
    await pointerEnter(wrapper);
    expect(agentKeys(wrapper)).toEqual(["ws-1:worker"]);

    store.payload = {
      ...makePayload({ workspaces: [one, two] }),
      taskRunner: { "ws-1": { state: "running" }, "ws-2": { state: "running" } },
    } as AnyApi;
    await nextTick();

    expect(agentKeys(wrapper)).toEqual(["ws-1:worker"]);
    expect(wrapper.get(".running-agents__title").text()).toContain("Running (1)");
  });

  it("the pending snapshot applies exactly once, after the grace interval", async () => {
    vi.useFakeTimers();
    try {
      const store = useAppStore();
      const now = Date.now();
      const one = taskWs("ws-1", "One", now - 2 * MINUTE);
      const two = taskWs("ws-2", "Two", now - MINUTE);
      store.payload = { ...makePayload({ workspaces: [one] }), taskRunner: { "ws-1": { state: "running" } } } as AnyApi;

      const wrapper = mount(SidebarPanel);
      await pointerEnter(wrapper);
      store.payload = {
        ...makePayload({ workspaces: [one, two] }),
        taskRunner: { "ws-1": { state: "running" }, "ws-2": { state: "running" } },
      } as AnyApi;
      await nextTick();
      expect(agentKeys(wrapper)).toEqual(["ws-1:worker"]);

      // Leaving starts the grace — still frozen while it runs.
      await pointerLeave(wrapper);
      await vi.advanceTimersByTimeAsync(GRACE_MS - 100);
      await nextTick();
      expect(agentKeys(wrapper)).toEqual(["ws-1:worker"]);

      await vi.advanceTimersByTimeAsync(200);
      await nextTick();
      expect(agentKeys(wrapper)).toEqual(["ws-1:worker", "ws-2:worker"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a pointer that comes back during the grace keeps the projection frozen", async () => {
    vi.useFakeTimers();
    try {
      const store = useAppStore();
      const now = Date.now();
      const one = taskWs("ws-1", "One", now - 2 * MINUTE);
      const two = taskWs("ws-2", "Two", now - MINUTE);
      store.payload = { ...makePayload({ workspaces: [one] }), taskRunner: { "ws-1": { state: "running" } } } as AnyApi;

      const wrapper = mount(SidebarPanel);
      await pointerEnter(wrapper);
      store.payload = {
        ...makePayload({ workspaces: [one, two] }),
        taskRunner: { "ws-1": { state: "running" }, "ws-2": { state: "running" } },
      } as AnyApi;
      await nextTick();

      await pointerLeave(wrapper);
      await vi.advanceTimersByTimeAsync(200);
      await pointerEnter(wrapper);
      await vi.advanceTimersByTimeAsync(GRACE_MS * 2);
      await nextTick();

      // The re-entry cancelled the unlock: still exactly one row.
      expect(agentKeys(wrapper)).toEqual(["ws-1:worker"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("focus inside the list holds the lock with no pointer at all", async () => {
    const store = useAppStore();
    const now = Date.now();
    const one = taskWs("ws-1", "One", now - 2 * MINUTE);
    const two = taskWs("ws-2", "Two", now - MINUTE);
    store.payload = { ...makePayload({ workspaces: [one] }), taskRunner: { "ws-1": { state: "running" } } } as AnyApi;

    const wrapper = mount(SidebarPanel, { attachTo: document.body });
    const list = wrapper.get('[data-role="workspace-list"]');
    const row = wrapper.get('.running-agents [data-role="activity-node-row"]');
    await list.trigger("focusin");

    store.payload = {
      ...makePayload({ workspaces: [one, two] }),
      taskRunner: { "ws-1": { state: "running" }, "ws-2": { state: "running" } },
    } as AnyApi;
    await nextTick();
    expect(agentKeys(wrapper)).toEqual(["ws-1:worker"]);

    // Moving focus BETWEEN two rows inside the list must not unlock either.
    await list.trigger("focusout", { relatedTarget: row.element });
    expect(agentKeys(wrapper)).toEqual(["ws-1:worker"]);

    wrapper.unmount();
  });

  it("an open mobile drawer keeps the same membership and order until it closes", async () => {
    const store = useAppStore();
    const now = Date.now();
    const one = taskWs("ws-1", "One", now - 2 * MINUTE);
    const two = taskWs("ws-2", "Two", now - MINUTE);
    store.payload = { ...makePayload({ workspaces: [one] }), taskRunner: { "ws-1": { state: "running" } } } as AnyApi;

    const wrapper = mount(SidebarPanel, { props: { drawerOpen: true } });
    expect(agentKeys(wrapper)).toEqual(["ws-1:worker"]);

    store.payload = {
      ...makePayload({ workspaces: [one, two] }),
      taskRunner: { "ws-1": { state: "running" }, "ws-2": { state: "running" } },
    } as AnyApi;
    await nextTick();
    expect(agentKeys(wrapper)).toEqual(["ws-1:worker"]);

    // App.vue closes the drawer on activation; only then does the pending
    // state land.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- setProps' inferred type drops optional props
    await wrapper.setProps({ drawerOpen: false } as any);
    await nextTick();
    expect(agentKeys(wrapper)).toEqual(["ws-1:worker", "ws-2:worker"]);
  });

  it("explicit Show more and collapse still work immediately while locked", async () => {
    const store = useAppStore();
    const now = Date.now();
    store.payload = recentPayload({
      workspaces: Array.from({ length: 8 }, (_, i) => ({
        id: `ws-${i}`,
        name: `Workspace ${i}`,
        cwd: `/w${i}`,
        panels: [],
        icon: "W",
        color: "#fff",
        profileId: "default",
        lastWorkedAt: new Date(now - (i + 1) * MINUTE).toISOString(),
      })),
    });

    const wrapper = mount(SidebarPanel);
    await pointerEnter(wrapper);
    expect(recentIds(wrapper)).toHaveLength(7);

    // The lock holds back BACKGROUND reflow, never a command the user gave.
    await wrapper.get('[data-role="recent-shortcuts-more"]').trigger("click");
    expect(recentIds(wrapper)).toHaveLength(8);

    await wrapper.get(".recent-shortcuts__toggle").trigger("click");
    expect(recentIds(wrapper)).toEqual([]);
  });

  it("a search typed while the pointer rests on the list suppresses the shortcuts at once", async () => {
    const store = useAppStore();
    const now = Date.now();
    store.payload = recentPayload({
      workspaces: BASE_WORKSPACES.map((ws, i) => ({
        ...ws,
        lastWorkedAt: new Date(now - (i + 1) * MINUTE).toISOString(),
      })),
    });

    const wrapper = mount(SidebarPanel);
    await pointerEnter(wrapper);
    expect(recentIds(wrapper)).toHaveLength(4);

    // The user typed: an explicit command, not a background update. Deferring
    // it would leave the stale shortcut list beside the filtered tree — two
    // answers to one query.
    store.workspaceSearchQuery = "alpha";
    await nextTick();

    expect(wrapper.find('[data-role="recent-shortcuts"]').exists()).toBe(false);
    expect(recentIds(wrapper)).toEqual([]);

    // Clearing it brings them straight back, still locked and still stable.
    store.workspaceSearchQuery = "";
    await nextTick();
    expect(recentIds(wrapper)).toHaveLength(4);
  });

  it("toggling the star filter while locked applies immediately", async () => {
    const store = useAppStore();
    const now = Date.now();
    store.payload = recentPayload({
      workspaces: [
        { ...BASE_WORKSPACES[0], starred: true, lastWorkedAt: new Date(now - 2 * MINUTE).toISOString() },
        { ...BASE_WORKSPACES[1], lastWorkedAt: new Date(now - MINUTE).toISOString() },
      ],
    });

    const wrapper = mount(SidebarPanel);
    await pointerEnter(wrapper);
    expect(recentIds(wrapper)).toEqual(["ws-B", "ws-A"]);

    store.starFilterActive = true;
    await nextTick();
    expect(recentIds(wrapper)).toEqual(["ws-A"]);

    store.starFilterActive = false;
    await nextTick();
    expect(recentIds(wrapper)).toEqual(["ws-B", "ws-A"]);
  });

  it("a user command re-freezes from the live state, so it lands on a coherent list", async () => {
    const store = useAppStore();
    const now = Date.now();
    const two = (extra: AnyApi[] = []): AnyApi[] => [
      { ...BASE_WORKSPACES[0], lastWorkedAt: new Date(now - 2 * MINUTE).toISOString() },
      { ...BASE_WORKSPACES[1], lastWorkedAt: new Date(now - MINUTE).toISOString() },
      ...extra,
    ];

    store.payload = recentPayload({ workspaces: two() });
    const wrapper = mount(SidebarPanel);
    await pointerEnter(wrapper);

    // A background stamp arrives on a THIRD workspace — held back…
    store.payload = recentPayload({
      workspaces: two([{ ...BASE_WORKSPACES[2], lastWorkedAt: new Date(now).toISOString() }]),
    });
    await nextTick();
    expect(recentIds(wrapper)).toEqual(["ws-B", "ws-A"]);

    // …until the user's own command re-freezes the surface. A filter applied to
    // a stale set would answer nothing useful, so the re-freeze re-reads the
    // live rows and the pending arrival lands with it. That is the right
    // trade-off: the user just asked for a reflow, so no click target is being
    // pulled out from under a gesture they did not expect to change.
    store.starFilterActive = true;
    await nextTick();
    expect(recentIds(wrapper)).toEqual([]);

    store.starFilterActive = false;
    await nextTick();
    expect(recentIds(wrapper)).toEqual(["ws-C", "ws-B", "ws-A"]);
  });

  it("a lastWorkedAt change during the lock updates the time but never the order", async () => {
    const store = useAppStore();
    const now = Date.now();
    const workspaces = (bumpedAt: number): AnyApi[] => [
      { ...BASE_WORKSPACES[0], lastWorkedAt: new Date(bumpedAt).toISOString() },
      { ...BASE_WORKSPACES[1], lastWorkedAt: new Date(now - MINUTE).toISOString() },
    ];

    store.payload = recentPayload({ workspaces: workspaces(now - 10 * MINUTE) });
    const wrapper = mount(SidebarPanel);
    expect(recentIds(wrapper)).toEqual(["ws-B", "ws-A"]);
    expect(wrapper.findAll(".activity-row__trailing").map((a) => a.text())).toEqual(["1m", "10m"]);

    await pointerEnter(wrapper);
    // ws-A is worked in again — it would sort FIRST if the order were live.
    store.payload = recentPayload({ workspaces: workspaces(now) });
    await nextTick();

    expect(recentIds(wrapper)).toEqual(["ws-B", "ws-A"]);
    // …but its own timestamp did refresh inside the row it already occupies.
    expect(wrapper.findAll(".activity-row__trailing").map((a) => a.text())).toEqual(["1m", "now"]);
  });

  it("attention, active and grid state still update on an already-presented key", async () => {
    const store = useAppStore();
    const now = Date.now();
    const workspaces = [
      { ...BASE_WORKSPACES[0], lastWorkedAt: new Date(now - 2 * MINUTE).toISOString() },
      { ...BASE_WORKSPACES[1], lastWorkedAt: new Date(now - MINUTE).toISOString() },
    ];

    store.payload = recentPayload({ workspaces });
    const wrapper = mount(SidebarPanel);
    await pointerEnter(wrapper);
    expect(recentIds(wrapper)).toEqual(["ws-B", "ws-A"]);
    // The fixture starts on ws-A, so the SECOND card is the active one.
    expect(wrapper.findAll('.recent-shortcuts [data-role="activity-node-row"]')[0].classes()).not.toContain(
      "activity-row--active",
    );

    // A background alert lands on ws-A, ws-B becomes active and gets pinned to
    // a grid slot. None of that may change membership, order — or the height,
    // which is why these are all in-row tints rather than extra rows.
    store.payload = {
      ...recentPayload({
        workspaces,
        activeWorkspaceId: "ws-B",
        windowSlots: [
          {
            id: "win-test",
            profileId: "default",
            activeWorkspaceId: "ws-B",
            workspaceGrid: { layout: "cols", cellWorkspaceIds: ["ws-B", null] },
          },
        ],
      }),
      attention: {
        sessions: {},
        byWorkspace: { "ws-A": { count: 2, latestAt: new Date(now).toISOString(), alerts: [{}, {}] } },
      },
    } as AnyApi;
    await nextTick();

    expect(recentIds(wrapper)).toEqual(["ws-B", "ws-A"]);
    const rows = wrapper.findAll('.recent-shortcuts [data-role="activity-node-row"]');
    expect(rows[0].classes()).toContain("activity-row--active");
    expect(rows[0].classes()).toContain("activity-row--in-grid");
    expect(rows[0].get(".activity-row__slot").text()).toBe("1");
    expect(rows[1].classes()).not.toContain("activity-row--active");
    expect(rows[1].classes()).toContain("activity-row--attention");
    expect(rows[1].get(".activity-row__attention-count").text()).toBe("2");
  });

  it("the elapsed keeps ticking on a locked RUNNING row", async () => {
    vi.useFakeTimers();
    try {
      const store = useAppStore();
      const now = Date.now();
      const one = taskWs("ws-1", "One", now - 5 * MINUTE);
      store.payload = {
        ...makePayload({ workspaces: [one] }),
        taskRunner: { "ws-1": { state: "running", startedAt: now - 5 * MINUTE } },
      } as AnyApi;

      const wrapper = mount(SidebarPanel);
      await pointerEnter(wrapper);
      expect(wrapper.get(".running-agents .activity-row__trailing").text()).toBe("5m");

      // Time is not layout: the row keeps its size, so the clock may advance.
      await vi.advanceTimersByTimeAsync(10 * MINUTE);
      await nextTick();

      expect(agentKeys(wrapper)).toEqual(["ws-1:worker"]);
      expect(wrapper.get(".running-agents .activity-row__trailing").text()).toBe("15m");
    } finally {
      vi.useRealTimers();
    }
  });

  it("an item crossing the 24h boundary during the lock is not removed", async () => {
    vi.useFakeTimers();
    try {
      const store = useAppStore();
      const now = Date.now();
      store.payload = recentPayload({
        workspaces: [
          { ...BASE_WORKSPACES[0], lastWorkedAt: new Date(now - (24 * 60 - 1) * MINUTE).toISOString() },
          { ...BASE_WORKSPACES[1], lastWorkedAt: new Date(now - MINUTE).toISOString() },
        ],
      });

      const wrapper = mount(SidebarPanel);
      expect(recentIds(wrapper)).toEqual(["ws-B", "ws-A"]);

      await pointerEnter(wrapper);
      await vi.advanceTimersByTimeAsync(2 * MINUTE);
      await nextTick();

      // Still two rows: the aged-out one holds its place under the pointer.
      expect(recentIds(wrapper)).toEqual(["ws-B", "ws-A"]);
      expect(wrapper.get(".recent-shortcuts__title").text()).toContain("(2)");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a hard delete during the lock becomes an inert placeholder in the same slot", async () => {
    const store = useAppStore();
    const now = Date.now();
    store.payload = recentPayload({
      workspaces: [
        { ...BASE_WORKSPACES[0], lastWorkedAt: new Date(now - 2 * MINUTE).toISOString() },
        { ...BASE_WORKSPACES[1], lastWorkedAt: new Date(now - MINUTE).toISOString() },
      ],
    });
    const activate = vi.spyOn(store, "activateWorkspace").mockResolvedValue(undefined);

    const wrapper = mount(SidebarPanel);
    expect(recentIds(wrapper)).toEqual(["ws-B", "ws-A"]);

    await pointerEnter(wrapper);
    // ws-B is deleted outright.
    store.payload = recentPayload({
      workspaces: [{ ...BASE_WORKSPACES[0], lastWorkedAt: new Date(now - 2 * MINUTE).toISOString() }],
    });
    await nextTick();

    // The slot is held, so ws-A did not move up — but the placeholder is inert.
    expect(recentIds(wrapper)).toEqual(["ws-B", "ws-A"]);
    const rows = wrapper.findAll('.recent-shortcuts [data-role="activity-node-row"]');
    expect(rows[0].classes()).toContain("activity-row--missing");
    expect(rows[0].attributes("disabled")).toBeDefined();
    expect(rows[1].classes()).not.toContain("activity-row--missing");

    await rows[0].trigger("click");
    await flushPromises();
    expect(activate).not.toHaveBeenCalled();
  });

  it("a deleted RUNNING host becomes an inert placeholder that cannot navigate", async () => {
    const store = useAppStore();
    const now = Date.now();
    const one = taskWs("ws-1", "One", now - 2 * MINUTE);
    const two = taskWs("ws-2", "Two", now - MINUTE);
    const inGrid = vi.fn().mockResolvedValue(undefined);
    (store as AnyApi).activateWorkspaceInGrid = inGrid;

    store.payload = {
      ...makePayload({ workspaces: [one, two] }),
      taskRunner: { "ws-1": { state: "running" }, "ws-2": { state: "running" } },
    } as AnyApi;
    const wrapper = mount(SidebarPanel);
    await pointerEnter(wrapper);

    store.payload = { ...makePayload({ workspaces: [two] }), taskRunner: { "ws-2": { state: "running" } } } as AnyApi;
    await nextTick();

    expect(agentKeys(wrapper)).toEqual(["ws-1:worker", "ws-2:worker"]);
    const rows = wrapper.findAll('.running-agents [data-role="activity-node-row"]');
    expect(rows[0].classes()).toContain("activity-row--missing");
    expect(rows[0].attributes("disabled")).toBeDefined();

    await rows[0].trigger("click");
    await flushPromises();
    expect(inGrid).not.toHaveBeenCalled();
  });

  it("the canonical tree is not frozen — it never reflowed on status changes anyway", async () => {
    const store = useAppStore();
    store.payload = makePayload({ workspaces: BASE_WORKSPACES });

    const wrapper = mount(SidebarPanel);
    await pointerEnter(wrapper);
    const treeIds = (): string[] =>
      wrapper
        .findAll('[data-role="workspace-list"] > .workspace-card[data-workspace-id]')
        .map((c: AnyApi) => c.attributes("data-workspace-id"));
    expect(treeIds()).toEqual(["ws-A", "ws-B", "ws-C", "ws-D"]);

    // A workspace really is added: the tree is the complete list, always.
    store.payload = makePayload({
      workspaces: [
        ...BASE_WORKSPACES,
        { id: "ws-E", name: "Epsilon", cwd: "/e", panels: [], icon: "E", color: "#fff", profileId: "default" },
      ],
    });
    await nextTick();

    expect(treeIds()).toEqual(["ws-A", "ws-B", "ws-C", "ws-D", "ws-E"]);
  });

  it("no layout animation wraps the dynamic surfaces", () => {
    const store = useAppStore();
    store.payload = { ...makePayload(), taskRunner: {} } as AnyApi;
    const wrapper = mount(SidebarPanel);

    // A TransitionGroup would reintroduce exactly the moving target the lock
    // exists to prevent, so neither surface may be wrapped in one.
    expect(wrapper.find('[data-role="workspace-list"] transition-group').exists()).toBe(false);
    expect(wrapper.html()).not.toContain("v-move");
  });
});

// ---------------------------------------------------------------------------
// V3 review, §3 — the recent shortcut as a contextual card
//
// The card must feel like a lighter version of the familiar WorkspaceCard, and
// its identity data must come from the ONE canonical card mapping, while the
// list itself stays strictly time-ordered and never becomes a second tree.
// ---------------------------------------------------------------------------

describe("SidebarPanel — hierarchical recent entries", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    (window as AnyApi).strideterm = { startupFlags: { windowId: "win-test" } };
  });

  const MINUTE = 60 * 1000;

  function recentPayload(overrides: AnyApi = {}): StatePayload {
    return makePayload({
      profiles: [{ id: "default", name: "Default", sidebarWorkspaceViewMode: "recent" }],
      ...overrides,
    });
  }

  function entries(wrapper: AnyApi): AnyApi[] {
    return wrapper.findAll('.recent-shortcuts [data-role="activity-node-row"]');
  }

  function cards(wrapper: AnyApi): AnyApi[] {
    return wrapper.findAll('.recent-shortcuts [data-role="activity-node-row"]');
  }

  function cardIds(wrapper: AnyApi): string[] {
    return entries(wrapper).map((e: AnyApi) => e.attributes("data-workspace-id"));
  }

  /** root → child → grandchild, each worked in at a different time. */
  function nestedChain(now: number): AnyApi[] {
    return [
      {
        id: "ws-root",
        name: "strideterm",
        cwd: "/root",
        panels: [],
        icon: "S",
        color: "#112233",
        profileId: "default",
        lastWorkedAt: new Date(now - 4 * MINUTE).toISOString(),
      },
      {
        id: "ws-child",
        name: "mobile",
        cwd: "/root/mobile",
        panels: [],
        icon: "M",
        color: "#445566",
        profileId: "default",
        quickfix: { parentWorkspaceId: "ws-root" },
        lastWorkedAt: new Date(now - MINUTE).toISOString(),
      },
      {
        id: "ws-grandchild",
        name: "mobile-fix",
        cwd: "/root/mobile/fix",
        panels: [],
        icon: "F",
        color: "#778899",
        profileId: "default",
        quickfix: { parentWorkspaceId: "ws-child" },
        lastWorkedAt: new Date(now - 2 * MINUTE).toISOString(),
      },
    ];
  }

  // V5 review, §"P1 UX — per-result ancestry přímo vytváří duplicitní Azure
  // větev". Connected results are ONE cluster: each workspace drawn exactly
  // once, indented inside the cluster's own border, never as a second copy of
  // a branch already on screen.
  it("connected results share one cluster, each workspace drawn exactly once", () => {
    const store = useAppStore();
    store.payload = recentPayload({ workspaces: nestedChain(Date.now()) });

    const wrapper = mount(SidebarPanel);

    expect(wrapper.findAll('.recent-shortcuts [data-role="activity-cluster"]')).toHaveLength(1);
    expect(cardIds(wrapper)).toEqual(["ws-root", "ws-child", "ws-grandchild"]);
    // No name appears twice anywhere in the section.
    expect(new Set(cardIds(wrapper)).size).toBe(3);
    // The indent is the row's own depth INSIDE the cluster — no free
    // `margin-left` that could bridge two neighbouring results.
    expect(entries(wrapper).map((e: AnyApi) => e.attributes("data-depth"))).toEqual(["0", "1", "2"]);
    for (const entry of entries(wrapper)) expect(entry.attributes("style")).not.toContain("margin-left");
    // The colour comes from the canonical card mapping, not from a second
    // derivation — so the shortcut and the tree card share an accent.
    const child = entries(wrapper)[cardIds(wrapper).indexOf("ws-child")];
    expect(child.attributes("style")).toContain("--accent: #445566");
    // Every result is a full row with its own time; a recent parent is an
    // activity node, never a context copy of itself.
    expect(wrapper.findAll('.recent-shortcuts [data-role="activity-context-row"]')).toHaveLength(0);
  });

  // The screenshot case, stated as a DOM invariant: `Azure DevOps` and its two
  // recent descendants form ONE cluster with each identity drawn once, not two
  // blocks repeating the same branch.
  it("the Azure case: a recent PR and its recent task make one deduplicated cluster", () => {
    const store = useAppStore();
    const now = Date.now();
    store.payload = recentPayload({
      workspaces: [
        { id: "ws-az", name: "Azure DevOps", cwd: "/az", panels: [], icon: "AZ", color: "#fff", profileId: "default" },
        {
          id: "ws-pr",
          name: "mhub PR #30746",
          cwd: "/pr",
          panels: [],
          icon: "AZ",
          color: "#fff",
          profileId: "default",
          review: { checkout: { mode: "managed-worktree" }, parentWorkspaceId: "ws-az" },
          lastWorkedAt: new Date(now - MINUTE).toISOString(),
        },
        {
          id: "ws-task",
          name: "pr-30746",
          cwd: "/pr/t",
          panels: [],
          icon: "BOT",
          color: "#fff",
          profileId: "default",
          task: { parentWorkspaceId: "ws-pr" },
          lastWorkedAt: new Date(now - 10 * 1000).toISOString(),
        },
      ],
    });

    const wrapper = mount(SidebarPanel);

    expect(wrapper.findAll('.recent-shortcuts [data-role="activity-cluster"]')).toHaveLength(1);
    const contexts = wrapper.findAll('.recent-shortcuts [data-role="activity-context-row"]');
    // `Azure DevOps` is not itself recent, so it appears ONCE, as context.
    expect(contexts).toHaveLength(1);
    expect(contexts[0].attributes("data-workspace-id")).toBe("ws-az");
    // Both recent workspaces keep their own row and their own time; the shared
    // provider context is not repeated and gets no time of its own.
    expect(cardIds(wrapper)).toEqual(["ws-pr", "ws-task"]);
    expect(contexts[0].find(".activity-row__trailing").exists()).toBe(false);
    expect(wrapper.findAll(".recent-shortcuts .activity-row__trailing").map((a: AnyApi) => a.text())).toEqual([
      "1m",
      "now",
    ]);
  });

  it("a recent ancestor becomes an activity node instead of gaining a context copy", () => {
    const store = useAppStore();
    const now = Date.now();
    const workspaces = nestedChain(now);
    store.payload = recentPayload({ workspaces });

    const wrapper = mount(SidebarPanel);

    // `ws-root` is recent, so it is the cluster's first ACTIVITY row — there is
    // no `strideterm` context row above it.
    expect(wrapper.findAll('.recent-shortcuts [data-role="activity-context-row"]')).toHaveLength(0);
    expect(entries(wrapper)[0].attributes("data-workspace-id")).toBe("ws-root");
    expect(entries(wrapper)[0].find(".activity-row__trailing").text()).toBe("4m");
  });

  it("a top-level workspace gets one plain row with no context above it", () => {
    const store = useAppStore();
    const now = Date.now();
    store.payload = recentPayload({ workspaces: nestedChain(now) });

    const wrapper = mount(SidebarPanel);
    const root = entries(wrapper)[cardIds(wrapper).indexOf("ws-root")];

    expect(root.attributes("data-depth")).toBe("0");
    // The row's second line still exists (equal height) and carries the same
    // short summary the tree card shows for a workspace with no git snapshot.
    expect(root.get(".activity-row__summary").text()).toBe("0 tabs");
  });

  // V5 acceptance: the parent context is not a recent result, so it cannot
  // consume a slot in the default seven and is never in the count.
  it("a parent context is never counted as a recent result", () => {
    const store = useAppStore();
    const now = Date.now();
    // Two unrelated branches, each with a NON-recent parent, so both draw a
    // context row that must stay out of the count.
    store.payload = recentPayload({
      workspaces: [
        { id: "p1", name: "Parent one", cwd: "/1", panels: [], icon: "P", color: "#fff", profileId: "default" },
        { id: "p2", name: "Parent two", cwd: "/2", panels: [], icon: "P", color: "#fff", profileId: "default" },
        {
          id: "c1",
          name: "Child one",
          cwd: "/1/c",
          panels: [],
          icon: "C",
          color: "#fff",
          profileId: "default",
          quickfix: { parentWorkspaceId: "p1" },
          lastWorkedAt: new Date(now - MINUTE).toISOString(),
        },
        {
          id: "c2",
          name: "Child two",
          cwd: "/2/c",
          panels: [],
          icon: "C",
          color: "#fff",
          profileId: "default",
          quickfix: { parentWorkspaceId: "p2" },
          lastWorkedAt: new Date(now - 2 * MINUTE).toISOString(),
        },
      ],
    });

    const wrapper = mount(SidebarPanel);

    expect(cardIds(wrapper)).toEqual(["c1", "c2"]);
    expect(wrapper.findAll('.recent-shortcuts [data-role="activity-context-row"]')).toHaveLength(2);
    expect(wrapper.get(".recent-shortcuts__title").text()).toContain("(2)");
  });

  // The original screenshot case, stated as a DOM invariant: an unrelated
  // time-neighbour never lends its box to a nested result.
  it("two unrelated branches are two clusters with a clear boundary", () => {
    const store = useAppStore();
    const now = Date.now();
    store.payload = recentPayload({
      workspaces: [
        {
          id: "ws-stash",
          name: "teststash",
          cwd: "/stash",
          panels: [],
          icon: "T",
          color: "#aa1111",
          profileId: "default",
          lastWorkedAt: new Date(now).toISOString(),
        },
        { id: "ws-root", name: "strideterm", cwd: "/r", panels: [], icon: "S", color: "#112233", profileId: "default" },
        {
          id: "ws-child",
          name: "strideterm / mobile",
          cwd: "/r/m",
          panels: [],
          icon: "M",
          color: "#445566",
          profileId: "default",
          quickfix: { parentWorkspaceId: "ws-root" },
          lastWorkedAt: new Date(now - 2 * 60 * MINUTE).toISOString(),
        },
      ],
    });

    const wrapper = mount(SidebarPanel);
    expect(cardIds(wrapper)).toEqual(["ws-stash", "ws-child"]);

    const clusters = wrapper.findAll('.recent-shortcuts [data-role="activity-cluster"]');
    expect(clusters).toHaveLength(2);
    // `teststash` is a cluster of its own and holds nothing else.
    expect(clusters[0].findAll("button")).toHaveLength(1);
    expect(clusters[0].find('[data-workspace-id="ws-child"]').exists()).toBe(false);
    // The child sits in its OWN cluster, under a `strideterm` context row —
    // never under `teststash`.
    const context = clusters[1].get('[data-role="activity-context-row"]');
    expect(context.attributes("data-workspace-id")).toBe("ws-root");
    expect(context.get(".activity-row__label").text()).toBe("strideterm");
    expect(clusters[1].get('[data-role="activity-node-row"]').attributes("data-workspace-id")).toBe("ws-child");
  });

  // V4 §"Pravidla komponenty" 8 / acceptance: recent uses the SAME visual
  // identity as ALL WORKSPACES and only removes the management surface.
  it("root and nested cards wear the same badge, accent and summary as their tree cards", () => {
    const store = useAppStore();
    store.payload = recentPayload({ workspaces: nestedChain(Date.now()) });

    const wrapper = mount(SidebarPanel);

    for (const [id, color, icon] of [
      ["ws-root", "#112233", "S"],
      ["ws-child", "#445566", "M"],
    ] as const) {
      const card = cards(wrapper)[cardIds(wrapper).indexOf(id)];
      const treeCard = wrapper.findAll(`.workspace-card[data-workspace-id="${id}"]`)[0];

      expect(card.attributes("style")).toContain(`--accent: ${color}`);
      expect(treeCard.attributes("style")).toContain(`--accent: ${color}`);
      expect(card.get(".activity-row__badge").text()).toContain(icon);
      expect(treeCard.get(".workspace-card__badge").text()).toContain(icon);
      // Same short summary text, from the one canonical card mapping.
      expect(card.get(".activity-row__summary").text()).toBe(treeCard.get(".workspace-card__summary").text());
    }
  });

  // V5 review, §1: inside a cluster HIERARCHY wins — parent before child — and
  // the clusters themselves stay ordered by their newest activity. Time is
  // still on every row; branch coherence is worth more than a flat interleave.
  it("clusters are time-ordered, but inside one the parent comes before its child", () => {
    const store = useAppStore();
    const now = Date.now();
    store.payload = recentPayload({
      workspaces: [
        ...nestedChain(now),
        {
          id: "ws-other",
          name: "unrelated",
          cwd: "/o",
          panels: [],
          icon: "O",
          color: "#fff",
          profileId: "default",
          lastWorkedAt: new Date(now - 3 * MINUTE).toISOString(),
        },
      ],
    });

    const wrapper = mount(SidebarPanel);

    // The strideterm cluster's newest member is 1m old, so it comes first even
    // though its own root was worked in 4m ago; `unrelated` (3m) follows.
    expect(cardIds(wrapper)).toEqual(["ws-root", "ws-child", "ws-grandchild", "ws-other"]);
    expect(wrapper.findAll(".recent-shortcuts .activity-row__trailing").map((a: AnyApi) => a.text())).toEqual([
      "4m",
      "1m",
      "2m",
      "3m",
    ]);
  });

  it("sibling branches inside a cluster are ordered by their own newest activity", () => {
    const store = useAppStore();
    const now = Date.now();
    store.payload = recentPayload({
      workspaces: [
        { id: "root", name: "Root", cwd: "/r", panels: [], icon: "R", color: "#fff", profileId: "default" },
        {
          id: "older",
          name: "Older branch",
          cwd: "/r/a",
          panels: [],
          icon: "A",
          color: "#fff",
          profileId: "default",
          quickfix: { parentWorkspaceId: "root" },
          lastWorkedAt: new Date(now - 9 * MINUTE).toISOString(),
        },
        {
          id: "newer",
          name: "Newer branch",
          cwd: "/r/b",
          panels: [],
          icon: "B",
          color: "#fff",
          profileId: "default",
          quickfix: { parentWorkspaceId: "root" },
          lastWorkedAt: new Date(now - MINUTE).toISOString(),
        },
      ],
    });

    const wrapper = mount(SidebarPanel);

    expect(cardIds(wrapper)).toEqual(["newer", "older"]);
    expect(wrapper.findAll('.recent-shortcuts [data-role="activity-cluster"]')).toHaveLength(1);
  });

  it("the limit counts recent workspaces only — added context never uses a slot", () => {
    const store = useAppStore();
    const now = Date.now();
    // Eight recent LEAVES, each under its own non-recent parent: the ancestor
    // closure adds eight context rows, and none of them may cost a slot.
    const workspaces = Array.from({ length: 8 }, (_, i) => [
      { id: `p-${i}`, name: `Parent ${i}`, cwd: `/p${i}`, panels: [], icon: "P", color: "#fff", profileId: "default" },
      {
        id: `ws-${i}`,
        name: `Level ${i}`,
        cwd: `/p${i}/c`,
        panels: [],
        icon: "L",
        color: "#fff",
        profileId: "default",
        quickfix: { parentWorkspaceId: `p-${i}` },
        lastWorkedAt: new Date(now - (i + 1) * MINUTE).toISOString(),
      },
    ]).flat();
    store.payload = recentPayload({ workspaces });

    const wrapper = mount(SidebarPanel);

    expect(cardIds(wrapper)).toHaveLength(7);
    expect(wrapper.get(".recent-shortcuts__title").text()).toContain("(8)");
    expect(wrapper.get('[data-role="recent-shortcuts-more"]').text()).toBe("Show 1 more");
    // Seven RESULTS — plus the seven parent context rows they need, which are
    // not results and never push the eighth workspace out.
    expect(wrapper.findAll('.recent-shortcuts [data-role="activity-context-row"]')).toHaveLength(7);

    // `Show more` widens the ACTIVITY set and the forest is rebuilt from it.
    (wrapper.get('[data-role="recent-shortcuts-more"]').element as HTMLElement).click();
    return nextTick().then(() => {
      expect(cardIds(wrapper)).toHaveLength(8);
      expect(wrapper.findAll('.recent-shortcuts [data-role="activity-context-row"]')).toHaveLength(8);
    });
  });

  it("a card carries no star, menu, task control, order index or drag handle", async () => {
    const store = useAppStore();
    const now = Date.now();
    store.payload = recentPayload({
      workspaces: [{ ...BASE_WORKSPACES[0], lastWorkedAt: new Date(now - MINUTE).toISOString() }],
    });
    const reorder = vi.spyOn(store, "reorderWorkspaces").mockResolvedValue(undefined);

    const wrapper = mount(SidebarPanel);
    const card = cards(wrapper)[0];

    expect(card.findAll("button")).toHaveLength(0); // the card IS the button
    expect(card.find(".workspace-card__star").exists()).toBe(false);
    expect(card.find(".workspace-card__action").exists()).toBe(false);
    expect(card.find(".workspace-card__index").exists()).toBe(false);
    expect(card.attributes("draggable")).toBeUndefined();

    const dataTransfer = {
      effectAllowed: "",
      dropEffect: "",
      setData: () => {},
      getData: () => "",
    };
    await card.trigger("dragstart", { dataTransfer });
    await card.trigger("drop", { dataTransfer, clientY: 0 });
    await flushPromises();
    expect(reorder).not.toHaveBeenCalled();
  });

  it("clicking a card activates its workspace, and so does Enter", async () => {
    const store = useAppStore();
    const now = Date.now();
    store.payload = recentPayload({
      workspaces: [{ ...BASE_WORKSPACES[0], lastWorkedAt: new Date(now - MINUTE).toISOString() }],
    });
    const activate = vi.spyOn(store, "activateWorkspace").mockResolvedValue(undefined);

    const wrapper = mount(SidebarPanel);
    await cards(wrapper)[0].trigger("click");
    await flushPromises();

    expect(activate).toHaveBeenCalledWith("ws-A");
    // A native <button> converts Enter into a click, so the same handler runs.
    expect(cards(wrapper)[0].element.tagName).toBe("BUTTON");
  });

  it("the accessible name and the tooltip carry the full path and the relative time", () => {
    const store = useAppStore();
    store.payload = recentPayload({ workspaces: nestedChain(Date.now()) });

    const wrapper = mount(SidebarPanel);
    const grandchild = cards(wrapper)[cardIds(wrapper).indexOf("ws-grandchild")];
    const label = grandchild.attributes("aria-label")!;

    expect(label).toContain("strideterm › mobile › mobile-fix");
    expect(label).toContain("2m ago");
    expect(grandchild.attributes("title")).toBe(label);
  });

  it("the name and the time survive a narrow sidebar; only the path may be clipped", () => {
    const store = useAppStore();
    const now = Date.now();
    store.payload = recentPayload({
      workspaces: [
        {
          id: "ws-p",
          name: "A very long parent workspace name",
          cwd: "/p",
          panels: [],
          icon: "P",
          color: "#fff",
          profileId: "default",
        },
        {
          id: "ws-c",
          name: "AAAAAAAAAAAAtest - test",
          cwd: "/c",
          panels: [],
          icon: "C",
          color: "#fff",
          profileId: "default",
          quickfix: { parentWorkspaceId: "ws-p" },
          lastWorkedAt: new Date(now - 4 * MINUTE).toISOString(),
        },
      ],
    });

    const wrapper = mount(SidebarPanel);
    const card = cards(wrapper)[0];

    // Name and time are always fully rendered in the DOM; the LABEL is the
    // element CSS is allowed to ellipsise (see sidebar.css), and the
    // untruncated path is still reachable through the accessible name and the
    // context row's own tooltip.
    expect(card.get(".activity-row__label").text()).toBe("AAAAAAAAAAAAtest - test");
    expect(card.get(".activity-row__trailing").text()).toBe("4m");
    const context = wrapper.get('.recent-shortcuts [data-role="activity-context-row"]');
    expect(context.get(".activity-row__label").text()).toBe("A very long parent workspace name");
    expect(context.attributes("title")).toContain("A very long parent workspace name");
    expect(card.attributes("aria-label")).toContain("A very long parent workspace name › AAAAAAAAAAAAtest - test");
  });

  it("search and the collapsed strip still fall back to the single canonical tree", async () => {
    const store = useAppStore();
    const now = Date.now();
    store.payload = recentPayload({
      workspaces: BASE_WORKSPACES.map((ws, i) => ({
        ...ws,
        lastWorkedAt: new Date(now - (i + 1) * MINUTE).toISOString(),
      })),
    });

    const wrapper = mount(SidebarPanel);
    expect(cardIds(wrapper)).toHaveLength(4);

    store.workspaceSearchQuery = "alpha";
    await nextTick();
    expect(wrapper.find('[data-role="recent-shortcuts"]').exists()).toBe(false);

    store.workspaceSearchQuery = "";
    store.sidebarCollapsed = true;
    await nextTick();
    expect(wrapper.find('[data-role="recent-shortcuts"]').exists()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// V4 review, §"P2" (three findings) — the lock has to hold the ROW, not just
// its slot in the list: the same key must keep its structure, its geometry and
// its navigation target. And the two commands that were still being deferred —
// switching the active profile and starring/unstarring a workspace — are
// explicit user actions and must land at once.
// ---------------------------------------------------------------------------

describe("SidebarPanel — V4 lock: structure, target and explicit commands", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    (window as AnyApi).strideterm = { startupFlags: { windowId: "win-test" } };
  });

  const MINUTE = 60 * 1000;
  const GRACE_MS = 500;

  function recentPayload(overrides: AnyApi = {}): StatePayload {
    return makePayload({
      profiles: [{ id: "default", name: "Default", sidebarWorkspaceViewMode: "recent" }],
      ...overrides,
    });
  }

  function entries(wrapper: AnyApi): AnyApi[] {
    return wrapper.findAll('.recent-shortcuts [data-role="activity-node-row"]');
  }

  function recentIds(wrapper: AnyApi): string[] {
    return entries(wrapper).map((r: AnyApi) => r.attributes("data-workspace-id"));
  }

  async function pointerEnter(wrapper: AnyApi): Promise<void> {
    await wrapper.get('[data-role="workspace-list"]').trigger("pointerenter");
  }

  async function pointerLeave(wrapper: AnyApi): Promise<void> {
    await wrapper.get('[data-role="workspace-list"]').trigger("pointerleave");
  }

  function ws(id: string, name: string, extra: AnyApi = {}): AnyApi {
    return { id, name, cwd: `/${id}`, panels: [], icon: id[3] || "W", color: "#fff", profileId: "default", ...extra };
  }

  // V5 review, §2 (last bullets): the lock holds the whole FOREST — cluster
  // membership, each node's role, the parent-child edges, the order and every
  // navigation target — not just a list of keys. A background reparent must
  // not restructure the cluster the pointer is aimed at.
  it("a background reparent leaves the cluster, its context row and its target alone", async () => {
    vi.useFakeTimers();
    try {
      const store = useAppStore();
      const now = Date.now();
      const child = (parentId: string): AnyApi =>
        ws("ws-child", "Child", {
          quickfix: { parentWorkspaceId: parentId },
          lastWorkedAt: new Date(now - MINUTE).toISOString(),
        });

      const contextOf = (wrapper: AnyApi): AnyApi =>
        wrapper.get('.recent-shortcuts [data-role="activity-context-row"]');

      store.payload = recentPayload({ workspaces: [ws("ws-root", "Root"), ws("ws-other", "Other"), child("ws-root")] });
      const wrapper = mount(SidebarPanel);
      expect(contextOf(wrapper).attributes("data-workspace-id")).toBe("ws-root");

      await pointerEnter(wrapper);
      // The child is reparented in the background. (The rename of the OTHER
      // workspace is what makes the payload visible to the sidebar at all —
      // `filteredWorkspaces` memoises on name/icon/colour/lastWorkedAt.)
      store.payload = recentPayload({
        workspaces: [ws("ws-root", "Root"), ws("ws-other", "Other renamed"), child("ws-other")],
      });
      await nextTick();

      // Same cluster, same context row, same target — the edge under the
      // pointer did not move.
      expect(contextOf(wrapper).attributes("data-workspace-id")).toBe("ws-root");
      expect(contextOf(wrapper).get(".activity-row__label").text()).toBe("Root");
      expect(recentIds(wrapper)).toEqual(["ws-child"]);

      await pointerLeave(wrapper);
      await vi.advanceTimersByTimeAsync(GRACE_MS + 50);
      await nextTick();

      expect(contextOf(wrapper).attributes("data-workspace-id")).toBe("ws-other");
      expect(contextOf(wrapper).get(".activity-row__label").text()).toBe("Other renamed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a rename during the lock does not re-wrap the row under the pointer", async () => {
    vi.useFakeTimers();
    try {
      const store = useAppStore();
      const now = Date.now();
      const named = (name: string): AnyApi[] => [
        ws("ws-a", name, { lastWorkedAt: new Date(now - MINUTE).toISOString() }),
      ];

      store.payload = recentPayload({ workspaces: named("Short") });
      const wrapper = mount(SidebarPanel);
      await pointerEnter(wrapper);

      store.payload = recentPayload({ workspaces: named("A dramatically longer workspace name that wraps") });
      await nextTick();
      expect(wrapper.get(".activity-row__label").text()).toBe("Short");

      await pointerLeave(wrapper);
      await vi.advanceTimersByTimeAsync(GRACE_MS + 50);
      await nextTick();
      expect(wrapper.get(".activity-row__label").text()).toBe("A dramatically longer workspace name that wraps");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a RUNNING row whose host and view move under the SAME key keeps its click target", async () => {
    const store = useAppStore();
    const startedAt = Date.now() - 60 * MINUTE;
    // An attached Companion task: while the Primary is hosted the row opens the
    // TASK workspace; once the Primary goes missing the same worker-session key
    // resolves to the SOURCE workspace instead. Same key, different target.
    const payload = (primaryMissing: boolean, sourceName: string): StatePayload =>
      makePayload({
        workspaces: [
          {
            id: "ws-src",
            name: sourceName,
            cwd: "/s",
            panels: [{ id: "primary", title: "Primary Claude" }],
            icon: "S",
            color: "#fff",
            profileId: "default",
          },
          {
            id: "ws-comp",
            name: "Companion",
            cwd: "/c",
            icon: "C",
            color: "#fff",
            profileId: "default",
            kind: "task",
            panels: [{ id: "judge", title: "Companion" }],
            task: {
              taskId: "t-comp",
              state: "running",
              mode: "attached",
              workerWorkspaceId: "ws-src",
              workerPanelId: "primary",
              judgePanelId: "judge",
              startedAt,
              totalPausedMs: 0,
              pausedAt: null,
              finishedAt: null,
              ...(primaryMissing ? { primaryMissing: true } : {}),
            },
          },
        ],
        activeWorkspaceId: "ws-src",
        windowSlots: [{ id: "win-test", profileId: "default", activeWorkspaceId: "ws-src" }],
      });

    store.payload = payload(false, "Source");
    const inGrid = vi.fn().mockResolvedValue(undefined);
    const view = vi.fn().mockResolvedValue(undefined);
    (store as AnyApi).activateWorkspaceInGrid = inGrid;
    (store as AnyApi).activateView = view;

    const wrapper = mount(SidebarPanel);
    const key = wrapper.get('.running-agents [data-role="activity-node-row"]').attributes("data-row-key");
    expect(wrapper.get('.running-agents [data-role="activity-node-row"]').text()).toContain("Companion");

    await pointerEnter(wrapper);
    store.payload = payload(true, "Source renamed");
    await nextTick();

    // Same row, same key — and the label and target it was aimed at.
    expect(wrapper.get('.running-agents [data-role="activity-node-row"]').attributes("data-row-key")).toBe(key);
    expect(wrapper.get('.running-agents [data-role="activity-node-row"]').text()).toContain("Companion");
    expect(wrapper.get('.running-agents [data-role="activity-node-row"]').text()).not.toContain("Source renamed");

    await wrapper.get('.running-agents [data-role="activity-node-row"]').trigger("click");
    await flushPromises();
    expect(inGrid).toHaveBeenCalledWith("ws-comp");
    expect(view).not.toHaveBeenCalledWith("ws-src:primary");
  });

  it("switching profile in an open drawer shows the new profile at once, with no stale placeholder", async () => {
    const store = useAppStore();
    const now = Date.now();
    const workspaces = [
      { ...ws("ws-a1", "A one"), profileId: "p1", lastWorkedAt: new Date(now - MINUTE).toISOString() },
      { ...ws("ws-a2", "A two"), profileId: "p1", lastWorkedAt: new Date(now - 2 * MINUTE).toISOString() },
      { ...ws("ws-b1", "B one"), profileId: "p2", lastWorkedAt: new Date(now - 3 * MINUTE).toISOString() },
    ];
    const profiles = [
      { id: "p1", name: "One", sidebarWorkspaceViewMode: "recent" },
      { id: "p2", name: "Two", sidebarWorkspaceViewMode: "recent" },
    ];
    const inProfile = (profileId: string): StatePayload =>
      makePayload({
        workspaces,
        profiles,
        windowSlots: [{ id: "win-test", profileId, activeWorkspaceId: "" }],
      });

    store.payload = inProfile("p1");
    // The drawer holds the lock for its whole lifetime — the hardest case.
    const wrapper = mount(SidebarPanel, { props: { drawerOpen: true } });
    expect(recentIds(wrapper)).toEqual(["ws-a1", "ws-a2"]);

    store.payload = inProfile("p2");
    await nextTick();

    // Only the new profile's rows, immediately, and none of the old profile's
    // ids surviving as a `gone` placeholder.
    expect(recentIds(wrapper)).toEqual(["ws-b1"]);
    expect(wrapper.findAll(".activity-row--missing")).toHaveLength(0);
  });

  it("a profile switch resets Show more, so every profile starts at the safe seven", async () => {
    const store = useAppStore();
    const now = Date.now();
    const many = (profileId: string, count: number, prefix: string): AnyApi[] =>
      Array.from({ length: count }, (_, i) => ({
        ...ws(`${prefix}-${i}`, `${prefix} ${i}`),
        profileId,
        lastWorkedAt: new Date(now - (i + 1) * MINUTE).toISOString(),
      }));
    const workspaces = [...many("p1", 9, "one"), ...many("p2", 9, "two")];
    const profiles = [
      { id: "p1", name: "One", sidebarWorkspaceViewMode: "recent" },
      { id: "p2", name: "Two", sidebarWorkspaceViewMode: "recent" },
    ];
    const inProfile = (profileId: string): StatePayload =>
      makePayload({ workspaces, profiles, windowSlots: [{ id: "win-test", profileId, activeWorkspaceId: "" }] });

    store.payload = inProfile("p1");
    const wrapper = mount(SidebarPanel, { props: { drawerOpen: true } });
    expect(recentIds(wrapper)).toHaveLength(7);

    await wrapper.get('[data-role="recent-shortcuts-more"]').trigger("click");
    await nextTick();
    expect(recentIds(wrapper)).toHaveLength(9);

    store.payload = inProfile("p2");
    await nextTick();

    expect(recentIds(wrapper).every((id) => id.startsWith("two-"))).toBe(true);
    expect(recentIds(wrapper)).toHaveLength(7);
    expect(wrapper.get('[data-role="recent-shortcuts-more"]').text()).toBe("Show 2 more");
  });

  it("an explicit unstar under an active star filter drops the row at once and re-freezes the rest", async () => {
    const store = useAppStore();
    const now = Date.now();
    const saveWorkspace = vi.fn().mockResolvedValue(undefined);
    store.payload = recentPayload({
      workspaces: [
        { ...ws("ws-a", "Alpha"), starred: true, lastWorkedAt: new Date(now - MINUTE).toISOString() },
        { ...ws("ws-b", "Beta"), starred: true, lastWorkedAt: new Date(now - 2 * MINUTE).toISOString() },
      ],
    });
    store.starFilterActive = true;

    const wrapper = mount(SidebarPanel, { global: { provide: { [apiKey]: { saveWorkspace } } } });
    await pointerEnter(wrapper);
    expect(recentIds(wrapper)).toEqual(["ws-a", "ws-b"]);

    // Unstar ws-a from its tree card while the pointer still rests on the list.
    const treeCard = wrapper.findAll('.workspace-card[data-workspace-id="ws-a"]')[0];
    await treeCard.get(".workspace-card__star").trigger("click");
    await nextTick();

    expect(saveWorkspace).toHaveBeenCalled();
    // Gone immediately — an explicit command is never deferred to the unlock.
    expect(recentIds(wrapper)).toEqual(["ws-b"]);
    expect(wrapper.findAll(".activity-row--missing")).toHaveLength(0);

    // …and the surface is re-frozen on the NEW list: a background arrival still
    // waits, so the row that is now under the pointer does not move again.
    store.payload = recentPayload({
      workspaces: [
        { ...ws("ws-a", "Alpha") },
        { ...ws("ws-b", "Beta"), starred: true, lastWorkedAt: new Date(now - 2 * MINUTE).toISOString() },
        { ...ws("ws-c", "Gamma"), starred: true, lastWorkedAt: new Date(now).toISOString() },
      ],
    });
    await nextTick();
    expect(recentIds(wrapper)).toEqual(["ws-b"]);
  });

  it("a failed star persist rolls the flip back and re-freezes the truthful list", async () => {
    const store = useAppStore();
    const now = Date.now();
    const saveWorkspace = vi.fn().mockRejectedValue(new Error("disk full"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    store.payload = recentPayload({
      workspaces: [
        { ...ws("ws-a", "Alpha"), starred: true, lastWorkedAt: new Date(now - MINUTE).toISOString() },
        { ...ws("ws-b", "Beta"), starred: true, lastWorkedAt: new Date(now - 2 * MINUTE).toISOString() },
      ],
    });
    store.starFilterActive = true;

    const wrapper = mount(SidebarPanel, { global: { provide: { [apiKey]: { saveWorkspace } } } });
    await pointerEnter(wrapper);

    const treeCard = wrapper.findAll('.workspace-card[data-workspace-id="ws-a"]')[0];
    await treeCard.get(".workspace-card__star").trigger("click");
    await flushPromises();
    await nextTick();

    // The optimistic unstar never reached disk, so the row comes back — and the
    // frozen snapshot says the same thing the store now does.
    expect(store.payload!.appState.workspaces.find((w: AnyApi) => w.id === "ws-a")!.starred).toBe(true);
    expect(recentIds(wrapper)).toEqual(["ws-a", "ws-b"]);
    consoleError.mockRestore();
  });

  it("a background recent arrival still waits for the unlock", async () => {
    vi.useFakeTimers();
    try {
      const store = useAppStore();
      const now = Date.now();
      store.payload = recentPayload({
        workspaces: [ws("ws-a", "Alpha", { lastWorkedAt: new Date(now - MINUTE).toISOString() })],
      });
      const wrapper = mount(SidebarPanel);
      await pointerEnter(wrapper);

      store.payload = recentPayload({
        workspaces: [
          ws("ws-a", "Alpha", { lastWorkedAt: new Date(now - MINUTE).toISOString() }),
          ws("ws-b", "Beta", { lastWorkedAt: new Date(now).toISOString() }),
        ],
      });
      await nextTick();
      expect(recentIds(wrapper)).toEqual(["ws-a"]);

      await pointerLeave(wrapper);
      await vi.advanceTimersByTimeAsync(GRACE_MS + 50);
      await nextTick();
      expect(recentIds(wrapper)).toEqual(["ws-b", "ws-a"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a hard delete during the lock keeps the WHOLE cluster, context row included", async () => {
    const store = useAppStore();
    const now = Date.now();
    const child = ws("ws-child", "Child", {
      quickfix: { parentWorkspaceId: "ws-root" },
      lastWorkedAt: new Date(now - MINUTE).toISOString(),
    });
    store.payload = recentPayload({
      workspaces: [
        ws("ws-root", "Root"),
        child,
        ws("ws-a", "Alpha", { lastWorkedAt: new Date(now - 2 * MINUTE).toISOString() }),
      ],
    });

    const wrapper = mount(SidebarPanel);
    expect(recentIds(wrapper)).toEqual(["ws-child", "ws-a"]);

    await pointerEnter(wrapper);
    store.payload = recentPayload({
      workspaces: [
        ws("ws-root", "Root"),
        ws("ws-a", "Alpha", { lastWorkedAt: new Date(now - 2 * MINUTE).toISOString() }),
      ],
    });
    await nextTick();

    // The cluster holds its full geometry: the context row above the deleted
    // workspace is still drawn, so nothing below it moves — and the row itself
    // is inert.
    expect(recentIds(wrapper)).toEqual(["ws-child", "ws-a"]);
    expect(wrapper.findAll('.recent-shortcuts [data-role="activity-cluster"]')).toHaveLength(2);
    expect(wrapper.get('.recent-shortcuts [data-role="activity-context-row"]').attributes("data-workspace-id")).toBe(
      "ws-root",
    );
    const gone = entries(wrapper)[0];
    expect(gone.classes()).toContain("activity-row--missing");
    expect(gone.attributes("disabled")).toBeDefined();
    expect(gone.get(".activity-row__trailing").text()).toBe("gone");

    const activate = vi.spyOn(store, "activateWorkspace").mockResolvedValue(undefined);
    await gone.trigger("click");
    expect(activate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// V5 review, §4 — RUNNING and the top RECENT are DISJOINT.
//
// RUNNING answers "what is working right now", RECENT answers "where did I
// work"; the canonical tree answers "where does this live" and always holds
// everything. A supervised task therefore occupies exactly one of the two top
// sections at a time, and the move between them happens as one atomic commit
// at the unlock — never under the pointer.
// ---------------------------------------------------------------------------

describe("SidebarPanel — RUNNING and RECENT are disjoint", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    (window as AnyApi).strideterm = { startupFlags: { windowId: "win-test" } };
  });

  const MINUTE = 60 * 1000;
  const GRACE_MS = 500;

  function recentPayload(overrides: AnyApi = {}): StatePayload {
    return makePayload({
      profiles: [{ id: "default", name: "Default", sidebarWorkspaceViewMode: "recent" }],
      ...overrides,
    });
  }

  function plain(id: string, name: string, extra: AnyApi = {}): AnyApi {
    return { id, name, cwd: `/${id}`, panels: [], icon: name[0], color: "#fff", profileId: "default", ...extra };
  }

  function taskWorkspace(id: string, name: string, extra: AnyApi = {}): AnyApi {
    return plain(id, name, {
      kind: "task",
      panels: [
        { id: "worker", title: "Worker Claude" },
        { id: "judge", title: "Judge Codex" },
      ],
      task: {
        taskId: `t-${id}`,
        state: "paused",
        workerPanelId: "worker",
        judgePanelId: "judge",
        startedAt: Date.now() - 5 * MINUTE,
        totalPausedMs: 0,
        pausedAt: null,
        finishedAt: null,
      },
      ...extra,
    });
  }

  function recentIds(wrapper: AnyApi): string[] {
    return wrapper
      .findAll('.recent-shortcuts [data-role="activity-node-row"]')
      .map((r: AnyApi) => r.attributes("data-workspace-id"));
  }

  function runningKeys(wrapper: AnyApi): string[] {
    return wrapper
      .findAll('.running-agents [data-role="activity-node-row"]')
      .map((r: AnyApi) => r.attributes("data-row-key"));
  }

  function treeIds(wrapper: AnyApi): string[] {
    return wrapper
      .findAll('[data-role="workspace-list"] > .workspace-card[data-workspace-id]')
      .map((c: AnyApi) => c.attributes("data-workspace-id"));
  }

  async function pointerEnter(wrapper: AnyApi): Promise<void> {
    await wrapper.get('[data-role="workspace-list"]').trigger("pointerenter");
  }

  async function pointerLeave(wrapper: AnyApi): Promise<void> {
    await wrapper.get('[data-role="workspace-list"]').trigger("pointerleave");
  }

  it("a running task is in RUNNING only; the canonical tree still holds it", () => {
    const store = useAppStore();
    const now = Date.now();
    store.payload = {
      ...recentPayload({
        workspaces: [
          plain("ws-a", "Alpha", { lastWorkedAt: new Date(now - 2 * MINUTE).toISOString() }),
          taskWorkspace("ws-task", "Task", { lastWorkedAt: new Date(now - MINUTE).toISOString() }),
        ],
      }),
      taskRunner: { "ws-task": { state: "running", startedAt: now - 5 * MINUTE } },
    } as AnyApi;

    const wrapper = mount(SidebarPanel);

    expect(runningKeys(wrapper)).toEqual(["ws-task:worker"]);
    expect(recentIds(wrapper)).toEqual(["ws-a"]);
    expect(treeIds(wrapper)).toEqual(["ws-a", "ws-task"]);
    expect(wrapper.get(".recent-shortcuts__title").text()).toContain("(1)");
  });

  it("the limit of seven is counted over the NON-running recent set", () => {
    const store = useAppStore();
    const now = Date.now();
    // Nine recent workspaces, the newest of which is a running task: the task
    // leaves the recent set, so the eighth plain workspace takes its slot
    // instead of being hidden behind a duplicate.
    const workspaces = [
      taskWorkspace("ws-task", "Task", { lastWorkedAt: new Date(now).toISOString() }),
      ...Array.from({ length: 8 }, (_, i) =>
        plain(`ws-${i}`, `Workspace ${i}`, { lastWorkedAt: new Date(now - (i + 1) * MINUTE).toISOString() }),
      ),
    ];
    store.payload = {
      ...recentPayload({ workspaces }),
      taskRunner: { "ws-task": { state: "running", startedAt: now - 5 * MINUTE } },
    } as AnyApi;

    const wrapper = mount(SidebarPanel);

    expect(recentIds(wrapper)).toEqual(["ws-0", "ws-1", "ws-2", "ws-3", "ws-4", "ws-5", "ws-6"]);
    expect(wrapper.get(".recent-shortcuts__title").text()).toContain("(8)");
    expect(wrapper.get('[data-role="recent-shortcuts-more"]').text()).toBe("Show 1 more");
  });

  it("when the task finishes it moves RUNNING → RECENT in ONE step at the unlock", async () => {
    vi.useFakeTimers();
    try {
      const store = useAppStore();
      const now = Date.now();
      const workspaces = (): AnyApi[] => [
        plain("ws-a", "Alpha", { lastWorkedAt: new Date(now - 2 * MINUTE).toISOString() }),
        taskWorkspace("ws-task", "Task", { lastWorkedAt: new Date(now - MINUTE).toISOString() }),
      ];
      store.payload = {
        ...recentPayload({ workspaces: workspaces() }),
        taskRunner: { "ws-task": { state: "running", startedAt: now - 5 * MINUTE } },
      } as AnyApi;

      const wrapper = mount(SidebarPanel);
      expect(runningKeys(wrapper)).toEqual(["ws-task:worker"]);
      expect(recentIds(wrapper)).toEqual(["ws-a"]);

      await pointerEnter(wrapper);
      store.payload = {
        ...recentPayload({ workspaces: workspaces() }),
        taskRunner: { "ws-task": { state: "completed", startedAt: now - 5 * MINUTE } },
      } as AnyApi;
      await nextTick();

      // Frozen: neither section moves while the pointer is on the list.
      expect(runningKeys(wrapper)).toEqual(["ws-task:worker"]);
      expect(recentIds(wrapper)).toEqual(["ws-a"]);

      await pointerLeave(wrapper);
      await vi.advanceTimersByTimeAsync(GRACE_MS + 50);
      await nextTick();

      // …and then both change together: gone from RUNNING, back in RECENT at
      // its own time position.
      expect(wrapper.find('[data-role="running-agents"]').exists()).toBe(false);
      expect(recentIds(wrapper)).toEqual(["ws-task", "ws-a"]);
      expect(treeIds(wrapper)).toEqual(["ws-a", "ws-task"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("when a task starts it moves RECENT → RUNNING in ONE step at the unlock", async () => {
    vi.useFakeTimers();
    try {
      const store = useAppStore();
      const now = Date.now();
      const workspaces = [
        plain("ws-a", "Alpha", { lastWorkedAt: new Date(now - 2 * MINUTE).toISOString() }),
        taskWorkspace("ws-task", "Task", { lastWorkedAt: new Date(now - MINUTE).toISOString() }),
      ];
      store.payload = {
        ...recentPayload({ workspaces }),
        taskRunner: { "ws-task": { state: "paused" } },
      } as AnyApi;

      const wrapper = mount(SidebarPanel);
      expect(wrapper.find('[data-role="running-agents"]').exists()).toBe(false);
      expect(recentIds(wrapper)).toEqual(["ws-task", "ws-a"]);

      await pointerEnter(wrapper);
      store.payload = {
        ...recentPayload({ workspaces }),
        taskRunner: { "ws-task": { state: "running", startedAt: now - 5 * MINUTE } },
      } as AnyApi;
      await nextTick();

      expect(wrapper.find('[data-role="running-agents"]').exists()).toBe(false);
      expect(recentIds(wrapper)).toEqual(["ws-task", "ws-a"]);

      await pointerLeave(wrapper);
      await vi.advanceTimersByTimeAsync(GRACE_MS + 50);
      await nextTick();

      expect(runningKeys(wrapper)).toEqual(["ws-task:worker"]);
      expect(recentIds(wrapper)).toEqual(["ws-a"]);
      // The canonical tree never lost it in either direction.
      expect(treeIds(wrapper)).toEqual(["ws-a", "ws-task"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a nested running task shares its provider context with the recent siblings it left behind", () => {
    const store = useAppStore();
    const now = Date.now();
    store.payload = {
      ...recentPayload({
        workspaces: [
          plain("ws-az", "Azure DevOps", { kind: "azure" }),
          plain("ws-pr", "mhub PR #30746", {
            review: { checkout: { mode: "managed-worktree" }, parentWorkspaceId: "ws-az" },
            lastWorkedAt: new Date(now - MINUTE).toISOString(),
          }),
          taskWorkspace("ws-task", "pr-30746", {
            task: {
              taskId: "t-1",
              state: "running",
              parentWorkspaceId: "ws-pr",
              workerPanelId: "worker",
              judgePanelId: "judge",
              startedAt: now - 5 * MINUTE,
              totalPausedMs: 0,
              pausedAt: null,
              finishedAt: null,
            },
            lastWorkedAt: new Date(now).toISOString(),
          }),
        ],
      }),
      taskRunner: { "ws-task": { state: "running", startedAt: now - 5 * MINUTE } },
    } as AnyApi;

    const wrapper = mount(SidebarPanel);

    // RUNNING draws the provider branch as a breadcrumb context row above the
    // task; RECENT shows the PR under the same provider context. Neither
    // section repeats the other's row.
    expect(runningKeys(wrapper)).toEqual(["ws-task:worker"]);
    expect(
      wrapper
        .findAll('.running-agents [data-role="activity-context-row"]')
        .map((c: AnyApi) => c.get(".activity-row__label").text()),
    ).toEqual(["Azure DevOps › mhub PR #30746"]);
    expect(recentIds(wrapper)).toEqual(["ws-pr"]);
    expect(
      wrapper
        .findAll('.recent-shortcuts [data-role="activity-context-row"]')
        .map((c: AnyApi) => c.attributes("data-workspace-id")),
    ).toEqual(["ws-az"]);
  });
});

// ---------------------------------------------------------------------------
// V5 review, §2 — every context row is a real navigation target, and using one
// is NAVIGATION, never work.
// ---------------------------------------------------------------------------

describe("SidebarPanel — clickable parent context", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    (window as AnyApi).strideterm = { startupFlags: { windowId: "win-test" } };
  });

  const MINUTE = 60 * 1000;

  function recentPayload(overrides: AnyApi = {}): StatePayload {
    return makePayload({
      profiles: [{ id: "default", name: "Default", sidebarWorkspaceViewMode: "recent" }],
      ...overrides,
    });
  }

  function nested(now: number): AnyApi[] {
    return [
      { id: "ws-root", name: "strideterm", cwd: "/r", panels: [], icon: "S", color: "#fff", profileId: "default" },
      {
        id: "ws-child",
        name: "mobile",
        cwd: "/r/m",
        panels: [],
        icon: "M",
        color: "#fff",
        profileId: "default",
        quickfix: { parentWorkspaceId: "ws-root" },
        lastWorkedAt: new Date(now - MINUTE).toISOString(),
      },
    ];
  }

  it("clicking the parent context activates the PARENT, not the child", async () => {
    const store = useAppStore();
    store.payload = recentPayload({ workspaces: nested(Date.now()) });
    const activate = vi.spyOn(store, "activateWorkspace").mockResolvedValue(undefined);

    const wrapper = mount(SidebarPanel);
    await wrapper.get('.recent-shortcuts [data-role="activity-context-row"]').trigger("click");
    await flushPromises();

    expect(activate).toHaveBeenCalledWith("ws-root");
    expect(wrapper.emitted("activate")?.[0]).toEqual(["ws-root"]);
  });

  it("activating a row is navigation, not work — nothing stamps lastWorkedAt", async () => {
    const store = useAppStore();
    const now = Date.now();
    store.payload = recentPayload({ workspaces: nested(now) });
    const activate = vi.spyOn(store, "activateWorkspace").mockResolvedValue(undefined);

    const wrapper = mount(SidebarPanel);
    await wrapper.get('.recent-shortcuts [data-role="activity-context-row"]').trigger("click");
    await wrapper.get('.recent-shortcuts [data-role="activity-node-row"]').trigger("click");
    await flushPromises();

    expect(activate.mock.calls).toEqual([["ws-root"], ["ws-child"]]);
    // The only recency mutation path is the backend work allowlist; the
    // sidebar never writes one of its own.
    const workspaces = store.payload!.appState.workspaces as AnyApi[];
    expect(workspaces.find((w) => w.id === "ws-root")!.lastWorkedAt).toBeUndefined();
    expect(workspaces.find((w) => w.id === "ws-child")!.lastWorkedAt).toBe(new Date(now - MINUTE).toISOString());
  });

  it("the star filter may select a child while its unstarred parent shows only as context", () => {
    const store = useAppStore();
    const now = Date.now();
    store.payload = recentPayload({
      workspaces: [
        { id: "ws-root", name: "strideterm", cwd: "/r", panels: [], icon: "S", color: "#fff", profileId: "default" },
        {
          id: "ws-child",
          name: "mobile",
          cwd: "/r/m",
          panels: [],
          icon: "M",
          color: "#fff",
          profileId: "default",
          starred: true,
          quickfix: { parentWorkspaceId: "ws-root" },
          lastWorkedAt: new Date(now - MINUTE).toISOString(),
        },
        {
          id: "ws-other",
          name: "Other",
          cwd: "/o",
          panels: [],
          icon: "O",
          color: "#fff",
          profileId: "default",
          lastWorkedAt: new Date(now - 2 * MINUTE).toISOString(),
        },
      ],
    });
    store.starFilterActive = true;

    const wrapper = mount(SidebarPanel);

    // Only the starred child is an ACTIVITY; its unstarred parent is still
    // drawn, as context, because ancestry resolves against the whole profile.
    expect(
      wrapper
        .findAll('.recent-shortcuts [data-role="activity-node-row"]')
        .map((r: AnyApi) => r.attributes("data-workspace-id")),
    ).toEqual(["ws-child"]);
    const context = wrapper.get('.recent-shortcuts [data-role="activity-context-row"]');
    expect(context.attributes("data-workspace-id")).toBe("ws-root");
    expect(wrapper.get(".recent-shortcuts__title").text()).toContain("(1)");
  });

  // V5 review, the Azure/GitHub matrix: "Background provider activity smí
  // změnit tento badge, ale nesmí vložit, odebrat ani přesunout entry."
  it("a background provider update may light the parent's attention badge and nothing else", async () => {
    const store = useAppStore();
    const now = Date.now();
    const workspaces = (): AnyApi[] => [
      { id: "ws-az", name: "Azure DevOps", cwd: "/az", panels: [], icon: "AZ", color: "#fff", profileId: "default" },
      {
        id: "ws-pr",
        name: "mhub PR #30746",
        cwd: "/pr",
        panels: [],
        icon: "AZ",
        color: "#fff",
        profileId: "default",
        review: { checkout: { mode: "managed-worktree" }, parentWorkspaceId: "ws-az" },
        lastWorkedAt: new Date(now - MINUTE).toISOString(),
      },
      {
        id: "ws-other",
        name: "Other",
        cwd: "/o",
        panels: [],
        icon: "O",
        color: "#fff",
        profileId: "default",
        lastWorkedAt: new Date(now - 2 * MINUTE).toISOString(),
      },
    ];
    const payloadWith = (alerts: number): AnyApi => ({
      ...recentPayload({ workspaces: workspaces() }),
      attention: {
        sessions: {},
        byWorkspace: alerts
          ? {
              "ws-az": {
                count: alerts,
                latestAt: new Date(now).toISOString(),
                alerts: Array.from({ length: alerts }, () => ({})),
              },
            }
          : {},
      },
    });

    store.payload = payloadWith(0);
    const wrapper = mount(SidebarPanel);
    const rowKeys = (): (string | undefined)[] =>
      wrapper
        .findAll(".recent-shortcuts button[data-role]")
        .map((r: AnyApi) => `${r.attributes("data-role")}:${r.attributes("data-workspace-id")}`);

    const before = rowKeys();
    expect(before).toEqual(["activity-context-row:ws-az", "activity-node-row:ws-pr", "activity-node-row:ws-other"]);
    expect(wrapper.find(".recent-shortcuts .activity-row__attention").exists()).toBe(false);

    await wrapper.get('[data-role="workspace-list"]').trigger("pointerenter");
    store.payload = payloadWith(2);
    await nextTick();

    // The badge lit up on the provider context row…
    const context = wrapper.get('.recent-shortcuts [data-role="activity-context-row"]');
    expect(context.classes()).toContain("activity-row--attention");
    expect(context.get(".activity-row__attention-count").text()).toBe("2");
    // …and nothing was inserted, removed or moved.
    expect(rowKeys()).toEqual(before);
  });
});

/**
 * V6 review, §"P2 UX — Recent zahazuje kanonický status dot na icon badge".
 *
 * The 15:19 screenshot: `mhub PR #30746` wears a coloured dot on its badge in
 * ALL WORKSPACES and none at all in Recent, so the fastest state signal in the
 * sidebar disappeared exactly where the user scans first. One shared resolver
 * now feeds the card AND both activity surfaces.
 */
describe("SidebarPanel — canonical status cue in the activity rows", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    (window as AnyApi).strideterm = { startupFlags: { windowId: "win-test" } };
  });

  const MINUTE = 60 * 1000;

  function recentPayload(overrides: AnyApi = {}): StatePayload {
    return makePayload({
      profiles: [{ id: "default", name: "Default", sidebarWorkspaceViewMode: "recent" }],
      ...overrides,
    });
  }

  /** A review workspace with an OPEN pull request, worked in a minute ago. */
  function reviewWorkspace(now: number, overrides: AnyApi = {}): AnyApi {
    return {
      id: "ws-pr",
      name: "mhub PR #30746",
      cwd: "/pr",
      panels: [],
      icon: "P",
      color: "#4a9eff",
      kind: "azure-review",
      profileId: "default",
      review: { provider: "azure-devops", prKey: "pr-1", checkout: { mode: "managed-worktree" } },
      lastWorkedAt: new Date(now - MINUTE).toISOString(),
      ...overrides,
    };
  }

  function azurePayload(now: number, extra: AnyApi[] = []): StatePayload {
    return {
      ...recentPayload({
        workspaces: [
          {
            id: "ws-az",
            name: "Azure DevOps",
            cwd: "/az",
            panels: [],
            icon: "AZ",
            color: "#0af",
            kind: "azure",
            profileId: "default",
          },
          { ...reviewWorkspace(now), azureParentId: "ws-az" },
          ...extra,
        ],
      }),
      azureDevops: {
        pullRequests: {
          "pr-1": { pullRequest: { pullRequestId: 30746, status: "active" }, profileId: "default" },
        },
      },
    } as AnyApi;
  }

  function dotOf(wrapper: AnyApi, selector: string): AnyApi | undefined {
    const row = wrapper.find(selector);
    if (!row.exists()) return undefined;
    const dot = row.find(".activity-row__status-dot");
    return dot.exists() ? dot : undefined;
  }

  it("shows the same state, colour class and tooltip in ALL WORKSPACES and in Recent", () => {
    const store = useAppStore();
    store.payload = azurePayload(Date.now());

    const wrapper = mount(SidebarPanel);

    const card = wrapper.get('.workspace-card[data-workspace-id="ws-pr"] .workspace-card__status-dot');
    const rowDot = dotOf(wrapper, '.recent-shortcuts [data-workspace-id="ws-pr"]');
    expect(rowDot).toBeDefined();
    // Same semantic state → same modifier suffix → same colour and glyph.
    expect(card.classes()).toContain("workspace-card__status-dot--pr-active");
    expect(rowDot!.classes()).toContain("activity-row__status-dot--pr-active");
    expect(card.attributes("title")).toBe("PR open");
    expect(rowDot!.attributes("title")).toBe("PR open");
  });

  it("names the state in the row's accessible name — the colour is never the only source", () => {
    const store = useAppStore();
    store.payload = azurePayload(Date.now());

    const wrapper = mount(SidebarPanel);

    const row = wrapper.get('.recent-shortcuts [data-workspace-id="ws-pr"]');
    expect(row.attributes("aria-label")).toContain("PR open");
    expect(row.attributes("title")).toContain("PR open");
  });

  /**
   * The case the shared resolver exists for: a hand-opened Claude Code panel
   * must NOT enter the task-only RUNNING section (its rows would appear and
   * vanish under the pointer), but its dot on the recent row stays.
   */
  it("an agent-like session lights the dot in Recent without entering RUNNING", () => {
    const store = useAppStore();
    const now = Date.now();
    store.payload = {
      ...recentPayload({
        workspaces: [
          {
            id: "ws-term",
            name: "playground",
            cwd: "/pg",
            icon: "T",
            color: "#fff",
            profileId: "default",
            panels: [{ id: "claude", title: "Claude Code" }],
            lastWorkedAt: new Date(now - MINUTE).toISOString(),
          },
        ],
      }),
      attention: {
        sessions: {
          "ws-term:claude": {
            workspaceId: "ws-term",
            panelId: "claude",
            activity: "running",
            agentLike: true,
            hasUserInput: true,
            activityStartedAt: now - MINUTE,
          },
        },
      },
    } as AnyApi;

    const wrapper = mount(SidebarPanel);

    expect(wrapper.find('[data-role="running-agents"]').exists()).toBe(false);
    const dot = dotOf(wrapper, '.recent-shortcuts [data-workspace-id="ws-term"]');
    expect(dot).toBeDefined();
    expect(dot!.classes()).toContain("activity-row__status-dot--running");
  });

  it("draws the cue on a CONTEXT row too, when that parent has a state of its own", () => {
    const store = useAppStore();
    const now = Date.now();
    // The PR parent is NOT recent; only its child is. The parent is therefore
    // a context row — and it still owns an open pull request.
    store.payload = {
      ...recentPayload({
        workspaces: [
          { ...reviewWorkspace(now), lastWorkedAt: undefined },
          {
            id: "ws-task",
            name: "pr-30746",
            cwd: "/pr/task",
            panels: [],
            icon: "B",
            color: "#fff",
            profileId: "default",
            quickfix: { parentWorkspaceId: "ws-pr" },
            lastWorkedAt: new Date(now - MINUTE).toISOString(),
          },
        ],
      }),
      azureDevops: {
        pullRequests: {
          "pr-1": { pullRequest: { pullRequestId: 30746, status: "active" }, profileId: "default" },
        },
      },
    } as AnyApi;

    const wrapper = mount(SidebarPanel);

    const context = wrapper.get('.recent-shortcuts [data-role="activity-context-row"]');
    expect(context.attributes("data-workspace-id")).toBe("ws-pr");
    expect(context.get(".activity-row__status-dot").classes()).toContain("activity-row__status-dot--pr-active");
    expect(context.attributes("aria-label")).toContain("PR open");
  });

  /**
   * The cue is a pixel-stable overlay, never a membership, ordering or
   * `lastWorkedAt` input — so it is one of the few things allowed to change
   * while the list is frozen.
   */
  it("a status change during the interaction lock moves no row and reorders nothing", async () => {
    const store = useAppStore();
    const now = Date.now();
    store.payload = azurePayload(now, [
      {
        id: "ws-other",
        name: "other",
        cwd: "/o",
        panels: [],
        icon: "O",
        color: "#fff",
        profileId: "default",
        lastWorkedAt: new Date(now - 2 * MINUTE).toISOString(),
      },
    ]);

    const wrapper = mount(SidebarPanel);
    const ids = () =>
      wrapper
        .findAll('.recent-shortcuts [data-role="activity-node-row"]')
        .map((r: AnyApi) => r.attributes("data-workspace-id"));
    const before = ids();

    await wrapper.get('[data-role="workspace-list"]').trigger("pointerenter");
    // The PR is abandoned in the background while the pointer rests on the list.
    store.payload = {
      ...(store.payload as AnyApi),
      azureDevops: {
        pullRequests: {
          "pr-1": {
            pullRequest: { pullRequestId: 30746, status: "abandoned", closedDate: new Date(now).toISOString() },
            profileId: "default",
          },
        },
      },
    } as AnyApi;
    await nextTick();

    expect(ids()).toEqual(before);
    const dot = dotOf(wrapper, '.recent-shortcuts [data-workspace-id="ws-pr"]');
    expect(dot).toBeDefined();
    // The dot itself is free to update — it cannot move a target.
    expect(dot!.classes()).toContain("activity-row__status-dot--abandoned");
  });

  it("a running supervised task wears the running cue in RUNNING as well", () => {
    const store = useAppStore();
    store.payload = {
      ...makePayload({
        workspaces: [
          {
            id: "ws-task",
            name: "Refactor",
            cwd: "/t",
            icon: "T",
            color: "#fff",
            profileId: "default",
            kind: "task",
            panels: [
              { id: "worker", title: "Worker Claude" },
              { id: "judge", title: "Judge Codex" },
            ],
            task: {
              taskId: "t-1",
              state: "judge-evaluating",
              workerPanelId: "worker",
              judgePanelId: "judge",
              startedAt: Date.now() - 60 * MINUTE,
              totalPausedMs: 0,
              pausedAt: null,
              finishedAt: null,
            },
          },
        ],
      }),
      taskRunner: { "ws-task": { state: "judge-evaluating" } },
    } as AnyApi;

    const wrapper = mount(SidebarPanel);

    const row = wrapper.get('.running-agents [data-role="activity-node-row"]');
    expect(row.get(".activity-row__status-dot").classes()).toContain("activity-row__status-dot--running");
    // …and the reserved state slot shows the SHORT label, not the raw state.
    expect(row.get(".activity-row__state").text()).toBe("judging");
  });
});

/**
 * V6 review, §"P2 UX — search má být jeden explicitní režim, ne Recent plus
 * další seznam" and §"P2 — star filter směšuje activity scope a context
 * ancestry".
 */
describe("SidebarPanel — search is one explicit mode", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    (window as AnyApi).strideterm = { startupFlags: { windowId: "win-test" } };
  });

  const MINUTE = 60 * 1000;

  /** A recent-mode profile with a running task and two recent workspaces. */
  function searchPayload(now: number): StatePayload {
    return {
      ...makePayload({
        profiles: [{ id: "default", name: "Default", sidebarWorkspaceViewMode: "recent" }],
        workspaces: [
          {
            id: "ws-root",
            name: "strideterm",
            cwd: "/root",
            panels: [],
            icon: "S",
            color: "#fff",
            profileId: "default",
            lastWorkedAt: new Date(now - 5 * MINUTE).toISOString(),
          },
          {
            id: "ws-alpha",
            name: "alpha service",
            cwd: "/root/alpha",
            panels: [],
            icon: "A",
            color: "#fff",
            profileId: "default",
            quickfix: { parentWorkspaceId: "ws-root" },
            lastWorkedAt: new Date(now - 2 * MINUTE).toISOString(),
          },
          {
            id: "ws-task",
            name: "alpha refactor",
            cwd: "/root/task",
            icon: "T",
            color: "#fff",
            profileId: "default",
            kind: "task",
            quickfix: { parentWorkspaceId: "ws-root" },
            panels: [
              { id: "worker", title: "Worker Claude" },
              { id: "judge", title: "Judge Codex" },
            ],
            task: {
              taskId: "t-1",
              state: "running",
              workerPanelId: "worker",
              judgePanelId: "judge",
              startedAt: now - 60 * MINUTE,
              totalPausedMs: 0,
              pausedAt: null,
              finishedAt: null,
            },
          },
        ],
      }),
      taskRunner: { "ws-task": { state: "running" } },
    } as AnyApi;
  }

  function treeIds(wrapper: AnyApi): string[] {
    return wrapper.findAll(".workspace-card[data-workspace-id]").map((c: AnyApi) => c.attributes("data-workspace-id"));
  }

  it("a query hides both dynamic surfaces and heads the tree with one SEARCH RESULTS label", async () => {
    const store = useAppStore();
    store.payload = searchPayload(Date.now());
    const wrapper = mount(SidebarPanel);

    // Before: both surfaces up, the canonical tree labelled as itself.
    expect(wrapper.find('[data-role="running-agents"]').exists()).toBe(true);
    expect(wrapper.find('[data-role="recent-shortcuts"]').exists()).toBe(true);
    expect(wrapper.find('[data-role="all-workspaces-title"]').exists()).toBe(true);
    expect(wrapper.find('[data-role="search-results-title"]').exists()).toBe(false);

    store.workspaceSearchQuery = "alpha";
    await nextTick();

    expect(wrapper.find('[data-role="running-agents"]').exists()).toBe(false);
    expect(wrapper.find('[data-role="recent-shortcuts"]').exists()).toBe(false);
    expect(wrapper.find('[data-role="all-workspaces-title"]').exists()).toBe(false);
    // Exactly one heading, and it says what it is counting.
    expect(wrapper.findAll(".recent-shortcuts__all-title")).toHaveLength(1);
    expect(wrapper.get('[data-role="search-results-title"]').text()).toBe("Search results (2)");
  });

  it("the count is MATCHES — a parent kept only for orientation is not one of them", async () => {
    const store = useAppStore();
    store.payload = searchPayload(Date.now());
    const wrapper = mount(SidebarPanel);

    store.workspaceSearchQuery = "alpha";
    await nextTick();

    // `strideterm` matched nothing; it is on screen only so the two matches
    // keep their place in the tree.
    expect(treeIds(wrapper)).toEqual(["ws-root", "ws-alpha", "ws-task"]);
    expect(wrapper.get('[data-role="search-results-title"]').text()).toBe("Search results (2)");
  });

  it("a running workspace that matches appears exactly once", async () => {
    const store = useAppStore();
    store.payload = searchPayload(Date.now());
    const wrapper = mount(SidebarPanel);

    store.workspaceSearchQuery = "refactor";
    await nextTick();

    expect(treeIds(wrapper).filter((id: string) => id === "ws-task")).toHaveLength(1);
    expect(wrapper.findAll('[data-role="activity-node-row"]')).toHaveLength(0);
  });

  it("a query with no results shows the empty state alone — no heading over nothing", async () => {
    const store = useAppStore();
    store.payload = searchPayload(Date.now());
    const wrapper = mount(SidebarPanel);

    store.workspaceSearchQuery = "nothing-matches-this";
    await nextTick();

    expect(treeIds(wrapper)).toEqual([]);
    expect(wrapper.find('[data-role="search-results-title"]').exists()).toBe(false);
    expect(wrapper.findAll(".workspace-list__no-match")).toHaveLength(1);
    expect(wrapper.get(".workspace-list__no-match").text()).toContain("nothing-matches-this");
  });

  it("clearing the query restores the recent mode with its collapse and Show-more state", async () => {
    const store = useAppStore();
    const now = Date.now();
    // Enough recent workspaces that `Show more` has something to reveal.
    const extras = Array.from({ length: 8 }, (_, index) => ({
      id: `ws-extra-${index}`,
      name: `extra ${index}`,
      cwd: `/extra/${index}`,
      panels: [],
      icon: "E",
      color: "#fff",
      profileId: "default",
      lastWorkedAt: new Date(now - (10 + index) * MINUTE).toISOString(),
    }));
    const base = searchPayload(now) as AnyApi;
    store.payload = {
      ...base,
      appState: { ...base.appState, workspaces: [...base.appState.workspaces, ...extras] },
    } as AnyApi;
    const wrapper = mount(SidebarPanel);

    const recentRows = () => wrapper.findAll('.recent-shortcuts [data-role="activity-node-row"]').length;
    const beforeCollapsed = recentRows();
    await wrapper.get('[data-role="recent-shortcuts-more"]').trigger("click");
    const expanded = recentRows();
    expect(expanded).toBeGreaterThan(beforeCollapsed);

    store.workspaceSearchQuery = "alpha";
    await nextTick();
    expect(wrapper.find('[data-role="recent-shortcuts"]').exists()).toBe(false);
    // The view MODE itself was never touched — only suspended.
    expect(
      (store.activeProfile as AnyApi)?.sidebarWorkspaceViewMode ??
        (store.payload as AnyApi).appState.profiles[0].sidebarWorkspaceViewMode,
    ).toBe("recent");

    store.workspaceSearchQuery = "";
    await nextTick();
    expect(wrapper.find('[data-role="recent-shortcuts"]').exists()).toBe(true);
    // Back with the Show-more expansion the user had left it in.
    expect(recentRows()).toBe(expanded);

    // Same for the section's collapsed state: a search must not silently
    // re-open a section the user had folded away.
    await wrapper.get(".recent-shortcuts__toggle").trigger("click");
    expect(recentRows()).toBe(0);
    store.workspaceSearchQuery = "alpha";
    await nextTick();
    store.workspaceSearchQuery = "";
    await nextTick();
    expect(wrapper.get(".recent-shortcuts__toggle").attributes("aria-expanded")).toBe("false");
    expect(recentRows()).toBe(0);
  });

  it("typing and clearing land immediately, even while the interaction lock is held", async () => {
    const store = useAppStore();
    store.payload = searchPayload(Date.now());
    const wrapper = mount(SidebarPanel);

    await wrapper.get('[data-role="workspace-list"]').trigger("pointerenter");
    store.workspaceSearchQuery = "alpha";
    await nextTick();

    // An explicit command is never deferred by the lock.
    expect(wrapper.find('[data-role="running-agents"]').exists()).toBe(false);
    expect(wrapper.find('[data-role="recent-shortcuts"]').exists()).toBe(false);

    store.workspaceSearchQuery = "";
    await nextTick();
    expect(wrapper.find('[data-role="running-agents"]').exists()).toBe(true);
    expect(wrapper.find('[data-role="recent-shortcuts"]').exists()).toBe(true);
  });

  it("an active star filter narrows the search scope, and the count follows it", async () => {
    const store = useAppStore();
    const base = searchPayload(Date.now()) as AnyApi;
    store.payload = {
      ...base,
      appState: {
        ...base.appState,
        workspaces: base.appState.workspaces.map((ws: AnyApi) =>
          ws.id === "ws-alpha" ? { ...ws, starred: true } : ws,
        ),
      },
    } as AnyApi;
    const wrapper = mount(SidebarPanel);

    store.starFilterActive = true;
    store.workspaceSearchQuery = "alpha";
    await nextTick();

    // `alpha refactor` matches the query but is outside the starred scope.
    expect(treeIds(wrapper)).toEqual(["ws-root", "ws-alpha"]);
    expect(wrapper.get('[data-role="search-results-title"]').text()).toBe("Search results (1)");
  });
});

describe("SidebarPanel — star roles: activity scope versus context ancestry", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    (window as AnyApi).strideterm = { startupFlags: { windowId: "win-test" } };
  });

  const MINUTE = 60 * 1000;

  /**
   * An unstarred parent that HAS its own `lastWorkedAt`, and a starred child.
   * The old projection handed the recent surface the whole starred union —
   * matches plus ancestry — so this parent became a full activity row.
   */
  function starPayload(now: number, extra: AnyApi[] = []): StatePayload {
    return makePayload({
      profiles: [{ id: "default", name: "Default", sidebarWorkspaceViewMode: "recent" }],
      workspaces: [
        {
          id: "ws-parent",
          name: "parent",
          cwd: "/p",
          panels: [],
          icon: "P",
          color: "#fff",
          profileId: "default",
          lastWorkedAt: new Date(now - 3 * MINUTE).toISOString(),
        },
        {
          id: "ws-child",
          name: "child",
          cwd: "/p/c",
          panels: [],
          icon: "C",
          color: "#fff",
          profileId: "default",
          starred: true,
          quickfix: { parentWorkspaceId: "ws-parent" },
          lastWorkedAt: new Date(now - MINUTE).toISOString(),
        },
        ...extra,
      ],
    });
  }

  function roleOf(wrapper: AnyApi, workspaceId: string): string | undefined {
    const row = wrapper.find(`.recent-shortcuts [data-workspace-id="${workspaceId}"]`);
    return row.exists() ? row.attributes("data-role") : undefined;
  }

  it("a starred child makes its unstarred, recently-worked parent a CONTEXT row", async () => {
    const store = useAppStore();
    store.payload = starPayload(Date.now());
    const wrapper = mount(SidebarPanel);

    // Without the filter the parent is a genuine activity — it was worked in.
    expect(roleOf(wrapper, "ws-parent")).toBe("activity-node-row");

    store.starFilterActive = true;
    await nextTick();

    // With it, the parent is on screen only so the starred child keeps its
    // place, and a context row wears no time.
    expect(roleOf(wrapper, "ws-child")).toBe("activity-node-row");
    expect(roleOf(wrapper, "ws-parent")).toBe("activity-context-row");
    expect(
      wrapper.find('.recent-shortcuts [data-workspace-id="ws-parent"]').find(".activity-row__trailing").exists(),
    ).toBe(false);
    // The heading counts real activities only.
    expect(wrapper.get(".recent-shortcuts__title").text()).toContain("(1)");
  });

  it("a descendant of a starred root is still an activity in its own right", async () => {
    const store = useAppStore();
    const now = Date.now();
    store.payload = makePayload({
      profiles: [{ id: "default", name: "Default", sidebarWorkspaceViewMode: "recent" }],
      workspaces: [
        {
          id: "ws-parent",
          name: "parent",
          cwd: "/p",
          panels: [],
          icon: "P",
          color: "#fff",
          profileId: "default",
          starred: true,
          lastWorkedAt: new Date(now - 3 * MINUTE).toISOString(),
        },
        {
          id: "ws-child",
          name: "child",
          cwd: "/p/c",
          panels: [],
          icon: "C",
          color: "#fff",
          profileId: "default",
          quickfix: { parentWorkspaceId: "ws-parent" },
          lastWorkedAt: new Date(now - MINUTE).toISOString(),
        },
      ],
    });
    const wrapper = mount(SidebarPanel);

    store.starFilterActive = true;
    await nextTick();

    expect(roleOf(wrapper, "ws-parent")).toBe("activity-node-row");
    expect(roleOf(wrapper, "ws-child")).toBe("activity-node-row");
    expect(wrapper.get(".recent-shortcuts__title").text()).toContain("(2)");
  });

  it("the canonical tree still keeps the ancestor, so the filtered branch is not a fragment", async () => {
    const store = useAppStore();
    store.payload = starPayload(Date.now());
    const wrapper = mount(SidebarPanel);

    store.starFilterActive = true;
    await nextTick();

    expect(
      wrapper.findAll(".workspace-card[data-workspace-id]").map((c: AnyApi) => c.attributes("data-workspace-id")),
    ).toEqual(["ws-parent", "ws-child"]);
  });
});

describe("SidebarPanel — V7: one search projection, scoped before it matches", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    (window as AnyApi).strideterm = { startupFlags: { windowId: "win-test" } };
  });

  const MINUTE = 60 * 1000;

  /**
   * One root with two branches, so a star scope on one branch and a query on
   * the other can be composed in the wrong order — which is exactly what V6
   * did (V7 review, §"P1 UX correctness — star scope a search ancestry se
   * skládají v nesprávném pořadí"). `rootName` is a parameter because the
   * difference between "an ancestor kept for orientation" and "an ancestor
   * that matches the query itself" is the whole point of two of these rows.
   */
  function branchPayload(now: number, rootName = "workspace hub", extra: AnyApi = {}): StatePayload {
    return makePayload({
      profiles: [{ id: "default", name: "Default", sidebarWorkspaceViewMode: "recent" }],
      workspaces: [
        {
          id: "ws-root",
          name: rootName,
          cwd: "/root",
          panels: [],
          icon: "R",
          color: "#fff",
          profileId: "default",
          lastWorkedAt: new Date(now - 9 * MINUTE).toISOString(),
        },
        {
          id: "ws-alpha",
          name: "alpha service",
          cwd: "/root/alpha",
          panels: [],
          icon: "A",
          color: "#fff",
          profileId: "default",
          starred: true,
          quickfix: { parentWorkspaceId: "ws-root" },
          lastWorkedAt: new Date(now - 3 * MINUTE).toISOString(),
        },
        {
          id: "ws-beta",
          name: "beta service",
          cwd: "/root/beta",
          panels: [],
          icon: "B",
          color: "#fff",
          profileId: "default",
          quickfix: { parentWorkspaceId: "ws-root" },
          lastWorkedAt: new Date(now - 2 * MINUTE).toISOString(),
        },
      ],
      ...extra,
    });
  }

  function treeIds(wrapper: AnyApi): string[] {
    return wrapper
      .findAll('[data-role="workspace-list"] > .workspace-card[data-workspace-id]')
      .map((c: AnyApi) => c.attributes("data-workspace-id"));
  }

  // --- IN SPLIT is the third shortcut surface, and search suspends it too ---

  it("a query suspends IN SPLIT alongside RUNNING and RECENT, leaving one result projection", async () => {
    const store = useAppStore();
    const now = Date.now();
    store.payload = {
      ...(branchPayload(now, "workspace hub", {
        workspaceGrid: { layout: "cols", cellWorkspaceIds: ["ws-root", "ws-beta"] },
      }) as AnyApi),
      taskRunner: {},
    } as AnyApi;
    const wrapper = mount(SidebarPanel);

    // Before: the grid group and the recent surface are both up.
    expect(wrapper.find('[data-role="split-group"]').exists()).toBe(true);
    expect(wrapper.find('[data-role="recent-shortcuts"]').exists()).toBe(true);

    store.workspaceSearchQuery = "service";
    await nextTick();

    expect(wrapper.find('[data-role="split-group"]').exists()).toBe(false);
    expect(wrapper.find('[data-role="running-agents"]').exists()).toBe(false);
    expect(wrapper.find('[data-role="recent-shortcuts"]').exists()).toBe(false);
    // Exactly one heading, and exactly one projection of workspace cards.
    expect(wrapper.findAll(".recent-shortcuts__all-title")).toHaveLength(1);
    expect(wrapper.get('[data-role="search-results-title"]').text()).toBe("Search results (2)");
    expect(treeIds(wrapper)).toEqual(["ws-root", "ws-alpha", "ws-beta"]);
  });

  it("a grid workspace that matches renders exactly once, still carrying its slot cue", async () => {
    const store = useAppStore();
    const now = Date.now();
    store.payload = branchPayload(now, "workspace hub", {
      workspaceGrid: { layout: "cols", cellWorkspaceIds: ["ws-beta", "ws-alpha"] },
    }) as AnyApi;
    const wrapper = mount(SidebarPanel);

    // Un-searched, a grid workspace is drawn twice on purpose: once in the
    // group, once as its tree ghost.
    expect(wrapper.findAll('.workspace-card[data-workspace-id="ws-beta"]')).toHaveLength(2);

    store.workspaceSearchQuery = "beta";
    await nextTick();

    const betaCards = wrapper.findAll('.workspace-card[data-workspace-id="ws-beta"]');
    expect(betaCards).toHaveLength(1);
    // The grid state is still readable from the surviving card.
    expect(betaCards[0].classes()).toContain("workspace-card--in-grid");
    expect(betaCards[0].get(".workspace-card__slot").text()).toBe("1");
  });

  it("clearing the query brings IN SPLIT back in the same slot order, grid untouched", async () => {
    const store = useAppStore();
    const now = Date.now();
    store.payload = branchPayload(now, "workspace hub", {
      workspaceGrid: { layout: "cols", cellWorkspaceIds: ["ws-beta", "ws-alpha"] },
    }) as AnyApi;
    const wrapper = mount(SidebarPanel);

    const splitOrder = () =>
      wrapper
        .findAll('[data-role="split-group"] [data-workspace-id]')
        .map((c: AnyApi) => c.attributes("data-workspace-id"));
    const before = splitOrder();
    expect(before).toEqual(["ws-beta", "ws-alpha"]);

    store.workspaceSearchQuery = "alpha";
    await nextTick();
    expect(wrapper.find('[data-role="split-group"]').exists()).toBe(false);
    // Suspended, never rewritten.
    expect((store.workspaceGrid as AnyApi).cellWorkspaceIds).toEqual(["ws-beta", "ws-alpha"]);

    store.workspaceSearchQuery = "";
    await nextTick();
    expect(splitOrder()).toEqual(before);
    expect((store.workspaceGrid as AnyApi).cellWorkspaceIds).toEqual(["ws-beta", "ws-alpha"]);
  });

  it("typing and clearing move IN SPLIT immediately, even while the interaction lock is held", async () => {
    const store = useAppStore();
    store.payload = branchPayload(Date.now(), "workspace hub", {
      workspaceGrid: { layout: "cols", cellWorkspaceIds: ["ws-beta", "ws-alpha"] },
    }) as AnyApi;
    const wrapper = mount(SidebarPanel);

    await wrapper.get('[data-role="workspace-list"]').trigger("pointerenter");

    // An explicit command is never deferred by the lock — in either direction.
    store.workspaceSearchQuery = "alpha";
    await nextTick();
    expect(wrapper.find('[data-role="split-group"]').exists()).toBe(false);

    store.workspaceSearchQuery = "";
    await nextTick();
    expect(wrapper.find('[data-role="split-group"]').exists()).toBe(true);
  });

  // --- scope, then match, then close the ancestry ---

  it("a star scope on one branch and a query on the other leaves no context ghost", async () => {
    const store = useAppStore();
    store.payload = branchPayload(Date.now());
    const wrapper = mount(SidebarPanel);

    store.starFilterActive = true;
    store.workspaceSearchQuery = "beta";
    await nextTick();

    // `ws-beta` is outside the starred scope, so there is no match — and with
    // no match there is no ancestor to keep either. The shared root used to
    // survive the intersection of the two closures and sit there alone, with
    // neither a heading (count 0) nor an empty state (tree non-empty).
    expect(treeIds(wrapper)).toEqual([]);
    expect(wrapper.find('[data-role="search-results-title"]').exists()).toBe(false);
    expect(wrapper.findAll(".recent-shortcuts__all-title")).toHaveLength(0);
    expect(wrapper.findAll(".workspace-list__no-match")).toHaveLength(1);
  });

  it("an ancestor kept only as star CONTEXT is not searchable and does not raise N", async () => {
    const store = useAppStore();
    // The root's own name matches the query — but it is in the star projection
    // as context only, so it is orientation, never a result.
    store.payload = branchPayload(Date.now(), "alpha hub");
    const wrapper = mount(SidebarPanel);

    store.starFilterActive = true;
    store.workspaceSearchQuery = "alpha";
    await nextTick();

    expect(wrapper.get('[data-role="search-results-title"]').text()).toBe("Search results (1)");
    // Present for orientation, and only because a real match hangs off it.
    expect(treeIds(wrapper)).toEqual(["ws-root", "ws-alpha"]);
  });

  it("a query on a starred child: the child is the match, its parent is context, N is 1", async () => {
    const store = useAppStore();
    store.payload = branchPayload(Date.now());
    const wrapper = mount(SidebarPanel);

    store.starFilterActive = true;
    store.workspaceSearchQuery = "alpha";
    await nextTick();

    expect(wrapper.get('[data-role="search-results-title"]').text()).toBe("Search results (1)");
    expect(treeIds(wrapper)).toEqual(["ws-root", "ws-alpha"]);
  });

  it("with no star filter the query still runs over the whole active profile", async () => {
    const store = useAppStore();
    store.payload = branchPayload(Date.now());
    const wrapper = mount(SidebarPanel);

    store.workspaceSearchQuery = "service";
    await nextTick();

    expect(wrapper.get('[data-role="search-results-title"]').text()).toBe("Search results (2)");
    expect(treeIds(wrapper)).toEqual(["ws-root", "ws-alpha", "ws-beta"]);
  });
});
