/**
 * Canonical "this task is working right now" vocabulary, shared by the backend
 * runner and the frontend surfaces that visualise running agents.
 *
 * Dependency-free (same rule as shared/types/task.ts and companion-primary.ts)
 * so it can be imported by the frontend bundle, the Electron main process and
 * the remote server alike.
 */

/**
 * Task states that count as "the agent is working".
 *
 * This is the set the runner already uses verbatim in three places —
 * `reconcileOnStartup` (agent-task-runner.ts, the startup recovery sweep),
 * `onSessionExit` (the worker-crash guard) and `#setTaskState` (elapsed
 * timing) — and that `TaskDashboardPane.vue`'s `ACTIVE_STATES` mirrors for the
 * elapsed timer. Those four copies are deliberately left in place (touching
 * the runner's timing is risk without benefit here), so this constant is the
 * shared definition new code reads: if one of them ever drifts, reading this
 * comment is how you find the other three.
 *
 * `capturing-context` IS included — it is an active attached state in which
 * `COMPANION_PRIMARY_HOSTED_STATES` already hosts the Primary in the task
 * workspace, so work is genuinely under way.
 *
 * `showering` is NOT included — the canonical set never contained it (the
 * post-refresh state is `refreshing`). `RUNNING_STATES` in WorkspaceCard.vue
 * is a separate, deliberately divergent copy answering a different question
 * (which label the status pill shows) and is not unified with this one.
 */
export const TASK_ACTIVE_STATES: ReadonlySet<string> = new Set([
  "running",
  "evaluating",
  "judge-evaluating",
  "refreshing",
  "capturing-context",
]);

/** The two agent roles a task binds a session to. */
export type TaskBindingRole = "worker" | "judge";

/** Minimal shape of TaskState this module reads. */
export interface TaskStatesTaskLike {
  mode?: string;
  workerWorkspaceId?: string;
  workerPanelId?: string;
  judgePanelId?: string;
}

/** Minimal shape of a task workspace this module reads. */
export interface TaskStatesWorkspaceLike {
  id: string;
  task?: TaskStatesTaskLike | null;
}

/**
 * Canonical session id for a task workspace's worker/"Primary" or
 * judge/"Companion" role. Standard tasks: both roles live in the task
 * workspace itself, so this returns exactly what every call site used to
 * hardcode inline. Attached (Companion loop) tasks: the worker/"Primary"
 * role is an EXTERNALLY OWNED session living in a different workspace
 * (`task.workerWorkspaceId`) — every write path (inject/clear/restart/alert)
 * must go through this helper instead of hardcoding
 * `${workspace.id}:${task.workerPanelId}`.
 *
 * Structurally typed on purpose (same pattern as
 * `CompanionPrimaryWorkspaceLike`) so the renderer can call it over the plain
 * `WorkspaceState` objects it gets in the state payload.
 */
export function sessionIdFor(workspace: TaskStatesWorkspaceLike, role: TaskBindingRole): string {
  const task = workspace.task;
  if (role === "judge") return `${workspace.id}:${task?.judgePanelId}`;
  if (task?.mode === "attached" && task.workerWorkspaceId) {
    return `${task.workerWorkspaceId}:${task.workerPanelId}`;
  }
  return `${workspace.id}:${task?.workerPanelId}`;
}
