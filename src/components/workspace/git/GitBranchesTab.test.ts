import { describe, expect, test, beforeEach, afterEach, vi } from "vitest";
import { ref } from "vue";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fakeApi: Record<string, any> = {};
const showError = vi.fn();
const addEvent = vi.fn();
const openDialog = vi.fn();
const closeDialog = vi.fn();
const azureCreatePullRequest = vi.fn();

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
    gitLoadGraph: vi.fn(),
    gitFetchBaseComparison: vi.fn(),
    gitSelectCommit: vi.fn(),
    gitCreateBranch: vi.fn(),
    gitCheckoutBranch: vi.fn(),
    gitCheckoutRemoteBranch: vi.fn(),
    gitRenameBranch: vi.fn(),
    gitDeleteBranch: vi.fn(),
    gitDeleteRemoteBranch: vi.fn(),
    gitMergeBase: vi.fn(),
    gitRebaseBase: vi.fn(),
    gitCherryPick: vi.fn(),
    gitSquashCommits: vi.fn(),
    gitCreateTag: vi.fn(),
    gitRemoveWorktree: vi.fn(),
    confirmRemoveWorktreeDeleteBranch: vi.fn(),
    azureListRemoteBranches: vi.fn(),
    azureCreatePullRequest,
  }),
}));
vi.mock("../../../stores/notifications.js", () => ({
  useNotificationStore: () => ({ showError, addEvent }),
}));
vi.mock("../../../composables/useIsNarrow.js", () => ({
  useIsNarrow: () => ({ isNarrow: ref(false), isMobile: ref(false) }),
}));

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
  document.body.innerHTML = "";
});

afterEach(async () => {
  for (const w of mountedWrappers) w.unmount();
  mountedWrappers.length = 0;
  document.body.innerHTML = "";
  await flushPromises();
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
    expect(showError.mock.calls[0][1]).toContain("clipboard blocked");
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
