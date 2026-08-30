/**
 * The profile tag on an alert card.
 *
 * The dock normally shows only the active profile's sessions, so the tag on an
 * active-profile card was pure noise — one of the two information-free rows the
 * density pass removed (that half is asserted in NotificationCenter.test.ts).
 * The tag itself stays, for the case it is actually for: a card whose session
 * belongs to a FOREIGN profile, where clicking it also offers a profile switch.
 *
 * Reaching that case means relaxing the dock's own profile filter, which is what
 * the mock below does — and only that: `activeProfileId` is still the real
 * value the component compares against, so this file asserts exactly the render
 * decision and nothing else.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";
import { computed, nextTick } from "vue";
import NotificationCenter from "./NotificationCenter.vue";
import { useNotificationStore } from "../../stores/notifications.js";
import { useAppStore } from "../../stores/app.js";

vi.mock("../../composables/useNotificationProfileScope.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../composables/useNotificationProfileScope.js")>();
  return {
    ...actual,
    useNotificationProfileScope: () => ({
      activeProfileId: computed(() => "p1"),
      profileByWs: computed(() => new Map<string, string>()),
      // Relaxed on purpose — see the file header.
      sessionInActiveProfile: () => true,
    }),
  };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApi = any;

function makePayload(): AnyApi {
  return {
    meta: { appVersion: "0.0.0", platform: "test", repositoryUrl: "", versionCheck: {}, recoveryCandidates: [] },
    appState: {
      activeWorkspaceId: "ws-a",
      profiles: [
        { id: "p1", name: "Profile Alpha", color: "#fff", workspaceIds: ["ws-a"] },
        { id: "p2", name: "Profile Beta", color: "#fff", workspaceIds: [] },
      ],
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
      settings: {},
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
    taskRunner: {},
  };
}

describe("NotificationCenter — profile tag on the alert card", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    window.localStorage.removeItem("strideterm-notifications-v2");
    (window as AnyApi).strideterm = { startupFlags: { windowId: "slot1" } };
  });

  it("is empty for the active profile and names a foreign one, inside the meta row", async () => {
    const appStore = useAppStore();
    const notifStore = useNotificationStore();
    appStore.payload = makePayload();
    notifStore.panelOpen = true;

    notifStore.add({
      title: "Mine",
      kind: "completed",
      workspaceId: "ws-a",
      viewId: "ws-a:sh",
      meta: { profileId: "p1" },
    });
    notifStore.add({
      title: "Theirs",
      kind: "completed",
      workspaceId: "ws-b",
      viewId: "ws-b:sh",
      meta: { profileId: "p2" },
    });

    const wrapper = mount(NotificationCenter);
    await nextTick();
    await nextTick();

    const cards = wrapper.findAll(".notification-item");
    const mine = cards.find((c) => c.text().includes("Mine"))!;
    const theirs = cards.find((c) => c.text().includes("Theirs"))!;

    expect(mine.find(".notification-item__profile-label").exists()).toBe(false);

    const tag = theirs.get(".notification-item__profile-label");
    expect(tag.text()).toBe("Profile Beta");
    expect(tag.attributes("title")).toBe("Profile: Profile Beta");
    // In the meta row beside the event count and the time — not a row of its own.
    expect(theirs.get(".notification-item__meta").find(".notification-item__profile-label").exists()).toBe(true);
  });

  it("stays empty when the stamped profile no longer exists", async () => {
    const appStore = useAppStore();
    const notifStore = useNotificationStore();
    appStore.payload = makePayload();
    notifStore.panelOpen = true;

    notifStore.add({
      title: "Deleted profile",
      kind: "completed",
      workspaceId: "ws-x",
      viewId: "ws-x:sh",
      meta: { profileId: "p-gone" },
    });

    const wrapper = mount(NotificationCenter);
    await nextTick();
    await nextTick();

    expect(wrapper.find(".notification-item").exists()).toBe(true);
    expect(wrapper.find(".notification-item__profile-label").exists()).toBe(false);
  });
});
