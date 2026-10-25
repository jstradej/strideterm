import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ReviewPrActionSnapshot } from "../../shared/review-pr-actions.js";
import type { WorkspaceState } from "../../shared/types/state.js";
import { createOperationRegistry } from "../operation-registry.js";
import { createReviewPrActionService } from "./pr-actions.js";

const profileId = "profile-a";
const prKey = "conn:owner/repo:42";
const rootPaths: string[] = [];
const noopLog = { trace() {}, debug() {}, info() {}, warn() {}, error() {} };

afterEach(async () => {
  await Promise.all(rootPaths.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function snapshot(sha = "head-a"): ReviewPrActionSnapshot {
  return {
    provider: "github",
    prKey,
    connectionId: "conn",
    repository: "owner/repo",
    number: 42,
    title: "Example PR",
    state: "open",
    isDraft: false,
    autoMerge: false,
    source: { repository: "fork/repo", branch: "feature", sha },
    target: { repository: "owner/repo", branch: "main", sha: "base-a" },
    checks: { state: "success", total: 1, successful: 1, failed: 0, pending: 0, items: [] },
    mergeReadiness: { state: "ready" },
    review: { approvals: 1, changesRequested: 0, requiredApprovals: 1 },
    supportedActions: ["merge", "approve"],
  };
}

async function harness(
  options: { now?: () => number; audit?: { insertEntry: () => number | null; finishEntry: () => boolean } } = {},
) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "strideterm-pr-action-unit-"));
  rootPaths.push(dir);
  const operations = createOperationRegistry({
    dir: path.join(dir, "operations"),
    log: noopLog,
    emitFinished() {},
    onChange() {},
  });
  const workspaces = ["workspace-a", "workspace-b"].map((id) => ({
    id,
    name: id,
    profileId,
    cwd: `C:/fake/${id}`,
    panels: [],
    review: {
      provider: "github",
      prKey,
      connectionId: "conn",
      sourceRepository: { fullName: "fork/repo" },
      pullRequest: { sourceRefName: "refs/heads/feature" },
    },
  })) as unknown as WorkspaceState[];
  const manager = {
    getPullRequestActionSnapshot: vi.fn(async () => snapshot()),
    executePullRequestAction: vi.fn(async () => ({
      provider: "github",
      prKey,
      action: "merge",
      status: "completed",
      message: "Merged.",
    })),
  };
  const service = createReviewPrActionService({
    getState: () => ({ workspaces, profiles: [{ id: profileId }] }),
    locate(workspaceId, requestedProfile) {
      const workspace = workspaces.find((item) => item.id === workspaceId);
      if (!workspace || requestedProfile !== profileId) throw new Error("Workspace unavailable.");
      return { workspace, provider: "github", manager, profileId };
    },
    operations,
    auditStores: { github: options.audit || { insertEntry: () => 1, finishEntry: () => true } },
    refreshAzure: async () => {},
    refreshGitHub: async () => {},
    broadcastState() {},
    log: noopLog,
    now: options.now,
  });
  return { dir, operations, workspaces, manager, service };
}

