/**
 * Electron's `ipcMain.handle` rejection reaches the renderer as a bare message ("Error invoking remote method …"):
 * custom fields such as `code` are dropped. A Jira failure therefore crosses IPC as an ordinary return value in this
 * envelope, and the sandboxed preload (which cannot import this file) turns it back into the same Error shape the
 * remote transport throws: `jiraError: { code, retryAfterMs? }` plus `code`.
 */
export const JIRA_IPC_FAILURE_MARKER = "__strideJiraFailure";

export interface JiraIpcFailure {
  [JIRA_IPC_FAILURE_MARKER]: 1;
  message: string;
  code: string;
  retryAfterMs?: number;
}

export function toJiraIpcFailure(error: { message: string; code: string; retryAfterMs?: number }): JiraIpcFailure {
  return {
    [JIRA_IPC_FAILURE_MARKER]: 1,
    message: error.message,
    code: error.code,
    ...(typeof error.retryAfterMs === "number" ? { retryAfterMs: error.retryAfterMs } : {}),
  };
}
