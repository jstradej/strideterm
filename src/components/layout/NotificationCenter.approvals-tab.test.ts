/**
 * When the dock offers an Approvals tab.
 *
 * Not "while the checkbox is ticked": that would hide the record of what was
 * approved while it WAS ticked, and the setting flips to false on its own —
 * `updateSettings()` disarms `autoApprovePermissions` whenever
 * `notifications.agentHook` drops. The evidence has to outlive the switch that
 * produced it, so a profile with a trail keeps the tab either way.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";
import NotificationCenter from "./NotificationCenter.vue";
import { useNotificationStore } from "../../stores/notifications.js";
import { useAppStore } from "../../stores/app.js";
import { apiKey } from "../../types/keys.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApi = any;

function makePayload(settings: AnyApi = {}): AnyApi {
  return {
    meta: { appVersion: "0.0.0", platform: "test", repositoryUrl: "", versionCheck: {}, recoveryCandidates: [] },
    appState: {
      activeWorkspaceId: "ws-a",
      profiles: [{ id: "p1", name: "Profile Alpha", color: "#fff", workspaceIds: ["ws-a"] }],
      workspaces: [
        {
          id: "ws-a",
          name: "WsA",
          profileId: "p1",
          panels: [{ id: "sh", title: "Shell", command: "" }],
          kind: "terminal",
          cwd: "/tmp/a",
        },
      ],
      windowSlots: [{ id: "slot1", profileId: "p1", activeWorkspaceId: "ws-a", activeSessionId: "" }],
      settings,
      tabTemplates: [],
      ssh: {
        hosts: [],
        keys: [],
        certificates: [],
        knownHosts: {},
        settings: { defaultAgentMode: "inherit", importedSshConfig: false },
      },
    },
    workspace: null,
    attention: { sessions: {}, alerts: [] },
    docker: {
      available: false,
      backend: null,
      contexts: [],
      containers: [],
      lazydocker: { available: false, backend: null, error: "" },
      error: "",
      lastUpdatedAt: null,
    },
    git: { workspaces: {}, activeWorkspace: null, connections: [] },
    azureDevops: { inboxItems: [], connections: [], lastUpdatedAt: null, error: "" },
    github: { inboxItems: [], connections: [], lastUpdatedAt: null, error: "" },
    reviewBridge: { sessions: {}, enabled: false },
    plugins: [],
    environment: {},
    telegram: { connections: [] },
  };
}

/** A transport whose approval trail holds `total` rows. */
function makeApi(total: number) {
  const queryCalls: AnyApi[] = [];
  const handlers: Array<(_payload: unknown) => void> = [];
  return {
    queryCalls,
    handlers,
    fire: (payload: unknown) => handlers.forEach((handler) => handler(payload)),
    api: {
      isRemote: false,
      queryApprovalAuditLog: (filters: AnyApi) => {
        queryCalls.push(filters);
        return Promise.resolve({ entries: total > 0 ? [{ id: 1, timestamp: new Date().toISOString() }] : [], total });
      },
      deleteApprovalAuditEntries: () => Promise.resolve({ deleted: 0 }),
      onApprovalRecorded: (handler: (_payload: unknown) => void) => handlers.push(handler),
    },
  };
}

async function mountDock({ total = 0, armed = false } = {}) {
  const appStore = useAppStore();
  const notifStore = useNotificationStore();
  appStore.payload = makePayload(armed ? { notifications: { autoApprovePermissions: true } } : {}) as AnyApi;
  notifStore.pinned = true;

  const harness = makeApi(total);
  const wrapper = mount(NotificationCenter, {
    global: { provide: { [apiKey as unknown as symbol]: harness.api } },
  });
  await flushPromises();
  return {
    wrapper,
    notifStore,
    appStore,
    queryCalls: harness.queryCalls,
    handlers: harness.handlers,
    fire: harness.fire,
  };
}

function tabLabels(wrapper: AnyApi): string[] {
  return wrapper.findAll(".notification-center__tab-label").map((el: AnyApi) => el.text());
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }));
});

