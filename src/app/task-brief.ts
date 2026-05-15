// Shared limits and copy for the "task brief" / "task assignment" textareas
// that feed the initial prompt to a Worker agent. Used by the workspace
// creation dialog and the Task Dashboard hero editor so the cap and the
// guidance line stay aligned across surfaces.
//
// Keep TASK_BRIEF_MAX_CHARS in sync with electron/backend/ipc-schemas.ts
// (taskWorkspaceCreateSchema.description, taskUpdateDescriptionSchema.description).
export const TASK_BRIEF_MAX_CHARS = 20000;

export const TASK_BRIEF_HINT =
  'Tip: for long or detailed briefs, write the spec to a file in the workspace (e.g. PLAN.md) and just point the agent at it here — "Implement the plan in PLAN.md". Keeps the prompt readable and versions the spec alongside the code.';

export function formatBriefCounter(used: number, max: number = TASK_BRIEF_MAX_CHARS): string {
  return `${used.toLocaleString()} / ${max.toLocaleString()} characters`;
}
