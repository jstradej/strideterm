import { defineStore } from "pinia";
import { ref, computed } from "vue";

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
const MAX_SESSIONS = 200;
const MAX_EVENTS_PER_SESSION = 20;

type NotificationState = "waiting" | "finished" | "resolved" | "snoozed";
type NotificationUrgency = "normal" | "urgent";
type NotificationKind = "waiting" | "completed" | "info" | "review" | "error" | "warning" | string;

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
  return kind === "completed" || kind === "info" || kind === "review" ? "finished" : "waiting";
}

export const useNotificationStore = defineStore("notifications", () => {
  const sessions = ref<NotificationSession[]>(loadFromStorage());
  const panelOpen = ref(false);
  const pinned = ref(loadPinned());
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
  }

  function snooze(sessionId: string, ms = 600_000): void {
    const s = sessions.value.find((x) => x.id === sessionId);
    if (!s) return;
    s.snoozedUntil = Date.now() + ms;
    sessions.value = [...sessions.value];
    saveToStorage(sessions.value);
  }

  function markAllRead(filter?: SessionFilter): void {
    let changed = false;
    for (const s of sessions.value) {
      if (filter && !filter(s)) continue;
      if (s.state === "waiting" || s.state === "finished") {
        s.state = "resolved";
        changed = true;
      }
    }
    if (changed) {
      sessions.value = [...sessions.value];
      saveToStorage(sessions.value);
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

  function remove(sessionIdOrEventId: string): void {
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

  function removeByViewId(viewId: string): void {
    if (!viewId) return;
    sessions.value = sessions.value.filter((s) => s.viewId !== viewId);
    saveToStorage(sessions.value);
  }

  function clearAll(filter?: SessionFilter): void {
    if (filter) {
      sessions.value = sessions.value.filter((s) => !filter(s));
    } else {
      sessions.value = [];
    }
    saveToStorage(sessions.value);
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
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              if (nextPayload) appStore.payload = nextPayload as any;
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
    try {
      const { useAppStore } = await import("./app.js");
      const appStore = useAppStore();
      const api = appStore.getApi();
      if (api?.clearAlertForSession) {
        const next = await (api.clearAlertForSession as (id: string, opts: { dismissed: boolean }) => Promise<unknown>)(
          sessionId,
          { dismissed },
        );
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (next) appStore.payload = next as any;
      }
    } catch {
      // Ignore — clearing backend state is best-effort.
    }
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
    remove,
    removeByViewId,
    clearAll,
    clearOnBackend,
    togglePanel,
    closePanel,
    togglePin,
    requestFocus,
    showError,
    pushPersistentToast,
    dismissPersistentToast,
  };
});
