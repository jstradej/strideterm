import { describe, expect, test, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useGitUiStore } from "./git-ui.js";
import type { Transport } from "../transport.js";

beforeEach(() => {
  setActivePinia(createPinia());
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
});
