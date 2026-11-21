import type { PeerFailureReason } from "./peers.js";

/**
 * A rejected `ipcMain.handle` reaches the renderer as a bare message: `code` and `reason` are dropped. A failure of
 * a `peers:client:*` call therefore crosses IPC as an ordinary return value in this envelope, and the sandboxed
 * preload (which cannot import this file) turns it back into an Error carrying `code` and `peerError`.
 */
export const PEER_IPC_FAILURE_MARKER = "__stridePeerFailure";

export interface PeerIpcFailure {
  [PEER_IPC_FAILURE_MARKER]: 1;
  message: string;
  code: string;
  reason?: PeerFailureReason;
}

export function toPeerIpcFailure(error: { message: string; code: string; reason?: PeerFailureReason }): PeerIpcFailure {
  return {
    [PEER_IPC_FAILURE_MARKER]: 1,
    message: error.message,
    code: error.code,
    ...(error.reason ? { reason: error.reason } : {}),
  };
}
