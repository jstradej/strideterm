import fs from "node:fs/promises";
import path from "node:path";
import type { AppState, WorkspaceState } from "../../shared/types/state.js";
import {
  REVIEW_GIT_OPERATION_CHANNEL,
  type ReviewGitOperationEvent,
  type ReviewGitOperationKind,
  type ReviewGitState,
} from "../../shared/review-git-events.js";
import { reviewSourceIdentityKey, sourceBranchName } from "../../shared/review-source-identity.js";
import { digest, inspectCheckout, listCommits, lsRemoteRef, type GitRun } from "./inspect.js";
import { managedReviewBranchAlias } from "./engine.js";
import { sharedReviewGitLocks, type ReviewGitLocks } from "./locks.js";
import {
  REVIEW_GIT_OPERATION_RETENTION_MS,
  createReviewGitOperationRegistry,
  type ReviewGitOperationRecord,
  type ReviewGitOperationRegistry,
} from "./operations.js";
import type { ReviewGitConfirmation, ReviewGitRequester, ReviewGitResult } from "./types.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyManager = any;

const MAX_DIFF_BYTES = 120_000;
const MAX_CONFLICT_FILE_BYTES = 60_000;
const MAX_LOG = 100;

export interface ReviewGitServiceCtx {
  getState: () => AppState;
  azure: AnyManager;
  github: AnyManager;
  reviewBridgeStore: AnyManager;
  refreshGit: (workspaceId?: string | null) => Promise<void>;
  refreshAzure: () => Promise<unknown>;
  refreshGitHub: () => Promise<unknown>;
  broadcastState: () => void;
  emit: (channel: string, payload: unknown) => void;
  /** The audit stores a review operation may have written to. */
  auditStores: {
    azure?: AnyManager;
    github?: AnyManager;
    system?: AnyManager;
  };
  log: {
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
    error(message: string, meta?: Record<string, unknown>): void;
  };
  locks?: ReviewGitLocks;
  now?: () => number;
}

export interface ReviewGitCaller {
  profileId: string;
  requester: ReviewGitRequester;
}

export interface ReviewGitStartInput {
  kind: ReviewGitOperationKind;
  workspaceId: string;
  idempotencyKey?: string;
  confirmation?: ReviewGitConfirmation;
  paths?: string[];
  message?: string;
}

interface Located {
  workspace: WorkspaceState;
  provider: "azure-devops" | "github";
  manager: AnyManager;
  profileId: string;
}

export type ReviewGitReadInput =
  | { operation: "identity" }
  | { operation: "status" }
  | { operation: "refs"; query?: boolean }
  | { operation: "diff"; scope: "worktree" | "staged" | "head-vs-target" | "head-vs-source"; path?: string }
  | { operation: "history"; range: "head" | "head-vs-target" | "head-vs-source"; limit?: number }
  | { operation: "conflicts" }
  | { operation: "checks" }
  | { operation: "audit-log"; limit?: number; category?: "read" | "write"; operationName?: string };

export interface ReviewGitCommitAnchor {
  commentKey: string;
  filePath: string;
  lineNumber: number;
}

