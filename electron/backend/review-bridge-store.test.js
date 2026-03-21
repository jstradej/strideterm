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

    // createDraftComment — new standalone comment (no thread)
    const draftCommentContext = await store.createDraftComment({
      prKey: "ado-main:repo-1:123",
      body: "Should we add a follow-up note about the missing loading-state test?",
      authorAgent: "human",
    });
    const draftComment = draftCommentContext?.comments.find((comment) => comment.commentKind === "draft");
    expect(draftComment).toMatchObject({
      status: "draft-ready",
      commentKind: "draft",
    });
    expect(draftComment?.payload?.questionBody).toContain("loading-state test");

    // createDraftComment auto-creates a draft
    const autoDraft = draftCommentContext?.drafts.find((draft) => draft.commentKey === draftComment?.commentKey);
    expect(autoDraft?.status).toBe("draft");
    expect(autoDraft?.body).toContain("loading-state test");

    // Overwriting with saveDraftResponse still works
    const draftCommentDraftContext = await store.saveDraftResponse({
      prKey: "ado-main:repo-1:123",
      commentKey: draftComment?.commentKey,
      body: "Yes. I would add a short regression note and ask for a focused test.",
      authorAgent: "codex",
    });
    const draftCommentDraft = draftCommentDraftContext?.drafts.find((draft) => draft.commentKey === draftComment?.commentKey);
    expect(draftCommentDraft?.status).toBe("draft");
    expect(draftCommentDraft?.body).toContain("regression note");

    await store.close();
  });

  test("createDraftComment reply to existing thread with autoQueue", async () => {
    const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-review-bridge-reply-"));
    tempPaths.push(rootPath);
    const store = await createReviewBridgeStore(rootPath);

    await store.syncPullRequest({
      provider: "azure-devops",
      prKey: "ado-main:repo-1:200",
      connectionId: "ado-main",
      repository: { id: "repo-1", name: "web-app" },
      pullRequest: { id: 200, title: "Add tests", status: "active" },
      role: "reviewer",
      threads: [
        {
          id: 50,
          status: "active",
          filePath: "/src/test.js",
          lineStart: 10,
          publishedDate: "2026-03-20T10:00:00.000Z",
          comments: [
            { id: 500, parentCommentId: 0, content: "Missing test coverage.", publishedDate: "2026-03-20T10:00:00.000Z", author: { displayName: "Reviewer" } },
          ],
        },
      ],
    });

    // Reply to thread 50 without autoQueue
    const replyContext = await store.createDraftComment({
      prKey: "ado-main:repo-1:200",
      body: "I'll add the missing tests.",
      threadId: 50,
      authorAgent: "human",
    });
    const replyDraft = replyContext?.drafts.find((d) => d.body.includes("missing tests"));
    expect(replyDraft).toBeTruthy();
    expect(replyDraft?.status).toBe("draft");
    expect(replyContext?.syncQueue?.filter((q) => q.status === "pending")).toHaveLength(0);

    // Reply to thread 50 with autoQueue
    const autoQueueContext = await store.createDraftComment({
      prKey: "ado-main:repo-1:200",
      body: "Actually, I added them already.",
      threadId: 50,
      authorAgent: "human",
      autoQueue: true,
    });
    const queuedDraft = autoQueueContext?.drafts.find((d) => d.body.includes("added them already"));
    expect(queuedDraft?.status).toBe("ready-to-sync");
    const pendingQueue = autoQueueContext?.syncQueue?.filter((q) => q.status === "pending");
    expect(pendingQueue).toHaveLength(1);

    // Publish pipeline works with auto-queued reply
    const publishedContext = await store.syncPendingDrafts("ado-main:repo-1:200", async (entry) => {
      expect(entry.remoteThreadId).toBe(50);
      expect(entry.body).toContain("added them already");
      return { remoteCommentId: 501 };
    });
    expect(publishedContext?.syncQueue?.[0]?.status).toBe("synced");

    await store.close();
  });
});
