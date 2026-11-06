import { userFacingMessage } from "../../../../lib/error-message.js";
import { JIRA_SAFE_ERROR_CODES } from "../../../../../electron/shared/jira-error-codes.js";
import type { JiraErrorCode } from "./jira-pane-types.js";

export type JiraFailureStatus = { code: JiraErrorCode; retryAfterMs?: number };

const ACCESS_FAILURE_CODES = ["auth-expired", "permission-denied", "not-found", "credential-missing"];

const JIRA_ERROR_LABELS: Record<JiraErrorCode, string> = {
  "auth-expired": "Authentication expired",
  "permission-denied": "Jira permission denied",
  unsupported: "Jira capability unsupported",
  "rate-limited": "Jira rate limit reached",
  network: "Jira network error",
  "not-found": "Jira item not found",
  unknown: "Jira request error",
  "jira-write-unknown": "Write outcome unknown; reconciliation required",
  "jira-write-rejected": "Jira rejected the write",
  "jira-unavailable": "Jira is unavailable",
  "validation-failed": "Jira request was invalid",
  forbidden: "Jira action not allowed",
  "configuration-incomplete": "Jira connection setup is incomplete",
  "credential-missing": "Saved credentials are missing",
  "certificate-invalid": "Client certificate rejected",
  "host-unreachable": "Jira host unreachable",
  "tls-error": "TLS connection failed",
};

/** Every code the runtime can send; the labels above are typed against the same shared list. */
export const JIRA_STATUS_CODES: readonly JiraErrorCode[] = JIRA_SAFE_ERROR_CODES;

/** Persisted connection health also carries "verified", which has no failure label. */
export function jiraErrorLabelFor(code: JiraErrorCode | "verified"): string {
  return code === "verified" ? "Verified" : JIRA_ERROR_LABELS[code];
}

type FailureShape = {
  message?: unknown;
  error?: unknown;
  code?: unknown;
  retryAfterMs?: unknown;
  jiraError?: { code?: unknown; retryAfterMs?: unknown };
};

function failureShape(cause: unknown): FailureShape | undefined {
  return cause && typeof cause === "object" ? (cause as FailureShape) : undefined;
}

/** The raw machine-readable code of a failure: `jiraError.code` (desktop and remote transports) or a plain `code`. */
export function jiraFailureCode(cause: unknown): string {
  const value = failureShape(cause);
  const code = value?.jiraError?.code ?? value?.code;
  return typeof code === "string" ? code : "";
}

export function jiraFailureStatus(cause: unknown): JiraFailureStatus | null {
  const code = jiraFailureCode(cause);
  if (!JIRA_STATUS_CODES.includes(code as JiraErrorCode)) return null;
  const value = failureShape(cause);
  const retryAfterMs = value?.jiraError?.retryAfterMs ?? value?.retryAfterMs;
  return { code: code as JiraErrorCode, ...(typeof retryAfterMs === "number" ? { retryAfterMs } : {}) };
}

export function isJiraAccessFailure(cause: unknown): boolean {
  return ACCESS_FAILURE_CODES.includes(jiraFailureCode(cause));
}

/** `userFacingMessage` plus any leading `SomeError: ` class prefix a wrapped IPC rejection still carries. */
export function jiraFailureReason(cause: unknown): string {
  let text = userFacingMessage(cause, "").trim();
  for (let guard = 0; guard < 3 && /^\w+Error:\s*/.test(text); guard++) text = text.replace(/^\w+Error:\s*/, "");
  return text.trim();
}

export function formatJiraFailureStatus(status: JiraFailureStatus): string {
  const label = jiraErrorLabelFor(status.code);
  return status.retryAfterMs ? `${label} · Retry after ${Math.ceil(status.retryAfterMs / 1000)} seconds.` : label;
}

export function isSupersededActivation(cause: unknown): boolean {
  return /was superseded/i.test(jiraFailureReason(cause));
}

/** Builds "<context>: <reason>"; the context alone when the cause carries no reason of its own. */
export function composeFailureText(context: string, cause: unknown): string {
  const base = context.trim().replace(/[\s.:]+$/, "");
  const reason = jiraFailureReason(cause);
  if (!reason || reason === base) return `${base}.`;
  return `${base}: ${reason}`;
}
