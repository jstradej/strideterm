import { ClientRequestError } from "./client-request-error.js";

/**
 * Credential-store reference of an integration connection. Always derived from
 * the connection id — never read from a request. A `tokenRef` taken from the
 * caller is a read primitive over the whole credential store (the
 * `mobile:desktop-device-private-key`, the relay key, `ssh:*`): combined with a
 * host the caller chose, verification would send that secret there.
 */
export function connectionSecretRef(connectionId: string): string {
  return `cred:${connectionId}`;
}

/**
 * Credential-store reference of the remote-access master token (the bearer secret of the LAN/tunnel
 * HTTP server). Not a `mobile:` ref, so `refusesPlaintextStorage` does not apply: on a machine
 * without secure storage it falls back to `plain:` like `cred:*` does and remote access stays usable.
 * `strideterm-state.json` carries `token: ""`; the runtime adopts the stored value at startup.
 */
export const REMOTE_ACCESS_TOKEN_REF = "remote:access-token";

interface ExistingConnection {
  id: string;
  profileId?: string;
}

/**
 * The persisted connection a save/verify request names, or undefined for a new
 * one. Refuses (400) when it belongs to another profile than the caller's; a
 * caller with no resolved profile (desktop IPC without a window) is not
 * narrowed, matching the cross-profile guard next to it. `emptyProfileIsGlobal`
 * is for Telegram, where an empty profileId means "All profiles" and is owned
 * by every caller; elsewhere an empty one is the "default" profile.
 */
export function findOwnedConnection<T extends ExistingConnection>(
  connections: readonly T[],
  connectionId: string,
  callerProfileId: string,
  emptyProfileIsGlobal = false,
): T | undefined {
  const existing = connections.find((c) => c.id === connectionId);
  const global = emptyProfileIsGlobal && !existing?.profileId;
  if (existing && callerProfileId && !global && (existing.profileId || "default") !== callerProfileId) {
    throw new ClientRequestError(`Connection ${connectionId} belongs to another profile.`);
  }
  return existing;
}

/**
 * Stored secret of a connection that is already saved, read under the
 * reference derived from its id. Never a reference a request names, and never
 * for an id that is not a saved connection (so a request cannot point a new
 * connection at another connection's secret by reusing its id). A saved
 * connection of another profile than `callerProfileId` is refused (400).
 */
export function storedSecretOfSavedConnection(
  connections: readonly ExistingConnection[],
  connectionId: string | undefined,
  credentialStore: { getSecret(ref: string): string | null | undefined },
  callerProfileId = "",
  emptyProfileIsGlobal = false,
): string {
  if (!connectionId || !findOwnedConnection(connections, connectionId, callerProfileId, emptyProfileIsGlobal))
    return "";
  return credentialStore.getSecret(connectionSecretRef(connectionId)) || "";
}
