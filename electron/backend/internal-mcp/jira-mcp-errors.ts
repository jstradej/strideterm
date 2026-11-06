import { jiraErrorFields, JiraRequestError } from "../jira/jira-request-error.js";
import { logJiraFailure, logJiraRecovered } from "../jira/jira-failure-log.js";
import { InternalMcpError } from "./errors.js";

const GENERIC = "The Jira request failed. No Jira credentials or provider details were returned.";

const MESSAGES: Record<string, string> = {
  "auth-expired":
    "Jira sign-in has expired for this connection. Ask the user to sign in to it again in strIDEterm; retrying will not help until then.",
  "credential-missing":
    "The Jira credential for this connection is missing. Ask the user to reconnect it in strIDEterm.",
  "permission-denied": "Jira denied the connected account access to that resource.",
  "rate-limited": "Jira is rate limiting requests. Wait for retryAfterMs and try again.",
  "not-found": "Jira could not find that resource.",
  "host-unreachable": "Jira could not be reached from this machine. It may be offline or behind a VPN.",
  "tls-error": "The secure connection to Jira failed. Ask the user to check the Jira certificate.",
  "certificate-invalid":
    "The client certificate for this Jira connection is not usable. Ask the user to fix it in strIDEterm.",
  network: "Jira did not answer in time or could not be reached. Retrying later may work.",
};

/**
 * What an agent learns about a failed Jira call: a stable code it can branch on (and `retryAfterMs` when Jira gave
 * one), never the provider's message, URL or credentials. One transition-logged warn goes to the log per (connection, operation); the first success afterwards logs the recovery.
 */
export interface JiraMcpCallScope {
  /** The Jira operation the agent asked for; with the connection it keys the transition log. */
  operation: string;
  connectionId?: string;
}

const failureScope = (scope: JiraMcpCallScope) => ({
  connectionId: scope.connectionId || "-",
  scope: `mcp:${scope.operation}`,
});

export function jiraMcpCallSucceeded(scope: JiraMcpCallScope): void {
  const { connectionId, scope: name } = failureScope(scope);
  logJiraRecovered(connectionId, name);
}

export function jiraUnavailableError(error: unknown, call: JiraMcpCallScope): InternalMcpError {
  if (error instanceof InternalMcpError) return error;
  if (error instanceof JiraRequestError) {
    const fields = jiraErrorFields(error);
    logJiraFailure({ ...failureScope(call), code: error.code }, fields);
    return new InternalMcpError("jira_unavailable", MESSAGES[error.code] ?? GENERIC, {
      cause: error,
      jiraCode: error.code,
      ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
    });
  }
  logJiraFailure({ ...failureScope(call), code: "unexpected" }, jiraErrorFields(error));
  return new InternalMcpError("jira_unavailable", GENERIC, { cause: error });
}
