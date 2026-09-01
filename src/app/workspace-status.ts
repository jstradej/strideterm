/**
 * THE semantic status of a workspace, as one shared resolver.
 *
 * The canonical workspace card has always drawn a small coloured dot on the
 * bottom-right corner of its icon badge. It is the fastest signal in the
 * sidebar — one glance says "that agent is still working", "that PR is open",
 * "that run failed" — and it deliberately answers for SEVERAL different
 * lifecycles at the same position:
 *
 *   - a task/agent run: `running`, `completed`, `failed`, `stopped`, `paused`;
 *   - a pull request: `active`, `merged`, `abandoned`;
 *   - a plain agent-like SESSION: `running` / `done` in a workspace that
 *     deliberately does NOT belong to the task-only RUNNING section.
 *
 * That last case is the reason this has to be shared rather than re-derived.
 * A hand-opened Claude Code terminal must not enter the moving RUNNING
 * section (V3 review, Fáze 1 — its rows appeared and vanished under the
 * pointer), but its status dot on a recent workspace row is stable and should
 * absolutely stay. The activity rows may not GUESS that meaning from a colour;
 * they have to read the same model the card reads (V6 review, §"P2 UX — Recent
 * zahazuje kanonický status dot na icon badge").
 *
 * So the mapping lives here, once, and `WorkspaceCard.vue` and both activity
 * surfaces call it. A second table of conditions in SidebarPanel is exactly how
 * the two renderings would drift apart again.
 *
 * Pure and dependency-free: no store, no Vue, no clock.
 *
 * NOT included: the CI / pipeline checks dot. It is a different semantics on a
 * different anchor (next to the title, not on the badge) and the plan scopes
 * this step to the badge status cue precisely (V6 plan, §"Oprava", bod 7).
 */

/**
 * Task states whose label is "the agent is working".
 *
 * Deliberately NOT `TASK_ACTIVE_STATES` from `electron/shared/task-states.ts`:
 * that set answers "does this task hold a session / count as a running agent",
 * and it excludes `showering` while including `capturing-context`. This one
 * answers "which dot does the user see", the question `WorkspaceCard.vue`'s
 * private `RUNNING_STATES` has always answered — moved here verbatim so the
 * card and the activity rows cannot disagree.
 */
const RUNNING_TASK_STATES: ReadonlySet<string> = new Set([
  "running",
  "evaluating",
  "judge-evaluating",
  "refreshing",
  "showering",
]);

/** Whether a task state means "working right now" for the status dot / pill. */
export function isTaskRunningState(state: string | null | undefined): boolean {
  return Boolean(state && RUNNING_TASK_STATES.has(state));
}

/**
 * The dot's semantic states. Each one is also the CSS modifier suffix, so the
 * card and the activity row are literally the same colour and glyph.
 */
export type WorkspaceStatusState =
  "running" | "completed" | "merged" | "failed" | "stopped" | "paused" | "pr-active" | "abandoned";

export interface WorkspaceStatusCue {
  state: WorkspaceStatusState;
  /** Human sentence for the tooltip and the row's accessible name. */
  label: string;
  /** Whether the dot pulses — reserved for states that are still in motion. */
  heartbeat: boolean;
}

/** The card fields this resolver reads. Structural, so any card-like works. */
export interface WorkspaceStatusSource {
  kind?: string;
  taskState?: string | null;
  prStatus?: string | null;
  agentActivityState?: string | null;
  agentActivityLabel?: string;
}

/**
 * Resolve the one status cue for a workspace, or `null` when it has no state
 * worth a dot.
 *
 * Precedence, unchanged from the card's original mapping: a task's own
 * lifecycle first (it is the most specific thing the workspace is doing), then
 * a plain agent session, then the pull request the workspace reviews — with
 * one exception, spelled out below: a session that is running RIGHT NOW
 * outranks a task that has already settled.
 */
export function resolveWorkspaceStatusCue(source: WorkspaceStatusSource | null | undefined): WorkspaceStatusCue | null {
  if (!source) return null;
  const { kind, taskState, prStatus, agentActivityState, agentActivityLabel } = source;

  if (kind === "task" && taskState) {
    if (isTaskRunningState(taskState)) return { state: "running", label: "Running…", heartbeat: true };
    // A settled task does not end the workspace: its worktree stays open and
    // the user drives it by hand. A panel that is running right now is the
    // more current truth than the run that finished earlier — the tab already
    // says "running", so the sidebar dot has to pulse with it instead of
    // showing the workspace as idle while an agent types in it.
    //
    // Only `running` outranks the settled state. A `done` session adds nothing
    // over "Completed" and would wrongly soften "Failed" into a green dot.
    if (agentActivityState === "running") {
      return { state: "running", label: agentActivityLabel || "Agent is working", heartbeat: true };
    }
    if (taskState === "failed") return { state: "failed", label: "Failed", heartbeat: false };
    if (taskState === "stopped") return { state: "stopped", label: "Stopped", heartbeat: false };
    if (taskState === "paused") return { state: "paused", label: "Paused", heartbeat: false };
    if (taskState === "completed" || taskState === "done") {
      if (prStatus === "completed") return { state: "merged", label: "Done · PR merged", heartbeat: false };
      return { state: "completed", label: "Completed", heartbeat: false };
    }
  }

  if (agentActivityState === "running") {
    return { state: "running", label: agentActivityLabel || "Agent is working", heartbeat: true };
  }
  if (agentActivityState === "done") {
    return { state: "completed", label: agentActivityLabel || "Agent finished", heartbeat: false };
  }

  if (prStatus === "active") return { state: "pr-active", label: "PR open", heartbeat: true };
  if (prStatus === "completed") return { state: "merged", label: "PR merged", heartbeat: false };
  if (prStatus === "abandoned") return { state: "abandoned", label: "PR abandoned", heartbeat: false };

  return null;
}
