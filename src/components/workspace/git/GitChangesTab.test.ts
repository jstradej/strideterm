import { describe, expect, test, beforeEach, afterEach, vi } from "vitest";
import { ref } from "vue";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fakeApi: Record<string, any> = {};
const refreshGit = vi.fn(async () => {});
const gitClearSelectedDiff = vi.fn();
const showError = vi.fn();

vi.mock("../../../stores/app.js", () => ({
  useAppStore: () => ({ getApi: () => fakeApi }),
}));
vi.mock("../../../stores/git-ui.js", () => ({
  useGitUiStore: () => ({
    refreshGit,
    gitClearSelectedDiff,
    gitSelectDiff: vi.fn(),
    openConflictDialog: vi.fn(),
    gitSwitchTab: vi.fn(),
    gitCreateBranch: vi.fn(),
    gitCommitAll: vi.fn(),
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mountedWrappers: VueWrapper<any>[] = [];

function mountTab() {
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
    },
    attachTo: document.body,
  });
  mountedWrappers.push(wrapper);
  return wrapper;
}

beforeEach(() => {
  setActivePinia(createPinia());
  for (const k of Object.keys(fakeApi)) delete fakeApi[k];
  fakeApi.fileDelete = vi.fn(async () => ({ ok: true }));
  fakeApi.fileGitIgnore = vi.fn(async () => ({ ok: true }));
  refreshGit.mockClear();
  gitClearSelectedDiff.mockClear();
  showError.mockClear();
  document.body.innerHTML = "";
});

// Unmount after every test to stop the component's document click/keydown
// listeners from firing (and touching a torn-down mock) in later tests.
afterEach(async () => {
  for (const w of mountedWrappers) w.unmount();
  mountedWrappers.length = 0;
  document.body.innerHTML = "";
  await flushPromises();
});

describe("GitChangesTab", () => {
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
