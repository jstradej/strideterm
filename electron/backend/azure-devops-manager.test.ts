import path from "node:path";
import os from "node:os";
import { describe, expect, test, vi } from "vitest";
import {
  AzureDevOpsManager,
  createPullRequestKey,
  normalizeConnectionInput,
  normalizeRemoteUrl,
  stripRefsPrefix,
} from "./azure-devops-manager.js";
import { buildPullRequestSummary } from "./azure-devops-pr-summary.js";

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
  return vi.fn(async (url, _options = {}) => {
    const href = String(url);
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
                name: "MHUB JUnit Tests",
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
                settings: { displayName: "MHUB JUnit Tests" },
              },
              context: {
                buildDefinitionName: "MHUB JUnit Tests",
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
    if (href.includes("/comments?") || href.endsWith("/threads?api-version=7.1")) {
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
    now: () => new Date("2026-03-17T10:00:00.000Z").getTime(),
  });
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
      attentionReason: "new comment",
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

    expect(snapshot.pullRequests[prKey].hasAttention).toBe(false);
    expect(snapshot.inbox.needsAttention).toEqual([]);
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
      name: "MHUB JUnit Tests",
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
    expect(execFileTextImpl.mock.calls.some((call) => call[1][0] === "-c" && call[1].includes("clone"))).toBe(true);
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

  test("sends comment and vote requests", async () => {
    const { manager, fetchImpl } = createManager();
    await manager.sync({
      connections: [connection],
      workspaces: [],
      gitSnapshots: {},
    });

    const prKey = createPullRequestKey("ado-main", "repo-1", 123);
    await manager.addPullRequestComment({ prKey, content: "LGTM" });
    await manager.setPullRequestVote({ prKey, vote: 10 });

    expect(
      fetchImpl.mock.calls.some(
        ([url, options]) => String(url).includes("/threads?api-version=7.1") && options.method === "POST",
      ),
    ).toBe(true);
    expect(
      fetchImpl.mock.calls.some(
        ([url, options]) => String(url).includes("/reviewers/reviewer-1") && options.method === "PUT",
      ),
    ).toBe(true);
  });
});

describe("azure manager helpers", () => {
  test("normalizeConnectionInput extracts project and repository hints from project URLs", () => {
    const connection = normalizeConnectionInput({
      orgUrl: "https://devops.skoda.vwgroup.com/projects/JAVA/MSP_MHUB",
      projectFilters: [],
      repositoryFilters: [],
    });

    expect(connection.orgUrl).toBe("https://devops.skoda.vwgroup.com/projects/JAVA");
    expect(connection.projectFilters).toEqual(["MSP_MHUB"]);
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
