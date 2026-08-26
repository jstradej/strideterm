import { defineStore } from "pinia";
import { ref, computed } from "vue";
import type { StatePayload } from "../../electron/shared/types/state.js";
import { hasMeaningfulUserInput } from "../../electron/shared/terminal-input.js";

/**
 * Notification center state — session-grouped (Plan § 3.3.1).
 *
 * One "attention thread" per (workspaceId, panelId). Events fire over time
 * into that thread; the latest-kind determines the thread's current state.
 *
 * State machine (§ 3.3.3):
 *   waiting   — latest event is a live waiting alert, user hasn't acted
 *   finished  — latest event is a completed/exit alert, user hasn't ack'd
 *   resolved  — user clicked Jump / Dismiss, or backend cleared the alert
 *   snoozed   — (soft) user hit Snooze, thread hidden until snoozedUntil
 */

const STORAGE_KEY = "strideterm-notifications-v2";
const LEGACY_KEY = "strideterm-notifications";
const PINNED_KEY = "strideterm-notifications-pinned";
// Cross-window sync channel. Only ack/read state (resolve, snooze, remove,
// clear) is synchronized between windows of the same app — NEVER arrival:
// each window captures its own arrivals/toasts, otherwise the first window
// to see an alert would suppress the toast in its same-profile sibling.
const SYNC_CHANNEL_NAME = "strideterm-notifications";
const MAX_SESSIONS = 200;
const MAX_EVENTS_PER_SESSION = 20;

type NotificationState = "waiting" | "finished" | "resolved" | "snoozed";
type NotificationUrgency = "normal" | "urgent";
type NotificationKind = "waiting" | "completed" | "subagent_done" | "info" | "review" | "error" | "warning" | string;

/**
 * A toast that does not auto-dismiss. Used for errors the user must act on
 * (e.g. background workspace deletion failed and the user needs the path to
 * delete it manually). The user explicitly closes it; until they do, it
 * stays visible. `copyPath` adds a "Copy path" affordance so the user can
 * paste the offending path into Explorer / a shell without retyping it.
 */
export interface PersistentToast {
  id: string;
  title: string;
  body: string;
  kind: NotificationKind;
  copyPath?: string;
  at: string;
}

interface NotificationEvent {
  id: string;
  title: string;
  body: string;
  kind: NotificationKind;
  tier: number;
  urgency: NotificationUrgency;
  at: string;
}

interface NotificationSession {
  id: string;
  workspaceId: string;
  workspaceName: string;
  tabName: string;
  viewId: string;
  state: NotificationState;
  tier: number;
  urgency: NotificationUrgency;
  category: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  meta: Record<string, any> | null;
  firstAt: string;
  latestAt: string;
  events: NotificationEvent[];
  snoozedUntil: number;
}

interface AddEventPayload {
  title: string;
  body?: string;
  kind?: NotificationKind;
  tier?: number;
  urgency?: NotificationUrgency;
  workspaceId?: string;
  workspaceName?: string;
  tabName?: string;
  viewId?: string;
  category?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  meta?: Record<string, any> | null;
}

type SessionFilter = (_s: NotificationSession) => boolean;

/**
 * Cross-window sync messages. Ack/read state only — arrival is intentionally
 * absent (each window captures and toasts its own arrivals).
 */
type NotificationSyncMessage =
  | { type: "set-state"; sessionIds: string[]; state: NotificationState }
  | { type: "snooze"; sessionId: string; snoozedUntil: number }
  | { type: "remove"; id: string }
  | { type: "remove-by-view"; viewId: string }
  | { type: "clear-sessions"; sessionIds: string[] };

function threadId(workspaceId: string, viewId: string): string {
  return `${workspaceId || ""}:${viewId || ""}`;
}

function loadFromStorage(): NotificationSession[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as NotificationSession[];
  } catch {
    // fall through
  }
  // Legacy flat list — drop it. The live payload will repopulate.
  try {
    window.localStorage.removeItem(LEGACY_KEY);
  } catch {
    /* no-op */
  }
  return [];
}

