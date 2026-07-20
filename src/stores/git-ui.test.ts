import { describe, expect, test, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useGitUiStore } from "./git-ui.js";
import { useNotificationStore } from "./notifications.js";
import type { Transport } from "../transport.js";

// gitSelectDiff is the only one of the three diff-preview loaders that reads
// the app store's git snapshot (to resolve rootPath/baseBranch), so it needs
// a mock here; the default null return matches the real store's behaviour
// when no payload has been loaded, which is what the other describe blocks
// below implicitly relied on before this mock existed.
const getGitSnapshot = vi.fn((_workspaceId: string, _rootPath?: string | null): unknown => null);
vi.mock("./app.js", () => ({
  useAppStore: () => ({ getGitSnapshot }),
}));

beforeEach(() => {
  setActivePinia(createPinia());
  getGitSnapshot.mockReset();
  getGitSnapshot.mockReturnValue(null);
});

describe("git-ui store", () => {
  describe("setActiveRoot / getActiveRoot", () => {
    test("round-trip: setActiveRoot then getActiveRoot returns the same path", () => {
      const store = useGitUiStore();
      store.setActiveRoot("ws1", "/repo/a");
      expect(store.getActiveRoot("ws1")).toBe("/repo/a");
    });

    test("getActiveRoot returns empty string when workspace is not known", () => {
      const store = useGitUiStore();
      expect(store.getActiveRoot("unknown")).toBe("");
    });

    test("setActiveRoot clears when empty string is passed", () => {
      const store = useGitUiStore();
      store.setActiveRoot("ws1", "/repo/a");
      store.setActiveRoot("ws1", "");
      expect(store.getActiveRoot("ws1")).toBe("");
    });

    test("setActiveRoot with one workspace does not affect another workspace", () => {
      const store = useGitUiStore();
      store.setActiveRoot("ws1", "/repo/a");
      store.setActiveRoot("ws2", "/repo/b");
      expect(store.getActiveRoot("ws1")).toBe("/repo/a");
      expect(store.getActiveRoot("ws2")).toBe("/repo/b");
    });
  });

  describe("setActiveRoot persistence via api.setWorkspaceUIState", () => {
    test("calls setWorkspaceUIState with correct arguments after init", () => {
      const mockApi = {
        setWorkspaceUIState: vi.fn().mockResolvedValue(null),
      } as unknown as Transport;
      const store = useGitUiStore();
      store.init(mockApi);
      store.setActiveRoot("ws1", "/repo/b");
      expect(mockApi.setWorkspaceUIState).toHaveBeenCalledWith("ws1", { activeRootPath: "/repo/b" });
    });

    test("does not throw when api is not initialized (no init call)", () => {
      const store = useGitUiStore();
      // _api is null — should be a no-op, not crash
      expect(() => store.setActiveRoot("ws1", "/repo/a")).not.toThrow();
      expect(store.getActiveRoot("ws1")).toBe("/repo/a");
    });

    test("passes empty string to setWorkspaceUIState when root is cleared", () => {
      const mockApi = {
        setWorkspaceUIState: vi.fn().mockResolvedValue(null),
      } as unknown as Transport;
      const store = useGitUiStore();
      store.init(mockApi);
      store.setActiveRoot("ws1", "");
      expect(mockApi.setWorkspaceUIState).toHaveBeenCalledWith("ws1", { activeRootPath: "" });
    });
  });

  // gitSelectCommit/gitSelectDiff/reviewSelectFileDiff each independently
  // reimplemented "optimistic Loading… placeholder, then real result or
  // error-shaped fallback carrying the same identity fields" before being
  // migrated onto the shared loadDiffPreview() helper.
  describe("diff preview loading (gitSelectCommit / gitSelectDiff / reviewSelectFileDiff)", () => {
    test("gitSelectCommit replaces the loading placeholder with the fetched result", async () => {
      const gitCommitDiff = vi.fn().mockResolvedValue({ ok: true, hash: "abc123", diff: "+line", summary: "1 file" });
      const mockApi = { gitCommitDiff } as unknown as Transport;
      const store = useGitUiStore();
      store.init(mockApi);

      const pending = store.gitSelectCommit("ws1", "abc123");
      expect(store.get("ws1").commitDiffPreview).toEqual({
        ok: true,
        hash: "abc123",
        diff: "",
        summary: "Loading...",
      });

      await pending;
      expect(gitCommitDiff).toHaveBeenCalledWith({ workspaceId: "ws1", hash: "abc123" });
      expect(store.get("ws1").commitDiffPreview).toEqual({
        ok: true,
        hash: "abc123",
        diff: "+line",
        summary: "1 file",
      });
    });

    test("gitSelectCommit falls back to an error-shaped result carrying the hash when the fetch rejects", async () => {
      const gitCommitDiff = vi.fn().mockRejectedValue(new Error("network down"));
      const mockApi = { gitCommitDiff } as unknown as Transport;
      const store = useGitUiStore();
      store.init(mockApi);

      await store.gitSelectCommit("ws1", "abc123");

      expect(store.get("ws1").commitDiffPreview).toEqual({
        ok: false,
        hash: "abc123",
        diff: "",
        summary: "network down",
      });
    });

    test("gitSelectCommit is a no-op for an empty hash", async () => {
      const store = useGitUiStore();
      await store.gitSelectCommit("ws1", "");
      expect(store.get("ws1").commitDiffPreview).toBeUndefined();
    });

    test("gitSelectDiff replaces the loading placeholder with the fetched result, carrying scope and resolving rootPath/baseBranch from the app-store snapshot", async () => {
      getGitSnapshot.mockReturnValue({ baseBranch: "main" });
      // A manually-controlled promise (rather than mockResolvedValue) so the
      // in-flight "Loading…" placeholder can be observed deterministically:
      // gitSelectDiff awaits a dynamic import before loadDiffPreview ever
      // runs, so the placeholder isn't visible synchronously the way
      // gitSelectCommit's is — flushing via a macrotask (setTimeout) drains
      // every microtask ahead of it (the import + loadDiffPreview's
      // pre-fetch code) while this fetch stays deliberately unresolved.
      let resolveFetch: (value: unknown) => void = () => {};
      const gitDiffPreview = vi.fn(() => new Promise((resolve) => (resolveFetch = resolve)));
      const mockApi = { gitDiffPreview } as unknown as Transport;
      const store = useGitUiStore();
      store.init(mockApi);
      store.setActiveRoot("ws1", "/repo/a");

      const pending = store.gitSelectDiff("ws1", "src/foo.ts", "staged");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(store.get("ws1").diffPreview).toEqual({
        ok: true,
        path: "src/foo.ts",
        scope: "staged",
        diff: "",
        summary: "Loading diff preview...",
      });
      expect(store.get("ws1").selectedDiff).toEqual({ path: "src/foo.ts", scope: "staged" });
      expect(gitDiffPreview).toHaveBeenCalledWith({
        workspaceId: "ws1",
        path: "src/foo.ts",
        scope: "staged",
        baseBranch: "main",
        rootPath: "/repo/a",
      });

      resolveFetch({ ok: true, path: "src/foo.ts", scope: "staged", diff: "+line", summary: "1 file" });
      await pending;
      expect(store.get("ws1").diffPreview).toEqual({
        ok: true,
        path: "src/foo.ts",
        scope: "staged",
        diff: "+line",
        summary: "1 file",
      });
    });

    test("gitSelectDiff falls back to an error-shaped result carrying the path and scope when the fetch rejects", async () => {
      const gitDiffPreview = vi.fn().mockRejectedValue(new Error("diff fetch failed"));
      const mockApi = { gitDiffPreview } as unknown as Transport;
      const store = useGitUiStore();
      store.init(mockApi);

      await store.gitSelectDiff("ws1", "src/foo.ts", "unstaged");

      expect(store.get("ws1").diffPreview).toEqual({
        ok: false,
        path: "src/foo.ts",
        scope: "unstaged",
        diff: "",
        summary: "diff fetch failed",
      });
    });

    test("gitSelectDiff is a no-op for an empty path", async () => {
      const store = useGitUiStore();
      await store.gitSelectDiff("ws1", "", "staged");
      expect(store.get("ws1").diffPreview).toBeUndefined();
    });

    test("reviewSelectFileDiff falls back to an error-shaped result carrying only the path (no scope)", async () => {
      const gitDiffPreview = vi.fn().mockRejectedValue(new Error("diff fetch failed"));
      const mockApi = { gitDiffPreview } as unknown as Transport;
      const store = useGitUiStore();
      store.init(mockApi);

      await store.reviewSelectFileDiff("ws1", "src/foo.ts");

      expect(store.get("ws1").reviewFileDiffPreview).toEqual({
        ok: false,
        path: "src/foo.ts",
        diff: "",
        summary: "diff fetch failed",
      });
    });
  });

  describe("cleanup", () => {
    test("cleanup removes workspace state so getActiveRoot returns empty string", () => {
      const store = useGitUiStore();
      store.setActiveRoot("ws1", "/repo/a");
      store.cleanup("ws1");
      expect(store.getActiveRoot("ws1")).toBe("");
    });
  });

  describe("PR rootPath routing", () => {
    test("azureCreatePullRequest includes the active rootPath", async () => {
      const mockApi = {
        azureCreatePullRequest: vi.fn().mockResolvedValue({ result: { ok: true, pullRequestId: 123 }, payload: null }),
      } as unknown as Transport;
      const store = useGitUiStore();
      store.init(mockApi);
      store.setActiveRoot("ws1", "/repo/b");

      await store.azureCreatePullRequest("ws1", {
        title: "My PR",
        description: "desc",
        sourceBranch: "feature/test",
        targetBranch: "main",
        connectionId: "ado-1",
      });

      expect(mockApi.azureCreatePullRequest).toHaveBeenCalledWith({
        workspaceId: "ws1",
        title: "My PR",
        description: "desc",
        sourceBranch: "feature/test",
        targetBranch: "main",
        connectionId: "ado-1",
        isDraft: false,
        rootPath: "/repo/b",
      });
    });

    test("azureCreatePullRequest forwards isDraft when provided", async () => {
      const mockApi = {
        azureCreatePullRequest: vi.fn().mockResolvedValue({ result: { ok: true, pullRequestId: 7 }, payload: null }),
      } as unknown as Transport;
      const store = useGitUiStore();
      store.init(mockApi);
      store.setActiveRoot("ws1", "/repo/b");

      await store.azureCreatePullRequest("ws1", {
        title: "WIP",
        description: "",
        sourceBranch: "feature/test",
        targetBranch: "main",
        connectionId: "ado-1",
        isDraft: true,
      });

      expect(mockApi.azureCreatePullRequest).toHaveBeenCalledWith(
        expect.objectContaining({ isDraft: true, title: "WIP" }),
      );
    });

    test("azureListRemoteBranches includes the active rootPath", async () => {
      const mockApi = {
        azureListRemoteBranches: vi.fn().mockResolvedValue({ branches: ["main", "develop"] }),
      } as unknown as Transport;
      const store = useGitUiStore();
      store.init(mockApi);
      store.setActiveRoot("ws1", "/repo/b");

      await store.azureListRemoteBranches("ws1");

      expect(mockApi.azureListRemoteBranches).toHaveBeenCalledWith({
        workspaceId: "ws1",
        rootPath: "/repo/b",
      });
    });

    // Regression: a failed fetch used to silently collapse to an empty
    // branch list with no error field — indistinguishable in the picker UI
    // from "this repo genuinely has no other branches."
    test("azureListRemoteBranches sets remoteBranchesError and clears the list when the API call fails", async () => {
      const mockApi = {
        azureListRemoteBranches: vi.fn().mockRejectedValue(new Error("network unreachable")),
      } as unknown as Transport;
      const store = useGitUiStore();
      store.init(mockApi);
      store.setActiveRoot("ws1", "/repo/b");

      await store.azureListRemoteBranches("ws1");

      expect(store.get("ws1").remoteBranches).toEqual([]);
      expect(store.get("ws1").remoteBranchesError).toBe("network unreachable");
    });
  });

  describe("openLazygit", () => {
    // Regression: openLazygit had no error handling at all, so a click did
    // nothing when lazygit wasn't installed/available — no banner, no toast.
    test("surfaces an error notification when the session fails to open", async () => {
      const mockApi = {
        openLazygitSession: vi.fn().mockRejectedValue(new Error("Lazygit is not available for this workspace.")),
      } as unknown as Transport;
      const store = useGitUiStore();
      store.init(mockApi);
      store.setActiveRoot("ws1", "/repo/a");

      await store.openLazygit("ws1");

      const notifications = useNotificationStore();
      expect(notifications.latestToast?.kind).toBe("error");
      expect(notifications.latestToast?.title).toBe("Failed to open Lazygit");
      expect(notifications.latestToast?.body).toBe("Lazygit is not available for this workspace.");
    });
  });

  describe("dismissStalePending — volatile counts must not nuke a fresh confirm", () => {
    // Regression: the screenshot bug. A pending rebase confirm was set, then a
    // background snapshot poll (ahead/behind + auto-detected compareWithBase
    // counts flapping) silently dismissed it via dismissStalePending — so the
    // confirm dialog vanished the instant a poll landed and the Update button
    // "did nothing". The staleness hash must ignore those volatile counts.
    const snap = (over: Record<string, unknown> = {}) => ({
      available: true,
      branch: "feature/x",
      baseBranch: "develop",
      dirty: false,
      dirtyCount: 0,
      aheadCount: 2,
      behindCount: 11,
      operationState: { kind: "idle", inProgress: false, conflicts: [] },
      compareWithBase: { baseBranch: "origin/develop", aheadCount: 2, behindCount: 11 },
      ...over,
    });

    test("keeps the pending confirm when only ahead/behind + compareWithBase counts change", () => {
      const store = useGitUiStore();
      store.setPendingGitAction("ws1", { type: "rebase", baseBranch: "origin/develop", snapshot: snap() });
      expect(store.get("ws1").pendingAction).toBeTruthy();

      // A poll lands: counts flap (base re-detected / fetch happened) but no
      // operation started and the tree is still clean.
      store.dismissStalePending(
        "ws1",
        snap({
          aheadCount: 0,
          behindCount: 0,
          compareWithBase: { baseBranch: "origin/jstradej/feature-x", aheadCount: 0, behindCount: 0 },
        }),
      );

      expect(store.get("ws1").pendingAction).toBeTruthy();
    });

    test("dismisses the pending confirm when an operation starts", () => {
      const store = useGitUiStore();
      store.setPendingGitAction("ws1", { type: "rebase", baseBranch: "origin/develop", snapshot: snap() });
      store.dismissStalePending("ws1", snap({ operationState: { kind: "rebase", inProgress: true, conflicts: [] } }));
      expect(store.get("ws1").pendingAction).toBeNull();
    });

    test("dismisses the pending confirm when the working tree dirty state changes", () => {
      const store = useGitUiStore();
      store.setPendingGitAction("ws1", { type: "merge", baseBranch: "origin/develop", snapshot: snap() });
      store.dismissStalePending("ws1", snap({ dirty: true, dirtyCount: 3 }));
      expect(store.get("ws1").pendingAction).toBeNull();
    });
  });

  describe("Conflict Center — listConflicts contract", () => {
    // Regression: git-manager.listConflicts returns the list under `entries`.
    // loadConflicts previously read `result.conflicts`, which never exists, so
    // the Conflict Center table always rendered empty. This locks the contract.
    test("loadConflicts populates the dialog from the backend `entries` key", async () => {
      const mockApi = {
        gitListConflicts: vi.fn().mockResolvedValue({
          ok: true,
          entries: [
            { path: "app.py", conflictType: "both-modified", stages: [1, 2, 3], binary: false },
            { path: "logo.png", conflictType: "both-added", stages: [2, 3], binary: true },
          ],
        }),
      } as unknown as Transport;
      const store = useGitUiStore();
      store.init(mockApi);

      store.openConflictDialog("ws1", "/repo/a");
      await store.loadConflicts("ws1");

      expect(mockApi.gitListConflicts).toHaveBeenCalledWith({ workspaceId: "ws1", rootPath: "/repo/a" });
      const dlg = store.get("ws1").conflictDialog;
      expect(dlg?.conflicts.map((c) => c.path)).toEqual(["app.py", "logo.png"]);
      const png = dlg?.conflicts.find((c) => c.path === "logo.png");
      expect(png?.binary).toBe(true);
      expect(png?.conflictType).toBe("both-added");
      expect(dlg?.conflicts.every((c) => c.resolved === false)).toBe(true);
    });
  });

  describe("live push progress (onGitPushProgress)", () => {
    type ProgressHandler = (p: { workspaceId: string; rootPath: string; chunk: string }) => void;

    test("init subscribes and streamed chunks accumulate on the workspace", () => {
      let handler: ProgressHandler | null = null;
      const mockApi = {
        onGitPushProgress: vi.fn((h: ProgressHandler) => {
          handler = h;
        }),
      } as unknown as Transport;
      const store = useGitUiStore();
      store.init(mockApi);
      expect(mockApi.onGitPushProgress).toHaveBeenCalledTimes(1);

      handler!({ workspaceId: "ws1", rootPath: "/repo", chunk: "Running pre-push hook…\n" });
      handler!({ workspaceId: "ws1", rootPath: "/repo", chunk: "✓ typecheck\n" });

      expect(store.get("ws1").pushProgress).toBe("Running pre-push hook…\n✓ typecheck\n");
    });

    test("progress for one workspace does not leak into another", () => {
      let handler: ProgressHandler | null = null;
      const mockApi = {
        onGitPushProgress: vi.fn((h: ProgressHandler) => {
          handler = h;
        }),
      } as unknown as Transport;
      const store = useGitUiStore();
      store.init(mockApi);

      handler!({ workspaceId: "ws1", rootPath: "/repo", chunk: "ws1 output" });
      expect(store.get("ws1").pushProgress).toBe("ws1 output");
      expect(store.get("ws2").pushProgress).toBeUndefined();
    });

    test("a push clears any stale live output at the start", async () => {
      let handler: ProgressHandler | null = null;
      const mockApi = {
        onGitPushProgress: vi.fn((h: ProgressHandler) => {
          handler = h;
        }),
        gitPush: vi.fn().mockResolvedValue({ result: { ok: true, summary: "pushed" } }),
      } as unknown as Transport;
      const store = useGitUiStore();
      store.init(mockApi);

      // A previous push left output behind.
      handler!({ workspaceId: "ws1", rootPath: "/repo", chunk: "old output" });
      expect(store.get("ws1").pushProgress).toBe("old output");

      await store.gitPush("ws1");
      expect(store.get("ws1").pushProgress).toBe("");
    });
  });
});
