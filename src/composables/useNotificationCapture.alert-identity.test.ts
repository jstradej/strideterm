/**
 * V2 plan, Fáze 2 — stable alert identity and an idempotent history.
 *
 * One backend `addProjectAlert()` must produce exactly ONE notification event,
 * however many times that alert comes back in a renderer payload. The observed
 * `5×` on a single completion was five renderer copies of one alert: the
 * capture keyed on the presence edge of `workspaceId:panelId` and pruned the
 * key whenever the alert momentarily disappeared, so every reappearance looked
 * like a new arrival.
 *
 * The tests below are written against the CONTRACT (`alertId` in, exactly-once
 * out), not against the mechanism, so a later rewrite of either the composable
 * or the store still has to satisfy them.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { nextTick } from "vue";
import { setActivePinia, createPinia } from "pinia";
import { useAppStore } from "../stores/app.js";
import { useNotificationStore } from "../stores/notifications.js";
import { useNotificationCapture } from "./useNotificationCapture.js";
import { fireNotificationAlert } from "./useNotificationSound.js";

vi.mock("./useNotificationSound.js", () => ({
  fireNotificationAlert: vi.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApi = any;

const STORAGE_KEY = "strideterm-notifications-v2";

const WORKSPACES = [
  { id: "ws-a", name: "Alpha", profileId: "profile-a", panels: [{ id: "shell", title: "Shell" }] },
  { id: "ws-b", name: "Beta", profileId: "profile-b", panels: [{ id: "shell", title: "Shell" }] },
];

const PROFILES = [
  { id: "profile-a", name: "A", color: "#fff", workspaceIds: ["ws-a"] },
  { id: "profile-b", name: "B", color: "#fff", workspaceIds: ["ws-b"] },
];

function makePayload(byWorkspace: Record<string, AnyApi>, activeWorkspaceId = "ws-a"): AnyApi {
  return {
    appState: {
      workspaces: WORKSPACES,
      profiles: PROFILES,
      activeWorkspaceId,
      windowSlots: [{ id: "win-1", profileId: "profile-a", activeWorkspaceId, activeSessionId: "" }],
    },
    attention: { byWorkspace },
  };
}

/** One backend alert bucket, exactly as `getAttentionSnapshot()` emits it. */
function bucket({
  alertId,
  workspaceId = "ws-a",
  panelId = "shell",
  at = "2026-08-29T19:17:57.907Z",
  kind = "completed",
}: {
  alertId: string;
  workspaceId?: string;
  panelId?: string;
  at?: string;
  kind?: string;
}): Record<string, AnyApi> {
  return {
    [workspaceId]: {
      count: 1,
      latestAt: at,
      alerts: [
        {
          alertId,
          projectId: workspaceId,
          panelId,
          sessionId: `${workspaceId}:${panelId}`,
          title: "claude",
          exitCode: null,
          kind,
          tier: 1,
          urgency: "normal",
          detail: "",
          at,
        },
      ],
    },
  };
}

function persistedEvents(): AnyApi[] {
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return [];
  return (JSON.parse(raw) as AnyApi[]).flatMap((session) => session.events || []);
}

