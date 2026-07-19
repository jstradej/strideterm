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
import { describe, expect, test, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import AzureInboxPane from "./AzureInboxPane.vue";
import { useAppStore } from "../../stores/app.js";
import { useNotificationStore } from "../../stores/notifications.js";
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
            author: { id: "alice", displayName: "Alice", uniqueName: "alice@example.com" },
            connectionId: "ado-1",
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
            author: { id: "alice", displayName: "Alice", uniqueName: "alice@example.com" },
            connectionId: "ado-1",
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

function mountPane(payload = buildPayload()) {
  const appStore = useAppStore();
  appStore.payload = payload;
  return mount(AzureInboxPane, {
    props: { workspaceId: "ws-azure" },
    global: {
      stubs: {
        // The async PaneShell + PR row + audit log don't matter for the
        // chrome-collapse assertion; stubbing speeds up mount and avoids
        // pulling their dependencies into the test.
        PaneShell: true,
        AzurePrRow: {
          props: ["item"],
          template: '<div class="azure-pr-row-stub">{{ item.author.displayName }}</div>',
        },
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

function buildPr(id: number, author: string, repo = "platform-api") {
  return {
    prKey: `ado:${id}`,
    connectionId: "ado-1",
    project: { name: "MockProject" },
    repository: { name: repo },
    pullRequest: {
      id,
      title: `PR ${id}`,
      isDraft: false,
      sourceRefName: `refs/heads/feat/${id}`,
      targetRefName: "refs/heads/main",
      url: "",
    },
    author: {
      id: author.toLowerCase(),
      displayName: author,
      uniqueName: `${author.toLowerCase()}@example.com`,
    },
    role: "reviewer",
    hasAttention: true,
    attentionReason: "new comment",
    checks: { failedCount: 0, pendingCount: 0, passedCount: 1 },
  };
}

function payloadWithPrs(prs: ReturnType<typeof buildPr>[]) {
  return buildPayload({
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
        recentlyUpdated: prs,
        needsAttention: prs,
        needsMyReview: prs,
        myPullRequests: [],
      },
    },
  });
}

function filterRow(wrapper: ReturnType<typeof mountPane>, label: string) {
  return wrapper
    .findAll(".azure-inbox__filter-row")
    .find((row) => row.find(".azure-inbox__filter-label").text() === label)!;
}

describe("AzureInboxPane author filter", () => {
  beforeEach(() => {
    setMatchMediaResult("(max-width: 768px)", false);
    setMatchMediaResult("(max-width: 768px), (max-height: 500px)", false);
  });

  test("shows author buttons for up to five authors and filters the PR rows", async () => {
    const wrapper = mountPane(payloadWithPrs([buildPr(1, "Alice"), buildPr(2, "Bob"), buildPr(3, "Carol")]));
    await flushPromises();

    const authorRow = filterRow(wrapper, "Author");
    expect(authorRow.find("select").exists()).toBe(false);
    expect(authorRow.findAll("button").map((button) => button.text())).toEqual([
      "All authors",
      "Alice",
      "Bob",
      "Carol",
    ]);

    await authorRow.findAll("button")[2].trigger("click");
    expect(wrapper.findAll(".azure-pr-row-stub").map((row) => row.text())).toEqual(["Bob"]);
  });

  test("uses a select for more than five authors", async () => {
    const prs = ["Alice", "Bob", "Carol", "Dave", "Erin", "Frank"].map((author, index) => buildPr(index + 1, author));
    const wrapper = mountPane(payloadWithPrs(prs));
    await flushPromises();

    const select = wrapper.get('select[aria-label="Filter pull requests by author"]');
    expect(select.findAll("option")).toHaveLength(7);

    await select.setValue("frank");
    expect(wrapper.findAll(".azure-pr-row-stub").map((row) => row.text())).toEqual(["Frank"]);
  });

  test("combines author and repository filters", async () => {
    const wrapper = mountPane(
      payloadWithPrs([buildPr(1, "Alice", "api"), buildPr(2, "Bob", "api"), buildPr(3, "Bob", "web")]),
    );
    await flushPromises();

    await filterRow(wrapper, "Repo")
      .findAll("button")
      .find((button) => button.text() === "MockProject/api")!
      .trigger("click");
    await filterRow(wrapper, "Author")
      .findAll("button")
      .find((button) => button.text() === "Bob")!
      .trigger("click");

    expect(wrapper.findAll(".azure-pr-row-stub").map((row) => row.text())).toEqual(["Bob"]);
  });
});

/**
 * Regression coverage for review-code-quality-2026-07.md finding 1.3: the
 * toolbar Refresh and connection-delete handlers were try/finally with no
 * catch, so a failed call silently reset the busy flag with zero
 * user-visible feedback. Both now go through notifications.runWithToast.
 */
describe("AzureInboxPane — refresh and delete-connection surface failures instead of silently succeeding", () => {
  beforeEach(() => {
    setMatchMediaResult("(max-width: 768px)", false);
    setMatchMediaResult("(max-width: 768px), (max-height: 500px)", false);
  });

  test("handleRefresh: rejection is caught and surfaced as a toast, busy resets", async () => {
    const appStore = useAppStore();
    appStore.payload = buildPayload();
    vi.spyOn(appStore, "refreshAzure").mockRejectedValue(new Error("network down"));
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
    vi.spyOn(appStore, "deleteAzureConnection").mockRejectedValue(new Error("connection in use"));
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
