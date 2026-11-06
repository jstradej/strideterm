/**
 * One list of the codes a Jira failure can carry. The zod enums, the persisted connection health and the TypeScript
 * types are all derived from it, so a code added here cannot be accepted in one place and rejected in another.
 */
export const JIRA_REQUEST_ERROR_CODES = [
  "auth-expired",
  "permission-denied",
  "configuration-incomplete",
  "unsupported",
  "rate-limited",
  "network",
  "not-found",
  "unknown",
  "credential-missing",
  "certificate-invalid",
  "host-unreachable",
  "tls-error",
] as const;
export type JiraRequestErrorCode = (typeof JIRA_REQUEST_ERROR_CODES)[number];

export const JIRA_CONNECTION_HEALTH_STATES = ["verified", ...JIRA_REQUEST_ERROR_CODES] as const;
export type JiraConnectionHealthState = (typeof JIRA_CONNECTION_HEALTH_STATES)[number];

/** Codes the write envelope adds on top of the request codes. */
export const JIRA_WRITE_ENVELOPE_CODES = [
  "jira-write-unknown",
  "jira-write-rejected",
  "jira-unavailable",
  "validation-failed",
  "forbidden",
] as const;
export const JIRA_SAFE_ERROR_CODES = [...JIRA_WRITE_ENVELOPE_CODES, ...JIRA_REQUEST_ERROR_CODES] as const;

/**
 * What the write journal keeps of a failure: the code and, for an HTTP answer, its status (`permission-denied:403`,
 * `not-sent:credential-missing`), plus the original `interrupted` / `provider-error` / `reconcile-incomplete`.
 */
export const JIRA_WRITE_SAFE_CODE_PATTERN = /^[a-z][a-z0-9:-]{0,95}$/;

/**
 * Codes that mean the stored sign-in no longer works and the user has to act on the connection.
 * `permission-denied` is not one: Jira answers 403 per resource (a restricted issue, board or project), so one
 * hidden issue would otherwise flip the whole connection to "sign in again" and back on the next successful read.
 */
export const JIRA_SIGN_IN_CODES: ReadonlySet<string> = new Set(["auth-expired", "credential-missing"]);
