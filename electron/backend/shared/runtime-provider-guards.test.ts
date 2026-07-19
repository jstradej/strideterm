import { describe, expect, test, vi } from "vitest";
import { resolveRootPath, assertPrInViewerProfile, mirrorActivationIntoSlot } from "./runtime-provider-guards.js";

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
