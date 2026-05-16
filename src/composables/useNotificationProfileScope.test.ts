import { describe, it, expect } from "vitest";
import { resolveEventProfileId, resolveSessionProfileId } from "./useNotificationProfileScope.js";

describe("resolveSessionProfileId", () => {
  it("prefers the stamped profileId on the session meta", () => {
    const map = new Map([["wsA", "profile-a"]]);
    const id = resolveSessionProfileId({ workspaceId: "wsA", meta: { profileId: "profile-b" } }, map);
    // Stamped profileId wins — the session was created knowing which
    // profile owns it; the workspace lookup is only a fallback.
    expect(id).toBe("profile-b");
  });

  it("falls back to the workspace's profile when no meta stamp exists", () => {
    const map = new Map([["wsA", "profile-a"]]);
    const id = resolveSessionProfileId({ workspaceId: "wsA", meta: null }, map);
    expect(id).toBe("profile-a");
  });

  it("returns '' for sessions whose owner can't be resolved", () => {
    const map = new Map<string, string>();
    expect(resolveSessionProfileId({ workspaceId: "", meta: null }, map)).toBe("");
    expect(resolveSessionProfileId({ workspaceId: "missing", meta: null }, map)).toBe("");
  });
});

describe("resolveEventProfileId", () => {
  const payload = {
    appState: {
      workspaces: [
        { id: "wsA", profileId: "profile-a" },
        { id: "wsB", profileId: "profile-b" },
      ],
      settings: {
        integrations: {
          azureDevops: {
            connections: [
              { id: "conn-az-a", profileId: "profile-a" },
              { id: "conn-az-b", profileId: "profile-b" },
            ],
          },
          github: {
            connections: [
              { id: "conn-gh-a", profileId: "profile-a" },
              { id: "conn-gh-b", profileId: "profile-b" },
            ],
          },
        },
      },
    },
  };

  it("uses reviewWorkspaceId's profile when present", () => {
    const id = resolveEventProfileId({ reviewWorkspaceId: "wsB", connectionId: "conn-az-a" }, "azure-devops", payload);
    // reviewWorkspaceId takes precedence over connectionId — once a review
    // workspace exists, it's the authoritative profile owner for the PR.
    expect(id).toBe("profile-b");
  });

  it("falls back to existingWorkspaceId when reviewWorkspaceId is empty", () => {
    const id = resolveEventProfileId({ existingWorkspaceId: "wsA" }, "github", payload);
    expect(id).toBe("profile-a");
  });

  it("falls back to the connection's profile for new PRs (no review workspace yet)", () => {
    // This is the cross-profile-leak scenario: a brand-new PR has no
    // workspace yet, but the originating connection knows which profile
    // it belongs to. Without this fallback the event would land in
    // every window.
    const idAz = resolveEventProfileId(
      { reviewWorkspaceId: "", existingWorkspaceId: "", connectionId: "conn-az-b" },
      "azure-devops",
      payload,
    );
    expect(idAz).toBe("profile-b");

    const idGh = resolveEventProfileId(
      { reviewWorkspaceId: "", existingWorkspaceId: "", connectionId: "conn-gh-a" },
      "github",
      payload,
    );
    expect(idGh).toBe("profile-a");
  });

  it("returns '' when nothing identifies an owner", () => {
    const id = resolveEventProfileId({ connectionId: "unknown" }, "github", payload);
    expect(id).toBe("");
  });

  it("defaults a profile-less workspace to 'default'", () => {
    const profileless = {
      appState: {
        workspaces: [{ id: "wsX" }],
        settings: { integrations: {} },
      },
    };
    expect(resolveEventProfileId({ existingWorkspaceId: "wsX" }, "github", profileless)).toBe("default");
  });
});
