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

const WORKSPACES = [
  { id: "ws-a", name: "Alpha", profileId: "profile-a", panels: [] },
  { id: "ws-b", name: "Beta", profileId: "profile-b", panels: [] },
];

const PROFILES = [
  { id: "profile-a", name: "A", color: "#fff", workspaceIds: ["ws-a"] },
  { id: "profile-b", name: "B", color: "#fff", workspaceIds: ["ws-b"] },
];

function makePayload(byWorkspace: Record<string, AnyApi>): AnyApi {
  return {
    appState: {
      workspaces: WORKSPACES,
      profiles: PROFILES,
      activeWorkspaceId: "ws-a",
      windowSlots: [{ id: "win-1", profileId: "profile-a", activeWorkspaceId: "ws-a", activeSessionId: "" }],
    },
    attention: { byWorkspace },
  };
}

describe("useNotificationCapture — per-window profile scoping", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setActivePinia(createPinia());
    window.localStorage.removeItem("strideterm-notifications-v2");
    window.localStorage.removeItem("strideterm-notifications-pinned");
    (window as AnyApi).strideterm = { startupFlags: { windowId: "win-1" } };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stores and toasts an alert from this window's profile", async () => {
    const appStore = useAppStore();
    const notifStore = useNotificationStore();
    appStore.payload = makePayload({});
    useNotificationCapture();
    // Skip past the startup grace period (15s) so alerts actually fire.
    vi.advanceTimersByTime(16_000);

    appStore.payload = makePayload({
      "ws-a": { alerts: [{ panelId: "shell", sessionId: "ws-a:shell", kind: "waiting", tier: 1 }] },
    });
    await nextTick();

    expect(notifStore.sessions).toHaveLength(1);
    expect(notifStore.sessions[0].workspaceId).toBe("ws-a");
    expect(notifStore.sessions[0].meta?.profileId).toBe("profile-a");
    // Toast fires in this window — arrival is per-window, never deduped globally.
    expect(notifStore.latestToast).not.toBeNull();
  });

  it("does NOT store an alert from another profile as this window's notification", async () => {
    const appStore = useAppStore();
    const notifStore = useNotificationStore();
    appStore.payload = makePayload({});
    useNotificationCapture();
    vi.advanceTimersByTime(16_000);

    // Alert belongs to ws-b (profile-b) while this window shows profile-a.
    appStore.payload = makePayload({
      "ws-b": { alerts: [{ panelId: "shell", sessionId: "ws-b:shell", kind: "waiting", tier: 1 }] },
    });
    await nextTick();

    expect(notifStore.sessions).toHaveLength(0);
    expect(notifStore.latestToast).toBeNull();
  });

  it("two windows of the same profile each capture the same alert (toast in both)", async () => {
    // Window 1 (profile-a)
    const piniaA = createPinia();
    setActivePinia(piniaA);
    (window as AnyApi).strideterm = { startupFlags: { windowId: "win-1" } };
    const appA = useAppStore();
    const notifA = useNotificationStore();
    appA.payload = makePayload({});
    useNotificationCapture();

    // Window 2 (same profile, different slot)
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

    const alert = { "ws-a": { alerts: [{ panelId: "shell", sessionId: "ws-a:shell", kind: "waiting", tier: 1 }] } };
    appA.payload = makePayload(alert);
    const nextB = makePayload(alert);
    nextB.appState.windowSlots = payloadB.appState.windowSlots;
    appB.payload = nextB;
    await nextTick();

    expect(notifA.sessions).toHaveLength(1);
    expect(notifB.sessions).toHaveLength(1);
    expect(notifA.latestToast).not.toBeNull();
    expect(notifB.latestToast).not.toBeNull();
  });
});

describe("useNotificationCapture — question alerts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setActivePinia(createPinia());
    window.localStorage.removeItem("strideterm-notifications-v2");
    window.localStorage.removeItem("strideterm-notifications-pinned");
    (window as AnyApi).strideterm = { startupFlags: { windowId: "win-1" } };
    vi.mocked(fireNotificationAlert).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function captureQuestion(message: string | undefined) {
    const appStore = useAppStore();
    const notifStore = useNotificationStore();
    appStore.payload = makePayload({});
    useNotificationCapture();
    vi.advanceTimersByTime(16_000);
    appStore.payload = makePayload({
      "ws-a": {
        alerts: [
          {
            alertId: "alert-1",
            panelId: "shell",
            sessionId: "ws-a:shell",
            title: "Claude Code",
            kind: "question",
            tier: 1,
            urgency: "urgent",
            detail: "hook:Notification:permission_prompt",
            ...(message === undefined ? {} : { message }),
          },
        ],
      },
    });
    return notifStore;
  }

  it('derives "Permission needed: <tool>" from Claude\'s own hook message', async () => {
    const notifStore = captureQuestion("Claude needs your permission to use Bash");
    await nextTick();

    const event = notifStore.sessions[0].events[0];
    expect(event.title).toBe("Permission needed: Bash");
    expect(event.body).toBe("Claude needs your permission to use Bash");
    expect(event.kind).toBe("question");
  });

  it("prefers the PermissionRequest summary, which names the tool exactly", async () => {
    const notifStore = captureQuestion("Bash: chmod +x deploy.sh");
    await nextTick();

    const event = notifStore.sessions[0].events[0];
    expect(event.title).toBe("Permission needed: Bash");
    expect(event.body).toBe("Bash: chmod +x deploy.sh");
  });

  it('falls back to "Agent asks a question" for the bare permission message (AskUserQuestion)', async () => {
    const notifStore = captureQuestion("Claude needs your permission");
    await nextTick();

    expect(notifStore.sessions[0].events[0].title).toBe("Agent asks a question");
  });

  it("falls back to a workspace-scoped body when the alert carries no message", async () => {
    const notifStore = captureQuestion(undefined);
    await nextTick();

    const event = notifStore.sessions[0].events[0];
    expect(event.title).toBe("Agent asks a question");
    expect(event.body).toBe("Claude Code in Alpha needs your answer.");
  });

  it("a second question in the same panel takes over the toast instead of queueing behind a dead one", async () => {
    // P2-6: the backend keeps ONE alert per panel, so question B replaces
    // question A there. The toast slot queued B behind A, and A waited for its
    // thread to leave "waiting" — which it never did, because B was keeping it
    // there. The user was left reading a question nobody was asking.
    const notifStore = captureQuestion("Bash: first");
    await nextTick();
    expect(notifStore.latestToast?.body).toBe("Bash: first");

    const appStore = useAppStore();
    appStore.payload = makePayload({
      "ws-a": {
        alerts: [
          {
            alertId: "alert-2",
            panelId: "shell",
            sessionId: "ws-a:shell",
            title: "Claude Code",
            kind: "question",
            tier: 1,
            urgency: "urgent",
            detail: "hook:Notification:permission_prompt",
            message: "Bash: second",
          },
        ],
      },
    });
    await nextTick();

    expect(notifStore.latestToast?.body).toBe("Bash: second");
    expect(notifStore.toastQueue).toHaveLength(0);
    // The first alert is gone from the payload, which is how its toast would
    // have known to close had it still been the one on screen.
    expect(notifStore.liveAlertIds).toEqual(["alert-2"]);
  });

  it("the toast carries the alert id it was built from", async () => {
    const notifStore = captureQuestion("Bash: chmod +x deploy.sh");
    await nextTick();

    expect(notifStore.latestToast?.sourceAlertId).toBe("alert-1");
    expect(notifStore.liveAlertIds).toEqual(["alert-1"]);
  });

  it("a question thread lands in Waiting and passes kind through to the sound layer", async () => {
    const notifStore = captureQuestion("Bash: chmod +x deploy.sh");
    await nextTick();

    expect(notifStore.sessions[0].state).toBe("waiting");
    expect(notifStore.latestToast?.kind).toBe("question");
    // The toast needs the thread key so it can un-stick itself when resolved.
    expect(notifStore.latestToast?.viewId).toBe("ws-a:shell");
    expect(vi.mocked(fireNotificationAlert).mock.calls[0][2]).toMatchObject({ kind: "question" });
  });
});

