import { beforeEach, describe, expect, test, vi } from "vitest";
import { reactive } from "vue";
import { mount, flushPromises } from "@vue/test-utils";

const azureCreatePullRequest = vi.fn();
const jiraApi = {
  previewJiraWrite: vi.fn(),
  executeJiraWrite: vi.fn(),
  searchJiraIssues: vi.fn(),
  getJiraIssue: vi.fn(),
};
const appStore = {
  payload: {
    appState: {
      workspaces: [
        {
          id: "ws1",
          profileId: "default",
          workItems: [
            {
              ref: { provider: "jira", connectionId: "jira-1", issueId: "100", issueKey: "ENG-1" },
              summary: "Example",
              ownIdentity: { displayName: "Alice" },
            },
          ],
        },
      ],
    },
  },
  myActiveProfileId: "default",
  getApi: () => jiraApi,
};

vi.mock("../../../stores/git-ui.js", () => ({
  useGitUiStore: () => ({
    azureCreatePullRequest,
    remoteBranches: [],
    remoteBranchesLoading: false,
    azureListRemoteBranches: vi.fn(),
  }),
}));
vi.mock("../../../stores/app.js", () => ({ useAppStore: () => appStore }));

vi.mock("../../../lib/renderer-log.js", () => ({ rlog: vi.fn() }));

import GitPullRequestTab from "./GitPullRequestTab.vue";
import { jiraWriteExecuteSchema, jiraWritePreviewSchema } from "../../../../electron/backend/ipc-schemas.js";
import CustomSelect from "../../common/CustomSelect.vue";
import { rlog } from "../../../lib/renderer-log.js";

function mountTab(gitUi: Record<string, unknown>, withRoutes = false, snapshot: Record<string, unknown> = {}) {
  return mount(GitPullRequestTab, {
    props: {
      workspaceId: "ws1",
      snapshot: {
        branch: withRoutes ? "feature/ENG-1" : "feature/x",
        aheadCount: 0,
        upstream: "origin/feature/x",
        dirty: false,
        branchNames: [],
        ...snapshot,
      },
      gitUi,
      baseBranch: "main",
      hasAzureConnection: true,
      activeConnectionId: "conn-1",
      activeConnectionLabel: "Azure — org/project",
      jiraRoutes: withRoutes
        ? [
            {
              connectionId: "jira-1",
              label: "Engineering",
              webUrl: "https://jira.example/jira",
              issueKeyPrefixes: ["ENG"],
            },
          ]
        : [],
    },
  });
}

async function fillAndSubmit(wrapper: ReturnType<typeof mountTab>) {
  const inputs = wrapper.findAll("input.git-pr-form__input");
  await inputs[1].setValue("My PR title");
  await wrapper.find(".git-operation-actions button").trigger("click");
  await flushPromises();
}

describe("GitPullRequestTab — when a PR can be created", () => {
  // The provider opens the PR from the branch on the remote: a pushed branch (0 ahead of its upstream) is the
  // ready state, and unpushed commits would silently be left out of the PR.
  test("a published, fully pushed branch can create a PR", async () => {
    const wrapper = mountTab(reactive({ lastResult: null }));
    await wrapper.findAll("input.git-pr-form__input")[1].setValue("My PR title");

    expect(wrapper.find(".git-operation-actions button").attributes("disabled")).toBeUndefined();
  });

  test("unpushed commits block the PR until they are pushed", async () => {
    const wrapper = mountTab(reactive({ lastResult: null }), false, { aheadCount: 2 });
    await wrapper.findAll("input.git-pr-form__input")[1].setValue("My PR title");

    const button = wrapper.find(".git-operation-actions button");
    expect(button.attributes("disabled")).toBeDefined();
    expect(button.attributes("title")).toContain("Push your commits first");
  });

  test("an unpublished branch blocks the PR until it is published", async () => {
    const wrapper = mountTab(reactive({ lastResult: null }), false, { upstream: "" });
    await wrapper.findAll("input.git-pr-form__input")[1].setValue("My PR title");

    const button = wrapper.find(".git-operation-actions button");
    expect(button.attributes("disabled")).toBeDefined();
    expect(button.attributes("title")).toContain("Publish the branch first");
  });
});

