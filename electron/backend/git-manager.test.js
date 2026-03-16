import { describe, expect, test } from "vitest";
import { GitManager } from "./git-manager.js";

class FakeGitManager extends GitManager {
  constructor({ hostLazygit = null, wslLazygit = null, responses = {} } = {}) {
    super();
    this.hostLazygit = hostLazygit;
    this.wslLazygit = wslLazygit;
    this.responses = responses;
  }

  async detectLazygit(workspace) {
    return this.hostLazygit || this.wslLazygit || {
      available: false,
      backend: null,
      error: "missing",
      launch: null,
    };
  }

  async inspectWorkspace(workspace) {
    if (this.responses[workspace.id]) {
      return this.responses[workspace.id];
    }
    return super.inspectWorkspace(workspace);
  }
}

describe("GitManager", () => {
  test("refreshWorkspaces builds a snapshot map keyed by workspace id", async () => {
    const manager = new FakeGitManager({
      responses: {
        frontend: {
          workspaceId: "frontend",
          cwd: "/home/user/workspace",
          available: true,
          root: "/home/user/workspace",
          repository: "workspace",
          branch: "main",
          commitCount: 42,
          dirty: true,
          dirtyCount: 3,
          status: [{ code: "M", path: "src/app.js" }],
          log: [{ shortHash: "abc123", relativeDate: "2 hours ago", author: "Jaromir", refs: "(HEAD -> main)", subject: "Refine workspace" }],
          lazygit: { available: true, backend: "host", error: "", launch: { file: "lazygit", args: [] } },
          error: "",
          lastUpdatedAt: "2026-03-14T18:00:00.000Z",
        },
      },
    });

    const snapshots = await manager.refreshWorkspaces([{ id: "frontend", cwd: "/home/user/workspace", kind: "terminal" }]);

    expect(snapshots.frontend.branch).toBe("main");
    expect(snapshots.frontend.dirtyCount).toBe(3);
    expect(manager.getSnapshot("frontend").repository).toBe("workspace");
  });

  test("createLazygitLaunch returns a cloned launch config", async () => {
    const manager = new FakeGitManager({
      responses: {
        frontend: {
          workspaceId: "frontend",
          cwd: "/home/user/workspace",
          available: true,
          root: "/home/user/workspace",
          repository: "workspace",
          branch: "main",
          commitCount: 1,
          dirty: false,
          dirtyCount: 0,
          status: [],
          log: [],
          lazygit: {
            available: true,
            backend: "wsl",
            error: "",
            launch: { file: "wsl.exe", args: ["-e", "sh", "-lc", "cd '/home/user/workspace' && exec lazygit"] },
          },
          error: "",
          lastUpdatedAt: "2026-03-14T18:00:00.000Z",
        },
      },
    });

    await manager.refreshWorkspaces([{ id: "frontend", cwd: "/home/user/workspace", kind: "terminal" }]);
    const launch = manager.createLazygitLaunch("frontend");
    launch.args.push("mutated");

    expect(manager.getSnapshot("frontend").lazygit.launch.args).not.toContain("mutated");
    expect(launch.file).toBe("wsl.exe");
  });
});
