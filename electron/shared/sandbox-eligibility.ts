import { parseAgentCommand } from "./agent-ssh.js";

/**
 * Which tabs of an isolated workspace run inside the sandbox. Shared by the runtime (which decides) and
 * the renderer (which labels the tab "isolated"), so the label can never promise more than the runtime does.
 *
 * Agent tabs, plus a shell tab that opted in with `sandboxShell`: a tab running a Git UI or an SSH connection
 * is not wrapped. In a task workspace every Worker and Judge tab is, whatever command it runs.
 */

const GEMINI_EXECUTABLES = /^gemini(?:\.(?:exe|cmd|bat|com))?$/iu;

/** The agent a tab runs, by its command. Gemini is matched by its executable name: MCP launches do not parse it. */
export function detectSandboxAgent(command: unknown): string | null {
  const parsed = parseAgentCommand(command);
  if (parsed) return parsed.provider;
  const first = String(command || "")
    .trim()
    .split(/\s+/u)[0]
    ?.split(/[\\/]/u)
    .pop();
  return first && GEMINI_EXECUTABLES.test(first) ? "gemini" : null;
}

export interface SandboxEligibilityWorkspace {
  sandboxEnabled?: boolean;
  kind?: string;
}

export interface SandboxEligibilityPanel {
  command?: string;
  launch?: unknown;
  /** A shell tab the user chose to run isolated. It can only narrow: it does nothing in a workspace that is not isolated. */
  sandboxShell?: boolean;
}

export const TASK_DASHBOARD_COMMAND = "__task-dashboard__";

export function isSandboxedPanel(
  workspace: SandboxEligibilityWorkspace | null | undefined,
  panel: SandboxEligibilityPanel | null | undefined,
): boolean {
  if (!workspace || workspace.sandboxEnabled !== true || !panel) return false;
  if (panel.launch) return false;
  if (workspace.kind === "task") return panel.command !== TASK_DASHBOARD_COMMAND;
  if (detectSandboxAgent(panel.command) !== null) return true;
  return panel.sandboxShell === true && !String(panel.command || "").startsWith("__");
}
