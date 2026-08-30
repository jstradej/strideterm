/**
 * The relay's lifecycle: what exists with the flag off, what exists with it on, and what is left
 * behind when it is turned off again.
 *
 * The assertions worth having here are all negative. "Flag off creates no connector and no
 * listener" and "turning the relay on does not open a LAN listener" are properties a reader cannot
 * check by looking at the manager alone — they are about what did NOT happen — so each one is
 * tested by counting the things that were built.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createMobileRelayManager, type RelayOriginServer } from "./mobile-relay-manager.js";
import { RELAY_INSTALLATION_KEY_REF } from "./mobile-relay-identity.js";
import type { RelayConnector } from "./mobile-relay-connector.js";
import { RELAY_REVOCATION_TOMBSTONE_TTL_MS } from "./mobile-relay-protocol.js";

const INSTALLATION_ID = "installation-under-test";
const RELAY_ORIGIN = "https://relay.test.invalid";

/** An in-memory stand-in for the credential store, with the same three methods the real one has. */
function makeCredentialStore(): {
  getSecret(ref: string): string;
  setSecret(ref: string, secret: string): Promise<void>;
  size(): number;
} {
  const secrets = new Map<string, string>();
  return {
    getSecret: (ref) => secrets.get(ref) ?? "",
    setSecret: async (ref, secret) => {
      secrets.set(ref, secret);
    },
    size: () => secrets.size,
  };
}

interface Harness {
  manager: ReturnType<typeof createMobileRelayManager>;
  originsStarted: { host: string; port: number; guardToken: string }[];
  originsClosed: number;
  connectorsStarted: number;
  connectorsStopped: number;
  grantRequests: string[];
  credentialStore: ReturnType<typeof makeCredentialStore>;
  revokedDevices: string[];
  /** The snapshot callback the manager handed the connector — what a sync phase would replay. */
  relayRevocations(): Array<{ deviceId: string; revokedAt: number }>;
  setEnabled(next: boolean): void;
}

