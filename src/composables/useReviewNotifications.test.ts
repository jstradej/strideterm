/**
 * Profile-scoping tests for useReviewNotifications.
 *
 * Review activity is broadcast in the shared payload to every window. The
 * composable must skip events whose owning profile differs from the active
 * profile — otherwise a window in profile B would surface PR pings from
 * profile A through the dock, toast and notification sound.
 *
 * These tests run the composable inside a synthetic Vue component (so its
 * `watch` set-up actually fires), mutate `appStore.payload.azureDevops.
 * reviewActivity`, wait a tick, and assert what landed in the notification
 * store.
 */
import { describe, expect, test, beforeEach, vi } from "vitest";
import { defineComponent, ref, nextTick } from "vue";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { useReviewNotifications } from "./useReviewNotifications.js";
import { useAppStore } from "../stores/app.js";
import { useNotificationStore } from "../stores/notifications.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApi = any;

vi.mock("./useNotificationSound.js", () => ({
  fireNotificationAlert: vi.fn(),
}));

function buildPayload(overrides: AnyApi = {}): AnyApi {
  return {
    meta: { appVersion: "0.0.0", platform: "test", repositoryUrl: "", versionCheck: {}, recoveryCandidates: [] },
    appState: {
      activeWorkspaceId: "",
      profiles: [
        { id: "p1", name: "P1", color: "#fff", workspaceIds: [] },
        { id: "p2", name: "P2", color: "#fff", workspaceIds: [] },
      ],
      workspaces: [
        { id: "ws-p1", name: "WS1", profileId: "p1", kind: "azure", panels: [] },
        { id: "ws-p2", name: "WS2", profileId: "p2", kind: "azure", panels: [] },
      ],
      windowSlots: [{ id: "slot1", profileId: "p1", activeWorkspaceId: "ws-p1", activeSessionId: "" }],
      settings: {
        integrations: {
          azureDevops: {
            connections: [
              { id: "conn-a", profileId: "p1" },
              { id: "conn-b", profileId: "p2" },
            ],
          },
          github: { connections: [] },
        },
      },
      tabTemplates: [],
      ssh: {
        hosts: [],
        keys: [],
        certificates: [],
        knownHosts: {},
        settings: { defaultAgentMode: "inherit", importedSshConfig: false },
      },
    },
    azureDevops: {
      reviewActivity: [],
      pullRequests: {},
      connections: [],
      inboxItems: [],
      lastUpdatedAt: null,
      error: "",
    },
    github: { reviewActivity: [], pullRequests: {}, connections: [], inboxItems: [], lastUpdatedAt: null, error: "" },
    ...overrides,
  };
}

function mountHarness() {
  const toastRef = ref<AnyApi>(null);
  const wrapper = mount(
    defineComponent({
      setup() {
        useReviewNotifications(toastRef);
        return () => null;
      },
    }),
  );
  return { wrapper, toastRef };
}