export function createReviewGitService(ctx: ReviewGitServiceCtx) {
  const now = ctx.now ?? (() => Date.now());
  const locks = ctx.locks ?? sharedReviewGitLocks;

  const toEvent = (record: ReviewGitOperationRecord): ReviewGitOperationEvent => ({
    operationId: record.operationId,
    profileId: record.profileId,
    workspaceId: record.workspaceId,
    kind: record.kind,
    source: record.source,
    state: record.state,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    ...(record.state === "failed" ? { error: record.error || "The operation failed." } : {}),
    ...(record.state === "succeeded" ? { result: record.result ?? null } : {}),
  });

  const operations: ReviewGitOperationRegistry = createReviewGitOperationRegistry({
    now,
    onChange(record) {
      try {
        ctx.broadcastState();
        if (record.state !== "running") ctx.emit(REVIEW_GIT_OPERATION_CHANNEL, toEvent(record));
      } catch (error) {
        ctx.log.error("review git operation result could not be published", {
          operationId: record.operationId,
          err: (error as Error)?.message || String(error),
        });
      }
    },
  });

  function managerFor(workspace: WorkspaceState): { provider: Located["provider"]; manager: AnyManager } {
    const provider = workspace.review?.provider;
    if (provider === "github") return { provider, manager: ctx.github };
    if (provider === "azure-devops") return { provider, manager: ctx.azure };
    throw new Error("This workspace is not linked to a supported pull request provider.");
  }

  /** Profile-aware lookup: the workspace must exist, be PR-linked, and belong to the caller's profile. */
  function locate(workspaceId: string, profileId: string): Located {
    const workspace = ctx.getState().workspaces.find((item) => item.id === workspaceId);
    if (!workspace?.review?.prKey) throw new Error("Review workspace not found.");
    const workspaceProfile = workspace.profileId || "default";
    if (workspaceProfile !== profileId) {
      throw new Error(`Cross-profile refused: workspace ${workspaceId} is not in profile ${profileId}.`);
    }
    return { workspace, ...managerFor(workspace), profileId: workspaceProfile };
  }

  const gitRunFor =
    (manager: AnyManager): GitRun =>
    (cwd, args, auth) =>
      manager.runGit(cwd, args, { login: auth?.login, token: auth?.token });

  /** Stale inline anchors after a history rewrite: mark, never move. */
  async function revalidateAnchors(located: Located): Promise<void> {
    const { workspace, manager } = located;
    const prKey = workspace.review?.prKey;
    if (!prKey || !ctx.reviewBridgeStore?.markStaleAnchors) return;
    const run = gitRunFor(manager);
    try {
      await ctx.reviewBridgeStore.markStaleAnchors(prKey, async (anchor: ReviewGitCommitAnchor) => {
        const spec = `HEAD:${anchor.filePath.replace(/\\/gu, "/")}`;
        const content = await run(workspace.cwd, ["show", spec]).then(
          (out) => out.stdout,
          () => null,
        );
        if (content === null) return false;
        const lines = content.length === 0 ? 0 : content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
        return anchor.lineNumber <= lines;
      });
    } catch (error) {
      ctx.log.warn("inline comment anchors could not be revalidated", {
        workspaceId: workspace.id,
        err: (error as Error)?.message || String(error),
      });
    }
  }

  const rewritesHistory = (result: ReviewGitResult): boolean =>
    result.status === "reset" || result.status === "rebased";

  async function afterOperation(located: Located): Promise<void> {
    await ctx.refreshGit(located.workspace.id);
    if (located.provider === "github") await ctx.refreshGitHub();
    else await ctx.refreshAzure();
    ctx.broadcastState();
  }

  async function publishDrafts(located: Located, requester: ReviewGitRequester) {
    const { workspace, manager, provider } = located;
    const prKey = workspace.review!.prKey;
    const published: string[] = [];
    const failed: Array<{ commentKey: string; error: string }> = [];
    const run = async (entry: Record<string, unknown>) => {
      const commentKey = String(entry.commentKey || "");
      try {
        const comment = (entry.comment || {}) as { anchorStale?: boolean; filePath?: string; lineNumber?: number };
        if (comment.anchorStale) {
          throw new Error(
            `The inline anchor ${comment.filePath || ""}${comment.lineNumber ? `:${comment.lineNumber}` : ""} is stale after a history rewrite. Re-anchor or delete this comment, then publish again.`,
          );
        }
        if (provider === "github") {
          await manager.addPullRequestComment({
            prKey,
            body: entry.body,
            threadId: entry.remoteThreadId,
            filePath: comment.filePath,
            lineNumber: comment.lineNumber,
            lineSide: (entry.comment as { lineSide?: string } | undefined)?.lineSide,
          });
        } else {
          await manager.addPullRequestComment({
            prKey,
            content: entry.body,
            threadId: entry.remoteThreadId,
            parentCommentId: entry.parentCommentId || 0,
            filePath: comment.filePath,
            lineNumber: comment.lineNumber,
            lineSide: (entry.comment as { lineSide?: string } | undefined)?.lineSide,
          });
        }
        published.push(commentKey);
        return { publishedAt: new Date(now()).toISOString(), threadId: entry.remoteThreadId };
      } catch (error) {
        failed.push({ commentKey, error: (error as Error)?.message || String(error) });
        throw error;
      }
    };
    try {
      await ctx.reviewBridgeStore.syncPendingDrafts(prKey, run);
    } catch (error) {
      failed.push({ commentKey: "", error: (error as Error)?.message || String(error) });
    }
    ctx.log.info("review drafts published", { workspaceId: workspace.id, requester: requester.source });
    return { attempted: true, published, failed };
  }

  async function execute(
    kind: ReviewGitOperationKind,
    located: Located,
    input: ReviewGitStartInput,
    requester: ReviewGitRequester,
  ): Promise<unknown> {
    const { workspace, manager } = located;
    const common = { workspace, requester };
    const mcp = requester.source === "mcp";
    let result: ReviewGitResult;
    switch (kind) {
      case "fetch":
        result = await manager.fetchReviewWorkspace(common);
        break;
      case "refresh":
        result = await manager.syncReviewWorkspace({ ...common, confirmation: input.confirmation });
        break;
      case "rebase":
        result = await manager.rebaseReviewWorkspace({ ...common, confirmation: input.confirmation });
        break;
      case "push":
      case "force-push":
        result = await manager.pushReviewWorkspace({
          ...common,
          force: kind === "force-push",
          confirmation: input.confirmation,
          requireProposal: mcp,
        });
        break;
      case "push-and-publish": {
        const push = (await manager.pushReviewWorkspace({
          ...common,
          confirmation: input.confirmation,
          requireProposal: mcp,
        })) as ReviewGitResult;
        const pushed = push.status === "pushed" || push.status === "up-to-date";
        const publish = pushed
          ? await publishDrafts(located, requester)
          : { attempted: false, published: [] as string[], failed: [] as Array<{ commentKey: string; error: string }> };
        if (push.status === "pushed") await revalidateAnchors(located);
        await afterOperation(located);
        return { kind, push, publish };
      }
      case "stage":
      case "unstage":
      case "commit":
      case "continue":
      case "skip":
      case "abort": {
        const engine = manager.getReviewGitEngine();
        const subject = manager.buildReviewSubject(workspace);
        if (kind === "stage") result = await engine.stage(subject, requester, input.paths || [], input.confirmation);
        else if (kind === "unstage")
          result = await engine.unstage(subject, requester, input.paths || [], input.confirmation);
        else if (kind === "commit")
          result = await engine.commit(subject, requester, input.message || "", input.confirmation);
        else if (kind === "continue") result = await engine.continueOperation(subject, requester, input.confirmation);
        else if (kind === "skip") result = await engine.skipOperation(subject, requester, input.confirmation);
        else result = await engine.abortOperation(subject, requester, input.confirmation);
        break;
      }
      default:
        throw new Error(`Unsupported review Git operation: ${String(kind)}`);
    }
    if (rewritesHistory(result) || (kind === "continue" && result.status === "continued")) {
      await revalidateAnchors(located);
    }
    await afterOperation(located);
    return result;
  }

  /**
   * Validate and authorize synchronously (a throw is an immediate error for the
   * caller), start the work without awaiting it and answer at once. After the
   * start the run does not depend on the caller: it keeps going when the phone
   * session ends, the window switches profile, or an agent capability is revoked.
   */
  function start(input: ReviewGitStartInput, caller: ReviewGitCaller): { started: true; operationId: string } {
    const located = locate(input.workspaceId, caller.profileId);
    // Building the subject proves the connection and PAT exist before anything starts.
    located.manager.buildReviewSubject(located.workspace);
    if ((input.kind === "stage" || input.kind === "unstage") && !input.paths?.length) {
      throw new Error("At least one path is required.");
    }
    if (input.kind === "commit" && !String(input.message || "").trim()) {
      throw new Error("A commit message is required.");
    }
    const running = operations
      .running(located.profileId)
      .find(
        (record) =>
          record.workspaceId === located.workspace.id &&
          record.kind === input.kind &&
          !input.idempotencyKey &&
          !input.confirmation,
      );
    if (running) return { started: true, operationId: running.operationId };

    const requester: ReviewGitRequester = { ...caller.requester };
    const { operation } = operations.start({
      profileId: located.profileId,
      workspaceId: located.workspace.id,
      kind: input.kind,
      source: requester.source,
      idempotencyKey: input.idempotencyKey,
      run: () => execute(input.kind, located, input, { ...requester }),
    });
    return { started: true, operationId: operation.operationId };
  }

  function lookup(operationId: string, profileId: string, workspaceId?: string) {
    const found = operations.get(operationId, { profileId, workspaceId });
    if (!found.found) {
      return {
        status: "unavailable" as const,
        reason: found.reason,
        message:
          found.reason === "expired"
            ? "This operation finished more than 24 hours ago and its result is no longer kept."
            : "No such operation for this workspace.",
      };
    }
    const event = toEvent(found.operation);
    return { status: event.state, operation: event };
  }

  function stateFor(): ReviewGitState {
    const cutoff = now() - REVIEW_GIT_OPERATION_RETENTION_MS;
    const all = [...allProfiles()].map(toEvent);
    return {
      running: all.filter((event) => event.state === "running"),
      lastRuns: all.filter(
        (event) => event.state !== "running" && event.finishedAt && Date.parse(event.finishedAt) >= cutoff,
      ),
    };
  }

  function allProfiles(): ReviewGitOperationRecord[] {
    const profiles = new Set<string>();
    for (const workspace of ctx.getState().workspaces) profiles.add(workspace.profileId || "default");
    return [...profiles].flatMap((profileId) => operations.listForProfile(profileId));
  }

  // ---------------------------------------------------------------------------
  // Read tools
  // ---------------------------------------------------------------------------

  function clip(text: string, max = MAX_DIFF_BYTES): { text: string; truncated: boolean } {
    return text.length > max ? { text: text.slice(0, max), truncated: true } : { text, truncated: false };
  }

  function safeRelative(file: string): string {
    const normalized = String(file || "").replace(/\\/gu, "/");
    if (
      !normalized ||
      normalized.startsWith("/") ||
      /^[a-z]:/iu.test(normalized) ||
      normalized.split("/").includes("..")
    ) {
      throw new Error(`"${file}" is not a repository-relative path.`);
    }
    return normalized;
  }

  async function read(input: ReviewGitReadInput, workspaceId: string, profileId: string): Promise<unknown> {
    const located = locate(workspaceId, profileId);
    const { workspace, manager } = located;
    const review = workspace.review!;
    const run = gitRunFor(manager);
    const cwd = workspace.cwd;
    const sourceBranch = sourceBranchName(review.pullRequest?.sourceRefName);
    const targetBranch = String(review.pullRequest?.targetRefName || "").replace(/^refs\/heads\//u, "");
    const git = async (args: string[]) => (await run(cwd, args)).stdout;

    switch (input.operation) {
      case "identity":
        return {
          workspaceId: workspace.id,
          profileId,
          provider: review.provider,
          prKey: review.prKey,
          pullRequestId: review.pullRequest?.id ?? null,
          title: review.pullRequest?.title ?? "",
          role: review.role,
          targetRepository: review.repository
            ? { name: review.repository.name, remoteUrl: review.repository.remoteUrl }
            : null,
          sourceRepository: review.sourceRepository
            ? {
                fullName: review.sourceRepository.fullName,
                remoteUrl: review.sourceRepository.remoteUrl,
                sameAsTarget: review.sourceRepository.sameAsTarget,
                writableByConnection: review.sourceRepository.canPush,
              }
            : null,
          sourceRef: review.pullRequest?.sourceRefName,
          targetRef: review.pullRequest?.targetRefName,
          expectedLocalBranches: [
            managedReviewBranchAlias(review.pullRequest?.id ?? "", review.pullRequest?.sourceRefName || ""),
            sourceBranch,
          ],
          sourceBaselineSha: review.sourceBaselineSha || null,
          sourceIdentity: reviewSourceIdentityKey(review) || null,
          checkoutMode: review.checkout?.mode ?? null,
        };
      case "status": {
        const facts = await inspectCheckout(run, cwd);
        const conflicts = facts.operation ? await manager.getReviewGitEngine().conflictedPaths(cwd) : [];
        const aliases = [
          managedReviewBranchAlias(review.pullRequest?.id ?? "", review.pullRequest?.sourceRefName || ""),
          sourceBranch,
        ];
        return {
          headSha: facts.headSha,
          branch: facts.branch || null,
          detached: facts.detached,
          onPullRequestBranch: !facts.detached && aliases.includes(facts.branch),
          operationInProgress: facts.operation,
          conflictedPaths: conflicts,
          staged: facts.dirty.staged,
          unstaged: facts.dirty.unstaged,
          untracked: facts.dirty.untracked,
          conflicted: facts.dirty.conflicted,
          changedPaths: facts.dirty.paths.slice(0, 500),
          shallow: facts.shallow,
          sourceBaselineSha: review.sourceBaselineSha || null,
        };
      }
      case "refs": {
        const trackingSource = await git(["rev-parse", "--verify", "-q", `refs/remotes/origin/${sourceBranch}`]).then(
          (out) => out.trim(),
          () => "",
        );
        const trackingTarget = await git(["rev-parse", "--verify", "-q", `refs/remotes/origin/${targetBranch}`]).then(
          (out) => out.trim(),
          () => "",
        );
        const facts = await inspectCheckout(run, cwd);
        const subject = manager.buildReviewSubject(workspace);
        let live: { source: string | null; target: string | null } | undefined;
        if (input.query) {
          const remote = subject.sourceRepository?.remoteUrl || "origin";
          live = {
            source: await lsRemoteRef(run, cwd, remote, `refs/heads/${sourceBranch}`, subject.auth).catch(() => null),
            target: await lsRemoteRef(run, cwd, "origin", `refs/heads/${targetBranch}`, subject.auth).catch(() => null),
          };
        }
        return {
          headSha: facts.headSha,
          branch: facts.branch || null,
          sourceRef: review.pullRequest?.sourceRefName,
          targetRef: review.pullRequest?.targetRefName,
          trackingSourceSha: trackingSource || null,
          trackingTargetSha: trackingTarget || null,
          sourceBaselineSha: review.sourceBaselineSha || null,
          ...(live ? { live } : {}),
          note: "Tracking refs are local caches and can be stale; refresh/push re-query the live source.",
        };
      }
      case "diff": {
        const file = input.path ? safeRelative(input.path) : "";
        const pathArgs = file ? ["--", file] : [];
        const base = ["--literal-pathspecs", "diff", "--no-color", "--no-ext-diff"];
        let args: string[];
        if (input.scope === "worktree") args = [...base, ...pathArgs];
        else if (input.scope === "staged") args = [...base, "--cached", ...pathArgs];
        else if (input.scope === "head-vs-target")
          args = [...base, `refs/remotes/origin/${targetBranch}...HEAD`, ...pathArgs];
        else args = [...base, `refs/remotes/origin/${sourceBranch}...HEAD`, ...pathArgs];
        const out = clip(await git(args));
        return { scope: input.scope, path: file || null, diff: out.text, truncated: out.truncated };
      }
      case "history": {
        const limit = Math.min(Math.max(Number(input.limit) || 30, 1), MAX_LOG);
        const range =
          input.range === "head-vs-target"
            ? `refs/remotes/origin/${targetBranch}..HEAD`
            : input.range === "head-vs-source"
              ? `refs/remotes/origin/${sourceBranch}..HEAD`
              : "HEAD";
        const commits = await listCommits(run, cwd, range, limit);
        return { range: input.range, total: commits.total, commits: commits.commits };
      }
      case "conflicts": {
        const paths = await manager.getReviewGitEngine().conflictedPaths(cwd);
        const files = [];
        for (const file of paths.slice(0, 20)) {
          const absolute = path.join(cwd, safeRelative(file));
          const raw = await fs.readFile(absolute, "utf8").catch(() => "");
          const clipped = clip(raw, MAX_CONFLICT_FILE_BYTES);
          files.push({ path: file, content: clipped.text, truncated: clipped.truncated });
        }
        const facts = await inspectCheckout(run, cwd);
        return { operationInProgress: facts.operation, conflictedPaths: paths, files };
      }
      case "checks": {
        const summary = (manager.findSummary?.(review.prKey) || manager.snapshot?.pullRequests?.[review.prKey]) as
          { checks?: unknown } | undefined;
        return {
          prKey: review.prKey,
          checks: summary?.checks ?? null,
          note: "Read-only snapshot from the last provider sync.",
        };
      }
      case "audit-log": {
        const limit = Math.min(Math.max(Number(input.limit) || 20, 1), 100);
        const entries: Array<Record<string, unknown>> = [];
        const providerStore = located.provider === "github" ? ctx.auditStores.github : ctx.auditStores.azure;
        if (providerStore?.query) {
          const result = providerStore.query({
            connectionId: review.connectionId,
            resourceType: "git",
            resourceId: workspace.id,
            category: input.category,
            operation: input.operationName,
            limit,
          });
          entries.push(...(result.entries as Array<Record<string, unknown>>));
        }
        if (ctx.auditStores.system?.query) {
          const result = ctx.auditStores.system.query({
            connectionId: `system-${workspace.id}`,
            category: input.category,
            operation: input.operationName,
            limit,
          });
          entries.push(...(result.entries as Array<Record<string, unknown>>));
        }
        entries.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
        return {
          total: entries.length,
          entries: entries.slice(0, limit).map((entry) => ({
            timestamp: entry.timestamp,
            operation: entry.operation,
            category: entry.category,
            success: entry.success,
            errorMessage: entry.errorMessage,
            durationMs: entry.durationMs,
            summary: entry.summary,
            operationId: entry.operationId || undefined,
            details: parseDetails(entry.details),
            expectedRef: entry.expectedRef || undefined,
            previousRemoteRef: entry.previousRemoteRef || undefined,
            newRemoteRef: entry.newRemoteRef || undefined,
          })),
        };
      }
      default:
        throw new Error("Unsupported review Git read.");
    }
  }

  function parseDetails(raw: unknown): unknown {
    if (typeof raw !== "string" || !raw) return undefined;
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  }

  return {
    operations,
    locks,
    locate,
    start,
    lookup,
    read,
    stateFor,
    /** Digest of a workspace's PR/source identity, used to bind agent capabilities. */
    identityKeyFor(workspace: WorkspaceState): string {
      return reviewSourceIdentityKey(workspace.review) || digest(workspace.id, workspace.review?.prKey || "");
    },
  };
}

export type ReviewGitService = ReturnType<typeof createReviewGitService>;
