import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, test, vi } from "vitest";
import {
  createReviewBridgeMcpHandlers,
  parseReviewBridgeMcpArgs,
  registerBasicReviewChangesTool,
} from "./review-bridge-mcp.js";
import { execFileText } from "./process-utils.js";

function createContext() {
  return {
    prKey: "ado-main:repo-1:123",
    comments: [
      {
        commentKey: "ado-main:repo-1:123:thread:10",
        commentKind: "answer-question",
        status: "ready-for-agent",
        priority: "high",
        title: "Review thread in src/app.js:12",
        summary: "Please clarify null handling.",
        displayIndex: 1,
        remoteThreadId: 10,
        payload: {
          filePath: "src/app.js",
          lineStart: 12,
        },
      },
      {
        commentKey: "ado-main:repo-1:123:local:1",
        commentKind: "local-comment",
        status: "ready-for-agent",
        priority: "medium",
        title: "Need extra follow-up",
        summary: "Check migration impact.",
        displayIndex: 2,
        remoteThreadId: null,
        payload: {
          questionBody: "Check migration impact.",
        },
      },
      {
        commentKey: "ado-main:repo-1:123:thread:11",
        commentKind: "answer-question",
        status: "dismissed",
        priority: "low",
        title: "Old thread",
        summary: "",
        displayIndex: 3,
        remoteThreadId: 11,
        payload: {},
      },
    ],
    threads: [
      {
        id: 10,
        status: "active",
        filePath: "src/app.js",
        lineStart: 12,
        comments: [
          {
            id: 1,
            content: "Please clarify null handling.",
            author: { displayName: "Reviewer" },
          },
        ],
      },
    ],
    drafts: [],
  };
}

