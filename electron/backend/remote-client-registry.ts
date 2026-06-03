/**
 * RemoteClientRegistry — runtime-only registry of remote browser sessions.
 *
 * Each cookie session that has authenticated gets its own RemoteClientContext
 * tracking which desktop profile the user is bound to. The active workspace
 * and session are NOT stored per-client: mobile mirrors the desktop windowSlot
 * for the bound profile, so there is exactly one source of truth and no
 * separate state to keep in sync. This context is purely in-process memory;
 * it is never written to the persisted AppState and disappears on server
 * restart (same as the activeSessions set in remote-server.ts).
 */

/** 7 days — aligned with the session cookie expiry. */
const CLIENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Sweep interval: once per hour. */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

export interface RemoteClientContext {
  id: string;
  profileId: string;
  connectedAt: number;
  lastSeenAt: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyState = any;

export class RemoteClientRegistry {
  private readonly clients = new Map<string, RemoteClientContext>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  private openProfileIds(appState: AnyState): string[] {
    const slots: AnyState[] = appState?.windowSlots || [];
    const ids: string[] = [];
    for (const slot of slots) {
      const profileId = String(slot?.profileId || "");
      if (profileId && !ids.includes(profileId)) ids.push(profileId);
    }
    return ids;
  }

  private fallbackProfileId(appState: AnyState): string {
    return this.openProfileIds(appState)[0] || "";
  }

  private slotForProfile(appState: AnyState, profileId: string): AnyState | undefined {
    const slots: AnyState[] = appState?.windowSlots || [];
    return slots.find((s: AnyState) => String(s?.profileId || "") === profileId);
  }

  /** Get-or-create a client context for `sessionId`. */
  getOrCreate(sessionId: string, appState: AnyState, requestedProfileId = ""): RemoteClientContext {
    const existing = this.clients.get(sessionId);
    if (existing) {
      existing.lastSeenAt = Date.now();
      return existing;
    }
    const openProfileIds = this.openProfileIds(appState);
    const profileId =
      requestedProfileId && openProfileIds.includes(requestedProfileId) ? requestedProfileId : openProfileIds[0] || "";
    const client: RemoteClientContext = {
      id: sessionId,
      profileId,
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
  // Activation methods — validate the request and return the desktop windowId
  // to drive. The caller invokes runtime.activate*InWindow with that windowId;
  // the runtime mutates the shared windowSlot and broadcasts. Mobile and
  // desktop share the slot's active workspace/session, so there is no separate
  // per-client state to mutate here.
  // ---------------------------------------------------------------------------

  /**
   * Lookup-only: returns the desktop windowId currently bound to this remote
   * session (via the client's active profileId → matching slot). Returns ""
   * when there is no session, no bound profile, or no open slot for that
   * profile. Use this for endpoints that mutate per-slot state but are not
   * themselves "activation" requests — e.g. opening a PR review workspace
   * should mirror the new active workspace into the bound slot, otherwise the
   * frontend selector (slot-first) keeps the old workspace and the UI flickers.
   */
  getBoundWindowId(sessionId: string, appState: AnyState): string {
    const client = this.clients.get(sessionId);
    if (!client) return "";
    const slot = this.slotForProfile(appState, client.profileId);
    return slot ? String(slot.id) : "";
  }

  activateProfile(sessionId: string, profileId: string, appState: AnyState): void {
    const client = this.clients.get(sessionId);
    if (!client) throw new Error("Remote client session not found");
    if (!this.openProfileIds(appState).includes(profileId)) throw new Error("Profile is not open on desktop");
    client.profileId = profileId;
    client.lastSeenAt = Date.now();
  }

  activateWorkspace(sessionId: string, workspaceId: string, appState: AnyState): { windowId: string } {
    const client = this.clients.get(sessionId);
    if (!client) throw new Error("Remote client session not found");
    const workspaces: AnyState[] = appState?.workspaces || [];
    const ws = workspaces.find((w: AnyState) => w.id === workspaceId);
    if (!ws) throw new Error("Workspace not found");
    if ((ws.profileId || "default") !== client.profileId) {
      throw new Error("Workspace does not belong to the active profile");
    }
    const slot = this.slotForProfile(appState, client.profileId);
    if (!slot) throw new Error("Profile is not open on desktop");
    client.lastSeenAt = Date.now();
    return { windowId: String(slot.id) };
  }

  activateSession(
    sessionId: string,
    workspaceId: string,
    sessionToActivate: string,
    appState: AnyState,
  ): { windowId: string } {
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
    const slot = this.slotForProfile(appState, client.profileId);
    if (!slot) throw new Error("Profile is not open on desktop");
    client.lastSeenAt = Date.now();
    return { windowId: String(slot.id) };
  }

  // ---------------------------------------------------------------------------
  // Fallback helpers — called when a profile is deleted.
  // Returns the session IDs of affected clients (so the caller can push state).
  // Deleted workspaces don't need a registry fallback: the runtime already
  // rewrites slot.activeWorkspaceId in deleteWorkspace, and mobile derives its
  // active workspace from that slot.
  // ---------------------------------------------------------------------------

  fallbackDeletedProfile(profileId: string, appState: AnyState): string[] {
    const affected: string[] = [];
    const fallbackProfileId = this.fallbackProfileId(appState);
    for (const [sid, client] of this.clients) {
      if (client.profileId === profileId) {
        client.profileId = fallbackProfileId;
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
   * 2. Injects `remoteClient` with profileId, and activeWorkspaceId/
   *    activeSessionId mirrored from the bound desktop windowSlot. Mobile
   *    and desktop always see the same active workspace for a given profile.
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
    // Lazy fallback: client's profile no longer open in any desktop slot.
    if (!this.openProfileIds(appState).includes(client.profileId)) {
      client.profileId = this.fallbackProfileId(appState);
    }
    const boundSlot = this.slotForProfile(appState, client.profileId);
    return {
      ...payload,
      appState: { ...appState, windowSlots: reducedSlots },
      remoteClient: {
        id: client.id,
        profileId: client.profileId,
        activeWorkspaceId: String(boundSlot?.activeWorkspaceId || ""),
        activeSessionId: String(boundSlot?.activeSessionId || ""),
        workspaceGrid: boundSlot?.workspaceGrid ?? null,
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
