import { describe, expect, test } from "vitest";
import { RemoteClientRegistry } from "./remote-client-registry.js";

// Minimal AppState shape needed by the registry.
function makeState(
  opts: {
    profiles?: { id: string }[];
    workspaces?: { id: string; profileId?: string }[];
  } = {},
) {
  return {
    profiles: opts.profiles ?? [{ id: "default" }],
    workspaces: opts.workspaces ?? [],
  };
}

describe("RemoteClientRegistry", () => {
  describe("getOrCreate", () => {
    test("creates a new client with the first profile/workspace as default", () => {
      const registry = new RemoteClientRegistry();
      const state = makeState({
        profiles: [{ id: "p1" }, { id: "p2" }],
        workspaces: [
          { id: "ws1", profileId: "p1" },
          { id: "ws2", profileId: "p2" },
        ],
      });
      const client = registry.getOrCreate("session1", state);
      expect(client.id).toBe("session1");
      expect(client.profileId).toBe("p1");
      expect(client.activeWorkspaceId).toBe("ws1");
      expect(client.activeSessionId).toBe("");
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
    test("switches the client to a valid profile and resets workspace", () => {
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
      const client = registry.get("session1")!;
      expect(client.profileId).toBe("p2");
      expect(client.activeWorkspaceId).toBe("ws2");
      expect(client.activeSessionId).toBe("");
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
      // session1 moved to p2
      expect(registry.get("session1")!.profileId).toBe("p2");
      // session2 stays on p1 (default, first profile)
      expect(registry.get("session2")!.profileId).toBe("p1");
    });

    test("activation never touches windowSlots (registry has no slot concept)", () => {
      const registry = new RemoteClientRegistry();
      const state = {
        ...makeState({ profiles: [{ id: "p1" }, { id: "p2" }], workspaces: [] }),
        windowSlots: [{ id: "slot1", profileId: "p1" }],
      };
      registry.getOrCreate("session1", state);
      registry.activateProfile("session1", "p2", state);
      // windowSlots in the passed state must not be modified
      expect(state.windowSlots[0].profileId).toBe("p1");
    });

    test("throws when profile not found", () => {
      const registry = new RemoteClientRegistry();
      const state = makeState({ profiles: [{ id: "p1" }] });
      registry.getOrCreate("session1", state);
      expect(() => registry.activateProfile("session1", "nonexistent", state)).toThrow("Profile not found");
    });

    test("throws when client not found", () => {
      const registry = new RemoteClientRegistry();
      const state = makeState({ profiles: [{ id: "p1" }] });
      expect(() => registry.activateProfile("ghost", "p1", state)).toThrow("Remote client session not found");
    });
  });

  describe("activateWorkspace", () => {
    test("switches workspace within the client's active profile", () => {
      const registry = new RemoteClientRegistry();
      const state = makeState({
        profiles: [{ id: "p1" }],
        workspaces: [
          { id: "ws1", profileId: "p1" },
          { id: "ws2", profileId: "p1" },
        ],
      });
      registry.getOrCreate("session1", state);
      registry.activateWorkspace("session1", "ws2", state);
      expect(registry.get("session1")!.activeWorkspaceId).toBe("ws2");
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
      registry.getOrCreate("session1", state); // starts on p1 / ws1
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
  });

  describe("activateSession", () => {
    test("activates a session that belongs to the workspace", () => {
      const registry = new RemoteClientRegistry();
      const state = makeState({
        profiles: [{ id: "p1" }],
        workspaces: [{ id: "ws1", profileId: "p1" }],
      });
      registry.getOrCreate("session1", state);
      registry.activateSession("session1", "ws1", "ws1:panel1", state);
      const client = registry.get("session1")!;
      expect(client.activeWorkspaceId).toBe("ws1");
      expect(client.activeSessionId).toBe("ws1:panel1");
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
      registry.getOrCreate("session1", state); // on p1
      expect(() => registry.activateSession("session1", "ws2", "ws2:panel1", state)).toThrow(
        "Workspace does not belong to the active profile",
      );
    });
  });

  describe("fallbackDeletedProfile", () => {
    test("moves affected clients to the first remaining profile", () => {
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

      // Now p2 is deleted — pass state without p2
      const stateAfterDelete = makeState({
        profiles: [{ id: "p1" }],
        workspaces: [{ id: "ws1", profileId: "p1" }],
      });
      const affected = registry.fallbackDeletedProfile("p2", stateAfterDelete);
      expect(affected).toContain("session1");
      expect(registry.get("session1")!.profileId).toBe("p1");
      expect(registry.get("session1")!.activeWorkspaceId).toBe("ws1");
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

  describe("fallbackDeletedWorkspace", () => {
    test("moves clients to sibling workspace when their active workspace is deleted", () => {
      const registry = new RemoteClientRegistry();
      const state = makeState({
        profiles: [{ id: "p1" }],
        workspaces: [
          { id: "ws1", profileId: "p1" },
          { id: "ws2", profileId: "p1" },
        ],
      });
      registry.getOrCreate("session1", state); // starts on ws1
      // Delete ws1 — pass state without ws1
      const stateAfterDelete = makeState({
        profiles: [{ id: "p1" }],
        workspaces: [{ id: "ws2", profileId: "p1" }],
      });
      const affected = registry.fallbackDeletedWorkspace("ws1", stateAfterDelete);
      expect(affected).toContain("session1");
      expect(registry.get("session1")!.activeWorkspaceId).toBe("ws2");
      expect(registry.get("session1")!.activeSessionId).toBe("");
    });

    test("sets empty workspace when no sibling exists", () => {
      const registry = new RemoteClientRegistry();
      const state = makeState({
        profiles: [{ id: "p1" }],
        workspaces: [{ id: "ws1", profileId: "p1" }],
      });
      registry.getOrCreate("session1", state);
      const affected = registry.fallbackDeletedWorkspace("ws1", makeState({ profiles: [{ id: "p1" }] }));
      expect(affected).toContain("session1");
      expect(registry.get("session1")!.activeWorkspaceId).toBe("");
    });
  });

  describe("composePayload", () => {
    test("injects remoteClient field for the requesting session", () => {
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
      registry.activateProfile("session2", "p2", state);

      const basePayload = { appState: { ...state, windowSlots: [] }, meta: {} };
      const payload1 = registry.composePayload("session1", basePayload) as Record<string, unknown>;
      const payload2 = registry.composePayload("session2", basePayload) as Record<string, unknown>;

      expect((payload1.remoteClient as Record<string, unknown>).profileId).toBe("p1");
      expect((payload2.remoteClient as Record<string, unknown>).profileId).toBe("p2");
    });

    test("reduces windowSlots to id/profileId/windowIndex only", () => {
      const registry = new RemoteClientRegistry();
      const state = makeState({ profiles: [{ id: "p1" }] });
      registry.getOrCreate("session1", state);
      const basePayload = {
        appState: {
          ...state,
          windowSlots: [
            { id: "slot1", profileId: "p1", bounds: { x: 0, y: 0, width: 800, height: 600 }, lastFocusedAt: 123 },
            { id: "slot2", profileId: "p1", bounds: { x: 100, y: 100, width: 800, height: 600 } },
          ],
        },
      };
      const result = registry.composePayload("session1", basePayload) as Record<string, unknown>;
      const slots = (result.appState as Record<string, unknown>).windowSlots as unknown[];
      expect(slots).toHaveLength(2);
      expect(slots[0]).toEqual({ id: "slot1", profileId: "p1", windowIndex: 1 });
      expect(slots[1]).toEqual({ id: "slot2", profileId: "p1", windowIndex: 2 });
      // bounds/lastFocusedAt must not be included
      expect(Object.keys(slots[0] as object)).not.toContain("bounds");
      expect(Object.keys(slots[0] as object)).not.toContain("lastFocusedAt");
    });

    test("lazy-falls-back profile when the stored profileId no longer exists", () => {
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

      // Compose with a payload where p2 was deleted
      const basePayload = {
        appState: {
          profiles: [{ id: "p1" }],
          workspaces: [{ id: "ws1", profileId: "p1" }],
          windowSlots: [],
        },
      };
      const result = registry.composePayload("session1", basePayload) as Record<string, unknown>;
      expect((result.remoteClient as Record<string, unknown>).profileId).toBe("p1");
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
});
