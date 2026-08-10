/**
 * Attached-mode ("Companion loop") Primary relocation.
 *
 * While a companion loop is live, the source workspace's Primary tab is
 * PRESENTED inside the companion task workspace next to the Dashboard and the
 * Companion terminal. The move is presentation-only:
 *
 *   viewId     attached-primary:<taskWorkspaceId>   — where the tab is shown
 *   sessionId  <sourceWorkspaceId>:<sourcePanelId>  — the real PTY target
 *
 * The panel object never leaves `sourceWorkspace.panels`, the session id never
 * changes, and nothing about the PTY / replay / hooks / task binding is
 * re-keyed. `viewId` and `sessionId` are NOT interchangeable — every terminal
 * operation must go through the session id, every layout/activation decision
 * through the view id.
 *
 * Hosting is DERIVED, never persisted: the binding already exists on the
 * attached task (`workerWorkspaceId` / `workerPanelId`), so there is no
 * `moved` flag, no snapshot and no second lifecycle to keep in sync. This
 * module is the single shared predicate — the renderer decides where to draw
 * the tab with it, and the backend decides whether the source may be deleted
 * with the same function, so the two can never disagree.
 *
 * Dependency-free (same rule as shared/types/task.ts) so it can be imported by
 * the frontend bundle, the Electron main process and the remote server alike.
 */

export const COMPANION_PRIMARY_VIEW_PREFIX = "attached-primary:";

/**
 * Task states in which the Primary is shown inside the task workspace.
 *
 * `completed` and `failed` are the RETURN states — the agent run is over, so
 * the tab goes back to where it came from (a later "Send back" re-hosts it).
 * `paused` stays hosted: the loop is not finished, it is only waiting.
 *
 * Fail-closed by construction: an unknown/future state is not in the set, so
 * the Primary simply stays in its own workspace until someone adds it here
 * deliberately.
 */
export const COMPANION_PRIMARY_HOSTED_STATES: ReadonlySet<string> = new Set([
  "idle",
  "capturing-context",
  "brief-ready",
  "running",
  "evaluating",
  "judge-evaluating",
  "refreshing",
  "awaiting-user",
  "paused",
]);

/** Minimal shape of TaskState this module reads. */
export interface CompanionPrimaryTaskLike {
  mode?: string;
  state?: string;
  primaryMissing?: boolean;
  workerWorkspaceId?: string;
  workerPanelId?: string;
  companionRole?: string;
}

export interface CompanionPrimaryPanelLike {
  id: string;
  title?: string;
  command?: string;
}

export interface CompanionPrimaryWorkspaceLike {
  id: string;
  name?: string;
  kind?: string;
  profileId?: string;
  panels?: CompanionPrimaryPanelLike[];
  task?: CompanionPrimaryTaskLike | null;
}

/** Live per-workspace task-runner snapshot (payload.taskRunner), when available. */
export type CompanionPrimaryTaskRunner = Record<string, CompanionPrimaryTaskLike | undefined> | null | undefined;

export interface CompanionPrimaryBinding {
  /** Workspace that HOSTS the tab (the companion task workspace). */
  taskWorkspaceId: string;
  /** Virtual view id the tab is rendered under. */
  viewId: string;
  /** Workspace that OWNS the session (attention, panel, cwd, layout). */
  sourceWorkspaceId: string;
  sourcePanelId: string;
  /** The real PTY target — `${sourceWorkspaceId}:${sourcePanelId}`. */
  sourceSessionId: string;
  companionRole: string;
  sourceWorkspaceName: string;
  sourcePanelTitle: string;
  taskWorkspaceName: string;
}

export function companionPrimaryViewId(taskWorkspaceId: string): string {
  return `${COMPANION_PRIMARY_VIEW_PREFIX}${taskWorkspaceId}`;
}

export function isCompanionPrimaryViewId(value: unknown): boolean {
  return String(value || "").startsWith(COMPANION_PRIMARY_VIEW_PREFIX);
}

/** Task workspace id encoded in a virtual Primary view id, or "" if not one. */
export function parseCompanionPrimaryViewId(value: unknown): string {
  const raw = String(value || "");
  return raw.startsWith(COMPANION_PRIMARY_VIEW_PREFIX) ? raw.slice(COMPANION_PRIMARY_VIEW_PREFIX.length) : "";
}

/**
 * The single hosting predicate. True when this task's Primary belongs in the
 * task workspace rather than its own. Callers that also need the source
 * workspace/panel to still exist use resolveCompanionPrimaryBinding().
 */
export function isCompanionPrimaryHosted(task: CompanionPrimaryTaskLike | null | undefined): boolean {
  if (!task || task.mode !== "attached") return false;
  if (task.primaryMissing === true) return false;
  if (!task.workerWorkspaceId || !task.workerPanelId) return false;
  return COMPANION_PRIMARY_HOSTED_STATES.has(String(task.state || ""));
}

