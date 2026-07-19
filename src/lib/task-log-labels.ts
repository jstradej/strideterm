/**
 * Canonical event-id -> label/category mapping for TASK_LOG.jsonl entries.
 *
 * Previously TaskDashboardStatusTab.vue and TaskDashboardLogTab.vue each kept
 * their own EVENT_LABELS map and the two had drifted: the Log tab's map didn't
 * know about `judge-nudged` / `verdict-rejected`, so those events fell back to
 * showing the raw event id string instead of a proper label. This module is
 * the single source of truth both tabs import from — the union of every event
 * type either component knew about, using the more-complete label text where
 * they previously disagreed (e.g. "Worker idle detected" over "Worker idle").
 */
const EVENT_LABELS: Record<string, string> = {
  "task-started": "Task started",
  "task-stopped": "Task stopped",
  "task-paused": "Task paused",
  "task-resumed": "Task resumed",
  "task-reset": "Task reset",
  "task-completed": "Task completed",
  "task-failed": "Task failed",
  "evaluation-complete": "Checks finished",
  "worker-reprompted": "Worker re-prompted",
  "judge-requested": "Judge requested",
  "judge-verdict": "Judge verdict",
  "judge-nudged": "Judge nudged",
  "shower-started": "Context refresh",
  "shower-completed": "Refresh done",
  "shower-failed": "Refresh failed",
  "worker-idle-detected": "Worker idle detected",
  "verdict-rejected": "User rejected verdict",
};

export function eventLabel(event: string): string {
  return EVENT_LABELS[event] || event;
}

export function eventCategory(event: string): string {
  if (event === "task-completed") return "success";
  if (event === "task-failed" || event === "shower-failed") return "error";
  if (event.startsWith("judge-")) return "judge";
  if (event.startsWith("shower-")) return "shower";
  if (event === "worker-reprompted" || event === "verdict-rejected") return "warn";
  return "info";
}
