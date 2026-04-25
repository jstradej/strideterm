/// <reference types="node" />
import { createAuditLogStore } from "./shared/base-audit-log-store.js";

export function createGitAuditLogStore(databasePath: string) {
  return createAuditLogStore(databasePath, {
    tableName: "git_audit_log",
    indexPrefix: "git_audit",
    providerColumns: [
      { name: "remote_url", default: "" },
      { name: "expected_ref", default: "" },
      { name: "previous_remote_ref", default: "" },
      { name: "new_remote_ref", default: "" },
    ],
    mapEntryToProviderValues: (entry) => [
      String(entry.remoteUrl || ""),
      String(entry.expectedRef || ""),
      String(entry.previousRemoteRef || ""),
      String(entry.newRemoteRef || ""),
    ],
    mapRowToProviderFields: (row) => ({
      remoteUrl: row.remote_url,
      expectedRef: row.expected_ref,
      previousRemoteRef: row.previous_remote_ref,
      newRemoteRef: row.new_remote_ref,
    }),
    searchFields: ["remote_url"],
  });
}
