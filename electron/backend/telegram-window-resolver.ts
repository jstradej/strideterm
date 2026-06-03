/**
 * Pure helper: resolves the target desktop window for a Telegram-originated
 * command.
 *
 * Telegram speaks in `profileId` (the user-facing scope — "which profile did
 * I pick from the menu?"), but the rest of the runtime — IPC handlers,
 * remote-server slot-aware routes, window registry — uses `windowId` as the
 * canonical scope unit. A profile may be open in ANY number of desktop
 * windows (or none), so the resolver returns a DECISION, not just a string:
 * which window to use, why, and — when the choice is ambiguous — the list of
 * candidates so the caller can ask the user.
 *
 * Rules (in order):
 *  1. Explicit valid `cmd.windowId` wins ("explicit-window").
 *  2. Commands that don't need a desktop window resolve to
 *     "no-window-required" — runtime-only actions never open windows.
 *  3. A same-profile window already showing the target workspace/session
 *     wins ("workspace-visible").
 *  4. Exactly one window in the profile → use it ("only-profile-window").
 *  5. Multiple windows: targeted actions (open review, workspace screenshot)
 *     use the most recently focused window
 *     ("last-focused-profile-window"); "current"-style actions without an
 *     explicit window require a user choice ("needs-user-choice" +
 *     candidates).
 *  6. No window in the profile: actions allowed to create one get
 *     "needs-new-window"; everything else gets "needs-user-choice" with an
 *     empty candidate list (caller surfaces a user-facing error / picker).
 *
 * Kept as a standalone, dependency-free function so the routing logic is
 * straightforward to unit-test.
 */

export type TelegramWindowResolutionReason =
  | "explicit-window"
  | "workspace-visible"
  | "last-focused-profile-window"
  | "only-profile-window"
  | "needs-user-choice"
  | "needs-new-window"
  | "no-window-required";

export interface TelegramWindowCandidate {
  windowId: string;
  activeWorkspaceId?: string;
  lastFocusedAt?: number;
}

export interface TelegramWindowResolution {
  windowId?: string;
  reason: TelegramWindowResolutionReason;
  candidates?: TelegramWindowCandidate[];
}

export interface TelegramWindowResolverCommand {
  /** Explicit target window (e.g. `/screenshot N`) — always wins. */
  windowId?: string;
  /** Profile scope of the command (connection binding or menu pick). */
  profileId?: string;
  /** Target workspace, when the action aims at a specific one. */
  workspaceId?: string;
  /** Target session, when the action aims at a specific one. */
  sessionId?: string;
  /** False for runtime-only commands (/status, task lifecycle, …). Default true. */
  requiresDesktopWindow?: boolean;
  /** May a new window be created when none shows the profile? Default false. */
  allowCreateWindow?: boolean;
  /** Prefer a window already showing the target workspace/session. Default true. */
  preferVisibleWorkspace?: boolean;
  /**
   * "Current"-style actions (screenshot current) must never silently pick
   * one of several windows — require a user choice instead of last-focused.
   * Default false (targeted actions fall back to last-focused).
   */
  requireExplicitWindowWhenAmbiguous?: boolean;
}

export interface TelegramWindowResolverSlot {
  id: string;
  profileId?: string;
  activeWorkspaceId?: string;
  activeSessionId?: string;
  lastFocusedAt?: number;
}

export function resolveTelegramWindow(
  cmd: TelegramWindowResolverCommand,
  windowSlots: ReadonlyArray<TelegramWindowResolverSlot>,
): TelegramWindowResolution {
  // 1. Explicit windowId always wins — it's already authoritative (the
  //    caller validates liveness; a dead id fails downstream loudly).
  if (cmd.windowId) return { windowId: String(cmd.windowId), reason: "explicit-window" };

  // 2. Runtime-only commands never resolve (and never create) windows.
  if (cmd.requiresDesktopWindow === false) return { reason: "no-window-required" };

  const profileId = cmd.profileId ? String(cmd.profileId) : "";
  if (!profileId) {
    // Legacy: no profile binding — the caller falls back to its primary
    // window behavior (single-window setups).
    return { reason: "no-window-required" };
  }

  const candidates: TelegramWindowCandidate[] = windowSlots
    .filter((slot) => (slot.profileId || "default") === profileId)
    .map((slot) => ({
      windowId: slot.id,
      activeWorkspaceId: slot.activeWorkspaceId,
      lastFocusedAt: slot.lastFocusedAt,
    }));

  // 3. A window already showing the target workspace/session wins.
  if (cmd.preferVisibleWorkspace !== false && (cmd.workspaceId || cmd.sessionId)) {
    const slotsById = new Map(windowSlots.map((slot) => [slot.id, slot]));
    const visible = candidates.find((candidate) => {
      const slot = slotsById.get(candidate.windowId);
      if (!slot) return false;
      if (cmd.sessionId && slot.activeSessionId === cmd.sessionId) return true;
      if (cmd.workspaceId && slot.activeWorkspaceId === cmd.workspaceId) return true;
      return false;
    });
    if (visible) return { windowId: visible.windowId, reason: "workspace-visible", candidates };
  }

  // 4. Exactly one window in the profile.
  if (candidates.length === 1) {
    return { windowId: candidates[0].windowId, reason: "only-profile-window", candidates };
  }

  // 5. Multiple windows.
  if (candidates.length > 1) {
    if (cmd.requireExplicitWindowWhenAmbiguous) {
      return { reason: "needs-user-choice", candidates };
    }
    const lastFocused = [...candidates].sort((a, b) => (b.lastFocusedAt || 0) - (a.lastFocusedAt || 0))[0];
    return { windowId: lastFocused.windowId, reason: "last-focused-profile-window", candidates };
  }

  // 6. No window shows the profile.
  if (cmd.allowCreateWindow) {
    return { reason: "needs-new-window", candidates };
  }
  return { reason: "needs-user-choice", candidates };
}
