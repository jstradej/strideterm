/**
 * Pure logic behind the Claude Code `PermissionRequest` hook.
 *
 * Two independent jobs, both side-effect free so they can be unit-tested
 * without a runtime, a session or a database:
 *
 *  1. `summarizePermissionRequest` — turn `tool_name` + `tool_input` into one
 *     short human line ("Bash: chmod +x deploy.sh"). Used as the alert text of
 *     the `question` notification and as the `summary` column of the approval
 *     audit log.
 *  2. `decideAutoApprove` — decide whether strIDEterm may answer the request on
 *     the user's behalf, and say WHY when it may not. The reason string is
 *     logged and is what a "why did this not auto-approve?" question is
 *     answered with.
 *
 * See .private/plan-agent-question-alerts-and-auto-approve.md § B.
 */

import { redactSecrets } from "../logger.js";

/** Cap on a summary. Long enough for a real command, short enough that a
 *  pathological argument can't dominate a toast, a chat message or a DB row —
 *  and the shorter the string, the less chance of persisting a secret that the
 *  redaction patterns don't recognise. */
export const SUMMARY_MAX_CHARS = 200;

/**
 * Tools that must NEVER be auto-approved, no matter what the user turned on.
 *
 * These are not "risky" tools — they are tools whose permission prompt IS the
 * interaction. Claude Code renders both as a permission dialog, and a bare
 * `allow` answers them with nothing:
 *
 *  - `AskUserQuestion`: the docs require `updatedInput` carrying an `answers`
 *    object alongside `allow`; changelog 2.1.69 fixed exactly the bug where an
 *    auto-allowed AskUserQuestion "ran with empty answers".
 *  - `ExitPlanMode`: approving a plan is the user's decision by definition.
 *    Anyone who wants this without waiting can add their own hook for it.
 */
export const AUTO_APPROVE_NEVER_TOOLS: ReadonlySet<string> = new Set(["AskUserQuestion", "ExitPlanMode"]);

/** Tools whose most telling argument is a path. */
const FILE_PATH_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "Read"]);

