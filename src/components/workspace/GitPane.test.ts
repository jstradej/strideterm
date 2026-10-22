import { describe, expect, test, beforeEach, vi } from "vitest";
import { shallowMount, mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { reactive } from "vue";
import GitPane from "./GitPane.vue";
import { useAppStore } from "../../stores/app.js";
import { useGitUiStore } from "../../stores/git-ui.js";
import { useRemoteDetailsStore } from "../../stores/remote-details.js";
import DialogOverlay from "../dialogs/DialogOverlay.vue";
import SettingsGitTab from "../dialogs/settings/SettingsGitTab.vue";
import type { StatePayload, GitSnapshot } from "../../../electron/shared/types/state.js";

declare const setMatchMediaResult: (query: string, matches: boolean) => void;

function buildWorkspace(overrides: Record<string, unknown> = {}) {
  return {
    id: "ws-test",
    name: "Test WS",
    icon: "\u{1F4BB}",
    color: "#4CAF50",
    kind: "terminal",
    profileId: "default",
    cwd: "/ms",
    gitRoots: [],
    notes: "",
    activePanelId: "panel-1",
    panels: [{ id: "panel-1", title: "Terminal", command: "", shell: true, startup: "default" }],
    activeViewId: "ws-test:panel-1",
    splitLayout: null,
    splitViewIds: [],
    activeRootPath: "",
    review: null,
    ...overrides,
  };
}

function makeSnapshot(rootPath: string = "/ms/api"): GitSnapshot {
  return {
    available: true,
    branch: "main",
    isMainWorktree: true,
    isWorktree: false,
    dirty: false,
    dirtyCount: 0,
    aheadCount: 0,
    behindCount: 0,
    staged: [],
    unstaged: [],
    untracked: [],
    remotes: {},
    operationState: {
      kind: "idle",
      inProgress: false,
      conflicts: [],
      label: "",
      details: "",
      canContinue: false,
      canAbort: false,
    },
    compareWithBase: null as unknown as GitSnapshot["compareWithBase"],
    upstream: "",
    commitCount: 1,
    stashCount: 0,
    lazygit: { available: false, backend: null, error: "" },
    rootPath,
    workspaceId: "ws-test",
    // required GitSnapshot fields
    cwd: rootPath,
    root: rootPath,
    repository: "repo",
    status: [],
    changes: {
      staged: {
        name: "staged",
        files: [],
        diffStat: { files: 0, insertions: 0, deletions: 0, renames: 0, deletes: 0 },
      },
      unstaged: {
        name: "unstaged",
        files: [],
        diffStat: { files: 0, insertions: 0, deletions: 0, renames: 0, deletes: 0 },
      },
      untracked: {
        name: "untracked",
        files: [],
        diffStat: { files: 0, insertions: 0, deletions: 0, renames: 0, deletes: 0 },
      },
    },
    diffStat: { files: 0, insertions: 0, deletions: 0, renames: 0, deletes: 0 },
    log: [],
    gitDir: "",
    gitCommonDir: "",
    worktreePath: rootPath,
    mainWorktreePath: rootPath,
    siblingWorktrees: [],
    baseBranch: "",
    branchNames: [],
    lastFetchAt: null,
    error: "",
    lastUpdatedAt: new Date().toISOString(),
  } as unknown as GitSnapshot;
}

function mountPane(
  workspaceId: string,
  workspaces: any[] = [], // eslint-disable-line @typescript-eslint/no-explicit-any
  options: { connections?: any[]; activeProfileId?: string; deep?: boolean; newView?: boolean } = {}, // eslint-disable-line @typescript-eslint/no-explicit-any
) {
  const appStore = useAppStore();
  const activeProfileId = options.activeProfileId ?? "default";
  const profiles = [
    { id: "default", name: "Default", color: "#ffa424", workspaceIds: [] },
    { id: "profile-b", name: "Profile B", color: "#ffa424", workspaceIds: [] },
    { id: "profile-c", name: "Profile C", color: "#ffa424", workspaceIds: [] },
  ];
  appStore.payload = {
    appState: {
      workspaces,
      activeProfileId,
      profiles,
      windowSlots: [{ id: "win-test", profileId: activeProfileId, activeWorkspaceId: workspaceId }],
      ...(options.newView ? { settings: { git: { ui: { newView: true } } } } : {}),
    },
    git: {
      workspaces: {
        [workspaceId]: makeSnapshot(),
      },
      connections: options.connections || [],
    },
  } as unknown as StatePayload;
  const mountOptions = { props: { workspaceId }, global: { stubs: { teleport: false } } };
  return options.deep ? mount(GitPane, mountOptions) : shallowMount(GitPane, mountOptions);
}

type PaneWrapper = ReturnType<typeof mountPane>;

function menuItemLabel(item: HTMLElement) {
  return item.firstChild?.textContent?.trim();
}

function menuItems() {
  return Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'));
}

async function pickMoreTool(wrapper: PaneWrapper, label: string) {
  if (menuItems().length === 0) await wrapper.get('[aria-label="More Git tools"]').trigger("click");
  const item = menuItems().find((el) => menuItemLabel(el) === label);
  expect(item, `menu item ${label}`).toBeTruthy();
  item!.click();
  await flushPromises();
}

beforeEach(() => {
  setActivePinia(createPinia());
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).strideterm = { startupFlags: { windowId: "win-test" } };
});

