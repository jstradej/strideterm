import { createHash, randomUUID } from "node:crypto";
import type { WorkspaceState } from "../../shared/types/state.js";
import {
  reviewPrActionOptionsSchema,
  reviewPrActionOutcomeSchema,
  reviewPrActionSnapshotSchema,
  type ReviewPrAction,
  type ReviewPrActionOptions,
  type ReviewPrActionOutcome,
  type ReviewPrActionProposal,
  type ReviewPrActionSnapshot,
  type ReviewPrProvider,
  REVIEW_PR_ACTION_OPERATION_KIND,
  REVIEW_PR_ACTION_PROPOSAL_OPERATION_KIND,
  REVIEW_PR_INSPECT_OPERATION_KIND,
} from "../../shared/review-pr-actions.js";
import type { OperationRegistry } from "../operation-registry.js";
import { reviewPrActionSnapshotFingerprint } from "../shared/review-pr-action-fingerprint.js";

const PROPOSAL_TTL_MS = 10 * 60 * 1000;
const PROPOSAL_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_PROPOSALS = 200;
type ActionManager = {
  getPullRequestActionSnapshot: (prKey: string, options: { fresh: true }) => Promise<unknown>;
  executePullRequestAction: (input: {
    prKey: string;
    action: ReviewPrAction;
    options: ReviewPrActionOptions;
    expectedSnapshot: ReviewPrActionSnapshot;
  }) => Promise<unknown>;
};
type AuditStore = {
  insertEntry?: (entry: Record<string, unknown>) => number | null;
  finishEntry?: (
    id: number,
    outcome: {
      success: boolean;
      errorMessage?: string | null;
      durationMs?: number | null;
      details?: Record<string, unknown>;
    },
  ) => boolean;
};
type Located = {
  workspace: WorkspaceState;
  provider: ReviewPrProvider;
  manager: ActionManager;
  profileId: string;
};

export interface ReviewPrActionRequester {
  source: "mcp";
  agent: string;
  panelId: string;
}

export interface ReviewPrActionProposalInput {
  action: ReviewPrAction;
  options: ReviewPrActionOptions;
  idempotencyKey: string;
}

export interface ReviewPrActionProposalCaller {
  profileId: string;
  workspaceId: string;
  requester: ReviewPrActionRequester;
}

