import { describe, expect, test, beforeEach, afterEach, vi } from "vitest";
import { reactive, ref } from "vue";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fakeApi: Record<string, any> = {};
const showError = vi.fn();
const addEvent = vi.fn();
const openDialog = vi.fn();
const closeDialog = vi.fn();
const azureCreatePullRequest = vi.fn();
const gitLoadGraph = vi.fn();
const gitFetch = vi.fn();
const gitPush = vi.fn();
const gitCheckoutBranch = vi.fn();
const gitCheckoutRemoteBranch = vi.fn();
const gitCreateBranch = vi.fn();
const gitRenameBranch = vi.fn();
const gitDeleteBranch = vi.fn();
const gitDeleteRemoteBranch = vi.fn();
const gitCreateTag = vi.fn();
const gitRemoveWorktree = vi.fn();
const historySelections = new Map<string, typeof historySelection>();
const historySelectionKey = (workspaceId: string, rootPath: string, profileId: string) =>
  `${profileId}::${workspaceId}::${rootPath}`;
const getHistorySelection = vi.fn(
  (workspaceId: string, rootPath: string, profileId: string) =>
    historySelections.get(historySelectionKey(workspaceId, rootPath, profileId)) || historySelection,
);

vi.mock("../../../stores/app.js", () => ({
  useAppStore: () => ({
    getApi: () => fakeApi,
    closeDialog,
    openDialog,
  }),
}));
vi.mock("../../../stores/git-ui.js", () => ({
  useGitUiStore: () => ({
    gitListBranches: vi.fn(),
    gitListTags: vi.fn(),
    gitLoadGraph,
    gitFetch,
    gitPush,
    getGitHistoryPreferences: () => ({ favorites: [], recent: [] }),
    getGitHistorySelection: getHistorySelection,
    setGitHistorySelection: (
      workspaceId: string,
      rootPath: string,
      profileId: string,
      patch: Record<string, string>,
    ) => {
      const selection =
        historySelections.get(historySelectionKey(workspaceId, rootPath, profileId)) || historySelection;
      Object.assign(selection, patch);
    },
    toggleGitHistoryFavorite: vi.fn(),
    recordGitHistoryRef: vi.fn(),
    gitFetchBaseComparison: vi.fn(),
    gitSelectCommit: vi.fn(),
    gitCreateBranch,
    gitCheckoutBranch,
    gitCheckoutRemoteBranch,
    gitRenameBranch,
    gitDeleteBranch,
    gitDeleteRemoteBranch,
    gitMergeBase: vi.fn(),
    gitRebaseBase: vi.fn(),
    gitCherryPick: vi.fn(),
    gitSquashCommits: vi.fn(),
    gitCreateTag,
    gitRemoveWorktree,
    confirmRemoveWorktreeDeleteBranch: vi.fn(),
    azureListRemoteBranches: vi.fn(),
    azureCreatePullRequest,
  }),
}));
const historySelection = reactive({
  ref: "",
  commitSearch: "",
  showRemotes: true,
  userFilter: "",
  dateFilter: "all" as "all" | "today" | "week" | "month" | "custom",
  customSince: "",
  customUntil: "",
  pathsFilter: [] as string[],
  topoOrder: false,
  graphLimit: 500,
  compareBase: "",
  includeBaseUpdates: false,
  viewMode: "graph" as "graph" | "flat",
});
vi.mock("../../../stores/notifications.js", () => ({
  useNotificationStore: () => ({ showError, addEvent }),
}));
vi.mock("../../../composables/useIsNarrow.js", () => ({
  useIsNarrow: () => mobileViewport,
}));

const mobileViewport = { isNarrow: ref(false), isMobile: ref(false) };

import GitBranchesTab from "./GitBranchesTab.vue";
import GitChangeTree from "./GitChangeTree.vue";
import CustomSelect from "../../common/CustomSelect.vue";
import BranchSelectPopover from "./BranchSelectPopover.vue";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mountedWrappers: VueWrapper<any>[] = [];

function mountTab(gitUiOverrides: Record<string, unknown> = {}) {
  const wrapper = mount(GitBranchesTab, {
    props: {
      workspaceId: "ws1",
      snapshot: { dirty: false, branch: "main" },
      gitUi: {
        branchList: { current: "main", locals: [], remotes: [], defaultBranch: "", defaultRemote: "" },
        graph: { commits: [], head: "", refs: {} },
        selectedCommit: "",
        ...gitUiOverrides,
      },
      activeRootPath: "/repo",
    },
    attachTo: document.body,
  });
  mountedWrappers.push(wrapper);
  return wrapper;
}

beforeEach(() => {
  setActivePinia(createPinia());
  for (const k of Object.keys(fakeApi)) delete fakeApi[k];
  showError.mockClear();
  addEvent.mockClear();
  openDialog.mockClear();
  closeDialog.mockClear();
  azureCreatePullRequest.mockReset();
  gitLoadGraph.mockClear();
  gitFetch.mockClear();
  gitPush.mockClear();
  gitCheckoutBranch.mockClear();
  gitCheckoutRemoteBranch.mockClear();
  gitCreateBranch.mockClear();
  gitRenameBranch.mockClear();
  gitDeleteBranch.mockClear();
  gitDeleteRemoteBranch.mockClear();
  gitCreateTag.mockClear();
  gitRemoveWorktree.mockClear();
  getHistorySelection.mockClear();
  historySelections.clear();
  document.body.innerHTML = "";
});

