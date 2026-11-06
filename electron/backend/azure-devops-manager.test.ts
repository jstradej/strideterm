import path from "node:path";
import os from "node:os";
import { describe, expect, test, vi } from "vitest";
import {
  AzureDevOpsManager,
  carryOverCodeSnippets,
  createPullRequestKey,
  normalizeConnectionInput,
  normalizeRemoteUrl,
  stripRefsPrefix,
} from "./azure-devops-manager.js";
import { buildPullRequestSummary } from "./azure-devops-pr-summary.js";
import { isRemoteOnConnectionHost } from "./azure-devops-utils.js";

describe("isRemoteOnConnectionHost", () => {
  test.each([
    ["https://dev.azure.com/org", "https://dev.azure.com/org/p/_git/r", true],
    ["https://dev.azure.com/org", "https://org.visualstudio.com/p/_git/r", true],
    ["https://tfs.example.com/tfs", "https://tfs.example.com/tfs/c/p/_git/r", true],
    ["https://dev.azure.com/org", "https://evil-visualstudio.com/p/_git/r", false],
    ["https://dev.azure.com/org", "https://devXazure.com/p/_git/r", false],
    ["https://dev.azure.com/org", "http://dev.azure.com/org/p/_git/r", false],
    ["https://tfs.example.com/tfs", "https://attacker.invalid/r", false],
  ])("org %s, remote %s -> %s", (orgUrl, remoteUrl, expected) => {
    expect(isRemoteOnConnectionHost({ orgUrl }, remoteUrl)).toBe(expected);
  });
});

