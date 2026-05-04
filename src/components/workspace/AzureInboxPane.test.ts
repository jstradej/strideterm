/**
 * Component-level tests for AzureInboxPane mobile/responsive behaviour.
 *
 * These run under jsdom (no dev server, no playwright) — they prove the
 * Vue conditional rendering for the popover triggers tracks `isMobile`
 * correctly, regardless of which dev server the e2e suite happens to
 * pick up. The matchMedia polyfill in test/vitest-setup.ts is overridden
 * per test via `setMatchMediaResult` so we can flip into desktop or
 * mobile mode without touching the viewport.
 */
import { describe, expect, test, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import AzureInboxPane from "./AzureInboxPane.vue";
import { useAppStore } from "../../stores/app.js";
import type { StatePayload } from "../../../electron/shared/types/state.js";

declare const setMatchMediaResult: (query: string, matches: boolean) => void;

function buildPayload(overrides: Record<string, unknown> = {}): StatePayload {
  return {
    appState: {
      activeWorkspaceId: "ws-azure",
      activeProfileId: "default",
      workspaces: [
        {
          id: "ws-azure",
          name: "Azure Inbox",
          kind: "azure",
          panels: [],
        },
      ],
      profiles: [{ id: "default", name: "Default", color: "", workspaceIds: ["ws-azure"] }],
    },
    azureDevops: {
      connections: [
        {
          id: "ado-1",
          label: "Mock org",
          orgUrl: "https://dev.azure.com/mock-org",
          login: "you@example.com",
          status: "ok",
          enabled: true,
        },
      ],
      inbox: {
        recentlyUpdated: [
          {
            prKey: "ado:1",
            project: { name: "MockProject" },
            repository: { name: "platform-api" },
            pullRequest: {
              id: 1,
              title: "Sample PR",
              isDraft: false,
              sourceRefName: "refs/heads/feat/x",
              targetRefName: "refs/heads/main",
              url: "",
            },
            author: { displayName: "Alice" },
            role: "reviewer",
            hasAttention: true,
            attentionReason: "new comment",
            checks: { failedCount: 0, pendingCount: 0, passedCount: 1 },
          },
        ],
        needsAttention: [
          {
            prKey: "ado:1",
            project: { name: "MockProject" },
            repository: { name: "platform-api" },
            pullRequest: {
              id: 1,
              title: "Sample PR",
              isDraft: false,
              sourceRefName: "refs/heads/feat/x",
              targetRefName: "refs/heads/main",
              url: "",
            },
            author: { displayName: "Alice" },
            role: "reviewer",
            hasAttention: true,
            attentionReason: "new comment",
            checks: { failedCount: 0, pendingCount: 0, passedCount: 1 },
          },
        ],
        needsMyReview: [],
        myPullRequests: [],
      },
      ...((overrides.azureDevops as Record<string, unknown>) || {}),
    },
    ...overrides,
  } as unknown as StatePayload;
}

function mountPane() {
  const appStore = useAppStore();
  appStore.payload = buildPayload();
  return mount(AzureInboxPane, {
    props: { workspaceId: "ws-azure" },
    global: {
      stubs: {
        // The async PaneShell + PR row + audit log don't matter for the
        // chrome-collapse assertion; stubbing speeds up mount and avoids
        // pulling their dependencies into the test.
        PaneShell: true,
        AzurePrRow: true,
        AzureAuditLog: true,
      },
    },
  });
}

beforeEach(() => {
  setActivePinia(createPinia());
});

describe("AzureInboxPane responsive chrome", () => {
  test("on desktop viewport the inline tabs + actions are visible, no popover triggers", async () => {
    setMatchMediaResult("(max-width: 768px)", false);
    setMatchMediaResult("(max-width: 768px), (max-height: 500px)", false);
    const wrapper = mountPane();
    await flushPromises();

    expect(wrapper.find(".azure-inbox__tabs-trigger").exists()).toBe(false);
    expect(wrapper.find(".azure-inbox__menu-trigger").exists()).toBe(false);
    // Inline tabs strip + actions cluster always present in DOM
    expect(wrapper.find(".azure-inbox__tabs").exists()).toBe(true);
    expect(wrapper.find(".azure-inbox__actions").exists()).toBe(true);
  });

  test("on mobile viewport the popover triggers render inside the inbox shell", async () => {
    setMatchMediaResult("(max-width: 768px)", true);
    setMatchMediaResult("(max-width: 768px), (max-height: 500px)", true);
    const wrapper = mountPane();
    await flushPromises();

    expect(wrapper.find(".azure-inbox__tabs-trigger").exists()).toBe(true);
    expect(wrapper.find(".azure-inbox__menu-trigger").exists()).toBe(true);
  });

  test("clicking the tabs trigger opens the tabs popover (toggles --tabs-menu-open class)", async () => {
    setMatchMediaResult("(max-width: 768px)", true);
    setMatchMediaResult("(max-width: 768px), (max-height: 500px)", true);
    const wrapper = mountPane();
    await flushPromises();

    expect(wrapper.find(".azure-inbox--tabs-menu-open").exists()).toBe(false);
    await wrapper.find(".azure-inbox__tabs-trigger").trigger("click");
    expect(wrapper.find(".azure-inbox--tabs-menu-open").exists()).toBe(true);
    // Backdrop dismisses
    await wrapper.find(".azure-inbox__menu-backdrop").trigger("click");
    expect(wrapper.find(".azure-inbox--tabs-menu-open").exists()).toBe(false);
  });

  test("clicking the actions trigger opens the actions popover", async () => {
    setMatchMediaResult("(max-width: 768px)", true);
    setMatchMediaResult("(max-width: 768px), (max-height: 500px)", true);
    const wrapper = mountPane();
    await flushPromises();

    expect(wrapper.find(".azure-inbox--menu-open").exists()).toBe(false);
    await wrapper.find(".azure-inbox__menu-trigger").trigger("click");
    expect(wrapper.find(".azure-inbox--menu-open").exists()).toBe(true);
    await wrapper.find(".azure-inbox__menu-backdrop").trigger("click");
    expect(wrapper.find(".azure-inbox--menu-open").exists()).toBe(false);
  });

  test("opening one popover closes the other (mutually exclusive)", async () => {
    setMatchMediaResult("(max-width: 768px)", true);
    setMatchMediaResult("(max-width: 768px), (max-height: 500px)", true);
    const wrapper = mountPane();
    await flushPromises();

    await wrapper.find(".azure-inbox__tabs-trigger").trigger("click");
    expect(wrapper.find(".azure-inbox--tabs-menu-open").exists()).toBe(true);
    await wrapper.find(".azure-inbox__menu-trigger").trigger("click");
    expect(wrapper.find(".azure-inbox--menu-open").exists()).toBe(true);
    expect(wrapper.find(".azure-inbox--tabs-menu-open").exists()).toBe(false);
  });

  test("active tab info renders inside the trigger label on mobile", async () => {
    setMatchMediaResult("(max-width: 768px)", true);
    setMatchMediaResult("(max-width: 768px), (max-height: 500px)", true);
    const wrapper = mountPane();
    await flushPromises();

    // Default tab is "Needs attention" (most-actionable-first).
    const triggerLabel = wrapper.find(".azure-inbox__tabs-trigger__label").text();
    expect(triggerLabel).toBe("Needs attention");
  });
});