afterEach(async () => {
  for (const w of mountedWrappers) w.unmount();
  mountedWrappers.length = 0;
  document.body.innerHTML = "";
  await flushPromises();
  Object.assign(historySelection, {
    ref: "",
    commitSearch: "",
    showRemotes: true,
    userFilter: "",
    dateFilter: "all",
    customSince: "",
    customUntil: "",
    pathsFilter: [],
    topoOrder: false,
    graphLimit: 500,
    compareBase: "",
    includeBaseUpdates: false,
    viewMode: "graph",
  });
});

describe("GitBranchesTab compact history picker", () => {
  test("applies a relative path filter to the History graph query", async () => {
    vi.useFakeTimers();
    const picker = mount(GitBranchesTab, {
      props: {
        workspaceId: "ws1",
        snapshot: { dirty: false, branch: "main" },
        gitUi: {
          branchList: { current: "main", locals: [], remotes: [], defaultBranch: "", defaultRemote: "" },
          graph: { commits: [], head: "", refs: {} },
          selectedCommit: "",
        },
        activeRootPath: "/repo",
        compactHistory: true,
      },
      attachTo: document.body,
    });
    mountedWrappers.push(picker);
    const pathInput = picker.get('input[placeholder="+ path…"]');
    await pathInput.setValue("src/app.ts");
    await pathInput.trigger("keydown.enter");
    await vi.advanceTimersByTimeAsync(500);
    await flushPromises();

    expect(gitLoadGraph).toHaveBeenLastCalledWith("ws1", expect.objectContaining({ paths: ["src/app.ts"] }));
    expect(picker.text()).toContain("src/app.ts");
    picker.unmount();
    vi.useRealTimers();
  });

  test("applies custom date bounds and the selected result limit to the History query", async () => {
    vi.useFakeTimers();
    const picker = mountTab();
    const filterRow = picker.get(".git-branches__filters");
    const selects = filterRow.findAllComponents(CustomSelect);
    const dateSelect = selects.find((select: VueWrapper) => select.classes().includes("git-branches__cselect--date"));
    expect(dateSelect).toBeTruthy();
    dateSelect!.vm.$emit("update:modelValue", "custom");
    await flushPromises();

    await picker.get('input[title="Show commits on or after this date"]').setValue("2026-02-01");
    await picker.get('input[title="Show commits on or before this date"]').setValue("2026-02-28");
    const limitSelect = selects.find((select: VueWrapper) => select.classes().includes("git-branches__cselect--limit"));
    expect(limitSelect).toBeTruthy();
    limitSelect!.vm.$emit("update:modelValue", 500);
    await vi.advanceTimersByTimeAsync(500);
    await flushPromises();

    expect(gitLoadGraph).toHaveBeenLastCalledWith(
      "ws1",
      expect.objectContaining({ sinceDate: "2026-02-01", untilDate: "2026-02-28", limit: 500 }),
    );
    picker.unmount();
    vi.useRealTimers();
  });

  test("queries the selected base range and includes base updates only when requested", async () => {
    vi.useFakeTimers();
    const picker = mount(GitBranchesTab, {
      props: {
        workspaceId: "ws-compare-filter",
        snapshot: { dirty: false, branch: "topic" },
        gitUi: {
          branchList: {
            current: "topic",
            local: [{ name: "topic", isCurrent: true }],
            remotes: [],
            defaultBranch: "main",
            defaultRemote: "origin",
          },
          graph: { commits: [], head: "", refs: {} },
          selectedCommit: "",
        },
        activeRootPath: "/repo",
        compactHistory: true,
        baseBranchOptions: ["main"],
      },
    });
    mountedWrappers.push(picker);
    const comparePicker = picker.findComponent(BranchSelectPopover);
    expect(comparePicker.exists()).toBe(true);
    await picker.get(".git-branches__cselect--compare .branch-picker__button").trigger("click");
    await flushPromises();
    const mainOption = Array.from(document.body.querySelectorAll('[role="option"]')).find((row) =>
      row.textContent?.includes("main"),
    );
    expect(mainOption).toBeTruthy();
    mainOption!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await flushPromises();
    await vi.advanceTimersByTimeAsync(250);
    await flushPromises();
    expect(gitLoadGraph).toHaveBeenLastCalledWith(
      "ws-compare-filter",
      expect.objectContaining({ branch: "main..topic" }),
    );
    expect(picker.text()).toContain("main … HEAD");

    await picker.get('button[title^="Switch to walking base..."]').trigger("click");
    await vi.advanceTimersByTimeAsync(250);
    await flushPromises();
    expect(gitLoadGraph).toHaveBeenLastCalledWith(
      "ws-compare-filter",
      expect.objectContaining({ branch: "main...topic" }),
    );
    picker.unmount();
    vi.useRealTimers();
  });

  test("sends the selected commit author as a graph filter", async () => {
    vi.useFakeTimers();
    const gitUi = reactive({
      branchList: { current: "main", local: [{ name: "main", isCurrent: true }], remotes: [] },
      graph: { commits: [] as Array<Record<string, unknown>>, head: "", refs: {} },
    });
    const picker = mount(GitBranchesTab, {
      props: {
        workspaceId: "ws-author-filter",
        snapshot: { dirty: false, branch: "main" },
        gitUi,
        activeRootPath: "/repo",
        compactHistory: true,
      },
    });
    mountedWrappers.push(picker);
    await flushPromises();
    gitUi.graph.commits = [
      {
        hash: "abc123456789",
        shortHash: "abc1234",
        parents: [],
        subject: "A commit",
        author: "Ada Example",
        relativeDate: "today",
        isoDate: "2026-10-21T00:00:00.000Z",
        refs: [],
      },
    ];
    await flushPromises();
    const filterRow = picker.get(".git-branches__filters");
    const authorSelect = filterRow
      .findAllComponents(CustomSelect)
      .find((select: VueWrapper) => select.classes().includes("git-branches__cselect--user"));
    expect(authorSelect).toBeTruthy();
    expect(authorSelect!.props("options")).toContainEqual({ value: "Ada Example", label: "Ada Example" });
    authorSelect!.vm.$emit("update:modelValue", "Ada Example");
    await vi.advanceTimersByTimeAsync(250);
    await flushPromises();
    expect(gitLoadGraph).toHaveBeenLastCalledWith(
      "ws-author-filter",
      expect.objectContaining({ author: "Ada Example" }),
    );
    picker.unmount();
    vi.useRealTimers();
  });

  test("forwards the topological ordering toggle to the graph query", async () => {
    vi.useFakeTimers();
    const picker = mount(GitBranchesTab, {
      props: {
        workspaceId: "ws-topo-filter",
        snapshot: { dirty: false, branch: "main" },
        gitUi: {
          branchList: { current: "main", local: [{ name: "main", isCurrent: true }], remotes: [] },
          graph: { commits: [], head: "", refs: {} },
        },
        activeRootPath: "/repo",
        compactHistory: true,
      },
    });
    mountedWrappers.push(picker);
    await picker.get('button[title^="Date order"]').trigger("click");
    await vi.advanceTimersByTimeAsync(250);
    await flushPromises();
    expect(gitLoadGraph).toHaveBeenLastCalledWith("ws-topo-filter", expect.objectContaining({ topoOrder: true }));
    picker.unmount();
    vi.useRealTimers();
  });

  test("clears an active History path filter and reloads the unfiltered graph", async () => {
    vi.useFakeTimers();
    const picker = mount(GitBranchesTab, {
      props: {
        workspaceId: "ws-clear-history-filter",
        snapshot: { dirty: false, branch: "main" },
        gitUi: {
          branchList: { current: "main", local: [{ name: "main", isCurrent: true }], remotes: [] },
          graph: { commits: [], head: "", refs: {} },
        },
        activeRootPath: "/repo",
        compactHistory: true,
      },
    });
    mountedWrappers.push(picker);
    const pathInput = picker.get('input[placeholder="+ path…"]');
    await pathInput.setValue("src/feature.ts");
    await pathInput.trigger("keydown.enter");
    await vi.advanceTimersByTimeAsync(250);
    await flushPromises();
    expect(gitLoadGraph).toHaveBeenLastCalledWith(
      "ws-clear-history-filter",
      expect.objectContaining({ paths: ["src/feature.ts"] }),
    );

    await picker.get('button[title="Clear all commit filters"]').trigger("click");
    await vi.advanceTimersByTimeAsync(250);
    await flushPromises();
    expect(gitLoadGraph).toHaveBeenLastCalledWith("ws-clear-history-filter", expect.objectContaining({ paths: [] }));
    expect(picker.get('button[title="No active filters to clear"]').attributes("disabled")).toBeDefined();
    picker.unmount();
    vi.useRealTimers();
  });

  test("surfaces tag read failures in History", async () => {
    const picker = mountTab({ tagsError: "Could not load tags." });
    expect(picker.get('[role="alert"]').text()).toBe("Could not load tags.");
  });

  test("preserves a selected tag when tag reads fail during branch refresh", async () => {
    Object.assign(historySelection, { ref: "v1.2.3", commitSearch: "" });
    const gitUi = reactive({
      branchList: {
        current: "main",
        local: [{ name: "main", isCurrent: true }],
        remotes: [],
        defaultBranch: "main",
        defaultRemote: "",
      },
      graph: { commits: [], head: "", refs: {} },
      tags: [],
      tagsLoading: false,
      tagsError: "Tag list unavailable.",
      branchesLoading: false,
    });
    const picker = mount(GitBranchesTab, {
      props: {
        workspaceId: "ws-tag-read-error",
        snapshot: { dirty: false, branch: "main" },
        gitUi,
        compactHistory: true,
      },
    });
    gitUi.branchList.local.push({ name: "another-branch", isCurrent: false });
    await flushPromises();
    expect(historySelection.ref).toBe("v1.2.3");
    expect(picker.get('[role="alert"]').text()).toContain("Tag list unavailable.");
  });

  test("reads History selection scoped to the active profile, workspace, and root", async () => {
    const picker = mount(GitBranchesTab, {
      props: {
        workspaceId: "ws-scoped-history",
        activeRootPath: "/repo/scoped",
        profileId: "profile-scoped",
        snapshot: { dirty: false, branch: "main" },
        gitUi: {
          branchList: { current: "main", local: [], remotes: [], defaultBranch: "", defaultRemote: "" },
          graph: { commits: [], head: "", refs: {} },
          tags: [],
        },
        compactHistory: true,
      },
    });
    await flushPromises();
    expect(getHistorySelection).toHaveBeenCalledWith("ws-scoped-history", "/repo/scoped", "profile-scoped");
    expect(picker.find('[aria-label="History reference"]').exists()).toBe(true);
  });

  test("keeps the History ref picker natively keyboard-focusable", async () => {
    const picker = mount(GitBranchesTab, {
      props: {
        workspaceId: "ws-keyboard-history",
        snapshot: { dirty: false, branch: "main" },
        gitUi: {
          branchList: { current: "main", local: [{ name: "main", isCurrent: true }], remotes: [] },
          graph: { commits: [], head: "", refs: {} },
          tags: [],
        },
        compactHistory: true,
      },
      attachTo: document.body,
    });
    const select = picker.get<HTMLSelectElement>('[aria-label="History reference"]');
    expect(select.element.tabIndex).toBe(0);
    select.element.focus();
    expect(document.activeElement).toBe(select.element);
    expect(select.attributes("aria-label")).toBe("History reference");
    picker.unmount();
  });

  test("restores the visible History selection when switching roots and profiles", async () => {
    historySelections.set(historySelectionKey("ws-scope-switch", "/repo/a", "profile-a"), {
      ...historySelection,
      ref: "feature/a",
      commitSearch: "alpha",
      dateFilter: "custom",
      customSince: "2026-01-01",
      customUntil: "2026-02-01",
      pathsFilter: ["src/a.ts"],
      topoOrder: true,
      graphLimit: 1000,
      viewMode: "flat",
    });
    historySelections.set(historySelectionKey("ws-scope-switch", "/repo/b", "profile-a"), {
      ...historySelection,
      ref: "feature/b",
      commitSearch: "beta",
      dateFilter: "all",
      customSince: "",
      customUntil: "",
      pathsFilter: [],
      topoOrder: false,
      graphLimit: 300,
      viewMode: "graph",
    });
    historySelections.set(historySelectionKey("ws-scope-switch", "/repo/a", "profile-b"), {
      ...historySelection,
      ref: "release/a",
      commitSearch: "release",
    });
    const picker = mount(GitBranchesTab, {
      props: {
        workspaceId: "ws-scope-switch",
        activeRootPath: "/repo/a",
        profileId: "profile-a",
        snapshot: { dirty: false, branch: "main" },
        gitUi: {
          branchList: {
            current: "main",
            local: [{ name: "main" }, { name: "feature/a" }, { name: "feature/b" }, { name: "release/a" }],
            remotes: [],
            defaultBranch: "main",
            defaultRemote: "",
          },
          graph: { commits: [], head: "", refs: {} },
          tags: [],
        },
        baseBranchOptions: ["origin/main"],
        compactHistory: true,
      },
    });
    const select = () => picker.get<HTMLSelectElement>('[aria-label="History reference"]').element;
    expect(select().value).toBe("feature/a");
    expect(picker.findAll<HTMLInputElement>('input[type="date"]').map((input) => input.element.value)).toEqual([
      "2026-01-01",
      "2026-02-01",
    ]);
    expect(picker.get(".git-branches__path-chip").text()).toContain("src/a.ts");
    expect(picker.text()).toContain("Sort: Topo");
    expect(picker.text()).toContain("View: Flat");

    await picker.setProps({ activeRootPath: "/repo/b" } as never);
    expect(select().value).toBe("feature/b");
    expect(picker.findAll('input[type="date"]')).toHaveLength(0);
    expect(picker.findAll(".git-branches__path-chip")).toHaveLength(0);
    expect(picker.text()).toContain("Sort: Date");
    expect(picker.text()).toContain("View: Graph");
    await picker.setProps({ activeRootPath: "/repo/a", profileId: "profile-b" } as never);
    expect(select().value).toBe("release/a");
    await picker.setProps({ profileId: "profile-a" } as never);
    expect(select().value).toBe("feature/a");
    expect(picker.get<HTMLInputElement>('input[type="date"]').element.value).toBe("2026-01-01");
  });

  test("keeps a persisted ref selection while branch and tag reads are pending", async () => {
    Object.assign(historySelection, { ref: "origin/topic", commitSearch: "" });
    mobileViewport.isNarrow.value = false;
    const picker = mount(GitBranchesTab, {
      props: {
        workspaceId: "ws-pending-ref",
        snapshot: { dirty: false, branch: "main" },
        gitUi: {
          branchList: { current: "main", local: [], remotes: [], defaultBranch: "", defaultRemote: "" },
          graph: { commits: [], head: "", refs: {} },
          branchesLoading: true,
          tagsLoading: true,
        },
        compactHistory: true,
      },
    });
    await flushPromises();
    expect(historySelection.ref).toBe("origin/topic");
    expect(picker.get('[aria-label="History reference"]').element).toHaveProperty("value", "origin/topic");
  });

  test("prunes a missing ref when successful loading finishes with empty ref lists", async () => {
    Object.assign(historySelection, { ref: "gone/branch", commitSearch: "" });
    const gitUi = reactive({
      branchList: { current: "", local: [], remotes: [], defaultBranch: "", defaultRemote: "" },
      graph: { commits: [], head: "", refs: {} },
      tags: [],
      branchesLoading: true,
      tagsLoading: true,
      tagsError: "",
    });
    const picker = mount(GitBranchesTab, {
      props: {
        workspaceId: "ws-empty-ref-load",
        snapshot: { dirty: false, branch: "" },
        gitUi,
        compactHistory: true,
      },
    });
    expect(historySelection.ref).toBe("gone/branch");
    gitUi.branchesLoading = false;
    gitUi.tagsLoading = false;
    await flushPromises();
    expect(historySelection.ref).toBe("");
    expect(picker.get('[role="status"]').text()).toContain("Reference “gone/branch” is no longer available");
  });

  test("explains when a selected ref disappears after successful reads", async () => {
    Object.assign(historySelection, { ref: "origin/topic", commitSearch: "" });
    const gitUi = reactive({
      branchList: {
        current: "main",
        local: [],
        remotes: [{ name: "origin/topic" }],
        defaultBranch: "",
        defaultRemote: "",
      },
      graph: { commits: [], head: "", refs: {} },
      tags: [],
      branchesLoading: true,
      tagsLoading: true,
    });
    const picker = mount(GitBranchesTab, {
      props: {
        workspaceId: "ws-deleted-ref",
        snapshot: { dirty: false, branch: "main" },
        gitUi,
        compactHistory: true,
      },
    });
    gitUi.branchList.remotes = [];
    gitUi.branchesLoading = false;
    gitUi.tagsLoading = false;
    await flushPromises();
    expect(historySelection.ref).toBe("");
    expect(picker.get('[role="status"]').text()).toContain("Reference “origin/topic” is no longer available");
  });

  test("compact History skips the hidden branch-tree step on narrow layouts", async () => {
    mobileViewport.isNarrow.value = true;
    mobileViewport.isMobile.value = true;
    const picker = mount(GitBranchesTab, {
      props: {
        workspaceId: "ws-mobile-history",
        snapshot: { dirty: false, branch: "main" },
        gitUi: {
          branchList: { current: "main", local: [{ name: "main", isCurrent: true }], remotes: [] },
          graph: {
            commits: [{ hash: "abc123456789", shortHash: "abc1234", message: "History entry" }],
            head: "abc123456789",
            refs: {},
          },
        },
        compactHistory: true,
      },
    });
    await flushPromises();
    expect(picker.get('[role="tablist"]').attributes("aria-label")).toBe("History view");
    expect(picker.get('[role="tablist"] button').text()).toBe("History");
    expect(picker.find(".git-branches__commits-pane").exists()).toBe(true);
    expect(picker.find(".git-branches__diff-pane--mobile").exists()).toBe(false);
    expect(historySelection.ref).toBe("");
    picker.unmount();
    mobileViewport.isNarrow.value = false;
    mobileViewport.isMobile.value = false;
  });

  test("shows detached HEAD and an empty-history state in a repository without commits", async () => {
    mobileViewport.isNarrow.value = false;
    mobileViewport.isMobile.value = false;
    const picker = mount(GitBranchesTab, {
      props: {
        workspaceId: "ws-empty-history",
        snapshot: { dirty: false, branch: "" },
        gitUi: {
          branchList: { current: "", local: [], remotes: [], defaultBranch: "", defaultRemote: "" },
          graph: { commits: [], head: "", refs: {} },
          tags: [],
          busyAction: "fetch",
        },
        compactHistory: true,
      },
    });
    await flushPromises();
    expect(picker.get('[aria-label="History reference"]').text()).toContain("HEAD · detached");
    expect(picker.findAll(".git-history-picker__current")[0].text()).toContain("Working branch: Detached HEAD");
    expect(picker.findAll(".git-tree__placeholder").some((node) => node.text() === "No commits found.")).toBe(true);
    expect(picker.find('[data-testid="operation-card"]').exists()).toBe(true);
  });

  test("renders and filters a large History ref list", async () => {
    mobileViewport.isNarrow.value = false;
    mobileViewport.isMobile.value = false;
    const branches = Array.from({ length: 400 }, (_, index) => ({
      name: `feature/topic-${String(index).padStart(3, "0")}`,
      isCurrent: index === 0,
    }));
    const picker = mount(GitBranchesTab, {
      props: {
        workspaceId: "ws-large-history",
        snapshot: { dirty: false, branch: branches[0]!.name },
        gitUi: {
          branchList: {
            current: branches[0]!.name,
            local: branches,
            remotes: [],
            defaultBranch: "",
            defaultRemote: "",
          },
          graph: { commits: [], head: "", refs: {} },
          tags: [],
        },
        compactHistory: true,
      },
    });
    await flushPromises();
    const select = picker.get('[aria-label="History reference"]');
    expect(select.findAll("option").some((option) => option.text().includes("feature/topic-399"))).toBe(true);

    await picker.get('[aria-label="Search history references"]').setValue("feature/topic-399");
    expect(select.findAll("option").filter((option) => option.text().includes("feature/topic-")).length).toBeLessThan(
      5,
    );
    expect(select.text()).toContain("feature/topic-399");
  });

  test("distinguishes an empty commit search from a history query error", async () => {
    const gitUi = reactive({
      branchList: { current: "main", local: [{ name: "main", isCurrent: true }], remotes: [] },
      graph: {
        commits: [{ hash: "abc123456789", shortHash: "abc1234", message: "A real commit" }],
        head: "abc123456789",
        refs: {},
      },
      graphError: "",
    });
    const picker = mount(GitBranchesTab, {
      props: {
        workspaceId: "ws-history-search-error",
        snapshot: { dirty: false, branch: "main" },
        gitUi,
        compactHistory: true,
      },
    });
    const search = picker.get('[aria-label="Search commits"]');
    await search.setValue("no such commit");
    expect(picker.text()).toContain("No commits match “no such commit”.");
    expect(picker.find(".git-branches__pane-error").exists()).toBe(false);

    gitUi.graphError = "History query failed.";
    await flushPromises();
    expect(picker.text()).not.toContain("No commits match “no such commit”.");
    expect(picker.find(".git-branches__pane-error").text()).toContain("History query failed.");
  });

  test("selecting a named reference only changes the graph query", async () => {
    vi.useFakeTimers();
    mobileViewport.isMobile.value = false;
    const picker = mount(GitBranchesTab, {
      props: {
        workspaceId: "ws1",
        snapshot: { dirty: false, branch: "main" },
        gitUi: {
          branchList: {
            current: "main",
            upstream: "origin/main",
            local: [
              { name: "main", isCurrent: true },
              { name: "feature/topic", isCurrent: false },
            ],
            remotes: [{ name: "origin/main", shortName: "main", remote: "origin" }],
            defaultBranch: "main",
            defaultRemote: "origin",
          },
          graph: { commits: [], head: "", refs: {} },
          tags: [{ name: "v1.0.0" }],
        },
        compactHistory: true,
      },
    });
    await flushPromises();
    const select = picker.get('[aria-label="History reference"]');
    await select.setValue("origin/main");
    expect(historySelection.ref).toBe("origin/main");
    await flushPromises();
    await vi.advanceTimersByTimeAsync(300);
    await flushPromises();
    expect(picker.find('[aria-label="Search history references"]').exists()).toBe(true);
    expect(picker.find('[aria-label="History reference"]').element).toBe(select.element);
    expect(gitLoadGraph).toHaveBeenCalledWith("ws1", expect.objectContaining({ branch: "origin/main" }));
    expect(gitCheckoutBranch).not.toHaveBeenCalled();
    expect(gitCheckoutRemoteBranch).not.toHaveBeenCalled();
    expect(gitCreateBranch).not.toHaveBeenCalled();
    expect(gitRenameBranch).not.toHaveBeenCalled();
    expect(gitDeleteBranch).not.toHaveBeenCalled();
    expect(gitDeleteRemoteBranch).not.toHaveBeenCalled();
    expect(gitCreateTag).not.toHaveBeenCalled();
    expect(gitRemoveWorktree).not.toHaveBeenCalled();
    expect(gitFetch).not.toHaveBeenCalled();
    expect(gitPush).not.toHaveBeenCalled();
    picker.unmount();
    vi.useRealTimers();
  });

  test("restores the selected History reference after the History pane remounts", async () => {
    vi.useFakeTimers();
    mobileViewport.isMobile.value = false;
    const props = {
      workspaceId: "ws-history-remount",
      snapshot: { dirty: false, branch: "main" },
      gitUi: {
        branchList: {
          current: "main",
          local: [{ name: "main", isCurrent: true }],
          remotes: [{ name: "origin/release", shortName: "release", remote: "origin" }],
          defaultBranch: "main",
          defaultRemote: "origin",
        },
        graph: { commits: [], head: "", refs: {} },
        tags: [],
      },
      compactHistory: true,
    };
    const first = mount(GitBranchesTab, { props });
    mountedWrappers.push(first);
    await flushPromises();
    await first.get('[aria-label="History reference"]').setValue("origin/release");
    expect(historySelection.ref).toBe("origin/release");
    first.unmount();

    const second = mount(GitBranchesTab, { props });
    mountedWrappers.push(second);
    await flushPromises();
    expect((second.get('[aria-label="History reference"]').element as HTMLSelectElement).value).toBe("origin/release");
    second.unmount();
    vi.useRealTimers();
  });

  test("HEAD and all references issue distinct graph queries", async () => {
    vi.useFakeTimers();
    mobileViewport.isMobile.value = false;
    const picker = mount(GitBranchesTab, {
      props: {
        workspaceId: "ws-head-scope",
        snapshot: { dirty: false, branch: "main" },
        gitUi: {
          branchList: {
            current: "main",
            local: [{ name: "main", isCurrent: true }],
            remotes: [],
            defaultBranch: "main",
            defaultRemote: "",
          },
          graph: { commits: [], head: "", refs: {} },
        },
        compactHistory: true,
      },
    });
    await flushPromises();
    const select = picker.get('[aria-label="History reference"]');

    await select.setValue("HEAD");
    await flushPromises();
    expect(historySelection.ref).toBe("HEAD");
    await vi.advanceTimersByTimeAsync(300);
    expect(gitLoadGraph).toHaveBeenLastCalledWith("ws-head-scope", expect.objectContaining({ branch: "HEAD" }));

    await select.setValue("__ALL__");
    await flushPromises();
    expect(historySelection.ref).toBe("");
    await vi.advanceTimersByTimeAsync(300);
    expect(gitLoadGraph).toHaveBeenLastCalledWith("ws-head-scope", expect.objectContaining({ branch: "" }));

    picker.unmount();
    vi.useRealTimers();
  });

  test("reloads the selected history query when the root changes but its ref is the same", async () => {
    vi.useFakeTimers();
    historySelections.set(historySelectionKey("ws-root-history", "/repo-b", "default"), {
      ...historySelection,
      ref: "topic-b",
      commitSearch: "",
    });
    const picker = mount(GitBranchesTab, {
      props: {
        workspaceId: "ws-root-history",
        snapshot: { dirty: false, branch: "main" },
        gitUi: {
          branchList: {
            current: "main",
            local: [
              { name: "main", isCurrent: true },
              { name: "topic-b", isCurrent: false },
            ],
            remotes: [],
            defaultBranch: "main",
            defaultRemote: "",
          },
          graph: { commits: [], head: "", refs: {} },
        },
        activeRootPath: "/repo-a",
        compactHistory: true,
      },
    });
    await flushPromises();
    gitLoadGraph.mockClear();

    await picker.setProps({ activeRootPath: "/repo-b" } as never);
    await flushPromises();
    await vi.advanceTimersByTimeAsync(300);

    expect(gitLoadGraph).toHaveBeenCalledWith("ws-root-history", expect.objectContaining({ branch: "topic-b" }));
    picker.unmount();
    vi.useRealTimers();
  });
});

