import { describe, expect, test, beforeEach, vi } from "vitest";
import { shallowMount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import GitPane from "./GitPane.vue";
import GitStrategySplitButton from "./git/GitStrategySplitButton.vue";
import { useAppStore } from "../../stores/app.js";
import { useGitUiStore } from "../../stores/git-ui.js";
import type { StatePayload, GitSnapshot } from "../../../electron/shared/types/state.js";

/**
 * The Git toolbar's Pull button.
 *
 * It is a split button because `git pull --ff-only` cannot succeed on a
 * DIVERGED branch, and Pull was enabled in exactly that state — clickable and
 * doomed. The main click therefore routes by repo state, and the label names
 * where it is going so the user never has to work it out from the counts.
 *
 * shallowMount stubs the split button, which is what we want here: these tests
 * pin GitPane's decisions (label, strategy, routing, primary) and not the
 * button's internals, which GitStrategySplitButton.test.ts owns.
 */

/** The SFC's prop types don't survive findComponent here, so read them as a
 *  plain record rather than scattering casts through every assertion. */
function propsOf(button: { props: () => unknown }): Record<string, unknown> {
  return button.props() as Record<string, unknown>;
}

function buildWorkspace() {
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
  };
}

function makeSnapshot(overrides: Record<string, unknown> = {}): GitSnapshot {
  const rootPath = "/ms/api";
  return {
    available: true,
    branch: "develop",
    isMainWorktree: true,
    isWorktree: false,
    dirty: false,
    dirtyCount: 0,
    aheadCount: 0,
    behindCount: 0,
    staged: [],
    unstaged: [],
    untracked: [],
    remotes: { origin: "https://example.invalid/repo.git" },
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
    upstream: "origin/develop",
    commitCount: 5,
    stashCount: 0,
    lazygit: { available: false, backend: null, error: "" },
    rootPath,
    workspaceId: "ws-test",
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
    ...overrides,
  } as unknown as GitSnapshot;
}

function mountPane(
  snapshotOverrides: Record<string, unknown> = {},
  { updateStrategy = "rebase", showAllActions = false }: { updateStrategy?: string; showAllActions?: boolean } = {},
) {
  const appStore = useAppStore();
  appStore.payload = {
    appState: {
      workspaces: [buildWorkspace()],
      activeProfileId: "default",
      profiles: [{ id: "default", name: "Default", color: "#ffa424", workspaceIds: [] }],
      windowSlots: [{ id: "win-test", profileId: "default", activeWorkspaceId: "ws-test" }],
      settings: { git: { ui: { showAllActions, updateStrategy } } },
    },
    git: {
      workspaces: { "ws-test": makeSnapshot(snapshotOverrides) },
      connections: [],
    },
  } as unknown as StatePayload;
  const wrapper = shallowMount(GitPane, { props: { workspaceId: "ws-test" } });
  const pullButton = () => wrapper.findComponent(GitStrategySplitButton);
  return { wrapper, appStore, pullButton, pullProps: () => propsOf(pullButton()) };
}

const DIVERGED = { aheadCount: 1, behindCount: 2 };

beforeEach(() => {
  setActivePinia(createPinia());
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).strideterm = { startupFlags: { windowId: "win-test" } };
});

