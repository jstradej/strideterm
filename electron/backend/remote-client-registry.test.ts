import { describe, expect, test } from "vitest";
import { RemoteClientRegistry } from "./remote-client-registry.js";

// Minimal AppState shape needed by the registry. Each profile gets a
// matching windowSlot by default (so the registry's "profile open on desktop"
// invariants hold without callers spelling out slots every time).
function makeState(
  opts: {
    profiles?: { id: string }[];
    workspaces?: { id: string; profileId?: string }[];
    windowSlots?: { id: string; profileId: string; activeWorkspaceId?: string; activeSessionId?: string }[];
  } = {},
) {
  const profiles = opts.profiles ?? [{ id: "default" }];
  const workspaces = opts.workspaces ?? [];
  const defaultSlots = profiles.map((profile, idx) => {
    const firstWs = workspaces.find((w) => (w.profileId || "default") === profile.id);
    return {
      id: `win-${idx + 1}`,
      profileId: profile.id,
      activeWorkspaceId: firstWs?.id ?? "",
      activeSessionId: "",
    };
  });
  return {
    profiles,
    workspaces,
    windowSlots: opts.windowSlots ?? defaultSlots,
  };
}

describe("RemoteClientRegistry", () => {
  describe("getOrCreate", () => {
    test("creates a new client bound to the first open desktop profile", () => {
      const registry = new RemoteClientRegistry();
      const state = makeState({
        profiles: [{ id: "p1" }, { id: "p2" }],
        workspaces: [
          { id: "ws1", profileId: "p1" },
          { id: "ws2", profileId: "p2" },
        ],
        windowSlots: [{ id: "win-2", profileId: "p2", activeWorkspaceId: "ws2" }],
      });
      const client = registry.getOrCreate("session1", state);
      expect(client.id).toBe("session1");
      expect(client.profileId).toBe("p2");
    });

    test("uses requested bootstrap profile when it is open on desktop", () => {
      const registry = new RemoteClientRegistry();
      const state = makeState({
        profiles: [{ id: "p1" }, { id: "p2" }],
        workspaces: [
          { id: "ws1", profileId: "p1" },
          { id: "ws2", profileId: "p2" },
        ],
      });
      const client = registry.getOrCreate("session1", state, "p2");
      expect(client.profileId).toBe("p2");
    });

    test("returns existing client on repeat call", () => {
      const registry = new RemoteClientRegistry();
      const state = makeState({ profiles: [{ id: "p1" }] });
      const c1 = registry.getOrCreate("session1", state);
      c1.profileId = "p1";
      const c2 = registry.getOrCreate("session1", state);
      expect(c2).toBe(c1);
    });
  });

  describe("activateProfile", () => {
    test("switches the client to a valid profile", () => {
      const registry = new RemoteClientRegistry();
      const state = makeState({
        profiles: [{ id: "p1" }, { id: "p2" }],
        workspaces: [
          { id: "ws1", profileId: "p1" },
          { id: "ws2", profileId: "p2" },
        ],
      });
      registry.getOrCreate("session1", state);
      registry.activateProfile("session1", "p2", state);
      expect(registry.get("session1")!.profileId).toBe("p2");
    });

    test("two clients, two profiles: activating profile on one does not change the other", () => {
      const registry = new RemoteClientRegistry();
      const state = makeState({
        profiles: [{ id: "p1" }, { id: "p2" }],
        workspaces: [
          { id: "ws1", profileId: "p1" },
          { id: "ws2", profileId: "p2" },
        ],
      });
      registry.getOrCreate("session1", state);
      registry.getOrCreate("session2", state);
      registry.activateProfile("session1", "p2", state);
      expect(registry.get("session1")!.profileId).toBe("p2");
      expect(registry.get("session2")!.profileId).toBe("p1");
    });

    test("activation rejects persisted profiles that are not open in desktop windowSlots", () => {
      const registry = new RemoteClientRegistry();
      const state = {
        ...makeState({ profiles: [{ id: "p1" }, { id: "p2" }], workspaces: [] }),
        windowSlots: [{ id: "slot1", profileId: "p1", activeWorkspaceId: "" }],
      };
      registry.getOrCreate("session1", state);
      expect(() => registry.activateProfile("session1", "p2", state)).toThrow("Profile is not open on desktop");
    });

    test("throws when profile not found", () => {
      const registry = new RemoteClientRegistry();
      const state = makeState({ profiles: [{ id: "p1" }] });
      registry.getOrCreate("session1", state);
      expect(() => registry.activateProfile("session1", "nonexistent", state)).toThrow(
        "Profile is not open on desktop",
      );
    });

    test("throws when client not found", () => {
      const registry = new RemoteClientRegistry();
      const state = makeState({ profiles: [{ id: "p1" }] });
      expect(() => registry.activateProfile("ghost", "p1", state)).toThrow("Remote client session not found");
    });
  });

  describe("getBoundWindowId", () => {
    test("returns the windowId for the bound profile's desktop slot", () => {
      const registry = new RemoteClientRegistry();
      const state = makeState({
        profiles: [{ id: "p1" }],
        workspaces: [{ id: "ws1", profileId: "p1" }],
        windowSlots: [{ id: "win-1", profileId: "p1", activeWorkspaceId: "ws1" }],
      });
      registry.getOrCreate("session1", state);
      expect(registry.getBoundWindowId("session1", state)).toBe("win-1");
    });

    test("returns the slot matching the client's profile when multiple slots are open", () => {
      const registry = new RemoteClientRegistry();
      const state = makeState({
        profiles: [{ id: "p1" }, { id: "p2" }],
        workspaces: [
          { id: "ws1", profileId: "p1" },
          { id: "ws2", profileId: "p2" },
        ],
        windowSlots: [
          { id: "win-1", profileId: "p1", activeWorkspaceId: "ws1" },
          { id: "win-2", profileId: "p2", activeWorkspaceId: "ws2" },
        ],
      });
      registry.getOrCreate("session1", state, "p2");
      expect(registry.getBoundWindowId("session1", state)).toBe("win-2");
    });

    test("returns empty string when session is unknown", () => {
      const registry = new RemoteClientRegistry();
      const state = makeState({ profiles: [{ id: "p1" }] });
      expect(registry.getBoundWindowId("ghost", state)).toBe("");
    });

    test("returns empty string when bound profile has no open slot", () => {
      const registry = new RemoteClientRegistry();
      const state = makeState({
        profiles: [{ id: "p1" }],
        workspaces: [{ id: "ws1", profileId: "p1" }],
      });
      registry.getOrCreate("session1", state);
      const stateAfterClose = { ...state, windowSlots: [] };
      expect(registry.getBoundWindowId("session1", stateAfterClose)).toBe("");
    });
  });

  describe("activateWorkspace", () => {
    test("returns the windowId for the bound profile's desktop slot", () => {
      const registry = new RemoteClientRegistry();
      const state = makeState({
        profiles: [{ id: "p1" }],
        workspaces: [
          { id: "ws1", profileId: "p1" },
          { id: "ws2", profileId: "p1" },
        ],
        windowSlots: [{ id: "win-1", profileId: "p1", activeWorkspaceId: "ws1" }],
      });
      registry.getOrCreate("session1", state);
      const result = registry.activateWorkspace("session1", "ws2", state);
      expect(result.windowId).toBe("win-1");
    });

    test("rejects workspace from a different profile", () => {
      const registry = new RemoteClientRegistry();
      const state = makeState({
        profiles: [{ id: "p1" }, { id: "p2" }],
        workspaces: [
          { id: "ws1", profileId: "p1" },
          { id: "ws2", profileId: "p2" },
        ],
      });
      registry.getOrCreate("session1", state);
      expect(() => registry.activateWorkspace("session1", "ws2", state)).toThrow(
        "Workspace does not belong to the active profile",
      );
    });

    test("throws when workspace not found", () => {
      const registry = new RemoteClientRegistry();
      const state = makeState({ profiles: [{ id: "p1" }] });
      registry.getOrCreate("session1", state);
      expect(() => registry.activateWorkspace("session1", "nonexistent", state)).toThrow("Workspace not found");
    });

    test("throws when profile is no longer open in any desktop slot", () => {
      const registry = new RemoteClientRegistry();
      const state = makeState({
        profiles: [{ id: "p1" }],
        workspaces: [{ id: "ws1", profileId: "p1" }],
      });
      registry.getOrCreate("session1", state);
      const stateAfterClose = { ...state, windowSlots: [] };
      // Profile validation happens before slot lookup, so workspace-validation
      // error wins when the workspace's profile is no longer the client's
      // (after lazy fallback would run). Here we exercise the slot-lookup
      // failure directly by keeping client's profileId but closing the slot.
      const client = registry.get("session1")!;
      client.profileId = "p1";
      expect(() => registry.activateWorkspace("session1", "ws1", stateAfterClose)).toThrow(
        "Profile is not open on desktop",
      );
    });
  });

  describe("activateSession", () => {
    test("returns the windowId for a session that belongs to the workspace", () => {
      const registry = new RemoteClientRegistry();
      const state = makeState({
        profiles: [{ id: "p1" }],
        workspaces: [{ id: "ws1", profileId: "p1" }],
      });
      registry.getOrCreate("session1", state);
      const result = registry.activateSession("session1", "ws1", "ws1:panel1", state);
      expect(result.windowId).toBe("win-1");
    });

    test("rejects session that does not start with workspaceId:", () => {
      const registry = new RemoteClientRegistry();
      const state = makeState({
        profiles: [{ id: "p1" }],
        workspaces: [{ id: "ws1", profileId: "p1" }],
      });
      registry.getOrCreate("session1", state);
      expect(() => registry.activateSession("session1", "ws1", "ws2:panel1", state)).toThrow(
        "Session does not belong to workspace",
      );
    });

    test("rejects session when workspace belongs to a different profile", () => {
      const registry = new RemoteClientRegistry();
      const state = makeState({
        profiles: [{ id: "p1" }, { id: "p2" }],
        workspaces: [
          { id: "ws1", profileId: "p1" },
          { id: "ws2", profileId: "p2" },
        ],
      });
      registry.getOrCreate("session1", state);
      expect(() => registry.activateSession("session1", "ws2", "ws2:panel1", state)).toThrow(
        "Workspace does not belong to the active profile",
      );
    });
  });

  describe("fallbackDeletedProfile", () => {
    test("moves affected clients to the first remaining open profile", () => {
      const registry = new RemoteClientRegistry();
      const stateWithP2 = makeState({
        profiles: [{ id: "p1" }, { id: "p2" }],
        workspaces: [
          { id: "ws1", profileId: "p1" },
          { id: "ws2", profileId: "p2" },
        ],
      });
      registry.getOrCreate("session1", stateWithP2);
      registry.activateProfile("session1", "p2", stateWithP2);

      const stateAfterDelete = makeState({
        profiles: [{ id: "p1" }],
        workspaces: [{ id: "ws1", profileId: "p1" }],
      });
      const affected = registry.fallbackDeletedProfile("p2", stateAfterDelete);
      expect(affected).toContain("session1");
      expect(registry.get("session1")!.profileId).toBe("p1");
    });

    test("returns empty array when no clients are on the deleted profile", () => {
      const registry = new RemoteClientRegistry();
      const state = makeState({ profiles: [{ id: "p1" }] });
      registry.getOrCreate("session1", state);
      const affected = registry.fallbackDeletedProfile("p2", state);
      expect(affected).toHaveLength(0);
      expect(registry.get("session1")!.profileId).toBe("p1");
    });
  });

  describe("composePayload", () => {
    test("injects remoteClient with active workspace/session derived from the bound slot", () => {
      const registry = new RemoteClientRegistry();
      const state = makeState({
        profiles: [{ id: "p1" }, { id: "p2" }],
        workspaces: [
          { id: "ws1", profileId: "p1" },
          { id: "ws2", profileId: "p2" },
        ],
        windowSlots: [
          { id: "win-1", profileId: "p1", activeWorkspaceId: "ws1", activeSessionId: "ws1:panel1" },
          { id: "win-2", profileId: "p2", activeWorkspaceId: "ws2", activeSessionId: "" },
        ],
      });
      registry.getOrCreate("session1", state);
      registry.getOrCreate("session2", state);
      registry.activateProfile("session2", "p2", state);

      const basePayload = { appState: { ...state }, meta: {} };
      const payload1 = registry.composePayload("session1", basePayload) as Record<string, unknown>;
      const payload2 = registry.composePayload("session2", basePayload) as Record<string, unknown>;

      const rc1 = payload1.remoteClient as Record<string, unknown>;
      expect(rc1.profileId).toBe("p1");
      expect(rc1.activeWorkspaceId).toBe("ws1");
      expect(rc1.activeSessionId).toBe("ws1:panel1");

      const rc2 = payload2.remoteClient as Record<string, unknown>;
      expect(rc2.profileId).toBe("p2");
      expect(rc2.activeWorkspaceId).toBe("ws2");
      expect(rc2.activeSessionId).toBe("");
    });

    test("mirrors desktop changes: composing again picks up the slot's new activeWorkspaceId", () => {
      const registry = new RemoteClientRegistry();
      const state = makeState({
        profiles: [{ id: "p1" }],
        workspaces: [
          { id: "ws1", profileId: "p1" },
          { id: "ws2", profileId: "p1" },
        ],
        windowSlots: [{ id: "win-1", profileId: "p1", activeWorkspaceId: "ws1" }],
      });
      registry.getOrCreate("session1", state);

      // Desktop switches workspace in win-1.
      const stateAfter = {
        ...state,
        windowSlots: [{ id: "win-1", profileId: "p1", activeWorkspaceId: "ws2", activeSessionId: "" }],
      };
      const result = registry.composePayload("session1", { appState: stateAfter }) as Record<string, unknown>;
      const rc = result.remoteClient as Record<string, unknown>;
      expect(rc.activeWorkspaceId).toBe("ws2");
    });

    test("reduces windowSlots to id/profileId/windowIndex only", () => {
      const registry = new RemoteClientRegistry();
      const state = makeState({ profiles: [{ id: "p1" }] });
      registry.getOrCreate("session1", state);
      const basePayload = {
        appState: {
          ...state,
          windowSlots: [
            {
              id: "slot1",
              profileId: "p1",
              activeWorkspaceId: "",
              bounds: { x: 0, y: 0, width: 800, height: 600 },
              lastFocusedAt: 123,
            },
            {
              id: "slot2",
              profileId: "p1",
              activeWorkspaceId: "",
              bounds: { x: 100, y: 100, width: 800, height: 600 },
            },
          ],
        },
      };
      const result = registry.composePayload("session1", basePayload) as Record<string, unknown>;
      const slots = (result.appState as Record<string, unknown>).windowSlots as unknown[];
      expect(slots).toHaveLength(2);
      expect(slots[0]).toEqual({ id: "slot1", profileId: "p1", windowIndex: 1 });
      expect(slots[1]).toEqual({ id: "slot2", profileId: "p1", windowIndex: 2 });
      expect(Object.keys(slots[0] as object)).not.toContain("bounds");
      expect(Object.keys(slots[0] as object)).not.toContain("lastFocusedAt");
    });

    test("lazy-falls-back profile when its desktop slot closes", () => {
      const registry = new RemoteClientRegistry();
      const initialState = makeState({
        profiles: [{ id: "p1" }, { id: "p2" }],
        workspaces: [
          { id: "ws1", profileId: "p1" },
          { id: "ws2", profileId: "p2" },
        ],
      });
      registry.getOrCreate("session1", initialState);
      registry.activateProfile("session1", "p2", initialState);

      // Window 2 closes.
      const basePayload = {
        appState: {
          profiles: [{ id: "p1" }, { id: "p2" }],
          workspaces: [
            { id: "ws1", profileId: "p1" },
            { id: "ws2", profileId: "p2" },
          ],
          windowSlots: [{ id: "win-1", profileId: "p1", activeWorkspaceId: "ws1" }],
        },
      };
      const result = registry.composePayload("session1", basePayload) as Record<string, unknown>;
      const rc = result.remoteClient as Record<string, unknown>;
      expect(rc.profileId).toBe("p1");
      expect(rc.activeWorkspaceId).toBe("ws1");
    });

    test("returns payload without remoteClient when session is not in registry", () => {
      const registry = new RemoteClientRegistry();
      const basePayload = { appState: { profiles: [], workspaces: [], windowSlots: [] } };
      const result = registry.composePayload("unknown-session", basePayload) as Record<string, unknown>;
      expect(result.remoteClient).toBeUndefined();
    });
  });

  describe("TTL sweep", () => {
    test("startCleanupSweep / stopCleanupSweep do not throw", () => {
      const registry = new RemoteClientRegistry();
      expect(() => {
        registry.startCleanupSweep();
        registry.stopCleanupSweep();
      }).not.toThrow();
    });
  });

  describe("visual-profile-switch — remote semantics unchanged", () => {
    test("activateProfile rejects profile with saved lastActiveWorkspaceId but no windowSlot", () => {
      // A profile may have `lastActiveWorkspaceId` from visual profile switch
      // persistence but no open desktop window. Remote clients must still be
      // unable to switch to it.
      const registry = new RemoteClientRegistry();
      const state = {
        profiles: [{ id: "p1" }, { id: "p2", lastActiveWorkspaceId: "ws2", lastActiveSessionId: "ws2:shell" }],
        workspaces: [
          { id: "ws1", profileId: "p1" },
          { id: "ws2", profileId: "p2" },
        ],
        windowSlots: [{ id: "win-1", profileId: "p1", activeWorkspaceId: "ws1", activeSessionId: "" }],
      };
      registry.getOrCreate("session1", state);
      expect(() => registry.activateProfile("session1", "p2", state)).toThrow("Profile is not open on desktop");
    });

    test("composePayload mirrors active workspace from desktop slot, not Profile.lastActiveWorkspaceId", () => {
      // Even if the profile has a different lastActiveWorkspaceId stored,
      // the remote payload should reflect the slot's actual active workspace.
      const registry = new RemoteClientRegistry();
      const state = makeState({
        profiles: [{ id: "p1" }],
        workspaces: [
          { id: "ws-slot", profileId: "p1" },
          { id: "ws-saved", profileId: "p1" },
        ],
        windowSlots: [{ id: "win-1", profileId: "p1", activeWorkspaceId: "ws-slot", activeSessionId: "" }],
      });
      registry.getOrCreate("session1", state);
      const payload = {
        appState: {
          ...state,
          profiles: [{ id: "p1", lastActiveWorkspaceId: "ws-saved" }],
        },
      };
      const composed = registry.composePayload("session1", payload) as Record<string, unknown>;
      const rc = composed.remoteClient as Record<string, unknown>;
      // Remote client active workspace must be derived from the slot, not the saved id.
      expect(rc.activeWorkspaceId).toBe("ws-slot");
    });
  });
});
