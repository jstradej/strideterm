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
type NotificationKind =
  "waiting" | "question" | "completed" | "subagent_done" | "info" | "review" | "error" | "warning" | string;

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
  /**
   * When the event happened. For a backend attention alert this is the
   * alert's own `at` — NOT the renderer's capture time, which varies per
   * window and would make the same source event look like several.
   */
  at: string;
  /**
   * Backend `alertId` this event was captured from, when it came from an
   * attention alert. The store's exactly-once guarantee keys on it.
   * Absent on events persisted before V2 and on non-alert sources
   * (review/pipeline notifications, app errors) — those are never
   * retroactively deduplicated, since their identity cannot be recovered.
   */
  sourceAlertId?: string;
  /**
   * Stable rank the SOURCE assigned this event, used only to break a tie when
   * two events share `at` — for a back-filled approval it is the audit row id.
   * A burst of auto-approvals inside one turn shares a millisecond, so the
   * timestamp alone cannot order them; the durable log's own order can.
   * Absent on live events, which arrive in order and need no tiebreak.
   */
  historyRank?: number;
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
  /** Source event time. Defaults to now for locally-originated events. */
  occurredAt?: string;
  /** Backend alert identity — see NotificationEvent.sourceAlertId. */
  sourceAlertId?: string;
  /**
   * This event is being replayed from a durable record, not arriving live, so
   * it may well be OLDER than what history already holds — see `addEvent`.
   *
   * The default insert is a prepend, which is right for a live event and wrong
   * for a back-fill that closes a gap in more than one batch: the batches walk
   * DOWNWARDS, so the second one carries older rows than the first, and
   * prepending them reversed the thread, dragged `latestAt` backwards and — at
   * the 20-event and 200-session caps — evicted the genuinely newest entries.
   */
  historical?: boolean;
  /** Source order for tie-breaking — see NotificationEvent.historyRank. */
  historyRank?: number;
}

/** Payload for the alert-capture entry point, where both fields are required. */
interface AddAlertEventPayload extends AddEventPayload {
  sourceAlertId: string;
  occurredAt: string;
}

type SessionFilter = (_s: NotificationSession) => boolean;

/**
 * The sort key history is ordered by, newest first — see `isNewerEntry`.
 * Both an event and a session reduce to it, so one comparison orders the
 * thread's events and the list of threads alike.
 */
interface HistoryOrder {
  at: string;
  historyRank?: number;
}

/**
 * Cross-window sync messages. Ack/read state only — arrival is intentionally
 * absent (each window captures and toasts its own arrivals).
 */
