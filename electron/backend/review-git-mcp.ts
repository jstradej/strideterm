/// <reference types="node" />
import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { REVIEW_GIT_CAPABILITY_ENV, REVIEW_GIT_URL_ENV } from "../shared/review-git-env.js";

export interface ReviewGitStdioConfig {
  url: string;
  capability: string;
}

export function readReviewGitStdioConfig(env: NodeJS.ProcessEnv = process.env): ReviewGitStdioConfig | null {
  const url = String(env[REVIEW_GIT_URL_ENV] || "").trim();
  const capability = String(env[REVIEW_GIT_CAPABILITY_ENV] || "").trim();
  if (!url || !capability) return null;
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol !== "http:" ||
      parsed.hostname !== "127.0.0.1" ||
      parsed.pathname !== "/review-git" ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      (parsed.port && Number(parsed.port) === 0)
    ) {
      return null;
    }
  } catch {
    return null;
  }
  if (!/^[A-Za-z0-9_-]{40,100}$/u.test(capability)) return null;
  return { url, capability };
}

const NOT_AVAILABLE =
  "Review Git is not available in this tab: it has no runtime grant (the tab was not started from its review workspace, or the grant was revoked). Restart the agent tab from the review workspace.";

const INLINE_WAIT_MS = 20_000;
const START_ATTEMPTS = 3;

interface OperationLookup {
  operationId: string;
  started?: boolean;
  status: "running" | "succeeded" | "failed" | "unavailable";
  operation?: { result?: unknown; error?: string; kind: string; startedAt: string; finishedAt: string | null };
  reason?: string;
  message?: string;
}

export function createReviewGitClient({
  config,
  fetchImpl = globalThis.fetch,
  retryDelayMs = 400,
}: {
  config: ReviewGitStdioConfig | null;
  fetchImpl?: typeof fetch;
  retryDelayMs?: number;
}) {
  async function send(payload: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (!config) throw new Error(NOT_AVAILABLE);
    const response = await fetchImpl(config.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.capability}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    });
    const body = (await response.json().catch(() => null)) as { result?: unknown; error?: { message?: string } } | null;
    if (!response.ok) throw new Error(body?.error?.message || `Review Git broker returned HTTP ${response.status}.`);
    return body?.result;
  }

  return {
    available: Boolean(config),
    read(payload: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
      return send(payload, signal);
    },
    /**
     * Start an operation. The idempotency key is minted once, BEFORE the first
     * attempt, and reused on every retry: when the acknowledgement is lost the
     * broker answers the retry with the operation the first attempt started
     * instead of starting a second one. Only a transport failure (no response
     * at all) is retried — an HTTP error means the broker decided.
     */
    async start(
      payload: { kind: string } & Record<string, unknown>,
      signal?: AbortSignal,
      waitMs = INLINE_WAIT_MS,
    ): Promise<OperationLookup> {
      const idempotencyKey = randomUUID();
      let lastError: unknown;
      for (let attempt = 1; attempt <= START_ATTEMPTS; attempt += 1) {
        try {
          return (await send({ operation: "start", idempotencyKey, waitMs, ...payload }, signal)) as OperationLookup;
        } catch (error) {
          lastError = error;
          const transportFailure = error instanceof TypeError;
          if (!transportFailure || signal?.aborted || attempt === START_ATTEMPTS) break;
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
        }
      }
      throw lastError instanceof Error ? lastError : new Error("Review Git request failed.");
    },
    async status(operationId: string, waitMs = 0, signal?: AbortSignal): Promise<OperationLookup> {
      return (await send({ operation: "operation-status", operationId, waitMs }, signal)) as OperationLookup;
    },
  };
}

export type ReviewGitClient = ReturnType<typeof createReviewGitClient>;

interface Proposal {
  proposalId: string;
  kind: string;
  title: string;
  message: string;
  facts: Record<string, unknown>;
  affectedCommits: Array<{ sha: string; subject: string }>;
  affectedTotal: number;
  incomingCommits: Array<{ sha: string; subject: string }>;
  incomingTotal: number;
}

interface EngineResult {
  status: string;
  message?: string;
  code?: string;
  guidance?: string;
  proposal?: Proposal;
  stale?: boolean;
  headSha?: string;
  previousHeadSha?: string;
  baselineWarning?: string;
  conflictedPaths?: string[];
  recoveryRef?: string;
}

function textResult(text: string, structured?: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text }], ...(structured ? { structuredContent: structured } : {}) };
}

function listCommits(label: string, commits: Proposal["affectedCommits"], total: number): string {
  if (!total) return "";
  const lines = commits.slice(0, 15).map((commit) => `  - ${commit.sha.slice(0, 8)} ${commit.subject}`);
  const more = total > commits.length ? `\n  … and ${total - commits.length} more` : "";
  return `\n${label} (${total}):\n${lines.join("\n")}${more}`;
}

