import path from "node:path";
import os from "node:os";
import { describe, expect, test, vi } from "vitest";
import { AzureDevOpsManager, createPullRequestKey } from "./azure-devops-manager.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createCredentialStore(secrets: Record<string, string> = {}) {
  return { getSecret: (ref: string) => secrets[ref] || "" };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createReviewStore(initial: any = {}) {
  const state = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    trackedPullRequests: initial.trackedPullRequests || {} as Record<string, any>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    connections: initial.connections || {} as Record<string, any>,
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

/**
 * Stateful fetch stub. Holds a mutable `world` object so individual tests can
 * alter PR state (comments, reviewers, commit id, merge status) between sync
 * calls and observe the resulting reviewActivity deltas.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createWorldFetch(world: any) {
  return vi.fn(async (url) => {
    const href = String(url);
    if (href.includes("/_apis/projects")) {
      return {
        ok: true,
        json: async () => ({ value: [{ id: "project-1", name: "Platform", state: "wellFormed" }] }),
      };
    }
    if (href.includes("/Platform/_apis/git/pullrequests")) {
      return { ok: true, json: async () => ({ value: world.pullRequests }) };
    }
    if (href.includes("/threads?")) {
      return {
        ok: true,
        json: async () => ({
          value: [
            {
              id: 10,
              status: "active",
              publishedDate: "2026-03-17T09:00:00.000Z",
              lastUpdatedDate: "2026-03-17T09:00:00.000Z",
              comments: world.comments,
            },
          ],
        }),
      };
    }
    if (
      href.includes("/statuses?") ||
      href.includes("/policy/evaluations?") ||
      href.includes("/iterations?") ||
      href.includes("/iterations/") ||
      href.includes("/reviewers/") ||
      href.includes("/comments?")
    ) {
      return { ok: true, json: async () => ({ value: [] }) };
    }
    throw new Error(`Unexpected URL: ${href}`);
  });
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

function basePullRequest(overrides = {}) {
  return {
    pullRequestId: 123,
    title: "Fix login redirect",
    description: "",
    status: "active",
    mergeStatus: "succeeded",
    isDraft: false,
    sourceRefName: "refs/heads/feature/login-fix",
    targetRefName: "refs/heads/main",
    creationDate: "2026-03-17T08:00:00.000Z",
    lastMergeSourceCommit: {
      commitId: "commit-1",
      committer: { name: "Alice", email: "alice@example.com", date: "2026-03-17T08:30:00.000Z" },
    },
    createdBy: { id: "author-1", displayName: "Alice", uniqueName: "alice@example.com" },
    repository: {
      id: "repo-1",
      name: "web-app",
      remoteUrl: "https://dev.azure.com/acme/Platform/_git/web-app",
      project: { id: "project-1", name: "Platform" },
    },
    reviewers: [
      { id: "reviewer-1", displayName: "Me", uniqueName: "me@example.com", vote: 0, isRequired: true },
      { id: "reviewer-2", displayName: "Bob", uniqueName: "bob@example.com", vote: 0 },
    ],
    _links: { web: { href: "https://dev.azure.com/acme/Platform/_git/web-app/pullrequest/123" } },
    ...overrides,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function commentFrom({ id, author, content, at }: any) {
  return {
    id,
    parentCommentId: 0,
    content,
    publishedDate: at,
    lastUpdatedDate: at,
    commentType: "text",
    author,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeManager(world: any, trackedPullRequests: any = {}) {
  const reviewStore = createReviewStore({ trackedPullRequests });
  const fetchImpl = createWorldFetch(world);
  const manager = new AzureDevOpsManager({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    credentialStore: createCredentialStore({ "cred:ado-main": "pat-123" }) as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    reviewStore: reviewStore as any,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    execFileTextImpl: vi.fn().mockResolvedValue({ stdout: "", stderr: "" }),
    now: () => new Date(world.nowIso).getTime(),
  });
  return { manager, reviewStore };
}

const prKey = createPullRequestKey("ado-main", "repo-1", 123);

describe("AzureDevOpsManager review-activity deltas", () => {
  test("first sync seeds tracked.lastNotifiedActivityAt and emits no events", async () => {
    const world = {
      nowIso: "2026-03-17T10:00:00.000Z",
      pullRequests: [basePullRequest()],
      comments: [
        commentFrom({
          id: 100,
          author: { id: "author-2", displayName: "Bob", uniqueName: "bob@example.com" },
          content: "Looks good",
          at: "2026-03-17T09:00:00.000Z",
        }),
      ],
    };
    const { manager, reviewStore } = makeManager(world);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const snapshot = (await manager.sync({ connections: [connection], workspaces: [], gitSnapshots: {} })) as any;

    expect(snapshot.reviewActivity).toEqual([]);
    expect(reviewStore.getTrackedPullRequest(prKey).lastNotifiedActivityAt).toBeTruthy();
  });

  test("second sync emits pr-new-comment when somebody else comments", async () => {
    const world = {
      nowIso: "2026-03-17T10:00:00.000Z",
      pullRequests: [basePullRequest()],
      comments: [
        commentFrom({
          id: 100,
          author: { id: "author-2", displayName: "Bob", uniqueName: "bob@example.com" },
          content: "Looks good",
          at: "2026-03-17T09:00:00.000Z",
        }),
      ],
    };
    const { manager } = makeManager(world);
    await manager.sync({ connections: [connection], workspaces: [], gitSnapshots: {} });

    world.nowIso = "2026-03-17T10:05:00.000Z";
    world.comments.push(
      commentFrom({
        id: 101,
        author: { id: "author-2", displayName: "Bob", uniqueName: "bob@example.com" },
        content: "One more nit on line 12",
        at: "2026-03-17T10:02:00.000Z",
      }),
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const snapshot = (await manager.sync({ connections: [connection], workspaces: [], gitSnapshots: {} })) as any;
    expect(snapshot.reviewActivity).toHaveLength(1);
    expect(snapshot.reviewActivity[0]).toMatchObject({
      prKey,
      kind: "pr-new-comment",
      provider: "azure-devops",
    });
    expect(snapshot.reviewActivity[0].body).toContain("Bob");
    expect(snapshot.reviewActivity[0].body).toContain("line 12");
  });

  test("second sync ignores comments authored by the current user", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const world: any = {
      nowIso: "2026-03-17T10:00:00.000Z",
      pullRequests: [basePullRequest()],
      comments: [],
    };
    const { manager } = makeManager(world);
    await manager.sync({ connections: [connection], workspaces: [], gitSnapshots: {} });

    world.nowIso = "2026-03-17T10:05:00.000Z";
    world.comments.push(
      commentFrom({
        id: 102,
        author: { id: "me-azure", displayName: "Me", uniqueName: "me@example.com" },
        content: "self-note",
        at: "2026-03-17T10:03:00.000Z",
      }),
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const snapshot = (await manager.sync({ connections: [connection], workspaces: [], gitSnapshots: {} })) as any;
    expect(snapshot.reviewActivity).toEqual([]);
  });

  test("vote change by another reviewer emits pr-vote-changed; self vote is ignored", async () => {
    const world = {
      nowIso: "2026-03-17T10:00:00.000Z",
      pullRequests: [basePullRequest()],
      comments: [],
    };
    const { manager } = makeManager(world);
    await manager.sync({ connections: [connection], workspaces: [], gitSnapshots: {} });

    // Both reviewers change votes, including me. Only Bob's change should notify.
    world.nowIso = "2026-03-17T10:05:00.000Z";
    world.pullRequests = [
      basePullRequest({
        reviewers: [
          { id: "reviewer-1", displayName: "Me", uniqueName: "me@example.com", vote: 10, isRequired: true },
          { id: "reviewer-2", displayName: "Bob", uniqueName: "bob@example.com", vote: -10 },
        ],
      }),
    ];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const snapshot = (await manager.sync({ connections: [connection], workspaces: [], gitSnapshots: {} })) as any;
    const voteEvents = snapshot.reviewActivity// eslint-disable-next-line @typescript-eslint/no-explicit-any
    .filter((ev: any) => ev.kind === "pr-vote-changed");
    expect(voteEvents).toHaveLength(1);
    expect(voteEvents[0].body).toContain("Bob");
    expect(voteEvents[0].body).toContain("rejected");
    expect(voteEvents[0].urgency).toBe("urgent");
  });

  test("source branch push by somebody else emits pr-source-updated", async () => {
    const world = {
      nowIso: "2026-03-17T10:00:00.000Z",
      pullRequests: [basePullRequest()],
      comments: [],
    };
    const { manager } = makeManager(world);
    await manager.sync({ connections: [connection], workspaces: [], gitSnapshots: {} });

    world.nowIso = "2026-03-17T10:05:00.000Z";
    world.pullRequests = [
      basePullRequest({
        lastMergeSourceCommit: {
          commitId: "commit-2",
          committer: { name: "Bob", email: "bob@example.com", date: "2026-03-17T10:04:00.000Z" },
        },
      }),
    ];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const snapshot = (await manager.sync({ connections: [connection], workspaces: [], gitSnapshots: {} })) as any;
    const pushEvents = snapshot.reviewActivity// eslint-disable-next-line @typescript-eslint/no-explicit-any
    .filter((ev: any) => ev.kind === "pr-source-updated");
    expect(pushEvents).toHaveLength(1);
    expect(pushEvents[0].body).toContain("Bob");
  });

  test("source push by me is NOT reported", async () => {
    const world = {
      nowIso: "2026-03-17T10:00:00.000Z",
      pullRequests: [basePullRequest()],
      comments: [],
    };
    const { manager } = makeManager(world);
    await manager.sync({ connections: [connection], workspaces: [], gitSnapshots: {} });

    world.nowIso = "2026-03-17T10:05:00.000Z";
    world.pullRequests = [
      basePullRequest({
        lastMergeSourceCommit: {
          commitId: "commit-3",
          committer: { name: "Me", email: "me@example.com", date: "2026-03-17T10:04:00.000Z" },
        },
      }),
    ];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const snapshot = (await manager.sync({ connections: [connection], workspaces: [], gitSnapshots: {} })) as any;
    expect(snapshot.reviewActivity// eslint-disable-next-line @typescript-eslint/no-explicit-any
    .filter((ev: any) => ev.kind === "pr-source-updated")).toEqual([]);
  });

  test("brand-new PR discovered on second sync emits pr-new for reviewer role", async () => {
    // First sync: only PR 123 exists
    const world = {
      nowIso: "2026-03-17T10:00:00.000Z",
      pullRequests: [basePullRequest()],
      comments: [],
    };
    const { manager } = makeManager(world);
    await manager.sync({ connections: [connection], workspaces: [], gitSnapshots: {} });

    // Second sync: PR 456 appears (brand new, we're a reviewer)
    world.nowIso = "2026-03-17T10:05:00.000Z";
    world.pullRequests = [
      basePullRequest(),
      basePullRequest({
        pullRequestId: 456,
        title: "Add feature X",
        creationDate: "2026-03-17T10:03:00.000Z",
        lastMergeSourceCommit: {
          commitId: "commit-new",
          committer: { name: "Alice", email: "alice@example.com", date: "2026-03-17T10:03:00.000Z" },
        },
        reviewers: [{ id: "reviewer-1", displayName: "Me", uniqueName: "me@example.com", vote: 0, isRequired: true }],
      }),
    ];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const snapshot = (await manager.sync({ connections: [connection], workspaces: [], gitSnapshots: {} })) as any;
    const newEvents = snapshot.reviewActivity// eslint-disable-next-line @typescript-eslint/no-explicit-any
    .filter((ev: any) => ev.kind === "pr-new");
    expect(newEvents).toHaveLength(1);
    expect(newEvents[0].pullRequestNumber).toBe(456);
    expect(newEvents[0].body).toContain("feature X");
  });

  test("connection error emits exactly once per transition, silent on re-poll", async () => {
    // Arrange: force the first sync to fail by omitting the credential secret.
    const world = {
      nowIso: "2026-03-17T10:00:00.000Z",
      pullRequests: [basePullRequest()],
      comments: [],
    };
    const reviewStore = createReviewStore({});
    const manager = new AzureDevOpsManager({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      credentialStore: createCredentialStore({}) as any, // no secret → "PAT is missing."
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      reviewStore: reviewStore as any,
      fetchImpl: createWorldFetch(world) as unknown as typeof fetch,
      execFileTextImpl: vi.fn().mockResolvedValue({ stdout: "", stderr: "" }),
      now: () => new Date(world.nowIso).getTime(),
    });

    // First sync: idle → error → emits one connection-error event.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const first = (await manager.sync({ connections: [connection], workspaces: [], gitSnapshots: {} })) as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const firstErrors = first.reviewActivity.filter((ev: any) => ev.kind === "connection-error");
    expect(firstErrors).toHaveLength(1);
    expect(firstErrors[0].body).toContain("PAT is missing");
    expect(firstErrors[0].prKey).toBe("connection:ado-main");

    // Second sync, still failing identically: no new event.
    world.nowIso = "2026-03-17T10:05:00.000Z";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const second = (await manager.sync({ connections: [connection], workspaces: [], gitSnapshots: {} })) as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const secondErrors = second.reviewActivity.filter((ev: any) => ev.kind === "connection-error");
    // appendReviewActivity keeps the first event in the rolling log; there
    // should not be a *new* one with a later timestamp.
    expect(secondErrors).toHaveLength(1);
    expect(secondErrors[0].at).toBe(firstErrors[0].at);
  });

  test("connection error re-emits when the error message changes", async () => {
    const world = {
      nowIso: "2026-03-17T10:00:00.000Z",
      pullRequests: [basePullRequest()],
      comments: [],
    };
    const reviewStore = createReviewStore({});
    const credentialStore = {
      _secret: "",
      getSecret() {
        return this._secret;
      },
    };
    const manager = new AzureDevOpsManager({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      credentialStore: credentialStore as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      reviewStore: reviewStore as any,
      fetchImpl: createWorldFetch(world) as unknown as typeof fetch,
      execFileTextImpl: vi.fn().mockResolvedValue({ stdout: "", stderr: "" }),
      now: () => new Date(world.nowIso).getTime(),
    });

    // 1st sync — "PAT is missing."
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const first = (await manager.sync({ connections: [connection], workspaces: [], gitSnapshots: {} })) as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(first.reviewActivity.filter((ev: any) => ev.kind === "connection-error")).toHaveLength(1);

    // 2nd sync — different error (401 from the API). Swap the fetch stub.
    world.nowIso = "2026-03-17T10:05:00.000Z";
    credentialStore._secret = "pat-123"; // now has a secret, but fetch will 401
    manager.fetchImpl = async () => {
      throw new Error("HTTP 401 Unauthorized");
    };
    // Azure manager stores its api + fetch in this.api — rebuild the fetch impl
    // the same way the constructor did, via the shared api layer:
    manager.api = manager.api.constructor ? manager.api : manager.api;
    // Simpler: monkey-patch api to reject
    manager.api.listProjects = async () => {
      throw new Error("HTTP 401 Unauthorized");
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const second = (await manager.sync({ connections: [connection], workspaces: [], gitSnapshots: {} })) as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const secondErrors = second.reviewActivity.filter((ev: any) => ev.kind === "connection-error");
    expect(secondErrors).toHaveLength(2); // old + new
    expect(secondErrors[0].body).toContain("401");
  });

  test("merge status turning bad emits urgent event for the PR author", async () => {
    // Scenario: I am the author; merge status goes from succeeded to conflicts
    const worldConnection = { ...connection, login: "alice@example.com" };
    const world = {
      nowIso: "2026-03-17T10:00:00.000Z",
      pullRequests: [basePullRequest()],
      comments: [],
    };
    const { manager } = makeManager(world);
    await manager.sync({ connections: [worldConnection], workspaces: [], gitSnapshots: {} });

    world.nowIso = "2026-03-17T10:05:00.000Z";
    world.pullRequests = [basePullRequest({ mergeStatus: "conflicts" })];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const snapshot = (await manager.sync({ connections: [worldConnection], workspaces: [], gitSnapshots: {} })) as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mergeEvents = snapshot.reviewActivity.filter((ev: any) => ev.kind === "pr-merge-status-changed");
    expect(mergeEvents).toHaveLength(1);
    expect(mergeEvents[0].urgency).toBe("urgent");
  });
});
