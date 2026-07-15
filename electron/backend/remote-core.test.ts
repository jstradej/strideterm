import { describe, expect, test } from "vitest";
import {
  REMOTE_STATE_PROTOCOL,
  buildRemoteCore,
  buildResourceDetail,
  isKnownResourceKey,
  looksLikeStatePayload,
  parseResourceKey,
  resourceProfileAuthorized,
  resourceRevision,
  summarizeGit,
} from "./remote-core.js";

// A full desktop-shaped payload composed for a remote client on profile "p1".
function fullPayload() {
  return {
    meta: { appVersion: "9.9.9" },
    appState: {
      activeWorkspaceId: "ws1",
      workspaces: [
        { id: "ws1", name: "WS1", profileId: "p1", panels: [{ id: "a" }] },
        { id: "ws2", name: "WS2", profileId: "p2", panels: [{ id: "a" }] },
      ],
      windowSlots: [{ id: "win-1", profileId: "p1" }],
      settings: { theme: "dark" },
    },
    workspace: { workspace: { id: "ws1" }, sessions: [] },
    attention: { byWorkspace: {} },
    taskRunner: {},
    plugins: [],
    environment: { claudeAvailable: true },
    remoteAccess: { enabled: true, host: "h", port: 1, urls: ["u"], tunnel: { active: false }, token: "" },
    git: {
      connections: [{ id: "c1", label: "C1", provider: "azure-devops", enabled: true }],
      workspaces: {
        ws1: {
          available: true,
          branch: "main",
          dirty: true,
          dirtyCount: 3,
          branchMerged: false,
          lastChangeAt: "2026-07-15T10:00:00Z",
          lastUpdatedAt: "2026-07-15T10:00:01Z",
          log: [{ hash: "abc", subject: "big log entry".repeat(50) }],
          compareWithBase: { commits: [1, 2, 3] },
          roots: { "/repo": { branch: "main" } },
        },
        ws2: {
          available: true,
          branch: "dev",
          dirty: false,
          dirtyCount: 0,
          lastChangeAt: null,
          lastUpdatedAt: "2026-07-15T09:00:00Z",
          log: [],
        },
      },
      activeWorkspace: { branch: "main" },
    },
    azureDevops: {
      connections: [
        { id: "az1", label: "AZ1", profileId: "p1" },
        { id: "az2", label: "AZ2", profileId: "p2" },
      ],
      inbox: {
        needsMyReview: [{ prKey: "azure:pr1", connectionId: "az1" }],
        needsAttention: [{ prKey: "azure:pr2", connectionId: "az2" }],
        myPullRequests: [],
        recentlyUpdated: [],
      },
      pullRequests: {
        "azure:pr1": {
          prKey: "azure:pr1",
          profileId: "p1",
          connectionId: "az1",
          lastActivityAt: "2026-07-15T11:00:00Z",
          pullRequest: { status: "active", title: "PR one" },
          checks: { items: [{ id: "ck", state: "succeeded" }] },
          threads: [{ id: "t1", comments: ["a".repeat(1000)] }],
          issueComments: [{ id: "ic1", body: "b".repeat(1000) }],
          payload: { huge: "x".repeat(5000) },
          repository: { name: "repo" },
          role: "reviewer",
        },
        "azure:pr2": {
          prKey: "azure:pr2",
          profileId: "p2",
          connectionId: "az2",
          lastActivityAt: "2026-07-15T08:00:00Z",
          pullRequest: { status: "active" },
          threads: [{ id: "t9" }],
        },
      },
      reviewActivity: [{ id: "ev1", prKey: "azure:pr1" }],
      trackedPullRequests: { "azure:pr1": {} },
      sync: { lastCompletedAt: "2026-07-15T11:30:00Z" },
    },
    github: { connections: [], inbox: {}, pullRequests: {}, reviewActivity: [], sync: {} },
    reviewBridge: {
      rootPath: "/root",
      databasePath: "/db",
      agentPrompts: [{ promptId: "p", title: "Prompt" }],
      pullRequests: {
        "azure:pr1": {
          prKey: "azure:pr1",
          comments: [{ commentKey: "ck1", updatedAt: "2026-07-15T11:00:00Z" }],
          drafts: [{ draftId: "d1", status: "draft", updatedAt: "2026-07-15T11:05:00Z" }],
          syncQueue: [],
          threads: [{ id: "t", comments: ["z".repeat(2000)] }],
          mcpServerSpec: { command: "node", args: [], env: {} },
          lastSeenActivityAt: "2026-07-15T11:05:00Z",
        },
      },
    },
    docker: {
      available: true,
      lastUpdatedAt: "2026-07-15T12:00:00Z",
      backends: [{ id: "b1" }],
      contexts: [{ Name: "default" }],
      containers: [
        { ID: "c1", State: "running", Status: "Up 2 hours" },
        { ID: "c2", State: "exited", Status: "Exited (0)" },
      ],
      images: [{ ID: "img1" }],
      volumes: [{ Name: "v1" }],
      networks: [{ ID: "n1" }],
      lazydocker: {},
    },
    remoteClient: { id: "sess", profileId: "p1", activeWorkspaceId: "ws1", activeSessionId: "" },
  };
}

