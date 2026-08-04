/**
 * RemoteClientRegistry — runtime-only registry of remote browser sessions.
 *
 * Each cookie session that has authenticated gets its own RemoteClientContext.
 * A remote client is an independent VIEWER: it owns its active profile,
 * active workspace/session, and workspace grid — it does not mirror any
 * desktop windowSlot, and it may show a profile that is not open in any
 * desktop window. Workspaces, sessions and runtime managers stay shared with
 * desktop viewers of the same profile; only the view selection is per-client.
 *
 * This context is purely in-process memory; it is never written to the
 * persisted AppState and disappears on server restart (same as the
 * activeSessions set in remote-server.ts).
 */

import type { WorkspaceGridState } from "../shared/types/state.js";

/** 7 days — aligned with the session cookie expiry. */
const CLIENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Sweep interval: once per hour. */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

export interface RemoteClientContext {
  id: string;
  profileId: string;
  activeWorkspaceId: string;
  activeSessionId: string;
  /** Viewer-owned grid — independent of every desktop window's grid. */
  workspaceGrid?: WorkspaceGridState | null;
  connectedAt: number;
  lastSeenAt: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyState = any;

export class RemoteClientRegistry {
  private readonly clients = new Map<string, RemoteClientContext>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  private existingProfileIds(appState: AnyState): string[] {
    const profiles: AnyState[] = appState?.profiles || [];
    return profiles.map((p: AnyState) => String(p?.id || "")).filter(Boolean);
  }

  private openDesktopProfileIds(appState: AnyState): string[] {
    const slots: AnyState[] = appState?.windowSlots || [];
    const ids: string[] = [];
    for (const slot of slots) {
      const profileId = String(slot?.profileId || "");
      if (profileId && !ids.includes(profileId)) ids.push(profileId);
    }
    return ids;
  }

  /**
   * Default profile for a fresh / orphaned client: prefer a profile that is
   * open on the desktop (most likely what the user wants to see), else the
   * first existing profile.
   */
  private fallbackProfileId(appState: AnyState): string {
    const existing = this.existingProfileIds(appState);
    const open = this.openDesktopProfileIds(appState).filter((id) => existing.includes(id));
    return open[0] || existing[0] || "";
  }

  /**
   * Public resolver for the default profile a v2 core/detail request is scoped
   * to when the caller has no bound session. Keeps an unbound remote client
   * scoped to ONE profile (never every profile) instead of leaking all of them.
   */
  resolveFallbackProfileId(appState: AnyState): string {
    return this.fallbackProfileId(appState);
  }

  private profileWorkspaces(appState: AnyState, profileId: string): AnyState[] {
    const workspaces: AnyState[] = appState?.workspaces || [];
    return workspaces.filter((ws: AnyState) => String(ws?.profileId || "default") === profileId);
  }

  /**
   * The desktop window a freshly-bound client should adopt its view from: the
   * most recently focused slot in `profileId`, or null when the profile has no
   * desktop window. Focus ordering follows the same convention as main.ts's
   * primary-window pick (`lastFocusedAt || 0`, highest wins); ties keep the
   * earlier slot so the result is deterministic.
   */
  private primarySlotForProfile(appState: AnyState, profileId: string): AnyState | null {
    const slots: AnyState[] = appState?.windowSlots || [];
    const inProfile = slots.filter((slot: AnyState) => String(slot?.profileId || "") === profileId);
    if (inProfile.length === 0) return null;
    return inProfile.reduce((best: AnyState, slot: AnyState) =>
      Number(slot?.lastFocusedAt || 0) > Number(best?.lastFocusedAt || 0) ? slot : best,
    );
  }

  /**
   * Seed a client's view state when it (re)binds to a profile.
   *
   * Precedence: the profile's live desktop window, then the profile's
   * lastActive mirror, then its first workspace.
   *
   * The desktop window comes first because the mirror
   * (`profile.lastActiveWorkspaceId`) is only written on deactivation-ish
   * events — workspace/session switch, profile switch, window close — so it
   * drifts from what the user is actually looking at: two windows in one
   * profile overwrite each other's value, and a mirror that survived a kill
   * is never corrected on load (the windowSlot seed in normalizeState only
   * fills a MISSING one). Reading the slot here makes "connect from the phone"
   * land on the desktop's current view.
   *
   * This runs on (re)bind only — fresh session, profile switch, or a profile
   * that ceased to exist — never on the broadcast path, so the desktop cannot
   * drag an established remote view around mid-session. `composePayload` ->
   * `revalidate` still only touches an INVALID selection.
   */
  private seedViewState(client: RemoteClientContext, appState: AnyState): void {
    const profiles: AnyState[] = appState?.profiles || [];
    const profile = profiles.find((p: AnyState) => p.id === client.profileId);
    const wsList = this.profileWorkspaces(appState, client.profileId);
    const inProfile = (id: string): boolean => Boolean(id) && wsList.some((ws: AnyState) => ws.id === id);

    const slot = this.primarySlotForProfile(appState, client.profileId);
    const slotWsId = String(slot?.activeWorkspaceId || "");
    const savedWsId = String(profile?.lastActiveWorkspaceId || "");

    // Each source contributes workspace AND session together. Pairing a slot
    // workspace with a mirrored session would synthesise a view neither the
    // desktop nor the previous remote client ever had.
    let workspaceId: string;
    let sessionId = "";
    if (inProfile(slotWsId)) {
      workspaceId = slotWsId;
      sessionId = String(slot?.activeSessionId || "");
    } else if (inProfile(savedWsId)) {
      workspaceId = savedWsId;
      sessionId = String(profile?.lastActiveSessionId || "");
    } else {
      workspaceId = String(wsList[0]?.id || "");
    }

    client.activeWorkspaceId = workspaceId;
    client.activeSessionId = workspaceId && sessionId.startsWith(`${workspaceId}:`) ? sessionId : "";
    client.workspaceGrid = this.sanitizeGrid(profile?.workspaceGrid, appState, client.profileId);
  }

