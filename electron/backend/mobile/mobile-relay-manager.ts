/// <reference types="node" />
/**
 * Owns the managed relay's lifecycle for one installation: the feature flag, the loopback-only
 * internal origin, and exactly one connector.
 *
 * EXACTLY ONE CONNECTOR PER INSTALLATION, WHATEVER THE WINDOW COUNT (plan §10). This object is
 * built once by `createRuntime`, which is itself built once per data directory — the same place and
 * for the same reason `MobileManager` is. Opening a second desktop window creates no second relay
 * connection, no second internal origin and no second identity, because there is no per-window code
 * path that could.
 *
 * FLAG OFF MEANS NOTHING EXISTS. `start()` with the flag off returns without creating a connector,
 * a listener, a socket or a key. That is the plan's "feature flag off creates no connector and no
 * listener" (§10) taken literally: not a connector in a disabled state, but no connector.
 *
 * TURNING IT ON DOES NOT OPEN A LAN LISTENER. The internal origin binds `127.0.0.1` on a port the
 * OS chose, and is reachable only by a caller presenting this process's guard secret. The user's
 * LAN/Cloudflare listener continues to be governed solely by `remoteAccess.enabled`, its host and
 * its port — the relay neither starts one nor stops one.
 */
import { randomBytes } from "node:crypto";

import { getLogger } from "../logger.js";
import { classifyNetworkError } from "../net/network-error.js";
import {
  createRelayConnector,
  defaultDefinitiveRefusalRetryDelay,
  defaultReconnectDelay,
  type RelayConnector,
  type RelayConnectorState,
  type RelayRevocationRecord,
} from "./mobile-relay-connector.js";
import { RELAY_REVOCATION_TOMBSTONE_TTL_MS } from "./mobile-relay-protocol.js";
import { loadRelayInstallationIdentity, type RelayInstallationIdentity } from "./mobile-relay-identity.js";
import {
  MobileRelayGrantDefinitiveRefusalError,
  type MobileFirebaseTransport,
  type RelayConnectorGrant,
} from "./mobile-firebase-transport.js";
import type { RelayIdentityCredentialStore } from "./mobile-relay-identity.js";

const log = getLogger("mobile-relay-manager");

/** What the manager needs from the remote server, without importing it (and its whole dependency set). */
export interface RelayOriginServer {
  address?: { host: string; port: number };
  close(): Promise<void>;
  revokeMobileSessionsForDevice?: (deviceId: string) => void;
}

export interface RelayOriginStarter {
  (loopbackOrigin: {
    host: string;
    port: number;
    guardToken: string;
    /**
     * The PUBLIC origin viewers reach the relay at, as the grant issuer stated it.
     *
     * Passed in rather than discovered, because the loopback listener cannot discover it: every
     * request it sees has been rewritten by the connector to name the loopback origin, so anything it
     * inferred from a `Host` or `X-Forwarded-*` header would be a value a viewer could influence
     * (production hardening §5 "Ticket" 3). It is what a relay ticket's `allowedOrigin` is compared
     * against when the WebView redeems it.
     */
    publicOrigin: string;
  }): Promise<RelayOriginServer>;
}

export interface MobileRelayManagerOptions {
  installationId: string;
  credentialStore: RelayIdentityCredentialStore;
  transport: Pick<MobileFirebaseTransport, "issueRelayConnectorGrant">;
  /** Starts a loopback-only instance of the remote server. Injected so this module never imports it. */
  startOrigin: RelayOriginStarter;
  /** Reads the current flag. Called on every `reconfigure()`, so a settings change takes effect. */
  isEnabled: () => boolean;
  /**
   * Every device this installation has revoked, from the PERSISTENT store.
   *
   * Plan §3.3 is explicit that this must be the device store rather than a `Set` the connector
   * accumulates: the case the whole revocation-sync phase exists for is a revoke that happened while
   * this desktop's process was not running, and an in-process collection knows nothing about it. The
   * runtime passes a closure over `MobileDeviceStore`, which reads the same atomically-written state
   * file everything else does.
   */
  listRevocations: () => Array<{ deviceId: string; revokedAt: number | null }>;
  createConnector?: typeof createRelayConnector;
  /** Injectable so a test can drive the start-failure retry without waiting real seconds. */
  retryDelayMs?: (attempt: number) => number;
  /**
   * Injectable so a test can drive the DEFINITIVE-refusal start-failure retry without waiting real
   * seconds. See `RelayConnectorOptions.definitiveRefusalRetryDelayMs` — the same distinction applies
   * to the very first grant fetch, before any connector exists to apply it inside its own loop.
   */
  definitiveRefusalRetryDelayMs?: () => number;
}

