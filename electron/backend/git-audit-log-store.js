import { createAuditLogStore } from "./shared/base-audit-log-store.js";

export function createGitAuditLogStore(databasePath) {
  return createAuditLogStore(databasePath, {
    tableName: "git_audit_log",
    indexPrefix: "git_audit",
    providerColumns: [
      { name: "remote_url" },
      { name: "expected_ref" },
      { name: "previous_remote_ref" },
      { name: "new_remote_ref" },
    ],
    mapEntryToProviderValues: (entry) => [
      entry.remoteUrl || "",
      entry.expectedRef || "",
      entry.previousRemoteRef || "",
      entry.newRemoteRef || "",
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