describe("Pull button label names what the click will do", () => {
  test("behind and clean → plain Pull", () => {
    expect(mountPane({ behindCount: 2 }).pullProps().mainLabel).toBe("Pull");
  });

  test("behind and dirty → Pull (stash & restore)", () => {
    expect(mountPane({ behindCount: 2, dirty: true, dirtyCount: 1 }).pullProps().mainLabel).toBe(
      "Pull (stash & restore)",
    );
  });

  test("diverged → names the persisted strategy, not a Pull that would fail", () => {
    expect(mountPane(DIVERGED).pullProps().mainLabel).toBe("Pull (rebase)");
    expect(mountPane(DIVERGED, { updateStrategy: "merge" }).pullProps().mainLabel).toBe("Pull (merge)");
  });

  test("busy wins over every other label", async () => {
    const { wrapper, pullProps } = mountPane(DIVERGED);
    const gitUi = useGitUiStore();
    // setActiveRoot goes through ensure(), which is what actually creates the
    // per-workspace entry — get() hands back a throwaway `{}` until it exists,
    // so mutating its result before that is lost.
    gitUi.setActiveRoot("ws-test", "/ms/api");
    gitUi.get("ws-test").busyAction = "pull";
    await wrapper.vm.$nextTick();

    expect(pullProps().mainLabel).toBe("Pulling…");
    expect(pullProps().busy).toBe(true);
  });

  test("the diverged tooltip says a fast-forward is impossible and how to switch", () => {
    const title = String(mountPane(DIVERGED).pullProps().mainTitle);
    expect(title).toContain("Diverged (1 ahead, 2 behind)");
    expect(title).toContain("fast-forward is impossible");
    expect(title).toContain("rewrites their hashes");
    expect(title).toContain("caret to merge instead");
  });

  test("the merge tooltip names the merge commit instead", () => {
    const title = String(mountPane(DIVERGED, { updateStrategy: "merge" }).pullProps().mainTitle);
    expect(title).toContain("adding a merge commit");
    expect(title).toContain("caret to rebase instead");
  });
});

describe("Pull button routing", () => {
  test("merely behind → the unchanged fast-forward pull", async () => {
    const { pullButton } = mountPane({ behindCount: 2 });
    const gitUi = useGitUiStore();
    const pull = vi.spyOn(gitUi, "gitPull").mockResolvedValue(undefined);
    const rebase = vi.spyOn(gitUi, "gitRebaseBase").mockResolvedValue(undefined);

    await pullButton().vm.$emit("run");

    expect(pull).toHaveBeenCalledWith("ws-test", { stashDirty: false });
    expect(rebase).not.toHaveBeenCalled();
  });

  test("behind and dirty → fast-forward pull in stash mode", async () => {
    const { pullButton } = mountPane({ behindCount: 2, dirty: true, dirtyCount: 1 });
    const pull = vi.spyOn(useGitUiStore(), "gitPull").mockResolvedValue(undefined);

    await pullButton().vm.$emit("run");

    expect(pull).toHaveBeenCalledWith("ws-test", { stashDirty: true });
  });

  test("diverged + rebase → rebase onto the UPSTREAM, fetching first", async () => {
    // The upstream, not the base branch: the toolbar integrates the branch's
    // own remote counterpart. The card is the one that targets the base.
    const { pullButton } = mountPane(DIVERGED);
    const gitUi = useGitUiStore();
    const rebase = vi.spyOn(gitUi, "gitRebaseBase").mockResolvedValue(undefined);
    const pull = vi.spyOn(gitUi, "gitPull").mockResolvedValue(undefined);

    await pullButton().vm.$emit("run");

    expect(rebase).toHaveBeenCalledWith("ws-test", "origin/develop", { fetchFirst: true });
    // The whole point of the fix: --ff-only is never issued in this state.
    expect(pull).not.toHaveBeenCalled();
  });

  test("diverged + merge → merge the upstream in, fetching first", async () => {
    const { pullButton } = mountPane(DIVERGED, { updateStrategy: "merge" });
    const gitUi = useGitUiStore();
    const merge = vi.spyOn(gitUi, "gitMergeBase").mockResolvedValue(undefined);
    const pull = vi.spyOn(gitUi, "gitPull").mockResolvedValue(undefined);

    await pullButton().vm.$emit("run");

    expect(merge).toHaveBeenCalledWith("ws-test", "origin/develop", { fetchFirst: true });
    expect(pull).not.toHaveBeenCalled();
  });

  test("ahead and behind but WITHOUT an upstream is not diverged — it fast-forwards", async () => {
    // `isDiverged` requires an upstream, so "diverged with no upstream" is not
    // a representable state and neither the routing nor primaryAction guards
    // against it. This pins that premise: if isDiverged ever stops requiring
    // an upstream, onPullClick would hand gitRebaseBase an empty ref, and this
    // test fires first.
    const { pullButton, pullProps } = mountPane({ ...DIVERGED, upstream: "" }, { showAllActions: true });
    const gitUi = useGitUiStore();
    const rebase = vi.spyOn(gitUi, "gitRebaseBase").mockResolvedValue(undefined);
    const pull = vi.spyOn(gitUi, "gitPull").mockResolvedValue(undefined);

    expect(pullProps().mainLabel).toBe("Pull");
    await pullButton().vm.$emit("run");

    expect(rebase).not.toHaveBeenCalled();
    expect(pull).toHaveBeenCalledWith("ws-test", { stashDirty: false });
  });

  test("ahead only is not diverged and offers no strategy", () => {
    const { pullProps } = mountPane({ aheadCount: 3, behindCount: 0 });
    expect(pullProps().mainLabel).toBe("Pull");
    expect(pullProps().disabled).toBe(true);
  });
});