function saveToStorage(sessions: NotificationSession[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions.slice(0, MAX_SESSIONS)));
  } catch {
    // Ignore storage failures.
  }
}

function loadPinned(): boolean {
  try {
    return window.localStorage.getItem(PINNED_KEY) === "1";
  } catch {
    return false;
  }
}

function savePinned(value: boolean): void {
  try {
    window.localStorage.setItem(PINNED_KEY, value ? "1" : "0");
  } catch {
    // Ignore storage failures.
  }
}

function kindToState(kind: NotificationKind): NotificationState {
  // Review activity and info/completed events don't block on user input —
  // they land in "Finished" so the user can ack them at their convenience.
  // SubagentStop is treated the same: a sub-agent finishing within a turn
  // never expects user input, so it shouldn't sit in "Waiting" tying up
  // attention.
  return kind === "completed" || kind === "info" || kind === "review" || kind === "subagent_done"
    ? "finished"
    : "waiting";
}

export const useNotificationStore = defineStore("notifications", () => {
  const sessions = ref<NotificationSession[]>(loadFromStorage());
  const panelOpen = ref(false);
  const pinned = ref(loadPinned());

  // --- Cross-window ack sync (BroadcastChannel) ---------------------------
  // Windows of the same profile show the same alerts; acknowledging in one
  // window must resolve the entry in the others. Only ack/clear/snooze sync;
  // arrival/toast stays per-window by design.
  let syncChannel: BroadcastChannel | null = null;
  try {
    if (typeof BroadcastChannel !== "undefined") {
      syncChannel = new BroadcastChannel(SYNC_CHANNEL_NAME);
      syncChannel.onmessage = (event: MessageEvent) => {
        try {
          applySyncMessage(event.data as NotificationSyncMessage);
        } catch {
          // Malformed message from another (older/newer) window — ignore.
        }
      };
    }
  } catch {
    syncChannel = null;
  }

  function broadcastSync(message: NotificationSyncMessage): void {
    try {
      syncChannel?.postMessage(message);
    } catch {
      // Channel closed or serialization failed — sync is best-effort.
    }
  }

  /** Apply a sync message from another window — never re-broadcasts. */
  function applySyncMessage(message: NotificationSyncMessage): void {
    if (!message || typeof message !== "object") return;
    switch (message.type) {
      case "set-state": {
        let changed = false;
        for (const s of sessions.value) {
          if (message.sessionIds.includes(s.id) && s.state !== message.state) {
            s.state = message.state;
            changed = true;
          }
        }
        if (changed) {
          sessions.value = [...sessions.value];
          saveToStorage(sessions.value);
        }
        break;
      }
      case "snooze": {
        const s = sessions.value.find((x) => x.id === message.sessionId);
        if (s) {
          s.snoozedUntil = message.snoozedUntil;
          sessions.value = [...sessions.value];
          saveToStorage(sessions.value);
        }
        break;
      }
      case "remove": {
        removeInternal(message.id);
        break;
      }
      case "remove-by-view": {
        if (!message.viewId) return;
        sessions.value = sessions.value.filter((s) => s.viewId !== message.viewId);
        saveToStorage(sessions.value);
        break;
      }
      case "clear-sessions": {
        sessions.value = sessions.value.filter((s) => !message.sessionIds.includes(s.id));
        saveToStorage(sessions.value);
        break;
      }
    }
  }
  // Incremented whenever something (e.g. a keyboard shortcut) explicitly
  // wants the dock focused. The component watches this counter and calls
  // focus() — a ref-bump is used so repeated requests retrigger even when
  // pinned/open state hasn't changed.
  const focusRequestSignal = ref(0);
  // Transient toast payload. Lives in the store (not in a composable) so any
  // part of the app can trigger a toast via showError/showToast without
  // threading a ref through prop drilling or custom event buses.
  const latestToast = ref<(NotificationEvent & { category: string }) | null>(null);
  // Stickier counterpart of latestToast: each entry stays until the user
  // closes it. Rendered as a stack in App.vue so multiple background
  // failures don't clobber each other.
  const persistentToasts = ref<PersistentToast[]>([]);

  // Back-compat computed: a flat `items` list still exposed so older
  // consumers (and tests) can iterate per-event.  New UI reads `sessions`.
  const items = computed(() => {
    const flat: Array<{
      id: string;
      title: string;
      body: string;
      kind: NotificationKind;
      tier: number;
      urgency: NotificationUrgency;
      workspaceId: string;
      workspaceName: string;
      tabName: string;
      viewId: string;
      at: string;
      read: boolean;
    }> = [];
    for (const s of sessions.value) {
      for (const ev of s.events) {
        flat.push({
          id: ev.id,
          title: ev.title,
          body: ev.body,
          kind: ev.kind,
          tier: ev.tier,
          urgency: ev.urgency,
          workspaceId: s.workspaceId,
          workspaceName: s.workspaceName,
          tabName: s.tabName,
          viewId: s.viewId,
          at: ev.at,
          read: s.state !== "waiting" && s.state !== "snoozed",
        });
      }
    }
    return flat;
  });

  // Bell badge shows anything the user hasn't acknowledged yet — live waiting
  // sessions AND finished-but-unacked ones (the "Ack finished" queue).
  const unreadCount = computed(() =>
    sessions.value.reduce((acc, s) => acc + (s.state === "waiting" || s.state === "finished" ? 1 : 0), 0),
  );

  const waitingSessions = computed(() => sessions.value.filter((s) => s.state === "waiting"));
  const finishedSessions = computed(() => sessions.value.filter((s) => s.state === "finished"));
  const resolvedSessions = computed(() => sessions.value.filter((s) => s.state === "resolved"));

  function findSession(workspaceId: string, viewId: string): NotificationSession | undefined {
    const id = threadId(workspaceId, viewId);
    return sessions.value.find((s) => s.id === id);
  }

  function addEvent({
    title,
    body = "",
    kind = "info",
    tier = 1,
    urgency = "normal",
    workspaceId = "",
    workspaceName = "",
    tabName = "",
    viewId = "",
    category = "terminal",
    meta = null,
  }: AddEventPayload): NotificationEvent {
    const id = threadId(workspaceId, viewId);
    const eventEntry: NotificationEvent = {
      id: crypto.randomUUID(),
      title,
      body,
      kind,
      tier,
      urgency,
      at: new Date().toISOString(),
    };

    const existing = findSession(workspaceId, viewId);
    if (existing) {
      existing.events = [eventEntry, ...existing.events].slice(0, MAX_EVENTS_PER_SESSION);
      existing.latestAt = eventEntry.at;
      existing.workspaceName = workspaceName || existing.workspaceName;
      existing.tabName = tabName || existing.tabName;
      if (category) existing.category = category;
      if (meta) existing.meta = { ...(existing.meta || {}), ...meta };
      // Urgent always takes precedence; waiting > finished when comparing kinds.
      const nextState = kindToState(kind);
      if (existing.state === "resolved" && (nextState === "waiting" || urgency === "urgent")) {
        existing.state = nextState;
      } else if (existing.state !== "waiting") {
        existing.state = nextState;
      }
      existing.tier = Math.min(existing.tier ?? 3, tier);
      if (urgency === "urgent") existing.urgency = "urgent";
      // Bubble the session to the top of the list so newest-thread-first
      // ordering stays intuitive even without an explicit sort.
      sessions.value = [existing, ...sessions.value.filter((s) => s !== existing)];
    } else {
      const session: NotificationSession = {
        id,
        workspaceId,
        workspaceName,
        tabName,
        viewId,
        state: kindToState(kind),
        tier,
        urgency,
        category,
        meta: meta || null,
        firstAt: eventEntry.at,
        latestAt: eventEntry.at,
        events: [eventEntry],
        snoozedUntil: 0,
      };
      sessions.value = [session, ...sessions.value].slice(0, MAX_SESSIONS);
    }

    saveToStorage(sessions.value);
    return eventEntry;
  }

  // Back-compat alias for existing call sites.
  function add(payload: AddEventPayload): NotificationEvent {
    return addEvent(payload);
  }

  function setState(sessionRef: string | NotificationSession, newState: NotificationState): void {
    const s = typeof sessionRef === "string" ? sessions.value.find((x) => x.id === sessionRef) : sessionRef;
    if (!s) return;
    s.state = newState;
    sessions.value = [...sessions.value];
    saveToStorage(sessions.value);
    broadcastSync({ type: "set-state", sessionIds: [s.id], state: newState });
  }

  function snooze(sessionId: string, ms = 600_000): void {
    const s = sessions.value.find((x) => x.id === sessionId);
    if (!s) return;
    s.snoozedUntil = Date.now() + ms;
    sessions.value = [...sessions.value];
    saveToStorage(sessions.value);
    broadcastSync({ type: "snooze", sessionId: s.id, snoozedUntil: s.snoozedUntil });
  }

  function markAllRead(filter?: SessionFilter): void {
    const changedIds: string[] = [];
    for (const s of sessions.value) {
      if (filter && !filter(s)) continue;
      if (s.state === "waiting" || s.state === "finished") {
        s.state = "resolved";
        changedIds.push(s.id);
      }
    }
    if (changedIds.length > 0) {
      sessions.value = [...sessions.value];
      saveToStorage(sessions.value);
      broadcastSync({ type: "set-state", sessionIds: changedIds, state: "resolved" });
    }
  }

  /**
   * Profile-aware unread count. The bare `unreadCount` computed sums every
   * session in the process-shared store; callers that should only see their
   * own profile pass a predicate (e.g. App.vue bell, NotificationCenter
   * header) so the badge doesn't light up for alerts the user can't see.
   */
  function unreadCountFor(filter: SessionFilter): number {
    let n = 0;
    for (const s of sessions.value) {
      if (!filter(s)) continue;
      if (s.state === "waiting" || s.state === "finished") n += 1;
    }
    return n;
  }

  function markRead(sessionId: string): void {
    setState(sessionId, "resolved");
  }

  /**
   * Acknowledge a session's notification because the user actually typed into
   * that terminal. Merely opening the tab is NOT enough — switching tabs is
   * something the user does while browsing, and it must stay unambiguous that
   * they did something with the result before the alert goes away.
   *
   * `data` is the raw PTY write; passive traffic (mouse tracking, focus
   * in/out) is filtered out by the same predicate the backend uses to decide
   * whether a write should pause a running task.
   *
   * Cheap by design: this runs on every keystroke, so the common case (no
   * unacked thread for this session) exits after one scan and does no work.
   */
  function resolveByEngagement(sessionId: string, data: string): void {
    if (!sessionId) return;
    const targets = sessions.value.filter(
      (s) => s.viewId === sessionId && (s.state === "waiting" || s.state === "finished"),
    );
    if (targets.length === 0) return;
    if (!hasMeaningfulUserInput(data)) return;
    for (const s of targets) setState(s.id, "resolved");
    // Engagement, not a dismissal — same signal the notification center's
    // "Jump" sends, so backend adaptive suppression learns the user acted on
    // this alert. Fire-and-forget: the local state is already resolved and a
    // failed RPC must not resurrect the badge.
    clearOnBackend(sessionId, { dismissed: false }).catch(() => {});
  }

  function removeInternal(sessionIdOrEventId: string): void {
    // Accept either a thread id or a legacy event id (back-compat with old UI).
    const before = sessions.value.length;
    sessions.value = sessions.value.filter((s) => {
      if (s.id === sessionIdOrEventId) return false;
      return true;
    });
    if (sessions.value.length === before) {
      // Try per-event removal (legacy item id).
      sessions.value = sessions.value
        .map((s) => ({ ...s, events: s.events.filter((ev) => ev.id !== sessionIdOrEventId) }))
        .filter((s) => s.events.length > 0);
    }
    saveToStorage(sessions.value);
  }

  function remove(sessionIdOrEventId: string): void {
    removeInternal(sessionIdOrEventId);
    broadcastSync({ type: "remove", id: sessionIdOrEventId });
  }

  function removeByViewId(viewId: string): void {
    if (!viewId) return;
    sessions.value = sessions.value.filter((s) => s.viewId !== viewId);
    saveToStorage(sessions.value);
    broadcastSync({ type: "remove-by-view", viewId });
  }

  function clearAll(filter?: SessionFilter): void {
    let removedIds: string[];
    if (filter) {
      removedIds = sessions.value.filter((s) => filter(s)).map((s) => s.id);
      sessions.value = sessions.value.filter((s) => !filter(s));
    } else {
      removedIds = sessions.value.map((s) => s.id);
      sessions.value = [];
    }
    saveToStorage(sessions.value);
    // Broadcast explicit ids — a blanket "clear everything" would also wipe
    // OTHER-profile sessions a sibling window holds that this window never saw.
    if (removedIds.length > 0) {
      broadcastSync({ type: "clear-sessions", sessionIds: removedIds });
    }
    // Also clear backend attention alerts (bells on tabs/workspaces). The
    // server resolves which profile to clear from the caller's bound
    // session, so the request body stays empty regardless of `filter`.
    import("./app.js")
      .then(({ useAppStore }) => {
        const appStore = useAppStore();
        const api = appStore.getApi();
        if (api?.clearAllAttention) {
          (api.clearAllAttention() as Promise<unknown>)
            .then((nextPayload) => {
              if (nextPayload) appStore.adoptPayload(nextPayload as StatePayload);
            })
            .catch(() => {});
        }
      })
      .catch(() => {});
  }

  /**
   * Clear a session's backend alert entry. `dismissed` distinguishes Jump
   * (engagement — dismissed=false) from Dismiss (no engagement — dismissed=true).
   * Backend uses the flag to feed adaptive suppression (plan § 3.2.6).
   */
  async function clearOnBackend(sessionId: string, { dismissed = false } = {}): Promise<void> {
    const { useAppStore } = await import("./app.js");
    const appStore = useAppStore();
    const api = appStore.getApi();
    // A missing RPC (older backend / transport without this method) is a
    // genuine no-op — nothing to clear. But a real RPC failure must propagate
    // so the caller's runWithToast can surface it; swallowing it would let the
    // UI mark the notification resolved while the backend alert stays active.
    if (!api?.clearAlertForSession) return;
    const next = await (api.clearAlertForSession as (id: string, opts: { dismissed: boolean }) => Promise<unknown>)(
      sessionId,
      { dismissed },
    );
    if (next) appStore.adoptPayload(next as StatePayload);
  }

  function togglePanel(): void {
    panelOpen.value = !panelOpen.value;
  }

  function closePanel(): void {
    panelOpen.value = false;
  }

  function togglePin(): void {
    pinned.value = !pinned.value;
    savePinned(pinned.value);
    if (pinned.value) {
      // Pinning makes the panel permanently visible — clear the transient
      // overlay flag so unpinning later doesn't leave it stuck open.
      panelOpen.value = false;
    } else {
      // Unpinning: keep the panel visible as an overlay so the user can see
      // what's there and close it deliberately with × or Esc. Without this
      // the panel would vanish immediately, feeling abrupt.
      panelOpen.value = true;
    }
  }

  function requestFocus(): void {
    focusRequestSignal.value += 1;
  }

  // Surface an app-level error to the user: persistent entry in the dock
  // (so it survives scroll-away) plus a transient toast (so it grabs
  // attention even when the dock is closed behind a dialog). Callers should
  // use this instead of `console.error` for anything the user needs to act
  // on or recover from — failed IPC, backend validation errors, etc.
  //
  // `profileId` scopes the entry to a single profile so a window viewing
  // profile B doesn't show errors raised in profile A. Defaults to the
  // current window's active profile; callers acting on a specific workspace
  // should pass that workspace's `profileId` instead.
  function showError(
    title: string,
    body: string,
    {
      workspaceId = "",
      workspaceName = "",
      profileId = "",
    }: { workspaceId?: string; workspaceName?: string; profileId?: string } = {},
  ): NotificationEvent {
    const entry = addEvent({
      title,
      body,
      kind: "error",
      tier: 1,
      urgency: "normal",
      workspaceId,
      workspaceName,
      category: "error",
      meta: profileId ? { profileId } : null,
    });
    if (!pinned.value) {
      latestToast.value = { ...entry, category: "error" };
    }
    return entry;
  }

  /**
   * Push a sticky toast. Returns the id so the caller can dismiss it
   * programmatically (e.g. once the underlying problem is resolved). The
   * toast also lands as a persistent dock entry so it survives page reload.
   *
   * `profileId` scopes the mirrored dock entry to a single profile —
   * without it, the unknown-owner pass-through in useNotificationProfileScope
   * would surface this error in every profile's notification panel.
   * Persistent toasts themselves render globally (they're system-level
   * "needs action" indicators that should stay visible across switches).
   */
  function pushPersistentToast({
    title,
    body,
    kind = "error",
    copyPath = "",
    profileId = "",
  }: {
    title: string;
    body: string;
    kind?: NotificationKind;
    copyPath?: string;
    profileId?: string;
  }): string {
    const id = crypto.randomUUID();
    persistentToasts.value = [
      ...persistentToasts.value,
      { id, title, body, kind, copyPath, at: new Date().toISOString() },
    ];
    // Mirror to the dock so a quick "X" on the toast doesn't lose the error
    // entirely — the user can still find it later in the notification panel.
    addEvent({
      title,
      body: copyPath ? `${body}\n${copyPath}` : body,
      kind,
      tier: 1,
      urgency: "normal",
      category: "error",
      meta: profileId ? { profileId } : null,
    });
    return id;
  }

  function dismissPersistentToast(id: string): void {
    persistentToasts.value = persistentToasts.value.filter((t) => t.id !== id);
  }

  /**
   * Auto-dismissing toast for transient success confirmations. Shares the
   * persistent toast stack so it appears in the same bottom-right slot,
   * but isn't mirrored into the notification panel (each successful Git
   * action would otherwise spam the dock).
   */
  function pushEphemeralToast({
    title,
    body,
    kind = "info",
    durationMs = 4000,
  }: {
    title: string;
    body: string;
    kind?: NotificationKind;
    durationMs?: number;
  }): string {
    const id = crypto.randomUUID();
    persistentToasts.value = [...persistentToasts.value, { id, title, body, kind, at: new Date().toISOString() }];
    if (durationMs > 0) {
      setTimeout(() => dismissPersistentToast(id), durationMs);
    }
    return id;
  }

  /**
   * Run an async action, turning a rejection into an error toast instead of
   * an unhandled rejection with no user-visible feedback. Returns whether
   * the action succeeded so a caller can decide UI state (e.g. keep a
   * dialog open) without needing its own try/catch.
   */
  async function runWithToast(
    title: string,
    fn: () => Promise<unknown>,
    options: { workspaceId?: string; workspaceName?: string; profileId?: string } = {},
  ): Promise<boolean> {
    try {
      await fn();
      return true;
    } catch (err) {
      showError(title, (err as Error)?.message || "Action failed", options);
      return false;
    }
  }

  return {
    // State
    sessions,
    items, // back-compat
    panelOpen,
    pinned,
    focusRequestSignal,
    latestToast,
    persistentToasts,
    // Computed
    unreadCount,
    waitingSessions,
    finishedSessions,
    resolvedSessions,
    // Event API
    add,
    addEvent,
    setState,
    snooze,
    markAllRead,
    unreadCountFor,
    markRead,
    resolveByEngagement,
    remove,
    removeByViewId,
    clearAll,
    clearOnBackend,
    togglePanel,
    closePanel,
    togglePin,
    requestFocus,
    showError,
    runWithToast,
    pushPersistentToast,
    pushEphemeralToast,
    dismissPersistentToast,
    // Test hook: apply a cross-window sync message as if it arrived via
    // BroadcastChannel (which doesn't deliver within one JS context).
    _applySyncMessageForTest: applySyncMessage,
  };
});
