import { describe, expect, test, beforeEach, vi } from "vitest";
import { shallowMount, mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import GitPane from "./GitPane.vue";
import { useAppStore } from "../../stores/app.js";
import { useGitUiStore } from "../../stores/git-ui.js";
import { useRemoteDetailsStore } from "../../stores/remote-details.js";
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
  options: { connections?: any[]; activeProfileId?: string; deep?: boolean } = {}, // eslint-disable-line @typescript-eslint/no-explicit-any
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

function patchGitSnapshot(workspaceId: string, patch: Record<string, unknown>): void {
  const appStore = useAppStore();
  const payload = appStore.payload as unknown as {
    [key: string]: unknown;
    git: { [key: string]: unknown; workspaces: Record<string, Record<string, unknown>> };
  };
  const snapshot = payload.git.workspaces[workspaceId];
  appStore.payload = {
    ...payload,
    git: { ...payload.git, workspaces: { ...payload.git.workspaces, [workspaceId]: { ...snapshot, ...patch } } },
  } as unknown as StatePayload;
}

type PaneWrapper = ReturnType<typeof mountPane>;

async function pickTab(wrapper: PaneWrapper, label: string) {
  const tab = wrapper.findAll('[role="tab"]').find((el) => el.text().replace(/\d+$/, "").trim() === label);
  expect(tab, `tab ${label}`).toBeTruthy();
  await tab!.trigger("click");
  await flushPromises();
}

beforeEach(() => {
  setActivePinia(createPinia());
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).strideterm = { startupFlags: { windowId: "win-test" } };
});

