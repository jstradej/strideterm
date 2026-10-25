import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ReviewPrActionProposal, ReviewPrActionSnapshot } from "../shared/review-pr-actions.js";
import type { Logger } from "./logger.js";
import type { WorkspaceState } from "../shared/types/state.js";
import { createOperationRegistry, type OperationRegistry } from "./operation-registry.js";
import { createReviewGitBroker, type ReviewGitGrantContext } from "./review-git/broker.js";
import { createReviewPrActionService } from "./review-git/pr-actions.js";

const PROFILE_A = "profile-a";
const PROFILE_B = "profile-b";
type BrokerResult = {
  status?: string;
  operationId?: string;
  kind?: string;
  started?: boolean;
  result?: { proposal?: ReviewPrActionProposal; snapshot?: ReviewPrActionSnapshot };
  proposal?: ReviewPrActionProposal;
  [key: string]: unknown;
};

function resultOf(response: { body: { result?: BrokerResult } }): BrokerResult {
  if (!response.body.result) throw new Error("The broker response did not include a result.");
  return response.body.result;
}

function proposalOf(response: { body: { result?: BrokerResult } }): ReviewPrActionProposal {
  const proposal = resultOf(response).result?.proposal;
  if (!proposal) throw new Error("The broker response did not include a proposal.");
  return proposal;
}

function workspace(id: string, profileId: string, prKey: string) {
  return {
    id,
    name: `${id} PR workspace`,
    profileId,
    cwd: `C:/fake/${id}`,
    panels: [],
    review: {
      provider: "github",
      prKey,
      connectionId: `connection-${profileId}`,
      sourceRepository: { fullName: "fork/project" },
      pullRequest: { sourceRefName: "refs/heads/feature" },
    },
  } as unknown as WorkspaceState;
}

function snapshotFor(prKey: string): ReviewPrActionSnapshot {
  const number = prKey.endsWith("42") ? 42 : prKey.endsWith("43") ? 43 : 44;
  return {
    provider: "github",
    prKey,
    connectionId: `connection-${prKey.includes("profile-b") ? PROFILE_B : PROFILE_A}`,
    repository: "owner/project",
    number,
    url: `https://github.com/owner/project/pull/${number}`,
    title: `Pull request ${number}`,
    state: "open",
    isDraft: false,
    autoMerge: false,
    source: { repository: "fork/project", branch: "feature", sha: `head-${number}` },
    target: { repository: "owner/project", branch: "main", sha: "target-sha" },
    checks: { state: "success", total: 1, successful: 1, failed: 0, pending: 0, items: [] },
    mergeReadiness: { state: "ready" },
    review: { approvals: 1, changesRequested: 0, requiredApprovals: 1 },
    supportedActions: ["merge", "approve"],
  };
}

const noopLog: Logger = { info() {}, warn() {}, error() {}, debug() {}, trace() {} };
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function createHarness() {
  const root = await mkdtemp(path.join(os.tmpdir(), "strideterm-review-pr-actions-"));
  cleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));

  const workspaces = [
    workspace("ws-a", PROFILE_A, "connection-profile-a:owner/project:42"),
    workspace("ws-a2", PROFILE_A, "connection-profile-a:owner/project:43"),
    workspace("ws-b", PROFILE_B, "connection-profile-b:owner/project:44"),
  ];
  const operationsFinished: unknown[] = [];
  const operations = createOperationRegistry({
    dir: path.join(root, "operations"),
    log: noopLog,
    emitFinished: (event) => operationsFinished.push(event),
    onChange() {},
  });
  const executePullRequestAction = vi.fn(async ({ prKey, action }: { prKey: string; action: string }) => ({
    provider: "github",
    prKey,
    action,
    status: "completed",
    message: `GitHub completed ${action}.`,
  }));
  const manager = {
    getPullRequestActionSnapshot: vi.fn(async (prKey: string) => snapshotFor(prKey)),
    executePullRequestAction,
  };
  const byId = new Map(workspaces.map((item) => [item.id, item]));
  const actionService = createReviewPrActionService({
    getState: () => ({ workspaces, profiles: [{ id: PROFILE_A }, { id: PROFILE_B }] }),
    locate(workspaceId, profileId) {
      const found = byId.get(workspaceId);
      if (!found || String(found.profileId) !== profileId) throw new Error("Cross-profile refused.");
      return { workspace: found, provider: "github", manager, profileId };
    },
    operations,
    auditStores: {
      github: { insertEntry: () => 1, finishEntry: () => true },
    },
    refreshAzure: async () => {},
    refreshGitHub: async () => {},
    broadcastState() {},
    log: noopLog,
  });

  function lookup(operationId: string, profileId: string, workspaceId: string) {
    const record = operations.get(operationId, profileId);
    if (!record || record.originWorkspaceId !== workspaceId) {
      return { status: "unavailable" as const, reason: "unknown", message: "Operation unavailable." };
    }
    const status =
      record.status === "accepted" ? "running" : record.status === "interrupted" ? "failed" : record.status;
    return {
      status: status as "running" | "succeeded" | "failed",
      operation: {
        kind: record.kind,
        startedAt: record.createdAt,
        finishedAt: record.finishedAt || null,
        ...(record.result ? { result: record.result } : {}),
        ...(record.error ? { error: record.error.message } : {}),
      },
    };
  }

  const reviewGitService = {
    operations,
    read: vi.fn(async () => ({})),
    start: vi.fn(() => {
      throw new Error("The integration harness does not start Git operations.");
    }),
    lookup,
  };
  let grantLive = true;
  const broker = createReviewGitBroker({
    service: reviewGitService as never,
    prActions: () => actionService,
    isGrantLive: () => grantLive,
  });
  const { url } = await broker.start();
  cleanups.push(() => broker.close());

  function mintGrant(context: Partial<ReviewGitGrantContext> = {}) {
    return broker.mintGrant({
      sessionId: "ws-a:panel-a",
      profileId: PROFILE_A,
      workspaceId: "ws-a",
      panelId: "panel-a",
      prKey: "connection-profile-a:owner/project:42",
      identityKey: "identity-a",
      agent: "claude",
      command: "claude",
      ...context,
    });
  }

  async function call(capability: string, body: unknown) {
    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${capability}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
    });
    return {
      status: response.status,
      body: (await response.json()) as { result?: BrokerResult; error?: { code: string } },
    };
  }

  return {
    broker,
    actionService,
    operations,
    operationsFinished,
    manager,
    mintGrant,
    call,
    setGrantLive: (value: boolean) => (grantLive = value),
  };
}