describe("buildRemoteCore", () => {
  test("advertises the protocol and keeps navigation/badge core", () => {
    const core = buildRemoteCore(fullPayload());
    expect(core.stateProtocol).toBe(REMOTE_STATE_PROTOCOL);
    expect(core.meta).toBeDefined();
    expect(core.appState).toBeDefined();
    expect(core.attention).toBeDefined();
    expect(core.taskRunner).toBeDefined();
    expect(core.remoteClient).toEqual(fullPayload().remoteClient);
  });

  test("git snapshots are replaced by summaries scoped to the client profile", () => {
    const core = buildRemoteCore(fullPayload());
    // Full snapshots gone; only summaries, and only for p1's workspace.
    expect((core as unknown as { git: { workspaces?: unknown } }).git.workspaces).toBeUndefined();
    expect(Object.keys(core.gitSummaries)).toEqual(["ws1"]);
    expect(core.gitSummaries.ws1).toEqual({
      available: true,
      branch: "main",
      dirty: true,
      dirtyCount: 3,
      branchMerged: false,
      lastChangeAt: "2026-07-15T10:00:00Z",
    });
    // The heavy log / compareWithBase never appear anywhere in the core.
    expect(JSON.stringify(core.gitSummaries)).not.toContain("big log entry");
    expect(core.git.connections).toHaveLength(1);
  });

  test("azure summary drops inbox and per-PR comment bodies, keeps badges", () => {
    const core = buildRemoteCore(fullPayload());
    const az = core.azureDevops;
    expect(az.inbox).toBeUndefined();
    expect(az.reviewActivity).toHaveLength(1);
    expect(az.connections).toHaveLength(2);
    const pr = az.pullRequests["azure:pr1"];
    expect(pr.pullRequest.status).toBe("active");
    expect(pr.checks.items).toHaveLength(1);
    expect(pr.lastActivityAt).toBe("2026-07-15T11:00:00Z");
    // Heavy comment bodies stripped.
    expect(pr.threads).toBeUndefined();
    expect(pr.issueComments).toBeUndefined();
    expect(pr.payload).toBeUndefined();
    expect(JSON.stringify(core.azureDevops)).not.toContain("aaaaa");
  });

  test("review-bridge keeps only agentPrompts, drops per-PR contexts", () => {
    const core = buildRemoteCore(fullPayload());
    expect(core.reviewBridge.agentPrompts).toHaveLength(1);
    expect(core.reviewBridge.pullRequests).toEqual({});
    expect(JSON.stringify(core.reviewBridge)).not.toContain("zzzzz");
  });

  test("docker summary keeps counts, drops the lists", () => {
    const core = buildRemoteCore(fullPayload());
    expect(core.docker.available).toBe(true);
    expect(core.docker.counts).toEqual({ containers: 2, running: 1 });
    expect(core.docker.containers).toEqual([]);
    expect(core.docker.images).toEqual([]);
    expect(core.docker.volumes).toEqual([]);
  });

  test("core carries revisions for git/docker/inboxes", () => {
    const core = buildRemoteCore(fullPayload());
    expect(core.revisions["git:ws1"]).toBe("2026-07-15T10:00:01Z");
    expect(core.revisions["git:ws2"]).toBeUndefined(); // other profile
    expect(core.revisions["docker"]).toBe("2026-07-15T12:00:00Z");
    expect(core.revisions["azure-inbox"]).toContain("2026-07-15T11:30:00Z");
  });

  test("an uncomposed payload (no remoteClient) summarizes all workspaces", () => {
    const p = fullPayload();
    delete (p as { remoteClient?: unknown }).remoteClient;
    const core = buildRemoteCore(p);
    expect(Object.keys(core.gitSummaries).sort()).toEqual(["ws1", "ws2"]);
    expect(core.remoteClient).toBeUndefined();
  });
});

describe("summarizeGit", () => {
  test("coerces missing fields safely", () => {
    expect(summarizeGit(undefined)).toEqual({
      available: false,
      branch: "",
      dirty: false,
      dirtyCount: 0,
      branchMerged: undefined,
      lastChangeAt: null,
    });
  });
});

describe("resource keys", () => {
  test("parses id-less and id-bearing keys (prKey may contain colons)", () => {
    expect(parseResourceKey("docker")).toEqual({ type: "docker" });
    expect(parseResourceKey("azure-inbox")).toEqual({ type: "azure-inbox" });
    expect(parseResourceKey("git:ws1")).toEqual({ type: "git", id: "ws1" });
    expect(parseResourceKey("azure-pr:azure-devops:org/repo/12")).toEqual({
      type: "azure-pr",
      id: "azure-devops:org/repo/12",
    });
  });

  test("isKnownResourceKey rejects unknown / id-missing", () => {
    expect(isKnownResourceKey("docker")).toBe(true);
    expect(isKnownResourceKey("git:ws1")).toBe(true);
    expect(isKnownResourceKey("git")).toBe(false); // needs id
    expect(isKnownResourceKey("bogus:x")).toBe(false);
  });
});