describe("useReviewNotifications — profile scoping", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    window.localStorage.clear();
    (window as AnyApi).strideterm = { startupFlags: { windowId: "slot1" } };
    // Skip the startup grace so emitted events fire immediately. The grace
    // ignores events for the first 5s after mount; pushing the clock past
    // it before mount means every event we add lands as a real notification.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
  });

  test("drops events whose owning profile differs from the active profile", async () => {
    const appStore = useAppStore();
    appStore.payload = buildPayload();
    const notifStore = useNotificationStore();

    const { wrapper } = mountHarness();
    // Advance past STARTUP_GRACE_MS (5s) so the next batch isn't seeded silently.
    vi.setSystemTime(new Date("2025-01-01T00:00:10Z"));

    // Two events: one stamped with conn-a (profile p1, active), one with
    // conn-b (profile p2, other). Only the p1 event should land.
    appStore.payload = buildPayload({
      azureDevops: {
        reviewActivity: [
          {
            id: "ev-p2",
            connectionId: "conn-b",
            prKey: "pr-2",
            title: "p2 PR comment",
            body: "from profile 2",
            reviewWorkspaceId: "",
            existingWorkspaceId: "",
          },
          {
            id: "ev-p1",
            connectionId: "conn-a",
            prKey: "pr-1",
            title: "p1 PR comment",
            body: "from profile 1",
            reviewWorkspaceId: "",
            existingWorkspaceId: "",
          },
        ],
        connections: [],
        inboxItems: [],
        pullRequests: {},
        lastUpdatedAt: null,
        error: "",
      },
    });
    await nextTick();
    await flushPromises();

    const titles = notifStore.sessions.map((s) => s.events[0].title);
    expect(titles).toContain("p1 PR comment");
    expect(titles).not.toContain("p2 PR comment");
    wrapper.unmount();
  });

  test("stamps meta.profileId on the session so the NotificationCenter filter can see it", async () => {
    const appStore = useAppStore();
    appStore.payload = buildPayload();
    const notifStore = useNotificationStore();

    const { wrapper } = mountHarness();
    vi.setSystemTime(new Date("2025-01-01T00:00:10Z"));

    appStore.payload = buildPayload({
      azureDevops: {
        reviewActivity: [
          {
            id: "ev-x",
            connectionId: "conn-a",
            prKey: "pr-x",
            title: "test",
            body: "",
            reviewWorkspaceId: "",
            existingWorkspaceId: "",
          },
        ],
        connections: [],
        inboxItems: [],
        pullRequests: {},
        lastUpdatedAt: null,
        error: "",
      },
    });
    await nextTick();
    await flushPromises();

    expect(notifStore.sessions[0].meta?.profileId).toBe("p1");
    wrapper.unmount();
  });

  test("events with an unresolvable owner are dropped", async () => {
    // Backend stamps event.profileId from the owning connection, so a
    // missing profileId here means every source failed: no stamp on the
    // event, no workspace match, and no connection match. Routing such
    // an event to the active profile would silently leak profile-A
    // notifications into whichever window happens to be looking.
    const appStore = useAppStore();
    appStore.payload = buildPayload();
    const notifStore = useNotificationStore();

    const { wrapper } = mountHarness();
    vi.setSystemTime(new Date("2025-01-01T00:00:10Z"));

    appStore.payload = buildPayload({
      azureDevops: {
        reviewActivity: [
          {
            id: "ev-unknown",
            connectionId: "missing-conn",
            prKey: "pr-u",
            title: "unknown",
            body: "",
            reviewWorkspaceId: "",
            existingWorkspaceId: "",
          },
        ],
        connections: [],
        inboxItems: [],
        pullRequests: {},
        lastUpdatedAt: null,
        error: "",
      },
    });
    await nextTick();
    await flushPromises();

    expect(notifStore.sessions.map((s) => s.events[0].title)).not.toContain("unknown");
    wrapper.unmount();
  });

  test("events with backend-stamped profileId route by that stamp, not by lookup", async () => {
    // The PR summary builder stamps event.profileId from connection.profileId
    // even when the workspace lookup would race (deleted workspace, fresh
    // connection without a review workspace yet). The composable must trust
    // the stamp first.
    const appStore = useAppStore();
    appStore.payload = buildPayload();
    const notifStore = useNotificationStore();

    const { wrapper } = mountHarness();
    vi.setSystemTime(new Date("2025-01-01T00:00:10Z"));

    appStore.payload = buildPayload({
      azureDevops: {
        reviewActivity: [
          {
            id: "ev-stamped",
            // No connection in payload, no workspace — only stamp.
            connectionId: "gone",
            profileId: "p1",
            prKey: "pr-stamped",
            title: "from stamp",
            body: "",
            reviewWorkspaceId: "",
            existingWorkspaceId: "",
          },
        ],
        connections: [],
        inboxItems: [],
        pullRequests: {},
        lastUpdatedAt: null,
        error: "",
      },
    });
    await nextTick();
    await flushPromises();

    expect(notifStore.sessions.map((s) => s.events[0].title)).toContain("from stamp");
    expect(notifStore.sessions[0].meta?.profileId).toBe("p1");
    wrapper.unmount();
  });
});