/**
 * Category A (code-review batch, 2026-07): loadCommitFiles used to swallow
 * a failed fileCommitFiles call into an empty `commitFiles` array, which is
 * indistinguishable from "this commit genuinely touched zero files."
 */
describe("GitBranchesTab — loadCommitFiles surfaces a load failure", () => {
  test("a rejected fileCommitFiles call shows a distinct error, not the empty-changes message", async () => {
    fakeApi.fileCommitFiles = vi.fn().mockRejectedValue(new Error("git show failed: bad object"));
    const wrapper = mountTab({ selectedCommit: "abc1234" });
    await flushPromises();

    const placeholder = wrapper.find(".git-branches__commit-files .git-branches__placeholder");
    expect(placeholder.exists()).toBe(true);
    expect(placeholder.text()).toContain("git show failed: bad object");
    // The GitChangeTree (which would render "No local changes." for a
    // genuinely empty list) must not be the thing rendered on failure.
    expect(wrapper.findComponent(GitChangeTree).exists()).toBe(false);
  });

  test("a successful load renders the files and never shows the empty/error placeholder", async () => {
    fakeApi.fileCommitFiles = vi.fn().mockResolvedValue({ files: [{ path: "src/foo.ts", code: "M" }] });
    const wrapper = mountTab({ selectedCommit: "def5678" });
    await flushPromises();

    expect(wrapper.find(".git-branches__commit-files .git-branches__placeholder").exists()).toBe(false);
    expect(wrapper.findComponent(GitChangeTree).exists()).toBe(true);
  });

  test("reloads commit files when the repository root changes but the selected hash is the same", async () => {
    let finishA!: (result: { files: Array<{ path: string; code: string }> }) => void;
    fakeApi.fileCommitFiles = vi.fn(({ rootPath }: { rootPath: string }) =>
      rootPath === "/repo"
        ? new Promise<{ files: Array<{ path: string; code: string }> }>((resolve) => (finishA = resolve))
        : Promise.resolve({ files: [{ path: "from-b.ts", code: "M" }] }),
    );
    const wrapper = mountTab({ selectedCommit: "same-sha" });
    await vi.waitFor(() => expect(fakeApi.fileCommitFiles).toHaveBeenCalledTimes(1));

    await wrapper.setProps({ activeRootPath: "/repo-b" } as never);
    await flushPromises();
    expect(fakeApi.fileCommitFiles).toHaveBeenNthCalledWith(1, { rootPath: "/repo", hash: "same-sha" });
    expect(fakeApi.fileCommitFiles).toHaveBeenNthCalledWith(2, { rootPath: "/repo-b", hash: "same-sha" });
    finishA({ files: [{ path: "from-a.ts", code: "M" }] });
    await flushPromises();
    expect(wrapper.text()).toContain("from-b.ts");
    expect(wrapper.text()).not.toContain("from-a.ts");
  });
});

