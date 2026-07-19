import { describe, expect, test, vi, beforeEach } from "vitest";
import { ref } from "vue";
import { useCommitContextMenu, type CommitContextMenuCommit } from "./useCommitContextMenu.js";

interface Commit extends CommitContextMenuCommit {
  hash: string;
  shortHash: string;
  subject: string;
  parents: string[];
}

function commit(overrides: Partial<Commit>): Commit {
  return { hash: "h", shortHash: "h", subject: "", parents: [], ...overrides };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeAppStore() {
  return { openDialog: vi.fn(), closeDialog: vi.fn() };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeGitUiStore() {
  return {
    gitCherryPick: vi.fn().mockResolvedValue(undefined),
    gitCheckoutBranch: vi.fn().mockResolvedValue(undefined),
    gitCreateBranch: vi.fn().mockResolvedValue(undefined),
    gitCreateTag: vi.fn().mockResolvedValue(undefined),
    gitSquashCommits: vi.fn().mockResolvedValue(undefined),
  };
}

function setup(overrides: Partial<Parameters<typeof useCommitContextMenu<Commit>>[0]> = {}) {
  const commits = ref<Commit[]>([
    commit({ hash: "c3", shortHash: "c3s", subject: "third", parents: ["c2"] }),
    commit({ hash: "c2", shortHash: "c2s", subject: "second", parents: ["c1"] }),
    commit({ hash: "c1", shortHash: "c1s", subject: "first", parents: [] }),
  ]);
  const head = ref("c3");
  const multiSelected = ref<string[]>([]);
  const snapshot = ref<Record<string, unknown>>({});
  const hasAzureConnection = ref(false);
  const currentBranch = ref("main");
  const appStore = makeAppStore();
  const gitUiStore = makeGitUiStore();
  const shortHashOf = vi.fn((h: string) => h.slice(0, 4));
  const copyToClipboard = vi.fn().mockResolvedValue(undefined);
  const refreshAll = vi.fn();
  const onOpenCommitDialog = vi.fn();
  const openCreatePullRequestDialog = vi.fn();
  const workspaceId = ref("ws1");

  const api = useCommitContextMenu<Commit>({
    workspaceId,
    commits,
    head,
    multiSelected,
    snapshot,
    hasAzureConnection,
    currentBranch,
    gitUiStore,
    appStore,
    shortHashOf,
    copyToClipboard,
    refreshAll,
    onOpenCommitDialog,
    openCreatePullRequestDialog,
    ...overrides,
  });

  return {
    api,
    commits,
    head,
    multiSelected,
    snapshot,
    hasAzureConnection,
    appStore,
    gitUiStore,
    copyToClipboard,
    refreshAll,
    onOpenCommitDialog,
    openCreatePullRequestDialog,
    workspaceId,
  };
}

describe("useCommitContextMenu — single-commit menu", () => {
  test("right-clicking a non-merge, non-HEAD commit builds the base item set with no Create PR", () => {
    const { api } = setup();
    api.onCommitContextMenu({ hash: "c2", x: 10, y: 20 });
    expect(api.ctxMenu.value?.hash).toBe("c2");
    expect(api.ctxMenu.value?.hashes).toEqual(["c2"]);
    const ids = api.ctxMenu.value?.items.map((i) => i.id) || [];
    expect(ids).toEqual(["details", "copyHash", "copyShort", "copySubject", "cherryPick", "checkout", "newBranch", "newTag"]);
    expect(api.ctxMenu.value?.items.find((i) => i.id === "cherryPick")?.disabled).toBe(false);
  });

  test("Create PR appears only when hasAzureConnection AND the commit is HEAD", () => {
    const { api, snapshot, hasAzureConnection } = setup();
    snapshot.value = { headCommit: "c3" };
    hasAzureConnection.value = true;
    api.onCommitContextMenu({ hash: "c3", x: 0, y: 0 });
    expect(api.ctxMenu.value?.items.some((i) => i.id === "createPr")).toBe(true);

    // Same connection flag, but right-clicking a non-HEAD commit — no PR item.
    api.onCommitContextMenu({ hash: "c2", x: 0, y: 0 });
    expect(api.ctxMenu.value?.items.some((i) => i.id === "createPr")).toBe(false);
  });

  test("a merge commit (2+ parents) disables cherry-pick with an explanatory title", () => {
    const { api, commits } = setup();
    commits.value = [commit({ hash: "m1", shortHash: "m1s", parents: ["a", "b"] })];
    api.onCommitContextMenu({ hash: "m1", x: 0, y: 0 });
    const item = api.ctxMenu.value?.items.find((i) => i.id === "cherryPick");
    expect(item?.disabled).toBe(true);
    expect(item?.title).toContain("not supported");
  });

  test("an unknown hash leaves the menu closed", () => {
    const { api } = setup();
    api.onCommitContextMenu({ hash: "does-not-exist", x: 0, y: 0 });
    expect(api.ctxMenu.value).toBeNull();
  });
});

describe("useCommitContextMenu — multi-selection menu", () => {
  test("right-clicking a hash inside an active multi-selection builds the multi menu", () => {
    const { api, multiSelected } = setup();
    multiSelected.value = ["c3", "c2"];
    api.onCommitContextMenu({ hash: "c2", x: 0, y: 0 });
    const ids = api.ctxMenu.value?.items.map((i) => i.id) || [];
    expect(ids).toEqual(["cherryPick", "squash"]);
    expect(api.ctxMenu.value?.hashes).toEqual(["c3", "c2"]); // newest-first, per commits order
  });

  test("a contiguous 2-commit selection on the checked-out branch is squash-eligible", () => {
    const { api, multiSelected } = setup(); // head=c3, commits c3(parents:c2) -> c2(parents:c1) -> c1
    multiSelected.value = ["c3", "c2"];
    api.onCommitContextMenu({ hash: "c3", x: 0, y: 0 });
    const squash = api.ctxMenu.value?.items.find((i) => i.id === "squash");
    expect(squash?.disabled).toBe(false);
  });

  test("a selection containing a merge commit is not squash-eligible", () => {
    const { api, commits, multiSelected } = setup();
    commits.value = [
      commit({ hash: "c3", shortHash: "c3s", parents: ["c2"] }),
      commit({ hash: "c2", shortHash: "c2s", parents: ["c1a", "c1b"] }), // merge
      commit({ hash: "c1a", shortHash: "c1as", parents: [] }),
    ];
    multiSelected.value = ["c3", "c2"];
    api.onCommitContextMenu({ hash: "c3", x: 0, y: 0 });
    const squash = api.ctxMenu.value?.items.find((i) => i.id === "squash");
    expect(squash?.disabled).toBe(true);
    expect(squash?.title).toContain("merge commit");
  });

  test("a single-hash multiSelected does NOT trigger the multi menu", () => {
    const { api, multiSelected } = setup();
    multiSelected.value = ["c2"];
    api.onCommitContextMenu({ hash: "c2", x: 0, y: 0 });
    const ids = api.ctxMenu.value?.items.map((i) => i.id) || [];
    expect(ids).toContain("details"); // single-commit menu, not multi
  });
});

describe("useCommitContextMenu — onMenuPick actions", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  test("copyHash / copyShort / copySubject copy the right text and close the menu", async () => {
    const { api, copyToClipboard } = ctx;
    api.onCommitContextMenu({ hash: "c2", x: 0, y: 0 });
    await api.onMenuPick("copyHash");
    expect(copyToClipboard).toHaveBeenCalledWith("c2");
    expect(api.ctxMenu.value).toBeNull();

    api.onCommitContextMenu({ hash: "c2", x: 0, y: 0 });
    await api.onMenuPick("copyShort");
    expect(copyToClipboard).toHaveBeenCalledWith("c2s");

    api.onCommitContextMenu({ hash: "c2", x: 0, y: 0 });
    await api.onMenuPick("copySubject");
    expect(copyToClipboard).toHaveBeenCalledWith("second");
  });

  test("details opens the commit dialog via the injected callback", async () => {
    const { api, onOpenCommitDialog } = ctx;
    api.onCommitContextMenu({ hash: "c2", x: 0, y: 0 });
    await api.onMenuPick("details");
    expect(onOpenCommitDialog).toHaveBeenCalledWith("c2");
  });

  test("cherryPick opens a ConfirmDialog whose onConfirm calls gitCherryPick and refreshes", async () => {
    const { api, appStore, gitUiStore, refreshAll } = ctx;
    api.onCommitContextMenu({ hash: "c2", x: 0, y: 0 });
    await api.onMenuPick("cherryPick");
    expect(appStore.openDialog).toHaveBeenCalledWith("ConfirmDialog", expect.objectContaining({ eyebrow: "Git" }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dialogArgs = appStore.openDialog.mock.calls[0][1] as any;
    await dialogArgs.onConfirm();
    expect(gitUiStore.gitCherryPick).toHaveBeenCalledWith("ws1", ["c2"]);
    expect(refreshAll).toHaveBeenCalledWith(true);
    expect(appStore.closeDialog).toHaveBeenCalled();
  });

  test("squash opens a TextAreaDialog whose onSubmit squashes, clears multiSelected, and refreshes", async () => {
    const { api, appStore, gitUiStore, refreshAll, multiSelected } = ctx;
    multiSelected.value = ["c3", "c2"];
    api.onCommitContextMenu({ hash: "c3", x: 0, y: 0 });
    await api.onMenuPick("squash");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dialogArgs = appStore.openDialog.mock.calls[0][1] as any;
    expect(dialogArgs.value).toBe("second\n\nthird"); // oldest-first prefill (c2 is older than c3)
    await dialogArgs.onSubmit("squashed message");
    expect(gitUiStore.gitSquashCommits).toHaveBeenCalledWith("ws1", ["c3", "c2"], "squashed message");
    expect(multiSelected.value).toEqual([]);
    expect(refreshAll).toHaveBeenCalledWith(true);
  });

  test("checkout opens a ConfirmDialog whose onConfirm checks out the commit", async () => {
    const { api, appStore, gitUiStore, refreshAll } = ctx;
    api.onCommitContextMenu({ hash: "c2", x: 0, y: 0 });
    await api.onMenuPick("checkout");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dialogArgs = appStore.openDialog.mock.calls[0][1] as any;
    await dialogArgs.onConfirm();
    expect(gitUiStore.gitCheckoutBranch).toHaveBeenCalledWith("ws1", "c2");
    expect(refreshAll).toHaveBeenCalledWith(true);
  });

  test("newBranch opens a TextInputDialog whose onSubmit creates the branch at this commit", async () => {
    const { api, appStore, gitUiStore, refreshAll } = ctx;
    api.onCommitContextMenu({ hash: "c2", x: 0, y: 0 });
    await api.onMenuPick("newBranch");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dialogArgs = appStore.openDialog.mock.calls[0][1] as any;
    await dialogArgs.onSubmit("feature/x");
    expect(gitUiStore.gitCreateBranch).toHaveBeenCalledWith("ws1", "feature/x", "c2");
    expect(refreshAll).toHaveBeenCalledWith(true);
  });

  test("newTag opens a TextInputDialog whose onSubmit creates the tag at this commit", async () => {
    const { api, appStore, gitUiStore, refreshAll } = ctx;
    api.onCommitContextMenu({ hash: "c2", x: 0, y: 0 });
    await api.onMenuPick("newTag");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dialogArgs = appStore.openDialog.mock.calls[0][1] as any;
    await dialogArgs.onSubmit("v1.0.0");
    expect(gitUiStore.gitCreateTag).toHaveBeenCalledWith("ws1", "v1.0.0", "", "c2");
    expect(refreshAll).toHaveBeenCalledWith(true);
  });

  test("createPr delegates to the injected openCreatePullRequestDialog callback", async () => {
    const { api, snapshot, hasAzureConnection, openCreatePullRequestDialog } = ctx;
    snapshot.value = { headCommit: "c3" };
    hasAzureConnection.value = true;
    api.onCommitContextMenu({ hash: "c3", x: 0, y: 0 });
    await api.onMenuPick("createPr");
    expect(openCreatePullRequestDialog).toHaveBeenCalledTimes(1);
  });

  test("picking with no open menu is a no-op", async () => {
    const { api, copyToClipboard } = ctx;
    await api.onMenuPick("copyHash");
    expect(copyToClipboard).not.toHaveBeenCalled();
  });
});
