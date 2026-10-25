import { describe, expect, test, vi } from "vitest";
import { AzureDevOpsManager, createPullRequestKey } from "./azure-devops-manager.js";

const connection = {
  id: "ado-actions",
  orgUrl: "https://dev.azure.com/acme",
  login: "user@example.com",
  tokenRef: "ado-actions-token",
  enabled: true,
};

function createManager({ tracked = false, draft = false, autoComplete = false } = {}) {
  const prKey = createPullRequestKey(connection.id, "repo-1", 42);
  const reviewStore = {
    getTrackedPullRequest: () =>
      tracked
        ? {
            connectionId: connection.id,
            projectName: "Project",
            repositoryId: "repo-1",
            repositoryName: "web",
            pullRequestId: 42,
          }
        : null,
  };
  const manager = new AzureDevOpsManager({
    credentialStore: { getSecret: () => "token" } as unknown as never,
    reviewStore: reviewStore as unknown as never,
    fetchImpl: vi.fn() as unknown as never,
    execFileTextImpl: vi.fn().mockResolvedValue({ stdout: "", stderr: "" }),
  });
  const current = {
    prKey,
    connectionId: connection.id,
    project: { id: "project-id", name: "Project" },
    repository: { id: "repo-1", name: "web" },
    pullRequest: { id: 42, sourceRefName: "refs/heads/feature", targetRefName: "refs/heads/main" },
  };
  manager.setSnapshot({
    connections: [connection],
    inbox: { needsMyReview: [], myPullRequests: [], recentlyUpdated: [], needsAttention: [] },
    trackedPullRequests: {},
    pullRequests: tracked ? {} : { [prKey]: current },
    sync: { running: false, lastStartedAt: null, lastCompletedAt: null },
  } as unknown as never);
  let status = tracked ? "abandoned" : "active";
  let currentDraft = draft;
  let currentAutoCompleteIdentity: unknown = autoComplete ? { id: "me" } : null;
  manager.azureApi.getPullRequestById = vi.fn().mockImplementation(async () => ({
    status,
    mergeStatus: "succeeded",
    title: "Example",
    sourceRefName: "refs/heads/feature",
    targetRefName: "refs/heads/main",
    isDraft: currentDraft,
    autoCompleteSetBy: currentAutoCompleteIdentity,
    lastMergeSourceCommit: { commitId: "head-1" },
    reviewers: [{ id: "reviewer", vote: 10 }],
    repository: { project: { id: "project-id" } },
    _links: { web: { href: "https://dev.azure.com/acme/Project/_git/web/pullrequest/42" } },
  }));
  manager.azureApi.listPullRequestStatuses = vi.fn().mockResolvedValue([]);
  manager.azureApi.listPolicyEvaluations = vi.fn().mockResolvedValue([]);
  manager.azureApi.listRepositoryRefs = vi.fn().mockResolvedValue([{ name: "refs/heads/main", objectId: "base-1" }]);
  const setStatus = (next: string) => (status = next);
  return {
    manager,
    prKey,
    current,
    setStatus,
    setDraft: (next: boolean) => (currentDraft = next),
    setAutoComplete: (next: unknown) => (currentAutoCompleteIdentity = next),
  };
}

