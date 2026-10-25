import { randomUUID } from "node:crypto";
import {
  fullSourceRef,
  isManagedReviewBranch,
  managedReviewBranchAlias,
  normalizeRemoteIdentity,
  sameRemote,
  sanitizePathSegment,
  sourceBranchName,
} from "../../shared/review-source-identity.js";
import { stripRefsPrefix } from "../shared/provider-utils.js";
import {
  compareCommits,
  describeDirty,
  digest,
  hasCommit,
  inspectCheckout,
  listCommits,
  lsRemoteRef,
  type Ancestry,
  type CheckoutFacts,
  type GitRun,
} from "./inspect.js";
import { commonDirOf, type ReviewGitLocks } from "./locks.js";
import type {
  ReviewGitBlockCode,
  ReviewGitConfirmation,
  ReviewGitProposal,
  ReviewGitProposalKind,
  ReviewGitRequester,
  ReviewGitResult,
  ReviewGitSubject,
} from "./types.js";

export interface ReviewGitAuditEntry {
  operationId: string;
  kind: string;
  subject: ReviewGitSubject;
  requester: ReviewGitRequester;
  refs: Record<string, string>;
}

export interface ReviewGitAuditOutcome {
  success: boolean;
  outcome: string;
  errorMessage?: string;
  refs?: Record<string, string>;
}

/**
 * Durable audit trail. `begin` must persist the intent BEFORE a mutating
 * command and return null when it could not — the mutation is then refused.
 * `finish` records the outcome on the same row and returns false when that
 * write failed (the engine logs the gap; it never replays the mutation).
 */
export interface ReviewGitAudit {
  begin(entry: ReviewGitAuditEntry): unknown | null;
  finish(handle: unknown, outcome: ReviewGitAuditOutcome): boolean;
}

export interface ReviewGitEngineDeps {
  git: GitRun;
  locks: ReviewGitLocks;
  audit: ReviewGitAudit;
  /** Persist the source baseline (and lazily captured identity). Throws when the write failed. */
  persistBaseline(subject: ReviewGitSubject, sha: string): Promise<void>;
  log: {
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
  };
  now?: () => number;
}

interface SourceRemote {
  /** `origin` when the checkout's origin is verified to be the source repository, else the explicit URL. */
  target: string;
  viaOrigin: boolean;
}

interface Prepared {
  facts: CheckoutFacts;
  sourceBranch: string;
  fullRef: string;
  remote: SourceRemote;
  liveSha: string;
}

type Block = Extract<ReviewGitResult, { status: "blocked" }>;

const SHORT = 8;
const short = (sha: string) => (sha ? sha.slice(0, SHORT) : "none");

function proposalIdOf(
  subject: ReviewGitSubject,
  kind: ReviewGitProposalKind,
  facts: ReviewGitProposal["facts"],
): string {
  return digest(subject.workspaceId, subject.prKey, kind, JSON.stringify(facts));
}

