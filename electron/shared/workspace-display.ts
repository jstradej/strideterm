import type { WorkspaceState } from "./types/state.js";

/**
 * Display name for a workspace as shown in the UI (sidebar card) and in
 * outbound notifications (Telegram alerts, in-app attention chips).
 *
 * For task agents that have a `sequenceNumber` we append " #N" so multiple
 * agents inheriting the same name from their parent workspace can be told
 * apart at a glance — without this, a notification like "📍 mhub › Worker"
 * is indistinguishable across three running agents on the same project.
 *
 * Pre-existing tasks created before the sequenceNumber field was introduced
 * have `sequenceNumber === undefined` and render with the plain name; this
 * is intentional backward compatibility, not a bug.
 */
export function formatWorkspaceDisplayName(
  workspace: Pick<WorkspaceState, "kind" | "name" | "task"> | null | undefined,
): string {
  if (!workspace) return "";
  if (workspace.kind === "task" && typeof workspace.task?.sequenceNumber === "number") {
    return `${workspace.name} #${workspace.task.sequenceNumber}`;
  }
  return workspace.name;
}
