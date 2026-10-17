import type { ShallowRef, ComputedRef } from "vue";
import type { StatePayload } from "../../electron/shared/types/state.js";
import {
  reviewGitOperationEventSchema,
  type ReviewGitOperationEvent,
  type ReviewGitOperationKind,
} from "../../electron/shared/review-git-events.js";
import type { CallableTransport, Transport } from "../transport.js";
import { useNotificationStore } from "./notifications.js";
import { fireNotificationAlert } from "../composables/useNotificationSound.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApi = any;

export interface ReviewGitProposalView {
  proposalId: string;
  kind: string;
  title: string;
  message: string;
  affectedCommits: Array<{ sha: string; subject: string }>;
  affectedTotal: number;
  incomingCommits: Array<{ sha: string; subject: string }>;
  incomingTotal: number;
  choices: Array<{ id: string; label: string }>;
}

/** What a finished operation carries: the engine's result, or push-and-publish's two parts. */
export type ReviewGitOutcome = AnyApi;

interface ReviewGitOperationsCtx {
  payload: ShallowRef<StatePayload | null>;
  myActiveProfileId: ComputedRef<string | null>;
  getApi: () => Transport;
  confirmInApp: (opts: {
    title: string;
    message: string;
    confirmLabel?: string;
    cancelLabel?: string;
    danger?: boolean;
  }) => Promise<boolean>;
}

/**
 * Operations this client has already been told about, newest last. Per client
 * (browser storage), bounded, and separate from the notification history: the
 * user removing an entry must not make the payload's replayed last run look
 * new again after a reload.
 */
const NOTIFIED_KEY = "strideterm-review-git-notified-operations";
const NOTIFIED_MAX = 100;
const FINISHED_MEMORY = 50;
const WAIT_LIMIT_MS = 15 * 60 * 1000;
const MAX_CONFIRM_ROUNDS = 3;

