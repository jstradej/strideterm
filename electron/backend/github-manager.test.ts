import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { GitHubManager, createPullRequestKey } from "./github-manager.js";

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

function jsonOk(data: unknown) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function searchItem(owner: string, repo: string, number: number): any {
  return {
    number,
    pull_request: { url: `https://api.github.com/repos/${owner}/${repo}/pulls/${number}` },
    repository_url: `https://api.github.com/repos/${owner}/${repo}`,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function defaultPr(owner: string, repo: string, number: number, overrides: Record<string, any> = {}): any {
  return {
    number,
    title: `PR #${number}`,
    body: "",
    state: "open",
    draft: false,
    url: `https://api.github.com/repos/${owner}/${repo}/pulls/${number}`,
    html_url: `https://github.com/${owner}/${repo}/pull/${number}`,
    created_at: "2026-03-17T08:00:00.000Z",
    updated_at: "2026-03-17T09:00:00.000Z",
    merged_at: null,
    closed_at: null,
    mergeable: true,
    mergeable_state: "clean",
    base: {
      repo: {
        owner: { login: owner },
        name: repo,
        clone_url: `https://github.com/${owner}/${repo}.git`,
        html_url: `https://github.com/${owner}/${repo}`,
      },
      ref: "main",
    },
    head: { sha: "sha-1", ref: "feature" },
    user: { login: "alice", name: "Alice", avatar_url: "" },
    ...overrides,
  };
}

function createFetchStub({
  searchItems = [] as unknown[],
  prsByNumber = {} as Record<number, unknown>,
  checkRunsByRef = {} as Record<string, unknown[]>,
  combinedStatusByRef = {} as Record<string, unknown>,
  branches = [] as Array<{ name: string }>,
} = {}) {
  return vi.fn(async (url: unknown, _options?: unknown) => {
    const href = String(url);
    if (href.includes("/search/issues")) {
      return jsonOk({ items: searchItems });
    }
    if (/\/repos\/[^/]+\/[^/]+\/branches/.test(href)) {
      return jsonOk(branches);
    }
    if (href.includes("/requested_reviewers")) {
      return jsonOk({ users: [], teams: [] });
    }
    if (/\/pulls\/\d+\/reviews/.test(href)) {
      return jsonOk([]);
    }
    if (/\/pulls\/\d+\/comments/.test(href)) {
      return jsonOk([]);
    }
    if (/\/issues\/\d+\/comments/.test(href)) {
      return jsonOk([]);
    }
    if (/\/pulls\/\d+\/files/.test(href)) {
      return jsonOk([]);
    }
    const checkRunsMatch = href.match(/\/commits\/([^/]+)\/check-runs/);
    if (checkRunsMatch) {
      return jsonOk({ check_runs: checkRunsByRef[checkRunsMatch[1]] || [] });
    }
    const statusMatch = href.match(/\/commits\/([^/]+)\/status/);
    if (statusMatch) {
      return jsonOk(combinedStatusByRef[statusMatch[1]] || { statuses: [] });
    }
    const prMatch = href.match(/\/pulls\/(\d+)(?:\?|$)/);
    if (prMatch) {
      const number = Number(prMatch[1]);
      const pr = prsByNumber[number];
      if (!pr) throw new Error(`No PR mock for #${number}`);
      return jsonOk(pr);
    }
    throw new Error(`Unexpected URL: ${href}`);
  });
}

function createManager({
  secrets = { "cred:gh-main": "ghp-token" },
  trackedPullRequests = {},
  fetchOverrides = {},
}: {
  secrets?: Record<string, string>;
  trackedPullRequests?: Record<string, unknown>;
  fetchOverrides?: Parameters<typeof createFetchStub>[0];
} = {}) {
  const reviewStore = createReviewStore({ trackedPullRequests });
  const fetchImpl = createFetchStub(fetchOverrides);
  const manager = new GitHubManager({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    credentialStore: createCredentialStore(secrets) as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    reviewStore: reviewStore as any,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    execFileTextImpl: vi.fn().mockResolvedValue({ stdout: "", stderr: "" }),
    now: () => new Date("2026-03-17T10:00:00.000Z").getTime(),
  });
  return { manager, fetchImpl, reviewStore };
}

const connection = {
  id: "gh-main",
  label: "Acme",
  hostUrl: "https://github.com",
  currentUserLogin: "alice",
  tokenRef: "cred:gh-main",
  enabled: true,
};

describe("GitHubManager stale PR resolution", () => {
  test("marks a PR closed when the detail check 404s", async () => {
    const prKey = createPullRequestKey("gh-main", "acme", "web", 999);
    const { manager, fetchImpl } = createManager();
    const baseImpl = fetchImpl.getMockImplementation()!;
    fetchImpl.mockImplementation(async (url, options) => {
      if (String(url).includes("/repos/acme/web/pulls/999")) {
        throw new Error("GitHub request failed (404): Not Found");
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
            provider: "github",
            connectionId: "gh-main",
            repository: { fullName: "acme/web", owner: "acme", name: "web" },
            pullRequest: { number: 999, state: "open" },
            prKey,
          },
        },
      ],
      gitSnapshots: {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: test assertion cast on untyped manager result
    })) as any;

    expect(snapshot.pullRequests[prKey].pullRequest.state).toBe("closed");
  });

  test("leaves a PR unresolved and logs when the detail check fails transiently", async () => {
    const prKey = createPullRequestKey("gh-main", "acme", "web", 999);
    const { manager, fetchImpl } = createManager();
    const baseImpl = fetchImpl.getMockImplementation()!;
    const warnSpy = vi.spyOn(manager.log, "warn").mockImplementation(() => {});
    fetchImpl.mockImplementation(async (url, options) => {
      if (String(url).includes("/repos/acme/web/pulls/999")) {
        throw new Error("network error: ECONNRESET");
      }
      return baseImpl(url, options);
    });

    const workspaces = [
      {
        id: "workspace-stale-transient",
        cwd: "/repo",
        review: {
          provider: "github",
          connectionId: "gh-main",
          repository: { fullName: "acme/web", owner: "acme", name: "web" },
          pullRequest: { number: 999, state: "open" },
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

    // No detail was ever resolved for this PR, so it must not be marked closed.
    expect(snapshot.pullRequests[prKey]).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      "stale PR check failed, will retry next poll",
      expect.objectContaining({ prKey, err: expect.stringContaining("ECONNRESET") }),
    );

    const detailCallsFor999 = () =>
      fetchImpl.mock.calls.filter(([url]) => String(url).includes("/repos/acme/web/pulls/999")).length;
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

describe("GitHubManager check-run aggregation", () => {
  test("ensurePullRequestDetail's check aggregation matches buildCheckSummary for neutral/startup_failure conclusions", async () => {
    const prKey = createPullRequestKey("gh-main", "acme", "web", 42);
    const pr = defaultPr("acme", "web", 42, { head: { sha: "sha-42", ref: "feature" } });
    const { manager } = createManager({
      fetchOverrides: {
        searchItems: [searchItem("acme", "web", 42)],
        prsByNumber: { 42: pr },
        checkRunsByRef: {
          "sha-42": [
            { id: 1, name: "lint", conclusion: "neutral", check_suite: { id: 501 } },
            { id: 2, name: "build", conclusion: "startup_failure", check_suite: { id: 502 } },
          ],
        },
      },
    });

    await manager.sync({ connections: [connection], workspaces: [], gitSnapshots: {} });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: test assertion cast on untyped manager result
    const detail = (await manager.ensurePullRequestDetail(prKey, { workspaces: [] })) as any;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lintItem = detail.checks.items.find((i: any) => i.name === "lint");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const buildItem = detail.checks.items.find((i: any) => i.name === "build");

    // neutral maps to "succeeded" per buildCheckSummary/normalizeCheckState.
    expect(lintItem.state).toBe("succeeded");
    expect(lintItem.stateLabel).toBe("passed");
    // checkSuiteId is only present on buildCheckSummary's output, not the old
    // inline copy — proves the manager now delegates instead of reimplementing.
    expect(lintItem.checkSuiteId).toBe(501);

    // startup_failure previously fell through to "unknown" in the inline
    // copy; buildCheckSummary maps it to "failed".
    expect(buildItem.state).toBe("failed");
    expect(buildItem.checkSuiteId).toBe(502);

    expect(detail.checks.failedCount).toBe(1);
    expect(detail.checks.passedCount).toBe(1);
  });
});

describe("GitHubManager inbox dedup", () => {
  test("collapses the same PR reachable via two GitHub connections into one inbox entry", async () => {
    const searchItems = [searchItem("acme", "web", 42)];
    const pr = defaultPr("acme", "web", 42);
    const fetchImpl = createFetchStub({ searchItems, prsByNumber: { 42: pr } });
    const reviewStore = createReviewStore();
    const manager = new GitHubManager({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      credentialStore: createCredentialStore({ "cred:gh-a": "token-a", "cred:gh-b": "token-b" }) as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      reviewStore: reviewStore as any,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      execFileTextImpl: vi.fn().mockResolvedValue({ stdout: "", stderr: "" }),
      now: () => new Date("2026-03-17T10:00:00.000Z").getTime(),
    });

    const connectionA = {
      id: "gh-a",
      label: "Acme A",
      hostUrl: "https://github.com",
      currentUserLogin: "alice",
      tokenRef: "cred:gh-a",
      enabled: true,
    };
    const connectionB = {
      id: "gh-b",
      label: "Acme B",
      hostUrl: "https://github.com",
      currentUserLogin: "alice",
      tokenRef: "cred:gh-b",
      enabled: true,
    };

    const snapshot = (await manager.sync({
      connections: [connectionA, connectionB],
      workspaces: [],
      gitSnapshots: {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: test assertion cast on untyped manager result
    })) as any;

    // Both connections fetched the same repo/PR independently — trackedPullRequests
    // is keyed per-connection so both entries survive there...
    expect(Object.keys(snapshot.trackedPullRequests).sort()).toEqual([
      createPullRequestKey("gh-a", "acme", "web", 42),
      createPullRequestKey("gh-b", "acme", "web", 42),
    ]);

    // ...but the inbox views the user sees must show the PR only once.
    expect(snapshot.inbox.recentlyUpdated).toHaveLength(1);
    const combinedRoleBuckets = [...snapshot.inbox.needsMyReview, ...snapshot.inbox.myPullRequests];
    expect(combinedRoleBuckets).toHaveLength(1);
  });
});

// openReviewWorkspace was hoisted onto BaseProviderManager.openReviewWorkspaceCore
// (shared with AzureDevOpsManager) and had zero dedicated GitHub-side test
// coverage beforehand — these mirror the equivalent AzureDevOpsManager tests.
describe("GitHubManager openReviewWorkspace", () => {
  test("creates a managed review workspace when none exists", async () => {
    const prKey = createPullRequestKey("gh-main", "acme", "web", 42);
    const { manager } = createManager({
      fetchOverrides: { searchItems: [searchItem("acme", "web", 42)], prsByNumber: { 42: defaultPr("acme", "web", 42) } },
    });
    await manager.sync({ connections: [connection], workspaces: [], gitSnapshots: {} });

    const result = (await manager.openReviewWorkspace({
      state: {
        tabTemplates: [],
        workspaces: [
          {
            id: "github-root",
            kind: "github",
            profileId: "default",
            cwd: "C:/reviews",
            panels: [{ id: "shell-template", title: "Shell", command: "" }],
          },
        ],
      },
      prKey,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: test assertion cast on untyped manager result
    })) as any;

    expect(result.created).toBe(true);
    expect(result.workspace.review.provider).toBe("github");
    expect(result.workspace.review.parentWorkspaceId).toBe("github-root");
    expect(result.workspace.cwd).toContain(path.join("reviews", "gh-main"));
    expect(result.workspace.name).toBe("acme/web PR #42");
    expect(result.workspace.notes).toBe("GitHub review workspace for acme/web PR #42");
    expect(result.workspace.panels).toHaveLength(1);
  });

  test("fails clearly when a matched workspace has no cwd", async () => {
    const prKey = createPullRequestKey("gh-main", "acme", "web", 42);
    const { manager } = createManager();
    manager.setSnapshot({
      connections: [connection],
      inbox: { needsMyReview: [], myPullRequests: [], recentlyUpdated: [], needsAttention: [] },
      trackedPullRequests: {},
      pullRequests: {
        [prKey]: {
          prKey,
          connectionId: "gh-main",
          repository: { owner: "acme", name: "web", fullName: "acme/web" },
          pullRequest: { number: 42, sourceRefName: "refs/heads/feature", targetRefName: "refs/heads/main" },
          role: "author",
          existingWorkspaceId: "workspace-bad",
        },
      },
      sync: { running: false, lastStartedAt: null, lastCompletedAt: null },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    await expect(
      manager.openReviewWorkspace({
        state: { tabTemplates: [], workspaces: [{ id: "workspace-bad", name: "Broken workspace", cwd: "" }] },
        prKey,
      }),
    ).rejects.toThrow('Matched workspace "Broken workspace" does not have a working directory.');
  });

  test("lands the new review on the connection's profile, not windowSlots[0]", async () => {
    const profileBConnection = { ...connection, id: "gh-b", profileId: "profile-b", tokenRef: "cred:gh-b" };
    const prKey = createPullRequestKey("gh-b", "acme", "web", 42);
    const { manager } = createManager({
      secrets: { "cred:gh-b": "ghp-b" } as unknown as Record<string, string>,
      fetchOverrides: { searchItems: [searchItem("acme", "web", 42)], prsByNumber: { 42: defaultPr("acme", "web", 42) } },
    });
    await manager.sync({ connections: [profileBConnection], workspaces: [], gitSnapshots: {} });

    const result = (await manager.openReviewWorkspace({
      state: {
        tabTemplates: [],
        windowSlots: [{ profileId: "default" }, { profileId: "profile-b" }],
        workspaces: [
          { id: "github-root-b", kind: "github", profileId: "profile-b", cwd: "C:/reviews-b", panels: [] },
        ],
      },
      prKey,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: test assertion cast on untyped manager result
    })) as any;

    expect(result.workspace.profileId).toBe("profile-b");
    expect(result.workspace.review.parentWorkspaceId).toBe("github-root-b");
  });
});

describe("GitHubManager listRemoteBranches / listQuickFixBranches", () => {
  test("listQuickFixBranches delegates to listRemoteBranches and returns the same branch names", async () => {
    const { manager } = createManager({
      fetchOverrides: { branches: [{ name: "main" }, { name: "feature/x" }] },
    });
    await manager.sync({ connections: [connection], workspaces: [], gitSnapshots: {} });

    const viaRemote = await manager.listRemoteBranches("gh-main", "acme", "web");
    const viaQuickFix = await manager.listQuickFixBranches("gh-main", "acme", "web");

    expect(viaRemote).toEqual(["main", "feature/x"]);
    expect(viaQuickFix).toEqual(viaRemote);
  });
});
