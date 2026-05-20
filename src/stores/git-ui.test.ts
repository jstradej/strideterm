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
});
