import { ipcMain, dialog, BrowserWindow, shell } from "electron";

export function registerIpc(runtime, emitToRenderer) {
  const subscriptions = [
    runtime.on("state:updated", (payload) => emitToRenderer("state:updated", payload)),
    runtime.on("terminal:data", (payload) => emitToRenderer("terminal:data", payload)),
    runtime.on("terminal:exit", (payload) => emitToRenderer("terminal:exit", payload)),
  ];

  ipcMain.handle("state:get", async () => runtime.getInitialState());
  ipcMain.handle("shell:open-external", async (_event, url) => {
    if (typeof url === "string" && /^https?:\/\//i.test(url)) {
      return shell.openExternal(url);
    }
  });
  ipcMain.handle("workspace:activate", async (_event, workspaceId) => runtime.activateWorkspace(workspaceId));
  ipcMain.handle("project:activate", async (_event, projectId) => runtime.activateProject(projectId));
  ipcMain.handle("workspace:save", async (_event, workspace) => runtime.saveWorkspace(workspace));
  ipcMain.handle("project:save", async (_event, project) => runtime.saveProject(project));
  ipcMain.handle("workspace:delete", async (_event, workspaceId) => runtime.deleteWorkspace(workspaceId));
  ipcMain.handle("project:delete", async (_event, projectId) => runtime.deleteProject(projectId));
  ipcMain.handle("workspace:reorder", async (_event, workspaceIds) => runtime.reorderWorkspaces(workspaceIds));
  ipcMain.handle("project:reorder", async (_event, projectIds) => runtime.reorderProjects(projectIds));
  ipcMain.handle("settings:update", async (_event, settings) => {
    const { payload, remoteAccessChanged } = await runtime.updateSettings(settings);
    return { payload, remoteAccessChanged };
  });
  ipcMain.handle("session:activate", async (_event, sessionId) => runtime.activateSession(sessionId));
  ipcMain.handle("attention:sync", async (_event, payload) => runtime.syncAttentionContext(payload));
  ipcMain.handle("terminal:restart", async (_event, sessionId) => runtime.restartSession(sessionId));
  ipcMain.handle("terminal:close", async (_event, sessionId) => runtime.closeSession(sessionId));
  ipcMain.handle("remote:token:regenerate", async () => runtime.regenerateRemoteToken());
  ipcMain.handle("tunnel:refresh", async () => runtime.refreshTunnelState());
  ipcMain.handle("tunnel:create", async () => runtime.createCloudflareTunnel());
  ipcMain.handle("tunnel:stop", async () => runtime.stopCloudflareTunnel());
  ipcMain.handle("docker:refresh", async () => runtime.refreshDockerState());
  ipcMain.handle("git:refresh", async (_event, projectId) => runtime.refreshGitState(projectId));
  ipcMain.handle("git:fetch", async (_event, payload) => runtime.gitFetch(payload));
  ipcMain.handle("git:merge-into-current", async (_event, payload) => runtime.gitMergeIntoCurrent(payload));
  ipcMain.handle("git:rebase-onto", async (_event, payload) => runtime.gitRebaseOnto(payload));
  ipcMain.handle("git:continue", async (_event, payload) => runtime.gitContinueOperation(payload));
  ipcMain.handle("git:abort", async (_event, payload) => runtime.gitAbortOperation(payload));
  ipcMain.handle("git:diff-preview", async (_event, payload) => runtime.gitDiffPreview(payload));
  ipcMain.handle("git:merge-into-base", async (_event, payload) => runtime.gitMergeCurrentIntoBase(payload));
  ipcMain.handle("git:remove-worktree", async (_event, payload) => runtime.gitRemoveWorktree(payload));
  ipcMain.handle("git:commit-all", async (_event, payload) => runtime.gitCommitAll(payload));
  ipcMain.handle("git:commit-diff", async (_event, payload) => runtime.gitCommitDiff(payload));
  ipcMain.handle("docker:action", async (_event, action, containerId) => runtime.dockerAction(action, containerId));
  ipcMain.handle("docker:open-session", async (_event, payload) => runtime.openDockerSession(payload));
  ipcMain.handle("docker:open-lazydocker", async (_event, payload) => runtime.openLazydockerSession(payload));
  ipcMain.handle("git:open-lazygit", async (_event, payload) => runtime.openLazygitSession(payload));
  ipcMain.handle("git:create-worktree", async (_event, payload) => runtime.createWorktree(payload));
  ipcMain.handle("plugins:list", async () => runtime.getPlugins());
  ipcMain.handle("plugins:workspace-template", async (_event, pluginId) => runtime.getPluginWorkspaceTemplate(pluginId));
  ipcMain.handle("profile:save", async (_event, profile) => runtime.saveProfile(profile));
  ipcMain.handle("profile:delete", async (_event, profileId) => runtime.deleteProfile(profileId));
  ipcMain.handle("profile:activate", async (_event, profileId) => runtime.activateProfile(profileId));

  ipcMain.handle("dialog:browse-directory", async (_event, defaultPath) => {
    const win = BrowserWindow.getFocusedWindow();
    const result = await dialog.showOpenDialog(win, {
      properties: ["openDirectory"],
      defaultPath: defaultPath || undefined,
    });
    return result.canceled ? null : result.filePaths[0] || null;
  });

  ipcMain.handle("dialog:browse-file", async (_event, options = {}) => {
    const win = BrowserWindow.getFocusedWindow();
    const result = await dialog.showOpenDialog(win, {
      properties: ["openFile"],
      defaultPath: options.defaultPath || undefined,
      filters: options.filters || [],
    });
    return result.canceled ? null : result.filePaths[0] || null;
  });

  ipcMain.on("terminal:resize", (_event, sessionId, size) => {
    runtime.resizeSession(sessionId, size);
  });

  ipcMain.on("terminal:input", (_event, sessionId, data) => {
    runtime.writeToSession(sessionId, data);
  });

  return () => {
    subscriptions.forEach((unsubscribe) => unsubscribe());
    ipcMain.removeHandler("state:get");
    ipcMain.removeHandler("workspace:activate");
    ipcMain.removeHandler("project:activate");
    ipcMain.removeHandler("workspace:save");
    ipcMain.removeHandler("project:save");
    ipcMain.removeHandler("workspace:delete");
    ipcMain.removeHandler("project:delete");
    ipcMain.removeHandler("workspace:reorder");
    ipcMain.removeHandler("project:reorder");
    ipcMain.removeHandler("settings:update");
    ipcMain.removeHandler("session:activate");
    ipcMain.removeHandler("attention:sync");
    ipcMain.removeHandler("terminal:restart");
    ipcMain.removeHandler("terminal:close");
    ipcMain.removeHandler("remote:token:regenerate");
    ipcMain.removeHandler("tunnel:refresh");
    ipcMain.removeHandler("tunnel:create");
    ipcMain.removeHandler("tunnel:stop");
    ipcMain.removeHandler("docker:refresh");
    ipcMain.removeHandler("git:refresh");
    ipcMain.removeHandler("git:fetch");
    ipcMain.removeHandler("git:merge-into-current");
    ipcMain.removeHandler("git:rebase-onto");
    ipcMain.removeHandler("git:continue");
    ipcMain.removeHandler("git:abort");
    ipcMain.removeHandler("git:diff-preview");
    ipcMain.removeHandler("git:merge-into-base");
    ipcMain.removeHandler("git:remove-worktree");
    ipcMain.removeHandler("git:commit-all");
    ipcMain.removeHandler("git:commit-diff");
    ipcMain.removeHandler("docker:action");
    ipcMain.removeHandler("docker:open-session");
    ipcMain.removeHandler("docker:open-lazydocker");
    ipcMain.removeHandler("git:open-lazygit");
    ipcMain.removeHandler("git:create-worktree");
    ipcMain.removeHandler("plugins:list");
    ipcMain.removeHandler("plugins:workspace-template");
    ipcMain.removeHandler("profile:save");
    ipcMain.removeHandler("profile:delete");
    ipcMain.removeHandler("profile:activate");
    ipcMain.removeHandler("dialog:browse-directory");
    ipcMain.removeHandler("dialog:browse-file");
    ipcMain.removeHandler("shell:open-external");
    ipcMain.removeAllListeners("terminal:resize");
    ipcMain.removeAllListeners("terminal:input");
  };
}