export interface MobileRelayStatus {
  enabled: boolean;
  state: RelayConnectorState | "off";
  relayOrigin: string;
  /** Loopback port of the internal origin, or 0 when none is running. Never a URL a human uses. */
  internalPort: number;
  lastError: string;
}

export interface MobileRelayManager {
  /** Starts or stops the relay to match the flag. Safe to call repeatedly. */
  reconfigure(): Promise<void>;
  stop(): Promise<void>;
  status(): MobileRelayStatus;
  /** Diagnostics for the local harness and the debug UI. Counts and states only. */
  stats(): ReturnType<RelayConnector["stats"]> | null;
  /** Told by MobileManager when a device is revoked, so the relay closes its sessions too. */
  revokeDevice(deviceId: string): void;
  /** The origin the WebView must be pointed at, or "" when the relay is not running. */
  relayOrigin(): string;
}

export function createMobileRelayManager(options: MobileRelayManagerOptions): MobileRelayManager {
  const createConnector = options.createConnector ?? createRelayConnector;
  const retryDelayMs = options.retryDelayMs ?? defaultReconnectDelay;
  const definitiveRefusalRetryDelayMs = options.definitiveRefusalRetryDelayMs ?? defaultDefinitiveRefusalRetryDelay;

  /**
   * The snapshot the connector replays during `conn.sync`, filtered to what can still matter.
   *
   * A tombstone older than the relay's own retention is one the relay would drop on arrival, so
   * sending it is pure noise on a phase that holds the installation open; and a record with no
   * `revokedAt` (which a store written by an older build could contain) is treated as "revoked now",
   * because a missing instant must never be read as "long ago and therefore expired".
   */
  function relayRevocations(): RelayRevocationRecord[] {
    const now = Date.now();
    const oldestRelevant = now - RELAY_REVOCATION_TOMBSTONE_TTL_MS;
    const out: RelayRevocationRecord[] = [];
    for (const record of options.listRevocations()) {
      const revokedAt = typeof record.revokedAt === "number" ? record.revokedAt : now;
      if (revokedAt < oldestRelevant) continue;
      out.push({ deviceId: record.deviceId, revokedAt });
    }
    return out;
  }

  let identity: RelayInstallationIdentity | null = null;
  let origin: RelayOriginServer | null = null;
  let connector: RelayConnector | null = null;
  let relayOrigin = "";
  let lastError = "";
  let starting: Promise<void> | null = null;
  let retryTimer: NodeJS.Timeout | null = null;
  let retryAttempt = 0;

  async function ensureIdentity(): Promise<RelayInstallationIdentity> {
    identity ??= await loadRelayInstallationIdentity({
      installationId: options.installationId,
      credentialStore: options.credentialStore,
    });
    return identity;
  }

  /**
   * Fetches a fresh connector grant, and records the relay origin it names.
   *
   * The origin is taken from the ISSUER's answer, not from local configuration: the grant's audience
   * and the origin the connector dials have to be the same string or the relay refuses the
   * handshake, and having one source for both removes the way they could disagree.
   */
  async function fetchGrant(fingerprint: string): Promise<RelayConnectorGrant> {
    const issued = await options.transport.issueRelayConnectorGrant(options.installationId, fingerprint);
    relayOrigin = issued.relayOrigin;
    return issued;
  }

  async function start(): Promise<void> {
    const id = await ensureIdentity();

    // One probe before anything is bound: a deployment with no relay answers `failed-precondition`,
    // and the right response to that is to leave the desktop exactly as it was rather than to open a
    // listener nothing will ever connect to.
    const first = await fetchGrant(id.fingerprint);

    const guardToken = randomBytes(32).toString("base64url");
    // Port 0: the OS picks one that is free right now, which is what "random or conflict-safe"
    // means when the alternative is a fixed port that a second installation would collide with.
    //
    // `publicOrigin` is the issuer's own answer — the same string the connector dials and the same
    // one the grant's audience carries — so the loopback server can check a ticket's origin against a
    // value nothing on the request path could influence.
    origin = await options.startOrigin({
      host: "127.0.0.1",
      port: 0,
      guardToken,
      publicOrigin: first.relayOrigin,
    });
    const address = origin.address;
    if (!address) {
      await origin.close();
      origin = null;
      throw new Error("relay internal origin did not report an address");
    }

    let cachedGrant: string | null = first.grant;
    connector = createConnector({
      relayOrigin: first.relayOrigin,
      identity: id,
      internalOrigin: { host: address.host, port: address.port, guardToken },
      getGrant: async () => {
        // The first grant is used once, then every attempt asks for a new one: connector grants are
        // minutes long by design, so a reconnect after an outage must not present a stale token.
        if (cachedGrant) {
          const grant = cachedGrant;
          cachedGrant = null;
          return grant;
        }
        return (await fetchGrant(id.fingerprint)).grant;
      },
      listRelayRevocations: relayRevocations,
      onStateChange: (state) => log.info("relay connector state", { state }),
      definitiveRefusalRetryDelayMs,
    });
    connector.start();
    log.info("managed relay started", { internalPort: address.port });
  }

  async function stopInternal(): Promise<void> {
    await connector?.stop();
    connector = null;
    // Closing the internal origin is not optional cleanup: plan §5.4 requires the loopback listener
    // to be gone the moment the relay is switched off, not merely idle.
    //
    // Time-capped, for the same reason the runtime caps its state flush on quit: a close that never
    // settles would wedge the manager so the relay could never be turned back on, and a listener
    // that outlives its cap is a leak worth logging rather than a reason to stop working.
    const closing = origin?.close();
    if (closing) {
      let closed = false;
      await Promise.race([
        closing.then(() => {
          closed = true;
        }),
        new Promise<void>((resolve) => setTimeout(resolve, 5000)),
      ]).catch(() => undefined);
      if (!closed) log.warn("the relay internal origin did not close within 5s");
    }
    origin = null;
    relayOrigin = "";
  }

  /**
   * Re-attempts a start that failed, with the same bounded exponential backoff the connector uses
   * for a lost socket.
   *
   * It exists because the two most likely reasons a start fails are both temporary and both normal:
   * the control plane has not finished signing in yet at boot, and the control plane is briefly
   * unreachable. Neither should mean "this desktop has no relay until the user visits Settings".
   * The retry is cancelled by disabling the relay, by `stop()`, and by a start that succeeds.
   */
  function scheduleRetry(definitive: boolean): void {
    if (retryTimer || !options.isEnabled()) return;
    // A DEFINITIVE refusal (the entitlement, not the network — plan §6, package 2) does not use the
    // exponential counter at all: it must neither inflate it nor inherit whatever it already was from
    // an unrelated spell of network errors, the same reasoning `mobile-relay-connector.ts`'s own
    // `scheduleDefinitiveRefusalRetry` documents.
    const delay = definitive ? definitiveRefusalRetryDelayMs() : retryDelayMs(retryAttempt++);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void manager.reconfigure().catch(() => undefined);
    }, delay);
    retryTimer.unref?.();
  }

  function cancelRetry(): void {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
  }

  const manager: MobileRelayManager = {
    async reconfigure() {
      // Serialised: a settings change while a start is in flight must not leave two origins bound.
      starting = (starting ?? Promise.resolve())
        .catch(() => undefined)
        .then(async () => {
          const wanted = options.isEnabled();
          if (!wanted) {
            if (connector || origin) log.info("managed relay disabled");
            cancelRetry();
            retryAttempt = 0;
            await stopInternal();
            lastError = "";
            return;
          }
          if (connector) return;
          try {
            await start();
            lastError = "";
            cancelRetry();
            retryAttempt = 0;
          } catch (error) {
            const message = (error as Error).message;
            // The UI gets a fixed code for a classified transport failure (TLS inspection above
            // all); the log keeps the original text for support. Anything else is shown as before.
            const net = classifyNetworkError(error);
            lastError = net ? `network:${net}` : message;
            const definitive = error instanceof MobileRelayGrantDefinitiveRefusalError;
            log.warn("managed relay unavailable", { err: message, definitive });
            await stopInternal();
            scheduleRetry(definitive);
          }
        });
      await starting;
    },
    async stop() {
      cancelRetry();
      starting = (starting ?? Promise.resolve()).catch(() => undefined).then(() => stopInternal());
      await starting;
    },
    status: () => ({
      enabled: options.isEnabled(),
      state: connector ? connector.state() : "off",
      relayOrigin,
      internalPort: origin?.address?.port ?? 0,
      lastError,
    }),
    stats: () => connector?.stats() ?? null,
    revokeDevice(deviceId: string) {
      connector?.revokeDevice(deviceId);
      origin?.revokeMobileSessionsForDevice?.(deviceId);
    },
    relayOrigin: () => relayOrigin,
  };

  return manager;
}