function makeHarness(
  options: {
    grant?: () => Promise<{ grant: string; relayOrigin: string; desktopInstallationId: string; expiresAt: number }>;
    retryDelayMs?: (attempt: number) => number;
    /** What the persistent device store would report. Empty unless a test cares. */
    revocations?: () => Array<{ deviceId: string; revokedAt: number | null }>;
  } = {},
): Harness {
  let enabled = false;
  const credentialStore = makeCredentialStore();
  const state = {
    originsStarted: [] as { host: string; port: number; guardToken: string }[],
    originsClosed: 0,
    connectorsStarted: 0,
    connectorsStopped: 0,
    grantRequests: [] as string[],
    revokedDevices: [] as string[],
    /** The snapshot callback the manager handed the connector — what the sync phase would replay. */
    listRelayRevocations: undefined as (() => Array<{ deviceId: string; revokedAt: number }>) | undefined,
  };

  const manager = createMobileRelayManager({
    installationId: INSTALLATION_ID,
    credentialStore,
    transport: {
      async issueRelayConnectorGrant(pairId, fingerprint) {
        state.grantRequests.push(`${pairId}:${fingerprint}`);
        if (options.grant) return options.grant();
        return {
          grant: "connector-grant",
          relayOrigin: RELAY_ORIGIN,
          desktopInstallationId: INSTALLATION_ID,
          expiresAt: Date.now() + 900_000,
        };
      },
    },
    startOrigin: async (loopbackOrigin) => {
      state.originsStarted.push(loopbackOrigin);
      const server: RelayOriginServer = {
        address: { host: loopbackOrigin.host, port: 45_000 + state.originsStarted.length },
        close: async () => {
          state.originsClosed += 1;
        },
        revokeMobileSessionsForDevice: (deviceId: string) => state.revokedDevices.push(`origin:${deviceId}`),
      };
      return server;
    },
    isEnabled: () => enabled,
    listRevocations: () => options.revocations?.() ?? [],
    retryDelayMs: options.retryDelayMs,
    createConnector: (connectorOptions) => {
      state.listRelayRevocations = connectorOptions.listRelayRevocations;
      const connector: RelayConnector = {
        start: () => {
          state.connectorsStarted += 1;
        },
        stop: async () => {
          state.connectorsStopped += 1;
        },
        state: () => "ready",
        revokeDevice: (deviceId: string) => state.revokedDevices.push(`connector:${deviceId}`),
        stats: () => ({
          state: "ready",
          connects: 1,
          httpStreams: 0,
          wsStreams: 0,
          liveHttpStreams: 0,
          liveWsStreams: 0,
          bytesIn: 0,
          bytesOut: 0,
          overflows: 0,
          reconnects: 0,
          revocationsReplayed: 0,
          lastError: "",
        }),
      };
      return connector;
    },
  });

  return {
    manager,
    credentialStore,
    get originsStarted() {
      return state.originsStarted;
    },
    get originsClosed() {
      return state.originsClosed;
    },
    get connectorsStarted() {
      return state.connectorsStarted;
    },
    get connectorsStopped() {
      return state.connectorsStopped;
    },
    get grantRequests() {
      return state.grantRequests;
    },
    get revokedDevices() {
      return state.revokedDevices;
    },
    relayRevocations() {
      if (!state.listRelayRevocations) throw new Error("no connector was created");
      return state.listRelayRevocations();
    },
    setEnabled(next: boolean) {
      enabled = next;
    },
  };
}

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the managed relay's lifecycle", () => {
  test("with the flag off, nothing is created — no origin, no connector, not even a key", async () => {
    const harness = makeHarness();
    await harness.manager.reconfigure();

    expect(harness.originsStarted).toHaveLength(0);
    expect(harness.connectorsStarted).toBe(0);
    expect(harness.grantRequests).toHaveLength(0);
    // Not even an identity: generating a keypair for a feature the user has not switched on would
    // be a durable side effect of doing nothing.
    expect(harness.credentialStore.getSecret(RELAY_INSTALLATION_KEY_REF)).toBe("");
    expect(harness.manager.status()).toMatchObject({ enabled: false, state: "off", relayOrigin: "", internalPort: 0 });
  });

  test("with the flag on, exactly one loopback origin and one connector exist", async () => {
    const harness = makeHarness();
    harness.setEnabled(true);
    await harness.manager.reconfigure();

    expect(harness.originsStarted).toHaveLength(1);
    expect(harness.connectorsStarted).toBe(1);
    // The bind is loopback-only and the port is the OS's choice, not a fixed one two installations
    // would fight over.
    expect(harness.originsStarted[0]!.host).toBe("127.0.0.1");
    expect(harness.originsStarted[0]!.port).toBe(0);
    expect(harness.originsStarted[0]!.guardToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(harness.manager.status()).toMatchObject({ enabled: true, state: "ready", relayOrigin: RELAY_ORIGIN });
  });

  test("reconfiguring again while it is already running builds nothing further", async () => {
    const harness = makeHarness();
    harness.setEnabled(true);
    await harness.manager.reconfigure();
    await harness.manager.reconfigure();
    await harness.manager.reconfigure();

    expect(harness.originsStarted).toHaveLength(1);
    expect(harness.connectorsStarted).toBe(1);
  });

  test("turning it off closes the origin immediately, rather than leaving it idle", async () => {
    const harness = makeHarness();
    harness.setEnabled(true);
    await harness.manager.reconfigure();
    harness.setEnabled(false);
    await harness.manager.reconfigure();

    expect(harness.originsClosed).toBe(1);
    expect(harness.connectorsStopped).toBe(1);
    expect(harness.manager.status()).toMatchObject({ enabled: false, state: "off", relayOrigin: "", internalPort: 0 });
    expect(harness.manager.relayOrigin()).toBe("");
  });

  test("a deployment with no relay leaves nothing bound, and says why", async () => {
    const harness = makeHarness({
      grant: async () => {
        throw new Error("issueRelayConnectorGrant: the managed relay is not configured");
      },
    });
    harness.setEnabled(true);
    await harness.manager.reconfigure();

    // The grant is asked for BEFORE anything is bound, so a desktop whose backend has no relay does
    // not end up with a listener nothing will ever connect to.
    expect(harness.grantRequests).toHaveLength(1);
    expect(harness.originsStarted).toHaveLength(0);
    expect(harness.connectorsStarted).toBe(0);
    expect(harness.manager.status().lastError).toMatch(/not configured/);
  });

  test("a revoke reaches both the relay and the origin's own sessions", async () => {
    const harness = makeHarness();
    harness.setEnabled(true);
    await harness.manager.reconfigure();
    harness.manager.revokeDevice("mobile-device-xyz");

    expect(harness.revokedDevices).toEqual(["connector:mobile-device-xyz", "origin:mobile-device-xyz"]);
  });

  test("the grant names this installation and the key it will have to prove it holds", async () => {
    const harness = makeHarness();
    harness.setEnabled(true);
    await harness.manager.reconfigure();

    const [request] = harness.grantRequests;
    const [pairId, fingerprint] = request!.split(":");
    expect(pairId).toBe(INSTALLATION_ID);
    expect(fingerprint).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test("the installation keypair is generated once and reused", async () => {
    const harness = makeHarness();
    harness.setEnabled(true);
    await harness.manager.reconfigure();
    const stored = harness.credentialStore.getSecret(RELAY_INSTALLATION_KEY_REF);
    expect(stored).toMatch(/BEGIN PRIVATE KEY/);

    harness.setEnabled(false);
    await harness.manager.reconfigure();
    harness.setEnabled(true);
    await harness.manager.reconfigure();
    expect(harness.credentialStore.getSecret(RELAY_INSTALLATION_KEY_REF)).toBe(stored);
    expect(harness.credentialStore.size()).toBe(1);
  });

  test("stop() is idempotent and leaves nothing running", async () => {
    tempDirs.push(mkdtempSync(path.join(tmpdir(), "st-relay-manager-")));
    const harness = makeHarness();
    harness.setEnabled(true);
    await harness.manager.reconfigure();
    await harness.manager.stop();
    await harness.manager.stop();

    expect(harness.originsClosed).toBe(1);
    expect(harness.manager.stats()).toBeNull();
  });
});

describe("a start that fails is retried, not abandoned", () => {
  test("a control plane that is briefly unavailable does not cost the desktop its relay", async () => {
    // The two likeliest reasons a start fails are both temporary and both ordinary: the control
    // plane has not finished signing in yet at boot, and the control plane is briefly unreachable.
    // Neither may mean "no relay until the user visits Settings".
    let attempts = 0;
    const harness = makeHarness({
      grant: async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("issueRelayConnectorGrant failed (UNAUTHENTICATED)");
        return {
          grant: "connector-grant",
          relayOrigin: RELAY_ORIGIN,
          desktopInstallationId: INSTALLATION_ID,
          expiresAt: Date.now() + 900_000,
        };
      },
      retryDelayMs: () => 5,
    });
    harness.setEnabled(true);
    await harness.manager.reconfigure();
    expect(harness.manager.status().lastError).toMatch(/UNAUTHENTICATED/);

    await vi.waitFor(() => expect(harness.connectorsStarted).toBe(1), { timeout: 5_000 });
    expect(attempts).toBeGreaterThanOrEqual(3);
    expect(harness.originsStarted).toHaveLength(1);
    expect(harness.manager.status().lastError).toBe("");
  });

  test("disabling the relay cancels a pending retry", async () => {
    let attempts = 0;
    const harness = makeHarness({
      grant: async () => {
        attempts += 1;
        throw new Error("the managed relay is not configured");
      },
      retryDelayMs: () => 5,
    });
    harness.setEnabled(true);
    await harness.manager.reconfigure();
    harness.setEnabled(false);
    await harness.manager.reconfigure();

    const settled = attempts;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(attempts).toBe(settled);
    expect(harness.originsStarted).toHaveLength(0);
  });

  test("the connector is handed a live snapshot of the persistent revocations", async () => {
    // Plan §3.3: the sync phase must read the DEVICE STORE, not a set the connector accumulated. The
    // manager passes a closure, so what matters is (a) that it reads through to the store at call
    // time and (b) that what it hands over is the wire shape the frame needs.
    // Recent instants, because the manager filters out anything the relay's own retention would
    // already have dropped — a fixed timestamp from years ago would be filtered for the right reason
    // and make this test pass for the wrong one.
    const firstRevokedAt = Date.now() - 60_000;
    const revoked: Array<{ deviceId: string; revokedAt: number | null }> = [
      { deviceId: "mobile-1", revokedAt: firstRevokedAt },
    ];
    const harness = makeHarness({ revocations: () => revoked });
    harness.setEnabled(true);
    await harness.manager.reconfigure();

    expect(harness.relayRevocations()).toEqual([{ deviceId: "mobile-1", revokedAt: firstRevokedAt }]);

    // A revoke that happens after the connector was built is in the next answer — which is the whole
    // point of a callback rather than a value.
    revoked.push({ deviceId: "mobile-2", revokedAt: Date.now() });
    expect(harness.relayRevocations()).toHaveLength(2);
  });

  test("a revocation older than the relay's own retention is not replayed, and a dateless one is", async () => {
    // Two edges of the same filter. A tombstone the relay would drop on arrival is noise on a phase
    // that holds the installation open; a record with no instant (a store written before this field
    // existed) must be treated as "now", because reading a missing date as "long ago" would silently
    // drop a real revocation.
    const now = Date.now();
    const harness = makeHarness({
      revocations: () => [
        { deviceId: "mobile-ancient", revokedAt: now - RELAY_REVOCATION_TOMBSTONE_TTL_MS - 60_000 },
        { deviceId: "mobile-fresh", revokedAt: now - 60_000 },
        { deviceId: "mobile-dateless", revokedAt: null },
      ],
    });
    harness.setEnabled(true);
    await harness.manager.reconfigure();

    const replayed = harness.relayRevocations();
    expect(replayed.map((entry) => entry.deviceId)).toEqual(["mobile-fresh", "mobile-dateless"]);
    expect(replayed.every((entry) => typeof entry.revokedAt === "number")).toBe(true);
  });
});