describe("GitPane repo picker", () => {
  test("exposes the full active repository path and working branch in a focusable details control", async () => {
    const workspaceId = "ws-long-repository-details";
    const wrapper = mountPane(workspaceId, [buildWorkspace({ id: workspaceId })]);
    const appStore = useAppStore();
    appStore.payload = {
      ...appStore.payload!,
      appState: { ...appStore.payload!.appState!, settings: { git: { ui: { newView: true } } } },
    } as StatePayload;
    const longRoot = "C:/work/customer-projects/very-long/repository/path/services/catalog-api";
    useGitUiStore().setActiveRoot(workspaceId, longRoot);
    await flushPromises();

    const details = wrapper.get(".git-view__repo-details");
    expect(details.get("summary").attributes("aria-label")).toBe("Show full repository path and working branch");
    await details.get("summary").trigger("click");
    expect(details.text()).toContain(longRoot);
    expect(details.text()).toContain("main");
  });

  test("keeps the classic tabs by default and renders three opt-in views with legacy tools", async () => {
    const ws = buildWorkspace({ id: "ws-new-git-view" });
    const wrapper = mountPane("ws-new-git-view", [ws]);
    expect(wrapper.find('[aria-label="Git sections"]').exists()).toBe(true);
    const appStore = useAppStore();
    appStore.payload = {
      ...appStore.payload!,
      appState: { ...appStore.payload!.appState!, settings: { git: { ui: { newView: true } } } },
    } as StatePayload;
    await flushPromises();
    expect(wrapper.find('[aria-label="Git sections"]').exists()).toBe(false);
    expect(wrapper.findAll('[role="tab"]').map((tab) => tab.text())).toEqual([
      "History",
      "Changes",
      "Review",
      "More ▾",
    ]);
    expect(wrapper.find('[aria-label="More Git tools"]').exists()).toBe(true);
    await pickMoreTool(wrapper, "Stashes");
    expect(wrapper.findComponent({ name: "GitStashesTab" }).exists()).toBe(true);
    await pickMoreTool(wrapper, "Branches");
    expect(wrapper.findComponent({ name: "GitBranchesTab" }).exists()).toBe(true);
    wrapper.unmount();
  });

  test("a picked More tool is the only active tab until a main view is chosen again", async () => {
    const ws = buildWorkspace({ id: "ws-more-active" });
    const wrapper = mountPane("ws-more-active", [ws], { newView: true });
    await flushPromises();
    const more = () => wrapper.get('[aria-label="More Git tools"]');
    expect(more().text()).toBe("More ▾");
    expect(wrapper.findAll(".git-tabs__item--active")).toHaveLength(1);

    await pickMoreTool(wrapper, "Stashes");
    expect(more().text()).toBe("Stashes ▾");
    expect(more().attributes("aria-selected")).toBe("true");
    expect(more().classes()).toContain("git-tabs__item--active");
    const active = wrapper.findAll(".git-tabs__item--active");
    expect(active).toHaveLength(1);
    expect(wrapper.findAll('[role="tab"][aria-selected="true"]')).toHaveLength(1);

    const history = wrapper.findAll('[role="tab"]').find((tab) => tab.text() === "History")!;
    await history.trigger("click");
    await flushPromises();
    expect(history.attributes("aria-selected")).toBe("true");
    expect(history.classes()).toContain("git-tabs__item--active");
    expect(more().text()).toBe("More ▾");
    expect(more().attributes("aria-selected")).toBe("false");
    wrapper.unmount();
  });

  test.each([
    ["branch", "GitBranchTab"],
    ["branches", "GitBranchesTab"],
    ["stashes", "GitStashesTab"],
    ["pr", "GitPullRequestTab"],
    ["worktrees", "GitWorktreeList"],
    ["bulk", "BulkRepoTable"],
    ["conflicts", "GitConflictsTab"],
  ])("More routes %s to its existing tool", async (destination, componentName) => {
    const workspaceId = `ws-more-${destination}`;
    const ws = buildWorkspace({
      id: workspaceId,
      ...(destination === "bulk" ? { gitRoots: ["/ms/api", "/ms/web"] } : {}),
    });
    const wrapper = mountPane(workspaceId, [ws]);
    const appStore = useAppStore();
    appStore.payload = {
      ...appStore.payload!,
      appState: { ...appStore.payload!.appState!, settings: { git: { ui: { newView: true } } } },
    } as StatePayload;
    if (destination === "conflicts") {
      const payload = appStore.payload!;
      const snapshot = payload.git!.workspaces[workspaceId];
      appStore.payload = {
        ...payload,
        git: {
          ...payload.git!,
          workspaces: {
            ...payload.git!.workspaces,
            [workspaceId]: {
              ...snapshot,
              operationState: { ...snapshot.operationState, conflicts: [{ path: "src/conflict.ts" }] },
            },
          },
        },
      } as StatePayload;
    }
    await flushPromises();

    const label = {
      branch: "Overview",
      branches: "Branches",
      stashes: "Stashes",
      pr: "Pull Request",
      worktrees: "Worktrees",
      bulk: "Bulk",
      conflicts: "Conflicts",
    }[destination]!;
    await wrapper.get('[aria-label="More Git tools"]').trigger("click");
    expect(menuItems().map(menuItemLabel)).toContain(label);
    await pickMoreTool(wrapper, label);
    expect(wrapper.findComponent({ name: componentName }).exists()).toBe(true);
    wrapper.unmount();
  });

  test("falls back with an explanation when a saved More tool is unavailable", async () => {
    const ws = buildWorkspace({ id: "ws-unavailable-more-tool" });
    const wrapper = mountPane("ws-unavailable-more-tool", [ws]);
    const appStore = useAppStore();
    appStore.payload = {
      ...appStore.payload!,
      appState: { ...appStore.payload!.appState!, settings: { git: { ui: { newView: true } } } },
    } as StatePayload;
    const gitUiStore = useGitUiStore();
    gitUiStore.setNewViewLegacyDestination("ws-unavailable-more-tool", "conflicts");
    await flushPromises();

    expect(wrapper.find(".git-view__fallback").text()).toContain("Conflicts is unavailable right now");
    expect(wrapper.find(".git-view__fallback").text()).toContain("Showing History");
    expect(wrapper.get('[aria-label="More Git tools"]').text()).toBe("More ▾");
    expect(wrapper.get('[aria-label="More Git tools"]').attributes("aria-selected")).toBe("false");
    expect(gitUiStore.getNewViewLegacyDestination("ws-unavailable-more-tool")).toBe("conflicts");
    expect(wrapper.findComponent({ name: "GitBranchesTab" }).exists()).toBe(true);
  });

  test("Review renders the linked provider review workspace using its PR data and drafts", async () => {
    const linked = buildWorkspace({
      id: "ws-linked",
      review: { prKey: "azure:repo:42", provider: "azure-devops", role: "reviewer" },
    });
    const providerReview = buildWorkspace({
      id: "ws-provider-review",
      kind: "review",
      review: { prKey: "azure:repo:42", provider: "azure-devops", role: "reviewer" },
    });
    const wrapper = mountPane("ws-linked", [linked, providerReview]);
    const appStore = useAppStore();
    appStore.payload = {
      ...appStore.payload!,
      appState: { ...appStore.payload!.appState!, settings: { git: { ui: { newView: true } } } },
    } as StatePayload;
    await flushPromises();
    const reviewPane = wrapper.findComponent({ name: "AzureReviewPane" });
    expect(reviewPane.exists()).toBe(true);
    expect(reviewPane.props("workspaceId")).toBe("ws-provider-review");
  });

  test("Review keeps the shared Git operation status visible", async () => {
    const ws = buildWorkspace({ id: "ws-review-operation" });
    const wrapper = mountPane("ws-review-operation", [ws]);
    const appStore = useAppStore();
    appStore.payload = {
      ...appStore.payload!,
      appState: { ...appStore.payload!.appState!, settings: { git: { ui: { newView: true } } } },
    } as StatePayload;
    const gitUiStore = useGitUiStore();
    gitUiStore.get("ws-review-operation").busyAction = "fetch";
    await flushPromises();
    await wrapper
      .findAll('[role="tab"]')
      .find((tab) => tab.text() === "Review")!
      .trigger("click");
    await flushPromises();

    expect(wrapper.findComponent({ name: "GitOperationCard" }).exists()).toBe(true);
  });

  test.each(["History", "Changes", "Review"] as const)("keeps conflict resolution visible in %s", async (view) => {
    const workspaceId = `ws-conflicts-${view.toLowerCase()}`;
    const ws = buildWorkspace({ id: workspaceId });
    const wrapper = mountPane(workspaceId, [ws]);
    const appStore = useAppStore();
    const base = appStore.payload!;
    const snapshot = base.git!.workspaces[workspaceId];
    appStore.payload = {
      ...base,
      appState: { ...base.appState!, settings: { git: { ui: { newView: true } } } },
      git: {
        ...base.git!,
        workspaces: {
          ...base.git!.workspaces,
          [workspaceId]: {
            ...snapshot,
            operationState: { ...snapshot.operationState, conflicts: [{ path: "src/conflict.ts" }] },
          },
        },
      },
    } as StatePayload;
    await flushPromises();
    if (view !== "History") {
      await wrapper
        .findAll('[role="tab"]')
        .find((tab) => tab.text() === view)!
        .trigger("click");
      await flushPromises();
    }

    expect(wrapper.get('[aria-label="Open conflict resolution"]').text()).toContain("Resolve conflicts");
  });

  test("keeps exactly one remote Git detail interest across view-setting toggles", async () => {
    const workspaceId = "ws-remote-view-interest";
    const subscriptions: string[][] = [];
    const appStore = useAppStore();
    appStore.init({
      isRemote: true,
      getState: () => new Promise(() => {}),
      onStateUpdated: vi.fn(),
      subscribeResources: (resources: string[]) => subscriptions.push([...resources]),
      fetchResourceDetail: vi.fn().mockResolvedValue(null),
    } as unknown as import("../../transport.js").Transport);
    const wrapper = mountPane(workspaceId, [buildWorkspace({ id: workspaceId })]);
    await flushPromises();
    const expected = [`git:${workspaceId}`];
    expect(subscriptions.at(-1)).toEqual(expected);

    for (const newView of [true, false, true]) {
      appStore.payload = {
        ...appStore.payload!,
        appState: { ...appStore.payload!.appState!, settings: { git: { ui: { newView } } } },
      } as StatePayload;
      await flushPromises();
      expect(useRemoteDetailsStore().isInterested(`git:${workspaceId}`)).toBe(true);
      expect(subscriptions.at(-1)).toEqual(expected);
    }

    wrapper.unmount();
    await flushPromises();
    expect(useRemoteDetailsStore().isInterested(`git:${workspaceId}`)).toBe(false);
    expect(subscriptions.at(-1)).toEqual([]);
    expect(subscriptions).toHaveLength(2);
  });
  test("a running Git operation survives turning the opt-in view off and back on", async () => {
    const ws = buildWorkspace({ id: "ws-toggle-operation" });
    const wrapper = mountPane("ws-toggle-operation", [ws]);
    const appStore = useAppStore();
    const gitUiStore = useGitUiStore();
    gitUiStore.setActiveRoot("ws-toggle-operation", "/ms/api");
    gitUiStore.get("ws-toggle-operation").busyAction = "fetch";
    gitUiStore.get("ws-toggle-operation").busyPhase = "Fetching…";

    appStore.payload = {
      ...appStore.payload!,
      appState: { ...appStore.payload!.appState!, settings: { git: { ui: { newView: true } } } },
    } as StatePayload;
    await flushPromises();
    await wrapper
      .findAll('[role="tab"]')
      .find((tab) => tab.text() === "Review")!
      .trigger("click");
    await flushPromises();
    expect(wrapper.findComponent({ name: "GitOperationCard" }).exists()).toBe(true);

    appStore.payload = {
      ...appStore.payload!,
      appState: { ...appStore.payload!.appState!, settings: { git: { ui: { newView: false } } } },
    } as StatePayload;
    await flushPromises();
    expect(wrapper.find('[aria-label="Git sections"]').exists()).toBe(true);
    expect(gitUiStore.get("ws-toggle-operation").busyAction).toBe("fetch");

    appStore.payload = {
      ...appStore.payload!,
      appState: { ...appStore.payload!.appState!, settings: { git: { ui: { newView: true } } } },
    } as StatePayload;
    await flushPromises();
    expect(gitUiStore.get("ws-toggle-operation").busyAction).toBe("fetch");
    expect(wrapper.findComponent({ name: "GitOperationCard" }).exists()).toBe(true);
  });

  test("the selected History reference survives the actual view-setting toggle", async () => {
    const workspaceId = "ws-toggle-history-reference";
    const workspace = buildWorkspace({ id: workspaceId, activeRootPath: "/ms/api", gitRoots: ["/ms/api"] });
    const wrapper = mountPane(workspaceId, [workspace], { deep: true, newView: true });
    const appStore = useAppStore();
    const gitUiStore = useGitUiStore();
    gitUiStore.setActiveRoot(workspaceId, "/ms/api");
    Object.assign(gitUiStore.get(workspaceId), {
      branchList: {
        current: "main",
        upstream: "origin/main",
        local: [{ name: "main", isCurrent: true }],
        remotes: [{ name: "origin/release", shortName: "release", remote: "origin" }],
        defaultBranch: "main",
        defaultRemote: "origin",
      },
      tags: [],
    });
    gitUiStore.setGitHistorySelection(workspaceId, "/ms/api", "default", { ref: "origin/release" });
    await flushPromises();
    expect(wrapper.get('[aria-label="History reference"]').attributes("data-value")).toBe("origin/release");

    appStore.payload = {
      ...appStore.payload!,
      appState: { ...appStore.payload!.appState!, settings: { git: { ui: { newView: false } } } },
    } as StatePayload;
    await flushPromises();
    expect(wrapper.find('[aria-label="Git sections"]').exists()).toBe(true);

    appStore.payload = {
      ...appStore.payload!,
      appState: { ...appStore.payload!.appState!, settings: { git: { ui: { newView: true } } } },
    } as StatePayload;
    await flushPromises();
    expect(wrapper.get('[aria-label="History reference"]').attributes("data-value")).toBe("origin/release");
    wrapper.unmount();
  });

  test("an unsaved Review editor survives toggling the view through the Settings control", async () => {
    const ws = buildWorkspace({ id: "ws-toggle-review-draft" });
    const wrapper = mountPane("ws-toggle-review-draft", [ws]);
    const appStore = useAppStore();
    appStore.payload = {
      ...appStore.payload!,
      appState: { ...appStore.payload!.appState!, settings: { git: { ui: { newView: true } } } },
    } as StatePayload;

    const dialogOverlay = mount(DialogOverlay, { attachTo: document.body });
    appStore.openDialog("TextAreaDialog", {
      title: "Edit review draft",
      label: "Comment",
      value: "Saved value",
      onSubmit: () => undefined,
      onCancel: () => undefined,
    });
    await vi.waitFor(() => expect(document.body.querySelector(".dialog--textarea textarea")).not.toBeNull());
    const textarea = document.body.querySelector(".dialog--textarea textarea") as HTMLTextAreaElement;
    textarea.value = "Unsaved editor contents survive the Settings toggle.";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await flushPromises();

    const form = reactive({ git: { ui: { newView: true, showAllActions: false } } });
    const settings = mount(SettingsGitTab, { global: { provide: { settingsForm: form } } });
    const newViewCheckbox = settings.get('input[type="checkbox"]');
    await newViewCheckbox.setValue(false);
    appStore.payload = {
      ...appStore.payload!,
      appState: { ...appStore.payload!.appState!, settings: form },
    } as StatePayload;
    await flushPromises();
    expect(wrapper.find('[aria-label="Git sections"]').exists()).toBe(true);

    await newViewCheckbox.setValue(true);
    appStore.payload = {
      ...appStore.payload!,
      appState: { ...appStore.payload!.appState!, settings: form },
    } as StatePayload;
    await flushPromises();

    expect(wrapper.findAll('[role="tab"]').map((tab) => tab.text())).toEqual([
      "History",
      "Changes",
      "Review",
      "More ▾",
    ]);
    expect(document.body.querySelector(".dialog--textarea textarea")).toHaveProperty(
      "value",
      "Unsaved editor contents survive the Settings toggle.",
    );

    settings.unmount();
    dialogOverlay.unmount();
    wrapper.unmount();
  });

  test("repo picker is shown when workspace has 2+ gitRoots", () => {
    const ws = buildWorkspace({ id: "ws-multi", gitRoots: ["/ms/api", "/ms/web"] });
    const wrapper = mountPane("ws-multi", [ws]);
    expect(wrapper.find(".git-repo-picker").exists()).toBe(true);
  });

  test("repo picker is hidden when workspace has < 2 gitRoots", () => {
    const ws = buildWorkspace({ id: "ws-single", gitRoots: ["/ms/api"] });
    const wrapper = mountPane("ws-single", [ws]);
    expect(wrapper.find(".git-repo-picker").exists()).toBe(false);
  });

  test("repo picker is hidden when gitRoots is empty", () => {
    const ws = buildWorkspace({ id: "ws-empty", gitRoots: [] });
    const wrapper = mountPane("ws-empty", [ws]);
    expect(wrapper.find(".git-repo-picker").exists()).toBe(false);
  });

  test.each([
    ["reviewer", "no opt-in exists any more"],
    ["author", "the author keeps full Git"],
    ["observer", "role never changes what is available"],
  ])("a PR-linked workspace (%s) is never locked: the repo picker stays — %s", (role) => {
    const ws = buildWorkspace({
      id: `ws-${role}`,
      gitRoots: ["/ms/api", "/ms/web"],
      review: { prKey: "pr-123", provider: "azure-devops", role },
    });
    const wrapper = mountPane(`ws-${role}`, [ws]);
    expect(wrapper.find(".git-repo-picker").exists()).toBe(true);
  });

  test("connection picker hides connections from other profiles", () => {
    // payload.git.connections now contains connections from every open
    // profile. The GitPane in a workspace belonging to profile-b must
    // surface only profile-b's connections in the picker — otherwise the
    // user could pick a profile-default connection that resolveGitConnection
    // would then refuse to honour at op time (workspace.profileId mismatch).
    const ws = buildWorkspace({ id: "ws-b", profileId: "profile-b" });
    const wrapper = mountPane("ws-b", [ws], {
      activeProfileId: "profile-b",
      connections: [
        { id: "conn-default", label: "Default Conn", profileId: "default", enabled: true, provider: "azure-devops" },
        { id: "conn-b", label: "B Conn", profileId: "profile-b", enabled: true, provider: "azure-devops" },
        { id: "conn-other", label: "Other Profile Conn", profileId: "profile-c", enabled: true, provider: "github" },
      ],
    });

    const select = wrapper.findComponent({ name: "CustomSelect" });
    expect(select.exists()).toBe(true);
    const options = select.props("options") as Array<{ value: string; label: string }>;
    const optionValues = options.map((o) => o.value).sort();
    // Only profile-b connection plus the "" (system credentials) sentinel.
    expect(optionValues).toEqual(["", "conn-b"]);
  });

  test("switching sub-tabs does not change activeRootPath", () => {
    const ws = buildWorkspace({ id: "ws-tabs", gitRoots: ["/ms/api", "/ms/web"] });
    mountPane("ws-tabs", [ws]);
    const gitUiStore = useGitUiStore();

    // Set initial root
    gitUiStore.setActiveRoot("ws-tabs", "/ms/api");
    expect(gitUiStore.getActiveRoot("ws-tabs")).toBe("/ms/api");

    // Switch sub-tab
    if (gitUiStore.gitSwitchTab) {
      gitUiStore.gitSwitchTab("ws-tabs", "changes");
    } else {
      gitUiStore.get("ws-tabs").activeTab = "changes";
    }

    // Root should be unchanged
    expect(gitUiStore.getActiveRoot("ws-tabs")).toBe("/ms/api");
  });
});

