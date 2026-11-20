import type { WindowBackend } from "./peers.js";

/**
 * `window:get-backend` before the runtime's IPC exists. A local window must not wait for the runtime, so it is
 * answered at once. A window restored as attached to another desktop waits until `registerIpc` has run: the very
 * next calls of its renderer (`peer:http`, `peer:ws:open`) are registered there, and a rejection from `ipcReady`
 * (the runtime failed to start) makes the renderer fall back as it does for any failed call.
 */
export async function answerWindowBackendDuringBoot(input: {
  isBootPeerWindow: boolean;
  ipcReady: Promise<void>;
  getBackend: () => WindowBackend;
}): Promise<WindowBackend> {
  if (!input.isBootPeerWindow) return { kind: "local" };
  await input.ipcReady;
  return input.getBackend();
}
