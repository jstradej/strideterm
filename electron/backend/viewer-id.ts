/**
 * Viewer identifiers.
 *
 * A "viewer" is a concrete view onto the runtime: a desktop window
 * (WindowSlot, identified by its slot id) or a remote/mobile browser client
 * (RemoteClientContext, identified by `remote:<sessionId>`). Runtime methods
 * that accept a `windowId` accept either form — desktop ids resolve through
 * windowSlots, remote ids through the RemoteClientRegistry. This lets every
 * profile-scoped guard and per-viewer mutation work for remote clients whose
 * profile is not open in any desktop window.
 */

export const REMOTE_VIEWER_PREFIX = "remote:";

/** Build the viewer id for a remote client session. */
export function remoteViewerId(sessionId: string): string {
  return `${REMOTE_VIEWER_PREFIX}${sessionId}`;
}

/** Returns the remote session id when `viewerId` is a remote viewer id, else null. */
export function parseRemoteViewerId(viewerId: string | undefined | null): string | null {
  if (!viewerId || !viewerId.startsWith(REMOTE_VIEWER_PREFIX)) return null;
  const sessionId = viewerId.slice(REMOTE_VIEWER_PREFIX.length);
  return sessionId || null;
}