describe("useNotificationCapture — approval:recorded", () => {
  const EVENT = {
    requestId: "req-1",
    workspaceId: "ws-a",
    viewId: "ws-a:shell",
    workspaceName: "Alpha",
    panelTitle: "Claude Code",
    profileId: "profile-a",
    toolName: "Bash",
    summary: "Bash: chmod +x deploy.sh",
    detail: "chmod +x deploy.sh",
    at: "2026-09-03T10:00:00.000Z",
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let emit: ((event: any) => void) | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let auditRows: any[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let auditQueries: any[] = [];
  /** How many of the next audit queries reject — the transient-failure seam. */
  let auditFailures = 0;
  /**
   * Fail the FIRST query that matches, then disarm. `auditFailures` counts
   * from the front, which cannot reach the sixth query of a walk; this picks
   * the continuation batch out by its cursor.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let auditFailOnce: ((_filters: any) => boolean) | null = null;
  /**
   * While true, a query takes its snapshot and then PARKS until the test
   * releases it — the seam for "a lifecycle trigger landed while an attempt
   * was still in flight", which is the only shape the in-flight race has.
   */
  let auditDefer = false;
  let auditParked: Array<{ resolve: () => void; reject: () => void }> = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let connectionState: ((connection: any) => void) | null = null;

  /**
   * `id` as SQLite hands it out: AUTOINCREMENT in insertion order, stable once
   * assigned. Tests list `auditRows` oldest-first, so the array order IS the
   * insert order — and two rows stamped the same millisecond still get
   * distinct, ordered ids, which is the whole reason the back-fill pages on
   * this column instead of on `timestamp`.
   */
  let auditNextId = 1;
  let auditIds = new Map<string, number>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function withAuditIds(rows: any[]): any[] {
    return rows.map((row) => {
      const key = String(row.resourceId || "");
      if (!auditIds.has(key)) auditIds.set(key, auditNextId++);
      return { ...row, id: auditIds.get(key) };
    });
  }

  /** Let every parked query answer (or fail). */
  function releaseAuditQueries(mode: "resolve" | "reject" = "resolve"): void {
    const parked = auditParked;
    auditParked = [];
    for (const entry of parked) (mode === "resolve" ? entry.resolve : entry.reject)();
  }

  const api = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onApprovalRecorded: (handler: (event: any) => void) => {
      emit = handler;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onConnectionState: (handler: (connection: any) => void) => {
      connectionState = handler;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    queryApprovalAuditLog: async (filters: any) => {
      auditQueries.push(filters);
      if (auditFailures > 0) {
        auditFailures -= 1;
        throw new Error("audit log unavailable");
      }
      if (auditFailOnce?.(filters)) {
        auditFailOnce = null;
        throw new Error("audit log unavailable");
      }
      // `from`/`to` (both inclusive), the exclusive `afterId`/`beforeId`
      // keyset cursors and `limit`, applied the way the SQLite store applies
      // them — ORDER BY id DESC, which is what makes a cursor on `id` and a
      // window on `timestamp` behave differently at a page boundary.
      // `profileId` deliberately is NOT honoured: one test below proves the
      // renderer still filters a foreign profile's row out of the answer.
      const matching = withAuditIds(auditRows)
        .filter(
          (row) =>
            (!filters?.from || String(row.timestamp) >= filters.from) &&
            (!filters?.to || String(row.timestamp) <= filters.to) &&
            (!filters?.afterId || row.id > filters.afterId) &&
            (!filters?.beforeId || row.id < filters.beforeId),
        )
        .sort((left, right) => right.id - left.id);
      // The snapshot is taken BEFORE the park: a query that answers late
      // answers with the log as it was when it was asked, which is exactly the
      // race an in-flight resume has to survive.
      const result = { entries: matching.slice(0, filters?.limit || 50), total: matching.length };
      if (auditDefer) {
        await new Promise<void>((resolve, reject) =>
          auditParked.push({ resolve, reject: () => reject(new Error("audit log unavailable")) }),
        );
      }
      return result;
    },
  };

  beforeEach(() => {
    vi.useFakeTimers();
    setActivePinia(createPinia());
    window.localStorage.removeItem("strideterm-notifications-v2");
    window.localStorage.removeItem("strideterm-notifications-pinned");
    (window as AnyApi).strideterm = { startupFlags: { windowId: "win-1" } };
    vi.mocked(fireNotificationAlert).mockClear();
    emit = null;
    connectionState = null;
    auditRows = [];
    auditQueries = [];
    auditFailures = 0;
    auditFailOnce = null;
    auditDefer = false;
    auditParked = [];
    auditNextId = 1;
    auditIds = new Map<string, number>();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function setup() {
    const appStore = useAppStore();
    const notifStore = useNotificationStore();
    appStore.payload = makePayload({});
    useNotificationCapture(api as AnyApi);
    return notifStore;
  }

  /**
   * The REAL bootstrap order: the capture composable runs inside App.vue's
   * setup, and the payload only lands once `appStore.init(api)` has finished —
   * after the mount. A test that seeds the payload first cannot see the bug
   * this shape exists for.
   */
  function setupBeforePayload() {
    const appStore = useAppStore();
    const notifStore = useNotificationStore();
    appStore.payload = null;
    useNotificationCapture(api as AnyApi);
    return { appStore, notifStore };
  }

  /** A state push that puts this window on `profileId` — a profile switch. */
  function payloadForProfile(profileId: string): AnyApi {
    const payload = makePayload({});
    payload.appState.windowSlots = [{ id: "win-1", profileId, activeWorkspaceId: "ws-a", activeSessionId: "" }];
    return payload;
  }

  /** Let the watchers fire and the back-fill's awaits resolve. */
  async function settle(): Promise<void> {
    await nextTick();
    await vi.advanceTimersByTimeAsync(0);
    await nextTick();
  }

  /**
   * Let a walk that spans several pages — and the continuation batch a capped
   * one queues behind itself — run all the way out.
   */
  async function settleFully(): Promise<void> {
    for (let round = 0; round < 12; round += 1) await settle();
  }

  /** Every approval in history, by request id, order-independent. */
  function approvalIds(notifStore: ReturnType<typeof useNotificationStore>): string[] {
    return notifStore.sessions
      .flatMap((session) => session.events.map((event) => String(event.sourceAlertId || "")))
      .filter((id) => id.startsWith("approval:"))
      .sort();
  }

  const OLD_ROW = {
    timestamp: "2026-09-03T09:00:00.000Z",
    resourceId: "req-old",
    workspaceId: "ws-a",
    workspaceName: "Alpha",
    panelTitle: "Claude Code",
    sessionId: "ws-a:shell",
    profileId: "profile-a",
    toolName: "Bash",
    summary: "Bash: npm test",
  };

  it("records a tier-3 approval entry with no toast, sound or OS popup", async () => {
    const notifStore = setup();
    emit!(EVENT);
    await nextTick();

    expect(notifStore.sessions).toHaveLength(1);
    const session = notifStore.sessions[0];
    const event = session.events[0];
    // "Approval sent", not "Auto-approved": strIDEterm issued a decision;
    // nothing in the flow observes whether Claude Code acted on it.
    expect(event.title).toBe("Approval sent");
    // The tool name appears once. Feeding the renderer the prefixed summary
    // produced "Bash in Alpha: Bash: chmod +x deploy.sh".
    expect(event.body).toBe("Bash in Alpha: chmod +x deploy.sh");
    expect(event.tier).toBe(3);
    expect(event.at).toBe(EVENT.at);
    expect(session.category).toBe("approval");
    expect(session.meta).toMatchObject({ profileId: "profile-a", requestId: "req-1" });
    // Silent: kind "info" lands in Finished, and the entry never becomes a toast.
    expect(session.state).toBe("finished");
    expect(notifStore.latestToast).toBeNull();
    expect(fireNotificationAlert).not.toHaveBeenCalled();
  });

  it("ignores an approval from another profile", async () => {
    const notifStore = setup();
    emit!({ ...EVENT, profileId: "profile-b" });
    await nextTick();

    expect(notifStore.sessions).toHaveLength(0);
  });

  it("strips the tool prefix from a payload that carries only the summary", async () => {
    const notifStore = setup();
    // An older backend, or a replayed event: no `detail` field.
    emit!({ ...EVENT, detail: undefined });
    await nextTick();

    expect(notifStore.sessions[0].events[0].body).toBe("Bash in Alpha: chmod +x deploy.sh");
  });

  it("does nothing when the transport has no approval channel", async () => {
    const appStore = useAppStore();
    const notifStore = useNotificationStore();
    appStore.payload = makePayload({});
    // A transport predating the feature, or none at all (tests, early setup).
    expect(() => useNotificationCapture(null)).not.toThrow();
    expect(notifStore.sessions).toHaveLength(0);
  });

  it("back-fills approvals from the audit log the renderer was not around for", async () => {
    // `approval:recorded` is live and nothing replays it. An approval made
    // while this window was closed, reloading, or not yet connected left a row
    // in SQLite and nothing in the Notification Center.
    auditRows = [
      {
        timestamp: "2026-09-03T09:00:00.000Z",
        resourceId: "req-old",
        workspaceId: "ws-a",
        workspaceName: "Alpha",
        panelTitle: "Claude Code",
        sessionId: "ws-a:shell",
        profileId: "profile-a",
        toolName: "Bash",
        summary: "Bash: npm test",
      },
    ];
    const { appStore, notifStore } = setupBeforePayload();
    // Nothing to scope against yet — asking now would answer for the wrong
    // profile, so nothing is asked.
    await vi.advanceTimersByTimeAsync(0);
    expect(auditQueries).toHaveLength(0);

    appStore.payload = makePayload({});
    await nextTick();
    await vi.advanceTimersByTimeAsync(0);
    await nextTick();

    // `profile-a` is this window's profile and is NOT "default" — the id the
    // fallback used to produce, which threw away every row.
    expect(auditQueries).toEqual([{ limit: 50, profileId: "profile-a" }]);
    expect(notifStore.sessions).toHaveLength(1);
    expect(notifStore.sessions[0].events[0].body).toBe("Bash in Alpha: npm test");

    // Every later payload names the same profile; the trail is fetched once.
    appStore.payload = makePayload({});
    await nextTick();
    await vi.advanceTimersByTimeAsync(0);
    expect(auditQueries).toHaveLength(1);
    expect(notifStore.sessions[0].events).toHaveLength(1);
  });

  it("retries the back-fill after a transient failure instead of retiring the profile", async () => {
    // P2-3: the profile used to be marked done BEFORE the await, and the query
    // swallowed every error. One transient failure — the remote transport not
    // up yet at bootstrap, an IPC restart, a briefly locked SQLite file — and
    // the Notification Center stayed incomplete for the life of the renderer
    // while the rows sat in the audit log.
    auditRows = [
      {
        timestamp: "2026-09-03T09:00:00.000Z",
        resourceId: "req-old",
        workspaceId: "ws-a",
        workspaceName: "Alpha",
        panelTitle: "Claude Code",
        sessionId: "ws-a:shell",
        profileId: "profile-a",
        toolName: "Bash",
        summary: "Bash: npm test",
      },
    ];
    auditFailures = 1;
    const { appStore, notifStore } = setupBeforePayload();

    appStore.payload = makePayload({});
    await nextTick();
    await vi.advanceTimersByTimeAsync(0);
    await nextTick();

    // Asked, and it threw: nothing in history, and the profile is NOT retired.
    expect(auditQueries).toHaveLength(1);
    expect(notifStore.sessions).toHaveLength(0);

    // The next state push — a reconnect, or just the next payload — is the
    // retry. The profile id has not changed, which is exactly why a watcher
    // keyed on it alone could never fire again.
    appStore.payload = makePayload({});
    await nextTick();
    await vi.advanceTimersByTimeAsync(0);
    await nextTick();

    expect(auditQueries).toEqual([
      { limit: 50, profileId: "profile-a" },
      { limit: 50, profileId: "profile-a" },
    ]);
    expect(notifStore.sessions).toHaveLength(1);
    expect(notifStore.sessions[0].events).toHaveLength(1);
    expect(notifStore.sessions[0].events[0].body).toBe("Bash in Alpha: npm test");

    // And exactly once: success retires the profile, so later payloads stop
    // asking and the history gains no duplicate.
    appStore.payload = makePayload({});
    await nextTick();
    await vi.advanceTimersByTimeAsync(0);
    await nextTick();

    expect(auditQueries).toHaveLength(2);
    expect(notifStore.sessions).toHaveLength(1);
    expect(notifStore.sessions[0].events).toHaveLength(1);
  });

  it("the back-fill and the live event cannot produce two entries for one approval", async () => {
    auditRows = [
      {
        timestamp: EVENT.at,
        resourceId: EVENT.requestId,
        workspaceId: EVENT.workspaceId,
        workspaceName: EVENT.workspaceName,
        panelTitle: EVENT.panelTitle,
        sessionId: EVENT.viewId,
        profileId: EVENT.profileId,
        toolName: EVENT.toolName,
        summary: EVENT.summary,
      },
    ];
    const notifStore = setup();
    emit!(EVENT);
    await vi.advanceTimersByTimeAsync(0);
    await nextTick();

    expect(notifStore.sessions).toHaveLength(1);
    expect(notifStore.sessions[0].events).toHaveLength(1);
  });

  it("skips back-filled approvals belonging to another profile", async () => {
    auditRows = [
      {
        timestamp: "2026-09-03T09:00:00.000Z",
        resourceId: "req-other",
        workspaceId: "ws-b",
        workspaceName: "Beta",
        sessionId: "ws-b:shell",
        profileId: "profile-b",
        toolName: "Bash",
        summary: "Bash: ls",
      },
    ];
    const notifStore = setup();
    await vi.advanceTimersByTimeAsync(0);
    await nextTick();

    expect(notifStore.sessions).toHaveLength(0);
  });

  it("resumes from the checkpoint when a profile is re-entered, filling exactly what was missed", async () => {
    // P2-1: a SUCCESSFUL back-fill used to retire the profile for the life of
    // the renderer. But this window drops every live `approval:recorded` whose
    // profile is not the one on screen, so an approval recorded in profile A
    // while the window showed B reached neither path — the audit row existed,
    // the Notification Center entry never did, and no later trigger would ask
    // again. "Synchronised" is a moment in time, not a permanent state.
    auditRows = [OLD_ROW];
    const { appStore, notifStore } = setupBeforePayload();

    appStore.payload = payloadForProfile("profile-a");
    await settle();

    expect(auditQueries).toEqual([{ limit: 50, profileId: "profile-a" }]);
    expect(approvalIds(notifStore)).toEqual(["approval:req-old"]);

    // The user switches this window to profile B.
    appStore.payload = payloadForProfile("profile-b");
    await settle();
    expect(auditQueries[1]).toEqual({ limit: 50, profileId: "profile-b" });

    // An approval is recorded in A while B is on screen: the live event is
    // correctly dropped (wrong profile for this window) and the row lands in
    // the audit log, which is now the only place it exists.
    emit!({ ...EVENT, requestId: "req-missed", at: "2026-09-03T11:00:00.000Z" });
    auditRows = [
      OLD_ROW,
      { ...OLD_ROW, timestamp: "2026-09-03T11:00:00.000Z", resourceId: "req-missed", summary: "Bash: npm run build" },
    ];
    await settle();
    expect(approvalIds(notifStore)).toEqual(["approval:req-old"]);

    // Back to A. The resume asks from the checkpoint rather than from
    // scratch, and the missing approval appears exactly once.
    appStore.payload = payloadForProfile("profile-a");
    await settle();

    // `afterId: 1` — OLD_ROW's row id, exclusive. Not `from: <timestamp>`:
    // the store orders by id, so only an id cursor can page without either
    // repeating a page of same-millisecond rows or stepping over one.
    expect(auditQueries[2]).toEqual({ limit: 50, profileId: "profile-a", afterId: 1 });
    expect(auditQueries).toHaveLength(3);
    expect(approvalIds(notifStore)).toEqual(["approval:req-missed", "approval:req-old"]);
    expect(notifStore.sessions[0].events.filter((event) => event.sourceAlertId === "approval:req-missed")).toHaveLength(
      1,
    );
  });

  it("resumes after a reconnect, and does not re-ask on the first connect", async () => {
    // P2-1, the transport half: `approval:recorded` is live and the server
    // replays nothing a client missed while it was away, so a reconnect is a
    // gap by construction — and a lifetime "done" marker left it open.
    auditRows = [OLD_ROW];
    const { appStore, notifStore } = setupBeforePayload();
    appStore.payload = payloadForProfile("profile-a");
    await settle();
    expect(auditQueries).toHaveLength(1);

    // The first `connected` of the session is not a reconnect; the profile
    // watcher has already asked, and asking twice at bootstrap is waste.
    connectionState!({ connected: true, message: "" });
    await settle();
    expect(auditQueries).toHaveLength(1);

    // Dropped — and an approval is recorded while this client is not
    // listening, so no live event ever reaches it.
    connectionState!({ connected: false, message: "connection lost" });
    auditRows = [
      OLD_ROW,
      { ...OLD_ROW, timestamp: "2026-09-03T11:00:00.000Z", resourceId: "req-missed", summary: "Bash: npm run build" },
    ];
    await settle();
    expect(approvalIds(notifStore)).toEqual(["approval:req-old"]);

    // Back up. No `reconnected` flag needed: this handler saw the drop.
    connectionState!({ connected: true, message: "" });
    await settle();

    expect(auditQueries[1]).toEqual({ limit: 50, profileId: "profile-a", afterId: 1 });
    expect(approvalIds(notifStore)).toEqual(["approval:req-missed", "approval:req-old"]);
    expect(auditQueries).toHaveLength(2);

    // A transport that only LABELS the re-open — the WS re-opened without this
    // handler seeing a `connected: false` — resumes just the same.
    auditRows = [
      ...auditRows,
      { ...OLD_ROW, timestamp: "2026-09-03T12:00:00.000Z", resourceId: "req-later", summary: "Bash: git status" },
    ];
    connectionState!({ connected: true, message: "", reconnected: true });
    await settle();

    expect(auditQueries).toHaveLength(3);
    expect(approvalIds(notifStore)).toEqual(["approval:req-later", "approval:req-missed", "approval:req-old"]);
  });

  it("an empty first back-fill is still a checkpoint, and its resume reaches back over the whole gap", async () => {
    // P2-1: the checkpoint used to BE the newest timestamp folded in, so an
    // empty log recorded the empty string — indistinguishable from "never
    // read". The resume then took the one-page branch meant for a first read
    // and declared a 60-row gap closed after 50 of them, permanently: the
    // cursor moved to the newest row and nothing ever asked below it again.
    const rowAt = (index: number) => ({
      ...OLD_ROW,
      timestamp: `2026-09-03T10:${String(index).padStart(2, "0")}:00.000Z`,
      resourceId: `req-${index}`,
      // One thread per row: a session keeps only its newest 20 events, which
      // would hide most of the walk.
      sessionId: `ws-a:shell-${index}`,
    });

    auditRows = [];
    const { appStore, notifStore } = setupBeforePayload();
    appStore.payload = payloadForProfile("profile-a");
    await settle();

    // Asked once, answered with nothing — and RECORDED as read: the ordinary
    // state push must not query again on every payload.
    expect(auditQueries).toEqual([{ limit: 50, profileId: "profile-a" }]);
    appStore.payload = payloadForProfile("profile-a");
    await settle();
    expect(auditQueries).toHaveLength(1);

    // 60 approvals while this window shows another profile.
    auditRows = Array.from({ length: 60 }, (_, index) => rowAt(index));
    appStore.payload = payloadForProfile("profile-b");
    await settle();
    appStore.payload = payloadForProfile("profile-a");
    await settleFully();

    // All 60 — the one-page branch would have stopped at the newest 50.
    expect(approvalIds(notifStore)).toHaveLength(60);
    expect(approvalIds(notifStore)).toContain("approval:req-0");
    expect(approvalIds(notifStore)).toContain("approval:req-59");
    // No `afterId` — the checkpoint points at nothing — so the walk starts at
    // the top and pages DOWN until the log runs out.
    expect(auditQueries.slice(2)).toEqual([
      { limit: 50, profileId: "profile-a" },
      { limit: 50, profileId: "profile-a", beforeId: 11 },
    ]);
  });

  it("a gap deeper than one batch is closed in chunks — the checkpoint never jumps an unfinished walk", async () => {
    // P2-1: `fetchApprovalRows` stops at BACKFILL_MAX_RESUME_PAGES, and its
    // answer used to say nothing about WHY. The caller moved the checkpoint to
    // the newest row read either way, so everything under the cap became
    // unaskable — the next resume asked `from: <newest>` and could never reach
    // back down. 260 rows is five full pages plus a tail.
    const rowAt = (index: number) => ({
      ...OLD_ROW,
      timestamp: `2026-09-03T11:00:00.${String(index).padStart(3, "0")}Z`,
      resourceId: `req-${index}`,
      // 130 threads of two events each: under both MAX_SESSIONS (200) and
      // MAX_EVENTS_PER_SESSION (20), so nothing is evicted and "every row
      // arrived" is a claim the assertions can actually make.
      sessionId: `ws-a:shell-${index % 130}`,
    });

    auditRows = [OLD_ROW];
    const { appStore, notifStore } = setupBeforePayload();
    appStore.payload = payloadForProfile("profile-a");
    await settle();
    expect(auditQueries).toHaveLength(1);

    auditRows = [OLD_ROW, ...Array.from({ length: 260 }, (_, index) => rowAt(index))];
    appStore.payload = payloadForProfile("profile-b");
    await settle();
    appStore.payload = payloadForProfile("profile-a");
    await settleFully();

    // All 260 plus OLD_ROW: not one row between the old watermark and the new
    // one is left unreachable. The page cap alone would have delivered 246 and
    // called the gap closed.
    expect(approvalIds(notifStore)).toHaveLength(261);
    expect(approvalIds(notifStore)).toContain("approval:req-0");
    expect(approvalIds(notifStore)).toContain("approval:req-259");
    // Nothing missing is only half of "the gap closed". The continuation batch
    // carries rows OLDER than the batch before it, so every thread it touched
    // has to end up newest-first anyway — `approvalIds()` sorts, and would
    // report a reversed thread as a healthy one.
    for (const session of notifStore.sessions) {
      const times = session.events.map((event) => event.at);
      expect(times).toEqual([...times].sort().reverse());
      expect(session.latestAt).toBe(times[0]);
    }
    // Five pages, then — because the fifth came back full — a SIXTH request in
    // a follow-up batch, continuing the same walk from where the cap stopped
    // it (`beforeId: 12`) rather than starting over at the top.
    expect(auditQueries.slice(2)).toEqual([
      { limit: 50, profileId: "profile-a", afterId: 1 },
      { limit: 50, profileId: "profile-a", afterId: 1, beforeId: 212 },
      { limit: 50, profileId: "profile-a", afterId: 1, beforeId: 162 },
      { limit: 50, profileId: "profile-a", afterId: 1, beforeId: 112 },
      { limit: 50, profileId: "profile-a", afterId: 1, beforeId: 62 },
      { limit: 50, profileId: "profile-a", afterId: 1, beforeId: 12 },
    ]);

    // And the watermark that finally moved is the top of the CLOSED walk, so
    // the next resume asks above it and finds nothing left to do.
    connectionState!({ connected: false, message: "connection lost" });
    connectionState!({ connected: true, message: "" });
    await settleFully();
    expect(auditQueries[auditQueries.length - 1]).toEqual({ limit: 50, profileId: "profile-a", afterId: 261 });
    expect(approvalIds(notifStore)).toHaveLength(261);
  });

  it("a page boundary of rows sharing one timestamp does not stall the walk", async () => {
    // P2-1: the cursor was an INCLUSIVE `to: <oldest timestamp seen>`, while
    // the store orders by id. A page whose rows all carry the same millisecond
    // therefore came back byte-identical, the `oldest === before` guard called
    // it "nowhere left to walk", and the rows underneath were never asked for.
    const rowAt = (index: number) => ({
      ...OLD_ROW,
      // One millisecond for all 60 — a burst of auto-approvals inside one turn.
      timestamp: "2026-09-03T11:00:00.000Z",
      resourceId: `req-same-${index}`,
      sessionId: `ws-a:shell-${index}`,
    });

    auditRows = [OLD_ROW];
    const { appStore, notifStore } = setupBeforePayload();
    appStore.payload = payloadForProfile("profile-a");
    await settle();

    auditRows = [OLD_ROW, ...Array.from({ length: 60 }, (_, index) => rowAt(index))];
    appStore.payload = payloadForProfile("profile-b");
    await settle();
    appStore.payload = payloadForProfile("profile-a");
    await settleFully();

    expect(approvalIds(notifStore)).toHaveLength(61);
    expect(approvalIds(notifStore)).toContain("approval:req-same-0");
    expect(approvalIds(notifStore)).toContain("approval:req-same-59");
    expect(auditQueries.slice(2)).toEqual([
      { limit: 50, profileId: "profile-a", afterId: 1 },
      { limit: 50, profileId: "profile-a", afterId: 1, beforeId: 12 },
    ]);
  });

  it("a profile re-entry during an in-flight attempt is queued, not dropped", async () => {
    // P2-2: the in-flight set rightly stops two triggers issuing the same
    // query — but a `resume` is not a duplicate, it is news that a gap MAY
    // have opened since the running attempt took its snapshot. Dropping it was
    // permanent: that attempt then wrote a checkpoint, and the ordinary state
    // push never asks a profile that has one.
    auditRows = [OLD_ROW];
    const { appStore, notifStore } = setupBeforePayload();

    // The first attempt takes its snapshot and parks — the remote round trip
    // that has not come back yet.
    auditDefer = true;
    appStore.payload = payloadForProfile("profile-a");
    await settle();
    expect(auditQueries).toHaveLength(1);

    // The window moves to B (whose own first read parks too) and an approval
    // is recorded in A. The live event is correctly filtered out — wrong
    // profile for this window — so the audit log is the only place it exists.
    appStore.payload = payloadForProfile("profile-b");
    await settle();
    emit!({ ...EVENT, requestId: "req-missed", at: "2026-09-03T11:00:00.000Z" });
    auditRows = [
      OLD_ROW,
      { ...OLD_ROW, timestamp: "2026-09-03T11:00:00.000Z", resourceId: "req-missed", summary: "Bash: npm run build" },
    ];
    await settle();

    // Back to A while A's original request is STILL in flight.
    appStore.payload = payloadForProfile("profile-a");
    await settle();
    expect(auditQueries).toHaveLength(2);
    expect(approvalIds(notifStore)).toEqual([]);

    // The stale snapshot lands. It knows nothing about req-missed — and the
    // queued resume runs straight after it, filling the row exactly once.
    auditDefer = false;
    releaseAuditQueries();
    await settleFully();

    expect(approvalIds(notifStore)).toEqual(["approval:req-missed", "approval:req-old"]);
    expect(auditQueries).toHaveLength(3);
    expect(auditQueries[2]).toEqual({ limit: 50, profileId: "profile-a", afterId: 1 });
  });

  it("a reconnect during an in-flight attempt survives that attempt failing", async () => {
    // P2-2, the other edge the review named: the reconnect can be the LAST
    // trigger there will be, and it landed while the previous attempt was
    // still in flight — including an attempt about to fail, which leaves the
    // checkpoint untouched but also leaves nobody to ask again.
    auditRows = [OLD_ROW];
    const { appStore, notifStore } = setupBeforePayload();
    appStore.payload = payloadForProfile("profile-a");
    await settle();
    expect(auditQueries).toHaveLength(1);

    auditDefer = true;
    connectionState!({ connected: false, message: "connection lost" });
    connectionState!({ connected: true, message: "" });
    await settle();
    expect(auditQueries).toHaveLength(2);

    // An approval is recorded, then the connection flaps again before the
    // parked attempt has answered.
    auditRows = [
      OLD_ROW,
      { ...OLD_ROW, timestamp: "2026-09-03T11:00:00.000Z", resourceId: "req-missed", summary: "Bash: npm run build" },
    ];
    connectionState!({ connected: false, message: "connection lost" });
    connectionState!({ connected: true, message: "" });
    await settle();
    expect(auditQueries).toHaveLength(2);

    // The parked attempt REJECTS. The queued resume still runs.
    auditDefer = false;
    releaseAuditQueries("reject");
    await settleFully();

    expect(approvalIds(notifStore)).toEqual(["approval:req-missed", "approval:req-old"]);
    expect(auditQueries).toHaveLength(3);
    expect(auditQueries[2]).toEqual({ limit: 50, profileId: "profile-a", afterId: 1 });

    // The other half of the same edge: the parked attempt SUCCEEDS, with a
    // snapshot taken before the newer row existed. A stale answer is not a
    // synchronised profile, so the queued reconnect resume still has to run.
    auditDefer = true;
    connectionState!({ connected: false, message: "connection lost" });
    connectionState!({ connected: true, message: "" });
    await settle();
    expect(auditQueries).toHaveLength(4);

    auditRows = [
      ...auditRows,
      { ...OLD_ROW, timestamp: "2026-09-03T12:00:00.000Z", resourceId: "req-later", summary: "Bash: git status" },
    ];
    connectionState!({ connected: false, message: "connection lost" });
    connectionState!({ connected: true, message: "" });
    await settle();
    expect(auditQueries).toHaveLength(4);

    auditDefer = false;
    releaseAuditQueries();
    await settleFully();

    expect(approvalIds(notifStore)).toEqual(["approval:req-later", "approval:req-missed", "approval:req-old"]);
    expect(auditQueries).toHaveLength(5);
    expect(auditQueries[4]).toEqual({ limit: 50, profileId: "profile-a", afterId: 2 });
  });

  it("a resume walks further pages until the gap is closed", async () => {
    // Auto-approve writes a row per tool call, so a profile left off screen
    // for an afternoon can easily have missed more than one page. The FIRST
    // back-fill deliberately reaches back a single page — the recent tail is
    // all a fresh renderer needs — but a resume closes a gap whose start is
    // known, and stopping at 50 there would drop the rest on the floor.
    const rowAt = (index: number) => ({
      ...OLD_ROW,
      timestamp: `2026-09-03T10:${String(index).padStart(2, "0")}:00.000Z`,
      resourceId: `req-${index}`,
      // A thread of its own per row: one session keeps only its newest 20
      // events, which would hide the older half of the walk.
      sessionId: `ws-a:shell-${index}`,
    });
    const rows = Array.from({ length: 60 }, (_, index) => rowAt(index));

    auditRows = [rows[0]];
    const { appStore, notifStore } = setupBeforePayload();
    appStore.payload = payloadForProfile("profile-a");
    await settle();
    expect(auditQueries).toHaveLength(1);

    // 59 approvals happened while this window showed another profile.
    auditRows = rows;
    appStore.payload = payloadForProfile("profile-b");
    await settle();
    appStore.payload = payloadForProfile("profile-a");
    await settle();

    // Page two walks DOWN with `beforeId` — the oldest row id page one
    // returned, exclusive — so a row written at the top of the log mid-walk
    // cannot shift the window and skip anything, the way an offset would.
    // `afterId: 1` is the floor: OLD_ROW's own id, already folded in.
    expect(auditQueries.slice(2)).toEqual([
      { limit: 50, profileId: "profile-a", afterId: 1 },
      { limit: 50, profileId: "profile-a", afterId: 1, beforeId: 11 },
    ]);
    expect(approvalIds(notifStore)).toHaveLength(60);
    expect(approvalIds(notifStore)).toContain("approval:req-1");
    expect(approvalIds(notifStore)).toContain("approval:req-59");
  });

  it("a continuation batch cannot reorder a thread or evict its newest events", async () => {
    // P2-1: the walk pages DOWNWARDS, so the batch that runs second carries
    // rows OLDER than the one that ran first — and the store only ever
    // prepended. Those older rows therefore landed on top of the thread,
    // dragged `latestAt` backwards, and at MAX_EVENTS_PER_SESSION pushed the
    // genuinely newest approvals back out of the history the walk was
    // completing. 260 rows is five capped pages plus a continuation of ten.
    const rowAt = (index: number) => ({
      ...OLD_ROW,
      timestamp: `2026-09-03T11:00:00.${String(index).padStart(3, "0")}Z`,
      resourceId: `req-${index}`,
      // ONE thread for all of them: the 20-event cap is the point here.
      sessionId: "ws-a:shell",
    });

    auditRows = [OLD_ROW];
    const { appStore, notifStore } = setupBeforePayload();
    appStore.payload = payloadForProfile("profile-a");
    await settle();
    expect(auditQueries).toHaveLength(1);

    auditRows = [OLD_ROW, ...Array.from({ length: 260 }, (_, index) => rowAt(index))];
    appStore.payload = payloadForProfile("profile-b");
    await settle();
    appStore.payload = payloadForProfile("profile-a");
    await settleFully();

    // Five pages, then the continuation — so the second batch really did land
    // after the first, which is the only way this bug can be reproduced.
    expect(auditQueries).toHaveLength(8);
    expect(auditQueries[7]).toEqual({ limit: 50, profileId: "profile-a", afterId: 1, beforeId: 12 });

    const session = notifStore.sessions.find((entry) => entry.viewId === "ws-a:shell");
    expect(session).toBeDefined();
    // Exactly the newest twenty, newest first. The prepend delivered the
    // continuation's ten OLDEST rows at the top instead.
    expect(session?.events.map((event) => event.sourceAlertId)).toEqual(
      Array.from({ length: 20 }, (_, index) => `approval:req-${259 - index}`),
    );
    // And the thread sorts by its newest approval, not by whichever batch
    // happened to write last.
    expect(session?.latestAt).toBe("2026-09-03T11:00:00.259Z");
    // The continuation still moved `firstAt` back: those rows are real history
    // even when the event cap keeps them out of the visible thread.
    expect(session?.firstAt).toBe(OLD_ROW.timestamp);
  });

  it("a continuation batch cannot evict newer threads past the session cap", async () => {
    // P2-1, one level up: MAX_SESSIONS is 200, and a prepended older batch
    // pushed threads off the bottom of the list. Those were not stale threads
    // — they were the NEWEST ones the earlier batch had just restored.
    const rowAt = (index: number) => ({
      ...OLD_ROW,
      timestamp: `2026-09-03T11:00:00.${String(index).padStart(3, "0")}Z`,
      resourceId: `req-${index}`,
      // A thread of its own per row, so the session cap is what bites.
      sessionId: `ws-a:shell-${index}`,
    });

    auditRows = [OLD_ROW];
    const { appStore, notifStore } = setupBeforePayload();
    appStore.payload = payloadForProfile("profile-a");
    await settle();

    auditRows = [OLD_ROW, ...Array.from({ length: 260 }, (_, index) => rowAt(index))];
    appStore.payload = payloadForProfile("profile-b");
    await settle();
    appStore.payload = payloadForProfile("profile-a");
    await settleFully();

    // 261 threads for 200 slots: the survivors must be the newest 200.
    expect(notifStore.sessions).toHaveLength(200);
    expect(notifStore.sessions[0].viewId).toBe("ws-a:shell-259");
    expect(notifStore.sessions[199].viewId).toBe("ws-a:shell-60");
    const ids = approvalIds(notifStore);
    expect(ids).toContain("approval:req-259");
    // req-60..req-69 were the first casualties of the prepended continuation.
    expect(ids).toContain("approval:req-60");
    // The continuation's own rows are the oldest in the log, so the cap drops
    // THEM — rather than the newer threads they used to displace.
    expect(ids).not.toContain("approval:req-0");
    expect(ids).not.toContain("approval:req-9");
  });

  it("a resume that fails with no trigger left behind it retries on its own", async () => {
    // P2-2: a failed attempt leaves the checkpoint alone, which is right — but
    // the checkpoint is also what stops the ordinary state push from asking.
    // So the one lifecycle trigger there was going to be threw, nothing was
    // queued, and the gap stayed open for the life of the renderer.
    auditRows = [OLD_ROW];
    const { appStore, notifStore } = setupBeforePayload();
    appStore.payload = payloadForProfile("profile-a");
    await settle();
    expect(auditQueries).toHaveLength(1);

    appStore.payload = payloadForProfile("profile-b");
    await settle();

    // An approval lands in A while B is on screen: the live event is dropped
    // (wrong profile for this window) and the audit row is all that is left.
    emit?.({ ...EVENT, requestId: "req-missed", at: "2026-09-03T11:00:00.000Z" });
    auditRows = [
      OLD_ROW,
      { ...OLD_ROW, timestamp: "2026-09-03T11:00:00.000Z", resourceId: "req-missed", summary: "Bash: npm run build" },
    ];
    await settle();

    // Back to A — the one re-entry — and its query throws.
    auditFailures = 1;
    appStore.payload = payloadForProfile("profile-a");
    await settle();
    expect(auditQueries).toHaveLength(3);
    expect(approvalIds(notifStore)).toEqual(["approval:req-old"]);

    // No second profile switch, no reconnect, no state push: the armed backoff
    // is the only thing that can close this gap, and it does.
    await vi.advanceTimersByTimeAsync(2_000);
    await settleFully();

    expect(auditQueries).toHaveLength(4);
    expect(auditQueries[3]).toEqual({ limit: 50, profileId: "profile-a", afterId: 1 });
    expect(approvalIds(notifStore)).toEqual(["approval:req-missed", "approval:req-old"]);

    // Exactly once. Success disarms the retry, so the backoff does not keep
    // hammering the audit log for the rest of the session.
    await vi.advanceTimersByTimeAsync(120_000);
    await settleFully();
    expect(auditQueries).toHaveLength(4);
    expect(approvalIds(notifStore)).toEqual(["approval:req-missed", "approval:req-old"]);
  });

  it("a reconnect resume that fails retries without a second reconnect", async () => {
    // P2-2, the transport half — and the sharper one: successfully coming back
    // does not produce another `reconnected`, so a catch-up query that throws
    // has nothing at all behind it.
    auditRows = [OLD_ROW];
    const { appStore, notifStore } = setupBeforePayload();
    appStore.payload = payloadForProfile("profile-a");
    await settle();
    expect(auditQueries).toHaveLength(1);

    connectionState?.({ connected: false, message: "connection lost" });
    auditRows = [
      OLD_ROW,
      { ...OLD_ROW, timestamp: "2026-09-03T11:00:00.000Z", resourceId: "req-missed", summary: "Bash: npm run build" },
    ];
    auditFailures = 1;
    connectionState?.({ connected: true, message: "" });
    await settle();
    expect(auditQueries).toHaveLength(2);
    expect(approvalIds(notifStore)).toEqual(["approval:req-old"]);

    await vi.advanceTimersByTimeAsync(2_000);
    await settleFully();

    expect(auditQueries).toHaveLength(3);
    expect(auditQueries[2]).toEqual({ limit: 50, profileId: "profile-a", afterId: 1 });
    expect(approvalIds(notifStore)).toEqual(["approval:req-missed", "approval:req-old"]);
  });

  it("a continuation batch that fails resumes the same walk, and the checkpoint stays put", async () => {
    // P2-2 over an unfinished walk: the retry must continue from the stored
    // `beforeId`, never start a new walk at the top — and the watermark must
    // not move until the walk it belongs to actually reaches the bottom.
    const rowAt = (index: number) => ({
      ...OLD_ROW,
      timestamp: `2026-09-03T11:00:00.${String(index).padStart(3, "0")}Z`,
      resourceId: `req-${index}`,
      // 130 threads of two events each: under both caps, so "every row
      // arrived" is a claim the count can actually make.
      sessionId: `ws-a:shell-${index % 130}`,
    });

    auditRows = [OLD_ROW];
    const { appStore, notifStore } = setupBeforePayload();
    appStore.payload = payloadForProfile("profile-a");
    await settle();

    auditRows = [OLD_ROW, ...Array.from({ length: 260 }, (_, index) => rowAt(index))];
    appStore.payload = payloadForProfile("profile-b");
    await settle();

    // Five capped pages land; the sixth — the continuation — throws.
    auditFailOnce = (filters) => filters?.beforeId === 12;
    appStore.payload = payloadForProfile("profile-a");
    await settleFully();

    const failedAt = auditQueries.length;
    expect(auditQueries[failedAt - 1]).toEqual({ limit: 50, profileId: "profile-a", afterId: 1, beforeId: 12 });
    expect(approvalIds(notifStore)).toHaveLength(251);

    // No further lifecycle trigger. The backoff repeats the SAME walk step.
    await vi.advanceTimersByTimeAsync(2_000);
    await settleFully();

    expect(auditQueries).toHaveLength(failedAt + 1);
    expect(auditQueries[failedAt]).toEqual({ limit: 50, profileId: "profile-a", afterId: 1, beforeId: 12 });
    expect(approvalIds(notifStore)).toHaveLength(261);

    // Only now does the watermark move — to the top of the walk that finally
    // closed, not to the top of the batch that failed underneath it.
    connectionState?.({ connected: false, message: "connection lost" });
    connectionState?.({ connected: true, message: "" });
    await settleFully();
    expect(auditQueries[auditQueries.length - 1]).toEqual({ limit: 50, profileId: "profile-a", afterId: 261 });
    expect(approvalIds(notifStore)).toHaveLength(261);
  });

  it("an ordinary state push retries a failed resume before the backoff comes due", async () => {
    // P2-2's other half. The timer covers "no push ever comes"; the MARKER
    // covers the push that does. Without it the payload watcher is turned away
    // by the checkpoint the failed attempt rightly left in place, and the
    // renderer waits out a backoff it did not need.
    auditRows = [OLD_ROW];
    const { appStore, notifStore } = setupBeforePayload();
    appStore.payload = payloadForProfile("profile-a");
    await settle();

    appStore.payload = payloadForProfile("profile-b");
    await settle();
    auditRows = [
      OLD_ROW,
      { ...OLD_ROW, timestamp: "2026-09-03T11:00:00.000Z", resourceId: "req-missed", summary: "Bash: npm run build" },
    ];

    auditFailures = 1;
    appStore.payload = payloadForProfile("profile-a");
    await settle();
    expect(auditQueries).toHaveLength(3);
    expect(approvalIds(notifStore)).toEqual(["approval:req-old"]);

    // A plain state push: same profile, so only the payload watcher fires —
    // and it fires well inside the two-second backoff.
    appStore.payload = payloadForProfile("profile-a");
    await settleFully();
    expect(auditQueries).toHaveLength(4);
    expect(auditQueries[3]).toEqual({ limit: 50, profileId: "profile-a", afterId: 1 });
    expect(approvalIds(notifStore)).toEqual(["approval:req-missed", "approval:req-old"]);

    // That push consumed the retry, and its success disarmed the timer: the
    // next payload asks nothing, and the backoff never fires behind it.
    appStore.payload = payloadForProfile("profile-a");
    await settleFully();
    await vi.advanceTimersByTimeAsync(120_000);
    await settleFully();
    expect(auditQueries).toHaveLength(4);
  });

  it("the backoff is bounded, and hands a permanent failure back to the state push", async () => {
    // The review's own caveat: an unconditional immediate retry in `catch`
    // would turn a broken transport or a locked SQLite file into a tight loop.
    // Three widening steps, then the timers stop — but the marker stays, so a
    // profile with a checkpoint is left on exactly the terms a profile without
    // one has always had: it retries when the next state push arrives.
    auditRows = [OLD_ROW];
    const { appStore, notifStore } = setupBeforePayload();
    appStore.payload = payloadForProfile("profile-a");
    await settle();
    expect(auditQueries).toHaveLength(1);

    auditRows = [
      OLD_ROW,
      { ...OLD_ROW, timestamp: "2026-09-03T11:00:00.000Z", resourceId: "req-missed", summary: "Bash: npm run build" },
    ];
    auditFailures = 99;
    connectionState?.({ connected: false, message: "connection lost" });
    connectionState?.({ connected: true, message: "" });
    await settle();
    expect(auditQueries).toHaveLength(2);

    for (const delay of [2_000, 10_000, 30_000]) {
      const before = auditQueries.length;
      // A tick short of the step is still quiet — the delay is real, not a
      // zero-timeout loop wearing one.
      await vi.advanceTimersByTimeAsync(delay - 1);
      await settleFully();
      expect(auditQueries).toHaveLength(before);
      await vi.advanceTimersByTimeAsync(1);
      await settleFully();
      expect(auditQueries).toHaveLength(before + 1);
    }

    // Four failures in, the timers are spent: ten minutes of silence.
    await vi.advanceTimersByTimeAsync(600_000);
    await settleFully();
    expect(auditQueries).toHaveLength(5);
    expect(approvalIds(notifStore)).toEqual(["approval:req-old"]);

    // The marker outlives them, so the next state push still closes the gap.
    auditFailures = 0;
    appStore.payload = payloadForProfile("profile-a");
    await settleFully();
    expect(auditQueries).toHaveLength(6);
    expect(auditQueries[5]).toEqual({ limit: 50, profileId: "profile-a", afterId: 1 });
    expect(approvalIds(notifStore)).toEqual(["approval:req-missed", "approval:req-old"]);
  });
});
