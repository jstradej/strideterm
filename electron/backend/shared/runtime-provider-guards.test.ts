import { describe, expect, test, vi } from "vitest";
import {
  resolveRootPath,
  assertPrInViewerProfile,
  mirrorActivationIntoSlot,
  assertWorktreeCleanForPush,
  filterConnectionsByOpenProfiles,
  computeMinPollSeconds,
} from "./runtime-provider-guards.js";

describe("resolveRootPath", () => {
  test("returns the resolved path when resolveGitRootPath finds a match", () => {
    const resolveGitRootPath = vi.fn(() => "/resolved/path");
    const workspace = { id: "ws-1" } as never;
    const result = resolveRootPath(resolveGitRootPath, workspace, "sub/dir");
    expect(result).toBe("/resolved/path");
    expect(resolveGitRootPath).toHaveBeenCalledWith(workspace, "sub/dir");
  });

  test("returns empty string when rawRootPath is empty (no throw)", () => {
    const resolveGitRootPath = vi.fn(() => null);
    const workspace = { id: "ws-1" } as never;
    const result = resolveRootPath(resolveGitRootPath, workspace, "");
    expect(result).toBe("");
    expect(resolveGitRootPath).toHaveBeenCalledWith(workspace, "");
  });

  test("throws when a non-empty rawRootPath does not resolve", () => {
    const resolveGitRootPath = vi.fn(() => null);
    const workspace = { id: "ws-1" } as never;
    expect(() => resolveRootPath(resolveGitRootPath, workspace, "unknown/path")).toThrow(
      /Root path not found in workspace gitRoots: unknown\/path/,
    );
  });
});

describe("assertPrInViewerProfile", () => {
  function makeDeps(payload: unknown, callerProfileId: string | null) {
    return {
      getPayload: vi.fn(() => payload),
      getViewerProfileId: vi.fn(() => callerProfileId),
    };
  }

  test("no-op when the caller has no viewer profile (desktop IPC)", () => {
    const deps = makeDeps({ azureDevops: { pullRequests: { "pr-1": { profileId: "p1" } } } }, null);
    expect(() => assertPrInViewerProfile(deps, "azureDevops", "pr-1", undefined)).not.toThrow();
  });

  test("allows access when the PR's profile matches the caller's profile", () => {
    const deps = makeDeps({ azureDevops: { pullRequests: { "pr-1": { profileId: "p1" } } } }, "p1");
    expect(() => assertPrInViewerProfile(deps, "azureDevops", "pr-1", "win-a")).not.toThrow();
  });

  test("refuses when the PR belongs to a different profile", () => {
    const deps = makeDeps({ azureDevops: { pullRequests: { "pr-1": { profileId: "p1" } } } }, "p2");
    expect(() => assertPrInViewerProfile(deps, "azureDevops", "pr-1", "win-b")).toThrow(/Cross-profile refused/);
  });

  test("treats a missing profileId on the PR as 'default'", () => {
    const deps = makeDeps({ azureDevops: { pullRequests: { "pr-1": {} } } }, "default");
    expect(() => assertPrInViewerProfile(deps, "azureDevops", "pr-1", "win-a")).not.toThrow();
  });

  test("no-op when the PR isn't present in the snapshot (nothing to compare against)", () => {
    const deps = makeDeps({ azureDevops: { pullRequests: {} } }, "p1");
    expect(() => assertPrInViewerProfile(deps, "azureDevops", "pr-missing", "win-a")).not.toThrow();
  });

  test("snapshotKey selects the right slice of the payload — 'github' does not see azureDevops PRs", () => {
    const deps = makeDeps(
      {
        azureDevops: { pullRequests: { "pr-1": { profileId: "p2" } } },
        github: { pullRequests: { "pr-1": { profileId: "p1" } } },
      },
      "p1",
    );
    // Same prKey "pr-1" exists under both providers with different owning
    // profiles — snapshotKey must route to the correct one.
    expect(() => assertPrInViewerProfile(deps, "github", "pr-1", "win-a")).not.toThrow();
    expect(() => assertPrInViewerProfile(deps, "azureDevops", "pr-1", "win-a")).toThrow(/Cross-profile refused/);
  });
});

