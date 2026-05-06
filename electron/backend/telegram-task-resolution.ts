/**
 * Pure resolution helper for Telegram-driven `start-task` commands.
 *
 * The runtime's command handler used to walk up the parent chain to find a
 * "proper project root" workspace and used that root's cwd as the new task's
 * cwd. That broke the very common flow:
 *
 *   1. User runs `/task`, picks a project, picks "Existing worktree" → the
 *      new task workspace is created with `parentWorkspaceId = main project`
 *      but `cwd = worktree path` (correct).
 *   2. The task completes and Telegram pings the user.
 *   3. The user replies to that completion notification with a new task
 *      description.
 *   4. The runtime walked up from the task workspace to the `main project`
 *      and used `main.cwd` for the new task — the new task ran in the main
 *      branch instead of the worktree the user was clearly working in.
 *
 * This helper centralises the resolution logic so the runtime, tests, and
 * any future UI surface (e.g. "do another task") all share one definition.
 */

interface MinimalWorkspace {
  id: string;
  name: string;
  cwd: string;
  kind: string;
  review?: { parentWorkspaceId?: string } | null;
  quickfix?: { parentWorkspaceId?: string } | null;
  task?: { parentWorkspaceId?: string } | null;
}

export interface ResolveTaskTargetInput<W extends MinimalWorkspace> {
  /** The full workspace list. */
  workspaces: W[];
  /** The workspaceId carried by the Telegram start-task command (origin). */
  sourceWorkspaceId: string;
  /**
   * Optional explicit cwd override — used when the user picked
   * "Existing worktree" via `/task`. When set, this always wins.
   */
  targetCwd?: string | null;
}

export interface ResolveTaskTargetResult<W extends MinimalWorkspace> {
  /** The workspace to attach the new task to (parent in the sidebar tree). */
  parentWorkspace: W | null;
  /** The cwd the new task should run in. Empty if no parent could be found. */
  taskCwd: string;
  /** The original source workspace, if it could be found. */
  source: W | null;
  /** Why the cwd was picked — useful for telemetry / log messages. */
  cwdReason: "explicit" | "source-overrides-root" | "root" | "none";
}

function isProperRoot<W extends MinimalWorkspace>(w: W | null | undefined): boolean {
  if (!w || !w.cwd) return false;
  if (w.kind === "azure" || w.kind === "github" || w.kind === "docker" || w.kind === "task") return false;
  if (w.review || w.quickfix || w.task) return false;
  return true;
}

function getParentId<W extends MinimalWorkspace>(w: W | null | undefined): string {
  if (!w) return "";
  return w.task?.parentWorkspaceId || w.review?.parentWorkspaceId || w.quickfix?.parentWorkspaceId || "";
}

function trim(value: string | null | undefined): string {
  return String(value || "").trim();
}

/**
 * Resolve the parent workspace + cwd to use when starting a Telegram task.
 *
 * Cwd priority (first match wins):
 *   1. `targetCwd` — explicit override (the user picked "Existing worktree"
 *      via `/task`).
 *   2. The source workspace's own cwd, IF it differs from the resolved root
 *      — covers the "task agent ran in a worktree, completed, user replied
 *      to the completion notification" case so the new task continues in
 *      the same worktree.
 *   3. The resolved-root's cwd.
 *
 * Parent priority:
 *   - First ancestor that satisfies `isProperRoot` (regular project, has
 *     cwd, not a task/review/quickfix/inbox child).
 *   - Fallback: the source workspace itself if it has a cwd (covers PR
 *     review and quickfix workspaces).
 *   - Otherwise null.
 */
export function resolveTelegramTaskTarget<W extends MinimalWorkspace>(
  input: ResolveTaskTargetInput<W>,
): ResolveTaskTargetResult<W> {
  const byId = new Map<string, W>(input.workspaces.map((w) => [w.id, w]));
  const source = byId.get(input.sourceWorkspaceId) || null;

  let walker = source;
  let resolved: W | null = isProperRoot(walker) ? walker : null;
  const seen = new Set<string>();
  while (walker && !resolved && !seen.has(walker.id)) {
    seen.add(walker.id);
    const upId = getParentId(walker);
    if (!upId) break;
    walker = byId.get(upId) || null;
    if (isProperRoot(walker)) {
      resolved = walker;
    }
  }
  const parentWorkspace: W | null = resolved || (source?.cwd ? source : null);
  if (!parentWorkspace) {
    return { parentWorkspace: null, taskCwd: "", source, cwdReason: "none" };
  }

  const explicit = trim(input.targetCwd);
  const sourceCwd = trim(source?.cwd);
  const rootCwd = trim(parentWorkspace.cwd);

  if (explicit) {
    return { parentWorkspace, taskCwd: explicit, source, cwdReason: "explicit" };
  }
  if (sourceCwd && sourceCwd !== rootCwd) {
    return { parentWorkspace, taskCwd: sourceCwd, source, cwdReason: "source-overrides-root" };
  }
  return { parentWorkspace, taskCwd: rootCwd, source, cwdReason: "root" };
}
