/// <reference types="node" />
import { createAuditLogStore } from "./shared/base-audit-log-store.js";

/**
 * Telegram audit log: every Telegram-driven side-effect (alert forwarded,
 * command received, action dispatched) is recorded here so the user can
 * later inspect what their bot did, and so write actions (start-task,
 * open-pr-review) leave a permanent trail outside the rolling Winston log.
 */
export function createTelegramAuditLogStore(databasePath: string) {
  return createAuditLogStore(databasePath, {
    tableName: "telegram_audit_log",
    indexPrefix: "telegram_audit",
    providerColumns: [
      { name: "chat_id", default: "" },
      { name: "workspace_id", default: "" },
    ],
    mapEntryToProviderValues: (entry) => [String(entry.chatId || ""), String(entry.workspaceId || "")],
    mapRowToProviderFields: (row) => ({ chatId: row.chat_id, workspaceId: row.workspace_id }),
    searchFields: ["chat_id", "workspace_id"],
  });
}

export type TelegramAuditLogStore = ReturnType<typeof createTelegramAuditLogStore>;
