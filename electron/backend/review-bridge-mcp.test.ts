import { describe, expect, test, vi } from "vitest";
import { createReviewBridgeMcpHandlers, parseReviewBridgeMcpArgs } from "./review-bridge-mcp.js";

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
    });
  });
});
