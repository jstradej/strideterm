import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { afterEach, describe, expect, test } from "vitest";
import { createReviewBridgeStore } from "./review-bridge-store.js";

const tempPaths = [];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((targetPath) => fs.rm(targetPath, { recursive: true, force: true })));
});

describe("review bridge store", () => {
  test("imports a pull request into sqlite and writes per-pr exports", async () => {
    const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-review-bridge-"));
    tempPaths.push(rootPath);
    const store = await createReviewBridgeStore(rootPath);

    const context = await store.syncPullRequest({
      provider: "azure-devops",
      prKey: "ado-main:repo-1:123",
      connectionId: "ado-main",
      existingWorkspaceId: "workspace-main",
      reviewWorkspaceId: "workspace-review",
      project: { id: "project-1", name: "Platform" },
      repository: { id: "repo-1", name: "web-app" },
      pullRequest: {
        id: 123,
        title: "Fix login redirect",
        status: "active",
        sourceRefName: "refs/heads/feature/login-fix",
        targetRefName: "refs/heads/main",
      },
      role: "reviewer",
      lastRemoteActivityAt: "2026-03-18T08:30:00.000Z",
      lastSeenActivityAt: "2026-03-18T08:00:00.000Z",
      changedFiles: [
        { changeType: "edit", path: "/src/auth.js" },
      ],
      localChangedFiles: [
        { changeType: "M", path: "src/auth.js" },
      ],
      threads: [
        {
          id: 10,
          status: "active",
          filePath: "/src/auth.js",
          lineStart: 42,
          lineEnd: 42,
          publishedDate: "2026-03-18T08:10:00.000Z",
          lastUpdatedDate: "2026-03-18T08:20:00.000Z",
          comments: [
            {
              id: 100,
              parentCommentId: 0,
              content: "Please clarify this condition.",
              publishedDate: "2026-03-18T08:20:00.000Z",
              lastUpdatedDate: "2026-03-18T08:20:00.000Z",
              commentType: "text",
              author: {
                id: "reviewer-1",
                displayName: "Reviewer",
                uniqueName: "reviewer@example.com",
              },
            },
          ],
        },
      ],
    });

    expect(context).toBeTruthy();
    expect(context?.briefMarkdownPath).toContain(path.join("exports", "azure-devops", "ado-main", "repo-1", "pr-123"));
    expect(context?.comments).toHaveLength(1);
    expect(context?.comments[0]).toMatchObject({
      status: "ready-for-agent",
      title: "Review thread in /src/auth.js:42",
    });

    const briefJson = JSON.parse(await fs.readFile(context.briefJsonPath, "utf8"));
    const briefMarkdown = await fs.readFile(context.briefMarkdownPath, "utf8");

    expect(briefJson.pullRequest.title).toBe("Fix login redirect");
    expect(briefJson.threads[0].comments[0].content).toContain("clarify");
    expect(briefMarkdown).toContain("Read comments here, prepare local drafts");
    expect(briefMarkdown).toContain("Please clarify this condition.");

    const reopenedContext = store.getPullRequestContext("ado-main:repo-1:123");
    expect(reopenedContext?.databasePath).toBe(path.join(rootPath, "review-bridge.db"));

    await store.markPullRequestSeen("ado-main:repo-1:123", "2026-03-18T08:30:00.000Z");
    const updatedContext = store.getPullRequestContext("ado-main:repo-1:123");
    expect(updatedContext?.lastSeenActivityAt).toBe("2026-03-18T08:30:00.000Z");

    const draftedContext = await store.saveDraftResponse({
      prKey: "ado-main:repo-1:123",
      commentKey: "ado-main:repo-1:123:thread:10",
      body: "I will simplify the condition and add a guard clause.",
      authorAgent: "codex",
    });
    expect(draftedContext?.drafts).toHaveLength(1);
    expect(draftedContext?.drafts[0]).toMatchObject({
      status: "draft",
      authorAgent: "codex",
    });

    const queuedContext = await store.queueDraftResponse({
      prKey: "ado-main:repo-1:123",
      draftId: draftedContext?.drafts[0]?.draftId,
    });
    expect(queuedContext?.syncQueue).toHaveLength(1);
    expect(queuedContext?.syncQueue[0].status).toBe("pending");

    const syncedContext = await store.syncPendingDrafts("ado-main:repo-1:123", async (entry) => {
      expect(entry.remoteThreadId).toBe(10);
      expect(entry.parentCommentId).toBe(100);
      expect(entry.body).toContain("guard clause");
      return { remoteCommentId: 101 };
    });
    expect(syncedContext?.drafts[0].status).toBe("synced");
    expect(syncedContext?.comments[0].status).toBe("synced");
    expect(syncedContext?.syncQueue[0].status).toBe("synced");

    const localCommentContext = await store.createLocalComment({
      prKey: "ado-main:repo-1:123",
      body: "Should we add a follow-up note about the missing loading-state test?",
      authorAgent: "human",
    });
    const localComment = localCommentContext?.comments.find((comment) => comment.commentKind === "local-comment");
    expect(localComment).toMatchObject({
      status: "ready-for-agent",
      commentKind: "local-comment",
    });
    expect(localComment?.payload?.questionBody).toContain("loading-state test");

    const localCommentDraftContext = await store.saveDraftResponse({
      prKey: "ado-main:repo-1:123",
      commentKey: localComment?.commentKey,
      body: "Yes. I would add a short regression note and ask for a focused test.",
      authorAgent: "codex",
    });
    const localCommentDraft = localCommentDraftContext?.drafts.find((draft) => draft.commentKey === localComment?.commentKey);
    expect(localCommentDraft?.status).toBe("draft");

    await store.close();
  });
});