  /**
   * Validate a grid against the client's profile: cells referencing
   * workspaces outside the profile become null; an all-empty grid is null.
   * Always returns an independent copy.
   */
  private sanitizeGrid(grid: AnyState, appState: AnyState, profileId: string): WorkspaceGridState | null {
    if (!grid || typeof grid !== "object" || !Array.isArray(grid.cellWorkspaceIds)) return null;
    const profileWsIds = new Set(this.profileWorkspaces(appState, profileId).map((ws: AnyState) => ws.id));
    const seen = new Set<string>();
    const cellWorkspaceIds = (grid.cellWorkspaceIds as (string | null)[]).map((id) => {
      if (typeof id === "string" && id && profileWsIds.has(id) && !seen.has(id)) {
        seen.add(id);
        return id;
      }
      return null;
    });
    if (cellWorkspaceIds.every((id) => id === null)) return null;
    return { layout: grid.layout, cellWorkspaceIds };
  }

  /**
   * Lazy re-validation before reads: the client's profile may have been
   * deleted, its active workspace removed or moved to another profile.
   */
  private revalidate(client: RemoteClientContext, appState: AnyState): void {
    if (!this.existingProfileIds(appState).includes(client.profileId)) {
      client.profileId = this.fallbackProfileId(appState);
      this.seedViewState(client, appState);
      return;
    }
    const wsList = this.profileWorkspaces(appState, client.profileId);
    if (!client.activeWorkspaceId || !wsList.some((ws: AnyState) => ws.id === client.activeWorkspaceId)) {
      client.activeWorkspaceId = String(wsList[0]?.id || "");
      client.activeSessionId = "";
    }
    if (client.activeSessionId && !client.activeSessionId.startsWith(`${client.activeWorkspaceId}:`)) {
      client.activeSessionId = "";
    }
    if (client.workspaceGrid) {
      client.workspaceGrid = this.sanitizeGrid(client.workspaceGrid, appState, client.profileId);
    }
  }

  /** Get-or-create a client context for `sessionId`. */
  getOrCreate(sessionId: string, appState: AnyState, requestedProfileId = ""): RemoteClientContext {
    const existing = this.clients.get(sessionId);
    if (existing) {
      existing.lastSeenAt = Date.now();
      return existing;
    }
    // Any EXISTING profile is a valid initial binding — the remote client is
    // a peer viewer, not a mirror of a desktop window, so the profile does
    // not need to be open on the desktop.
    const profileId =
      requestedProfileId && this.existingProfileIds(appState).includes(requestedProfileId)
        ? requestedProfileId
        : this.fallbackProfileId(appState);
    const client: RemoteClientContext = {
      id: sessionId,
      profileId,
      activeWorkspaceId: "",
      activeSessionId: "",
      workspaceGrid: null,
      connectedAt: Date.now(),
      lastSeenAt: Date.now(),
    };
    this.seedViewState(client, appState);
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
  // Activation methods — mutate the client's OWN view state. No desktop
  // windowSlot is read or written: remote activation never flips a desktop
  // window, and desktop activation never flips a remote client.
  // ---------------------------------------------------------------------------

  activateProfile(sessionId: string, profileId: string, appState: AnyState): void {
    const client = this.clients.get(sessionId);
    if (!client) throw new Error("Remote client session not found");
    if (!this.existingProfileIds(appState).includes(profileId)) throw new Error("Profile not found");
    client.profileId = profileId;
    this.seedViewState(client, appState);
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
    if (client.activeSessionId && !client.activeSessionId.startsWith(`${workspaceId}:`)) {
      client.activeSessionId = "";
    }
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

  /**
   * Replace the client's viewer-owned grid. The caller (runtime grid ops)
   * has already validated cross-profile cells; sanitize defensively anyway.
   */
  setWorkspaceGrid(sessionId: string, grid: WorkspaceGridState | null, appState: AnyState): void {
    const client = this.clients.get(sessionId);
    if (!client) throw new Error("Remote client session not found");
    client.workspaceGrid = grid ? this.sanitizeGrid(grid, appState, client.profileId) : null;
    client.lastSeenAt = Date.now();
  }

  // ---------------------------------------------------------------------------
  // Fallback helpers — called when a profile is deleted.
  // Returns the session IDs of affected clients (so the caller can push state).
  // Deleting a workspace doesn't need an explicit hook: composePayload
  // re-validates the client's view lazily on the next push.
  // ---------------------------------------------------------------------------

  fallbackDeletedProfile(profileId: string, appState: AnyState): string[] {
    const affected: string[] = [];
    for (const [sid, client] of this.clients) {
      if (client.profileId === profileId) {
        client.profileId = this.fallbackProfileId(appState);
        this.seedViewState(client, appState);
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
   *    need bounds / lastFocusedAt (still sent so the UI can render
   *    "Open on desktop: N windows" badges).
   * 2. Injects `remoteClient` with the client's OWN profileId,
   *    activeWorkspaceId, activeSessionId and workspaceGrid.
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
    this.revalidate(client, appState);
    return {
      ...payload,
      appState: { ...appState, windowSlots: reducedSlots },
      remoteClient: {
        id: client.id,
        profileId: client.profileId,
        activeWorkspaceId: client.activeWorkspaceId,
        activeSessionId: client.activeSessionId,
        workspaceGrid: client.workspaceGrid ?? null,
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
