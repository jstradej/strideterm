/**
 * Runtime context subset consumed by Docker handlers.
 * The full runtime ctx is typed as a structural interface so new fields
 * can be added without breaking this module.
 */
interface DockerHandlerCtx {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  docker: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dockerLogManager: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dockerShellManager: any;
  getPayload: () => unknown;
  refreshDocker: () => Promise<void>;
  ensureDockerPolling: () => void;
}

/**
 * Factory for Docker operation API handlers — pure delegation to the
 * Docker manager and the log-stream / shell-stream managers.
 * Extracted from runtime.ts to reduce file size.
 */
export function createDockerHandlers(ctx: DockerHandlerCtx) {
  const { docker, dockerLogManager, dockerShellManager, getPayload, refreshDocker, ensureDockerPolling } = ctx;

  return {
    async refreshDockerState() {
      // This is the user hitting Refresh, so re-probe from scratch instead of
      // reusing the detection cache. It's the escape hatch for a backend that
      // appeared after we last looked — notably a docker CLI installed mid-
      // session, which the "not installed" memo would otherwise hide until a
      // restart.
      docker.invalidateBackendDetectionCache();
      await refreshDocker();
      return getPayload();
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async dockerAction(action: any, containerId: any, backendId?: any, contextName?: any) {
      const allowedActions = new Set(["start", "stop", "restart", "remove"]);
      if (!allowedActions.has(action)) {
        throw new Error(`Invalid Docker action: ${action}`);
      }
      await docker.performAction(
        action,
        containerId,
        backendId ? String(backendId) : undefined,
        contextName ? String(contextName) : undefined,
      );
      return getPayload();
    },
    async dockerLogsOpen(
      sessionId: string,
      containerId: string,
      backendId: string,
      contextName: string,
      onData: (sessionId: string, data: Buffer) => void,
      onClose: (sessionId: string, code: number | null) => void,
      options: { timestamps?: boolean; tail?: number | "all" } = {},
    ): Promise<void> {
      const backend = docker.getBackendForLogs(backendId);
      if (!backend) {
        throw new Error(`Docker backend not found: ${backendId}`);
      }
      dockerLogManager.openSession(sessionId, backend, contextName, containerId, onData, onClose, options);
      ensureDockerPolling();
    },
    dockerLogsUpdate(sessionId: string, options: { timestamps?: boolean; tail?: number | "all" }): boolean {
      return dockerLogManager.updateSession(sessionId, options);
    },
    dockerLogsClose(sessionId: string): void {
      dockerLogManager.closeSession(sessionId);
      ensureDockerPolling();
    },
    async dockerShellOpen(
      sessionId: string,
      containerId: string,
      backendId: string,
      contextName: string,
      cols: number,
      rows: number,
      onData: (sessionId: string, data: string) => void,
      onClose: (sessionId: string, code: number | null) => void,
    ): Promise<void> {
      const backend = docker.getBackendForLogs(backendId);
      if (!backend) {
        throw new Error(`Docker backend not found: ${backendId}`);
      }
      dockerShellManager.openSession(sessionId, backend, contextName, containerId, cols, rows, onData, onClose);
      ensureDockerPolling();
    },
    dockerShellWrite(sessionId: string, data: string): void {
      dockerShellManager.writeSession(sessionId, data);
    },
    dockerShellResize(sessionId: string, cols: number, rows: number): void {
      dockerShellManager.resizeSession(sessionId, cols, rows);
    },
    dockerShellClose(sessionId: string): void {
      dockerShellManager.closeSession(sessionId);
      ensureDockerPolling();
    },
    async dockerInspect(containerId: string, backendId: string, contextName: string): Promise<string> {
      return docker.inspectContainer(containerId, backendId, contextName);
    },
    async dockerImageInspect(imageId: string, backendId: string, contextName: string): Promise<string> {
      return docker.inspectImage(imageId, backendId, contextName);
    },
    async dockerVolumeInspect(volumeName: string, backendId: string, contextName: string): Promise<string> {
      return docker.inspectVolume(volumeName, backendId, contextName);
    },
    async dockerNetworkInspect(networkId: string, backendId: string, contextName: string): Promise<string> {
      return docker.inspectNetwork(networkId, backendId, contextName);
    },
    async dockerImageRemove(imageId: string, backendId: string, contextName: string, force: boolean) {
      await docker.removeImage(imageId, backendId, contextName, force);
      return getPayload();
    },
    async dockerVolumeRemove(volumeName: string, backendId: string, contextName: string, force: boolean) {
      await docker.removeVolume(volumeName, backendId, contextName, force);
      return getPayload();
    },
    async dockerNetworkRemove(networkId: string, backendId: string, contextName: string) {
      await docker.removeNetwork(networkId, backendId, contextName);
      return getPayload();
    },
    async dockerImagePull(reference: string, backendId: string, contextName: string) {
      await docker.pullImage(reference, backendId, contextName);
      return getPayload();
    },
    async dockerImagePrune(backendId: string, contextName: string, all: boolean) {
      const result = await docker.pruneImages(backendId, contextName, { all });
      return { payload: getPayload(), result };
    },
    async dockerVolumePrune(backendId: string, contextName: string) {
      const result = await docker.pruneVolumes(backendId, contextName);
      return { payload: getPayload(), result };
    },
    async dockerNetworkPrune(backendId: string, contextName: string) {
      const result = await docker.pruneNetworks(backendId, contextName);
      return { payload: getPayload(), result };
    },
    async dockerBuilderPrune(backendId: string, contextName: string, all: boolean) {
      const result = await docker.pruneBuilder(backendId, contextName, { all });
      return { payload: getPayload(), result };
    },
    async dockerSystemDf(backendId?: string, contextName?: string): Promise<string> {
      return docker.systemDf(backendId, contextName);
    },
    async dockerVolumeList(
      volumeName: string,
      backendId: string,
      contextName: string,
      subPath: string,
    ): Promise<string> {
      return docker.volumeListPath(volumeName, backendId, contextName, subPath);
    },
    async dockerVolumeReadFile(
      volumeName: string,
      backendId: string,
      contextName: string,
      subPath: string,
    ): Promise<string> {
      return docker.volumeReadFile(volumeName, backendId, contextName, subPath);
    },
    async dockerTop(containerId: string, backendId: string, contextName: string): Promise<string> {
      return docker.topContainer(containerId, backendId, contextName);
    },
    async dockerStats(containerId: string, backendId: string, contextName: string) {
      return docker.statsContainer(containerId, backendId, contextName);
    },
    async dockerComposeAction(action: string, backendId: string, contextName: string, projectName: string) {
      const snapshot = docker.getSnapshot();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const containers = (snapshot.containers as any[]).filter(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (c: any) =>
          c.backendId === backendId && c.contextName === contextName && c.parsedLabels?.composeProject === projectName,
      );
      if (containers.length === 0) {
        throw new Error(`No containers found for compose project: ${projectName}`);
      }
      await Promise.allSettled(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        containers.map((c: any) => docker.performAction(action, c.ID, backendId, contextName)),
      );
      await refreshDocker();
      return getPayload();
    },
  };
}
