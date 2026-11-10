import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import JiraHeaderSearch from "./JiraHeaderSearch.vue";
import { useAppStore } from "../../stores/app.js";
import { useNotificationStore } from "../../stores/notifications.js";
import { resetJiraNudgeThrottleForTests } from "../../lib/jira-activity.js";
import { resetJiraMyIssuesForTests } from "../../composables/useJiraMyIssues.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApi = any;

const connection = (id: string, label: string, prefixes: string[] = []) => ({
  id,
  profileId: "default",
  enabled: true,
  label,
  webUrl: `https://${id}.example`,
  issueKeyPrefixes: prefixes,
});
const issue = (connectionId: string, issueId: string, issueKey: string, summary: string, updated: string) => ({
  ref: { provider: "jira", connectionId, issueId, issueKey },
  summary,
  status: "In Progress",
  statusCategory: "indeterminate",
  updated,
});
const jiraInbox = {
  id: "jira-inbox",
  name: "Jira",
  cwd: "",
  panels: [],
  icon: "J",
  color: "#fff",
  profileId: "default",
  kind: "jira",
};

function setup(api: AnyApi, workspaces: AnyApi[] = [jiraInbox]) {
  const store = useAppStore();
  store.payload = {
    appState: {
      workspaces,
      activeWorkspaceId: "",
      activeProfileId: "default",
      profiles: [{ id: "default", name: "Default" }],
      windowSlots: [{ id: "win-test", profileId: "default", activeWorkspaceId: "" }],
    },
  } as AnyApi;
  vi.spyOn(store, "getApi").mockReturnValue(api);
  const activateWorkspace = vi.spyOn(store, "activateWorkspace").mockResolvedValue();
  const activateView = vi.spyOn(store, "activateView").mockResolvedValue();
  const wrapper = mount(JiraHeaderSearch, { attachTo: document.body });
  return { store, wrapper, activateWorkspace, activateView };
}

async function type(wrapper: ReturnType<typeof mount>, value: string, key = "Enter") {
  const input = wrapper.find("input");
  await input.setValue(value);
  await input.trigger("keydown", { key });
  await flushPromises();
}

