import { describe, expect, it, vi } from "vitest";
import type { AppState } from "../shared/types/state.js";
import { createProviderHandlers } from "./runtime-provider-handlers.js";

const ISSUE = { connectionId: "jira-a", issueId: "1001", issueKey: "ENG-1" };

function setup() {
  const state = {
    activeWorkspaceId: "",
    windowSlots: [],
    settings: {
      integrations: {
        jira: {
          connections: [
            {
              id: "jira-a",
              profileId: "profile-a",
              label: "A",
              enabled: true,
              deployment: "data-center",
              webUrl: "https://jira.example.com",
              apiBaseUrl: "https://jira.example.com/jira",
              auth: { kind: "dc-pat", secretRef: "jira:a:pat" },
              accountPurpose: "personal",
            },
          ],
          queries: [],
        },
      },
    },
    workspaces: [],
  } as unknown as AppState;
  const snapshots: string[][] = [];
  const store = {
    mutate: vi.fn(async (mutator: (draft: AppState) => void) => {
      mutator(state);
      snapshots.push(state.workspaces.map((workspace) => workspace.id));
    }),
  };
  const checkout = (profileId: string) =>
    vi.fn(async (options: { newBranchName: string }) => ({
      workspace: {
        id: "workspace-new",
        name: options.newBranchName,
        kind: "terminal",
        source: "manual",
        profileId,
        cwd: "/cache/worktree",
        panels: [],
        quickfix: { connectionId: "conn", repositoryName: "web", baseBranch: "main" },
      },
    }));
  const azure = { openQuickFixWorkspace: checkout("profile-a") };
  const github = { openQuickFixWorkspace: checkout("profile-a") };
  const jiraManager = {
    issue: vi.fn(async (connection: { id: string }, issueId: string) => ({
      ref: { provider: "jira", connectionId: connection.id, issueId, issueKey: "ENG-1" },
      summary: "Fix login",
      status: "In Progress",
    })),
  };
  const ctx = {
    log: { info: vi.fn(), warn: vi.fn() },
    jiraLog: { info: vi.fn(), warn: vi.fn() },
    getState: () => state,
    store,
    azure,
    github,
    git: {},
    sessions: { syncWithState: vi.fn() },
    credentialStore: { hasSecret: () => true, getSecret: () => "token", listRefs: () => [] },
    getPayload: () => ({ appState: state }),
    broadcastState: vi.fn(),
    refreshGit: vi.fn(async () => undefined),
    registerGitWorkspaces: vi.fn(async () => undefined),
    ensureVisibleSession: vi.fn(),
    getViewerProfileId: (windowId: string) =>
      (({ "window-a": "profile-a", "window-b": "profile-b" }) as Record<string, string>)[windowId] || null,
    getViewerActiveWorkspaceId: () => "",
    mirrorRemoteViewerWorkspace: vi.fn(),
    jiraManager,
  };
  const handlers = createProviderHandlers(ctx);
  return { handlers, state, store, azure, github, jiraManager, snapshots };
}

const azurePayload = {
  connectionId: "az-1",
  projectName: "Engineering",
  repositoryId: "repo-1",
  repositoryName: "web",
  remoteUrl: "https://dev.azure.com/org/project/_git/web",
  baseBranch: "main",
  newBranchName: "feature/ENG-1-fix-login",
};
const githubPayload = {
  connectionId: "gh-1",
  owner: "acme",
  repo: "web",
  remoteUrl: "https://github.com/acme/web.git",
  baseBranch: "main",
  newBranchName: "feature/ENG-1-fix-login",
};

describe.each([
  ["azure", "azureQuickFixCreate", azurePayload],
  ["github", "githubQuickFixCreate", githubPayload],
] as const)("%s quick-fix create linked to a Jira issue", (provider, method, payload) => {
  const manager = (setupResult: ReturnType<typeof setup>) => setupResult[provider];

  it("registers the workspace with the work item in one state mutation", async () => {
    const result = setup();
    await result.handlers[method]({ ...payload, jiraIssueRef: ISSUE }, "window-a");
    expect(result.store.mutate).toHaveBeenCalledTimes(1);
    expect(result.snapshots).toEqual([["workspace-new"]]);
    expect(result.state.workspaces[0]).toMatchObject({
      id: "workspace-new",
      profileId: "profile-a",
      workItems: [
        {
          ref: { provider: "jira", connectionId: "jira-a", issueId: "1001", issueKey: "ENG-1" },
          summary: "Fix login",
          status: "In Progress",
        },
      ],
    });
    expect(result.state.activeWorkspaceId).toBe("workspace-new");
  });

  it("creates an unlinked workspace when no issue is named", async () => {
    const result = setup();
    await result.handlers[method](payload, "window-a");
    expect(result.jiraManager.issue).not.toHaveBeenCalled();
    expect(result.state.workspaces[0]?.workItems).toBeUndefined();
  });

  it("refuses a Jira connection of another profile before anything is cloned or registered", async () => {
    const result = setup();
    await expect(result.handlers[method]({ ...payload, jiraIssueRef: ISSUE }, "window-b")).rejects.toThrow(
      "Jira connection belongs to another profile.",
    );
    expect(manager(result).openQuickFixWorkspace).not.toHaveBeenCalled();
    expect(result.store.mutate).not.toHaveBeenCalled();
    expect(result.state.workspaces).toEqual([]);
  });

  it("refuses an unknown Jira connection and an issue the connection does not return", async () => {
    const result = setup();
    await expect(
      result.handlers[method]({ ...payload, jiraIssueRef: { ...ISSUE, connectionId: "missing" } }, "window-a"),
    ).rejects.toThrow("Jira connection was not found or is disabled.");
    result.jiraManager.issue.mockResolvedValueOnce({
      ref: { provider: "jira", connectionId: "jira-a", issueId: "other", issueKey: "ENG-9" },
      summary: "",
      status: "",
    });
    await expect(result.handlers[method]({ ...payload, jiraIssueRef: ISSUE }, "window-a")).rejects.toThrow(
      "Jira issue reference does not match",
    );
    expect(manager(result).openQuickFixWorkspace).not.toHaveBeenCalled();
    expect(result.state.workspaces).toEqual([]);
  });
});