// §3.5 useMobileShellMenus wiring — GitPane is one of 3 consumers (with
// InboxPane and AzureReviewPane) of the shared composable, but unlike them
// wires onSelectTab straight to gitSwitchTab and reuses the same tab-nav
// buttons for both desktop and the mobile popover (no separate tab list).
describe("GitPane mobile shell menus (useMobileShellMenus wiring)", () => {
  beforeEach(() => {
    setMatchMediaResult("(max-width: 768px), (max-height: 500px)", false);
  });

  test("on desktop viewport the popover triggers do not render", async () => {
    const ws = buildWorkspace({ id: "ws-desktop" });
    const wrapper = mountPane("ws-desktop", [ws]);
    await flushPromises();

    expect(wrapper.find(".git-view__tabs-trigger").exists()).toBe(false);
    expect(wrapper.find(".git-view__menu-trigger").exists()).toBe(false);
    expect(wrapper.find(".git-view__menu-backdrop").exists()).toBe(false);
  });

  test("on mobile viewport the popover triggers render, showing the active tab's label", async () => {
    setMatchMediaResult("(max-width: 768px), (max-height: 500px)", true);
    const ws = buildWorkspace({ id: "ws-mobile" });
    const wrapper = mountPane("ws-mobile", [ws]);
    await flushPromises();

    expect(wrapper.find(".git-view__tabs-trigger").exists()).toBe(true);
    expect(wrapper.find(".git-view__menu-trigger").exists()).toBe(true);
    // Default activeTab is "branch" -> Overview (see GitPane.vue's `tabs` computed).
    expect(wrapper.find(".git-view__tabs-trigger__label").text()).toBe("Overview");
  });

  test("toggling the tabs trigger flips the git-view--tabs-menu-open class", async () => {
    setMatchMediaResult("(max-width: 768px), (max-height: 500px)", true);
    const ws = buildWorkspace({ id: "ws-mobile-tabs" });
    const wrapper = mountPane("ws-mobile-tabs", [ws]);
    await flushPromises();

    await wrapper.find(".git-view__tabs-trigger").trigger("click");
    expect(wrapper.find(".git-view").classes()).toContain("git-view--tabs-menu-open");
    expect(wrapper.find(".git-view__tabs-trigger").attributes("aria-expanded")).toBe("true");

    await wrapper.find(".git-view__tabs-trigger").trigger("click");
    expect(wrapper.find(".git-view").classes()).not.toContain("git-view--tabs-menu-open");
  });

  test("toggling the actions trigger flips the git-view--menu-open class, mutually exclusive with the tabs menu", async () => {
    setMatchMediaResult("(max-width: 768px), (max-height: 500px)", true);
    const ws = buildWorkspace({ id: "ws-mobile-actions" });
    const wrapper = mountPane("ws-mobile-actions", [ws]);
    await flushPromises();

    await wrapper.find(".git-view__tabs-trigger").trigger("click");
    expect(wrapper.find(".git-view").classes()).toContain("git-view--tabs-menu-open");

    await wrapper.find(".git-view__menu-trigger").trigger("click");
    expect(wrapper.find(".git-view").classes()).toContain("git-view--menu-open");
    expect(wrapper.find(".git-view").classes()).not.toContain("git-view--tabs-menu-open");
  });

  test("clicking a tab item switches gitUiStore's active tab AND closes the tabs popover (onSelectTab wiring)", async () => {
    setMatchMediaResult("(max-width: 768px), (max-height: 500px)", true);
    const ws = buildWorkspace({ id: "ws-mobile-switch", gitRoots: ["/ms/api", "/ms/web"] });
    const wrapper = mountPane("ws-mobile-switch", [ws]);
    await flushPromises();
    const gitUiStore = useGitUiStore();

    await wrapper.find(".git-view__tabs-trigger").trigger("click");
    expect(wrapper.find(".git-view").classes()).toContain("git-view--tabs-menu-open");

    const branchesTab = wrapper.findAll(".git-tabs__item").find((btn) => btn.text() === "Branches");
    expect(branchesTab).toBeTruthy();
    await branchesTab!.trigger("click");

    expect(gitUiStore.get("ws-mobile-switch").activeTab).toBe("branches");
    // useMobileShellMenus.onTabClick closes the tabs popover after selecting.
    expect(wrapper.find(".git-view").classes()).not.toContain("git-view--tabs-menu-open");
    expect(wrapper.find(".git-view__tabs-trigger__label").text()).toBe("Branches");
  });

  test("the backdrop closes both popovers", async () => {
    setMatchMediaResult("(max-width: 768px), (max-height: 500px)", true);
    const ws = buildWorkspace({ id: "ws-mobile-backdrop" });
    const wrapper = mountPane("ws-mobile-backdrop", [ws]);
    await flushPromises();

    await wrapper.find(".git-view__menu-trigger").trigger("click");
    expect(wrapper.find(".git-view__menu-backdrop").exists()).toBe(true);

    await wrapper.find(".git-view__menu-backdrop").trigger("click");
    expect(wrapper.find(".git-view").classes()).not.toContain("git-view--menu-open");
    expect(wrapper.find(".git-view__menu-backdrop").exists()).toBe(false);
  });
});

