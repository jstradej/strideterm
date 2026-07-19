/**
 * Component-level tests for GitHubInboxPane mobile/responsive behaviour.
 *
 * Same approach as AzureInboxPane.test.ts — mount under jsdom with the
 * matchMedia polyfill flipped to mobile and assert the popover triggers
 * render. The GitHub pane shares the .azure-inbox shell so the same CSS
 * media-query rules apply once the triggers are in the DOM.
 */
import { describe, expect, test, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import GitHubInboxPane from "./GitHubInboxPane.vue";
import { useAppStore } from "../../stores/app.js";
import { useNotificationStore } from "../../stores/notifications.js";
import type { StatePayload } from "../../../electron/shared/types/state.js";

declare const setMatchMediaResult: (query: string, matches: boolean) => void;

function buildPayload(): StatePayload {
  return {
    appState: {
      activeWorkspaceId: "ws-github",
      activeProfileId: "default",
      workspaces: [
        {
          id: "ws-github",
          name: "GitHub Inbox",
          kind: "github",
          panels: [],
        },
      ],
      profiles: [{ id: "default", name: "Default", color: "", workspaceIds: ["ws-github"] }],
      settings: { integrations: { github: { reviewRoot: "" } } },
    },
    github: {
      connections: [
        {
          id: "gh-1",
          label: "Mock GitHub",
          hostUrl: "https://github.com",
          currentUserLogin: "you",
          status: "ok",
          enabled: true,
        },
      ],
      inbox: {
        recentlyUpdated: [
          {
            prKey: "github:42",
            repository: { fullName: "mock-org/strideterm" },
            pullRequest: {
              id: 42,
              number: 42,
              title: "Sample GitHub PR",
              draft: false,
              webUrl: "https://github.com/mock-org/strideterm/pull/42",
            },
            author: { login: "alice", displayName: "Alice" },
            role: "reviewer",
            hasAttention: true,
            attentionReason: "review state changed",
            checks: { failedCount: 0, pendingCount: 0, passedCount: 1 },
            reviewerSummary: { approvedCount: 0, changesRequestedCount: 0, pendingCount: 1, totalCount: 1 },
          },
        ],
        needsMyReview: [],
        myPullRequests: [],
        needsAttention: [],
      },
    },
  } as unknown as StatePayload;
}

function mountPane() {
  const appStore = useAppStore();
  appStore.payload = buildPayload();
  return mount(GitHubInboxPane, {
    props: { workspaceId: "ws-github" },
    global: {
      stubs: {
        PaneShell: true,
        PrRow: true,
        AuditLog: true,
      },
    },
  });
}

beforeEach(() => {
  setActivePinia(createPinia());
});

describe("GitHubInboxPane responsive chrome", () => {
  test("on desktop the inline chrome renders without popover triggers", async () => {
    setMatchMediaResult("(max-width: 768px)", false);
    setMatchMediaResult("(max-width: 768px), (max-height: 500px)", false);
    const wrapper = mountPane();
    await flushPromises();

    expect(wrapper.find(".azure-inbox__tabs-trigger").exists()).toBe(false);
    expect(wrapper.find(".azure-inbox__menu-trigger").exists()).toBe(false);
    expect(wrapper.find(".azure-inbox__tabs").exists()).toBe(true);
  });

  test("on mobile the popover triggers render", async () => {
    setMatchMediaResult("(max-width: 768px)", true);
    setMatchMediaResult("(max-width: 768px), (max-height: 500px)", true);
    const wrapper = mountPane();
    await flushPromises();

    expect(wrapper.find(".azure-inbox__tabs-trigger").exists()).toBe(true);
    expect(wrapper.find(".azure-inbox__menu-trigger").exists()).toBe(true);
  });

  test("toggling the actions trigger flips the --menu-open class", async () => {
    setMatchMediaResult("(max-width: 768px)", true);
    setMatchMediaResult("(max-width: 768px), (max-height: 500px)", true);
    const wrapper = mountPane();
    await flushPromises();

    await wrapper.find(".azure-inbox__menu-trigger").trigger("click");
    expect(wrapper.find(".azure-inbox--menu-open").exists()).toBe(true);
    await wrapper.find(".azure-inbox__menu-backdrop").trigger("click");
    expect(wrapper.find(".azure-inbox--menu-open").exists()).toBe(false);
  });

  test("toggling the tabs trigger flips the --tabs-menu-open class", async () => {
    setMatchMediaResult("(max-width: 768px)", true);
    setMatchMediaResult("(max-width: 768px), (max-height: 500px)", true);
    const wrapper = mountPane();
    await flushPromises();

    await wrapper.find(".azure-inbox__tabs-trigger").trigger("click");
    expect(wrapper.find(".azure-inbox--tabs-menu-open").exists()).toBe(true);
    await wrapper.find(".azure-inbox__menu-backdrop").trigger("click");
    expect(wrapper.find(".azure-inbox--tabs-menu-open").exists()).toBe(false);
  });
});

/**
 * Regression coverage for review-code-quality-2026-07.md finding 1.3: the
 * toolbar Refresh and connection-delete handlers were try/finally with no
 * catch, so a failed call silently reset the busy flag with zero
 * user-visible feedback. Both now go through notifications.runWithToast.
 */
describe("GitHubInboxPane — refresh and delete-connection surface failures instead of silently succeeding", () => {
  beforeEach(() => {
    setMatchMediaResult("(max-width: 768px)", false);
    setMatchMediaResult("(max-width: 768px), (max-height: 500px)", false);
  });

  test("handleRefresh: rejection is caught and surfaced as a toast, busy resets", async () => {
    const appStore = useAppStore();
    appStore.payload = buildPayload();
    vi.spyOn(appStore, "refreshGitHub").mockRejectedValue(new Error("network down"));
    const wrapper = mountPane();
    await flushPromises();

    const refreshBtn = wrapper.findAll("button").find((b) => b.text().includes("Refresh"))!;
    await refreshBtn.trigger("click");
    await flushPromises();

    const notifications = useNotificationStore();
    expect(notifications.sessions).toHaveLength(1);
    expect(notifications.sessions[0].events[0].title).toBe("Refresh failed");
    expect(refreshBtn.text()).toBe("Refresh");
    expect(refreshBtn.attributes("disabled")).toBeUndefined();
  });

  test("handleDeleteConnection: rejection is caught and surfaced as a toast, busy resets", async () => {
    const appStore = useAppStore();
    appStore.payload = buildPayload();
    vi.spyOn(appStore, "deleteGitHubConnection").mockRejectedValue(new Error("connection in use"));
    const wrapper = mountPane();
    await flushPromises();

    const connectionsTabBtn = wrapper.findAll(".azure-tab").find((b) => b.text().startsWith("Connections"))!;
    await connectionsTabBtn.trigger("click");

    const deleteBtn = wrapper.findAll("button").find((b) => b.text() === "Delete")!;
    await deleteBtn.trigger("click");
    await flushPromises();

    const notifications = useNotificationStore();
    expect(notifications.sessions).toHaveLength(1);
    expect(notifications.sessions[0].events[0].title).toBe("Delete connection failed");
    expect(deleteBtn.attributes("disabled")).toBeUndefined();
  });
});
