import { describe, expect, test, beforeEach, afterEach, vi } from "vitest";
import { h, reactive, ref } from "vue";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { setActivePinia, createPinia } from "pinia";

vi.mock("../../shared/MonacoDiffPanel.vue", () => ({
  __esModule: true,
  default: {
    name: "MonacoDiffPanel",
    props: ["payload", "loading", "initialInline", "popoutTitle"],
    render: () => h("div", { class: "mdp-stub" }),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fakeApi: Record<string, any> = {};
const showError = vi.fn();
const addEvent = vi.fn();
const openDialog = vi.fn();
const closeDialog = vi.fn();
const azureCreatePullRequest = vi.fn();
const gitListBranches = vi.fn();
const gitLoadGraph = vi.fn();
const gitFetch = vi.fn();
const toggleGitHistoryFavorite = vi.fn();
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
let historyPreferences = { favorites: [] as string[], recent: [] as string[] };

vi.mock("../../../stores/app.js", () => ({
  useAppStore: () => ({
    getApi: () => fakeApi,
    closeDialog,
    openDialog,
  }),
}));
vi.mock("../../../stores/git-ui.js", () => ({
  useGitUiStore: () => ({
    gitListBranches,
    gitListTags: vi.fn(),
    gitLoadGraph,
    gitFetch,
    gitPush,
    getGitHistoryPreferences: () => historyPreferences,
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
    toggleGitHistoryFavorite,
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
import GitHistoryFilters from "./GitHistoryFilters.vue";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mountedWrappers: VueWrapper<any>[] = [];

const menuItems = () => Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'));
const optionRows = () => Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]'));

async function addCompactPath(path: string) {
  const input = document.body.querySelector<HTMLInputElement>('input[aria-label="Add path filter"]')!;
  input.value = path;
  input.dispatchEvent(new Event("input"));
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await flushPromises();
}

async function chooseHistoryRef(button: { trigger: (event: string) => Promise<void> }, name: string) {
  await button.trigger("click");
  const direct = menuItems().find((item) =>
    name === "All branches and tags"
      ? item.textContent?.trim() === name
      : item.textContent?.trim().endsWith("HEAD") && name === "HEAD",
  );
  if (direct) {
    direct.click();
    await flushPromises();
    return;
  }
  menuItems()
    .find((item) => item.textContent?.trim() === "Select…")!
    .click();
  await flushPromises();
  const input = document.body.querySelector<HTMLInputElement>('[aria-label="Search history references"]')!;
  input.value = name;
  input.dispatchEvent(new Event("input"));
  await flushPromises();
  const row = optionRows().find((candidate) => candidate.textContent?.trim().replace(/^[★☆]/, "") === name);
  if (!row) throw new Error(`No History range option "${name}"`);
  row.click();
  await flushPromises();
}

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
  historyPreferences = { favorites: [], recent: [] };
  setActivePinia(createPinia());
  for (const k of Object.keys(fakeApi)) delete fakeApi[k];
  showError.mockClear();
  addEvent.mockClear();
  openDialog.mockClear();
  closeDialog.mockClear();
  azureCreatePullRequest.mockReset();
  gitListBranches.mockClear();
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
  test("keeps the diff pane full while pointer dragging across the combined minimum boundary", async () => {
    const picker = mountTab();
    await flushPromises();
    const panes = picker.get(".git-branches__panes");
    Object.defineProperty(panes.element, "clientWidth", { value: 1000 });
    const splitter = picker.findAll(".git-branches__panes > .splitpanes__splitter")[1];
    const frames: FrameRequestCallback[] = [];
    const requestFrame = vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });

    try {
      await splitter.trigger("mousedown", { clientX: 0 });
      for (const clientX of [460, 459, 450, 300, 459, 460]) {
        document.dispatchEvent(new MouseEvent("mousemove", { clientX, bubbles: true }));
        frames.splice(0).forEach((callback) => callback(0));
        await flushPromises();

        const sizes = picker
          .findAll(".git-branches__panes > .splitpanes__pane")
          .map((pane) => parseFloat((pane.element as HTMLElement).style.width));
        expect(sizes).toEqual([18, 28, 54]);
      }
    } finally {
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      requestFrame.mockRestore();
      await new Promise((resolve) => setTimeout(resolve, 110));
    }
  });

  test("keeps the diff pane filling the remaining width when commits and branches reach their minimum", async () => {
    const picker = mountTab();
    await flushPromises();
    const splitter = picker.findAll(".git-branches__panes > .splitpanes__splitter")[1];

    for (let step = 0; step < 8; step++) {
      await splitter.trigger("keydown", { key: "ArrowLeft" });
      await flushPromises();
    }

    const sizes = () =>
      picker
        .findAll(".git-branches__panes > .splitpanes__pane")
        .map((pane) => parseFloat((pane.element as HTMLElement).style.width));
    expect(sizes()).toEqual([18, 28, 54]);

    for (let step = 0; step < 4; step++) {
      await splitter.trigger("keydown", { key: "ArrowRight" });
    }
    expect(sizes()).toEqual([18, 48, 34]);

    for (let step = 0; step < 8; step++) {
      await splitter.trigger("keydown", { key: "ArrowLeft" });
    }
    expect(sizes()).toEqual([18, 28, 54]);
  });

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
    await picker.get(".git-branches__paths-button").trigger("click");
    await addCompactPath("src/app.ts");
    await vi.advanceTimersByTimeAsync(500);
    await flushPromises();

    expect(gitLoadGraph).toHaveBeenLastCalledWith("ws1", expect.objectContaining({ paths: ["src/app.ts"] }));
    expect(document.body.textContent).toContain("src/app.ts");
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
        baseBranchOptions: ["main", "develop"],
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

    await picker.get(".git-branches__cselect--compare .branch-picker__button").trigger("click");
    await flushPromises();
    const options = Array.from(document.body.querySelectorAll('[role="option"]'));
    options
      .find((row) => row.textContent?.includes("develop"))
      ?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await flushPromises();
    expect(picker.find('input[type="checkbox"]').exists()).toBe(true);
    expect((picker.get('input[type="checkbox"]').element as HTMLInputElement).checked).toBe(false);
    await vi.advanceTimersByTimeAsync(250);
    await flushPromises();
    expect(gitLoadGraph).toHaveBeenLastCalledWith(
      "ws-compare-filter",
      expect.objectContaining({ branch: "develop..topic" }),
    );

    await picker.get(".git-branches__cselect--compare .branch-picker__button").trigger("click");
    await flushPromises();
    const offOption = Array.from(document.body.querySelectorAll(".branch-picker__row")).find((row) =>
      row.textContent?.includes("Compare: off"),
    );
    offOption?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await flushPromises();
    expect(picker.find('input[type="checkbox"]').exists()).toBe(false);
    await vi.advanceTimersByTimeAsync(250);
    await flushPromises();
    expect(gitLoadGraph).toHaveBeenLastCalledWith("ws-compare-filter", expect.objectContaining({ branch: "" }));
    picker.unmount();
    vi.useRealTimers();
  });

  test("compact History keeps the commits pane visible", async () => {
    const picker = mount(GitBranchesTab, {
      props: {
        workspaceId: "ws-compact-panes",
        snapshot: { dirty: false, branch: "main" },
        gitUi: {
          branchList: { current: "main", local: [{ name: "main", isCurrent: true }], remotes: [] },
          graph: {
            commits: [
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
            ],
            head: "abc123456789",
            refs: {},
          },
          selectedCommit: "",
        },
        activeRootPath: "/repo",
        compactHistory: true,
      },
    });
    mountedWrappers.push(picker);
    await flushPromises();
    const panes = picker.findAll(".git-branches__panes > .splitpanes__pane");
    expect(panes).toHaveLength(2);
    expect(panes[0].findComponent({ name: "GitTreeGraph" }).exists()).toBe(true);
    for (const graph of picker.findAllComponents({ name: "GitTreeGraph" })) {
      expect(graph.props("history")).toBe(true);
    }
    const source = readFileSync(resolve(process.cwd(), "src/components/workspace/git/GitBranchesTab.vue"), "utf8");
    expect(source).not.toContain("splitpanes__pane:first-child");
  });

  test("legacy Branches view does not use history rows", async () => {
    const picker = mount(GitBranchesTab, {
      props: {
        workspaceId: "ws-legacy-rows",
        snapshot: { dirty: false, branch: "main" },
        gitUi: {
          branchList: { current: "main", local: [{ name: "main", isCurrent: true }], remotes: [] },
          graph: {
            commits: [
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
            ],
            head: "abc123456789",
            refs: {},
          },
          selectedCommit: "",
        },
        activeRootPath: "/repo",
        compactHistory: false,
      },
    });
    mountedWrappers.push(picker);
    await flushPromises();
    const graphs = picker.findAllComponents({ name: "GitTreeGraph" });
    expect(graphs.length).toBeGreaterThan(0);
    for (const graph of graphs) expect(graph.props("history")).toBe(false);
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
    await picker.get(".git-branches__user-button").trigger("click");
    const menuRows = () => Array.from(document.body.querySelectorAll<HTMLElement>(".git-history-menu__row"));
    menuRows()
      .find((r) => r.textContent?.includes("Select…"))!
      .click();
    await flushPromises();
    const search = document.body.querySelector<HTMLInputElement>('input[aria-label="Search authors"]')!;
    search.value = "Ada";
    search.dispatchEvent(new Event("input"));
    await flushPromises();
    menuRows()
      .find((r) => r.textContent?.includes("Ada Example"))!
      .click();
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
    await picker.get(".git-branches__paths-button").trigger("click");
    await addCompactPath("src/feature.ts");
    await vi.advanceTimersByTimeAsync(250);
    await flushPromises();
    expect(gitLoadGraph).toHaveBeenLastCalledWith(
      "ws-clear-history-filter",
      expect.objectContaining({ paths: ["src/feature.ts"] }),
    );

    await picker.get('button[title="Clear the search, branch and all commit filters"]').trigger("click");
    await vi.advanceTimersByTimeAsync(250);
    await flushPromises();
    expect(gitLoadGraph).toHaveBeenLastCalledWith("ws-clear-history-filter", expect.objectContaining({ paths: [] }));
    expect(picker.find('button[title="Clear the search, branch and all commit filters"]').exists()).toBe(false);
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
    const select = picker.get<HTMLButtonElement>('[aria-label="History reference"]');
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
    const select = () => ({ value: picker.get('[aria-label="History reference"]').attributes("data-value") });
    expect(select().value).toBe("feature/a");
    expect(picker.findAll<HTMLInputElement>('input[type="date"]').map((input) => input.element.value)).toEqual([
      "2026-01-01",
      "2026-02-01",
    ]);
    expect(picker.get(".git-branches__paths-button").text()).toContain("Paths: 1");
    await picker.get(".git-branches__paths-button").trigger("click");
    expect(document.body.querySelector(".git-history-menu__row--static")!.textContent).toContain("src/a.ts");
    expect(picker.text()).toContain("Sort: Topo");
    expect(picker.text()).toContain("View: Flat");

    await picker.setProps({ activeRootPath: "/repo/b" } as never);
    expect(select().value).toBe("feature/b");
    expect(picker.findAll('input[type="date"]')).toHaveLength(0);
    expect(document.body.querySelector(".git-history-menu__row--static")).toBeNull();
    expect(picker.get(".git-branches__paths-button").text()).toBe("Paths▾");
    expect(picker.text()).toContain("Sort: Date");
    expect(picker.text()).toContain("View: Graph");
    await picker.setProps({ activeRootPath: "/repo/a", profileId: "profile-b" } as never);
    expect(select().value).toBe("release/a");
    await picker.setProps({ profileId: "profile-a" } as never);
    expect(select().value).toBe("feature/a");
    expect(picker.get<HTMLInputElement>('input[type="date"]').element.value).toBe("2026-01-01");
  });

  test("History keeps its structure while loading, the legacy view keeps the cold-start block", async () => {
    mobileViewport.isNarrow.value = false;
    const mountLoading = (compactHistory: boolean, id: string) => {
      const wrapper = mount(GitBranchesTab, {
        props: {
          workspaceId: id,
          snapshot: { dirty: false, branch: "main" },
          gitUi: { graph: { commits: [], head: "", refs: {} }, branchesLoading: true, tagsLoading: true },
          compactHistory,
        },
      });
      mountedWrappers.push(wrapper);
      return wrapper;
    };
    const history = mountLoading(true, "ws-history-loading");
    await flushPromises();
    expect(history.find(".git-branches__loading").exists()).toBe(false);
    expect(history.find(".git-branches__body").exists()).toBe(true);
    const legacy = mountLoading(false, "ws-legacy-loading");
    await flushPromises();
    expect(legacy.find(".git-branches__loading").exists()).toBe(true);
  });

  test("History toolbar has no visible captions but keeps accessible names", async () => {
    mobileViewport.isNarrow.value = false;
    const picker = mount(GitBranchesTab, {
      props: {
        workspaceId: "ws-history-captions",
        snapshot: { dirty: false, branch: "main" },
        gitUi: { graph: { commits: [], head: "", refs: {} } },
        compactHistory: true,
      },
    });
    mountedWrappers.push(picker);
    await flushPromises();
    const text = picker.get(".git-history-picker").text();
    for (const caption of ["Find reference", "History range", "Find commits"]) {
      expect(text).not.toContain(caption);
    }
    expect(picker.find('[aria-label="Search history references"]').exists()).toBe(false);
    expect(picker.find('[aria-label="History reference"]').exists()).toBe(true);
    expect(picker.find('[aria-label="Search commits"]').exists()).toBe(true);
    expect(
      picker
        .get(".git-history-picker")
        .element.firstElementChild?.querySelector("[aria-label]")
        ?.getAttribute("aria-label"),
    ).toBe("Search commits");
    await picker.get('[aria-label="History reference"]').trigger("click");
    expect(menuItems().map((item) => item.textContent?.trim())).toContain("Select…");
    menuItems()
      .find((item) => item.textContent?.trim() === "Select…")!
      .click();
    await flushPromises();
    expect(document.body.querySelector('[aria-label="Search history references"]')).not.toBeNull();
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
    expect(picker.get('[aria-label="History reference"]').attributes("data-value")).toBe("origin/topic");
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
    const tabs = picker.findAll('[role="tablist"] button').map((b) => b.text());
    expect(tabs).toEqual(["Commits", "Diff"]);
    expect(picker.get('[role="tablist"] button').attributes("disabled")).toBeUndefined();
    expect(picker.find(".git-branches__commits-pane").exists()).toBe(true);
    expect(picker.find(".git-branches__mobile-back").exists()).toBe(false);
    expect(picker.find(".git-branches__diff-pane--mobile").exists()).toBe(false);
    expect(picker.findComponent(GitHistoryFilters).exists()).toBe(false);
    expect(picker.find(".git-history-picker__search input").exists()).toBe(true);
    await picker.get(".git-history-picker__toggle").trigger("click");
    expect(picker.findComponent(GitHistoryFilters).exists()).toBe(true);
    await picker.get(".git-history-picker__toggle").trigger("click");
    expect(picker.findComponent(GitHistoryFilters).exists()).toBe(false);
    expect(historySelection.ref).toBe("");
    expect(picker.find(".git-history-picker__toggle-count").exists()).toBe(false);
    historySelection.ref = "main";
    await flushPromises();
    expect(picker.find(".git-history-picker__toggle-count").exists()).toBe(false);
    historySelection.ref = "topic";
    await flushPromises();
    expect(picker.get(".git-history-picker__toggle-count").text()).toBe("1");
    historySelection.ref = "";
    picker.unmount();
    mobileViewport.isNarrow.value = false;
    mobileViewport.isMobile.value = false;
  });

  describe("History diff on a phone", () => {
    const innerWidth = window.innerWidth;
    const mountHistory = async (shortWide: boolean) => {
      Object.defineProperty(window, "innerWidth", { value: shortWide ? 667 : 360, configurable: true });
      window.matchMedia = ((query: string) => ({
        matches: shortWide && query.includes("max-height"),
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })) as unknown as typeof window.matchMedia;
      mobileViewport.isNarrow.value = true;
      mobileViewport.isMobile.value = true;
      fakeApi.fileCommitFiles = vi.fn().mockResolvedValue({ files: [{ path: "src/foo.ts", code: "M" }] });
      fakeApi.fileCommitDiff = vi.fn().mockResolvedValue({ original: "a", modified: "b" });
      const picker = mount(GitBranchesTab, {
        props: {
          workspaceId: "ws-phone-diff",
          activeRootPath: "/repo",
          snapshot: { dirty: false, branch: "main" },
          gitUi: {
            branchList: { current: "main", local: [{ name: "main", isCurrent: true }], remotes: [] },
            graph: {
              commits: [{ hash: "abc1234abc1234", shortHash: "abc1234", message: "History entry" }],
              head: "abc1234abc1234",
              refs: {},
            },
            selectedCommit: "abc1234abc1234",
          },
          compactHistory: true,
        },
        attachTo: document.body,
      });
      mountedWrappers.push(picker);
      await flushPromises();
      return picker;
    };
    const restoreViewport = () => {
      Object.defineProperty(window, "innerWidth", { value: innerWidth, configurable: true });
      mobileViewport.isNarrow.value = false;
      mobileViewport.isMobile.value = false;
      // @ts-expect-error test cleanup
      delete window.matchMedia;
    };

    test("opens a narrow diff inline, and an open file in landscape hides the commit list until the back button", async () => {
      const picker = await mountHistory(true);
      expect(picker.find(".git-branches__commits-pane").exists()).toBe(true);
      expect(picker.find(".git-branches__diff-pane--mobile").exists()).toBe(true);
      expect(picker.find(".mdp-stub").exists()).toBe(false);
      picker.findComponent(GitChangeTree).vm.$emit("select", "src/foo.ts");
      await flushPromises();
      expect(picker.find(".git-branches__commits-pane").exists()).toBe(false);
      expect(picker.get(".mdp-stub").exists()).toBe(true);
      expect(picker.findComponent({ name: "MonacoDiffPanel" }).props("initialInline")).toBe(true);
      await picker.get(".git-branches__mobile-back").trigger("click");
      expect(picker.find(".git-branches__commits-pane").exists()).toBe(true);
      expect(picker.find(".mdp-stub").exists()).toBe(false);
      restoreViewport();
    });

    test("portrait stacks the file and the diff and also starts inline", async () => {
      const picker = await mountHistory(false);
      await picker.findAll('[role="tablist"] button')[1].trigger("click");
      picker.findComponent(GitChangeTree).vm.$emit("select", "src/foo.ts");
      await flushPromises();
      expect(picker.findComponent({ name: "MonacoDiffPanel" }).props("initialInline")).toBe(true);
      restoreViewport();
    });
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
    await picker.get('[aria-label="History reference"]').trigger("click");
    expect(menuItems().map((item) => item.textContent?.trim())).toContain("★HEAD");
    expect(picker.findAll(".git-tree__placeholder").some((node) => node.text() === "No commits found.")).toBe(true);
    expect(picker.find('[data-testid="operation-card"]').exists()).toBe(true);
  });

  test("toggles a History favourite through the menu star and has no toolbar star button", async () => {
    mobileViewport.isNarrow.value = false;
    mobileViewport.isMobile.value = false;
    toggleGitHistoryFavorite.mockClear();
    const picker = mount(GitBranchesTab, {
      props: {
        workspaceId: "ws-favorite",
        activeRootPath: "/repo",
        profileId: "p1",
        snapshot: { dirty: false, branch: "main" },
        gitUi: {
          branchList: {
            current: "main",
            local: [{ name: "main", isCurrent: true }],
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
    mountedWrappers.push(picker);
    await flushPromises();
    expect(picker.find('[aria-label="Favorite history reference"]').exists()).toBe(false);
    expect(picker.find('[aria-label="Remove history favorite"]').exists()).toBe(false);
    await picker.get('[aria-label="History reference"]').trigger("click");
    menuItems()
      .find((item) => item.textContent?.trim().startsWith("Local"))!
      .click();
    await flushPromises();
    const row = menuItems().find((item) => item.textContent?.trim().replace(/^[★☆]/, "") === "main (working branch)")!;
    row.dispatchEvent(new MouseEvent("mouseenter"));
    await flushPromises();
    row.querySelector<HTMLElement>(".history-range-picker__star")!.click();
    await flushPromises();
    expect(toggleGitHistoryFavorite).toHaveBeenCalledWith("ws-favorite", "main", "/repo", "p1");
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
    await select.trigger("click");
    menuItems()
      .find((item) => item.textContent?.trim() === "Select…")!
      .click();
    await flushPromises();
    const optionTexts = () =>
      Array.from(document.body.querySelectorAll('[role="option"]')).map((option) => option.textContent || "");
    expect(optionTexts().some((text) => text.includes("feature/topic-399"))).toBe(true);
    const refSearch = document.body.querySelector<HTMLInputElement>('[aria-label="Search history references"]')!;
    refSearch.value = "feature/topic-399";
    refSearch.dispatchEvent(new Event("input"));
    await flushPromises();
    expect(optionTexts().filter((text) => text.includes("feature/topic-")).length).toBeLessThan(5);
    expect(optionTexts().some((text) => text.includes("feature/topic-399"))).toBe(true);
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
    await chooseHistoryRef(select, "origin/main");
    expect(historySelection.ref).toBe("origin/main");
    await flushPromises();
    await vi.advanceTimersByTimeAsync(300);
    await flushPromises();
    expect(picker.find('[aria-label="Search history references"]').exists()).toBe(false);
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
    await chooseHistoryRef(first.get('[aria-label="History reference"]'), "origin/release");
    expect(historySelection.ref).toBe("origin/release");
    first.unmount();

    const second = mount(GitBranchesTab, { props });
    mountedWrappers.push(second);
    await flushPromises();
    expect(second.get('[aria-label="History reference"]').attributes("data-value")).toBe("origin/release");
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

    await chooseHistoryRef(select, "HEAD");
    await flushPromises();
    expect(historySelection.ref).toBe("HEAD");
    expect(picker.get('[aria-label="History reference"]').text()).toContain("Branch: HEAD");
    await vi.advanceTimersByTimeAsync(300);
    expect(gitLoadGraph).toHaveBeenLastCalledWith("ws-head-scope", expect.objectContaining({ branch: "HEAD" }));

    await chooseHistoryRef(select, "All branches and tags");
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

describe("GitBranchesTab branch tree grouping", () => {
  test("full Branches reuses History rows while branch selection still filters its commit query", async () => {
    vi.useFakeTimers();
    const picker = mountTab({
      branchList: {
        current: "main",
        upstream: "origin/main",
        local: [
          { name: "main", isCurrent: true },
          { name: "topic", isCurrent: false },
        ],
        remotes: [],
        defaultBranch: "main",
        defaultRemote: "",
      },
      graph: { commits: [], head: "", refs: {} },
    });
    await flushPromises();
    const commitGraph = picker.findComponent({ name: "GitTreeGraph" });
    expect(commitGraph.props("historyLayout")).toBe(true);
    expect(commitGraph.props("history")).toBe(false);
    gitLoadGraph.mockClear();

    const localSection = picker
      .findAll(".branch-node--section > .branch-node__row")
      .find((row) => row.text().includes("Local"))!;
    await localSection.trigger("click");
    await picker
      .findAll(".branch-node--branch-local > .branch-node__row")
      .find((row) => row.text().includes("topic"))!
      .trigger("click");
    await vi.advanceTimersByTimeAsync(400);
    await flushPromises();

    expect(historySelection.ref).toBe("topic");
    expect(gitLoadGraph).toHaveBeenLastCalledWith("ws1", expect.objectContaining({ branch: "topic" }));
    picker.unmount();
    vi.useRealTimers();
  });

  test("pins default, configured base, and exact favorite refs without merging local and remote identities", async () => {
    historyPreferences = {
      favorites: ["people/alice/topic", "origin/people/alice/topic", "refs/tags/v1.0", "missing/ref"],
      recent: [],
    };
    const picker = mount(GitBranchesTab, {
      props: {
        workspaceId: "ws-important-refs",
        profileId: "profile-a",
        snapshot: { dirty: false, branch: "feature/work" },
        baseBranch: "origin/people/alice/topic",
        remoteNames: ["origin", "upstream"],
        gitUi: {
          branchList: {
            current: "feature/work",
            upstream: "origin/feature/work",
            local: [
              { name: "feature/work", isCurrent: true },
              { name: "main", isCurrent: false },
              { name: "people/alice/topic", isCurrent: false },
              { name: "release/base", isCurrent: false },
            ],
            remotes: [
              { name: "origin/main", remote: "origin", shortName: "main", isDefault: true },
              {
                name: "origin/people/alice/topic",
                remote: "origin",
                shortName: "people/alice/topic",
                isDefault: false,
              },
              { name: "upstream/main", remote: "upstream", shortName: "main", isDefault: true },
            ],
            defaultBranch: "main",
            defaultRemote: "origin",
          },
          graph: { commits: [], head: "", refs: {} },
          selectedCommit: "",
        },
        activeRootPath: "/repo/a",
      },
      attachTo: document.body,
    });
    mountedWrappers.push(picker);
    await flushPromises();

    const importantSection = picker
      .findAll(".branch-node--section")
      .find((section) => section.text().includes("Important"));
    expect(importantSection).toBeTruthy();
    const importantRows = Array.from(importantSection!.element.querySelectorAll(":scope > ul [role=treeitem]"));
    const rowLabels = importantRows.map((row) => row.querySelector(".branch-node__label")?.textContent?.trim());
    expect(rowLabels).toEqual(["origin/main", "origin/people/alice/topic", "people/alice/topic"]);
    expect(importantRows[0].textContent).toContain("default");
    expect(importantRows[1].textContent).toContain("base");
    expect(
      importantRows.filter((row) => row.querySelector(".branch-node__label")?.textContent?.trim() === "origin/main"),
    ).toHaveLength(1);
    const importantRemote = picker
      .findAll(".branch-node--branch-remote > .branch-node__row")
      .find((row) => row.text().includes("origin/people/alice/topic"));
    expect(importantRemote).toBeTruthy();
    await importantRemote!.trigger("dblclick");
    await flushPromises();
    expect(gitCheckoutRemoteBranch).toHaveBeenCalledWith(
      "ws-important-refs",
      "origin/people/alice/topic",
      "origin-people/alice/topic",
    );
    expect(
      picker
        .findAll(".branch-node--section > .branch-node__row")
        .find((row) => row.text().includes("Remote · origin"))
        ?.attributes("aria-expanded"),
    ).toBe("false");

    await picker.setProps({ baseBranch: "release/base" });
    await flushPromises();
    const dynamicBaseRow = picker.findAll(".branch-node__label").find((label) => label.text() === "release/base");
    expect(dynamicBaseRow).toBeTruthy();
    expect(dynamicBaseRow!.element.parentElement?.textContent).toContain("base");
    await picker.setProps({ baseBranch: "not/a-real-branch" });
    await flushPromises();
    expect(picker.findAll(".branch-node__label").map((label) => label.text())).not.toContain("not/a-real-branch");

    const remoteChip = picker.findAll(".git-branches__chips button").find((button) => button.text() === "Remote")!;
    await remoteChip.trigger("click");
    await flushPromises();
    const visibleImportantRows = picker
      .findAll(".branch-node--section")
      .find((section) => section.text().includes("Important"))!
      .findAll(":scope > ul [role=treeitem]");
    expect(visibleImportantRows.map((row) => row.find(".branch-node__label").text())).toEqual(["people/alice/topic"]);
    await picker
      .findAll(".git-branches__chips button")
      .find((button) => button.text() === "Remote")!
      .trigger("click");
    await flushPromises();

    await picker.get('input[aria-label="Filter branches and commits"]').setValue("alice");
    await flushPromises();
    expect(picker.findAll(".branch-node__label").map((label) => label.text())).toContain("origin/people/alice/topic");
    expect(
      picker
        .findAll(".branch-node--section > .branch-node__row")
        .find((row) => row.text().includes("Remote · origin"))
        ?.attributes("aria-expanded"),
    ).toBe("true");
    expect(
      picker
        .findAll(".branch-node--folder > .branch-node__row")
        .find((row) => row.text().includes("people"))
        ?.attributes("aria-expanded"),
    ).toBe("true");
    await picker.get('input[aria-label="Filter branches and commits"]').setValue("");
    await flushPromises();
    expect(
      picker
        .findAll(".branch-node--section > .branch-node__row")
        .find((row) => row.text().includes("Remote · origin"))
        ?.attributes("aria-expanded"),
    ).toBe("false");
  });

  test("scopes saved expansion across root and profile changes", async () => {
    const wrapper = mount(GitBranchesTab, {
      props: {
        workspaceId: "same-workspace",
        profileId: "profile-one",
        snapshot: { dirty: false, branch: "main" },
        activeRootPath: "/repo/one",
        gitUi: {
          branchList: { current: "main", local: [{ name: "main", isCurrent: true }], remotes: [] },
          graph: { commits: [], head: "", refs: {} },
        },
      },
    });
    mountedWrappers.push(wrapper);
    const branchTree = () => wrapper.findComponent({ name: "BranchTreePane" });
    const localRow = () =>
      branchTree()
        .findAll(".branch-node--section > .branch-node__row")
        .find((row) => row.text().includes("Local"))!;
    const keyOne = branchTree().props("stateKey") as string;
    const keyRootTwo = keyOne.replace("%2Frepo%2Fone", "%2Frepo%2Ftwo");
    const keyProfileTwo = keyOne.replace("profile-one", "profile-two");
    localStorage.removeItem(keyOne);
    localStorage.removeItem(keyRootTwo);
    localStorage.removeItem(keyProfileTwo);
    await localRow().trigger("click");
    expect(localRow().attributes("aria-expanded")).toBe("true");

    await wrapper.setProps({ activeRootPath: "/repo/two" });
    expect(branchTree().props("stateKey")).toContain("%2Frepo%2Ftwo");
    expect(localRow().attributes("aria-expanded")).toBe("false");
    await localRow().trigger("click");

    await wrapper.setProps({ activeRootPath: "/repo/one" });
    expect(localRow().attributes("aria-expanded")).toBe("true");
    await wrapper.setProps({ profileId: "profile-two" });
    expect(branchTree().props("stateKey")).toContain("profile-two");
    expect(localRow().attributes("aria-expanded")).toBe("false");
    await wrapper.setProps({ profileId: "profile-one" });
    expect(localRow().attributes("aria-expanded")).toBe("true");
    localStorage.removeItem(keyOne);
    localStorage.removeItem(keyRootTwo);
    localStorage.removeItem(keyProfileTwo);
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

  test("the commit search filters the graph and the header count, and range base reaches the graphs", async () => {
    const mk = (hash: string, subject: string) => ({
      hash,
      shortHash: hash.slice(0, 7),
      parents: [],
      subject,
      author: "Ada Example",
      relativeDate: "today",
      isoDate: "2026-10-21T00:00:00.000Z",
      refs: [],
    });
    const gitUi = reactive({
      branchList: { current: "main", local: [{ name: "main", isCurrent: true }], remotes: [] },
      graph: {
        commits: [
          mk("a1".repeat(10), "MSP-1 first"),
          mk("b2".repeat(10), "other work"),
          mk("c3".repeat(10), "MSP-3 third"),
        ],
        head: "a1".repeat(10),
        refs: {},
      },
    });
    const picker = mount(GitBranchesTab, {
      props: {
        workspaceId: "ws-commit-search-count",
        snapshot: { dirty: false, branch: "main" },
        gitUi,
        compactHistory: true,
        baseBranch: "origin/develop",
      },
    });
    mountedWrappers.push(picker);
    await flushPromises();
    const graph = () => picker.findComponent({ name: "GitTreeGraph" });
    expect(graph().props("commits")).toHaveLength(3);
    expect(picker.get(".git-branches__pane-count").text()).toBe("3 commits");
    expect(picker.get(".git-branches__pane-vs").text()).toBe("vs origin/develop");
    for (const g of picker.findAllComponents({ name: "GitTreeGraph" })) {
      expect(g.props("rangeBase")).toBe("origin/develop");
    }

    await picker.get('[aria-label="Search commits"]').setValue("MSP");
    await flushPromises();
    expect((graph().props("commits") as Array<{ subject: string }>).map((c) => c.subject)).toEqual([
      "MSP-1 first",
      "MSP-3 third",
    ]);
    expect(picker.get(".git-branches__pane-count").text()).toBe("2 of 3");
    for (const g of picker.findAllComponents({ name: "GitTreeGraph" })) {
      expect(g.props("flat")).toBe(true);
      expect(g.props("reachCommits")).toHaveLength(3);
    }

    await picker.get('[aria-label="Search commits"]').setValue("");
    await flushPromises();
    for (const g of picker.findAllComponents({ name: "GitTreeGraph" })) expect(g.props("flat")).toBe(false);
  });

  test("legacy Branches view passes no range base to the graphs", async () => {
    const picker = mount(GitBranchesTab, {
      props: {
        workspaceId: "ws-legacy-range-base",
        snapshot: { dirty: false, branch: "main" },
        gitUi: {
          branchList: { current: "main", local: [{ name: "main", isCurrent: true }], remotes: [] },
          graph: { commits: [], head: "", refs: {} },
        },
        compactHistory: false,
        baseBranch: "develop",
      },
    });
    mountedWrappers.push(picker);
    await flushPromises();
    for (const g of picker.findAllComponents({ name: "GitTreeGraph" })) expect(g.props("rangeBase")).toBe("");
  });
});

describe("GitBranchesTab history toolbar", () => {
  function mountMode(compactHistory: boolean, snapshot: Record<string, unknown> = {}) {
    const wrapper = mount(GitBranchesTab, {
      props: {
        workspaceId: "ws-toolbar",
        snapshot: { dirty: false, branch: "main", ...snapshot },
        gitUi: {
          branchList: { current: "main", local: [{ name: "main", isCurrent: true }], remotes: [] },
          graph: { commits: [], head: "", refs: {} },
        },
        activeRootPath: "/repo",
        compactHistory,
      },
      attachTo: document.body,
    });
    mountedWrappers.push(wrapper);
    return wrapper;
  }

  test("history mode has no branch-tree toolbar; legacy mode has it", () => {
    expect(mountMode(true).find(".git-branches__toolbar").exists()).toBe(false);
    expect(mountMode(false).find(".git-branches__toolbar").exists()).toBe(true);
  });

  test("filters live in the History toolbar, or in the commits pane in legacy mode", () => {
    const history = mountMode(true);
    expect(history.get(".git-history-picker").findComponent(GitHistoryFilters).exists()).toBe(true);
    expect(history.get(".git-branches__commits-pane").findComponent(GitHistoryFilters).exists()).toBe(false);
    const legacy = mountMode(false);
    expect(legacy.find(".git-history-picker").exists()).toBe(false);
    expect(legacy.get(".git-branches__commits-pane").findComponent(GitHistoryFilters).exists()).toBe(true);
  });

  test("Clear filters shows only with an active filter, search or ref and resets the search", async () => {
    const picker = mountMode(true);
    const clearButton = () => picker.findAll("button").find((b) => b.text() === "Clear filters");
    expect(clearButton()).toBeUndefined();
    await picker.get('input[aria-label="Search commits"]').setValue("fix");
    expect(clearButton()).toBeDefined();
    await clearButton()!.trigger("click");
    expect(historySelection.commitSearch).toBe("");
    expect(clearButton()).toBeUndefined();
    historySelection.ref = "main";
    await flushPromises();
    expect(clearButton()).toBeDefined();
    await clearButton()!.trigger("click");
    expect(historySelection.ref).toBe("");
    historySelection.topoOrder = true;
    await flushPromises();
    expect(clearButton()).toBeDefined();
    await clearButton()!.trigger("click");
    expect(historySelection.topoOrder).toBe(false);
  });

  test("neither History nor Branches adds a duplicate Refresh button to its toolbar", () => {
    expect(
      mountMode(true)
        .findAll("button")
        .some((b) => b.text() === "Refresh"),
    ).toBe(false);
    expect(
      mountMode(false)
        .findAll("button")
        .some((b) => b.text() === "Refresh"),
    ).toBe(false);
  });

  test("bumping the refresh token force-reloads branches and the graph", async () => {
    vi.useFakeTimers();
    const gitUi = reactive({
      branchList: { current: "main", local: [{ name: "main", isCurrent: true }], remotes: [] },
      graph: { commits: [], head: "", refs: {} },
      historyRefreshToken: 0,
    });
    const picker = mount(GitBranchesTab, {
      props: { workspaceId: "ws-token", snapshot: { dirty: false, branch: "main" }, gitUi, compactHistory: true },
    });
    mountedWrappers.push(picker);
    await vi.advanceTimersByTimeAsync(500);
    gitLoadGraph.mockClear();
    gitUi.historyRefreshToken = 1;
    await vi.advanceTimersByTimeAsync(500);
    expect(gitListBranches).toHaveBeenCalledWith("ws-token", { force: true });
    expect(gitLoadGraph).toHaveBeenCalledWith("ws-token", expect.objectContaining({ force: true }));
    vi.useRealTimers();
  });

  test("HEAD is a valid selection: no notice, selection kept, graph queried with HEAD", async () => {
    vi.useFakeTimers();
    Object.assign(historySelection, { ref: "HEAD", commitSearch: "" });
    const picker = mount(GitBranchesTab, {
      props: {
        workspaceId: "ws-head-valid",
        snapshot: { dirty: false, branch: "main" },
        gitUi: {
          branchList: { current: "main", local: [{ name: "main", isCurrent: true }], remotes: [] },
          graph: { commits: [], head: "", refs: {} },
          tags: [{ name: "v1" }],
          branchesLoading: false,
          tagsLoading: false,
        },
        compactHistory: true,
      },
    });
    mountedWrappers.push(picker);
    await vi.advanceTimersByTimeAsync(500);
    expect(picker.find(".git-history-picker__notice").exists()).toBe(false);
    expect(historySelection.ref).toBe("HEAD");
    expect(gitLoadGraph).toHaveBeenCalledWith("ws-head-valid", expect.objectContaining({ branch: "HEAD" }));
    vi.useRealTimers();
  });

  test("a missing-ref notice is a slim status line that can be dismissed", async () => {
    Object.assign(historySelection, { ref: "gone", commitSearch: "" });
    const gitUi = reactive({
      branchList: { current: "main", local: [{ name: "main", isCurrent: true }], remotes: [] },
      graph: { commits: [], head: "", refs: {} },
      tags: [] as Array<{ name: string }>,
      branchesLoading: false,
      tagsLoading: false,
    });
    const picker = mount(GitBranchesTab, {
      props: { workspaceId: "ws-notice", snapshot: { dirty: false, branch: "main" }, gitUi, compactHistory: true },
    });
    mountedWrappers.push(picker);
    gitUi.tags = [{ name: "t" }];
    await flushPromises();
    const notice = picker.get(".git-history-picker__notice");
    expect(notice.classes()).not.toContain("git-branches__placeholder");
    expect(notice.text()).toContain("no longer available");
    await notice.get('[aria-label="Dismiss notice"]').trigger("click");
    expect(picker.find(".git-history-picker__notice").exists()).toBe(false);
  });

  test("Last fetch sits in the status line, not the toolbar", () => {
    const picker = mountMode(true, { lastFetchAt: "2026-03-01T10:00:00Z" });
    expect(picker.get(".git-branches__pane-head").text()).toContain("Last fetch:");
    expect(picker.get(".git-history-picker").text()).not.toContain("Last fetch");
    expect(picker.get(".git-history-picker").text()).not.toContain("Working branch");
  });
});

describe("GitBranchesTab graph start", () => {
  test("starts the graph once on mount from the snapshot branch, without waiting for branches", async () => {
    mountTab({ branchList: undefined, graph: undefined, graphLoading: true });
    await flushPromises();
    expect(gitLoadGraph).toHaveBeenCalledTimes(1);
    expect(gitLoadGraph).toHaveBeenCalledWith("ws1", expect.objectContaining({ branch: "main" }));
    expect(historySelection.ref).toBe("main");
  });

  test("does not start twice when branches resolve afterwards", async () => {
    const wrapper = mountTab({ branchList: undefined, graph: undefined, graphLoading: true });
    await flushPromises();
    await wrapper.setProps({
      gitUi: { branchList: { current: "main", locals: [], remotes: [] }, graph: undefined, graphLoading: true },
    } as never);
    await flushPromises();
    expect(gitLoadGraph).toHaveBeenCalledTimes(1);
  });

  test("shows a spinner, not 'No commits found.', before the first graph request", async () => {
    const wrapper = mount(GitBranchesTab, {
      props: {
        workspaceId: "ws1",
        snapshot: { dirty: false },
        gitUi: { branchList: undefined, graph: undefined, selectedCommit: "" },
        activeRootPath: "/repo",
      },
      attachTo: document.body,
    });
    mountedWrappers.push(wrapper);
    expect(gitLoadGraph).not.toHaveBeenCalled();
    expect(wrapper.text()).not.toContain("No commits found.");
    expect(wrapper.find(".git-tree__placeholder .spinner").exists()).toBe(true);
  });

  test("shows the background-load spinner in the commits pane header", async () => {
    const wrapper = mountTab({ graphLoadingMore: true });
    await flushPromises();
    expect(wrapper.find('.git-branches__pane-more[title="Loading more commits…"]').exists()).toBe(true);
  });
});
