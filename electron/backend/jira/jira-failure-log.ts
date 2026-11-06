import { getLogger, type Logger } from "../logger.js";

export const JIRA_STILL_FAILING_LOG_MS = 30 * 60_000;
const MAX_TRACKED = 500;

export interface JiraFailureKey {
  connectionId: string;
  /** What kind of work failed (`poll:<queryId>`, `view-sync:<viewId>`, `read`, ...). */
  scope: string;
  code: string;
}

interface FailureState {
  code: string;
  since: number;
  lastLoggedAt: number;
  suppressed: number;
}

/**
 * Logs a background failure on a CHANGE of state only: ok to error, a different code, and error to ok (`recovered`).
 * While the same failure persists it writes one "still failing" line per interval, so a poll that fails every
 * minute for a day is a handful of lines, not 1440.
 */
export function createJiraFailureLog(
  log: Pick<Logger, "warn" | "info">,
  options: { now?: () => number; stillFailingMs?: number } = {},
) {
  const now = options.now ?? Date.now;
  const stillFailingMs = options.stillFailingMs ?? JIRA_STILL_FAILING_LOG_MS;
  const states = new Map<string, FailureState>();
  const stateKey = (connectionId: string, scope: string) => `${connectionId}\u0000${scope}`;
  return {
    failure(key: JiraFailureKey, fields: Record<string, unknown> = {}): void {
      const id = stateKey(key.connectionId, key.scope);
      const at = now();
      const previous = states.get(id);
      const base = { connectionId: key.connectionId, scope: key.scope, code: key.code, ...fields };
      if (!previous || previous.code !== key.code) {
        if (!previous && states.size >= MAX_TRACKED) states.delete(states.keys().next().value as string);
        states.set(id, { code: key.code, since: previous?.since ?? at, lastLoggedAt: at, suppressed: 0 });
        log.warn("jira background work failed", { ...base, ...(previous ? { previousCode: previous.code } : {}) });
        return;
      }
      if (at - previous.lastLoggedAt >= stillFailingMs) {
        log.warn("jira background work still failing", {
          ...base,
          failingForMs: at - previous.since,
          suppressed: previous.suppressed,
        });
        previous.lastLoggedAt = at;
        previous.suppressed = 0;
        return;
      }
      previous.suppressed += 1;
    },
    recovered(connectionId: string, scope: string, fields: Record<string, unknown> = {}): void {
      const id = stateKey(connectionId, scope);
      const previous = states.get(id);
      if (!previous) return;
      states.delete(id);
      log.info("jira background work recovered", {
        connectionId,
        scope,
        previousCode: previous.code,
        failedForMs: now() - previous.since,
        ...fields,
      });
    },
    isFailing(connectionId: string, scope: string): boolean {
      return states.has(stateKey(connectionId, scope));
    },
    /** Forget a scope without logging, for connections or watches that no longer exist. */
    forget(connectionId: string, scope?: string): void {
      for (const id of [...states.keys()]) {
        const [connection, itemScope] = id.split("\u0000");
        if (connection === connectionId && (scope === undefined || itemScope === scope)) states.delete(id);
      }
    },
  };
}

export type JiraFailureLog = ReturnType<typeof createJiraFailureLog>;

let shared: JiraFailureLog | undefined;
/** The process-wide instance every Jira module reports through, so one failure is one line wherever it is seen. */
export function jiraFailureLog(): JiraFailureLog {
  shared ??= createJiraFailureLog(getLogger("jira"));
  return shared;
}

export function logJiraFailure(key: JiraFailureKey, fields?: Record<string, unknown>): void {
  jiraFailureLog().failure(key, fields);
}

export function logJiraRecovered(connectionId: string, scope: string, fields?: Record<string, unknown>): void {
  jiraFailureLog().recovered(connectionId, scope, fields);
}
