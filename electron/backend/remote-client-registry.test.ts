import { describe, expect, test } from "vitest";
import { RemoteClientRegistry } from "./remote-client-registry.js";

// Minimal AppState shape needed by the registry. Each profile gets a
// matching windowSlot by default — but the registry no longer requires the
// profile to be open on the desktop; the remote client is an independent
// viewer with its own active workspace/session/grid.
function makeState(
  opts: {
    profiles?: { id: string; lastActiveWorkspaceId?: string; lastActiveSessionId?: string; workspaceGrid?: unknown }[];
    workspaces?: { id: string; profileId?: string }[];
    windowSlots?: {
      id: string;
      profileId: string;
      activeWorkspaceId?: string;
      activeSessionId?: string;
      lastFocusedAt?: number;
    }[];
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
      // View state is the client's own, seeded from the profile defaults.
      expect(client.activeWorkspaceId).toBe("ws2");
    });

    test("falls back to the first existing profile when no desktop window is open", () => {
      const registry = new RemoteClientRegistry();
      const state = makeState({
        profiles: [{ id: "p1" }],
        workspaces: [{ id: "ws1", profileId: "p1" }],
        windowSlots: [],
      });
      const client = registry.getOrCreate("session1", state);
      expect(client.profileId).toBe("p1");
      expect(client.activeWorkspaceId).toBe("ws1");
    });

    test("uses requested bootstrap profile even when it is NOT open on desktop", () => {
      const registry = new RemoteClientRegistry();
      const state = makeState({
        profiles: [{ id: "p1" }, { id: "p2" }],
        workspaces: [
          { id: "ws1", profileId: "p1" },
          { id: "ws2", profileId: "p2" },
        ],
        windowSlots: [{ id: "win-1", profileId: "p1", activeWorkspaceId: "ws1" }],
      });
      const client = registry.getOrCreate("session1", state, "p2");
      expect(client.profileId).toBe("p2");
      expect(client.activeWorkspaceId).toBe("ws2");
    });

    test("seeds view state from the profile's lastActive ids when the profile has no desktop window", () => {
      const registry = new RemoteClientRegistry();
      const state = makeState({
        profiles: [{ id: "p1", lastActiveWorkspaceId: "ws2", lastActiveSessionId: "ws2:shell" }],
        workspaces: [
          { id: "ws1", profileId: "p1" },
          { id: "ws2", profileId: "p1" },
        ],
        windowSlots: [],
      });
      const client = registry.getOrCreate("session1", state);
      expect(client.activeWorkspaceId).toBe("ws2");
      expect(client.activeSessionId).toBe("ws2:shell");
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

  // A client adopts the desktop's CURRENT view for its profile when it binds,
  // because profile.lastActive* is only written on deactivation-ish events and
  // drifts from what the user is looking at. Adoption happens on (re)bind only
  // — never on the broadcast path — so an established remote view is never
  // dragged around by the desktop mid-session.
  describe("seedViewState — adopting the desktop view", () => {
    test("prefers the profile's live desktop window over the lastActive mirror", () => {
      const registry = new RemoteClientRegistry();
      const state = makeState({
        profiles: [{ id: "p1", lastActiveWorkspaceId: "ws-stale", lastActiveSessionId: "ws-stale:shell" }],
        workspaces: [
          { id: "ws-stale", profileId: "p1" },
          { id: "ws-live", profileId: "p1" },
        ],
        windowSlots: [{ id: "win-1", profileId: "p1", activeWorkspaceId: "ws-live", activeSessionId: "ws-live:term" }],
      });
      const client = registry.getOrCreate("session1", state);
      expect(client.activeWorkspaceId).toBe("ws-live");
      expect(client.activeSessionId).toBe("ws-live:term");
    });

    test("picks the most recently focused window when the profile has several", () => {
      const registry = new RemoteClientRegistry();
      const state = makeState({
        profiles: [{ id: "p1" }],
        workspaces: [
          { id: "ws-a", profileId: "p1" },
          { id: "ws-b", profileId: "p1" },
        ],
        windowSlots: [
          { id: "win-1", profileId: "p1", activeWorkspaceId: "ws-a", activeSessionId: "ws-a:x", lastFocusedAt: 100 },
          { id: "win-2", profileId: "p1", activeWorkspaceId: "ws-b", activeSessionId: "ws-b:y", lastFocusedAt: 900 },
        ],
      });
      const client = registry.getOrCreate("session1", state);
      expect(client.activeWorkspaceId).toBe("ws-b");
      expect(client.activeSessionId).toBe("ws-b:y");
    });

    test("most-recent wins regardless of slot array order", () => {
      const registry = new RemoteClientRegistry();
      const state = makeState({
        profiles: [{ id: "p1" }],
        workspaces: [
          { id: "ws-a", profileId: "p1" },
          { id: "ws-b", profileId: "p1" },
        ],
        windowSlots: [
          { id: "win-2", profileId: "p1", activeWorkspaceId: "ws-b", lastFocusedAt: 900 },
          { id: "win-1", profileId: "p1", activeWorkspaceId: "ws-a", lastFocusedAt: 100 },
        ],
      });
      expect(registry.getOrCreate("session1", state).activeWorkspaceId).toBe("ws-b");
    });

    test("ties on lastFocusedAt resolve to the first slot, deterministically", () => {
      const registry = new RemoteClientRegistry();
      const state = makeState({
        profiles: [{ id: "p1" }],
        workspaces: [
          { id: "ws-a", profileId: "p1" },
          { id: "ws-b", profileId: "p1" },
        ],
        windowSlots: [
          { id: "win-1", profileId: "p1", activeWorkspaceId: "ws-a", lastFocusedAt: 500 },
          { id: "win-2", profileId: "p1", activeWorkspaceId: "ws-b", lastFocusedAt: 500 },
        ],
      });
      expect(registry.getOrCreate("s1", state).activeWorkspaceId).toBe("ws-a");
      expect(registry.getOrCreate("s2", state).activeWorkspaceId).toBe("ws-a");
    });

    test("slots with no lastFocusedAt at all still resolve to the first slot", () => {
      const registry = new RemoteClientRegistry();
      const state = makeState({
        profiles: [{ id: "p1" }],
        workspaces: [
          { id: "ws-a", profileId: "p1" },
          { id: "ws-b", profileId: "p1" },
        ],
        windowSlots: [
          { id: "win-1", profileId: "p1", activeWorkspaceId: "ws-a" },
          { id: "win-2", profileId: "p1", activeWorkspaceId: "ws-b" },
        ],
      });
      expect(registry.getOrCreate("session1", state).activeWorkspaceId).toBe("ws-a");
    });

    test("ignores desktop windows belonging to other profiles", () => {
      const registry = new RemoteClientRegistry();
      const state = makeState({
        profiles: [{ id: "p1", lastActiveWorkspaceId: "ws1b" }, { id: "p2" }],
        workspaces: [
          { id: "ws1a", profileId: "p1" },
          { id: "ws1b", profileId: "p1" },
          { id: "ws2", profileId: "p2" },
        ],
        // A p2 window is focused far more recently — it must not seed a p1 client.
        windowSlots: [{ id: "win-2", profileId: "p2", activeWorkspaceId: "ws2", lastFocusedAt: 9999 }],
      });
      const client = registry.getOrCreate("session1", state, "p1");
      expect(client.profileId).toBe("p1");
      expect(client.activeWorkspaceId).toBe("ws1b");
    });

    test("falls back to the mirror when the desktop workspace left the profile", () => {
      const registry = new RemoteClientRegistry();
      const state = makeState({
        profiles: [{ id: "p1", lastActiveWorkspaceId: "ws-mirror", lastActiveSessionId: "ws-mirror:shell" }],
        workspaces: [
          { id: "ws-mirror", profileId: "p1" },
          { id: "ws-moved", profileId: "p2" },
        ],
        // Slot still points at a workspace that now belongs to p2.
        windowSlots: [{ id: "win-1", profileId: "p1", activeWorkspaceId: "ws-moved" }],
      });
      const client = registry.getOrCreate("session1", state);
      expect(client.activeWorkspaceId).toBe("ws-mirror");
      expect(client.activeSessionId).toBe("ws-mirror:shell");
    });

    test("falls back to the first profile workspace when neither slot nor mirror is usable", () => {
      const registry = new RemoteClientRegistry();
      const state = makeState({
        profiles: [{ id: "p1", lastActiveWorkspaceId: "ws-gone" }],
        workspaces: [
          { id: "ws-first", profileId: "p1" },
          { id: "ws-second", profileId: "p1" },
        ],
        windowSlots: [{ id: "win-1", profileId: "p1", activeWorkspaceId: "" }],
      });
      const client = registry.getOrCreate("session1", state);
      expect(client.activeWorkspaceId).toBe("ws-first");
      expect(client.activeSessionId).toBe("");
    });

    test("does not pair an adopted desktop workspace with a mirrored session", () => {
      const registry = new RemoteClientRegistry();
      const state = makeState({
        profiles: [{ id: "p1", lastActiveWorkspaceId: "ws-other", lastActiveSessionId: "ws-other:shell" }],
        workspaces: [
          { id: "ws-live", profileId: "p1" },
          { id: "ws-other", profileId: "p1" },
        ],
        // Desktop shows ws-live with no focused session — the client must show
        // the same, not ws-live plus a session mirrored from another workspace.
        windowSlots: [{ id: "win-1", profileId: "p1", activeWorkspaceId: "ws-live", activeSessionId: "" }],
      });
      const client = registry.getOrCreate("session1", state);
      expect(client.activeWorkspaceId).toBe("ws-live");
      expect(client.activeSessionId).toBe("");
    });

    test("clears an adopted session that does not belong to the adopted workspace", () => {
      const registry = new RemoteClientRegistry();
      const state = makeState({
        profiles: [{ id: "p1" }],
        workspaces: [
          { id: "ws-a", profileId: "p1" },
          { id: "ws-b", profileId: "p1" },
        ],
        windowSlots: [{ id: "win-1", profileId: "p1", activeWorkspaceId: "ws-a", activeSessionId: "ws-b:shell" }],
      });
      const client = registry.getOrCreate("session1", state);
      expect(client.activeWorkspaceId).toBe("ws-a");
      expect(client.activeSessionId).toBe("");
    });

    test("adoption does not follow the desktop after the client is bound", () => {
      const registry = new RemoteClientRegistry();
      const state = makeState({
        profiles: [{ id: "p1" }],
        workspaces: [
          { id: "ws-a", profileId: "p1" },
          { id: "ws-b", profileId: "p1" },
        ],
        windowSlots: [{ id: "win-1", profileId: "p1", activeWorkspaceId: "ws-a", activeSessionId: "ws-a:shell" }],
      });
      const client = registry.getOrCreate("session1", state);
      expect(client.activeWorkspaceId).toBe("ws-a");

      // Desktop moves on. A reconnect (same cookie session) must NOT re-adopt —
      // otherwise a phone on a flaky link gets yanked around on every reconnect.
      const moved = makeState({
        profiles: [{ id: "p1" }],
        workspaces: [
          { id: "ws-a", profileId: "p1" },
          { id: "ws-b", profileId: "p1" },
        ],
        windowSlots: [
          {
            id: "win-1",
            profileId: "p1",
            activeWorkspaceId: "ws-b",
            activeSessionId: "ws-b:shell",
            lastFocusedAt: 999,
          },
        ],
      });
      expect(registry.getOrCreate("session1", moved)).toBe(client);
      expect(client.activeWorkspaceId).toBe("ws-a");
      expect(client.activeSessionId).toBe("ws-a:shell");

      // Nor via the broadcast path.
      const composed = registry.composePayload("session1", { appState: moved }) as Record<string, unknown>;
      expect((composed.remoteClient as Record<string, unknown>).activeWorkspaceId).toBe("ws-a");
    });

    test("a client that picked its own workspace keeps it across broadcasts", () => {
      const registry = new RemoteClientRegistry();
      const state = makeState({
        profiles: [{ id: "p1" }],
        workspaces: [
          { id: "ws-a", profileId: "p1" },
          { id: "ws-b", profileId: "p1" },
        ],
        windowSlots: [{ id: "win-1", profileId: "p1", activeWorkspaceId: "ws-a", lastFocusedAt: 999 }],
      });
      registry.getOrCreate("session1", state);
      registry.activateWorkspace("session1", "ws-b", state);
      const composed = registry.composePayload("session1", { appState: state }) as Record<string, unknown>;
      expect((composed.remoteClient as Record<string, unknown>).activeWorkspaceId).toBe("ws-b");
    });

    test("switching profile adopts that profile's desktop view", () => {
      const registry = new RemoteClientRegistry();
      const state = makeState({
        profiles: [{ id: "p1" }, { id: "p2", lastActiveWorkspaceId: "ws2-stale" }],
        workspaces: [
          { id: "ws1", profileId: "p1" },
          { id: "ws2-stale", profileId: "p2" },
          { id: "ws2-live", profileId: "p2" },
        ],
        windowSlots: [
          { id: "win-1", profileId: "p1", activeWorkspaceId: "ws1", lastFocusedAt: 100 },
          {
            id: "win-2",
            profileId: "p2",
            activeWorkspaceId: "ws2-live",
            activeSessionId: "ws2-live:t",
            lastFocusedAt: 50,
          },
        ],
      });
      registry.getOrCreate("session1", state);
      registry.activateProfile("session1", "p2", state);
      expect(registry.get("session1")!.activeWorkspaceId).toBe("ws2-live");
      expect(registry.get("session1")!.activeSessionId).toBe("ws2-live:t");
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
      expect(registry.get("session1")!.activeWorkspaceId).toBe("ws2");
    });

    test("allows a profile that has NO desktop window (independent viewer)", () => {
      const registry = new RemoteClientRegistry();
      const state = makeState({
        profiles: [{ id: "p1" }, { id: "p-desktopless", lastActiveWorkspaceId: "ws2" }],
        workspaces: [
          { id: "ws1", profileId: "p1" },
          { id: "ws2", profileId: "p-desktopless" },
        ],
        windowSlots: [{ id: "win-1", profileId: "p1", activeWorkspaceId: "ws1" }],
      });
      registry.getOrCreate("session1", state);
      registry.activateProfile("session1", "p-desktopless", state);
      expect(registry.get("session1")!.profileId).toBe("p-desktopless");
      expect(registry.get("session1")!.activeWorkspaceId).toBe("ws2");
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
    test("mutates the client's own active workspace — no desktop windowId involved", () => {
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
      registry.activateWorkspace("session1", "ws2", state);
      expect(registry.get("session1")!.activeWorkspaceId).toBe("ws2");
      // The desktop slot in the state object is untouched by remote activation.
      expect(state.windowSlots[0].activeWorkspaceId).toBe("ws1");
    });

    test("works when the profile has no desktop window at all", () => {
      const registry = new RemoteClientRegistry();
      const state = makeState({
        profiles: [{ id: "p1" }],
        workspaces: [
          { id: "ws1", profileId: "p1" },
          { id: "ws2", profileId: "p1" },
        ],
        windowSlots: [],
      });
      registry.getOrCreate("session1", state);
      registry.activateWorkspace("session1", "ws2", state);
      expect(registry.get("session1")!.activeWorkspaceId).toBe("ws2");
    });

    test("clears the active session when it belongs to another workspace", () => {
      const registry = new RemoteClientRegistry();
      const state = makeState({
        profiles: [{ id: "p1", lastActiveWorkspaceId: "ws1", lastActiveSessionId: "ws1:shell" }],
        workspaces: [
          { id: "ws1", profileId: "p1" },
          { id: "ws2", profileId: "p1" },
        ],
        // Session comes from the desktop slot the client adopts on bind.
        windowSlots: [{ id: "win-1", profileId: "p1", activeWorkspaceId: "ws1", activeSessionId: "ws1:shell" }],
      });
      registry.getOrCreate("session1", state);
      expect(registry.get("session1")!.activeSessionId).toBe("ws1:shell");
      registry.activateWorkspace("session1", "ws2", state);
      expect(registry.get("session1")!.activeSessionId).toBe("");
    });

    test("two clients on the same profile keep independent active workspaces", () => {
      const registry = new RemoteClientRegistry();
      const state = makeState({
        profiles: [{ id: "p1" }],
        workspaces: [
          { id: "ws1", profileId: "p1" },
          { id: "ws2", profileId: "p1" },
        ],
      });
      registry.getOrCreate("session1", state);
      registry.getOrCreate("session2", state);
      registry.activateWorkspace("session1", "ws2", state);
      expect(registry.get("session1")!.activeWorkspaceId).toBe("ws2");
      expect(registry.get("session2")!.activeWorkspaceId).toBe("ws1");
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
  });

  describe("activateSession", () => {
    test("sets the client's own active workspace and session", () => {
      const registry = new RemoteClientRegistry();
      const state = makeState({
        profiles: [{ id: "p1" }],
        workspaces: [{ id: "ws1", profileId: "p1" }],
      });
      registry.getOrCreate("session1", state);
      registry.activateSession("session1", "ws1", "ws1:panel1", state);
      expect(registry.get("session1")!.activeWorkspaceId).toBe("ws1");
      expect(registry.get("session1")!.activeSessionId).toBe("ws1:panel1");
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

  describe("setWorkspaceGrid", () => {
    test("stores a sanitized viewer-owned grid", () => {
      const registry = new RemoteClientRegistry();
      const state = makeState({
        profiles: [{ id: "p1" }, { id: "p2" }],
        workspaces: [
          { id: "ws1", profileId: "p1" },
          { id: "ws2", profileId: "p1" },
          { id: "ws-foreign", profileId: "p2" },
        ],
      });
      registry.getOrCreate("session1", state);
      // Foreign-profile cell must be nulled.
      registry.setWorkspaceGrid("session1", { layout: "cols", cellWorkspaceIds: ["ws1", "ws-foreign"] }, state);
      expect(registry.get("session1")!.workspaceGrid).toEqual({ layout: "cols", cellWorkspaceIds: ["ws1", null] });
    });

    test("two clients on the same profile keep independent grids", () => {
      const registry = new RemoteClientRegistry();
      const state = makeState({
        profiles: [{ id: "p1" }],
        workspaces: [
          { id: "ws1", profileId: "p1" },
          { id: "ws2", profileId: "p1" },
        ],
      });
      registry.getOrCreate("session1", state);
      registry.getOrCreate("session2", state);
      registry.setWorkspaceGrid("session1", { layout: "cols", cellWorkspaceIds: ["ws1", "ws2"] }, state);
      expect(registry.get("session1")!.workspaceGrid).toEqual({ layout: "cols", cellWorkspaceIds: ["ws1", "ws2"] });
      expect(registry.get("session2")!.workspaceGrid).toBeNull();
    });

    test("all-empty grid collapses to null", () => {
      const registry = new RemoteClientRegistry();
      const state = makeState({
        profiles: [{ id: "p1" }],
        workspaces: [{ id: "ws1", profileId: "p1" }],
      });
      registry.getOrCreate("session1", state);
      registry.setWorkspaceGrid("session1", { layout: "cols", cellWorkspaceIds: [null, null] }, state);
      expect(registry.get("session1")!.workspaceGrid).toBeNull();
    });
  });

  describe("fallbackDeletedProfile", () => {
    test("moves affected clients to a remaining profile and reseeds their view", () => {
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

  describe("composePayload", () => {
    test("injects remoteClient with the client's OWN active workspace/session/grid", () => {
      const registry = new RemoteClientRegistry();
      const state = makeState({
        profiles: [{ id: "p1" }, { id: "p2" }],
        workspaces: [
          { id: "ws1", profileId: "p1" },
          { id: "ws1b", profileId: "p1" },
          { id: "ws2", profileId: "p2" },
        ],
        windowSlots: [
          { id: "win-1", profileId: "p1", activeWorkspaceId: "ws1", activeSessionId: "ws1:panel1" },
          { id: "win-2", profileId: "p2", activeWorkspaceId: "ws2", activeSessionId: "" },
        ],
      });
      registry.getOrCreate("session1", state);
      registry.activateWorkspace("session1", "ws1b", state);
      registry.getOrCreate("session2", state);
      registry.activateProfile("session2", "p2", state);

      const basePayload = { appState: { ...state }, meta: {} };
      const payload1 = registry.composePayload("session1", basePayload) as Record<string, unknown>;
      const payload2 = registry.composePayload("session2", basePayload) as Record<string, unknown>;

      const rc1 = payload1.remoteClient as Record<string, unknown>;
      expect(rc1.profileId).toBe("p1");
      // The client's own view — NOT the desktop slot's (win-1 shows ws1).
      expect(rc1.activeWorkspaceId).toBe("ws1b");

      const rc2 = payload2.remoteClient as Record<string, unknown>;
      expect(rc2.profileId).toBe("p2");
      expect(rc2.activeWorkspaceId).toBe("ws2");
      expect(rc2.activeSessionId).toBe("");
    });

    test("desktop slot changes do NOT leak into the remote client's view", () => {
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

      // Desktop switches workspace in win-1 — the remote view must not move.
      const stateAfter = {
        ...state,
        windowSlots: [{ id: "win-1", profileId: "p1", activeWorkspaceId: "ws2", activeSessionId: "" }],
      };
      const result = registry.composePayload("session1", { appState: stateAfter }) as Record<string, unknown>;
      const rc = result.remoteClient as Record<string, unknown>;
      expect(rc.activeWorkspaceId).toBe("ws1");
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

    test("client KEEPS its profile when the profile's desktop window closes", () => {
      // The remote client is an independent viewer — closing the desktop
      // window for its profile must not rebind it.
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

      // Window 2 closes — p2 still exists as a profile.
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
      expect(rc.profileId).toBe("p2");
      expect(rc.activeWorkspaceId).toBe("ws2");
    });

    test("falls back when the client's profile was DELETED", () => {
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

      // p2 is gone entirely.
      const basePayload = {
        appState: {
          profiles: [{ id: "p1" }],
          workspaces: [{ id: "ws1", profileId: "p1" }],
          windowSlots: [{ id: "win-1", profileId: "p1", activeWorkspaceId: "ws1" }],
        },
      };
      const result = registry.composePayload("session1", basePayload) as Record<string, unknown>;
      const rc = result.remoteClient as Record<string, unknown>;
      expect(rc.profileId).toBe("p1");
      expect(rc.activeWorkspaceId).toBe("ws1");
    });

    test("re-seeds the active workspace when it was deleted", () => {
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

      const basePayload = {
        appState: {
          profiles: [{ id: "p1" }],
          workspaces: [{ id: "ws1", profileId: "p1" }],
          windowSlots: [],
        },
      };
      const result = registry.composePayload("session1", basePayload) as Record<string, unknown>;
      const rc = result.remoteClient as Record<string, unknown>;
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
});
