import type { InternalMcpErrorCode } from "../../shared/internal-mcp.js";

export class InternalMcpError extends Error {
  /** For `jira_unavailable`: the safe Jira failure code the agent can branch on. */
  readonly jiraCode?: string;
  readonly retryAfterMs?: number;
  constructor(
    readonly code: InternalMcpErrorCode,
    message: string,
    options?: { cause?: unknown; jiraCode?: string; retryAfterMs?: number },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "InternalMcpError";
    if (options?.jiraCode) this.jiraCode = options.jiraCode;
    if (options?.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
  }
}
