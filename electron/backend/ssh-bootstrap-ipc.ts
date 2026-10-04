export const DEFERRED_SSH_RUNTIME_CHANNELS = [
  "ssh:hosts:list",
  "ssh:capabilities:get",
  "ssh:hosts:create",
  "ssh:hosts:update",
  "ssh:hosts:delete",
  "ssh:hosts:duplicate",
  "ssh:hosts:test",
  "ssh:keys:list",
  "ssh:keys:import",
  "ssh:keys:generate",
  "ssh:keys:delete",
  "ssh:keys:rename",
  "ssh:certs:list",
  "ssh:certs:import",
  "ssh:certs:delete",
  "ssh:config:preview",
  "ssh:config:import",
  "ssh:known-hosts:import",
] as const;

export interface DeferredSshIpcMain {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): unknown;
  removeHandler(channel: string): unknown;
}

export function registerDeferredSshIpcHandlers(
  ipcMain: DeferredSshIpcMain,
  invokeRuntimeMethod: (methodName: string, ...args: unknown[]) => Promise<unknown>,
): () => void {
  for (const channel of DEFERRED_SSH_RUNTIME_CHANNELS) {
    ipcMain.handle(channel, (_event, ...args) => invokeRuntimeMethod(channel, ...args));
  }
  return () => {
    for (const channel of DEFERRED_SSH_RUNTIME_CHANNELS) ipcMain.removeHandler(channel);
  };
}