interface StoredProposal {
  proposal: ReviewPrActionProposal;
  requester: ReviewPrActionRequester;
  status: "pending" | "confirming" | "rejected" | "expired" | "stale" | "started" | "succeeded" | "failed";
  operationId?: string;
  updatedAt: number;
  expectedHash: string;
  identityKey: string;
  confirmedAt?: string;
  confirmedBy?: string;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function hash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function prIdentity(snapshot: ReviewPrActionSnapshot): string {
  return [snapshot.provider, snapshot.connectionId, snapshot.repository, String(snapshot.number)].join("|");
}

function actionLabel(action: ReviewPrAction): string {
  const labels: Record<ReviewPrAction, string> = {
    approve: "Approve pull request",
    complete: "Complete pull request",
    enable_auto_complete: "Enable auto-complete",
    disable_auto_complete: "Disable auto-complete",
    merge: "Merge pull request",
    enable_auto_merge: "Enable auto-merge",
    disable_auto_merge: "Disable auto-merge",
    set_draft: "Mark pull request as draft",
    set_ready: "Mark pull request as ready",
    abandon: "Abandon pull request",
    reactivate: "Reactivate pull request",
    close: "Close pull request",
    reopen: "Reopen pull request",
  };
  return labels[action];
}

function actionMessage(
  action: ReviewPrAction,
  snapshot: ReviewPrActionSnapshot,
  options: ReviewPrActionOptions,
): string {
  const actionText: Record<ReviewPrAction, string> = {
    approve:
      snapshot.provider === "github"
        ? "Submit an approval for this exact source commit."
        : "Submit an approval vote for this pull request after checking its current source commit; Azure DevOps applies the vote at PR level.",
    complete: `Complete this pull request using ${options.mergeMethod || "merge"} strategy if provider policies allow it. No policy bypass or source branch deletion will be requested.`,
    enable_auto_complete: `Queue provider auto-complete using ${options.mergeMethod || "merge"} strategy. This accepts scheduling; the provider may complete it later when its policies pass.`,
    disable_auto_complete: "Cancel provider auto-complete.",
    merge: `Merge this pull request using ${options.mergeMethod || "merge"} strategy. Provider policies still apply; no bypass or source branch deletion will be requested.`,
    enable_auto_merge: `Enable provider auto-merge using ${options.mergeMethod || "merge"} strategy. This accepts scheduling; the provider may merge later when its policies pass.`,
    disable_auto_merge: "Disable provider auto-merge.",
    set_draft: "Mark this pull request as a draft.",
    set_ready: "Mark this pull request as ready for review.",
    abandon: "Abandon this pull request.",
    reactivate: "Reactivate this pull request.",
    close: "Close this pull request.",
    reopen: "Reopen this pull request.",
  };
  const checks = snapshot.checks;
  return [
    actionText[action],
    `PR #${snapshot.number}: ${snapshot.title} (${snapshot.repository})`,
    `Source: ${snapshot.source.repository} ${snapshot.source.branch} @ ${snapshot.source.sha.slice(0, 12) || "unknown"}`,
    `Target: ${snapshot.target.repository} ${snapshot.target.branch} @ ${snapshot.target.sha.slice(0, 12) || "unknown"}`,
    `State: ${snapshot.state}${snapshot.isDraft ? " (draft)" : ""}; auto-merge: ${snapshot.autoMerge === null ? "unknown" : snapshot.autoMerge ? "on" : "off"}.`,
    `Checks: ${checks.state} — ${checks.successful} successful, ${checks.failed} failed, ${checks.pending} pending, ${checks.total} total.`,
    "Review this proposal in strIDEterm and confirm there before the action can start. An agent response cannot confirm it.",
  ].join("\n");
}

function proposalDedupeKey(
  snapshot: ReviewPrActionSnapshot,
  action: ReviewPrAction,
  options: ReviewPrActionOptions,
  profileId: string,
  workspaceId: string,
): string {
  return hash({ identity: prIdentity(snapshot), profileId, workspaceId, action, options, snapshot });
}

function proposalStatusResult(record: StoredProposal) {
  return {
    status: record.status,
    proposal: record.proposal,
    ...(record.operationId ? { operationId: record.operationId } : {}),
  };
}

export function createReviewPrActionService({
  getState,
  locate,
  operations,
  auditStores,
  refreshAzure,
  refreshGitHub,
  broadcastState,
  log,
  now = Date.now,
}: {
  getState: () => { workspaces: WorkspaceState[]; profiles: Array<{ id: string }> };
  locate: (workspaceId: string, profileId: string) => Located;
  operations: OperationRegistry;
  auditStores: { azure?: AuditStore; github?: AuditStore };
  refreshAzure: () => Promise<unknown>;
  refreshGitHub: () => Promise<unknown>;
  broadcastState: () => void;
  log: {
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
    error(message: string, meta?: Record<string, unknown>): void;
  };
  now?: () => number;
}) {
  const proposals = new Map<string, StoredProposal>();
  const pendingByFacts = new Map<string, string>();
  const prLocks = new Map<string, Promise<void>>();

  function prune(): void {
    const cutoff = now() - PROPOSAL_RETENTION_MS;
    for (const [proposalId, record] of proposals) {
      if (record.status === "pending" && Date.parse(record.proposal.expiresAt) <= now()) {
        record.status = "expired";
        record.updatedAt = now();
        const key = proposalDedupeKey(
          record.proposal.snapshot,
          record.proposal.action,
          record.proposal.options,
          record.proposal.profileId,
          record.proposal.workspaceId,
        );
        if (pendingByFacts.get(key) === proposalId) pendingByFacts.delete(key);
      }
      if (record.updatedAt < cutoff || proposals.size > MAX_PROPOSALS) {
        proposals.delete(proposalId);
        const key = proposalDedupeKey(
          record.proposal.snapshot,
          record.proposal.action,
          record.proposal.options,
          record.proposal.profileId,
          record.proposal.workspaceId,
        );
        if (pendingByFacts.get(key) === proposalId) pendingByFacts.delete(key);
      }
    }
  }

  function publish(): void {
    try {
      broadcastState();
    } catch {
      // Operation and proposal state remains authoritative if a renderer update is unavailable.
    }
  }

  function getLocated(workspaceId: string, profileId: string): Located {
    const located = locate(workspaceId, profileId);
    if (!located.workspace.review?.prKey) throw new Error("Review workspace not found.");
    if (located.provider !== located.workspace.review.provider) throw new Error("The pull request provider changed.");
    return located;
  }

  async function fetchSnapshot(located: Located): Promise<ReviewPrActionSnapshot> {
    const review = located.workspace.review;
    if (!review?.prKey || typeof located.manager.getPullRequestActionSnapshot !== "function") {
      throw new Error("Pull request actions are unavailable for this provider.");
    }
    const snapshot = reviewPrActionSnapshotSchema.parse(
      await located.manager.getPullRequestActionSnapshot(review.prKey, { fresh: true }),
    );
    if (snapshot.provider !== located.provider || snapshot.prKey !== review.prKey) {
      throw new Error("The provider returned a pull request that does not match this review workspace.");
    }
    if (snapshot.connectionId !== review.connectionId) throw new Error("The pull request connection changed.");
    return snapshot;
  }

  function effectiveOptions(action: ReviewPrAction, options: ReviewPrActionOptions): ReviewPrActionOptions {
    const usesMergeMethod = ["complete", "enable_auto_complete", "merge", "enable_auto_merge"].includes(action);
    if (options.mergeMethod && !usesMergeMethod)
      throw new Error("mergeMethod only applies to merge or auto-complete actions.");
    return usesMergeMethod ? { mergeMethod: options.mergeMethod || "merge" } : {};
  }

  function startOperation(
    located: Located,
    kind: string,
    idempotencyKey: string,
    input: unknown,
    step: string,
    run: (operationId: string) => Promise<Record<string, unknown>>,
  ) {
    const inputHash = hash(input);
    return operations.accept(
      {
        kind,
        profileId: located.profileId,
        originWorkspaceId: located.workspace.id,
        idempotencyKey,
        inputHash,
        initialStep: step,
        intent: {
          provider: located.provider,
          prKey: located.workspace.review?.prKey || "",
          workspaceId: located.workspace.id,
          profileId: located.profileId,
          ...((input && typeof input === "object" ? input : {}) as Record<string, unknown>),
        },
      },
      async (handle) => {
        await handle.update({ workspaceId: located.workspace.id });
        return run(handle.record.operationId);
      },
    );
  }

  async function withPrLock<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = prLocks.get(key) || Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    prLocks.set(key, current);
    await previous;
    try {
      return await run();
    } finally {
      release();
      if (prLocks.get(key) === current) prLocks.delete(key);
    }
  }