async function waitForOperation(operations: OperationRegistry, operationId: string, profileId: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const operation = operations.get(operationId, profileId);
    if (operation && ["succeeded", "failed", "interrupted"].includes(operation.status)) return operation;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Operation ${operationId} did not finish in time.`);
}

describe("review PR actions through the real review Git HTTP broker", () => {
  test("MCP can inspect, propose and poll, but its strict broker contract cannot confirm or mutate", async () => {
    const h = await createHarness();
    const grant = h.mintGrant();
    const inspect = await h.call(grant.capability, {
      operation: "pr-inspect",
      idempotencyKey: "inspect-key-123",
      waitMs: 2_000,
    });
    expect(inspect.status).toBe(200);
    expect(resultOf(inspect)).toMatchObject({
      status: "succeeded",
      kind: "review-pr-inspect",
      result: { snapshot: { prKey: "connection-profile-a:owner/project:42", source: { sha: "head-42" } } },
    });

    const proposalRun = await h.call(grant.capability, {
      operation: "pr-action-propose",
      action: "merge",
      options: { mergeMethod: "squash" },
      idempotencyKey: "proposal-key-123",
      waitMs: 2_000,
    });
    expect(proposalRun.status).toBe(200);
    const proposal = proposalOf(proposalRun);
    expect(proposal).toMatchObject({
      action: "merge",
      options: { mergeMethod: "squash" },
      profileId: PROFILE_A,
      snapshot: { title: "Pull request 42", source: { sha: "head-42" }, target: { sha: "target-sha" } },
    });
    expect(h.actionService.stateFor().pending.map((item) => item.proposalId)).toContain(proposal.proposalId);

    const status = await h.call(grant.capability, { operation: "pr-action-status", id: proposal.proposalId });
    expect(resultOf(status)).toMatchObject({ status: "pending", proposal: { proposalId: proposal.proposalId } });

    const forgedApproval = await h.call(grant.capability, {
      operation: "pr-action-propose",
      action: "merge",
      idempotencyKey: "forged-key-123",
      approved: true,
      proposalId: proposal.proposalId,
    });
    const directConfirmation = await h.call(grant.capability, {
      operation: "pr-action-confirm",
      proposalId: proposal.proposalId,
      approved: true,
    });
    const genericMutation = await h.call(grant.capability, {
      operation: "start",
      kind: "review-pr-action",
      idempotencyKey: "mutation-key-123",
      confirmation: { proposalId: proposal.proposalId, approved: true },
    });
    expect(forgedApproval.status).toBe(400);
    expect(directConfirmation.status).toBe(400);
    expect(genericMutation.status).toBe(400);
    expect(h.manager.executePullRequestAction).not.toHaveBeenCalled();

    const decision = await h.actionService.confirm(
      { proposalId: proposal.proposalId, approved: true },
      PROFILE_A,
      "desktop-window-a",
    );
    expect(decision.status).toBe("started");
    await waitForOperation(h.operations, decision.operationId!, PROFILE_A);
    expect(h.manager.executePullRequestAction).toHaveBeenCalledTimes(1);
  });

  test("profile and workspace grants cannot propose or read a proposal from another scope", async () => {
    const h = await createHarness();
    const ownGrant = h.mintGrant();
    const otherWorkspaceGrant = h.mintGrant({
      sessionId: "ws-a2:panel-a",
      workspaceId: "ws-a2",
      prKey: "connection-profile-a:owner/project:43",
    });
    const otherProfileGrant = h.mintGrant({
      sessionId: "ws-b:panel-b",
      profileId: PROFILE_B,
      workspaceId: "ws-b",
      panelId: "panel-b",
      prKey: "connection-profile-b:owner/project:44",
    });

    const proposed = await h.actionService.startProposal(
      { action: "merge", options: { mergeMethod: "merge" }, idempotencyKey: "scope-key-123" },
      { profileId: PROFILE_A, workspaceId: "ws-a", requester: { source: "mcp", agent: "claude", panelId: "panel-a" } },
    );
    await waitForOperation(h.operations, proposed.operationId, PROFILE_A);
    const proposalRecord = h.operations.get(proposed.operationId, PROFILE_A)!;
    const proposalId = String(proposalRecord.result?.proposalId || "");
    expect(proposalId).toBeTruthy();

    const wrongWorkspace = await h.call(otherWorkspaceGrant.capability, {
      operation: "pr-action-status",
      id: proposalId,
    });
    const wrongProfile = await h.call(otherProfileGrant.capability, { operation: "pr-action-status", id: proposalId });
    expect(wrongWorkspace.body.result).toEqual({ status: "unavailable", reason: "unknown" });
    expect(wrongProfile.body.result).toEqual({ status: "unavailable", reason: "unknown" });

    const smuggledScope = await h.call(ownGrant.capability, {
      operation: "pr-action-propose",
      action: "merge",
      idempotencyKey: "scope-smuggle-123",
      profileId: PROFILE_B,
      workspaceId: "ws-b",
    });
    expect(smuggledScope.status).toBe(400);
    expect(h.manager.executePullRequestAction).not.toHaveBeenCalled();
  });

  test("revocation blocks new requests, while an already confirmed operation survives agent disconnect", async () => {
    const h = await createHarness();
    const grant = h.mintGrant();
    const proposalResponse = await h.call(grant.capability, {
      operation: "pr-action-propose",
      action: "merge",
      options: { mergeMethod: "squash" },
      idempotencyKey: "disconnect-key-123",
      waitMs: 2_000,
    });
    const proposal = proposalOf(proposalResponse);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    h.manager.executePullRequestAction.mockImplementation(async (input) => {
      await gate;
      return {
        provider: "github",
        prKey: input.prKey,
        action: input.action,
        status: "completed",
        message: "GitHub completed the pull request.",
      };
    });

    const decision = await h.actionService.confirm(
      { proposalId: proposal.proposalId, approved: true },
      PROFILE_A,
      "desktop-window-a",
    );
    expect(decision.status).toBe("started");
    for (let attempt = 0; attempt < 100 && !h.manager.executePullRequestAction.mock.calls.length; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(h.manager.executePullRequestAction).toHaveBeenCalledTimes(1);

    h.broker.revokeSession("ws-a:panel-a");
    expect((await h.call(grant.capability, { operation: "pr-action-status", id: proposal.proposalId })).status).toBe(
      401,
    );
    release();
    const actionOperation = h.operations.list(PROFILE_A).find((record) => record.kind === "review-pr-action");
    expect(actionOperation).toBeTruthy();
    await waitForOperation(h.operations, actionOperation!.operationId, PROFILE_A);

    const actionResult = h.operations.list(PROFILE_A).find((record) => record.kind === "review-pr-action");
    expect(actionResult?.status).toBe("succeeded");
    expect(actionResult?.result).toMatchObject({ status: "completed", action: "merge" });
    expect(h.operationsFinished).toHaveLength(2);
    expect(h.operationsFinished.map((event) => (event as { kind?: string }).kind)).toContain("review-pr-action");
  });

  test("retries with one proposal idempotency key create one proposal and repeated app confirmation mutates once", async () => {
    const h = await createHarness();
    const grant = h.mintGrant();
    const request = {
      operation: "pr-action-propose",
      action: "merge",
      options: { mergeMethod: "rebase" },
      idempotencyKey: "retry-key-123456",
      waitMs: 2_000,
    };
    const first = await h.call(grant.capability, request);
    const retry = await h.call(grant.capability, request);
    const firstOperationId = resultOf(first).operationId;
    const retryOperationId = resultOf(retry).operationId;
    expect(retryOperationId).toBe(firstOperationId);
    expect(h.operations.list(PROFILE_A).filter((record) => record.kind === "review-pr-action-proposal")).toHaveLength(
      1,
    );

    const proposal = proposalOf(first);
    const firstDecision = await h.actionService.confirm(
      { proposalId: proposal.proposalId, approved: true },
      PROFILE_A,
      "desktop-window-a",
    );
    const replayedDecision = await h.actionService.confirm(
      { proposalId: proposal.proposalId, approved: true },
      PROFILE_A,
      "desktop-window-a",
    );
    expect(firstDecision.status).toBe("started");
    expect(replayedDecision.status).toBe("started");
    await waitForOperation(h.operations, firstDecision.operationId!, PROFILE_A);
    expect(h.manager.executePullRequestAction).toHaveBeenCalledTimes(1);
    expect(h.operations.list(PROFILE_A).filter((record) => record.kind === "review-pr-action")).toHaveLength(1);
  });
});