describe("GitPane push target", () => {
  function pushButtonFor(branch: string) {
    const ws = buildWorkspace({
      id: "ws-pr",
      review: {
        prKey: "gh:7",
        provider: "github",
        role: "author",
        pullRequest: { id: 7, sourceRefName: "refs/heads/feature/login", targetRefName: "refs/heads/main" },
      },
    });
    const wrapper = mountPane("ws-pr", [ws]);
    const appStore = useAppStore();
    const payload = appStore.payload as unknown as { git: { workspaces: Record<string, GitSnapshot> } };
    payload.git.workspaces["ws-pr"] = {
      ...makeSnapshot(),
      branch,
      aheadCount: 1,
      upstream: "origin/feature/login",
      remotes: { origin: "https://example.com/repo.git" },
    } as unknown as GitSnapshot;
    appStore.payload = { ...appStore.payload } as unknown as StatePayload;
    return { wrapper, appStore };
  }

  test("on the managed PR alias Push says it goes to the PR branch and names it", async () => {
    const { wrapper } = pushButtonFor("pr-7-feature-login");
    await flushPromises();
    const button = wrapper.get("[data-testid='push-button']");
    expect(button.text()).toBe("Push to PR branch");
    expect(button.attributes("title")).toContain("origin/feature/login");
    expect(button.attributes("title")).toContain("source branch");
  });

  test("on any other branch of the same workspace Push is the ordinary push of that branch", async () => {
    const { wrapper } = pushButtonFor("develop");
    await flushPromises();
    const button = wrapper.get("[data-testid='push-button']");
    expect(button.text()).not.toContain("PR branch");
    expect(button.attributes("title")).not.toContain("source branch");
  });
});
