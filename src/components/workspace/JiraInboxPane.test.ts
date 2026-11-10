import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { defineComponent, h, reactive } from "vue";
import { createRemoteTransport } from "../../transport.js";
import type { JiraWorkspaceViewsState } from "../../../electron/shared/types/jira-workspace-views.js";
import CustomSelect from "../common/CustomSelect.vue";
import { useNotificationStore } from "../../stores/notifications.js";
import {
  readJiraViewPreferences,
  writeJiraViewPreferences,
  writeLastJiraSearch,
} from "./jira/jira-view-preferences.js";
import {
  jiraConnectionMetadataSchema,
  jiraConnectionSaveSchema,
  jiraConnectionTestSchema,
  jiraOwnIdentitySchema,
  jiraOwnIssuesQuerySchema,
  jiraQuerySaveSchema,
  jiraWorkspaceIssueLinkSchema,
  jiraWorkspaceProjectScopeSetSchema,
  jiraWriteExecuteSchema,
  jiraWritePreviewSchema,
} from "../../../electron/backend/ipc-schemas.js";

const mockStoreState = vi.hoisted(() => ({
  payload: null as unknown,
  transportApi: null as unknown,
  isMobileSession: false,
  jiraBoardChooserRequest: null as { workspaceId: string; sequence: number } | null,
  jiraIssueOpenRequest: null as {
    workspaceId: string;
    ref: { connectionId: string; issueId: string; issueKey: string };
    sequence: number;
  } | null,
  jiraSearchRequest: null as { workspaceId: string; text: string; sequence: number } | null,
}));
import JiraInboxPane from "./JiraInboxPane.vue";
import JiraStartDevelopmentDialog from "./jira/JiraStartDevelopmentDialog.vue";
import { startJiraDevelopmentSchema } from "../../../electron/shared/jira-development.js";

/** Board choosing lives in the Board view only; the helper switches there first, like a user would. */
async function showBoardView(wrapper: ReturnType<typeof mount>) {
  if (wrapper.find(".jira-board-controls").exists()) return;
  await wrapper
    .findAll(".jira-view-tab")
    .find((tab) => tab.text() === "Board")
    ?.trigger("click");
  await flushPromises();
}

const COMMENT_BOX = 'textarea[placeholder="Write a comment… (Ctrl+Enter to send)"]';

/** Writes a comment in the composer and sends it with the form's own submit. */
async function sendComment(wrapper: ReturnType<typeof mount>, text: string) {
  await wrapper.get(COMMENT_BOX).setValue(text);
  await wrapper.get(".jira-comment-composer").trigger("submit");
  await flushPromises();
}

/** Opens the status menu of the open issue and picks the transition that leads to `target`. */
async function pickStatus(wrapper: ReturnType<typeof mount>, target: string) {
  await wrapper.get(".jira-status-menu > summary").trigger("click");
  await flushPromises();
  const item = wrapper
    .findAll(".jira-status-menu [role=menuitem]")
    .find((candidate) => candidate.text().includes(target));
  if (!item) throw new Error(`The status menu has no transition to ${target}.`);
  await item.trigger("click");
  await flushPromises();
}

/** Switches the Jira inbox to its Settings view, where the open panel belongs to the selected connection. */
async function openSettingsView(wrapper: ReturnType<typeof mount>) {
  await wrapper
    .findAll(".jira-view-tab")
    .find((tab) => tab.text() === "Settings")!
    .trigger("click");
  await flushPromises();
}

/** Opens the selected connection's Edit form on its Connection tab: address and credentials. */
async function openConnectionTab(wrapper: ReturnType<typeof mount>) {
  await wrapper
    .findAll(".jira-settings-manager__actions button")
    .find((button) => button.text() === "Edit")!
    .trigger("click");
  await flushPromises();
  await wrapper
    .findAll(".jira-connection-edit-card__tab")
    .find((tab) => tab.text() === "Connection")!
    .trigger("click");
  await flushPromises();
}

/** Picks an item of the Views menu by its label, the way a click on the open menu does. */
async function chooseView(wrapper: ReturnType<typeof mount>, label: string | RegExp) {
  const item = wrapper
    .findAll(".jira-views-menu__panel [role=menuitem]")
    .find((candidate) => (typeof label === "string" ? candidate.text().includes(label) : label.test(candidate.text())));
  if (!item) throw new Error(`The Views menu has no item ${String(label)}.`);
  await item.trigger("click");
  await flushPromises();
}

/** Opens Advanced JQL from the toolbar menu. */
async function openAdvancedJql(wrapper: ReturnType<typeof mount>) {
  const item = wrapper
    .findAll(".jira-toolbar-more [role=menuitem]")
    .find((candidate) => candidate.text().includes("Advanced JQL"));
  if (!item) throw new Error("The toolbar menu has no Advanced JQL item.");
  await item.trigger("click");
  await flushPromises();
}

/** Picks an item of the toolbar's ⋯ menu. */
async function openToolbarMenuItem(wrapper: ReturnType<typeof mount>, label: string) {
  const item = wrapper
    .findAll(".jira-toolbar-more [role=menuitem]")
    .find((candidate) => candidate.text().includes(label));
  if (!item) throw new Error(`The toolbar menu has no item ${label}.`);
  await item.trigger("click");
  await flushPromises();
}

/** The pane now opens with a default search; queue its answer first so a test's own queued answers keep their order. */
function answerFirstOpenSearch(result: unknown = []) {
  transport.searchJiraIssues.mockResolvedValueOnce(result);
}

/** Runs one JQL from the Advanced JQL panel. */
async function runJql(wrapper: ReturnType<typeof mount>) {
  await wrapper.find("form.jira-search").trigger("submit");
  await flushPromises();
}

/** The Start development dialog is teleported to the body; the pane's component tree still holds it. */
function branchPanel(wrapper: ReturnType<typeof mount>) {
  return wrapper.findComponent(JiraStartDevelopmentDialog);
}

async function chooseCustomSelect(
  wrapper: ReturnType<typeof mount>,
  selector: string,
  value: string | number,
  index = 0,
) {
  if (selector === ".jira-board-controls") await showBoardView(wrapper);
  if (selector === ".jira-board-controls" && index === 0) {
    const chooser = wrapper.find(".jira-board-controls > label");
    if (chooser.exists()) {
      await chooser.find(".custom-select__button").trigger("click");
      await flushPromises();
      if (typeof value === "number" && value > 0) {
        const api = mockStoreState.transportApi as {
          searchJiraBoards?: { mock?: { results?: Array<{ value: unknown }> } };
        } | null;
        const request =
          api?.searchJiraBoards?.mock?.results?.at(-1)?.value ?? transport.listJiraBoards.mock.results.at(-1)?.value;
        if (request && typeof (request as Promise<unknown>).then === "function") await request;
        await flushPromises();
      }
    }
  }
  if ((selector === ".jira-board-controls" && index > 0) || selector === ".jira-board-options") {
    const options = wrapper.find(".jira-board-options");
    if (options.exists() && !(options.element as HTMLDetailsElement).open) {
      await options.find("summary").trigger("click");
    }
  }
  const selectRoot =
    selector === ".jira-board-controls" && index > 0
      ? wrapper.find(".jira-board-options")
      : selector === ".jira-branch-start"
        ? branchPanel(wrapper)
        : wrapper.find(selector);
  const selectIndex = selector === ".jira-board-controls" && index > 0 ? index - 1 : index;
  const select = selectRoot.findAllComponents(CustomSelect)[selectIndex];
  if (!select) throw new Error(`Custom select ${selector} at index ${index} was not found.`);
  await select.vm.$emit("update:modelValue", value);
  await select.vm.$emit("change", value);
  await flushPromises();
}

/** Indicators appear only after `useDelayedFlag`'s delay, so a fast cache hit never flashes one. */
async function pastDelayedIndicators() {
  await vi.advanceTimersByTimeAsync(250);
  await flushPromises();
}

/** What a button sends is held to the real zod schema of its IPC channel, not only to the test's own expectation. */
function expectEveryCallToMatch(
  schema: { safeParse(value: unknown): { success: boolean; error?: unknown } },
  mock: { mock: { calls: unknown[][] } },
) {
  expect(mock.mock.calls.length).toBeGreaterThan(0);
  for (const [payload] of mock.mock.calls) {
    const result = schema.safeParse(payload);
    expect(result.success, JSON.stringify(result.error ?? payload)).toBe(true);
  }
}

/** The shape a failed Jira call has on desktop (preload `invokeJira`) and on the remote transport. */
function desktopJiraFailure(message: string, code: string, retryAfterMs?: number) {
  return Object.assign(new Error(message), {
    code,
    jiraError: { code, ...(retryAfterMs ? { retryAfterMs } : {}) },
  });
}

function customSelectProps(select: { props(): unknown }) {
  return select.props() as {
    options: Array<{ value: unknown; label: string }>;
    searchable: boolean;
    hasMore: boolean;
  };
}

const transport = vi.hoisted(() => ({
  listJiraConnections: vi.fn(),
  getJiraWorkspaceProjectScope: vi.fn(),
  setJiraWorkspaceProjectScope: vi.fn(),
  getJiraRecentSearches: vi.fn(),
  getJiraWorkspaceViews: vi.fn(),
  getJiraWriteHistory: vi.fn(),
  deleteWorkspace: vi.fn(),
  saveJiraWorkspaceView: vi.fn(),
  removeJiraWorkspaceView: vi.fn(),
  setJiraWorkspaceActiveView: vi.fn(),
  refreshJiraWorkspaceViews: vi.fn(),
  rememberJiraSearch: vi.fn(),
  getJiraRecentIssues: vi.fn(),
  rememberJiraIssueViewed: vi.fn(),
  getJiraRepoBindingPreference: vi.fn(),
  searchJiraIssues: vi.fn(),
  buildJiraOwnIssuesQuery: vi.fn(),
  getJiraIssue: vi.fn(),
  saveJiraIssueAttachment: vi.fn(),
  uploadJiraIssueAttachment: vi.fn(),
  saveJiraConnection: vi.fn(),
  testJiraConnection: vi.fn(),
  listJiraBoards: vi.fn(),
  listJiraProjects: vi.fn(),
  getJiraBoardView: vi.fn(),
  listJiraBoardQuickFilters: vi.fn(),
  searchJiraUsers: vi.fn(),
  previewJiraWrite: vi.fn(),
  executeJiraWrite: vi.fn(),
  reconcileJiraWrite: vi.fn(),
  deleteJiraConnection: vi.fn(),
  verifyJiraConnection: vi.fn(),
  updateJiraConnectionMetadata: vi.fn(),
  listJiraQueries: vi.fn(),
  listJiraFavoriteFilters: vi.fn(),
  getJiraSavedFilter: vi.fn(),
  saveJiraQuery: vi.fn(),
  deleteJiraQuery: vi.fn(),
  openExternal: vi.fn(),
  browseFile: vi.fn(),
  confirmInApp: vi.fn(),
  listJiraComments: vi.fn(),
  listJiraCommentDrafts: vi.fn(),
  deleteJiraCommentDraft: vi.fn(),
  verifyJiraOwnIdentity: vi.fn(),
  setJiraOwnIdentity: vi.fn(),
  listJiraTransitions: vi.fn(),
  attachJiraIssueToWorkspace: vi.fn(),
  detachJiraIssueFromWorkspace: vi.fn(),
  azureQuickFixListProjects: vi.fn(),
  azureQuickFixListRepositories: vi.fn(),
  azureQuickFixListBranches: vi.fn(),
  azureQuickFixCreate: vi.fn(),
  githubQuickFixCreate: vi.fn(),
  startJiraDevelopment: vi.fn(),
  onOperationFinished: vi.fn(),
  openAzureConnectionDialog: vi.fn(),
  openGitHubConnectionDialog: vi.fn(),
  githubQuickFixListRepos: vi.fn(),
  githubQuickFixListBranches: vi.fn(),
  saveWorkspace: vi.fn(),
  adoptPayload: vi.fn(),
  activateWorkspace: vi.fn(),
  activateView: vi.fn(),
}));

vi.mock("../../stores/app.js", () => ({
  useAppStore: () => ({
    getApi: () => (mockStoreState.transportApi || transport) as typeof transport,
    isMobileSession: () => mockStoreState.isMobileSession,
    get myActiveProfileId() {
      return (
        (mockStoreState.payload as { appState?: { activeProfileId?: string } } | null)?.appState?.activeProfileId ||
        "default"
      );
    },
    get myActiveWorkspaceId() {
      return (
        (mockStoreState.payload as { appState?: { activeWorkspaceId?: string } } | null)?.appState?.activeWorkspaceId ||
        ""
      );
    },
    payload: mockStoreState.payload,
    get jiraBoardChooserRequest() {
      return mockStoreState.jiraBoardChooserRequest;
    },
    clearJiraBoardChooserRequest(sequence: number) {
      if (mockStoreState.jiraBoardChooserRequest?.sequence === sequence) mockStoreState.jiraBoardChooserRequest = null;
    },
    get jiraIssueOpenRequest() {
      return mockStoreState.jiraIssueOpenRequest;
    },
    clearJiraIssueOpenRequest(sequence: number) {
      if (mockStoreState.jiraIssueOpenRequest?.sequence === sequence) mockStoreState.jiraIssueOpenRequest = null;
    },
    get jiraSearchRequest() {
      return mockStoreState.jiraSearchRequest;
    },
    clearJiraSearchRequest(sequence: number) {
      if (mockStoreState.jiraSearchRequest?.sequence === sequence) mockStoreState.jiraSearchRequest = null;
    },
    adoptPayload: transport.adoptPayload,
    openAzureConnectionDialog: transport.openAzureConnectionDialog,
    openGitHubConnectionDialog: transport.openGitHubConnectionDialog,
    activateWorkspace: transport.activateWorkspace,
    activateView: transport.activateView,
    saveWorkspace: transport.saveWorkspace,
    confirmInApp: transport.confirmInApp,
  }),
}));

describe("JiraInboxPane", () => {
  // Every test shares one transport mock: a pane left mounted keeps its timers (rate-limit retry, polling) and
  // can consume the next test's queued answers.
  enableAutoUnmount(afterEach);
  afterEach(() => {
    vi.useRealTimers();
  });
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    localStorage.clear();
    transport.confirmInApp.mockResolvedValue(true);
    mockStoreState.transportApi = new Proxy(transport, {
      get(target, property, receiver) {
        if (
          [
            "getJiraWorkspaceViews",
            "saveJiraWorkspaceView",
            "removeJiraWorkspaceView",
            "setJiraWorkspaceActiveView",
            "refreshJiraWorkspaceViews",
          ].includes(String(property))
        )
          return undefined;
        return Reflect.get(target, property, receiver);
      },
    });
    mockStoreState.isMobileSession = false;
    mockStoreState.jiraBoardChooserRequest = null;
    mockStoreState.jiraIssueOpenRequest = null;
    mockStoreState.jiraSearchRequest = null;
    mockStoreState.payload = reactive({
      appState: {
        activeProfileId: "default",
        activeWorkspaceId: "ws-1",
        workspaces: [{ id: "ws-1", name: "Payments", profileId: "default", workItems: [] }],
        settings: {
          integrations: {
            azureDevops: { connections: [{ id: "az-1", label: "Azure", profileId: "default" }] },
            github: { connections: [{ id: "gh-1", label: "GitHub", profileId: "default" }] },
          },
        },
      },
    });
    transport.listJiraConnections.mockResolvedValue([
      {
        id: "jira-1",
        label: "Engineering",
        deployment: "data-center",
        webUrl: "https://jira.example.com",
        apiBaseUrl: "https://jira.example.com/jira",
        accountPurpose: "technical",
        verifiedIdentity: { displayName: "Build Bot" },
        ownIdentity: { kind: "data-center", name: "alice", displayName: "Alice" },
      },
    ]);
    transport.getJiraWorkspaceProjectScope.mockResolvedValue(null);
    transport.setJiraWorkspaceProjectScope.mockImplementation(
      async ({ projectKeys }: { projectKeys: string[] | null }) => projectKeys,
    );
    transport.getJiraRecentSearches.mockResolvedValue([]);
    transport.getJiraWorkspaceViews.mockResolvedValue({
      workspaceId: "jira:ws",
      profileId: "default",
      views: [{ viewId: "issues", kind: "issues", title: "Issues" }],
      activeViewId: "issues",
      syncByViewId: {},
    });
    transport.saveJiraWorkspaceView.mockReset();
    transport.setJiraWorkspaceActiveView.mockReset();
    transport.refreshJiraWorkspaceViews.mockReset();
    transport.getJiraRecentIssues.mockResolvedValue([]);
    transport.getJiraWriteHistory.mockResolvedValue([]);
    transport.deleteWorkspace.mockResolvedValue(undefined);
    transport.rememberJiraSearch.mockResolvedValue(undefined);
    transport.rememberJiraIssueViewed.mockResolvedValue(undefined);
    transport.searchJiraIssues.mockResolvedValue([
      { ref: { provider: "jira", connectionId: "jira-1", issueId: "1001", issueKey: "ENG-1" }, summary: "Fix login" },
    ]);
    transport.buildJiraOwnIssuesQuery.mockResolvedValue({
      jql: 'assignee = "alice" ORDER BY updated DESC',
      identityLabel: "Alice",
    });
    transport.getJiraIssue.mockResolvedValue({
      ref: { provider: "jira", connectionId: "jira-1", issueId: "1001", issueKey: "ENG-1" },
      summary: "Fix login",
      status: "In Progress",
      description: "Login fails on refresh",
      attachments: [],
    });
    transport.saveJiraIssueAttachment.mockResolvedValue({ saved: true, filePath: "C:/Downloads/log.txt" });
    transport.uploadJiraIssueAttachment.mockResolvedValue({
      ok: true,
      data: { status: "succeeded", journalId: "upload-1" },
    });
    transport.saveJiraConnection.mockResolvedValue({ ok: true });
    transport.testJiraConnection.mockResolvedValue({ ok: true, identity: { displayName: "Gateway User" } });
    transport.listJiraBoards.mockResolvedValue([{ id: 42, name: "Engineering board", type: "kanban" }]);
    transport.listJiraProjects.mockResolvedValue([
      { id: "1", key: "ENG", name: "Engineering" },
      { id: "2", key: "OPS", name: "Operations" },
    ]);
    transport.saveWorkspace.mockResolvedValue(undefined);
    transport.getJiraBoardView.mockResolvedValue({
      boardId: 42,
      mode: "backlog",
      columns: [
        { name: "To Do", statuses: [{ id: "1", name: "Open" }] },
        { name: "Doing", statuses: [{ id: "2", name: "In Progress" }] },
      ],
      issues: [
        {
          ref: { provider: "jira", connectionId: "jira-1", issueId: "1001", issueKey: "ENG-1" },
          summary: "Fix login",
          status: "Open",
        },
      ],
    });
    transport.listJiraBoardQuickFilters.mockResolvedValue({ filters: [], hasMore: false });
    transport.searchJiraUsers.mockResolvedValue([]);
    transport.previewJiraWrite.mockResolvedValue({
      token: "confirm-1",
      intent: "Share reviewed findings",
      preview: "[Posted by a connected Jira account]\nReviewed this change.",
    });
    transport.executeJiraWrite.mockResolvedValue({ ok: true, data: { status: "succeeded", journalId: "write-1" } });
    transport.verifyJiraConnection.mockResolvedValue({
      ok: true,
      identity: { displayName: "Build Bot" },
      serverTitle: "Jira",
      health: { state: "verified", checkedAt: "now" },
    });
    transport.updateJiraConnectionMetadata.mockResolvedValue({ ok: true });
    transport.listJiraQueries.mockResolvedValue([
      {
        id: "query-1",
        connectionId: "jira-1",
        name: "My issues",
        jql: "assignee = currentUser()",
        notificationsEnabled: false,
      },
    ]);
    transport.listJiraFavoriteFilters.mockResolvedValue([{ id: "20", name: "Assigned to me" }]);
    transport.getJiraSavedFilter.mockResolvedValue({
      id: "20",
      name: "Assigned to me",
      jql: "assignee = currentUser() ORDER BY updated DESC",
    });
    transport.getJiraSavedFilter.mockResolvedValue({
      id: "99",
      name: "Private filter",
      jql: "project = APP AND assignee = currentUser()",
    });
    transport.saveJiraQuery.mockResolvedValue({ id: "query-2" });
    transport.listJiraComments.mockResolvedValue([
      { id: "comment-1", author: "Alice (Example s.r.o.)", created: "today", body: "Reviewed" },
    ]);
    transport.listJiraCommentDrafts.mockResolvedValue([]);
    transport.deleteJiraCommentDraft.mockResolvedValue({ deleted: true });
    transport.verifyJiraOwnIdentity.mockResolvedValue({ ok: true });
    transport.setJiraOwnIdentity.mockResolvedValue({ ok: true });
    transport.attachJiraIssueToWorkspace.mockResolvedValue({ ok: true });
    transport.detachJiraIssueFromWorkspace.mockResolvedValue({ ok: true });
    transport.listJiraTransitions.mockResolvedValue([
      {
        id: "31",
        name: "Start progress",
        to: "In Progress",
        requiredFields: [
          { id: "resolution", name: "Resolution note", type: "string", required: true, supported: true },
        ],
      },
    ]);
    transport.azureQuickFixListProjects.mockResolvedValue({ projects: [{ id: "project-1", name: "Engineering" }] });
    transport.azureQuickFixListRepositories.mockResolvedValue({
      repositories: [
        { id: "repo-1", name: "web", remoteUrl: "https://dev.azure.com/org/project/_git/web", defaultBranch: "main" },
      ],
    });
    transport.azureQuickFixListBranches.mockResolvedValue({ branches: ["main", "develop"] });
    transport.azureQuickFixCreate.mockResolvedValue({
      appState: { workspaces: [{ id: "ws-1" }, { id: "ws-new", name: "feature/ENG-1-fix-login" }] },
    });
    transport.githubQuickFixCreate.mockResolvedValue({
      appState: { workspaces: [{ id: "ws-1" }, { id: "ws-gh-new", name: "feature/ENG-1-fix-login" }] },
    });
    transport.startJiraDevelopment.mockResolvedValue({ started: true, operationId: "op-dev-1", replayed: false });
  });

  test("stores the root Issues project scope per workspace and applies it to Jira search", async () => {
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" }, attachTo: document.body });
    await flushPromises();
    expect(transport.listJiraProjects).not.toHaveBeenCalled();
    await wrapper.get(".jira-primary-project-scope > summary").trigger("click");
    await flushPromises();
    await wrapper.get(".jira-project-scope-picker__search input").setValue("OPS");
    await wrapper.get('.jira-project-scope-picker__project input[type="checkbox"]').setValue(true);
    await wrapper.get(".jira-project-scope-picker__apply").trigger("click");
    await flushPromises();
    await wrapper.get("form.jira-search").trigger("submit");
    await flushPromises();

    expect(transport.setJiraWorkspaceProjectScope).toHaveBeenCalledWith({
      workspaceId: "jira:ws",
      connectionId: "jira-1",
      projectKeys: ["OPS"],
    });
    expect(wrapper.get(".jira-primary-project-scope").text()).toContain("OPS");
    expectEveryCallToMatch(jiraWorkspaceProjectScopeSetSchema, transport.setJiraWorkspaceProjectScope);
    expect(transport.searchJiraIssues).toHaveBeenLastCalledWith(
      expect.objectContaining({
        connectionId: "jira-1",
        projectKeys: ["OPS"],
      }),
    );

    await wrapper.get(".jira-primary-project-scope > summary").trigger("click");
    await wrapper
      .findAll(".jira-project-scope-picker__modes button")
      .find((button) => button.text() === "All projects")!
      .trigger("click");
    await wrapper.get(".jira-project-scope-picker__apply").trigger("click");
    await flushPromises();
    expect(transport.setJiraWorkspaceProjectScope).toHaveBeenLastCalledWith({
      workspaceId: "jira:ws",
      connectionId: "jira-1",
      projectKeys: [],
    });

    await wrapper.get(".jira-primary-project-scope > summary").trigger("click");
    await wrapper
      .findAll(".jira-project-scope-picker__modes button")
      .find((button) => button.text() === "Use defaults")!
      .trigger("click");
    await wrapper.get(".jira-project-scope-picker__apply").trigger("click");
    await flushPromises();
    expect(transport.setJiraWorkspaceProjectScope).toHaveBeenLastCalledWith({
      workspaceId: "jira:ws",
      connectionId: "jira-1",
      projectKeys: null,
    });
    expect(transport.searchJiraIssues).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ projectKeys: expect.anything() }),
    );

    await wrapper.get(".jira-search-details > summary").trigger("click");
    await wrapper.get("form.jira-search").trigger("submit");
    await flushPromises();
    expect(wrapper.get(".jira-search-details > summary").text()).toContain("All projects");
    wrapper.unmount();
  });

  test("guides a new Jira connection through save, verification, and into issues", async () => {
    transport.listJiraConnections
      .mockReset()
      .mockResolvedValueOnce([])
      .mockResolvedValue([
        {
          id: "jira-new",
          label: "Engineering",
          deployment: "data-center",
          webUrl: "https://jira.example.com",
          apiBaseUrl: "https://jira.example.com/jira",
        },
      ]);
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" }, attachTo: document.body });
    await flushPromises();

    expect(wrapper.text()).toContain("Connect your Jira site");
    expect(wrapper.get(".jira-inbox").classes()).toContain("jira-inbox--setup");
    expect(wrapper.find(".jira-setup").findAllComponents(CustomSelect)).toHaveLength(1);
    await chooseCustomSelect(wrapper, ".jira-setup", "pat");
    expect(wrapper.find(".jira-setup__type").text()).toContain("Connection type");
    await wrapper.get(".jira-setup__actions button:not(.button--ghost)").trigger("click");
    await flushPromises();
    const webUrlInput = wrapper.get('input[placeholder="https://jira.example.com"]');
    expect(document.activeElement).toBe(webUrlInput.element);
    await wrapper.get(".jira-setup__actions button:not(.button--ghost)").trigger("click");
    expect(wrapper.text()).toContain("Enter the Jira web URL you use in your browser.");
    expect(document.activeElement).toBe(webUrlInput.element);
    expect(transport.saveJiraConnection).not.toHaveBeenCalled();

    const formFields = wrapper.findAll(".jira-setup input");
    await formFields[0].setValue("https://jira.example.com");
    await formFields[1].setValue("https://jira.example.com/jira");
    await formFields[2].setValue("temporary-test-token");
    await wrapper.get(".jira-setup__actions button:not(.button--ghost)").trigger("click");
    await flushPromises();

    expect(transport.saveJiraConnection).toHaveBeenCalledWith(
      expect.objectContaining({ label: "jira.example.com", pat: "temporary-test-token" }),
    );
    expectEveryCallToMatch(jiraConnectionSaveSchema, transport.saveJiraConnection);
    expect(transport.verifyJiraConnection).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain("Jira connection verified");
    expect(wrapper.get(".jira-inbox").classes()).toContain("jira-inbox--setup");
    await wrapper.get(".jira-setup__actions button").trigger("click");
    expect(wrapper.get(".jira-inbox").classes()).not.toContain("jira-inbox--setup");
    expect(wrapper.find(".jira-controls").exists()).toBe(true);
    expect(wrapper.get(".jira-head").text()).toContain("Connection settings");
    wrapper.unmount();
  });

  test("shows the Jira connection wizard only when there are no saved connections", async () => {
    transport.listJiraConnections.mockResolvedValueOnce([]);
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" }, attachTo: document.body });
    await flushPromises();
    const connectionType = wrapper.find(".jira-setup").findComponent(CustomSelect);
    expect(customSelectProps(connectionType).options).toEqual(
      expect.arrayContaining([
        { value: "cloud", label: "Jira Cloud · API token" },
        { value: "pat", label: "Jira Data Center · Personal access token" },
        { value: "apim", label: "API gateway (APIM)" },
      ]),
    );
    expect(wrapper.text()).toContain("Self-hosted Jira Data Center");
    expect(wrapper.get(".jira-inbox").classes()).toContain("jira-inbox--setup");
  });

  test("organizes issues, board and connection settings into styled views", async () => {
    answerFirstOpenSearch();
    transport.listJiraBoards.mockResolvedValueOnce([]);
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
    await flushPromises();
    expect(wrapper.findAll(".jira-view-tab").map((tab) => tab.text())).toEqual(["Issues", "Board", "Settings"]);
    expect(wrapper.get(".jira-head h2").text()).toBe("Issues");
    await wrapper
      .findAll(".jira-view-tab")
      .find((tab) => tab.text() === "Board")!
      .trigger("click");
    expect(wrapper.get(".jira-inbox").classes()).toContain("jira-inbox--board-view");
    expect(wrapper.get(".jira-head h2").text()).toBe("Board");
    expect(wrapper.get(".jira-board-empty").text()).toContain("Choose a board above");
    await wrapper
      .findAll(".jira-view-tab")
      .find((tab) => tab.text() === "Settings")!
      .trigger("click");
    expect(wrapper.get(".jira-inbox").classes()).toContain("jira-inbox--settings-view");
    expect(wrapper.get(".jira-head h2").text()).toBe("Jira settings");
    expect(wrapper.find(".jira-settings-manager").exists()).toBe(true);
    expect(wrapper.get(".jira-identity").text()).toContain("person whose issues appear under My issues");
  });

  describe("Settings view", () => {
    const twoConnections = () =>
      transport.listJiraConnections.mockReset().mockResolvedValue([
        {
          id: "jira-1",
          label: "Engineering",
          deployment: "data-center",
          webUrl: "https://one.example.com",
          apiBaseUrl: "https://one.example.com/jira",
          verifiedIdentity: { displayName: "Build Bot" },
        },
        {
          id: "jira-2",
          label: "Operations",
          deployment: "cloud",
          webUrl: "https://two.example.com",
          verifiedIdentity: { displayName: "Ops Bot" },
        },
      ]);
    const headers = (wrapper: ReturnType<typeof mount>) => wrapper.findAll(".jira-connection-panel__header");

    test("has General and Connections sections, one Add connection and no topbar controls", async () => {
      const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
      await flushPromises();
      await openSettingsView(wrapper);
      const headings = wrapper
        .findAll(".jira-settings-manager > h3, .jira-settings-manager__heading h3")
        .map((heading) => heading.text());
      expect(headings).toEqual(["General", "Connections"]);
      expect(wrapper.find('[data-testid="jira-comment-attribution"]').exists()).toBe(true);
      expect(wrapper.findAll("button").filter((button) => button.text() === "Add connection")).toHaveLength(1);
      expect(wrapper.find(".jira-head__connection").exists()).toBe(false);
      expect(wrapper.find(".jira-head__sync").exists()).toBe(false);
      expect(wrapper.find(".jira-head__refresh").exists()).toBe(false);
      expect(wrapper.find(".jira-head__add").exists()).toBe(false);
      expect(wrapper.find(".jira-connection-actions").exists()).toBe(false);
      expect(wrapper.find(".jira-connection-form").exists()).toBe(false);
      wrapper.unmount();
    });

    test("the connection panel holds its actions, status, identity and saved queries", async () => {
      const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
      await flushPromises();
      await openSettingsView(wrapper);
      const header = wrapper.get(".jira-connection-panel__header");
      expect(header.attributes("aria-expanded")).toBe("true");
      const body = wrapper.get(".jira-connection-panel__body");
      expect(header.attributes("aria-controls")).toBe(body.attributes("id"));
      expect(body.findAll(".jira-settings-manager__actions button").map((button) => button.text())).toEqual([
        "Edit",
        "Test connection",
        "Disconnect",
      ]);
      expect(body.get(".jira-connection-status").text()).toContain("My issues for");
      expect(body.get(".jira-identity").attributes("style")).toContain("display: none");
      await body
        .findAll(".jira-connection-status__link")
        .find((button) => button.text() === "Change")!
        .trigger("click");
      expect(body.get(".jira-identity").attributes("style") ?? "").not.toContain("display: none");
      expect(body.get(".jira-identity").text()).toContain("Verify and save personal identity");
      expect(body.find(".jira-saved-query-details").exists()).toBe(true);
      wrapper.unmount();
    });

    test("Connection settings in the topbar opens the Settings view on the selected connection", async () => {
      twoConnections();
      const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
      await flushPromises();
      expect(wrapper.get(".jira-head__add").text()).toBe("Connection settings");
      expect(wrapper.text()).not.toContain("Add connection");
      await wrapper.get(".jira-head__add").trigger("click");
      await flushPromises();
      expect(wrapper.get(".jira-view-tab--active").text()).toBe("Settings");
      expect(headers(wrapper).map((header) => header.attributes("aria-expanded"))).toEqual(["true", "false"]);
      wrapper.unmount();
    });

    test("only one connection panel is open; opening another selects it and collapsing it closes the panel", async () => {
      twoConnections();
      const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
      await flushPromises();
      await openSettingsView(wrapper);
      await headers(wrapper)[1].trigger("click");
      await flushPromises();
      expect(headers(wrapper).map((header) => header.attributes("aria-expanded"))).toEqual(["false", "true"]);
      expect(wrapper.findAll(".jira-connection-panel__body")).toHaveLength(1);
      expect(wrapper.findAll(".jira-connection-panel")[1].find(".jira-connection-panel__body").exists()).toBe(true);
      await headers(wrapper)[1].trigger("click");
      expect(wrapper.findAll(".jira-connection-panel__body")).toHaveLength(0);
      await wrapper
        .findAll(".jira-view-tab")
        .find((tab) => tab.text() === "Issues")!
        .trigger("click");
      await openSettingsView(wrapper);
      expect(headers(wrapper).map((header) => header.attributes("aria-expanded"))).toEqual(["false", "true"]);
      wrapper.unmount();
    });

    test("the dialog embedding has Connections but no General section", async () => {
      const wrapper = mount(JiraInboxPane, { props: { connectionsOnly: true } });
      await flushPromises();
      expect(wrapper.find('[data-testid="jira-comment-attribution"]').exists()).toBe(false);
      expect(wrapper.findAll("h3").map((heading) => heading.text())).not.toContain("General");
      expect(wrapper.get(".jira-settings-manager h3").text()).toBe("Connections");
      expect(wrapper.findAll("button").filter((button) => button.text() === "Add connection")).toHaveLength(1);
      expect(wrapper.get(".jira-connection-panel__body").find(".jira-identity").exists()).toBe(true);
      wrapper.unmount();
    });

    test("a remote client sees the connections read-only", async () => {
      mockStoreState.transportApi = { ...transport, isRemote: true };
      const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
      await flushPromises();
      expect(wrapper.find(".jira-head__add").exists()).toBe(false);
      await openSettingsView(wrapper);
      expect(wrapper.find(".jira-connection-panel__header").exists()).toBe(true);
      expect(wrapper.find(".jira-settings-manager__actions").exists()).toBe(false);
      expect(wrapper.findAll("button").filter((button) => button.text() === "Add connection")).toHaveLength(0);
      expect(wrapper.find(".jira-identity").exists()).toBe(false);
      expect(wrapper.text()).toContain("Connection changes are available in the desktop app.");
      wrapper.unmount();
    });
  });

  test("shows the default results at once, explains empty search states and keeps stale results visible while refreshing", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let finishSearch!: (issues: unknown[]) => void;
    const current = [
      {
        ref: { provider: "jira", connectionId: "jira-1", issueId: "70000", issueKey: "ABC-70000" },
        summary: "Current result",
      },
    ];
    transport.searchJiraIssues
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(current)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishSearch = resolve;
          }),
      );
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
    await flushPromises();
    expect(wrapper.find(".jira-empty--search").exists()).toBe(false);
    expect(wrapper.find(".jira-issue").text()).toContain("ABC-70000");
    expect(transport.rememberJiraSearch).not.toHaveBeenCalled();

    await wrapper.find("form.jira-search").trigger("submit");
    await flushPromises();
    expect(wrapper.find(".jira-issue").text()).toContain("ABC-70000");
    const localFilter = wrapper.get('input[aria-label="Filter results"]');
    await localFilter.setValue("no matching issue");
    expect(wrapper.get(".jira-list-toolbar__count").text()).toContain("Showing 0 of 1 loaded issues");
    expect(wrapper.get(".jira-list-toolbar__groups").text()).toContain("All 0");
    await localFilter.setValue("");

    await wrapper.find("form.jira-search").trigger("submit");
    await flushPromises();
    expect(wrapper.get(".jira-head__sync").attributes("aria-busy")).toBe("true");
    await pastDelayedIndicators();
    expect(wrapper.get(".jira-head__sync-text").attributes("title")).toContain("Existing results remain visible");
    expect(wrapper.find(".jira-issue").text()).toContain("ABC-70000");
    expect(wrapper.get(".jira-results").attributes("aria-busy")).toBe("true");

    finishSearch([]);
    await flushPromises();
    expect(wrapper.find(".jira-empty--search").text()).toContain("No matching Jira issues");
  });

  test("zero results show the active project scope and query as removable chips and offer all projects", async () => {
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" }, attachTo: document.body });
    try {
      await flushPromises();
      await wrapper.get(".jira-primary-project-scope > summary").trigger("click");
      await flushPromises();
      await wrapper.get(".jira-project-scope-picker__search input").setValue("OPS");
      await wrapper.get('.jira-project-scope-picker__project input[type="checkbox"]').setValue(true);
      await wrapper.get(".jira-project-scope-picker__apply").trigger("click");
      await flushPromises();
      transport.searchJiraIssues.mockResolvedValue([]);
      await wrapper.get("form.jira-search").trigger("submit");
      await flushPromises();
      const empty = wrapper.get(".jira-empty--search");
      expect(empty.text()).toContain("No matching Jira issues");
      expect(empty.text()).not.toContain("Check the error above");
      const chips = empty.findAll(".jira-filter-chip").map((chip) => chip.text());
      expect(chips.some((text) => text.includes("Projects: OPS"))).toBe(true);
      expect(chips.some((text) => text.includes("Query:"))).toBe(true);

      await empty
        .findAll("button")
        .find((button) => button.text() === "Search all projects")!
        .trigger("click");
      await flushPromises();
      expect(transport.setJiraWorkspaceProjectScope).toHaveBeenLastCalledWith({
        workspaceId: "jira:ws",
        connectionId: "jira-1",
        projectKeys: [],
      });
      expect(wrapper.find(".jira-empty--search").text()).not.toContain("Projects: OPS");

      await wrapper.get('.jira-filter-chip__remove[aria-label="Remove query"]').trigger("click");
      await flushPromises();
      expect(wrapper.get(".jira-empty--search").text()).toContain("Find your Jira issues");
      expect(wrapper.find(".jira-filter-chip").exists()).toBe(false);
    } finally {
      wrapper.unmount();
    }
  });

  test("a saved query is only deleted after the confirmation is accepted", async () => {
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
    await flushPromises();
    await wrapper
      .findAll(".jira-view-tab")
      .find((tab) => tab.text() === "Settings")!
      .trigger("click");
    transport.confirmInApp.mockResolvedValueOnce(false);
    await wrapper
      .findAll(".jira-saved-queries button")
      .find((button) => button.text() === "Delete")!
      .trigger("click");
    await flushPromises();
    expect(transport.confirmInApp).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Delete saved query?", confirmLabel: "Delete", danger: true }),
    );
    expect(transport.deleteJiraQuery).not.toHaveBeenCalled();
  });

  test("the worklog form takes human durations, validates inline and sends whole seconds", async () => {
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
    await flushPromises();
    await wrapper.find("form.jira-search").trigger("submit");
    await flushPromises();
    await wrapper.find(".jira-issue").trigger("click");
    await flushPromises();
    await wrapper
      .get(".jira-detail-header__actions > details:last-child")
      .findAll("[role=menuitem]")
      .find((item) => item.text() === "Log work…")!
      .trigger("click");
    await flushPromises();
    const duration = wrapper.get('.jira-write input[placeholder="1h 30m"]');
    await duration.setValue("soon");
    expect(wrapper.get(".jira-write .jira-field-error").text()).toContain("1h 30m");
    const review = () => wrapper.findAll(".jira-write button").find((button) => button.text().startsWith("Review"))!;
    expect(review().attributes("disabled")).toBeDefined();
    await duration.setValue("1.5h");
    expect(wrapper.find(".jira-write .jira-field-error").exists()).toBe(false);
    transport.previewJiraWrite.mockResolvedValueOnce({
      token: "worklog-token",
      intent: "Log work on ENG-1",
      preview: "1h 30m",
      account: { displayName: "Build Bot", purpose: "technical" },
    });
    await review().trigger("click");
    await flushPromises();
    expect(transport.previewJiraWrite).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: "worklog", seconds: 5400 }),
    );
    expectEveryCallToMatch(jiraWritePreviewSchema, transport.previewJiraWrite);
  });

  test("empty state focuses the simple issue search", async () => {
    answerFirstOpenSearch();
    const wrapper = mount(JiraInboxPane, {
      props: { workspaceId: "jira:ws" },
      attachTo: document.body,
    });
    await flushPromises();

    await wrapper.get(".jira-empty--action").trigger("click");
    await flushPromises();

    expect((wrapper.get(".jira-search-details").element as HTMLDetailsElement).open).toBe(false);
    expect(document.activeElement).toBe(wrapper.get('input[aria-label="Search Jira by issue key or words"]').element);
    wrapper.unmount();
  });

  test("simple search accepts issue keys and words without requiring JQL", async () => {
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
    await flushPromises();
    const searchInput = wrapper.get('input[aria-label="Search Jira by issue key or words"]');

    await searchInput.setValue("eng-1");
    await wrapper.get("form.jira-quick-search").trigger("submit");
    await flushPromises();
    expect(transport.searchJiraIssues).toHaveBeenLastCalledWith({
      connectionId: "jira-1",
      jql: 'key = "ENG-1"',
      limit: 50,
      cacheOnly: true,
    });
    await wrapper.get('input[aria-label="Filter results"]').setValue("no matching issue");

    await searchInput.setValue("login fails");
    await wrapper.get("form.jira-quick-search").trigger("submit");
    await flushPromises();
    expect(transport.searchJiraIssues).toHaveBeenLastCalledWith({
      connectionId: "jira-1",
      jql: 'text ~ "login" AND text ~ "fails" ORDER BY updated DESC',
      limit: 50,
      cacheOnly: true,
    });
    expect(wrapper.get('input[aria-label="Filter results"]').element).toHaveProperty("value", "");
    expect(wrapper.find(".jira-issue").text()).toContain("ENG-1");

    await searchInput.setValue('"foo" OR project = ABC \\ bar');
    await wrapper.get("form.jira-quick-search").trigger("submit");
    await flushPromises();
    expect(transport.searchJiraIssues).toHaveBeenLastCalledWith({
      connectionId: "jira-1",
      jql: 'text ~ "foo" AND text ~ "OR" AND text ~ "project" AND text ~ "ABC" AND text ~ "bar" ORDER BY updated DESC',
      limit: 50,
      cacheOnly: true,
    });

    const callsBeforeEmptySubmit = transport.searchJiraIssues.mock.calls.length;
    await searchInput.setValue("++||!");
    await wrapper.get("form.jira-quick-search").trigger("submit");
    await flushPromises();
    expect(transport.searchJiraIssues).toHaveBeenCalledTimes(callsBeforeEmptySubmit);
    expect(wrapper.get(".jira-quick-search__error").text()).toContain("at least one word");
    wrapper.unmount();
  });

  test("announces issue detail loading before rendering the fetched issue", async () => {
    let finishIssue!: (issue: unknown) => void;
    transport.getJiraIssue.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishIssue = resolve;
        }),
    );
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
    await flushPromises();
    await wrapper.find("form.jira-search").trigger("submit");
    await flushPromises();
    await wrapper.find(".jira-issue").trigger("click");
    expect(wrapper.find(".jira-detail .jira-empty").text()).toContain("Loading issue details");
    finishIssue({
      ref: { provider: "jira", connectionId: "jira-1", issueId: "70000", issueKey: "ABC-70000" },
      summary: "Fetched issue",
      description: "A description",
    });
    await flushPromises();
    expect(wrapper.find(".jira-detail h2").text()).toBe("Fetched issue");
  });

  test("offers inline human identity setup directly from a technical account context", async () => {
    transport.listJiraConnections.mockResolvedValueOnce([
      {
        id: "jira-1",
        label: "Engineering",
        deployment: "data-center",
        webUrl: "https://jira.example.com",
        accountPurpose: "technical",
        verifiedIdentity: { displayName: "W9NIZLA" },
      },
    ]);
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
    await flushPromises();
    expect(wrapper.findAll(".jira-human-identity-setup__actions")).toHaveLength(0);
    const myIssues = wrapper
      .findAll(".jira-views-menu__panel [role=menuitem]")
      .find((item) => item.text().includes("My issues"))!;
    expect(myIssues.text()).toContain("Choose your Jira identity first");
    await myIssues.trigger("click");
    expect(wrapper.find(".jira-human-identity-setup").exists()).toBe(true);
  });

  test("searches Jira boards through server pages and appends the next page", async () => {
    const searchJiraBoards = vi
      .fn()
      .mockResolvedValueOnce({
        boards: [{ id: 42, name: "Engineering board", type: "scrum" }],
        hasMore: true,
        nextCursor: "50",
      })
      .mockResolvedValueOnce({
        boards: [{ id: 53, name: "Roadmap", type: "kanban" }],
        hasMore: true,
        nextCursor: "50",
      })
      .mockResolvedValueOnce({
        boards: [{ id: 64, name: "Roadmap archive", type: "kanban" }],
        hasMore: false,
      });
    mockStoreState.transportApi = {
      ...transport,
      getJiraWorkspaceViews: undefined,
      saveJiraWorkspaceView: undefined,
      removeJiraWorkspaceView: undefined,
      setJiraWorkspaceActiveView: undefined,
      refreshJiraWorkspaceViews: undefined,
      searchJiraBoards,
    };
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
    await flushPromises();
    await showBoardView(wrapper);
    await wrapper.find(".jira-board-controls .custom-select__button").trigger("click");
    await flushPromises();
    const boardSelect = wrapper.find(".jira-board-controls").findComponent(CustomSelect);
    expect(customSelectProps(boardSelect).searchable).toBe(true);
    expect(customSelectProps(boardSelect).hasMore).toBe(true);

    await boardSelect.vm.$emit("search", "Roadmap");
    await new Promise((resolve) => setTimeout(resolve, 300));
    await flushPromises();
    expect(searchJiraBoards).toHaveBeenLastCalledWith({ connectionId: "jira-1", query: "Roadmap", limit: 50 });
    expect(customSelectProps(boardSelect).options.map((option) => option.label)).toContain("Roadmap · kanban");

    await boardSelect.vm.$emit("loadMore");
    await flushPromises();
    expect(searchJiraBoards).toHaveBeenLastCalledWith({
      connectionId: "jira-1",
      query: "Roadmap",
      cursor: "50",
      limit: 50,
    });
    expect(customSelectProps(boardSelect).options.map((option) => option.label)).toContain("Roadmap archive · kanban");
    expect(customSelectProps(boardSelect).hasMore).toBe(false);
  });

  test("explains limited multi-project board discovery and the eight-project search limit", async () => {
    const searchJiraBoards = vi
      .fn()
      .mockResolvedValueOnce({ boards: [], hasMore: false, truncated: true })
      .mockRejectedValueOnce(new Error("Choose up to 8 projects to find boards, or search within one project."));
    mockStoreState.transportApi = { ...transport, searchJiraBoards };
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
    await flushPromises();
    await showBoardView(wrapper);
    await wrapper.find(".jira-board-controls .custom-select__button").trigger("click");
    await flushPromises();
    expect(wrapper.get(".jira-board-picker-notice").text()).toContain("Showing a limited set of boards");

    const boardSelect = wrapper.find(".jira-board-controls").findComponent(CustomSelect);
    await boardSelect.vm.$emit("search", "OPS");
    await new Promise((resolve) => setTimeout(resolve, 300));
    await flushPromises();
    expect(wrapper.get(".jira-board-picker-notice").text()).toContain("Choose up to 8 projects");
    wrapper.unmount();
  });

  test("opens a pinned board by saved connection and ID without falling back to the first board page", async () => {
    const pinned = {
      id: "board-child",
      name: "Roadmap",
      kind: "jira-board",
      profileId: "default",
      jiraBoard: { parentWorkspaceId: "jira-parent", connectionId: "jira-1", boardId: "999", boardName: "Roadmap" },
    };
    mockStoreState.payload = reactive({
      appState: {
        workspaces: [{ id: "jira-parent", name: "Jira inbox", kind: "jira", profileId: "default" }, pinned],
      },
    });
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: pinned.id } });
    await flushPromises();
    expect(transport.getJiraBoardView).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: "jira-1", boardId: 999, mode: "issues", cacheOnly: true }),
    );
    expect(transport.getJiraBoardView).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: "jira-1", boardId: 999, mode: "issues", forceRefresh: true }),
    );
    expect(transport.listJiraBoards).toHaveBeenCalledWith("jira-1");
    expect(wrapper.get(".jira-inbox").classes()).toContain("jira-inbox--board-view");
  });

  test("does not substitute another connection when a pinned board connection is missing", async () => {
    const pinned = {
      id: "board-child",
      name: "Roadmap",
      kind: "jira-board",
      profileId: "default",
      jiraBoard: {
        parentWorkspaceId: "jira-parent",
        connectionId: "removed-jira",
        boardId: "999",
        boardName: "Roadmap",
      },
    };
    mockStoreState.payload = reactive({ appState: { workspaces: [pinned] } });
    transport.listJiraConnections.mockResolvedValueOnce([
      { id: "jira-1", label: "Engineering", deployment: "cloud", webUrl: "https://example.net" },
    ]);
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: pinned.id } });
    await flushPromises();
    expect(wrapper.find('[role="alert"]').text()).toContain("no longer available");
    expect(transport.listJiraBoards).not.toHaveBeenCalled();
    expect(transport.getJiraBoardView).not.toHaveBeenCalled();
  });

  test("Settings connection manager works without a Jira workspace and Cancel returns to an empty state", async () => {
    transport.listJiraConnections.mockResolvedValue([]);
    const wrapper = mount(JiraInboxPane, { props: { connectionsOnly: true }, attachTo: document.body });
    await flushPromises();
    expect(wrapper.text()).toContain("No Jira connections yet");
    expect(wrapper.find(".jira-head").exists()).toBe(false);
    expect(wrapper.find(".jira-setup").exists()).toBe(false);
    expect(wrapper.get(".jira-settings-manager").text()).toContain("you don’t need a Jira workspace");

    const add = wrapper.get(".jira-settings-manager__heading button");
    await add.trigger("click");
    await flushPromises();
    expect(document.activeElement).toBe(wrapper.get('input[placeholder="Engineering Jira"]').element);
    await chooseCustomSelect(wrapper, ".jira-setup", "apim");
    await wrapper.get(".jira-setup__actions button:not(.button--ghost)").trigger("click");
    await flushPromises();
    expect(document.activeElement).toBe(wrapper.get('input[placeholder="https://jira.example.com"]').element);

    await wrapper
      .findAll(".jira-setup__actions button")
      .find((button) => button.text() === "Back")!
      .trigger("click");
    await flushPromises();
    expect(document.activeElement).toBe(wrapper.get('input[placeholder="Engineering Jira"]').element);
    await wrapper
      .findAll(".jira-setup__actions button")
      .find((button) => button.text() === "Cancel")!
      .trigger("click");
    await flushPromises();
    expect(wrapper.find(".jira-setup").exists()).toBe(false);
    expect(wrapper.get(".jira-settings-manager").text()).toContain("No Jira connections yet");
    expect(document.activeElement).toBe(wrapper.get(".jira-settings-manager__heading button").element);
    expect(transport.saveJiraConnection).not.toHaveBeenCalled();
    expect(transport.listJiraBoards).not.toHaveBeenCalled();
    expect(transport.listJiraQueries).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  test("lets a remote user choose and verify a human identity without using the API account", async () => {
    mockStoreState.transportApi = { ...transport, isRemote: true };
    transport.listJiraConnections.mockResolvedValueOnce([
      {
        id: "jira-1",
        label: "Engineering",
        deployment: "data-center",
        webUrl: "https://jira.example.com",
        accountPurpose: "technical",
        verifiedIdentity: { displayName: "W9NIZLA" },
      },
    ]);
    transport.listJiraConnections.mockResolvedValueOnce([
      {
        id: "jira-1",
        label: "Engineering",
        deployment: "data-center",
        webUrl: "https://jira.example.com",
        accountPurpose: "technical",
        verifiedIdentity: { displayName: "W9NIZLA" },
        ownIdentity: { kind: "data-center", name: "alice", displayName: "Alice Example" },
      },
    ]);
    transport.searchJiraUsers.mockResolvedValueOnce([
      { kind: "data-center", name: "alice", displayName: "Alice Example" },
      { kind: "data-center", name: "api-bot", displayName: "W9NIZLA" },
    ]);

    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
    await flushPromises();
    await chooseView(wrapper, "My issues");
    expect(wrapper.text()).toContain("Changes in Jira are still made by the connected account.");
    expect(wrapper.find(".jira-human-identity-setup").exists()).toBe(true);
    expect(wrapper.find(".jira-identity").exists()).toBe(false);

    await wrapper.get(".jira-human-identity-setup input").setValue("Alice");
    await wrapper.get(".jira-human-identity-setup__search").trigger("submit");
    await flushPromises();
    expect(transport.searchJiraUsers).toHaveBeenCalledWith({ connectionId: "jira-1", query: "Alice", limit: 25 });
    expect(wrapper.findAll(".jira-human-identity-setup__results button")).toHaveLength(2);
    await wrapper.findAll(".jira-human-identity-setup__results button")[0].trigger("click");
    await wrapper.get(".jira-human-identity-setup__actions .button").trigger("click");
    await flushPromises();
    expect(transport.verifyJiraOwnIdentity).toHaveBeenCalledWith({ connectionId: "jira-1", userId: "alice" });
    expect(transport.setJiraOwnIdentity).toHaveBeenCalledWith({ connectionId: "jira-1", userId: "alice" });
    expectEveryCallToMatch(jiraOwnIdentitySchema, transport.setJiraOwnIdentity);
    expect(transport.buildJiraOwnIssuesQuery).toHaveBeenCalledWith({
      connectionId: "jira-1",
      baseJql: "statusCategory != Done",
    });
    expect(transport.saveJiraWorkspaceView).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  test("returns focus to the Views menu after cancelling remote identity setup", async () => {
    mockStoreState.transportApi = { ...transport, isRemote: true };
    transport.listJiraConnections.mockResolvedValueOnce([
      {
        id: "jira-1",
        label: "Engineering",
        deployment: "data-center",
        webUrl: "https://jira.example.com",
        accountPurpose: "technical",
        verifiedIdentity: { displayName: "W9NIZLA" },
      },
    ]);
    const wrapper = mount(JiraInboxPane, { attachTo: document.body, props: { workspaceId: "jira:ws" } });
    await flushPromises();
    await chooseView(wrapper, "My issues");
    await wrapper.get(".jira-human-identity-setup__actions .button--ghost").trigger("click");
    await flushPromises();
    expect(wrapper.find(".jira-human-identity-setup").exists()).toBe(false);
    expect(document.activeElement).toBe(wrapper.get(".jira-views-menu > summary").element);
    wrapper.unmount();
  });

  test("Settings connection list shows APIM type and exposes profile-level management actions", async () => {
    const savedConnection = {
      id: "jira-apim",
      label: "Gateway Jira",
      deployment: "data-center",
      webUrl: "https://jira.example.com",
      apiBaseUrl: "https://gateway.example.com/prefix",
      auth: { kind: "dc-apim" },
      subscriptionHeaderName: "X-Key",
    };
    transport.listJiraConnections.mockReset().mockResolvedValue([savedConnection]);
    const wrapper = mount(JiraInboxPane, { props: { connectionsOnly: true }, attachTo: document.body });
    await flushPromises();
    expect(wrapper.find(".jira-head").exists()).toBe(false);
    expect(wrapper.get(".jira-settings-manager").text()).toContain("API gateway (APIM)");
    expect(transport.listJiraBoards).not.toHaveBeenCalled();
    expect(transport.listJiraQueries).toHaveBeenCalledWith("jira-apim");
    await wrapper
      .findAll(".jira-settings-manager__actions button")
      .find((button) => button.text() === "Test connection")!
      .trigger("click");
    await flushPromises();
    expect(transport.verifyJiraConnection).toHaveBeenCalledWith("jira-apim");
    expect(wrapper.get(".jira-connection-verify-result").text()).toContain("Verified as Build Bot");
    expect(
      wrapper
        .findAll(".jira-settings-manager__actions button")
        .find((button) => button.text() === "Test connection")!
        .attributes("title"),
    ).toBe("Check that Gateway Jira can still sign in and read Jira. Changes nothing.");
    expect(
      wrapper
        .findAll(".jira-settings-manager__actions button")
        .find((button) => button.text() === "Edit")!
        .attributes("title"),
    ).toContain("Change the name, defaults, address or credentials of Gateway Jira");
    expect(transport.listJiraBoards).not.toHaveBeenCalled();
    await wrapper
      .findAll(".jira-settings-manager__actions button")
      .find((button) => button.text() === "Edit")!
      .trigger("click");
    await flushPromises();
    expect(wrapper.find(".jira-connection-edit").exists()).toBe(true);
    await openConnectionTab(wrapper);
    await flushPromises();
    expect(wrapper.get(".jira-setup").text()).toContain("Leave a secret blank to keep the saved value");
    expect(
      wrapper
        .findAll(".jira-setup__actions button")
        .find((button) => button.text() === "Test connection")!
        .attributes("title"),
    ).toBe("Check these details against Jira without saving anything.");
    expect(
      wrapper
        .findAll(".jira-setup__actions button")
        .find((button) => button.text() === "Save connection")!
        .attributes("title"),
    ).toContain("A blank secret keeps its saved value.");
    expect(wrapper.find(".jira-connection-edit").exists()).toBe(false);
    await wrapper
      .findAll(".jira-setup__actions button")
      .find((button) => button.text() === "Cancel")!
      .trigger("click");
    await flushPromises();
    expect(wrapper.get(".jira-settings-manager").text()).toContain("Gateway Jira");
    wrapper.unmount();
  });

  test("successful APIM credential save clears an earlier permission failure from its manager card", async () => {
    const oldConnection = {
      id: "jira-apim",
      label: "Gateway Jira",
      deployment: "data-center",
      webUrl: "https://jira.example.com",
      apiBaseUrl: "https://gateway.example.com/prefix",
      auth: { kind: "dc-apim" },
      subscriptionHeaderName: "X-Key",
      clientCertificatePath: "C:/certs/client.p12",
      verifiedIdentity: { displayName: "Old identity" },
    };
    const refreshedConnection = { ...oldConnection, verifiedIdentity: { displayName: "W9NIZLA" } };
    transport.listJiraConnections
      .mockReset()
      .mockResolvedValueOnce([oldConnection])
      .mockResolvedValueOnce([oldConnection])
      .mockResolvedValueOnce([refreshedConnection])
      .mockResolvedValue([refreshedConnection]);
    transport.verifyJiraConnection.mockResolvedValueOnce({
      ok: false,
      health: { state: "permission-denied", checkedAt: "now" },
      error: { code: "permission-denied", message: "This Jira account does not have permission for that data." },
    });
    transport.saveJiraConnection.mockResolvedValueOnce({ id: "jira-apim" });

    const wrapper = mount(JiraInboxPane, { props: { connectionsOnly: true }, attachTo: document.body });
    await flushPromises();
    const managerActions = () => wrapper.findAll(".jira-settings-manager__actions button");
    await managerActions()
      .find((button) => button.text() === "Test connection")!
      .trigger("click");
    await flushPromises();
    expect(wrapper.get(".jira-connection-verify-result").text()).toContain(
      "This Jira account does not have permission for that data.",
    );

    await openConnectionTab(wrapper);
    await flushPromises();
    await wrapper
      .findAll(".jira-setup__actions button")
      .find((button) => button.text() === "Test connection")!
      .trigger("click");
    await flushPromises();
    expect(wrapper.get(".jira-setup__test-result").text()).toContain("Connection test passed");
    expect(transport.testJiraConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "jira-apim",
        deployment: "data-center",
        authMode: "apim",
        webUrl: "https://jira.example.com",
        apiBaseUrl: "https://gateway.example.com/prefix",
        subscriptionKey: "",
        subscriptionHeaderName: "X-Key",
        clientCertificatePath: "C:/certs/client.p12",
        clientCertificatePassword: "",
      }),
    );
    await wrapper
      .findAll(".jira-setup__actions button")
      .find((button) => button.text() === "Cancel")!
      .trigger("click");
    await flushPromises();
    expect(wrapper.get(".jira-connection-verify-result").text()).toContain(
      "This Jira account does not have permission for that data.",
    );

    await openConnectionTab(wrapper);
    await flushPromises();
    await wrapper
      .findAll(".jira-setup__actions button")
      .find((button) => button.text() === "Save connection")!
      .trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("Saved and verified as W9NIZLA");
    expect(wrapper.find(".jira-connection-edit-card").exists()).toBe(false);
    expect(transport.saveJiraConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "jira-apim",
        deployment: "data-center",
        authMode: "apim",
        webUrl: "https://jira.example.com",
        apiBaseUrl: "https://gateway.example.com/prefix",
        subscriptionKey: "",
        subscriptionHeaderName: "X-Key",
        clientCertificatePath: "C:/certs/client.p12",
        clientCertificatePassword: "",
      }),
    );
    expect(transport.saveJiraConnection).toHaveBeenCalledOnce();
    expect(transport.verifyJiraConnection).toHaveBeenCalledOnce();
    expect(wrapper.find(".jira-connection-verify-result").exists()).toBe(false);
    expect(wrapper.get(".jira-connection-panel").text()).toContain("W9NIZLA");

    transport.verifyJiraConnection.mockResolvedValueOnce({
      ok: false,
      health: { state: "permission-denied", checkedAt: "later" },
      error: { code: "permission-denied", message: "This Jira account does not have permission for that data." },
    });
    await managerActions()
      .find((button) => button.text() === "Test connection")!
      .trigger("click");
    await flushPromises();
    expect(wrapper.get(".jira-connection-verify-result").text()).toContain(
      "This Jira account does not have permission for that data.",
    );
    expect(transport.verifyJiraConnection.mock.calls).toEqual([["jira-apim"], ["jira-apim"]]);
    expect(transport.testJiraConnection).toHaveBeenCalledOnce();
    expect(transport.listJiraBoards).not.toHaveBeenCalled();
    expect(transport.listJiraQueries).toHaveBeenCalledWith("jira-apim");
    wrapper.unmount();
  });

  test("configures Jira through an API gateway and selects a client certificate through the native picker", async () => {
    transport.listJiraConnections
      .mockReset()
      .mockResolvedValueOnce([])
      .mockResolvedValue([
        {
          id: "jira-apim",
          label: "jira.example.com",
          deployment: "data-center",
          webUrl: "https://jira.example.com",
          apiBaseUrl: "https://gateway.example.com/prefix",
        },
      ]);
    transport.browseFile.mockResolvedValue("C:/certs/client.p12");
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" }, attachTo: document.body });
    await flushPromises();
    await chooseCustomSelect(wrapper, ".jira-setup", "apim");
    expect(wrapper.find(".jira-setup__type").text()).toContain("API gateway");
    await wrapper.get(".jira-setup__actions button:not(.button--ghost)").trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("Add your gateway details");
    expect(wrapper.get('input[placeholder="https://jira.example.com"]').element).toBe(document.activeElement);
    await wrapper.get('input[placeholder="https://jira.example.com"]').setValue("https://jira.example.com");
    await wrapper
      .get('input[placeholder="https://gateway.example.com/jira"]')
      .setValue("https://gateway.example.com/prefix");
    expect((wrapper.get('.jira-setup input[autocomplete="off"]').element as HTMLInputElement).value).toBe(
      "Ocp-Apim-Subscription-Key",
    );
    await wrapper.get('input[placeholder="https://gateway.example.com/jira"]').trigger("blur");
    await wrapper.find(".jira-setup .jira-setup__file-row button.button--ghost").trigger("click");
    await flushPromises();
    expect(transport.browseFile).toHaveBeenCalledWith({
      filters: [{ name: "PKCS#12 certificate", extensions: ["pfx", "p12"] }],
    });
    expect(
      (wrapper.get('.jira-setup input[placeholder="Optional .pfx or .p12 file"]').element as HTMLInputElement).value,
    ).toBe("C:/certs/client.p12");
    await wrapper
      .get('input[placeholder="https://gateway.example.com/jira"]')
      .setValue("https://gateway.example.com/prefix");
    const key = wrapper.findAll(".jira-setup input[type=password]")[0];
    await wrapper.get(".jira-setup__actions button:not(.button--ghost)").trigger("click");
    await flushPromises();
    expect(wrapper.find('[role="alert"]').text()).toContain("subscription key");
    expect(document.activeElement).toBe(key.element);
    await key.setValue("gateway-secret");
    await wrapper.find(".jira-setup input[type=password]").setValue("gateway-secret");
    await wrapper.get(".jira-setup__actions button:not(.button--ghost)").trigger("click");
    await flushPromises();
    expect(transport.saveJiraConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        deployment: "data-center",
        authMode: "apim",
        apiBaseUrl: "https://gateway.example.com/prefix",
        subscriptionHeaderName: "Ocp-Apim-Subscription-Key",
        subscriptionKey: "gateway-secret",
        clientCertificatePath: "C:/certs/client.p12",
      }),
    );
    expectEveryCallToMatch(jiraConnectionSaveSchema, transport.saveJiraConnection);
    expect(transport.testJiraConnection).not.toHaveBeenCalled();
    expect(transport.verifyJiraConnection).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain("Jira connection verified");
  });

  test("editing APIM credentials leaves saved secrets blank and submits blank values to preserve them", async () => {
    transport.listJiraConnections.mockResolvedValueOnce([
      {
        id: "jira-apim",
        label: "Gateway Jira",
        deployment: "data-center",
        webUrl: "https://jira.example.com",
        apiBaseUrl: "https://gateway.example.com/prefix",
        auth: { kind: "dc-apim" },
        subscriptionHeaderName: "X-Subscription-Key",
        clientCertificatePath: "C:/certs/client.pfx",
      },
    ]);
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
    await flushPromises();
    await openSettingsView(wrapper);
    await openConnectionTab(wrapper);
    const setup = wrapper.find(".jira-setup");
    expect(setup.text()).toContain("Leave a secret blank to keep the saved value");
    expect(
      (setup.get('input[placeholder="Leave blank to keep the saved key"]').element as HTMLInputElement).value,
    ).toBe("");
    expect((setup.get('input[placeholder="Optional .pfx or .p12 file"]').element as HTMLInputElement).value).toBe(
      "C:/certs/client.pfx",
    );
    expect((setup.findAll('input[type="password"]')[0]!.element as HTMLInputElement).value).toBe("");
    await setup
      .findAll(".jira-setup__actions button")
      .find((button) => button.text() === "Test connection")!
      .trigger("click");
    await flushPromises();
    expect(transport.testJiraConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "jira-apim",
        authMode: "apim",
        subscriptionKey: "",
        clientCertificatePassword: "",
        clientCertificatePath: "C:/certs/client.pfx",
        subscriptionHeaderName: "X-Subscription-Key",
      }),
    );
    expect(transport.saveJiraConnection).not.toHaveBeenCalled();
    await setup.get(".jira-setup__actions button:not(.button--ghost)").trigger("click");
    await flushPromises();
    expect(transport.saveJiraConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "jira-apim",
        authMode: "apim",
        subscriptionKey: "",
        clientCertificatePassword: "",
        clientCertificatePath: "C:/certs/client.pfx",
        subscriptionHeaderName: "X-Subscription-Key",
      }),
    );
    expectEveryCallToMatch(jiraConnectionTestSchema, transport.testJiraConnection);
    expectEveryCallToMatch(jiraConnectionSaveSchema, transport.saveJiraConnection);
    expect(transport.verifyJiraConnection).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain("Saved and verified");
  });

  test("keeps Test separate from Save, shows pending/success feedback, and clears results after edits", async () => {
    transport.listJiraConnections.mockReset().mockResolvedValue([]);
    let resolveTest!: (value: { ok: true; identity: { displayName: string } }) => void;
    transport.testJiraConnection.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveTest = resolve;
      }),
    );
    const wrapper = mount(JiraInboxPane, { props: { connectionsOnly: true }, attachTo: document.body });
    await flushPromises();
    await wrapper.get(".jira-settings-manager__heading button").trigger("click");
    await chooseCustomSelect(wrapper, ".jira-setup", "apim");
    await wrapper.get(".jira-setup__actions button:not(.button--ghost)").trigger("click");
    await wrapper.get('input[placeholder="https://jira.example.com"]').setValue("https://jira.example.com");
    await wrapper
      .get('input[placeholder="https://gateway.example.com/jira"]')
      .setValue("https://gateway.example.com/prefix");
    await wrapper.get('.jira-setup input[type="password"]').setValue("temporary-key");

    const testButton = wrapper
      .findAll(".jira-setup__actions button")
      .find((button) => button.text() === "Test connection")!;
    await testButton.trigger("click");
    expect(testButton.text()).toBe("Test connection");
    expect(testButton.attributes("aria-busy")).toBe("true");
    expect(
      wrapper
        .findAll(".jira-setup__actions button")
        .find((button) => button.text() === "Save connection")!
        .attributes("disabled"),
    ).toBeDefined();
    expect(wrapper.get(".jira-setup__test-result").text()).toContain("Testing connection without saving");
    expect(transport.saveJiraConnection).not.toHaveBeenCalled();

    resolveTest({ ok: true, identity: { displayName: "APIM User" } });
    await flushPromises();
    expect(wrapper.get(".jira-setup__test-result").text()).toContain(
      "Connection test passed · APIM User. Nothing was saved.",
    );
    await wrapper.get('.jira-setup input[type="password"]').setValue("changed-key");
    expect(wrapper.find(".jira-setup__test-result").exists()).toBe(false);
    expect(transport.saveJiraConnection).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  test("shows sanitized test failures beside actions and marks the related field", async () => {
    transport.listJiraConnections.mockReset().mockResolvedValue([]);
    transport.browseFile.mockResolvedValue("C:/certs/client.p12");
    transport.testJiraConnection.mockResolvedValueOnce({
      ok: false,
      error: { message: "Error invoking remote method 'jira:test-connection': Certificate password is invalid." },
    });
    const wrapper = mount(JiraInboxPane, { props: { connectionsOnly: true }, attachTo: document.body });
    await flushPromises();
    await wrapper.get(".jira-settings-manager__heading button").trigger("click");
    await chooseCustomSelect(wrapper, ".jira-setup", "apim");
    await wrapper.get(".jira-setup__actions button:not(.button--ghost)").trigger("click");
    await wrapper.get('input[placeholder="https://jira.example.com"]').setValue("https://jira.example.com");
    await wrapper
      .get('input[placeholder="https://gateway.example.com/jira"]')
      .setValue("https://gateway.example.com/prefix");
    await wrapper.get('.jira-setup input[type="password"]').setValue("temporary-key");
    await wrapper.find(".jira-setup .jira-setup__file-row button").trigger("click");
    await flushPromises();
    await wrapper.findAll('.jira-setup input[type="password"]')[1]!.setValue("wrong-password");
    await wrapper
      .findAll(".jira-setup__actions button")
      .find((button) => button.text() === "Test connection")!
      .trigger("click");
    await flushPromises();

    const result = wrapper.get(".jira-setup__test-result");
    expect(result.attributes("role")).toBe("alert");
    expect(result.text()).toContain("Certificate password is invalid.");
    expect(result.text()).not.toContain("Error invoking remote method");
    expect(wrapper.find('.jira-setup input[type="password"][aria-invalid="true"]').exists()).toBe(true);
    expect(document.activeElement).toBe(result.element);
    expect(transport.saveJiraConnection).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  test("Save has its own pending state and performs one authoritative save without a second verify call", async () => {
    transport.listJiraConnections
      .mockReset()
      .mockResolvedValueOnce([])
      .mockResolvedValue([
        {
          id: "jira-saved",
          label: "jira.example.com",
          deployment: "data-center",
          webUrl: "https://jira.example.com",
          apiBaseUrl: "https://gateway.example.com/prefix",
          verifiedIdentity: { displayName: "APIM User" },
        },
      ]);
    let resolveSave!: (value: { id: string }) => void;
    transport.saveJiraConnection.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSave = resolve;
      }),
    );
    const wrapper = mount(JiraInboxPane, { props: { connectionsOnly: true }, attachTo: document.body });
    await flushPromises();
    await wrapper.get(".jira-settings-manager__heading button").trigger("click");
    await chooseCustomSelect(wrapper, ".jira-setup", "apim");
    await wrapper.get(".jira-setup__actions button:not(.button--ghost)").trigger("click");
    await wrapper.get('input[placeholder="https://jira.example.com"]').setValue("https://jira.example.com");
    await wrapper
      .get('input[placeholder="https://gateway.example.com/jira"]')
      .setValue("https://gateway.example.com/prefix");
    await wrapper.get('.jira-setup input[type="password"]').setValue("temporary-key");

    const saveButton = wrapper
      .findAll(".jira-setup__actions button")
      .find((button) => button.text() === "Save connection")!;
    await saveButton.trigger("click");
    expect(saveButton.text()).toBe("Save connection");
    expect(saveButton.attributes("aria-busy")).toBe("true");
    expect(
      wrapper
        .findAll(".jira-setup__actions button")
        .find((button) => button.text() === "Cancel")!
        .attributes("disabled"),
    ).toBeDefined();
    expect(transport.testJiraConnection).not.toHaveBeenCalled();
    expect(transport.verifyJiraConnection).not.toHaveBeenCalled();

    resolveSave({ id: "jira-saved" });
    await flushPromises();
    expect(wrapper.get(".jira-setup").text()).toContain("Saved and verified as APIM User");
    expect(transport.saveJiraConnection).toHaveBeenCalledOnce();
    expect(transport.verifyJiraConnection).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  test("canceling a pending test and reopening ignores the late result", async () => {
    transport.listJiraConnections.mockReset().mockResolvedValue([]);
    let resolveTest!: (value: { ok: true; identity: { displayName: string } }) => void;
    transport.testJiraConnection.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveTest = resolve;
      }),
    );
    const wrapper = mount(JiraInboxPane, { props: { connectionsOnly: true }, attachTo: document.body });
    await flushPromises();
    await wrapper.get(".jira-settings-manager__heading button").trigger("click");
    await chooseCustomSelect(wrapper, ".jira-setup", "apim");
    await wrapper.get(".jira-setup__actions button:not(.button--ghost)").trigger("click");
    await wrapper.get('input[placeholder="https://jira.example.com"]').setValue("https://jira.example.com");
    await wrapper
      .get('input[placeholder="https://gateway.example.com/jira"]')
      .setValue("https://gateway.example.com/prefix");
    await wrapper.get('.jira-setup input[type="password"]').setValue("temporary-key");
    await wrapper
      .findAll(".jira-setup__actions button")
      .find((button) => button.text() === "Test connection")!
      .trigger("click");
    expect(wrapper.get(".jira-setup__test-result").text()).toContain("Testing connection");
    await wrapper
      .findAll(".jira-setup__actions button")
      .find((button) => button.text() === "Cancel")!
      .trigger("click");
    expect(wrapper.find(".jira-setup").exists()).toBe(false);
    await wrapper.get(".jira-settings-manager__heading button").trigger("click");
    resolveTest({ ok: true, identity: { displayName: "Old test" } });
    await flushPromises();
    expect(wrapper.find(".jira-setup__test-result").exists()).toBe(false);
    expect(wrapper.text()).not.toContain("Old test");
    expect(transport.saveJiraConnection).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  test("loads a connection, searches, and fetches selected issue details", async () => {
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" }, attachTo: document.body });
    await flushPromises();

    expect(transport.listJiraConnections).toHaveBeenCalledOnce();
    expect(wrapper.find(".jira-head .custom-select__value").text()).toContain("Engineering · Jira Data Center · PAT");
    await wrapper.find("form.jira-search").trigger("submit");
    await flushPromises();
    expect(transport.searchJiraIssues).toHaveBeenCalledWith({
      connectionId: "jira-1",
      jql: 'assignee = "alice" ORDER BY updated DESC',
      limit: 50,
      cacheOnly: true,
    });
    expect(wrapper.text()).toContain("ENG-1");

    await wrapper.find(".jira-issue").trigger("click");
    await flushPromises();
    expect(transport.getJiraIssue).toHaveBeenCalledWith({ connectionId: "jira-1", issueId: "1001", cacheOnly: true });
    expect(wrapper.text()).toContain("Login fails on refresh");
    expect(wrapper.text()).toContain("In Progress");
    const actionDetails = wrapper.get(".jira-detail-header__actions > details:last-child");
    const actionSummary = actionDetails.get("summary");
    await actionSummary.trigger("click");
    expect((actionDetails.element as HTMLDetailsElement).open).toBe(true);
    await actionSummary.trigger("keydown", { key: "Escape" });
    expect((actionDetails.element as HTMLDetailsElement).open).toBe(false);
    expect(document.activeElement).toBe(actionSummary.element);
    expect(actionSummary.attributes("title")).toContain("Copy the key or link");
    await actionSummary.trigger("click");
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect((actionDetails.element as HTMLDetailsElement).open).toBe(false);
    expect(wrapper.text()).not.toContain("No attachments on this issue.");
    await wrapper.find(".jira-detail__back").trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("Select an issue to view its details.");
    expect(wrapper.find(".jira-results").exists()).toBe(true);
    expect(transport.getJiraIssue).toHaveBeenCalledTimes(1);
  });

  test.each([
    { rich: true, label: "normalized rich description" },
    { rich: false, label: "legacy cached plain description" },
  ])("renders $label without interpreting legacy text as Markdown", async ({ rich }) => {
    transport.getJiraIssue.mockResolvedValue({
      ref: { provider: "jira", connectionId: "jira-1", issueId: "1001", issueKey: "ENG-1" },
      summary: "Description rendering regression",
      description: "## Literal legacy heading\nLegacy **literal stars** and https://example.com/guide",
      ...(rich
        ? {
            descriptionMarkdown:
              "## Rich heading\n\nRich **emphasis** and https://example.com/guide\n\n- First item\n- Second item",
          }
        : {}),
    });
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
    try {
      await flushPromises();
      await wrapper.get("form.jira-search").trigger("submit");
      await flushPromises();
      await wrapper.get(".jira-issue").trigger("click");
      await flushPromises();
      const description = wrapper.get(".jira-description");
      expect(description.get("a").attributes("href")).toBe("https://example.com/guide");
      if (rich) {
        expect(description.get("h2").text()).toBe("Rich heading");
        expect(description.get("strong").text()).toBe("emphasis");
        expect(description.findAll("ul > li").map((item) => item.text())).toEqual(["First item", "Second item"]);
        expect(description.text()).not.toContain("Literal legacy heading");
      } else {
        expect(description.find("h2").exists()).toBe(false);
        expect(description.find("strong").exists()).toBe(false);
        expect(description.text()).toContain("## Literal legacy heading");
        expect(description.text()).toContain("**literal stars**");
      }
    } finally {
      wrapper.unmount();
    }
  });

  test("uses native titles only on icon-only actions and keeps no custom tooltip layer", async () => {
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" }, attachTo: document.body });
    try {
      await flushPromises();
      await wrapper.get("form.jira-search").trigger("submit");
      await flushPromises();
      await wrapper.get(".jira-issue").trigger("click");
      await flushPromises();
      expect(wrapper.find("[data-tooltip]").exists()).toBe(false);
      const actions = wrapper.findAll(
        ".jira-detail-header__actions button, .jira-detail-header__actions a, .jira-detail-header__actions summary",
      );
      expect(actions.length).toBeGreaterThanOrEqual(2);
      for (const action of actions) {
        const title = action.attributes("title");
        if (title) expect(title).not.toBe(action.text());
      }
      await wrapper.get(".jira-detail-header__actions summary").trigger("focusin");
      await flushPromises();
      expect(document.body.querySelector(".jira-action-tooltip")).toBeNull();
    } finally {
      wrapper.unmount();
    }
  });

  test("lists issue attachments and saves a selected attachment through the native save dialog", async () => {
    transport.getJiraIssue.mockResolvedValueOnce({
      ref: { provider: "jira", connectionId: "jira-1", issueId: "1001", issueKey: "ENG-1" },
      summary: "Fix login",
      attachments: [
        { id: "7", fileName: "server log.txt", mediaType: "text/plain", sizeBytes: 2048 },
        { id: "large", fileName: "archive.zip", mediaType: "application/zip", sizeBytes: 12 * 1024 * 1024 },
      ],
    });
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
    await flushPromises();
    await wrapper.find("form.jira-search").trigger("submit");
    await flushPromises();
    await wrapper.find(".jira-issue").trigger("click");
    await flushPromises();
    expect(wrapper.find('[aria-label="Issue attachments"]').text()).toContain("server log.txt");
    expect(wrapper.find('[aria-label="Issue attachments"]').text()).toContain("2.0 KB");
    expect(wrapper.findAll('[aria-label="Issue attachments"] li button')[1]!.attributes("disabled")).toBeDefined();
    expect(wrapper.find('[aria-label="Issue attachments"]').text()).toContain("Download limit is 10 MiB.");
    await wrapper.find('[aria-label="Issue attachments"] li button').trigger("click");
    await flushPromises();
    expect(transport.saveJiraIssueAttachment).toHaveBeenCalledWith({
      connectionId: "jira-1",
      issueId: "1001",
      attachmentId: "7",
    });
    expect(wrapper.find('[aria-label="Issue attachments"]').text()).toContain("Saved.");
  });

  test("attachment download cancellation and errors are shown without exposing renderer file paths", async () => {
    transport.getJiraIssue.mockResolvedValueOnce({
      ref: { provider: "jira", connectionId: "jira-1", issueId: "1001", issueKey: "ENG-1" },
      summary: "Fix login",
      attachments: [{ id: "8", fileName: "capture.png", mediaType: "image/png", sizeBytes: 10 }],
    });
    transport.saveJiraIssueAttachment.mockResolvedValueOnce({ saved: false });
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
    await flushPromises();
    await wrapper.find("form.jira-search").trigger("submit");
    await flushPromises();
    await wrapper.find(".jira-issue").trigger("click");
    await flushPromises();
    await wrapper.find('[aria-label="Issue attachments"] li button').trigger("click");
    await flushPromises();
    expect(wrapper.find('[aria-label="Issue attachments"]').text()).toContain("Save cancelled.");
    transport.saveJiraIssueAttachment.mockRejectedValueOnce(new Error("Download failed"));
    await wrapper.find('[aria-label="Issue attachments"] li button').trigger("click");
    await flushPromises();
    expect(wrapper.find('[role="alert"]').text()).toContain("Download failed");
    expect(wrapper.text()).not.toContain("C:/Downloads");
  });

  test("upload is an explicit native file-picker action, refreshes metadata, and reports completion", async () => {
    transport.getJiraIssue
      .mockResolvedValueOnce({
        ref: { provider: "jira", connectionId: "jira-1", issueId: "1001", issueKey: "ENG-1" },
        summary: "Fix login",
        attachments: [],
      })
      .mockResolvedValueOnce({
        ref: { provider: "jira", connectionId: "jira-1", issueId: "1001", issueKey: "ENG-1" },
        summary: "Fix login",
        attachments: [{ id: "9", fileName: "new.txt", mediaType: "text/plain", sizeBytes: 120 }],
      });
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
    await flushPromises();
    await wrapper.find("form.jira-search").trigger("submit");
    await flushPromises();
    await wrapper.find(".jira-issue").trigger("click");
    await flushPromises();
    const moreActions = wrapper.get(".jira-detail-header__actions > details:last-child");
    await moreActions.get("summary").trigger("click");
    await moreActions
      .findAll("[role=menuitem]")
      .find((item) => item.text() === "Add attachment")!
      .trigger("click");
    expect((moreActions.element as HTMLDetailsElement).open).toBe(false);
    await flushPromises();
    expect(transport.uploadJiraIssueAttachment).toHaveBeenCalledWith({ connectionId: "jira-1", issueId: "1001" });
    expect(transport.getJiraIssue).toHaveBeenCalledTimes(2);
    expect(wrapper.find(".jira-detail-header .jira-upload-status").text()).toContain("Attachment uploaded");
    expect(wrapper.find('[aria-label="Issue attachments"]').exists()).toBe(true);
    await wrapper.get('[aria-label="Issue attachments"] > summary').trigger("click");
    expect(wrapper.find('[aria-label="Issue attachments"]').text()).toContain("new.txt");
  });

  test("mobile session keeps attachment metadata but does not offer desktop file-dialog actions", async () => {
    mockStoreState.isMobileSession = true;
    transport.getJiraIssue.mockResolvedValueOnce({
      ref: { provider: "jira", connectionId: "jira-1", issueId: "1001", issueKey: "ENG-1" },
      summary: "Fix login",
      attachments: [{ id: "7", fileName: "server log.txt", mediaType: "text/plain", sizeBytes: 12 }],
    });
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
    await flushPromises();
    await wrapper.find("form.jira-search").trigger("submit");
    await flushPromises();
    await wrapper.find(".jira-issue").trigger("click");
    await flushPromises();
    await wrapper.get('[aria-label="Issue attachments"] > summary').trigger("click");
    expect(wrapper.find('[aria-label="Issue attachments"]').text()).toContain("server log.txt");
    expect(wrapper.find(".jira-detail-readonly").text()).toContain("available in the desktop app");
    expect(wrapper.find('[aria-label="Issue attachments"] button').exists()).toBe(false);
  });

  test("short wide workspace panes compact board tools and can restore search controls on demand", async () => {
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    const originalMatchMedia = Object.getOwnPropertyDescriptor(window, "matchMedia");
    let coarsePointer = true;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: ((query: string) => ({
        matches: query === "(pointer: coarse)" && coarsePointer,
        addEventListener: () => {},
        removeEventListener: () => {},
      })) as unknown as typeof window.matchMedia,
    });
    let bounds = { width: 770, height: 600 };
    const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.classList?.contains("jira-inbox")) {
        return {
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          width: bounds.width,
          height: bounds.height,
          right: bounds.width,
          bottom: bounds.height,
          toJSON: () => ({}),
        } as DOMRect;
      }
      return originalRect.call(this);
    });
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" }, attachTo: document.body });
    try {
      await flushPromises();
      await wrapper
        .findAll(".jira-view-tab")
        .find((tab) => tab.text() === "Board")!
        .trigger("click");
      await chooseCustomSelect(wrapper, ".jira-board-controls", 42);
      expect(wrapper.get(".jira-inbox").classes()).toContain("jira-inbox--compact");
      expect(wrapper.find(".jira-head__actions").text()).toContain("Connection settings");
      expect(wrapper.find(".jira-head__actions").text()).not.toContain("Open search");
      expect(wrapper.find("form.jira-search").exists()).toBe(false);
      await wrapper
        .findAll(".jira-view-tab")
        .find((tab) => tab.text() === "Issues")!
        .trigger("click");
      await wrapper.find(".jira-head__actions button").trigger("click");
      await flushPromises();
      expect(wrapper.find("form.jira-search").exists()).toBe(true);
      coarsePointer = false;
      window.dispatchEvent(new Event("resize"));
      await flushPromises();
      expect(wrapper.get(".jira-inbox").classes()).not.toContain("jira-inbox--compact");
      bounds = { width: 842, height: 328 };
      window.dispatchEvent(new Event("resize"));
      await flushPromises();
      expect(wrapper.get(".jira-inbox").classes()).toContain("jira-inbox--compact");
      bounds = { width: 842, height: 800 };
      window.dispatchEvent(new Event("resize"));
      await flushPromises();
      expect(wrapper.get(".jira-inbox").classes()).not.toContain("jira-inbox--compact");
    } finally {
      wrapper.unmount();
      rectSpy.mockRestore();
      if (originalMatchMedia) Object.defineProperty(window, "matchMedia", originalMatchMedia);
      else delete (window as Partial<Window>).matchMedia;
    }
  });

  test("agent comment draft loads the issue and prefills the guarded composer without posting", async () => {
    transport.listJiraCommentDrafts.mockResolvedValueOnce([
      {
        id: "draft-1",
        ref: { provider: "jira", connectionId: "jira-1", issueId: "1001", issueKey: "ENG-1" },
        body: "Please add a regression test.",
        sourceWorkspaceId: "ws-1",
        createdAt: "today",
      },
    ]);
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "ws-1" }, attachTo: document.body });
    await flushPromises();
    expect(wrapper.text()).toContain("Agent comment drafts (1)");
    expect(wrapper.text()).toContain("Payments");
    await wrapper.find(".jira-mcp-drafts__actions .button--ghost").trigger("click");
    await flushPromises();
    expect(
      (wrapper.find('textarea[placeholder="Write a comment… (Ctrl+Enter to send)"]').element as HTMLTextAreaElement)
        .value,
    ).toBe("Please add a regression test.");
    expect(wrapper.get(".jira-reason__text").text()).toBe("Review agent-proposed comment");
    expect(document.activeElement).toBe(
      wrapper.find('textarea[placeholder="Write a comment… (Ctrl+Enter to send)"]').element,
    );
    expect(transport.previewJiraWrite).toHaveBeenCalledTimes(1);
    expect(transport.previewJiraWrite).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: "comment", body: "Please add a regression test." }),
    );
    expect(transport.executeJiraWrite).not.toHaveBeenCalled();
    const card = wrapper.get(".jira-comment-composer .jira-confirm");
    expect(card.text()).toContain("Agent-written comment, not yet sent");
    expect(card.get("pre").text()).toContain("Reviewed this change.");
    const sendButton = wrapper
      .findAll(".jira-comment-composer button[type=submit]")
      .find((button) => button.text().includes("Comment"))!;
    expect(sendButton.attributes("disabled")).toBeDefined();
    await card.findAll("button")[0]!.trigger("click");
    await flushPromises();
    expect(transport.executeJiraWrite).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  test("cancelling the agent draft review sends nothing and removes the card", async () => {
    transport.listJiraCommentDrafts.mockResolvedValueOnce([
      {
        id: "draft-1",
        ref: { provider: "jira", connectionId: "jira-1", issueId: "1001", issueKey: "ENG-1" },
        body: "Please add a regression test.",
        sourceWorkspaceId: "ws-1",
        createdAt: "today",
      },
    ]);
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "ws-1" }, attachTo: document.body });
    await flushPromises();
    await wrapper.find(".jira-mcp-drafts__actions .button--ghost").trigger("click");
    await flushPromises();
    await wrapper.get(".jira-comment-composer .jira-confirm").findAll("button")[1]!.trigger("click");
    await flushPromises();
    expect(wrapper.find(".jira-comment-composer .jira-confirm").exists()).toBe(false);
    expect(transport.executeJiraWrite).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  test("agent comment draft clear requires the in-app confirmation and removes only the chosen draft", async () => {
    transport.listJiraCommentDrafts.mockResolvedValueOnce([
      {
        id: "draft-1",
        ref: { provider: "jira", connectionId: "jira-1", issueId: "1001", issueKey: "ENG-1" },
        body: "Proposed change.",
        sourceWorkspaceId: "ws-1",
        createdAt: "today",
      },
    ]);
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "ws-1" } });
    await flushPromises();
    await wrapper.findAll(".jira-mcp-drafts__actions .button--ghost")[1]!.trigger("click");
    await flushPromises();
    expect(transport.confirmInApp).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Clear agent comment draft?", danger: true }),
    );
    expect(transport.deleteJiraCommentDraft).toHaveBeenCalledWith({ sourceWorkspaceId: "ws-1", draftId: "draft-1" });
    expect(wrapper.find(".jira-mcp-drafts").exists()).toBe(false);
  });

  test("personal preset delegates identity query to runtime and leaves raw currentUser JQL unchanged", async () => {
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
    await flushPromises();
    const rawJql = "assignee = currentUser() ORDER BY updated DESC";
    await wrapper.find(".jira-search input").setValue(rawJql);
    await chooseView(wrapper, "My issues, including done");
    expect(transport.buildJiraOwnIssuesQuery).toHaveBeenCalledWith({ connectionId: "jira-1" });
    expect(transport.searchJiraIssues).toHaveBeenCalledWith({
      connectionId: "jira-1",
      jql: 'assignee = "alice" ORDER BY updated DESC',
      limit: 50,
      cacheOnly: true,
    });
    expect((wrapper.find(".jira-search input").element as HTMLInputElement).value).toBe(rawJql);
    expect(wrapper.text()).toContain("Showing issues for Alice");
  });

  test("My open issues uses the verified personal identity and excludes Done status without changing the JQL editor", async () => {
    transport.buildJiraOwnIssuesQuery.mockResolvedValueOnce({
      jql: '(statusCategory != Done) AND assignee = "alice"',
      identityLabel: "Alice",
    });
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
    await flushPromises();
    const rawJql = (wrapper.find(".jira-search input").element as HTMLInputElement).value;
    await chooseView(wrapper, "Assigned to you, not done");
    expect(transport.buildJiraOwnIssuesQuery).toHaveBeenCalledWith({
      connectionId: "jira-1",
      baseJql: "statusCategory != Done",
    });
    expect(transport.searchJiraIssues).toHaveBeenCalledWith({
      connectionId: "jira-1",
      jql: '(statusCategory != Done) AND assignee = "alice"',
      limit: 50,
      cacheOnly: true,
    });
    expect((wrapper.find(".jira-search input").element as HTMLInputElement).value).toBe(rawJql);
  });

  test("opens a board filtered by the verified human identity, not the technical API account", async () => {
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
    await flushPromises();
    await wrapper
      .findAll(".jira-view-tab")
      .find((tab) => tab.text() === "Board")!
      .trigger("click");
    await chooseCustomSelect(wrapper, ".jira-board-controls", 42);
    await openToolbarMenuItem(wrapper, "Open My issues as a tab");
    expect(transport.buildJiraOwnIssuesQuery).toHaveBeenCalledWith({ connectionId: "jira-1" });
    expect(transport.getJiraBoardView.mock.lastCall?.[0]).toMatchObject({
      connectionId: "jira-1",
      boardId: 42,
      assignee: { kind: "user", id: "alice" },
    });
    expect(wrapper.get(".jira-view-tab--active").text()).toBe("Board");
  });

  test("choosing a board only shows it; Save as tab is the one action that creates a saved tab", async () => {
    mockStoreState.transportApi = transport;
    mockStoreState.payload = reactive({
      appState: {
        activeProfileId: "default",
        workspaces: [{ id: "jira:ws", name: "Jira inbox", kind: "jira", profileId: "default" }],
      },
    });
    const issuesView = { viewId: "issues", kind: "issues" as const, title: "Issues" };
    transport.getJiraWorkspaceViews.mockImplementation(async ({ workspaceId }: { workspaceId: string }) => ({
      workspaceId,
      profileId: "default",
      views: [issuesView],
      activeViewId: "issues",
      syncByViewId: {},
    }));
    const savedView = {
      viewId: "saved-board-42",
      kind: "board" as const,
      connectionId: "jira-1",
      boardId: 42,
      boardName: "Engineering board",
      title: "Engineering board",
      mode: "issues" as const,
      sprintId: null,
      quickFilterIds: [],
      assignee: null,
      doneWithinDays: 14 as const,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const savedState = {
      workspaceId: "jira:ws",
      profileId: "default",
      views: [issuesView, savedView],
      activeViewId: savedView.viewId,
      syncByViewId: {},
    };
    transport.saveJiraWorkspaceView.mockResolvedValue(savedState);
    transport.setJiraWorkspaceActiveView.mockResolvedValue(savedState);
    const wrapper = mount(JiraInboxPane, {
      props: { workspaceId: "jira:ws", jiraViewId: "issues" },
      attachTo: document.body,
    });
    await flushPromises();
    await chooseCustomSelect(wrapper, ".jira-board-controls", 42);
    await flushPromises();
    expect(transport.saveJiraWorkspaceView).not.toHaveBeenCalled();
    expect(transport.activateView).not.toHaveBeenCalled();
    expect(wrapper.get(".jira-view-tab--active").text()).toBe("Board");
    expect(wrapper.get(".jira-save-board-tab").text()).toBe("Save as tab");
    await wrapper.get(".jira-save-board-tab").trigger("click");
    await flushPromises();
    expect(transport.saveJiraWorkspaceView).toHaveBeenCalledWith({
      workspaceId: "jira:ws",
      view: expect.objectContaining({
        kind: "board",
        connectionId: "jira-1",
        boardId: 42,
        boardName: "Engineering board",
      }),
    });
    expect(transport.activateView).toHaveBeenCalledWith("jira:jira:ws:view:saved-board-42");
  });

  test("opens the board chooser after the Issues connection and board load finishes", async () => {
    let resolveConnections!: (connections: unknown[]) => void;
    transport.listJiraConnections.mockReturnValue(
      new Promise((resolve) => {
        resolveConnections = resolve;
      }),
    );
    mockStoreState.jiraBoardChooserRequest = { workspaceId: "jira:ws", sequence: 4 };
    const wrapper = mount(JiraInboxPane, {
      props: { workspaceId: "jira:ws", jiraViewId: "issues" },
      attachTo: document.body,
    });
    await flushPromises();
    expect(wrapper.find(".jira-board-controls").exists()).toBe(false);
    resolveConnections([
      {
        id: "jira-1",
        label: "Engineering",
        deployment: "data-center",
        webUrl: "https://jira.example.com",
        apiBaseUrl: "https://jira.example.com/jira",
        accountPurpose: "technical",
        verifiedIdentity: { displayName: "Build Bot" },
        ownIdentity: { kind: "data-center", name: "alice", displayName: "Alice" },
      },
    ]);
    await flushPromises();
    expect(wrapper.get(".jira-view-tab--active").text()).toBe("Board");
    expect(wrapper.get(".jira-board-controls .custom-select__button").attributes("aria-expanded")).toBe("true");
    expect(document.activeElement).toBeInstanceOf(HTMLInputElement);
    expect((document.activeElement as HTMLElement).classList.contains("custom-select__search")).toBe(true);
    expect(mockStoreState.jiraBoardChooserRequest).toBeNull();
    wrapper.unmount();
  });

  test("loads native saved board tabs from SQLite config and cached Jira issues", async () => {
    mockStoreState.transportApi = transport;
    mockStoreState.payload = reactive({
      appState: {
        activeProfileId: "default",
        workspaces: [{ id: "jira:ws", name: "Jira inbox", kind: "jira", profileId: "default" }],
      },
    });
    const savedView = {
      viewId: "saved-board-42",
      kind: "board" as const,
      connectionId: "jira-1",
      boardId: 42,
      boardName: "Engineering board",
      title: "Engineering board",
      mode: "issues" as const,
      sprintId: null,
      quickFilterIds: [],
      assignee: null,
      doneWithinDays: 14 as const,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    transport.getJiraWorkspaceViews.mockResolvedValue({
      workspaceId: "jira:ws",
      profileId: "default",
      views: [{ viewId: "issues", kind: "issues", title: "Issues" }, savedView],
      activeViewId: savedView.viewId,
      syncByViewId: { [savedView.viewId]: { state: "syncing", startedAt: Date.now() } },
    });
    transport.setJiraWorkspaceActiveView.mockResolvedValue({
      workspaceId: "jira:ws",
      profileId: "default",
      views: [{ viewId: "issues", kind: "issues", title: "Issues" }, savedView],
      activeViewId: savedView.viewId,
      syncByViewId: { [savedView.viewId]: { state: "syncing", startedAt: Date.now() } },
    });
    transport.getJiraBoardView.mockResolvedValueOnce({
      issues: [
        {
          ref: { provider: "jira", connectionId: "jira-1", issueId: "1001", issueKey: "ENG-1" },
          summary: "Cached issue",
          status: "Open",
          statusId: "1",
        },
      ],
      columns: [{ name: "To Do", statuses: [{ id: "1", name: "Open" }] }],
      cache: { source: "cache", fetchedAt: Date.now() - 30_000, stale: true },
    });
    transport.refreshJiraWorkspaceViews.mockResolvedValue({
      workspaceId: "jira:ws",
      profileId: "default",
      views: [{ viewId: "issues", kind: "issues", title: "Issues" }, savedView],
      activeViewId: savedView.viewId,
      syncByViewId: { [savedView.viewId]: { state: "syncing", startedAt: Date.now() } },
    });
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws", jiraViewId: savedView.viewId } });
    await flushPromises();
    expect(wrapper.find(".jira-view-tab").exists()).toBe(false);
    expect(wrapper.text()).toContain("Cached issue");
    expect(transport.getJiraBoardView).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: "jira-1", boardId: 42, mode: "issues", cacheOnly: true }),
    );
    expect(transport.getJiraBoardView).not.toHaveBeenCalledWith(expect.objectContaining({ forceRefresh: true }));
    wrapper.unmount();
  });

  test("a saved board tab leaves the header's search to the Issues tab", async () => {
    mockStoreState.transportApi = transport;
    mockStoreState.payload = reactive({
      appState: {
        activeProfileId: "default",
        workspaces: [{ id: "jira:ws", name: "Jira inbox", kind: "jira", profileId: "default" }],
      },
    });
    const savedView = {
      viewId: "saved-board-42",
      kind: "board" as const,
      connectionId: "jira-1",
      boardId: 42,
      boardName: "Engineering board",
      title: "Engineering board",
      mode: "issues" as const,
      sprintId: null,
      quickFilterIds: [],
      assignee: null,
      doneWithinDays: 14 as const,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const state = {
      workspaceId: "jira:ws",
      profileId: "default",
      views: [{ viewId: "issues", kind: "issues", title: "Issues" }, savedView],
      activeViewId: savedView.viewId,
      syncByViewId: {},
    };
    transport.getJiraWorkspaceViews.mockResolvedValue(state);
    transport.setJiraWorkspaceActiveView.mockResolvedValue(state);
    transport.getJiraBoardView.mockResolvedValue({
      issues: [],
      columns: [{ name: "To Do", statuses: [{ id: "1", name: "Open" }] }],
      cache: { source: "cache", fetchedAt: Date.now(), stale: false },
    });
    const JiraPaneHost = defineComponent({
      props: {
        workspaceId: { type: String, required: true },
        jiraViewId: { type: String, required: true },
      },
      setup(props) {
        return () => h(JiraInboxPane, { workspaceId: props.workspaceId, jiraViewId: props.jiraViewId });
      },
    });
    // The Issues tab last showed its board, after a search of its own.
    writeJiraViewPreferences("default", "jira:ws", { activeView: "board" }, localStorage);
    writeLastJiraSearch(
      "default",
      "jira:ws",
      { connectionId: "jira-1", jql: "project = ENG", kind: "jql", label: null, filterId: null },
      localStorage,
    );
    const watcherIssue = {
      ref: { provider: "jira" as const, connectionId: "jira-1", issueId: "77", issueKey: "ENG-77" },
      summary: "Watcher alerts are late",
    };
    transport.searchJiraIssues.mockImplementation(async ({ jql }: { jql: string }) => ({
      issues: jql === 'text ~ "watcher" ORDER BY updated DESC' ? [watcherIssue] : [],
      cache: { source: "network", fetchedAt: Date.now(), stale: false },
    }));
    // The header asks while a saved board tab is the one on screen.
    mockStoreState.jiraSearchRequest = { workspaceId: "jira:ws", text: "watcher", sequence: 1 };
    const wrapper = mount(JiraPaneHost, { props: { workspaceId: "jira:ws", jiraViewId: savedView.viewId } });
    await flushPromises();
    const searchedWatcher = () =>
      transport.searchJiraIssues.mock.calls.some(
        ([request]) => (request as { jql?: string } | undefined)?.jql === 'text ~ "watcher" ORDER BY updated DESC',
      );
    expect(searchedWatcher()).toBe(false);
    expect(mockStoreState.jiraSearchRequest).not.toBeNull();

    await wrapper.setProps({ jiraViewId: "issues" });
    await flushPromises();
    expect(searchedWatcher()).toBe(true);
    expect((wrapper.find(".jira-quick-search input").element as HTMLInputElement).value).toBe("watcher");
    expect(wrapper.text()).toContain("Watcher alerts are late");
    expect(mockStoreState.jiraSearchRequest).toBeNull();
    wrapper.unmount();
  });

  test("the Issues view shows its results while the Board tab has a sprint picked", async () => {
    mockStoreState.transportApi = transport;
    mockStoreState.payload = reactive({
      appState: {
        activeProfileId: "default",
        workspaces: [{ id: "jira:ws", name: "Jira inbox", kind: "jira", profileId: "default" }],
      },
    });
    writeJiraViewPreferences(
      "default",
      "jira:ws",
      {
        connectionId: "jira-1",
        boardId: "42",
        boardName: "Engineering board",
        boardType: "scrum",
        boardMode: "sprints",
        selectedSprintId: "7",
        activeView: "issues",
      },
      localStorage,
    );
    transport.listJiraBoards.mockResolvedValue([{ id: 42, name: "Engineering board", type: "scrum" }]);
    transport.searchJiraIssues.mockImplementation(async ({ jql }: { jql: string }) => ({
      issues:
        jql === 'text ~ "watcher" ORDER BY updated DESC'
          ? [
              {
                ref: { provider: "jira" as const, connectionId: "jira-1", issueId: "77", issueKey: "ENG-77" },
                summary: "Watcher alerts are late",
              },
            ]
          : [],
      cache: { source: "network", fetchedAt: Date.now(), stale: false },
    }));
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws", jiraViewId: "issues" } });
    await flushPromises();

    await wrapper.find(".jira-quick-search input").setValue("watcher");
    await wrapper.find(".jira-quick-search").trigger("submit");
    await flushPromises();

    expect(wrapper.find(".jira-results").exists()).toBe(true);
    expect(wrapper.text()).toContain("Watcher alerts are late");
    wrapper.unmount();
  });

  test("with several connections the header's search runs across all of them in the Issues tab", async () => {
    mockStoreState.transportApi = transport;
    mockStoreState.payload = reactive({
      appState: {
        activeProfileId: "default",
        workspaces: [{ id: "jira:ws", name: "Jira inbox", kind: "jira", profileId: "default" }],
      },
    });
    transport.listJiraConnections.mockResolvedValue([
      { id: "jira-1", label: "Engineering", deployment: "cloud", webUrl: "https://one.example" },
      { id: "jira-2", label: "Operations", deployment: "cloud", webUrl: "https://two.example" },
    ]);
    writeJiraViewPreferences("default", "jira:ws", { activeView: "board", connectionId: "jira-1" }, localStorage);
    transport.searchJiraIssues.mockImplementation(
      async ({ connectionId, jql }: { connectionId: string; jql: string }) => ({
        issues:
          jql === 'text ~ "watcher" ORDER BY updated DESC'
            ? [
                {
                  ref: { provider: "jira" as const, connectionId, issueId: `${connectionId}-7`, issueKey: "OPS-7" },
                  summary: `Watcher on ${connectionId}`,
                },
              ]
            : [],
        cache: { source: "network", fetchedAt: Date.now(), stale: false },
      }),
    );
    mockStoreState.jiraSearchRequest = { workspaceId: "jira:ws", text: "watcher", sequence: 1 };
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws", jiraViewId: "issues" } });
    await flushPromises();

    expect(wrapper.text()).toContain("Watcher on jira-1");
    expect(wrapper.text()).toContain("Watcher on jira-2");
    expect(mockStoreState.jiraSearchRequest).toBeNull();
    wrapper.unmount();
  });

  test("restores a saved assignee chip without loading an unfiltered board from Jira", async () => {
    mockStoreState.transportApi = transport;
    mockStoreState.payload = reactive({
      appState: {
        activeProfileId: "default",
        workspaces: [{ id: "jira:ws", name: "Jira inbox", kind: "jira", profileId: "default" }],
      },
    });
    const savedView = {
      viewId: "saved-board-42",
      kind: "board" as const,
      connectionId: "jira-1",
      boardId: 42,
      boardName: "Engineering board",
      title: "Engineering board",
      mode: "issues" as const,
      sprintId: null,
      quickFilterIds: [],
      assignee: { kind: "user" as const, id: "alice", label: "Alice" },
      doneWithinDays: 14 as const,
      projectKeys: ["OPS"],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const state = {
      workspaceId: "jira:ws",
      profileId: "default",
      views: [{ viewId: "issues", kind: "issues", title: "Issues" }, savedView],
      activeViewId: savedView.viewId,
      syncByViewId: {},
    };
    transport.getJiraWorkspaceViews.mockResolvedValue(state);
    transport.setJiraWorkspaceActiveView.mockResolvedValue(state);
    transport.getJiraBoardView.mockResolvedValueOnce(null).mockResolvedValueOnce({
      issues: [
        {
          ref: { provider: "jira", connectionId: "jira-1", issueId: "1001", issueKey: "OPS-1" },
          summary: "Alice's issue",
          status: "Open",
          statusId: "1",
        },
      ],
      columns: [{ name: "To Do", statuses: [{ id: "1", name: "Open" }] }],
      cache: { source: "cache", fetchedAt: Date.now(), stale: false },
    });

    const JiraPaneHost = defineComponent({
      props: {
        workspaceId: { type: String, required: true },
        jiraViewId: { type: String, required: true },
      },
      setup(props) {
        return () => h(JiraInboxPane, { workspaceId: props.workspaceId, jiraViewId: props.jiraViewId });
      },
    });
    const wrapper = mount(JiraPaneHost, {
      props: { workspaceId: "jira:ws", jiraViewId: savedView.viewId },
    });
    await flushPromises();

    const aliceChip = wrapper
      .findAll(".jira-assignee-chip")
      .find((button) => button.attributes("aria-label") === "Alice");
    expect(aliceChip?.attributes("aria-pressed")).toBe("true");
    expect(wrapper.text()).toContain("Alice's issue");
    expect(transport.getJiraBoardView).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ connectionId: "jira-1", boardId: 42, cacheOnly: true }),
    );
    // The board's own Jira filter decides its projects; the saved project scope does not narrow it.
    for (const [payload] of transport.getJiraBoardView.mock.calls) expect(payload).not.toHaveProperty("projectKeys");
    expect(transport.getJiraBoardView).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        connectionId: "jira-1",
        boardId: 42,
        assignee: { kind: "user", id: "alice" },
        cacheOnly: true,
      }),
    );
    expect(transport.getJiraBoardView).not.toHaveBeenCalledWith(expect.objectContaining({ forceRefresh: true }));
    wrapper.unmount();
  });

  test("saves an assignee chip picked on a board tab as a plain, cloneable object", async () => {
    mockStoreState.transportApi = transport;
    mockStoreState.payload = reactive({
      appState: {
        activeProfileId: "default",
        workspaces: [{ id: "jira:ws", name: "Jira inbox", kind: "jira", profileId: "default" }],
      },
    });
    const savedView = {
      viewId: "saved-board-42",
      kind: "board" as const,
      connectionId: "jira-1",
      boardId: 42,
      boardName: "Engineering board",
      title: "Engineering board",
      mode: "issues" as const,
      sprintId: null,
      quickFilterIds: [],
      assignee: null,
      doneWithinDays: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const state = {
      workspaceId: "jira:ws",
      profileId: "default",
      views: [{ viewId: "issues", kind: "issues", title: "Issues" }, savedView],
      activeViewId: savedView.viewId,
      syncByViewId: {},
    };
    transport.getJiraWorkspaceViews.mockResolvedValue(state);
    transport.setJiraWorkspaceActiveView.mockResolvedValue(state);
    transport.saveJiraWorkspaceView.mockResolvedValue(state);
    transport.getJiraBoardView.mockResolvedValue({
      boardId: 42,
      mode: "issues",
      columns: [{ name: "To Do", statuses: [{ id: "1", name: "Open" }] }],
      issues: [
        {
          ref: { provider: "jira", connectionId: "jira-1", issueId: "1001", issueKey: "ENG-1" },
          summary: "Bob's task",
          status: "Open",
          statusId: "1",
          assignee: "Bob Builder",
          assigneeRef: { kind: "data-center", key: "jira-user-7", name: "bob", displayName: "Bob Builder" },
        },
      ],
      cache: { source: "cache", fetchedAt: Date.now(), stale: false },
    });
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws", jiraViewId: savedView.viewId } });
    await flushPromises();

    await wrapper
      .findAll(".jira-assignee-chip")
      .find((button) => button.attributes("aria-label") === "Bob Builder")!
      .trigger("click");
    await new Promise((resolve) => setTimeout(resolve, 300));
    await flushPromises();

    const saved = transport.saveJiraWorkspaceView.mock.lastCall?.[0];
    expect(saved?.view.assignee).toEqual({ kind: "user", id: "bob", label: "Bob Builder" });
    // Electron IPC structured-clones the payload; a Vue reactive proxy fails with "An object could not be cloned".
    expect(() => structuredClone(saved)).not.toThrow();
    wrapper.unmount();
  });

  test("offers only the board statuses that loaded issues are in, plus a chosen one that has none", async () => {
    mockStoreState.transportApi = transport;
    mockStoreState.payload = reactive({
      appState: {
        activeProfileId: "default",
        workspaces: [{ id: "jira:ws", name: "Jira inbox", kind: "jira", profileId: "default" }],
      },
    });
    const savedView = {
      viewId: "saved-board-42",
      kind: "board" as const,
      connectionId: "jira-1",
      boardId: 42,
      boardName: "Engineering board",
      title: "Engineering board",
      mode: "issues" as const,
      sprintId: null,
      quickFilterIds: [],
      assignee: { kind: "user" as const, id: "bob", label: "Bob Builder" },
      doneWithinDays: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const state = {
      workspaceId: "jira:ws",
      profileId: "default",
      views: [{ viewId: "issues", kind: "issues", title: "Issues" }, savedView],
      activeViewId: savedView.viewId,
      syncByViewId: {},
    };
    transport.getJiraWorkspaceViews.mockResolvedValue(state);
    transport.setJiraWorkspaceActiveView.mockResolvedValue(state);
    transport.getJiraBoardView.mockResolvedValue({
      boardId: 42,
      mode: "issues",
      columns: [
        { name: "To Do", statuses: [{ id: "1", name: "Open" }] },
        { name: "In Progress", statuses: [{ id: "2", name: "Doing" }] },
        { name: "Done", statuses: [{ id: "3", name: "Closed" }] },
      ],
      issues: [
        {
          ref: { provider: "jira", connectionId: "jira-1", issueId: "1002", issueKey: "ENG-2" },
          summary: "Bob's task",
          status: "Doing",
          statusId: "2",
          assignee: "Bob Builder",
        },
      ],
      cache: { source: "cache", fetchedAt: Date.now(), stale: false },
    });
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws", jiraViewId: savedView.viewId } });
    await flushPromises();

    const chipTexts = () =>
      wrapper.findAll(".jira-native-view-toolbar__status").map((chip) => chip.text().replace(/\s+/g, " "));
    expect(chipTexts()).toEqual(["All 1", "Doing 1"]);

    await wrapper
      .findAll(".jira-native-view-toolbar__status")
      .find((chip) => chip.text().startsWith("Doing"))!
      .trigger("click");
    transport.getJiraBoardView.mockResolvedValue({
      boardId: 42,
      mode: "issues",
      columns: [
        { name: "To Do", statuses: [{ id: "1", name: "Open" }] },
        { name: "In Progress", statuses: [{ id: "2", name: "Doing" }] },
        { name: "Done", statuses: [{ id: "3", name: "Closed" }] },
      ],
      issues: [],
      cache: { source: "cache", fetchedAt: Date.now(), stale: false },
    });
    await wrapper
      .findAll(".jira-assignee-chip")
      .find((chip) => chip.text() === "All")!
      .trigger("click");
    await flushPromises();
    expect(chipTexts()).toEqual(["All 0", "Doing 0"]);
    wrapper.unmount();
  });

  test("shows a Data Center person once when a board tab reopens with them chosen", async () => {
    mockStoreState.transportApi = transport;
    mockStoreState.payload = reactive({
      appState: {
        activeProfileId: "default",
        workspaces: [{ id: "jira:ws", name: "Jira inbox", kind: "jira", profileId: "default" }],
      },
    });
    const savedView = {
      viewId: "saved-board-42",
      kind: "board" as const,
      connectionId: "jira-1",
      boardId: 42,
      boardName: "Engineering board",
      title: "Engineering board",
      mode: "issues" as const,
      sprintId: null,
      quickFilterIds: [],
      assignee: { kind: "user" as const, id: "bob", label: "Bob Builder" },
      doneWithinDays: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const state = {
      workspaceId: "jira:ws",
      profileId: "default",
      views: [{ viewId: "issues", kind: "issues", title: "Issues" }, savedView],
      activeViewId: savedView.viewId,
      syncByViewId: {},
    };
    transport.getJiraWorkspaceViews.mockResolvedValue(state);
    transport.setJiraWorkspaceActiveView.mockResolvedValue(state);
    const bob = {
      ref: { provider: "jira", connectionId: "jira-1", issueId: "1", issueKey: "ENG-1" },
      summary: "Bob's task",
      status: "Open",
      statusId: "1",
      assignee: "Bob Builder",
      assigneeRef: { kind: "data-center", key: "JIRAUSER7", name: "bob", displayName: "Bob Builder" },
    };
    transport.getJiraBoardView.mockResolvedValue({
      boardId: 42,
      mode: "issues",
      columns: [{ name: "To Do", statuses: [{ id: "1", name: "Open" }] }],
      issues: [bob],
      cache: { source: "cache", fetchedAt: Date.now(), stale: false },
    });
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws", jiraViewId: savedView.viewId } });
    await flushPromises();

    expect(
      wrapper
        .findAll(".jira-board-people .jira-assignee-chip")
        .filter((chip) => chip.attributes("aria-label") === "Bob Builder"),
    ).toHaveLength(1);
    wrapper.unmount();
  });

  test("shows a person once, narrows the loaded issues to them at once and keeps the status chips", async () => {
    mockStoreState.transportApi = transport;
    mockStoreState.payload = reactive({
      appState: {
        activeProfileId: "default",
        workspaces: [{ id: "jira:ws", name: "Jira inbox", kind: "jira", profileId: "default" }],
      },
    });
    const savedView = {
      viewId: "saved-board-42",
      kind: "board" as const,
      connectionId: "jira-1",
      boardId: 42,
      boardName: "Engineering board",
      title: "Engineering board",
      mode: "issues" as const,
      sprintId: null,
      quickFilterIds: [],
      assignee: null,
      doneWithinDays: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const state = {
      workspaceId: "jira:ws",
      profileId: "default",
      views: [{ viewId: "issues", kind: "issues", title: "Issues" }, savedView],
      activeViewId: savedView.viewId,
      syncByViewId: {},
    };
    transport.getJiraWorkspaceViews.mockResolvedValue(state);
    transport.setJiraWorkspaceActiveView.mockResolvedValue(state);
    transport.saveJiraWorkspaceView.mockResolvedValue(state);
    const issue = (
      id: string,
      summary: string,
      name: string,
      displayName: string,
      status = "Open",
      statusId = "1",
    ) => ({
      ref: { provider: "jira", connectionId: "jira-1", issueId: id, issueKey: `ENG-${id}` },
      summary,
      status,
      statusId,
      assignee: displayName,
      assigneeRef: { kind: "data-center", key: `JIRAUSER${id}`, name, displayName },
    });
    // No snapshot of the filtered board is cached yet: a saved tab waits for its background sync to fetch one.
    transport.getJiraBoardView.mockImplementation(async (input: { assignee?: unknown }) =>
      input.assignee
        ? null
        : {
            boardId: 42,
            mode: "issues",
            columns: [
              { name: "To Do", statuses: [{ id: "1", name: "Open" }] },
              { name: "In Progress", statuses: [{ id: "2", name: "Doing" }] },
            ],
            issues: [
              issue("1", "Bob's task", "bob", "Bob Builder"),
              issue("2", "Alice's task", "alice", "Alice", "Doing", "2"),
            ],
            cache: { source: "cache", fetchedAt: Date.now(), stale: false },
          },
    );
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws", jiraViewId: savedView.viewId } });
    await flushPromises();
    const people = () =>
      wrapper.findAll(".jira-board-people .jira-assignee-chip").map((chip) => chip.attributes("aria-label"));
    expect(people().filter((label) => label === "Bob Builder")).toHaveLength(1);
    const statusChips = () =>
      wrapper.findAll(".jira-native-view-toolbar__status").map((chip) => chip.text().replace(/\s+/g, " "));
    expect(statusChips()).toEqual(["All 2", "Open 1", "Doing 1"]);

    await wrapper
      .findAll(".jira-assignee-chip")
      .find((chip) => chip.attributes("aria-label") === "Bob Builder")!
      .trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain("Bob's task");
    expect(wrapper.text()).not.toContain("Alice's task");
    const chosen = wrapper.find('.jira-board-people .jira-assignee-chip[aria-pressed="true"]');
    expect(chosen.attributes("aria-label")).toBe("Bob Builder");
    expect(chosen.text()).toContain("Builder");
    expect(people().filter((label) => label === "Bob Builder")).toHaveLength(1);
    // Alice's status stays as a chip, so the row does not change width and move the people chips after it.
    expect(statusChips()).toEqual(["All 1", "Open 1", "Doing 0"]);
    wrapper.unmount();
  });

  test("does not continue a saved board load after its cached roster rejects on a tab switch", async () => {
    mockStoreState.transportApi = transport;
    mockStoreState.payload = reactive({
      appState: {
        activeProfileId: "default",
        workspaces: [{ id: "jira:ws", name: "Jira inbox", kind: "jira", profileId: "default" }],
      },
    });
    const savedView = {
      viewId: "saved-board-42",
      kind: "board" as const,
      connectionId: "jira-1",
      boardId: 42,
      boardName: "Engineering board",
      title: "Engineering board",
      mode: "issues" as const,
      sprintId: null,
      quickFilterIds: [],
      assignee: { kind: "user" as const, id: "alice", label: "Alice" },
      doneWithinDays: 14 as const,
      projectKeys: ["OPS"],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const state = {
      workspaceId: "jira:ws",
      profileId: "default",
      views: [{ viewId: "issues", kind: "issues", title: "Issues" }, savedView],
      activeViewId: savedView.viewId,
      syncByViewId: {},
    };
    transport.getJiraWorkspaceViews.mockResolvedValue(state);
    transport.setJiraWorkspaceActiveView.mockResolvedValue(state);
    let rejectRoster!: (reason: Error) => void;
    transport.getJiraBoardView.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectRoster = reject;
      }),
    );

    const JiraPaneHost = defineComponent({
      props: {
        workspaceId: { type: String, required: true },
        jiraViewId: { type: String, required: true },
      },
      setup(props) {
        return () => h(JiraInboxPane, { workspaceId: props.workspaceId, jiraViewId: props.jiraViewId });
      },
    });
    const wrapper = mount(JiraPaneHost, {
      props: { workspaceId: "jira:ws", jiraViewId: savedView.viewId },
    });
    await vi.waitFor(() => expect(transport.getJiraBoardView).toHaveBeenCalledTimes(1));
    await wrapper.setProps({ jiraViewId: "issues" });
    await flushPromises();
    rejectRoster(new Error("Cached roster unavailable"));
    await flushPromises();

    expect(transport.getJiraBoardView).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  test("keeps native saved board date filters isolated from Issues preferences and exposes native board options", async () => {
    mockStoreState.transportApi = transport;
    transport.listJiraBoards.mockResolvedValue([{ id: 42, name: "Engineering board", type: "scrum" }]);
    writeJiraViewPreferences("default", "jira:ws", { doneWithinDays: 90 });
    const savedView = {
      viewId: "saved-board-42",
      kind: "board" as const,
      connectionId: "jira-1",
      boardId: 42,
      boardName: "Engineering board",
      title: "Engineering board",
      mode: "issues" as const,
      sprintId: null,
      quickFilterIds: [],
      assignee: null,
      doneWithinDays: 7 as const,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    transport.getJiraWorkspaceViews.mockResolvedValue({
      workspaceId: "jira:ws",
      profileId: "default",
      views: [{ viewId: "issues", kind: "issues", title: "Issues" }, savedView],
      activeViewId: savedView.viewId,
      syncByViewId: {},
    });
    transport.saveJiraWorkspaceView.mockResolvedValue({
      workspaceId: "jira:ws",
      profileId: "default",
      views: [{ viewId: "issues", kind: "issues", title: "Issues" }, savedView],
      activeViewId: savedView.viewId,
      syncByViewId: {},
    });
    transport.getJiraBoardView.mockResolvedValue({
      boardId: 42,
      mode: "issues",
      columns: [{ name: "Open", statuses: [{ id: "1", name: "Open" }] }],
      issues: [],
      cache: { source: "cache", fetchedAt: Date.now(), stale: false },
    });

    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws", jiraViewId: savedView.viewId } });
    await flushPromises();

    expect(transport.getJiraBoardView).toHaveBeenCalledWith(
      expect.objectContaining({ boardId: 42, doneWithinDays: 7, cacheOnly: true }),
    );
    expect(wrapper.find(".jira-board-options").exists()).toBe(true);
    expect(wrapper.find(".jira-head h2").text()).toBe("Engineering board");
    await chooseCustomSelect(wrapper, ".jira-board-options", "backlog");
    expect(transport.getJiraBoardView).toHaveBeenLastCalledWith(
      expect.objectContaining({ boardId: 42, mode: "backlog" }),
    );
    wrapper.unmount();
    await flushPromises();
    expect(transport.saveJiraWorkspaceView).toHaveBeenCalledWith({
      workspaceId: "jira:ws",
      view: expect.objectContaining({ viewId: savedView.viewId, boardId: 42, mode: "backlog" }),
    });
    expect(transport.activateView).not.toHaveBeenCalled();
  });

  test("restores a saved all-time board without injecting the default completion window", async () => {
    mockStoreState.transportApi = transport;
    const savedView = {
      viewId: "saved-board-all-time",
      kind: "board" as const,
      connectionId: "jira-1",
      boardId: 42,
      boardName: "Engineering board",
      title: "Engineering board",
      mode: "issues" as const,
      sprintId: null,
      quickFilterIds: [],
      assignee: null,
      doneWithinDays: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    transport.getJiraWorkspaceViews.mockResolvedValue({
      workspaceId: "jira:ws",
      profileId: "default",
      views: [{ viewId: "issues", kind: "issues", title: "Issues" }, savedView],
      activeViewId: savedView.viewId,
      syncByViewId: {},
    });
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws", jiraViewId: savedView.viewId } });
    await flushPromises();
    expect(transport.getJiraBoardView).toHaveBeenCalledWith(
      expect.not.objectContaining({ doneWithinDays: expect.anything() }),
    );
    wrapper.unmount();
  });

  test("restores a saved backlog mode before board metadata arrives", async () => {
    mockStoreState.transportApi = transport;
    transport.listJiraBoards.mockResolvedValue([{ id: 42, name: "Engineering board", type: "scrum" }]);
    const savedView = {
      viewId: "saved-board-backlog",
      kind: "board" as const,
      connectionId: "jira-1",
      boardId: 42,
      boardName: "Engineering board",
      title: "Engineering board",
      mode: "backlog" as const,
      sprintId: null,
      quickFilterIds: [],
      assignee: null,
      doneWithinDays: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    transport.getJiraWorkspaceViews.mockResolvedValue({
      workspaceId: "jira:ws",
      profileId: "default",
      views: [{ viewId: "issues", kind: "issues", title: "Issues" }, savedView],
      activeViewId: savedView.viewId,
      syncByViewId: {},
    });
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws", jiraViewId: savedView.viewId } });
    await flushPromises();
    expect(transport.getJiraBoardView).toHaveBeenCalledWith(
      expect.objectContaining({ boardId: 42, mode: "backlog", cacheOnly: true }),
    );
    wrapper.unmount();
  });

  test("native mobile presentation filters locally, keeps detail open and persists per-view choices without Jira refresh", async () => {
    mockStoreState.transportApi = transport;
    mockStoreState.isMobileSession = true;
    transport.listJiraBoards.mockResolvedValue([{ id: 42, name: "Engineering board", type: "kanban" }]);
    const savedView = {
      viewId: "saved-mobile-board",
      kind: "board" as const,
      connectionId: "jira-1",
      boardId: 42,
      boardName: "Engineering board",
      title: "Custom Ops view",
      mode: "issues" as const,
      sprintId: null,
      quickFilterIds: [],
      assignee: null,
      doneWithinDays: 14 as const,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const state = {
      workspaceId: "jira:ws",
      profileId: "default",
      views: [{ viewId: "issues", kind: "issues", title: "Issues" }, savedView],
      activeViewId: savedView.viewId,
      syncByViewId: {},
    };
    transport.getJiraWorkspaceViews.mockResolvedValue(state);
    transport.saveJiraWorkspaceView.mockResolvedValue({
      ...state,
      views: [state.views[0]!, { ...savedView, presentation: "board", statusFilter: "id:3" }],
    });
    transport.getJiraBoardView.mockResolvedValue({
      boardId: 42,
      mode: "issues",
      columns: [
        { name: "To Do", statuses: [{ id: "1", name: "Open" }] },
        { name: "In Progress", statuses: [{ id: "2", name: "Doing" }] },
        { name: "Done", statuses: [{ id: "3", name: "Done" }] },
      ],
      issues: [
        {
          ref: { provider: "jira", connectionId: "jira-1", issueId: "1001", issueKey: "ENG-1" },
          summary: "Open task",
          status: "Open",
          statusId: "1",
        },
        {
          ref: { provider: "jira", connectionId: "jira-1", issueId: "1002", issueKey: "ENG-2" },
          summary: "Active task",
          status: "Doing",
          statusId: "2",
        },
        {
          ref: { provider: "jira", connectionId: "jira-1", issueId: "1003", issueKey: "ENG-3" },
          summary: "Finished task",
          status: "Done",
          statusId: "3",
        },
      ],
      cache: { source: "cache", fetchedAt: Date.now(), stale: false },
    });
    const wrapper = mount(JiraInboxPane, {
      props: { workspaceId: "jira:ws", jiraViewId: savedView.viewId },
      attachTo: document.body,
    });
    await flushPromises();

    expect(wrapper.get(".jira-inbox").classes()).toContain("jira-inbox--native-list");
    const mobileStatusPicker = wrapper.find(".jira-native-view-toolbar__status-picker").findComponent(CustomSelect);
    expect(customSelectProps(mobileStatusPicker).options.map((option) => option.label)).toEqual([
      "All · 3",
      "Open · 1",
      "Doing · 1",
      "Done · 1",
    ]);
    const initialBoardReadCount = transport.getJiraBoardView.mock.calls.length;
    await chooseCustomSelect(wrapper, ".jira-native-view-toolbar__status-picker", "id:1");
    expect(wrapper.findAll(".jira-native-issue-list__item").map((button) => button.text())).toHaveLength(1);
    expect(wrapper.text()).toContain("Open task");
    expect(wrapper.text()).not.toContain("Active task");
    const activeStatusPicker = wrapper.find(".jira-native-view-toolbar__status-select");
    (activeStatusPicker.element as HTMLButtonElement).focus();
    expect(document.activeElement).toBe(activeStatusPicker.element);
    await chooseCustomSelect(wrapper, ".jira-native-view-toolbar__status-picker", "__all__");
    expect(wrapper.findAll(".jira-native-issue-list__item")).toHaveLength(3);
    await wrapper.get(".jira-native-issue-list__toolbar input").setValue("Open task");
    expect(wrapper.findAll(".jira-native-issue-list__item")).toHaveLength(1);

    await wrapper.get(".jira-native-issue-list__item").trigger("click");
    await flushPromises();
    expect(wrapper.find(".jira-detail").exists()).toBe(true);
    expect(wrapper.find(".jira-detail").text()).toContain("ENG-1");
    await wrapper
      .findAll(".jira-native-view-toolbar__mode")
      .find((button) => button.text() === "Board")!
      .trigger("click");
    expect(wrapper.find(".jira-detail").exists()).toBe(true);
    expect(wrapper.find(".jira-inbox--native-list").exists()).toBe(false);
    expect(wrapper.find(".jira-board-column__header strong").text()).toContain("Open");
    expect(wrapper.find(".jira-board-column__count").text()).toBe("1");
    expect(wrapper.findAll(".jira-board-column .jira-board-issue")).toHaveLength(1);
    expect(wrapper.text()).toContain("Open task");
    expect(wrapper.find(".jira-native-board-filter-indicator").exists()).toBe(true);
    await wrapper.get(".jira-native-board-filter-indicator button").trigger("click");
    expect(wrapper.find(".jira-native-board-filter-indicator").exists()).toBe(false);
    expect(wrapper.findAll(".jira-board-column .jira-board-issue")).toHaveLength(3);
    await chooseCustomSelect(wrapper, ".jira-native-view-toolbar__status-picker", "id:3");
    expect(wrapper.find(".jira-detail").exists()).toBe(true);
    expect(wrapper.find(".jira-board-column__header strong").text()).toContain("Done");
    await wrapper
      .findAll(".jira-native-view-toolbar__mode")
      .find((button) => button.text() === "List")!
      .trigger("click");
    await chooseCustomSelect(wrapper, ".jira-native-view-toolbar__status-picker", "__all__");
    expect(
      customSelectProps(wrapper.find(".jira-native-view-toolbar__status-picker").findComponent(CustomSelect)).options[0]
        ?.label,
    ).toBe("All · 3");
    expect(transport.getJiraBoardView).toHaveBeenCalledTimes(initialBoardReadCount);
    expect(transport.searchJiraIssues).not.toHaveBeenCalledWith(expect.objectContaining({ forceRefresh: true }));

    await new Promise((resolve) => setTimeout(resolve, 300));
    await flushPromises();
    expect(transport.saveJiraWorkspaceView).toHaveBeenLastCalledWith({
      workspaceId: "jira:ws",
      view: expect.objectContaining({
        viewId: savedView.viewId,
        title: "Custom Ops view",
        presentation: "list",
        statusFilter: null,
      }),
    });
    wrapper.unmount();
  });

  test("restores native mobile List scroll and issue focus after Back and keeps Board scroll separately", async () => {
    mockStoreState.transportApi = transport;
    mockStoreState.isMobileSession = true;
    const savedView = {
      viewId: "saved-mobile-scroll",
      kind: "personal" as const,
      connectionId: "jira-1",
      boardId: null,
      boardName: "My issues",
      title: "My issues",
      mode: "issues" as const,
      sprintId: null,
      quickFilterIds: [],
      assignee: null,
      doneWithinDays: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const state: JiraWorkspaceViewsState = {
      workspaceId: "jira:ws",
      profileId: "default",
      views: [{ viewId: "issues", kind: "issues", title: "Issues" }, savedView],
      activeViewId: savedView.viewId,
      syncByViewId: { [savedView.viewId]: { state: "syncing", startedAt: Date.now() } },
    };
    mockStoreState.payload = reactive({
      appState: {
        activeProfileId: "default",
        workspaces: [{ id: "jira:ws", name: "Jira inbox", kind: "jira", profileId: "default" }],
      },
      jiraWorkspaceViews: { "jira:ws": state },
    });
    mockStoreState.transportApi = transport;
    transport.getJiraWorkspaceViews.mockResolvedValue(state);
    transport.searchJiraIssues.mockResolvedValueOnce({
      issues: [
        {
          ref: { provider: "jira", connectionId: "jira-1", issueId: "4006", issueKey: "OPS-406" },
          summary: "First open ticket",
          status: "Open",
          statusId: "1",
          statusCategory: "new",
        },
        {
          ref: { provider: "jira", connectionId: "jira-1", issueId: "4007", issueKey: "OPS-407" },
          summary: "Another open ticket",
          status: "Open",
          statusId: "1",
          statusCategory: "new",
        },
        {
          ref: { provider: "jira", connectionId: "jira-1", issueId: "4008", issueKey: "OPS-408" },
          summary: "Selected open ticket",
          status: "Open",
          statusId: "1",
          statusCategory: "new",
        },
      ],
      hasMore: false,
      cache: { source: "cache", fetchedAt: Date.now(), stale: false },
    });
    transport.getJiraIssue.mockResolvedValue({
      ref: { provider: "jira", connectionId: "jira-1", issueId: "4008", issueKey: "OPS-408" },
      summary: "Selected open ticket",
      status: "Open",
    });

    const wrapper = mount(JiraInboxPane, {
      attachTo: document.body,
      props: { workspaceId: "jira:ws", jiraViewId: savedView.viewId },
    });
    await flushPromises();
    const initialList = wrapper.get(".jira-native-issue-list");
    (initialList.element as HTMLElement).scrollTop = 900;
    initialList.element.dispatchEvent(new Event("scroll"));
    const clickedIssue = wrapper.get('[data-issue-id="4008"]');
    await clickedIssue.trigger("click");
    await flushPromises();
    expect(wrapper.find(".jira-detail").exists()).toBe(true);
    await wrapper.get(".jira-detail__back").trigger("click");
    await flushPromises();
    const restoredList = wrapper.get(".jira-native-issue-list");
    expect((restoredList.element as HTMLElement).scrollTop).toBe(900);
    const restoredIssue = restoredList.get('[data-issue-id="4008"]');
    expect(document.activeElement).toBe(restoredIssue.element);

    mockStoreState.isMobileSession = false;
    window.dispatchEvent(new Event("resize"));
    await flushPromises();
    expect(wrapper.find(".jira-native-issue-list").exists()).toBe(false);
    const boardCards = wrapper.get(".jira-board-column__cards");
    (boardCards.element as HTMLElement).scrollTop = 420;
    boardCards.element.dispatchEvent(new Event("scroll"));
    mockStoreState.isMobileSession = true;
    window.dispatchEvent(new Event("resize"));
    await flushPromises();
    expect((wrapper.get(".jira-native-issue-list").element as HTMLElement).scrollTop).toBe(900);
    mockStoreState.isMobileSession = false;
    window.dispatchEvent(new Event("resize"));
    await flushPromises();
    expect((wrapper.get(".jira-board-column__cards").element as HTMLElement).scrollTop).toBe(420);
    wrapper.unmount();
  });

  test("switching a saved sprint tab to Backlog clears sprint scope before a quick leave", async () => {
    mockStoreState.transportApi = transport;
    transport.listJiraBoards.mockResolvedValue([{ id: 42, name: "Engineering board", type: "scrum" }]);
    const savedView = {
      viewId: "saved-board-sprint-to-backlog",
      kind: "board" as const,
      connectionId: "jira-1",
      boardId: 42,
      boardName: "Engineering board",
      title: "Engineering board",
      mode: "sprints" as const,
      sprintId: 51,
      quickFilterIds: [],
      assignee: null,
      doneWithinDays: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const initialState = {
      workspaceId: "jira:ws",
      profileId: "default",
      views: [{ viewId: "issues", kind: "issues", title: "Issues" }, savedView],
      activeViewId: savedView.viewId,
      syncByViewId: {},
    };
    const updatedView = { ...savedView, mode: "backlog" as const, sprintId: null };
    const updatedState = { ...initialState, views: [initialState.views[0]!, updatedView] };
    transport.getJiraWorkspaceViews.mockResolvedValueOnce(initialState).mockResolvedValue(updatedState);
    transport.saveJiraWorkspaceView.mockResolvedValue(updatedState);
    transport.getJiraBoardView.mockResolvedValueOnce({
      boardId: 42,
      mode: "sprints",
      sprintId: 51,
      sprints: [{ id: 51, name: "Sprint 51", state: "active" }],
      issues: [],
      columns: [],
      cache: { source: "cache", fetchedAt: Date.now(), stale: false },
    });

    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws", jiraViewId: savedView.viewId } });
    await flushPromises();
    await chooseCustomSelect(wrapper, ".jira-board-options", "backlog");
    expect(transport.getJiraBoardView).toHaveBeenLastCalledWith(
      expect.objectContaining({ boardId: 42, mode: "backlog", cacheOnly: true }),
    );
    expect(transport.getJiraBoardView).not.toHaveBeenLastCalledWith(expect.objectContaining({ sprintId: 51 }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    await flushPromises();
    expect(transport.saveJiraWorkspaceView).toHaveBeenLastCalledWith({
      workspaceId: "jira:ws",
      view: expect.objectContaining({ viewId: savedView.viewId, mode: "backlog", sprintId: null }),
    });
    wrapper.unmount();

    const reopened = mount(JiraInboxPane, { props: { workspaceId: "jira:ws", jiraViewId: savedView.viewId } });
    await flushPromises();
    expect(transport.getJiraBoardView).toHaveBeenLastCalledWith(
      expect.objectContaining({ boardId: 42, mode: "backlog", cacheOnly: true }),
    );
    expect(transport.getJiraBoardView).not.toHaveBeenLastCalledWith(expect.objectContaining({ sprintId: 51 }));
    reopened.unmount();
  });

  test("renders and cache-refreshes a saved sprint while keeping its issue detail open", async () => {
    mockStoreState.transportApi = transport;
    transport.listJiraBoards.mockResolvedValue([{ id: 42, name: "Engineering board", type: "scrum" }]);
    const savedView = {
      viewId: "saved-board-sprint",
      kind: "board" as const,
      connectionId: "jira-1",
      boardId: 42,
      boardName: "Engineering board",
      title: "Engineering board",
      mode: "sprints" as const,
      sprintId: 51,
      quickFilterIds: [],
      assignee: null,
      doneWithinDays: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const state: JiraWorkspaceViewsState = {
      workspaceId: "jira:ws",
      profileId: "default",
      views: [{ viewId: "issues", kind: "issues", title: "Issues" }, savedView],
      activeViewId: savedView.viewId,
      syncByViewId: { [savedView.viewId]: { state: "syncing" as const, startedAt: Date.now() } },
    };
    const payload = reactive({
      appState: {
        activeProfileId: "default",
        workspaces: [{ id: "jira:ws", name: "Jira inbox", kind: "jira", profileId: "default" }],
      },
      jiraWorkspaceViews: { "jira:ws": state },
    });
    mockStoreState.payload = payload;
    transport.getJiraWorkspaceViews.mockResolvedValue(state);
    const issue = {
      ref: { provider: "jira", connectionId: "jira-1", issueId: "5101", issueKey: "ENG-51" },
      summary: "Cached sprint issue",
      status: "In Progress",
      statusId: "2",
    };
    transport.getJiraBoardView.mockResolvedValueOnce({
      boardId: 42,
      mode: "sprints",
      sprintId: 51,
      sprints: [{ id: 51, name: "Sprint 51", state: "active" }],
      issues: [issue],
      columns: [],
      cache: { source: "cache", fetchedAt: Date.now(), stale: false },
    });
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws", jiraViewId: savedView.viewId } });
    await flushPromises();
    expect(transport.getJiraBoardView).toHaveBeenCalledWith(
      expect.objectContaining({ boardId: 42, mode: "sprints", sprintId: 51, cacheOnly: true }),
    );
    expect(wrapper.text()).toContain("Cached sprint issue");
    expect(wrapper.find(".jira-sprint-bar").text()).toContain("Sprint 51");
    expect(wrapper.find(".jira-sprint-bar").text()).not.toContain("unknown state");
    await wrapper.get(".jira-sprints .jira-issue").trigger("click");
    await flushPromises();
    expect(wrapper.find(".jira-detail").exists()).toBe(true);
    transport.getJiraBoardView.mockResolvedValueOnce({
      boardId: 42,
      mode: "sprints",
      sprintId: 51,
      sprints: [],
      issues: [{ ...issue, summary: "Updated sprint issue" }],
      columns: [],
      cache: { source: "cache", fetchedAt: Date.now(), stale: false },
    });
    payload.jiraWorkspaceViews["jira:ws"] = {
      ...state,
      syncByViewId: { [savedView.viewId]: { state: "idle", syncedAt: Date.now() } },
    };
    await flushPromises();
    expect(wrapper.text()).toContain("Updated sprint issue");
    expect(wrapper.find(".jira-sprint-bar").text()).toContain("Selected sprint");
    expect(wrapper.find(".jira-sprint-bar").text()).not.toContain("unknown state");
    expect(wrapper.find(".jira-detail").exists()).toBe(true);
    wrapper.unmount();
  });

  test("refreshes a native My issues tab from cache after sync and keeps its selected detail open", async () => {
    mockStoreState.transportApi = transport;
    const savedView = {
      viewId: "saved-personal",
      kind: "personal" as const,
      connectionId: "jira-1",
      boardId: null,
      boardName: "My issues",
      title: "My issues",
      mode: "issues" as const,
      sprintId: null,
      quickFilterIds: [],
      assignee: null,
      doneWithinDays: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const state: JiraWorkspaceViewsState = {
      workspaceId: "jira:ws",
      profileId: "default",
      views: [{ viewId: "issues", kind: "issues", title: "Issues" }, savedView],
      activeViewId: savedView.viewId,
      syncByViewId: { [savedView.viewId]: { state: "idle" as const, syncedAt: Date.now() } },
    };
    const payload = reactive({
      appState: {
        activeProfileId: "default",
        workspaces: [{ id: "jira:ws", name: "Jira inbox", kind: "jira", profileId: "default" }],
      },
      jiraWorkspaceViews: { "jira:ws": state },
    });
    mockStoreState.payload = payload;
    transport.getJiraWorkspaceViews.mockResolvedValue(state);
    transport.refreshJiraWorkspaceViews.mockResolvedValue(state);
    const originalIssue = {
      ref: { provider: "jira", connectionId: "jira-1", issueId: "1001", issueKey: "ENG-1" },
      summary: "Cached summary",
      status: "Open",
      statusId: "1",
      statusCategory: "new" as const,
    };
    transport.searchJiraIssues.mockResolvedValueOnce({
      issues: [originalIssue],
      hasMore: false,
      cache: { source: "cache", fetchedAt: Date.now(), stale: false },
    });
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws", jiraViewId: savedView.viewId } });
    await flushPromises();
    expect(transport.searchJiraIssues).toHaveBeenCalledWith(
      expect.objectContaining({ jql: 'assignee = "alice" ORDER BY updated DESC', cacheOnly: true }),
    );
    expect(transport.searchJiraIssues).not.toHaveBeenCalledWith(expect.objectContaining({ forceRefresh: true }));

    await wrapper.get(".jira-board-issue").trigger("click");
    await flushPromises();
    expect(wrapper.find(".jira-detail").exists()).toBe(true);
    const detailReadsBeforeRefresh = transport.getJiraIssue.mock.calls.length;
    await wrapper.get(".jira-head__refresh").trigger("click");
    await flushPromises();
    expect(transport.getJiraIssue.mock.calls.length).toBeGreaterThan(detailReadsBeforeRefresh);
    const refreshedIssue = { ...originalIssue, summary: "Updated after sync" };
    transport.searchJiraIssues.mockResolvedValueOnce({
      issues: [refreshedIssue],
      hasMore: false,
      cache: { source: "cache", fetchedAt: Date.now(), stale: false },
    });
    payload.jiraWorkspaceViews["jira:ws"] = {
      ...state,
      syncByViewId: { [savedView.viewId]: { state: "idle", syncedAt: Date.now() } },
    };
    await flushPromises();
    expect(transport.searchJiraIssues).toHaveBeenLastCalledWith(
      expect.objectContaining({ jql: 'assignee = "alice" ORDER BY updated DESC', cacheOnly: true }),
    );
    expect(wrapper.find(".jira-detail").exists()).toBe(true);
    expect(wrapper.find(".jira-detail").text()).toContain("ENG-1");
    expect(wrapper.text()).toContain("Updated after sync");
    wrapper.unmount();
  });

  test("personal view defaults to Open and can restore All from its synchronized cache", async () => {
    mockStoreState.transportApi = transport;
    mockStoreState.isMobileSession = true;
    const savedView = {
      viewId: "saved-personal-scope",
      kind: "personal" as const,
      connectionId: "jira-1",
      boardId: null,
      boardName: "My issues",
      title: "My issues",
      mode: "issues" as const,
      sprintId: null,
      quickFilterIds: [],
      assignee: null,
      doneWithinDays: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const state: JiraWorkspaceViewsState = {
      workspaceId: "jira:ws",
      profileId: "default",
      views: [{ viewId: "issues", kind: "issues", title: "Issues" }, savedView],
      activeViewId: savedView.viewId,
      syncByViewId: { [savedView.viewId]: { state: "syncing", startedAt: Date.now() } },
    };
    const payload = reactive({
      appState: {
        activeProfileId: "default",
        workspaces: [{ id: "jira:ws", name: "Jira inbox", kind: "jira", profileId: "default" }],
      },
      jiraWorkspaceViews: { "jira:ws": state },
    });
    mockStoreState.payload = payload;
    transport.getJiraWorkspaceViews.mockResolvedValue(state);
    transport.buildJiraOwnIssuesQuery.mockImplementation(async ({ personalScope }) => ({
      jql:
        personalScope === "all"
          ? 'assignee = "alice" ORDER BY updated DESC'
          : 'assignee = "alice" AND statusCategory != Done ORDER BY updated DESC',
      identityLabel: "Alice",
    }));
    const openIssue = {
      ref: { provider: "jira", connectionId: "jira-1", issueId: "1001", issueKey: "ENG-1" },
      summary: "Open ticket",
      status: "In Progress",
      statusCategory: "indeterminate" as const,
    };
    const doneIssue = {
      ref: { provider: "jira", connectionId: "jira-1", issueId: "1002", issueKey: "ENG-2" },
      summary: "Recently closed ticket",
      status: "Closed",
      statusCategory: "done" as const,
    };
    transport.searchJiraIssues.mockResolvedValueOnce({
      issues: [openIssue],
      hasMore: false,
      cache: { source: "cache", fetchedAt: Date.now(), stale: false },
    });

    const wrapper = mount(JiraInboxPane, {
      props: { workspaceId: "jira:ws", jiraViewId: savedView.viewId },
    });
    await flushPromises();
    expect(transport.buildJiraOwnIssuesQuery).toHaveBeenCalledWith({ connectionId: "jira-1", personalScope: "open" });
    expect(transport.searchJiraIssues).toHaveBeenCalledWith(
      expect.objectContaining({
        jql: 'assignee = "alice" AND statusCategory != Done ORDER BY updated DESC',
        cacheOnly: true,
      }),
    );
    expect(wrapper.text()).toContain("Open only");
    expect(wrapper.text()).not.toContain("Recently closed ticket");

    const allState: JiraWorkspaceViewsState = {
      ...state,
      views: [state.views[0]!, { ...savedView, personalScope: "all" }],
      syncByViewId: { [savedView.viewId]: { state: "syncing", startedAt: Date.now() } },
    };
    transport.saveJiraWorkspaceView.mockResolvedValue(allState);
    await wrapper.get(".jira-personal-scope > summary").trigger("click");
    await chooseCustomSelect(wrapper, ".jira-personal-scope", "all");
    await new Promise((resolve) => setTimeout(resolve, 300));
    await flushPromises();
    expect(transport.saveJiraWorkspaceView).toHaveBeenLastCalledWith({
      workspaceId: "jira:ws",
      view: expect.objectContaining({ kind: "personal", personalScope: "all" }),
    });

    transport.searchJiraIssues.mockResolvedValueOnce({
      issues: [openIssue, doneIssue],
      hasMore: false,
      cache: { source: "cache", fetchedAt: Date.now(), stale: false },
    });
    payload.jiraWorkspaceViews["jira:ws"] = {
      ...allState,
      syncByViewId: { [savedView.viewId]: { state: "idle", syncedAt: Date.now() } },
    };
    await flushPromises();
    expect(transport.buildJiraOwnIssuesQuery).toHaveBeenLastCalledWith({
      connectionId: "jira-1",
      personalScope: "all",
    });
    expect(transport.searchJiraIssues).toHaveBeenLastCalledWith(
      expect.objectContaining({ jql: 'assignee = "alice" ORDER BY updated DESC', cacheOnly: true }),
    );
    expect(wrapper.text()).toContain("Recently closed ticket");
    expect(wrapper.text()).toContain("All issues");
    expect(transport.searchJiraIssues).not.toHaveBeenCalledWith(expect.objectContaining({ forceRefresh: true }));
    wrapper.unmount();
  });

  test("persists the project scope on a native My issues view and applies it to the personal query and result read", async () => {
    mockStoreState.transportApi = transport;
    const savedView = {
      viewId: "personal-scope-project-test",
      kind: "personal" as const,
      connectionId: "jira-1",
      boardId: null,
      boardName: "My issues",
      title: "My issues",
      mode: "issues" as const,
      sprintId: null,
      quickFilterIds: [],
      assignee: null,
      doneWithinDays: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const state: JiraWorkspaceViewsState = {
      workspaceId: "jira:ws",
      profileId: "default",
      views: [{ viewId: "issues", kind: "issues", title: "Issues" }, savedView],
      activeViewId: savedView.viewId,
      syncByViewId: { [savedView.viewId]: { state: "syncing", startedAt: Date.now() } },
    };
    mockStoreState.payload = reactive({
      appState: {
        activeProfileId: "default",
        workspaces: [{ id: "jira:ws", name: "Jira inbox", kind: "jira", profileId: "default" }],
      },
      jiraWorkspaceViews: { "jira:ws": state },
    });
    transport.getJiraWorkspaceViews.mockResolvedValue(state);
    transport.saveJiraWorkspaceView.mockResolvedValue(state);
    transport.searchJiraIssues.mockResolvedValue({
      issues: [
        {
          ref: { provider: "jira", connectionId: "jira-1", issueId: "1", issueKey: "OPS-1" },
          summary: "Operations issue",
        },
      ],
      hasMore: false,
      cache: { source: "cache", fetchedAt: Date.now(), stale: false },
    });

    const wrapper = mount(JiraInboxPane, {
      props: { workspaceId: "jira:ws", jiraViewId: savedView.viewId },
    });
    await flushPromises();
    expect(transport.listJiraProjects).not.toHaveBeenCalled();
    await wrapper.get(".jira-project-scope-picker > summary").trigger("click");
    await flushPromises();
    await wrapper.get(".jira-project-scope-picker__search input").setValue("OPS");
    await wrapper.get('.jira-project-scope-picker__project input[type="checkbox"]').setValue(true);
    await wrapper.get(".jira-project-scope-picker__apply").trigger("click");
    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await flushPromises();
    expect(wrapper.get(".jira-personal-scope > summary").text()).toContain("OPS");

    expect(transport.buildJiraOwnIssuesQuery).toHaveBeenLastCalledWith({
      connectionId: "jira-1",
      personalScope: "open",
      projectKeys: ["OPS"],
    });
    expect(transport.searchJiraIssues).toHaveBeenLastCalledWith(
      expect.objectContaining({
        connectionId: "jira-1",
        cacheOnly: true,
        projectKeys: ["OPS"],
      }),
    );
    expect(transport.saveJiraWorkspaceView).toHaveBeenLastCalledWith({
      workspaceId: "jira:ws",
      view: expect.objectContaining({ kind: "personal", projectKeys: ["OPS"] }),
    });
    wrapper.unmount();
  });

  test("persists Use defaults as a null project override on a native My issues view", async () => {
    mockStoreState.transportApi = transport;
    const savedView = {
      viewId: "personal-scope-clear-test",
      kind: "personal" as const,
      connectionId: "jira-1",
      boardId: null,
      boardName: "My issues",
      title: "My issues",
      mode: "issues" as const,
      sprintId: null,
      quickFilterIds: [],
      assignee: null,
      doneWithinDays: null,
      projectKeys: ["PLAT"],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const state: JiraWorkspaceViewsState = {
      workspaceId: "jira:ws",
      profileId: "default",
      views: [{ viewId: "issues", kind: "issues", title: "Issues" }, savedView],
      activeViewId: savedView.viewId,
      syncByViewId: { [savedView.viewId]: { state: "idle", syncedAt: Date.now() } },
    };
    const storePayload = reactive({
      appState: {
        activeProfileId: "default",
        workspaces: [{ id: "jira:ws", name: "Jira inbox", kind: "jira", profileId: "default" }],
      },
      jiraWorkspaceViews: { "jira:ws": state },
    });
    mockStoreState.payload = storePayload;
    transport.getJiraWorkspaceViews.mockResolvedValue(state);
    transport.buildJiraOwnIssuesQuery.mockResolvedValue({
      jql: 'assignee = "alice" AND statusCategory != Done ORDER BY updated DESC',
      identityLabel: "Alice",
    });
    transport.searchJiraIssues.mockResolvedValue({
      issues: [],
      hasMore: false,
      cache: { source: "cache", fetchedAt: Date.now(), stale: false },
    });
    transport.saveJiraWorkspaceView.mockImplementation(async ({ view }) => {
      const nextViews = state.views.map((item) => {
        if (item.viewId !== savedView.viewId) return item;
        const { projectKeys, ...input } = view;
        return {
          ...savedView,
          ...input,
          ...(projectKeys === null
            ? { projectKeys: undefined }
            : projectKeys === undefined
              ? {}
              : { projectKeys: [...projectKeys] }),
        };
      });
      state.views = nextViews;
      const nextState = { ...state, views: nextViews };
      storePayload.jiraWorkspaceViews["jira:ws"] = nextState;
      return nextState;
    });

    const wrapper = mount(JiraInboxPane, {
      props: { workspaceId: "jira:ws", jiraViewId: savedView.viewId },
    });
    await flushPromises();
    await wrapper.get(".jira-personal-scope > summary").trigger("click");
    await wrapper.get(".jira-project-scope-picker > summary").trigger("click");
    await wrapper
      .findAll(".jira-project-scope-picker__modes button")
      .find((button) => button.text() === "Use defaults")!
      .trigger("click");
    await wrapper.get(".jira-project-scope-picker__apply").trigger("click");
    await new Promise((resolve) => setTimeout(resolve, 300));
    await flushPromises();
    expect(transport.saveJiraWorkspaceView).toHaveBeenLastCalledWith({
      workspaceId: "jira:ws",
      view: expect.objectContaining({ kind: "personal", projectKeys: null }),
    });

    await wrapper.get(".jira-project-scope-picker > summary").trigger("click");
    await wrapper
      .findAll(".jira-project-scope-picker__modes button")
      .find((button) => button.text() === "All projects")!
      .trigger("click");
    await wrapper.get(".jira-project-scope-picker__apply").trigger("click");
    await new Promise((resolve) => setTimeout(resolve, 300));
    await flushPromises();
    expect(transport.saveJiraWorkspaceView).toHaveBeenLastCalledWith({
      workspaceId: "jira:ws",
      view: expect.objectContaining({ kind: "personal", projectKeys: [] }),
    });

    await wrapper.get(".jira-project-scope-picker > summary").trigger("click");
    await wrapper
      .findAll(".jira-project-scope-picker__modes button")
      .find((button) => button.text() === "Use defaults")!
      .trigger("click");
    await wrapper.get(".jira-project-scope-picker__apply").trigger("click");
    await new Promise((resolve) => setTimeout(resolve, 300));
    await flushPromises();
    expect(transport.saveJiraWorkspaceView).toHaveBeenLastCalledWith({
      workspaceId: "jira:ws",
      view: expect.objectContaining({ kind: "personal", projectKeys: null }),
    });
    wrapper.unmount();
  });

  test("shows a loading state instead of an empty message while the first personal sync is running", async () => {
    mockStoreState.transportApi = transport;
    mockStoreState.isMobileSession = true;
    const savedView = {
      viewId: "saved-personal-first-sync",
      kind: "personal" as const,
      connectionId: "jira-1",
      boardId: null,
      boardName: "My issues",
      title: "My issues",
      mode: "issues" as const,
      sprintId: null,
      quickFilterIds: [],
      assignee: null,
      doneWithinDays: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const state: JiraWorkspaceViewsState = {
      workspaceId: "jira:ws",
      profileId: "default",
      views: [{ viewId: "issues", kind: "issues", title: "Issues" }, savedView],
      activeViewId: savedView.viewId,
      syncByViewId: { [savedView.viewId]: { state: "syncing", startedAt: Date.now() } },
    };
    mockStoreState.payload = reactive({
      appState: {
        activeProfileId: "default",
        workspaces: [{ id: "jira:ws", name: "Jira inbox", kind: "jira", profileId: "default" }],
      },
      jiraWorkspaceViews: { "jira:ws": state },
    });
    transport.getJiraWorkspaceViews.mockResolvedValue(state);
    transport.searchJiraIssues.mockResolvedValueOnce(null);

    const wrapper = mount(JiraInboxPane, {
      props: { workspaceId: "jira:ws", jiraViewId: savedView.viewId },
    });
    await flushPromises();
    expect(wrapper.find(".jira-native-issue-list").text()).toContain("Loading issues from Jira");
    expect(wrapper.find(".jira-native-issue-list").text()).not.toContain("No issues in this view.");
    wrapper.unmount();
  });

  test("shows a retry error instead of an empty message after an initial sync failure", async () => {
    mockStoreState.transportApi = transport;
    mockStoreState.isMobileSession = true;
    const savedView = {
      viewId: "saved-personal-sync-error",
      kind: "personal" as const,
      connectionId: "jira-1",
      boardId: null,
      boardName: "My issues",
      title: "My issues",
      mode: "issues" as const,
      sprintId: null,
      quickFilterIds: [],
      assignee: null,
      doneWithinDays: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const state: JiraWorkspaceViewsState = {
      workspaceId: "jira:ws",
      profileId: "default",
      views: [{ viewId: "issues", kind: "issues", title: "Issues" }, savedView],
      activeViewId: savedView.viewId,
      syncByViewId: { [savedView.viewId]: { state: "error", error: "Jira is unavailable." } },
    };
    mockStoreState.payload = reactive({
      appState: {
        activeProfileId: "default",
        workspaces: [{ id: "jira:ws", name: "Jira inbox", kind: "jira", profileId: "default" }],
      },
      jiraWorkspaceViews: { "jira:ws": state },
    });
    transport.getJiraWorkspaceViews.mockResolvedValue(state);
    transport.searchJiraIssues.mockResolvedValueOnce(null);
    transport.refreshJiraWorkspaceViews.mockResolvedValue({
      ...state,
      syncByViewId: { [savedView.viewId]: { state: "syncing", startedAt: Date.now() } },
    });

    const wrapper = mount(JiraInboxPane, {
      props: { workspaceId: "jira:ws", jiraViewId: savedView.viewId },
    });
    await flushPromises();
    expect(wrapper.find(".jira-native-view-sync-error").text()).toContain("Jira is unavailable.");
    expect(wrapper.find(".jira-native-issue-list").text()).not.toContain("No issues in this view.");
    await wrapper.get(".jira-native-view-sync-error button").trigger("click");
    await flushPromises();
    expect(transport.refreshJiraWorkspaceViews).toHaveBeenCalledWith({
      workspaceId: "jira:ws",
      viewId: savedView.viewId,
    });
    wrapper.unmount();
  });

  test("keeps cached mobile issues visible and exposes retry when the saved view sync fails", async () => {
    mockStoreState.transportApi = transport;
    mockStoreState.isMobileSession = true;
    const savedView = {
      viewId: "saved-personal-cached-sync-error",
      kind: "personal" as const,
      connectionId: "jira-1",
      boardId: null,
      boardName: "My issues",
      title: "My issues",
      mode: "issues" as const,
      sprintId: null,
      quickFilterIds: [],
      assignee: null,
      doneWithinDays: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const state: JiraWorkspaceViewsState = {
      workspaceId: "jira:ws",
      profileId: "default",
      views: [{ viewId: "issues", kind: "issues", title: "Issues" }, savedView],
      activeViewId: savedView.viewId,
      syncByViewId: { [savedView.viewId]: { state: "error", error: "Jira returned HTTP 503." } },
    };
    mockStoreState.payload = reactive({
      appState: {
        activeProfileId: "default",
        workspaces: [{ id: "jira:ws", name: "Jira inbox", kind: "jira", profileId: "default" }],
      },
      jiraWorkspaceViews: { "jira:ws": state },
    });
    transport.getJiraWorkspaceViews.mockResolvedValue(state);
    transport.searchJiraIssues.mockResolvedValueOnce({
      issues: [
        {
          ref: { provider: "jira", connectionId: "jira-1", issueId: "1001", issueKey: "ENG-1" },
          summary: "Cached issue stays available",
          status: "In Progress",
          statusId: "3",
          statusCategory: "indeterminate",
        },
      ],
      hasMore: false,
      cache: { source: "cache", fetchedAt: Date.now(), stale: true },
    });
    transport.refreshJiraWorkspaceViews.mockResolvedValue({
      ...state,
      syncByViewId: { [savedView.viewId]: { state: "syncing", startedAt: Date.now() } },
    });

    const wrapper = mount(JiraInboxPane, {
      props: { workspaceId: "jira:ws", jiraViewId: savedView.viewId },
    });
    await flushPromises();
    expect(wrapper.text()).toContain("Cached issue stays available");
    expect(wrapper.find(".jira-native-view-sync-error").text()).toContain("Jira returned HTTP 503.");
    expect(wrapper.find(".jira-native-view-sync-error button").text()).toContain("Retry");
    await wrapper
      .findAll(".jira-native-view-toolbar__mode")
      .find((button) => button.text() === "Board")!
      .trigger("click");
    await flushPromises();
    expect(wrapper.find(".jira-native-view-sync-error").exists()).toBe(true);
    expect(wrapper.find(".jira-board-issue").text()).toContain("Cached issue stays available");
    await wrapper.find(".jira-native-view-sync-error button").trigger("click");
    await flushPromises();
    expect(transport.refreshJiraWorkspaceViews).toHaveBeenCalledWith({
      workspaceId: "jira:ws",
      viewId: savedView.viewId,
    });
    expect(wrapper.text()).toContain("Cached issue stays available");
    wrapper.unmount();
  });

  test("opens My issues as a status board without selecting a Jira board", async () => {
    answerFirstOpenSearch();
    transport.listJiraBoards.mockResolvedValueOnce([]);
    transport.searchJiraIssues.mockResolvedValueOnce({
      issues: [
        {
          ref: { provider: "jira", connectionId: "jira-1", issueId: "2001", issueKey: "ENG-2" },
          summary: "A personal issue",
          status: "In Progress",
          statusId: "3",
          statusCategory: "indeterminate",
        },
      ],
      hasMore: false,
      cache: { source: "network", fetchedAt: Date.now(), stale: false },
    });
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
    await flushPromises();
    await wrapper
      .findAll(".jira-view-tab")
      .find((tab) => tab.text() === "Board")!
      .trigger("click");
    await flushPromises();
    await openToolbarMenuItem(wrapper, "Open My issues as a tab");
    expect(transport.buildJiraOwnIssuesQuery).toHaveBeenCalledWith({ connectionId: "jira-1" });
    expect(transport.getJiraBoardView).not.toHaveBeenCalled();
    expect(transport.searchJiraIssues).toHaveBeenCalledWith({
      connectionId: "jira-1",
      jql: 'assignee = "alice" ORDER BY updated DESC',
      limit: 50,
      cacheOnly: true,
    });
    expect(wrapper.find(".jira-board-columns").exists()).toBe(true);
    expect(wrapper.findAll(".jira-board-column__header").map((header) => header.text())).toContain("In progress1");
    expect(wrapper.text()).not.toContain("Select a board to start viewing issues.");

    await wrapper
      .findAll(".jira-view-tab")
      .find((tab) => tab.text() === "Issues")!
      .trigger("click");
    await wrapper.get(".jira-search-details > summary").trigger("click");
    transport.searchJiraIssues.mockResolvedValueOnce({
      issues: [
        {
          ref: { provider: "jira", connectionId: "jira-1", issueId: "3001", issueKey: "OPS-1" },
          summary: "New",
          status: "Open",
          statusId: "1",
          statusCategory: "new",
        },
        {
          ref: { provider: "jira", connectionId: "jira-1", issueId: "3002", issueKey: "OPS-2" },
          summary: "Working",
          status: "In Progress",
          statusId: "2",
          statusCategory: "indeterminate",
        },
        {
          ref: { provider: "jira", connectionId: "jira-1", issueId: "3003", issueKey: "OPS-3" },
          summary: "Review",
          status: "Reviewing",
          statusId: "3",
          statusCategory: "indeterminate",
        },
      ],
      hasMore: false,
      cache: { source: "network", fetchedAt: Date.now(), stale: false },
    });
    await wrapper.get(".jira-search input").setValue("project = OPS ORDER BY updated DESC");
    await wrapper.get(".jira-search").trigger("submit");
    await flushPromises();
    await wrapper
      .findAll(".jira-view-tab")
      .find((tab) => tab.text() === "Board")!
      .trigger("click");
    await flushPromises();
    expect(wrapper.find(".jira-board-toolbar").text()).toContain("Search results");
    expect(wrapper.find(".jira-board-columns").text()).toContain("OPS-3");
    expect(wrapper.find('[aria-label="Issues without a matching board column"]').exists()).toBe(false);
    expect(wrapper.find(".jira-board-empty").exists()).toBe(false);
  });

  test("keeps compact synthetic boards in compact layout and makes each column keyboard scrollable", async () => {
    mockStoreState.isMobileSession = true;
    transport.listJiraBoards.mockResolvedValueOnce([]);
    transport.searchJiraIssues.mockResolvedValueOnce({
      issues: [
        {
          ref: { provider: "jira", connectionId: "jira-1", issueId: "2001", issueKey: "ENG-2" },
          summary: "A personal issue",
          status: "In Progress",
          statusId: "3",
          statusCategory: "indeterminate",
        },
      ],
      hasMore: false,
      cache: { source: "network", fetchedAt: Date.now(), stale: false },
    });
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:compact-board" } });
    await flushPromises();
    await wrapper
      .findAll(".jira-view-tab")
      .find((tab) => tab.text() === "Board")!
      .trigger("click");
    await flushPromises();
    await openToolbarMenuItem(wrapper, "Open My issues as a tab");
    expect(wrapper.get(".jira-inbox").classes()).toContain("jira-inbox--compact-board");
    const emptyDoneColumn = wrapper.get('[aria-label="Done issues"]');
    expect(emptyDoneColumn.attributes("tabindex")).toBe("0");
    expect(emptyDoneColumn.element.tagName).toBe("DIV");
    wrapper.unmount();
  });

  test("shows actual linked development as recent activity and opens its workspace", async () => {
    mockStoreState.payload = reactive({
      appState: {
        activeProfileId: "default",
        workspaces: [
          {
            id: "task-recent",
            name: "Implement ENG-7",
            kind: "task",
            profileId: "default",
            lastWorkedAt: "2026-10-27T15:30:00.000Z",
            task: {
              state: "running",
              startedAt: "2026-10-26T09:00:00.000Z",
              jiraIssueRefs: [{ provider: "jira", connectionId: "jira-1", issueId: "7001", issueKey: "ENG-7" }],
              jiraIssueSnapshots: [],
            },
          },
          {
            id: "task-prepared",
            name: "Prepared ENG-8",
            kind: "task",
            profileId: "default",
            task: {
              state: "idle",
              jiraIssueRefs: [{ provider: "jira", connectionId: "jira-1", issueId: "8001", issueKey: "ENG-8" }],
            },
          },
        ],
      },
    });
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
    await flushPromises();
    const panel = wrapper.get(".jira-views-menu__panel");
    expect(panel.text()).toContain("ENG-7");
    expect(panel.text()).toContain("Development");
    expect(panel.text()).not.toContain("ENG-8");
    await panel
      .findAll("[role=menuitem]")
      .find((item) => item.text().includes("ENG-7"))!
      .trigger("click");
    expect(transport.activateWorkspace).toHaveBeenCalledWith("task-recent");
  });

  test("shows only explicitly viewed Jira issues as recently viewed and opens the cached detail flow", async () => {
    transport.getJiraIssue.mockResolvedValueOnce({
      ref: { provider: "jira", connectionId: "jira-1", issueId: "2001", issueKey: "ENG-2" },
      summary: "Recent issue",
      status: "Open",
      description: "Recent description",
    });
    transport.getJiraRecentIssues.mockResolvedValueOnce([
      {
        ref: { provider: "jira", connectionId: "jira-1", issueId: "2001", issueKey: "ENG-2" },
        summary: "Recent issue",
        status: "Open",
        viewedAt: Date.now(),
      },
    ]);
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
    await flushPromises();
    const recent = wrapper.get(".jira-views-menu__panel");
    expect(recent.text()).toContain("Recent");
    expect(recent.text()).toContain("ENG-2");
    await chooseView(wrapper, "ENG-2");
    expect(transport.getJiraIssue).toHaveBeenCalledWith({ connectionId: "jira-1", issueId: "2001", cacheOnly: true });
    expect(transport.rememberJiraIssueViewed).toHaveBeenCalledWith({
      ref: { provider: "jira", connectionId: "jira-1", issueId: "2001", issueKey: "ENG-2" },
    });
    wrapper.unmount();
  });

  test("keeps recent Jira issue and development cards inside the selected project scope", async () => {
    transport.listJiraConnections.mockResolvedValueOnce([
      {
        id: "jira-1",
        label: "Engineering",
        deployment: "data-center",
        webUrl: "https://jira.example.com",
        accountPurpose: "technical",
        verifiedIdentity: { displayName: "Build Bot" },
        ownIdentity: { kind: "data-center", name: "alice", displayName: "Alice" },
        projectKeys: ["OPS"],
      },
    ]);
    transport.getJiraRecentSearches.mockResolvedValueOnce([{ jql: "project = ENG", usedAt: Date.now() }]);
    transport.getJiraRecentIssues.mockResolvedValueOnce([
      {
        ref: { provider: "jira", connectionId: "jira-1", issueId: "ops-1", issueKey: "OPS-1" },
        summary: "Operations ticket",
        status: "Open",
        viewedAt: Date.now(),
      },
      {
        ref: { provider: "jira", connectionId: "jira-1", issueId: "eng-1", issueKey: "ENG-1" },
        summary: "Engineering ticket",
        status: "Open",
        viewedAt: Date.now(),
      },
    ]);
    mockStoreState.payload = reactive({
      appState: {
        activeProfileId: "default",
        workspaces: [
          {
            id: "task-ops",
            name: "Operations task",
            kind: "task",
            profileId: "default",
            lastWorkedAt: "2026-10-27T15:30:00.000Z",
            task: {
              state: "running",
              jiraIssueRefs: [{ provider: "jira", connectionId: "jira-1", issueId: "ops-2", issueKey: "OPS-2" }],
            },
          },
          {
            id: "task-eng",
            name: "Engineering task",
            kind: "task",
            profileId: "default",
            lastWorkedAt: "2026-10-27T16:30:00.000Z",
            task: {
              state: "running",
              jiraIssueRefs: [{ provider: "jira", connectionId: "jira-1", issueId: "eng-2", issueKey: "ENG-2" }],
            },
          },
        ],
      },
    });
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
    await flushPromises();
    const recents = wrapper.get(".jira-views-menu__panel");
    expect(recents.text()).toContain("OPS-2");
    expect(recents.text()).not.toContain("ENG-2");
    expect(recents.text()).toContain("OPS-1");
    expect(recents.text()).not.toContain("ENG-1");
    expect(recents.text()).toContain("project = ENG");
    wrapper.unmount();
  });

  test("restores the last successful query from SQLite cache first and refreshes stale results in the background", async () => {
    writeLastJiraSearch(
      "default",
      "jira:search-prefs",
      { connectionId: "jira-1", jql: "project = PAY", kind: "jql", label: "Payments", filterId: null },
      localStorage,
    );
    const cachedIssue = {
      ref: { provider: "jira" as const, connectionId: "jira-1", issueId: "cache-1", issueKey: "PAY-1" },
      summary: "Cached result",
    };
    const freshIssue = {
      ref: { provider: "jira" as const, connectionId: "jira-1", issueId: "fresh-1", issueKey: "PAY-2" },
      summary: "Fresh result",
    };
    transport.searchJiraIssues
      .mockResolvedValueOnce({
        issues: [cachedIssue],
        cache: { source: "cache", fetchedAt: Date.now() - 60_000, stale: true },
      })
      .mockResolvedValueOnce({
        issues: [freshIssue],
        cache: { source: "network", fetchedAt: Date.now(), stale: false },
      });
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:search-prefs" } });
    await flushPromises();
    expect(transport.searchJiraIssues).toHaveBeenNthCalledWith(1, {
      connectionId: "jira-1",
      jql: "project = PAY",
      limit: 50,
      cacheOnly: true,
    });
    expect(transport.searchJiraIssues).toHaveBeenNthCalledWith(2, {
      connectionId: "jira-1",
      jql: "project = PAY",
      limit: 50,
      forceRefresh: true,
    });
    expect(wrapper.text()).toContain("Fresh result");
    expect(wrapper.find(".jira-cache-status").exists()).toBe(false);
    expect(wrapper.get(".jira-head__sync").text()).toContain("Loaded");
    expect((wrapper.find(".jira-search input").element as HTMLInputElement).value).toBe("project = PAY");
    wrapper.unmount();
  });

  test("nothing refreshes on a timer; returning to the window refreshes only data older than 5 minutes, once", async () => {
    writeLastJiraSearch(
      "default",
      "jira:search-return",
      { connectionId: "jira-1", jql: "project = PAY", kind: "jql", label: "Payments", filterId: null },
      localStorage,
    );
    const issue = {
      ref: { provider: "jira" as const, connectionId: "jira-1", issueId: "pay-1", issueKey: "PAY-1" },
      summary: "Result",
    };
    const start = Date.now();
    let now = start;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const rects = vi
      .spyOn(Element.prototype, "getClientRects")
      .mockReturnValue([{ width: 1, height: 1 }] as unknown as DOMRectList);
    // Like the runtime cache: a read past its 5-minute TTL comes back stale.
    transport.searchJiraIssues.mockImplementation(async (payload: { cacheOnly?: boolean }) => ({
      issues: [issue],
      cache: payload.cacheOnly
        ? { source: "cache", fetchedAt: start, stale: now - start >= 5 * 60_000 }
        : { source: "network", fetchedAt: now, stale: false },
    }));
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:search-return" }, attachTo: document.body });
    await flushPromises();
    const callsAfterMount = transport.searchJiraIssues.mock.calls.length;

    window.dispatchEvent(new Event("focus"));
    await flushPromises();
    expect(transport.searchJiraIssues).toHaveBeenCalledTimes(callsAfterMount);

    // Six minutes later the cached read is stale: one cache read, then one Jira request.
    now = start + 6 * 60_000;
    window.dispatchEvent(new Event("focus"));
    await flushPromises();
    expect(transport.searchJiraIssues).toHaveBeenCalledTimes(callsAfterMount + 2);
    expect(transport.searchJiraIssues).toHaveBeenLastCalledWith(expect.objectContaining({ forceRefresh: true }));

    window.dispatchEvent(new Event("focus"));
    await flushPromises();
    expect(transport.searchJiraIssues).toHaveBeenCalledTimes(callsAfterMount + 2);
    wrapper.unmount();
    rects.mockRestore();
    clock.mockRestore();
  });

  test("keeps the selected issue open when a passive background search refresh finishes", async () => {
    writeLastJiraSearch(
      "default",
      "jira:search-selection",
      { connectionId: "jira-1", jql: "project = PAY", kind: "jql", label: "Payments", filterId: null },
      localStorage,
    );
    const cachedIssue = {
      ref: { provider: "jira" as const, connectionId: "jira-1", issueId: "cache-1", issueKey: "PAY-1" },
      summary: "Cached result",
    };
    mockStoreState.payload = reactive({
      appState: {
        activeProfileId: "default",
        workspaces: [
          { id: "jira:search-selection", name: "Jira inbox", kind: "jira", profileId: "default" },
          {
            id: "task-pay-1",
            name: "Implement PAY-1",
            kind: "task",
            profileId: "default",
            task: {
              state: "running",
              startedAt: "2026-10-27T15:00:00.000Z",
              jiraIssueRefs: [cachedIssue.ref],
              jiraIssueSnapshots: [],
            },
          },
        ],
      },
    });
    let finishRefresh!: (value: unknown) => void;
    transport.searchJiraIssues
      .mockResolvedValueOnce({
        issues: [cachedIssue],
        cache: { source: "cache", fetchedAt: Date.now() - 60_000, stale: true },
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishRefresh = resolve;
          }),
      );
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:search-selection" } });
    await flushPromises();
    await wrapper.get(".jira-issue").trigger("click");
    await flushPromises();
    expect(wrapper.find(".jira-detail h2").text()).toBe("Fix login");
    finishRefresh({
      issues: [
        {
          ...cachedIssue,
          summary: "Fresh result",
        },
      ],
      cache: { source: "network", fetchedAt: Date.now(), stale: false },
    });
    await flushPromises();
    expect(wrapper.find(".jira-detail h2").text()).toBe("Fix login");
    wrapper.unmount();
  });

  test("does not fall back to UI-built personal JQL when runtime rejects identity policy", async () => {
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
    await flushPromises();
    transport.searchJiraIssues.mockClear();
    transport.buildJiraOwnIssuesQuery.mockRejectedValueOnce(new Error("Personal Jira identity is not verified."));
    await chooseView(wrapper, "My issues, including done");
    expect(wrapper.find('[role="alert"]').text()).toContain("not verified");
    expect(transport.searchJiraIssues).not.toHaveBeenCalled();
  });

  test("Cloud personal preset uses the runtime-owned accountId, not an interpolated renderer identity", async () => {
    transport.listJiraConnections.mockResolvedValueOnce([
      {
        id: "cloud-1",
        label: "Cloud",
        deployment: "cloud",
        webUrl: "https://example.atlassian.net",
        accountPurpose: "technical",
        verifiedIdentity: { displayName: "Build Bot" },
        ownIdentity: { kind: "cloud", accountId: "acc-123", displayName: "Alice" },
      },
    ]);
    transport.buildJiraOwnIssuesQuery.mockResolvedValueOnce({
      jql: 'assignee = "acc-123" ORDER BY updated DESC',
      identityLabel: "Alice",
    });
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
    await flushPromises();
    await chooseView(wrapper, "My issues, including done");
    expect(transport.buildJiraOwnIssuesQuery).toHaveBeenCalledWith({ connectionId: "cloud-1" });
    expect(transport.searchJiraIssues).toHaveBeenCalledWith({
      connectionId: "cloud-1",
      jql: 'assignee = "acc-123" ORDER BY updated DESC',
      limit: 50,
      cacheOnly: true,
    });
    expect(wrapper.text()).toContain("Showing issues for Alice");
  });

  test("shows bounded search pagination and appends the next page", async () => {
    answerFirstOpenSearch();
    transport.searchJiraIssues.mockResolvedValueOnce({
      issues: [
        { ref: { provider: "jira", connectionId: "jira-1", issueId: "1", issueKey: "ENG-1" }, summary: "First" },
      ],
      hasMore: true,
      nextCursor: "cursor-1",
      truncated: true,
    });
    transport.searchJiraIssues.mockResolvedValueOnce({
      issues: [
        { ref: { provider: "jira", connectionId: "jira-1", issueId: "2", issueKey: "ENG-2" }, summary: "Second" },
      ],
      hasMore: false,
      truncated: false,
    });
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
    await flushPromises();
    await wrapper.find("form.jira-search").trigger("submit");
    await flushPromises();
    expect(wrapper.text()).toContain("Jira limited this result set");
    await wrapper
      .findAll(".jira-results button")
      .find((button) => button.text().includes("Load more"))!
      .trigger("click");
    await flushPromises();
    expect(transport.searchJiraIssues).toHaveBeenLastCalledWith({
      connectionId: "jira-1",
      jql: 'assignee = "alice" ORDER BY updated DESC',
      limit: 50,
      cursor: "cursor-1",
    });
    expect(wrapper.text()).toContain("ENG-2");
    expect(wrapper.text()).not.toContain("Jira limited this result set");
  });

  test("saved-query polling is explicitly opted in from Settings and can be disabled", async () => {
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
    await flushPromises();
    await wrapper
      .findAll(".jira-view-tab")
      .find((tab) => tab.text() === "Settings")!
      .trigger("click");
    const notificationToggle = wrapper.find('.jira-saved-queries input[type="checkbox"]');
    expect((notificationToggle.element as HTMLInputElement).checked).toBe(false);
    expect(wrapper.text()).toContain("do not capture the full Jira notification stream");
    transport.listJiraQueries.mockResolvedValueOnce([
      {
        id: "query-1",
        connectionId: "jira-1",
        name: "My issues",
        jql: "assignee = currentUser()",
        notificationsEnabled: true,
      },
    ]);
    await notificationToggle.setValue(true);
    await flushPromises();
    expect(transport.saveJiraQuery).toHaveBeenCalledWith({
      id: "query-1",
      connectionId: "jira-1",
      name: "My issues",
      jql: "assignee = currentUser()",
      notificationsEnabled: true,
    });
    expectEveryCallToMatch(jiraQuerySaveSchema, transport.saveJiraQuery);
    expect((wrapper.find('.jira-saved-queries input[type="checkbox"]').element as HTMLInputElement).checked).toBe(true);
    await wrapper.find('.jira-saved-queries input[type="checkbox"]').setValue(false);
    await flushPromises();
    expect(transport.saveJiraQuery).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "query-1", notificationsEnabled: false }),
    );
    expectEveryCallToMatch(jiraQuerySaveSchema, transport.saveJiraQuery);
  });

  test("Settings renames and deletes a saved query after confirmation and keeps nothing else", async () => {
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
    await flushPromises();
    await wrapper
      .findAll(".jira-view-tab")
      .find((tab) => tab.text() === "Settings")!
      .trigger("click");
    expect(wrapper.find(".jira-saved-queries select, .jira-saved-queries .custom-select").exists()).toBe(false);
    const nameInput = wrapper.get('.jira-saved-queries input[aria-label^="Name of saved query"]');
    await nameInput.setValue("Open work");
    await nameInput.trigger("change");
    await flushPromises();
    expect(transport.saveJiraQuery).toHaveBeenCalledWith(expect.objectContaining({ id: "query-1", name: "Open work" }));
    expectEveryCallToMatch(jiraQuerySaveSchema, transport.saveJiraQuery);
    await wrapper
      .findAll(".jira-saved-queries button")
      .find((button) => button.text() === "Delete")!
      .trigger("click");
    await flushPromises();
    expect(transport.confirmInApp).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Delete saved query?", danger: true }),
    );
    expect(transport.deleteJiraQuery).toHaveBeenCalledWith("query-1");
  });

  test("a saved query picked in Views runs at once and switches to the Issues view", async () => {
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
    await flushPromises();
    await wrapper
      .findAll(".jira-view-tab")
      .find((tab) => tab.text() === "Board")!
      .trigger("click");
    expect(wrapper.get(".jira-view-tab--active").text()).toBe("Board");
    await chooseView(wrapper, "My issues");
    expect(wrapper.get(".jira-view-tab--active").text()).toBe("Issues");
    transport.searchJiraIssues.mockClear();
    await wrapper
      .findAll(".jira-views-menu__panel [role=menuitem]")
      .find((item) => item.attributes("title") === "assignee = currentUser()")!
      .trigger("click");
    await flushPromises();
    expect(transport.searchJiraIssues).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: "jira-1", jql: "assignee = currentUser()" }),
    );
    expect(wrapper.get(".jira-view-tab--active").text()).toBe("Issues");
    expect(wrapper.find(".jira-issue").exists()).toBe(true);
  });

  test("a Jira favorite picked in Views runs its own JQL unchanged", async () => {
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
    await flushPromises();
    transport.getJiraSavedFilter.mockResolvedValueOnce({
      id: "20",
      name: "Assigned to me",
      jql: "assignee = currentUser() ORDER BY updated DESC",
    });
    await chooseView(wrapper, "Assigned to me");
    expect(transport.getJiraSavedFilter).toHaveBeenCalledWith({ connectionId: "jira-1", filterId: "20" });
    expect(transport.searchJiraIssues).toHaveBeenCalledWith(
      expect.objectContaining({ jql: "assignee = currentUser() ORDER BY updated DESC" }),
    );
  });

  test("surfaces search and issue-detail failures", async () => {
    answerFirstOpenSearch();
    transport.searchJiraIssues.mockRejectedValueOnce(new Error("JQL rejected"));
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
    await flushPromises();
    await wrapper.find("form.jira-search").trigger("submit");
    await flushPromises();
    expect(wrapper.find(".jira-error__message").text()).toBe("Jira search failed: JQL rejected");

    transport.searchJiraIssues.mockResolvedValueOnce([
      { ref: { provider: "jira", connectionId: "jira-1", issueId: "1001", issueKey: "ENG-1" }, summary: "Fix login" },
    ]);
    transport.getJiraIssue.mockRejectedValueOnce(new Error("Issue unavailable"));
    await wrapper.find("form.jira-search").trigger("submit");
    await flushPromises();
    await wrapper.find(".jira-issue").trigger("click");
    await flushPromises();
    expect(wrapper.find(".jira-error__message").text()).toBe("Could not load issue details: Issue unavailable");
  });

  test("renders machine-readable Jira rate-limit status and Retry-After", async () => {
    answerFirstOpenSearch();
    transport.searchJiraIssues.mockRejectedValueOnce(
      desktopJiraFailure("Jira throttled this request.", "rate-limited", 2500),
    );
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
    await flushPromises();
    await wrapper.find("form.jira-search").trigger("submit");
    await flushPromises();
    expect(wrapper.find('[role="alert"]').text()).toContain("Jira throttled this request.");
    expect(wrapper.find('[role="alert"]').text()).toContain("Jira rate limit reached");
    expect(wrapper.find('[role="alert"]').text()).not.toContain("Retry after");
    expect(wrapper.get(".jira-error__countdown").text()).toContain("3 s");
    expect(wrapper.find('[role="alert"] .jira-error__countdown').exists()).toBe(false);
  });

  test("renders persisted connection health and unwraps clone-safe verification errors", async () => {
    const connection = {
      id: "jira-1",
      label: "Engineering",
      deployment: "data-center",
      webUrl: "https://jira.example.com",
      apiBaseUrl: "https://jira.example.com/jira",
      accountPurpose: "technical",
      verifiedIdentity: { displayName: "Build Bot" },
    };
    transport.listJiraConnections.mockReset();
    transport.listJiraConnections.mockResolvedValueOnce([
      { ...connection, health: { state: "auth-expired", checkedAt: "2026-10-23T12:00:00Z" } },
    ]);
    transport.listJiraConnections.mockResolvedValueOnce([
      { ...connection, health: { state: "permission-denied", checkedAt: "2026-10-23T12:01:00Z" } },
    ]);
    transport.verifyJiraConnection.mockResolvedValueOnce({
      ok: false,
      health: { state: "permission-denied", checkedAt: "2026-10-23T12:01:00Z" },
      error: { code: "permission-denied", message: "Jira permission denied", retryAfterMs: 0 },
    });
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
    await flushPromises();
    await openSettingsView(wrapper);
    expect(wrapper.find('[aria-label="Jira connection health"]').text()).toContain("Authentication expired");
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Test connection")!
      .trigger("click");
    await flushPromises();
    expect(wrapper.find(".jira-connection-verify-result").text()).toContain("Jira permission denied");
    expect(wrapper.find('[aria-label="Jira connection health"]').text()).toContain("Jira permission denied");
  });

  test.each([
    ["permission-denied", "Jira permission denied", undefined, "connected"],
    ["unsupported", "Jira capability unsupported", undefined, "connected"],
    ["rate-limited", "Jira rate limit reached", 2500, "connected"],
    ["network", "Jira network error", undefined, "unavailable"],
  ] as const)("shows persisted %s health and availability", async (state, label, retryAfterMs, availability) => {
    transport.listJiraConnections.mockResolvedValueOnce([
      {
        id: "jira-1",
        label: "Engineering",
        deployment: "data-center",
        webUrl: "https://jira.example.com",
        apiBaseUrl: "https://jira.example.com/jira",
        health: { state, checkedAt: "2026-10-23T12:00:00Z", ...(retryAfterMs ? { retryAfterMs } : {}) },
        status: availability,
      },
    ]);
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
    await flushPromises();
    await openSettingsView(wrapper);
    expect(wrapper.find('[aria-label="Jira connection health"]').text()).toContain(label);
    if (retryAfterMs)
      expect(wrapper.find('[aria-label="Jira connection health"]').text()).toContain("Retry after 3 seconds");
    if (availability === "unavailable") expect(wrapper.text()).toContain("Unavailable / offline");
  });

  describe("comment attribution hint", () => {
    const openIssue = async () => {
      const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
      await flushPromises();
      await wrapper.find("form.jira-search").trigger("submit");
      await flushPromises();
      await wrapper.find(".jira-issue").trigger("click");
      await flushPromises();
      return wrapper;
    };
    const setAttribution = (value: unknown) => {
      const settings = (mockStoreState.payload as { appState: { settings: { integrations: Record<string, unknown> } } })
        .appState.settings;
      settings.integrations.jira = { commentAttribution: value };
    };

    test("a technical connection shows what will be added, from the shared helper", async () => {
      const wrapper = await openIssue();
      expect(wrapper.get('[data-testid="jira-comment-attribution-hint"]').text()).toBe(
        "Adds: “On behalf of Alice” before the comment",
      );
      expect(
        wrapper
          .get(".jira-comment-composer__meta")
          .element.contains(wrapper.get('[data-testid="jira-comment-attribution-hint"]').element),
      ).toBe(true);
    });

    test("follows the configured text and position, and hides when disabled", async () => {
      setAttribution({ enabled: true, text: "Sent by {account} for {user}", position: "after" });
      let wrapper = await openIssue();
      expect(wrapper.get('[data-testid="jira-comment-attribution-hint"]').text()).toBe(
        "Adds: “Sent by Build Bot for Alice” after the comment",
      );
      wrapper.unmount();
      setAttribution({ enabled: false, text: "x", position: "before" });
      wrapper = await openIssue();
      expect(wrapper.find('[data-testid="jira-comment-attribution-hint"]').exists()).toBe(false);
    });

    test("a personal connection shows no attribution line", async () => {
      transport.listJiraConnections.mockResolvedValue([
        {
          id: "jira-1",
          label: "Engineering",
          deployment: "data-center",
          webUrl: "https://jira.example.com",
          apiBaseUrl: "https://jira.example.com/jira",
          accountPurpose: "personal",
          verifiedIdentity: { displayName: "Alice" },
          ownIdentity: { kind: "data-center", name: "alice", displayName: "Alice" },
        },
      ]);
      const wrapper = await openIssue();
      expect(wrapper.find('[data-testid="jira-comment-attribution-hint"]').exists()).toBe(false);
    });
  });

  test("offers explicit reconciliation for an unknown durable write and never resends it", async () => {
    transport.executeJiraWrite.mockResolvedValueOnce({
      ok: false,
      error: {
        code: "jira-write-unknown",
        message: "Jira may have accepted this write.",
        status: "unknown",
        journalId: "journal-1",
      },
    });
    transport.reconcileJiraWrite.mockResolvedValueOnce({
      journalId: "journal-1",
      status: "reconciled",
      outcome: "applied",
    });
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
    await flushPromises();
    await wrapper.find("form.jira-search").trigger("submit");
    await flushPromises();
    await wrapper.find(".jira-issue").trigger("click");
    await flushPromises();
    await sendComment(wrapper, "Reviewed this change.");
    expect(transport.executeJiraWrite).toHaveBeenCalledOnce();
    expect(wrapper.text()).toContain("Write outcome unknown; reconciliation required");
    expect(wrapper.text()).toContain("Do not submit it again");
    expect(wrapper.find(".jira-comment-composer .jira-inline-error").text()).toContain(
      "Jira may have accepted this write.",
    );
    await wrapper.find(".jira-write-reconcile button").trigger("click");
    await flushPromises();
    expect(wrapper.find(".jira-comment-composer .jira-inline-error").exists()).toBe(false);
    expect(transport.reconcileJiraWrite).toHaveBeenCalledWith("journal-1");
    expect(transport.executeJiraWrite).toHaveBeenCalledOnce();
    expect(wrapper.text()).toContain("Reconciliation completed: applied");
  });

  test("loads a mocked board and sends a Jira comment through preview, token and execute", async () => {
    mockStoreState.isMobileSession = true;
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" }, attachTo: document.body });
    await flushPromises();
    await chooseCustomSelect(wrapper, ".jira-board-controls", 42);
    expect(transport.getJiraBoardView).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: "jira-1", boardId: 42, mode: "issues", cacheOnly: true }),
    );
    expect(transport.getJiraBoardView).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: "jira-1", boardId: 42, mode: "issues", forceRefresh: true }),
    );
    await wrapper.find(".jira-board-issue").trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("Login fails on refresh");
    expect(wrapper.get(".jira-inbox").classes()).toContain("jira-inbox--compact-detail");
    expect((wrapper.get(".jira-detail-sidebar").element as HTMLDetailsElement).open).toBe(false);
    expect(document.activeElement).toBe(wrapper.get(".jira-detail h2").element);
    await wrapper.find(".jira-detail__back").trigger("click");
    await flushPromises();
    expect(document.activeElement).toBe(wrapper.get(".jira-board-issue").element);
    expect(wrapper.get(".jira-inbox").classes()).not.toContain("jira-inbox--compact-detail");
    expect(transport.getJiraIssue).toHaveBeenCalledTimes(1);
    await wrapper.find(".jira-board-issue").trigger("click");
    await flushPromises();
    await sendComment(wrapper, "Reviewed this change.");
    expect(transport.previewJiraWrite).toHaveBeenCalledWith(
      expect.objectContaining({ action: "comment", body: "Reviewed this change.", intent: "Comment on ENG-1" }),
    );
    expect(transport.executeJiraWrite).toHaveBeenCalledWith(
      expect.objectContaining({ action: "comment", confirmation: expect.objectContaining({ token: "confirm-1" }) }),
    );
    expectEveryCallToMatch(jiraWritePreviewSchema, transport.previewJiraWrite);
    expectEveryCallToMatch(jiraWriteExecuteSchema, transport.executeJiraWrite);
    expect(wrapper.text()).toContain("Comment added to ENG-1.");
    expect(wrapper.text()).toContain("To Do");
    expect(wrapper.text()).toContain("Open");
    expect(wrapper.find(".jira-board-column").text()).toContain("ENG-1");
    wrapper.unmount();
  });

  test("on a wide pane a board card opens as a drawer beside the columns; Escape closes it and returns to the card", async () => {
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" }, attachTo: document.body });
    await flushPromises();
    await chooseCustomSelect(wrapper, ".jira-board-controls", 42);
    await flushPromises();
    const columns = wrapper.get(".jira-board-columns");
    (wrapper.get(".jira-board-column__cards").element as HTMLElement).scrollTop = 40;
    const card = wrapper.get(".jira-board-issue");
    await card.trigger("click");
    await flushPromises();
    const root = wrapper.get(".jira-inbox");
    expect(root.classes()).toContain("jira-inbox--board-drawer");
    expect(root.classes()).not.toContain("jira-inbox--board-detail");
    expect(wrapper.get(".jira-board-columns").element).toBe(columns.element);
    expect(wrapper.find(".jira-board-split .jira-board-drawer .jira-detail-header h2").text()).toBe("Fix login");
    expect(wrapper.find(".jira-detail__back").exists()).toBe(false);
    expect(wrapper.find(".jira-detail__close").exists()).toBe(true);
    expect(wrapper.find(".jira-columns").exists()).toBe(false);
    expect((wrapper.get(".jira-board-column__cards").element as HTMLElement).scrollTop).toBe(40);

    await wrapper.get(".jira-detail-header").trigger("keydown", { key: "Escape" });
    await flushPromises();
    expect(root.classes()).not.toContain("jira-inbox--board-drawer");
    expect(wrapper.find(".jira-board-drawer").exists()).toBe(false);
    expect(wrapper.get(".jira-board-columns").element).toBe(columns.element);
    expect(document.activeElement).toBe(wrapper.get(".jira-board-issue").element);

    await wrapper.get(".jira-board-issue").trigger("click");
    await flushPromises();
    await wrapper.get(".jira-detail__close").trigger("click");
    await flushPromises();
    expect(wrapper.find(".jira-board-drawer").exists()).toBe(false);
    wrapper.unmount();
  });

  test("in a compact pane opening a board card replaces the board and Back returns to the same card", async () => {
    mockStoreState.isMobileSession = true;
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" }, attachTo: document.body });
    await flushPromises();
    await wrapper
      .findAll(".jira-view-tab")
      .find((tab) => tab.text() === "Board")!
      .trigger("click");
    await flushPromises();
    await chooseCustomSelect(wrapper, ".jira-board-controls", 42);
    await flushPromises();
    expect((wrapper.get(".jira-board-filter-details").element as HTMLDetailsElement).open).toBe(false);

    const card = wrapper.get(".jira-board-issue");
    await card.trigger("click");
    await flushPromises();

    const root = wrapper.get(".jira-inbox");
    const columns = wrapper.get(".jira-columns");
    const back = wrapper.get(".jira-detail__back");
    expect(root.classes()).toContain("jira-inbox--board-view");
    expect(root.classes()).toContain("jira-inbox--board-detail");
    expect(getComputedStyle(columns.element).display).toBe("grid");
    expect(getComputedStyle(back.element).display).not.toBe("none");
    expect(wrapper.get(".jira-detail-header h2").text()).toBe("Fix login");

    await back.trigger("click");
    await flushPromises();
    expect(root.classes()).not.toContain("jira-inbox--board-detail");
    expect(wrapper.find(".jira-detail-header").exists()).toBe(false);
    expect(wrapper.find(".jira-board-issue").exists()).toBe(true);
    expect(document.activeElement).toBe(wrapper.get(".jira-board-issue").element);

    await wrapper.get(".jira-board-issue").trigger("click");
    await flushPromises();
    await wrapper
      .findAll(".jira-view-tab")
      .find((tab) => tab.text() === "Settings")!
      .trigger("click");
    await flushPromises();
    expect(root.classes()).not.toContain("jira-inbox--board-detail");
    expect(wrapper.find(".jira-columns").exists()).toBe(false);
    expect(wrapper.find(".jira-detail-header").exists()).toBe(false);

    await wrapper
      .findAll(".jira-view-tab")
      .find((tab) => tab.text() === "Issues")!
      .trigger("click");
    await flushPromises();
    expect(root.classes()).toContain("jira-inbox--issues-view");
    expect(root.classes()).not.toContain("jira-inbox--board-detail");
    expect(wrapper.find(".jira-detail__back").text()).toContain("Back to issues");
    wrapper.unmount();
  });

  test("keeps board detail Back available while loading a cache-miss issue", async () => {
    mockStoreState.isMobileSession = true;
    let resolveIssue!: (value: unknown) => void;
    transport.getJiraIssue
      .mockResolvedValueOnce(null)
      .mockImplementationOnce(() => new Promise((resolve) => (resolveIssue = resolve)));
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" }, attachTo: document.body });
    await flushPromises();
    await wrapper
      .findAll(".jira-view-tab")
      .find((tab) => tab.text() === "Board")!
      .trigger("click");
    await flushPromises();
    await chooseCustomSelect(wrapper, ".jira-board-controls", 42);
    await flushPromises();
    await wrapper.get(".jira-board-issue").trigger("click");
    await flushPromises();

    expect(wrapper.get(".jira-detail").attributes("data-selected")).toBe("true");
    expect(wrapper.findAll(".jira-detail .spinner")).toHaveLength(1);
    expect(wrapper.get(".jira-detail .jira-empty").text()).toContain("Loading issue details");
    expect(wrapper.get(".jira-detail__back").text()).toContain("Back to board");
    await wrapper.get(".jira-detail__back").trigger("click");
    resolveIssue({
      ref: { provider: "jira", connectionId: "jira-1", issueId: "1001", issueKey: "ENG-1" },
      summary: "Late response",
    });
    await flushPromises();
    expect(wrapper.find(".jira-detail-header").exists()).toBe(false);
    expect(wrapper.text()).not.toContain("Late response");
    wrapper.unmount();
  });

  test("keeps multi-page board refresh atomic and refreshes only on demand", async () => {
    vi.useFakeTimers();
    transport.getJiraBoardView
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        boardId: 42,
        mode: "issues",
        issues: [
          {
            ref: { provider: "jira", connectionId: "jira-1", issueId: "old-1", issueKey: "ENG-1" },
            summary: "Old first page",
          },
        ],
        hasMore: true,
        nextCursor: "page-2",
        cache: { source: "network", fetchedAt: 100, stale: false },
      })
      .mockResolvedValueOnce({
        boardId: 42,
        mode: "issues",
        issues: [
          {
            ref: { provider: "jira", connectionId: "jira-1", issueId: "old-2", issueKey: "ENG-2" },
            summary: "Old second page",
          },
        ],
        hasMore: true,
        nextCursor: "page-3",
      })
      .mockResolvedValueOnce({
        boardId: 42,
        mode: "issues",
        issues: [
          {
            ref: { provider: "jira", connectionId: "jira-1", issueId: "new-1", issueKey: "ENG-1" },
            summary: "Fresh first page",
          },
        ],
        hasMore: true,
        nextCursor: "page-2",
        cache: { source: "network", fetchedAt: 200, stale: false },
      })
      .mockResolvedValueOnce({
        boardId: 42,
        mode: "issues",
        issues: [
          {
            ref: { provider: "jira", connectionId: "jira-1", issueId: "new-2", issueKey: "ENG-2" },
            summary: "Stale second page",
          },
        ],
        hasMore: true,
        nextCursor: "page-3",
        cache: {
          source: "cache",
          fetchedAt: 100,
          stale: true,
          refreshError: { code: "network-error", message: "Offline" },
        },
      })
      .mockResolvedValueOnce({
        boardId: 42,
        mode: "issues",
        issues: [
          {
            ref: { provider: "jira", connectionId: "jira-1", issueId: "old-3", issueKey: "ENG-3" },
            summary: "Retained cursor page",
          },
        ],
        hasMore: false,
      });
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
    try {
      (mockStoreState.payload as { appState: { activeWorkspaceId: string } }).appState.activeWorkspaceId = "jira:ws";
      await flushPromises();
      await wrapper
        .findAll(".jira-view-tab")
        .find((tab) => tab.text() === "Board")!
        .trigger("click");
      await flushPromises();
      await chooseCustomSelect(wrapper, ".jira-board-controls", 42);
      await flushPromises();
      await wrapper.get(".jira-board-load-more").trigger("click");
      await flushPromises();
      expect(wrapper.text()).toContain("Old first page");
      expect(wrapper.text()).toContain("Old second page");

      await vi.advanceTimersByTimeAsync(60_000);
      await flushPromises();
      const requestsBeforeWait = transport.getJiraBoardView.mock.calls.length;
      expect(requestsBeforeWait).toBeGreaterThanOrEqual(2);
      expect(transport.getJiraBoardView).toHaveBeenCalledTimes(requestsBeforeWait);
      await wrapper.get('.jira-head__refresh[aria-label="Refresh Jira data"]').trigger("click");
      await flushPromises();
      expect(transport.getJiraBoardView).toHaveBeenNthCalledWith(
        requestsBeforeWait + 2,
        expect.objectContaining({
          connectionId: "jira-1",
          boardId: 42,
          mode: "issues",
          cursor: "page-2",
          forceRefresh: true,
        }),
      );
      expect(wrapper.text()).not.toContain("Fresh first page");
      expect(wrapper.text()).not.toContain("Stale second page");
      expect(wrapper.text()).toContain("Old first page");
      expect(wrapper.text()).toContain("Old second page");
      expect(wrapper.text()).toContain("Offline");

      await wrapper.get(".jira-board-load-more").trigger("click");
      await flushPromises();
      expect(transport.getJiraBoardView).toHaveBeenLastCalledWith(
        expect.objectContaining({ connectionId: "jira-1", boardId: 42, mode: "issues", cursor: "page-3" }),
      );
      expect(wrapper.text()).toContain("Retained cursor page");
    } finally {
      wrapper.unmount();
      vi.useRealTimers();
    }
  });

  test("filters loaded issues by status and text and re-runs the JQL with the chosen order", async () => {
    transport.searchJiraIssues.mockResolvedValue([
      {
        ref: { provider: "jira", connectionId: "jira-1", issueId: "1", issueKey: "ENG-1" },
        summary: "Fix login",
        status: "To Do",
        assignee: "Duda, Tomas",
      },
      {
        ref: { provider: "jira", connectionId: "jira-1", issueId: "2", issueKey: "ENG-2" },
        summary: "Release notes",
        status: "Closed",
      },
    ]);
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
    await flushPromises();
    await wrapper.find(".jira-search input").setValue("project = ENG ORDER BY updated DESC");
    await wrapper.find("form.jira-search").trigger("submit");
    await flushPromises();
    expect(wrapper.findAll(".jira-results .jira-issue")).toHaveLength(2);

    const done = wrapper.findAll(".jira-list-toolbar__group").find((button) => button.text().startsWith("Done"))!;
    expect(done.text()).toBe("Done 1");
    await done.trigger("click");
    expect(wrapper.findAll(".jira-results .jira-issue").map((row) => row.text())).toEqual([
      expect.stringContaining("ENG-2"),
    ]);
    await wrapper.findAll(".jira-list-toolbar__group")[0]!.trigger("click");
    await wrapper.find(".jira-list-toolbar__search").setValue("duda");
    expect(wrapper.findAll(".jira-results .jira-issue").map((row) => row.text())).toEqual([
      expect.stringContaining("ENG-1"),
    ]);

    await chooseCustomSelect(wrapper, ".jira-list-toolbar", "priority");
    expect(transport.searchJiraIssues).toHaveBeenLastCalledWith({
      connectionId: "jira-1",
      jql: "project = ENG ORDER BY priority DESC, updated DESC",
      limit: 50,
      cacheOnly: true,
    });
    wrapper.unmount();
  });

  test("a compact Issues list keeps the status groups and moves narrowing and sort into the Filters sheet", async () => {
    mockStoreState.isMobileSession = true;
    transport.searchJiraIssues.mockResolvedValue([
      {
        ref: { provider: "jira", connectionId: "jira-1", issueId: "1", issueKey: "ENG-1" },
        summary: "Fix login",
        status: "To Do",
        assignee: "Duda, Tomas",
      },
      {
        ref: { provider: "jira", connectionId: "jira-1", issueId: "2", issueKey: "ENG-2" },
        summary: "Release notes",
        status: "Closed",
      },
    ]);
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" }, attachTo: document.body });
    await flushPromises();
    await wrapper.find(".jira-search input").setValue("project = ENG ORDER BY updated DESC");
    await wrapper.find("form.jira-search").trigger("submit");
    await flushPromises();

    expect(wrapper.get(".jira-inbox").classes()).toContain("jira-inbox--filter-sheet");
    expect(wrapper.findAll(".jira-list-toolbar__group").length).toBeGreaterThan(0);
    expect(wrapper.find(".jira-list-toolbar__search").exists()).toBe(false);
    expect(wrapper.find(".jira-list-toolbar__sort").exists()).toBe(false);
    expect(wrapper.find(".jira-list-toolbar .jira-facets").exists()).toBe(false);
    expect(wrapper.find(".jira-controls > .jira-smart-filters").exists()).toBe(false);

    const toggle = wrapper.get(".jira-filter-sheet-toggle");
    await toggle.trigger("click");
    const sheet = wrapper.get(".jira-filter-sheet");
    // Pinned inside the pane's own scroll, so it sits at the bottom of the visible list.
    expect(sheet.element.parentElement).toBe(wrapper.get(".jira-inbox").element);
    expect(sheet.find(".jira-smart-filters").exists()).toBe(true);
    await sheet.get(".jira-filter-sheet__search").setValue("duda");
    expect(wrapper.findAll(".jira-results .jira-issue").map((row) => row.text())).toEqual([
      expect.stringContaining("ENG-1"),
    ]);
    expect(toggle.text()).toBe("Filters1");

    await chooseCustomSelect(wrapper, ".jira-filter-sheet", "priority");
    expect(transport.searchJiraIssues).toHaveBeenLastCalledWith({
      connectionId: "jira-1",
      jql: "project = ENG ORDER BY priority DESC, updated DESC",
      limit: 50,
      cacheOnly: true,
    });

    await sheet
      .findAll(".jira-filter-sheet__head .button")
      .find((button) => button.text() === "Done")!
      .trigger("click");
    expect(wrapper.find(".jira-filter-sheet").exists()).toBe(false);
    wrapper.unmount();
  });

  test("hides long-completed issues on a plain board until the user asks for all of them", async () => {
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
    await flushPromises();
    await chooseCustomSelect(wrapper, ".jira-board-controls", 42, 0);
    expect(transport.getJiraBoardView).toHaveBeenLastCalledWith(
      expect.objectContaining({ mode: "issues", doneWithinDays: 14 }),
    );
    await chooseCustomSelect(wrapper, ".jira-board-controls", "all", 2);
    expect(transport.getJiraBoardView).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ doneWithinDays: expect.anything() }),
    );
    wrapper.unmount();
  });

  test("filters every board page by Jira quick filter and stable assignee identity", async () => {
    transport.listJiraBoardQuickFilters.mockResolvedValue({
      filters: [{ id: 6, name: "My team", description: "Team issues", jql: "assignee is not EMPTY", position: 0 }],
      hasMore: false,
    });
    transport.searchJiraUsers.mockResolvedValue([
      { kind: "data-center", key: "jira-user-6", name: "alice", displayName: "Alice Smith" },
    ]);
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
    await flushPromises();
    await wrapper
      .findAll(".jira-view-tab")
      .find((tab) => tab.text() === "Board")!
      .trigger("click");
    await flushPromises();
    await chooseCustomSelect(wrapper, ".jira-board-controls", 42);
    await flushPromises();
    expect(wrapper.find(".jira-board-filter-chip").text()).toBe("My team");

    await wrapper.get("#jira-assignee-search").setValue("Alice");
    await new Promise((resolve) => setTimeout(resolve, 280));
    await flushPromises();
    await wrapper
      .findAll(".jira-assignee-results button")
      .find((button) => button.text().includes("Alice Smith"))!
      .trigger("click");
    await flushPromises();
    await wrapper.get(".jira-board-filter-chip").trigger("click");
    await flushPromises();
    expect(transport.searchJiraUsers).toHaveBeenCalledWith({ connectionId: "jira-1", query: "Alice", limit: 25 });
    expect(transport.getJiraBoardView).toHaveBeenLastCalledWith(
      expect.objectContaining({
        connectionId: "jira-1",
        boardId: 42,
        mode: "issues",
        quickFilterIds: [6],
        assignee: { kind: "user", id: "alice" },
        forceRefresh: true,
      }),
    );

    await wrapper
      .findAll(".jira-assignee-chip")
      .find((button) => button.text() === "All")!
      .trigger("click");
    await flushPromises();
    expect(transport.getJiraBoardView).toHaveBeenLastCalledWith(
      expect.objectContaining({ quickFilterIds: [6], forceRefresh: true }),
    );
    expect(transport.getJiraBoardView.mock.lastCall?.[0]).not.toHaveProperty("assignee");
    await wrapper.get(".jira-board-filter-chip").trigger("click");
    await flushPromises();
    expect(transport.getJiraBoardView.mock.lastCall?.[0]).not.toHaveProperty("quickFilterIds");
    wrapper.unmount();
  });

  test("Escape dismisses the applied board-filter panel and returns focus without clearing filters", async () => {
    const matchMedia = Object.getOwnPropertyDescriptor(window, "matchMedia");
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(
        () =>
          ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList,
      ),
    });
    transport.listJiraBoardQuickFilters.mockResolvedValue({
      filters: [{ id: 6, name: "My team", jql: "assignee is not EMPTY", position: 0 }],
      hasMore: false,
    });
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" }, attachTo: document.body });
    try {
      await flushPromises();
      await wrapper
        .findAll(".jira-view-tab")
        .find((tab) => tab.text() === "Board")!
        .trigger("click");
      await flushPromises();
      await chooseCustomSelect(wrapper, ".jira-board-controls", 42);
      await flushPromises();

      const details = wrapper.get(".jira-board-filter-details");
      const summary = details.get("summary");
      await summary.trigger("click");
      expect((details.element as HTMLDetailsElement).open).toBe(true);
      await wrapper.get(".jira-board-filter-chip").trigger("click");
      await flushPromises();
      const readsBeforeDismiss = transport.getJiraBoardView.mock.calls.length;

      const assigneeSearch = wrapper.get("#jira-assignee-search");
      (assigneeSearch.element as HTMLInputElement).focus();
      await assigneeSearch.trigger("keydown", { key: "Tab" });
      expect(document.activeElement).toBe(summary.element);
      expect((details.element as HTMLDetailsElement).open).toBe(true);

      await summary.trigger("keydown", { key: "Escape" });
      await flushPromises();

      expect((details.element as HTMLDetailsElement).open).toBe(false);
      expect(wrapper.get(".jira-board-filter-chip").attributes("aria-pressed")).toBe("true");
      expect(transport.getJiraBoardView.mock.calls).toHaveLength(readsBeforeDismiss);
      expect(document.activeElement).toBe(summary.element);
    } finally {
      wrapper.unmount();
      if (matchMedia) Object.defineProperty(window, "matchMedia", matchMedia);
      else Reflect.deleteProperty(window, "matchMedia");
    }
  });

  test("restores the selected board and quick filter per profile and workspace", async () => {
    transport.listJiraBoardQuickFilters.mockResolvedValue({
      filters: [{ id: 6, name: "My team", jql: "assignee is not EMPTY", position: 0 }],
      hasMore: false,
    });
    const first = mount(JiraInboxPane, { props: { workspaceId: "jira:prefs" } });
    await flushPromises();
    await first
      .findAll(".jira-view-tab")
      .find((tab) => tab.text() === "Board")!
      .trigger("click");
    await chooseCustomSelect(first, ".jira-board-controls", 42);
    await flushPromises();
    await first.get(".jira-board-filter-chip").trigger("click");
    await flushPromises();
    first.unmount();

    transport.getJiraBoardView.mockClear();
    const restored = mount(JiraInboxPane, { props: { workspaceId: "jira:prefs" } });
    await flushPromises();
    expect(transport.getJiraBoardView).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: "jira-1", boardId: 42, quickFilterIds: [6] }),
    );
    expect(restored.get(".jira-board-filter-chip").attributes("aria-pressed")).toBe("true");
    restored.unmount();

    transport.getJiraBoardView.mockClear();
    const otherWorkspace = mount(JiraInboxPane, { props: { workspaceId: "jira:other" } });
    await flushPromises();
    expect(transport.getJiraBoardView).not.toHaveBeenCalled();
    otherWorkspace.unmount();

    mockStoreState.payload = reactive({
      appState: {
        ...(mockStoreState.payload as { appState: Record<string, unknown> }).appState,
        activeProfileId: "another-profile",
      },
    });
    const otherProfile = mount(JiraInboxPane, { props: { workspaceId: "jira:prefs" } });
    await flushPromises();
    expect(transport.getJiraBoardView).not.toHaveBeenCalled();
    otherProfile.unmount();
  });

  test("hydrates and refreshes delayed issue previews, then dismisses on leave", async () => {
    const now = Date.now();
    transport.getJiraIssue
      .mockResolvedValueOnce({
        ref: { provider: "jira", connectionId: "jira-1", issueId: "1001", issueKey: "ENG-1" },
        summary: "Cached summary",
        status: "In Progress",
        assignee: "Alice",
        priority: "High",
        description: "A cached preview description",
        cache: { source: "cache", fetchedAt: now - 120_000, stale: true },
      })
      .mockResolvedValueOnce({
        ref: { provider: "jira", connectionId: "jira-1", issueId: "1001", issueKey: "ENG-1" },
        summary: "Fresh summary",
        status: "Done",
        assignee: "Alice",
        priority: "High",
        description: "Fresh preview description",
        cache: { source: "network", fetchedAt: now, stale: false },
      });
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" }, attachTo: document.body });
    await flushPromises();
    await wrapper
      .findAll(".jira-view-tab")
      .find((tab) => tab.text() === "Board")!
      .trigger("click");
    await flushPromises();
    await chooseCustomSelect(wrapper, ".jira-board-controls", 42);
    await flushPromises();

    const card = wrapper.get(".jira-board-issue");
    await card.trigger("mouseenter");
    await new Promise((resolve) => setTimeout(resolve, 370));
    await flushPromises();
    expect(document.getElementById("jira-issue-preview")).not.toBeNull();
    expect(document.body.textContent).toContain("Fresh summary");
    expect(document.body.textContent).toContain("Fresh preview description");
    expect(card.attributes("aria-describedby")).toBe("jira-issue-preview");
    expect(transport.getJiraIssue).toHaveBeenNthCalledWith(1, {
      connectionId: "jira-1",
      issueId: "1001",
      cacheOnly: true,
    });
    expect(transport.getJiraIssue).toHaveBeenNthCalledWith(2, {
      connectionId: "jira-1",
      issueId: "1001",
      forceRefresh: true,
    });

    await wrapper.get(".jira-board-issue").trigger("mouseleave");
    await flushPromises();
    expect(document.getElementById("jira-issue-preview")).toBeNull();
    expect(card.attributes("aria-describedby")).toBeUndefined();
    wrapper.unmount();
  });

  test("a slower earlier issue request cannot replace the latest selection", async () => {
    answerFirstOpenSearch();
    transport.searchJiraIssues.mockResolvedValueOnce([
      { ref: { provider: "jira", connectionId: "jira-1", issueId: "first", issueKey: "ENG-1" }, summary: "First" },
      { ref: { provider: "jira", connectionId: "jira-1", issueId: "second", issueKey: "ENG-2" }, summary: "Second" },
    ]);
    let resolveFirst!: (issue: unknown) => void;
    const firstResponse = new Promise((resolve) => (resolveFirst = resolve));
    transport.getJiraIssue.mockImplementation((payload: { issueId: string; cacheOnly?: boolean }) => {
      if (payload.cacheOnly) return Promise.resolve(null);
      if (payload.issueId === "first") return firstResponse;
      return Promise.resolve({
        ref: { provider: "jira", connectionId: "jira-1", issueId: "second", issueKey: "ENG-2" },
        summary: "Latest selected issue",
      });
    });
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
    await flushPromises();
    await wrapper.find("form.jira-search").trigger("submit");
    await flushPromises();
    const cards = wrapper.findAll(".jira-issue");
    await cards[0]!.trigger("click");
    await cards[1]!.trigger("click");
    await flushPromises();
    expect(wrapper.get(".jira-detail-header h2").text()).toBe("Latest selected issue");
    resolveFirst({
      ref: { provider: "jira", connectionId: "jira-1", issueId: "first", issueKey: "ENG-1" },
      summary: "Old issue",
    });
    await flushPromises();
    expect(wrapper.get(".jira-detail-header h2").text()).toBe("Latest selected issue");
    wrapper.unmount();
  });

  test("a detail response from the previous profile is discarded", async () => {
    transport.searchJiraIssues.mockResolvedValueOnce([
      {
        ref: { provider: "jira", connectionId: "jira-1", issueId: "old-profile", issueKey: "ENG-1" },
        summary: "Old profile issue",
      },
    ]);
    let resolveOldProfile!: (issue: unknown) => void;
    const oldProfileResponse = new Promise((resolve) => (resolveOldProfile = resolve));
    transport.getJiraIssue.mockImplementation((payload: { cacheOnly?: boolean }) =>
      payload.cacheOnly ? Promise.resolve(null) : oldProfileResponse,
    );
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
    await flushPromises();
    await wrapper.find("form.jira-search").trigger("submit");
    await flushPromises();
    await wrapper.get(".jira-issue").trigger("click");
    await flushPromises();

    (mockStoreState.payload as { appState: { activeProfileId: string } }).appState.activeProfileId = "other-profile";
    await flushPromises();
    resolveOldProfile({
      ref: { provider: "jira", connectionId: "jira-1", issueId: "old-profile", issueKey: "ENG-1" },
      summary: "Stale profile detail",
    });
    await flushPromises();

    expect(wrapper.find(".jira-detail-header").exists()).toBe(false);
    expect(wrapper.text()).not.toContain("Stale profile detail");
    wrapper.unmount();
  });

  test("shows board filter, owner, capabilities and bounded paging metadata", async () => {
    transport.getJiraBoardView.mockResolvedValueOnce(null).mockResolvedValueOnce({
      boardId: 42,
      mode: "issues",
      issues: [
        {
          ref: { provider: "jira", connectionId: "jira-1", issueId: "1001", issueKey: "ENG-1" },
          summary: "First",
          status: "Open",
        },
      ],
      columns: [{ name: "To Do", statuses: [{ id: "1", name: "Open" }] }],
      filter: { id: 3, name: "Engineering filter", jql: "project = ENG" },
      owner: { displayName: "Board owner" },
      capabilities: { issues: "available", backlog: "unknown", sprints: "unknown" },
      hasMore: true,
      nextCursor: "100",
      truncated: true,
    });
    transport.getJiraBoardView.mockResolvedValueOnce({
      boardId: 42,
      mode: "issues",
      issues: [
        {
          ref: { provider: "jira", connectionId: "jira-1", issueId: "1002", issueKey: "ENG-2" },
          summary: "Second",
          status: "Open",
        },
      ],
      hasMore: false,
      truncated: false,
    });
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
    await flushPromises();
    await chooseCustomSelect(wrapper, ".jira-board-controls", 42);
    await flushPromises();
    expect(wrapper.text()).toContain("Engineering filter");
    expect(wrapper.text()).not.toContain("Issues: available");
    expect(wrapper.text()).toContain("Showing the first page of this board");
    await wrapper
      .findAll(".jira-view-tab")
      .find((tab) => tab.text() === "Board")!
      .trigger("click");
    await flushPromises();
    await wrapper
      .findAll("button")
      .find((button) => button.text().includes("Load more"))!
      .trigger("click");
    await flushPromises();
    expect(transport.getJiraBoardView).toHaveBeenLastCalledWith({
      connectionId: "jira-1",
      boardId: 42,
      mode: "issues",
      cursor: "100",
      doneWithinDays: 14,
    });
    expect(wrapper.text()).toContain("ENG-2");
    expect(wrapper.text()).not.toContain("Showing the first page of this board");
  });

  test("matches board columns by status id and keeps unmatched Jira issues accessible", async () => {
    answerFirstOpenSearch();
    transport.getJiraBoardView.mockResolvedValueOnce(null).mockResolvedValueOnce({
      boardId: 42,
      mode: "issues",
      issues: [
        {
          ref: { provider: "jira", connectionId: "jira-1", issueId: "2001", issueKey: "ENG-21" },
          summary: "Mapped by status id",
          status: "Open",
          statusId: "1",
        },
        {
          ref: { provider: "jira", connectionId: "jira-1", issueId: "2002", issueKey: "ENG-22" },
          summary: "Unmapped issue remains available",
          status: "Open",
          statusId: "9",
        },
      ],
      columns: [{ name: "To Do", statuses: [{ id: "1", name: "" }] }],
      hasMore: false,
    });
    transport.getJiraIssue.mockResolvedValueOnce({
      ref: { provider: "jira", connectionId: "jira-1", issueId: "2001", issueKey: "ENG-21" },
      summary: "Mapped by status id",
      status: "Open",
      issueType: "Task",
      priority: "High",
      reporter: "Alex Reporter",
      created: "2026-01-02T10:00:00Z",
      updated: "2026-01-03T10:00:00Z",
      resolution: "Fixed",
      labels: ["regression"],
      components: ["Web"],
      versions: ["2.0"],
      issueLinks: [{ type: "blocks", direction: "outward", issueKey: "ENG-23", summary: "Follow-up", status: "Open" }],
      description:
        "A useful issue description. See https://example.com/guide?from=jira&view=full. <img src=x onerror=alert(1)>",
    });
    transport.searchJiraIssues.mockResolvedValueOnce([
      {
        ref: { provider: "jira", connectionId: "jira-1", issueId: "2001", issueKey: "ENG-21" },
        summary: "Mapped by status id",
      },
      {
        ref: { provider: "jira", connectionId: "jira-1", issueId: "2002", issueKey: "ENG-22" },
        summary: "Unmapped issue remains available",
      },
    ]);

    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" }, attachTo: document.body });
    await flushPromises();
    await wrapper
      .findAll(".jira-view-tab")
      .find((tab) => tab.text() === "Board")!
      .trigger("click");
    await flushPromises();
    await chooseCustomSelect(wrapper, ".jira-board-controls", 42);
    await flushPromises();

    expect(wrapper.findAll(".jira-board-column .jira-board-issue").map((issue) => issue.text())).toEqual([
      expect.stringContaining("ENG-21"),
    ]);
    expect(wrapper.get(".jira-board-unmapped").text()).toContain("ENG-22");
    await wrapper
      .findAll(".jira-view-tab")
      .find((tab) => tab.text() === "Issues")!
      .trigger("click");
    await wrapper.find("form.jira-search").trigger("submit");
    await flushPromises();
    await wrapper.findAll(".jira-issue")[0]!.trigger("click");
    await flushPromises();
    expect(wrapper.get(".jira-detail-header").text()).toContain("Task");
    expect(wrapper.get(".jira-detail-meta").text()).toContain("High");
    expect(wrapper.get(".jira-detail-meta").text()).toContain("Unassigned");
    expect(wrapper.get(".jira-detail-sidebar").text()).toContain("Alex Reporter");
    expect(wrapper.get(".jira-issue-links").text()).toContain("ENG-23");
    expect(wrapper.get(".jira-detail-layout").text()).toContain("A useful issue description.");
    expect(wrapper.get(".jira-description").find("a").attributes("href")).toBe(
      "https://example.com/guide?from=jira&view=full",
    );
    expect(wrapper.get(".jira-description").find("img").exists()).toBe(false);
    expect(wrapper.get(".jira-description").text()).toContain("<img src=x onerror=alert(1)>");
    expect(branchPanel(wrapper).exists()).toBe(false);
    expect(wrapper.get(".jira-comments .jira-detail-card__title").text()).toBe("Comments 1");
    expect(wrapper.get(".jira-comment__meta").text()).toContain("Alice");
    expect(wrapper.get(".jira-comment__meta").text()).not.toContain("Example s.r.o.");
    const commentButton = wrapper
      .get(".jira-detail-header__actions")
      .findAll("button")
      .find((button) => button.text() === "Comment");
    await commentButton!.trigger("click");
    await flushPromises();
    expect(document.activeElement).toBe(wrapper.get(COMMENT_BOX).element);
    await wrapper
      .get(".jira-detail-header__actions")
      .findAll("button")
      .find((button) => button.text() === "Start development")!
      .trigger("click");
    await flushPromises();
    expect(branchPanel(wrapper).exists()).toBe(true);
    await wrapper.findAll(".jira-issue")[1]!.trigger("click");
    await flushPromises();
    expect(branchPanel(wrapper).exists()).toBe(false);
    wrapper.unmount();
  });

  test("remote read-only transport keeps issue reads available and hides desktop mutations", async () => {
    const remoteApi = createRemoteTransport() as unknown as Record<string, unknown>;
    Object.assign(remoteApi, {
      listJiraConnections: transport.listJiraConnections,
      searchJiraBoards: vi
        .fn()
        .mockResolvedValue({ boards: [{ id: 42, name: "Engineering board", type: "scrum" }], hasMore: false }),
      listJiraQueries: transport.listJiraQueries,
      searchJiraIssues: transport.searchJiraIssues,
      getJiraIssue: transport.getJiraIssue,
      listJiraComments: transport.listJiraComments,
    });
    for (const method of ["previewJiraWrite", "executeJiraWrite", "listJiraTransitions"]) delete remoteApi[method];
    mockStoreState.transportApi = remoteApi;
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
    mockStoreState.transportApi = null;
    await flushPromises();
    await showBoardView(wrapper);
    await wrapper.find(".jira-board-controls > label").trigger("click");
    await flushPromises();
    expect(transport.listJiraConnections).toHaveBeenCalledOnce();
    expect(remoteApi.searchJiraBoards).toHaveBeenCalledWith({ connectionId: "jira-1", limit: 50 });
    expect(transport.listJiraQueries).toHaveBeenCalledWith("jira-1");
    await wrapper
      .findAll(".jira-view-tab")
      .find((tab) => tab.text() === "Issues")!
      .trigger("click");

    await wrapper.find("form.jira-search").trigger("submit");
    await flushPromises();
    expect(transport.searchJiraIssues).toHaveBeenCalled();
    await wrapper.find(".jira-issue").trigger("click");
    await flushPromises();
    expect(transport.getJiraIssue).toHaveBeenCalled();
    expect(transport.listJiraComments).toHaveBeenCalled();

    expect(wrapper.find(".jira-connection-form").exists()).toBe(false);
    expect(wrapper.find(".jira-write").exists()).toBe(false);
    expect(wrapper.find(".jira-comment-composer").exists()).toBe(false);
    expect(wrapper.find(".jira-status-menu").exists()).toBe(false);
    expect(wrapper.find(".jira-assign-menu").exists()).toBe(false);
    expect(branchPanel(wrapper).exists()).toBe(false);
    expect(wrapper.findAll(".jira-detail-readonly")).toHaveLength(1);
    expect(wrapper.text()).toContain("Read-only here.");
    expect(wrapper.text()).toContain("Start development");
    expect(wrapper.text()).not.toContain("Starting development from Jira is available in the desktop app.");
    expect(
      wrapper.findAll(".jira-views-menu__panel [role=menuitem]").some((item) => item.text().startsWith("My issues")),
    ).toBe(true);
    expect(wrapper.find('input[inputmode="numeric"]').exists()).toBe(false);
    expect(remoteApi.executeJiraWrite).toBeUndefined();
    expect(remoteApi.saveJiraConnection).toBeUndefined();
    expect(remoteApi.getJiraSavedFilter).toBeUndefined();
    expect(remoteApi.listJiraFavoriteFilters).toBeUndefined();
    expect(remoteApi.getJiraRepoBindingPreference).toBeUndefined();
  });

  test("remote transport with write methods offers issue writes and keeps attachments desktop-only", async () => {
    const remoteApi = createRemoteTransport() as unknown as Record<string, unknown>;
    Object.assign(remoteApi, {
      listJiraConnections: transport.listJiraConnections,
      searchJiraBoards: vi
        .fn()
        .mockResolvedValue({ boards: [{ id: 42, name: "Engineering board", type: "scrum" }], hasMore: false }),
      listJiraQueries: transport.listJiraQueries,
      searchJiraIssues: transport.searchJiraIssues,
      getJiraIssue: transport.getJiraIssue,
      listJiraComments: transport.listJiraComments,
      listJiraTransitions: vi.fn().mockResolvedValue([]),
      previewJiraWrite: vi.fn(),
      executeJiraWrite: vi.fn(),
    });
    mockStoreState.transportApi = remoteApi;
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
    mockStoreState.transportApi = null;
    await flushPromises();
    await showBoardView(wrapper);
    await wrapper.find(".jira-board-controls > label").trigger("click");
    await flushPromises();
    expect(transport.listJiraConnections).toHaveBeenCalledOnce();
    expect(remoteApi.searchJiraBoards).toHaveBeenCalledWith({ connectionId: "jira-1", limit: 50 });
    expect(transport.listJiraQueries).toHaveBeenCalledWith("jira-1");
    await wrapper
      .findAll(".jira-view-tab")
      .find((tab) => tab.text() === "Issues")!
      .trigger("click");

    await wrapper.find("form.jira-search").trigger("submit");
    await flushPromises();
    expect(transport.searchJiraIssues).toHaveBeenCalled();
    await wrapper.find(".jira-issue").trigger("click");
    await flushPromises();
    expect(transport.getJiraIssue).toHaveBeenCalled();
    expect(transport.listJiraComments).toHaveBeenCalled();

    expect(wrapper.find(".jira-connection-form").exists()).toBe(false);
    expect(wrapper.find(".jira-status-menu").exists()).toBe(true);
    expect(wrapper.find(".jira-assign-menu").exists()).toBe(true);
    expect(wrapper.find(".jira-write-details").exists()).toBe(true);
    expect(wrapper.text()).toContain("Comment");
    expect(wrapper.text()).not.toContain("Add attachment");
    expect(wrapper.text()).toContain("Attachments are available in the desktop app.");
    expect(wrapper.text()).not.toContain("Read-only here.");
    expect(remoteApi.uploadJiraIssueAttachment).toBeUndefined();
    expect(remoteApi.saveJiraIssueAttachment).toBeUndefined();
    expect(remoteApi.saveJiraConnection).toBeUndefined();
  });

  test("pages sprint metadata separately and loads paged issues for the selected sprint", async () => {
    transport.listJiraBoards.mockResolvedValue([{ id: 42, name: "Engineering board", type: "scrum" }]);
    transport.getJiraBoardView
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        boardId: 42,
        mode: "issues",
        issues: [],
      })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        boardId: 42,
        mode: "sprints",
        issues: [],
        sprints: [{ id: 10, name: "Sprint 10", state: "closed" }],
        sprintsHasMore: true,
        sprintsNextCursor: "sprint-page-2",
        capabilities: { configuration: "available", issues: "available", backlog: "unknown", sprints: "available" },
      })
      .mockResolvedValueOnce({
        boardId: 42,
        mode: "sprints",
        sprintId: 10,
        columns: [{ name: "Active", statuses: [{ id: "open", name: "Open" }] }],
        issues: [
          {
            ref: { provider: "jira", connectionId: "jira-1", issueId: "1010", issueKey: "ENG-10" },
            summary: "First sprint issue",
            status: "Open",
          },
        ],
        hasMore: true,
        nextCursor: "issue-page-2",
        truncated: true,
        capabilities: { configuration: "available", issues: "available", backlog: "unknown", sprints: "available" },
      })
      .mockResolvedValueOnce({
        boardId: 42,
        mode: "sprints",
        sprints: [{ id: 9, name: "Sprint 9", state: "closed" }],
        sprintsHasMore: false,
      })
      .mockResolvedValueOnce({
        boardId: 42,
        mode: "sprints",
        sprintId: 10,
        cursor: "issue-page-2",
        issues: [
          {
            ref: { provider: "jira", connectionId: "jira-1", issueId: "1011", issueKey: "ENG-11" },
            summary: "Second sprint issue",
            status: "Done",
          },
        ],
        hasMore: false,
        truncated: false,
      });
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
    await flushPromises();
    await wrapper
      .findAll(".jira-view-tab")
      .find((tab) => tab.text() === "Board")!
      .trigger("click");
    await chooseCustomSelect(wrapper, ".jira-board-controls", 42, 0);
    await chooseCustomSelect(wrapper, ".jira-board-controls", "sprints", 1);
    expect(wrapper.text()).toContain("No active sprint is available on this board.");
    await chooseCustomSelect(wrapper, ".jira-board-controls", 10, 2);
    await flushPromises();

    expect(transport.getJiraBoardView).toHaveBeenLastCalledWith({
      connectionId: "jira-1",
      boardId: 42,
      mode: "sprints",
      sprintId: 10,
    });
    expect(wrapper.text()).toContain("First sprint issue");
    expect(
      wrapper.findAll(".jira-board-column .jira-board-issue").some((button) => button.text().includes("ENG-10")),
    ).toBe(true);
    expect(wrapper.text()).not.toContain("Configuration: available");
    expect(wrapper.text()).toContain("Showing the first page of this sprint");

    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Load more")!
      .trigger("click");
    await flushPromises();
    expect(transport.getJiraBoardView).toHaveBeenLastCalledWith({
      connectionId: "jira-1",
      boardId: 42,
      mode: "sprints",
      cursor: "sprint-page-2",
    });
    expect(
      customSelectProps(wrapper.get(".jira-board-options").findAllComponents(CustomSelect)[1]!).options.map(
        (option) => option.label,
      ),
    ).toContain("Sprint 9 · closed");

    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Load more sprint issues")!
      .trigger("click");
    await flushPromises();
    expect(transport.getJiraBoardView).toHaveBeenLastCalledWith({
      connectionId: "jira-1",
      boardId: 42,
      mode: "sprints",
      sprintId: 10,
      cursor: "issue-page-2",
    });
    expect(wrapper.text()).toContain("Second sprint issue");
    expect(wrapper.text()).not.toContain("Showing the first page of this sprint");
  });

  test("shows permission-denied sprint capability and surfaces sprint issue errors", async () => {
    transport.listJiraBoards.mockResolvedValue([{ id: 42, name: "Engineering board", type: "scrum" }]);
    transport.getJiraBoardView
      .mockResolvedValueOnce({
        boardId: 42,
        mode: "sprints",
        issues: [],
        sprints: [{ id: 10, name: "Sprint 10", state: "active" }],
      })
      .mockResolvedValueOnce({
        boardId: 42,
        mode: "sprints",
        issues: [],
        sprints: [{ id: 10, name: "Sprint 10", state: "active" }],
        capabilities: {
          configuration: "permission-denied",
          issues: "permission-denied",
          backlog: "unknown",
          sprints: "permission-denied",
        },
      })
      .mockRejectedValueOnce(new Error("Jira denied access to sprint issues"));
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
    await flushPromises();
    await wrapper
      .findAll(".jira-view-tab")
      .find((tab) => tab.text() === "Board")!
      .trigger("click");
    await chooseCustomSelect(wrapper, ".jira-board-controls", 42, 0);
    await flushPromises();
    // A scrum board opens on its active sprint without choosing the view or the sprint first.
    expect(transport.getJiraBoardView).toHaveBeenNthCalledWith(1, expect.objectContaining({ mode: "sprints" }));
    expect(transport.getJiraBoardView).toHaveBeenLastCalledWith(
      expect.objectContaining({ mode: "sprints", sprintId: 10 }),
    );
    expect(wrapper.text()).toContain("did not allow this account to read the board’s configuration, issues, sprints");
    expect(wrapper.text()).not.toContain("Sprints: permission-denied");
    expect(wrapper.text()).toContain("Jira denied access to sprint issues");
  });

  test("loads saved queries and comments and shows a refused comment beside the composer without losing it", async () => {
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
    await flushPromises();
    expect(transport.listJiraQueries).toHaveBeenCalledWith("jira-1");
    await wrapper.find("form.jira-search").trigger("submit");
    await flushPromises();
    await wrapper.find(".jira-issue").trigger("click");
    await flushPromises();
    expect(transport.listJiraComments).toHaveBeenCalledOnce();
    expect(wrapper.text()).toContain("Reviewed");
    await wrapper
      .findAll(".jira-comments button")
      .find((button) => button.text() === "Refresh comments")!
      .trigger("click");
    await flushPromises();
    expect(transport.listJiraComments).toHaveBeenCalledTimes(2);
    transport.previewJiraWrite.mockResolvedValueOnce({
      token: "stale",
      intent: "Share reviewed findings",
      preview: "Exact preview",
      account: { displayName: "Build Bot", purpose: "technical" },
    });
    transport.executeJiraWrite.mockResolvedValueOnce({
      ok: false,
      error: { code: "unknown", message: "Preparation expired; preview the action again.", status: "failed" },
    });
    await sendComment(wrapper, "Reviewed this change.");
    expect(wrapper.get(".jira-comment-composer [role=alert]").text()).toContain("Preparation expired");
    expect(wrapper.get(COMMENT_BOX).element).toHaveProperty("value", "Reviewed this change.");
  });

  test("supports multi-issue workspace links and the same issue in multiple profile workspaces", async () => {
    const ref = { provider: "jira" as const, connectionId: "jira-1", issueId: "1001", issueKey: "ENG-1" };
    const state = mockStoreState.payload as { appState: { workspaces: Array<Record<string, unknown>> } };
    state.appState.workspaces.splice(
      0,
      1,
      {
        id: "ws-1",
        name: "Payments",
        profileId: "default",
        workItems: [
          { ref, summary: "Fix login", status: "Open" },
          {
            ref: { provider: "jira", connectionId: "deleted-connection", issueId: "2002", issueKey: "ENG-2" },
            summary: "Historical",
            status: "Closed",
          },
        ],
      },
      { id: "ws-2", name: "Platform", profileId: "default", workItems: [] },
      { id: "ws-foreign", name: "Other profile", profileId: "other", workItems: [] },
    );
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
    await flushPromises();
    await wrapper.find("form.jira-search").trigger("submit");
    await flushPromises();
    await wrapper.find(".jira-issue").trigger("click");
    await flushPromises();
    const moreActions = wrapper.get(".jira-detail-header__actions > details:last-child");
    await moreActions.get("summary").trigger("click");
    await moreActions
      .findAll("[role=menuitem]")
      .find((item) => item.text() === "Link workspace…")!
      .trigger("click");
    expect(customSelectProps(wrapper.find(".jira-workspace-links").findComponent(CustomSelect)).options).toEqual([
      { value: "ws-2", label: "Platform" },
    ]);
    expect(wrapper.findAll(".jira-workspace-links > p").map((node) => node.text())).toContain("Payments Unlink");
    await chooseCustomSelect(wrapper, ".jira-workspace-links", "ws-2");
    await wrapper
      .findAll(".jira-workspace-links button")
      .find((button) => button.text() === "Link issue")!
      .trigger("click");
    await flushPromises();
    const targetWorkspace = state.appState.workspaces.find((workspace) => workspace.id === "ws-2")!;
    targetWorkspace.workItems = [{ ref, summary: "Fix login", status: "Open" }];
    await flushPromises();
    expect(wrapper.findAll(".jira-workspace-links > p")).toHaveLength(2);
    expect(transport.attachJiraIssueToWorkspace).toHaveBeenCalledWith({
      workspaceId: "ws-2",
      ref: expect.objectContaining({ connectionId: "jira-1", issueId: "1001" }),
    });
    await wrapper
      .findAll(".jira-workspace-links button")
      .find((button) => button.text() === "Unlink")!
      .trigger("click");
    await flushPromises();
    expect(transport.detachJiraIssueFromWorkspace).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      ref: expect.objectContaining({ connectionId: "jira-1", issueId: "1001" }),
    });
    expectEveryCallToMatch(jiraWorkspaceIssueLinkSchema, transport.attachJiraIssueToWorkspace);
    expectEveryCallToMatch(jiraWorkspaceIssueLinkSchema, transport.detachJiraIssueFromWorkspace);
  });

  test("Cloud onboarding asks for the site, email and an API token and saves exactly that", async () => {
    transport.listJiraConnections.mockResolvedValueOnce([]);
    transport.saveJiraConnection.mockResolvedValueOnce({ ok: true, connection: { id: "cloud-1" } });
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" }, attachTo: document.body });
    await flushPromises();
    await chooseCustomSelect(wrapper, ".jira-setup", "cloud");
    expect(wrapper.text()).toContain("API token you create yourself");
    await wrapper.get(".jira-setup__actions button:not(.button--ghost)").trigger("click");
    await flushPromises();
    const site = wrapper.get('input[placeholder="https://your-site.atlassian.net"]');
    expect(document.activeElement).toBe(site.element);
    expect(wrapper.find("input[type=email]").attributes("placeholder")).toBe("me@example.com");
    expect(wrapper.findAll(".jira-setup input[type=password]")).toHaveLength(1);
    expect(wrapper.text()).not.toContain("Continue with Atlassian");

    await wrapper.get(".jira-setup__actions button:not(.button--ghost)").trigger("click");
    expect(wrapper.text()).toContain("Enter your Jira site address");
    expect(transport.saveJiraConnection).not.toHaveBeenCalled();

    await site.setValue("https://example.atlassian.net");
    await wrapper.get(".jira-setup input[type=email]").setValue("not-an-email");
    await wrapper.get(".jira-setup input[type=password]").setValue("api-token-value");
    await wrapper.get(".jira-setup__actions button:not(.button--ghost)").trigger("click");
    expect(wrapper.text()).toContain("Enter the email address of your Atlassian account.");
    expect(transport.saveJiraConnection).not.toHaveBeenCalled();

    await wrapper.get(".jira-setup input[type=email]").setValue("me@example.com");
    await wrapper.get(".jira-setup__actions button:not(.button--ghost)").trigger("click");
    await flushPromises();
    expect(transport.saveJiraConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        label: "example.atlassian.net",
        deployment: "cloud",
        webUrl: "https://example.atlassian.net",
        apiBaseUrl: "https://example.atlassian.net",
        email: "me@example.com",
        apiToken: "api-token-value",
      }),
    );
    expect(jiraConnectionSaveSchema.safeParse(transport.saveJiraConnection.mock.calls[0]?.[0]).success).toBe(true);
    expect(wrapper.text()).toContain("Jira connection verified");
  });

  test("Cloud setup tests the draft with the real schema and links to the API token page", async () => {
    transport.listJiraConnections.mockResolvedValueOnce([]);
    transport.testJiraConnection.mockResolvedValueOnce({ ok: true, identity: { displayName: "Me" } });
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" }, attachTo: document.body });
    await flushPromises();
    await chooseCustomSelect(wrapper, ".jira-setup", "cloud");
    await wrapper.get(".jira-setup__actions button:not(.button--ghost)").trigger("click");
    await flushPromises();
    await wrapper.get('input[placeholder="https://your-site.atlassian.net"]').setValue("https://example.atlassian.net");
    await wrapper.get(".jira-setup input[type=email]").setValue("me@example.com");
    await wrapper.get(".jira-setup input[type=password]").setValue("api-token-value");
    await wrapper.get(".jira-setup__actions button.button--ghost").trigger("click");
    await flushPromises();
    expect(wrapper.get(".jira-setup__test-result").text()).toContain("Connection test passed");
    expect(transport.testJiraConnection).toHaveBeenCalledWith(
      expect.objectContaining({ deployment: "cloud", email: "me@example.com", apiToken: "api-token-value" }),
    );
    expect(jiraConnectionTestSchema.safeParse(transport.testJiraConnection.mock.calls[0]?.[0]).success).toBe(true);
    expect(transport.saveJiraConnection).not.toHaveBeenCalled();

    await wrapper
      .findAll(".jira-setup a")
      .find((link) => link.text() === "Create an API token")!
      .trigger("click");
    expect(transport.openExternal).toHaveBeenCalledWith("https://id.atlassian.com/manage-profile/security/api-tokens");
  });

  test("a Cloud connection is edited through the same form, keeping the saved token when left blank", async () => {
    transport.listJiraConnections.mockResolvedValue([
      {
        id: "cloud-1",
        label: "Cloud site",
        deployment: "cloud",
        webUrl: "https://example.atlassian.net",
        apiBaseUrl: "https://example.atlassian.net",
        auth: { kind: "cloud-api-token", email: "me@example.com" },
        verifiedIdentity: { displayName: "Me" },
      },
    ]);
    transport.saveJiraConnection.mockResolvedValueOnce({ ok: true, connection: { id: "cloud-1" } });
    const wrapper = mount(JiraInboxPane, { props: { connectionsOnly: true }, attachTo: document.body });
    await flushPromises();
    expect(wrapper.get(".jira-settings-manager").text()).toContain("Jira Cloud · API token");
    await openConnectionTab(wrapper);
    await flushPromises();
    expect(wrapper.get(".jira-connection-edit-card__tab--active").text()).toBe("Connection");
    expect((wrapper.get(".jira-setup input[type=email]").element as HTMLInputElement).value).toBe("me@example.com");
    expect(wrapper.get(".jira-setup input[type=password]").attributes("placeholder")).toBe(
      "Leave blank to keep the saved token",
    );
    await wrapper
      .findAll(".jira-setup__actions button")
      .find((button) => button.text() === "Save connection")!
      .trigger("click");
    await flushPromises();
    expect(transport.saveJiraConnection).toHaveBeenCalledWith(
      expect.objectContaining({ id: "cloud-1", deployment: "cloud", email: "me@example.com", apiToken: "" }),
    );
    expect(jiraConnectionSaveSchema.safeParse(transport.saveJiraConnection.mock.calls[0]?.[0]).success).toBe(true);
  });

  test("a failed Cloud save is shown in the form and keeps the typed details", async () => {
    transport.listJiraConnections.mockResolvedValueOnce([]);
    transport.saveJiraConnection.mockRejectedValueOnce(new Error("Jira rejected the email or API token."));
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" }, attachTo: document.body });
    await flushPromises();
    await chooseCustomSelect(wrapper, ".jira-setup", "cloud");
    await wrapper.get(".jira-setup__actions button:not(.button--ghost)").trigger("click");
    await flushPromises();
    await wrapper.get('input[placeholder="https://your-site.atlassian.net"]').setValue("https://example.atlassian.net");
    await wrapper.get(".jira-setup input[type=email]").setValue("me@example.com");
    await wrapper.get(".jira-setup input[type=password]").setValue("api-token-value");
    await wrapper.get(".jira-setup__actions button:not(.button--ghost)").trigger("click");
    await flushPromises();
    expect(wrapper.get(".jira-setup__test-result").text()).toContain("Jira rejected the email or API token.");
    expect((wrapper.get(".jira-setup input[type=email]").element as HTMLInputElement).value).toBe("me@example.com");
  });

  test("edits Jira metadata without asking for or changing the credential", async () => {
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
    await flushPromises();
    await openSettingsView(wrapper);
    const dispatch = vi.spyOn(window, "dispatchEvent");
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Edit")!
      .trigger("click");
    await wrapper.find(".jira-connection-edit input").setValue("Build Jira");
    await chooseCustomSelect(wrapper, ".jira-connection-edit", "technical");
    await wrapper.find('[aria-label="Link issue keys to this connection"]').setValue("app, OPS, app");
    await wrapper
      .findAll(".jira-connection-edit button")
      .find((button) => button.text() === "Save details")!
      .trigger("click");
    await flushPromises();
    expect(transport.updateJiraConnectionMetadata).toHaveBeenCalledWith({
      connectionId: "jira-1",
      label: "Build Jira",
      accountPurpose: "technical",
      issueKeyPrefixes: ["APP", "OPS"],
      defaultJql: "",
      projectKeys: [],
      // A connection saved before the 15-minute floor is offered at the floor, never sent below it.
      pollSeconds: 900,
    });
    expectEveryCallToMatch(jiraConnectionMetadataSchema, transport.updateJiraConnectionMetadata);
    expect(transport.saveJiraConnection).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "strideterm:jira-link-routes-changed" }));
  });

  test("connection create and delete invalidate mounted Jira link routes", async () => {
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" }, attachTo: document.body });
    await flushPromises();
    await openSettingsView(wrapper);
    const dispatch = vi.spyOn(window, "dispatchEvent");
    await wrapper.get(".jira-settings-manager__heading button").trigger("click");
    await flushPromises();
    await chooseCustomSelect(wrapper, ".jira-setup", "pat");
    await wrapper.get(".jira-setup__actions button:not(.button--ghost)").trigger("click");
    await flushPromises();
    const formFields = wrapper.findAll(".jira-setup input");
    await formFields[0].setValue("https://new.example");
    await formFields[1].setValue("https://new.example/jira");
    await formFields[2].setValue("pat");
    await wrapper.get(".jira-setup__actions button:not(.button--ghost)").trigger("click");
    await flushPromises();
    expect(transport.saveJiraConnection).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "strideterm:jira-link-routes-changed" }));
    dispatch.mockClear();
    await wrapper.get(".jira-setup__actions button").trigger("click");
    await flushPromises();
    await wrapper
      .findAll(".jira-settings-manager__actions button")
      .find((button) => button.text() === "Disconnect")!
      .trigger("click");
    await flushPromises();
    expect(transport.deleteJiraConnection).toHaveBeenCalledWith("jira-1");
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "strideterm:jira-link-routes-changed" }));
    expect(transport.confirmInApp).toHaveBeenCalledWith(
      expect.objectContaining({ confirmLabel: "Disconnect", danger: true }),
    );
    wrapper.unmount();
  });

  test("all connections performs only text search and labels the source connection", async () => {
    transport.listJiraConnections.mockResolvedValue([
      { id: "jira-1", label: "Engineering", deployment: "cloud", webUrl: "https://one.example" },
      { id: "jira-2", label: "Operations", deployment: "cloud", webUrl: "https://two.example" },
    ]);
    transport.searchJiraIssues.mockImplementation(async ({ connectionId }: { connectionId: string }) => [
      {
        ref: { provider: "jira", connectionId, issueId: "100", issueKey: "OPS-1" },
        summary: "Shared phrase",
      },
    ]);
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
    await flushPromises();
    transport.searchJiraIssues.mockClear();
    await chooseCustomSelect(wrapper, ".jira-head", "__all__");
    await wrapper.find('input[placeholder="Search issue text"]').setValue('release "candidate"');
    await wrapper.find("form.jira-search").trigger("submit");
    await flushPromises();
    expect(transport.searchJiraIssues).toHaveBeenCalledTimes(2);
    expect(transport.searchJiraIssues).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "jira-1",
        jql: 'text ~ "release" AND text ~ "candidate" ORDER BY updated DESC',
      }),
    );
    expect(wrapper.text()).toContain("Source: Engineering");
    expect(wrapper.text()).toContain("Source: Operations");
    expect(wrapper.findAll(".jira-issue")).toHaveLength(2);
    expect(wrapper.find("input[placeholder*='currentUser']").exists()).toBe(false);
    await wrapper.findAll(".jira-issue")[1].trigger("click");
    await flushPromises();
    expect(transport.getJiraIssue).toHaveBeenCalledWith({ connectionId: "jira-2", issueId: "100", cacheOnly: true });
  });

  test("all connections My issues builds a separate verified identity query per connection", async () => {
    transport.listJiraConnections.mockResolvedValue([
      {
        id: "jira-1",
        label: "Engineering",
        deployment: "cloud",
        webUrl: "https://one.example",
        ownIdentity: { displayName: "Alice" },
      },
      {
        id: "jira-2",
        label: "Operations",
        deployment: "cloud",
        webUrl: "https://two.example",
        ownIdentity: { displayName: "Bob" },
      },
    ]);
    transport.buildJiraOwnIssuesQuery.mockImplementation(async ({ connectionId }: { connectionId: string }) => ({
      jql: `assignee = "${connectionId}"`,
      identityLabel: connectionId,
    }));
    transport.searchJiraIssues.mockImplementation(async ({ connectionId }: { connectionId: string }) => [
      {
        ref: { provider: "jira", connectionId, issueId: connectionId, issueKey: `${connectionId}-1` },
        summary: "Assigned issue",
      },
    ]);
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
    await flushPromises();
    transport.searchJiraIssues.mockClear();
    transport.buildJiraOwnIssuesQuery.mockClear();
    await chooseCustomSelect(wrapper, ".jira-head", "__all__");
    await chooseView(wrapper, "My issues, including done");
    expect(transport.buildJiraOwnIssuesQuery).toHaveBeenCalledTimes(2);
    expect(transport.searchJiraIssues).toHaveBeenCalledTimes(2);
    expect(wrapper.text()).toContain("Source: Engineering · jira-1");
    expect(wrapper.text()).toContain("Source: Operations · jira-2");
  });

  test("aggregated My open issues pages each connection independently", async () => {
    transport.listJiraConnections.mockResolvedValue([
      {
        id: "jira-1",
        label: "Engineering",
        deployment: "cloud",
        webUrl: "https://one.example",
        ownIdentity: { displayName: "Alice" },
      },
      {
        id: "jira-2",
        label: "Operations",
        deployment: "cloud",
        webUrl: "https://two.example",
        ownIdentity: { displayName: "Bob" },
      },
    ]);
    transport.buildJiraOwnIssuesQuery.mockImplementation(
      async ({ connectionId, baseJql }: { connectionId: string; baseJql?: string }) => ({
        jql: `(${baseJql}) AND assignee = "${connectionId}"`,
        identityLabel: connectionId,
      }),
    );
    transport.searchJiraIssues.mockImplementation(
      async ({ connectionId, cursor }: { connectionId: string; cursor?: string }) => {
        if (!cursor)
          return {
            issues: [
              {
                ref: { provider: "jira", connectionId, issueId: `${connectionId}-1`, issueKey: `${connectionId}-1` },
                summary: "First",
              },
            ],
            hasMore: true,
            nextCursor: `${connectionId}-next`,
          };
        return {
          issues: [
            {
              ref: { provider: "jira", connectionId, issueId: `${connectionId}-2`, issueKey: `${connectionId}-2` },
              summary: "Second",
            },
          ],
          hasMore: false,
        };
      },
    );
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
    await flushPromises();
    await chooseCustomSelect(wrapper, ".jira-head", "__all__");
    await chooseView(wrapper, "Assigned to you, not done");
    expect(transport.buildJiraOwnIssuesQuery).toHaveBeenCalledWith({
      connectionId: "jira-1",
      baseJql: "statusCategory != Done",
    });
    expect(wrapper.text()).toContain("Showing up to 50 issues per connection. Load more results to continue.");
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Load more results")!
      .trigger("click");
    await flushPromises();
    expect(transport.searchJiraIssues).toHaveBeenCalledWith({
      connectionId: "jira-1",
      jql: '(statusCategory != Done) AND assignee = "jira-1"',
      limit: 50,
      cursor: "jira-1-next",
    });
    expect(wrapper.text()).toContain("jira-1-2");
    expect(wrapper.text()).toContain("jira-2-2");
    expect(wrapper.text()).not.toContain("Showing up to 50 issues per connection");
  });

  test("all connections reports the failing source by name and keeps successful source results", async () => {
    transport.listJiraConnections.mockResolvedValue([
      { id: "jira-1", label: "Engineering", deployment: "cloud", webUrl: "https://one.example" },
      { id: "jira-2", label: "Operations", deployment: "cloud", webUrl: "https://two.example" },
    ]);
    transport.searchJiraIssues.mockImplementation(async ({ connectionId }: { connectionId: string }) => {
      if (connectionId === "jira-2") throw new Error("offline");
      return [{ ref: { provider: "jira", connectionId, issueId: "100", issueKey: "OPS-1" }, summary: "Available" }];
    });
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
    await flushPromises();
    await chooseCustomSelect(wrapper, ".jira-head", "__all__");
    await wrapper.find('input[placeholder="Search issue text"]').setValue("deploy");
    await wrapper.find("form.jira-search").trigger("submit");
    await flushPromises();
    expect(wrapper.text()).toContain("Could not search Operations (offline)");
    expect(wrapper.text()).toContain("Source: Engineering");
    expect(wrapper.findAll(".jira-issue")).toHaveLength(1);
  });

  test("all connections bounds parallel Jira queries", async () => {
    transport.listJiraConnections.mockResolvedValue(
      Array.from({ length: 10 }, (_, index) => ({
        id: `jira-${index}`,
        label: `Connection ${index}`,
        deployment: "cloud",
        webUrl: `https://${index}.example`,
      })),
    );
    let active = 0;
    let maxActive = 0;
    transport.searchJiraIssues.mockImplementation(async ({ connectionId }: { connectionId: string }) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 0));
      active--;
      return [{ ref: { provider: "jira", connectionId, issueId: connectionId, issueKey: "OPS-1" }, summary: "Row" }];
    });
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
    await flushPromises();
    transport.searchJiraIssues.mockClear();
    await chooseCustomSelect(wrapper, ".jira-head", "__all__");
    await wrapper.find('input[placeholder="Search issue text"]').setValue("parallel");
    await wrapper.find("form.jira-search").trigger("submit");
    await vi.waitFor(() => expect(transport.searchJiraIssues).toHaveBeenCalledTimes(10));
    expect(transport.searchJiraIssues).toHaveBeenCalledTimes(10);
    expect(maxActive).toBeLessThanOrEqual(4);
  });

  test("executes the selected Jira-owned favorite filter without rewriting its currentUser JQL", async () => {
    transport.getJiraSavedFilter.mockResolvedValue({
      id: "20",
      name: "Assigned to me",
      jql: "assignee = currentUser() ORDER BY updated DESC",
    });
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
    await flushPromises();
    await chooseView(wrapper, "Assigned to me");
    expect(transport.getJiraSavedFilter).toHaveBeenCalledWith({ connectionId: "jira-1", filterId: "20" });
    expect(transport.searchJiraIssues).toHaveBeenCalledWith({
      connectionId: "jira-1",
      jql: "assignee = currentUser() ORDER BY updated DESC",
      limit: 50,
      cacheOnly: true,
    });
    expect(wrapper.text()).toContain("These results are for the shared API account, not for you.");
  });

  test("loads a non-favorite saved filter by validated ID on the selected Jira connection", async () => {
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
    await flushPromises();
    await wrapper.find('input[inputmode="numeric"]').setValue("99");
    await wrapper.get("form.jira-filter-by-id").trigger("submit");
    await flushPromises();
    expect(transport.getJiraSavedFilter).toHaveBeenCalledWith({ connectionId: "jira-1", filterId: "99" });
    expect(transport.searchJiraIssues).toHaveBeenCalledWith({
      connectionId: "jira-1",
      jql: "project = APP AND assignee = currentUser()",
      limit: 50,
      cacheOnly: true,
    });
  });

  test("the status pill is a menu of transitions; one inline Confirm sends the transition with its required fields", async () => {
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" }, attachTo: document.body });
    await flushPromises();
    await wrapper.find("form.jira-search").trigger("submit");
    await flushPromises();
    await wrapper.find(".jira-issue").trigger("click");
    await flushPromises();
    expect(wrapper.find(".jira-write-card").exists()).toBe(false);
    expect(wrapper.get(".jira-status-menu > summary").text()).toBe("In Progress");
    await wrapper.get(".jira-status-menu > summary").trigger("click");
    await flushPromises();
    expect(transport.listJiraTransitions).toHaveBeenCalledWith({ ref: expect.objectContaining({ issueKey: "ENG-1" }) });
    await wrapper
      .findAll(".jira-status-menu [role=menuitem]")
      .find((item) => item.text().includes("In Progress"))!
      .trigger("click");
    await flushPromises();
    const card = wrapper.get(".jira-write-card");
    expect(card.get(".jira-write-card__question").text()).toBe("ENG-1 → In Progress?");
    expect(card.get(".jira-reason__summary").text()).toContain("Move ENG-1 to In Progress");
    expect(card.find(".jira-reason__editor").exists()).toBe(false);
    expect(card.text()).toContain("Sent to Jira as Build Bot (technical account)");
    expect(card.get("button.jira-write-card__confirm").attributes("disabled")).toBeDefined();
    expect(document.activeElement).toBe(card.get("input").element);
    await card.get("input[required]").setValue("Validated acceptance criteria");
    expect(card.get("button.jira-write-card__confirm").attributes("disabled")).toBeUndefined();
    transport.previewJiraWrite.mockResolvedValueOnce({
      token: "transition-token",
      intent: "Move ENG-1 to In Progress",
      preview: "In Progress with required fields",
      account: { displayName: "Build Bot", purpose: "technical" },
    });
    await card.get("button.jira-write-card__confirm").trigger("click");
    await flushPromises();
    expect(transport.previewJiraWrite).toHaveBeenCalledWith(
      expect.objectContaining({ action: "transition", transitionId: "31", intent: "Move ENG-1 to In Progress" }),
    );
    expect(transport.executeJiraWrite).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "transition",
        transitionId: "31",
        fields: { resolution: "Validated acceptance criteria" },
        confirmation: expect.objectContaining({ token: "transition-token" }),
      }),
    );
    expectEveryCallToMatch(jiraWritePreviewSchema, transport.previewJiraWrite);
    expectEveryCallToMatch(jiraWriteExecuteSchema, transport.executeJiraWrite);
    expect(wrapper.find(".jira-write-card").exists()).toBe(false);
    expect(wrapper.get(".jira-write-feedback").text()).toContain("Moved ENG-1 to In Progress.");
    expect(document.activeElement).toBe(wrapper.get(".jira-status-menu > summary").element);
    wrapper.unmount();
  });

  const BRANCH_ISSUE_REF = { provider: "jira", connectionId: "jira-1", issueId: "1001", issueKey: "ENG-1" } as const;
  function linkedBranchWorkspace(overrides: Record<string, unknown> = {}) {
    return {
      id: "ws-branch",
      name: "feature/ENG-1-fix-login",
      kind: "terminal",
      profileId: "default",
      quickfix: { repositoryName: "web", baseBranch: "main" },
      workItems: [{ ref: BRANCH_ISSUE_REF, summary: "Fix login", status: "Open" }],
      lastWorkedAt: "2026-05-01T10:00:00.000Z",
      ...overrides,
    };
  }
  function addPayloadWorkspace(workspace: Record<string, unknown>) {
    (mockStoreState.payload as { appState: { workspaces: unknown[] } }).appState.workspaces.push(workspace);
  }
  function headerButton(wrapper: ReturnType<typeof mount>, text: string) {
    return wrapper
      .get(".jira-detail-header__actions")
      .findAll("button")
      .find((button) => button.text() === text);
  }
  async function openFirstIssue() {
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" }, attachTo: document.body });
    await flushPromises();
    await wrapper.find("form.jira-search").trigger("submit");
    await flushPromises();
    await wrapper.find(".jira-issue").trigger("click");
    await flushPromises();
    return wrapper;
  }
  async function openStartDevelopment() {
    const wrapper = await openFirstIssue();
    await headerButton(wrapper, "Start development")!.trigger("click");
    await flushPromises();
    return wrapper;
  }
  function branchSelects(wrapper: ReturnType<typeof mount>) {
    return branchPanel(wrapper).findAllComponents(CustomSelect) as unknown as Array<
      ReturnType<typeof mount> & { props(key: string): unknown }
    >;
  }
  function branchSelectValues(wrapper: ReturnType<typeof mount>): unknown[] {
    return branchSelects(wrapper).map((select: { props(key: string): unknown }) => select.props("modelValue"));
  }
  function onlyAzureConnection() {
    (
      mockStoreState.payload as { appState: { settings: { integrations: Record<string, unknown> } } }
    ).appState.settings.integrations = {
      azureDevops: { connections: [{ id: "az-1", label: "Azure", profileId: "default" }] },
    };
  }

  test("Start development: several connections ask for one, the branch is suggested, and one call creates and links it", async () => {
    const wrapper = await openStartDevelopment();
    const panel = branchPanel(wrapper);
    expect(branchPanel(wrapper).exists()).toBe(true);
    expect(panel.text()).not.toMatch(/Worker|Judge|Browse|checkout path|Include from Jira|Task description/);
    const task = (panel.get(".jira-branch-task textarea").element as HTMLTextAreaElement).value;
    expect(task).toContain("Jira issue ENG-1");
    expect(task).toContain(".strideterm/jira/ENG-1/ISSUE.md");
    expect(customSelectProps(branchSelects(wrapper)[0]!).options).toEqual([
      { value: "azure:az-1", label: "Azure DevOps · Azure" },
      { value: "github:gh-1", label: "GitHub · GitHub" },
    ]);
    expect((panel.get(".jira-branch-name input").element as HTMLInputElement).value).toBe("feature/ENG-1-fix-login");
    expect(panel.get("button.jira-branch-start__submit").attributes("disabled")).toBeDefined();
    expect(panel.get("button.jira-branch-start__submit").attributes("title")).toBe("Choose a connection first.");
    await chooseCustomSelect(wrapper, ".jira-branch-start", "azure:az-1", 0);
    expect(branchSelects(wrapper)[3]!.props("modelValue")).toBe("main");
    expect(panel.get("button.jira-branch-start__submit").attributes("disabled")).toBeUndefined();
    await panel.get(".jira-branch-name input").setValue("feature/ENG-1-login-refresh");
    transport.startJiraDevelopment.mockResolvedValueOnce(finishedDevelopment({ launched: false }));
    await panel.get("button.jira-branch-start__submit").trigger("click");
    await flushPromises();
    expect(transport.startJiraDevelopment).toHaveBeenCalledTimes(1);
    expect(transport.startJiraDevelopment).toHaveBeenCalledWith({
      jiraIssueRef: { connectionId: "jira-1", issueId: "1001", issueKey: "ENG-1" },
      target: {
        provider: "azure",
        connectionId: "az-1",
        projectName: "Engineering",
        repositoryId: "repo-1",
        repositoryName: "web",
        remoteUrl: "https://dev.azure.com/org/project/_git/web",
        baseBranch: "main",
        newBranchName: "feature/ENG-1-login-refresh",
      },
      agent: null,
      mode: "analyze",
      idempotencyKey: expect.any(String),
    });
    expectEveryCallToMatch(startJiraDevelopmentSchema, transport.startJiraDevelopment);
    expect(transport.azureQuickFixCreate).not.toHaveBeenCalled();
    // The dialog closes once the run reports the workspace ready.
    expect(branchPanel(wrapper).exists()).toBe(false);
    expect(JSON.parse(localStorage.getItem("strideterm.jira.branchTarget.jira-1.ENG") || "{}")).toMatchObject({
      connectionKey: "azure:az-1",
      repoId: "repo-1",
      baseBranch: "main",
    });
    wrapper.unmount();
  });

  test("Start development on GitHub sends the repository owner and the issue link", async () => {
    transport.githubQuickFixListRepos.mockResolvedValue({
      repositories: [
        {
          name: "web",
          fullName: "acme/web",
          owner: "acme",
          remoteUrl: "https://github.com/acme/web.git",
          defaultBranch: "develop",
        },
      ],
    });
    transport.githubQuickFixListBranches.mockResolvedValue({ branches: ["main", "develop"] });
    const wrapper = await openStartDevelopment();
    await chooseCustomSelect(wrapper, ".jira-branch-start", "github:gh-1", 0);
    expect(branchPanel(wrapper).text()).not.toContain("Project");
    await branchPanel(wrapper).get("button.jira-branch-start__submit").trigger("click");
    await flushPromises();
    expect(transport.startJiraDevelopment).toHaveBeenCalledWith(
      expect.objectContaining({
        jiraIssueRef: { connectionId: "jira-1", issueId: "1001", issueKey: "ENG-1" },
        target: {
          provider: "github",
          connectionId: "gh-1",
          owner: "acme",
          repo: "web",
          remoteUrl: "https://github.com/acme/web.git",
          baseBranch: "develop",
          newBranchName: "feature/ENG-1-fix-login",
        },
      }),
    );
    expectEveryCallToMatch(startJiraDevelopmentSchema, transport.startJiraDevelopment);
    wrapper.unmount();
  });

  function finishedDevelopment(result: Record<string, unknown>) {
    const outcome = {
      operationId: "op-dev-1",
      kind: "jira.start-development",
      profileId: "default",
      finishedAt: new Date().toISOString(),
      result: { workspaceId: "ws-branch", issueKey: "ENG-1", ...result },
    };
    return { started: true as const, operationId: "op-dev-1", replayed: false, outcome };
  }

  test("Start development keeps the dialog open with the run's progress until the workspace is ready", async () => {
    onlyAzureConnection();
    (mockStoreState.payload as { appState: Record<string, unknown> }).appState.tabTemplates = [
      { id: "codex", title: "Codex", command: "codex" },
    ];
    localStorage.setItem("strideterm.jira.developmentAgent", "codex");
    (mockStoreState.payload as Record<string, unknown>).operations = {
      running: [{ operationId: "op-dev-1", kind: "jira.start-development", profileId: "default", step: "agent" }],
      lastResults: [],
    };
    const wrapper = await openStartDevelopment();
    const panel = branchPanel(wrapper);
    await panel.get("button.jira-branch-start__submit").trigger("click");
    await flushPromises();
    expect(branchPanel(wrapper).exists()).toBe(true);
    expect(panel.get(".jira-branch-start__progress").text()).toBe("Starting Codex…");
    // Waiting is not required: Close hides the dialog and the run goes on.
    const close = panel.findAll(".dialog__footer button").find((button) => button.text() === "Close")!;
    expect(close.attributes("disabled")).toBeUndefined();
    await close.trigger("click");
    expect(branchPanel(wrapper).exists()).toBe(false);
    wrapper.unmount();
  });

  test("Start development settles from the live operation:finished event when the payload has no result", async () => {
    onlyAzureConnection();
    (mockStoreState.payload as { appState: Record<string, unknown> }).appState.tabTemplates = [
      { id: "codex", title: "Codex", command: "codex" },
    ];
    localStorage.setItem("strideterm.jira.developmentAgent", "codex");
    (mockStoreState.payload as Record<string, unknown>).operations = { running: [], lastResults: [] };
    const wrapper = await openStartDevelopment();
    const panel = branchPanel(wrapper);
    await panel.get("button.jira-branch-start__submit").trigger("click");
    await flushPromises();
    expect(branchPanel(wrapper).exists()).toBe(true);
    const handler = transport.onOperationFinished.mock.calls.at(-1)![0] as (event: unknown) => void;
    handler(finishedDevelopment({ launched: true }).outcome);
    await flushPromises();
    expect(branchPanel(wrapper).exists()).toBe(false);
    wrapper.unmount();
  });

  test("unmounting the pane removes its operation:finished listener", async () => {
    onlyAzureConnection();
    const stop = vi.fn();
    transport.onOperationFinished.mockReturnValueOnce(stop);
    const wrapper = await openStartDevelopment();
    expect(transport.onOperationFinished).toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    wrapper.unmount();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  test("Start development stops waiting after the deadline and points to the Notification Center", async () => {
    onlyAzureConnection();
    (mockStoreState.payload as { appState: Record<string, unknown> }).appState.tabTemplates = [
      { id: "codex", title: "Codex", command: "codex" },
    ];
    localStorage.setItem("strideterm.jira.developmentAgent", "codex");
    (mockStoreState.payload as Record<string, unknown>).operations = { running: [], lastResults: [] };
    const wrapper = await openStartDevelopment();
    const panel = branchPanel(wrapper);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await panel.get("button.jira-branch-start__submit").trigger("click");
      await flushPromises();
      expect(branchPanel(wrapper).exists()).toBe(true);
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
      await flushPromises();
      expect(branchPanel(wrapper).exists()).toBe(false);
      expect(useNotificationStore().persistentToasts.map((toast) => toast.body)).toContain(
        "The result will appear in the Notification Center.",
      );
    } finally {
      vi.useRealTimers();
    }
    wrapper.unmount();
  });

  test("Start development hands the chosen agent and the instructions as the user edited them", async () => {
    onlyAzureConnection();
    (mockStoreState.payload as { appState: Record<string, unknown> }).appState.tabTemplates = [
      { id: "codex", title: "Codex", command: "codex" },
      { id: "claude", title: "Claude Code", command: "claude --model opus" },
    ];
    localStorage.setItem("strideterm.jira.developmentAgent", "codex");
    (mockStoreState.payload as Record<string, unknown>).operations = {
      running: [],
      lastResults: [finishedDevelopment({ launched: true, agentName: "codex" }).outcome],
    };
    const wrapper = await openStartDevelopment();
    const panel = branchPanel(wrapper);
    // The agent last used is preselected; the options list each installed agent once, plus none.
    const agentSelect = branchPanel(wrapper)
      .get(".jira-branch-agent")
      .findComponent(CustomSelect) as unknown as ReturnType<typeof mount> & { props(key: string): unknown };
    expect(agentSelect.props("modelValue")).toBe("codex");
    expect(customSelectProps(agentSelect).options.map((option) => option.value)).toEqual(["claude", "codex", ""]);
    // Model and effort start at the template's own and override it only when chosen.
    const effortSelect = branchSelects(wrapper).at(-1)!;
    expect(effortSelect.props("modelValue")).toBe("");
    await panel.get(".jira-branch-agent-row input").setValue("gpt-6.1-sol");
    effortSelect.vm.$emit("update:modelValue", "xhigh");
    await flushPromises();
    const textarea = panel.get(".jira-branch-task textarea");
    // Analyze first is the default tab; each tab keeps its own text.
    expect((textarea.element as HTMLTextAreaElement).value).toContain("Analyse Jira issue ENG-1");
    expect((textarea.element as HTMLTextAreaElement).value).toContain("created from `main`");
    const modeTab = (label: string) => panel.findAll(".jira-branch-mode button").find((tab) => tab.text() === label)!;
    expect(modeTab("Analyze first").attributes("aria-selected")).toBe("true");
    await modeTab("Implement").trigger("click");
    expect((textarea.element as HTMLTextAreaElement).value).toContain("You are implementing Jira issue ENG-1");
    await textarea.setValue("Only investigate; report back before changing code.");
    await modeTab("Analyze first").trigger("click");
    expect((textarea.element as HTMLTextAreaElement).value).toContain("Analyse Jira issue ENG-1");
    await modeTab("Implement").trigger("click");
    await panel.get(".jira-branch-name input").setValue("feature/ENG-1-investigate");
    // A branch renamed after the edit leaves the user's text alone.
    expect((textarea.element as HTMLTextAreaElement).value).toBe("Only investigate; report back before changing code.");
    expect(panel.get("button.jira-branch-start__submit").text()).toBe("Start development");
    await panel.get("button.jira-branch-start__submit").trigger("click");
    await flushPromises();
    expect(transport.startJiraDevelopment).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: "codex",
        mode: "implement",
        model: "gpt-6.1-sol",
        effort: "xhigh",
        task: "Only investigate; report back before changing code.",
        target: expect.objectContaining({ newBranchName: "feature/ENG-1-investigate" }),
      }),
    );
    expectEveryCallToMatch(startJiraDevelopmentSchema, transport.startJiraDevelopment);
    expect(localStorage.getItem("strideterm.jira.developmentAgent")).toBe("codex");
    expect(JSON.parse(localStorage.getItem("strideterm.jira.developmentModel.codex") || "null")).toEqual({
      model: "gpt-6.1-sol",
      effort: "xhigh",
    });
    wrapper.unmount();
  });

  test("Start development with one connection hides the picker and preselects it down to the only repository", async () => {
    onlyAzureConnection();
    const wrapper = await openStartDevelopment();
    const panel = branchPanel(wrapper);
    expect(transport.azureQuickFixListProjects).toHaveBeenCalledWith({ connectionId: "az-1" });
    expect(transport.azureQuickFixListBranches).toHaveBeenCalledWith({
      connectionId: "az-1",
      projectName: "Engineering",
      repositoryId: "repo-1",
    });
    expect(panel.text()).not.toContain("Connection");
    expect(branchSelectValues(wrapper)).toEqual(["project-1", "repo-1", "main", ""]);
    expect(panel.get("button.jira-branch-start__submit").attributes("disabled")).toBeUndefined();
    wrapper.unmount();
  });

  test("Start development without a connection is disabled, says why and offers to add one from the menu", async () => {
    (
      mockStoreState.payload as { appState: { settings: { integrations: Record<string, unknown> } } }
    ).appState.settings.integrations = {};
    const wrapper = await openFirstIssue();
    const start = headerButton(wrapper, "Start development")!;
    expect(start.attributes("disabled")).toBeDefined();
    expect(start.attributes("title")).toBe("Add an Azure DevOps or GitHub connection first");
    await wrapper.get(".jira-detail-header__actions > details:last-child > summary").trigger("click");
    const add = wrapper
      .findAll(".jira-extra-actions__menu [role=menuitem]")
      .find((item) => item.text().includes("Add Azure DevOps connection"))!;
    await add.trigger("click");
    expect(transport.openAzureConnectionDialog).toHaveBeenCalledWith("");
    const addGithub = wrapper
      .findAll(".jira-extra-actions__menu [role=menuitem]")
      .find((item) => item.text().includes("Add GitHub connection"))!;
    await addGithub.trigger("click");
    expect(transport.openGitHubConnectionDialog).toHaveBeenCalledWith("");
    wrapper.unmount();
  });

  test("Start development applies the saved repository target by itself and focuses the branch name", async () => {
    transport.getJiraRepoBindingPreference.mockResolvedValue({
      provider: "azure",
      connectionId: "az-1",
      projectId: "project-1",
      repoId: "repo-1",
      repoName: "web",
      remoteUrl: "https://dev.azure.com/org/project/_git/web",
      baseBranch: "develop",
    });
    transport.getJiraIssue.mockResolvedValue({
      ref: { provider: "jira", connectionId: "jira-1", issueId: "1001", issueKey: "ENG-1" },
      summary: "Fix login",
      status: "In Progress",
      projectKey: "ENG",
    });
    const wrapper = await openStartDevelopment();
    expect(branchSelectValues(wrapper)).toEqual(["azure:az-1", "project-1", "repo-1", "develop", ""]);
    expect(document.activeElement).toBe(branchPanel(wrapper).get(".jira-branch-name input").element);
    wrapper.unmount();
  });

  test("Start development prefers the target last used for the Jira project", async () => {
    localStorage.setItem(
      "strideterm.jira.branchTarget.jira-1.ENG",
      JSON.stringify({ connectionKey: "azure:az-1", projectId: "project-1", repoId: "repo-1", baseBranch: "develop" }),
    );
    const wrapper = await openStartDevelopment();
    expect(branchSelects(wrapper)[3]!.props("modelValue")).toBe("develop");
    wrapper.unmount();
  });

  test("a refused Start development stays in the dialog with the reason and an error toast", async () => {
    transport.startJiraDevelopment.mockRejectedValueOnce(
      new Error("The GitHub connection is not available in this profile."),
    );
    const wrapper = await openStartDevelopment();
    await chooseCustomSelect(wrapper, ".jira-branch-start", "azure:az-1", 0);
    await branchPanel(wrapper).get("button.jira-branch-start__submit").trigger("click");
    await flushPromises();
    expect(branchPanel(wrapper).get("[role=alert]").text()).toContain("Could not start development");
    expect(branchPanel(wrapper).get("[role=alert]").text()).toContain(
      "The GitHub connection is not available in this profile.",
    );
    expect(
      useNotificationStore().persistentToasts.some((toast) => toast.title === "Could not start development on ENG-1"),
    ).toBe(true);
    expect(branchPanel(wrapper).exists()).toBe(true);
    wrapper.unmount();
  });

  test("an issue with a linked branch workspace offers Open branch and moves New branch into the menu", async () => {
    addPayloadWorkspace(linkedBranchWorkspace());
    const wrapper = await openFirstIssue();
    expect(headerButton(wrapper, "Start development")).toBeUndefined();
    const open = headerButton(wrapper, "Open branch")!;
    expect(open.attributes("title")).toBe("Switch to feature/ENG-1-fix-login, the branch workspace linked to ENG-1.");
    await open.trigger("click");
    await flushPromises();
    expect(transport.activateWorkspace).toHaveBeenCalledWith("ws-branch");
    await wrapper.get(".jira-detail-header__actions > details:last-child > summary").trigger("click");
    const newBranch = wrapper
      .findAll(".jira-extra-actions__menu [role=menuitem]")
      .find((item) => item.text().includes("New branch…"))!;
    await newBranch.trigger("click");
    await flushPromises();
    expect(branchPanel(wrapper).exists()).toBe(true);
    wrapper.unmount();
  });

  test("the Development section lists the linked branch workspace with its repository and opens it", async () => {
    addPayloadWorkspace(linkedBranchWorkspace());
    const wrapper = await openFirstIssue();
    const section = wrapper.get(".jira-development-links");
    expect(section.text()).toContain("Branch");
    expect(section.text()).toContain("feature/ENG-1-fix-login");
    expect(section.text()).toContain("web");
    expect(section.text()).toContain("from main");
    await section.get("button").trigger("click");
    await flushPromises();
    expect(transport.activateWorkspace).toHaveBeenCalledWith("ws-branch");
    wrapper.unmount();
  });

  test("a workspace of another profile, a task workspace and a plain link are not branch workspaces of the issue", async () => {
    addPayloadWorkspace(linkedBranchWorkspace({ id: "ws-other", profileId: "other" }));
    addPayloadWorkspace(linkedBranchWorkspace({ id: "ws-task", kind: "task" }));
    addPayloadWorkspace(linkedBranchWorkspace({ id: "ws-linked", quickfix: null }));
    const wrapper = await openFirstIssue();
    expect(headerButton(wrapper, "Start development")).toBeDefined();
    expect(wrapper.find(".jira-development-links").exists()).toBe(false);
    wrapper.unmount();
  });

  test("Views → Recent lists linked branch workspaces of the connection", async () => {
    addPayloadWorkspace(linkedBranchWorkspace());
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" }, attachTo: document.body });
    await flushPromises();
    const recent = wrapper
      .findAll(".jira-views-menu__panel [role=menuitem]")
      .find((item) => item.text().includes("ENG-1 · feature/ENG-1-fix-login"))!;
    expect(recent.text()).toContain("Development · Branch");
    await recent.trigger("click");
    await flushPromises();
    expect(transport.activateWorkspace).toHaveBeenCalledWith("ws-branch");
    wrapper.unmount();
  });

  test("board cards and list rows of an issue with a linked branch workspace carry a branch marker naming it", async () => {
    addPayloadWorkspace(linkedBranchWorkspace());
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" }, attachTo: document.body });
    await flushPromises();
    await wrapper.find("form.jira-search").trigger("submit");
    await flushPromises();
    const row = wrapper.get(".jira-issue .jira-branch-badge");
    expect(row.attributes("title")).toBe("Branch workspace: feature/ENG-1-fix-login");
    await showBoardView(wrapper);
    await chooseCustomSelect(wrapper, ".jira-board-controls", 42);
    await flushPromises();
    const card = wrapper.get(".jira-board-issue .jira-branch-badge");
    expect(card.attributes("title")).toBe("Branch workspace: feature/ENG-1-fix-login");
    wrapper.unmount();
  });

  test("an issue without a linked branch workspace has no marker", async () => {
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" }, attachTo: document.body });
    await flushPromises();
    await wrapper.find("form.jira-search").trigger("submit");
    await flushPromises();
    expect(wrapper.find(".jira-issue").exists()).toBe(true);
    expect(wrapper.find(".jira-branch-badge").exists()).toBe(false);
    wrapper.unmount();
  });

  test("previews remote links and worklogs as separate confirmed operations", async () => {
    const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
    await flushPromises();
    await wrapper.find("form.jira-search").trigger("submit");
    await flushPromises();
    await wrapper.find(".jira-issue").trigger("click");
    await flushPromises();
    const more = wrapper.get(".jira-detail-header__actions > details:last-child");
    await more
      .findAll("[role=menuitem]")
      .find((item) => item.text() === "Add link…")!
      .trigger("click");
    await flushPromises();
    expect(wrapper.get(".jira-write-details").element).toHaveProperty("open", true);
    await wrapper.find('.jira-write input[type="url"]').setValue("https://github.com/org/repo/pull/5");
    await wrapper
      .findAll(".jira-write input")
      .find((input) => input.attributes("required") !== undefined && input.attributes("type") !== "url")!
      .setValue("Review PR");
    transport.previewJiraWrite.mockResolvedValueOnce({
      token: "remote-link-token",
      intent: "Add a link to ENG-1",
      preview: "Add remote link",
      account: { displayName: "Build Bot", purpose: "technical" },
    });
    await wrapper
      .findAll(".jira-write button")
      .find((button) => button.text().startsWith("Review"))!
      .trigger("click");
    await flushPromises();
    expect(transport.previewJiraWrite).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "remote-link",
        url: "https://github.com/org/repo/pull/5",
        title: "Review PR",
        globalId: "https://github.com/org/repo/pull/5",
        intent: "Add a link to ENG-1",
      }),
    );
    expectEveryCallToMatch(jiraWritePreviewSchema, transport.previewJiraWrite);
    await wrapper.find('[role="dialog"] button').trigger("click");
    await flushPromises();
    expectEveryCallToMatch(jiraWriteExecuteSchema, transport.executeJiraWrite);
    expect(wrapper.get(".jira-write-details").text()).toContain("Link added to ENG-1.");

    await more
      .findAll("[role=menuitem]")
      .find((item) => item.text() === "Log work…")!
      .trigger("click");
    await flushPromises();
    await wrapper.find('.jira-write input[placeholder="1h 30m"]').setValue("30m");
    await wrapper.find('.jira-write input[type="datetime-local"]').setValue("2026-10-23T09:30");
    await wrapper.find(".jira-write textarea").setValue("Investigated regression");
    transport.previewJiraWrite.mockResolvedValueOnce({
      token: "worklog-token",
      intent: "Log work on ENG-1",
      preview: "30m",
      account: { displayName: "Build Bot", purpose: "technical" },
    });
    await wrapper
      .findAll(".jira-write button")
      .find((button) => button.text().startsWith("Review"))!
      .trigger("click");
    await flushPromises();
    expect(transport.previewJiraWrite).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: "worklog",
        seconds: 1800,
        started: new Date("2026-10-23T09:30").toISOString(),
        comment: "Investigated regression",
        intent: "Log work on ENG-1",
      }),
    );
    expectEveryCallToMatch(jiraWritePreviewSchema, transport.previewJiraWrite);
  });

  describe("failure reporting and stale answers", () => {
    const issueRef = (issueId: string, issueKey: string) => ({
      provider: "jira" as const,
      connectionId: "jira-1",
      issueId,
      issueKey,
    });
    function twoIssues() {
      transport.searchJiraIssues.mockResolvedValue([
        { ref: issueRef("1001", "ENG-1"), summary: "First issue" },
        { ref: issueRef("1002", "ENG-2"), summary: "Second issue" },
      ]);
      transport.getJiraIssue.mockImplementation(async ({ issueId }: { issueId: string }) => ({
        ref: issueRef(issueId, issueId === "1001" ? "ENG-1" : "ENG-2"),
        summary: issueId === "1001" ? "First issue" : "Second issue",
        status: "Open",
        description: "",
        attachments: [],
      }));
    }
    async function mountWithTwoIssues() {
      twoIssues();
      const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" }, attachTo: document.body });
      await flushPromises();
      await wrapper.find("form.jira-search").trigger("submit");
      await flushPromises();
      return wrapper;
    }
    async function openIssueRow(wrapper: ReturnType<typeof mount>, index: number) {
      await wrapper.findAll(".jira-issue")[index]!.trigger("click");
      await flushPromises();
    }

    test("strips the IPC wrapper and the error class from the reason and logs context and code only", async () => {
      answerFirstOpenSearch();
      const logRenderer = vi.fn();
      (window as unknown as { strideterm?: unknown }).strideterm = { logRenderer };
      try {
        transport.searchJiraIssues.mockRejectedValueOnce(
          Object.assign(new Error("Error invoking remote method 'jira:search': JiraRequestError: Query is invalid"), {
            code: "unknown",
          }),
        );
        const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
        await flushPromises();
        await wrapper.find("form.jira-search").trigger("submit");
        await flushPromises();
        expect(wrapper.find('[role="alert"]').text()).toContain("Jira search failed: Query is invalid");
        expect(wrapper.find('[role="alert"]').text()).not.toContain("JiraRequestError");
        expect(logRenderer).toHaveBeenCalledWith(
          "warn",
          "[jira] Jira search failed",
          expect.objectContaining({ context: "Jira search failed", code: "unknown" }),
        );
        expect(JSON.stringify(logRenderer.mock.calls)).not.toContain("Query is invalid");
      } finally {
        delete (window as unknown as { strideterm?: unknown }).strideterm;
      }
    });

    test("a new failure clears the previous Retry-After instead of attaching it to another error", async () => {
      answerFirstOpenSearch();
      transport.searchJiraIssues
        .mockRejectedValueOnce(desktopJiraFailure("Throttled.", "rate-limited", 4000))
        .mockRejectedValueOnce(new Error("Plain failure"));
      const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
      await flushPromises();
      await wrapper.find("form.jira-search").trigger("submit");
      await flushPromises();
      expect(wrapper.get(".jira-error__countdown").text()).toContain("4 s");
      await wrapper.find("form.jira-search").trigger("submit");
      await flushPromises();
      expect(wrapper.find('[role="alert"]').text()).toContain("Plain failure");
      expect(wrapper.find(".jira-error__countdown").exists()).toBe(false);
    });

    test("an access failure in the desktop shape purges the cached board and says why", async () => {
      const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" }, attachTo: document.body });
      await flushPromises();
      await wrapper
        .findAll(".jira-view-tab")
        .find((tab) => tab.text() === "Board")!
        .trigger("click");
      await chooseCustomSelect(wrapper, ".jira-board-controls", 42);
      expect(wrapper.find(".jira-board-issue").exists()).toBe(true);
      transport.listJiraBoardQuickFilters.mockResolvedValue({ filters: [], hasMore: false });
      transport.getJiraBoardView.mockRejectedValueOnce(
        desktopJiraFailure("Jira says this token expired.", "auth-expired"),
      );
      await wrapper.get(".jira-head__refresh").trigger("click");
      await flushPromises();
      expect(wrapper.find(".jira-board-issue").exists()).toBe(false);
      expect(wrapper.get(".jira-sign-in-card").text()).toContain("Sign-in expired for");
      expect(wrapper.find(".jira-error").exists()).toBe(false);
      wrapper.unmount();
    });

    test("an access failure while opening an issue closes the detail and keeps the status label", async () => {
      const wrapper = await mountWithTwoIssues();
      transport.getJiraIssue.mockReset().mockRejectedValue(desktopJiraFailure("Revoked.", "permission-denied"));
      await openIssueRow(wrapper, 0);
      expect(wrapper.find(".jira-detail-header").exists()).toBe(false);
      expect(wrapper.find('[role="alert"]').text()).toContain("Could not load issue details: Revoked.");
      expect(wrapper.find('[role="alert"]').text()).toContain("Jira permission denied");
      wrapper.unmount();
    });

    test("a write that finishes after switching issues does not clear the draft of the issue on screen", async () => {
      const wrapper = await mountWithTwoIssues();
      let finishWrite!: (value: unknown) => void;
      transport.executeJiraWrite.mockImplementationOnce(() => new Promise((resolve) => (finishWrite = resolve)));
      await openIssueRow(wrapper, 0);
      await sendComment(wrapper, "Comment for the first issue");
      expect(transport.executeJiraWrite).toHaveBeenCalledWith(
        expect.objectContaining({ ref: expect.objectContaining({ issueId: "1001" }) }),
      );
      await openIssueRow(wrapper, 1);
      await wrapper.get(COMMENT_BOX).setValue("Draft for the second issue");
      finishWrite({ ok: true, data: { status: "succeeded", journalId: "write-A" } });
      await flushPromises();
      expect((wrapper.get(COMMENT_BOX).element as HTMLTextAreaElement).value).toBe("Draft for the second issue");
      expect(wrapper.text()).not.toContain("Comment added to ENG-1.");
      await openIssueRow(wrapper, 0);
      expect((wrapper.get(COMMENT_BOX).element as HTMLTextAreaElement).value).toBe("");
      wrapper.unmount();
    });

    test("a write that fails after switching issues is reported by the banner with the issue key, not in B's form", async () => {
      const wrapper = await mountWithTwoIssues();
      let failWrite!: (value: unknown) => void;
      transport.executeJiraWrite.mockImplementationOnce(() => new Promise((resolve) => (failWrite = resolve)));
      await openIssueRow(wrapper, 0);
      await sendComment(wrapper, "Comment for the first issue");
      await openIssueRow(wrapper, 1);
      failWrite({
        ok: false,
        error: {
          code: "jira-write-unknown",
          message: "Jira may have accepted this write.",
          status: "unknown",
          journalId: "journal-A",
        },
      });
      await flushPromises();
      expect(wrapper.find(".jira-comment-composer .jira-inline-error").exists()).toBe(false);
      expect(wrapper.find(".jira-write-reconcile").exists()).toBe(false);
      expect(wrapper.find('[role="alert"]').text()).toContain("ENG-1");
      expect(wrapper.find('[role="alert"]').text()).toContain("Jira may have accepted this write.");
      await openIssueRow(wrapper, 0);
      expect(wrapper.find(".jira-write-reconcile").text()).toContain("journal-A");
      expect((wrapper.get(COMMENT_BOX).element as HTMLTextAreaElement).value).toBe("Comment for the first issue");
      wrapper.unmount();
    });

    test("transitions loaded for the previous issue never reach the issue on screen", async () => {
      const wrapper = await mountWithTwoIssues();
      let finishFirst!: (value: unknown) => void;
      transport.listJiraTransitions
        .mockImplementationOnce(() => new Promise((resolve) => (finishFirst = resolve)))
        .mockResolvedValueOnce([{ id: "99", name: "Only for B", to: "Done", requiredFields: [] }]);
      await openIssueRow(wrapper, 0);
      await wrapper.get(".jira-status-menu > summary").trigger("click");
      await flushPromises();
      await openIssueRow(wrapper, 1);
      expect((wrapper.get(".jira-status-menu").element as HTMLDetailsElement).open).toBe(false);
      await wrapper.get(".jira-status-menu > summary").trigger("click");
      await flushPromises();
      finishFirst([{ id: "31", name: "Start progress", to: "In Progress", requiredFields: [] }]);
      await flushPromises();
      expect(wrapper.findAll(".jira-status-menu [role=menuitem]").map((item) => item.text())).toEqual([
        "DoneOnly for B",
      ]);
      wrapper.unmount();
    });

    test("keeps an unknown write reconcilable per issue and finds one left by an earlier session", async () => {
      const wrapper = await mountWithTwoIssues();
      transport.getJiraWriteHistory.mockImplementation(async ({ issueId }: { issueId: string }) =>
        issueId === "1001" ? [{ id: "journal-old", state: "unknown", issueId, kind: "comment" }] : [],
      );
      await openIssueRow(wrapper, 0);
      expect(transport.getJiraWriteHistory).toHaveBeenCalledWith(
        expect.objectContaining({ connectionId: "jira-1", issueId: "1001" }),
      );
      expect(wrapper.find(".jira-write-reconcile").text()).toContain("journal-old");
      await openIssueRow(wrapper, 1);
      expect(wrapper.find(".jira-write-reconcile").exists()).toBe(false);
      await openIssueRow(wrapper, 0);
      expect(wrapper.find(".jira-write-reconcile").text()).toContain("journal-old");
      wrapper.unmount();
    });

    test("write, attachment and comment errors appear next to their forms, not in the banner", async () => {
      const wrapper = await mountWithTwoIssues();
      transport.previewJiraWrite.mockRejectedValueOnce(desktopJiraFailure("Preview refused.", "validation-failed"));
      transport.listJiraComments.mockRejectedValueOnce(new Error("Comments offline"));
      await openIssueRow(wrapper, 0);
      expect(wrapper.find(".jira-comments__notice--error").text()).toContain(
        "Could not load comments: Comments offline",
      );
      expect(wrapper.find(".jira-error").exists()).toBe(false);
      await sendComment(wrapper, "Reviewed this change.");
      expect(wrapper.find(".jira-comment-composer .jira-inline-error").text()).toContain(
        "Could not preview the comment: Preview refused.",
      );
      expect(wrapper.find(".jira-error").exists()).toBe(false);
      expect((wrapper.get(COMMENT_BOX).element as HTMLTextAreaElement).value).toBe("Reviewed this change.");
      wrapper.unmount();
    });

    test("an attachment upload failure is shown beside the issue header", async () => {
      const wrapper = await mountWithTwoIssues();
      await openIssueRow(wrapper, 0);
      transport.uploadJiraIssueAttachment.mockRejectedValueOnce(new Error("Disk is read-only"));
      await wrapper
        .findAll("button")
        .find((button) => button.text() === "Add attachment")!
        .trigger("click");
      await flushPromises();
      expect(wrapper.find(".jira-detail-header .jira-inline-error").text()).toContain(
        "Could not upload the Jira attachment: Disk is read-only",
      );
      expect(wrapper.find(".jira-error").exists()).toBe(false);
      wrapper.unmount();
    });

    test("validates the write fields on the client before sending anything", async () => {
      const wrapper = await mountWithTwoIssues();
      await openIssueRow(wrapper, 0);
      await chooseCustomSelect(wrapper, ".jira-write", "remote-link");
      await wrapper.find('.jira-write input[type="url"]').setValue("not a link");
      await wrapper.find(".jira-write input:not([type])").setValue("Review PR");
      expect(wrapper.find(".jira-write .jira-field-error").text()).toContain("http:// or https://");
      const preview = wrapper.findAll(".jira-write button").find((button) => button.text().startsWith("Review"))!;
      expect(preview.attributes("disabled")).toBeDefined();
      await wrapper.find('.jira-write input[type="url"]').setValue("https://example.com/pr/1");
      expect(wrapper.find(".jira-write .jira-field-error").exists()).toBe(false);
      expect(preview.attributes("disabled")).toBeUndefined();
      await wrapper.get(".jira-write .jira-reason__edit").trigger("click");
      const reason = wrapper.get('.jira-write input[aria-label="Reason for this change"]');
      await reason.setValue("short");
      expect(wrapper.find(".jira-write .jira-field-error").text()).toContain("at least 8 characters (5/8)");
      expect(preview.attributes("disabled")).toBeDefined();
      await reason.setValue("x".repeat(501));
      expect(wrapper.find(".jira-write .jira-field-error").text()).toContain("under 500");
      wrapper.unmount();
    });

    test("saves Jira details only when they pass the schema rules, and says which field is wrong", async () => {
      const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
      await flushPromises();
      await openSettingsView(wrapper);
      await wrapper
        .findAll("button")
        .find((button) => button.text() === "Edit")!
        .trigger("click");
      await wrapper.find('[aria-label="Link issue keys to this connection"]').setValue("app, 9bad");
      await wrapper
        .findAll(".jira-connection-edit button")
        .find((button) => button.text() === "Save details")!
        .trigger("click");
      await flushPromises();
      expect(transport.updateJiraConnectionMetadata).not.toHaveBeenCalled();
      expect(wrapper.find(".jira-connection-edit .jira-field-error").text()).toContain("9BAD");
      expect(wrapper.find(".jira-connection-edit .jira-inline-error").text()).toContain("highlighted fields");
      await wrapper.find('[aria-label="Link issue keys to this connection"]').setValue("app");
      await wrapper
        .findAll(".jira-connection-edit button")
        .find((button) => button.text() === "Save details")!
        .trigger("click");
      await flushPromises();
      expect(transport.updateJiraConnectionMetadata).toHaveBeenCalledOnce();
      expectEveryCallToMatch(jiraConnectionMetadataSchema, transport.updateJiraConnectionMetadata);
    });

    test("Test connection and Save details refresh the connection list without closing the open issue or searching again", async () => {
      const wrapper = await mountWithTwoIssues();
      await openIssueRow(wrapper, 0);
      const searches = transport.searchJiraIssues.mock.calls.length;
      const issueReads = transport.getJiraIssue.mock.calls.length;
      const connectionLists = transport.listJiraConnections.mock.calls.length;
      await wrapper
        .findAll(".jira-view-tab")
        .find((tab) => tab.text() === "Settings")!
        .trigger("click");
      await wrapper
        .findAll("button")
        .find((button) => button.text() === "Test connection")!
        .trigger("click");
      await flushPromises();
      await wrapper
        .findAll("button")
        .find((button) => button.text() === "Edit")!
        .trigger("click");
      await wrapper
        .findAll(".jira-connection-edit button")
        .find((button) => button.text() === "Save details")!
        .trigger("click");
      await flushPromises();
      expect(transport.verifyJiraConnection).toHaveBeenCalledOnce();
      expect(transport.updateJiraConnectionMetadata).toHaveBeenCalledOnce();
      expect(transport.listJiraConnections.mock.calls.length).toBeGreaterThan(connectionLists);
      await wrapper
        .findAll(".jira-view-tab")
        .find((tab) => tab.text() === "Issues")!
        .trigger("click");
      await flushPromises();
      expect(transport.searchJiraIssues.mock.calls.length).toBe(searches);
      expect(transport.getJiraIssue.mock.calls.length).toBe(issueReads);
      expect(wrapper.find(".jira-detail-header h2").text()).toBe("First issue");
      wrapper.unmount();
    });

    test("the header Connection settings opens the selected connection in this pane only, even from the Board view", async () => {
      const first = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" }, attachTo: document.body });
      const second = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" }, attachTo: document.body });
      await flushPromises();
      await first
        .findAll(".jira-view-tab")
        .find((tab) => tab.text() === "Board")!
        .trigger("click");
      await first.get(".jira-head__add").trigger("click");
      await flushPromises();
      expect(first.get(".jira-inbox").classes()).toContain("jira-inbox--settings-view");
      expect(first.get(".jira-view-tab--active").text()).toBe("Settings");
      expect(first.get(".jira-connection-panel__header").attributes("aria-expanded")).toBe("true");
      expect(first.find(".jira-setup").exists()).toBe(false);
      expect(second.get(".jira-view-tab--active").text()).toBe("Issues");
      first.unmount();
      second.unmount();
    });

    test("a saved tab whose views could not be loaded offers Retry instead of saying it is gone", async () => {
      mockStoreState.transportApi = transport;
      const view = {
        viewId: "view-board",
        kind: "board",
        connectionId: "jira-1",
        boardId: 42,
        boardName: "Engineering board",
        title: "Engineering board",
        mode: "issues",
        sprintId: null,
        quickFilterIds: [],
        assignee: null,
        doneWithinDays: null,
        createdAt: 1,
        updatedAt: 1,
      };
      transport.getJiraWorkspaceViews.mockRejectedValueOnce(new Error("Registry offline")).mockResolvedValue({
        workspaceId: "jira:ws",
        profileId: "default",
        views: [{ viewId: "issues", kind: "issues", title: "Issues" }, view],
        activeViewId: "view-board",
        syncByViewId: {},
      });
      const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws", jiraViewId: "view-board" } });
      await flushPromises();
      expect(wrapper.find('[role="alert"]').text()).toContain("Could not load this saved Jira tab: Registry offline");
      expect(wrapper.find('[role="alert"]').text()).not.toContain("no longer available");
      await wrapper.find('[role="alert"] button').trigger("click");
      await flushPromises();
      expect(wrapper.find(".jira-error").exists()).toBe(false);
      expect(transport.getJiraWorkspaceViews).toHaveBeenCalledTimes(2);
      wrapper.unmount();
    });

    test("connections of the previous profile are not shown when the profile changed during the load", async () => {
      let finishOld!: (value: unknown) => void;
      transport.listJiraConnections
        .mockReset()
        .mockImplementationOnce(() => new Promise((resolve) => (finishOld = resolve)))
        .mockResolvedValue([
          { id: "jira-2", label: "Other profile Jira", deployment: "data-center", webUrl: "https://other.example.com" },
        ]);
      const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
      await flushPromises();
      (mockStoreState.payload as { appState: { activeProfileId: string } }).appState.activeProfileId = "other";
      await flushPromises();
      finishOld([
        { id: "jira-1", label: "Engineering", deployment: "data-center", webUrl: "https://jira.example.com" },
      ]);
      await flushPromises();
      const labels = wrapper
        .findAllComponents(CustomSelect)
        .flatMap((select) => customSelectProps(select).options.map((option) => option.label));
      expect(labels.some((label) => label.includes("Other profile Jira"))).toBe(true);
      expect(labels.some((label) => label.includes("Engineering"))).toBe(false);
      wrapper.unmount();
    });

    test("a project scope that could not be saved is rolled back and the error stays on the picker summary", async () => {
      transport.setJiraWorkspaceProjectScope.mockRejectedValueOnce(new Error("Store locked"));
      const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" }, attachTo: document.body });
      await flushPromises();
      await wrapper.get(".jira-primary-project-scope > summary").trigger("click");
      await flushPromises();
      await wrapper.get('.jira-project-scope-picker__project input[type="checkbox"]').setValue(true);
      await wrapper.get(".jira-project-scope-picker__apply").trigger("click");
      await flushPromises();
      expect(wrapper.get(".jira-primary-project-scope .jira-project-scope-picker__selection").text()).toBe(
        "All projects",
      );
      expect(
        wrapper.get(".jira-primary-project-scope > summary .jira-project-scope-picker__save-error").text(),
      ).toContain("Could not save the project scope; the previous scope was restored: Store locked");
      wrapper.unmount();
    });

    test("a failed assignee search says so instead of claiming there are no users", async () => {
      const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" }, attachTo: document.body });
      await flushPromises();
      await wrapper
        .findAll(".jira-view-tab")
        .find((tab) => tab.text() === "Board")!
        .trigger("click");
      await chooseCustomSelect(wrapper, ".jira-board-controls", 42);
      vi.useFakeTimers();
      try {
        transport.searchJiraUsers.mockRejectedValueOnce(desktopJiraFailure("Users are hidden.", "permission-denied"));
        const input = wrapper.get("#jira-assignee-search");
        await input.setValue("ali");
        await vi.advanceTimersByTimeAsync(300);
        await flushPromises();
        expect(wrapper.text()).toContain("Could not search Jira users: Users are hidden.");
        expect(wrapper.text()).not.toContain("No Jira users found.");
      } finally {
        vi.useRealTimers();
      }
      wrapper.unmount();
    });

    test("a refresh that the runtime rejects ends in the sync line, not in an unhandled rejection", async () => {
      mockStoreState.transportApi = transport;
      const view = {
        viewId: "view-board",
        kind: "board",
        connectionId: "jira-1",
        boardId: 42,
        boardName: "Engineering board",
        title: "Engineering board",
        mode: "issues",
        sprintId: null,
        quickFilterIds: [],
        assignee: null,
        doneWithinDays: null,
        createdAt: 1,
        updatedAt: 1,
      };
      transport.getJiraWorkspaceViews.mockResolvedValue({
        workspaceId: "jira:ws",
        profileId: "default",
        views: [{ viewId: "issues", kind: "issues", title: "Issues" }, view],
        activeViewId: "view-board",
        syncByViewId: {},
      });
      transport.refreshJiraWorkspaceViews.mockRejectedValue(new Error("Sync engine stopped"));
      const unhandled = vi.fn();
      process.on("unhandledRejection", unhandled);
      try {
        const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws", jiraViewId: "view-board" } });
        await flushPromises();
        await wrapper.get(".jira-head__refresh").trigger("click");
        await flushPromises();
        expect(wrapper.get(".jira-head__sync").text()).toContain("Could not refresh Jira data: Sync engine stopped");
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(unhandled).not.toHaveBeenCalled();
        wrapper.unmount();
      } finally {
        process.off("unhandledRejection", unhandled);
      }
    });

    test("opens the issue the sidebar asked for in this workspace, then clears the request", async () => {
      mockStoreState.jiraIssueOpenRequest = {
        workspaceId: "jira:ws",
        ref: { connectionId: "jira-1", issueId: "1001", issueKey: "ENG-1" },
        sequence: 1,
      };
      const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
      await flushPromises();
      expect(transport.getJiraIssue).toHaveBeenCalledWith(
        expect.objectContaining({ connectionId: "jira-1", issueId: "1001" }),
      );
      expect(wrapper.find(".jira-detail-header h2").text()).toBe("Fix login");
      expect(mockStoreState.jiraIssueOpenRequest).toBeNull();
      wrapper.unmount();
    });

    test("runs the search the header handed over as a quick search, then clears the request", async () => {
      mockStoreState.jiraSearchRequest = { workspaceId: "jira:ws", text: "login timeout", sequence: 1 };
      const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
      await flushPromises();
      expect(transport.searchJiraIssues).toHaveBeenCalledWith(
        expect.objectContaining({
          connectionId: "jira-1",
          jql: 'text ~ "login" AND text ~ "timeout" ORDER BY updated DESC',
        }),
      );
      expect((wrapper.find(".jira-quick-search input").element as HTMLInputElement).value).toBe("login timeout");
      expect(mockStoreState.jiraSearchRequest).toBeNull();
      wrapper.unmount();
    });

    test("ignores an issue request for another workspace and reports a connection this profile does not have", async () => {
      mockStoreState.jiraIssueOpenRequest = {
        workspaceId: "someone-else",
        ref: { connectionId: "jira-1", issueId: "1001", issueKey: "ENG-1" },
        sequence: 1,
      };
      const other = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
      await flushPromises();
      expect(transport.getJiraIssue).not.toHaveBeenCalled();
      expect(mockStoreState.jiraIssueOpenRequest).not.toBeNull();
      other.unmount();
      mockStoreState.jiraIssueOpenRequest = {
        workspaceId: "jira:ws",
        ref: { connectionId: "missing", issueId: "1", issueKey: "NOPE-1" },
        sequence: 2,
      };
      const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
      await flushPromises();
      expect(transport.getJiraIssue).not.toHaveBeenCalled();
      expect(wrapper.find('[role="alert"]').text()).toContain("Could not open NOPE-1");
      expect(mockStoreState.jiraIssueOpenRequest).toBeNull();
      wrapper.unmount();
    });

    test("a superseded view activation after saving a board tab is not an error", async () => {
      mockStoreState.transportApi = transport;
      mockStoreState.payload = reactive({
        appState: {
          activeProfileId: "default",
          workspaces: [{ id: "jira:ws", name: "Jira inbox", kind: "jira", profileId: "default" }],
        },
      });
      const issuesView = { viewId: "issues", kind: "issues" as const, title: "Issues" };
      const savedView = {
        viewId: "saved-board-42",
        kind: "board" as const,
        connectionId: "jira-1",
        boardId: 42,
        boardName: "Engineering board",
        title: "Engineering board",
        mode: "issues" as const,
        sprintId: null,
        quickFilterIds: [],
        assignee: null,
        doneWithinDays: 14 as const,
        createdAt: 1,
        updatedAt: 1,
      };
      const savedState = {
        workspaceId: "jira:ws",
        profileId: "default",
        views: [issuesView, savedView],
        activeViewId: savedView.viewId,
        syncByViewId: {},
      };
      transport.getJiraWorkspaceViews.mockResolvedValue({ ...savedState, views: [issuesView], activeViewId: "issues" });
      transport.saveJiraWorkspaceView.mockResolvedValue(savedState);
      transport.activateView.mockRejectedValueOnce(new Error("View activation was superseded"));
      const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" }, attachTo: document.body });
      await flushPromises();
      await chooseCustomSelect(wrapper, ".jira-board-controls", 42);
      await flushPromises();
      expect(transport.activateView).not.toHaveBeenCalled();
      await wrapper.get(".jira-save-board-tab").trigger("click");
      await flushPromises();
      expect(transport.activateView).toHaveBeenCalledOnce();
      expect(wrapper.find('[role="alert"]').exists()).toBe(false);
      expect(wrapper.text()).not.toContain("superseded");
      wrapper.unmount();
    });

    test("an error of one profile does not stay on screen after switching profile", async () => {
      answerFirstOpenSearch();
      transport.searchJiraIssues.mockRejectedValueOnce(new Error("Old profile failure"));
      const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
      await flushPromises();
      await wrapper.find("form.jira-search").trigger("submit");
      await flushPromises();
      expect(wrapper.find('[role="alert"]').text()).toContain("Old profile failure");
      (mockStoreState.payload as { appState: { activeProfileId: string } }).appState.activeProfileId = "other";
      await flushPromises();
      expect(wrapper.find('[role="alert"]').exists()).toBe(false);
      wrapper.unmount();
    });

    test("a saved repository target that cannot be read is a notice, not a failed issue", async () => {
      const wrapper = await mountWithTwoIssues();
      transport.getJiraIssue.mockImplementation(async ({ issueId }: { issueId: string }) => ({
        ref: issueRef(issueId, "ENG-1"),
        summary: "First issue",
        projectKey: "ENG",
        status: "Open",
        description: "",
        attachments: [],
      }));
      transport.getJiraRepoBindingPreference.mockRejectedValueOnce(new Error("Preferences locked"));
      await openIssueRow(wrapper, 0);
      expect(wrapper.find(".jira-detail-header h2").text()).toBe("First issue");
      expect(wrapper.find(".jira-error").exists()).toBe(false);
      await wrapper
        .get(".jira-detail-header__actions")
        .findAll("button")
        .find((button) => button.text() === "Start development")!
        .trigger("click");
      await flushPromises();
      expect(branchPanel(wrapper).text()).toContain(
        "Could not load the saved repository target for this project: Preferences locked",
      );
      wrapper.unmount();
    });

    test("switching to All connections while a load is pending does not leave the pane busy", async () => {
      transport.listJiraConnections.mockResolvedValue([
        { id: "jira-1", label: "Engineering", deployment: "cloud", webUrl: "https://one.example" },
        { id: "jira-2", label: "Operations", deployment: "cloud", webUrl: "https://two.example" },
      ]);
      let finishSearch!: (value: unknown) => void;
      transport.searchJiraIssues.mockImplementationOnce(() => new Promise((resolve) => (finishSearch = resolve)));
      const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
      await flushPromises();
      await wrapper.find("form.jira-search").trigger("submit");
      await chooseCustomSelect(wrapper, ".jira-head", "__all__");
      finishSearch([]);
      await flushPromises();
      expect(wrapper.get(".jira-head__refresh").attributes("disabled")).toBeUndefined();
      wrapper.unmount();
    });
  });
  describe("loading states and layout stability", () => {
    const issueRef = (issueId: string, issueKey: string) => ({
      provider: "jira" as const,
      connectionId: "jira-1",
      issueId,
      issueKey,
    });
    const detailOf = (issueId: string) => ({
      ref: issueRef(issueId, issueId === "1001" ? "ENG-1" : "ENG-2"),
      summary: issueId === "1001" ? "First issue" : "Second issue",
      status: "Open",
      description: "",
      attachments: [],
    });
    async function mountWithTwoIssues() {
      transport.searchJiraIssues.mockResolvedValue([
        { ref: issueRef("1001", "ENG-1"), summary: "First issue" },
        { ref: issueRef("1002", "ENG-2"), summary: "Second issue" },
      ]);
      transport.getJiraIssue.mockImplementation(async ({ issueId }: { issueId: string }) => detailOf(issueId));
      const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" }, attachTo: document.body });
      await flushPromises();
      await wrapper.find("form.jira-search").trigger("submit");
      await flushPromises();
      return wrapper;
    }

    test("the sync status lives in the header slot, which stays one element while idle and while loading", async () => {
      answerFirstOpenSearch();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      let finishSearch!: (value: unknown) => void;
      transport.searchJiraIssues.mockImplementationOnce(() => new Promise((resolve) => (finishSearch = resolve)));
      const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
      await flushPromises();
      const slot = wrapper.get(".jira-head__sync");
      expect(wrapper.find(".jira-status-strip").exists()).toBe(false);
      expect(slot.attributes("aria-busy")).toBeUndefined();
      expect(slot.attributes("role")).toBe("status");
      expect(slot.attributes("aria-live")).toBe("polite");

      await wrapper.find("form.jira-search").trigger("submit");
      await flushPromises();
      await pastDelayedIndicators();
      expect(wrapper.findAll(".jira-head__sync")).toHaveLength(1);
      expect(wrapper.get(".jira-head__sync").element).toBe(slot.element);
      expect(slot.attributes("aria-busy")).toBe("true");
      expect(slot.get(".jira-head__sync-status").text()).toContain("Searching Jira issues");

      finishSearch([]);
      await flushPromises();
      expect(wrapper.get(".jira-head__sync").element).toBe(slot.element);
      await pastDelayedIndicators();
      expect(slot.attributes("aria-busy")).toBeUndefined();
      expect(slot.find(".jira-head__sync-status").exists()).toBe(false);
      wrapper.unmount();
      vi.useRealTimers();
    });

    test("no empty state renders while connections or the first search are still loading", async () => {
      let resolveConnections!: (value: unknown) => void;
      const connections = [{ id: "jira-1", label: "Engineering", deployment: "cloud", webUrl: "https://one.example" }];
      transport.listJiraConnections.mockReset().mockImplementation(() => new Promise((r) => (resolveConnections = r)));
      const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
      await flushPromises();
      expect(wrapper.find(".jira-empty--search").exists()).toBe(false);
      expect(wrapper.find(".jira-skeleton").exists()).toBe(true);

      let finishSearch!: (value: unknown) => void;
      transport.searchJiraIssues.mockImplementationOnce(() => new Promise((resolve) => (finishSearch = resolve)));
      resolveConnections(connections);
      await flushPromises();
      expect(wrapper.find(".jira-empty--search").exists()).toBe(false);
      expect(wrapper.find(".jira-skeleton").exists()).toBe(true);
      finishSearch([]);
      await flushPromises();
      expect(wrapper.find(".jira-empty--search").text()).toContain("No matching Jira issues");

      transport.searchJiraIssues.mockImplementationOnce(() => new Promise((resolve) => (finishSearch = resolve)));
      await wrapper.find("form.jira-search").trigger("submit");
      await flushPromises();
      expect(wrapper.find(".jira-skeleton").exists()).toBe(true);
      finishSearch([]);
      await flushPromises();
      expect(wrapper.find(".jira-empty--search").text()).toContain("No matching Jira issues");
      wrapper.unmount();
    });

    test("a list that is being searched again keeps its rows, dimmed and marked busy", async () => {
      const wrapper = await mountWithTwoIssues();
      const rowsBefore = wrapper.findAll(".jira-issue");
      expect(rowsBefore).toHaveLength(2);
      expect(wrapper.get(".jira-results").attributes("aria-busy")).toBeUndefined();
      let finishSearch!: (value: unknown) => void;
      transport.searchJiraIssues.mockImplementationOnce(() => new Promise((resolve) => (finishSearch = resolve)));
      await wrapper.find("form.jira-search").trigger("submit");
      await flushPromises();
      expect(wrapper.get(".jira-results").attributes("aria-busy")).toBe("true");
      expect(wrapper.findAll(".jira-issue")).toHaveLength(2);
      expect(wrapper.findAll(".jira-issue")[0]!.element).toBe(rowsBefore[0]!.element);
      expect(wrapper.find(".jira-empty--search").exists()).toBe(false);
      finishSearch([]);
      await flushPromises();
      expect(wrapper.get(".jira-results").attributes("aria-busy")).toBeUndefined();
      wrapper.unmount();
    });

    test("openIssue keeps the previous issue on screen until the next one resolves", async () => {
      const wrapper = await mountWithTwoIssues();
      await wrapper.findAll(".jira-issue")[0]!.trigger("click");
      await flushPromises();
      expect(wrapper.get(".jira-detail-header h2").text()).toBe("First issue");

      let resolveSecond!: (value: unknown) => void;
      transport.getJiraIssue.mockImplementation(({ issueId }: { issueId: string }) =>
        issueId === "1002" ? new Promise((resolve) => (resolveSecond = resolve)) : Promise.resolve(detailOf(issueId)),
      );
      await wrapper.findAll(".jira-issue")[1]!.trigger("click");
      await flushPromises();
      expect(wrapper.get(".jira-detail-header h2").text()).toBe("First issue");
      expect(wrapper.get(".jira-detail").attributes("aria-busy")).toBe("true");
      expect(wrapper.get(".jira-detail").attributes("data-selected")).toBe("true");
      expect(wrapper.findAll(".jira-issue")[1]!.classes()).toContain("selected");

      resolveSecond(detailOf("1002"));
      await flushPromises();
      expect(wrapper.get(".jira-detail-header h2").text()).toBe("Second issue");
      expect(wrapper.get(".jira-detail").attributes("aria-busy")).toBeUndefined();
      wrapper.unmount();
    });

    test("sending a comment leaves the Search button and the project picker alone", async () => {
      const wrapper = await mountWithTwoIssues();
      await wrapper.findAll(".jira-issue")[0]!.trigger("click");
      await flushPromises();
      await wrapper.get(".jira-quick-search input").setValue("login");
      await wrapper.get(COMMENT_BOX).setValue("Looks good to me");
      let finishWrite!: (value: unknown) => void;
      transport.executeJiraWrite.mockImplementationOnce(() => new Promise((resolve) => (finishWrite = resolve)));
      const searchButton = wrapper.get(".jira-quick-search button");
      const labelBefore = searchButton.text();
      const sendButton = () => wrapper.get(".jira-comment-composer button[type=submit]");
      const widthBefore = sendButton().text();
      await wrapper.get(".jira-comment-composer").trigger("submit");
      await flushPromises();

      expect(searchButton.text()).toBe(labelBefore);
      expect(searchButton.attributes("disabled")).toBeUndefined();
      expect(searchButton.attributes("aria-busy")).toBeUndefined();
      expect(wrapper.getComponent({ name: "JiraProjectScopePicker" }).props("disabled")).toBeFalsy();
      expect(sendButton().attributes("aria-busy")).toBe("true");
      expect(sendButton().text()).toBe(widthBefore);
      expect(
        wrapper
          .findAll(".jira-comment-composer button")
          .find((button) => button.text() === "Discard")!
          .attributes("disabled"),
      ).toBeDefined();

      finishWrite({ ok: true, data: { status: "succeeded", journalId: "write-1" } });
      await flushPromises();
      wrapper.unmount();
    });

    test("the status menu opens at once with a loading row and then lists the transitions", async () => {
      let resolveTransitions!: (value: unknown) => void;
      transport.listJiraTransitions.mockImplementationOnce(
        () => new Promise((resolve) => (resolveTransitions = resolve)),
      );
      const wrapper = await mountWithTwoIssues();
      await wrapper.findAll(".jira-issue")[0]!.trigger("click");
      await flushPromises();
      await wrapper.get(".jira-status-menu > summary").trigger("click");
      await flushPromises();
      expect((wrapper.get(".jira-status-menu").element as HTMLDetailsElement).open).toBe(true);
      expect(wrapper.get(".jira-status-menu .jira-menu__note").text()).toContain("Loading transitions");
      expect(wrapper.findAll(".jira-status-menu [role=menuitem]")).toHaveLength(0);
      resolveTransitions([{ id: "7", name: "Finish", to: "Done", requiredFields: [] }]);
      await flushPromises();
      expect(wrapper.find(".jira-status-menu .jira-menu__note").exists()).toBe(false);
      expect(wrapper.findAll(".jira-status-menu [role=menuitem]").map((item) => item.text())).toEqual(["DoneFinish"]);
      wrapper.unmount();
    });

    test("a failed background sync shows how long ago, why, and when it retries, in the fixed sync line", async () => {
      mockStoreState.transportApi = transport;
      mockStoreState.isMobileSession = true;
      const savedView = {
        viewId: "saved-personal-failed-refresh",
        kind: "personal" as const,
        connectionId: "jira-1",
        boardId: null,
        boardName: "My issues",
        title: "My issues",
        mode: "issues" as const,
        sprintId: null,
        quickFilterIds: [],
        assignee: null,
        doneWithinDays: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      const failedAt = Date.now() - 2 * 60_000;
      const state: JiraWorkspaceViewsState = {
        workspaceId: "jira:ws",
        profileId: "default",
        views: [{ viewId: "issues", kind: "issues", title: "Issues" }, savedView],
        activeViewId: savedView.viewId,
        syncByViewId: {
          [savedView.viewId]: {
            state: "error",
            error: "Jira is unavailable.",
            failedAt,
            code: "rate-limited",
            retryAfterMs: 10 * 60_000,
          },
        },
      };
      mockStoreState.payload = reactive({
        appState: {
          activeProfileId: "default",
          workspaces: [{ id: "jira:ws", name: "Jira inbox", kind: "jira", profileId: "default" }],
        },
        jiraWorkspaceViews: { "jira:ws": state },
      });
      transport.getJiraWorkspaceViews.mockResolvedValue(state);
      transport.searchJiraIssues.mockResolvedValueOnce(null);
      const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws", jiraViewId: savedView.viewId } });
      await flushPromises();
      const line = wrapper.get(".jira-head__sync");
      expect(line.text()).toContain("Last refresh failed 2m ago");
      expect(line.text()).toContain("Jira rate limit reached");
      expect(line.text()).toMatch(/retrying in \d+ s/);
      wrapper.unmount();
    });
  });

  describe("daily-use flows", () => {
    const issueRef = (issueId: string, issueKey: string) => ({
      provider: "jira" as const,
      connectionId: "jira-1",
      issueId,
      issueKey,
    });
    function twoIssues() {
      transport.searchJiraIssues.mockResolvedValue([
        { ref: issueRef("1001", "ENG-1"), summary: "First issue", status: "Open" },
        { ref: issueRef("1002", "ENG-2"), summary: "Second issue", status: "Open" },
      ]);
      transport.getJiraIssue.mockImplementation(async ({ issueId }: { issueId: string }) => ({
        ref: issueRef(issueId, issueId === "1001" ? "ENG-1" : "ENG-2"),
        summary: issueId === "1001" ? "First issue" : "Second issue",
        status: "Open",
        description: "",
        attachments: [],
        url: `https://jira.example.com/browse/${issueId === "1001" ? "ENG-1" : "ENG-2"}`,
      }));
    }
    async function mountWithTwoIssues() {
      twoIssues();
      const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" }, attachTo: document.body });
      await flushPromises();
      await wrapper.find("form.jira-search").trigger("submit");
      await flushPromises();
      return wrapper;
    }
    async function openIssueRow(wrapper: ReturnType<typeof mount>, index: number) {
      await wrapper.findAll(".jira-issue")[index]!.trigger("click");
      await flushPromises();
    }
    const assignMenuItem = (wrapper: ReturnType<typeof mount>, label: string) =>
      wrapper.findAll(".jira-assign-menu [role=menuitem]").find((item) => item.text().includes(label))!;
    async function key(target: { trigger: (event: string, init?: object) => Promise<unknown> }, name: string) {
      await target.trigger("keydown", { key: name });
      await flushPromises();
    }

    describe("assigning", () => {
      test("Assign to me previews and executes the me assignee after one Confirm", async () => {
        const wrapper = await mountWithTwoIssues();
        await openIssueRow(wrapper, 0);
        await wrapper.get(".jira-assign-menu > summary").trigger("click");
        await assignMenuItem(wrapper, "Assign to me").trigger("click");
        await flushPromises();
        const card = wrapper.get(".jira-write-card");
        expect(card.get(".jira-write-card__question").text()).toBe("Assign ENG-1 to me (Alice)?");
        expect(card.get(".jira-reason__summary").text()).toContain("Assign ENG-1 to me");
        await card.get("button.jira-write-card__confirm").trigger("click");
        await flushPromises();
        expect(transport.previewJiraWrite).toHaveBeenCalledWith({
          action: "assign",
          ref: expect.objectContaining({ issueId: "1001" }),
          assignee: { kind: "me" },
          intent: "Assign ENG-1 to me",
        });
        expect(transport.executeJiraWrite).toHaveBeenCalledWith(
          expect.objectContaining({ action: "assign", assignee: { kind: "me" } }),
        );
        expectEveryCallToMatch(jiraWritePreviewSchema, transport.previewJiraWrite);
        expectEveryCallToMatch(jiraWriteExecuteSchema, transport.executeJiraWrite);
        expect(wrapper.find(".jira-write-card").exists()).toBe(false);
        expect(wrapper.get(".jira-write-feedback").text()).toContain("Assigned ENG-1 to me.");
        expect(document.activeElement).toBe(wrapper.get(".jira-assign-menu > summary").element);
        wrapper.unmount();
      });

      test("Unassign sends the unassigned assignee", async () => {
        const wrapper = await mountWithTwoIssues();
        await openIssueRow(wrapper, 0);
        await wrapper.get(".jira-assign-menu > summary").trigger("click");
        await assignMenuItem(wrapper, "Unassign").trigger("click");
        await flushPromises();
        expect(wrapper.get(".jira-write-card__question").text()).toBe("Unassign ENG-1?");
        await wrapper.get("button.jira-write-card__confirm").trigger("click");
        await flushPromises();
        expect(transport.previewJiraWrite).toHaveBeenCalledWith(
          expect.objectContaining({ action: "assign", assignee: { kind: "unassigned" }, intent: "Unassign ENG-1" }),
        );
        expectEveryCallToMatch(jiraWritePreviewSchema, transport.previewJiraWrite);
        expectEveryCallToMatch(jiraWriteExecuteSchema, transport.executeJiraWrite);
        wrapper.unmount();
      });

      test("a user found by search is assigned by id", async () => {
        const wrapper = await mountWithTwoIssues();
        await openIssueRow(wrapper, 0);
        transport.searchJiraUsers.mockResolvedValueOnce([
          { kind: "data-center", name: "bob", displayName: "Bob Builder" },
        ]);
        await wrapper.get(".jira-assign-menu > summary").trigger("click");
        await flushPromises();
        await wrapper.get(".jira-assign-search input").setValue("bob");
        await new Promise((resolve) => setTimeout(resolve, 320));
        await flushPromises();
        expect(transport.searchJiraUsers).toHaveBeenCalledWith({ connectionId: "jira-1", query: "bob", limit: 25 });
        await assignMenuItem(wrapper, "Bob Builder").trigger("click");
        await flushPromises();
        expect(wrapper.get(".jira-write-card__question").text()).toBe("Assign ENG-1 to Bob Builder?");
        await wrapper.get("button.jira-write-card__confirm").trigger("click");
        await flushPromises();
        expect(transport.previewJiraWrite).toHaveBeenCalledWith(
          expect.objectContaining({
            action: "assign",
            assignee: { kind: "user", id: "bob", displayName: "Bob Builder" },
            intent: "Assign ENG-1 to Bob Builder",
          }),
        );
        expectEveryCallToMatch(jiraWritePreviewSchema, transport.previewJiraWrite);
        expectEveryCallToMatch(jiraWriteExecuteSchema, transport.executeJiraWrite);
        wrapper.unmount();
      });

      test("a failed user search says so instead of showing an empty list", async () => {
        const wrapper = await mountWithTwoIssues();
        await openIssueRow(wrapper, 0);
        transport.searchJiraUsers.mockRejectedValueOnce(new Error("Directory offline"));
        await wrapper.get(".jira-assign-menu > summary").trigger("click");
        await flushPromises();
        await wrapper.get(".jira-assign-search input").setValue("bob");
        await new Promise((resolve) => setTimeout(resolve, 320));
        await flushPromises();
        expect(wrapper.get(".jira-assign-menu [role=alert]").text()).toContain("Directory offline");
        expect(wrapper.get(".jira-assign-menu").text()).not.toContain("No Jira users found.");
        wrapper.unmount();
      });

      test("without a chosen Jira identity, Assign to me asks for it instead of previewing", async () => {
        transport.listJiraConnections.mockResolvedValue([
          {
            id: "jira-1",
            label: "Engineering",
            deployment: "data-center",
            webUrl: "https://jira.example.com",
            accountPurpose: "technical",
            verifiedIdentity: { displayName: "Build Bot" },
          },
        ]);
        const wrapper = await mountWithTwoIssues();
        await openIssueRow(wrapper, 0);
        const item = assignMenuItem(wrapper, "Assign to me");
        expect(item.text()).toContain("Choose your Jira identity first");
        await wrapper.get(".jira-assign-menu > summary").trigger("click");
        await item.trigger("click");
        await flushPromises();
        expect(wrapper.find(".jira-write-card").exists()).toBe(false);
        expect(wrapper.find(".jira-human-identity-setup").exists()).toBe(true);
        expect(transport.previewJiraWrite).not.toHaveBeenCalled();
        wrapper.unmount();
      });
    });

    describe("drafts and the reason", () => {
      test("a comment draft and its edited reason survive switching issues", async () => {
        const wrapper = await mountWithTwoIssues();
        await openIssueRow(wrapper, 0);
        await wrapper.get(COMMENT_BOX).setValue("Half-written thought about the first issue");
        await wrapper.get(".jira-comment-composer .jira-reason__edit").trigger("click");
        await wrapper
          .get('.jira-comment-composer input[aria-label="Reason for this change"]')
          .setValue("Thinking aloud");
        await openIssueRow(wrapper, 1);
        expect((wrapper.get(COMMENT_BOX).element as HTMLTextAreaElement).value).toBe("");
        await wrapper.get(COMMENT_BOX).setValue("Different words for the second");
        expect(wrapper.get(".jira-comment-composer .jira-reason__text").text()).toBe("Comment on ENG-2");
        await openIssueRow(wrapper, 0);
        expect((wrapper.get(COMMENT_BOX).element as HTMLTextAreaElement).value).toBe(
          "Half-written thought about the first issue",
        );
        expect(wrapper.get(".jira-comment-composer .jira-reason__text").text()).toBe("Thinking aloud");
        await openIssueRow(wrapper, 1);
        expect((wrapper.get(COMMENT_BOX).element as HTMLTextAreaElement).value).toBe("Different words for the second");
        wrapper.unmount();
      });

      test("closing the detail with Escape keeps the draft for the next time", async () => {
        const wrapper = await mountWithTwoIssues();
        await openIssueRow(wrapper, 0);
        await wrapper.get(COMMENT_BOX).setValue("Do not lose me");
        await key(wrapper.get(".jira-detail-header"), "Escape");
        expect(wrapper.find(".jira-detail-header").exists()).toBe(false);
        await openIssueRow(wrapper, 0);
        expect((wrapper.get(COMMENT_BOX).element as HTMLTextAreaElement).value).toBe("Do not lose me");
        wrapper.unmount();
      });

      test("discarding a draft asks first and only clears it after the answer is yes", async () => {
        const wrapper = await mountWithTwoIssues();
        await openIssueRow(wrapper, 0);
        await wrapper.get(COMMENT_BOX).setValue("Maybe delete this");
        const discard = () =>
          wrapper.findAll(".jira-comment-composer button").find((button) => button.text() === "Discard")!;
        transport.confirmInApp.mockResolvedValueOnce(false);
        await discard().trigger("click");
        await flushPromises();
        expect(transport.confirmInApp).toHaveBeenCalledWith(
          expect.objectContaining({ title: "Discard this comment?", danger: true }),
        );
        expect((wrapper.get(COMMENT_BOX).element as HTMLTextAreaElement).value).toBe("Maybe delete this");
        await discard().trigger("click");
        await flushPromises();
        expect((wrapper.get(COMMENT_BOX).element as HTMLTextAreaElement).value).toBe("");
        expect(document.activeElement).toBe(wrapper.get(COMMENT_BOX).element);
        wrapper.unmount();
      });

      test("a reason under 8 characters is explained with a counter and blocks sending", async () => {
        const wrapper = await mountWithTwoIssues();
        await openIssueRow(wrapper, 0);
        await wrapper.get(COMMENT_BOX).setValue("A real comment");
        expect(wrapper.get(".jira-comment-composer .jira-reason__summary").text()).toContain("Comment on ENG-1");
        const send = () => wrapper.get(".jira-comment-composer button[type=submit]");
        expect(send().attributes("disabled")).toBeUndefined();
        await wrapper.get(".jira-comment-composer .jira-reason__edit").trigger("click");
        await wrapper.get('.jira-comment-composer input[aria-label="Reason for this change"]').setValue("short");
        expect(wrapper.get(".jira-comment-composer .jira-field-error").text()).toContain("at least 8 characters (5/8)");
        expect(wrapper.get(".jira-comment-composer .jira-reason__counter").text()).toBe("5 / 8+");
        expect(send().attributes("disabled")).toBeDefined();
        await wrapper.get(".jira-comment-composer").trigger("submit");
        await flushPromises();
        expect(transport.previewJiraWrite).not.toHaveBeenCalled();
        await wrapper
          .get('.jira-comment-composer input[aria-label="Reason for this change"]')
          .setValue("Agreed in the standup");
        expect(send().attributes("disabled")).toBeUndefined();
        await wrapper.get(".jira-comment-composer").trigger("submit");
        await flushPromises();
        expect(transport.previewJiraWrite).toHaveBeenCalledWith(
          expect.objectContaining({ action: "comment", intent: "Agreed in the standup" }),
        );
        wrapper.unmount();
      });

      test("Ctrl+Enter sends the comment and focus moves to the new comment", async () => {
        const wrapper = await mountWithTwoIssues();
        transport.listJiraComments.mockResolvedValue([
          { id: "c1", author: "Alice", body: "Earlier", created: "2026-10-01T10:00:00Z" },
        ]);
        await openIssueRow(wrapper, 0);
        transport.listJiraComments.mockResolvedValue([
          { id: "c1", author: "Alice", body: "Earlier", created: "2026-10-01T10:00:00Z" },
          { id: "c2", author: "Build Bot", body: "Ship it", created: "2026-11-01T10:00:00Z" },
        ]);
        await wrapper.get(COMMENT_BOX).setValue("Ship it");
        await wrapper.get(COMMENT_BOX).trigger("keydown", { key: "Enter", ctrlKey: true });
        await flushPromises();
        expect(transport.executeJiraWrite).toHaveBeenCalledWith(expect.objectContaining({ action: "comment" }));
        expect((wrapper.get(COMMENT_BOX).element as HTMLTextAreaElement).value).toBe("");
        const comments = wrapper.findAll(".jira-comment");
        expect(comments).toHaveLength(2);
        expect(document.activeElement).toBe(comments[1]!.element);
        wrapper.unmount();
      });

      test("copying the key or the link confirms briefly without moving the layout", async () => {
        const writeText = vi.fn().mockResolvedValue(undefined);
        Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
        const wrapper = await mountWithTwoIssues();
        await openIssueRow(wrapper, 0);
        const more = wrapper.get(".jira-detail-header__actions > details:last-child");
        await more
          .findAll("[role=menuitem]")
          .find((item) => item.text() === "Copy key")!
          .trigger("click");
        await flushPromises();
        expect(writeText).toHaveBeenLastCalledWith("ENG-1");
        expect(wrapper.get(".jira-write-feedback").text()).toContain("Copied ENG-1");
        await more
          .findAll("[role=menuitem]")
          .find((item) => item.text() === "Copy link")!
          .trigger("click");
        await flushPromises();
        expect(writeText).toHaveBeenLastCalledWith("https://jira.example.com/browse/ENG-1");
        writeText.mockRejectedValueOnce(new Error("Clipboard blocked"));
        await more
          .findAll("[role=menuitem]")
          .find((item) => item.text() === "Copy key")!
          .trigger("click");
        await flushPromises();
        expect(wrapper.get(".jira-detail-header .jira-inline-error").text()).toContain("Clipboard blocked");
        wrapper.unmount();
      });

      test("Cancel closes the status confirmation and returns focus to the status pill", async () => {
        const wrapper = await mountWithTwoIssues();
        await openIssueRow(wrapper, 0);
        await pickStatus(wrapper, "In Progress");
        expect(wrapper.find(".jira-write-card").exists()).toBe(true);
        await wrapper
          .get(".jira-write-card")
          .findAll("button")
          .find((button) => button.text() === "Cancel")!
          .trigger("click");
        await flushPromises();
        expect(wrapper.find(".jira-write-card").exists()).toBe(false);
        expect(document.activeElement).toBe(wrapper.get(".jira-status-menu > summary").element);
        expect(transport.previewJiraWrite).not.toHaveBeenCalled();
        wrapper.unmount();
      });
    });

    describe("keyboard", () => {
      test("the list is one Tab stop; j/k and the arrows move focus, Enter opens, Escape closes and returns", async () => {
        const wrapper = await mountWithTwoIssues();
        const rows = () => wrapper.findAll(".jira-issue");
        expect(rows().filter((row) => row.attributes("tabindex") === "0")).toHaveLength(1);
        expect(rows()[0]!.attributes("tabindex")).toBe("0");
        expect(rows()[1]!.attributes("tabindex")).toBe("-1");
        (rows()[0]!.element as HTMLElement).focus();
        await key(rows()[0]!, "j");
        expect(document.activeElement).toBe(rows()[1]!.element);
        expect(rows()[1]!.attributes("tabindex")).toBe("0");
        expect(rows()[0]!.attributes("tabindex")).toBe("-1");
        await key(rows()[1]!, "ArrowUp");
        expect(document.activeElement).toBe(rows()[0]!.element);
        await key(rows()[0]!, "k");
        expect(document.activeElement).toBe(rows()[0]!.element);
        await key(rows()[0]!, "ArrowDown");
        expect(document.activeElement).toBe(rows()[1]!.element);
        expect(wrapper.find(".jira-detail-header").exists()).toBe(false);

        await key(rows()[1]!, "Enter");
        expect(wrapper.get(".jira-detail-header h2").text()).toBe("Second issue");
        expect(document.activeElement).toBe(rows()[1]!.element);
        await key(rows()[1]!, "k");
        expect(document.activeElement).toBe(rows()[0]!.element);
        expect(wrapper.get(".jira-detail-header h2").text()).toBe("First issue");

        await wrapper.get(".jira-detail-header h2").trigger("keydown", { key: "Escape" });
        await flushPromises();
        expect(wrapper.find(".jira-detail-header").exists()).toBe(false);
        expect(document.activeElement).toBe(rows()[0]!.element);
        wrapper.unmount();
      });

      test("keys are ignored while typing in a field, and Escape still closes the detail", async () => {
        const wrapper = await mountWithTwoIssues();
        await openIssueRow(wrapper, 0);
        const search = wrapper.get('input[aria-label="Search Jira by issue key or words"]');
        (search.element as HTMLInputElement).focus();
        const typed = new KeyboardEvent("keydown", { key: "j", bubbles: true, cancelable: true });
        search.element.dispatchEvent(typed);
        const slash = new KeyboardEvent("keydown", { key: "/", bubbles: true, cancelable: true });
        search.element.dispatchEvent(slash);
        expect(typed.defaultPrevented).toBe(false);
        expect(slash.defaultPrevented).toBe(false);
        expect(document.activeElement).toBe(search.element);
        const comment = wrapper.get(COMMENT_BOX);
        const inComposer = new KeyboardEvent("keydown", { key: "k", bubbles: true, cancelable: true });
        comment.element.dispatchEvent(inComposer);
        expect(inComposer.defaultPrevented).toBe(false);
        expect(wrapper.get(".jira-detail-header h2").text()).toBe("First issue");
        await key(comment, "Escape");
        expect(wrapper.find(".jira-detail-header").exists()).toBe(true);
        await key(search, "Escape");
        expect(wrapper.find(".jira-detail-header").exists()).toBe(true);
        await key(wrapper.get(".jira-detail-header"), "Escape");
        expect(wrapper.find(".jira-detail-header").exists()).toBe(false);
        wrapper.unmount();
      });

      test("Escape during an IME composition never closes the detail", async () => {
        const wrapper = await mountWithTwoIssues();
        await openIssueRow(wrapper, 0);
        await wrapper.get(".jira-detail-header").trigger("keydown", { key: "Escape", isComposing: true });
        await flushPromises();
        expect(wrapper.find(".jira-detail-header").exists()).toBe(true);
        wrapper.unmount();
      });

      test("a slash focuses the quick search from the list but never takes the key outside the pane", async () => {
        const wrapper = await mountWithTwoIssues();
        const row = wrapper.findAll(".jira-issue")[0]!;
        (row.element as HTMLElement).focus();
        const inside = new KeyboardEvent("keydown", { key: "/", bubbles: true, cancelable: true });
        row.element.dispatchEvent(inside);
        await flushPromises();
        expect(inside.defaultPrevented).toBe(true);
        expect(document.activeElement).toBe(
          wrapper.get('input[aria-label="Search Jira by issue key or words"]').element,
        );

        const outside = document.createElement("div");
        outside.tabIndex = 0;
        document.body.appendChild(outside);
        outside.focus();
        const away = new KeyboardEvent("keydown", { key: "/", bubbles: true, cancelable: true });
        outside.dispatchEvent(away);
        const arrow = new KeyboardEvent("keydown", { key: "j", bubbles: true, cancelable: true });
        outside.dispatchEvent(arrow);
        const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
        outside.dispatchEvent(escape);
        expect(away.defaultPrevented).toBe(false);
        expect(arrow.defaultPrevented).toBe(false);
        expect(escape.defaultPrevented).toBe(false);
        expect(document.activeElement).toBe(outside);
        outside.remove();
        wrapper.unmount();
      });

      test("Escape on an action button closes the issue", async () => {
        const wrapper = await mountWithTwoIssues();
        await openIssueRow(wrapper, 0);
        const comment = wrapper.get(".jira-detail-header__actions a");
        await comment.trigger("focusin");
        await key(comment, "Escape");
        expect(wrapper.find(".jira-detail-header").exists()).toBe(false);
        wrapper.unmount();
      });

      test("on a board, arrows move within a column and between columns, and j/k step the open drawer", async () => {
        const card = (issueId: string, key: string, status: string, statusId: string) => ({
          ref: issueRef(issueId, key),
          summary: `Card ${key}`,
          status,
          statusId,
        });
        transport.getJiraBoardView.mockResolvedValue({
          boardId: 42,
          mode: "issues",
          columns: [
            { name: "To Do", statuses: [{ id: "1", name: "Open" }] },
            { name: "Doing", statuses: [{ id: "2", name: "In Progress" }] },
          ],
          issues: [
            card("1", "ENG-1", "Open", "1"),
            card("2", "ENG-2", "Open", "1"),
            card("3", "ENG-3", "In Progress", "2"),
            card("4", "ENG-4", "In Progress", "2"),
          ],
          hasMore: false,
        });
        transport.getJiraIssue.mockImplementation(async ({ issueId }: { issueId: string }) => ({
          ref: issueRef(issueId, `ENG-${issueId}`),
          summary: `Card ENG-${issueId}`,
          status: "Open",
        }));
        const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" }, attachTo: document.body });
        await flushPromises();
        await chooseCustomSelect(wrapper, ".jira-board-controls", 42);
        const cards = () => wrapper.findAll(".jira-board-issue");
        expect(cards().filter((item) => item.attributes("tabindex") === "0")).toHaveLength(1);
        (cards()[0]!.element as HTMLElement).focus();
        await key(cards()[0]!, "ArrowDown");
        expect(document.activeElement).toBe(cards()[1]!.element);
        await key(cards()[1]!, "ArrowRight");
        expect(document.activeElement).toBe(cards()[3]!.element);
        await key(cards()[3]!, "ArrowLeft");
        expect(document.activeElement).toBe(cards()[1]!.element);
        await key(cards()[1]!, "ArrowDown");
        expect(document.activeElement).toBe(cards()[1]!.element);
        await key(cards()[1]!, "ArrowRight");
        await key(cards()[3]!, "k");
        expect(document.activeElement).toBe(cards()[2]!.element);

        await key(cards()[2]!, "Enter");
        expect(wrapper.get(".jira-inbox").classes()).toContain("jira-inbox--board-drawer");
        expect(wrapper.get(".jira-board-drawer h2").text()).toBe("Card ENG-3");
        await key(cards()[2]!, "j");
        expect(wrapper.get(".jira-board-drawer h2").text()).toBe("Card ENG-4");
        expect(document.activeElement).toBe(cards()[3]!.element);
        await key(cards()[3]!, "Escape");
        expect(wrapper.find(".jira-board-drawer").exists()).toBe(false);
        expect(wrapper.findAll(".jira-board-column")).toHaveLength(2);
        expect(document.activeElement).toBe(cards()[3]!.element);
        wrapper.unmount();
      });
    });

    describe("expired sign-in and rate limits", () => {
      const cloudConnection = {
        id: "cloud-1",
        label: "Cloud site",
        deployment: "cloud",
        webUrl: "https://example.atlassian.net",
        auth: { kind: "cloud-api-token", email: "me@example.com" },
        status: "needs-login",
        verifiedIdentity: { displayName: "Alice" },
      };

      test("a connection that needs login shows one card and Sign in again opens its credentials form with the token focused", async () => {
        transport.listJiraConnections.mockResolvedValue([cloudConnection]);
        const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" }, attachTo: document.body });
        await flushPromises();
        const card = wrapper.get(".jira-sign-in-card");
        expect(card.get("h3").text()).toBe("Sign-in expired for Cloud site");
        expect(wrapper.get(".jira-inbox").classes()).toContain("jira-inbox--sign-in");
        expect(card.findAll("button").map((button) => button.text())).toEqual(["Sign in again", "Open Jira settings"]);
        await card.get(".jira-sign-in-card__primary").trigger("click");
        await flushPromises();
        expect(wrapper.get(".jira-inbox").classes()).toContain("jira-inbox--settings-view");
        expect(wrapper.find(".jira-sign-in-card").exists()).toBe(false);
        expect(wrapper.get(".jira-connection-edit-card__tab--active").text()).toBe("Connection");
        expect((wrapper.get(".jira-setup input[type=email]").element as HTMLInputElement).value).toBe("me@example.com");
        expect(document.activeElement).toBe(wrapper.get(".jira-setup input[type=password]").element);
        wrapper.unmount();
      });

      test("the sign-in failure is shown once, on the card, not as a second banner", async () => {
        answerFirstOpenSearch();
        transport.searchJiraIssues.mockRejectedValueOnce(desktopJiraFailure("Sign-in expired.", "auth-expired"));
        const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
        await flushPromises();
        await wrapper.find("form.jira-search").trigger("submit");
        await flushPromises();
        expect(wrapper.find(".jira-sign-in-card").exists()).toBe(true);
        expect(wrapper.find(".jira-error").exists()).toBe(false);
        wrapper.unmount();
      });

      test("Data Center sign-in again opens the credentials form with the token field focused", async () => {
        transport.listJiraConnections.mockResolvedValue([
          {
            id: "dc-1",
            label: "Jira DC",
            deployment: "data-center",
            webUrl: "https://jira.example.com",
            apiBaseUrl: "https://jira.example.com/jira",
            auth: { kind: "dc-pat" },
            status: "needs-login",
          },
        ]);
        const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" }, attachTo: document.body });
        await flushPromises();
        expect(wrapper.get(".jira-sign-in-card h3").text()).toBe("Sign-in expired for Jira DC");
        await wrapper.get(".jira-sign-in-card__primary").trigger("click");
        await flushPromises();
        expect(wrapper.get(".jira-inbox").classes()).toContain("jira-inbox--settings-view");
        expect(wrapper.find(".jira-sign-in-card").exists()).toBe(false);
        expect(wrapper.get(".jira-connection-edit-card__tab--active").text()).toBe("Connection");
        expect(document.activeElement).toBe(wrapper.get(".jira-setup input[type=password]").element);
        wrapper.unmount();
      });

      test("Open Jira settings goes to the pane's Settings view", async () => {
        transport.listJiraConnections.mockResolvedValue([cloudConnection]);
        const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
        await flushPromises();
        await wrapper.get(".jira-sign-in-card__settings").trigger("click");
        await flushPromises();
        expect(wrapper.get(".jira-view-tab--active").text()).toBe("Settings");
        expect(wrapper.find(".jira-sign-in-card").exists()).toBe(false);
        wrapper.unmount();
      });

      test("an auth-expired answer to a search turns into the same card", async () => {
        answerFirstOpenSearch();
        transport.searchJiraIssues.mockRejectedValueOnce(desktopJiraFailure("Token expired.", "auth-expired"));
        const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
        await flushPromises();
        expect(wrapper.find(".jira-sign-in-card").exists()).toBe(false);
        await wrapper.find("form.jira-search").trigger("submit");
        await flushPromises();
        expect(wrapper.get(".jira-sign-in-card h3").text()).toBe("Sign-in expired for Engineering");
        wrapper.unmount();
      });

      test("a rate limit counts down and retries once by itself, then waits for the user", async () => {
        answerFirstOpenSearch();
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
        transport.searchJiraIssues
          .mockRejectedValueOnce(desktopJiraFailure("Jira throttled this request.", "rate-limited", 2000))
          .mockRejectedValueOnce(desktopJiraFailure("Jira throttled this request.", "rate-limited", 2000));
        const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
        await flushPromises();
        await wrapper.find("form.jira-search").trigger("submit");
        await flushPromises();
        expect(wrapper.get(".jira-error__countdown").text()).toContain("Retrying automatically in 2 s");
        const callsAfterFailure = transport.searchJiraIssues.mock.calls.length;
        await vi.advanceTimersByTimeAsync(1000);
        expect(wrapper.get(".jira-error__countdown").text()).toMatch(/Retrying automatically in [12] s/);
        expect(transport.searchJiraIssues).toHaveBeenCalledTimes(callsAfterFailure);
        await vi.advanceTimersByTimeAsync(1500);
        await flushPromises();
        expect(transport.searchJiraIssues.mock.calls.length).toBe(callsAfterFailure + 1);
        expect(wrapper.get(".jira-error__countdown").text()).toContain("You can try again in");
        const callsAfterRetry = transport.searchJiraIssues.mock.calls.length;
        await vi.advanceTimersByTimeAsync(5000);
        await flushPromises();
        expect(transport.searchJiraIssues.mock.calls.length).toBe(callsAfterRetry);
        await wrapper
          .findAll(".jira-error button")
          .find((button) => button.text() === "Retry now")!
          .trigger("click");
        await flushPromises();
        expect(transport.searchJiraIssues.mock.calls.length).toBe(callsAfterRetry + 1);
        expect(wrapper.find(".jira-error").exists()).toBe(false);
        wrapper.unmount();
      });
    });

    describe("disconnecting", () => {
      test("the confirmation names what else goes and counts the pinned board workspaces that close", async () => {
        const board = (id: string, connectionId: string, profileId = "default") => ({
          id,
          name: id,
          kind: "jira-board",
          profileId,
          jiraBoard: { parentWorkspaceId: "jira:ws", connectionId, boardId: "1", boardName: id },
        });
        mockStoreState.payload = reactive({
          appState: {
            activeProfileId: "default",
            workspaces: [
              { id: "jira:ws", name: "Jira inbox", kind: "jira", profileId: "default" },
              board("board-a", "jira-1"),
              board("board-b", "jira-1"),
              board("board-other-connection", "jira-2"),
              board("board-other-profile", "jira-1", "other"),
            ],
          },
        });
        const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
        await flushPromises();
        await wrapper
          .findAll(".jira-view-tab")
          .find((tab) => tab.text() === "Settings")!
          .trigger("click");
        await wrapper
          .findAll("button")
          .find((button) => button.text() === "Disconnect")!
          .trigger("click");
        await flushPromises();
        const confirmation = transport.confirmInApp.mock.calls.at(-1)![0] as { message: string; confirmLabel: string };
        expect(confirmation.confirmLabel).toBe("Disconnect");
        expect(confirmation.message).toContain("Engineering");
        expect(confirmation.message).toContain("saved views, polling watches and saved repository targets");
        expect(confirmation.message).toContain("2 pinned board workspaces will close");
        expect(confirmation.message).toContain("Nothing in Jira itself is deleted");
        expect(transport.deleteJiraConnection).toHaveBeenCalledWith("jira-1");
        wrapper.unmount();
      });

      test("with no pinned boards the confirmation says so, and Cancel deletes nothing", async () => {
        transport.confirmInApp.mockResolvedValueOnce(false);
        const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
        await flushPromises();
        await wrapper
          .findAll(".jira-view-tab")
          .find((tab) => tab.text() === "Settings")!
          .trigger("click");
        await wrapper
          .findAll("button")
          .find((button) => button.text() === "Disconnect")!
          .trigger("click");
        await flushPromises();
        const confirmation = transport.confirmInApp.mock.calls.at(-1)![0] as { message: string };
        expect(confirmation.message).toContain("No pinned board workspaces are open for it");
        expect(transport.deleteJiraConnection).not.toHaveBeenCalled();
        wrapper.unmount();
      });
    });
  });

  describe("review follow-ups", () => {
    const issueRef = (issueId: string, issueKey: string) => ({
      provider: "jira" as const,
      connectionId: "jira-1",
      issueId,
      issueKey,
    });
    function twoIssues() {
      transport.searchJiraIssues.mockResolvedValue([
        { ref: issueRef("1001", "ENG-1"), summary: "First issue", status: "Open" },
        { ref: issueRef("1002", "ENG-2"), summary: "Second issue", status: "Open" },
      ]);
      transport.getJiraIssue.mockImplementation(async ({ issueId }: { issueId: string }) => ({
        ref: issueRef(issueId, issueId === "1001" ? "ENG-1" : "ENG-2"),
        summary: issueId === "1001" ? "First issue" : "Second issue",
        status: "Open",
        description: "",
        attachments: [],
      }));
    }
    async function mountWithTwoIssues() {
      twoIssues();
      const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" }, attachTo: document.body });
      await flushPromises();
      await wrapper.find("form.jira-search").trigger("submit");
      await flushPromises();
      return wrapper;
    }
    async function openIssueRow(wrapper: ReturnType<typeof mount>, index: number) {
      await wrapper.findAll(".jira-issue")[index]!.trigger("click");
      await flushPromises();
    }

    test("Load more is usable again when a new search starts while it was loading", async () => {
      answerFirstOpenSearch();
      const first = {
        issues: [{ ref: issueRef("1", "ENG-1"), summary: "First" }],
        hasMore: true,
        nextCursor: "cursor-1",
      };
      transport.searchJiraIssues.mockResolvedValueOnce(first);
      const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
      await flushPromises();
      await wrapper.find("form.jira-search").trigger("submit");
      await flushPromises();
      let finishMore!: (value: unknown) => void;
      transport.searchJiraIssues.mockImplementationOnce(() => new Promise((resolve) => (finishMore = resolve)));
      const loadMoreButton = () =>
        wrapper.findAll(".jira-results button").find((button) => button.text().includes("Load more"))!;
      await loadMoreButton().trigger("click");
      expect(loadMoreButton().attributes("aria-busy")).toBe("true");
      transport.searchJiraIssues.mockResolvedValueOnce({ ...first, nextCursor: "cursor-2" });
      await wrapper.find("form.jira-search").trigger("submit");
      await flushPromises();
      finishMore({ issues: [], hasMore: false });
      await flushPromises();
      expect(loadMoreButton().attributes("aria-busy")).toBeUndefined();
      expect(wrapper.text()).not.toContain("Searching Jira issues");
      transport.searchJiraIssues.mockResolvedValueOnce({ issues: [], hasMore: false });
      await loadMoreButton().trigger("click");
      await flushPromises();
      expect(transport.searchJiraIssues).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "cursor-2" }));
    });

    test("a double submit of the connection setup saves one connection", async () => {
      let finishSave!: (value: unknown) => void;
      transport.saveJiraConnection.mockImplementationOnce(() => new Promise((resolve) => (finishSave = resolve)));
      const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" }, attachTo: document.body });
      await flushPromises();
      await openSettingsView(wrapper);
      await wrapper.get(".jira-settings-manager__heading button").trigger("click");
      await flushPromises();
      await chooseCustomSelect(wrapper, ".jira-setup", "pat");
      await wrapper.get(".jira-setup__actions button:not(.button--ghost)").trigger("click");
      await flushPromises();
      const formFields = wrapper.findAll(".jira-setup input");
      await formFields[0].setValue("https://new.example");
      await formFields[1].setValue("https://new.example/jira");
      await formFields[2].setValue("pat");
      const save = wrapper.get(".jira-setup__actions button:not(.button--ghost)");
      await save.trigger("click");
      await save.trigger("click");
      expect(transport.saveJiraConnection).toHaveBeenCalledTimes(1);
      finishSave({ id: "jira-new" });
      await flushPromises();
      wrapper.unmount();
    });

    test("an unsent comment survives a search that clears the open issue", async () => {
      const wrapper = await mountWithTwoIssues();
      await openIssueRow(wrapper, 0);
      await wrapper.get(COMMENT_BOX).setValue("Do not lose me");
      await wrapper.find("form.jira-search").trigger("submit");
      await flushPromises();
      await openIssueRow(wrapper, 0);
      expect((wrapper.get(COMMENT_BOX).element as HTMLTextAreaElement).value).toBe("Do not lose me");
    });

    test("the comment composer names the account the comment posts as", async () => {
      const wrapper = await mountWithTwoIssues();
      await openIssueRow(wrapper, 0);
      await wrapper.get(COMMENT_BOX).setValue("Hello");
      expect(wrapper.get(".jira-comment-composer .jira-help").text()).toContain("Build Bot");
    });

    test("a failing favorite filter launched from Views reports in the pane banner, not inside the menu", async () => {
      transport.listJiraFavoriteFilters.mockResolvedValue([{ id: "f1", name: "Mine" }]);
      transport.getJiraSavedFilter.mockRejectedValue(new Error("Jira is down"));
      const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" }, attachTo: document.body });
      await flushPromises();
      await wrapper.get(".jira-views-menu > summary").trigger("click");
      await wrapper
        .findAll(".jira-views-menu [role=menuitem]")
        .find((item) => item.text().includes("Mine"))!
        .trigger("click");
      await flushPromises();
      expect(wrapper.get(".jira-error-banner, [role=alert]").text()).toContain("favorite filter");
      expect(wrapper.find(".jira-views-menu .jira-inline-error").exists()).toBe(false);
    });

    test("the worklog form starts at the local time of day, not UTC", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-03-01T23:30:00Z"));
      vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(-120);
      try {
        const wrapper = await mountWithTwoIssues();
        await openIssueRow(wrapper, 0);
        const details = wrapper.get(".jira-write-details");
        (details.element as HTMLDetailsElement).open = true;
        await wrapper
          .findAll(".jira-extra-actions [role=menuitem]")
          .find((item) => item.text() === "Log work…")
          ?.trigger("click");
        await flushPromises();
        const started = wrapper.get('.jira-write input[type="datetime-local"]');
        expect((started.element as HTMLInputElement).value).toBe("2026-03-02T01:30");
      } finally {
        vi.restoreAllMocks();
      }
    });

    test("the sidebar can open an issue in a saved board tab of this workspace", async () => {
      mockStoreState.transportApi = transport;
      mockStoreState.payload = reactive({
        appState: {
          activeProfileId: "default",
          workspaces: [{ id: "jira:ws", name: "Jira inbox", kind: "jira", profileId: "default" }],
        },
      });
      const savedView = {
        viewId: "saved-board-42",
        kind: "board" as const,
        connectionId: "jira-1",
        boardId: 42,
        boardName: "Engineering board",
        title: "Engineering board",
        mode: "issues" as const,
        sprintId: null,
        quickFilterIds: [],
        assignee: null,
        doneWithinDays: 14 as const,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      const state = {
        workspaceId: "jira:ws",
        profileId: "default",
        views: [{ viewId: "issues", kind: "issues", title: "Issues" }, savedView],
        activeViewId: savedView.viewId,
        syncByViewId: {},
      };
      transport.getJiraWorkspaceViews.mockResolvedValue(state);
      transport.setJiraWorkspaceActiveView.mockResolvedValue(state);
      transport.refreshJiraWorkspaceViews.mockResolvedValue(state);
      transport.getJiraBoardView.mockResolvedValue({
        issues: [{ ref: issueRef("1001", "ENG-1"), summary: "Cached issue", status: "Open", statusId: "1" }],
        columns: [{ name: "To Do", statuses: [{ id: "1", name: "Open" }] }],
        cache: { source: "cache", fetchedAt: Date.now(), stale: false },
      });
      mockStoreState.jiraIssueOpenRequest = {
        workspaceId: "jira:ws",
        ref: { connectionId: "jira-1", issueId: "1001", issueKey: "ENG-1" },
        sequence: 1,
      };
      const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws", jiraViewId: savedView.viewId } });
      await flushPromises();
      expect(transport.getJiraIssue).toHaveBeenCalledWith(
        expect.objectContaining({ connectionId: "jira-1", issueId: "1001" }),
      );
      expect(mockStoreState.jiraIssueOpenRequest).toBeNull();
    });

    test("Start development reopened on another issue gets that issue's branch, and never keeps the previous one", async () => {
      const wrapper = await mountWithTwoIssues();
      const openTaskDetails = async () => {
        await wrapper
          .get(".jira-detail-header__actions")
          .findAll("button")
          .find((button) => button.text() === "Start development")!
          .trigger("click");
        await flushPromises();
      };
      const branch = () => (branchPanel(wrapper).get(".jira-branch-name input").element as HTMLInputElement).value;
      await openIssueRow(wrapper, 0);
      await openTaskDetails();
      expect(branch()).toContain("ENG-1");
      await openIssueRow(wrapper, 1);
      await openTaskDetails();
      expect(branch()).toContain("ENG-2");
      expect(branch()).not.toContain("ENG-1");
    });

    test("the identity form for Assign to me is shown at the pane level, wherever the issue is open", async () => {
      transport.listJiraConnections.mockResolvedValue([
        {
          id: "jira-1",
          label: "Engineering",
          deployment: "data-center",
          webUrl: "https://jira.example.com",
          apiBaseUrl: "https://jira.example.com/jira",
          accountPurpose: "technical",
          verifiedIdentity: { displayName: "Build Bot" },
        },
      ]);
      const wrapper = await mountWithTwoIssues();
      await openIssueRow(wrapper, 0);
      await wrapper.get(".jira-assign-menu > summary").trigger("click");
      await wrapper
        .findAll(".jira-assign-menu [role=menuitem]")
        .find((item) => item.text().includes("Assign to me"))!
        .trigger("click");
      await flushPromises();
      expect(wrapper.find(".jira-inbox > .jira-human-identity-setup").exists()).toBe(true);
    });
  });

  describe("final review fixes", () => {
    const issueRef = (issueId: string, issueKey: string) => ({
      provider: "jira" as const,
      connectionId: "jira-1",
      issueId,
      issueKey,
    });
    const issueDetail = (issueId: string) => ({
      ref: issueRef(issueId, issueId === "1001" ? "ENG-1" : "ENG-2"),
      summary: issueId === "1001" ? "First issue" : "Second issue",
      status: "Open",
      description: "",
      attachments: [],
    });
    function twoIssues() {
      transport.searchJiraIssues.mockResolvedValue([
        { ref: issueRef("1001", "ENG-1"), summary: "First issue", status: "Open" },
        { ref: issueRef("1002", "ENG-2"), summary: "Second issue", status: "Open" },
      ]);
      transport.getJiraIssue.mockImplementation(async ({ issueId }: { issueId: string }) => issueDetail(issueId));
    }
    async function mountWithTwoIssues(workspaceId = "jira:ws") {
      twoIssues();
      const wrapper = mount(JiraInboxPane, { props: { workspaceId }, attachTo: document.body });
      await flushPromises();
      await wrapper.find("form.jira-search").trigger("submit");
      await flushPromises();
      return wrapper;
    }
    async function openIssueRow(wrapper: ReturnType<typeof mount>, index: number) {
      await wrapper.findAll(".jira-issue")[index]!.trigger("click");
      await flushPromises();
    }
    const commentValue = (wrapper: ReturnType<typeof mount>) =>
      (wrapper.get(COMMENT_BOX).element as HTMLTextAreaElement).value;
    const sentOk = { ok: true, data: { status: "succeeded", journalId: "write-1" } };
    const agentDraft = (issueKey = "ENG-1", issueId = "1001", connectionId = "jira-1") => ({
      id: "draft-1",
      ref: { provider: "jira", connectionId, issueId, issueKey },
      body: "Please add a regression test.",
      sourceWorkspaceId: "ws-1",
      createdAt: "today",
    });
    const useDraftButton = (wrapper: ReturnType<typeof mount>) =>
      wrapper.get(".jira-mcp-drafts__actions .button--ghost");
    const twoConnections = () => [
      {
        id: "jira-1",
        label: "Engineering",
        deployment: "data-center",
        webUrl: "https://jira.example.com",
        apiBaseUrl: "https://jira.example.com/jira",
        accountPurpose: "technical",
        verifiedIdentity: { displayName: "Build Bot" },
        ownIdentity: { kind: "data-center", name: "alice", displayName: "Alice" },
      },
      {
        id: "jira-2",
        label: "Operations",
        deployment: "data-center",
        webUrl: "https://ops.example.com",
        apiBaseUrl: "https://ops.example.com/jira",
        accountPurpose: "technical",
        verifiedIdentity: { displayName: "Build Bot" },
      },
    ];

    test("a comment that succeeds while the next issue is still loading clears the composer of the issue on screen", async () => {
      const wrapper = await mountWithTwoIssues();
      let finishWrite!: (value: unknown) => void;
      transport.executeJiraWrite.mockImplementationOnce(() => new Promise((resolve) => (finishWrite = resolve)));
      await openIssueRow(wrapper, 0);
      await sendComment(wrapper, "Posted text");
      let releaseSecond!: (value: unknown) => void;
      const secondIssue = new Promise((resolve) => (releaseSecond = resolve));
      transport.getJiraIssue.mockImplementation(
        async ({ issueId, cacheOnly }: { issueId: string; cacheOnly?: boolean }) => {
          if (issueId !== "1002") return issueDetail(issueId);
          return cacheOnly ? null : secondIssue;
        },
      );
      await openIssueRow(wrapper, 1);
      finishWrite(sentOk);
      await flushPromises();
      expect(commentValue(wrapper)).toBe("");
      expect(wrapper.get(".jira-comment-composer__done").text()).toContain("Comment added to ENG-1.");
      releaseSecond(issueDetail("1002"));
      await flushPromises();
      await openIssueRow(wrapper, 0);
      expect(commentValue(wrapper)).toBe("");
    });

    test("a comment that succeeds after its own issue was opened again is not left as an unsent draft", async () => {
      const wrapper = await mountWithTwoIssues();
      let finishWrite!: (value: unknown) => void;
      transport.executeJiraWrite.mockImplementationOnce(() => new Promise((resolve) => (finishWrite = resolve)));
      await openIssueRow(wrapper, 0);
      await sendComment(wrapper, "Posted text");
      await openIssueRow(wrapper, 0);
      finishWrite(sentOk);
      await flushPromises();
      expect(commentValue(wrapper)).toBe("");
      expect(wrapper.get(".jira-comment-composer__done").text()).toContain("Comment added to ENG-1.");
    });

    test("a comment that succeeds after another issue was opened drops the draft saved for it", async () => {
      const wrapper = await mountWithTwoIssues();
      let finishWrite!: (value: unknown) => void;
      transport.executeJiraWrite.mockImplementationOnce(() => new Promise((resolve) => (finishWrite = resolve)));
      await openIssueRow(wrapper, 0);
      await sendComment(wrapper, "Posted text");
      await openIssueRow(wrapper, 1);
      finishWrite(sentOk);
      await flushPromises();
      await openIssueRow(wrapper, 0);
      expect(commentValue(wrapper)).toBe("");
    });

    test("scrolling inside an open menu keeps it open, scrolling the page closes it", async () => {
      const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" }, attachTo: document.body });
      await flushPromises();
      await wrapper.get(".jira-views-menu > summary").trigger("click");
      const menu = wrapper.get(".jira-views-menu").element as HTMLDetailsElement;
      expect(menu.open).toBe(true);
      wrapper.get(".jira-views-menu__panel").element.dispatchEvent(new Event("scroll"));
      expect(menu.open).toBe(true);
      document.dispatchEvent(new Event("scroll"));
      expect(menu.open).toBe(false);
    });

    test("a write started before a connection switch keeps blocking a second one", async () => {
      transport.listJiraConnections.mockResolvedValue(twoConnections());
      const wrapper = await mountWithTwoIssues();
      let finishWrite!: (value: unknown) => void;
      transport.executeJiraWrite.mockImplementationOnce(() => new Promise((resolve) => (finishWrite = resolve)));
      await openIssueRow(wrapper, 0);
      await sendComment(wrapper, "First comment");
      await chooseCustomSelect(wrapper, ".jira-head__connection", "jira-2");
      await chooseCustomSelect(wrapper, ".jira-head__connection", "jira-1");
      await wrapper.find("form.jira-search").trigger("submit");
      await flushPromises();
      await openIssueRow(wrapper, 0);
      await sendComment(wrapper, "Second comment");
      expect(transport.executeJiraWrite).toHaveBeenCalledTimes(1);
      finishWrite(sentOk);
      await flushPromises();
    });

    test("Use draft for an issue of another connection switches the pane to that connection first", async () => {
      transport.listJiraConnections.mockResolvedValue(twoConnections());
      transport.listJiraCommentDrafts.mockResolvedValueOnce([agentDraft("OPS-5", "5001", "jira-2")]);
      transport.getJiraIssue.mockImplementation(async ({ issueId }: { issueId: string }) => ({
        ref: { provider: "jira", connectionId: "jira-2", issueId, issueKey: "OPS-5" },
        summary: "Ops issue",
        status: "Open",
        attachments: [],
      }));
      const wrapper = mount(JiraInboxPane, { props: { workspaceId: "ws-1" }, attachTo: document.body });
      await flushPromises();
      transport.searchJiraIssues.mockClear();
      await useDraftButton(wrapper).trigger("click");
      await flushPromises();
      expect(transport.searchJiraIssues).toHaveBeenCalledWith(expect.objectContaining({ connectionId: "jira-2" }));
      expect(commentValue(wrapper)).toBe("Please add a regression test.");
    });

    describe("agent drafts", () => {
      test("a sent agent draft is removed from the list of drafts that were not sent", async () => {
        transport.listJiraCommentDrafts.mockResolvedValueOnce([agentDraft()]);
        const wrapper = mount(JiraInboxPane, { props: { workspaceId: "ws-1" }, attachTo: document.body });
        await flushPromises();
        await useDraftButton(wrapper).trigger("click");
        await flushPromises();
        await wrapper.get(".jira-comment-composer .jira-confirm").findAll("button")[0]!.trigger("click");
        await flushPromises();
        expect(transport.executeJiraWrite).toHaveBeenCalledOnce();
        expect(transport.deleteJiraCommentDraft).toHaveBeenCalledWith({
          sourceWorkspaceId: "ws-1",
          draftId: "draft-1",
        });
        expect(wrapper.text()).not.toContain("Agent comment drafts");
      });

      test("Ctrl+Enter during the draft review does not skip Confirm and send", async () => {
        transport.listJiraCommentDrafts.mockResolvedValueOnce([agentDraft()]);
        const wrapper = mount(JiraInboxPane, { props: { workspaceId: "ws-1" }, attachTo: document.body });
        await flushPromises();
        await useDraftButton(wrapper).trigger("click");
        await flushPromises();
        expect(wrapper.find(".jira-comment-composer .jira-confirm").exists()).toBe(true);
        await wrapper.get(".jira-comment-composer").trigger("submit");
        await flushPromises();
        expect(transport.previewJiraWrite).toHaveBeenCalledTimes(1);
        expect(transport.executeJiraWrite).not.toHaveBeenCalled();
      });

      test("Use draft asks before it replaces the comment the user has typed", async () => {
        transport.listJiraCommentDrafts.mockResolvedValueOnce([agentDraft()]);
        const wrapper = await mountWithTwoIssues("ws-1");
        await openIssueRow(wrapper, 0);
        await wrapper.get(COMMENT_BOX).setValue("My own words");
        transport.confirmInApp.mockResolvedValueOnce(false);
        await useDraftButton(wrapper).trigger("click");
        await flushPromises();
        expect(transport.confirmInApp).toHaveBeenCalledWith(
          expect.objectContaining({ title: "Replace your unsent comment?" }),
        );
        expect(commentValue(wrapper)).toBe("My own words");
        expect(transport.previewJiraWrite).not.toHaveBeenCalled();
        transport.confirmInApp.mockResolvedValueOnce(true);
        await useDraftButton(wrapper).trigger("click");
        await flushPromises();
        expect(commentValue(wrapper)).toBe("Please add a regression test.");
      });
    });

    describe("a previewed write is sent as previewed", () => {
      async function openWorklogForm(wrapper: ReturnType<typeof mount>) {
        await wrapper
          .get(".jira-detail-header__actions > details:last-child")
          .findAll("[role=menuitem]")
          .find((item) => item.text() === "Log work…")!
          .trigger("click");
        await flushPromises();
      }
      const review = (wrapper: ReturnType<typeof mount>) =>
        wrapper.findAll(".jira-write button").find((button) => button.text().startsWith("Review"))!;

      test("editing a previewed field goes back to Review and sends nothing", async () => {
        const wrapper = await mountWithTwoIssues();
        await openIssueRow(wrapper, 0);
        await openWorklogForm(wrapper);
        await wrapper.get('.jira-write input[placeholder="1h 30m"]').setValue("30m");
        await review(wrapper).trigger("click");
        await flushPromises();
        expect(wrapper.find(".jira-write .jira-confirm").exists()).toBe(true);
        await wrapper.get('.jira-write input[placeholder="1h 30m"]').setValue("2h");
        await flushPromises();
        expect(wrapper.find(".jira-write .jira-confirm").exists()).toBe(false);
        expect(transport.executeJiraWrite).not.toHaveBeenCalled();
        await review(wrapper).trigger("click");
        await flushPromises();
        await wrapper.get(".jira-write .jira-confirm button").trigger("click");
        await flushPromises();
        expect(transport.previewJiraWrite).toHaveBeenLastCalledWith(
          expect.objectContaining({ action: "worklog", seconds: 7200 }),
        );
        expect(transport.executeJiraWrite).toHaveBeenCalledOnce();
        expect(transport.executeJiraWrite).toHaveBeenCalledWith(
          expect.objectContaining({ action: "worklog", seconds: 7200 }),
        );
        expectEveryCallToMatch(jiraWriteExecuteSchema, transport.executeJiraWrite);
      });
    });

    test("a card opened and replaced by a board filter does not leave Loading issue details running", async () => {
      transport.listJiraBoardQuickFilters.mockResolvedValue({
        filters: [{ id: 6, name: "My team", description: "", jql: "assignee is not EMPTY", position: 0 }],
        hasMore: false,
      });
      const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" }, attachTo: document.body });
      await flushPromises();
      await showBoardView(wrapper);
      await chooseCustomSelect(wrapper, ".jira-board-controls", 42);
      await flushPromises();
      transport.getJiraIssue.mockImplementationOnce(() => new Promise(() => {}));
      await wrapper.get(".jira-board-issue").trigger("click");
      await flushPromises();
      await wrapper.get(".jira-board-filter-chip").trigger("click");
      await flushPromises();
      expect(wrapper.get(".jira-head__refresh").attributes("aria-busy")).toBeUndefined();
      expect(wrapper.text()).not.toContain("Loading issue details");
    });

    test("a refresh the runtime rejects is also shown in the status strip", async () => {
      mockStoreState.transportApi = transport;
      const view = {
        viewId: "view-board",
        kind: "board",
        connectionId: "jira-1",
        boardId: 42,
        boardName: "Engineering board",
        title: "Engineering board",
        mode: "issues",
        sprintId: null,
        quickFilterIds: [],
        assignee: null,
        doneWithinDays: null,
        createdAt: 1,
        updatedAt: 1,
      };
      transport.getJiraWorkspaceViews.mockResolvedValue({
        workspaceId: "jira:ws",
        profileId: "default",
        views: [{ viewId: "issues", kind: "issues", title: "Issues" }, view],
        activeViewId: "view-board",
        syncByViewId: {},
      });
      transport.refreshJiraWorkspaceViews.mockRejectedValue(new Error("Sync engine stopped"));
      const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws", jiraViewId: "view-board" } });
      await flushPromises();
      await wrapper.get(".jira-head__refresh").trigger("click");
      await flushPromises();
      const failure = wrapper.get(".jira-head__sync .jira-head__sync-status");
      expect(failure.attributes("role")).toBe("alert");
      expect(failure.text()).toContain("Sync engine stopped");
      expect(failure.get("button").text()).toBe("Retry");
      expect(wrapper.get(".jira-head__sync").classes()).toContain("jira-head__sync--error");
      expect(wrapper.find(".jira-status-strip").exists()).toBe(false);
      transport.refreshJiraWorkspaceViews.mockClear();
      await failure.get("button").trigger("click");
      await flushPromises();
      expect(transport.refreshJiraWorkspaceViews).toHaveBeenCalled();
    });

    describe("uploading an attachment", () => {
      async function openAndUpload(wrapper: ReturnType<typeof mount>) {
        await wrapper.find("form.jira-search").trigger("submit");
        await flushPromises();
        await wrapper.find(".jira-issue").trigger("click");
        await flushPromises();
        const moreActions = wrapper.get(".jira-detail-header__actions > details:last-child");
        await moreActions.get("summary").trigger("click");
        await moreActions
          .findAll("[role=menuitem]")
          .find((item) => item.text() === "Add attachment")!
          .trigger("click");
        await flushPromises();
      }

      test("an upload whose outcome is unknown offers Reconcile and says not to upload again", async () => {
        transport.uploadJiraIssueAttachment.mockResolvedValueOnce({
          ok: false,
          error: {
            code: "jira-write-unknown",
            message: "Jira may have accepted this file.",
            status: "unknown",
            journalId: "journal-up",
          },
        });
        const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" }, attachTo: document.body });
        await flushPromises();
        await openAndUpload(wrapper);
        expect(wrapper.get(".jira-write-reconcile").text()).toContain("journal-up");
        expect(wrapper.find('[aria-label="Reconcile Jira write outcome"] button').exists()).toBe(true);
        expect(wrapper.get(".jira-detail .jira-inline-error").text()).toContain("Jira may have accepted this file.");
      });

      test("an accepted upload with an unknown status also offers Reconcile", async () => {
        transport.uploadJiraIssueAttachment.mockResolvedValueOnce({
          ok: true,
          data: { status: "unknown", journalId: "journal-up2" },
        });
        const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" }, attachTo: document.body });
        await flushPromises();
        await openAndUpload(wrapper);
        expect(wrapper.get(".jira-write-reconcile").text()).toContain("journal-up2");
        expect(wrapper.find(".jira-upload-status").exists()).toBe(false);
      });

      test("cancelling the file dialog reports nothing", async () => {
        transport.uploadJiraIssueAttachment.mockResolvedValueOnce({ ok: true, cancelled: true });
        const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" }, attachTo: document.body });
        await flushPromises();
        await openAndUpload(wrapper);
        expect(wrapper.find(".jira-upload-status").exists()).toBe(false);
        expect(wrapper.find(".jira-detail .jira-inline-error").exists()).toBe(false);
        expect(wrapper.find(".jira-write-reconcile").exists()).toBe(false);
      });
    });

    describe("the error banner", () => {
      test("Retry now keeps the focus in the pane and the countdown stays outside the alert", async () => {
        answerFirstOpenSearch();
        transport.searchJiraIssues.mockRejectedValueOnce(desktopJiraFailure("Throttled.", "rate-limited", 30_000));
        const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" }, attachTo: document.body });
        await flushPromises();
        await wrapper.find("form.jira-search").trigger("submit");
        await flushPromises();
        expect(wrapper.find('[role="alert"] .jira-error__countdown').exists()).toBe(false);
        expect(wrapper.get(".jira-error__countdown").attributes("aria-live")).toBe("off");
        expect(wrapper.get('[role="alert"]').text()).not.toContain("Retry after");
        const retry = wrapper.findAll(".jira-error button").find((button) => button.text() === "Retry now")!;
        (retry.element as HTMLElement).focus();
        await retry.trigger("click");
        await flushPromises();
        expect(wrapper.find(".jira-error").exists()).toBe(false);
        expect(wrapper.element.contains(document.activeElement)).toBe(true);
      });

      test("the banner takes no room in the page flow and can be dismissed", async () => {
        answerFirstOpenSearch();
        transport.searchJiraIssues.mockRejectedValueOnce(new Error("Plain failure"));
        const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" }, attachTo: document.body });
        await flushPromises();
        await wrapper.find("form.jira-search").trigger("submit");
        await flushPromises();
        expect(wrapper.find(".jira-error > .jira-error__panel").exists()).toBe(true);
        await wrapper
          .findAll(".jira-error button")
          .find((button) => button.text() === "Dismiss")!
          .trigger("click");
        await flushPromises();
        expect(wrapper.find(".jira-error").exists()).toBe(false);
        expect(wrapper.element.contains(document.activeElement)).toBe(true);
      });
    });

    describe("layout that stays put", () => {
      test("the reason and the posting identity are in the DOM before the first keystroke, only inert", async () => {
        const wrapper = await mountWithTwoIssues();
        await openIssueRow(wrapper, 0);
        const meta = wrapper.get(".jira-comment-composer__meta");
        expect(meta.find(".jira-reason").exists()).toBe(true);
        expect(meta.find(".jira-help").exists()).toBe(true);
        expect(meta.attributes("inert")).toBeDefined();
        await wrapper.get(COMMENT_BOX).setValue("Typing now");
        expect(wrapper.get(".jira-comment-composer__meta").attributes("inert")).toBeUndefined();
      });

      test("the result columns keep their grid while the first search is loading", async () => {
        let finishSearch!: (issues: unknown[]) => void;
        transport.searchJiraIssues.mockImplementationOnce(() => new Promise((resolve) => (finishSearch = resolve)));
        const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" }, attachTo: document.body });
        await flushPromises();
        expect(wrapper.get(".jira-columns").classes()).not.toContain("jira-columns--empty");
        finishSearch([{ ref: issueRef("1001", "ENG-1"), summary: "First issue" }]);
        await flushPromises();
        expect(wrapper.get(".jira-columns").classes()).not.toContain("jira-columns--empty");
      });

      test("a quick-search error is rendered with its own class", async () => {
        const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" }, attachTo: document.body });
        await flushPromises();
        await wrapper.get('input[aria-label="Search Jira by issue key or words"]').setValue("!!!");
        await wrapper.get("form.jira-quick-search").trigger("submit");
        await flushPromises();
        expect(wrapper.get(".jira-quick-search__error").text()).toContain("at least one word");
      });
    });

    test("Refresh re-runs the active search under its own kind and label without recording a recent search", async () => {
      const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" }, attachTo: document.body });
      await flushPromises();
      await wrapper.get('input[aria-label="Search Jira by issue key or words"]').setValue("login flow");
      await wrapper.get("form.jira-quick-search").trigger("submit");
      await flushPromises();
      expect(transport.rememberJiraSearch).toHaveBeenCalledTimes(1);
      await wrapper.get(".jira-head__refresh").trigger("click");
      await flushPromises();
      expect(transport.rememberJiraSearch).toHaveBeenCalledTimes(1);
      const saved = readJiraViewPreferences("default", "jira:ws", localStorage).lastSearch;
      expect(saved?.kind).toBe("quick-search");
      expect(saved?.label).toBe("login flow");
    });

    test("people filter the board from its toolbar, one click to narrow and one to reset", async () => {
      const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" }, attachTo: document.body });
      await flushPromises();
      await showBoardView(wrapper);
      await chooseCustomSelect(wrapper, ".jira-board-controls", 42);
      await flushPromises();
      expect(wrapper.find(".jira-board-filter-details .jira-project-scope-picker").exists()).toBe(false);
      const unassigned = () => wrapper.get(".jira-board-people [aria-label='Unassigned']");
      expect(unassigned().attributes("title")).toBe("Show only issues with no assignee.");
      await unassigned().trigger("click");
      await flushPromises();
      expect(unassigned().attributes("aria-pressed")).toBe("true");
      expect(transport.getJiraBoardView).toHaveBeenLastCalledWith(
        expect.objectContaining({ boardId: 42, assignee: { kind: "unassigned" } }),
      );
      await unassigned().trigger("click");
      await flushPromises();
      expect(unassigned().attributes("aria-pressed")).toBe("false");
      expect(transport.getJiraBoardView.mock.lastCall?.[0]).not.toHaveProperty("assignee");
      expect((wrapper.get(".jira-board-filter-details").element as HTMLDetailsElement).open).toBe(false);
      wrapper.unmount();
    });
  });
  describe("Issues smart filters and result facets", () => {
    const chip = (wrapper: ReturnType<typeof mount>, label: string) =>
      wrapper.findAll(".jira-smart-chip").find((candidate) => candidate.text() === label)!;
    const pressed = (wrapper: ReturnType<typeof mount>) =>
      wrapper
        .findAll(".jira-smart-chip")
        .filter((candidate) => candidate.attributes("aria-pressed") === "true")
        .map((candidate) => candidate.text());
    const lastBuild = () => transport.buildJiraOwnIssuesQuery.mock.lastCall?.[0];
    function smartQueries() {
      transport.buildJiraOwnIssuesQuery.mockImplementation(async (payload: { smartFilters?: string[] }) => ({
        jql: payload.smartFilters ? `smart(${payload.smartFilters.join(",")})` : 'assignee = "alice"',
        identityLabel: "Alice",
      }));
    }

    test("opening the pane runs the default search at once and does not record it as a recent search", async () => {
      const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
      await flushPromises();
      expect(transport.buildJiraOwnIssuesQuery).toHaveBeenCalledWith({
        connectionId: "jira-1",
        baseJql: "statusCategory != Done",
      });
      expect(transport.searchJiraIssues).toHaveBeenCalledWith(
        expect.objectContaining({ jql: 'assignee = "alice" ORDER BY updated DESC' }),
      );
      expect(wrapper.find(".jira-issue").text()).toContain("ENG-1");
      expect(transport.rememberJiraSearch).not.toHaveBeenCalled();
      expect(pressed(wrapper)).toEqual([]);
    });

    test("chips combine across groups, replace within a group and clear on a second click", async () => {
      smartQueries();
      const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
      await flushPromises();
      await chip(wrapper, "Assigned to me").trigger("click");
      await flushPromises();
      expect(lastBuild()).toEqual({ connectionId: "jira-1", smartFilters: ["assigned-to-me"] });
      expect(jiraOwnIssuesQuerySchema.safeParse(lastBuild()).success).toBe(true);
      expect(transport.searchJiraIssues).toHaveBeenLastCalledWith(
        expect.objectContaining({ jql: "smart(assigned-to-me)" }),
      );
      expect(transport.rememberJiraSearch).toHaveBeenLastCalledWith(
        expect.objectContaining({ jql: "smart(assigned-to-me)", label: "Assigned to me" }),
      );
      expect(pressed(wrapper)).toEqual(["Assigned to me"]);

      await chip(wrapper, "Open").trigger("click");
      await flushPromises();
      expect(lastBuild()?.smartFilters).toEqual(["assigned-to-me", "open"]);
      expect(pressed(wrapper)).toEqual(["Assigned to me", "Open"]);

      await chip(wrapper, "Reported by me").trigger("click");
      await flushPromises();
      expect(lastBuild()?.smartFilters).toEqual(["reported-by-me", "open"]);
      expect(pressed(wrapper)).toEqual(["Reported by me", "Open"]);

      await chip(wrapper, "Open").trigger("click");
      await flushPromises();
      expect(lastBuild()?.smartFilters).toEqual(["reported-by-me"]);
      await chip(wrapper, "Reported by me").trigger("click");
      await flushPromises();
      expect(lastBuild()).toEqual({ connectionId: "jira-1", baseJql: "statusCategory != Done" });
      expect(pressed(wrapper)).toEqual([]);
      expectEveryCallToMatch(jiraOwnIssuesQuerySchema, transport.buildJiraOwnIssuesQuery);
    });

    test("the chips survive a restart with the search they produced", async () => {
      smartQueries();
      const first = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
      await flushPromises();
      await chip(first, "Watching").trigger("click");
      await flushPromises();
      await chip(first, "Current sprint").trigger("click");
      await flushPromises();
      expect(readJiraViewPreferences("default", "jira:ws", localStorage).smartFilters).toEqual([
        "watching",
        "current-sprint",
      ]);
      first.unmount();
      transport.searchJiraIssues.mockClear();
      const second = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
      await flushPromises();
      expect(pressed(second)).toEqual(["Watching", "Current sprint"]);
      expect(transport.searchJiraIssues).toHaveBeenCalledWith(
        expect.objectContaining({ jql: "smart(watching,current-sprint)" }),
      );
    });

    test("a failed chip search keeps the previous chips", async () => {
      smartQueries();
      const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
      await flushPromises();
      await chip(wrapper, "Open").trigger("click");
      await flushPromises();
      transport.searchJiraIssues.mockRejectedValueOnce(new Error("JQL rejected"));
      await chip(wrapper, "Unassigned").trigger("click");
      await flushPromises();
      expect(pressed(wrapper)).toEqual(["Open"]);
      expect(wrapper.find(".jira-error__message").text()).toContain("JQL rejected");
    });

    test("without a verified identity the Who chips are disabled and lead to the identity setup", async () => {
      transport.listJiraConnections.mockResolvedValue([
        { id: "jira-1", label: "Engineering", deployment: "cloud", webUrl: "https://one.example" },
      ]);
      smartQueries();
      const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
      await flushPromises();
      for (const label of ["Assigned to me", "Reported by me", "Watching"]) {
        expect(chip(wrapper, label).attributes("aria-disabled")).toBe("true");
        expect(chip(wrapper, label).attributes("title")).toContain("Jira identity");
      }
      for (const label of ["Unassigned", "Open", "Current sprint"])
        expect(chip(wrapper, label).attributes("aria-disabled")).toBeUndefined();
      transport.buildJiraOwnIssuesQuery.mockClear();
      await chip(wrapper, "Watching").trigger("click");
      await flushPromises();
      expect(transport.buildJiraOwnIssuesQuery).not.toHaveBeenCalled();
      expect(wrapper.find(".jira-human-identity-setup").exists()).toBe(true);
      expect(pressed(wrapper)).toEqual([]);
    });

    test("facets count the loaded issues, narrow them without asking Jira and can be cleared", async () => {
      const row = (id: string, status: string, issueType: string, priority: string, assignee?: string) => ({
        ref: { provider: "jira", connectionId: "jira-1", issueId: id, issueKey: `ENG-${id}` },
        summary: `Issue ${id}`,
        status,
        issueType,
        priority,
        ...(assignee ? { assignee } : {}),
      });
      transport.searchJiraIssues.mockResolvedValue([
        row("1", "Open", "Bug", "High", "Alice"),
        row("2", "In Progress", "Bug", "Low", "Bob"),
        row("3", "In Progress", "Task", "High", "Alice"),
      ]);
      const wrapper = mount(JiraInboxPane, { props: { workspaceId: "jira:ws" } });
      await flushPromises();
      const facet = (text: string) =>
        wrapper.findAll(".jira-facet").find((candidate) => candidate.text().startsWith(text))!;
      expect(facet("Bug").text()).toBe("Bug 2");
      expect(facet("Task").text()).toBe("Task 1");
      expect(facet("In Progress").text()).toBe("In Progress 2");
      expect(wrapper.findAll(".jira-facet--person")).toHaveLength(2);
      const searches = transport.searchJiraIssues.mock.calls.length;

      await facet("Bug").trigger("click");
      expect(wrapper.findAll(".jira-issue")).toHaveLength(2);
      expect(wrapper.get(".jira-list-toolbar__count").text()).toContain("Showing 2 of 3 loaded issues");
      expect(facet("In Progress").text()).toBe("In Progress 1");
      await facet("In Progress").trigger("click");
      expect(wrapper.findAll(".jira-issue").map((issue) => issue.text())).toEqual([expect.stringContaining("ENG-2")]);
      expect(wrapper.get(".jira-list-toolbar__count").text()).toContain("Showing 1 of 3 loaded issues");
      expect(transport.searchJiraIssues.mock.calls.length).toBe(searches);

      await wrapper.get(".jira-list-toolbar__count").get("button").trigger("click");
      expect(wrapper.findAll(".jira-issue")).toHaveLength(3);
      expect(wrapper.find(".jira-list-toolbar__count button").exists()).toBe(false);
    });
  });
});