type NotificationSyncMessage =
  | { type: "set-state"; sessionIds: string[]; state: NotificationState }
  | { type: "snooze"; sessionId: string; snoozedUntil: number }
  | { type: "remove"; id: string }
  | { type: "remove-by-view"; workspaceId: string; viewId: string }
  | { type: "remove-by-workspace"; workspaceId: string }
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
  //
  // `question` falls through to "waiting" (the default): the agent is blocked
  // on the user, which is exactly what the Waiting section is for.
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
        if (!message.workspaceId || !message.viewId) return;
        applyRemoval((s) => s.workspaceId === message.workspaceId && s.viewId === message.viewId);
        break;
      }
      case "remove-by-workspace": {
        if (!message.workspaceId) return;
        applyRemoval((s) => s.workspaceId === message.workspaceId);
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
  // Purely transient UI seam for "open the dock on tab X" (the hero's running-
  // agent chip uses it). Same counter pattern as focusRequestSignal: the
  // requested tab plus a bumped signal so a repeat press retriggers even when
  // nothing else changed. Nothing here is persisted, nothing enters `sessions`,
  // and no thread state or badge is touched.
  const requestedPanelTab = ref("");
  const panelTabRequestSignal = ref(0);
  // Transient toast payload. Lives in the store (not in a composable) so any
  // part of the app can trigger a toast via showError/showToast without
  // threading a ref through prop drilling or custom event buses.
  // `viewId` rides along so a sticky toast (kind "question") can watch its own
  // thread and disappear when the backend alert clears.
  type ToastPayload = NotificationEvent & {
    category: string;
    viewId?: string;
    /**
     * The backend `alertId` this toast was built from, when it had one.
     *
     * A sticky question toast needs to know when ITS OWN question is over, and
     * the thread's state cannot tell it: the backend keeps one alert per panel,
     * so a second question replaces the first while the thread stays
     * `waiting` — leaving the old text on screen and the new one queued behind
     * a toast that would never resolve.
     */
    sourceAlertId?: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    meta?: Record<string, any> | null;
  };
  const latestToast = ref<ToastPayload | null>(null);
  /**
   * Toasts held back while a `question` occupies the slot.
   *
   * `latestToast` is one shared ref, so before this queue any later arrival —
   * a completion, an error, another question — overwrote the toast in place.
   * For a `question` that is a real loss: its toast is deliberately sticky
   * because the agent is blocked until the user answers, and it would vanish
   * without ever having been clicked, closed or resolved.
   *
   * Bounded, because the point is not to replay an evening's worth of alerts
   * once a question is finally answered — the Notification Center already
   * holds all of them.
   */
  const toastQueue = ref<ToastPayload[]>([]);
  const MAX_QUEUED_TOASTS = 5;

  /**
   * Show a toast, or queue it behind an unanswered question.
   *
   * Every toast source goes through here — alert capture, `showError`, the
   * update-available notice, review notifications — so the protected slot
   * cannot be bypassed by writing `latestToast` directly.
   */
  function pushToast(entry: ToastPayload): void {
    const current = latestToast.value;
    if (current && current.kind === "question" && current.id !== entry.id) {
      // …except when the newcomer is that panel's NEXT question. The backend
      // holds one alert per panel, so question B arriving means question A is
      // no longer being asked; queueing B would keep a dead question on screen
      // and hide the live one behind it.
      const replacesCurrentQuestion =
        entry.kind === "question" && Boolean(entry.viewId) && entry.viewId === current.viewId;
      if (!replacesCurrentQuestion) {
        if (!toastQueue.value.some((queued) => queued.id === entry.id)) {
          toastQueue.value = [...toastQueue.value, entry].slice(-MAX_QUEUED_TOASTS);
        }
        return;
      }
    }
    latestToast.value = entry;
  }

  /**
   * Clear the visible toast and promote the next queued one, if any. Called
   * when the toast is dismissed — by the user, by its own timer, or by the
   * backend alert clearing under a sticky question.
   */
  function dismissToast(): void {
    const [next, ...rest] = toastQueue.value;
    toastQueue.value = rest;
    latestToast.value = next || null;
  }
  /**
   * Backend `alertId`s present in the latest attention payload.
   *
   * Written by the capture composable on every payload, read by the sticky
   * question toast to decide whether the question it is showing is still being
   * asked. Identity, not thread state: the same panel can raise a second
   * question while the first one's toast is up.
   */
  const liveAlertIds = ref<string[]>([]);

  function setLiveAlertIds(ids: string[]): void {
    liveAlertIds.value = ids;
  }

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

  /**
   * Is `left` strictly newer than `right` in the history's own ordering?
   *
   * `at` decides; `historyRank` only breaks a tie, and only when both sides
   * carry one. Equal and untied counts as NOT newer, so a chronological insert
   * of equally-stamped events preserves the order they are handed over in.
   */
  function isNewerEntry(left: HistoryOrder, right: HistoryOrder): boolean {
    if (left.at !== right.at) return left.at > right.at;
    if (typeof left.historyRank === "number" && typeof right.historyRank === "number") {
      return left.historyRank > right.historyRank;
    }
    return false;
  }

  /** Where `entry` belongs in a newest-first list. */
  function chronologicalIndex<T>(list: T[], orderOf: (_item: T) => HistoryOrder, entry: HistoryOrder): number {
    let index = 0;
    while (index < list.length && isNewerEntry(orderOf(list[index]), entry)) index += 1;
    return index;
  }

  /** A session sorts by its newest event — which is `events[0]` by construction. */
  function sessionOrder(session: NotificationSession): HistoryOrder {
    return { at: session.latestAt, historyRank: session.events[0]?.historyRank };
  }

  /**
   * The insert every entry point funnels through.
   *
   * `retained` says whether the event actually ENTERED the visible history.
   * Both retention caps can drop a REPLAYED event outright — it is placed by
   * its own chronology, so a row older than everything the cap keeps lands
   * past the end — and a dropped event has to be a no-op for everything the
   * user can see. A live event is always the newest thing in its thread, so
   * it is always retained.
   */
  function insertEvent({
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
    occurredAt = "",
    sourceAlertId = "",
    historical = false,
    historyRank,
  }: AddEventPayload): { event: NotificationEvent; retained: boolean } {
    const id = threadId(workspaceId, viewId);
    const eventEntry: NotificationEvent = {
      id: crypto.randomUUID(),
      title,
      body,
      kind,
      tier,
      urgency,
      at: occurredAt || new Date().toISOString(),
      ...(sourceAlertId ? { sourceAlertId } : {}),
      ...(typeof historyRank === "number" ? { historyRank } : {}),
    };

    const existing = findSession(workspaceId, viewId);
    // Does this event speak for the session as a whole? Every live event
    // does; a replayed one only when it landed at the head of the thread.
    let projectsSession = true;
    if (existing) {
      if (historical) {
        // A replayed row is placed where it BELONGS, not at the head. Both
        // caps then cut the genuinely oldest tail: a second back-fill batch
        // carries older rows than the first, and prepending them used to
        // evict the newest events of the very thread it was completing.
        const events = [...existing.events];
        const index = chronologicalIndex(events, (event) => event, eventEntry);
        // The thread started earlier than history knew — the row proves it.
        // This is deliberately the ONE thing a row outside the cap still
        // says: a lifetime fact about the thread, not a claim about its
        // current state.
        const movedFirstAt = eventEntry.at < existing.firstAt;
        if (movedFirstAt) existing.firstAt = eventEntry.at;
        if (index >= MAX_EVENTS_PER_SESSION) {
          // Older than all MAX_EVENTS_PER_SESSION events the cap keeps, so it
          // is not in the visible history at all. It must therefore touch
          // NOTHING the user can see — no state, no labels, no category, no
          // meta, no tier/urgency, no reordering. Otherwise a replayed row
          // nobody can point at reopens a thread the user already resolved.
          if (movedFirstAt) saveToStorage(sessions.value);
          return { event: eventEntry, retained: false };
        }
        events.splice(index, 0, eventEntry);
        existing.events = events.slice(0, MAX_EVENTS_PER_SESSION);
        // A retained replayed row that is NOT the newest one is history, not
        // news: the session-level projection (state, labels, category, meta)
        // describes `events[0]`, so only an event that became `events[0]`
        // may rewrite it. Everything below is skipped for the rest.
        projectsSession = index === 0;
      } else {
        existing.events = [eventEntry, ...existing.events].slice(0, MAX_EVENTS_PER_SESSION);
      }
      // `events[0]` is the newest by construction on both paths, so this is
      // the live path's `eventEntry.at` unchanged — and, on the historical
      // one, refuses to drag `latestAt` back to an older replayed row.
      existing.latestAt = existing.events[0]?.at || existing.latestAt;
      if (projectsSession) {
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
      }
      // Tier and urgency are aggregates over the whole thread, not a picture
      // of its newest event, so a retained older row still counts in them.
      existing.tier = Math.min(existing.tier ?? 3, tier);
      if (urgency === "urgent") existing.urgency = "urgent";
      // Bubble the session to the top of the list so newest-thread-first
      // ordering stays intuitive even without an explicit sort. A historical
      // event bubbles only as far as its own `latestAt` earns — an older
      // replayed row must not jump its thread over threads that are newer.
      const others = sessions.value.filter((s) => s !== existing);
      if (historical) others.splice(chronologicalIndex(others, sessionOrder, sessionOrder(existing)), 0, existing);
      else others.unshift(existing);
      sessions.value = others;
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
      // Same rule one level up: past MAX_SESSIONS the list drops its oldest
      // thread, so a back-filled session older than 200 already-known ones has
      // to land below them — prepending it evicted a newer thread instead.
      const next = [...sessions.value];
      const index = historical ? chronologicalIndex(next, sessionOrder, sessionOrder(session)) : 0;
      // ...and one older than ALL of them lands past the end, where the slice
      // below throws it away. The store never held it, so say so.
      if (index >= MAX_SESSIONS) return { event: eventEntry, retained: false };
      next.splice(index, 0, session);
      sessions.value = next.slice(0, MAX_SESSIONS);
    }

    saveToStorage(sessions.value);
    return { event: eventEntry, retained: true };
  }

  /** The event itself, for the many call sites that cannot be dropped. */
  function addEvent(payload: AddEventPayload): NotificationEvent {
    return insertEvent(payload).event;
  }

  // Back-compat alias for existing call sites.
  function add(payload: AddEventPayload): NotificationEvent {
    return addEvent(payload);
  }

  /** The already-recorded event for this backend alert, if there is one. */
  function findEventBySourceAlertId(sourceAlertId: string): NotificationEvent | null {
    if (!sourceAlertId) return null;
    for (const session of sessions.value) {
      for (const event of session.events) {
        if (event.sourceAlertId === sourceAlertId) return event;
      }
    }
    return null;
  }

  /**
   * Exactly-once entry point for backend attention alerts (V2 plan, Fáze 2).
   *
   * One backend `addProjectAlert()` produces at most ONE event in this
   * history, no matter how many times the alert comes back in a payload — a
   * rebroadcast, a reconnect, a renderer-side cache replay, a remounted
   * capture composable or a second window all carry the same `alertId`.
   *
   * The whole history is searched BEFORE anything is touched, so a duplicate
   * is completely side-effect free: no append, no thread-state change, no
   * bubbling, no `latestAt` move — and the caller, seeing `inserted: false`,
   * fires no toast, no sound and no OS notification.
   *
   * A genuinely new alert on the same panel carries a NEW `alertId`, so it
   * inserts a second event and keeps the intended reopen semantics for an
   * already-resolved thread.
   *
   * `inserted` means the event is IN the history, not merely that it was new:
   * a replayed row older than everything the 20-event or 200-session cap
   * keeps is dropped by the cap, and reports `inserted: false` for the same
   * reason a duplicate does — nothing was added for the user to see.
   */
  function addAlertEvent(payload: AddAlertEventPayload): { event: NotificationEvent; inserted: boolean } {
    const duplicate = findEventBySourceAlertId(payload.sourceAlertId);
    if (duplicate) return { event: duplicate, inserted: false };
    const { event, retained } = insertEvent(payload);
    return { event, inserted: retained };
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

  /**
   * Drop every session matching `doomed`, persisting only when something
   * actually changed; returns whether it did.
   *
   * The changed-only guard is what makes duplicate delivery harmless. The same
   * removal reaches a window twice — once as the runtime's authoritative event,
   * once as a sibling window's BroadcastChannel echo — and the second pass must
   * not re-broadcast (an endless echo between two windows) or rewrite
   * localStorage for nothing.
   */
  function applyRemoval(doomed: SessionFilter): boolean {
    const next = sessions.value.filter((s) => !doomed(s));
    if (next.length === sessions.value.length) return false;
    sessions.value = next;
    saveToStorage(sessions.value);
    return true;
  }

  /**
   * Drop the history of one removed panel.
   *
   * Keyed on (workspaceId, viewId) rather than viewId alone: a view id is only
   * unique within its workspace, so a legacy or custom id that repeats in
   * another workspace would take that workspace's history down with it.
   */
  function removeByViewId(workspaceId: string, viewId: string): void {
    if (!workspaceId || !viewId) return;
    if (!applyRemoval((s) => s.workspaceId === workspaceId && s.viewId === viewId)) return;
    broadcastSync({ type: "remove-by-view", workspaceId, viewId });
  }

  /**
   * Drop the history of a removed workspace — every thread, resolved ones
   * included. The workspace no longer exists, so nothing in those threads can
   * be jumped to, and an unstamped session left behind would lose the workspace
   * its owning profile was inferred from and start showing in every profile.
   */
  function removeByWorkspaceId(workspaceId: string): void {
    if (!workspaceId) return;
    if (!applyRemoval((s) => s.workspaceId === workspaceId)) return;
    broadcastSync({ type: "remove-by-workspace", workspaceId });
  }

  /**
   * Reconnect reconciliation for workspace-level history.
   *
   * The lifecycle event is transient, so a renderer that was disconnected when a
   * workspace disappeared never sees it. Call this only with an AUTHORITATIVE
   * workspace list — an accepted broadcast, the bootstrap/reconnect getState
   * result, or an API response — never with a locally composed optimistic
   * delete payload or a snapshot the coreRevision gate rejected. Absence from
   * one of those is not proof of deletion, and the history it would remove
   * cannot be recovered.
   *
   * Desktop payloads carry the GLOBAL workspace list, so absence proves
   * deletion. A remote protocol-v2 payload carries only the viewer's own
   * profile, so absence proves deletion only for a session stamped with that
   * same profile — a foreign-profile or unstamped session is retained, since
   * from a partial payload the two are indistinguishable from a deleted one.
   */
  function reconcileWorkspaces(
    liveWorkspaceIds: Set<string>,
    { partialByProfile, viewerProfileId }: { partialByProfile: boolean; viewerProfileId: string | null },
  ): void {
    if (partialByProfile && !viewerProfileId) return;
    const doomedIds = new Set(
      sessions.value
        .filter((s) => {
          if (!s.workspaceId) return false;
          if (liveWorkspaceIds.has(s.workspaceId)) return false;
          if (partialByProfile && String(s.meta?.profileId || "") !== viewerProfileId) return false;
          return true;
        })
        .map((s) => s.id),
    );
    if (doomedIds.size === 0) return;
    applyRemoval((s) => doomedIds.has(s.id));
    // Explicit ids, matching clearAll: a blanket message would also wipe
    // sessions a sibling window holds that this window never had a payload for.
    broadcastSync({ type: "clear-sessions", sessionIds: [...doomedIds] });
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

  /** Show the dock (if it isn't pinned open already) on a specific tab. */
  function openPanelOnTab(tab: string): void {
    requestedPanelTab.value = tab;
    panelTabRequestSignal.value += 1;
    if (!pinned.value) panelOpen.value = true;
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
      pushToast({ ...entry, category: "error" });
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
    requestedPanelTab,
    panelTabRequestSignal,
    latestToast,
    toastQueue,
    pushToast,
    dismissToast,
    liveAlertIds,
    setLiveAlertIds,
    persistentToasts,
    // Computed
    unreadCount,
    waitingSessions,
    finishedSessions,
    resolvedSessions,
    // Event API
    add,
    addEvent,
    addAlertEvent,
    findEventBySourceAlertId,
    setState,
    snooze,
    markAllRead,
    unreadCountFor,
    markRead,
    resolveByEngagement,
    remove,
    removeByViewId,
    removeByWorkspaceId,
    reconcileWorkspaces,
    clearAll,
    clearOnBackend,
    togglePanel,
    closePanel,
    togglePin,
    requestFocus,
    openPanelOnTab,
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
