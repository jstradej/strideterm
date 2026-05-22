import { describe, expect, test } from "vitest";
import {
  validateIpc,
  workspaceSchema,
  azureCommentSchema,
  azureVoteSchema,
  azureThreadStatusSchema,
  gitBranchDeleteSchema,
  gitBranchListSchema,
  gitBranchRenameSchema,
  gitCheckoutRemoteSchema,
  gitPayloadSchema,
  gitDiffPreviewSchema,
  gitLogPageSchema,
  gitLogGraphSchema,
  gitRemoteBranchDeleteSchema,
  terminalResizeSchema,
  profileSchema,
  worktreeSchema,
  removeWorktreeSchema,
  dockerSessionSchema,
} from "./ipc-schemas.js";

describe("ipc-schemas", () => {
  describe("validateIpc", () => {
    test("returns validated data on success", () => {
      const result = validateIpc(gitPayloadSchema, { workspaceId: "ws-1" }, "test");
      expect(result.workspaceId).toBe("ws-1");
    });

    test("throws descriptive error on failure", () => {
      expect(() => validateIpc(gitPayloadSchema, {}, "git:fetch")).toThrow(/IPC validation failed on 'git:fetch'/);
    });

    test("throws on null payload", () => {
      expect(() => validateIpc(gitPayloadSchema, null, "test")).toThrow();
    });
  });

  describe("workspaceSchema", () => {
    test("accepts valid workspace", () => {
      const result = validateIpc(
        workspaceSchema,
        {
          id: "ws-1",
          name: "My Workspace",
          cwd: "/home/user/project",
          panels: [{ id: "p1", title: "Shell" }],
        },
        "workspace:save",
      );
      expect(result.id).toBe("ws-1");
    });

    test("rejects workspace without id", () => {
      expect(() => validateIpc(workspaceSchema, { name: "test" }, "test")).toThrow();
    });

    test("rejects empty id", () => {
      expect(() => validateIpc(workspaceSchema, { id: "", name: "test" }, "test")).toThrow();
    });

    test("passes through extra fields", () => {
      const result = validateIpc(
        workspaceSchema,
        {
          id: "ws-1",
          name: "test",
          kind: "terminal",
          customField: "hello",
        },
        "test",
      );
      expect(result.customField).toBe("hello");
    });
  });

  describe("azureCommentSchema", () => {
    test("accepts valid comment", () => {
      const result = validateIpc(
        azureCommentSchema,
        {
          prKey: "org/project/repo/1",
          content: "LGTM",
          threadId: null,
          parentCommentId: 0,
        },
        "test",
      );
      expect(result.prKey).toBe("org/project/repo/1");
    });

    test("rejects missing prKey", () => {
      expect(() => validateIpc(azureCommentSchema, { content: "hi" }, "test")).toThrow();
    });
  });

  describe("azureVoteSchema", () => {
    test("accepts valid vote", () => {
      const result = validateIpc(azureVoteSchema, { prKey: "key", vote: 10 }, "test");
      expect(result.vote).toBe(10);
    });

    test("rejects non-numeric vote", () => {
      expect(() => validateIpc(azureVoteSchema, { prKey: "key", vote: "yes" }, "test")).toThrow();
    });
  });

  describe("azureThreadStatusSchema", () => {
    test("accepts valid status", () => {
      const result = validateIpc(
        azureThreadStatusSchema,
        {
          prKey: "key",
          threadId: 42,
          status: "fixed",
        },
        "test",
      );
      expect(result.status).toBe("fixed");
    });

    test("rejects invalid status value", () => {
      expect(() =>
        validateIpc(
          azureThreadStatusSchema,
          {
            prKey: "key",
            threadId: 42,
            status: "invalid",
          },
          "test",
        ),
      ).toThrow();
    });
  });

  describe("gitDiffPreviewSchema", () => {
    test("accepts valid diff preview request", () => {
      const result = validateIpc(
        gitDiffPreviewSchema,
        {
          workspaceId: "ws-1",
          path: "src/app.js",
          scope: "staged",
        },
        "test",
      );
      expect(result.path).toBe("src/app.js");
    });

    test("rejects empty path", () => {
      expect(() =>
        validateIpc(
          gitDiffPreviewSchema,
          {
            workspaceId: "ws-1",
            path: "",
          },
          "test",
        ),
      ).toThrow();
    });
  });

  describe("gitLogPageSchema", () => {
    test("applies default skip and limit", () => {
      const result = validateIpc(gitLogPageSchema, { workspaceId: "ws-1" }, "git:log-page");
      expect(result.skip).toBe(0);
      expect(result.limit).toBe(100);
    });

    test("clamps limit to <= 500", () => {
      expect(() => validateIpc(gitLogPageSchema, { workspaceId: "ws-1", limit: 9999 }, "test")).toThrow();
    });

    test("rejects negative skip", () => {
      expect(() => validateIpc(gitLogPageSchema, { workspaceId: "ws-1", skip: -1 }, "test")).toThrow();
    });
  });

  describe("gitLogGraphSchema", () => {
    test("accepts minimal payload", () => {
      const result = validateIpc(gitLogGraphSchema, { workspaceId: "ws-1" }, "git:log-graph");
      expect(result.workspaceId).toBe("ws-1");
    });

    test("accepts full filter set", () => {
      const result = validateIpc(
        gitLogGraphSchema,
        {
          workspaceId: "ws-1",
          limit: 500,
          includeRemotes: true,
          branch: "main",
          sinceDate: "2 weeks ago",
          untilDate: "2026-01-01",
          paths: ["src/foo.ts", "docs/README.md"],
          topoOrder: true,
          author: "alice@example.com",
        },
        "git:log-graph",
      );
      expect(result.sinceDate).toBe("2 weeks ago");
      expect(result.paths).toEqual(["src/foo.ts", "docs/README.md"]);
      expect(result.topoOrder).toBe(true);
      expect(result.author).toBe("alice@example.com");
    });

    test("rejects sinceDate starting with '-' (flag-injection guard)", () => {
      expect(() => validateIpc(gitLogGraphSchema, { workspaceId: "ws-1", sinceDate: "--malicious" }, "test")).toThrow();
    });

    test("rejects path containing '..' (traversal guard)", () => {
      expect(() => validateIpc(gitLogGraphSchema, { workspaceId: "ws-1", paths: ["../etc/passwd"] }, "test")).toThrow();
    });

    test("rejects path starting with '-' (flag-injection guard)", () => {
      expect(() => validateIpc(gitLogGraphSchema, { workspaceId: "ws-1", paths: ["-rf"] }, "test")).toThrow();
    });

    test("rejects more than 32 paths", () => {
      const paths = Array.from({ length: 33 }, (_, i) => `f${i}.ts`);
      expect(() => validateIpc(gitLogGraphSchema, { workspaceId: "ws-1", paths }, "test")).toThrow();
    });

    test("rejects author starting with '-' (flag-injection guard)", () => {
      expect(() => validateIpc(gitLogGraphSchema, { workspaceId: "ws-1", author: "-x" }, "test")).toThrow();
    });

    test("clamps limit to <= 2000", () => {
      expect(() => validateIpc(gitLogGraphSchema, { workspaceId: "ws-1", limit: 9999 }, "test")).toThrow();
    });
  });

  describe("gitBranchListSchema", () => {
    test("accepts minimal payload", () => {
      const result = validateIpc(gitBranchListSchema, { workspaceId: "ws-1" }, "git:list-branches");
      expect(result.workspaceId).toBe("ws-1");
    });

    test("accepts rootPath when provided", () => {
      const result = validateIpc(
        gitBranchListSchema,
        { workspaceId: "ws-1", rootPath: "/repo/sub" },
        "git:list-branches",
      );
      expect(result.rootPath).toBe("/repo/sub");
    });

    test("rejects missing workspaceId", () => {
      expect(() => validateIpc(gitBranchListSchema, {}, "test")).toThrow();
    });

    test("rejects empty workspaceId", () => {
      expect(() => validateIpc(gitBranchListSchema, { workspaceId: "" }, "test")).toThrow();
    });
  });

  describe("gitBranchDeleteSchema", () => {
    test("accepts a normal branch name", () => {
      const result = validateIpc(
        gitBranchDeleteSchema,
        { workspaceId: "ws-1", branch: "feature/foo" },
        "git:delete-branch",
      );
      expect(result.branch).toBe("feature/foo");
    });

    test("force flag round-trips", () => {
      const result = validateIpc(
        gitBranchDeleteSchema,
        { workspaceId: "ws-1", branch: "feature/foo", force: true },
        "test",
      );
      expect(result.force).toBe(true);
    });

    test("rejects branch starting with '-' (flag-injection guard)", () => {
      expect(() => validateIpc(gitBranchDeleteSchema, { workspaceId: "ws-1", branch: "-D" }, "test")).toThrow();
    });

    test("rejects missing branch field", () => {
      expect(() => validateIpc(gitBranchDeleteSchema, { workspaceId: "ws-1" }, "test")).toThrow();
    });
  });

  describe("gitRemoteBranchDeleteSchema", () => {
    test("accepts a normal branch+remote pair", () => {
      const result = validateIpc(
        gitRemoteBranchDeleteSchema,
        { workspaceId: "ws-1", branch: "feature/foo", remote: "origin" },
        "git:delete-remote-branch",
      );
      expect(result.remote).toBe("origin");
    });

    test("remote is optional (defaults applied downstream)", () => {
      const result = validateIpc(gitRemoteBranchDeleteSchema, { workspaceId: "ws-1", branch: "feature/foo" }, "test");
      expect(result.remote).toBeUndefined();
    });

    test("rejects branch starting with '-' (flag-injection guard)", () => {
      expect(() =>
        validateIpc(gitRemoteBranchDeleteSchema, { workspaceId: "ws-1", branch: "-rf", remote: "origin" }, "test"),
      ).toThrow();
    });

    test("rejects remote starting with '-' (flag-injection guard)", () => {
      expect(() =>
        validateIpc(
          gitRemoteBranchDeleteSchema,
          { workspaceId: "ws-1", branch: "feature/foo", remote: "--upload-pack=evil" },
          "test",
        ),
      ).toThrow();
    });
  });

  describe("gitBranchRenameSchema", () => {
    test("accepts both old and new name", () => {
      const result = validateIpc(
        gitBranchRenameSchema,
        { workspaceId: "ws-1", branch: "old-name", newName: "new-name" },
        "git:rename-branch",
      );
      expect(result.newName).toBe("new-name");
    });

    test("old branch is optional (renaming current branch)", () => {
      const result = validateIpc(gitBranchRenameSchema, { workspaceId: "ws-1", newName: "new-name" }, "test");
      expect(result.branch).toBeUndefined();
    });

    test("rejects newName starting with '-' (flag-injection guard)", () => {
      expect(() => validateIpc(gitBranchRenameSchema, { workspaceId: "ws-1", newName: "-D" }, "test")).toThrow();
    });

    test("rejects old branch starting with '-' (flag-injection guard)", () => {
      expect(() =>
        validateIpc(
          gitBranchRenameSchema,
          { workspaceId: "ws-1", branch: "--config=core.fsmonitor=evil.sh", newName: "ok" },
          "test",
        ),
      ).toThrow();
    });

    test("rejects missing newName", () => {
      expect(() => validateIpc(gitBranchRenameSchema, { workspaceId: "ws-1", branch: "old" }, "test")).toThrow();
    });
  });

  describe("gitCheckoutRemoteSchema", () => {
    test("accepts remoteBranch and optional localBranch", () => {
      const result = validateIpc(
        gitCheckoutRemoteSchema,
        { workspaceId: "ws-1", remoteBranch: "origin/feature", localBranch: "feature" },
        "git:checkout-remote-branch",
      );
      expect(result.remoteBranch).toBe("origin/feature");
      expect(result.localBranch).toBe("feature");
    });

    test("localBranch is optional (derived downstream)", () => {
      const result = validateIpc(
        gitCheckoutRemoteSchema,
        { workspaceId: "ws-1", remoteBranch: "origin/feature" },
        "test",
      );
      expect(result.localBranch).toBeUndefined();
    });

    test("rejects remoteBranch starting with '-' (flag-injection guard)", () => {
      expect(() =>
        validateIpc(gitCheckoutRemoteSchema, { workspaceId: "ws-1", remoteBranch: "-rf" }, "test"),
      ).toThrow();
    });

    test("rejects localBranch starting with '-' (flag-injection guard)", () => {
      expect(() =>
        validateIpc(
          gitCheckoutRemoteSchema,
          { workspaceId: "ws-1", remoteBranch: "origin/feature", localBranch: "-D" },
          "test",
        ),
      ).toThrow();
    });

    test("rejects missing remoteBranch", () => {
      expect(() => validateIpc(gitCheckoutRemoteSchema, { workspaceId: "ws-1" }, "test")).toThrow();
    });
  });

  describe("terminalResizeSchema", () => {
    test("accepts valid resize", () => {
      const result = validateIpc(terminalResizeSchema, { cols: 80, rows: 24 }, "test");
      expect(result.cols).toBe(80);
    });

    test("rejects non-integer cols", () => {
      expect(() => validateIpc(terminalResizeSchema, { cols: 80.5, rows: 24 }, "test")).toThrow();
    });

    test("rejects zero rows", () => {
      expect(() => validateIpc(terminalResizeSchema, { cols: 80, rows: 0 }, "test")).toThrow();
    });
  });

  describe("profileSchema", () => {
    test("accepts valid profile", () => {
      const result = validateIpc(profileSchema, { name: "Work" }, "test");
      expect(result.name).toBe("Work");
    });

    test("passes through extra fields", () => {
      const result = validateIpc(profileSchema, { name: "Work", color: "#ff0000" }, "test");
      expect(result.color).toBe("#ff0000");
    });
  });

  describe("worktreeSchema", () => {
    test("accepts valid worktree request", () => {
      const result = validateIpc(
        worktreeSchema,
        {
          workspaceId: "ws-1",
          name: "feature-branch",
        },
        "test",
      );
      expect(result.name).toBe("feature-branch");
    });

    test("rejects empty name", () => {
      expect(() =>
        validateIpc(
          worktreeSchema,
          {
            workspaceId: "ws-1",
            name: "",
          },
          "test",
        ),
      ).toThrow();
    });
  });

  describe("removeWorktreeSchema", () => {
    test("accepts valid remove request", () => {
      const result = validateIpc(
        removeWorktreeSchema,
        {
          workspaceId: "ws-1",
          worktreePath: "/path/to/tree",
        },
        "test",
      );
      expect(result.worktreePath).toBe("/path/to/tree");
    });

    test("deleteBranch defaults to undefined", () => {
      const result = validateIpc(
        removeWorktreeSchema,
        {
          workspaceId: "ws-1",
          worktreePath: "/path",
        },
        "test",
      );
      expect(result.deleteBranch).toBeUndefined();
    });
  });

  describe("dockerSessionSchema", () => {
    test("accepts valid docker session", () => {
      const result = validateIpc(
        dockerSessionSchema,
        {
          workspaceId: "ws-1",
          containerId: "abc123",
          mode: "shell",
        },
        "test",
      );
      expect(result.mode).toBe("shell");
    });
  });
});
