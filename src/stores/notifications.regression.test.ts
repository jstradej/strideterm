/**
 * Regression protection for notification behaviour this change deliberately
 * does NOT touch.
 *
 * The running-agent surfaces show things with DURATION; the bell keeps showing
 * things with a MOMENT. Nothing was latched, nothing was deduplicated away, and
 * the event/thread semantics of the store are unchanged — a repeat completion
 * is real information the user asked to keep. These tests pin that down so a
 * later "let's quieten the dock" edit has to break something visible.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { nextTick } from "vue";
import { setActivePinia, createPinia } from "pinia";
import { useAppStore } from "./app.js";
import { useNotificationStore } from "./notifications.js";
import { useNotificationCapture } from "../composables/useNotificationCapture.js";

vi.mock("../composables/useNotificationSound.js", () => ({
  fireNotificationAlert: vi.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApi = any;

const WORKSPACES = [{ id: "ws-a", name: "Alpha", profileId: "profile-a", panels: [{ id: "shell", title: "Shell" }] }];
const PROFILES = [{ id: "profile-a", name: "A", color: "#fff", workspaceIds: ["ws-a"] }];

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

function liveAlert(alertId: string, at = "2026-08-29T19:17:57.907Z"): Record<string, AnyApi> {
  return {
    "ws-a": {
      count: 1,
      latestAt: at,
      alerts: [{ alertId, panelId: "shell", sessionId: "ws-a:shell", kind: "completed", tier: 1, at }],
    },
  };
}

const LIVE_ALERT = liveAlert("alert-1");

describe("notifications — a repeat completion still reaches the user", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    window.localStorage.removeItem("strideterm-notifications-v2");
    window.localStorage.removeItem("strideterm-notifications-pinned");
  });

  it("a resolved thread reopens and bubbles back to the top when the agent finishes again", () => {
    const notifStore = useNotificationStore();
    notifStore.add({ title: "Older thread", kind: "completed", workspaceId: "ws-b", viewId: "ws-b:shell" });
    notifStore.add({ title: "Claude finished", kind: "completed", workspaceId: "ws-a", viewId: "ws-a:shell" });

    const thread = notifStore.sessions.find((s) => s.viewId === "ws-a:shell")!;
    notifStore.setState(thread.id, "resolved");
    // Push the other thread to the top so the re-bubble is observable.
    notifStore.add({ title: "Other again", kind: "completed", workspaceId: "ws-b", viewId: "ws-b:shell" });
    expect(notifStore.sessions[0].viewId).toBe("ws-b:shell");

    // The agent completes a second turn on the same session.
    notifStore.add({ title: "Claude finished again", kind: "completed", workspaceId: "ws-a", viewId: "ws-a:shell" });

    const reopened = notifStore.sessions.find((s) => s.viewId === "ws-a:shell")!;
    expect(reopened.state).toBe("finished");
    expect(reopened.events.length).toBe(2);
    expect(notifStore.sessions[0].viewId).toBe("ws-a:shell");
    expect(notifStore.unreadCount).toBeGreaterThan(0);
  });

  it("two runs of the same pipeline share one thread, and the second reopens it after an ack", () => {
    const notifStore = useNotificationStore();
    // Pipeline-run notifications carry an EMPTY viewId, so both runs key to the
    // same workspace thread — that is intended: one thread, two events.
    notifStore.add({
      title: "✅ Nightly",
      body: "Run #101 succeeded",
      kind: "completed",
      workspaceId: "ws-a",
      viewId: "",
      category: "pipeline",
    });
    const thread = notifStore.sessions[0];
    notifStore.markRead(thread.id);
    expect(notifStore.sessions[0].state).toBe("resolved");
    expect(notifStore.unreadCount).toBe(0);

    notifStore.add({
      title: "❌ Nightly",
      body: "Run #102 failed",
      kind: "completed",
      workspaceId: "ws-a",
      viewId: "",
      category: "pipeline",
    });

    expect(notifStore.sessions.length).toBe(1);
    expect(notifStore.sessions[0].events.length).toBe(2);
    expect(notifStore.sessions[0].state).toBe("finished");
    expect(notifStore.unreadCount).toBe(1);
  });
});

describe("notifications — the same live alert never fires twice", () => {
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

  async function primedCapture() {
    const appStore = useAppStore();
    const notifStore = useNotificationStore();
    appStore.payload = makePayload({});
    useNotificationCapture();
    // Past the 15s startup grace, so alerts actually fire.
    vi.advanceTimersByTime(16_000);
    return { appStore, notifStore };
  }

  it("re-delivering an unchanged alert adds no second event (same alertId)", async () => {
    const { appStore, notifStore } = await primedCapture();

    appStore.payload = makePayload(LIVE_ALERT);
    await nextTick();
    expect(notifStore.sessions.length).toBe(1);
    expect(notifStore.sessions[0].events.length).toBe(1);

    // The very same alert arrives again in the next snapshot — still live.
    appStore.payload = makePayload(LIVE_ALERT);
    await nextTick();

    expect(notifStore.sessions.length).toBe(1);
    expect(notifStore.sessions[0].events.length).toBe(1);
  });

  it("a still-live alert does not revive a thread the user just resolved", async () => {
    const { appStore, notifStore } = await primedCapture();

    appStore.payload = makePayload(LIVE_ALERT);
    await nextTick();
    const thread = notifStore.sessions[0];

    // The user clicks / dismisses it.
    notifStore.setState(thread.id, "resolved");
    expect(notifStore.unreadCount).toBe(0);

    // A new snapshot still carries the same live key.
    appStore.payload = makePayload(LIVE_ALERT);
    await nextTick();

    expect(notifStore.sessions[0].state).toBe("resolved");
    expect(notifStore.sessions[0].events.length).toBe(1);
    expect(notifStore.unreadCount).toBe(0);

    // The alert clearing and coming back is NOT a new event — the backend
    // alert is the same instance, so its id is the same (V2 plan, Fáze 2).
    appStore.payload = makePayload({});
    await nextTick();
    appStore.payload = makePayload(LIVE_ALERT);
    await nextTick();

    expect(notifStore.sessions[0].events.length).toBe(1);
    expect(notifStore.sessions[0].state).toBe("resolved");
    expect(notifStore.unreadCount).toBe(0);

    // Only a genuinely NEW backend alert — a new alertId — reopens the thread.
    appStore.payload = makePayload({});
    await nextTick();
    appStore.payload = makePayload(liveAlert("alert-2", "2026-08-29T19:25:00.000Z"));
    await nextTick();

    expect(notifStore.sessions[0].events.length).toBe(2);
    expect(notifStore.sessions[0].state).not.toBe("resolved");
    expect(notifStore.unreadCount).toBe(1);
  });
});

describe("notifications — an ack in one window reaches the other", () => {
  class MockBroadcastChannel {
    static instances: MockBroadcastChannel[] = [];
    name: string;
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    constructor(name: string) {
      this.name = name;
      MockBroadcastChannel.instances.push(this);
    }
    postMessage(data: unknown): void {
      for (const inst of MockBroadcastChannel.instances) {
        if (inst !== this && inst.name === this.name) inst.onmessage?.({ data });
      }
    }
    close(): void {
      // no-op
    }
  }

  beforeEach(() => {
    setActivePinia(createPinia());
    window.localStorage.removeItem("strideterm-notifications-v2");
    MockBroadcastChannel.instances = [];
    vi.stubGlobal("BroadcastChannel", MockBroadcastChannel);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("setState broadcasts and the second window applies it", () => {
    setActivePinia(createPinia());
    const windowA = useNotificationStore();
    setActivePinia(createPinia());
    const windowB = useNotificationStore();

    const payload = { title: "Claude finished", kind: "completed" as const, workspaceId: "ws-a", viewId: "ws-a:shell" };
    windowA.add({ ...payload });
    windowB.add({ ...payload });
    expect(windowB.unreadCount).toBe(1);

    windowA.setState(windowA.sessions[0].id, "resolved");

    expect(windowB.sessions[0].state).toBe("resolved");
    expect(windowB.unreadCount).toBe(0);
  });
});