/**
 * Category B (code-review batch, 2026-07): copyToClipboard did
 * `navigator.clipboard.writeText(...).catch(() => {})` (best-effort, no
 * feedback) — a failed copy was invisible.
 */
describe("GitBranchesTab — copyToClipboard surfaces a failure notification", () => {
  test("copying the absolute path when the clipboard write rejects shows an error toast", async () => {
    Object.defineProperty(window.navigator, "clipboard", {
      value: { writeText: vi.fn().mockRejectedValue(new Error("clipboard blocked")) },
      configurable: true,
    });
    fakeApi.fileCommitFiles = vi.fn().mockResolvedValue({ files: [{ path: "src/foo.ts", code: "M" }] });
    const wrapper = mountTab({ selectedCommit: "abc1234" });
    await flushPromises();

    const tree = wrapper.findComponent(GitChangeTree);
    expect(tree.exists()).toBe(true);
    tree.vm.$emit("context-menu", { path: "src/foo.ts", name: "foo.ts", kind: "file", x: 10, y: 10 });
    await flushPromises();

    const copyAbsBtn = Array.from(document.body.querySelectorAll(".context-menu__item")).find((el) =>
      el.textContent?.includes("Copy absolute path"),
    ) as HTMLButtonElement;
    expect(copyAbsBtn).toBeTruthy();
    copyAbsBtn.click();
    await flushPromises();

    expect(showError).toHaveBeenCalledTimes(1);
    expect(showError.mock.calls[0][0]).toBe("Copy failed");
    expect(showError.mock.calls[0][1]).toMatchObject({ message: "clipboard blocked" });
  });
});