function collapse(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function clip(value: string): string {
  if (value.length <= SUMMARY_MAX_CHARS) return value;
  return value.slice(0, SUMMARY_MAX_CHARS - 1) + "…";
}

/** First non-empty string-valued field of a tool input, in key order. Used for
 *  MCP tools, whose input shape we cannot know ahead of time. */
function firstStringField(toolInput: Record<string, unknown>): string {
  for (const value of Object.values(toolInput)) {
    // Strings only: a numeric `limit` or a boolean flag says nothing about what
    // the call actually does, and would crowd out the query / path that does.
    if (typeof value !== "string") continue;
    const text = collapse(value);
    if (text) return text;
  }
  return "";
}

export interface PermissionRequestSummary {
  /** `tool_name`, collapsed; `"tool"` when the payload carried none. */
  tool: string;
  /** The telling argument on its own, WITHOUT the `Tool: ` prefix. */
  detail: string;
  /** `Tool` or `Tool: <detail>` — the one-line form. */
  summary: string;
}

/**
 * Structured summary of a permission request.
 *
 * `detail` is kept separate from `summary` on purpose. A renderer that already
 * shows the tool name in its own right ("Bash in Alpha: …") needs the argument
 * alone; re-parsing it back out of the prefixed string is how
 * `Bash in Alpha: Bash: chmod +x deploy.sh` happened.
 *
 * Both fields are redacted and clipped: they are persisted to SQLite and
 * forwarded to Telegram, so a `curl -H "Authorization: Bearer …"` in a Bash
 * command must not survive verbatim.
 */
export function summarizePermissionRequestParts(toolName: unknown, toolInput: unknown): PermissionRequestSummary {
  const tool = collapse(toolName) || "tool";
  const input = (toolInput && typeof toolInput === "object" ? toolInput : {}) as Record<string, unknown>;

  let argument = "";
  if (tool === "Bash" || tool === "BashOutput") {
    argument = collapse(input.command);
  } else if (FILE_PATH_TOOLS.has(tool)) {
    argument = collapse(input.file_path) || collapse(input.notebook_path);
  } else if (tool === "Glob" || tool === "Grep") {
    argument = collapse(input.pattern) || collapse(input.path);
  } else if (tool === "WebFetch") {
    const url = collapse(input.url);
    try {
      argument = new URL(url).host;
    } catch {
      // Not a parseable URL — better a truncated raw value than nothing, and
      // the redaction below still strips `?token=` style query strings.
      argument = url;
    }
  } else if (tool.startsWith("mcp__")) {
    argument = firstStringField(input);
  }

  const detail = clip(redactSecrets(argument));
  const summary = detail ? clip(`${tool}: ${detail}`) : tool;
  return { tool, detail, summary };
}

/**
 * One-line human summary of a permission request.
 *
 * Shape is always `Tool` or `Tool: <argument>` — what the audit log stores and
 * what the `question` alert says. Callers that render the tool name themselves
 * want `summarizePermissionRequestParts(...).detail` instead.
 */
export function summarizePermissionRequest(toolName: unknown, toolInput: unknown): string {
  return summarizePermissionRequestParts(toolName, toolInput).summary;
}

/** Why a request was not auto-approved (or, for `global`, why it was). */
export type AutoApproveReason =
  | "global"
  | "disabled"
  | "never-list"
  | "unknown-session"
  | "task-workspace"
  | "unproven-session"
  | "session-not-active";

export interface AutoApproveDecision {
  approve: boolean;
  reason: AutoApproveReason;
}

export interface AutoApproveContext {
  /** `settings.notifications.autoApprovePermissions`. */
  enabled: boolean;
  /** `tool_name` from the hook payload. */
  toolName: string;
  /**
   * The workspace owning the session, or null when the session id could not be
   * parsed or its workspace no longer exists.
   *
   * `hasTask` is checked alongside `kind` on purpose. `kind` is derived from
   * the persisted value in `normalizeState`, so a state file whose `kind` got
   * lost would present a task workspace as an ordinary terminal one — and the
   * one thing that must never happen here is auto-approving inside the task
   * runner's own panels. The `task` object is the structural fact; `kind` is
   * a label about it.
   */
  workspace: { kind?: string; hasTask?: boolean } | null;
  /**
   * The session signal, or null when this instance has never seen the session.
   */
  signal: { turnActive?: boolean } | null;
  /**
   * Whether the hook process PROVED it belongs to this instance's PTY session,
   * by echoing back the per-session ownership token strIDEterm injected into
   * that PTY's environment (see `runtime.ts#sessionOwnershipTokens`).
   *
   * Routing alone cannot establish this. `notify.mjs` resolves URLs by project
   * directory, so a `claude` the user started in a plain terminal inside the
   * same repository, a second panel with the same `cwd`, and a dev instance
   * running beside prod all reach the same responder. Answering a permission
   * prompt for a session this instance is not driving is precisely the failure
   * this flag exists to make impossible: no token, no approval.
   */
  ownershipProven: boolean;
}

/**
 * Decide whether to answer a `PermissionRequest` with `allow`.
 *
 * Conservative by construction: every branch except the last returns
 * `approve: false`, so a context this function does not fully understand ends
 * with the prompt shown to the user — the same outcome as having no hook at
 * all.
 */
export function decideAutoApprove(ctx: AutoApproveContext): AutoApproveDecision {
  if (!ctx.enabled) return { approve: false, reason: "disabled" };

  // Checked before anything session-related so the never-list holds even for a
  // context we would otherwise refuse anyway — the unit test then proves the
  // list itself, not an unrelated guard standing in for it.
  if (AUTO_APPROVE_NEVER_TOOLS.has(ctx.toolName)) return { approve: false, reason: "never-list" };

  if (!ctx.workspace || !ctx.signal) return { approve: false, reason: "unknown-session" };

  // Task workspaces have their own permission story: worker and judge run with
  // the provider's own bypass flag, and an attached judge that does hit a
  // prompt is deliberately paused by the task runner. Nothing here should
  // reach in and answer for them.
  if (ctx.workspace.kind === "task" || ctx.workspace.hasTask) {
    return { approve: false, reason: "task-workspace" };
  }

  // The hook did not prove it came from the agent running in THIS instance's
  // PTY. Cwd-based routing fans every hook out to every registered URL, so
  // without the token there is no way to tell "the session I am driving" from
  // "someone else's claude that happens to share the directory".
  if (!ctx.ownershipProven) return { approve: false, reason: "unproven-session" };

  // A permission request only ever happens inside a turn — between the
  // `UserPromptSubmit` that started it and the `Stop` that ended it. Gating on
  // `turnActive` (rather than the sticky `hasUserInput` / `agentLike` flags,
  // which stay set for the life of the signal) means a session that went quiet
  // hours ago cannot still be eligible.
  if (!ctx.signal.turnActive) {
    return { approve: false, reason: "session-not-active" };
  }

  return { approve: true, reason: "global" };
}
