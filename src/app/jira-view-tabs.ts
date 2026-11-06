export function jiraViewTabId(workspaceId: string, viewId: string): string {
  if (!workspaceId) return "";
  if (viewId === "issues") return `jira:${workspaceId}`;
  return `jira:${workspaceId}:view:${encodeURIComponent(viewId)}`;
}

export function jiraViewIdFromTab(tabId: string, workspaceId: string): string | null {
  if (!workspaceId) return null;
  const rootId = `jira:${workspaceId}`;
  if (tabId === rootId) return "issues";
  const prefix = `${rootId}:view:`;
  if (!tabId.startsWith(prefix)) return null;
  try {
    const viewId = decodeURIComponent(tabId.slice(prefix.length));
    return viewId && viewId !== "issues" ? viewId : null;
  } catch {
    return null;
  }
}