describe("GitPane repo picker", () => {
  test("uses a fresh UUID for each mounted Git pane owner", async () => {
    const appStore = useAppStore();
    const api = { gitInterest: vi.fn().mockResolvedValue({ ok: true }) };
    vi.spyOn(appStore, "getApi").mockReturnValue(api as never);
    const first = mountPane("ws-uuid", [buildWorkspace({ id: "ws-uuid" })]);
    const second = mountPane("ws-uuid", [buildWorkspace({ id: "ws-uuid" })]);
    await flushPromises();
    const ownerIds = api.gitInterest.mock.calls
      .filter(([interest]) => interest.active)
      .map(([interest]) => interest.viewId);
    expect(ownerIds).toHaveLength(2);
    expect(ownerIds[0]).toMatch(/^git-pane-[0-9a-f-]{36}$/i);
    expect(ownerIds[1]).not.toBe(ownerIds[0]);
    first.unmount();
    second.unmount();
  });

  test.each([
    { activeRootPath: "/repo/secondary", expectedRoot: "/repo/secondary" },
    { activeRootPath: "", expectedRoot: "/repo/primary" },
  ])(
    "sends the selected root before a cold multi-root detail is available ($expectedRoot)",
    async ({ activeRootPath, expectedRoot }) => {
      const workspaceId = `ws-cold-${expectedRoot.split("/").at(-1)}`;
      const appStore = useAppStore();
      const api = { gitInterest: vi.fn().mockResolvedValue({ ok: true }) };
      vi.spyOn(appStore, "getApi").mockReturnValue(api as never);
      const workspace = buildWorkspace({
        id: workspaceId,
        cwd: "/repo",
        activeRootPath,
        gitRoots: ["/repo/primary", "/repo/secondary"],
      });
      const wrapper = mountPane(workspaceId, [workspace]);
      appStore.isRemoteTransport = true;
      await flushPromises();

      expect(api.gitInterest.mock.calls.filter(([interest]) => interest.active).at(-1)?.[0]).toMatchObject({
        workspaceId,
        rootPath: expectedRoot,
      });
      wrapper.unmount();
    },
  );

  test("shows desktop summary-only Git state as details loading", async () => {
    const workspaceId = "ws-summary-only";
    const wrapper = mountPane(workspaceId, [buildWorkspace({ id: workspaceId })]);
    patchGitSnapshot(workspaceId, { summaryOnly: true, stale: true });
    await flushPromises();
    expect(wrapper.find(".git-view--loading").exists()).toBe(true);
    expect(wrapper.find(".git-view__loading-caption").text()).toBe("Loading Git details…");
  });

  test("renders a restored snapshot with detail without the loading skeleton or a notice", async () => {
    const workspaceId = "ws-restored-detail";
    const wrapper = mountPane(workspaceId, [buildWorkspace({ id: workspaceId })]);
    patchGitSnapshot(workspaceId, { stale: true, verified: false, cached: true, summaryOnly: false });
    await flushPromises();
    expect(wrapper.find(".git-view--loading").exists()).toBe(false);
    expect(wrapper.find(".git-view").classes()).not.toContain("git-view--notice");
    expect(wrapper.find(".git-view__toolbar").exists()).toBe(true);
    expect(wrapper.find(".git-view__refresh-error").exists()).toBe(false);
  });

  test("keeps a cached full detail visible when the remote core reports summary-only", async () => {
    const workspaceId = "ws-cached-full-detail";
    const wrapper = mountPane(workspaceId, [buildWorkspace({ id: workspaceId })]);
    const appStore = useAppStore();
    appStore.isRemoteTransport = true;
    const detailStore = useRemoteDetailsStore();
    detailStore._cache = new Map([
      [
        `git:${workspaceId}`,
        {
          revision: "summary-revision",
          fetchedAt: Date.now(),
          data: { ...makeSnapshot(), stale: true, verified: false, summaryOnly: false },
        },
      ],
    ]) as never;
    appStore.payload = {
      ...(appStore.payload as unknown as StatePayload),
      gitSummaries: {
        [workspaceId]: {
          available: true,
          branch: "main",
          dirty: false,
          dirtyCount: 0,
          lastChangeAt: null,
          summaryOnly: true,
          refreshing: true,
        },
      },
    } as unknown as StatePayload;
    await flushPromises();

    expect(wrapper.find(".git-view--loading").exists()).toBe(false);
    expect(wrapper.find(".git-view__toolbar").exists()).toBe(true);
  });

  test("shows a cold unavailable snapshot error and retry action", async () => {
    const workspaceId = "ws-cold-error";
    const wrapper = mountPane(workspaceId, [buildWorkspace({ id: workspaceId })]);
    patchGitSnapshot(workspaceId, { available: false, error: "repository path is missing" });
    await flushPromises();
    expect(wrapper.text()).toContain("repository path is missing");
    expect(wrapper.findAll("button").some((button) => button.text().includes("Retry Git refresh"))).toBe(true);
  });

  test("shows loading for a cold refresh and ends loading when it fails", async () => {
    const workspaceId = "ws-cold-refresh";
    const wrapper = mountPane(workspaceId, [buildWorkspace({ id: workspaceId })]);
    patchGitSnapshot(workspaceId, { available: false, refreshing: true, stale: true, error: "" });
    await flushPromises();
    expect(wrapper.find(".git-view--loading").exists()).toBe(true);

    patchGitSnapshot(workspaceId, { available: false, refreshing: false, refreshError: "repository path is missing" });
    await flushPromises();
    expect(wrapper.find(".git-view--loading").exists()).toBe(false);
    expect(wrapper.text()).toContain("repository path is missing");
    expect(wrapper.findAll("button").some((button) => button.text().includes("Retry Git refresh"))).toBe(true);
  });

  test("keeps the last snapshot visible and explains a failed refresh", async () => {
    const workspaceId = "ws-refresh-error";
    const wrapper = mountPane(workspaceId, [buildWorkspace({ id: workspaceId })]);
    patchGitSnapshot(workspaceId, {
      stale: true,
      refreshError: "Git refresh timed out. The repository may be unavailable.",
    });
    await flushPromises();
    expect(wrapper.find(".git-view").classes()).toContain("git-view--notice");
    expect(wrapper.find(".git-view__refresh-error").text()).not.toContain("..");
    patchGitSnapshot(workspaceId, { stale: true, refreshError: "disk unavailable" });
    await flushPromises();
    expect(wrapper.find(".git-view__refresh-error").text()).toContain("disk unavailable");
    expect(wrapper.find(".git-view__refresh-error").text()).toContain("last available Git data");
    expect(wrapper.find(".git-view--loading").exists()).toBe(false);
  });

  test("exposes the full active repository path and working branch in a focusable details control", async () => {
    const workspaceId = "ws-long-repository-details";
    const wrapper = mountPane(workspaceId, [buildWorkspace({ id: workspaceId })]);
    const longRoot = "C:/work/customer-projects/very-long/repository/path/services/catalog-api";
    useGitUiStore().setActiveRoot(workspaceId, longRoot);
    await flushPromises();

    const details = wrapper.get(".git-view__repo-details");
    expect(details.get("summary").attributes("aria-label")).toBe("Show full repository path and working branch");
    await details.get("summary").trigger("click");
    expect(details.text()).toContain(longRoot);
    expect(details.text()).toContain("main");
  });

  test("always renders integrated views and legacy tools, ignoring an old false setting", async () => {
    const ws = buildWorkspace({ id: "ws-new-git-view" });
    const wrapper = mountPane("ws-new-git-view", [ws]);
    expect(wrapper.find('[aria-label="Git sections"]').exists()).toBe(true);
    expect(wrapper.find('[role="tab"][aria-selected="true"]').text()).toBe("History");
    const appStore = useAppStore();
    appStore.payload = {
      ...appStore.payload!,
      appState: { ...appStore.payload!.appState!, settings: { git: { ui: { newView: false } } } },
    } as unknown as StatePayload;
    await flushPromises();
    expect(wrapper.find('[aria-label="Git sections"]').exists()).toBe(true);
    expect(wrapper.findAll('[role="tab"]').map((tab) => tab.text())).toEqual([
      "History",
      "Changes",
      "Overview",
      "Branches",
      "Stashes",
      "Pull Request",
      "Worktrees",
    ]);
    expect(wrapper.find('[aria-label="More Git tools"]').exists()).toBe(false);
    await pickTab(wrapper, "Stashes");
    expect(wrapper.findComponent({ name: "GitStashesTab" }).exists()).toBe(true);
    await pickTab(wrapper, "Branches");
    expect(wrapper.findComponent({ name: "GitBranchesTab" }).props("compactHistory")).toBe(false);
    await pickTab(wrapper, "History");
    expect(wrapper.findComponent({ name: "GitBranchesTab" }).props("compactHistory")).toBe(true);
    wrapper.unmount();
  });

  test("a picked tool tab is the only active tab until History or Changes is chosen again", async () => {
    const ws = buildWorkspace({ id: "ws-more-active" });
    const wrapper = mountPane("ws-more-active", [ws]);
    await flushPromises();
    const tab = (label: string) => wrapper.findAll('[role="tab"]').find((el) => el.text() === label)!;
    expect(wrapper.findAll(".git-tabs__item--active")).toHaveLength(1);
    expect(tab("History").attributes("aria-selected")).toBe("true");

    await pickTab(wrapper, "Stashes");
    expect(tab("Stashes").attributes("aria-selected")).toBe("true");
    expect(tab("Stashes").classes()).toContain("git-tabs__item--active");
    expect(wrapper.findAll(".git-tabs__item--active")).toHaveLength(1);
    expect(wrapper.findAll('[role="tab"][aria-selected="true"]')).toHaveLength(1);
    expect(wrapper.findComponent({ name: "GitStashesTab" }).exists()).toBe(true);

    await pickTab(wrapper, "History");
    expect(tab("History").attributes("aria-selected")).toBe("true");
    expect(tab("History").classes()).toContain("git-tabs__item--active");
    expect(tab("Stashes").attributes("aria-selected")).toBe("false");
    expect(wrapper.findAll(".git-tabs__item--active")).toHaveLength(1);
    wrapper.unmount();
  });

  test("Overview separates working, upstream, and base status and sends branch management to Branches", async () => {
    const workspaceId = "ws-overview-status";
    const wrapper = mountPane(workspaceId, [buildWorkspace({ id: workspaceId })], { deep: true });
    const appStore = useAppStore();
    patchGitSnapshot(workspaceId, {
      branch: "feature/update-overview",
      branchNames: ["main", "origin/main", "feature/update-overview"],
      baseBranch: "main",
      upstream: "origin/feature/update-overview",
      aheadCount: 3,
      behindCount: 2,
      dirty: true,
      dirtyCount: 2,
      stashCount: 0,
      defaultRemote: "origin",
      remotes: { origin: "https://example.test/repo.git" },
    });
    await flushPromises();
    await pickTab(wrapper, "Overview");
    const gitUiStore = useGitUiStore();
    const rebaseBase = vi.spyOn(gitUiStore, "gitRebaseBase").mockImplementation(async () => {});

    const status = wrapper.get('[data-testid="branch-status-card"]');
    expect(status.text()).toContain("feature/update-overview");
    expect(status.text()).toContain("2 changed");
    expect(status.text()).toContain("origin/feature/update-overview");
    expect(status.text()).toContain("3 ahead · 2 behind");
    expect(status.text()).toContain("Base branch");
    expect(status.text().match(/Base branch:/g)).toHaveLength(1);
    expect(status.text()).not.toContain("Switch Branch");
    expect(status.text()).not.toContain("Checkout:");
    expect(wrapper.get('[data-testid="stash-card"]').text()).toContain("Stash changes…");
    expect(wrapper.get('[data-testid="stash-card"]').text()).not.toContain("Unstash");

    await wrapper.get('[data-testid="diverged-banner"] [data-testid="update-from-upstream"]').trigger("click");
    expect(rebaseBase).toHaveBeenLastCalledWith(workspaceId, "origin/feature/update-overview", { fetchFirst: true });
    const mergeBase = vi.spyOn(gitUiStore, "gitMergeBase").mockImplementation(async () => {});
    appStore.payload = {
      ...appStore.payload!,
      appState: { ...appStore.payload!.appState!, settings: { git: { ui: { updateStrategy: "merge" } } } },
    } as StatePayload;
    await wrapper.get('[data-testid="diverged-banner"] [data-testid="update-from-upstream"]').trigger("click");
    expect(mergeBase).toHaveBeenLastCalledWith(workspaceId, "origin/feature/update-overview", { fetchFirst: true });
    appStore.payload = {
      ...appStore.payload!,
      appState: { ...appStore.payload!.appState!, settings: { git: { ui: { updateStrategy: "rebase" } } } },
    } as StatePayload;
    await status.get('[data-testid="update-from-base"]').trigger("click");
    expect(rebaseBase).toHaveBeenLastCalledWith(workspaceId, "origin/main", { fetchFirst: true });

    await status.get("button").trigger("click");
    await flushPromises();
    expect(wrapper.findAll('[role="tab"][aria-selected="true"]').map((tab) => tab.text())).toEqual(["Branches"]);
    expect(wrapper.findComponent({ name: "GitBranchesTab" }).props("compactHistory")).toBe(false);
    wrapper.unmount();
  });

  test("clean Overview stash summary links to Stashes without offering an empty stash action", async () => {
    const workspaceId = "ws-overview-saved-stash";
    const wrapper = mountPane(workspaceId, [buildWorkspace({ id: workspaceId })], { deep: true });
    const appStore = useAppStore();
    const snapshot = appStore.payload!.git!.workspaces[workspaceId];
    appStore.payload = {
      ...appStore.payload!,
      git: {
        ...appStore.payload!.git!,
        workspaces: { ...appStore.payload!.git!.workspaces, [workspaceId]: { ...snapshot, stashCount: 1 } },
      },
    } as StatePayload;
    await flushPromises();
    await pickTab(wrapper, "Overview");

    const manageBranches = wrapper.get('[data-testid="branch-status-card"] button');
    expect(manageBranches.text()).toBe("Manage branches");
    await manageBranches.trigger("click");
    await flushPromises();
    expect(wrapper.find('[role="tab"][aria-selected="true"]').text()).toContain("Branches");
    await pickTab(wrapper, "Overview");

    const stashCard = wrapper.get('[data-testid="stash-card"]');
    expect(stashCard.text()).toContain("1 saved stash");
    expect(stashCard.find("button").text()).toContain("1 saved stash");
    expect(stashCard.text()).not.toContain("Stash changes");
    await stashCard.get("button").trigger("click");
    await flushPromises();
    expect(wrapper.find('[role="tab"][aria-selected="true"]').text()).toContain("Stashes");
    wrapper.unmount();
  });

  test("Go to Changes from Stashes selects the integrated Changes view", async () => {
    const workspaceId = "ws-stashes-to-changes";
    const ws = buildWorkspace({ id: workspaceId });
    const wrapper = mountPane(workspaceId, [ws], { deep: true });
    await flushPromises();

    await pickTab(wrapper, "Stashes");
    await wrapper.get(".stash-empty__actions button").trigger("click");
    await flushPromises();

    expect(
      wrapper
        .findAll('[role="tab"]')
        .find((tab) => tab.text() === "Changes")
        ?.attributes("aria-selected"),
    ).toBe("true");
    expect(wrapper.findComponent({ name: "GitChangesTab" }).exists()).toBe(true);
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
  ])("the %s tab routes to its existing tool", async (destination, componentName) => {
    const workspaceId = `ws-more-${destination}`;
    const ws = buildWorkspace({
      id: workspaceId,
      ...(destination === "bulk" ? { gitRoots: ["/ms/api", "/ms/web"] } : {}),
    });
    const wrapper = mountPane(workspaceId, [ws]);
    const appStore = useAppStore();
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
    expect(wrapper.findAll('[role="tab"]').map((el) => el.text().replace(/\d+$/, ""))).toContain(label);
    await pickTab(wrapper, label);
    expect(wrapper.findComponent({ name: componentName }).exists()).toBe(true);
    wrapper.unmount();
  });

  test("a saved tool tab that no longer exists shows the History view", async () => {
    const ws = buildWorkspace({ id: "ws-unavailable-more-tool" });
    const wrapper = mountPane("ws-unavailable-more-tool", [ws]);
    useGitUiStore().gitSwitchTab("ws-unavailable-more-tool", "conflicts");
    await flushPromises();

    const selected = wrapper.findAll('[role="tab"][aria-selected="true"]');
    expect(selected.map((tab) => tab.text())).toEqual(["History"]);
    expect(wrapper.findComponent({ name: "GitConflictsTab" }).exists()).toBe(false);
    wrapper.unmount();
  });

  test("a persisted Review view renders History and there is no Review tab", async () => {
    const ws = buildWorkspace({ id: "ws-persisted-review" });
    const wrapper = mountPane("ws-persisted-review", [ws]);
    const gitUiStore = useGitUiStore();
    gitUiStore.gitSwitchView("ws-persisted-review", "review", "/ms/api");
    gitUiStore.setActiveRoot("ws-persisted-review", "/ms/api");
    await flushPromises();

    const tabs = wrapper.findAll('[role="tab"]');
    expect(tabs.map((tab) => tab.text())).not.toContain("Review");
    expect(wrapper.findAll('[role="tab"][aria-selected="true"]').map((tab) => tab.text())).toEqual(["History"]);
    wrapper.unmount();
  });

  test("a review workspace with a clean tree opens on History", async () => {
    const ws = buildWorkspace({
      id: "ws-review-clean",
      kind: "review",
      review: { prKey: "azure:repo:42", provider: "azure-devops", role: "reviewer" },
    });
    const wrapper = mountPane("ws-review-clean", [ws]);
    await flushPromises();

    expect(wrapper.findAll('[role="tab"][aria-selected="true"]').map((tab) => tab.text())).toEqual(["History"]);
    expect(wrapper.findComponent({ name: "AzureReviewPane" }).exists()).toBe(false);
    wrapper.unmount();
  });

  test.each(["History", "Changes", "Overview"] as const)("keeps conflict resolution visible in %s", async (view) => {
    const workspaceId = `ws-conflicts-${view.toLowerCase()}`;
    const ws = buildWorkspace({ id: workspaceId });
    const wrapper = mountPane(workspaceId, [ws]);
    const appStore = useAppStore();
    const base = appStore.payload!;
    const snapshot = base.git!.workspaces[workspaceId];
    appStore.payload = {
      ...base,
      appState: base.appState!,
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

  test("keeps exactly one remote Git detail interest for the canonical Git pane lifecycle", async () => {
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

    expect(useRemoteDetailsStore().isInterested(`git:${workspaceId}`)).toBe(true);
    expect(subscriptions.at(-1)).toEqual(expected);

    wrapper.unmount();
    await flushPromises();
    expect(useRemoteDetailsStore().isInterested(`git:${workspaceId}`)).toBe(false);
    expect(subscriptions.at(-1)).toEqual([]);
    expect(subscriptions).toHaveLength(2);
  });
  test("History and Changes preferences survive switching between integrated tabs", async () => {
    const workspaceId = "ws-git-view-preferences";
    const workspace = buildWorkspace({ id: workspaceId, activeRootPath: "/ms/api", gitRoots: ["/ms/api", "/ms/web"] });
    const wrapper = mountPane(workspaceId, [workspace], { deep: true });
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

    await pickTab(wrapper, "Changes");
    await pickTab(wrapper, "History");
    expect(wrapper.get('[aria-label="History reference"]').attributes("data-value")).toBe("origin/release");

    gitUiStore.setActiveRoot(workspaceId, "/ms/web");
    gitUiStore.gitSwitchTab(workspaceId, "changes");
    await flushPromises();
    expect(gitUiStore.getGitView(workspaceId, "/ms/api")).toBe("history");
    expect(gitUiStore.getGitView(workspaceId, "/ms/web")).toBe("changes");

    gitUiStore.setActiveRoot(workspaceId, "/ms/api");
    await flushPromises();
    expect(wrapper.findAll('[role="tab"][aria-selected="true"]').map((tab) => tab.text())).toEqual(["History"]);
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
    // No active tool tab is stored yet, so the repo's History/Changes preference is used.
    expect(wrapper.find(".git-view__tabs-trigger__label").text()).toBe("History");
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

describe("GitPane header Refresh", () => {
  test("also asks the History view to reload", async () => {
    const ws = buildWorkspace({ id: "ws-refresh-token" });
    const wrapper = mountPane("ws-refresh-token", [ws], { deep: true });
    const store = useGitUiStore();
    const bump = vi.spyOn(store, "bumpHistoryRefresh");
    vi.spyOn(store, "refreshGit").mockResolvedValue(undefined);
    await flushPromises();
    const button = wrapper.findAll("button").find((b) => b.text() === "Refresh")!;
    expect(button.attributes("title")).toContain("reloads the commit history");
    await button.trigger("click");
    expect(bump).toHaveBeenCalledWith("ws-refresh-token");
    wrapper.unmount();
  });
});