  async function startInspection(
    workspaceId: string,
    profileId: string,
    idempotencyKey: string,
  ): Promise<{ started: true; operationId: string }> {
    const located = getLocated(workspaceId, profileId);
    const input = {
      provider: located.provider,
      prKey: located.workspace.review!.prKey,
      identity: reviewIdentity(located),
    };
    const accepted = await startOperation(
      located,
      REVIEW_PR_INSPECT_OPERATION_KIND,
      idempotencyKey,
      input,
      "fetching PR checks",
      async () => ({
        snapshot: await fetchSnapshot(located),
      }),
    );
    return { started: true, operationId: accepted.record.operationId };
  }

  function reviewIdentity(located: Located): string {
    const review = located.workspace.review;
    return [
      located.provider,
      review?.connectionId || "",
      review?.prKey || "",
      review?.sourceRepository?.fullName || review?.sourceRepository?.remoteUrl || "",
      review?.pullRequest?.sourceRefName || "",
    ].join("|");
  }

  async function startProposal(
    input: ReviewPrActionProposalInput,
    caller: ReviewPrActionProposalCaller,
  ): Promise<{ started: true; operationId: string }> {
    const options = effectiveOptions(input.action, reviewPrActionOptionsSchema.parse(input.options));
    const located = getLocated(caller.workspaceId, caller.profileId);
    const identity = reviewIdentity(located);
    const accepted = await startOperation(
      located,
      REVIEW_PR_ACTION_PROPOSAL_OPERATION_KIND,
      `review-pr-proposal:${input.idempotencyKey}`,
      { action: input.action, options, identity },
      "fetching current pull request state",
      async () => {
        const current = await fetchSnapshot(located);
        if (!current.supportedActions.includes(input.action)) {
          throw new Error(`${input.action} is not supported for this pull request.`);
        }
        if (["merge", "complete"].includes(input.action) && current.mergeReadiness.state !== "ready") {
          throw new Error(
            `Direct merge is unavailable while provider merge readiness is ${current.mergeReadiness.state}${current.mergeReadiness.reason ? `: ${current.mergeReadiness.reason}` : "."}`,
          );
        }
        const factsKey = proposalDedupeKey(current, input.action, options, caller.profileId, caller.workspaceId);
        const duplicateId = pendingByFacts.get(factsKey);
        const duplicate = duplicateId ? proposals.get(duplicateId) : undefined;
        if (duplicate?.status === "pending" && Date.parse(duplicate.proposal.expiresAt) > now()) {
          return { proposalId: duplicate.proposal.proposalId, status: "pending", deduplicated: true };
        }
        const proposalId = randomUUID();
        const proposal: ReviewPrActionProposal = {
          proposalId,
          profileId: caller.profileId,
          workspaceId: caller.workspaceId,
          provider: current.provider,
          prKey: current.prKey,
          action: input.action,
          options,
          title: actionLabel(input.action),
          message: actionMessage(input.action, current, options),
          snapshot: current,
          expiresAt: new Date(now() + PROPOSAL_TTL_MS).toISOString(),
        };
        proposals.set(proposalId, {
          proposal,
          requester: { ...caller.requester },
          status: "pending",
          updatedAt: now(),
          expectedHash: reviewPrActionSnapshotFingerprint(current),
          identityKey: identity,
        });
        pendingByFacts.set(factsKey, proposalId);
        publish();
        return { proposalId, status: "pending", proposal };
      },
    );
    return { started: true, operationId: accepted.record.operationId };
  }