describe("resourceProfileAuthorized", () => {
  test("git is authorized only for a workspace in the client profile", () => {
    const p = fullPayload();
    expect(resourceProfileAuthorized(p, "p1", "git:ws1")).toBe(true);
    expect(resourceProfileAuthorized(p, "p1", "git:ws2")).toBe(false); // other profile
    expect(resourceProfileAuthorized(p, "p1", "git:nope")).toBe(false);
  });

  test("per-PR resources reject cross-profile prKeys", () => {
    const p = fullPayload();
    expect(resourceProfileAuthorized(p, "p1", "azure-pr:azure:pr1")).toBe(true);
    expect(resourceProfileAuthorized(p, "p1", "azure-pr:azure:pr2")).toBe(false); // p2's PR
    expect(resourceProfileAuthorized(p, "p1", "review-bridge:azure:pr1")).toBe(true);
    expect(resourceProfileAuthorized(p, "p1", "review-bridge:azure:pr2")).toBe(false);
  });

  test("docker/inbox are always allowed (scoped internally); null profile allows all", () => {
    const p = fullPayload();
    expect(resourceProfileAuthorized(p, "p1", "docker")).toBe(true);
    expect(resourceProfileAuthorized(p, "p1", "azure-inbox")).toBe(true);
    expect(resourceProfileAuthorized(p, null, "git:ws2")).toBe(true);
  });
});

describe("buildResourceDetail", () => {
  test("git detail returns the full snapshot with roots + revision", () => {
    const p = fullPayload();
    const detail = buildResourceDetail(p, "p1", "git:ws1");
    expect(detail).not.toBeNull();
    expect(detail!.resource).toBe("git:ws1");
    expect(detail!.revision).toBe("2026-07-15T10:00:01Z");
    expect((detail!.data as { roots: unknown }).roots).toBeDefined();
    expect((detail!.data as { log: unknown[] }).log).toHaveLength(1);
  });

  test("azure inbox detail is scoped to the client profile's connections", () => {
    const p = fullPayload();
    const detail = buildResourceDetail(p, "p1", "azure-inbox");
    const data = detail!.data as { inbox: { needsMyReview: unknown[]; needsAttention: unknown[] }; connections: unknown[] };
    expect(data.inbox.needsMyReview).toHaveLength(1); // az1 (p1)
    expect(data.inbox.needsAttention).toHaveLength(0); // az2 belongs to p2
    expect(data.connections).toHaveLength(1);
  });

  test("azure PR detail returns threads + issueComments", () => {
    const p = fullPayload();
    const detail = buildResourceDetail(p, "p1", "azure-pr:azure:pr1");
    const data = detail!.data as { threads: unknown[]; issueComments: unknown[] };
    expect(data.threads).toHaveLength(1);
    expect(data.issueComments).toHaveLength(1);
  });

  test("review-bridge detail returns comments/drafts + agentPrompts", () => {
    const p = fullPayload();
    const detail = buildResourceDetail(p, "p1", "review-bridge:azure:pr1");
    const data = detail!.data as { comments: unknown[]; drafts: unknown[]; agentPrompts: unknown[] };
    expect(data.comments).toHaveLength(1);
    expect(data.drafts).toHaveLength(1);
    expect(data.agentPrompts).toHaveLength(1);
  });

  test("docker detail returns the full lists", () => {
    const p = fullPayload();
    const detail = buildResourceDetail(p, "p1", "docker");
    const data = detail!.data as { containers: unknown[]; images: unknown[] };
    expect(data.containers).toHaveLength(2);
    expect(data.images).toHaveLength(1);
  });

  test("absent resource → null", () => {
    expect(buildResourceDetail(fullPayload(), "p1", "git:missing")).toBeNull();
  });
});

describe("resourceRevision", () => {
  test("changes when the underlying timestamp changes", () => {
    const p = fullPayload();
    const before = resourceRevision(p, "review-bridge:azure:pr1");
    p.reviewBridge.pullRequests["azure:pr1"].drafts.push({ draftId: "d2", status: "draft", updatedAt: "2026-07-15T12:00:00Z" });
    const after = resourceRevision(p, "review-bridge:azure:pr1");
    expect(after).not.toBe(before);
  });
});

describe("looksLikeStatePayload", () => {
  test("distinguishes full payloads from small mutation results", () => {
    expect(looksLikeStatePayload(fullPayload())).toBe(true);
    expect(looksLikeStatePayload({ ok: true })).toBe(false);
    expect(looksLikeStatePayload({ ok: true, result: 1 })).toBe(false);
    expect(looksLikeStatePayload(null)).toBe(false);
  });
});
