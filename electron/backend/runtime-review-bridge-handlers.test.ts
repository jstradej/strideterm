import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AzureDevOpsManager } from "./azure-devops-manager.js";
import { createAzureApi } from "./azure-devops-api.js";
import { createReviewBridgeHandlers } from "./runtime-review-bridge-handlers.js";
import { createReviewGitService } from "./review-git/service.js";
import { createReviewBridgeStore } from "./review-bridge-store.js";

const tempPaths: string[] = [];
const openStores: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(openStores.splice(0).map((store) => store.close()));
  await Promise.all(tempPaths.splice(0).map((targetPath) => fs.rm(targetPath, { recursive: true, force: true })));
});

// review-bridge/pull-request/sync moved into slotAwareRoute this round: it
// publishes queued draft comments to the PR provider (an externally visible side
// effect), so it must refuse a prKey outside the caller viewer's profile
// (#32/#58/#63). The guard is delegated to the runtime's assertPrInViewerProfile.
describe("syncReviewBridgePullRequest — cross-profile viewer guard", () => {
  function makeHandlers() {
    const syncPendingDrafts = vi.fn(async () => {});
    const refreshAzure = vi.fn(async () => {});
    const refreshGitHub = vi.fn(async () => {});
    // Stand-in for runtime.assertPrInViewerProfile: PR "azure:pr1" is in p1.
    const assertPrInViewerProfile = vi.fn((prKey: string, windowId: string | undefined) => {
      const callerProfile = windowId === "remote:sess-b" ? "p2" : windowId === "remote:sess-a" ? "p1" : null;
      if (!callerProfile) return;
      if (prKey === "azure:pr1" && callerProfile !== "p1") {
        throw new Error(`Cross-profile refused: pull request ${prKey} is not in profile ${callerProfile}.`);
      }
    });
    const handlers = createReviewBridgeHandlers({
      azure: { addPullRequestComment: vi.fn(async () => {}), findSummary: () => null },
      github: { addPullRequestComment: vi.fn(async () => {}), findSummary: () => null },
      reviewBridgeStore: { getPullRequestContext: () => ({ provider: "azure-devops" }), syncPendingDrafts },
      getPayload: () => ({}),
      broadcastState: vi.fn(),
      refreshAzure,
      refreshGitHub,
      refreshGit: vi.fn(async () => {}),
      assertWorkspaceInViewerProfile: vi.fn(),
      assertPrInViewerProfile,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    return { handlers, syncPendingDrafts, assertPrInViewerProfile };
  }

  test("refuses to publish drafts for a PR outside the caller's profile", async () => {
    const { handlers, syncPendingDrafts } = makeHandlers();
    await expect(handlers.syncReviewBridgePullRequest({ prKey: "azure:pr1" }, "remote:sess-b")).rejects.toThrow(
      /Cross-profile/,
    );
    // The guard runs BEFORE any provider publish.
    expect(syncPendingDrafts).not.toHaveBeenCalled();
  });

  test("allows sync for the caller's own profile", async () => {
    const { handlers, syncPendingDrafts } = makeHandlers();
    await handlers.syncReviewBridgePullRequest({ prKey: "azure:pr1" }, "remote:sess-a");
    expect(syncPendingDrafts).toHaveBeenCalledTimes(1);
  });

  test("desktop IPC (no viewer id) is unaffected", async () => {
    const { handlers, syncPendingDrafts } = makeHandlers();
    await handlers.syncReviewBridgePullRequest({ prKey: "azure:pr1" });
    expect(syncPendingDrafts).toHaveBeenCalledTimes(1);
  });

  /**
   * Publishing through "Push & publish" now runs as a review Git operation; the
   * push itself is stubbed (nothing to push), so what is under test is only how
   * a queued draft's inline location reaches the provider.
   */
  async function pushAndPublish({
    store,
    state,
    azure,
    github,
  }: {
    store: unknown;
    state: { workspaces: unknown[] };
    azure: Record<string, unknown>;
    github: Record<string, unknown>;
  }) {
    const upToDate = { status: "up-to-date", message: "same", headSha: "", previousHeadSha: "" };
    const manager = (provider: Record<string, unknown>) => ({
      buildReviewSubject: () => ({}),
      pushReviewWorkspace: vi.fn(async () => upToDate),
      ...provider,
    });
    const service = createReviewGitService({
      getState: () => state as never,
      azure: manager(azure),
      github: manager(github),
      reviewBridgeStore: store as never,
      refreshGit: async () => {},
      refreshAzure: async () => {},
      refreshGitHub: async () => {},
      broadcastState: () => {},
      emit: () => {},
      auditStores: {},
      log: { info() {}, warn() {}, error() {} },
    });
    const started = service.start(
      { kind: "push-and-publish", workspaceId: "review-workspace" },
      { profileId: "default", requester: { source: "ui" } },
    );
    await service.operations.idle();
    return service.lookup(started.operationId, "default", "review-workspace") as {
      status: string;
      operation: { result: { publish: { published: string[]; failed: unknown[] } } };
    };
  }

  test.each([
    { publishMode: "sync", lineSide: "old" },
    { publishMode: "sync", lineSide: "new" },
    { publishMode: "push", lineSide: "old" },
    { publishMode: "push", lineSide: "new" },
  ] as const)(
    "preserves inline comment location through real store, $publishMode path, and ADO request ($lineSide side)",
    async ({ publishMode, lineSide }) => {
      const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-review-publish-location-"));
      tempPaths.push(rootPath);
      const prKey = "ado-main:repo-1:42";
      const connection = {
        id: "ado-main",
        orgUrl: "https://dev.azure.com/acme",
        login: "reviewer@example.com",
        tokenRef: "ado-token",
      };
      const store = await createReviewBridgeStore(rootPath);
      openStores.push(store);
      await store.syncPullRequest({
        provider: "azure-devops",
        prKey,
        connectionId: connection.id,
        project: { id: "project-1", name: "Platform" },
        repository: { id: "repo-1", name: "web-app" },
        pullRequest: { id: 42, title: "Inline location", status: "active", sourceRefName: "refs/heads/feature" },
        threads: [],
      });
      await store.createDraftComment({
        prKey,
        body: "The parser can throw here.",
        filePath: "src/parser.ts",
        lineNumber: 42,
        lineSide,
        autoQueue: true,
      });

      const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
      const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
        return { ok: true, status: 200, json: async () => ({ id: 900 }) } as Response;
      });
      const manager = Object.create(AzureDevOpsManager.prototype) as Record<string, unknown>;
      manager.api = createAzureApi(fetchImpl as typeof fetch);
      manager.ensurePullRequestDetail = async () => ({
        connectionId: connection.id,
        project: { id: "project-1", name: "Platform" },
        repository: { id: "repo-1", name: "web-app" },
        pullRequest: { id: 42 },
      });
      manager.findAzureConnection = () => connection;
      manager.credentialStore = { getSecret: () => "test-token" };
      manager.setAuditContext = vi.fn();

      const azure = {
        addPullRequestComment: (input: Parameters<AzureDevOpsManager["addPullRequestComment"]>[0]) =>
          AzureDevOpsManager.prototype.addPullRequestComment.call(manager, input),
        findSummary: () => null,
      };
      const state = {
        workspaces: [
          {
            id: "review-workspace",
            cwd: rootPath,
            review: {
              provider: "azure-devops",
              prKey,
              pullRequest: { sourceRefName: "refs/heads/feature" },
            },
          },
        ],
      };

      let published = 0;
      if (publishMode === "sync") {
        const handlers = createReviewBridgeHandlers({
          azure,
          github: { addPullRequestComment: vi.fn(), findSummary: () => null },
          reviewBridgeStore: store,
          getState: () => state,
          getPayload: () => ({}),
          broadcastState: vi.fn(),
          refreshAzure: vi.fn(async () => {}),
          refreshGitHub: vi.fn(async () => {}),
          refreshGit: vi.fn(async () => {}),
          assertWorkspaceInViewerProfile: vi.fn(),
          assertPrInViewerProfile: vi.fn(),
          git: { execGit: vi.fn(async () => ({ stdout: "0" })) },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);
        await handlers.syncReviewBridgePullRequest({ prKey });
      } else {
        const looked = await pushAndPublish({
          store,
          state,
          azure,
          github: { addPullRequestComment: vi.fn(), findSummary: () => null },
        });
        published = looked.operation.result.publish.published.length;
        // The push and the comment are reported separately, and nothing failed.
        expect(looked.operation.result.publish.failed).toEqual([]);
      }

      const publishedContext = await store.getPullRequestContext(prKey);
      await store.close();
      expect(requests).toHaveLength(1);
      expect(requests[0].url).toContain("/pullRequests/42/threads?");
      expect(requests[0].body.threadContext).toMatchObject({
        filePath: "/src/parser.ts",
        ...(lineSide === "old"
          ? {
              leftFileStart: { line: 42, offset: 1 },
              leftFileEnd: { line: 42, offset: 1 },
            }
          : {
              rightFileStart: { line: 42, offset: 1 },
              rightFileEnd: { line: 42, offset: 1 },
            }),
      });
      expect(publishedContext?.comments).toHaveLength(0);
      expect(publishedContext?.syncQueue).toHaveLength(0);
      if (publishMode === "push") expect(published).toBe(1);
    },
  );

  test.each(["sync", "push"] as const)(
    "hands the inline comment location to GitHub through the real store and %s path",
    async (publishMode) => {
      const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-review-publish-github-"));
      tempPaths.push(rootPath);
      const prKey = "gh-main:acme:web:42";
      const store = await createReviewBridgeStore(rootPath);
      openStores.push(store);
      await store.syncPullRequest({
        provider: "github",
        prKey,
        connectionId: "gh-main",
        repository: { id: "", name: "web" },
        pullRequest: { id: 42, title: "Inline location", status: "open", sourceRefName: "feature" },
        threads: [],
      });
      await store.createDraftComment({
        prKey,
        body: "The parser can throw here.",
        filePath: "src/parser.ts",
        lineNumber: 42,
        lineSide: "old",
        autoQueue: true,
      });

      const addPullRequestComment = vi.fn(async () => {});
      const state = {
        workspaces: [
          {
            id: "review-workspace",
            cwd: rootPath,
            review: { provider: "github", prKey, pullRequest: { sourceRefName: "feature" } },
          },
        ],
      };
      const github = { addPullRequestComment, findSummary: () => null };

      if (publishMode === "sync") {
        const handlers = createReviewBridgeHandlers({
          azure: { addPullRequestComment: vi.fn(), findSummary: () => null },
          github,
          reviewBridgeStore: store,
          getState: () => state,
          getPayload: () => ({}),
          broadcastState: vi.fn(),
          refreshAzure: vi.fn(async () => {}),
          refreshGitHub: vi.fn(async () => {}),
          refreshGit: vi.fn(async () => {}),
          assertWorkspaceInViewerProfile: vi.fn(),
          assertPrInViewerProfile: vi.fn(),
          git: { execGit: vi.fn(async () => ({ stdout: "0" })) },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);
        await handlers.syncReviewBridgePullRequest({ prKey });
      } else {
        await pushAndPublish({
          store,
          state,
          azure: { addPullRequestComment: vi.fn(), findSummary: () => null },
          github,
        });
      }
      await store.close();

      expect(addPullRequestComment).toHaveBeenCalledTimes(1);
      expect(addPullRequestComment).toHaveBeenCalledWith({
        prKey,
        body: "The parser can throw here.",
        threadId: null,
        filePath: "src/parser.ts",
        lineNumber: 42,
        lineSide: "old",
      });
    },
  );
});