describe("useNotificationCapture — one backend alert is exactly one event", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(fireNotificationAlert).mockClear();
    setActivePinia(createPinia());
    window.localStorage.removeItem(STORAGE_KEY);
    window.localStorage.removeItem("strideterm-notifications-pinned");
    (window as AnyApi).strideterm = { startupFlags: { windowId: "win-1" } };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Capture composable, primed past the startup grace period. */
  function primedCapture() {
    const appStore = useAppStore();
    const notifStore = useNotificationStore();
    appStore.payload = makePayload({});
    useNotificationCapture();
    vi.advanceTimersByTime(16_000);
    return { appStore, notifStore };
  }

  it("the OS popup is deduped by ALERT id, the ding by session", async () => {
    // Two different questions in one panel, 4 s apart, are two events the user
    // has to see. Keying the OS popup on the session collapsed them into one —
    // while the backend's urgent cooldown is only 3 s, so the second alert is
    // deliberately allowed through upstream.
    const { appStore } = primedCapture();

    appStore.payload = makePayload(bucket({ alertId: "alert-1", kind: "question" }));
    await nextTick();
    appStore.payload = makePayload(bucket({ alertId: "alert-2", kind: "question" }));
    await nextTick();

    const calls = vi.mocked(fireNotificationAlert).mock.calls;
    expect(calls).toHaveLength(2);
    const meta = calls.map((call) => call[2]!);
    expect(meta[0]).toMatchObject({ dedupeKey: "alert-1", sessionKey: "ws-a:ws-a:shell" });
    expect(meta[1]).toMatchObject({ dedupeKey: "alert-2", sessionKey: "ws-a:ws-a:shell" });
    // Same panel, so the SOUND still coalesces on the shared session key.
    expect(meta[0].sessionKey).toBe(meta[1].sessionKey);
  });

  it("records the backend alert id and the backend event time, not the capture time", async () => {
    const { appStore, notifStore } = primedCapture();

    appStore.payload = makePayload(bucket({ alertId: "alert-1", at: "2026-08-29T19:17:57.907Z" }));
    await nextTick();

    expect(notifStore.sessions).toHaveLength(1);
    const [event] = notifStore.sessions[0].events;
    expect(event.sourceAlertId).toBe("alert-1");
    expect(event.at).toBe("2026-08-29T19:17:57.907Z");
    expect(notifStore.sessions[0].latestAt).toBe("2026-08-29T19:17:57.907Z");
  });

  it("survives repeated workspace activations without appending a second event", async () => {
    const { appStore, notifStore } = primedCapture();
    const alert = bucket({ alertId: "alert-1" });

    appStore.payload = makePayload(alert);
    await nextTick();

    // Five snapshots — the shape a burst of workspace activations produces
    // (each one re-emits the whole global attention map).
    for (const activeWorkspaceId of ["ws-b", "ws-a", "ws-b", "ws-a", "ws-b"]) {
      appStore.payload = makePayload(alert, activeWorkspaceId);
      await nextTick();
    }

    expect(notifStore.sessions).toHaveLength(1);
    expect(notifStore.sessions[0].events).toHaveLength(1);
    expect(vi.mocked(fireNotificationAlert)).toHaveBeenCalledTimes(1);
  });

  it("an alert that vanishes and returns with the same id is silent", async () => {
    const { appStore, notifStore } = primedCapture();
    const alert = bucket({ alertId: "alert-1" });

    appStore.payload = makePayload(alert);
    await nextTick();
    const threadId = notifStore.sessions[0].id;
    const firstEventId = notifStore.sessions[0].events[0].id;
    const latestAt = notifStore.sessions[0].latestAt;

    // The user acknowledges it, then a stale snapshot drops the alert and the
    // next one brings the very same alert back.
    notifStore.setState(threadId, "resolved");
    notifStore.add({ title: "Unrelated", kind: "completed", workspaceId: "ws-a", viewId: "ws-a:other" });
    const topBefore = notifStore.sessions[0].viewId;
    vi.mocked(fireNotificationAlert).mockClear();
    notifStore.latestToast = null;

    appStore.payload = makePayload({});
    await nextTick();
    appStore.payload = makePayload(alert);
    await nextTick();

    const thread = notifStore.sessions.find((s) => s.id === threadId)!;
    expect(thread.events).toHaveLength(1);
    expect(thread.events[0].id).toBe(firstEventId);
    expect(thread.state).toBe("resolved");
    expect(thread.latestAt).toBe(latestAt);
    // No bubbling: the thread did not jump back to the top of the list.
    expect(notifStore.sessions[0].viewId).toBe(topBefore);
    expect(notifStore.latestToast).toBeNull();
    expect(vi.mocked(fireNotificationAlert)).not.toHaveBeenCalled();
  });

  it("a genuinely new alert on the same panel appends and reopens the thread", async () => {
    const { appStore, notifStore } = primedCapture();

    appStore.payload = makePayload(bucket({ alertId: "alert-1" }));
    await nextTick();
    notifStore.setState(notifStore.sessions[0].id, "resolved");
    expect(notifStore.unreadCount).toBe(0);

    appStore.payload = makePayload({});
    await nextTick();
    appStore.payload = makePayload({ ...bucket({ alertId: "alert-2", at: "2026-08-29T19:25:00.000Z" }) });
    await nextTick();

    expect(notifStore.sessions).toHaveLength(1);
    expect(notifStore.sessions[0].events).toHaveLength(2);
    expect(notifStore.sessions[0].events.map((e) => e.sourceAlertId)).toEqual(["alert-2", "alert-1"]);
    expect(notifStore.sessions[0].state).not.toBe("resolved");
    expect(notifStore.unreadCount).toBe(1);
  });

  it("a second real alert of the same panel is recorded even while the first is still unread", async () => {
    // V3 review, §4 P1. The capture used to bail out on "this tab already has
    // an unread notification" AFTER adding the new id to the seen-set, so the
    // second real alert was lost forever. A `waiting` alert is the case that
    // bites: its thread stays unread until the user acks it.
    const { appStore, notifStore } = primedCapture();

    appStore.payload = makePayload(bucket({ alertId: "alert-1", kind: "waiting" }));
    await nextTick();
    expect(notifStore.sessions[0].state).toBe("waiting");
    expect(notifStore.items.filter((n) => !n.read)).toHaveLength(1);

    // No ack, no disappearance in between — the backend simply raises a second
    // real alert on the very same panel.
    appStore.payload = makePayload(bucket({ alertId: "alert-2", kind: "waiting", at: "2026-08-29T19:25:00.000Z" }));
    await nextTick();

    // One thread, two source events, still exactly one unread thread.
    expect(notifStore.sessions).toHaveLength(1);
    expect(notifStore.sessions[0].events.map((e) => e.sourceAlertId)).toEqual(["alert-2", "alert-1"]);
    expect(notifStore.sessions[0].state).toBe("waiting");
    expect(notifStore.unreadCount).toBe(1);
    expect(vi.mocked(fireNotificationAlert)).toHaveBeenCalledTimes(2);
  });

  it("an id-less legacy alert still collapses onto an unread thread", async () => {
    // The degraded path keeps the old suppression: with no per-alert identity
    // there is nothing else to stop one panel's re-broadcast from piling up.
    const { appStore, notifStore } = primedCapture();

    const legacy = (at: string): Record<string, AnyApi> => ({
      "ws-a": {
        count: 1,
        latestAt: at,
        alerts: [{ panelId: "shell", sessionId: "ws-a:shell", title: "claude", kind: "waiting", tier: 1, at }],
      },
    });

    appStore.payload = makePayload(legacy("2026-08-29T19:17:57.907Z"));
    await nextTick();
    expect(notifStore.sessions[0].events).toHaveLength(1);

    appStore.payload = makePayload({});
    await nextTick();
    appStore.payload = makePayload(legacy("2026-08-29T19:25:00.000Z"));
    await nextTick();

    expect(notifStore.sessions[0].events).toHaveLength(1);
  });

  it("remounting the composable over a live alert does not re-capture it", async () => {
    const { appStore, notifStore } = primedCapture();

    appStore.payload = makePayload(bucket({ alertId: "alert-1" }));
    await nextTick();
    expect(notifStore.sessions[0].events).toHaveLength(1);

    // Same renderer, a second capture instance (e.g. App.vue remounted).
    useNotificationCapture();
    vi.advanceTimersByTime(16_000);
    appStore.payload = makePayload(bucket({ alertId: "alert-1" }));
    await nextTick();

    expect(notifStore.sessions[0].events).toHaveLength(1);
  });

  it("a renderer reload over a still-live alert does not duplicate the persisted event", async () => {
    const { appStore, notifStore } = primedCapture();

    appStore.payload = makePayload(bucket({ alertId: "alert-1" }));
    await nextTick();
    expect(persistedEvents()).toHaveLength(1);

    // Reload: fresh Pinia, store rehydrates from localStorage, the alert is
    // still live in the very first payload the new renderer sees.
    setActivePinia(createPinia());
    const reloadedApp = useAppStore();
    const reloadedNotif = useNotificationStore();
    reloadedApp.payload = makePayload(bucket({ alertId: "alert-1" }));
    useNotificationCapture();
    vi.advanceTimersByTime(16_000);
    reloadedApp.payload = makePayload(bucket({ alertId: "alert-1" }), "ws-b");
    await nextTick();

    expect(reloadedNotif.sessions[0].events).toHaveLength(1);
    expect(persistedEvents().filter((e) => e.sourceAlertId === "alert-1")).toHaveLength(1);
    expect(notifStore.sessions[0].events).toHaveLength(1);
  });

  it("two windows of the same profile each toast once and persist one source event", async () => {
    const piniaA = createPinia();
    setActivePinia(piniaA);
    const appA = useAppStore();
    const notifA = useNotificationStore();
    appA.payload = makePayload({});
    useNotificationCapture();

    const piniaB = createPinia();
    setActivePinia(piniaB);
    (window as AnyApi).strideterm = { startupFlags: { windowId: "win-2" } };
    const appB = useAppStore();
    const notifB = useNotificationStore();
    const payloadB = makePayload({});
    payloadB.appState.windowSlots = [
      { id: "win-1", profileId: "profile-a", activeWorkspaceId: "ws-a", activeSessionId: "" },
      { id: "win-2", profileId: "profile-a", activeWorkspaceId: "ws-a", activeSessionId: "" },
    ];
    appB.payload = payloadB;
    useNotificationCapture();
    vi.advanceTimersByTime(16_000);

    // Both windows see the same alert three times over.
    for (let i = 0; i < 3; i++) {
      appA.payload = makePayload(bucket({ alertId: "alert-1" }));
      const nextB = makePayload(bucket({ alertId: "alert-1" }));
      nextB.appState.windowSlots = payloadB.appState.windowSlots;
      appB.payload = nextB;
      await nextTick();
    }

    // Arrival is per-window (each window toasts its own), but each window's
    // history — and therefore the shared persisted history — holds exactly one
    // event for the one backend alert.
    expect(notifA.sessions[0].events).toHaveLength(1);
    expect(notifB.sessions[0].events).toHaveLength(1);
    expect(persistedEvents().filter((e) => e.sourceAlertId === "alert-1")).toHaveLength(1);
  });

  it("logs only the capture decision, never the alert body", async () => {
    const logRenderer = vi.fn();
    (window as AnyApi).strideterm = { startupFlags: { windowId: "win-1" }, logRenderer };
    const { appStore } = primedCapture();

    appStore.payload = makePayload(bucket({ alertId: "alert-1" }));
    await nextTick();

    // A reload: the new renderer rehydrates the persisted history but starts
    // with an empty in-memory seen-set, so the store-level guard is what
    // catches the duplicate — and that is what gets logged.
    setActivePinia(createPinia());
    const reloadedApp = useAppStore();
    reloadedApp.payload = makePayload({});
    useNotificationCapture();
    vi.advanceTimersByTime(16_000);
    reloadedApp.payload = makePayload(bucket({ alertId: "alert-1" }));
    await nextTick();

    const captures = logRenderer.mock.calls.filter((call) => call[1] === "notification capture");
    expect(captures).toHaveLength(2);
    expect(captures[0][2]).toEqual({ alertId: "alert-1", workspaceId: "ws-a", panelId: "shell", inserted: true });
    expect(captures[1][2]).toEqual({
      alertId: "alert-1",
      workspaceId: "ws-a",
      panelId: "shell",
      inserted: false,
      skipped: "duplicate-source-alert",
    });
    // Nothing from the alert's own text reaches the log.
    const serialized = JSON.stringify(captures);
    expect(serialized).not.toContain("claude");
    expect(serialized).not.toContain("Task completed");
  });

  it("stays silent while the same live alert is re-broadcast", async () => {
    const logRenderer = vi.fn();
    (window as AnyApi).strideterm = { startupFlags: { windowId: "win-1" }, logRenderer };
    const { appStore } = primedCapture();

    const alert = bucket({ alertId: "alert-1" });
    for (let i = 0; i < 5; i++) {
      appStore.payload = makePayload(alert, i % 2 === 0 ? "ws-a" : "ws-b");
      await nextTick();
    }

    const captures = logRenderer.mock.calls.filter((call) => call[1] === "notification capture");
    expect(captures).toHaveLength(1);
  });

  it("an alert from another profile is not presented in this viewer", async () => {
    const { appStore, notifStore } = primedCapture();

    appStore.payload = makePayload(bucket({ alertId: "alert-1", workspaceId: "ws-b" }));
    await nextTick();

    expect(notifStore.sessions).toHaveLength(0);
    expect(notifStore.latestToast).toBeNull();
  });

  it("loads a pre-V2 event with no sourceAlertId and never merges it retroactively", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        {
          id: "ws-a:ws-a:shell",
          workspaceId: "ws-a",
          workspaceName: "Alpha",
          tabName: "claude",
          viewId: "ws-a:shell",
          state: "resolved",
          tier: 1,
          urgency: "normal",
          category: "terminal",
          meta: { profileId: "profile-a" },
          firstAt: "2026-08-28T10:00:00.000Z",
          latestAt: "2026-08-28T10:00:00.000Z",
          snoozedUntil: 0,
          // Pre-V2 shape: a random UUID and no sourceAlertId at all.
          events: [
            {
              id: "11111111-2222-3333-4444-555555555555",
              title: "Task completed",
              body: "claude in Alpha finished.",
              kind: "completed",
              tier: 1,
              urgency: "normal",
              at: "2026-08-28T10:00:00.000Z",
            },
          ],
        },
      ]),
    );

    const { appStore, notifStore } = primedCapture();
    expect(notifStore.sessions[0].events[0].sourceAlertId).toBeUndefined();

    // A real new alert on that same panel still lands as its own event — the
    // legacy one is never claimed as "already captured".
    appStore.payload = makePayload(bucket({ alertId: "alert-1", at: "2026-08-29T19:17:57.907Z" }));
    await nextTick();

    expect(notifStore.sessions[0].events).toHaveLength(2);
    expect(notifStore.sessions[0].events[0].sourceAlertId).toBe("alert-1");
    expect(notifStore.sessions[0].events[1].sourceAlertId).toBeUndefined();
  });
});

