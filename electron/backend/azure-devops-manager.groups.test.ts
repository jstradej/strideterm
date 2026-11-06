import path from "node:path";
import os from "node:os";
import { describe, expect, test, vi } from "vitest";
import { AzureDevOpsManager } from "./azure-devops-manager.js";

interface World {
  nowMs: number;
  membership: "ok" | "forbidden";
  identityCalls: string[];
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
  reviewRoot: path.join(os.tmpdir(), "strideterm-azure-group-tests"),
};

function json(body: unknown, status = 200) {
  return { ok: status < 400, status, statusText: String(status), headers: new Map(), json: async () => body };
}

function createFetch(world: World) {
  return vi.fn(async (url: unknown, _options?: RequestInit) => {
    const href = String(url);
    if (href.includes("/reviewers/")) return json({ id: "me-1", vote: 10 });
    if (href.includes("/_apis/connectionData?")) return json({ authenticatedUser: { id: "me-1" } });
    if (href.includes("vssps.dev.azure.com/acme/_apis/identities")) {
      world.identityCalls.push(href);
      if (world.membership === "forbidden") {
        return new Response(JSON.stringify({ message: "Access denied" }), { status: 403 }) as never;
      }
      if (href.includes("identityIds=")) return json({ value: [{ memberOf: ["vssgp.team-descriptor"] }] });
      return json({ value: [{ id: "team-1" }] });
    }
    if (href.includes("/_apis/projects")) return json({ value: [{ id: "project-1", name: "Platform" }] });
    if (href.includes("/Platform/_apis/git/pullrequests")) {
      return json({
        value: [
          {
            pullRequestId: 7,
            title: "Team review",
            status: "active",
            mergeStatus: "succeeded",
            creationDate: "2026-03-17T08:00:00.000Z",
            lastMergeSourceCommit: { commitId: "c1", committer: { date: "2026-03-17T08:30:00.000Z" } },
            createdBy: { id: "author-1", displayName: "Alice", uniqueName: "alice@example.com" },
            repository: { id: "repo-1", name: "web-app", project: { id: "project-1", name: "Platform" } },
            reviewers: [{ id: "team-1", displayName: "[Platform]\\Reviewers", isContainer: true, vote: 0 }],
          },
        ],
      });
    }
    if (href.includes("/threads?")) return json({ value: [] });
    return json({ value: [] });
  });
}

function createManager(world: World) {
  const state = { trackedPullRequests: {} as Record<string, unknown>, connections: {} as Record<string, unknown> };
  const reviewStore = {
    getState: () => state,
    getTrackedPullRequest: (key: string) => state.trackedPullRequests[key] || null,
    async upsertTrackedPullRequest(key: string, patch: Record<string, unknown>) {
      state.trackedPullRequests[key] = { ...(state.trackedPullRequests[key] || {}), ...patch };
    },
    async upsertConnectionState(id: string, patch: Record<string, unknown>) {
      state.connections[id] = { ...(state.connections[id] || {}), ...patch };
    },
  };
  const fetchImpl = createFetch(world);
  const manager = new AzureDevOpsManager({
    credentialStore: { getSecret: (ref: string) => (ref === "cred:ado-main" ? "pat-123" : "") } as never,
    reviewStore: reviewStore as never,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    execFileTextImpl: vi.fn().mockResolvedValue({ stdout: "", stderr: "" }),
    now: () => world.nowMs,
  });
  const sync = () =>
    manager.sync({ connections: [connection], workspaces: [], gitSnapshots: {} }) as Promise<{
      connections: Array<Record<string, unknown>>;
      inbox: { needsMyReview: Array<Record<string, unknown>>; needsAttention: Array<Record<string, unknown>> };
    }>;
  return { manager, sync, fetchImpl };
}

const prKey = "ado-main:repo-1:7";

function reviewerPuts(fetchImpl: ReturnType<typeof createFetch>) {
  return fetchImpl.mock.calls
    .filter(([url, options]) => String(url).includes("/reviewers/") && options?.method === "PUT")
    .map(([url, options]) => ({ url: String(url), body: JSON.parse(String(options?.body)) }));
}

describe("AzureDevOpsManager group reviewers", () => {
  test("a PR requested from the user's team lands in Needs review and the connection reports the lookup", async () => {
    const world: World = { nowMs: Date.parse("2026-03-17T10:00:00Z"), membership: "ok", identityCalls: [] };
    const { sync } = createManager(world);

    const snapshot = await sync();

    expect(snapshot.inbox.needsMyReview).toHaveLength(1);
    expect(snapshot.inbox.needsMyReview[0]).toMatchObject({
      role: "reviewer",
      myReviewStatus: "pending",
      attentionReason: "Your review · via Reviewers",
    });
    expect(snapshot.inbox.needsAttention).toHaveLength(1);
    expect(snapshot.connections[0].groupMembership).toEqual({ status: "ok", count: 1 });
    expect(world.identityCalls[0]).toContain("identityIds=me-1&queryMembership=ExpandedUp");
    expect(world.identityCalls[1]).toContain("descriptors=vssgp.team-descriptor");
  });

  test("a member of the requested group votes as themselves, so Azure counts it for the group", async () => {
    const world: World = { nowMs: Date.parse("2026-03-17T10:00:00Z"), membership: "ok", identityCalls: [] };
    const { manager, sync, fetchImpl } = createManager(world);
    await sync();

    await manager.setPullRequestVote({ prKey, vote: 10 });

    expect(reviewerPuts(fetchImpl)).toEqual([
      { url: expect.stringContaining("/pullRequests/7/reviewers/me-1?"), body: { id: "me-1", vote: 10 } },
    ]);
  });

  test("someone who is neither a reviewer nor in a requested group still cannot vote", async () => {
    const world: World = { nowMs: Date.parse("2026-03-17T10:00:00Z"), membership: "forbidden", identityCalls: [] };
    const { manager, sync, fetchImpl } = createManager(world);
    await sync();

    await expect(manager.setPullRequestVote({ prKey, vote: 10 })).rejects.toThrow(/not an active reviewer/);
    expect(reviewerPuts(fetchImpl)).toEqual([]);
  });

  test("the membership is cached between syncs and refreshed after 30 minutes", async () => {
    const world: World = { nowMs: Date.parse("2026-03-17T10:00:00Z"), membership: "ok", identityCalls: [] };
    const { sync } = createManager(world);

    await sync();
    await sync();
    expect(world.identityCalls).toHaveLength(2);

    world.nowMs += 31 * 60 * 1000;
    await sync();
    expect(world.identityCalls).toHaveLength(4);
  });

  test("a refused lookup never fails the sync, is reported on the connection and retried after 5 minutes", async () => {
    const world: World = { nowMs: Date.parse("2026-03-17T10:00:00Z"), membership: "forbidden", identityCalls: [] };
    const { sync } = createManager(world);

    const snapshot = await sync();

    expect(snapshot.connections[0].status).toBe("ok");
    expect(snapshot.connections[0].groupMembership).toMatchObject({ status: "error" });
    expect((snapshot.connections[0].groupMembership as { error: string }).error).toContain("Identity (Read)");
    expect(snapshot.inbox.needsMyReview).toHaveLength(0);

    await sync();
    expect(world.identityCalls).toHaveLength(1);

    world.nowMs += 6 * 60 * 1000;
    world.membership = "ok";
    const recovered = await sync();
    expect(recovered.connections[0].groupMembership).toEqual({ status: "ok", count: 1 });
    expect(recovered.inbox.needsMyReview).toHaveLength(1);
  });
});
