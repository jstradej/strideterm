export type OpenInFilesTabResult = "opened" | "no-workspace" | "no-files-tab" | "outside";

interface FilesTabWorkspace {
  cwd?: string;
  panels?: Array<{ id: string; command?: string }>;
}

/**
 * The stores are imported lazily so that importing this module does not pull them into the importer's load graph.
 *
 * Show `absPath` in the Files tab of `ws`. "outside" means the Files pane could not show the path (it is not under
 * the workspace root).
 */
export async function openPathInWorkspaceFilesTab(
  ws: FilesTabWorkspace,
  absPath: string,
): Promise<Exclude<OpenInFilesTabResult, "no-workspace">> {
  const filesPanel = (ws.panels || []).find((p) => p?.command === "__files__");
  if (!filesPanel) return "no-files-tab";
  const [appMod, fmMod] = await Promise.all([import("../stores/app.js"), import("../stores/file-manager.js")]);
  await appMod.useAppStore().activateView(`files:${filesPanel.id}`);
  const fmStore = fmMod.useFileManagerStore();
  if (ws.cwd) await fmStore.init(ws.cwd);
  return (await fmStore.openFileAbsPath(absPath)) ? "opened" : "outside";
}

/**
 * Same, for the workspace `workspaceId`, looked up by id: right after a jump the active-workspace getter may not
 * have caught up.
 */
export async function openPathInFilesTab(workspaceId: string, absPath: string): Promise<OpenInFilesTabResult> {
  const { useAppStore } = await import("../stores/app.js");
  const workspaces = (useAppStore().payload?.appState?.workspaces || []) as Array<FilesTabWorkspace & { id: string }>;
  const ws = workspaces.find((item) => item?.id === workspaceId);
  return ws ? openPathInWorkspaceFilesTab(ws, absPath) : "no-workspace";
}