export function createReviewGitEngine(deps: ReviewGitEngineDeps) {
  const { git, locks, audit, log } = deps;

  const baseResult = (facts: { headSha: string }, previousHeadSha: string, message: string, operationId?: string) => ({
    message,
    headSha: facts.headSha,
    previousHeadSha,
    ...(operationId ? { operationId } : {}),
  });

  function blocked(
    facts: { headSha: string },
    code: ReviewGitBlockCode,
    message: string,
    guidance?: string,
    operationId?: string,
  ): Block {
    return {
      status: "blocked",
      code,
      guidance,
      ...baseResult(facts, facts.headSha, message, operationId),
    };
  }

  function makeProposal(
    subject: ReviewGitSubject,
    kind: ReviewGitProposalKind,
    input: {
      title: string;
      message: string;
      facts: ReviewGitProposal["facts"];
      affected?: { commits: ReviewGitProposal["affectedCommits"]; total: number };
      incoming?: { commits: ReviewGitProposal["incomingCommits"]; total: number };
      proceedLabel: string;
      keepLabel?: string;
    },
  ): ReviewGitProposal {
    return {
      proposalId: proposalIdOf(subject, kind, input.facts),
      kind,
      title: input.title,
      message: input.message,
      facts: input.facts,
      affectedCommits: input.affected?.commits ?? [],
      affectedTotal: input.affected?.total ?? 0,
      incomingCommits: input.incoming?.commits ?? [],
      incomingTotal: input.incoming?.total ?? 0,
      choices: [
        { id: "proceed", label: input.proceedLabel },
        ...(input.keepLabel ? [{ id: "keep" as const, label: input.keepLabel }] : []),
        { id: "cancel", label: "Cancel" },
      ],
    };
  }

  const shown = (value: unknown): string => {
    if (value === null || value === undefined) return "none";
    if (Array.isArray(value)) return `[${value.map(shown).join(", ")}]`;
    return typeof value === "string" && /^[0-9a-f]{40,64}$/u.test(value) ? short(value) : String(value);
  };

  /** The pinned facts that differ from the ones the caller says it was shown. */
  function changedFacts(proposal: ReviewGitProposal, previous: ReviewGitConfirmation["facts"]): string[] {
    if (!previous) return [];
    const keys = new Set([...Object.keys(proposal.facts), ...Object.keys(previous)]);
    return [...keys].filter(
      (key) => JSON.stringify(proposal.facts[key] ?? null) !== JSON.stringify(previous[key] ?? null),
    );
  }

  function confirmRequired(
    facts: { headSha: string },
    proposal: ReviewGitProposal,
    confirmation: ReviewGitConfirmation | undefined,
    operationId?: string,
  ): ReviewGitResult {
    const stale = Boolean(confirmation?.proposalId) && confirmation!.proposalId !== proposal.proposalId;
    const changed = stale ? changedFacts(proposal, confirmation?.facts) : [];
    const changeNote = changed.length
      ? ` Changed since you were asked: ${changed
          .map((key) => `${key} ${shown(confirmation?.facts?.[key])} → ${shown(proposal.facts[key])}`)
          .join("; ")}.`
      : "";
    return {
      status: "confirm-required",
      proposal,
      ...(stale ? { stale: true } : {}),
      ...(changed.length ? { changedFacts: changed } : {}),
      ...baseResult(
        facts,
        facts.headSha,
        stale ? `The repository changed since you were asked.${changeNote} ${proposal.message}` : proposal.message,
        operationId,
      ),
    };
  }

  /**
   * Look at the checkout once more immediately before a mutating command. A
   * shell Git (or another tool) can write to the checkout between this call's
   * inspection and its command, and it cannot be locked out — so the facts the
   * decision was made on are proven again at the last moment, and a change
   * means nothing is done.
   */
  async function recheck(
    subject: ReviewGitSubject,
    facts: CheckoutFacts,
    { clean = false, status = false }: { clean?: boolean; status?: boolean } = {},
  ): Promise<Block | null> {
    const now = await inspectCheckout(git, subject.cwd);
    const moved =
      now.headSha !== facts.headSha ||
      now.branch !== facts.branch ||
      now.operation !== facts.operation ||
      (clean && now.dirty.total > 0) ||
      (status && now.dirty.digest !== facts.dirty.digest);
    if (!moved) return null;
    return blocked(
      now,
      "stale",
      "The checkout changed (HEAD, branch, working tree or a Git operation) after it was inspected. Nothing was changed.",
      "Inspect it again and retry.",
    );
  }

  /** The key every worktree of this repository shares, read from the filesystem — no Git process runs before a lock is held. */
  async function lockTargets(subject: ReviewGitSubject): Promise<{ commonDir: string }> {
    return { commonDir: await commonDirOf(subject.cwd) };
  }

  /**
   * Preflight shared by every PR-targeted operation: checkout/branch binding,
   * source identity, and (when `queryLive`) the exact live source tip, pinned
   * as an immutable SHA for the rest of the operation.
   */
  async function prepare(
    subject: ReviewGitSubject,
    options: { queryLive: boolean; requireWritable?: boolean; allowOperation?: boolean; local?: boolean },
  ): Promise<{ block: Block } | { prepared: Prepared }> {
    if (!subject.cwd) {
      return { block: blocked({ headSha: "" }, "no-checkout", "Review workspace has no working directory.") };
    }
    const facts = await inspectCheckout(git, subject.cwd);
    const sourceBranch = sourceBranchName(subject.sourceRefName);
    const fullRef = fullSourceRef(subject.sourceRefName);
    if (options.local) {
      // Local-only work (stage, commit, resolving a paused operation) acts on
      // whatever branch is checked out — it needs no source identity.
      if (!options.allowOperation && facts.operation) {
        return {
          block: blocked(
            facts,
            "operation-in-progress",
            `A ${facts.operation} is already in progress.`,
            "Continue or abort it before anything else.",
          ),
        };
      }
      return { prepared: { facts, sourceBranch, fullRef, remote: { target: "origin", viaOrigin: true }, liveSha: "" } };
    }
    if (subject.pullRequestClosed) {
      return {
        block: blocked(
          facts,
          "pull-request-closed",
          `This pull request is ${subject.pullRequestClosed}, so nothing is refreshed, rebased or pushed for it.`,
          "Your checkout and local work are untouched. Stage and commit still work; nothing is cleaned up for you.",
        ),
      };
    }
    if (subject.identityConflict) {
      return {
        block: blocked(
          facts,
          "source-identity-changed",
          `The pull request's source no longer matches what this workspace was linked to (${subject.identityConflict}).`,
          "Open the pull request again to rebuild the link; the saved baseline is dropped, local work is untouched.",
        ),
      };
    }
    if (!sourceBranch) {
      return {
        block: blocked(
          facts,
          "source-unverified",
          "The pull request's source branch is unknown.",
          "Refresh the pull request and try again.",
        ),
      };
    }
    if (facts.detached && !facts.operation) {
      return {
        block: blocked(
          facts,
          "detached-head",
          "HEAD is detached, so this checkout is not on the pull request's branch.",
          `Switch back to ${managedReviewBranchAlias(subject.prId, subject.sourceRefName)} or ${sourceBranch}.`,
        ),
      };
    }
    if (!options.allowOperation && facts.operation) {
      return {
        block: blocked(
          facts,
          "operation-in-progress",
          `A ${facts.operation} is already in progress.`,
          "Resolve it, then continue or abort it before anything else.",
        ),
      };
    }
    if (!facts.detached) {
      const alias = managedReviewBranchAlias(subject.prId, subject.sourceRefName);
      if (!isManagedReviewBranch(facts.branch, subject.prId, subject.sourceRefName) && facts.branch !== sourceBranch) {
        return {
          block: blocked(
            facts,
            "branch-mismatch",
            `This checkout is on "${facts.branch}", not on the pull request's branch.`,
            `Switch back to ${alias} or ${sourceBranch}, or detach the review link. General Git actions still work on "${facts.branch}".`,
          ),
        };
      }
    }

    const repo = subject.sourceRepository;
    if (!repo || (!repo.id && !repo.remoteUrl && !repo.fullName)) {
      return {
        block: blocked(
          facts,
          "source-unverified",
          "The pull request's source repository is unknown, so nothing can be verified against it.",
          "Refresh the pull request from its provider, then try again.",
        ),
      };
    }
    if (options.requireWritable) {
      if (!repo.sameAsTarget && repo.canPush !== true) {
        return {
          block: blocked(
            facts,
            "source-repo-unsupported",
            `This pull request comes from a different repository (${repo.fullName || repo.remoteUrl}) that is not verified writable.`,
            "Push to the source repository from your own shell, or ask its owner.",
          ),
        };
      }
      if (repo.canPush === false) {
        return {
          block: blocked(
            facts,
            "source-not-writable",
            "The connection has no write access to the pull request's source repository.",
          ),
        };
      }
    }

    const originMatches = sameRemote(facts.originUrl, repo.remoteUrl);
    const remote: SourceRemote = originMatches
      ? { target: "origin", viaOrigin: true }
      : { target: repo.remoteUrl, viaOrigin: false };
    if (!remote.target) {
      return {
        block: blocked(
          facts,
          "source-unverified",
          "The source repository has no clone URL, so the remote cannot be verified.",
        ),
      };
    }

    let liveSha = "";
    if (options.queryLive) {
      const live = await lsRemoteRef(git, subject.cwd, remote.target, fullRef, subject.auth).catch((error: Error) => {
        throw new Error(`Could not query the pull request source branch: ${error.message}`, { cause: error });
      });
      if (!live) {
        return {
          block: blocked(
            facts,
            "source-ref-deleted",
            `The source branch ${sourceBranch} no longer exists on the remote.`,
            "The pull request may be closed or its branch deleted. Local work is untouched.",
          ),
        };
      }
      liveSha = live;
      const fetchArgs = remote.viaOrigin
        ? ["fetch", "origin", `+${fullRef}:refs/remotes/origin/${sourceBranch}`]
        : ["fetch", remote.target, fullRef];
      await git(subject.cwd, fetchArgs, subject.auth);
      if (!(await hasCommit(git, subject.cwd, liveSha))) {
        await git(subject.cwd, ["fetch", remote.target, liveSha], subject.auth).catch(() => {});
      }
      if (!(await hasCommit(git, subject.cwd, liveSha))) {
        return {
          block: blocked(
            facts,
            "source-unverified",
            `The source commit ${short(liveSha)} could not be fetched, so it cannot be verified.`,
          ),
        };
      }
    }
    return { prepared: { facts, sourceBranch, fullRef, remote, liveSha } };
  }

  async function createRecoveryRef(subject: ReviewGitSubject, headSha: string): Promise<string> {
    const stamp = new Date((deps.now ?? Date.now)()).toISOString().replace(/[-:.TZ]/gu, "");
    const ref = `refs/strideterm/recovery/${sanitizePathSegment(subject.workspaceId)}/${stamp}-${short(headSha)}`;
    await git(subject.cwd, ["update-ref", ref, headSha]);
    return ref;
  }

  async function recordBaseline(subject: ReviewGitSubject, sha: string): Promise<string | undefined> {
    if (!sha || subject.baselineSha === sha) return undefined;
    try {
      await deps.persistBaseline(subject, sha);
      subject.baselineSha = sha;
      return undefined;
    } catch (error) {
      const message = (error as Error)?.message || String(error);
      log.warn("source baseline could not be saved", { workspaceId: subject.workspaceId, sha, err: message });
      return `The pull request source baseline could not be saved (${message}). It stays at its previous value, so later operations take the conservative path.`;
    }
  }

  /** Persist audit intent, run the mutation, record the outcome. A failed intent write blocks the mutation. */
  async function audited<T extends ReviewGitResult>(
    subject: ReviewGitSubject,
    requester: ReviewGitRequester,
    kind: string,
    facts: { headSha: string },
    refs: Record<string, string>,
    run: () => Promise<T>,
  ): Promise<ReviewGitResult> {
    const operationId = requester.operationId || randomUUID();
    const handle = audit.begin({ operationId, kind, subject, requester: { ...requester, operationId }, refs });
    if (handle === null || handle === undefined) {
      return blocked(
        facts,
        "audit-unavailable",
        "The audit trail could not be written, so this change was not made.",
        "Check the strideterm log for the audit store error.",
        operationId,
      );
    }
    let result: ReviewGitResult;
    try {
      result = await run();
    } catch (error) {
      const message = (error as Error)?.message || String(error);
      if (!audit.finish(handle, { success: false, outcome: "failed", errorMessage: message, refs })) {
        log.warn("audit outcome could not be recorded", { operationId, kind, outcome: "failed" });
      }
      throw error;
    }
    const success = result.status !== "blocked" && result.status !== "confirm-required";
    if (!audit.finish(handle, { success, outcome: result.status, refs: { ...refs, headSha: result.headSha } })) {
      log.warn("audit outcome could not be recorded", { operationId, kind, outcome: result.status });
      result.message = `${result.message} (The audit outcome could not be recorded; the repository state above is authoritative.)`;
    }
    return { ...result, operationId };
  }

  async function withLocks<T>(subject: ReviewGitSubject, fn: () => Promise<T>): Promise<T> {
    const { commonDir } = await lockTargets(subject);
    return locks.withBoth(commonDir, subject.cwd, fn);
  }

  // ---------------------------------------------------------------------------
  // Fetch
  // ---------------------------------------------------------------------------

  async function fetch(subject: ReviewGitSubject, requester: ReviewGitRequester): Promise<ReviewGitResult> {
    const { commonDir } = await lockTargets(subject);
    return locks.withCommon(commonDir, async () => {
      const facts = await inspectCheckout(git, subject.cwd);
      const operationId = requester.operationId || randomUUID();
      const handle = audit.begin({
        operationId,
        kind: "fetch",
        subject,
        requester: { ...requester, operationId },
        refs: {},
      });
      try {
        await git(subject.cwd, ["fetch", "origin"], subject.auth);
        if (handle) audit.finish(handle, { success: true, outcome: "fetched" });
      } catch (error) {
        if (handle) audit.finish(handle, { success: false, outcome: "failed", errorMessage: (error as Error).message });
        throw error;
      }
      return { status: "fetched", ...baseResult(facts, facts.headSha, "Fetched the remote.", operationId) };
    });
  }

  // ---------------------------------------------------------------------------
  // Refresh
  // ---------------------------------------------------------------------------

  async function refresh(
    subject: ReviewGitSubject,
    requester: ReviewGitRequester,
    confirmation?: ReviewGitConfirmation,
  ): Promise<ReviewGitResult> {
    return withLocks(subject, async () => {
      const result = await prepare(subject, { queryLive: true });
      if ("block" in result) return result.block;
      const { facts, sourceBranch, liveSha } = result.prepared;
      const head = facts.headSha;
      const relation = await compareCommits(git, subject.cwd, head, liveSha, { shallow: facts.shallow });

      if (relation === "equal") {
        const warning = await recordBaseline(subject, liveSha);
        return {
          status: "already-current",
          ...baseResult(facts, head, "Already up to date."),
          liveSha,
          ...(warning ? { baselineWarning: warning } : {}),
        };
      }

      if (facts.dirty.total > 0) {
        return blocked(
          facts,
          "dirty-tree",
          `Cannot update: ${describeDirty(facts.dirty)} in the worktree.`,
          "Commit, stash, or discard the changes, then try again. Nothing is stashed automatically.",
        );
      }

      const refs = { headSha: head, liveSha, baselineSha: subject.baselineSha, sourceRef: result.prepared.fullRef };

      if (relation === "behind") {
        return audited(subject, requester, "sync-merge", facts, refs, async () => {
          const changed = await recheck(subject, facts, { clean: true });
          if (changed) return changed;
          const behind = await listCommits(git, subject.cwd, `${head}..${liveSha}`, 1);
          await git(subject.cwd, ["merge", "--ff-only", liveSha]);
          const headSha = (await git(subject.cwd, ["rev-parse", "HEAD"])).stdout.trim();
          const warning = await recordBaseline(subject, liveSha);
          return {
            status: "updated" as const,
            ...baseResult(
              { headSha },
              head,
              `Updated ${behind.total} commit${behind.total !== 1 ? "s" : ""} from ${sourceBranch}.`,
            ),
            commitCount: behind.total,
            liveSha,
            ...(warning ? { baselineWarning: warning } : {}),
          };
        });
      }

      const provenUnchanged = Boolean(subject.baselineSha) && subject.baselineSha === head;
      if (provenUnchanged) {
        return resetOntoLive(subject, requester, facts, liveSha, sourceBranch, refs, "baseline");
      }

      if (relation === "ahead") {
        const warning = subject.baselineSha ? undefined : await recordBaseline(subject, liveSha);
        const ahead = await listCommits(git, subject.cwd, `${liveSha}..${head}`, 1);
        return {
          status: "ahead",
          ...baseResult(
            facts,
            head,
            `Local branch is ${ahead.total} commit${ahead.total !== 1 ? "s" : ""} ahead of ${sourceBranch}. Nothing to fast-forward — push to publish them.`,
          ),
          liveSha,
          ...(warning ? { baselineWarning: warning } : {}),
        };
      }

      if (relation === "unknown") {
        return blocked(
          facts,
          "shallow-history",
          "The commit history needed to compare this checkout with the pull request is not available (shallow clone or missing objects).",
          "Fetch the full history (git fetch --unshallow), then try again.",
        );
      }

      const [discarded, incoming] = await Promise.all([
        listCommits(git, subject.cwd, `${liveSha}..${head}`),
        listCommits(git, subject.cwd, `${head}..${liveSha}`),
      ]);
      const proposal = makeProposal(subject, "reset", {
        title: "Reset onto the rewritten pull request branch?",
        message:
          `The pull request branch ${sourceBranch} no longer contains this checkout's HEAD ${short(head)}. ` +
          `Resetting onto ${short(liveSha)} would discard ${discarded.total} local commit${discarded.total !== 1 ? "s" : ""} from this checkout's history ` +
          `(a recovery ref to ${short(head)} is created first).` +
          (subject.baselineSha
            ? ` Last integrated source commit: ${short(subject.baselineSha)}.`
            : " No integrated source commit is on record."),
        facts: { headSha: head, liveSha, baselineSha: subject.baselineSha || null },
        affected: { commits: discarded.commits, total: discarded.total },
        incoming: { commits: incoming.commits, total: incoming.total },
        proceedLabel: "Discard local commits and reset",
        keepLabel: "Keep local",
      });
      if (confirmation?.proposalId !== proposal.proposalId) return confirmRequired(facts, proposal, confirmation);
      return resetOntoLive(subject, requester, facts, liveSha, sourceBranch, refs, "confirmed");
    });
  }

  async function resetOntoLive(
    subject: ReviewGitSubject,
    requester: ReviewGitRequester,
    facts: CheckoutFacts,
    liveSha: string,
    sourceBranch: string,
    refs: Record<string, string>,
    basis: "baseline" | "confirmed",
  ): Promise<ReviewGitResult> {
    const head = facts.headSha;
    return audited(subject, requester, "sync-reset", facts, { ...refs, basis }, async () => {
      const changed = await recheck(subject, facts, { clean: true });
      if (changed) return changed;
      let recoveryRef: string;
      try {
        recoveryRef = await createRecoveryRef(subject, head);
      } catch (error) {
        return blocked(
          facts,
          "recovery-ref-failed",
          `A recovery ref for ${short(head)} could not be created, so nothing was reset (${(error as Error).message}).`,
        );
      }
      const discarded = await listCommits(git, subject.cwd, `${liveSha}..${head}`, 1);
      const incoming = await listCommits(git, subject.cwd, `${head}..${liveSha}`, 1);
      await git(subject.cwd, ["reset", "--hard", liveSha]);
      const headSha = (await git(subject.cwd, ["rev-parse", "HEAD"])).stdout.trim();
      const warning = await recordBaseline(subject, liveSha);
      log.info("review checkout reset onto rewritten PR branch", {
        workspaceId: subject.workspaceId,
        basis,
        discarded: discarded.total,
        gained: incoming.total,
        previousHeadSha: head,
        headSha,
        recoveryRef,
      });
      return {
        status: "reset" as const,
        ...baseResult(
          { headSha },
          head,
          `The PR branch was rewritten. Reset onto ${sourceBranch} (${short(liveSha)}), leaving ${discarded.total} superseded commit${discarded.total !== 1 ? "s" : ""} behind${recoveryRef ? ` (recoverable at ${recoveryRef})` : ""}.`,
        ),
        commitCount: incoming.total,
        discardedCount: discarded.total,
        liveSha,
        recoveryRef,
        ...(warning ? { baselineWarning: warning } : {}),
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Rebase onto the PR target
  // ---------------------------------------------------------------------------

  async function rebase(
    subject: ReviewGitSubject,
    requester: ReviewGitRequester,
    confirmation?: ReviewGitConfirmation,
  ): Promise<ReviewGitResult> {
    return withLocks(subject, async () => {
      const result = await prepare(subject, { queryLive: false });
      if ("block" in result) return result.block;
      const { facts } = result.prepared;
      const head = facts.headSha;
      const targetBranch = stripRefsPrefix(subject.targetRefName);
      if (!targetBranch) {
        return blocked(facts, "source-unverified", "The pull request's target branch is unknown.");
      }
      if (facts.dirty.total > 0) {
        return blocked(
          facts,
          "dirty-tree",
          `Cannot rebase: ${describeDirty(facts.dirty)} in the worktree.`,
          "Commit, stash, or discard the changes first. Nothing is stashed automatically.",
        );
      }

      const targetRef = `refs/heads/${targetBranch}`;
      // The TARGET repository is whatever the provider says it is — `origin` only
      // when origin verifiably is it (an attached checkout may sit in a fork).
      const viaOrigin = !subject.targetRemoteUrl || sameRemote(facts.originUrl, subject.targetRemoteUrl);
      const targetRemote = viaOrigin ? "origin" : subject.targetRemoteUrl;
      const targetSha = await lsRemoteRef(git, subject.cwd, targetRemote, targetRef, subject.auth).catch(() => null);
      if (!targetSha) {
        return blocked(
          facts,
          "source-unverified",
          `The target branch ${targetBranch} could not be resolved on the remote.`,
        );
      }
      await git(
        subject.cwd,
        viaOrigin
          ? ["fetch", "origin", `+${targetRef}:refs/remotes/origin/${targetBranch}`]
          : ["fetch", targetRemote, targetRef],
        subject.auth,
      );
      if (!(await hasCommit(git, subject.cwd, targetSha))) {
        return blocked(facts, "source-unverified", `The target commit ${short(targetSha)} could not be fetched.`);
      }

      const relation = await compareCommits(git, subject.cwd, head, targetSha, { shallow: facts.shallow });
      if (relation === "equal" || relation === "ahead") {
        return {
          status: "up-to-date",
          ...baseResult(facts, head, `Already based on ${targetBranch} (${short(targetSha)}); nothing to rebase.`),
        };
      }
      if (relation === "unknown") {
        return blocked(
          facts,
          "shallow-history",
          "The history needed to rebase is not available (shallow clone or missing objects).",
        );
      }

      const [replayed, incoming] = await Promise.all([
        listCommits(git, subject.cwd, `${targetSha}..${head}`),
        listCommits(git, subject.cwd, `${head}..${targetSha}`),
      ]);
      const proposal = makeProposal(subject, "rebase", {
        title: `Rebase onto ${targetBranch}?`,
        message:
          `Rebase this checkout's ${replayed.total} local commit${replayed.total !== 1 ? "s" : ""} onto ${targetBranch} (${short(targetSha)}). ` +
          `Their hashes change (rewritten history, not lost code). This only rewrites the local branch; it does not push to the pull request's source branch.`,
        facts: { headSha: head, targetSha, targetRef },
        affected: { commits: replayed.commits, total: replayed.total },
        incoming: { commits: incoming.commits, total: incoming.total },
        proceedLabel: `Rebase onto ${targetBranch}`,
      });
      if (confirmation?.proposalId !== proposal.proposalId) return confirmRequired(facts, proposal, confirmation);

      return audited(subject, requester, "rebase", facts, { headSha: head, targetSha, targetRef }, async () => {
        const changed = await recheck(subject, facts, { clean: true });
        if (changed) return changed;
        try {
          await git(subject.cwd, ["-c", "core.editor=true", "rebase", targetSha], subject.auth);
        } catch (error) {
          const after = await inspectCheckout(git, subject.cwd);
          if (after.operation === "rebase") {
            return {
              status: "conflict" as const,
              operation: "rebase",
              conflictedPaths: await conflictedPaths(subject.cwd),
              ...baseResult(
                after,
                head,
                `Rebase onto ${targetBranch} stopped with conflicts. Resolve them, then continue or abort.`,
              ),
            };
          }
          throw error;
        }
        const headSha = (await git(subject.cwd, ["rev-parse", "HEAD"])).stdout.trim();
        return {
          status: "rebased" as const,
          ...baseResult(
            { headSha },
            head,
            `Rebased onto ${targetBranch} (${short(targetSha)}). The source branch is not updated until you push.`,
          ),
          commitCount: replayed.total,
        };
      });
    });
  }

  async function conflictedPaths(cwd: string): Promise<string[]> {
    const out = (await git(cwd, ["diff", "--name-only", "--diff-filter=U"])).stdout;
    return out.split(/\r?\n/u).filter(Boolean).sort();
  }

  // ---------------------------------------------------------------------------
  // Push / force push
  // ---------------------------------------------------------------------------

  async function push(
    subject: ReviewGitSubject,
    requester: ReviewGitRequester,
    options: { force?: boolean; confirmation?: ReviewGitConfirmation; requireProposal?: boolean } = {},
  ): Promise<ReviewGitResult> {
    const force = options.force === true;
    // An agent never pushes on its own say-so: its first call only describes the
    // push, and the continuation must name that exact proposal. The UI's Push
    // button is itself the explicit action, so it does not take this step.
    const requireProposal = options.requireProposal === true;
    return withLocks(subject, async () => {
      const result = await prepare(subject, { queryLive: true, requireWritable: true });
      if ("block" in result) return result.block;
      const { facts, sourceBranch, fullRef, remote, liveSha } = result.prepared;
      const head = facts.headSha;
      if (!head) return blocked(facts, "no-checkout", "There is nothing to push: the branch has no commits.");

      const relation = await compareCommits(git, subject.cwd, head, liveSha, { shallow: facts.shallow });
      if (relation === "equal") {
        const warning = subject.baselineSha ? undefined : await recordBaseline(subject, head);
        return {
          status: "up-to-date",
          ...baseResult(facts, head, `${sourceBranch} already points at ${short(head)}; nothing to push.`),
          liveSha,
          ...(warning ? { baselineWarning: warning } : {}),
        };
      }
      if (relation === "unknown") {
        return blocked(
          facts,
          "shallow-history",
          "The history needed to check that this push is safe is not available (shallow clone or missing objects).",
          "Fetch the full history (git fetch --unshallow), then try again.",
        );
      }
      const refs = { headSha: head, liveSha, baselineSha: subject.baselineSha, sourceRef: fullRef };

      if (!force) {
        if (relation === "behind") {
          return blocked(
            facts,
            "behind-remote",
            `${sourceBranch} has ${short(liveSha)}, which this checkout does not contain. Pushing would be rejected.`,
            "Refresh the checkout first.",
          );
        }
        if (relation === "diverged") {
          return blocked(
            facts,
            "not-fast-forward",
            `This checkout and ${sourceBranch} (${short(liveSha)}) have diverged, so a regular push would be rejected.`,
            "Force push replaces the remote branch and is a separate, explicit action.",
          );
        }
        if (requireProposal) {
          const outgoing = await listCommits(git, subject.cwd, `${liveSha}..${head}`);
          const proposal = makeProposal(subject, "push", {
            title: `Push to ${sourceBranch}?`,
            message: `Push ${outgoing.total} commit${outgoing.total !== 1 ? "s" : ""} (HEAD ${short(head)}) to ${sourceBranch} on the pull request's source repository (server at ${short(liveSha)}).`,
            facts: { headSha: head, liveSha },
            affected: { commits: outgoing.commits, total: outgoing.total },
            proceedLabel: "Push",
          });
          if (options.confirmation?.proposalId !== proposal.proposalId) {
            return confirmRequired(facts, proposal, options.confirmation);
          }
        }
      } else {
        const remoteOnly =
          relation === "ahead" ? { commits: [], total: 0 } : await listCommits(git, subject.cwd, `${head}..${liveSha}`);
        const serverMovedSinceBaseline = remoteOnly.total > 0 && liveSha !== subject.baselineSha;
        if (serverMovedSinceBaseline || requireProposal) {
          const local = await listCommits(git, subject.cwd, `${liveSha}..${head}`);
          const proposal = makeProposal(subject, "force-push", {
            title: serverMovedSinceBaseline
              ? "Force push over changes on the server?"
              : `Force push to ${sourceBranch}?`,
            message: serverMovedSinceBaseline
              ? `${sourceBranch} on the server has ${remoteOnly.total} commit${remoteOnly.total !== 1 ? "s" : ""} this checkout does not contain ` +
                `(server ${short(liveSha)}; last integrated ${short(subject.baselineSha)}; local ${short(head)}). ` +
                `A force push replaces them.`
              : `Force push HEAD ${short(head)} over ${sourceBranch} (server at ${short(liveSha)}, last integrated ${short(subject.baselineSha)}). ` +
                `The remote branch is replaced; the lease is the exact server commit above.`,
            facts: {
              headSha: head,
              liveSha,
              baselineSha: subject.baselineSha || null,
              serverMovedSinceBaseline,
            },
            affected: { commits: local.commits, total: local.total },
            incoming: { commits: remoteOnly.commits, total: remoteOnly.total },
            proceedLabel: serverMovedSinceBaseline ? "Force push and replace the server commits" : "Force push",
            keepLabel: serverMovedSinceBaseline ? "Keep server version" : undefined,
          });
          if (options.confirmation?.proposalId !== proposal.proposalId) {
            return confirmRequired(facts, proposal, options.confirmation);
          }
        }
      }

      const refspec = `${head}:refs/heads/${sourceBranch}`;
      const args = force
        ? ["push", `--force-with-lease=refs/heads/${sourceBranch}:${liveSha}`, remote.target, refspec]
        : ["push", remote.target, refspec];
      return audited(subject, requester, force ? "force-push" : "push", facts, refs, async () => {
        await git(subject.cwd, args, subject.auth);
        if (remote.viaOrigin) {
          await git(subject.cwd, ["update-ref", `refs/remotes/origin/${sourceBranch}`, head]).catch(() => {});
        }
        const warning = await recordBaseline(subject, head);
        return {
          status: "pushed" as const,
          ...baseResult(
            { headSha: head },
            head,
            `${force ? "Force pushed" : "Pushed"} ${short(head)} to ${sourceBranch}.`,
          ),
          liveSha,
          ...(warning ? { baselineWarning: warning } : {}),
        };
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Stage / unstage / commit / conflict resolution (checkout-level, MCP)
  // ---------------------------------------------------------------------------

  function validatePaths(paths: string[], changed: string[]): string | null {
    if (!paths.length) return "At least one path is required.";
    const known = new Set(changed);
    for (const entry of paths) {
      if (
        !entry ||
        entry.startsWith("/") ||
        /^[a-z]:/iu.test(entry) ||
        entry.split(/[\\/]/u).includes("..") ||
        entry.startsWith(":")
      ) {
        return `"${entry}" is not a repository-relative path.`;
      }
      if (!known.has(entry.replace(/\\/gu, "/"))) return `"${entry}" has no changes to stage or unstage.`;
    }
    return null;
  }

  async function stagePaths(
    subject: ReviewGitSubject,
    requester: ReviewGitRequester,
    kind: "stage" | "unstage",
    paths: string[],
    confirmation?: ReviewGitConfirmation,
  ): Promise<ReviewGitResult> {
    return withLocks(subject, async () => {
      const prepared = await prepare(subject, { queryLive: false, allowOperation: true, local: true });
      if ("block" in prepared) return prepared.block;
      const { facts } = prepared.prepared;
      const wanted = [...new Set(paths.map((entry) => entry.replace(/\\/gu, "/")))].sort();
      const problem = validatePaths(wanted, facts.dirty.paths);
      if (problem) return blocked(facts, "invalid-paths", problem);
      const proposal = makeProposal(subject, kind, {
        title: `${kind === "stage" ? "Stage" : "Unstage"} ${wanted.length} path${wanted.length !== 1 ? "s" : ""}?`,
        message: `${kind === "stage" ? "Stage" : "Unstage"}: ${wanted.join(", ")}.`,
        facts: { headSha: facts.headSha, paths: wanted, statusDigest: facts.dirty.digest },
        proceedLabel: kind === "stage" ? "Stage" : "Unstage",
      });
      if (confirmation?.proposalId !== proposal.proposalId) return confirmRequired(facts, proposal, confirmation);
      return audited(subject, requester, kind, facts, { headSha: facts.headSha }, async () => {
        const changed = await recheck(subject, facts, { status: true });
        if (changed) return changed;
        const args =
          kind === "stage"
            ? ["--literal-pathspecs", "add", "-A", "--", ...wanted]
            : facts.headSha
              ? ["--literal-pathspecs", "restore", "--staged", "--", ...wanted]
              : ["--literal-pathspecs", "rm", "--cached", "-r", "-q", "--", ...wanted];
        await git(subject.cwd, args);
        return {
          status: kind === "stage" ? ("staged" as const) : ("unstaged" as const),
          ...baseResult(
            facts,
            facts.headSha,
            `${kind === "stage" ? "Staged" : "Unstaged"} ${wanted.length} path${wanted.length !== 1 ? "s" : ""}.`,
          ),
        };
      });
    });
  }

  async function commit(
    subject: ReviewGitSubject,
    requester: ReviewGitRequester,
    message: string,
    confirmation?: ReviewGitConfirmation,
  ): Promise<ReviewGitResult> {
    return withLocks(subject, async () => {
      const prepared = await prepare(subject, { queryLive: false, local: true });
      if ("block" in prepared) return prepared.block;
      const { facts } = prepared.prepared;
      const text = String(message || "").trim();
      if (!text) return blocked(facts, "nothing-to-commit", "A commit message is required.");
      if (facts.dirty.staged === 0) {
        return blocked(facts, "nothing-to-commit", "Nothing is staged.", "Stage the intended paths first.");
      }
      const stagedDiff = (await git(subject.cwd, ["diff", "--cached", "--binary", "--no-ext-diff"])).stdout;
      const stat = (await git(subject.cwd, ["diff", "--cached", "--stat", "--no-ext-diff"])).stdout.trim();
      const proposal = makeProposal(subject, "commit", {
        title: "Commit the staged changes?",
        message: `Commit ${facts.dirty.staged} staged path${facts.dirty.staged !== 1 ? "s" : ""} with message "${text.split(/\r?\n/u)[0]}".\n${stat}`,
        facts: { headSha: facts.headSha, stagedDiffDigest: digest(stagedDiff), messageDigest: digest(text) },
        proceedLabel: "Commit",
      });
      if (confirmation?.proposalId !== proposal.proposalId) return confirmRequired(facts, proposal, confirmation);
      return audited(subject, requester, "commit", facts, { headSha: facts.headSha }, async () => {
        const changed = await recheck(subject, facts, { status: true });
        if (changed) return changed;
        await git(subject.cwd, ["commit", "-m", text]);
        const headSha = (await git(subject.cwd, ["rev-parse", "HEAD"])).stdout.trim();
        return {
          status: "committed" as const,
          ...baseResult({ headSha }, facts.headSha, `Committed ${short(headSha)}.`),
        };
      });
    });
  }

  async function resolveOperation(
    subject: ReviewGitSubject,
    requester: ReviewGitRequester,
    action: "continue" | "skip" | "abort",
    confirmation?: ReviewGitConfirmation,
  ): Promise<ReviewGitResult> {
    return withLocks(subject, async () => {
      const prepared = await prepare(subject, { queryLive: false, allowOperation: true, local: true });
      if ("block" in prepared) return prepared.block;
      const { facts } = prepared.prepared;
      if (!facts.operation)
        return blocked(facts, "no-operation", "No rebase, merge, cherry-pick or revert is in progress.");
      if (action === "skip" && facts.operation === "merge") {
        return blocked(facts, "no-operation", "A merge cannot be skipped; continue or abort it.");
      }
      const conflicts = await conflictedPaths(subject.cwd);
      if (action === "continue" && conflicts.length) {
        return blocked(
          facts,
          "conflicts-unresolved",
          `${conflicts.length} file${conflicts.length !== 1 ? "s are" : " is"} still conflicted: ${conflicts.join(", ")}.`,
          "Resolve and stage them, then continue.",
        );
      }
      const proposal = makeProposal(subject, action, {
        title: `${action[0].toUpperCase()}${action.slice(1)} the ${facts.operation}?`,
        message: `${action[0].toUpperCase()}${action.slice(1)} the ${facts.operation} in progress at ${short(facts.headSha)}${conflicts.length ? ` (conflicted: ${conflicts.join(", ")})` : ""}.`,
        facts: { operation: facts.operation, headSha: facts.headSha, statusDigest: facts.dirty.digest, conflicts },
        proceedLabel: action[0].toUpperCase() + action.slice(1),
      });
      if (confirmation?.proposalId !== proposal.proposalId) return confirmRequired(facts, proposal, confirmation);
      return audited(subject, requester, action, facts, { headSha: facts.headSha }, async () => {
        const changed = await recheck(subject, facts, { status: true });
        if (changed) return changed;
        const verb = facts.operation as string;
        try {
          await git(subject.cwd, ["-c", "core.editor=true", verb, `--${action}`]);
        } catch (error) {
          const after = await inspectCheckout(git, subject.cwd);
          if (after.operation && action !== "abort") {
            return {
              status: "conflict" as const,
              operation: after.operation,
              conflictedPaths: await conflictedPaths(subject.cwd),
              ...baseResult(
                after,
                facts.headSha,
                `The ${after.operation} stopped again. Resolve the conflicts, then continue or abort.`,
              ),
            };
          }
          throw error;
        }
        const after = await inspectCheckout(git, subject.cwd);
        if (after.operation && action !== "abort") {
          return {
            status: "conflict" as const,
            operation: after.operation,
            conflictedPaths: await conflictedPaths(subject.cwd),
            ...baseResult(after, facts.headSha, `The ${after.operation} stopped at the next conflict.`),
          };
        }
        const status = action === "continue" ? "continued" : action === "skip" ? "skipped" : "aborted";
        return { status, ...baseResult(after, facts.headSha, `${verb} ${status}.`) } as ReviewGitResult;
      });
    });
  }

  return {
    prepare,
    fetch,
    refresh,
    rebase,
    push,
    stage: (
      subject: ReviewGitSubject,
      requester: ReviewGitRequester,
      paths: string[],
      confirmation?: ReviewGitConfirmation,
    ) => stagePaths(subject, requester, "stage", paths, confirmation),
    unstage: (
      subject: ReviewGitSubject,
      requester: ReviewGitRequester,
      paths: string[],
      confirmation?: ReviewGitConfirmation,
    ) => stagePaths(subject, requester, "unstage", paths, confirmation),
    commit,
    continueOperation: (
      subject: ReviewGitSubject,
      requester: ReviewGitRequester,
      confirmation?: ReviewGitConfirmation,
    ) => resolveOperation(subject, requester, "continue", confirmation),
    skipOperation: (subject: ReviewGitSubject, requester: ReviewGitRequester, confirmation?: ReviewGitConfirmation) =>
      resolveOperation(subject, requester, "skip", confirmation),
    abortOperation: (subject: ReviewGitSubject, requester: ReviewGitRequester, confirmation?: ReviewGitConfirmation) =>
      resolveOperation(subject, requester, "abort", confirmation),
    conflictedPaths,
    /**
     * The live source tip when this checkout provably incorporates it (HEAD
     * equals it or contains it) — the only condition under which a missing
     * baseline may be initialized. Never persists; the caller decides where
     * the value goes. Null whenever proof is unavailable.
     */
    async proveBaseline(subject: ReviewGitSubject): Promise<string | null> {
      return withLocks(subject, async () => {
        const result = await prepare(subject, { queryLive: true, allowOperation: true });
        if ("block" in result) return null;
        const { facts, liveSha } = result.prepared;
        const relation = await compareCommits(git, subject.cwd, facts.headSha, liveSha, { shallow: facts.shallow });
        return relation === "equal" || relation === "ahead" ? liveSha : null;
      });
    },
  };
}

export type ReviewGitEngine = ReturnType<typeof createReviewGitEngine>;
export type { Ancestry };
export { normalizeRemoteIdentity };
export { managedReviewBranchAlias };
