import { describe, expect, test, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";

// The git-stash store reaches the transport via useAppStore().getApi() and
// leans on git-ui (active root, snapshot refresh) + notifications (toasts).
// Mock those so the store is exercised in isolation.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fakeApi: Record<string, any> = {};
const refreshGit = vi.fn(async () => {});
const pushEphemeralToast = vi.fn();

vi.mock("./app.js", () => ({
  useAppStore: () => ({ getApi: () => fakeApi }),
}));
vi.mock("./git-ui.js", () => ({
  useGitUiStore: () => ({ getActiveRoot: () => "/repo", refreshGit }),
}));
vi.mock("./notifications.js", () => ({
  useNotificationStore: () => ({ pushEphemeralToast }),
}));

import { useGitStashStore } from "./git-stash.js";

const SAMPLE = [
  {
    index: 0,
    ref: "stash@{0}",
    date: "",
    author: "",
    branch: "master",
    baseCommit: "",
    baseSubject: "",
    message: "On master: fix race",
    customMessage: "fix race",
    isWipDefault: false,
    fileCount: 2,
  },
  {
    index: 1,
    ref: "stash@{1}",
    date: "",
    author: "",
    branch: "feat/x",
    baseCommit: "",
    baseSubject: "",
    message: "On feat/x: experiment",
    customMessage: "experiment",
    isWipDefault: false,
    fileCount: 1,
  },
];

beforeEach(() => {
  setActivePinia(createPinia());
  for (const k of Object.keys(fakeApi)) delete fakeApi[k];
  refreshGit.mockClear();
  pushEphemeralToast.mockClear();
  fakeApi.gitListStashes = vi.fn(async () => ({ ok: true, stashes: SAMPLE }));
  fakeApi.gitStashFiles = vi.fn(async () => ({
    ok: true,
    files: [{ path: "src/foo.ts", code: "M", status: "modified", additions: 1, deletions: 0, isBinary: false }],
  }));
  fakeApi.gitStashFileDiff = vi.fn(async () => ({ ok: true, leftContent: "a", rightContent: "b" }));
  fakeApi.gitStash = vi.fn(async () => ({ result: { ok: true, summary: "stashed" } }));
  fakeApi.gitStashApply = vi.fn(async () => ({ result: { ok: true, summary: "applied" } }));
  fakeApi.gitStashPop = vi.fn(async () => ({ result: { ok: true, summary: "popped" } }));
  fakeApi.gitStashDrop = vi.fn(async () => ({ result: { ok: true, summary: "dropped" } }));
  fakeApi.gitStashBranch = vi.fn(async () => ({ result: { ok: true, summary: "branched" } }));
  fakeApi.gitStashExport = vi.fn(async () => ({ ok: true, patch: "diff --git", suggestedFilename: "x.patch" }));
  fakeApi.gitStashImport = vi.fn(async () => ({ result: { ok: true, summary: "imported" } }));
});

describe("git-stash store", () => {
  test("loadStashes populates byWorkspace[id].entries", async () => {
    const store = useGitStashStore();
    await store.loadStashes("ws1");
    expect(store.get("ws1").entries).toHaveLength(2);
    expect(store.get("ws1").entries[0].ref).toBe("stash@{0}");
  });

  test("selectedRef defaults to entries[0].ref on first load", async () => {
    const store = useGitStashStore();
    await store.loadStashes("ws1");
    expect(store.get("ws1").selectedRef).toBe("stash@{0}");
  });

  test("loadFiles lazy-loads files for a ref", async () => {
    const store = useGitStashStore();
    await store.loadFiles("ws1", "stash@{0}");
    expect(fakeApi.gitStashFiles).toHaveBeenCalledTimes(1);
    expect(store.get("ws1").filesByRef["stash@{0}"]).toHaveLength(1);
  });

  test("loadDiff caches by ref + path (second call is a no-op)", async () => {
    const store = useGitStashStore();
    await store.loadDiff("ws1", "stash@{0}", "src/foo.ts");
    await store.loadDiff("ws1", "stash@{0}", "src/foo.ts");
    expect(fakeApi.gitStashFileDiff).toHaveBeenCalledTimes(1);
    expect(store.get("ws1").diffByRefAndPath["stash@{0}::src/foo.ts"]).toBeTruthy();
  });

  test("apply sets busyRef during the call and clears it after", async () => {
    const store = useGitStashStore();
    let release: (v: unknown) => void = () => {};
    fakeApi.gitStashApply = vi.fn(() => new Promise((r) => (release = r)));
    const p = store.apply("ws1", "stash@{0}");
    // Busy state is set synchronously, before the (async) git call runs.
    expect(store.get("ws1").busyRef).toBe("stash@{0}");
    expect(store.get("ws1").busyAction).toBe("apply");
    await vi.waitFor(() => expect(fakeApi.gitStashApply).toHaveBeenCalled());
    release({ result: { ok: true, summary: "applied" } });
    await p;
    expect(store.get("ws1").busyRef).toBe("");
    expect(store.get("ws1").busyAction).toBe("");
  });

  test("createStash sets busyAction during the call and refreshes on success", async () => {
    const store = useGitStashStore();
    let release: (v: unknown) => void = () => {};
    fakeApi.gitStash = vi.fn(() => new Promise((r) => (release = r)));
    const p = store.createStash("ws1", { message: "m", includeUntracked: true });
    expect(store.get("ws1").busyAction).toBe("create");
    await vi.waitFor(() => expect(fakeApi.gitStash).toHaveBeenCalled());
    release({ result: { ok: true, summary: "stashed" } });
    await p;
    expect(store.get("ws1").busyAction).toBe("");
    // The list + snapshot are refreshed after a successful mutation.
    expect(fakeApi.gitListStashes).toHaveBeenCalled();
    expect(refreshGit).toHaveBeenCalledWith("ws1");
  });

  test("createStash forwards selected paths and omits them for a whole-tree stash", async () => {
    const store = useGitStashStore();
    // Whole-tree stash: no `paths` key so the backend takes its default branch.
    await store.createStash("ws1", { message: "all", includeUntracked: false });
    expect(fakeApi.gitStash).toHaveBeenLastCalledWith({
      workspaceId: "ws1",
      rootPath: "/repo",
      message: "all",
      includeUntracked: false,
    });
    // Path-scoped stash: the chosen subset is passed through.
    await store.createStash("ws1", { message: "subset", includeUntracked: true, paths: ["a.ts", "b.ts"] });
    expect(fakeApi.gitStash).toHaveBeenLastCalledWith({
      workspaceId: "ws1",
      rootPath: "/repo",
      message: "subset",
      includeUntracked: true,
      paths: ["a.ts", "b.ts"],
    });
  });

  test("pop and drop set busyRef and clear after, refreshing the list", async () => {
    const store = useGitStashStore();
    await store.pop("ws1", "stash@{0}");
    expect(store.get("ws1").busyRef).toBe("");
    await store.drop("ws1", "stash@{1}");
    expect(store.get("ws1").busyRef).toBe("");
    expect(fakeApi.gitStashPop).toHaveBeenCalledWith({ workspaceId: "ws1", rootPath: "/repo", ref: "stash@{0}" });
    expect(fakeApi.gitStashDrop).toHaveBeenCalledWith({ workspaceId: "ws1", rootPath: "/repo", ref: "stash@{1}" });
  });

  test("branchFrom forwards branch name + switch flag", async () => {
    const store = useGitStashStore();
    await store.branchFrom("ws1", "stash@{0}", "feature-x", true);
    expect(fakeApi.gitStashBranch).toHaveBeenCalledWith({
      workspaceId: "ws1",
      rootPath: "/repo",
      ref: "stash@{0}",
      branchName: "feature-x",
      switchImmediately: true,
    });
  });

  test("exportPatch returns patch + filename without throwing", async () => {
    const store = useGitStashStore();
    const res = await store.exportPatch("ws1", "stash@{0}");
    expect(res.ok).toBe(true);
    expect(res.patch).toContain("diff --git");
    expect(res.suggestedFilename).toBe("x.patch");
  });

  test("a mutating action aborts when the stash SHA changed out of band", async () => {
    const store = useGitStashStore();
    // Initial load: stash@{0} resolves to hash A.
    fakeApi.gitListStashes = vi.fn(async () => ({ ok: true, stashes: [{ ...SAMPLE[0], hash: "aaaaaaa" }] }));
    await store.loadStashes("ws1");
    // Out-of-band reshuffle (e.g. a `git stash drop` in a terminal): the same
    // ref now points at a different commit.
    fakeApi.gitListStashes = vi.fn(async () => ({ ok: true, stashes: [{ ...SAMPLE[0], hash: "bbbbbbb" }] }));
    const ok = await store.apply("ws1", "stash@{0}");
    expect(ok).toBe(false);
    expect(fakeApi.gitStashApply).not.toHaveBeenCalled();
    expect(pushEphemeralToast).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining("Stash list changed") }),
    );
  });

  test("a mutating action proceeds when the stash SHA is unchanged", async () => {
    const store = useGitStashStore();
    fakeApi.gitListStashes = vi.fn(async () => ({ ok: true, stashes: [{ ...SAMPLE[0], hash: "aaaaaaa" }] }));
    await store.loadStashes("ws1");
    const ok = await store.apply("ws1", "stash@{0}");
    expect(ok).toBe(true);
    expect(fakeApi.gitStashApply).toHaveBeenCalledTimes(1);
  });

  test("setFilter and setSelected mutate per-workspace state", async () => {
    const store = useGitStashStore();
    store.setFilter("ws1", "race");
    store.setSelected("ws1", "stash@{1}", "src/foo.ts");
    expect(store.get("ws1").filter).toBe("race");
    expect(store.get("ws1").selectedRef).toBe("stash@{1}");
    expect(store.get("ws1").selectedFile).toBe("src/foo.ts");
  });

  test("setIncludeUntrackedNext updates the per-session preference", () => {
    const store = useGitStashStore();
    store.setIncludeUntrackedNext("ws1", false);
    expect(store.get("ws1").includeUntrackedNext).toBe(false);
  });

  test("includeUntrackedNext defaults ON for a fresh workspace (not sticky)", () => {
    const store = useGitStashStore();
    store.setIncludeUntrackedNext("ws1", false);
    store.cleanup("ws1");
    // A re-ensured workspace starts ON again — the OFF choice is not persisted.
    expect(store.ensure("ws1").includeUntrackedNext).toBe(true);
  });
});