function createCredentialStore(secrets: Record<string, string> = {}) {
  return {
    getSecret(ref: string) {
      return secrets[ref] || "";
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createReviewStore(initial: any = {}) {
  const state = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    trackedPullRequests: initial.trackedPullRequests || ({} as Record<string, any>),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    connections: initial.connections || ({} as Record<string, any>),
  };
  return {
    getState() {
      return state;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getTrackedPullRequest(key: any) {
      return state.trackedPullRequests[key] || null;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async upsertTrackedPullRequest(key: any, patch: any) {
      state.trackedPullRequests[key] = {
        ...(state.trackedPullRequests[key] || {}),
        ...patch,
      };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async upsertConnectionState(connectionId: any, patch: any) {
      state.connections[connectionId] = {
        ...(state.connections[connectionId] || {}),
        ...patch,
      };
    },
  };
}

function createFetchStub() {
  return vi.fn(async (url, options = {}) => {
    const href = String(url);
    if (href.endsWith("/_apis/git/repositories?api-version=7.1")) {
      return {
        ok: true,
        json: async () => ({
          value: [
            {
              id: "repo-1",
              name: "web-app",
              remoteUrl: "https://dev.azure.com/acme/Platform/_git/web-app",
            },
          ],
        }),
      };
    }
    if (href.includes("/_apis/git/repositories/repo-1/pullrequests") && options.method === "POST") {
      return {
        ok: true,
        json: async () => ({
          pullRequestId: 124,
          title: "Create PR",
          _links: { web: { href: "https://dev.azure.com/acme/Platform/_git/web-app/pullrequest/124" } },
        }),
      };
    }
    if (href.includes("/_apis/projects")) {
      return {
        ok: true,
        json: async () => ({
          value: [{ id: "project-1", name: "Platform", description: "Platform", state: "wellFormed" }],
        }),
      };
    }
    if (href.includes("/Platform/_apis/git/pullrequests")) {
      return {
        ok: true,
        json: async () => ({
          value: [
            {
              pullRequestId: 123,
              title: "Fix login redirect",
              description: "Body",
              status: "active",
              mergeStatus: "succeeded",
              isDraft: false,
              sourceRefName: "refs/heads/feature/login-fix",
              targetRefName: "refs/heads/main",
              creationDate: "2026-03-17T08:00:00.000Z",
              lastMergeSourceCommit: {
                commitId: "commit-1",
                committer: { date: "2026-03-17T09:00:00.000Z" },
              },
              createdBy: {
                id: "author-1",
                displayName: "Alice",
                uniqueName: "alice@example.com",
              },
              repository: {
                id: "repo-1",
                name: "web-app",
                remoteUrl: "https://dev.azure.com/acme/Platform/_git/web-app",
                project: { id: "project-1", name: "Platform" },
              },
              reviewers: [
                { id: "reviewer-1", displayName: "Me", uniqueName: "me@example.com", vote: 0, isRequired: true },
              ],
              _links: {
                web: { href: "https://dev.azure.com/acme/Platform/_git/web-app/pullrequest/123" },
              },
            },
          ],
        }),
      };
    }
    if (/\/pullRequests\/[^/?]+\?/.test(href)) {
      return {
        ok: true,
        json: async () => ({ status: "completed", lastMergeSourceCommit: { commitId: "abc123" } }),
      };
    }
    if (href.includes("/threads?")) {
      return {
        ok: true,
        json: async () => ({
          value: [
            {
              id: 10,
              status: "active",
              publishedDate: "2026-03-17T09:30:00.000Z",
              lastUpdatedDate: "2026-03-17T09:35:00.000Z",
              threadContext: {
                filePath: "/src/auth.js",
                rightFileStart: { line: 12 },
                rightFileEnd: { line: 12 },
              },
              comments: [
                {
                  id: 100,
                  parentCommentId: 0,
                  content: "Please re-check this branch.",
                  publishedDate: "2026-03-17T09:35:00.000Z",
                  lastUpdatedDate: "2026-03-17T09:35:00.000Z",
                  commentType: "text",
                  author: { id: "author-2", displayName: "Reviewer", uniqueName: "reviewer@example.com" },
                },
              ],
            },
          ],
        }),
      };
    }
    if (href.includes("/statuses?")) {
      return {
        ok: true,
        json: async () => ({
          value: [
            {
              id: 501,
              state: "failed",
              description: "JFrog gradle and Sonar analyze build and publish / JFrog Maven",
              targetUrl: "https://dev.azure.com/acme/build/501",
              context: {
                genre: "Build",
                name: "Core JUnit Tests",
              },
            },
          ],
        }),
      };
    }
    if (href.includes("/_apis/policy/evaluations?")) {
      return {
        ok: true,
        json: async () => ({
          value: [
            {
              evaluationId: "policy-1",
              status: "rejected",
              configuration: {
                id: 77,
                isBlocking: false,
                type: { displayName: "Build" },
                settings: { displayName: "Core JUnit Tests" },
              },
              context: {
                buildDefinitionName: "Core JUnit Tests",
                buildNumber: "20260313.8",
                errorMessage: "Build failed",
                targetUrl: "https://dev.azure.com/acme/build/501",
              },
            },
          ],
        }),
      };
    }
    if (href.includes("/iterations?")) {
      return {
        ok: true,
        json: async () => ({
          value: [{ id: 1 }, { id: 2 }],
        }),
      };
    }
    if (href.includes("/iterations/2/changes")) {
      return {
        ok: true,
        json: async () => ({
          changeEntries: [
            {
              changeType: "edit",
              item: { path: "/src/auth.js", objectId: "blob-1" },
            },
          ],
        }),
      };
    }
    if (href.includes("/reviewers/")) {
      return {
        ok: true,
        json: async () => ({ ok: true }),
      };
    }
    if (href.includes("/comments?") || href.endsWith("/threads?api-version=7.1") || href.includes("/threads/10?")) {
      return {
        ok: true,
        json: async () => ({ ok: true }),
      };
    }

    throw new Error(`Unexpected URL: ${href}`);
  });
}

function createManager({
  trackedPullRequests = {},
  secrets = { "cred:ado-main": "pat-123" },
  auditLogStore = null as { logEntry(entry: Record<string, unknown>): void } | null,
  execFileTextImpl = vi.fn().mockResolvedValue({ stdout: "", stderr: "" }),
  reviewBridgeStore = {
    syncPullRequest: vi.fn(),
    markPullRequestSeen: vi.fn(),
  },
} = {}) {
  const reviewStore = createReviewStore({ trackedPullRequests });
  const fetchImpl = createFetchStub();
  const manager = new AzureDevOpsManager({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    credentialStore: createCredentialStore(secrets) as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    reviewStore: reviewStore as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    reviewBridgeStore: reviewBridgeStore as any,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    execFileTextImpl,
    auditLogStore,
    now: () => new Date("2026-03-17T10:00:00.000Z").getTime(),
  });
  manager.supportsGitConfigEnv = async () => true;
  return { manager, fetchImpl, reviewStore, execFileTextImpl, reviewBridgeStore };
}

const connection = {
  id: "ado-main",
  label: "Acme",
  orgUrl: "https://dev.azure.com/acme",
  login: "me@example.com",
  tokenRef: "cred:ado-main",
  enabled: true,
  projectFilters: ["Platform"],
  repositoryFilters: [],
  pollSeconds: 120,
  reviewRoot: path.join(os.tmpdir(), "strideterm-azure-review-tests"),
};

describe("AzureDevOpsManager", () => {
  test("fetches one PR status directly without loading its threads", async () => {
    const { manager, fetchImpl } = createManager();
    manager.setSnapshot({
      connections: [{ ...connection, profileId: "default" }],
      reviewActivity: [],
      pullRequests: {},
      trackedPullRequests: {},
      inbox: { needsMyReview: [], myPullRequests: [], recentlyUpdated: [], needsAttention: [] },
      sync: { running: false, lastStartedAt: null, lastCompletedAt: null },
    });

    await expect(manager.getPullRequestStatus("ado-main", "Platform", "repo-1", 123)).resolves.toEqual({
      status: "completed",
      lastMergeSourceCommitId: "abc123",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0][0])).toContain("/Platform/_apis/git/repositories/repo-1/pullRequests/123");
  });

  test("reports a PR the server answers 404 for as not-found, and other failures as errors", async () => {
    const { manager, fetchImpl } = createManager();
    manager.setSnapshot({
      connections: [{ ...connection, profileId: "default" }],
      reviewActivity: [],
      pullRequests: {},
      trackedPullRequests: {},
      inbox: { needsMyReview: [], myPullRequests: [], recentlyUpdated: [], needsAttention: [] },
      sync: { running: false, lastStartedAt: null, lastCompletedAt: null },
    });
    // A real HTTP error response, so the status goes through requestJson's own error path.
    const httpError = (status: number) =>
      new Response(JSON.stringify({ message: `HTTP ${status}` }), { status }) as unknown as Awaited<
        ReturnType<typeof fetchImpl>
      >;
    fetchImpl.mockImplementationOnce(async () => httpError(404));
    await expect(manager.getPullRequestStatus("ado-main", "Platform", "repo-1", 404)).resolves.toEqual({
      status: "not-found",
      lastMergeSourceCommitId: "",
    });
    fetchImpl.mockImplementationOnce(async () => httpError(500));
    await expect(manager.getPullRequestStatus("ado-main", "Platform", "repo-1", 500)).rejects.toThrow("(500)");
  });

  test("verifies a connection by listing projects", async () => {
    const { manager } = createManager();

    const result = await manager.verifyConnection({
      orgUrl: connection.orgUrl,
      login: connection.login,
      pat: "pat-123",
    });

    expect(result.ok).toBe(true);
    expect(result.projects[0].name).toBe("Platform");
  });

  test("syncs reviewer PRs and computes attention", async () => {
    const prKey = createPullRequestKey("ado-main", "repo-1", 123);
    const { manager, reviewBridgeStore } = createManager({
      trackedPullRequests: {
        [prKey]: {
          lastSeenActivityAt: "2026-03-17T08:30:00.000Z",
          lastVoteSignature: "reviewer-1:0:0",
          lastMergeStatus: "queued",
        },
      },
    });

    const snapshot = (await manager.sync({
      connections: [connection],
      workspaces: [],
      gitSnapshots: {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: test assertion cast on untyped manager result
    })) as any;

    expect(snapshot.inbox.needsMyReview).toHaveLength(1);
    expect(snapshot.inbox.needsMyReview[0]).toMatchObject({
      hasAttention: true,
      attentionReason: "Your review",
      newCommentsCount: 1,
      unresolvedThreadCount: 1,
    });
    expect(snapshot.inbox.needsMyReview[0].threads[0]).toMatchObject({
      filePath: "/src/auth.js",
      lineStart: 12,
      lineEnd: 12,
    });
    expect(reviewBridgeStore.syncPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        prKey,
        provider: "azure-devops",
      }),
    );
    expect(snapshot.connections[0].status).toBe("ok");
  });

  test("marks pull request as seen and clears attention", async () => {
    const { manager, reviewBridgeStore } = createManager();
    await manager.sync({
      connections: [connection],
      workspaces: [],
      gitSnapshots: {},
    });

    const prKey = createPullRequestKey("ado-main", "repo-1", 123);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const snapshot = (await manager.markPullRequestSeen(prKey)) as any;

    // The review is still owed, so opening the PR keeps its state-based attention.
    expect(snapshot.pullRequests[prKey]).toMatchObject({
      hasAttention: true,
      attentionReason: "Your review",
      newCommentsCount: 0,
    });
    expect(snapshot.inbox.needsAttention).toHaveLength(1);
    expect(reviewBridgeStore.markPullRequestSeen).toHaveBeenCalledWith(prKey, expect.any(String));
  });

  test("loads changed files and local diff details", async () => {
    const execFileTextImpl = vi.fn().mockResolvedValueOnce({ stdout: "M src/auth.js\n", stderr: "" });
    const { manager, reviewBridgeStore } = createManager({ execFileTextImpl });
    await manager.sync({
      connections: [connection],
      workspaces: [
        {
          id: "workspace-1",
          cwd: "/repo",
          review: {
            provider: "azure-devops",
            prKey: createPullRequestKey("ado-main", "repo-1", 123),
          },
        },
      ],
      gitSnapshots: {},
    });

    const detail = (await manager.ensurePullRequestDetail(createPullRequestKey("ado-main", "repo-1", 123), {
      workspaces: [
        {
          id: "workspace-1",
          cwd: "/repo",
          review: {
            provider: "azure-devops",
            prKey: createPullRequestKey("ado-main", "repo-1", 123),
          },
        },
      ],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: test assertion cast on untyped manager result
    })) as any;

    expect(detail.changedFiles[0].path).toBe("/src/auth.js");
    expect(detail.localChangedFiles[0]).toEqual({
      changeType: "M",
      path: "src/auth.js",
    });
    expect(detail.checks).toMatchObject({
      failedCount: 2,
      optionalFailedCount: 1,
    });
    expect(detail.checks.items[0]).toMatchObject({
      name: "Core JUnit Tests",
      state: "failed",
    });
    expect(reviewBridgeStore.syncPullRequest).toHaveBeenLastCalledWith(
      expect.objectContaining({
        prKey: createPullRequestKey("ado-main", "repo-1", 123),
        changedFiles: [expect.objectContaining({ path: "/src/auth.js" })],
        localChangedFiles: [expect.objectContaining({ path: "src/auth.js" })],
        checks: expect.objectContaining({
          failedCount: 2,
        }),
      }),
    );
  });

  test("a poll sync keeps the code snippets the detail fetch added (no strip-and-restore blink)", async () => {
    const prKey = createPullRequestKey("ado-main", "repo-1", 123);
    const execFileTextImpl = vi.fn(async (_bin: string, args: string[]) =>
      args.includes("--unified=4")
        ? { stdout: "@@ -10,3 +10,4 @@\n line10\n line11\n+line12\n line13\n", stderr: "" }
        : { stdout: "", stderr: "" },
    );
    const { manager } = createManager({ execFileTextImpl });
    const workspaces = [{ id: "workspace-1", cwd: "/repo", review: { provider: "azure-devops", prKey } }];
    await manager.sync({ connections: [connection], workspaces, gitSnapshots: {} });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: untyped snapshot in a test
    const detail = (await manager.ensurePullRequestDetail(prKey, { workspaces, force: true })) as any;
    const snippet = detail.threads[0].codeSnippet;
    expect(snippet).toContain("line12");

    await manager.sync({ connections: [connection], workspaces, gitSnapshots: {} });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: untyped snapshot in a test
    const after = (manager.getSnapshot() as any).pullRequests[prKey];
    expect(after.threads[0].codeSnippet).toBe(snippet);
  });

  test("a thread whose anchor moved does not keep a snippet of the old place", () => {
    const before = [{ id: 7, filePath: "/a.js", lineStart: 12, lineEnd: 12, codeSnippet: "old" }];
    expect(carryOverCodeSnippets(before, [{ id: 7, filePath: "/a.js", lineStart: 12, lineEnd: 12 }])).toEqual([
      { id: 7, filePath: "/a.js", lineStart: 12, lineEnd: 12, codeSnippet: "old" },
    ]);
    expect(carryOverCodeSnippets(before, [{ id: 7, filePath: "/a.js", lineStart: 30, lineEnd: 30 }])).toEqual([
      { id: 7, filePath: "/a.js", lineStart: 30, lineEnd: 30 },
    ]);
    expect(carryOverCodeSnippets(before, [{ id: 8, filePath: "/a.js", lineStart: 12, lineEnd: 12 }])).toEqual([
      { id: 8, filePath: "/a.js", lineStart: 12, lineEnd: 12 },
    ]);
  });

  test("a conflicting PR carries Azure's conflicting files; a listing that fails is unknown, not empty", async () => {
    const prKey = createPullRequestKey("ado-main", "repo-1", 123);
    const { manager, fetchImpl } = createManager();
    await manager.sync({ connections: [connection], workspaces: [], gitSnapshots: {} });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: untyped snapshot in a test
    const detailBefore = (await manager.ensurePullRequestDetail(prKey, { force: true })) as any;
    expect(detailBefore.serverConflicts).toEqual([]);
    expect(fetchImpl.mock.calls.some((call) => String(call[0]).includes("/conflicts?"))).toBe(false);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: untyped snapshot in a test
    const snapshot = manager.getSnapshot() as any;
    const pr = snapshot.pullRequests[prKey];
    manager.setSnapshot({
      ...snapshot,
      pullRequests: {
        ...snapshot.pullRequests,
        [prKey]: { ...pr, pullRequest: { ...pr.pullRequest, mergeStatus: "conflicts" } },
      },
    });
    const base = fetchImpl.getMockImplementation()!;
    let conflictsOk = true;
    fetchImpl.mockImplementation((async (url: unknown, options?: unknown) => {
      if (String(url).includes("/pullRequests/123/conflicts?")) {
        if (!conflictsOk) throw new Error("503 Service Unavailable");
        return {
          ok: true,
          json: async () => ({
            value: [
              { conflictPath: "/pom.xml", conflictType: "editEdit" },
              { conflictPath: "/streams/docker-compose-streams.yml", conflictType: "editEdit" },
            ],
          }),
        };
      }
      return base(url, options as never);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: the stub's inferred union has no conflicts shape
    }) as any);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: untyped snapshot in a test
    const listed = (await manager.ensurePullRequestDetail(prKey, { force: true })) as any;
    expect(listed.serverConflicts).toEqual([
      { path: "pom.xml", type: "editEdit" },
      { path: "streams/docker-compose-streams.yml", type: "editEdit" },
    ]);

    conflictsOk = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: untyped snapshot in a test
    const failed = (await manager.ensurePullRequestDetail(prKey, { force: true })) as any;
    expect(failed.serverConflicts).toBeNull();
  });

  test("creates a managed review workspace when none exists", async () => {
    const execFileTextImpl = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    const { manager } = createManager({ execFileTextImpl });
    await manager.sync({
      connections: [connection],
      workspaces: [],
      gitSnapshots: {},
    });

    const result = (await manager.openReviewWorkspace({
      state: {
        tabTemplates: [
          { id: "shell", title: "Shell", command: "" },
          { id: "claude", title: "Claude Code", command: "claude" },
          { id: "codex", title: "Codex", command: "codex" },
        ],
        workspaces: [
          {
            id: "azure-root",
            kind: "azure",
            profileId: "default",
            cwd: "C:/reviews",
            panels: [
              { id: "shell-template", title: "Shell", command: "" },
              { id: "docs-template", title: "Docs", command: "https://dev.azure.com/acme" },
            ],
          },
        ],
      },
      prKey: createPullRequestKey("ado-main", "repo-1", 123),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: test assertion cast on untyped manager result
    })) as any;

    expect(result.created).toBe(true);
    expect(result.workspace.review.provider).toBe("azure-devops");
    expect(result.workspace.review.parentWorkspaceId).toBe("azure-root");
    expect(result.workspace.cwd).toContain(path.join("reviews", "ado-main"));
    expect(result.workspace.cwd).not.toContain(path.join("Platform", "web-app", "pr-123-review"));
    expect(result.workspace.panels).toHaveLength(2);
    expect(result.workspace.panels[0].title).toBe("Shell");
    expect(result.workspace.panels[1].command).toBe("https://dev.azure.com/acme");
    expect(execFileTextImpl.mock.calls.some((call) => call[1].includes("clone"))).toBe(true);
  });

  test("copies Azure parent tabs into new review workspaces including command parameters", async () => {
    const execFileTextImpl = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    const { manager } = createManager({ execFileTextImpl });
    await manager.sync({
      connections: [connection],
      workspaces: [],
      gitSnapshots: {},
    });

    const result = (await manager.openReviewWorkspace({
      state: {
        tabTemplates: [],
        workspaces: [
          {
            id: "azure-root",
            kind: "azure",
            profileId: "default",
            cwd: "C:/reviews",
            panels: [
              { id: "shell-template", title: "Shell", command: "" },
              { id: "claude-template", title: "Claude Code", command: "claude --model haiku --verbose" },
              {
                id: "codex-template",
                title: "Codex",
                command: 'codex -s danger-full-access -c model_reasoning_effort="high"',
              },
            ],
          },
        ],
      },
      prKey: createPullRequestKey("ado-main", "repo-1", 123),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: test assertion cast on untyped manager result
    })) as any;

    expect(result.workspace.panels).toHaveLength(3);
    expect(result.workspace.panels[1]).toMatchObject({
      title: "Claude Code",
      command: "claude --model haiku --verbose",
    });
    expect(result.workspace.panels[2]).toMatchObject({
      title: "Codex",
      command: 'codex -s danger-full-access -c model_reasoning_effort="high"',
    });
  });

  test("builds stable managed review paths for matching persisted workspaces", async () => {
    const { manager } = createManager();
    await manager.sync({
      connections: [connection],
      workspaces: [
        {
          id: "azure-root",
          kind: "azure",
          profileId: "default",
          cwd: "C:/reviews",
          panels: [],
        },
      ],
      gitSnapshots: {},
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const summary = manager.getSnapshot().pullRequests[createPullRequestKey("ado-main", "repo-1", 123)] as any;

    const paths = manager.buildManagedReviewPaths(summary, {
      profileId: "default",
      workspaces: [
        {
          id: "azure-root",
          kind: "azure",
          profileId: "default",
          cwd: "C:/reviews",
          panels: [],
        },
      ],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;

    expect(paths).toMatchObject({
      parentWorkspaceId: "azure-root",
    });
    expect(paths!.rootPath).toContain(path.join("reviews", "ado-main"));
    expect(paths!.rootPath).toContain("pr-123");
    expect(paths!.cacheRepoPath).toContain(path.join("repos", "ado-main"));
    expect(paths!.cacheRepoPath).toContain("repo-1");
  });

  test("derives a clone URL when Azure omits repository.remoteUrl", async () => {
    const execFileTextImpl = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    const { manager } = createManager({ execFileTextImpl });

    manager.setSnapshot({
      connections: [connection],
      inbox: {
        needsMyReview: [],
        myPullRequests: [],
        recentlyUpdated: [],
        needsAttention: [],
      },
      trackedPullRequests: {},
      pullRequests: {
        [createPullRequestKey("ado-main", "repo-1", 123)]: {
          prKey: createPullRequestKey("ado-main", "repo-1", 123),
          connectionId: "ado-main",
          project: { id: "project-1", name: "Platform" },
          repository: { id: "repo-1", name: "web-app", remoteUrl: "" },
          pullRequest: {
            id: 123,
            title: "Fix login redirect",
            sourceRefName: "refs/heads/feature/login-fix",
            targetRefName: "refs/heads/main",
          },
          role: "reviewer",
          changedFiles: [],
        },
      },
      sync: {
        running: false,
        lastStartedAt: null,
        lastCompletedAt: null,
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    await manager.openReviewWorkspace({
      state: {
        tabTemplates: [],
        workspaces: [],
      },
      prKey: createPullRequestKey("ado-main", "repo-1", 123),
    });

    const cloneCall = execFileTextImpl.mock.calls.find((call) => call[1].includes("clone"));
    expect(cloneCall?.[1]).toContain("https://dev.azure.com/acme/Platform/_git/web-app");
  });

  test("sanitizes inherited git environment before spawning git", async () => {
    const previousGitDir = process.env.GIT_DIR;
    const previousGitWorkTree = process.env.GIT_WORK_TREE;
    process.env.GIT_DIR = "";
    process.env.GIT_WORK_TREE = "";
    const execFileTextImpl = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    const { manager } = createManager({ execFileTextImpl });

    try {
      await manager.sync({
        connections: [connection],
        workspaces: [],
        gitSnapshots: {},
      });
      await manager.openReviewWorkspace({
        state: {
          tabTemplates: [],
          workspaces: [],
        },
        prKey: createPullRequestKey("ado-main", "repo-1", 123),
      });
    } finally {
      if (previousGitDir === undefined) {
        delete process.env.GIT_DIR;
      } else {
        process.env.GIT_DIR = previousGitDir;
      }
      if (previousGitWorkTree === undefined) {
        delete process.env.GIT_WORK_TREE;
      } else {
        process.env.GIT_WORK_TREE = previousGitWorkTree;
      }
    }

    const gitCall = execFileTextImpl.mock.calls.find((call) => call[0] === "git" && Array.isArray(call[1]));
    expect(gitCall?.[2]?.env?.GIT_DIR).toBeUndefined();
    expect(gitCall?.[2]?.env?.GIT_WORK_TREE).toBeUndefined();
    if (process.platform === "win32") {
      expect(gitCall?.[1]).toContain("core.longpaths=true");
    }
  });

  test("uses shortened cache and review paths for managed workspaces", async () => {
    const execFileTextImpl = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    const { manager } = createManager({ execFileTextImpl });
    await manager.sync({
      connections: [connection],
      workspaces: [],
      gitSnapshots: {},
    });

    const result = (await manager.openReviewWorkspace({
      state: {
        tabTemplates: [],
        workspaces: [],
      },
      prKey: createPullRequestKey("ado-main", "repo-1", 123),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: test assertion cast on untyped manager result
    })) as any;

    const cloneCall = execFileTextImpl.mock.calls.find((call) => call[1].includes("clone"));
    const worktreeCall = execFileTextImpl.mock.calls.find(
      (call) => call[1].includes("worktree") && call[1].includes("add"),
    );
    expect(cloneCall?.[1]?.at(-1)).toContain(path.join("repos", "ado-main"));
    expect(cloneCall?.[1]?.at(-1)).toContain("repo-1");
    expect(cloneCall?.[1]?.at(-1)).not.toContain(path.join("Platform", "web-app"));
    expect(worktreeCall?.[1]).toContain(`pr-123-feature-login-fix`);
    expect(worktreeCall?.[1]).not.toContain("pr-123-review");
    expect(result.workspace.cwd).toContain(path.join("reviews", "ado-main"));
    expect(result.workspace.cwd).toContain("pr-123");
  });

  test("turns Windows long-path git failures into a readable message", async () => {
    const execFileTextImpl = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "", stderr: "" }) // clone
      .mockResolvedValueOnce({ stdout: "", stderr: "" }) // fetch
      .mockResolvedValueOnce({ stdout: "", stderr: "" }) // worktree prune
      .mockRejectedValueOnce(new Error("not a ref")) // show-ref (branch does not exist)
      .mockRejectedValueOnce({
        stderr: [
          "Preparing worktree (new branch 'pr-123-feature')",
          "error: unable to create file some/really/deep/path",
          "Filename too long",
          "fatal: Could not reset index file to revision 'HEAD'.",
        ].join("\n"),
      });
    const { manager } = createManager({ execFileTextImpl });
    await manager.sync({
      connections: [connection],
      workspaces: [],
      gitSnapshots: {},
    });

    await expect(
      manager.openReviewWorkspace({
        state: {
          tabTemplates: [],
          workspaces: [],
        },
        prKey: createPullRequestKey("ado-main", "repo-1", 123),
      }),
    ).rejects.toThrow("Review workspace could not be created because some checkout paths are too long.");
  });

  test("attaches author PRs to an existing matching workspace", async () => {
    createManager({
      secrets: { "cred:ado-main": "pat-123" },
    });
    const { summary } = buildPullRequestSummary({
      connection,
      pr: {
        pullRequestId: 123,
        title: "Fix login redirect",
        description: "Body",
        status: "active",
        mergeStatus: "succeeded",
        isDraft: false,
        sourceRefName: "refs/heads/feature/login-fix",
        targetRefName: "refs/heads/main",
        creationDate: "2026-03-17T08:00:00.000Z",
        lastMergeSourceCommit: {
          commitId: "commit-1",
          committer: { date: "2026-03-17T09:00:00.000Z" },
        },
        createdBy: {
          id: "me-1",
          displayName: "Me",
          uniqueName: "me@example.com",
        },
        repository: {
          id: "repo-1",
          name: "web-app",
          remoteUrl: "https://dev.azure.com/acme/Platform/_git/web-app",
          project: { id: "project-1", name: "Platform" },
        },
        reviewers: [],
        _links: {
          web: { href: "https://dev.azure.com/acme/Platform/_git/web-app/pullrequest/123" },
        },
      },
      projectName: "Platform",
      threads: [],
      tracked: {},
      workspaces: [{ id: "workspace-main", cwd: "/repo" }],
      gitSnapshots: {
        "workspace-main": {
          branch: "feature/login-fix",
          remotes: {
            origin: "https://dev.azure.com/acme/Platform/_git/web-app",
          },
        },
      },
    });

    expect(summary.role).toBe("author");
    expect(summary.existingWorkspaceId).toBe("workspace-main");
  });

  test("does not offer an author PR attach target when the checkout is on another branch", async () => {
    createManager({
      secrets: { "cred:ado-main": "pat-123" },
    });
    const { summary } = buildPullRequestSummary({
      connection,
      pr: {
        pullRequestId: 123,
        title: "Fix login redirect",
        status: "active",
        sourceRefName: "refs/heads/feature/login-fix",
        targetRefName: "refs/heads/main",
        createdBy: { id: "me-1", displayName: "Me", uniqueName: "me@example.com" },
        repository: {
          id: "repo-1",
          name: "web-app",
          remoteUrl: "https://dev.azure.com/acme/Platform/_git/web-app",
          project: { id: "project-1", name: "Platform" },
        },
        reviewers: [],
      },
      projectName: "Platform",
      threads: [],
      tracked: {},
      workspaces: [{ id: "workspace-main", cwd: "/repo" }],
      gitSnapshots: {
        "workspace-main": {
          // Same repository, unrelated branch — attaching here would turn a
          // normal dev workspace into a PR review workspace.
          branch: "feature/something-else",
          remotes: { origin: "https://dev.azure.com/acme/Platform/_git/web-app" },
        },
      },
    });

    expect(summary.role).toBe("author");
    expect(summary.existingWorkspaceId).toBe("");
  });

  test("fails clearly when a matched workspace has no cwd", async () => {
    const { manager } = createManager();

    manager.setSnapshot({
      connections: [connection],
      inbox: {
        needsMyReview: [],
        myPullRequests: [],
        recentlyUpdated: [],
        needsAttention: [],
      },
      trackedPullRequests: {},
      pullRequests: {
        [createPullRequestKey("ado-main", "repo-1", 123)]: {
          prKey: createPullRequestKey("ado-main", "repo-1", 123),
          connectionId: "ado-main",
          project: { id: "project-1", name: "Platform" },
          repository: { id: "repo-1", name: "web-app", remoteUrl: "https://dev.azure.com/acme/Platform/_git/web-app" },
          pullRequest: {
            id: 123,
            title: "Fix login redirect",
            sourceRefName: "refs/heads/feature/login-fix",
            targetRefName: "refs/heads/main",
          },
          role: "author",
          existingWorkspaceId: "workspace-bad",
          changedFiles: [],
        },
      },
      sync: {
        running: false,
        lastStartedAt: null,
        lastCompletedAt: null,
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    await expect(
      manager.openReviewWorkspace({
        state: {
          tabTemplates: [],
          workspaces: [
            {
              id: "workspace-bad",
              name: "Broken workspace",
              cwd: "",
            },
          ],
        },
        prKey: createPullRequestKey("ado-main", "repo-1", 123),
      }),
    ).rejects.toThrow('Matched workspace "Broken workspace" does not have a working directory.');
  });

  test("openReviewWorkspace lands the new review on the connection's profile, not windowSlots[0]", async () => {
    // Multi-window: windowSlots[0]=default, windowSlots[1]=profile-b. The
    // connection lives on profile-b. Without the fix, openReviewWorkspace
    // reads activeProfile from windowSlots[0] (= "default") and creates the
    // review workspace on "default", invisible from profile-b's sidebar.
    const profileBConnection = { ...connection, id: "ado-b", profileId: "profile-b", tokenRef: "cred:ado-b" };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: createManager.secrets has a strict literal type; widening is fine in test scope
    const { manager } = createManager({ secrets: { "cred:ado-b": "pat-b" } as any });
    await manager.sync({
      connections: [profileBConnection],
      workspaces: [],
      gitSnapshots: {},
    });
    const result = (await manager.openReviewWorkspace({
      state: {
        tabTemplates: [],
        windowSlots: [{ profileId: "default" }, { profileId: "profile-b" }],
        workspaces: [
          {
            id: "azure-root-b",
            kind: "azure",
            profileId: "profile-b",
            cwd: "C:/reviews-b",
            panels: [{ id: "shell-template", title: "Shell", command: "" }],
          },
        ],
      },
      prKey: createPullRequestKey("ado-b", "repo-1", 123),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: test assertion cast on untyped manager result
    })) as any;

    expect(result.created).toBe(true);
    expect(result.workspace.profileId).toBe("profile-b");
    expect(result.workspace.review.parentWorkspaceId).toBe("azure-root-b");
  });

  test("sends comment and vote requests", async () => {
    const auditEntries: Record<string, unknown>[] = [];
    const { manager, fetchImpl } = createManager({ auditLogStore: { logEntry: (entry) => auditEntries.push(entry) } });
    await manager.sync({
      connections: [connection],
      workspaces: [],
      gitSnapshots: {},
    });

    const prKey = createPullRequestKey("ado-main", "repo-1", 123);
    await manager.addPullRequestComment({
      prKey,
      content: "LGTM",
      filePath: "src/example.ts",
      lineNumber: 8,
      lineSide: "old",
    });
    await manager.setPullRequestVote({ prKey, vote: 10 });

    expect(
      fetchImpl.mock.calls.some(
        ([url, options]) => String(url).includes("/threads?api-version=7.1") && options.method === "POST",
      ),
    ).toBe(true);
    const createdThread = JSON.parse(
      String(
        fetchImpl.mock.calls.find(
          ([url, options]) => String(url).includes("/threads?api-version=7.1") && options.method === "POST",
        )?.[1].body,
      ),
    ) as { threadContext?: unknown };
    expect(createdThread.threadContext).toMatchObject({
      filePath: "/src/example.ts",
      leftFileStart: { line: 8, offset: 1 },
      leftFileEnd: { line: 8, offset: 1 },
    });
    expect(
      fetchImpl.mock.calls.some(
        ([url, options]) => String(url).includes("/reviewers/reviewer-1") && options.method === "PUT",
      ),
    ).toBe(true);
    expect(auditEntries.filter((entry) => entry.category === "write")).toMatchObject([
      {
        operation: "createThread",
        connectionId: "ado-main",
        success: true,
        userInitiated: true,
      },
      {
        operation: "setVote",
        connectionId: "ado-main",
        success: true,
        userInitiated: true,
      },
    ]);
  });

  test("records failed comment, vote, and thread-status provider writes exactly once", async () => {
    const auditEntries: Record<string, unknown>[] = [];
    const { manager, fetchImpl } = createManager({
      auditLogStore: { logEntry: (entry) => auditEntries.push(entry) },
    });
    await manager.sync({ connections: [connection], workspaces: [], gitSnapshots: {} });
    const baseFetch = fetchImpl.getMockImplementation()!;
    fetchImpl.mockImplementation(async (url, options) => {
      const method = (options as RequestInit | undefined)?.method || "GET";
      if (method !== "GET") {
        return {
          ok: false,
          status: 403,
          json: async () => ({ ok: false }),
          text: async () => JSON.stringify({ message: "Provider permission denied" }),
        };
      }
      return baseFetch!(url, options);
    });
    const prKey = createPullRequestKey("ado-main", "repo-1", 123);

    await expect(manager.addPullRequestComment({ prKey, content: "Comment." })).rejects.toThrow(/403/);
    await expect(manager.setPullRequestVote({ prKey, vote: 10 })).rejects.toThrow(/403/);
    await expect(manager.updateThreadStatus({ prKey, threadId: 10, status: "fixed" })).rejects.toThrow(/403/);

    expect(auditEntries.filter((entry) => entry.category === "write")).toMatchObject([
      { operation: "createThread", connectionId: "ado-main", success: false, userInitiated: true, statusCode: 403 },
      { operation: "setVote", connectionId: "ado-main", success: false, userInitiated: true, statusCode: 403 },
      { operation: "updateThread", connectionId: "ado-main", success: false, userInitiated: true, statusCode: 403 },
    ]);
    expect(auditEntries.filter((entry) => entry.category === "write")).toHaveLength(3);
  });

  test.each([
    ["src/example.ts", "/src/example.ts"],
    ["/src/example.ts", "/src/example.ts"],
    ["src\\nested\\example.ts", "/src/nested/example.ts"],
  ])("roots inline comment path %s as %s for ADO", async (filePath, expected) => {
    const { manager, fetchImpl } = createManager();
    await manager.sync({
      connections: [connection],
      workspaces: [],
      gitSnapshots: {},
    });

    await manager.addPullRequestComment({
      prKey: createPullRequestKey("ado-main", "repo-1", 123),
      content: "LGTM",
      filePath,
      lineNumber: 8,
    });

    const createdThread = JSON.parse(
      String(
        fetchImpl.mock.calls.find(
          ([url, options]) => String(url).includes("/threads?api-version=7.1") && options.method === "POST",
        )?.[1].body,
      ),
    ) as { threadContext?: { filePath?: string } };
    expect(createdThread.threadContext?.filePath).toBe(expected);
  });

  test("stale PR resolution marks a PR completed when the detail check 404s", async () => {
    const prKey = createPullRequestKey("ado-main", "repo-1", 999);
    const { manager, fetchImpl } = createManager();
    const baseImpl = fetchImpl.getMockImplementation()!;
    fetchImpl.mockImplementation(async (url, options) => {
      if (String(url).includes("/repositories/repo-1/pullRequests/999")) {
        throw new Error("Azure DevOps request failed (404): PR not found");
      }
      return baseImpl(url, options);
    });

    const snapshot = (await manager.sync({
      connections: [connection],
      workspaces: [
        {
          id: "workspace-stale-404",
          cwd: "/repo",
          review: {
            provider: "azure-devops",
            connectionId: "ado-main",
            project: { id: "project-1", name: "Platform" },
            repository: { id: "repo-1", name: "web-app" },
            pullRequest: { id: 999, status: "active" },
            prKey,
          },
        },
      ],
      gitSnapshots: {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: test assertion cast on untyped manager result
    })) as any;

    expect(snapshot.pullRequests[prKey].pullRequest.status).toBe("completed");
    // The workspace's own review metadata is the only id source here (no prior
    // summary existed). Dropping it makes the review pane render "PR #" and
    // files every terminal PR under a shared "pr-unknown" export directory.
    expect(snapshot.pullRequests[prKey].pullRequest.id).toBe(999);
  });

  test("stale PR resolution leaves a PR unresolved when the detail check fails transiently", async () => {
    const prKey = createPullRequestKey("ado-main", "repo-1", 999);
    const { manager, fetchImpl } = createManager();
    const baseImpl = fetchImpl.getMockImplementation()!;
    const warnSpy = vi.spyOn(manager.log, "warn").mockImplementation(() => {});
    fetchImpl.mockImplementation(async (url, options) => {
      if (String(url).includes("/repositories/repo-1/pullRequests/999")) {
        throw new Error("network error: ECONNRESET");
      }
      return baseImpl(url, options);
    });

    const workspaces = [
      {
        id: "workspace-stale-transient",
        cwd: "/repo",
        review: {
          provider: "azure-devops",
          connectionId: "ado-main",
          project: { id: "project-1", name: "Platform" },
          repository: { id: "repo-1", name: "web-app" },
          pullRequest: { id: 999, status: "active" },
          prKey,
        },
      },
    ];

    const snapshot = (await manager.sync({
      connections: [connection],
      workspaces,
      gitSnapshots: {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: test assertion cast on untyped manager result
    })) as any;

    // No detail was ever resolved for this PR, so it must not be marked completed.
    expect(snapshot.pullRequests[prKey]).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      "stale PR check failed, will retry next poll",
      expect.objectContaining({ prKey, err: expect.stringContaining("ECONNRESET") }),
    );

    const detailCallsFor999 = () =>
      fetchImpl.mock.calls.filter(([url]) => String(url).includes("/repositories/repo-1/pullRequests/999")).length;
    expect(detailCallsFor999()).toBe(1);

    // A second sync retries the check instead of staying permanently unresolved.
    const secondSnapshot = (await manager.sync({
      connections: [connection],
      workspaces,
      gitSnapshots: {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: test assertion cast on untyped manager result
    })) as any;

    expect(detailCallsFor999()).toBe(2);
    expect(secondSnapshot.pullRequests[prKey]).toBeUndefined();
  });
});

describe("azure manager helpers", () => {
  test("normalizeConnectionInput extracts project and repository hints from project URLs", () => {
    const connection = normalizeConnectionInput({
      orgUrl: "https://devops.example.com/projects/CORE/ACME_CORE",
      projectFilters: [],
      repositoryFilters: [],
    });

    expect(connection.orgUrl).toBe("https://devops.example.com/projects/CORE");
    expect(connection.projectFilters).toEqual(["ACME_CORE"]);
    expect(connection.repositoryFilters).toEqual([]);
  });

  test("normalizeConnectionInput keeps cloud-style project URLs at organization scope", () => {
    const connection = normalizeConnectionInput({
      orgUrl: "https://dev.azure.com/acme/projects/Platform/web-app",
      projectFilters: [],
      repositoryFilters: [],
    });

    expect(connection.orgUrl).toBe("https://dev.azure.com/acme");
    expect(connection.projectFilters).toEqual(["Platform"]);
    expect(connection.repositoryFilters).toEqual(["web-app"]);
  });

  test("normalizeRemoteUrl strips .git and casing", () => {
    expect(normalizeRemoteUrl("HTTPS://dev.azure.com/acme/Platform/_git/web-app.git")).toBe(
      "https://dev.azure.com/acme/platform/_git/web-app",
    );
  });

  test("stripRefsPrefix trims refs/heads", () => {
    expect(stripRefsPrefix("refs/heads/feature/test")).toBe("feature/test");
  });
});

describe("AzureDevOpsManager openQuickFixWorkspace", () => {
  test("clones the URL the connection lists for the repository, never the one the caller sent, with a host-scoped token", async () => {
    const execFileTextImpl = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    const { manager } = createManager({ execFileTextImpl });
    await manager.sync({ connections: [connection], workspaces: [], gitSnapshots: {} });

    const result = (await manager.openQuickFixWorkspace({
      state: { tabTemplates: [{ id: "shell", title: "Shell", command: "" }], workspaces: [] },
      connectionId: "ado-main",
      projectName: "Platform",
      repositoryId: "repo-1",
      repositoryName: "ignored-name",
      remoteUrl: "https://attacker.invalid/x.git",
      baseBranch: "main",
      newBranchName: "fix-attacker",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: test assertion cast on untyped manager result
    })) as any;

    const clone = execFileTextImpl.mock.calls.find((call) => call[1].includes("clone"));
    expect(clone?.[1]).toContain("https://dev.azure.com/acme/Platform/_git/web-app");
    expect(JSON.stringify(execFileTextImpl.mock.calls)).not.toContain("attacker.invalid");
    expect(result.workspace.quickfix.remoteUrl).toBe("https://dev.azure.com/acme/Platform/_git/web-app");
    expect(result.workspace.quickfix.repositoryName).toBe("web-app");
    const carriers = [...(clone?.[1] ?? []), ...Object.entries(clone?.[2]?.env ?? {}).flat()].map(String);
    expect(carriers.some((item) => item.startsWith("http.https://dev.azure.com/.extraheader"))).toBe(true);
    expect(carriers).not.toContain("http.extraheader");
  });

  test("refuses a repository the connection does not list, without running git", async () => {
    const execFileTextImpl = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    const { manager } = createManager({ execFileTextImpl });
    await manager.sync({ connections: [connection], workspaces: [], gitSnapshots: {} });

    await expect(
      manager.openQuickFixWorkspace({
        state: { tabTemplates: [], workspaces: [] },
        connectionId: "ado-main",
        projectName: "Platform",
        repositoryId: "not-listed",
        repositoryName: "web-app",
        remoteUrl: "https://attacker.invalid/x.git",
        baseBranch: "main",
        newBranchName: "fix-1",
      }),
    ).rejects.toThrow(/was not found in project Platform/);
    expect(execFileTextImpl).not.toHaveBeenCalled();
  });

  test.each([true, false])("creates a quickfix workspace using the parent opt-in default (%s)", async (parentOptIn) => {
    const execFileTextImpl = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    const { manager } = createManager({ execFileTextImpl });
    await manager.sync({ connections: [connection], workspaces: [], gitSnapshots: {} });

    const result = (await manager.openQuickFixWorkspace({
      state: {
        tabTemplates: [{ id: "shell", title: "Shell", command: "" }],
        workspaces: [
          {
            id: "azure-root",
            kind: "azure",
            profileId: "default",
            cwd: "C:/reviews",
            internalMcpEnabled: parentOptIn,
            panels: [{ id: "shell-template", title: "Shell", command: "" }],
          },
        ],
      },
      connectionId: "ado-main",
      projectName: "Platform",
      repositoryId: "repo-1",
      repositoryName: "web-app",
      remoteUrl: "https://dev.azure.com/acme/Platform/_git/web-app",
      baseBranch: "main",
      newBranchName: "fix-123",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: test assertion cast on untyped manager result
    })) as any;

    expect(result.parentWorkspaceId).toBe("azure-root");
    expect(result.workspace.name).toBe("fix-123");
    expect(result.workspace.profileId).toBe("default");
    expect(result.workspace.internalMcpEnabled).toBe(parentOptIn);
    expect(result.workspace.cwd).toContain(path.join("quickfix", "ado-main"));
    expect(result.workspace.review).toMatchObject({
      provider: "azure-devops",
      prKey: "",
      connectionId: "ado-main",
      role: "author",
      checkout: { mode: "managed-worktree" },
    });
    expect(result.workspace.quickfix).toMatchObject({
      connectionId: "ado-main",
      projectName: "Platform",
      repositoryId: "repo-1",
      repositoryName: "web-app",
      baseBranch: "main",
      parentWorkspaceId: "azure-root",
    });
    const worktreeCall = execFileTextImpl.mock.calls.find(
      (call) => call[1].includes("worktree") && call[1].includes("add"),
    );
    expect(worktreeCall?.[1]).toContain("fix-123");
  });

  test("refuses when the caller's profile doesn't match the connection's profile", async () => {
    const profileBConnection = { ...connection, id: "ado-b", profileId: "profile-b", tokenRef: "cred:ado-b" };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: createManager.secrets has a strict literal type; widening is fine in test scope
    const { manager } = createManager({ secrets: { "cred:ado-b": "pat-b" } as any });
    await manager.sync({ connections: [profileBConnection], workspaces: [], gitSnapshots: {} });

    await expect(
      manager.openQuickFixWorkspace({
        state: { tabTemplates: [], workspaces: [] },
        connectionId: "ado-b",
        projectName: "Platform",
        repositoryId: "repo-1",
        repositoryName: "web-app",
        remoteUrl: "https://dev.azure.com/acme/Platform/_git/web-app",
        baseBranch: "main",
        newBranchName: "fix-123",
        callerProfileId: "default",
      }),
    ).rejects.toThrow(/Cross-profile refused.*profile-b.*default/s);
  });

  test("surfaces a clear error when the branch already exists", async () => {
    const execFileTextImpl = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "", stderr: "" }) // clone
      .mockResolvedValueOnce({ stdout: "", stderr: "" }) // fetch
      .mockRejectedValueOnce({ stderr: "fatal: a branch named 'fix-123' already exists" }); // worktree add
    const { manager } = createManager({ execFileTextImpl });
    await manager.sync({ connections: [connection], workspaces: [], gitSnapshots: {} });

    await expect(
      manager.openQuickFixWorkspace({
        state: { tabTemplates: [], workspaces: [] },
        connectionId: "ado-main",
        projectName: "Platform",
        repositoryId: "repo-1",
        repositoryName: "web-app",
        remoteUrl: "https://dev.azure.com/acme/Platform/_git/web-app",
        baseBranch: "main",
        newBranchName: "fix-123",
      }),
    ).rejects.toThrow('Branch "fix-123" already exists. Choose a different name.');
  });
});

// fetchReviewWorkspace/rebaseReviewWorkspace/pushReviewWorkspace were hoisted onto
// BaseProviderManager and previously had test coverage only through a bare
// BaseProviderManager test double (base-manager.test.ts), never through a real
// AzureDevOpsManager instance — these confirm the connection's `login` (Azure-only,
// unlike GitHub) and PAT are threaded through correctly by the real subclass.
describe("AzureDevOpsManager fetchReviewWorkspace / rebaseReviewWorkspace / pushReviewWorkspace", () => {
  test("fetchReviewWorkspace resolves the connection and threads its login + PAT through to runGit", async () => {
    const execFileTextImpl = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    const { manager } = createManager({ execFileTextImpl });
    await manager.sync({ connections: [connection], workspaces: [], gitSnapshots: {} });

    await manager.fetchReviewWorkspace({
      workspace: { id: "review-ws-1", cwd: "/repo", review: { connectionId: "ado-main" } },
    });

    const fetchCall = execFileTextImpl.mock.calls.find(
      (call) => call[0] === "git" && call[1].includes("fetch") && call[1].includes("origin"),
    );
    expect(fetchCall).toBeDefined();
    expect(fetchCall![2]).toMatchObject({ cwd: "/repo" });
    // git >= 2.31: the header is in the child's environment, not on its command line.
    expect(fetchCall![1].some((a: string) => a.includes("http.extraheader"))).toBe(false);
    const header = fetchCall![2].env.GIT_CONFIG_VALUE_0;
    const decoded = Buffer.from(header.replace("AUTHORIZATION: Basic ", ""), "base64").toString("utf8");
    expect(decoded).toBe("me@example.com:pat-123");
  });

  test("push and rebase go through the shared review Git engine and refuse an unverifiable source", async () => {
    const execFileTextImpl = vi.fn(async (_bin: string, args: string[]) => {
      if (args.includes("symbolic-ref")) return { stdout: "pr-123-feature-login-fix", stderr: "" };
      if (args.includes("rev-parse") && args.includes("HEAD"))
        return { stdout: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", stderr: "" };
      if (args.includes("rev-parse")) return { stdout: ".git", stderr: "" };
      return { stdout: "", stderr: "" };
    });
    const { manager } = createManager();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (manager as any).execFileText = execFileTextImpl;
    await manager.sync({ connections: [connection], workspaces: [], gitSnapshots: {} });

    const workspace = {
      id: "review-ws-1",
      cwd: "/repo",
      review: {
        connectionId: "ado-main",
        pullRequest: { id: 123, sourceRefName: "refs/heads/feature/login-fix", targetRefName: "refs/heads/main" },
      },
    };

    // No source repository was ever captured for this review, so a push cannot be
    // verified against anything — it must stop before any git write.
    const pushed = await manager.pushReviewWorkspace({ workspace, force: true });
    expect(pushed).toMatchObject({ status: "blocked", code: "source-unverified" });
    expect(execFileTextImpl.mock.calls.some((call) => call[1].includes("push"))).toBe(false);
  });
});

describe("createPullRequestForWorkspace — cross-profile connection guard", () => {
  test("refuses when the connection belongs to a different profile than the workspace", async () => {
    const { manager } = createManager();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (manager as any).findAzureConnection = () => ({
      id: "ado-1",
      profileId: "profile-a",
      tokenRef: "cred:ado-main",
      orgUrl: "https://dev.azure.com/acme",
    });

    await expect(
      manager.createPullRequestForWorkspace({
        remoteUrl: "https://dev.azure.com/acme/Platform/_git/web-app",
        sourceBranch: "feature/x",
        targetBranch: "main",
        title: "Cross profile",
        connectionId: "ado-1",
        workspaceProfileId: "profile-b",
      }),
    ).rejects.toThrow(/Cross-profile refused.*profile-a.*profile-b/s);
  });

  test("audits one successful user-initiated PR creation", async () => {
    const entries: Record<string, unknown>[] = [];
    const { manager } = createManager({ auditLogStore: { logEntry: (entry) => entries.push(entry) } });
    manager.setSnapshot({ connections: [{ ...connection, profileId: "default" }] } as never);

    await expect(
      manager.createPullRequestForWorkspace({
        remoteUrl: "https://dev.azure.com/acme/Platform/_git/web-app",
        sourceBranch: "feature/audit",
        targetBranch: "main",
        title: "Create PR",
        description: "Audited creation",
        connectionId: "ado-main",
        workspaceProfileId: "default",
      }),
    ).resolves.toEqual({
      pullRequestId: 124,
      url: "https://dev.azure.com/acme/Platform/_git/web-app/pullrequest/124",
      title: "Create PR",
    });

    expect(entries.filter((entry) => entry.category === "write")).toMatchObject([
      { operation: "createPullRequest", connectionId: "ado-main", success: true, userInitiated: true },
    ]);
  });

  test("audits one failed user-initiated PR creation", async () => {
    const entries: Record<string, unknown>[] = [];
    const { manager, fetchImpl } = createManager({ auditLogStore: { logEntry: (entry) => entries.push(entry) } });
    manager.setSnapshot({ connections: [{ ...connection, profileId: "default" }] } as never);
    const baseFetch = fetchImpl.getMockImplementation()!;
    fetchImpl.mockImplementation(async (url, options) => {
      if ((options as RequestInit | undefined)?.method === "POST") {
        return {
          ok: false,
          status: 403,
          json: async () => ({ ok: false }),
          text: async () => JSON.stringify({ message: "Write permission denied" }),
        };
      }
      return baseFetch!(url, options);
    });

    await expect(
      manager.createPullRequestForWorkspace({
        remoteUrl: "https://dev.azure.com/acme/Platform/_git/web-app",
        sourceBranch: "feature/audit",
        targetBranch: "main",
        title: "Create PR",
        description: "Denied creation",
        connectionId: "ado-main",
        workspaceProfileId: "default",
      }),
    ).rejects.toThrow(/403/);

    expect(entries.filter((entry) => entry.category === "write")).toMatchObject([
      {
        operation: "createPullRequest",
        connectionId: "ado-main",
        success: false,
        userInitiated: true,
        statusCode: 403,
      },
    ]);
    expect(entries.filter((entry) => entry.category === "write")).toHaveLength(1);
  });
});

describe("AzureDevOpsManager updateThreadStatus audit", () => {
  test("audits one successful user-initiated thread update", async () => {
    const entries: Record<string, unknown>[] = [];
    const prKey = createPullRequestKey("ado-main", "repo-1", 123);
    const { manager } = createManager({
      auditLogStore: { logEntry: (entry) => entries.push(entry) },
    });
    manager.setSnapshot({
      connections: [{ ...connection, profileId: "default" }],
      pullRequests: {
        [prKey]: {
          prKey,
          connectionId: "ado-main",
          orgUrl: connection.orgUrl,
          project: { id: "project-1", name: "Platform" },
          repository: { id: "repo-1", name: "web-app" },
          pullRequest: { id: 123 },
          threads: [],
        },
      },
      inbox: { needsMyReview: [], myPullRequests: [], recentlyUpdated: [], needsAttention: [] },
    } as never);

    await manager.updateThreadStatus({ prKey, threadId: 10, status: "fixed" });

    expect(entries.filter((entry) => entry.category === "write")).toMatchObject([
      { operation: "updateThread", connectionId: "ado-main", success: true, userInitiated: true },
    ]);
  });
});

describe("AzureDevOpsManager buildReviewMetadata — source baseline and identity", () => {
  const SHA = "a".repeat(40);
  const summary = (overrides: Record<string, unknown> = {}) => ({
    prKey: "ado-main:repo-1:123",
    connectionId: "ado-main",
    orgUrl: "https://dev.azure.com/acme",
    project: { id: "p1", name: "Platform" },
    repository: { id: "repo-1", name: "web-app", remoteUrl: "https://example.com/acme/web-app.git" },
    sourceRepository: {
      id: "100",
      name: "web-app",
      fullName: "acme/web-app",
      remoteUrl: "https://example.com/acme/web-app.git",
      sameAsTarget: true,
      canPush: null,
    },
    pullRequest: { id: 123, sourceRefName: "refs/heads/feature/x", targetRefName: "refs/heads/main" },
    role: "reviewer",
    ...overrides,
  });
  const checkout = { mode: "managed-worktree", rootPath: "/r/pr-123", cacheRepoPath: "/r/cache" };
  const previousReview = (overrides: Record<string, unknown> = {}) => ({
    provider: "azure-devops",
    prKey: "ado-main:repo-1:123",
    connectionId: "ado-main",
    sourceRepository: summary().sourceRepository,
    pullRequest: { sourceRefName: "refs/heads/feature/x", targetRefName: "refs/heads/main" },
    sourceBaselineSha: SHA,
    ...overrides,
  });
  const build = (s: Record<string, unknown>, previous: Record<string, unknown> | null) =>
    createManager().manager.buildReviewMetadata(s as never, checkout as never, {
      previousReview: previous as never,
    }) as unknown as Record<string, unknown>;

  test("carries the source repository, never the retired writable flag, and starts with no baseline", () => {
    const review = build(summary(), null);
    expect(review.sourceRepository).toMatchObject({ id: "100", fullName: "acme/web-app", sameAsTarget: true });
    expect(review).not.toHaveProperty("writable");
    expect(review).not.toHaveProperty("sourceBaselineSha");
  });

  test("a rebuild keeps the baseline while the source identity is unchanged", () => {
    expect(build(summary(), previousReview()).sourceBaselineSha).toBe(SHA);
  });

  test("a rebuild keeps the baseline when only the TARGET moved", () => {
    const retargeted = summary({
      pullRequest: { id: 123, sourceRefName: "refs/heads/feature/x", targetRefName: "refs/heads/release" },
    });
    expect(build(retargeted, previousReview()).sourceBaselineSha).toBe(SHA);
  });

  test("a rebuild drops the baseline when the source ref changes", () => {
    const moved = summary({
      pullRequest: { id: 123, sourceRefName: "refs/heads/feature/y", targetRefName: "refs/heads/main" },
    });
    expect(build(moved, previousReview())).not.toHaveProperty("sourceBaselineSha");
  });

  test("a rebuild drops the baseline when the source repository changes", () => {
    const forked = summary({
      sourceRepository: {
        id: "200",
        name: "web-app",
        fullName: "fork/web-app",
        remoteUrl: "https://example.com/fork/web-app.git",
        sameAsTarget: false,
        canPush: null,
      },
    });
    expect(build(forked, previousReview())).not.toHaveProperty("sourceBaselineSha");
  });

  test("a rebuild never invents a baseline from the provider's activity cursors", () => {
    const review = build(
      summary({
        lastHeadSha: SHA,
        pullRequest: {
          id: 123,
          sourceRefName: "refs/heads/feature/x",
          targetRefName: "refs/heads/main",
          sourceCommitId: SHA,
          headSha: SHA,
        },
      }),
      null,
    );
    expect(review).not.toHaveProperty("sourceBaselineSha");
  });
});