describe("JiraHeaderSearch", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    (window as AnyApi).strideterm = { startupFlags: { windowId: "win-test" } };
    resetJiraNudgeThrottleForTests();
    resetJiraMyIssuesForTests();
  });
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("stays hidden without an enabled Jira connection in the profile", async () => {
    const { wrapper } = setup({
      listJiraConnections: vi.fn().mockResolvedValue([{ ...connection("c1", "Jira"), enabled: false }]),
    });
    await flushPromises();
    expect(wrapper.find("input").exists()).toBe(false);
  });

  it("focusing the field or coming back to the window asks the runtime to check alert queries, at most every 2 minutes", async () => {
    const nudgeJiraPolling = vi.fn().mockResolvedValue({ nudged: 1 });
    const { wrapper } = setup({
      listJiraConnections: vi.fn().mockResolvedValue([connection("c1", "Work")]),
      nudgeJiraPolling,
    });
    await flushPromises();
    await wrapper.find("input").trigger("focus");
    window.dispatchEvent(new Event("focus"));
    expect(nudgeJiraPolling).toHaveBeenCalledTimes(1);

    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 2 * 60_000);
    window.dispatchEvent(new Event("focus"));
    expect(nudgeJiraPolling).toHaveBeenCalledTimes(2);
    clock.mockRestore();
  });

  it("opens a typed issue key straight in the Jira inbox, asking only the connection that owns the prefix", async () => {
    const getJiraIssue = vi.fn(async ({ connectionId }: { connectionId: string }) =>
      issue(connectionId, "4211", "MSP-4211", "Login timeout", "2026-11-01T00:00:00Z"),
    );
    const { store, wrapper, activateWorkspace } = setup({
      listJiraConnections: vi
        .fn()
        .mockResolvedValue([connection("c1", "Work", ["MSP"]), connection("c2", "Other", ["OPS"])]),
      getJiraIssue,
    });
    await flushPromises();

    await type(wrapper, "msp-4211");

    expect(getJiraIssue).toHaveBeenCalledTimes(1);
    expect(getJiraIssue).toHaveBeenCalledWith({ connectionId: "c1", issueId: "MSP-4211" });
    expect(store.jiraIssueOpenRequest).toMatchObject({
      workspaceId: "jira-inbox",
      ref: { connectionId: "c1", issueId: "4211", issueKey: "MSP-4211" },
    });
    expect(activateWorkspace).toHaveBeenCalledWith("jira-inbox");
  });

  it("searches text across every connection, newest first, and hands the full search to the inbox", async () => {
    const searchJiraIssues = vi.fn(async ({ connectionId, jql }: { connectionId: string; jql: string }) => {
      expect(jql).toBe('text ~ "login" AND text ~ "timeout" ORDER BY updated DESC');
      return connectionId === "c1"
        ? { issues: [issue("c1", "1", "MSP-1", "Older", "2026-10-01T00:00:00Z")], hasMore: true }
        : { issues: [issue("c2", "2", "OPS-2", "Newer", "2026-11-01T00:00:00Z")] };
    });
    const { store, wrapper, activateWorkspace, activateView } = setup({
      listJiraConnections: vi.fn().mockResolvedValue([connection("c1", "Work"), connection("c2", "Other")]),
      searchJiraIssues,
    });
    await flushPromises();

    await type(wrapper, "login timeout");

    const rows = document.body.querySelectorAll(".jira-header-search__result");
    expect([...rows].map((row) => row.querySelector(".jira-header-search__key")?.textContent)).toEqual([
      "OPS-2",
      "MSP-1",
    ]);
    expect(document.body.querySelector(".jira-header-search__more")?.textContent).toContain("more than 2");

    (document.body.querySelector(".jira-header-search__all") as HTMLButtonElement).click();
    await flushPromises();

    expect(store.jiraSearchRequest).toMatchObject({ workspaceId: "jira-inbox", text: "login timeout" });
    expect(activateWorkspace).toHaveBeenCalledWith("jira-inbox");
    expect(activateView).toHaveBeenCalledWith("jira:jira-inbox");
  });

  it("searches a key-like word that names no issue as text", async () => {
    const searchJiraIssues = vi.fn().mockResolvedValue({ issues: [] });
    const { wrapper } = setup({
      listJiraConnections: vi.fn().mockResolvedValue([connection("c1", "Work")]),
      getJiraIssue: vi.fn().mockRejectedValue(new Error("Issue does not exist")),
      searchJiraIssues,
    });
    await flushPromises();

    await type(wrapper, "UTF-8");

    expect(searchJiraIssues).toHaveBeenCalledWith(
      expect.objectContaining({ jql: 'text ~ "UTF" AND text ~ "8" ORDER BY updated DESC' }),
    );
    expect(document.body.querySelector(".jira-header-search__status")?.textContent).toContain("No issues found");
  });

  it("shows a failed search in the panel and as an error toast", async () => {
    const { wrapper } = setup({
      listJiraConnections: vi.fn().mockResolvedValue([connection("c1", "Work")]),
      searchJiraIssues: vi.fn().mockRejectedValue(new Error("Jira sign-in expired")),
    });
    const showError = vi.spyOn(useNotificationStore(), "showError");
    await flushPromises();

    await type(wrapper, "deploy");

    expect(document.body.querySelector(".jira-header-search__status--error")?.textContent).toContain(
      "Jira sign-in expired",
    );
    expect(showError).toHaveBeenCalledWith("Jira search failed", expect.stringContaining("Jira sign-in expired"));
  });

  it("opens the issue in the browser when the profile has no Jira inbox on a phone", async () => {
    const openExternal = vi.fn().mockResolvedValue(undefined);
    const { store, wrapper } = setup(
      {
        listJiraConnections: vi.fn().mockResolvedValue([connection("c1", "Work", ["MSP"])]),
        getJiraIssue: vi.fn().mockResolvedValue(issue("c1", "7", "MSP-7", "Fix", "2026-11-01T00:00:00Z")),
        openExternal,
      },
      [],
    );
    vi.spyOn(store, "isMobileSession").mockReturnValue(true);
    await flushPromises();

    await type(wrapper, "MSP-7");

    expect(openExternal).toHaveBeenCalledWith("https://c1.example/browse/MSP-7");
    expect(store.jiraIssueOpenRequest).toBeNull();
  });

  describe("my issues badges", () => {
    const mine = (issueId: string, key: string, category: string, updated: string) => ({
      ...issue("c1", issueId, key, `Summary ${key}`, updated),
      status: category === "new" ? "To Do" : "In Progress",
      statusCategory: category,
    });
    const answer = (issues: unknown[], extra: Record<string, unknown> = {}) => ({
      connections: [
        {
          connectionId: "c1",
          label: "Work",
          issues,
          hasMore: false,
          cache: { source: "cache", fetchedAt: Date.now() - 60_000, stale: false },
          ...extra,
        },
      ],
    });
    const cached = answer([
      mine("1", "MSP-1", "new", "2026-11-01T00:00:00Z"),
      mine("2", "MSP-2", "new", "2026-11-03T00:00:00Z"),
      mine("3", "MSP-3", "indeterminate", "2026-11-02T00:00:00Z"),
    ]);

    it("paint from the cache without asking Jira, one request for two mounted headers", async () => {
      const getJiraMyIssues = vi.fn().mockResolvedValue(cached);
      const api = { listJiraConnections: vi.fn().mockResolvedValue([connection("c1", "Work")]), getJiraMyIssues };
      const { wrapper } = setup(api);
      const second = mount(JiraHeaderSearch, { attachTo: document.body });
      await flushPromises();

      expect(getJiraMyIssues).toHaveBeenCalledTimes(1);
      expect(getJiraMyIssues).toHaveBeenCalledWith({ refresh: "cache-only" });
      const badges = wrapper.findAll(".jira-header-search__badge");
      expect(badges.map((badge) => [badge.attributes("data-category"), badge.text()])).toEqual([
        ["new", "2"],
        ["indeterminate", "1"],
      ]);
      expect(badges[0].attributes("title")).toContain("updated 1m ago");
      expect(second.findAll(".jira-header-search__badge")).toHaveLength(2);
      second.unmount();
    });

    it("asks Jira once when nothing is cached yet, shows 50+ when there are more, and hides an empty category", async () => {
      const getJiraMyIssues = vi
        .fn()
        .mockResolvedValueOnce(answer([], { cache: null }))
        .mockResolvedValueOnce(
          answer([mine("3", "MSP-3", "indeterminate", "2026-11-02T00:00:00Z")], { hasMore: true }),
        );
      const { wrapper } = setup({
        listJiraConnections: vi.fn().mockResolvedValue([connection("c1", "Work")]),
        getJiraMyIssues,
      });
      await flushPromises();

      expect(getJiraMyIssues.mock.calls.map((call) => call[0])).toEqual([
        { refresh: "cache-only" },
        { refresh: "if-stale" },
      ]);
      const badges = wrapper.findAll(".jira-header-search__badge");
      expect(badges.map((badge) => badge.text())).toEqual(["1+"]);
      expect(badges[0].attributes("data-category")).toBe("indeterminate");
    });

    it("a badge lists that category newest first without waiting, and opens an issue from it", async () => {
      const getJiraMyIssues = vi.fn().mockResolvedValue(cached);
      const { wrapper, store } = setup({
        listJiraConnections: vi.fn().mockResolvedValue([connection("c1", "Work")]),
        getJiraMyIssues,
      });
      await flushPromises();

      await wrapper.findAll(".jira-header-search__badge")[0].trigger("click");
      const panel = document.querySelector(".jira-header-search__panel")!;
      expect(panel.querySelector(".jira-header-search__mine-title")?.textContent).toBe("My To Do");
      expect([...panel.querySelectorAll(".jira-header-search__key")].map((node) => node.textContent)).toEqual([
        "MSP-2",
        "MSP-1",
      ]);
      expect(getJiraMyIssues).toHaveBeenLastCalledWith({ refresh: "if-stale" });

      (panel.querySelectorAll(".jira-header-search__result")[0] as HTMLButtonElement).click();
      await flushPromises();
      expect(store.jiraIssueOpenRequest).toMatchObject({ ref: { issueKey: "MSP-2" } });
    });

    it("Refresh always asks Jira and reports a failure as a toast", async () => {
      const getJiraMyIssues = vi
        .fn()
        .mockResolvedValueOnce(cached)
        .mockResolvedValueOnce(cached)
        .mockRejectedValueOnce(new Error("Jira is down"));
      const showError = vi.spyOn(useNotificationStore(), "showError");
      const { wrapper } = setup({
        listJiraConnections: vi.fn().mockResolvedValue([connection("c1", "Work")]),
        getJiraMyIssues,
      });
      await flushPromises();
      await wrapper.findAll(".jira-header-search__badge")[1].trigger("click");
      await flushPromises();

      (document.querySelector(".jira-header-search__mine-refresh") as HTMLButtonElement).click();
      await flushPromises();
      expect(getJiraMyIssues).toHaveBeenLastCalledWith({ refresh: "force" });
      expect(showError).toHaveBeenCalledWith(
        "Could not refresh your Jira issues",
        expect.stringContaining("Jira is down"),
      );
    });
  });
});
