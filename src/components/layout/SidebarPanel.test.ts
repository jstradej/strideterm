import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { nextTick } from "vue";
import { createPinia, setActivePinia } from "pinia";
import SidebarPanel from "./SidebarPanel.vue";
import { useAppStore } from "../../stores/app.js";
import { useNotificationStore } from "../../stores/notifications.js";
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
