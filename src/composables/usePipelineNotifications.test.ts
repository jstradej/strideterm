/**
 * Profile-scoping tests for usePipelineNotifications.
 *
 * Pipeline check state lives in the shared payload (PR summary per
 * provider). Without profile scoping, a "pipeline failed" toast from
 * profile A would fire on profile B's window too. The composable
 * resolves the owning profile from the parent PR's connection /
 * workspace before pushing into the notification store.
 */
import { describe, expect, test, beforeEach, vi } from "vitest";
import { defineComponent, nextTick } from "vue";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { usePipelineNotifications } from "./usePipelineNotifications.js";
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
  return mount(
    defineComponent({
      setup() {
        usePipelineNotifications();
        return () => null;
      },
    }),
  );
}

function makePr({
  prKey,
  title,
  connectionId,
  checks,
}: {
  prKey: string;
  title: string;
  connectionId: string;
  checks: Array<{ id: string; name: string; state: string }>;
}) {
  return {
    [prKey]: {
      pullRequest: { title },
      connectionId,
      reviewWorkspaceId: "",
      existingWorkspaceId: "",
      checks: { items: checks },
    },
  };
}

describe("usePipelineNotifications — profile scoping", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    window.localStorage.clear();
    (window as AnyApi).strideterm = { startupFlags: { windowId: "slot1" } };
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
  });

  test("drops pipeline transitions whose PR belongs to a different profile", async () => {
    const appStore = useAppStore();
    // Seed initial pending state for both PRs so the composable knows
    // they're "running" before they transition.
    appStore.payload = buildPayload({
      azureDevops: {
        pullRequests: {
          ...makePr({
            prKey: "pr-1",
            title: "P1 PR",
            connectionId: "conn-a",
            checks: [{ id: "check-1", name: "build", state: "pending" }],
          }),
          ...makePr({
            prKey: "pr-2",
            title: "P2 PR",
            connectionId: "conn-b",
            checks: [{ id: "check-2", name: "build", state: "pending" }],
          }),
        },
        reviewActivity: [],
        connections: [],
        inboxItems: [],
        lastUpdatedAt: null,
        error: "",
      },
    });

    const notifStore = useNotificationStore();
    const wrapper = mountHarness();

    // Skip startup grace
    vi.setSystemTime(new Date("2025-01-01T00:00:10Z"));

    // Both pipelines transition to succeeded simultaneously.
    appStore.payload = buildPayload({
      azureDevops: {
        pullRequests: {
          ...makePr({
            prKey: "pr-1",
            title: "P1 PR",
            connectionId: "conn-a",
            checks: [{ id: "check-1", name: "build", state: "succeeded" }],
          }),
          ...makePr({
            prKey: "pr-2",
            title: "P2 PR",
            connectionId: "conn-b",
            checks: [{ id: "check-2", name: "build", state: "succeeded" }],
          }),
        },
        reviewActivity: [],
        connections: [],
        inboxItems: [],
        lastUpdatedAt: null,
        error: "",
      },
    });
    await nextTick();
    await flushPromises();

    const titles = notifStore.sessions.map((s) => s.events[0].title);
    // p1 (active) lands, p2 (other profile) does NOT.
    expect(titles.some((t) => t.includes("P1 PR"))).toBe(true);
    expect(titles.some((t) => t.includes("P2 PR"))).toBe(false);
    wrapper.unmount();
  });

  test("stamps meta.profileId on the pipeline session", async () => {
    const appStore = useAppStore();
    appStore.payload = buildPayload({
      azureDevops: {
        pullRequests: {
          ...makePr({
            prKey: "pr-1",
            title: "P1 PR",
            connectionId: "conn-a",
            checks: [{ id: "check-1", name: "build", state: "pending" }],
          }),
        },
        reviewActivity: [],
        connections: [],
        inboxItems: [],
        lastUpdatedAt: null,
        error: "",
      },
    });

    const notifStore = useNotificationStore();
    const wrapper = mountHarness();
    vi.setSystemTime(new Date("2025-01-01T00:00:10Z"));

    appStore.payload = buildPayload({
      azureDevops: {
        pullRequests: {
          ...makePr({
            prKey: "pr-1",
            title: "P1 PR",
            connectionId: "conn-a",
            checks: [{ id: "check-1", name: "build", state: "failed" }],
          }),
        },
        reviewActivity: [],
        connections: [],
        inboxItems: [],
        lastUpdatedAt: null,
        error: "",
      },
    });
    await nextTick();
    await flushPromises();

    expect(notifStore.sessions[0].meta?.profileId).toBe("p1");
    wrapper.unmount();
  });
});
