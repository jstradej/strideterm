/// <reference types="node" />
import { createAuditLogStore } from "./shared/base-audit-log-store.js";

/**
 * Approval audit log: every permission prompt strIDEterm answered on the
 * user's behalf (Settings → General → Auto-approve permission prompts).
 *
 * Auto-approve is a deliberate bypass, so the trail is not optional — a
 * failed write BLOCKS the approval (see runtime.ts#commitPermissionDecision)
 * rather than letting an unrecorded one through. The rolling Winston log
 * would not do on its own: it rotates, and the user needs to be able to ask
 * "what did it approve while I was away?" days later.
 *
 * Refusals are not recorded here. They are the normal, quiet case — the
 * prompt is simply shown — and they land in `strideterm.log` at debug level
 * with their reason.
 *
 * `claude_session_id` is Claude Code's own `session_id` from the hook payload,
 * kept so an approval can be cross-referenced with the agent transcript at
 * `~/.claude/projects/<project>/<session_id>.jsonl`. Together with the hook's
 * `prompt_id` it also forms `request_key`, the idempotency key that stops a
 * retried `PermissionRequest` from being recorded twice.
 *
 * `outcome` is `decision-issued`, never `approved`. strIDEterm writes the row
 * once arbitration has picked it as the single responder and immediately
 * before the decision goes out on the hook's stdout — but nothing reports back
 * whether Claude Code actually acted on it. Calling the row "approved" would
 * claim knowledge the process does not have.
 *
 * `profile_id` is stored so the remote audit-log endpoint can scope a reply to
 * the profile the calling client is bound to, the way the live
 * `approval:recorded` event already is. `workspace_name` / `panel_title` are a
 * snapshot of the human labels at approval time: the ids stay for correlation,
 * but a log the user cannot read is not a log they will check.
 */
export function createApprovalAuditLogStore(databasePath: string) {
  return createAuditLogStore(databasePath, {
    tableName: "approval_audit_log",
    indexPrefix: "approval_audit",
    providerColumns: [
      { name: "workspace_id", default: "" },
      { name: "session_id", default: "" },
      { name: "tool_name", default: "" },
      { name: "claude_session_id", default: "" },
      { name: "decision_reason", default: "" },
      { name: "profile_id", default: "" },
      { name: "workspace_name", default: "" },
      { name: "panel_title", default: "" },
      { name: "request_key", default: "" },
      { name: "outcome", default: "" },
    ],
    mapEntryToProviderValues: (entry) => [
      String(entry.workspaceId || ""),
      String(entry.sessionId || ""),
      String(entry.toolName || ""),
      String(entry.claudeSessionId || ""),
      String(entry.decisionReason || ""),
      String(entry.profileId || ""),
      String(entry.workspaceName || ""),
      String(entry.panelTitle || ""),
      String(entry.requestKey || ""),
      String(entry.outcome || ""),
    ],
    mapRowToProviderFields: (row) => ({
      workspaceId: row.workspace_id,
      sessionId: row.session_id,
      toolName: row.tool_name,
      claudeSessionId: row.claude_session_id,
      decisionReason: row.decision_reason,
      profileId: row.profile_id,
      workspaceName: row.workspace_name,
      panelTitle: row.panel_title,
      requestKey: row.request_key,
      outcome: row.outcome,
    }),
    searchFields: ["workspace_id", "workspace_name", "panel_title", "tool_name", "summary"],
  });
}

export type ApprovalAuditLogStore = ReturnType<typeof createApprovalAuditLogStore>;