describe("Azure DevOps PR action adapter", () => {
  test("completion pins the source SHA and explicitly keeps policy and source branch protections", async () => {
    const { manager, prKey } = createManager();
    const expectedSnapshot = await manager.getPullRequestActionSnapshot(prKey, { fresh: true });
    const update = vi.fn().mockResolvedValue({ status: "active", mergeStatus: "queued" });
    manager.azureApi.updatePullRequest = update;

    const outcome = await manager.executePullRequestAction({
      prKey,
      action: "complete",
      options: { mergeMethod: "squash" },
      expectedSnapshot,
    });

    expect(update).toHaveBeenCalledWith(expect.anything(), "token", "Project", "repo-1", 42, {
      status: "completed",
      lastMergeSourceCommit: { commitId: "head-1" },
      completionOptions: { bypassPolicy: false, deleteSourceBranch: false, mergeStrategy: "squash" },
    });
    expect(outcome.status).toBe("queued");
    expect(outcome.snapshot?.checks.state).toBe("unknown");
  });

  test("reactivates a tracked abandoned PR after it leaves the active inbox", async () => {
    const { manager, prKey } = createManager({ tracked: true });
    const expectedSnapshot = await manager.getPullRequestActionSnapshot(prKey, { fresh: true });
    const update = vi.fn().mockResolvedValue({ status: "active" });
    manager.azureApi.updatePullRequest = update;

    await manager.executePullRequestAction({ prKey, action: "reactivate", expectedSnapshot });

    expect(expectedSnapshot.state).toBe("abandoned");
    expect(update).toHaveBeenCalledWith(expect.anything(), "token", "Project", "repo-1", 42, { status: "active" });
  });

  test.each([
    [
      "disable_auto_complete",
      { autoComplete: true },
      { autoCompleteSetBy: { id: "00000000-0000-0000-0000-000000000000" } },
    ],
    ["set_draft", {}, { isDraft: true }],
    ["set_ready", { draft: true }, { isDraft: false }],
    ["abandon", {}, { status: "abandoned" }],
    ["reactivate", { tracked: true }, { status: "active" }],
  ])("sends the provider update for %s", async (actionName, setup, expectedPatch) => {
    const { manager, prKey, setStatus, setDraft, setAutoComplete } = createManager(setup as unknown as never);
    if (actionName === "set_ready") setDraft(true);
    const expectedSnapshot = await manager.getPullRequestActionSnapshot(prKey, { fresh: true });
    const update = vi.fn().mockImplementation(async (_c, _t, _p, _r, _id, patch) => {
      if ("status" in patch) setStatus(patch.status as string);
      if ("isDraft" in patch) setDraft(Boolean(patch.isDraft));
      if ("autoCompleteSetBy" in patch) setAutoComplete(patch.autoCompleteSetBy);
      return patch;
    });
    manager.azureApi.updatePullRequest = update;

    const outcome = await manager.executePullRequestAction({
      prKey,
      action: actionName as unknown as never,
      expectedSnapshot,
    });

    expect(update).toHaveBeenCalledWith(expect.anything(), "token", "Project", "repo-1", 42, expectedPatch);
    expect(["completed", "accepted"]).toContain(outcome.status);
  });

  test("enables auto-complete with current identity, source SHA, and no policy bypass", async () => {
    const { manager, prKey } = createManager();
    (manager as unknown as { getAuthenticatedUserId: () => Promise<string> }).getAuthenticatedUserId = vi
      .fn()
      .mockResolvedValue("user-id");
    const expectedSnapshot = await manager.getPullRequestActionSnapshot(prKey, { fresh: true });
    const update = vi.fn().mockResolvedValue({ autoCompleteSetBy: { id: "user-id" } });
    manager.azureApi.updatePullRequest = update;

    await manager.executePullRequestAction({
      prKey,
      action: "enable_auto_complete",
      options: { mergeMethod: "rebase" },
      expectedSnapshot,
    });

    expect(update).toHaveBeenCalledWith(expect.anything(), "token", "Project", "repo-1", 42, {
      autoCompleteSetBy: { id: "user-id" },
      lastMergeSourceCommit: { commitId: "head-1" },
      completionOptions: { bypassPolicy: false, deleteSourceBranch: false, mergeStrategy: "rebase" },
    });
  });

  test("blocks direct completion when provider readiness is pending", async () => {
    const { manager, prKey } = createManager();
    manager.azureApi.listPolicyEvaluations = vi
      .fn()
      .mockResolvedValue([{ status: "queued", configuration: { type: { displayName: "Build validation" } } }]);
    const snapshot = await manager.getPullRequestActionSnapshot(prKey, { fresh: true });
    const update = vi.fn();
    manager.azureApi.updatePullRequest = update;

    expect(snapshot.mergeReadiness.state).toBe("pending");
    await expect(
      manager.executePullRequestAction({ prKey, action: "complete", expectedSnapshot: snapshot }),
    ).rejects.toThrow("still running");
    expect(update).not.toHaveBeenCalled();
  });

  test.each([
    ["missing identity", undefined, false],
    ["empty UUID", { id: "00000000-0000-0000-0000-000000000000" }, false],
    ["enabled identity", { id: "user-id" }, true],
  ])("normalizes auto-complete state for %s", async (_name, identity, expected) => {
    const { manager, prKey } = createManager();
    manager.azureApi.getPullRequestById = vi.fn().mockResolvedValue({
      status: "active",
      mergeStatus: "succeeded",
      title: "Example",
      sourceRefName: "refs/heads/feature",
      targetRefName: "refs/heads/main",
      lastMergeSourceCommit: { commitId: "head-1" },
      reviewers: [],
      repository: { project: { id: "project-id" } },
      ...(identity === undefined ? {} : { autoCompleteSetBy: identity }),
    });

    const snapshot = await manager.getPullRequestActionSnapshot(prKey, { fresh: true });

    expect(snapshot.autoMerge).toBe(expected);
  });
});
