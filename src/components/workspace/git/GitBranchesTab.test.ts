import { describe, expect, test, beforeEach, afterEach, vi } from "vitest";
import { ref } from "vue";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fakeApi: Record<string, any> = {};
const showError = vi.fn();

vi.mock("../../../stores/app.js", () => ({
  useAppStore: () => ({
    getApi: () => fakeApi,
    closeDialog: vi.fn(),
    openDialog: vi.fn(),
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
    azureCreatePullRequest: vi.fn(),
  }),
}));
vi.mock("../../../stores/notifications.js", () => ({
  useNotificationStore: () => ({ showError }),
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