  function beginAudit(
    located: Located,
    stored: StoredProposal,
    operationId: string,
  ): { store: AuditStore; id: number; startedAt: number } {
    const store = auditStores[located.provider === "azure-devops" ? "azure" : "github"];
    if (!store?.insertEntry || !store.finishEntry) throw new Error("The pull request action audit is unavailable.");
    const snapshot = stored.proposal.snapshot;
    const id = store.insertEntry({
      timestamp: new Date(now()).toISOString(),
      connectionId: snapshot.connectionId,
      organization: located.provider === "azure-devops" ? located.workspace.review?.orgUrl || "" : "",
      project:
        located.provider === "azure-devops"
          ? located.workspace.review?.project?.name || snapshot.repository.split("/")[0] || ""
          : "",
      owner: located.provider === "github" ? snapshot.repository.split("/")[0] || "" : "",
      repository:
        located.provider === "github" ? snapshot.repository.split("/").slice(1).join("/") : snapshot.repository,
      operation: `reviewPr${stored.proposal.action}`,
      category: "write",
      method: "MCP",
      url: snapshot.url || "",
      statusCode: null,
      success: false,
      errorMessage: "started; outcome not yet recorded",
      durationMs: null,
      resourceType: "pullRequest",
      resourceId: String(snapshot.number),
      summary: `${stored.proposal.action} pull request ${snapshot.number}`,
      userInitiated: false,
      operationId,
      details: JSON.stringify({
        workspaceId: stored.proposal.workspaceId,
        profileId: stored.proposal.profileId,
        provider: stored.proposal.provider,
        prKey: stored.proposal.prKey,
        action: stored.proposal.action,
        options: stored.proposal.options,
        requester: stored.requester,
        confirmedBy: {
          source: "application",
          viewerId: stored.confirmedBy || "",
          confirmedAt: stored.confirmedAt || "",
        },
        pinned: stored.proposal.snapshot,
      }),
    });
    if (id === null || id === undefined)
      throw new Error("The pull request action could not be audited; it was not run.");
    return { store, id, startedAt: now() };
  }

  function finishAudit(
    audit: { store: AuditStore; id: number; startedAt: number },
    success: boolean,
    result: string,
    errorMessage?: string,
  ): boolean {
    try {
      return (
        audit.store.finishEntry?.(audit.id, {
          success,
          errorMessage: errorMessage || null,
          durationMs: now() - audit.startedAt,
          details: { outcome: result },
        }) === true
      );
    } catch {
      return false;
    }
  }

