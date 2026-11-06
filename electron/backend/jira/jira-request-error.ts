import type { JiraRequestErrorCode } from "../../shared/jira-error-codes.js";

export type { JiraRequestErrorCode };

export interface JiraRequestErrorOptions {
  cause?: unknown;
  /** The failure happened before any request left this machine, so nothing can have been applied. */
  notSent?: boolean;
  /** Jira's own (cleaned, clipped) explanation, when it gave one. */
  detail?: string;
}

export class JiraRequestError extends Error {
  notSent: boolean;
  readonly detail?: string;
  constructor(
    readonly code: JiraRequestErrorCode,
    message: string,
    readonly retryAfterMs?: number,
    readonly statusCode?: number,
    options: JiraRequestErrorOptions = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "JiraRequestError";
    this.notSent = options.notSent === true;
    if (options.detail) this.detail = options.detail;
  }
}

/** The operating-system / TLS code carried by an error or anything in its cause chain; never a message. */
export function errorCauseCode(error: unknown): string | undefined {
  for (let current: unknown = error, depth = 0; current && typeof current === "object" && depth < 5; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** The few facts of a failure that are safe and useful in a log line: never the message, URL or body. */
export function jiraErrorFields(error: unknown): {
  code: string;
  statusCode?: number;
  cause?: string;
} {
  if (error instanceof JiraRequestError)
    return {
      code: error.code,
      ...(error.statusCode !== undefined ? { statusCode: error.statusCode } : {}),
      ...(errorCauseCode(error.cause) ? { cause: errorCauseCode(error.cause) } : {}),
    };
  const cause = errorCauseCode(error);
  return { code: error instanceof Error ? error.name : "error", ...(cause ? { cause } : {}) };
}