describe("review bridge mcp handlers", () => {
  test("draft-only mode stores comments and replies locally without queueing", async () => {
    const context = createContext();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store: any = {
      getPullRequestContext: vi.fn(() => context),
      createDraftComment: vi.fn().mockResolvedValue(context),
      saveDraftResponse: vi.fn().mockResolvedValue(context),
      queueDraftResponse: vi.fn().mockResolvedValue(context),
    };
    const handlers = createReviewBridgeMcpHandlers({ store, prKey: context.prKey, draftOnly: true });
    await handlers.createDraftComment({ body: "Concrete defect", filePath: "src/app.js", lineNumber: 12 });
    await handlers.saveReviewDraft({ index: 1, body: "Local reply" });
    expect(store.createDraftComment).toHaveBeenCalledWith(expect.objectContaining({ autoQueue: false }));
    expect(store.saveDraftResponse).toHaveBeenCalledTimes(1);
    expect(store.queueDraftResponse).not.toHaveBeenCalled();
  });

  test("lists only active comments in order", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store: any = {
      getPullRequestContext: vi.fn(() => createContext()),
    };
    const handlers = createReviewBridgeMcpHandlers({
      store,
      prKey: "ado-main:repo-1:123",
    });

    const result = handlers.listReviewComments();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((result as any).structuredContent.comments).toHaveLength(2);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((result as any).structuredContent.comments[0]).toMatchObject({
      index: 1,
      commentKey: "ado-main:repo-1:123:thread:10",
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((result as any).structuredContent.comments[1]).toMatchObject({
      index: 2,
      commentKey: "ado-main:repo-1:123:local:1",
    });
  });

  test("resolves comment details by ordered index", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store: any = {
      getPullRequestContext: vi.fn(() => createContext()),
    };
    const handlers = createReviewBridgeMcpHandlers({
      store,
      prKey: "ado-main:repo-1:123",
    });

    const result = handlers.getReviewComment({ index: 2 });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((result as any).structuredContent.comment).toMatchObject({
      index: 2,
      commentKey: "ado-main:repo-1:123:local:1",
      commentKind: "local-comment",
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(((result as any).content[0] as any).text).toContain("Comment #2:");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(((result as any).content[0] as any).text).toContain("Local question");
  });

  test("saves drafts through the store using resolved comment keys", async () => {
    const nextContext = {
      ...createContext(),
      drafts: [
        {
          draftId: "draft-1",
          commentKey: "ado-main:repo-1:123:thread:10",
          status: "draft",
          body: "Looks good after the null guard.",
          authorAgent: "codex",
          needsHumanApproval: true,
          confidence: 0.7,
          updatedAt: "2026-03-18T12:00:00.000Z",
        },
      ],
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store: any = {
      getPullRequestContext: vi.fn(() => createContext()),
      saveDraftResponse: vi.fn().mockResolvedValue(nextContext),
      queueDraftResponse: vi.fn().mockResolvedValue(nextContext),
    };
    const handlers = createReviewBridgeMcpHandlers({
      store,
      prKey: "ado-main:repo-1:123",
    });

    const result = await handlers.saveReviewDraft({
      index: 1,
      body: "Looks good after the null guard.",
      authorAgent: "codex",
    });

    expect(store.saveDraftResponse).toHaveBeenCalledWith({
      prKey: "ado-main:repo-1:123",
      commentKey: "ado-main:repo-1:123:thread:10",
      body: "Looks good after the null guard.",
      authorAgent: "codex",
      confidence: null,
      needsHumanApproval: true,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((result as any).structuredContent.draft).toMatchObject({
      draftId: "draft-1",
      commentKey: "ado-main:repo-1:123:thread:10",
    });
  });

  test("edits a draft comment in place through the store", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store: any = {
      getPullRequestContext: vi.fn(() => createContext()),
      updateDraftComment: vi.fn().mockResolvedValue(createContext()),
    };
    const handlers = createReviewBridgeMcpHandlers({
      store,
      prKey: "ado-main:repo-1:123",
    });

    const result = await handlers.updateDraftComment({ index: 2, body: "Check the migration rollback too." });

    expect(store.updateDraftComment).toHaveBeenCalledWith({
      prKey: "ado-main:repo-1:123",
      commentKey: "ado-main:repo-1:123:local:1",
      body: "Check the migration rollback too.",
      title: "",
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(((result as any).content[0] as any).text).toContain("Updated draft comment #2");
  });

  test("deletes a local draft comment outright", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store: any = {
      getPullRequestContext: vi.fn(() => createContext()),
      deleteComment: vi.fn().mockResolvedValue(createContext()),
      deleteDraft: vi.fn(),
    };
    const handlers = createReviewBridgeMcpHandlers({
      store,
      prKey: "ado-main:repo-1:123",
    });

    const result = await handlers.deleteDraftComment({ index: 2 });

    expect(store.deleteComment).toHaveBeenCalledWith({
      prKey: "ado-main:repo-1:123",
      commentKey: "ado-main:repo-1:123:local:1",
    });
    expect(store.deleteDraft).not.toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((result as any).structuredContent.deleted).toBe("comment");
  });

  test("deletes only the draft reply when the target is a remote review thread", async () => {
    const context = {
      ...createContext(),
      drafts: [
        {
          draftId: "draft-1",
          commentKey: "ado-main:repo-1:123:thread:10",
          status: "draft",
          body: "Will fix.",
          authorAgent: "codex",
          needsHumanApproval: true,
          confidence: null,
          updatedAt: "2026-03-18T12:00:00.000Z",
        },
      ],
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store: any = {
      getPullRequestContext: vi.fn(() => context),
      deleteComment: vi.fn(),
      deleteDraft: vi.fn().mockResolvedValue(context),
    };
    const handlers = createReviewBridgeMcpHandlers({
      store,
      prKey: "ado-main:repo-1:123",
    });

    const result = await handlers.deleteDraftComment({ index: 1 });

    expect(store.deleteDraft).toHaveBeenCalledWith({
      prKey: "ado-main:repo-1:123",
      draftId: "draft-1",
    });
    // The reviewer's thread is not ours to delete.
    expect(store.deleteComment).not.toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((result as any).structuredContent.deleted).toBe("draft");
  });

  test("refuses to delete a remote review thread that carries no draft", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store: any = {
      getPullRequestContext: vi.fn(() => createContext()),
      deleteComment: vi.fn(),
      deleteDraft: vi.fn(),
    };
    const handlers = createReviewBridgeMcpHandlers({
      store,
      prKey: "ado-main:repo-1:123",
    });

    await expect(handlers.deleteDraftComment({ index: 1 })).rejects.toThrow(/remote review thread/u);
    expect(store.deleteComment).not.toHaveBeenCalled();
    expect(store.deleteDraft).not.toHaveBeenCalled();
  });
});

describe("parseReviewBridgeMcpArgs", () => {
  test("parses embedded review bridge mcp flags", () => {
    expect(
      parseReviewBridgeMcpArgs([
        ".",
        "--review-bridge-mcp",
        "--review-root",
        "C:/bridge",
        "--review-pr-key",
        "ado-main:repo-1:123",
      ]),
    ).toEqual({
      rootPath: "C:/bridge",
      prKey: "ado-main:repo-1:123",
      workspaceId: "",
      draftOnly: false,
      checkoutPath: "",
      expectedHead: "",
      baseCommit: "",
    });
  });

  test("enables the local-draft-only review mode", () => {
    expect(
      parseReviewBridgeMcpArgs([
        "--review-bridge-mcp",
        "--review-root",
        "C:/bridge",
        "--review-pr-key",
        "x",
        "--review-draft-only",
      ]),
    ).toMatchObject({ draftOnly: true });
  });
});

describe("basic review diff MCP tool", () => {
  test("serves a paged base-to-head diff from a divergent target without changing the checkout", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-review-diff-"));
    const git = (args: string[]) => execFileText("git", args, { cwd: root, timeout: 20_000 });
    const server = new McpServer({ name: "review-test", version: "1" });
    const client = new Client({ name: "review-test-client", version: "1" });
    try {
      await git(["init", "--initial-branch=main"]);
      await git(["config", "user.name", "Review Test"]);
      await git(["config", "user.email", "review-test@example.invalid"]);
      await fs.writeFile(path.join(root, "common.txt"), "common\n");
      await git(["add", "."]);
      await git(["commit", "-m", "common"]);
      await git(["checkout", "-b", "feature"]);
      await fs.writeFile(
        path.join(root, "feature.txt"),
        Array.from(
          { length: 100 },
          (_, index) => `feature-line-${index.toString().padStart(3, "0")} ${"x".repeat(20)}`,
        ).join("\n") + "\n",
      );
      await git(["add", "."]);
      await git(["commit", "-m", "feature"]);
      const head = (await git(["rev-parse", "HEAD"])).stdout.trim();
      await git(["checkout", "main"]);
      await fs.writeFile(path.join(root, "target-only.txt"), "target branch change\n");
      await git(["add", "."]);
      await git(["commit", "-m", "target-only"]);
      await git(["checkout", "feature"]);
      const mergeBase = (await git(["merge-base", "main", head])).stdout.trim();

      registerBasicReviewChangesTool(server, { checkoutPath: root, expectedHead: head, baseCommit: mergeBase });
      const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toEqual(["get_review_changes"]);

      const filesResult = CallToolResultSchema.parse(
        await client.callTool({ name: "get_review_changes", arguments: {} }),
      );
      const filesText = filesResult.content.find((content) => content.type === "text")?.text || "";
      expect(filesText).toContain("feature.txt");
      expect(filesText).not.toContain("target-only.txt");

      const first = CallToolResultSchema.parse(
        await client.callTool({
          name: "get_review_changes",
          arguments: { filePath: "feature.txt", offset: 0, limit: 500 },
        }),
      );
      const second = CallToolResultSchema.parse(
        await client.callTool({
          name: "get_review_changes",
          arguments: { filePath: "feature.txt", offset: 500, limit: 500 },
        }),
      );
      const firstPage = first.content.find((content) => content.type === "text")?.text || "";
      const secondPage = second.content.find((content) => content.type === "text")?.text || "";
      expect(firstPage).toContain("diff --git");
      expect(firstPage).not.toBe(secondPage);
      expect((first.structuredContent as { hasMore: boolean }).hasMore).toBe(true);
      expect((await git(["status", "--short"])).stdout).toBe("");
    } finally {
      await client.close().catch(() => {});
      await server.close().catch(() => {});
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