const TOOL_BY_KIND: Record<string, string> = {
  fetch: "review_git_fetch",
  refresh: "review_git_refresh",
  rebase: "review_git_rebase",
  stage: "review_git_stage",
  unstage: "review_git_unstage",
  commit: "review_git_commit",
  continue: "review_git_continue",
  skip: "review_git_skip",
  abort: "review_git_abort",
  push: "review_git_push",
  "force-push": "review_git_force_push",
};

/** Turn an operation lookup into text an agent will act on correctly. */
export function describeOperation(calledTool: string, lookup: OperationLookup): CallToolResult {
  // A status lookup must name the tool that STARTED the operation, not itself.
  const tool = TOOL_BY_KIND[lookup.operation?.kind || ""] || calledTool;
  const structured = lookup as unknown as Record<string, unknown>;
  if (lookup.status === "unavailable") {
    return textResult(`Operation ${lookup.operationId}: ${lookup.message || "unavailable"}`, structured);
  }
  if (lookup.status === "running") {
    return textResult(
      `Operation ${lookup.operationId} is still running. It keeps running without you; call git_operation_status with this operationId to see the result. Do not start it again.`,
      structured,
    );
  }
  if (lookup.status === "failed") {
    return textResult(
      `Operation ${lookup.operationId} FAILED: ${lookup.operation?.error || "unknown error"}\nThe repository may be partly changed: run review_git_status before doing anything else. Do not retry automatically.`,
      structured,
    );
  }
  const result = lookup.operation?.result as
    | EngineResult
    | { kind: string; push: EngineResult; publish: { attempted: boolean; published: string[]; failed: unknown[] } }
    | undefined;
  if (result && "push" in result) {
    const push = result.push;
    const publish = result.publish;
    return textResult(
      [
        `Push: ${push.status}${push.message ? ` — ${push.message}` : ""}`,
        publish.attempted
          ? `Publish: ${publish.published.length} comment(s) posted, ${publish.failed.length} failed.`
          : "Publish: not attempted.",
        "Push and publish succeed or fail independently; never repeat a push that succeeded or a comment that was posted.",
      ].join("\n"),
      structured,
    );
  }
  const engine = (result || { status: "unknown" }) as EngineResult;
  const lines: string[] = [];
  if (engine.status === "confirm-required" && engine.proposal) {
    const proposal = engine.proposal;
    lines.push(
      engine.stale
        ? "THE REPOSITORY CHANGED since the earlier proposal. Nothing was done."
        : "USER CONSENT REQUIRED. Nothing was done yet.",
      `${proposal.title}`,
      proposal.message,
      listCommits("Local commits affected", proposal.affectedCommits, proposal.affectedTotal),
      listCommits("Incoming / replaced commits", proposal.incomingCommits, proposal.incomingTotal),
      "",
      `Pinned facts: ${JSON.stringify(proposal.facts)}`,
      `Next: tell the user exactly this, ask them (AskUserQuestion in Claude, otherwise ask in the conversation and stop) and wait for their actual answer. If they approve, call ${tool} again with proposalId="${proposal.proposalId}", expectedFacts set to the pinned facts above, and consent set to their answer. If they decline, do nothing.`,
    );
  } else if (engine.status === "blocked") {
    lines.push(`BLOCKED (${engine.code}): ${engine.message}`);
    if (engine.guidance) lines.push(engine.guidance);
    lines.push("This is not a consent question; fix the cause or tell the user.");
  } else if (engine.status === "conflict") {
    lines.push(
      `${engine.message}`,
      `Conflicted files: ${(engine.conflictedPaths || []).join(", ") || "(none listed)"}.`,
      "Use review_git_conflicts to read them, resolve, stage (with consent), then continue or abort.",
    );
  } else {
    lines.push(`${engine.status}: ${engine.message || ""}`);
    if (engine.recoveryRef) lines.push(`Recovery ref: ${engine.recoveryRef}`);
    if (engine.baselineWarning) lines.push(`WARNING: ${engine.baselineWarning}`);
  }
  return textResult(lines.filter((line) => line !== undefined).join("\n"), structured);
}

const proposalFields = {
  proposalId: z
    .string()
    .optional()
    .describe(
      "Omit on the first call: the tool answers with a proposal. Pass the proposalId it returned only after the user actually approved.",
    ),
  expectedFacts: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.string())]))
    .optional()
    .describe(
      'The "facts" object of the proposal, passed back unchanged. If the repository changed since, the new proposal names what differs.',
    ),
  consent: z
    .string()
    .max(500)
    .optional()
    .describe("The user's actual answer, in their words. Recorded in the audit trail; it is not proof."),
};

