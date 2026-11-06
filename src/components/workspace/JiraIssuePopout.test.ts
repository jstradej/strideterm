import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { defineComponent, h, provide } from "vue";
import JiraIssuePopoutPane from "./JiraIssuePopoutPane.vue";
import JiraIssueDetail from "./jira/JiraIssueDetail.vue";
import { createJiraPaneContext } from "./jira/pane/createJiraPaneContext.js";
import { jiraPaneContextKey, type JiraPaneContext } from "./jira/pane/jira-pane-context.js";
import { useNotificationStore } from "../../stores/notifications.js";
import { jiraIssuePopoutSchema } from "../../../electron/backend/ipc-schemas.js";

const appStore = vi.hoisted(() => ({ api: null as unknown }));
vi.mock("../../stores/app.js", () => ({
  useAppStore: () => ({
    getApi: () => appStore.api,
    isMobileSession: () => false,
    myActiveProfileId: "default",
    myActiveWorkspaceId: "",
    payload: null,
    jiraBoardChooserRequest: null,
    jiraIssueOpenRequest: null,
    clearJiraBoardChooserRequest: () => {},
    clearJiraIssueOpenRequest: () => {},
  }),
}));

const REF = { provider: "jira" as const, connectionId: "jira-1", issueId: "1001", issueKey: "ENG-1" };
const ISSUE = { ref: REF, summary: "Fix login", status: "In Progress", description: "Login fails", attachments: [] };
const POPOUT_ISSUE = { connectionId: "jira-1", issueId: "1001", issueKey: "ENG-1" };

/**
 * A transport that records every call by method name. A method the test did not define looks absent (undefined), the
 * way it does on a transport that lacks it; a plain value answers as a resolved promise.
 */
function fakeTransport(methods: Record<string, unknown> = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const defaults: Record<string, unknown> = {
    isRemote: false,
    listJiraConnections: [
      { id: "jira-1", label: "Engineering", deployment: "data-center", webUrl: "https://j.example" },
    ],
    getJiraIssue: ISSUE,
    listJiraComments: [],
    listJiraCommentDrafts: [],
    getJiraWriteHistory: [],
    getJiraRepoBindingPreference: null,
    ...methods,
  };
  const api = new Proxy(defaults, {
    get(target, property) {
      const name = String(property);
      if (!(name in target)) return undefined;
      const value = target[name];
      if (name === "isRemote" || typeof value === "function") return value;
      return (...args: unknown[]) => {
        calls.push({ method: name, args });
        return Promise.resolve(value);
      };
    },
  });
  return { api, calls, names: () => calls.map((call) => call.method) };
}

const NEVER_IN_A_POPOUT = [
  "saveJiraWorkspaceView",
  "renameJiraWorkspaceView",
  "removeJiraWorkspaceView",
  "setJiraWorkspaceActiveView",
  "refreshJiraWorkspaceViews",
  "setJiraWorkspaceProjectScope",
  "getJiraWorkspaceViews",
  "getJiraWorkspaceProjectScope",
  "rememberJiraSearch",
  "rememberJiraIssueViewed",
  "saveJiraQuery",
  "deleteJiraQuery",
  "searchJiraIssues",
  "buildJiraOwnIssuesQuery",
  "getJiraBoardView",
  "listJiraBoards",
  "listJiraProjects",
  "getJiraRecentSearches",
  "getJiraRecentIssues",
];

function mountPopout() {
  return mount(JiraIssuePopoutPane, { props: { profileId: "default", workspaceId: "ws-1", issue: POPOUT_ISSUE } });
}

