/**
 * RemoteClientRegistry — runtime-only registry of remote browser sessions.
 *
 * Each cookie session that has authenticated gets its own RemoteClientContext
 * tracking which profile / workspace / session the user is looking at.  This
 * context is purely in-process memory; it is never written to the persisted
 * AppState and disappears on server restart (same as the activeSessions set in
 * remote-server.ts).
 *
 * Desktop window slots remain the source of truth for the desktop UI. Remote
 * clients operate in parallel without stealing or moving desktop slots.
 */

/** 7 days — aligned with the session cookie expiry. */
const CLIENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Sweep interval: once per hour. */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

export interface RemoteClientContext {
  id: string;
  profileId: string;
  activeWorkspaceId: string;
  activeSessionId: string;
  connectedAt: number;
  lastSeenAt: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyState = any;

export class RemoteClientRegistry {
  private readonly clients = new Map<string, RemoteClientContext>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  /** Get-or-create a client context for `sessionId`. */
  getOrCreate(sessionId: string, appState: AnyState): RemoteClientContext {
    const existing = this.clients.get(sessionId);
    if (existing) {
      existing.lastSeenAt = Date.now();
      return existing;
    }
    const profiles: AnyState[] = appState?.profiles || [];
    const firstProfile = profiles[0] || { id: "default" };
    const workspaces: AnyState[] = appState?.workspaces || [];
    const firstWs = workspaces.find((w: AnyState) => (w.profileId || "default") === firstProfile.id);
    const client: RemoteClientContext = {
      id: sessionId,
      profileId: firstProfile.id,
      activeWorkspaceId: firstWs?.id || "",
      activeSessionId: "",
      connectedAt: Date.now(),
      lastSeenAt: Date.now(),
    };
    this.clients.set(sessionId, client);
    return client;
  }

  get(sessionId: string): RemoteClientContext | undefined {
    return this.clients.get(sessionId);
  }

  bumpLastSeen(sessionId: string): void {
    const client = this.clients.get(sessionId);
    if (client) client.lastSeenAt = Date.now();
  }

  // ---------------------------------------------------------------------------
  // Activation methods — validate then mutate the client context.
  // None of these touch AppState (windowSlots or activeProfileId).
  // ---------------------------------------------------------------------------

  activateProfile(sessionId: string, profileId: string, appState: AnyState): void {
    const client = this.clients.get(sessionId);
    if (!client) throw new Error("Remote client session not found");
    const profiles: AnyState[] = appState?.profiles || [];
    if (!profiles.some((p: AnyState) => p.id === profileId)) throw new Error("Profile not found");
    const workspaces: AnyState[] = appState?.workspaces || [];
    const firstWs = workspaces.find((w: AnyState) => (w.profileId || "default") === profileId);
    client.profileId = profileId;
    client.activeWorkspaceId = firstWs?.id || "";
    client.activeSessionId = "";
    client.lastSeenAt = Date.now();
  }

  activateWorkspace(sessionId: string, workspaceId: string, appState: AnyState): void {
    const client = this.clients.get(sessionId);
    if (!client) throw new Error("Remote client session not found");
    const workspaces: AnyState[] = appState?.workspaces || [];
    const ws = workspaces.find((w: AnyState) => w.id === workspaceId);
    if (!ws) throw new Error("Workspace not found");
    if ((ws.profileId || "default") !== client.profileId) {
      throw new Error("Workspace does not belong to the active profile");
    }
    client.activeWorkspaceId = workspaceId;
    client.activeSessionId = "";
    client.lastSeenAt = Date.now();
  }

  activateSession(sessionId: string, workspaceId: string, sessionToActivate: string, appState: AnyState): void {
    const client = this.clients.get(sessionId);
    if (!client) throw new Error("Remote client session not found");
    const workspaces: AnyState[] = appState?.workspaces || [];
    const ws = workspaces.find((w: AnyState) => w.id === workspaceId);
    if (!ws) throw new Error("Workspace not found");
    if ((ws.profileId || "default") !== client.profileId) {
      throw new Error("Workspace does not belong to the active profile");
    }
    if (!sessionToActivate.startsWith(`${workspaceId}:`)) {
      throw new Error("Session does not belong to workspace");
    }
    client.activeWorkspaceId = workspaceId;
    client.activeSessionId = sessionToActivate;
    client.lastSeenAt = Date.now();
  }

