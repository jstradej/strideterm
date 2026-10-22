import { describe, expect, test, vi } from "vitest";
import { GitHubManager, createPullRequestKey } from "./github-manager.js";

const connection = {
  id: "gh-actions",
  hostUrl: "https://github.com",
  apiBaseUrl: "https://api.github.com",
  tokenRef: "github-actions-token",
  enabled: true,
};

type MockPullRequest = {
  [key: string]: unknown;
  head: { sha: string; ref: string; repo: { full_name: string } };
  base: { sha: string; ref: string; repo: { full_name: string } };
};

function createManager({ tracked = false } = {}) {
  const prKey = createPullRequestKey(connection.id, "acme", "web", 42);
  const trackedRecord = tracked
    ? { connectionId: connection.id, owner: "acme", repo: "web", pullRequestNumber: 42 }
    : null;
  const manager = new GitHubManager({
    credentialStore: { getSecret: () => "token" } as unknown as never,
    reviewStore: { getTrackedPullRequest: () => trackedRecord } as unknown as never,
    fetchImpl: vi.fn() as unknown as never,
    execFileTextImpl: vi.fn().mockResolvedValue({ stdout: "", stderr: "" }),
  });
  manager.setSnapshot({
    connections: [connection],
    inbox: { needsMyReview: [], myPullRequests: [], recentlyUpdated: [], needsAttention: [] },
    trackedPullRequests: {},
    pullRequests: tracked
      ? {}
      : {
          [prKey]: {
            prKey,
            connectionId: connection.id,
            repository: { owner: "acme", name: "web", fullName: "acme/web" },
            pullRequest: { number: 42 },
          },
        },
    sync: { running: false, lastStartedAt: null, lastCompletedAt: null },
  } as unknown as never);
  let currentPr: MockPullRequest = {
    number: 42,
    node_id: "node-42",
    title: "Example",
    html_url: "https://github.com/acme/web/pull/42",
    state: "open",
    draft: false,
    head: { sha: "head-1", ref: "feature", repo: { full_name: "fork/web" } },
    base: { sha: "base-1", ref: "main", repo: { full_name: "acme/web" } },
  };
  let details: Record<string, unknown> = {
    autoMergeRequest: null,
    mergeStateStatus: "CLEAN",
    reviewDecision: "APPROVED",
  };
  let checkRuns: unknown[] = [];
  let statuses: unknown[] = [];
  let reviews: unknown[] = [
    { user: { login: "reviewer" }, state: "APPROVED" },
    { user: { login: "reviewer" }, state: "COMMENTED" },
  ];
  manager.api.getPullRequest = vi.fn().mockImplementation(async () => currentPr);
  manager.api.listCheckRuns = vi.fn().mockImplementation(async () => checkRuns);
  manager.api.getCombinedStatus = vi.fn().mockImplementation(async () => ({ statuses }));
  manager.api.listReviews = vi.fn().mockImplementation(async () => reviews);
  manager.api.getPullRequestActionDetails = vi.fn().mockImplementation(async () => details);
  return {
    manager,
    prKey,
    setPr: (patch: Record<string, unknown>) => (currentPr = { ...currentPr, ...patch } as MockPullRequest),
    setDetails: (value: Record<string, unknown>) => (details = value),
    setCheckRuns: (value: unknown[]) => (checkRuns = value),
    setStatuses: (value: unknown[]) => (statuses = value),
    setReviews: (value: unknown[]) => (reviews = value),
  };
}