/**
 * Persisted task merged with the live runner state for the same workspace.
 * The runner is authoritative for `state`; everything else (the binding, the
 * missing-Primary flag) lives on the persisted task. The backend has no
 * taskRunner map — it passes nothing and reads the persisted state, which the
 * runner keeps in sync.
 */
export function effectiveCompanionTask(
  workspace: CompanionPrimaryWorkspaceLike | null | undefined,
  taskRunner?: CompanionPrimaryTaskRunner,
): CompanionPrimaryTaskLike | null {
  const persisted = workspace?.task;
  if (!persisted) return null;
  const live = taskRunner?.[workspace!.id];
  if (!live) return persisted;
  return { ...persisted, ...live };
}

function findWorkspace(
  workspaces: readonly CompanionPrimaryWorkspaceLike[],
  workspaceId: string,
): CompanionPrimaryWorkspaceLike | null {
  return workspaces.find((workspace) => workspace?.id === workspaceId) || null;
}

/**
 * Full binding for a companion task workspace, or null when the Primary is not
 * currently hosted there. Validates against the workspace list the CALLER can
 * see — on the remote slim core that list is already profile-scoped, so a
 * viewer in another profile resolves nothing and can neither render the alias
 * nor subscribe to the session. The desktop list is not scoped, so the profile
 * is compared explicitly here too.
 */
export function resolveCompanionPrimaryBinding(
  workspaces: readonly CompanionPrimaryWorkspaceLike[] | null | undefined,
  taskRunner: CompanionPrimaryTaskRunner,
  taskWorkspaceId: string,
): CompanionPrimaryBinding | null {
  if (!taskWorkspaceId) return null;
  const list = workspaces || [];
  const taskWorkspace = findWorkspace(list, taskWorkspaceId);
  if (!taskWorkspace || taskWorkspace.kind !== "task") return null;

  const task = effectiveCompanionTask(taskWorkspace, taskRunner);
  if (!isCompanionPrimaryHosted(task)) return null;

  const sourceWorkspace = findWorkspace(list, String(task!.workerWorkspaceId));
  if (!sourceWorkspace) return null;
  if ((sourceWorkspace.profileId || "default") !== (taskWorkspace.profileId || "default")) return null;

  const sourcePanelId = String(task!.workerPanelId);
  const sourcePanel = (sourceWorkspace.panels || []).find((panel) => panel?.id === sourcePanelId);
  if (!sourcePanel) return null;

  return {
    taskWorkspaceId,
    viewId: companionPrimaryViewId(taskWorkspaceId),
    sourceWorkspaceId: sourceWorkspace.id,
    sourcePanelId,
    sourceSessionId: `${sourceWorkspace.id}:${sourcePanelId}`,
    companionRole: String(task!.companionRole || "reviewer"),
    sourceWorkspaceName: sourceWorkspace.name || sourceWorkspace.id,
    sourcePanelTitle: sourcePanel.title || sourcePanelId,
    taskWorkspaceName: taskWorkspace.name || taskWorkspace.id,
  };
}

/**
 * Reverse lookup used by the source workspace: is this panel (or any panel of
 * this workspace) currently presented inside a companion task workspace?
 * Returns the first such binding — a Primary can only be attached to one
 * companion loop at a time, since creating a second one over the same panel is
 * refused at create time.
 */
export function findCompanionPrimaryHost(
  workspaces: readonly CompanionPrimaryWorkspaceLike[] | null | undefined,
  taskRunner: CompanionPrimaryTaskRunner,
  sourceWorkspaceId: string,
  sourcePanelId?: string,
): CompanionPrimaryBinding | null {
  if (!sourceWorkspaceId) return null;
  for (const workspace of workspaces || []) {
    if (workspace?.kind !== "task") continue;
    const task = effectiveCompanionTask(workspace, taskRunner);
    if (task?.workerWorkspaceId !== sourceWorkspaceId) continue;
    if (sourcePanelId && task?.workerPanelId !== sourcePanelId) continue;
    const binding = resolveCompanionPrimaryBinding(workspaces, taskRunner, workspace.id);
    if (binding) return binding;
  }
  return null;
}

/**
 * Panel ids of `sourceWorkspaceId` whose tab is currently hosted elsewhere, so
 * the source tab strip can hide them. Presentation-hidden, NOT removed: the
 * panel, its order and the persisted layout all stay untouched.
 */
export function companionPrimaryHostedPanelIds(
  workspaces: readonly CompanionPrimaryWorkspaceLike[] | null | undefined,
  taskRunner: CompanionPrimaryTaskRunner,
  sourceWorkspaceId: string,
): Set<string> {
  const hidden = new Set<string>();
  if (!sourceWorkspaceId) return hidden;
  for (const workspace of workspaces || []) {
    if (workspace?.kind !== "task") continue;
    const task = effectiveCompanionTask(workspace, taskRunner);
    if (task?.workerWorkspaceId !== sourceWorkspaceId) continue;
    const binding = resolveCompanionPrimaryBinding(workspaces, taskRunner, workspace.id);
    if (binding) hidden.add(binding.sourcePanelId);
  }
  return hidden;
}
