import { REGISTRY_AUDIT_WINDOW_MS } from "../../shared/registry.js";
import type { SandboxAuditLogStore } from "./sandbox-audit-log-store.js";

/**
 * Registry use is audited in aggregate, one row per (workspace, connection, window): the INTENT row is
 * written when the window opens — before the first request is forwarded — and finished with the totals
 * when the window closes. A request whose window cannot be opened is refused, so no registry traffic
 * leaves the host unrecorded.
 */

export interface RegistryAuditSubject {
  profileId: string;
  workspaceId: string;
  connectionId: string;
  label: string;
}

interface Window {
  rowId: number;
  startedAt: number;
  requests: number;
  bytes: number;
  failures: number;
  statuses: Record<string, number>;
  timer: ReturnType<typeof setTimeout>;
  subject: RegistryAuditSubject;
}

/** One named operation a sandbox asked a host broker for (an MCP call, a hook delivery). */
export interface BrokerOperationSubject {
  profileId: string;
  workspaceId: string;
  sessionId: string;
  route: string;
  method: string;
}

export interface RegistryAudit {
  /**
   * Writes the INTENT row for one broker operation before it is dispatched. Returns a function that finishes
   * the same row with the outcome, or null when the intent could not be written: the operation is then refused.
   */
  beginOperation(subject: BrokerOperationSubject): ((outcome: { status: number; bytes: number }) => void) | null;
  /** Opens (or joins) the window for the subject. Returns false when the intent could not be written. */
  begin(subject: RegistryAuditSubject): boolean;
  end(subject: RegistryAuditSubject, outcome: { status: number; bytes: number }): void;
  /** Finishes every open window now (shutdown). */
  flush(): void;
}

export function createRegistryAudit(
  store: Pick<SandboxAuditLogStore, "insertEntry" | "finishEntry">,
  { now = () => Date.now(), windowMs = REGISTRY_AUDIT_WINDOW_MS } = {},
): RegistryAudit {
  const windows = new Map<string, Window>();
  const keyOf = (subject: RegistryAuditSubject) => `${subject.workspaceId}\u0000${subject.connectionId}`;

  function close(key: string): void {
    const window = windows.get(key);
    if (!window) return;
    clearTimeout(window.timer);
    windows.delete(key);
    store.finishEntry(window.rowId, {
      success: window.failures === 0,
      durationMs: now() - window.startedAt,
      errorMessage: window.failures ? `${window.failures} request(s) failed` : null,
      summary: `registry: ${window.requests} request(s), ${window.bytes} byte(s) via ${window.subject.label}`,
      details: {
        requests: window.requests,
        bytes: window.bytes,
        failures: window.failures,
        statuses: window.statuses,
        windowEnded: new Date(now()).toISOString(),
      },
    });
  }

  return {
    beginOperation(subject) {
      const startedAt = now();
      const rowId = store.insertEntry({
        timestamp: new Date(startedAt).toISOString(),
        connectionId: "",
        profileId: subject.profileId,
        workspaceId: subject.workspaceId,
        operation: "brokerOperation",
        category: subject.method === "GET" ? "read" : "write",
        method: subject.method,
        url: "",
        success: false,
        errorMessage: "operation started; outcome not yet recorded",
        resourceType: "broker",
        resourceId: subject.route,
        summary: `sandbox asked the ${subject.route} broker (${subject.method})`,
        userInitiated: false,
        details: JSON.stringify({ sessionId: subject.sessionId, route: subject.route }),
      });
      if (rowId === null) return null;
      return (outcome) => {
        const failed = outcome.status === 0 || outcome.status >= 400;
        store.finishEntry(rowId, {
          success: !failed,
          durationMs: now() - startedAt,
          errorMessage: failed ? `status ${outcome.status || "error"}` : null,
          summary: `${subject.route} broker: status ${outcome.status || "error"}, ${outcome.bytes} byte(s)`,
          details: { route: subject.route, status: outcome.status, bytes: outcome.bytes },
        });
      };
    },
    begin(subject) {
      const key = keyOf(subject);
      if (windows.has(key)) return true;
      const startedAt = now();
      const rowId = store.insertEntry({
        timestamp: new Date(startedAt).toISOString(),
        connectionId: subject.connectionId,
        profileId: subject.profileId,
        workspaceId: subject.workspaceId,
        operation: "registryRead",
        category: "read",
        method: "GET",
        url: "",
        success: false,
        errorMessage: "window open; totals not yet recorded",
        resourceType: "registry",
        resourceId: subject.connectionId,
        summary: `registry window opened via ${subject.label}`,
        userInitiated: false,
        details: JSON.stringify({ workspaceId: subject.workspaceId, windowMs }),
      });
      if (rowId === null) return false;
      const timer = setTimeout(() => close(key), windowMs);
      timer.unref?.();
      windows.set(key, { rowId, startedAt, requests: 0, bytes: 0, failures: 0, statuses: {}, timer, subject });
      return true;
    },
    end(subject, outcome) {
      const window = windows.get(keyOf(subject));
      if (!window) return;
      window.requests += 1;
      window.bytes += outcome.bytes;
      if (outcome.status >= 400 || outcome.status === 0) window.failures += 1;
      const bucket = outcome.status === 0 ? "error" : `${Math.floor(outcome.status / 100)}xx`;
      window.statuses[bucket] = (window.statuses[bucket] || 0) + 1;
    },
    flush() {
      for (const key of [...windows.keys()]) close(key);
    },
  };
}