const CONSENT_NOTE =
  " Needs the user's consent: call once without proposalId to get a proposal, ask the user and wait for their actual answer, then call again with the proposalId.";

const REFRESH_NOTE =
  " Needs no question when it is safe: it runs at once. Only when it returns a proposal (commits would be discarded) ask the user, wait for their actual answer, then call again with the proposalId.";

export function registerReviewGitTools(server: McpServer, client: ReviewGitClient): void {
  const withDisconnect = (signal?: AbortSignal) => signal;
  const read = async (payload: Record<string, unknown>, signal?: AbortSignal) =>
    textResult(JSON.stringify(await client.read(payload, withDisconnect(signal)), null, 2));

  server.registerTool(
    "review_git_identity",
    {
      title: "Review Git: identity",
      description:
        "Which pull request, source repository/branch, target branch and local branches this review checkout is bound to, plus the persisted source baseline (the PR source commit last integrated or pushed). Start here.",
      inputSchema: {},
    },
    async (_input, extra) => read({ operation: "identity" }, extra.signal),
  );
  server.registerTool(
    "review_git_status",
    {
      title: "Review Git: status",
      description:
        "HEAD, current branch, whether it is the pull request's branch, staged/unstaged/untracked/conflicted counts and paths, any rebase/merge/cherry-pick/revert in progress. Read-only and always allowed, even while an operation is paused on conflicts.",
      inputSchema: {},
    },
    async (_input, extra) => read({ operation: "status" }, extra.signal),
  );
  server.registerTool(
    "review_git_refs",
    {
      title: "Review Git: source and target refs",
      description:
        "HEAD, the cached source/target tracking refs and the baseline. With query=true also asks the remote for the LIVE source and target tips (tracking refs can be stale).",
      inputSchema: { query: z.boolean().optional().describe("Also query the live remote tips.") },
    },
    async (input, extra) => read({ operation: "refs", ...(input?.query ? { query: true } : {}) }, extra.signal),
  );
  server.registerTool(
    "review_git_diff",
    {
      title: "Review Git: diff",
      description:
        "A bounded diff: unstaged worktree, staged, or HEAD against the pull request's target or source branch.",
      inputSchema: {
        scope: z.enum(["worktree", "staged", "head-vs-target", "head-vs-source"]),
        path: z.string().max(4096).optional().describe("Limit to one repository-relative path."),
      },
    },
    async (input, extra) => read({ operation: "diff", ...input }, extra.signal),
  );
  server.registerTool(
    "review_git_history",
    {
      title: "Review Git: history",
      description:
        "Commit list (hash and subject): HEAD's history, or the commits HEAD has beyond the target/source branch.",
      inputSchema: {
        range: z.enum(["head", "head-vs-target", "head-vs-source"]),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async (input, extra) => read({ operation: "history", ...input }, extra.signal),
  );
  server.registerTool(
    "review_git_conflicts",
    {
      title: "Review Git: conflicts",
      description:
        "The files conflicted by a paused rebase/merge/cherry-pick/revert, with their content including conflict markers.",
      inputSchema: {},
    },
    async (_input, extra) => read({ operation: "conflicts" }, extra.signal),
  );
  server.registerTool(
    "review_git_checks",
    {
      title: "Review Git: pull request checks",
      description: "Read-only CI / check summary of the pull request from the last provider sync.",
      inputSchema: {},
    },
    async (_input, extra) => read({ operation: "checks" }, extra.signal),
  );
  server.registerTool(
    "get_git_audit_log",
    {
      title: "Get Git Audit Log",
      description:
        "The audit trail of review Git operations for THIS workspace only (push, force push, refresh, rebase, commit, …) including the requester, the agent-reported consent and the refs/SHAs involved. Secrets are never included.",
      inputSchema: {
        limit: z.number().int().positive().max(100).optional().describe("Max entries to return (default 20)."),
        category: z.enum(["read", "write"]).optional().describe("Filter by read or write category."),
        operation: z.string().optional().describe("Filter by operation name, e.g. gitPush or gitForce-push."),
      },
    },
    async (input, extra) =>
      read(
        {
          operation: "audit-log",
          ...(input?.limit ? { limit: input.limit } : {}),
          ...(input?.category ? { category: input.category } : {}),
          ...(input?.operation ? { operationName: input.operation } : {}),
        },
        extra.signal,
      ),
  );

  function mutation(
    name: string,
    kind: string,
    title: string,
    description: string,
    extraSchema: z.ZodRawShape = {},
    consent = true,
  ): void {
    server.registerTool(
      name,
      {
        title,
        description: description + (consent ? CONSENT_NOTE : ""),
        inputSchema: consent ? { ...extraSchema, ...proposalFields } : { ...extraSchema },
      },
      async (input: Record<string, unknown>, extra: { signal?: AbortSignal }) => {
        const { proposalId, expectedFacts, consent: consentText, ...rest } = input || {};
        const lookup = await client.start(
          {
            kind,
            ...rest,
            ...(proposalId ? { confirmation: { proposalId, ...(expectedFacts ? { facts: expectedFacts } : {}) } } : {}),
            ...(consentText ? { consent: consentText } : {}),
          },
          withDisconnect(extra.signal),
        );
        return describeOperation(name, lookup);
      },
    );
  }

  mutation(
    "review_git_fetch",
    "fetch",
    "Review Git: fetch",
    "Fetch the remote (updates remote-tracking refs only; never moves HEAD or touches the worktree).",
    {},
    false,
  );
  server.registerTool(
    "review_git_refresh",
    {
      title: "Review Git: refresh",
      description:
        "Bring the checkout up to the pull request's live source commit. The exact live SHA is pinned. Fast-forwards automatically; resets onto a rewritten PR branch automatically ONLY when HEAD is exactly the last integrated source commit, the tree is clean and no operation is active (a recovery ref is created first). If commits would be discarded it returns a proposal instead." +
        REFRESH_NOTE,
      inputSchema: { ...proposalFields },
    },
    async (input: Record<string, unknown>, extra: { signal?: AbortSignal }) => {
      const { proposalId, expectedFacts, consent: consentText } = input || {};
      const lookup = await client.start(
        {
          kind: "refresh",
          ...(proposalId ? { confirmation: { proposalId, ...(expectedFacts ? { facts: expectedFacts } : {}) } } : {}),
          ...(consentText ? { consent: consentText } : {}),
        },
        withDisconnect(extra.signal),
      );
      return describeOperation("review_git_refresh", lookup);
    },
  );
  mutation(
    "review_git_rebase",
    "rebase",
    "Review Git: rebase onto the target branch",
    "Rebase the local branch onto the pull request's TARGET branch (the target SHA is pinned). Rewrites local history only; it never pushes and never changes the source baseline.",
  );
  mutation(
    "review_git_stage",
    "stage",
    "Review Git: stage paths",
    "Stage specific repository-relative paths (the intended paths and the current index are pinned).",
    { paths: z.array(z.string().max(4096)).min(1).max(500) },
  );
  mutation(
    "review_git_unstage",
    "unstage",
    "Review Git: unstage paths",
    "Unstage specific repository-relative paths.",
    { paths: z.array(z.string().max(4096)).min(1).max(500) },
  );
  mutation(
    "review_git_commit",
    "commit",
    "Review Git: commit",
    "Commit what is staged (the staged diff and the message are pinned: change either and you are asked again). Hooks run; they are never bypassed.",
    { message: z.string().min(1).max(10_000) },
  );
  mutation(
    "review_git_continue",
    "continue",
    "Review Git: continue a paused operation",
    "Continue a paused rebase/merge/cherry-pick/revert after its conflicts were resolved and staged.",
  );
  mutation(
    "review_git_skip",
    "skip",
    "Review Git: skip the current step of a paused operation",
    "Skip the commit a paused rebase/cherry-pick/revert is stopped on.",
  );
  mutation(
    "review_git_abort",
    "abort",
    "Review Git: abort a paused operation",
    "Abort a paused rebase/merge/cherry-pick/revert and restore the state before it began.",
  );
  mutation(
    "review_git_push",
    "push",
    "Review Git: push",
    "Push HEAD to the pull request's SOURCE branch in the verified source repository. Allowed only when it fast-forwards the live source branch. Never publishes queued draft comments.",
  );
  mutation(
    "review_git_force_push",
    "force-push",
    "Review Git: force push",
    "Force push HEAD over the pull request's source branch using a lease on the exact live SHA. A lease rejection is reported and never retried automatically.",
  );

  server.registerTool(
    "git_operation_status",
    {
      title: "Review Git: operation status",
      description:
        "Result of an operation started by a review_git_* tool: running, succeeded (with its result), failed, or explicitly unavailable/expired (results are kept for 24 hours). Use it whenever a call returned an operationId before finishing; never re-start an operation whose status is unknown.",
      inputSchema: {
        operationId: z.string().min(1).max(100),
        waitSeconds: z.number().int().min(0).max(20).optional().describe("Wait up to this long for it to finish."),
      },
    },
    async (input, extra) =>
      describeOperation(
        "git_operation_status",
        await client.status(input.operationId, (input.waitSeconds || 0) * 1000, withDisconnect(extra.signal)),
      ),
  );
}
