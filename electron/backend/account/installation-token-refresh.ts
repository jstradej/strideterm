// The SERVER-SIDE listener that turns "your claims changed" into a new token and a fresh stream.
//
// WHY IT HAS TO EXIST HERE, in the main process. A custom claim is baked into an ID token when it is
// minted, so an installation whose account was just granted, renewed or revoked goes on presenting
// the old token for the rest of its hour — and every entitlement-gated door refuses it meanwhile.
// `v2/tokenRefresh/{uid}` is the server saying "ask again now".
//
// WHAT WAS MISSING. `AccountManager.onClaimsChanged()` existed and refreshed the OWNER session, and
// an IPC method called `accountClaimsChanged` existed for a renderer to call. Neither is a listener:
// nothing in the desktop was subscribed to the marker, so the only thing that ever picked up a claim
// change was the next token expiry — up to an hour of an account that had paid being refused, and up
// to an hour of a revoked one still being admitted on its long-lived RTDB stream.
//
// THREE THINGS IN ORDER, and the order is the point:
//
//   1. THE TOKEN. `refreshSession()` mints a new one now, whatever the cached expiry says.
//   2. THE STREAMS. A Firebase RTDB SSE stream authenticates ONCE, at connect, so a stream opened
//      with the old token keeps whatever it was granted until it is torn down. Refreshing the token
//      and leaving the stream up is the half-fix that looks like it worked.
//   3. THE PAGE. The account overview is re-read, because what changed may be exactly what it shows.
//
// IT IS BOUNDED AND IT NEVER THROWS. The marker is written by the issuer on every claim change, so a
// burst of them — an account with five devices being re-issued — must not become five stream
// restarts a second. A minimum interval collapses them, and a failure leaves the previous state
// alone: this path exists to make things better sooner, and must not be able to make them worse.

import { tokenRefreshPath } from "../mobile/mobile-rtdb-paths.js";

/** The narrow slice of the REST client this needs. A port, so a test needs no Firebase project. */
export interface TokenRefreshSource {
  currentSession(): Promise<{ uid: string }>;
  refreshSession(): Promise<unknown>;
  stream(path: string, handlers: { onEvent(event: { data: unknown }): void; onError?(error: Error): void }): () => void;
}

export interface InstallationTokenRefreshDeps {
  readonly client: TokenRefreshSource;
  /** Tears down and re-opens whatever this installation has streaming. See rule 2. */
  readonly restartStreams: () => unknown;
  /** Re-reads the account overview, so the page agrees with the new claims. */
  readonly refreshAccount: () => Promise<void>;
  readonly now?: () => number;
  /**
   * Where the last marker this installation ACTED ON is kept, so a restart of the process does not
   * treat the node's unchanged current value as news. Both optional: without them the marker is
   * remembered for the life of the listener only. Must never throw into the listener.
   */
  readonly loadAppliedMarker?: () => Promise<string | null> | string | null;
  readonly saveAppliedMarker?: (marker: string) => Promise<void> | void;
  /** Collapses a burst. Defaults to five seconds. */
  readonly minIntervalMs?: number;
  readonly onError?: (error: unknown) => void;
}

export const TOKEN_REFRESH_MIN_INTERVAL_MS = 5_000;

export interface InstallationTokenRefreshListener {
  /** Subscribes. Returns a function that unsubscribes; safe to call twice. */
  start(): Promise<void>;
  stop(): void;
  /** For the runtime's own "something happened, check now" path and for tests. */
  applyNow(): Promise<void>;
}

export function createInstallationTokenRefreshListener(
  deps: InstallationTokenRefreshDeps,
): InstallationTokenRefreshListener {
  const now = deps.now ?? (() => Date.now());
  const minIntervalMs = deps.minIntervalMs ?? TOKEN_REFRESH_MIN_INTERVAL_MS;
  let unsubscribe: (() => void) | null = null;
  let lastAppliedAt = 0;
  let applying: Promise<void> | null = null;
  let pending = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  // The marker last acted on (serialised). A stream's ID token expires about hourly and the
  // reconnect makes RTDB re-send the CURRENT value as the first event; without this memory that old
  // marker looked like news and restarted the whole mobile manager every hour (2026-10-05: command
  // mailbox replayed, presence flapped, catalog refetched at 19:14, 20:14, 21:14).
  let appliedMarker: string | null = null;
  let markerLoad: Promise<void> | null = null;

  function requestRefresh(): void {
    if (stopped) return;
    pending = true;
    if (applying !== null) return;
    const remaining = minIntervalMs - (now() - lastAppliedAt);
    if (remaining > 0) {
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        requestRefresh();
      }, remaining);
      timer.unref?.();
      return;
    }
    void apply();
  }

  async function apply(): Promise<void> {
    // One at a time, and never more often than the interval. A claim re-issue across five devices
    // writes five markers within a second; five stream restarts would be worse than the staleness.
    if (applying !== null) return applying;
    if (now() - lastAppliedAt < minIntervalMs) return;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    pending = false;
    applying = (async () => {
      try {
        await deps.client.refreshSession();
        // AFTER the token, because a stream opened with the old one keeps what it was granted.
        await deps.restartStreams();
        await deps.refreshAccount();
        lastAppliedAt = now();
      } catch (error) {
        // A background refresh that fails changes nothing a user asked for; the next marker, or the
        // next foreground action, tries again.
        deps.onError?.(error);
      } finally {
        lastAppliedAt = now();
        applying = null;
        if (pending) requestRefresh();
      }
    })();
    return applying;
  }

  async function handleMarker(marker: string): Promise<void> {
    // One load, shared by every early event, so a second marker cannot be compared with "nothing".
    markerLoad ??= (async () => {
      try {
        appliedMarker = (await deps.loadAppliedMarker?.()) ?? null;
      } catch (error) {
        deps.onError?.(error);
      }
    })();
    await markerLoad;
    if (stopped || marker === appliedMarker) return;
    appliedMarker = marker;
    try {
      await deps.saveAppliedMarker?.(marker);
    } catch (error) {
      deps.onError?.(error);
    }
    requestRefresh();
  }

  return {
    async start(): Promise<void> {
      stopped = false;
      if (unsubscribe !== null) return;
      // The uid comes from the SESSION, never from a caller: the marker's own rule is
      // `auth.uid === $uid`, so a listener on anybody else's path would simply be refused — and
      // asking for one would mean this module had an opinion about which installation it is.
      const session = await deps.client.currentSession();
      unsubscribe = deps.client.stream(tokenRefreshPath(session.uid), {
        onEvent: (event) => {
          // The first event of every SSE (re)subscription is the node's CURRENT value, which is a
          // marker this machine has already acted on. `null` (no marker) is skipped; a marker equal to
          // the one last applied is skipped too — only a CHANGED one means "ask again now".
          if (event.data === null || event.data === undefined) return;
          void handleMarker(JSON.stringify(event.data));
        },
        onError: (error) => deps.onError?.(error),
      });
    },
    stop(): void {
      stopped = true;
      pending = false;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      unsubscribe?.();
      unsubscribe = null;
    },
    applyNow(): Promise<void> {
      lastAppliedAt = 0;
      return apply();
    },
  };
}