describe("GitHub PR action adapter", () => {
  test("reports zero checks as unknown and keeps approval through a comment", async () => {
    const { manager, prKey } = createManager();

    const snapshot = await manager.getPullRequestActionSnapshot(prKey, { fresh: true });

    expect(snapshot.checks).toMatchObject({ state: "unknown", total: 0 });
    expect(snapshot.review).toEqual({ approvals: 1, changesRequested: 0, requiredApprovals: null });
    expect(snapshot.source).toEqual({ repository: "fork/web", branch: "feature", sha: "head-1" });
  });

  test("does not call the merge endpoint after the fresh proposal pin changes", async () => {
    const { manager, prKey, setPr } = createManager();
    const expectedSnapshot = await manager.getPullRequestActionSnapshot(prKey, { fresh: true });
    setPr({ head: { sha: "head-2", ref: "feature", repo: { full_name: "fork/web" } } });
    const merge = vi.fn();
    manager.api.mergePullRequest = merge;

    await expect(manager.executePullRequestAction({ prKey, action: "merge", expectedSnapshot })).rejects.toThrow(
      "Pull request changed since the action was proposed",
    );
    expect(merge).not.toHaveBeenCalled();
  });

  test("does not claim this approval succeeded based on another reviewer's existing approval", async () => {
    const { manager, prKey } = createManager();
    const expectedSnapshot = await manager.getPullRequestActionSnapshot(prKey, { fresh: true });
    manager.submitPullRequestReview = vi.fn().mockResolvedValue({}) as unknown as never;

    const result = await manager.executePullRequestAction({ prKey, action: "approve", expectedSnapshot });

    expect(result.status).toBe("accepted");
    expect(result.message).toContain("not confirmed");
  });

  test.each([
    ["approve", "APPROVED"],
    ["merge", "MERGED"],
    ["enable_auto_merge", "AUTO_ON"],
    ["disable_auto_merge", "AUTO_OFF"],
    ["set_draft", "DRAFT"],
    ["set_ready", "READY"],
    ["close", "CLOSED"],
    ["reopen", "OPEN"],
  ])("dispatches GitHub %s and returns its provider-confirmed result", async (actionName, expected) => {
    const { manager, prKey, setPr, setDetails } = createManager();
    const action = actionName as unknown as never;
    if (action === "disable_auto_merge") setDetails({ autoMergeRequest: { enabledAt: "before" } });
    if (action === "set_ready") setPr({ draft: true });
    if (action === "reopen") setPr({ state: "closed" });
    const expectedSnapshot = await manager.getPullRequestActionSnapshot(prKey, { fresh: true });
    const approve = vi.fn().mockResolvedValue({ state: "APPROVED" });
    manager.submitPullRequestReview = approve as unknown as never;
    const merge = vi.fn().mockImplementation(async (_c, _t, _o, _r, _n, _sha, method) => {
      setPr({ merged_at: "now", state: "closed" });
      expect(method).toBe("squash");
      return { merged: true, message: "merged" };
    });
    const setState = vi.fn().mockImplementation(async (_c, _t, _o, _r, _n, state) => {
      setPr({ state });
      return { state };
    });
    const setDraft = vi.fn().mockImplementation(async (_c, _t, _id, draft) => {
      setPr({ draft });
      return {
        [draft ? "convertPullRequestToDraft" : "markPullRequestReadyForReview"]: { pullRequest: { isDraft: draft } },
      };
    });
    const setAutoMerge = vi.fn().mockImplementation(async (_c, _t, _id, enabled, _method, _expectedHead) => {
      setDetails({ autoMergeRequest: enabled ? { enabledAt: "now" } : null });
      return {
        [enabled ? "enablePullRequestAutoMerge" : "disablePullRequestAutoMerge"]: {
          pullRequest: { autoMergeRequest: enabled ? { enabledAt: "now" } : null },
        },
      };
    });
    manager.api.mergePullRequest = merge;
    manager.api.updatePullRequestState = setState;
    manager.api.setPullRequestDraft = setDraft;
    manager.api.setPullRequestAutoMerge = setAutoMerge;

    const outcome = await manager.executePullRequestAction({
      prKey,
      action,
      options: { mergeMethod: "squash" },
      expectedSnapshot,
    });

    expect(outcome.status).toBe("completed");
    if (expected === "APPROVED") expect(approve).toHaveBeenCalledWith({ prKey, event: "APPROVE", commitId: "head-1" });
    if (expected === "MERGED")
      expect(merge).toHaveBeenCalledWith(expect.anything(), "token", "acme", "web", 42, "head-1", "squash");
    if (expected === "AUTO_ON" || expected === "AUTO_OFF") {
      expect(setAutoMerge).toHaveBeenCalledWith(
        expect.anything(),
        "token",
        "node-42",
        expected === "AUTO_ON",
        "squash",
        "head-1",
      );
    }
    if (expected === "DRAFT" || expected === "READY")
      expect(setDraft).toHaveBeenCalledWith(expect.anything(), "token", "node-42", expected === "DRAFT");
    if (expected === "CLOSED" || expected === "OPEN")
      expect(setState).toHaveBeenCalledWith(
        expect.anything(),
        "token",
        "acme",
        "web",
        42,
        expected === "CLOSED" ? "closed" : "open",
      );
  });

  test.each([
    ["head", (pr: MockPullRequest) => ({ ...pr, head: { ...pr.head, sha: "head-2" } })],
    ["target ref", (pr: MockPullRequest) => ({ ...pr, base: { ...pr.base, ref: "release" } })],
    ["draft state", (pr: MockPullRequest) => ({ ...pr, draft: true })],
    ["title", (pr: MockPullRequest) => ({ ...pr, title: "Changed title" })],
  ])("blocks an action when the fresh %s pin changed", async (_name, mutate) => {
    const { manager, prKey, setPr } = createManager();
    const expectedSnapshot = await manager.getPullRequestActionSnapshot(prKey, { fresh: true });
    const current = await (
      manager.api as unknown as { getPullRequest: (...args: unknown[]) => Promise<MockPullRequest> }
    ).getPullRequest(connection, "token", "acme", "web", 42);
    setPr(mutate(current));
    const mutation = vi.fn();
    manager.api.updatePullRequestState = mutation;

    await expect(manager.executePullRequestAction({ prKey, action: "close", expectedSnapshot })).rejects.toThrow(
      "Pull request changed since the action was proposed",
    );
    expect(mutation).not.toHaveBeenCalled();
  });

  test.each(["auto-merge state", "checks", "reviews"])(
    "blocks an action when the fresh %s pin changed",
    async (changed) => {
      const { manager, prKey, setDetails, setCheckRuns, setReviews } = createManager();
      const expectedSnapshot = await manager.getPullRequestActionSnapshot(prKey, { fresh: true });
      if (changed === "auto-merge state") setDetails({ autoMergeRequest: { enabledAt: "now" } });
      if (changed === "checks") setCheckRuns([{ name: "New check", status: "queued", conclusion: null }]);
      if (changed === "reviews") setReviews([{ user: { login: "new-reviewer" }, state: "CHANGES_REQUESTED" }]);
      const mutation = vi.fn();
      manager.api.updatePullRequestState = mutation;

      await expect(manager.executePullRequestAction({ prKey, action: "close", expectedSnapshot })).rejects.toThrow(
        "Pull request changed since the action was proposed",
      );
      expect(mutation).not.toHaveBeenCalled();
    },
  );

  test("normalizes mixed check conclusions without hiding failures or unknown results", async () => {
    const { manager, prKey, setCheckRuns, setStatuses } = createManager();
    setCheckRuns([
      { name: "Required", status: "completed", conclusion: "action_required" },
      { name: "Optional", status: "completed", conclusion: "neutral" },
      { name: "Running", status: "in_progress", conclusion: null },
      { name: "Unrecognized", status: "completed", conclusion: "none" },
    ]);
    setStatuses([
      { context: "Legacy", state: "error" },
      { context: "Mystery", state: "unknown" },
    ]);

    const snapshot = await manager.getPullRequestActionSnapshot(prKey, { fresh: true });

    expect(snapshot.checks).toMatchObject({ state: "failure", total: 6, successful: 1, failed: 2, pending: 1 });
    expect(snapshot.checks.items.map((item) => item.state)).toContain("unknown");
  });

  test.each([
    ["DIRTY", "APPROVED", "blocked"],
    ["BLOCKED", "APPROVED", "blocked"],
    ["BEHIND", "APPROVED", "pending"],
    ["CLEAN", "REVIEW_REQUIRED", "pending"],
    ["UNKNOWN", "APPROVED", "unknown"],
  ])("derives merge readiness from GitHub merge state %s / %s", async (mergeStateStatus, reviewDecision, readiness) => {
    const { manager, prKey, setDetails } = createManager();
    setDetails({ autoMergeRequest: null, mergeStateStatus, reviewDecision });

    const snapshot = await manager.getPullRequestActionSnapshot(prKey, { fresh: true });

    expect(snapshot.mergeReadiness.state).toBe(readiness);
    expect(snapshot.supportedActions.includes("merge")).toBe(readiness === "ready");
    expect(snapshot.supportedActions).toContain("enable_auto_merge");
  });

  test("can reopen a closed PR from its tracked identity after inbox removal", async () => {
    const { manager, prKey, setPr } = createManager({ tracked: true });
    setPr({ state: "closed" });
    const expectedSnapshot = await manager.getPullRequestActionSnapshot(prKey, { fresh: true });
    const update = vi.fn().mockImplementation(async (_c, _t, _o, _r, _n, state) => {
      setPr({ state });
      return { state };
    });
    manager.api.updatePullRequestState = update;

    const outcome = await manager.executePullRequestAction({ prKey, action: "reopen", expectedSnapshot });

    expect(update).toHaveBeenCalled();
    expect(outcome.snapshot?.state).toBe("open");
  });

  test.each(["merge", "squash", "rebase"] as const)("passes %s through the GitHub merge API", async (mergeMethod) => {
    const { manager, prKey } = createManager();
    const expectedSnapshot = await manager.getPullRequestActionSnapshot(prKey, { fresh: true });
    const merge = vi.fn().mockResolvedValue({ merged: true });
    manager.api.mergePullRequest = merge;

    await manager.executePullRequestAction({ prKey, action: "merge", options: { mergeMethod }, expectedSnapshot });

    expect(merge).toHaveBeenCalledWith(expect.anything(), "token", "acme", "web", 42, "head-1", mergeMethod);
  });

  test("does not report a false merge when GitHub returns merged=false", async () => {
    const { manager, prKey } = createManager();
    const expectedSnapshot = await manager.getPullRequestActionSnapshot(prKey, { fresh: true });
    manager.api.mergePullRequest = vi.fn().mockResolvedValue({ merged: false, message: "Head branch was modified" });

    await expect(manager.executePullRequestAction({ prKey, action: "merge", expectedSnapshot })).rejects.toThrow(
      "Head branch was modified",
    );
  });

  test("does not retry a mutation when the follow-up snapshot fails", async () => {
    const { manager, prKey } = createManager();
    const expectedSnapshot = await manager.getPullRequestActionSnapshot(prKey, { fresh: true });
    const update = vi.fn().mockResolvedValue({ state: "closed" });
    manager.api.updatePullRequestState = update;
    (manager.api.getPullRequest as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        number: 42,
        node_id: "node-42",
        title: "Example",
        state: "open",
        draft: false,
        html_url: "https://github.com/acme/web/pull/42",
        head: { sha: "head-1", ref: "feature", repo: { full_name: "fork/web" } },
        base: { sha: "base-1", ref: "main", repo: { full_name: "acme/web" } },
      })
      .mockRejectedValueOnce(new Error("refresh failed"));

    const outcome = await manager.executePullRequestAction({ prKey, action: "close", expectedSnapshot });

    expect(update).toHaveBeenCalledTimes(1);
    expect(outcome.status).toBe("completed");
    expect(outcome.warning).toContain("follow-up refresh failed");
  });
});
