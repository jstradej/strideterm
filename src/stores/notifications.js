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
const MAX_SESSIONS = 200;
const MAX_EVENTS_PER_SESSION = 20;

function threadId(workspaceId, viewId) {
  return `${workspaceId || ""}:${viewId || ""}`;
}

function loadFromStorage() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
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

function saveToStorage(sessions) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions.slice(0, MAX_SESSIONS)));
  } catch {
    // Ignore storage failures.
  }
}

function kindToState(kind) {
  return kind === "completed" || kind === "info" ? "finished" : "waiting";
}

export const useNotificationStore = defineStore("notifications", () => {
  const sessions = ref(loadFromStorage());
  const panelOpen = ref(false);

  // Back-compat computed: a flat `items` list still exposed so older
  // consumers (and tests) can iterate per-event.  New UI reads `sessions`.
  const items = computed(() => {
    const flat = [];
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

  const unreadCount = computed(() => sessions.value.reduce((acc, s) => acc + (s.state === "waiting" ? 1 : 0), 0));

  const waitingSessions = computed(() => sessions.value.filter((s) => s.state === "waiting"));
  const finishedSessions = computed(() => sessions.value.filter((s) => s.state === "finished"));
  const resolvedSessions = computed(() => sessions.value.filter((s) => s.state === "resolved"));

  function findSession(workspaceId, viewId) {
    const id = threadId(workspaceId, viewId);
    return sessions.value.find((s) => s.id === id);
  }

  function addEvent({
    title,
    body,
    kind = "info",
    tier = 1,
    urgency = "normal",
    workspaceId = "",
    workspaceName = "",
    tabName = "",
    viewId = "",
  }) {
    const id = threadId(workspaceId, viewId);
    const eventEntry = {
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
      const session = {
        id,
        workspaceId,
        workspaceName,
        tabName,
        viewId,
        state: kindToState(kind),
        tier,
        urgency,
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
  function add(payload) {
    return addEvent(payload);
  }

  function setState(sessionRef, newState) {
    const s = typeof sessionRef === "string" ? sessions.value.find((x) => x.id === sessionRef) : sessionRef;
    if (!s) return;
    s.state = newState;
    sessions.value = [...sessions.value];
    saveToStorage(sessions.value);
  }

  function snooze(sessionId, ms = 600_000) {
    const s = sessions.value.find((x) => x.id === sessionId);
    if (!s) return;
    s.snoozedUntil = Date.now() + ms;
    sessions.value = [...sessions.value];
    saveToStorage(sessions.value);
  }

  function markAllRead() {
    let changed = false;
    for (const s of sessions.value) {
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

  function markRead(sessionId) {
    setState(sessionId, "resolved");
  }

  function remove(sessionIdOrEventId) {
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

  function removeByViewId(viewId) {
    if (!viewId) return;
    sessions.value = sessions.value.filter((s) => s.viewId !== viewId);
    saveToStorage(sessions.value);
  }

  function clearAll() {
    sessions.value = [];
    saveToStorage(sessions.value);
    // Also clear backend attention alerts (bells on tabs/workspaces)
    import("./app.js")
      .then(({ useAppStore }) => {
        const appStore = useAppStore();
        const api = appStore.getApi();
        if (api?.clearAllAttention) {
          api
            .clearAllAttention()
            .then((nextPayload) => {
              if (nextPayload) appStore.payload = nextPayload;
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
  async function clearOnBackend(sessionId, { dismissed = false } = {}) {
    try {
      const { useAppStore } = await import("./app.js");
      const appStore = useAppStore();
      const api = appStore.getApi();
      if (api?.clearAlertForSession) {
        const next = await api.clearAlertForSession(sessionId, { dismissed });
        if (next) appStore.payload = next;
      }
    } catch {
      // Ignore — clearing backend state is best-effort.
    }
  }

  function togglePanel() {
    panelOpen.value = !panelOpen.value;
  }

  function closePanel() {
    panelOpen.value = false;
  }

  return {
    // State
    sessions,
    items, // back-compat
    panelOpen,
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
    markRead,
    remove,
    removeByViewId,
    clearAll,
    clearOnBackend,
    togglePanel,
    closePanel,
  };
});