  async function runAction(proposalId: string, operationId: string): Promise<Record<string, unknown>> {
    const stored = proposals.get(proposalId);
    if (!stored || stored.status !== "confirming")
      throw new Error("The pull request action proposal is no longer approved.");
    const { proposal } = stored;
    const lockKey = prIdentity(proposal.snapshot);
    return withPrLock(lockKey, async () => {
      const located = getLocated(proposal.workspaceId, proposal.profileId);
      const fresh = await fetchSnapshot(located);
      if (reviewIdentity(getLocated(proposal.workspaceId, proposal.profileId)) !== stored.identityKey) {
        stored.status = "stale";
        stored.updatedAt = now();
        pendingByFacts.delete(
          proposalDedupeKey(
            proposal.snapshot,
            proposal.action,
            proposal.options,
            proposal.profileId,
            proposal.workspaceId,
          ),
        );
        publish();
        return {
          provider: proposal.provider,
          prKey: proposal.prKey,
          action: proposal.action,
          status: "stale",
          message: "The review workspace changed its pull request identity after confirmation. Nothing was applied.",
        };
      }
      if (reviewPrActionSnapshotFingerprint(fresh) !== stored.expectedHash) {
        stored.status = "stale";
        stored.updatedAt = now();
        pendingByFacts.delete(
          proposalDedupeKey(
            proposal.snapshot,
            proposal.action,
            proposal.options,
            proposal.profileId,
            proposal.workspaceId,
          ),
        );
        publish();
        return {
          provider: proposal.provider,
          prKey: proposal.prKey,
          action: proposal.action,
          status: "stale",
          message:
            "The pull request changed after confirmation. Nothing was applied; inspect the current pull request and request a new proposal.",
          snapshot: fresh,
        };
      }
      if (!fresh.supportedActions.includes(proposal.action)) {
        stored.status = "stale";
        stored.updatedAt = now();
        pendingByFacts.delete(
          proposalDedupeKey(
            proposal.snapshot,
            proposal.action,
            proposal.options,
            proposal.profileId,
            proposal.workspaceId,
          ),
        );
        publish();
        return {
          provider: proposal.provider,
          prKey: proposal.prKey,
          action: proposal.action,
          status: "stale",
          message: "The pull request no longer supports this action. Nothing was applied.",
          snapshot: fresh,
        };
      }

      const currentLocated = getLocated(proposal.workspaceId, proposal.profileId);
      if (reviewIdentity(currentLocated) !== stored.identityKey) {
        stored.status = "stale";
        stored.updatedAt = now();
        pendingByFacts.delete(
          proposalDedupeKey(
            proposal.snapshot,
            proposal.action,
            proposal.options,
            proposal.profileId,
            proposal.workspaceId,
          ),
        );
        publish();
        return {
          provider: proposal.provider,
          prKey: proposal.prKey,
          action: proposal.action,
          status: "stale",
          message:
            "The review workspace changed its pull request identity before the provider action. Nothing was applied.",
        };
      }
      const audit = beginAudit(currentLocated, stored, operationId);
      let result: ReviewPrActionOutcome;
      try {
        const rawResult = await currentLocated.manager.executePullRequestAction({
          prKey: proposal.prKey,
          action: proposal.action,
          options: proposal.options,
          expectedSnapshot: proposal.snapshot,
        });
        const parsedResult = reviewPrActionOutcomeSchema.safeParse(rawResult);
        result = parsedResult.success
          ? parsedResult.data
          : {
              provider: proposal.provider,
              prKey: proposal.prKey,
              action: proposal.action,
              status: "accepted",
              message:
                "The provider action request was sent, but its response could not be verified. Inspect the pull request before retrying.",
              warning: "Provider returned an invalid action result.",
            };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.startsWith("Pull request changed since the action was proposed.")) {
          finishAudit(audit, false, "stale", message);
          stored.status = "stale";
          stored.updatedAt = now();
          pendingByFacts.delete(
            proposalDedupeKey(
              proposal.snapshot,
              proposal.action,
              proposal.options,
              proposal.profileId,
              proposal.workspaceId,
            ),
          );
          publish();
          return {
            provider: proposal.provider,
            prKey: proposal.prKey,
            action: proposal.action,
            status: "stale",
            message: `${message} No action was applied.`,
          };
        }
        finishAudit(audit, false, "failed", message);
        log.error("review PR action failed", {
          operationId,
          proposalId,
          provider: proposal.provider,
          action: proposal.action,
          err: message,
        });
        throw new Error(
          `Provider action failed; its remote outcome may be uncertain. Inspect the pull request before retrying. ${message}`,
          { cause: error },
        );
      }

      const providerRejected = result.status === "failed";
      const auditRecorded = finishAudit(
        audit,
        !providerRejected,
        result.status,
        providerRejected ? result.message : undefined,
      );
      let warning = result.warning;
      if (!auditRecorded) log.warn("review PR action audit outcome could not be recorded", { operationId, proposalId });
      try {
        if (proposal.provider === "azure-devops") await refreshAzure();
        else await refreshGitHub();
      } catch (error) {
        warning = [
          warning,
          `${providerRejected ? "The provider rejected the action" : "The action was accepted"}, but provider state refresh failed: ${error instanceof Error ? error.message : String(error)}`,
        ]
          .filter(Boolean)
          .join(" ");
      }
      if (!auditRecorded) {
        warning = [
          warning,
          `${providerRejected ? "The provider rejected the action" : "The action was accepted"}, but its audit outcome could not be recorded.`,
        ]
          .filter(Boolean)
          .join(" ");
      }
      const outcome: ReviewPrActionOutcome = { ...result, ...(warning ? { warning } : {}) };
      stored.status = providerRejected ? "failed" : "succeeded";
      stored.updatedAt = now();
      pendingByFacts.delete(
        proposalDedupeKey(
          proposal.snapshot,
          proposal.action,
          proposal.options,
          proposal.profileId,
          proposal.workspaceId,
        ),
      );
      publish();
      return outcome as unknown as Record<string, unknown>;
    }).catch((error: unknown) => {
      stored.status = "failed";
      stored.updatedAt = now();
      pendingByFacts.delete(
        proposalDedupeKey(
          proposal.snapshot,
          proposal.action,
          proposal.options,
          proposal.profileId,
          proposal.workspaceId,
        ),
      );
      publish();
      throw error;
    });
  }

  async function confirm(
    input: { proposalId: string; approved: boolean },
    profileId: string,
    viewerId: string,
  ): Promise<{ status: "started" | "starting" | "rejected" | "expired"; operationId?: string }> {
    prune();
    const stored = proposals.get(input.proposalId);
    if (!stored) throw new Error("The pull request action proposal is unavailable or expired.");
    if (stored.proposal.profileId !== profileId) throw new Error("Cross-profile refused.");
    if (stored.status === "pending" && Date.parse(stored.proposal.expiresAt) <= now()) {
      stored.status = "expired";
      stored.updatedAt = now();
      publish();
      return { status: "expired" };
    }
    if (stored.status !== "pending") {
      if (stored.status === "started" || stored.status === "succeeded") {
        return { status: "started", ...(stored.operationId ? { operationId: stored.operationId } : {}) };
      }
      return {
        status: stored.status === "confirming" ? "starting" : stored.status === "expired" ? "expired" : "rejected",
      };
    }
    if (!input.approved) {
      stored.status = "rejected";
      stored.updatedAt = now();
      pendingByFacts.delete(
        proposalDedupeKey(
          stored.proposal.snapshot,
          stored.proposal.action,
          stored.proposal.options,
          stored.proposal.profileId,
          stored.proposal.workspaceId,
        ),
      );
      publish();
      return { status: "rejected" };
    }

    const proposal = stored.proposal;
    const located = getLocated(proposal.workspaceId, profileId);
    if (reviewIdentity(located) !== stored.identityKey) {
      stored.status = "stale";
      stored.updatedAt = now();
      pendingByFacts.delete(
        proposalDedupeKey(
          proposal.snapshot,
          proposal.action,
          proposal.options,
          proposal.profileId,
          proposal.workspaceId,
        ),
      );
      publish();
      return { status: "expired" };
    }
    stored.status = "confirming";
    stored.confirmedAt = new Date(now()).toISOString();
    stored.confirmedBy = viewerId;
    stored.updatedAt = now();
    publish();
    try {
      const accepted = await operations.accept(
        {
          kind: REVIEW_PR_ACTION_OPERATION_KIND,
          profileId,
          originWorkspaceId: proposal.workspaceId,
          idempotencyKey: `review-pr-action:${proposal.proposalId}`,
          inputHash: stored.expectedHash,
          initialStep: "rechecking pull request state",
          intent: {
            provider: proposal.provider,
            prKey: proposal.prKey,
            action: proposal.action,
            options: proposal.options,
            proposalId: proposal.proposalId,
            workspaceId: proposal.workspaceId,
            profileId,
            confirmedBy: { source: "application", viewerId, confirmedAt: stored.confirmedAt },
            pinned: proposal.snapshot,
          },
        },
        async (handle) => runAction(proposal.proposalId, handle.record.operationId),
      );
      stored.operationId = accepted.record.operationId;
      if (stored.status === "confirming") stored.status = "started";
      stored.updatedAt = now();
      publish();
      return { status: "started", operationId: accepted.record.operationId };
    } catch (error) {
      stored.status = "pending";
      stored.confirmedAt = undefined;
      stored.confirmedBy = undefined;
      stored.updatedAt = now();
      publish();
      throw error;
    }
  }

  function lookupStatus(id: string, profileId: string, workspaceId: string) {
    prune();
    const stored = proposals.get(id);
    if (stored) {
      if (stored.proposal.profileId !== profileId || stored.proposal.workspaceId !== workspaceId) {
        return { status: "unavailable", reason: "unknown" };
      }
      const operation = stored.operationId ? operations.get(stored.operationId, profileId) : null;
      return {
        ...proposalStatusResult(stored),
        ...(operation
          ? {
              operation: {
                operationId: operation.operationId,
                kind: operation.kind,
                status: operation.status,
                step: operation.step,
                result: operation.result,
                error: operation.error,
              },
            }
          : {}),
      };
    }
    const operation = operations.get(id, profileId);
    if (!operation) {
      const persistedProposal = operations
        .list(profileId)
        .find(
          (record) =>
            record.kind === REVIEW_PR_ACTION_PROPOSAL_OPERATION_KIND &&
            record.originWorkspaceId === workspaceId &&
            record.result?.proposalId === id,
        );
      return persistedProposal
        ? { status: "expired", reason: "runtime_restarted", operationId: persistedProposal.operationId }
        : { status: "unavailable", reason: "unknown" };
    }
    if (operation.originWorkspaceId !== workspaceId) return { status: "unavailable", reason: "unknown" };
    if (
      operation.kind === REVIEW_PR_ACTION_PROPOSAL_OPERATION_KIND &&
      operation.result?.proposalId &&
      !proposals.has(String(operation.result.proposalId))
    ) {
      return { status: "expired", reason: "runtime_restarted", operationId: operation.operationId };
    }
    return {
      status: operation.status,
      operationId: operation.operationId,
      kind: operation.kind,
      step: operation.step,
      result: operation.result,
      error: operation.error,
    };
  }

  function proposalForConfirmation(id: string): { profileId: string; workspaceId: string } | null {
    prune();
    const stored = proposals.get(id);
    if (!stored || stored.status !== "pending") return null;
    return { profileId: stored.proposal.profileId, workspaceId: stored.proposal.workspaceId };
  }

  function lookupProposalAccess(
    id: string,
    profileId: string,
  ): { operationId?: string; status: StoredProposal["status"] } | null {
    const stored = proposals.get(id);
    if (!stored) {
      const persistedProposal = operations
        .list(profileId)
        .find((record) => record.kind === REVIEW_PR_ACTION_PROPOSAL_OPERATION_KIND && record.result?.proposalId === id);
      return persistedProposal ? { status: "expired", operationId: persistedProposal.operationId } : null;
    }
    if (stored.proposal.profileId !== profileId) return null;
    return { status: stored.status, ...(stored.operationId ? { operationId: stored.operationId } : {}) };
  }

  function stateFor(): { pending: ReviewPrActionProposal[] } {
    prune();
    return {
      pending: [...proposals.values()].filter((record) => record.status === "pending").map((record) => record.proposal),
    };
  }

  return {
    startInspection,
    startProposal,
    confirm,
    lookupStatus,
    proposalForConfirmation,
    lookupProposalAccess,
    stateFor,
    operations,
  };
}

export type ReviewPrActionService = ReturnType<typeof createReviewPrActionService>;
