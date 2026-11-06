/** Remove private Jira bodies and polling membership from generic state broadcasts. */
export function stripJiraPrivatePayload(payload: unknown): void {
  if (!payload || typeof payload !== "object") return;
  const root = payload as Record<string, unknown>;
  const state = asRecord(root.appState) || root;
  const settings = asRecord(state.settings);
  const integrations = asRecord(settings?.integrations);
  const jira = asRecord(integrations?.jira);
  if (jira && typeof jira === "object") {
    delete jira.pollingState;
    delete jira.writeJournal;
    for (const value of Array.isArray(jira.connections) ? jira.connections : []) {
      const connection = asRecord(value);
      const auth = asRecord(connection?.auth);
      if (connection && auth) connection.auth = { kind: auth.kind };
    }
  }
  for (const value of Array.isArray(state.workspaces) ? state.workspaces : []) {
    const workspace = asRecord(value);
    if (workspace) delete workspace.jiraMcpCommentDrafts;
    const task = asRecord(workspace?.task);
    if (!task) continue;
    delete task.jiraPreparedSnapshot;
    delete task.jiraCommentDrafts;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
