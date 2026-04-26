import { describe, expect, test, beforeEach } from "vitest";
import { shallowMount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import GitPane from "./GitPane.vue";
import { useAppStore } from "../../stores/app.js";
import { useGitUiStore } from "../../stores/git-ui.js";
import type { StatePayload, GitSnapshot } from "../../../electron/shared/types/state.js";

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
    operationState: { kind: "idle", inProgress: false, conflicts: [], label: "", details: "", canContinue: false, canAbort: false },
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
      staged: { name: "staged", files: [], diffStat: { files: 0, insertions: 0, deletions: 0, renames: 0, deletes: 0 } },
      unstaged: { name: "unstaged", files: [], diffStat: { files: 0, insertions: 0, deletions: 0, renames: 0, deletes: 0 } },
      untracked: { name: "untracked", files: [], diffStat: { files: 0, insertions: 0, deletions: 0, renames: 0, deletes: 0 } },
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mountPane(workspaceId: string, workspaces: any[] = []) {
  const appStore = useAppStore();
  appStore.payload = {
    appState: {
      workspaces,
      activeProfileId: "default",
      profiles: [{ id: "default", name: "Default", color: "#ffa424", workspaceIds: [] }],
    },
    git: {
      workspaces: {
        [workspaceId]: makeSnapshot(),
      },
    },
  } as unknown as StatePayload;
  return shallowMount(GitPane, {
    props: { workspaceId },
  });
}

beforeEach(() => {
  setActivePinia(createPinia());
});

describe("GitPane repo picker", () => {
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

  test("repo picker is hidden for review workspaces even with gitRoots", () => {
    const ws = buildWorkspace({
      id: "ws-review",
      gitRoots: ["/ms/api", "/ms/web"],
      review: { prKey: "pr-123", provider: "azure-devops" },
    });
    const wrapper = mountPane("ws-review", [ws]);
    expect(wrapper.find(".git-repo-picker").exists()).toBe(false);
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