function loadNotified(): string[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(NOTIFIED_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function rememberNotified(operationId: string): void {
  try {
    const ids = [...loadNotified().filter((id) => id !== operationId), operationId];
    window.localStorage.setItem(NOTIFIED_KEY, JSON.stringify(ids.slice(-NOTIFIED_MAX)));
  } catch {
    // Storage unavailable: this renderer's in-memory set still holds for its lifetime.
  }
}

const shortSha = (sha: string) => String(sha || "").slice(0, 8);

function commitLines(commits: Array<{ sha: string; subject: string }>, total: number): string {
  const lines = commits.slice(0, 8).map((commit) => `  ${shortSha(commit.sha)} ${commit.subject}`);
  if (total > commits.length) lines.push(`  … and ${total - Math.min(commits.length, 8)} more`);
  return lines.join("\n");
}

/** The confirmation dialog body for a proposal: the runtime's wording plus the exact commits involved. */
export function describeProposal(proposal: ReviewGitProposalView): string {
  const parts = [proposal.message];
  if (proposal.affectedTotal) {
    const label =
      proposal.kind === "reset"
        ? "Local commits that would be discarded"
        : proposal.kind === "rebase"
          ? "Local commits that would be rewritten"
          : proposal.kind === "force-push" || proposal.kind === "push"
            ? "Local commits that would be published"
            : "Local commits involved";
    parts.push(
      `${label} (${proposal.affectedTotal}):\n${commitLines(proposal.affectedCommits, proposal.affectedTotal)}`,
    );
  }
  if (proposal.incomingTotal) {
    const label =
      proposal.kind === "force-push"
        ? "Server commits that would be replaced"
        : proposal.kind === "rebase"
          ? "Target commits brought in"
          : "Commits brought in";
    parts.push(
      `${label} (${proposal.incomingTotal}):\n${commitLines(proposal.incomingCommits, proposal.incomingTotal)}`,
    );
  }
  return parts.join("\n\n");
}

/** One-line outcome text for a toast or banner. */
export function describeReviewGitOutcome(kind: string, outcome: ReviewGitOutcome): string {
  const result = outcome?.push ?? outcome;
  if (!result) return "";
  const head = String(result.message || result.status || "");
  if (outcome?.publish) {
    const publish = outcome.publish as { attempted: boolean; published: string[]; failed: Array<{ error: string }> };
    const tail = publish.attempted
      ? `${publish.published.length} comment${publish.published.length === 1 ? "" : "s"} published${
          publish.failed.length ? `, ${publish.failed.length} failed (${publish.failed[0].error})` : ""
        }.`
      : "No comments were published.";
    return `${head} ${tail}`.trim();
  }
  return head || kind;
}

export function createReviewGitOperations(ctx: ReviewGitOperationsCtx) {
  /** Everything this renderer saw end, by operation id — the live event can beat the start call's response. */
  const finished = new Map<string, ReviewGitOperationEvent>();
  const waiters = new Map<string, Array<(event: ReviewGitOperationEvent) => void>>();
  /** Operations this renderer started and is awaiting; their outcome belongs to the caller, not a notification. */
  const owned = new Set<string>();
  const notifiedInMemory = new Set<string>();
  /**
   * While a start call is awaiting its response, an operation id this renderer
   * will own is not yet known — and a quick operation's result event can beat
   * the response. Outcomes seen in that window are judged once the response is in.
   */
  let startsInFlight = 0;
  const deferredNotifications: Array<{ event: ReviewGitOperationEvent; late: boolean }> = [];

  function announce(event: ReviewGitOperationEvent, late: boolean): void {
    if (startsInFlight > 0) {
      deferredNotifications.push({ event, late });
      return;
    }
    notifyForeign(event, { late });
  }

  function flushDeferred(): void {
    for (const { event, late } of deferredNotifications.splice(0)) notifyForeign(event, { late });
  }

  function remember(event: ReviewGitOperationEvent): void {
    finished.delete(event.operationId);
    finished.set(event.operationId, event);
    while (finished.size > FINISHED_MEMORY) {
      const oldest = finished.keys().next().value;
      if (oldest === undefined) break;
      finished.delete(oldest);
    }
  }

  function settle(event: ReviewGitOperationEvent): void {
    if (event.state === "running") return;
    remember(event);
    const pending = waiters.get(event.operationId);
    if (pending) {
      waiters.delete(event.operationId);
      for (const resolve of pending) resolve(event);
    }
  }

  /**
   * An operation started from somewhere else — another window, a phone, a
   * reload — still has an outcome worth showing. One Notification Center entry
   * per operation per client; an agent's operations are reported to the agent.
   */
  function notifyForeign(event: ReviewGitOperationEvent, { late }: { late: boolean }): void {
    if (event.source !== "ui" || owned.has(event.operationId)) return;
    if (notifiedInMemory.has(event.operationId)) return;
    if (event.profileId !== ctx.myActiveProfileId.value) return;
    notifiedInMemory.add(event.operationId);
    if (late && loadNotified().includes(event.operationId)) return;
    rememberNotified(event.operationId);
    const failed = event.state === "failed";
    const notifications = useNotificationStore();
    const workspace = ctx.payload.value?.appState?.workspaces?.find((ws) => ws.id === event.workspaceId);
    const title = failed ? `Git ${event.kind} failed` : `Git ${event.kind} finished`;
    const result = event.result as AnyApi;
    const gate = result?.push ?? result;
    const blocked = !failed && (gate?.status === "blocked" || gate?.status === "confirm-required");
    const body = failed ? String(event.error || "") : describeReviewGitOutcome(event.kind, result);
    const { event: entry, inserted } = notifications.addAlertEvent({
      title,
      body,
      kind: failed || blocked ? "error" : "completed",
      tier: 2,
      urgency: failed ? "urgent" : "normal",
      workspaceId: event.workspaceId,
      workspaceName: workspace?.name || "Review",
      category: "review-git",
      meta: { profileId: event.profileId, operationId: event.operationId },
      sourceAlertId: `review-git:${event.operationId}`,
      occurredAt: event.finishedAt || new Date().toISOString(),
    });
    if (!inserted) return;
    if (!notifications.pinned) notifications.pushToast({ ...entry, category: "review-git" });
    fireNotificationAlert(entry.title, entry.body, {
      tier: 2,
      urgency: failed ? "urgent" : "normal",
      sessionKey: `review-git:${event.workspaceId}`,
      dedupeKey: `review-git:${event.operationId}`,
    });
  }

  /** The live event from the runtime. */
  function reportOperation(raw: unknown): void {
    const parsed = reviewGitOperationEventSchema.safeParse(raw);
    if (!parsed.success) return;
    settle(parsed.data);
    announce(parsed.data, false);
  }

  /** The payload's `reviewGit` (running + last runs): covers an event this client was not connected for. */
  function reconcilePayload(state: unknown): void {
    const runs = (state as { lastRuns?: unknown } | null | undefined)?.lastRuns;
    if (!Array.isArray(runs)) return;
    for (const run of runs) {
      const parsed = reviewGitOperationEventSchema.safeParse(run);
      if (!parsed.success) continue;
      settle(parsed.data);
      announce(parsed.data, true);
    }
  }

  function runningFor(workspaceId: string): ReviewGitOperationEvent[] {
    const running = (ctx.payload.value as AnyApi)?.reviewGit?.running;
    return Array.isArray(running)
      ? (running as ReviewGitOperationEvent[]).filter((operation) => operation.workspaceId === workspaceId)
      : [];
  }

  /** Backend state, not a local flag: an operation started from the phone spins on the desktop too. */
  function isBusy(workspaceId: string, kinds?: string[]): boolean {
    return runningFor(workspaceId).some((operation) => !kinds || kinds.includes(operation.kind));
  }

  function waitFor(operationId: string): Promise<ReviewGitOperationEvent> {
    const known = finished.get(operationId);
    if (known) return Promise.resolve(known);
    // The payload may already carry the outcome (the event came first).
    reconcilePayload((ctx.payload.value as AnyApi)?.reviewGit);
    const afterReconcile = finished.get(operationId);
    if (afterReconcile) return Promise.resolve(afterReconcile);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(operationId);
        reject(new Error("Lost track of the Git operation. It may still be running — check the Git tab."));
      }, WAIT_LIMIT_MS);
      const list = waiters.get(operationId) || [];
      list.push((event) => {
        clearTimeout(timer);
        resolve(event);
      });
      waiters.set(operationId, list);
    });
  }

  async function runOnce(
    kind: ReviewGitOperationKind,
    workspaceId: string,
    confirmation?: { proposalId: string },
  ): Promise<ReviewGitOutcome> {
    const api = ctx.getApi() as CallableTransport;
    startsInFlight += 1;
    let started: { operationId: string };
    try {
      started = await api.startReviewGitOperation({
        kind,
        workspaceId,
        ...(confirmation ? { confirmation } : {}),
      });
      owned.add(started.operationId);
    } finally {
      startsInFlight -= 1;
      if (startsInFlight === 0) flushDeferred();
    }
    try {
      const event = await waitFor(started.operationId);
      if (event.state === "failed") throw new Error(event.error || "The Git operation failed.");
      return event.result;
    } finally {
      // Keep it owned a moment longer than the settle so the live event that
      // resolved it cannot also raise a notification for the same run.
      setTimeout(() => owned.delete(started.operationId), 5_000);
    }
  }

  /**
   * Start an operation and wait for its outcome. A confirmation-required
   * outcome opens the runtime's own proposal in a dialog; accepting submits the
   * continuation bound to that proposal, and a proposal the repository outgrew
   * in the meantime comes back as a fresh one to decide on again.
   */
  async function run(
    kind: ReviewGitOperationKind,
    workspaceId: string,
    { confirm = true }: { confirm?: boolean } = {},
  ): Promise<ReviewGitOutcome> {
    let confirmation: { proposalId: string } | undefined;
    let outcome: ReviewGitOutcome = null;
    for (let round = 0; round < MAX_CONFIRM_ROUNDS; round += 1) {
      outcome = await runOnce(kind, workspaceId, confirmation);
      const gate = outcome?.push ?? outcome;
      if (gate?.status !== "confirm-required" || !confirm) return outcome;
      const proposal = gate.proposal as ReviewGitProposalView;
      const accepted = await ctx.confirmInApp({
        title: proposal.title,
        message: (gate.stale ? "The repository changed while you were deciding.\n\n" : "") + describeProposal(proposal),
        confirmLabel: proposal.choices.find((choice) => choice.id === "proceed")?.label || "Continue",
        cancelLabel: proposal.choices.some((choice) => choice.id === "keep") ? "Keep as is" : "Cancel",
        danger: proposal.kind === "reset" || proposal.kind === "force-push",
      });
      if (!accepted) {
        return { status: "cancelled", message: "Cancelled — nothing was changed.", declined: proposal };
      }
      confirmation = { proposalId: proposal.proposalId };
    }
    return outcome;
  }

  return { run, isBusy, runningFor, reportOperation, reconcilePayload };
}

export type ReviewGitOperations = ReturnType<typeof createReviewGitOperations>;