  // ---------------------------------------------------------------------------
  // Fallback helpers — called when a profile or workspace is deleted.
  // Returns the session IDs of affected clients (so the caller can push state).
  // ---------------------------------------------------------------------------

  fallbackDeletedProfile(profileId: string, appState: AnyState): string[] {
    const affected: string[] = [];
    const profiles: AnyState[] = appState?.profiles || [];
    const fallbackProfile = profiles[0];
    if (!fallbackProfile) return affected;
    const workspaces: AnyState[] = appState?.workspaces || [];
    const fallbackWs = workspaces.find((w: AnyState) => (w.profileId || "default") === fallbackProfile.id);
    for (const [sid, client] of this.clients) {
      if (client.profileId === profileId) {
        client.profileId = fallbackProfile.id;
        client.activeWorkspaceId = fallbackWs?.id || "";
        client.activeSessionId = "";
        affected.push(sid);
      }
    }
    return affected;
  }

  fallbackDeletedWorkspace(workspaceId: string, appState: AnyState): string[] {
    const affected: string[] = [];
    const workspaces: AnyState[] = appState?.workspaces || [];
    for (const [sid, client] of this.clients) {
      if (client.activeWorkspaceId === workspaceId) {
        const sibling = workspaces.find(
          (w: AnyState) => (w.profileId || "default") === client.profileId && w.id !== workspaceId,
        );
        client.activeWorkspaceId = sibling?.id || "";
        client.activeSessionId = "";
        affected.push(sid);
      }
    }
    return affected;
  }

  // ---------------------------------------------------------------------------
  // Per-client payload composition.
  // ---------------------------------------------------------------------------

  /**
   * Compose a StatePayload variant for `sessionId`.
   *
   * 1. Reduces windowSlots to {id, profileId, windowIndex} — remote doesn't
   *    need bounds / lastFocusedAt.
   * 2. Injects `remoteClient` from the registry (with automatic fallback if
   *    the profile or workspace was deleted since last compose).
   */
  composePayload(sessionId: string, basePayload: unknown): unknown {
    const payload = basePayload as Record<string, unknown>;
    const appState = (payload.appState as Record<string, unknown>) || {};
    const slots = (appState.windowSlots as AnyState[]) || [];
    const reducedSlots = slots.map((slot: AnyState, idx: number) => ({
      id: slot.id,
      profileId: slot.profileId,
      windowIndex: idx + 1,
    }));
    const client = this.clients.get(sessionId);
    if (!client) {
      return { ...payload, appState: { ...appState, windowSlots: reducedSlots } };
    }
    // Lazy fallback: profile deleted
    const profiles = (appState.profiles as AnyState[]) || [];
    if (!profiles.some((p: AnyState) => p.id === client.profileId)) {
      const fallback = profiles[0];
      if (fallback) {
        const workspaces = (appState.workspaces as AnyState[]) || [];
        const fw = workspaces.find((w: AnyState) => (w.profileId || "default") === fallback.id);
        client.profileId = fallback.id;
        client.activeWorkspaceId = fw?.id || "";
        client.activeSessionId = "";
      }
    }
    // Lazy fallback: workspace deleted
    const workspaces = (appState.workspaces as AnyState[]) || [];
    if (client.activeWorkspaceId && !workspaces.some((w: AnyState) => w.id === client.activeWorkspaceId)) {
      const sibling = workspaces.find((w: AnyState) => (w.profileId || "default") === client.profileId);
      client.activeWorkspaceId = sibling?.id || "";
      client.activeSessionId = "";
    }
    return {
      ...payload,
      appState: { ...appState, windowSlots: reducedSlots },
      remoteClient: {
        id: client.id,
        profileId: client.profileId,
        activeWorkspaceId: client.activeWorkspaceId,
        activeSessionId: client.activeSessionId,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // TTL sweep.
  // ---------------------------------------------------------------------------

  startCleanupSweep(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      const cutoff = Date.now() - CLIENT_TTL_MS;
      for (const [sid, client] of this.clients) {
        if (client.lastSeenAt < cutoff) this.clients.delete(sid);
      }
    }, SWEEP_INTERVAL_MS);
    this.sweepTimer.unref?.();
  }

  stopCleanupSweep(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  /** Expose raw client map for testing. */
  _clientsForTest(): Map<string, RemoteClientContext> {
    return this.clients;
  }
}
