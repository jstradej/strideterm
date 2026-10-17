import type { ReviewCheckout, ReviewSourceRepository } from "../../shared/types/state.js";
import type { CommitSummary } from "./inspect.js";

/** Everything the engine needs to know about one PR-linked checkout. */
export interface ReviewGitSubject {
  workspaceId: string;
  profileId: string;
  cwd: string;
  provider: string;
  connectionId: string;
  prKey: string;
  prId: string | number;
  role: string;
  sourceRefName: string;
  targetRefName: string;
  sourceRepository: ReviewSourceRepository | null;
  /** The TARGET repository's clone URL (`review.repository.remoteUrl`). */
  targetRemoteUrl: string;
  baselineSha: string;
  checkout: ReviewCheckout | null;
  auth: { login?: string; token: string };
}

export interface ReviewGitRequester {
  source: "ui" | "mcp";
  agent?: string;
  panelId?: string;
  /** What the agent reported the user answered. Audit context only, never proof. */
  consent?: string;
  operationId?: string;
}

export type ReviewGitBlockCode =
  | "no-checkout"
  | "branch-mismatch"
  | "detached-head"
  | "dirty-tree"
  | "operation-in-progress"
  | "source-ref-deleted"
  | "source-unverified"
  | "source-repo-unsupported"
  | "source-not-writable"
  | "shallow-history"
  | "behind-remote"
  | "not-fast-forward"
  | "nothing-to-commit"
  | "conflicts-unresolved"
  | "no-operation"
  | "invalid-paths"
  | "audit-unavailable"
  | "recovery-ref-failed"
  | "stale";

export type ReviewGitProposalKind =
  "reset" | "rebase" | "push" | "force-push" | "stage" | "unstage" | "commit" | "continue" | "skip" | "abort";

export interface ReviewGitProposal {
  proposalId: string;
  kind: ReviewGitProposalKind;
  title: string;
  message: string;
  /** The repository facts this proposal pins; a continuation is refused if any of them changed. */
  facts: Record<string, string | number | boolean | string[] | null>;
  /** Local commits the action would discard or rewrite. */
  affectedCommits: CommitSummary[];
  affectedTotal: number;
  /** Remote or target commits the action would bring in or replace. */
  incomingCommits: CommitSummary[];
  incomingTotal: number;
  choices: Array<{ id: "proceed" | "keep" | "cancel"; label: string }>;
}

export interface ReviewGitConfirmation {
  proposalId: string;
}

export interface ReviewGitBase {
  message: string;
  headSha: string;
  previousHeadSha: string;
  /** Set when a successful integration or push could not be recorded as the new baseline. */
  baselineWarning?: string;
  operationId?: string;
}

export type ReviewGitResult =
  | (ReviewGitBase & { status: "blocked"; code: ReviewGitBlockCode; guidance?: string })
  | (ReviewGitBase & { status: "confirm-required"; proposal: ReviewGitProposal; stale?: boolean })
  | (ReviewGitBase & {
      status:
        | "already-current"
        | "updated"
        | "reset"
        | "ahead"
        | "rebased"
        | "pushed"
        | "up-to-date"
        | "fetched"
        | "staged"
        | "unstaged"
        | "committed"
        | "continued"
        | "skipped"
        | "aborted";
      commitCount?: number;
      discardedCount?: number;
      liveSha?: string;
      recoveryRef?: string;
      conflictedPaths?: string[];
    })
  | (ReviewGitBase & { status: "conflict"; conflictedPaths: string[]; operation: string });

export type ReviewGitStatus = ReviewGitResult["status"];
