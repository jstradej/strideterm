import { describe, expect, test, beforeEach, afterEach, vi } from "vitest";
import { ref, type ComponentPublicInstance } from "vue";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";

const { monacoPayloads } = vi.hoisted(() => ({ monacoPayloads: vi.fn() }));

vi.mock("../../shared/MonacoDiffPanel.vue", async () => {
  const { defineComponent, h, watch } = await import("vue");
  return {
    __esModule: true,
    default: defineComponent({
      name: "MonacoDiffPanel",
      props: ["payload"],
      setup(props) {
        watch(
          () => props.payload,
          (payload) => monacoPayloads(payload),
          { immediate: true, deep: true },
        );
        return () => h("div", { class: "monaco-test-panel" });
      },
    }),
  };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fakeApi: Record<string, any> = {};
const refreshGit = vi.fn(async () => {});
const gitClearSelectedDiff = vi.fn();
const gitSelectDiff = vi.fn();
const openConflictDialog = vi.fn();
const gitSwitchTab = vi.fn();
const gitCommitAll = vi.fn(async () => {});
const showError = vi.fn();
let observedWidth = 390;

class ResizeObserverMock {
  constructor(private callback: ResizeObserverCallback) {}
  observe() {
    this.callback(
      [{ contentRect: { width: observedWidth } } as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    );
  }
  disconnect() {}
  unobserve() {}
}

vi.mock("../../../stores/app.js", () => ({
  useAppStore: () => ({ getApi: () => fakeApi }),
}));
vi.mock("../../../stores/git-ui.js", () => ({
  useGitUiStore: () => ({
    refreshGit,
    gitClearSelectedDiff,
    gitSelectDiff,
    openConflictDialog,
    gitSwitchTab,
    gitCreateBranch: vi.fn(),
    gitCommitAll,
  }),
}));
vi.mock("../../../stores/git-stash.js", () => ({
  useGitStashStore: () => ({
    get: () => ({ busyAction: "", includeUntrackedNext: false }),
    setIncludeUntrackedNext: vi.fn(),
    createStash: vi.fn(async () => ({ ok: true, needsInitialCommit: false })),
  }),
}));
vi.mock("../../../stores/notifications.js", () => ({
  useNotificationStore: () => ({ showError }),
}));
vi.mock("../../../composables/useIsNarrow.js", () => ({
  useIsNarrow: () => ({ isNarrow: ref(false), isMobile: ref(false) }),
}));

import GitChangesTab from "./GitChangesTab.vue";
import GitChangeTree from "./GitChangeTree.vue";

type GitChangesTabTestProps = {
  workspaceId: string;
  snapshot: Record<string, unknown>;
  gitUi: Record<string, unknown>;
  operation: Record<string, unknown>;
  activeRootPath?: string;
};
type GitChangesTabTestWrapper = VueWrapper<
  InstanceType<typeof GitChangesTab>,
  ComponentPublicInstance<GitChangesTabTestProps>
>;

const mountedWrappers: GitChangesTabTestWrapper[] = [];

function mountTab(overrides: Record<string, unknown> = {}): GitChangesTabTestWrapper {
  const wrapper = mount(GitChangesTab, {
    props: {
      workspaceId: "ws1",
      snapshot: {
        dirty: false,
        staged: [],
        unstaged: [
          { path: "a.txt", code: "M", scope: "unstaged" },
          { path: "b.txt", code: "M", scope: "unstaged" },
        ],
        untracked: [],
        diffStat: null,
      },
      gitUi: {},
      operation: { inProgress: false, conflicts: [] },
      activeRootPath: "/repo",
      ...overrides,
    },
    attachTo: document.body,
  }) as unknown as GitChangesTabTestWrapper;
  mountedWrappers.push(wrapper);
  return wrapper;
}

beforeEach(() => {
  observedWidth = 390;
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  setActivePinia(createPinia());
  for (const k of Object.keys(fakeApi)) delete fakeApi[k];
  fakeApi.fileDelete = vi.fn(async () => ({ ok: true }));
  fakeApi.fileGitIgnore = vi.fn(async () => ({ ok: true }));
  refreshGit.mockClear();
  gitClearSelectedDiff.mockClear();
  gitSelectDiff.mockReset();
  openConflictDialog.mockReset();
  gitSwitchTab.mockReset();
  gitCommitAll.mockReset();
  gitCommitAll.mockResolvedValue(undefined);
  showError.mockClear();
  monacoPayloads.mockReset();
  document.body.innerHTML = "";
});

// Unmount after every test to stop the component's document click/keydown
// listeners from firing (and touching a torn-down mock) in later tests.
afterEach(async () => {
  for (const w of mountedWrappers) w.unmount();
  mountedWrappers.length = 0;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  await flushPromises();
});

describe("GitChangesTab", () => {
  test("opens a file diff from the mobile list and returns to the list", async () => {
    const wrapper = mountTab({
      snapshot: {
        dirty: true,
        branch: "main",
        staged: [],
        unstaged: [{ path: "src/a.ts", code: "M", scope: "unstaged" }],
        untracked: [],
        diffStat: null,
      },
    });
    await flushPromises();

    expect(wrapper.attributes("data-mode")).toBe("list");
    wrapper.findComponent(GitChangeTree).vm.$emit("select", "src/a.ts", "unstaged");
    await wrapper.setProps({ gitUi: { selectedDiff: { path: "src/a.ts", scope: "unstaged" } } });
    await flushPromises();
    expect(gitSelectDiff).toHaveBeenCalledWith("ws1", "src/a.ts", "unstaged");
    expect(wrapper.attributes("data-mode")).toBe("diff");

    await wrapper.get(".git-changes__mobile-head button").trigger("click");
    expect(wrapper.attributes("data-mode")).toBe("list");
  });

  test("branch header opens the Branches tab", async () => {
    const wrapper = mountTab({ snapshot: { dirty: false, branch: "main", staged: [], unstaged: [], untracked: [] } });
    await flushPromises();

    await wrapper.get(".git-changes__mobile-branch").trigger("click");
    expect(gitSwitchTab).toHaveBeenCalledWith("ws1", "branches");
    expect(gitCommitAll).not.toHaveBeenCalled();
  });

  test("replaces actual NUL-byte diff content with the binary notice before rendering Monaco", async () => {
    fakeApi.fileGitDiff = vi.fn(async () => ({
      ok: true,
      leftContent: "source\0binary-data",
      rightContent: "changed\0binary-data",
      leftLabel: "HEAD",
      rightLabel: "Working tree",
    }));
    mountTab({
      gitUi: { selectedDiff: { path: "image.bin", scope: "unstaged" } },
      snapshot: {
        dirty: true,
        staged: [],
        unstaged: [{ path: "image.bin", code: "M", scope: "unstaged" }],
        untracked: [],
        diffStat: null,
      },
    });
    await flushPromises();

    expect(fakeApi.fileGitDiff).toHaveBeenCalledWith({
      rootPath: "/repo",
      relativePath: "image.bin",
      source: "head",
      revisionRef: "",
    });
    expect(
      monacoPayloads.mock.calls.some(
        ([payload]) =>
          payload?.ok === false &&
          payload.leftContent === "" &&
          payload.rightContent === "" &&
          payload.leftError === "Binary file; text diff is unavailable.",
      ),
    ).toBe(true);
    expect(monacoPayloads.mock.calls.flat().some((payload) => JSON.stringify(payload).includes("\u0000"))).toBe(false);
  });

  test("next file navigation skips a duplicate staged/unstaged path", async () => {
    const wrapper = mountTab({
      snapshot: {
        dirty: true,
        staged: [{ path: "same.ts", code: "M" }],
        unstaged: [
          { path: "same.ts", code: "M" },
          { path: "next.ts", code: "M" },
        ],
        untracked: [],
        diffStat: null,
      },
      gitUi: {},
    });
    await flushPromises();
    await wrapper.setProps({ gitUi: { selectedDiff: { path: "same.ts", scope: "staged" } } });
    await flushPromises();

    await wrapper.get('[aria-label="Next file"]').trigger("click");
    expect(gitSelectDiff).toHaveBeenLastCalledWith("ws1", "next.ts", "unstaged");
  });

  test("opens conflicted files in Conflict Center instead of selecting a diff", async () => {
    const wrapper = mountTab({
      snapshot: {
        dirty: true,
        staged: [],
        unstaged: [{ path: "conflict.txt", code: "UU", scope: "unstaged" }],
        untracked: [],
        diffStat: null,
      },
      operation: { inProgress: false, conflicts: ["conflict.txt"] },
    });
    await flushPromises();

    wrapper.findComponent(GitChangeTree).vm.$emit("select", "conflict.txt", "unstaged");
    expect(openConflictDialog).toHaveBeenCalledWith("ws1", "/repo");
    expect(gitSwitchTab).toHaveBeenCalledWith("ws1", "conflicts");
    expect(gitSelectDiff).not.toHaveBeenCalled();
  });

  test("the tab takes no review, read-only or writable input, and commits whatever the checkout holds", async () => {
    const declared = Object.keys((GitChangesTab as unknown as { props?: Record<string, unknown> }).props || {});
    expect(declared.filter((name) => /review|read-?only|writable|locked/i.test(name))).toEqual([]);

    const wrapper = mountTab({
      snapshot: {
        dirty: true,
        staged: [],
        unstaged: [{ path: "review.txt", code: "M", scope: "unstaged" }],
        untracked: [],
        diffStat: null,
      },
    });
    await flushPromises();
    wrapper.findComponent(GitChangeTree).vm.$emit("toggle-select", "review.txt");
    await wrapper.get(".git-changes__mobile-dock .button").trigger("click");
    await wrapper.get(".git-changes__commit-screen textarea").setValue("address review");
    await wrapper.findAll(".git-changes__mobile-dock .button").at(-1)!.trigger("click");
    await flushPromises();

    expect(gitCommitAll).toHaveBeenCalledWith("ws1", "address review", ["review.txt"], undefined);
  });

  test("commits a selected rename once with its old path, even when the path has two scopes", async () => {
    const wrapper = mountTab({
      snapshot: {
        dirty: true,
        staged: [{ path: "new-name.ts", previousPath: "old-name.ts", code: "R", stagedStatus: "R" }],
        unstaged: [{ path: "new-name.ts", previousPath: "old-name.ts", code: "M", unstagedStatus: "M" }],
        untracked: [],
        diffStat: null,
      },
    });
    await flushPromises();
    wrapper.findComponent(GitChangeTree).vm.$emit("toggle-select", "new-name.ts");
    await wrapper.get(".git-changes__mobile-dock .button").trigger("click");
    await wrapper.get(".git-changes__commit-screen textarea").setValue("rename module");
    await wrapper.findAll(".git-changes__mobile-dock .button").at(-1)!.trigger("click");
    await flushPromises();

    expect(gitCommitAll).toHaveBeenCalledWith("ws1", "rename module", ["new-name.ts"], ["old-name.ts"]);
  });

  test("keeps mobile commit text and screen after a failed result, then clears on success", async () => {
    let resolveCommit: (() => void) | undefined;
    gitCommitAll.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveCommit = resolve;
        }),
    );
    const wrapper = mountTab({
      snapshot: {
        dirty: true,
        staged: [],
        unstaged: [{ path: "a.txt", code: "M", scope: "unstaged" }],
        untracked: [],
        diffStat: null,
      },
      gitUi: { lastResult: { ok: false } },
    });
    await flushPromises();
    await wrapper.get(".git-changes__mobile-dock .button").trigger("click");
    await wrapper.get(".git-changes__commit-screen textarea").setValue("keep this message");
    await wrapper.findAll(".git-changes__mobile-dock .button").at(-1)!.trigger("click");
    resolveCommit?.();
    await flushPromises();

    expect(wrapper.attributes("data-mode")).toBe("commit");
    expect((wrapper.get(".git-changes__commit-screen textarea").element as HTMLTextAreaElement).value).toBe(
      "keep this message",
    );

    await wrapper.setProps({ gitUi: { lastResult: { ok: true } } });
    gitCommitAll.mockResolvedValueOnce(undefined);
    await wrapper.findAll(".git-changes__mobile-dock .button").at(-1)!.trigger("click");
    await flushPromises();
    expect(wrapper.attributes("data-mode")).toBe("list");
    await wrapper.get(".git-changes__mobile-dock .button").trigger("click");
    expect((wrapper.get(".git-changes__commit-screen textarea").element as HTMLTextAreaElement).value).toBe("");
  });

  test("clears path selection and commit draft when the active root changes", async () => {
    const wrapper = mountTab({
      snapshot: {
        dirty: true,
        staged: [],
        unstaged: [{ path: "a.txt", code: "M", scope: "unstaged" }],
        untracked: [],
        diffStat: null,
      },
    });
    await flushPromises();
    wrapper.findComponent(GitChangeTree).vm.$emit("toggle-select", "a.txt");
    await wrapper.get(".git-changes__mobile-dock .button").trigger("click");
    await wrapper.get(".git-changes__commit-screen textarea").setValue("draft");

    await wrapper.setProps({ activeRootPath: "/other-repo" });
    await flushPromises();
    expect(wrapper.attributes("data-mode")).toBe("list");
    expect(wrapper.text()).not.toContain("1 selected");
    await wrapper.get(".git-changes__mobile-dock .button").trigger("click");
    expect((wrapper.get(".git-changes__commit-screen textarea").element as HTMLTextAreaElement).value).toBe("");
  });

  describe("confirmDelete — batch delete", () => {
    test("one failing delete does not abort the rest of the batch, and fires a single error notification", async () => {
      const wrapper = mountTab();
      await flushPromises();

      // Select both files, then right-click one of them — since it's part of
      // a multi-selection, the context menu targets the whole batch.
      const tree = wrapper.findComponent(GitChangeTree);
      tree.vm.$emit("toggle-select", "a.txt");
      tree.vm.$emit("toggle-select", "b.txt");
      await flushPromises();
      tree.vm.$emit("context-menu", { path: "a.txt", name: "a.txt", kind: "file", x: 10, y: 10 });
      await flushPromises();

      // a.txt is locked/permission-denied; b.txt should still go through.
      fakeApi.fileDelete = vi.fn(async ({ relativePath }: { relativePath: string }) => {
        if (relativePath === "a.txt") throw new Error("EBUSY: resource locked");
        return { ok: true };
      });

      const deleteMenuBtn = document.body.querySelector(".context-menu__item--danger") as HTMLButtonElement;
      expect(deleteMenuBtn).toBeTruthy();
      deleteMenuBtn.click();
      await flushPromises();

      const confirmBtn = document.body.querySelector(
        ".fm-dialog__actions .button:not(.button--ghost)",
      ) as HTMLButtonElement;
      expect(confirmBtn).toBeTruthy();
      confirmBtn.click();
      await flushPromises();

      // Both deletes were attempted — the failing one didn't abort the loop.
      expect(fakeApi.fileDelete).toHaveBeenCalledWith({ rootPath: "/repo", relativePath: "a.txt" });
      expect(fakeApi.fileDelete).toHaveBeenCalledWith({ rootPath: "/repo", relativePath: "b.txt" });

      // One aggregate error notification, not one per failed file.
      expect(showError).toHaveBeenCalledTimes(1);
      expect(showError.mock.calls[0][0]).toBe("Some files could not be deleted");
      expect(showError.mock.calls[0][1]).toContain("1 of 2");

      // The batch still refreshes afterward.
      expect(refreshGit).toHaveBeenCalledWith("ws1");
    });

    test("all deletes succeeding does not fire an error notification", async () => {
      const wrapper = mountTab();
      await flushPromises();

      const tree = wrapper.findComponent(GitChangeTree);
      tree.vm.$emit("toggle-select", "a.txt");
      tree.vm.$emit("toggle-select", "b.txt");
      await flushPromises();
      tree.vm.$emit("context-menu", { path: "a.txt", name: "a.txt", kind: "file", x: 10, y: 10 });
      await flushPromises();

      const deleteMenuBtn = document.body.querySelector(".context-menu__item--danger") as HTMLButtonElement;
      deleteMenuBtn.click();
      await flushPromises();
      const confirmBtn = document.body.querySelector(
        ".fm-dialog__actions .button:not(.button--ghost)",
      ) as HTMLButtonElement;
      confirmBtn.click();
      await flushPromises();

      expect(fakeApi.fileDelete).toHaveBeenCalledTimes(2);
      expect(showError).not.toHaveBeenCalled();
      expect(refreshGit).toHaveBeenCalledWith("ws1");
    });
  });

  describe("onMenuIgnore", () => {
    test("a failing gitignore update fires an error notification instead of throwing silently", async () => {
      const wrapper = mountTab();
      await flushPromises();

      const tree = wrapper.findComponent(GitChangeTree);
      tree.vm.$emit("context-menu", { path: "a.txt", name: "a.txt", kind: "file", x: 10, y: 10 });
      await flushPromises();

      fakeApi.fileGitIgnore = vi.fn(async () => {
        throw new Error("EACCES: permission denied");
      });

      const ignoreBtn = document.body.querySelector(
        ".context-menu__item:not(.context-menu__item--danger)",
      ) as HTMLButtonElement;
      expect(ignoreBtn).toBeTruthy();
      ignoreBtn.click();
      await flushPromises();

      expect(fakeApi.fileGitIgnore).toHaveBeenCalled();
      expect(showError).toHaveBeenCalledTimes(1);
      expect(showError.mock.calls[0][0]).toBe("Failed to update .gitignore");
      expect(refreshGit).not.toHaveBeenCalled();
    });
  });
});