describe("Pull button strategy persistence", () => {
  test("picking a strategy writes it to settings, preserving the git.ui sibling", async () => {
    const { pullButton, appStore } = mountPane(DIVERGED);
    const update = vi.spyOn(appStore, "updateSettings").mockResolvedValue(undefined);

    await pullButton().vm.$emit("update:strategy", "merge");

    // Only the one key — `updateSettings` deep-merges `git.ui`, so sending a
    // partial patch must not carry (and thus reset) showAllActions.
    expect(update).toHaveBeenCalledWith({ git: { ui: { updateStrategy: "merge" } } });
  });

  test("the offered strategy comes from settings, not component state", () => {
    expect(mountPane(DIVERGED).pullProps().strategy).toBe("rebase");
    expect(mountPane(DIVERGED, { updateStrategy: "merge" }).pullProps().strategy).toBe("merge");
  });

  test("a missing setting falls back to rebase", () => {
    const appStore = useAppStore();
    appStore.payload = {
      appState: {
        workspaces: [buildWorkspace()],
        activeProfileId: "default",
        profiles: [{ id: "default", name: "Default", color: "#ffa424", workspaceIds: [] }],
        windowSlots: [{ id: "win-test", profileId: "default", activeWorkspaceId: "ws-test" }],
        settings: {},
      },
      git: { workspaces: { "ws-test": makeSnapshot(DIVERGED) }, connections: [] },
    } as unknown as StatePayload;
    const wrapper = shallowMount(GitPane, { props: { workspaceId: "ws-test" } });
    expect(propsOf(wrapper.findComponent(GitStrategySplitButton)).strategy).toBe("rebase");
  });

  test("both strategy options are offered and name the upstream", () => {
    const options = mountPane(DIVERGED).pullProps().options as Array<Record<string, unknown>>;
    expect(options.map((o) => o.value)).toEqual(["rebase", "merge"]);
    expect(String(options[0].label)).toContain("origin/develop");
    expect(String(options[1].label)).toContain("origin/develop");
  });
});

describe("a diverged branch gets a primary action", () => {
  test("diverged Pull is highlighted instead of leaving the row all-grey", () => {
    // Regression: primaryAction returned null while diverged, so no button in
    // the toolbar was highlighted in the one state where the user most needs
    // to be told what to click.
    expect(mountPane(DIVERGED).pullProps().primary).toBe(true);
  });

  test("diverged is enabled — it has a real action now", () => {
    expect(mountPane(DIVERGED).pullProps().disabled).toBe(false);
  });

  test("merely behind stays primary as before", () => {
    expect(mountPane({ behindCount: 2 }).pullProps().primary).toBe(true);
  });

  test("up to date is not primary and is disabled", () => {
    const { pullProps } = mountPane({});
    expect(pullProps().primary).toBe(false);
    expect(pullProps().disabled).toBe(true);
  });

  test("no upstream → the button is not rendered at all (UC-1/UC-9)", () => {
    // showPull is false without an upstream, so there is nothing to be primary
    // or disabled. Asserted here so the split-button swap is known not to have
    // resurrected a button the visibility rules deliberately hide.
    expect(mountPane({ behindCount: 2, upstream: "" }).pullButton().exists()).toBe(false);
  });

  test("under showAllActions a no-upstream Pull is rendered but disabled", () => {
    // The escape hatch shows every action regardless of state. It keeps its
    // own legacy primary rule, which this change did not touch — what matters
    // is that the button cannot be run.
    expect(mountPane({ behindCount: 2, upstream: "" }, { showAllActions: true }).pullProps().disabled).toBe(true);
  });
});