describe("Jira issue pop-out", () => {
  enableAutoUnmount(afterEach);
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
  });

  describe("detached context", () => {
    test("loads the connections and the one issue and touches nothing else: no search, no board, no save", async () => {
      // Every method the pane could reach is defined, so a call would be recorded instead of looking absent.
      const { api, calls, names } = fakeTransport(Object.fromEntries(NEVER_IN_A_POPOUT.map((name) => [name, []])));
      appStore.api = api;
      const wrapper = mountPopout();
      await flushPromises();

      expect(wrapper.get("h2").text()).toBe("Fix login");
      expect(names()).toContain("listJiraConnections");
      expect(calls.find((call) => call.method === "getJiraIssue")?.args[0]).toMatchObject({
        connectionId: "jira-1",
        issueId: "1001",
      });
      for (const forbidden of NEVER_IN_A_POPOUT) expect(names(), forbidden).not.toContain(forbidden);
      expect(localStorage.length).toBe(0);
    });

    test("a persistence method looks absent to the context even when the transport has it", () => {
      const save = vi.fn();
      appStore.api = fakeTransport({ saveJiraWorkspaceView: save, rememberJiraIssueViewed: save }).api;
      let ctx!: JiraPaneContext;
      mount(
        defineComponent({
          setup() {
            ctx = createJiraPaneContext({
              workspaceId: "ws-1",
              jiraViewId: "issues",
              showHeader: false,
              connectionsOnly: false,
              detached: true,
            });
            return () => h("div");
          },
        }),
      );
      expect(ctx.dynamicApi.saveJiraWorkspaceView).toBeUndefined();
      expect(ctx.dynamicApi.rememberJiraIssueViewed).toBeUndefined();
      expect(ctx.dynamicApi.getJiraIssue).toBeTypeOf("function");
      expect(save).not.toHaveBeenCalled();
    });

    test("shows no Back, Close or Pop out control", async () => {
      appStore.api = fakeTransport({ openJiraIssuePopout: vi.fn() }).api;
      const wrapper = mountPopout();
      await flushPromises();
      expect(wrapper.find(".jira-detail__back").exists()).toBe(false);
      expect(wrapper.find(".jira-detail__close").exists()).toBe(false);
      expect(wrapper.find(".jira-detail__popout").exists()).toBe(false);
    });

    test("an issue that cannot be opened is shown in the window and as a toast", async () => {
      appStore.api = fakeTransport({ getJiraIssue: vi.fn().mockRejectedValue(new Error("Issue does not exist")) }).api;
      const toast = vi.spyOn(useNotificationStore(), "pushEphemeralToast");
      const wrapper = mountPopout();
      await flushPromises();
      expect(wrapper.get("[role=alert]").text()).toContain("Issue does not exist");
      expect(toast).toHaveBeenCalledWith(expect.objectContaining({ kind: "error", title: "Could not open ENG-1" }));
    });
  });

  describe("pop out button", () => {
    function mountDetail(api: unknown) {
      appStore.api = api;
      let ctx!: JiraPaneContext;
      const wrapper = mount(
        defineComponent({
          setup() {
            ctx = createJiraPaneContext({
              workspaceId: "ws-1",
              jiraViewId: "issues",
              showHeader: false,
              connectionsOnly: false,
            });
            provide(jiraPaneContextKey, ctx);
            return () => h("div", { class: "jira-inbox" }, [h(JiraIssueDetail)]);
          },
        }),
      );
      ctx.selected.value = ISSUE as never;
      return { wrapper, ctx };
    }

    test("is absent when the transport cannot open windows (remote)", async () => {
      const { wrapper } = mountDetail(fakeTransport({ isRemote: true }).api);
      await flushPromises();
      expect(wrapper.find(".jira-detail__popout").exists()).toBe(false);
    });

    test("opens the issue's window with the workspace and a plain ref, then closes the detail in the pane", async () => {
      const open = vi.fn().mockResolvedValue({ focused: false });
      const { wrapper, ctx } = mountDetail(fakeTransport({ openJiraIssuePopout: open }).api);
      await flushPromises();
      const button = wrapper.get(".jira-detail__popout");
      expect(button.attributes("title")).toMatch(/own window/);
      await button.trigger("click");
      await flushPromises();
      expect(open).toHaveBeenCalledTimes(1);
      const payload = open.mock.calls[0]![0];
      expect(payload).toEqual({ workspaceId: "ws-1", ref: POPOUT_ISSUE, summary: "Fix login" });
      expect(jiraIssuePopoutSchema.safeParse(payload).success).toBe(true);
      expect(ctx.selected.value).toBeNull();
    });

    test("a window that cannot open keeps the issue where it is and tells the user", async () => {
      const open = vi.fn().mockRejectedValue(new Error("no window"));
      const { wrapper, ctx } = mountDetail(fakeTransport({ openJiraIssuePopout: open }).api);
      const toast = vi.spyOn(useNotificationStore(), "showError");
      await flushPromises();
      await wrapper.get(".jira-detail__popout").trigger("click");
      await flushPromises();
      expect(toast).toHaveBeenCalledWith(
        "Could not open ENG-1 in its own window",
        expect.any(Error),
        expect.objectContaining({ workspaceId: "ws-1" }),
      );
      expect(ctx.selected.value).not.toBeNull();
    });
  });
});