describe("mirrorActivationIntoSlot", () => {
  test("returns null (no-op) when windowId is undefined — e.g. desktop IPC with no window context", () => {
    const draft = { windowSlots: [{ id: "win-a", profileId: "p1", activeWorkspaceId: "ws-old" }] };
    const result = mirrorActivationIntoSlot(draft, undefined, { id: "ws-new", profileId: "p1" });
    expect(result).toBeNull();
    expect(draft.windowSlots[0].activeWorkspaceId).toBe("ws-old");
  });

  test("returns null (no-op) when no slot matches windowId", () => {
    const draft = { windowSlots: [{ id: "win-a", profileId: "p1", activeWorkspaceId: "ws-old" }] };
    const result = mirrorActivationIntoSlot(draft, "win-missing", { id: "ws-new", profileId: "p1" });
    expect(result).toBeNull();
    expect(draft.windowSlots[0].activeWorkspaceId).toBe("ws-old");
  });

  test("mirrors the activation when the workspace profile matches the slot profile", () => {
    const draft = { windowSlots: [{ id: "win-a", profileId: "p1", activeWorkspaceId: "ws-old" }] };
    const result = mirrorActivationIntoSlot(draft, "win-a", { id: "ws-new", profileId: "p1" });
    expect(result).toEqual({ mirrored: true, slotProfileId: "p1", workspaceProfileId: "p1" });
    expect(draft.windowSlots[0].activeWorkspaceId).toBe("ws-new");
  });

  test("skips the mirror (cross-profile) and reports both profile ids without mutating the slot", () => {
    const draft = { windowSlots: [{ id: "win-b", profileId: "p2", activeWorkspaceId: "ws-old" }] };
    const result = mirrorActivationIntoSlot(draft, "win-b", { id: "ws-new", profileId: "p1" });
    expect(result).toEqual({ mirrored: false, slotProfileId: "p2", workspaceProfileId: "p1" });
    expect(draft.windowSlots[0].activeWorkspaceId).toBe("ws-old");
  });

  test("treats a missing workspace profileId as 'default' for the comparison", () => {
    const draft = { windowSlots: [{ id: "win-a", profileId: "default", activeWorkspaceId: "ws-old" }] };
    const result = mirrorActivationIntoSlot(draft, "win-a", { id: "ws-new" });
    expect(result).toEqual({ mirrored: true, slotProfileId: "default", workspaceProfileId: "default" });
    expect(draft.windowSlots[0].activeWorkspaceId).toBe("ws-new");
  });

  test("only mirrors into the targeted slot, leaving sibling slots of other windows untouched", () => {
    const draft = {
      windowSlots: [
        { id: "win-a", profileId: "p1", activeWorkspaceId: "ws-old-a" },
        { id: "win-a2", profileId: "p1", activeWorkspaceId: "ws-old-a2" },
      ],
    };
    mirrorActivationIntoSlot(draft, "win-a", { id: "ws-new", profileId: "p1" });
    expect(draft.windowSlots[0].activeWorkspaceId).toBe("ws-new");
    expect(draft.windowSlots[1].activeWorkspaceId).toBe("ws-old-a2");
  });
});

describe("assertWorktreeCleanForPush", () => {
  test("resolves without throwing when the worktree is clean", async () => {
    const git = { getCachedWorktreeDirtyState: vi.fn(async () => ({ dirty: false, dirtyCount: 0 })) };
    await expect(assertWorktreeCleanForPush(git, { cwd: "/repo" })).resolves.toBeUndefined();
    expect(git.getCachedWorktreeDirtyState).toHaveBeenCalledWith("/repo");
  });

  test("throws with a singular message for exactly one uncommitted change", async () => {
    const git = { getCachedWorktreeDirtyState: vi.fn(async () => ({ dirty: true, dirtyCount: 1 })) };
    await expect(assertWorktreeCleanForPush(git, { cwd: "/repo" })).rejects.toThrow(
      "Cannot push: 1 uncommitted change in the worktree. Commit your changes first, then try again.",
    );
  });

  test("throws with a plural message for multiple uncommitted changes", async () => {
    const git = { getCachedWorktreeDirtyState: vi.fn(async () => ({ dirty: true, dirtyCount: 3 })) };
    await expect(assertWorktreeCleanForPush(git, { cwd: "/repo" })).rejects.toThrow(
      "Cannot push: 3 uncommitted changes in the worktree. Commit your changes first, then try again.",
    );
  });
});

describe("filterConnectionsByOpenProfiles", () => {
  test("returns all connections unfiltered when there are no open window slots", () => {
    const connections = [
      { id: "c1", profileId: "p1" },
      { id: "c2", profileId: "p2" },
    ];
    expect(filterConnectionsByOpenProfiles(connections, [])).toEqual(connections);
    expect(filterConnectionsByOpenProfiles(connections, undefined)).toEqual(connections);
  });

  test("keeps only connections owned by a profile open in some window", () => {
    const connections = [
      { id: "c1", profileId: "p1" },
      { id: "c2", profileId: "p2" },
      { id: "c3", profileId: "p3" },
    ];
    const windowSlots = [{ profileId: "p1" }, { profileId: "p3" }];
    expect(filterConnectionsByOpenProfiles(connections, windowSlots).map((c) => c.id)).toEqual(["c1", "c3"]);
  });

  test("treats a missing connection profileId as 'default', matched by a slot with no profileId", () => {
    const connections = [{ id: "c1" }, { id: "c2", profileId: "p2" }];
    const windowSlots = [{}];
    expect(filterConnectionsByOpenProfiles(connections, windowSlots).map((c) => c.id)).toEqual(["c1"]);
  });

  test("a profile open in more than one window still dedupes to a single inclusion criterion", () => {
    const connections = [{ id: "c1", profileId: "p1" }];
    const windowSlots = [{ profileId: "p1" }, { profileId: "p1" }];
    expect(filterConnectionsByOpenProfiles(connections, windowSlots).map((c) => c.id)).toEqual(["c1"]);
  });
});

describe("computeMinPollSeconds", () => {
  test("picks the shortest per-connection pollSeconds", () => {
    const connections = [{ pollSeconds: 60 }, { pollSeconds: 30 }, { pollSeconds: 90 }];
    expect(computeMinPollSeconds(connections, 120)).toBe(30);
  });

  test("falls back to defaultPollSeconds when a connection has no pollSeconds", () => {
    const connections = [{}, { pollSeconds: 200 }];
    expect(computeMinPollSeconds(connections, 45)).toBe(45);
  });

  test("falls back to 120 when neither pollSeconds nor defaultPollSeconds is set", () => {
    const connections = [{}];
    expect(computeMinPollSeconds(connections, undefined)).toBe(120);
  });

  test("floors the result at 15 seconds even if every connection asks for less", () => {
    const connections = [{ pollSeconds: 5 }, { pollSeconds: 1 }];
    expect(computeMinPollSeconds(connections, 120)).toBe(15);
  });
});
