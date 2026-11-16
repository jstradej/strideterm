/// <reference types="node" />
import { createAuditLogStore } from "../shared/base-audit-log-store.js";

/** Audit trail of what a sandbox asked the host for: registry use and gateway-brokered operations. */
export function createSandboxAuditLogStore(databasePath: string) {
  return createAuditLogStore(databasePath, {
    tableName: "sandbox_audit_log",
    indexPrefix: "sandbox_audit",
    providerColumns: [
      { name: "profile_id", default: "" },
      { name: "workspace_id", default: "" },
    ],
    mapEntryToProviderValues: (entry) => [String(entry.profileId || ""), String(entry.workspaceId || "")],
    mapRowToProviderFields: (row) => ({ profileId: row.profile_id, workspaceId: row.workspace_id }),
    searchFields: ["workspace_id"],
  });
}

export type SandboxAuditLogStore = ReturnType<typeof createSandboxAuditLogStore>;