describe("GitPullRequestTab — create PR submission", () => {
  beforeEach(() => {
    appStore.payload.appState.workspaces[0].workItems = [
      {
        ref: { provider: "jira", connectionId: "jira-1", issueId: "100", issueKey: "ENG-1" },
        summary: "Example",
        ownIdentity: { displayName: "Alice" },
      },
    ];
    jiraApi.previewJiraWrite.mockReset();
    jiraApi.executeJiraWrite.mockReset();
    jiraApi.searchJiraIssues.mockReset();
    jiraApi.getJiraIssue.mockReset();
  });
  test("reports success via the shared submitPullRequest result", async () => {
    const gitUi = reactive<Record<string, unknown>>({ lastResult: null });
    azureCreatePullRequest.mockImplementation(async () => {
      gitUi.lastResult = { ok: true, pullRequestId: 42, url: "https://dev.azure.com/pr/42" };
    });

    const wrapper = mountTab(gitUi);
    await fillAndSubmit(wrapper);

    expect(azureCreatePullRequest).toHaveBeenCalledWith(
      "ws1",
      expect.objectContaining({ title: "My PR title", sourceBranch: "feature/x", connectionId: "conn-1" }),
    );
    const hint = wrapper.find(".git-pr-form .git-card__hint");
    expect(hint.text()).toContain("PR #42 created.");
    expect(hint.find("a").attributes("href")).toBe("https://dev.azure.com/pr/42");
  });

  test("keeps Jira remote-link as an opt-in, separately confirmed action", async () => {
    const gitUi = reactive<Record<string, unknown>>({ lastResult: null });
    azureCreatePullRequest.mockImplementation(async () => {
      gitUi.lastResult = { ok: true, pullRequestId: 42, url: "https://dev.azure.com/pr/42" };
    });
    jiraApi.previewJiraWrite.mockResolvedValue({
      token: "prepare-1",
      intent: "Link PR",
      preview: "ENG-1 ← PR 42",
      account: { displayName: "Bot", purpose: "technical" },
    });
    jiraApi.executeJiraWrite.mockResolvedValue({ ok: true, data: { status: "succeeded" } });
    const wrapper = mountTab(gitUi);
    expect(wrapper.find(".git-pr-jira-link").exists()).toBe(true);
    await wrapper.find(".git-pr-jira-link input[type=checkbox]").setValue(true);
    await fillAndSubmit(wrapper);
    expect(jiraApi.previewJiraWrite).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "remote-link",
        ref: expect.objectContaining({ issueId: "100" }),
        url: "https://dev.azure.com/pr/42",
      }),
    );
    expect(jiraApi.executeJiraWrite).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain("PR creation succeeded");
    await wrapper.find('[aria-label="Confirm Jira pull request link"] .button').trigger("click");
    await flushPromises();
    expect(jiraApi.executeJiraWrite).toHaveBeenCalledWith(
      expect.objectContaining({ action: "remote-link", confirmation: expect.objectContaining({ token: "prepare-1" }) }),
    );
    expect(wrapper.text()).toContain("Pull request created and Jira link added.");
    expect(jiraWritePreviewSchema.safeParse(jiraApi.previewJiraWrite.mock.calls[0][0]).success).toBe(true);
    expect(jiraWriteExecuteSchema.safeParse(jiraApi.executeJiraWrite.mock.calls[0][0]).success).toBe(true);
  });

  test("verifies a branch Jira candidate against the selected connection before presenting its canonical issue", async () => {
    const gitUi = reactive<Record<string, unknown>>({ lastResult: null });
    const previousLinks = appStore.payload.appState.workspaces[0].workItems;
    appStore.payload.appState.workspaces[0].workItems = [];
    jiraApi.searchJiraIssues.mockResolvedValue([
      { ref: { provider: "jira", connectionId: "jira-1", issueId: "100", issueKey: "ENG-1" }, summary: "Example" },
    ]);
    jiraApi.getJiraIssue.mockResolvedValue({
      ref: { provider: "jira", connectionId: "jira-1", issueId: "100", issueKey: "ENG-1" },
      summary: "Canonical issue",
    });
    jiraApi.previewJiraWrite.mockResolvedValue({
      token: "verified-link",
      intent: "Add PR link",
      preview: "ENG-1 ← PR 42",
    });
    jiraApi.executeJiraWrite.mockResolvedValue({ ok: true, data: { status: "succeeded" } });
    const wrapper = mountTab(gitUi, true);
    await flushPromises();
    expect(jiraApi.searchJiraIssues).toHaveBeenCalledWith({ connectionId: "jira-1", jql: 'key = "ENG-1"', limit: 5 });
    expect(jiraApi.getJiraIssue).toHaveBeenCalledWith({ connectionId: "jira-1", issueId: "100" });
    expect(wrapper.text()).toContain("Verified: ENG-1");
    await wrapper.find(".git-pr-jira-link input[type=checkbox]").setValue(true);
    azureCreatePullRequest.mockImplementation(async () => {
      gitUi.lastResult = { ok: true, pullRequestId: 42, url: "https://dev.azure.com/pr/42" };
    });
    await fillAndSubmit(wrapper);
    expect(jiraApi.previewJiraWrite).toHaveBeenCalledWith(
      expect.objectContaining({ ref: { provider: "jira", connectionId: "jira-1", issueId: "100", issueKey: "ENG-1" } }),
    );
    expect(jiraApi.executeJiraWrite).not.toHaveBeenCalled();
    await wrapper.find(".git-pr-jira-confirm button").trigger("click");
    await flushPromises();
    expect(jiraApi.executeJiraWrite).toHaveBeenCalledWith(
      expect.objectContaining({ ref: { provider: "jira", connectionId: "jira-1", issueId: "100", issueKey: "ENG-1" } }),
    );
    appStore.payload.appState.workspaces[0].workItems = previousLinks;
  });

  async function previewThenConfirm(executeResult: unknown) {
    const gitUi = reactive<Record<string, unknown>>({ lastResult: null });
    azureCreatePullRequest.mockImplementation(async () => {
      gitUi.lastResult = { ok: true, pullRequestId: 42, url: "https://dev.azure.com/pr/42" };
    });
    jiraApi.previewJiraWrite.mockResolvedValue({ token: "t", intent: "Link PR", preview: "ENG-1 <- PR 42" });
    jiraApi.executeJiraWrite.mockResolvedValue(executeResult);
    const wrapper = mountTab(gitUi);
    await wrapper.find(".git-pr-jira-link input[type=checkbox]").setValue(true);
    await fillAndSubmit(wrapper);
    await wrapper.find(".git-pr-jira-confirm button").trigger("click");
    await flushPromises();
    return wrapper;
  }

  test("does not claim the Jira link was added when the write was rejected", async () => {
    const wrapper = await previewThenConfirm({
      ok: false,
      error: { code: "jira-write-rejected", message: "Jira request failed (400).", status: "failed" },
    });
    expect(wrapper.text()).not.toContain("Jira link added");
    expect(wrapper.text()).toContain("Pull request created, but Jira link failed: Jira request failed (400).");
    expect(rlog).toHaveBeenCalledWith("warn", expect.stringContaining("PR link write failed"), expect.anything());
  });

  test("tells the user an unknown outcome may have added the link and needs reconciling", async () => {
    const wrapper = await previewThenConfirm({
      ok: false,
      error: { code: "jira-write-unknown", message: "Timed out.", status: "unknown", journalId: "j1" },
    });
    expect(wrapper.text()).not.toContain("Jira link added");
    expect(wrapper.text()).toContain("may have been added");
    expect(wrapper.text()).toContain("reconcile");
  });

  test("uses CustomSelect for the issue picker when several issues are linked", async () => {
    appStore.payload.appState.workspaces[0].workItems.push({
      ref: { provider: "jira", connectionId: "jira-1", issueId: "101", issueKey: "ENG-2" },
      summary: "Second",
      ownIdentity: { displayName: "Alice" },
    });
    const wrapper = mountTab(reactive<Record<string, unknown>>({ lastResult: null }));
    expect(wrapper.find(".git-pr-jira-link select").exists()).toBe(false);
    const selects = wrapper.findAllComponents(CustomSelect);
    expect(selects.some((select) => (select.props() as { options?: unknown[] }).options?.length === 2)).toBe(true);
  });

  test("reports Jira link preparation failure separately after successful PR creation", async () => {
    const gitUi = reactive<Record<string, unknown>>({ lastResult: null });
    azureCreatePullRequest.mockImplementation(async () => {
      gitUi.lastResult = { ok: true, pullRequestId: 42, url: "https://dev.azure.com/pr/42" };
    });
    jiraApi.previewJiraWrite.mockRejectedValue(new Error("permission denied"));
    const wrapper = mountTab(gitUi);
    await wrapper.find(".git-pr-jira-link input[type=checkbox]").setValue(true);
    await fillAndSubmit(wrapper);
    expect(wrapper.text()).toContain("PR #42 created.");
    expect(wrapper.text()).toContain("Pull request created, but Jira link preparation failed: permission denied");
  });

  test("reports failure via the shared submitPullRequest result", async () => {
    const gitUi = reactive<Record<string, unknown>>({ lastResult: null });
    azureCreatePullRequest.mockImplementation(async () => {
      gitUi.lastResult = { ok: false, summary: "A pull request already exists for this branch." };
    });

    const wrapper = mountTab(gitUi);
    await fillAndSubmit(wrapper);

    const hint = wrapper.find(".git-pr-form .git-card__hint--warning");
    expect(hint.text()).toContain("A pull request already exists for this branch.");
  });
});