async function proposal(h: Awaited<ReturnType<typeof harness>>, workspaceId = "workspace-a") {
  const accepted = await h.service.startProposal(
    { action: "merge", options: {}, idempotencyKey: `proposal-${workspaceId}-key` },
    { profileId, workspaceId, requester: { source: "mcp", agent: "test", panelId: "panel" } },
  );
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const op = h.operations.get(accepted.operationId, profileId);
    if (op?.status === "succeeded") return op.result!.proposal as { proposalId: string };
    if (op?.status === "failed") throw new Error(op.error?.message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Proposal did not finish.");
}

async function finish(h: Awaited<ReturnType<typeof harness>>, operationId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const op = h.operations.get(operationId, profileId);
    if (op?.status === "succeeded" || op?.status === "failed") return op;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Action did not finish.");
}

describe("review PR action service safety", () => {
  test("audit intent failure blocks remote mutation", async () => {
    const h = await harness({ audit: { insertEntry: () => null, finishEntry: () => true } });
    const p = await proposal(h);
    const decision = await h.service.confirm({ proposalId: p.proposalId, approved: true }, profileId, "window-1");
    const result = await finish(h, decision.operationId!);
    expect(result.status).toBe("failed");
    expect(result.error?.message).toContain("audit");
    expect(h.manager.executePullRequestAction).not.toHaveBeenCalled();
  });

  test("Azure DevOps audit entries use the workspace organization URL and project name", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "strideterm-pr-action-ado-audit-"));
    rootPaths.push(dir);
    const operations = createOperationRegistry({
      dir: path.join(dir, "operations"),
      log: noopLog,
      emitFinished() {},
      onChange() {},
    });
    const adoKey = "ado-connection:Project/repo:42";
    const workspace = {
      id: "ado-workspace",
      name: "Azure PR",
      cwd: "C:/fake/ado",
      profileId,
      panels: [],
      review: {
        provider: "azure-devops",
        prKey: adoKey,
        connectionId: "ado-connection",
        orgUrl: "https://dev.azure.com/acme-org",
        project: { name: "Project" },
        sourceRepository: { fullName: "Project/repo" },
        pullRequest: { sourceRefName: "refs/heads/feature" },
      },
    } as unknown as WorkspaceState;
    const adoSnapshot: ReviewPrActionSnapshot = {
      ...snapshot(),
      provider: "azure-devops",
      prKey: adoKey,
      connectionId: "ado-connection",
      repository: "Project/repo",
      state: "active",
      source: { repository: "Project/repo", branch: "feature", sha: "head" },
      target: { repository: "Project/repo", branch: "main", sha: "base" },
      mergeReadiness: { state: "ready" },
      supportedActions: ["approve"],
    };
    const auditEntry = vi.fn(() => 7);
    const manager = {
      getPullRequestActionSnapshot: vi.fn(async () => adoSnapshot),
      executePullRequestAction: vi.fn(async () => ({
        provider: "azure-devops",
        prKey: adoKey,
        action: "approve",
        status: "completed",
        message: "Approval recorded.",
      })),
    };
    const service = createReviewPrActionService({
      getState: () => ({ workspaces: [workspace], profiles: [{ id: profileId }] }),
      locate: () => ({ workspace, provider: "azure-devops", manager, profileId }),
      operations,
      auditStores: { azure: { insertEntry: auditEntry, finishEntry: () => true } },
      refreshAzure: async () => {},
      refreshGitHub: async () => {},
      broadcastState() {},
      log: noopLog,
    });
    const proposalOp = await service.startProposal(
      { action: "approve", options: {}, idempotencyKey: "ado-audit-key" },
      { profileId, workspaceId: workspace.id, requester: { source: "mcp", agent: "test", panelId: "panel" } },
    );
    let proposalRecord;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      proposalRecord = operations.get(proposalOp.operationId, profileId);
      if (proposalRecord?.status === "succeeded") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(proposalRecord?.status, proposalRecord?.error?.message).toBe("succeeded");
    const proposalId = String(proposalRecord?.result?.proposalId || "");
    expect(proposalId).not.toBe("");
    const confirmation = await service.confirm({ proposalId, approved: true }, profileId, "window-ado");
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const operation = operations.get(confirmation.operationId!, profileId);
      if (operation?.status === "succeeded" || operation?.status === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(auditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        organization: "https://dev.azure.com/acme-org",
        project: "Project",
      }),
    );
  });

  test("source commit drift after confirmation returns stale and performs no mutation", async () => {
    const h = await harness();
    const p = await proposal(h);
    h.manager.getPullRequestActionSnapshot.mockResolvedValue(snapshot("head-b"));
    const decision = await h.service.confirm({ proposalId: p.proposalId, approved: true }, profileId, "window-1");
    const result = await finish(h, decision.operationId!);
    expect(result.result).toMatchObject({ status: "stale" });
    expect(h.manager.executePullRequestAction).not.toHaveBeenCalled();
  });

  test("provider-side recheck drift is stale rather than an uncertain mutation failure", async () => {
    const h = await harness();
    const p = await proposal(h);
    h.manager.executePullRequestAction.mockRejectedValue(
      new Error("Pull request changed since the action was proposed. Refresh and propose it again."),
    );
    const decision = await h.service.confirm({ proposalId: p.proposalId, approved: true }, profileId, "window-1");
    const result = await finish(h, decision.operationId!);
    expect(result.status).toBe("succeeded");
    expect(result.result).toMatchObject({ status: "stale" });
  });

  test("check item order does not invalidate an otherwise identical proposal", async () => {
    const h = await harness();
    const first = snapshot();
    first.checks = {
      state: "success",
      total: 2,
      successful: 2,
      failed: 0,
      pending: 0,
      items: [
        { name: "build", state: "success", kind: "check" },
        { name: "test", state: "success", kind: "check" },
      ],
    };
    h.manager.getPullRequestActionSnapshot.mockResolvedValue(first);
    const p = await proposal(h);
    h.manager.getPullRequestActionSnapshot.mockResolvedValue({
      ...first,
      checks: { ...first.checks, items: [...first.checks.items].reverse() },
    });
    const decision = await h.service.confirm({ proposalId: p.proposalId, approved: true }, profileId, "window-1");
    const result = await finish(h, decision.operationId!);
    expect(result.status).toBe("succeeded");
    expect(result.result).toMatchObject({ status: "completed" });
    expect(h.manager.executePullRequestAction).toHaveBeenCalledTimes(1);
  });

  test("workspace relink while fresh state is loading prevents action against the new identity", async () => {
    const h = await harness();
    const p = await proposal(h);
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => (started = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    h.manager.getPullRequestActionSnapshot.mockImplementation(async () => {
      started();
      await gate;
      return snapshot();
    });
    const decision = await h.service.confirm({ proposalId: p.proposalId, approved: true }, profileId, "window-1");
    await entered;
    h.workspaces[0].review!.prKey = "conn:owner/repo:99";
    release();
    await finish(h, decision.operationId!);
    expect(h.manager.executePullRequestAction).not.toHaveBeenCalled();
  });

  test("expired and rejected proposals remain terminal", async () => {
    let now = 1_700_000_000_000;
    const h = await harness({ now: () => now });
    const expired = await proposal(h);
    now += 11 * 60 * 1000;
    expect(await h.service.confirm({ proposalId: expired.proposalId, approved: true }, profileId, "window-1")).toEqual({
      status: "expired",
    });

    now = 1_700_000_000_000;
    const rejected = await proposal(h, "workspace-b");
    expect(
      await h.service.confirm({ proposalId: rejected.proposalId, approved: false }, profileId, "window-1"),
    ).toEqual({ status: "rejected" });
    expect(await h.service.confirm({ proposalId: rejected.proposalId, approved: true }, profileId, "window-1")).toEqual(
      { status: "rejected" },
    );
    expect(h.manager.executePullRequestAction).not.toHaveBeenCalled();
  });

  test("same provider PR is serialized across workspaces", async () => {
    const h = await harness();
    const first = await proposal(h, "workspace-a");
    const second = await proposal(h, "workspace-b");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    h.manager.executePullRequestAction.mockImplementation(async () => {
      await gate;
      return { provider: "github", prKey, action: "merge", status: "completed", message: "Merged." };
    });
    const a = await h.service.confirm({ proposalId: first.proposalId, approved: true }, profileId, "window-1");
    const b = await h.service.confirm({ proposalId: second.proposalId, approved: true }, profileId, "window-2");
    for (let attempt = 0; attempt < 100 && h.manager.executePullRequestAction.mock.calls.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(h.manager.executePullRequestAction).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([finish(h, a.operationId!), finish(h, b.operationId!)]);
    expect(h.manager.executePullRequestAction).toHaveBeenCalledTimes(2);
  });

  test("a queued proposal is stale after an earlier action changes the PR", async () => {
    const h = await harness();
    const first = await proposal(h, "workspace-a");
    const second = await proposal(h, "workspace-b");
    let changed = false;
    h.manager.getPullRequestActionSnapshot.mockImplementation(async () => snapshot(changed ? "head-b" : "head-a"));
    h.manager.executePullRequestAction.mockImplementation(async () => {
      changed = true;
      return { provider: "github", prKey, action: "merge", status: "completed", message: "Merged." };
    });
    const a = await h.service.confirm({ proposalId: first.proposalId, approved: true }, profileId, "window-1");
    const b = await h.service.confirm({ proposalId: second.proposalId, approved: true }, profileId, "window-2");
    await Promise.all([finish(h, a.operationId!), finish(h, b.operationId!)]);
    const secondResult = h.operations.get(b.operationId!, profileId)?.result;
    expect(secondResult).toMatchObject({ status: "stale" });
    expect(h.manager.executePullRequestAction).toHaveBeenCalledTimes(1);
  });

  test("audit outcome or refresh failure warns without hiding a completed provider action", async () => {
    const h = await harness({ audit: { insertEntry: () => 1, finishEntry: () => false } });
    const p = await proposal(h);
    const action = h.service.confirm({ proposalId: p.proposalId, approved: true }, profileId, "window-1");
    const accepted = await action;
    const result = await finish(h, accepted.operationId!);
    expect(result.result).toMatchObject({ status: "completed", warning: expect.stringContaining("audit outcome") });
    expect(h.manager.executePullRequestAction).toHaveBeenCalledTimes(1);
  });

  test("failed provider outcome is audited as failure", async () => {
    const finishEntry = vi.fn(() => true);
    const h = await harness({ audit: { insertEntry: () => 1, finishEntry } });
    const p = await proposal(h);
    h.manager.executePullRequestAction.mockResolvedValue({
      provider: "github",
      prKey,
      action: "merge",
      status: "failed",
      message: "Provider rejected the request.",
    });
    const decision = await h.service.confirm({ proposalId: p.proposalId, approved: true }, profileId, "window-1");
    const result = await finish(h, decision.operationId!);
    expect(finishEntry).toHaveBeenLastCalledWith(
      1,
      expect.objectContaining({ success: false, errorMessage: "Provider rejected the request." }),
    );
    expect(result.result).toMatchObject({ status: "failed" });
  });

  test("a pending proposal from a prior runtime is reported expired, never restored for approval", async () => {
    const h = await harness();
    const accepted = await h.service.startProposal(
      { action: "merge", options: {}, idempotencyKey: "restart-proposal-key" },
      { profileId, workspaceId: "workspace-a", requester: { source: "mcp", agent: "test", panelId: "panel" } },
    );
    const original = await finish(h, accepted.operationId);
    expect(original.status).toBe("succeeded");
    const restarted = createReviewPrActionService({
      getState: () => ({ workspaces: h.workspaces, profiles: [{ id: profileId }] }),
      locate(workspaceId, requestedProfile) {
        const workspace = h.workspaces.find((item) => item.id === workspaceId);
        if (!workspace || requestedProfile !== profileId) throw new Error("Workspace unavailable.");
        return { workspace, provider: "github", manager: h.manager, profileId };
      },
      operations: h.operations,
      auditStores: { github: { insertEntry: () => 2, finishEntry: () => true } },
      refreshAzure: async () => {},
      refreshGitHub: async () => {},
      broadcastState() {},
      log: noopLog,
    });
    expect(restarted.stateFor().pending).toEqual([]);
    expect(restarted.lookupStatus(accepted.operationId, profileId, "workspace-a")).toMatchObject({
      status: "expired",
      reason: "runtime_restarted",
    });
  });
});
