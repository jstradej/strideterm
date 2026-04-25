import { describe, expect, test } from "vitest";
import {
  validateIpc,
  workspaceSchema,
  azureCommentSchema,
  azureVoteSchema,
  azureThreadStatusSchema,
  gitPayloadSchema,
  gitDiffPreviewSchema,
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
