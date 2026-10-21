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
    getGitHistorySelection: (_workspaceId: string, _rootPath: string, _profileId: string) => historySelection,
    setGitHistorySelection: (
      _workspaceId: string,
      _rootPath: string,
      _profileId: string,
      patch: Record<string, string>,
    ) => {
      Object.assign(historySelection, patch);
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
const historySelection = reactive({ ref: "", commitSearch: "" });
vi.mock("../../../stores/notifications.js", () => ({
  useNotificationStore: () => ({ showError, addEvent }),
}));
vi.mock("../../../composables/useIsNarrow.js", () => ({
  useIsNarrow: () => mobileViewport,
}));

const mobileViewport = { isNarrow: ref(false), isMobile: ref(false) };

import GitBranchesTab from "./GitBranchesTab.vue";
import GitChangeTree from "./GitChangeTree.vue";

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
  document.body.innerHTML = "";
});

afterEach(async () => {
  for (const w of mountedWrappers) w.unmount();
  mountedWrappers.length = 0;
  document.body.innerHTML = "";
  await flushPromises();
  Object.assign(historySelection, { ref: "", commitSearch: "" });
});

describe("GitBranchesTab compact history picker", () => {
  test("surfaces tag read failures in History", async () => {
    const picker = mountTab({ tagsError: "Could not load tags." });
    expect(picker.get('[role="alert"]').text()).toBe("Could not load tags.");
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
        },
        compactHistory: true,
      },
    });
    await flushPromises();
    expect(picker.get('[aria-label="History reference"]').text()).toContain("HEAD · detached");
    expect(picker.findAll(".git-history-picker__current")[0].text()).toContain("Working branch: Detached HEAD");
    expect(picker.findAll(".git-tree__placeholder").some((node) => node.text() === "No commits found.")).toBe(true);
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