/**
 * §5.4(d): the CreatePullRequestDialog's onSubmit handler now goes through
 * the same submitPullRequest() helper as GitPullRequestTab's inline form —
 * this pins that both success (close + toast) and failure (throw, dialog
 * stays open) behave the way CreatePullRequestDialog's own try/catch expects.
 */
describe("GitBranchesTab — create-pr dialog submission (shared submitPullRequest)", () => {
  function mountForPrDialog(gitUi: Record<string, unknown>) {
    const wrapper = mount(GitBranchesTab, {
      props: {
        workspaceId: "ws1",
        snapshot: { dirty: false, branch: "feature/x" },
        gitUi,
        activeRootPath: "/repo",
        hasAzureConnection: true,
        activeConnectionId: "conn-1",
      },
      attachTo: document.body,
    });
    mountedWrappers.push(wrapper);
    return wrapper;
  }

  test("submits via submitPullRequest and closes + toasts on success", async () => {
    const gitUi: Record<string, unknown> = {
      branchList: { current: "feature/x", locals: [], remotes: [], defaultBranch: "", defaultRemote: "" },
      graph: { commits: [], head: "", refs: {} },
      selectedCommit: "",
      remoteBranches: [],
      lastResult: null,
    };
    azureCreatePullRequest.mockImplementation(async () => {
      gitUi.lastResult = { ok: true, pullRequestId: 42, url: "https://dev.azure.com/pr/42" };
    });

    const wrapper = mountForPrDialog(gitUi);
    await flushPromises();
    const branchTree = wrapper.findComponent({ name: "BranchTreePane" });
    expect(branchTree.exists()).toBe(true);
    branchTree.vm.$emit("create-pr", "feature/x");
    await flushPromises();

    expect(openDialog).toHaveBeenCalledTimes(1);
    const [dialogName, dialogConfig] = openDialog.mock.calls[0];
    expect(dialogName).toBe("CreatePullRequestDialog");

    await dialogConfig.onSubmit({ title: "My PR", description: "", targetBranch: "main", isDraft: false });

    expect(azureCreatePullRequest).toHaveBeenCalledWith(
      "ws1",
      expect.objectContaining({ title: "My PR", sourceBranch: "feature/x", targetBranch: "main" }),
    );
    expect(closeDialog).toHaveBeenCalledTimes(1);
    expect(addEvent).toHaveBeenCalledTimes(1);
    expect(addEvent.mock.calls[0][0].body).toContain("PR #42 created.");
  });

  test("throws with the backend summary on failure, leaving the dialog open", async () => {
    const gitUi: Record<string, unknown> = {
      branchList: { current: "feature/x", locals: [], remotes: [], defaultBranch: "", defaultRemote: "" },
      graph: { commits: [], head: "", refs: {} },
      selectedCommit: "",
      remoteBranches: [],
      lastResult: null,
    };
    azureCreatePullRequest.mockImplementation(async () => {
      gitUi.lastResult = { ok: false, summary: "A pull request already exists for this branch." };
    });

    const wrapper = mountForPrDialog(gitUi);
    await flushPromises();
    const branchTree = wrapper.findComponent({ name: "BranchTreePane" });
    branchTree.vm.$emit("create-pr", "feature/x");
    await flushPromises();

    const [, dialogConfig] = openDialog.mock.calls[0];
    await expect(
      dialogConfig.onSubmit({ title: "My PR", description: "", targetBranch: "main", isDraft: false }),
    ).rejects.toThrow("A pull request already exists for this branch.");

    expect(closeDialog).not.toHaveBeenCalled();
  });
});