describe("notification store — addAlertEvent is side-effect free on a duplicate", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    window.localStorage.removeItem(STORAGE_KEY);
  });

  it("returns inserted:false and touches neither state, order nor latestAt", () => {
    const store = useNotificationStore();
    const first = store.addAlertEvent({
      title: "Task completed",
      kind: "completed",
      workspaceId: "ws-a",
      viewId: "ws-a:shell",
      sourceAlertId: "alert-1",
      occurredAt: "2026-08-29T19:17:57.907Z",
    });
    expect(first.inserted).toBe(true);

    store.setState(store.sessions[0].id, "resolved");
    store.add({ title: "Unrelated", kind: "completed", workspaceId: "ws-z", viewId: "ws-z:shell" });
    const orderBefore = store.sessions.map((s) => s.id);

    const repeat = store.addAlertEvent({
      title: "Task completed",
      kind: "completed",
      workspaceId: "ws-a",
      viewId: "ws-a:shell",
      sourceAlertId: "alert-1",
      occurredAt: "2026-08-29T19:30:00.000Z",
    });

    expect(repeat.inserted).toBe(false);
    expect(repeat.event.id).toBe(first.event.id);
    expect(store.sessions.map((s) => s.id)).toEqual(orderBefore);
    const thread = store.sessions.find((s) => s.viewId === "ws-a:shell")!;
    expect(thread.events).toHaveLength(1);
    expect(thread.state).toBe("resolved");
    expect(thread.latestAt).toBe("2026-08-29T19:17:57.907Z");
  });

  it("deduplicates across the whole history, not just the matching thread", () => {
    const store = useNotificationStore();
    store.addAlertEvent({
      title: "Task completed",
      workspaceId: "ws-a",
      viewId: "ws-a:shell",
      sourceAlertId: "alert-1",
      occurredAt: "2026-08-29T19:17:57.907Z",
    });

    // Same source alert, but the caller resolved a different thread key
    // (e.g. the workspace was renamed / the session id changed shape).
    const repeat = store.addAlertEvent({
      title: "Task completed",
      workspaceId: "ws-a",
      viewId: "ws-a:other",
      sourceAlertId: "alert-1",
      occurredAt: "2026-08-29T19:17:57.907Z",
    });

    expect(repeat.inserted).toBe(false);
    expect(store.sessions).toHaveLength(1);
  });
});