describe("NotificationCenter — the Approvals tab", () => {
  it("is absent when nothing has been approved and the bypass is off", async () => {
    const { wrapper } = await mountDock({ total: 0, armed: false });
    expect(tabLabels(wrapper)).not.toContain("Approvals");
  });

  it("appears while auto-approve is armed, even with an empty trail", async () => {
    const { wrapper } = await mountDock({ total: 0, armed: true });
    expect(tabLabels(wrapper)).toContain("Approvals");
  });

  it("appears for a profile that HAS a trail even though the bypass is off", async () => {
    // The regression this guards: disarming (or losing `agentHook`, which
    // disarms it for you) would otherwise take the record with it.
    const { wrapper } = await mountDock({ total: 4, armed: false });
    expect(tabLabels(wrapper)).toContain("Approvals");
  });

  it("scopes its probe to the active profile and only runs it while the dock shows", async () => {
    const { queryCalls } = await mountDock({ total: 1, armed: false });
    expect(queryCalls[0]).toMatchObject({ limit: 1, profileId: "p1" });
  });

  it("does not probe at all while the dock is closed", async () => {
    const appStore = useAppStore();
    const notifStore = useNotificationStore();
    appStore.payload = makePayload() as AnyApi;
    notifStore.pinned = false;
    notifStore.panelOpen = false;

    const { api, queryCalls } = makeApi(3);
    mount(NotificationCenter, { global: { provide: { [apiKey as unknown as symbol]: api } } });
    await flushPromises();

    expect(queryCalls).toHaveLength(0);
  });

  it("opens on request even before the probe has found anything", async () => {
    const { wrapper, notifStore } = await mountDock({ total: 0, armed: false });
    expect(tabLabels(wrapper)).not.toContain("Approvals");

    notifStore.openPanelOnTab("approvals");
    await flushPromises();

    // A refused request would look like a dead link; the tab shows its own
    // empty state instead.
    expect(tabLabels(wrapper)).toContain("Approvals");
    expect(wrapper.find(".approvals").exists()).toBe(true);
  });

  it("subscribes to live approvals exactly once, whatever the user does with the tabs", async () => {
    // The subscription is here and not in the tab because the tab is behind a
    // `v-if` and neither transport's onApprovalRecorded hands back an
    // unsubscribe — one listener per tab switch, never dropped.
    const { wrapper, notifStore, handlers } = await mountDock({ total: 2, armed: true });
    expect(handlers).toHaveLength(1);

    notifStore.openPanelOnTab("approvals");
    await flushPromises();
    notifStore.openPanelOnTab("alerts");
    await flushPromises();
    notifStore.openPanelOnTab("approvals");
    await flushPromises();

    expect(handlers).toHaveLength(1);
    expect(wrapper.find(".approvals").exists()).toBe(true);
  });

  it("a live approval makes the tab appear even while the dock is on Alerts", async () => {
    const { wrapper, fire } = await mountDock({ total: 0, armed: false });
    expect(tabLabels(wrapper)).not.toContain("Approvals");

    // The tab is not mounted, so it cannot report a count — which is the
    // second reason the subscription belongs to the dock.
    fire({ profileId: "p1", toolName: "Bash", summary: "Bash: something" });
    await flushPromises();

    expect(tabLabels(wrapper)).toContain("Approvals");
  });

  it("stays put when the trail is cleared from inside it, and goes once you leave", async () => {
    const { wrapper, notifStore } = await mountDock({ total: 2, armed: false });
    notifStore.openPanelOnTab("approvals");
    await flushPromises();
    expect(wrapper.find(".approvals").exists()).toBe(true);

    // Clear all: the panel reports zero. Yanking the tab out from under the
    // click that emptied it would leave the user staring at another tab with
    // no idea what happened.
    wrapper.findComponent({ name: "ApprovalsPanel" }).vm.$emit("count", 0);
    await flushPromises();
    expect(tabLabels(wrapper)).toContain("Approvals");
    expect(wrapper.find(".approvals").exists()).toBe(true);

    // Moving off it is what retires it.
    notifStore.openPanelOnTab("alerts");
    await flushPromises();
    expect(tabLabels(wrapper)).not.toContain("Approvals");
    expect(wrapper.find(".approvals").exists()).toBe(false);
  });
});
