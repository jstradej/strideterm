/**
 * Component-level tests for InboxPane — the provider-parametrized merge of
 * the former AzureInboxPane.vue / GitHubInboxPane.vue (review §3.1 point 6).
 *
 * These run under jsdom (no dev server, no playwright) — they prove the
 * Vue conditional rendering for the popover triggers tracks `isMobile`
 * correctly, regardless of which dev server the e2e suite happens to
 * pick up. The matchMedia polyfill in test/vitest-setup.ts is overridden
 * per test via `setMatchMediaResult` so we can flip into desktop or
 * mobile mode without touching the viewport.
 */
import { afterEach, describe, expect, test, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import InboxPane from "./InboxPane.vue";
import AzurePipelinesTab from "./azure/AzurePipelinesTab.vue";
import { useAppStore } from "../../stores/app.js";
import { useNotificationStore } from "../../stores/notifications.js";
import type { StatePayload } from "../../../electron/shared/types/state.js";

declare const setMatchMediaResult: (query: string, matches: boolean) => void;

type TestPrItem = {
  prKey: string;
  connectionId?: string;
  pullRequest: { id: number };
  repository: { name?: string };
  author: { id?: string; displayName: string; uniqueName?: string };
};
type MutableInboxFixture = {
  appState: { workspaces: Array<{ id: string; name: string; kind: string; panels: unknown[] }> };
  azureDevops?: { inbox: { recentlyUpdated: TestPrItem[]; needsAttention: TestPrItem[] } };
  github?: { inbox: { recentlyUpdated: TestPrItem[]; needsAttention: TestPrItem[] } };
};

function buildAzurePayload(overrides: Record<string, unknown> = {}): StatePayload {
  return {
    appState: {
      activeWorkspaceId: "ws-azure",
      activeProfileId: "default",
      workspaces: [{ id: "ws-azure", name: "Azure Inbox", kind: "azure", panels: [] }],
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

function buildGitHubPayload(): StatePayload {
  return {
    appState: {
      activeWorkspaceId: "ws-github",
      activeProfileId: "default",
      workspaces: [{ id: "ws-github", name: "GitHub Inbox", kind: "github", panels: [] }],
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

function mountAzurePane(payload = buildAzurePayload()) {
  const appStore = useAppStore();
  appStore.payload = payload;
  return mount(InboxPane, {
    props: { workspaceId: "ws-azure", provider: "azure" },
    global: {
      stubs: {
        // The async PaneShell + PR row + audit log don't matter for the
        // chrome-collapse assertion; stubbing speeds up mount and avoids
        // pulling their dependencies into the test.
        PaneShell: true,
        PrRow: {
          props: ["item"],
          template: '<div class="azure-pr-row-stub">{{ item.author.displayName }}</div>',
        },
        AuditLog: true,
        AzurePipelinesTab: true,
      },
    },
  });
}

function mountGitHubPane() {
  const appStore = useAppStore();
  appStore.payload = buildGitHubPayload();
  return mount(InboxPane, {
    props: { workspaceId: "ws-github", provider: "github" },
    global: {
      stubs: {
        PaneShell: true,
        PrRow: true,
        AuditLog: true,
        AzurePipelinesTab: true,
      },
    },
  });
}

beforeEach(() => {
  setActivePinia(createPinia());
  // The inbox remembers its filters per workspace; every test starts unfiltered.
  window.localStorage.clear();
});

describe("InboxPane (azure) responsive chrome", () => {
  test("on desktop viewport the inline tabs + actions are visible, no popover triggers", async () => {
    setMatchMediaResult("(max-width: 768px)", false);
    setMatchMediaResult("(max-width: 768px), (max-height: 500px)", false);
    const wrapper = mountAzurePane();
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
    const wrapper = mountAzurePane();
    await flushPromises();

    expect(wrapper.find(".azure-inbox__tabs-trigger").exists()).toBe(true);
    expect(wrapper.find(".azure-inbox__menu-trigger").exists()).toBe(true);
  });

  test("clicking the tabs trigger opens the tabs popover (toggles --tabs-menu-open class)", async () => {
    setMatchMediaResult("(max-width: 768px)", true);
    setMatchMediaResult("(max-width: 768px), (max-height: 500px)", true);
    const wrapper = mountAzurePane();
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
    const wrapper = mountAzurePane();
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
    const wrapper = mountAzurePane();
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
    const wrapper = mountAzurePane();
    await flushPromises();

    // Default tab is "Needs attention" (most-actionable-first) — azure only.
    const triggerLabel = wrapper.find(".azure-inbox__tabs-trigger__label").text();
    expect(triggerLabel).toBe("Needs attention");
  });
});

function buildPr(id: number, author: string, repo = "platform-api", extra: Record<string, unknown> = {}) {
  const { pullRequest: pullRequestExtra, ...rest } = extra;
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
      ...(pullRequestExtra as object),
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
    ...rest,
  };
}

function payloadWithPrs(prs: ReturnType<typeof buildPr>[]) {
  return buildAzurePayload({
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

function group(wrapper: ReturnType<typeof mountAzurePane>, label: string) {
  return wrapper.get(`[aria-label="${label}"]`);
}

function chipNames(el: ReturnType<typeof group>) {
  return el
    .findAll("button")
    .map((button) => (button.find("span").exists() ? button.get("span").text() : button.text()));
}

function rowAuthors(wrapper: ReturnType<typeof mountAzurePane>) {
  return wrapper.findAll(".azure-pr-row-stub").map((row) => row.text());
}

async function openTab(wrapper: ReturnType<typeof mountAzurePane>, name: string) {
  await wrapper
    .findAll(".azure-tab")
    .find((b) => b.text().startsWith(name))!
    .trigger("click");
  await flushPromises();
}

describe("InboxPane (azure) filters", () => {
  beforeEach(() => {
    setMatchMediaResult("(max-width: 768px)", false);
    setMatchMediaResult("(max-width: 768px), (max-height: 500px)", false);
  });

  test("author chips carry counts and filter the PR rows", async () => {
    const wrapper = mountAzurePane(payloadWithPrs([buildPr(1, "Alice"), buildPr(2, "Bob"), buildPr(3, "Carol")]));
    await flushPromises();

    const authors = group(wrapper, "Author");
    expect(authors.find("select").exists()).toBe(false);
    expect(chipNames(authors)).toEqual(["All authors", "Alice", "Bob", "Carol"]);
    expect(
      authors
        .get(".azure-inbox__author-chips")
        .findAll(".azure-inbox__pill")
        .map((p) => p.text()),
    ).toEqual(["1", "1", "1"]);

    await authors.findAll("button")[2].trigger("click");
    expect(rowAuthors(wrapper)).toEqual(["Bob"]);
    expect(authors.findAll("button")[2].attributes("aria-pressed")).toBe("true");
  });

  test("the current user comes first as You, then by PR count, then by name", async () => {
    const wrapper = mountAzurePane(
      payloadWithPrs([
        buildPr(1, "Zed", "platform-api", { role: "author" }),
        buildPr(2, "Alice"),
        buildPr(3, "Bob"),
        buildPr(4, "Bob"),
      ]),
    );
    await flushPromises();
    expect(chipNames(group(wrapper, "Author"))).toEqual(["All authors", "You", "Bob", "Alice"]);
  });

  test("a shared Azure project becomes the row prefix and chips show the repo name; mixed projects show project/repo", async () => {
    const same = mountAzurePane(payloadWithPrs([buildPr(1, "Alice", "api"), buildPr(2, "Bob", "web")]));
    await flushPromises();
    expect(group(same, "Repository").get(".azure-inbox__filter-label").text()).toBe("MockProject /");
    expect(chipNames(group(same, "Repository"))).toEqual(["All repos", "api", "web"]);
    same.unmount();

    const mixed = mountAzurePane(
      payloadWithPrs([buildPr(1, "Alice", "api"), buildPr(2, "Bob", "web", { project: { name: "Other" } })]),
    );
    await flushPromises();
    expect(chipNames(group(mixed, "Repository"))).toEqual(["All repos", "MockProject/api", "Other/web"]);
  });

  test("combines author and repository filters", async () => {
    const wrapper = mountAzurePane(
      payloadWithPrs([buildPr(1, "Alice", "api"), buildPr(2, "Bob", "api"), buildPr(3, "Bob", "web")]),
    );
    await flushPromises();

    await group(wrapper, "Repository")
      .findAll("button")
      .find((button) => button.text() === "api")!
      .trigger("click");
    await group(wrapper, "Author")
      .findAll("button")
      .find((button) => button.text().startsWith("Bob"))!
      .trigger("click");

    expect(rowAuthors(wrapper)).toEqual(["Bob"]);
  });

  test("several repositories and several authors can be picked at once; All clears the pick", async () => {
    const wrapper = mountAzurePane(
      payloadWithPrs([
        buildPr(1, "Alice", "api"),
        buildPr(2, "Bob", "web"),
        buildPr(3, "Carol", "ops"),
        buildPr(4, "Dave", "api"),
      ]),
    );
    await flushPromises();
    const chip = (groupName: string, label: string) =>
      group(wrapper, groupName)
        .findAll("button")
        .find((button) => button.text().startsWith(label))!;

    await chip("Repository", "api").trigger("click");
    await chip("Repository", "web").trigger("click");
    expect(rowAuthors(wrapper)).toEqual(["Alice", "Bob", "Dave"]);
    expect(chip("Repository", "api").attributes("aria-pressed")).toBe("true");
    expect(chip("Repository", "web").attributes("aria-pressed")).toBe("true");
    expect(chip("Repository", "All repos").attributes("aria-pressed")).toBe("false");

    await chip("Author", "Alice").trigger("click");
    await chip("Author", "Bob").trigger("click");
    expect(rowAuthors(wrapper)).toEqual(["Alice", "Bob"]);

    // A second click takes one value back out.
    await chip("Repository", "web").trigger("click");
    expect(rowAuthors(wrapper)).toEqual(["Alice"]);

    await chip("Repository", "All repos").trigger("click");
    await chip("Author", "All authors").trigger("click");
    expect(rowAuthors(wrapper)).toEqual(["Alice", "Bob", "Carol", "Dave"]);
  });

  test("the filters are remembered for the next start of the same inbox", async () => {
    const prs = [
      buildPr(1, "Alice", "api"),
      buildPr(2, "Bob", "web"),
      buildPr(3, "Carol", "api", { pullRequest: { isDraft: true } }),
    ];
    const first = mountAzurePane(payloadWithPrs(prs));
    await flushPromises();
    await group(first, "Repository")
      .findAll("button")
      .find((button) => button.text() === "api")!
      .trigger("click");
    await first.get("select.azure-inbox__select").setValue("created");
    await first.get('input[type="checkbox"]').setValue(true);
    first.unmount();

    const second = mountAzurePane(payloadWithPrs(prs));
    await flushPromises();
    expect(rowAuthors(second)).toEqual(["Alice"]);
    expect(
      group(second, "Repository")
        .findAll("button")
        .find((button) => button.text() === "api")!
        .attributes("aria-pressed"),
    ).toBe("true");
    expect((second.get("select.azure-inbox__select").element as HTMLSelectElement).value).toBe("created");
    expect((second.get('input[type="checkbox"]').element as HTMLInputElement).checked).toBe(true);
  });

  test("a remembered pick with no PR right now stays visible, so it never hides the list silently", async () => {
    window.localStorage.setItem(
      "strideterm-inbox-filters-v1:ws-azure",
      JSON.stringify({ repos: ["MockProject/gone"], authors: ["Zoe"], authorNames: { Zoe: "Zoe Former" } }),
    );
    const wrapper = mountAzurePane(payloadWithPrs([buildPr(1, "Alice", "api"), buildPr(2, "Bob", "web")]));
    await flushPromises();

    const gone = group(wrapper, "Repository")
      .findAll("button")
      .find((button) => button.text() === "gone")!;
    expect(gone.attributes("aria-pressed")).toBe("true");
    const zoe = group(wrapper, "Author")
      .findAll("button")
      .find((button) => button.text().startsWith("Zoe Former"))!;
    expect(zoe.attributes("aria-pressed")).toBe("true");
    expect(wrapper.text()).toContain("No pull requests match the selected filters.");

    await gone.trigger("click");
    await zoe.trigger("click");
    expect(rowAuthors(wrapper)).toEqual(["Alice", "Bob"]);
  });

  test("each inbox keeps its own filters", async () => {
    const prs = [buildPr(1, "Alice", "api"), buildPr(2, "Bob", "web")];
    const azure = mountAzurePane(payloadWithPrs(prs));
    await flushPromises();
    await group(azure, "Repository")
      .findAll("button")
      .find((button) => button.text() === "api")!
      .trigger("click");
    azure.unmount();

    expect(JSON.parse(window.localStorage.getItem("strideterm-inbox-filters-v1:ws-azure") || "{}").repos).toEqual([
      "MockProject/api",
    ]);
    expect(window.localStorage.getItem("strideterm-inbox-filters-v1:ws-azure-secondary")).toBeNull();
  });

  describe("author chips fit the available width", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });

    test("chips that do not fit move into a +N more select that filters and takes the active style", async () => {
      vi.stubGlobal(
        "ResizeObserver",
        class {
          observe() {}
          disconnect() {}
        },
      );
      vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(700);
      vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(100);

      const prs = ["Alice", "Bob", "Carol", "Dave", "Erin", "Frank"].map((n, i) => buildPr(i + 1, n));
      const wrapper = mountAzurePane(payloadWithPrs(prs));
      await flushPromises();

      const authors = group(wrapper, "Author");
      expect(chipNames(authors.get(".azure-inbox__author-chips") as never)).toEqual([
        "All authors",
        "Alice",
        "Bob",
        "Carol",
      ]);
      const select = wrapper.get('select[aria-label="More authors"]');
      expect(select.findAll("option").map((o) => o.text())).toEqual(["+3 more", "Dave (1)", "Erin (1)", "Frank (1)"]);
      // The visible chip is sized to its own label, not to the longest option.
      expect(wrapper.get(".azure-inbox__more-label").text()).toBe("+3 more");

      await select.setValue("frank");
      expect(rowAuthors(wrapper)).toEqual(["Frank"]);
      const chip = wrapper.get(".azure-inbox__more");
      expect(chip.attributes("data-active")).toBe("true");
      expect(chip.get(".azure-inbox__more-label").text()).toBe("Frank");
      expect(chip.get(".azure-inbox__pill").text()).toBe("1");
      // The list is back on "+3 more" and marks who is picked.
      expect((select.element as HTMLSelectElement).value).toBe("");
      expect(select.findAll("option").map((o) => o.text())).toContain("✓ Frank (1)");

      await select.setValue("dave");
      expect(rowAuthors(wrapper)).toEqual(["Dave", "Frank"]);
      expect(chip.get(".azure-inbox__more-label").text()).toBe("+2 authors");

      // Picking a picked author again takes them out.
      await select.setValue("frank");
      expect(rowAuthors(wrapper)).toEqual(["Dave"]);
    });
  });

  test("with no layout information every author chip is shown and there is no select", async () => {
    const prs = ["Alice", "Bob", "Carol", "Dave", "Erin", "Frank"].map((n, i) => buildPr(i + 1, n));
    const wrapper = mountAzurePane(payloadWithPrs(prs));
    await flushPromises();
    expect(chipNames(group(wrapper, "Author"))).toHaveLength(7);
    expect(wrapper.find('select[aria-label="More authors"]').exists()).toBe(false);
  });

  test("Hide drafts drops draft PRs", async () => {
    const wrapper = mountAzurePane(
      payloadWithPrs([buildPr(1, "Alice"), buildPr(2, "Bob", "platform-api", { pullRequest: { isDraft: true } })]),
    );
    await flushPromises();
    expect(rowAuthors(wrapper)).toEqual(["Alice", "Bob"].sort((a, b) => a.localeCompare(b)));

    await wrapper.get('input[type="checkbox"]').setValue(true);
    expect(rowAuthors(wrapper)).toEqual(["Alice"]);
  });

  test("Sort orders rows inside a group by activity, attention or creation date", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-05T00:00:00.000Z"));
    try {
      const wrapper = mountAzurePane(
        payloadWithPrs([
          buildPr(1, "Ann", "platform-api", {
            hasAttention: false,
            lastActivityAt: "2026-01-01T00:00:00.000Z",
            pullRequest: { creationDate: "2026-01-04T00:00:00.000Z" },
          }),
          buildPr(2, "Bob", "platform-api", {
            hasAttention: false,
            lastActivityAt: "2026-01-03T00:00:00.000Z",
            pullRequest: { creationDate: "2026-01-01T00:00:00.000Z" },
          }),
          buildPr(3, "Cid", "platform-api", {
            hasAttention: true,
            lastActivityAt: "2026-01-02T00:00:00.000Z",
            pullRequest: { creationDate: "2026-01-02T00:00:00.000Z" },
          }),
        ]),
      );
      await flushPromises();
      await openTab(wrapper, "All");

      expect(rowAuthors(wrapper)).toEqual(["Bob", "Cid", "Ann"]);
      const sort = wrapper.get("select.azure-inbox__select");
      await sort.setValue("attention");
      expect(rowAuthors(wrapper)).toEqual(["Cid", "Bob", "Ann"]);
      await sort.setValue("created");
      expect(rowAuthors(wrapper)).toEqual(["Ann", "Cid", "Bob"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("InboxPane (azure) groups", () => {
  beforeEach(() => {
    setMatchMediaResult("(max-width: 768px)", false);
    setMatchMediaResult("(max-width: 768px), (max-height: 500px)", false);
  });

  test("a repo group header shows project, repo, count, unread and attention, and collapses its rows", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-05T00:00:00.000Z"));
    const wrapper = mountAzurePane(
      payloadWithPrs([
        buildPr(1, "Alice", "api", { lastRemoteActivityAt: "2026-01-02T00:00:00.000Z" }),
        buildPr(2, "Bob", "api", {
          hasAttention: false,
          lastSeenActivityAt: "2026-01-02T00:00:00.000Z",
          lastRemoteActivityAt: "2026-01-02T00:00:00.000Z",
        }),
      ]),
    );
    await flushPromises();
    await openTab(wrapper, "All");

    const header = wrapper.get(".azure-repo-group__heading button");
    expect(wrapper.get(".azure-repo-group__heading").element.tagName).toBe("H2");
    expect(header.get(".azure-repo-group__project").text()).toBe("MockProject /");
    expect(header.get(".azure-repo-group__name").text()).toBe("api");
    expect(header.get(".azure-repo-group__count").text()).toBe("2");
    expect(header.get(".azure-repo-group__stats").text()).toContain("1 unread");
    expect(header.get(".azure-repo-group__attention").text()).toBe("1 needs attention");
    expect(header.attributes("aria-expanded")).toBe("true");
    expect(rowAuthors(wrapper)).toHaveLength(2);

    await header.trigger("click");
    expect(header.attributes("aria-expanded")).toBe("false");
    expect(rowAuthors(wrapper)).toHaveLength(0);
    await header.trigger("click");
    expect(rowAuthors(wrapper)).toHaveLength(2);
    vi.useRealTimers();
  });

  test("PRs idle for more than 30 days are folded behind a toggle row", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-01T00:00:00.000Z"));
    try {
      const wrapper = mountAzurePane(
        payloadWithPrs([
          buildPr(1, "Ann", "api", { lastActivityAt: "2026-02-25T00:00:00.000Z" }),
          buildPr(2, "Bob", "api", { lastActivityAt: "2026-01-01T00:00:00.000Z" }),
          buildPr(3, "Cid", "api", { lastActivityAt: "2025-12-01T00:00:00.000Z" }),
        ]),
      );
      await flushPromises();
      await openTab(wrapper, "All");

      expect(rowAuthors(wrapper)).toEqual(["Ann"]);
      const toggle = wrapper.get(".azure-repo-group__older");
      expect(toggle.text()).toContain("2 older than 30 days");
      expect(toggle.text()).toContain("last activity 59 d – 90 d ago");
      expect(toggle.attributes("aria-expanded")).toBe("false");

      await toggle.trigger("click");
      expect(rowAuthors(wrapper)).toEqual(["Ann", "Bob", "Cid"]);
      expect(wrapper.get(".azure-repo-group__older").text()).toContain("Hide 2 older pull requests");
    } finally {
      vi.useRealTimers();
    }
  });

  test("reason codes bucket the Needs attention tab; a payload without them keeps the role buckets", async () => {
    const reason = (code: string, label: string) => ({
      attentionReason: label,
      attentionReasons: [{ code, label, ackOnSeen: true }],
    });
    const wrapper = mountAzurePane(
      payloadWithPrs([
        buildPr(1, "Ann", "api", reason("group-review-requested", "Review requested via Core Team")),
        buildPr(2, "Bob", "api", reason("conflicts", "Merge conflicts")),
        buildPr(3, "Cid", "api", reason("replies", "2 replies to you")),
        buildPr(4, "Dan", "api", reason("something-new", "Something")),
      ]),
    );
    await flushPromises();
    expect(wrapper.findAll(".azure-repo-group__name").map((n) => n.text())).toEqual([
      "Waiting for your review",
      "Your pull requests",
      "Replies to you",
      "Other activity",
    ]);
  });
});

describe("InboxPane (azure) connections tab", () => {
  beforeEach(() => {
    setMatchMediaResult("(max-width: 768px)", false);
    setMatchMediaResult("(max-width: 768px), (max-height: 500px)", false);
  });

  test("shows the reviewer-group recognition status, muted for ok and in the danger colour for an error", async () => {
    const payload = buildAzurePayload();
    const conn = payload.azureDevops!.connections as unknown as Array<Record<string, unknown>>;
    conn[0].groupMembership = { status: "ok", count: 3 };
    const wrapper = mountAzurePane(payload);
    await flushPromises();
    await openTab(wrapper, "Connections");
    expect(wrapper.text()).toContain("Reviewer groups: 3 recognised");
    wrapper.unmount();

    conn[0].groupMembership = { status: "error", error: "403 Forbidden" };
    const failed = mountAzurePane(payload);
    await flushPromises();
    await openTab(failed, "Connections");
    const line = failed.findAll("div").find((d) => d.text() === "Reviewer groups not recognised: 403 Forbidden")!;
    expect(line.attributes("style")).toContain("var(--danger-fg)");
  });
});

/**
 * Regression coverage for review-code-quality-2026-07.md finding 1.3: the
 * toolbar Refresh and connection-delete handlers were try/finally with no
 * catch, so a failed call silently reset the busy flag with zero
 * user-visible feedback. Both now go through notifications.runWithToast.
 */
describe("InboxPane (azure) — refresh and delete-connection surface failures instead of silently succeeding", () => {
  beforeEach(() => {
    setMatchMediaResult("(max-width: 768px)", false);
    setMatchMediaResult("(max-width: 768px), (max-height: 500px)", false);
  });

  test("handleRefresh: rejection is caught and surfaced as a toast, busy resets", async () => {
    const appStore = useAppStore();
    appStore.payload = buildAzurePayload();
    vi.spyOn(appStore, "refreshAzure").mockRejectedValue(new Error("network down"));
    const wrapper = mountAzurePane();
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
    appStore.payload = buildAzurePayload();
    vi.spyOn(appStore, "deleteAzureConnection").mockRejectedValue(new Error("connection in use"));
    const wrapper = mountAzurePane();
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

describe("InboxPane (azure) Pipelines tab", () => {
  beforeEach(() => {
    setMatchMediaResult("(max-width: 768px)", false);
    setMatchMediaResult("(max-width: 768px), (max-height: 500px)", false);
  });

  test("selecting the Pipelines tab renders AzurePipelinesTab with this profile's connections (azure only)", async () => {
    const wrapper = mountAzurePane();
    await flushPromises();

    const pipelinesTabBtn = wrapper.findAll(".azure-tab").find((b) => b.text().startsWith("Pipelines"));
    expect(pipelinesTabBtn).toBeTruthy();
    // Each tab's content is gated on activeTab === tab.id, so the pane isn't
    // mounted until the tab is actually selected.
    expect(wrapper.findComponent(AzurePipelinesTab).exists()).toBe(false);

    await pipelinesTabBtn!.trigger("click");
    await flushPromises();

    const pipelinesTab = wrapper.findComponent(AzurePipelinesTab);
    expect(pipelinesTab.exists()).toBe(true);
    const pipelinesTabProps = pipelinesTab.props() as { workspaceId: string; connections: Array<{ id: string }> };
    expect(pipelinesTabProps.workspaceId).toBe("ws-azure");
    expect(pipelinesTabProps.connections.map((c) => c.id)).toEqual(["ado-1"]);
  });
});

describe("InboxPane (azure) needs-attention sub-bucketing", () => {
  beforeEach(() => {
    setMatchMediaResult("(max-width: 768px)", false);
    setMatchMediaResult("(max-width: 768px), (max-height: 500px)", false);
  });

  test("PRs needing attention for different reasons render as separate labeled buckets", async () => {
    const reviewerPr = buildPr(1, "Alice"); // role: "reviewer" -> "You were asked to review"
    const authorPr = { ...buildPr(2, "Bob"), role: "author" }; // -> "Your PRs need a look"
    const wrapper = mountAzurePane(payloadWithPrs([reviewerPr, authorPr]));
    await flushPromises();

    // Default tab is "Needs attention" (azure only) — no tab switch needed.
    const groups = wrapper.findAll(".azure-repo-group");
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.find(".azure-repo-group__name").text())).toEqual([
      "You were asked to review",
      "Your PRs need a look",
    ]);
    expect(groups.map((g) => g.find(".azure-repo-group__count").text())).toEqual(["1", "1"]);
    expect(groups[0].find(".azure-pr-row-stub").text()).toBe("Alice");
    expect(groups[1].find(".azure-pr-row-stub").text()).toBe("Bob");
  });
});

/**
 * Mark as read is an icon button on every row of every PR tab (it replaced
 * the Needs-attention-only "Seen" text button). These tests mount the real
 * PrRow so the button is actually observable.
 */
describe("InboxPane (azure) mark as read", () => {
  beforeEach(() => {
    setMatchMediaResult("(max-width: 768px)", false);
    setMatchMediaResult("(max-width: 768px), (max-height: 500px)", false);
  });

  function mountAzurePaneWithRealPrRow(payload: StatePayload) {
    const appStore = useAppStore();
    appStore.payload = payload as unknown as StatePayload;
    return mount(InboxPane, {
      props: { workspaceId: "ws-azure", provider: "azure" },
      global: { stubs: { PaneShell: true, AuditLog: true, AzurePipelinesTab: true } },
    });
  }

  test("is offered on every PR tab", async () => {
    const wrapper = mountAzurePaneWithRealPrRow(payloadWithPrs([buildPr(1, "Alice")]));
    await flushPromises();

    for (const tab of ["Needs attention", "All", "Needs review"]) {
      await openTab(wrapper as never, tab);
      expect(wrapper.find('button[aria-label="Mark #1 as read"]').exists()).toBe(true);
    }
  });

  test("clicking it marks the PR seen via the store, and once the backend drops it the attention bucket empties", async () => {
    const wrapper = mountAzurePaneWithRealPrRow(payloadWithPrs([buildPr(1, "Alice")]));
    const appStore = useAppStore();
    vi.spyOn(appStore, "markAzurePrSeen").mockImplementation(async () => {
      // Simulate the real flow: the API round-trip completes and the next
      // broadcast state no longer lists this PR as needing attention.
      appStore.payload = payloadWithPrs([]);
    });
    await flushPromises();

    expect(wrapper.text()).toContain("Alice");
    await wrapper.get('button[aria-label="Mark #1 as read"]').trigger("click");
    await flushPromises();

    expect(appStore.markAzurePrSeen).toHaveBeenCalledWith("ado:1");
    expect(wrapper.findAll(".azure-repo-group")).toHaveLength(0);
    expect(wrapper.text()).not.toContain("Alice");
  });

  test("a review request gets no chip under 'Waiting for your review', but keeps it in a repository group", async () => {
    const pr = buildPr(1, "Alice", "platform-api", {
      attentionReason: "Your review",
      attentionReasons: [{ code: "review-requested", label: "Your review", ackOnSeen: false }],
    });
    const wrapper = mountAzurePaneWithRealPrRow(payloadWithPrs([pr]));
    await flushPromises();

    await openTab(wrapper as never, "Needs attention");
    expect(wrapper.text()).toContain("Waiting for your review");
    expect(wrapper.find(".azure-pr-row__chip--attention").exists()).toBe(false);
    // The bucket mixes repositories, so the row names its own.
    expect(wrapper.get(".azure-pr-row__repo").text()).toBe("platform-api");

    await openTab(wrapper as never, "All");
    expect(wrapper.get(".azure-pr-row__chip--attention").text()).toBe("Your review");
    expect(wrapper.find(".azure-pr-row__repo").exists()).toBe(false);
  });
});

describe("InboxPane (github) PR list", () => {
  beforeEach(() => {
    setMatchMediaResult("(max-width: 768px)", false);
    setMatchMediaResult("(max-width: 768px), (max-height: 500px)", false);
  });

  function mountRealGitHub() {
    const payload = buildGitHubPayload() as unknown as MutableInboxFixture & {
      github: { inbox: { recentlyUpdated: Array<Record<string, unknown>> } };
    };
    const first = payload.github.inbox.recentlyUpdated[0];
    first.connectionId = "gh-1";
    payload.github.inbox.recentlyUpdated.push({
      ...first,
      prKey: "github:43",
      repository: { fullName: "other-org/tools" },
      pullRequest: { id: 43, number: 43, title: "A draft", draft: true },
    });
    const appStore = useAppStore();
    appStore.payload = payload as unknown as StatePayload;
    return mount(InboxPane, {
      props: { workspaceId: "ws-github", provider: "github" },
      global: { stubs: { PaneShell: true, AuditLog: true, AzurePipelinesTab: true } },
    });
  }

  test("renders owner/repo groups and chips with the shared filter bar, but no author filter", async () => {
    const wrapper = mountRealGitHub();
    await flushPromises();

    expect(wrapper.findAll(".azure-repo-group__project").map((t) => t.text())).toEqual(["mock-org /", "other-org /"]);
    expect(wrapper.findAll(".azure-repo-group__name").map((t) => t.text())).toEqual(["strideterm", "tools"]);
    expect(wrapper.text()).toContain("Sample GitHub PR");
    const chips = wrapper.get('[aria-label="Repository"]');
    expect(chips.findAll("button").map((b) => b.text())).toEqual([
      "All repos",
      "mock-org/strideterm",
      "other-org/tools",
    ]);
    expect(wrapper.find('[aria-label="Author"]').exists()).toBe(false);

    await chips.findAll("button")[2].trigger("click");
    expect(wrapper.findAll(".azure-pr-row")).toHaveLength(1);
  });

  test("Hide drafts honours the GitHub draft flag, and mark as read calls the GitHub store action", async () => {
    const wrapper = mountRealGitHub();
    const appStore = useAppStore();
    vi.spyOn(appStore, "markGitHubPrSeen").mockResolvedValue(undefined as never);
    await flushPromises();
    expect(wrapper.findAll(".azure-pr-row")).toHaveLength(2);

    await wrapper.get('input[type="checkbox"]').setValue(true);
    expect(wrapper.findAll(".azure-pr-row")).toHaveLength(1);

    await wrapper.get('button[aria-label="Mark #42 as read"]').trigger("click");
    expect(appStore.markGitHubPrSeen).toHaveBeenCalledWith("github:42");
  });
});

describe("InboxPane notification focus", () => {
  beforeEach(() => {
    setMatchMediaResult("(max-width: 768px)", false);
    setMatchMediaResult("(max-width: 768px), (max-height: 500px)", false);
  });

  test.each([
    { provider: "azure" as const, workspaceId: "ws-azure", connectionId: "ado-1", prKey: "ado:1" },
    { provider: "github" as const, workspaceId: "ws-github", connectionId: "gh-1", prKey: "github:42" },
  ])("opens and highlights the exact $provider pull request in All", async (target) => {
    const appStore = useAppStore();
    const payload = (target.provider === "azure"
      ? buildAzurePayload()
      : buildGitHubPayload()) as unknown as MutableInboxFixture;
    const inbox = target.provider === "azure" ? payload.azureDevops!.inbox : payload.github!.inbox;
    const pr = inbox.recentlyUpdated[0];
    pr.connectionId = target.connectionId;
    if (target.provider === "azure") inbox.needsAttention = [];
    appStore.payload = payload as unknown as StatePayload;
    appStore.requestInboxPullRequestFocus({
      provider: target.provider === "github" ? "github" : "azure-devops",
      connectionId: target.connectionId,
      prKey: target.prKey,
      profileId: "default",
      workspaceId: target.workspaceId,
    });

    const wrapper = mount(InboxPane, {
      props: { workspaceId: target.workspaceId, provider: target.provider },
      global: { stubs: { PaneShell: true, AuditLog: true, AzurePipelinesTab: true } },
    });
    await flushPromises();

    expect(
      wrapper
        .findAll(".azure-tab")
        .find((tab) => tab.text().startsWith("All"))
        ?.classes(),
    ).toContain("azure-tab--active");
    const row = wrapper.get(`[data-pr-key="${target.prKey}"][data-connection-id="${target.connectionId}"]`);
    expect(row.classes()).toContain("azure-pr-row--focused");
    expect(row.classes()).toContain("azure-pr-row--expanded");
    expect(appStore.inboxPullRequestFocus).toBeNull();
    wrapper.unmount();
  });

  test("only the requested same-provider inbox consumes the focus request", async () => {
    const appStore = useAppStore();
    const payload = buildAzurePayload() as unknown as MutableInboxFixture;
    payload.appState.workspaces.push({ id: "ws-azure-secondary", name: "Second Inbox", kind: "azure", panels: [] });
    appStore.payload = payload as unknown as StatePayload;
    appStore.requestInboxPullRequestFocus({
      provider: "azure-devops",
      connectionId: "ado-1",
      prKey: "ado:1",
      profileId: "default",
      workspaceId: "ws-azure-secondary",
    });

    const first = mount(InboxPane, {
      props: { workspaceId: "ws-azure", provider: "azure" },
      global: { stubs: { PaneShell: true, AuditLog: true, AzurePipelinesTab: true } },
    });
    const second = mount(InboxPane, {
      props: { workspaceId: "ws-azure-secondary", provider: "azure" },
      global: { stubs: { PaneShell: true, AuditLog: true, AzurePipelinesTab: true } },
    });
    await flushPromises();

    expect(appStore.inboxPullRequestFocus).toBeNull();
    expect(first.find(".azure-pr-row--focused").exists()).toBe(false);
    expect(second.find(".azure-pr-row--focused").exists()).toBe(true);
    first.unmount();
    second.unmount();
  });

  test("clears conflicting repo and author filters, then scrolls to the requested Azure PR", async () => {
    const appStore = useAppStore();
    const payload = buildAzurePayload() as unknown as MutableInboxFixture;
    const inbox = payload.azureDevops!.inbox;
    const target = inbox.recentlyUpdated[0];
    const other = structuredClone(target);
    other.prKey = "ado:2";
    other.pullRequest.id = 2;
    other.author = { id: "bob", displayName: "Bob", uniqueName: "bob@example.com" };
    const third = structuredClone(other);
    third.prKey = "ado:3";
    third.pullRequest.id = 3;
    third.repository.name = "other-repo";
    inbox.recentlyUpdated = [target, other, third];
    inbox.needsAttention = [target, other, third];
    appStore.payload = payload as unknown as StatePayload;
    const scrollIntoView = vi.fn();
    const originalDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView });

    try {
      const wrapper = mount(InboxPane, {
        props: { workspaceId: "ws-azure", provider: "azure" },
        global: { stubs: { PaneShell: true, AuditLog: true, AzurePipelinesTab: true } },
      });
      await flushPromises();
      await wrapper
        .get('[aria-label="Repository"]')
        .findAll("button")
        .find((button) => button.text().includes("platform-api"))!
        .trigger("click");
      await wrapper
        .get('[aria-label="Author"]')
        .findAll("button")
        .find((button) => button.text().startsWith("Bob"))!
        .trigger("click");

      appStore.requestInboxPullRequestFocus({
        provider: "azure-devops",
        connectionId: "ado-1",
        prKey: "ado:1",
        profileId: "default",
        workspaceId: "ws-azure",
      });
      await flushPromises();

      const row = wrapper.get('[data-pr-key="ado:1"][data-connection-id="ado-1"]');
      expect(row.classes()).toContain("azure-pr-row--focused");
      expect(row.classes()).toContain("azure-pr-row--expanded");
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "center", behavior: "smooth" });
      expect(
        wrapper
          .get('[aria-label="Repository"]')
          .findAll("button")
          .find((button) => button.text() === "All repos")
          ?.attributes("aria-pressed"),
      ).toBe("true");
      wrapper.unmount();
    } finally {
      if (originalDescriptor) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalDescriptor);
      else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
    }
  });

  test("keeps the remembered filters when they already show the requested PR", async () => {
    const appStore = useAppStore();
    const payload = buildAzurePayload() as unknown as MutableInboxFixture;
    const inbox = payload.azureDevops!.inbox;
    const target = inbox.recentlyUpdated[0];
    const other = structuredClone(target);
    other.prKey = "ado:2";
    other.pullRequest.id = 2;
    other.repository.name = "other-repo";
    inbox.recentlyUpdated = [target, other];
    inbox.needsAttention = [target, other];
    appStore.payload = payload as unknown as StatePayload;
    window.localStorage.setItem(
      "strideterm-inbox-filters-v1:ws-azure",
      JSON.stringify({ repos: [`MockProject/${target.repository.name}`] }),
    );
    appStore.requestInboxPullRequestFocus({
      provider: "azure-devops",
      connectionId: "ado-1",
      prKey: "ado:1",
      profileId: "default",
      workspaceId: "ws-azure",
    });

    const wrapper = mount(InboxPane, {
      props: { workspaceId: "ws-azure", provider: "azure" },
      global: { stubs: { PaneShell: true, AuditLog: true, AzurePipelinesTab: true } },
    });
    await flushPromises();

    expect(wrapper.get('[data-pr-key="ado:1"]').classes()).toContain("azure-pr-row--focused");
    expect(wrapper.find('[data-pr-key="ado:2"]').exists()).toBe(false);
    expect(JSON.parse(window.localStorage.getItem("strideterm-inbox-filters-v1:ws-azure") || "{}").repos).toHaveLength(
      1,
    );
    wrapper.unmount();
  });
});

describe("InboxPane (github) responsive chrome", () => {
  test("on desktop the inline chrome renders without popover triggers", async () => {
    setMatchMediaResult("(max-width: 768px)", false);
    setMatchMediaResult("(max-width: 768px), (max-height: 500px)", false);
    const wrapper = mountGitHubPane();
    await flushPromises();

    expect(wrapper.find(".azure-inbox__tabs-trigger").exists()).toBe(false);
    expect(wrapper.find(".azure-inbox__menu-trigger").exists()).toBe(false);
    expect(wrapper.find(".azure-inbox__tabs").exists()).toBe(true);
  });

  test("on mobile the popover triggers render", async () => {
    setMatchMediaResult("(max-width: 768px)", true);
    setMatchMediaResult("(max-width: 768px), (max-height: 500px)", true);
    const wrapper = mountGitHubPane();
    await flushPromises();

    expect(wrapper.find(".azure-inbox__tabs-trigger").exists()).toBe(true);
    expect(wrapper.find(".azure-inbox__menu-trigger").exists()).toBe(true);
  });

  test("toggling the actions trigger flips the --menu-open class", async () => {
    setMatchMediaResult("(max-width: 768px)", true);
    setMatchMediaResult("(max-width: 768px), (max-height: 500px)", true);
    const wrapper = mountGitHubPane();
    await flushPromises();

    await wrapper.find(".azure-inbox__menu-trigger").trigger("click");
    expect(wrapper.find(".azure-inbox--menu-open").exists()).toBe(true);
    await wrapper.find(".azure-inbox__menu-backdrop").trigger("click");
    expect(wrapper.find(".azure-inbox--menu-open").exists()).toBe(false);
  });

  test("toggling the tabs trigger flips the --tabs-menu-open class", async () => {
    setMatchMediaResult("(max-width: 768px)", true);
    setMatchMediaResult("(max-width: 768px), (max-height: 500px)", true);
    const wrapper = mountGitHubPane();
    await flushPromises();

    await wrapper.find(".azure-inbox__tabs-trigger").trigger("click");
    expect(wrapper.find(".azure-inbox--tabs-menu-open").exists()).toBe(true);
    await wrapper.find(".azure-inbox__menu-backdrop").trigger("click");
    expect(wrapper.find(".azure-inbox--tabs-menu-open").exists()).toBe(false);
  });

  test("has no Pipelines tab and defaults to the All tab (no attention sub-bucketing)", async () => {
    setMatchMediaResult("(max-width: 768px)", false);
    setMatchMediaResult("(max-width: 768px), (max-height: 500px)", false);
    const wrapper = mountGitHubPane();
    await flushPromises();

    const tabLabels = wrapper.findAll(".azure-tab").map((b) => b.text());
    expect(tabLabels.some((label) => label.startsWith("Pipelines"))).toBe(false);
    expect(tabLabels.some((label) => label.startsWith("All"))).toBe(true);
  });
});

/**
 * Regression coverage for review-code-quality-2026-07.md finding 1.3: the
 * toolbar Refresh and connection-delete handlers were try/finally with no
 * catch, so a failed call silently reset the busy flag with zero
 * user-visible feedback. Both now go through notifications.runWithToast.
 */
describe("InboxPane (github) — refresh and delete-connection surface failures instead of silently succeeding", () => {
  beforeEach(() => {
    setMatchMediaResult("(max-width: 768px)", false);
    setMatchMediaResult("(max-width: 768px), (max-height: 500px)", false);
  });

  test("handleRefresh: rejection is caught and surfaced as a toast, busy resets", async () => {
    const appStore = useAppStore();
    appStore.payload = buildGitHubPayload();
    vi.spyOn(appStore, "refreshGitHub").mockRejectedValue(new Error("network down"));
    const wrapper = mountGitHubPane();
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
    appStore.payload = buildGitHubPayload();
    vi.spyOn(appStore, "deleteGitHubConnection").mockRejectedValue(new Error("connection in use"));
    const wrapper = mountGitHubPane();
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
