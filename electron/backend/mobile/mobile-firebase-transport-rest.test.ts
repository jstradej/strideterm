import { describe, expect, test, vi } from "vitest";
import { createFirebaseMobileTransport } from "./mobile-firebase-transport-rest.js";
import { MobileQuotaExceededError } from "./mobile-firebase-transport.js";
import {
  MobileFirebaseNotConfiguredError,
  MOBILE_FIREBASE_ENV_VARS,
  resolveMobileFirebaseConfig,
} from "./mobile-firebase-config.js";
import {
  MobileFirebaseCallableError,
  MobileFirebasePermissionDeniedError,
  type MobileFirebaseRestClient,
  type RtdbStreamHandlers,
} from "./mobile-firebase-rest.js";
import {
  computeQuotaWindowBounds,
  FUNCTIONS_REGION,
  pairCommandsPath,
  pairDevicesPath,
  pairEventPath,
  pairPresencePath,
  pairQuotaWindowPath,
  pairResultPath,
} from "./mobile-rtdb-paths.js";
import type { Device, EncryptedEnvelope, NotificationEvent } from "./mobile-schemas.js";
import { makeCloudDevice } from "./mobile-test-fixtures.js";

const CONFIG = resolveMobileFirebaseConfig(
  {
    [MOBILE_FIREBASE_ENV_VARS.projectId]: "demo-strideterm",
    [MOBILE_FIREBASE_ENV_VARS.databaseEmulator]: "127.0.0.1:9000",
  },
  FUNCTIONS_REGION,
).config!;

const PAIR_ID = "desktop-device-1";
const NOW = 1_755_302_400_000; // a UTC-midnight-aligned instant, so window maths is easy to read

interface StubOptions {
  /** Nodes the fake database already contains, keyed by path. */
  initial?: Record<string, unknown>;
  /** Paths (substring match) whose writes should be rejected as a rules failure. */
  denyWritesTo?: string[];
  /** What the server's clock reads. Defaults to agreeing with the local one. */
  serverNow?: number;
}

/** A fake {@link MobileFirebaseRestClient} with just enough of an RTDB to test the transport. */
function makeStubClient(options: StubOptions = {}) {
  const store = new Map<string, unknown>(Object.entries(options.initial ?? {}));
  const writes: { path: string; value: unknown }[] = [];
  const multiUpdates: Record<string, unknown>[] = [];
  const streams = new Map<string, RtdbStreamHandlers>();
  const unsubscribed: string[] = [];
  const callables: { name: string; data: unknown }[] = [];
  let callableResult: unknown = {};

  function denied(path: string): boolean {
    return (options.denyWritesTo ?? []).some((needle) => path.includes(needle));
  }

  const client: MobileFirebaseRestClient = {
    async signIn() {
      return { idToken: "id-1", uid: "desktop-uid", expiresAt: NOW + 3_600_000 };
    },
    async currentSession() {
      return { idToken: "id-1", uid: "desktop-uid", expiresAt: NOW + 3_600_000 };
    },
    clearCachedToken: vi.fn(),
    async forgetSession() {},
    async get<T>(path: string) {
      return (store.get(path) ?? null) as T | null;
    },
    async set(path: string, value: unknown) {
      if (denied(path)) throw new MobileFirebasePermissionDeniedError(path);
      writes.push({ path, value });
      store.set(path, value);
    },
    async remove(path: string) {
      store.delete(path);
    },
    async updateMulti(updates: Record<string, unknown>) {
      for (const path of Object.keys(updates)) {
        if (denied(path)) throw new MobileFirebasePermissionDeniedError(path);
      }
      multiUpdates.push(updates);
      for (const [path, value] of Object.entries(updates)) store.set(path, value);
    },
    async getWithEtag<T>(path: string) {
      return { value: (store.get(path) ?? null) as T | null, etag: "etag" };
    },
    async setIfMatch(path: string, value: unknown) {
      store.set(path, value);
      return true;
    },
    async serverNow() {
      return options.serverNow ?? NOW;
    },
    stream(path: string, handlers: RtdbStreamHandlers) {
      streams.set(path, handlers);
      return () => {
        streams.delete(path);
        unsubscribed.push(path);
      };
    },
    async callFunction<TResult>(name: string, data: unknown) {
      callables.push({ name, data });
      return callableResult as TResult;
    },
  };

  return {
    client,
    store,
    writes,
    multiUpdates,
    streams,
    unsubscribed,
    callables,
    setCallableResult: (value: unknown) => {
      callableResult = value;
    },
  };
}

function makeTransport(stub: ReturnType<typeof makeStubClient>, config = CONFIG) {
  return createFirebaseMobileTransport({
    config,
    missingConfig: config ? [] : [MOBILE_FIREBASE_ENV_VARS.projectId],
    createClient: () => stub.client,
    now: () => NOW,
  });
}

function makeEvent(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  return {
    protocolVersion: 2,
    eventId: "event-1",
    pairId: PAIR_ID,
    sourceDeviceId: PAIR_ID,
    targetDeviceId: "mobile-device-1",
    profileId: "profile-1",
    workspaceId: null,
    severity: "normal",
    dedupeKey: "dedupe-1",
    collapseKey: null,
    createdAt: NOW,
    expiresAt: NOW + 604_800_000,
    sessionKeyVersion: 1,
    ciphertext: "Y2lwaGVy",
    aad: "YWFk",
    ...overrides,
  };
}

function makeEnvelope(overrides: Partial<EncryptedEnvelope> = {}): EncryptedEnvelope {
  return {
    protocolVersion: 2,
    pairId: PAIR_ID,
    senderDeviceId: "mobile-device-1",
    targetDeviceId: PAIR_ID,
    messageId: "command-1",
    messageType: "command",
    nonce: "AAAAAAAAAAAAAAAA",
    createdAt: NOW,
    expiresAt: NOW + 60_000,
    ciphertext: "Y2lwaGVy",
    aad: "YWFk",
    sessionKeyVersion: 1,
    ...overrides,
  };
}

function makeDevice(overrides: Partial<Device> = {}): Device {
  return makeCloudDevice({
    deviceId: "mobile-device-1",
    uid: "mobile-uid-1",
    pairId: PAIR_ID,
    capabilities: ["notifications"],
    profileAllowlist: ["profile-1"],
    createdAt: NOW,
    lastSeenAt: NOW,
    ...overrides,
  });
}

describe("configuration", () => {
  test("an unconfigured install still gets the real transport, and says exactly what is missing", async () => {
    // Review §P0.2 acceptance: "the runtime with Mobile enabled does not use the unimplemented
    // transport". Missing configuration is an operator problem, not a reason to fall back to a
    // stub that throws "Not implemented" for everything.
    const transport = createFirebaseMobileTransport({
      config: null,
      missingConfig: [MOBILE_FIREBASE_ENV_VARS.projectId, MOBILE_FIREBASE_ENV_VARS.apiKey],
      createClient: () => {
        throw new Error("must not construct a client without a config");
      },
    });
    await expect(transport.connect()).rejects.toBeInstanceOf(MobileFirebaseNotConfiguredError);
    await expect(transport.connect()).rejects.toThrow(MOBILE_FIREBASE_ENV_VARS.projectId);
  });

  test("the client is built lazily, once, and reused", async () => {
    const stub = makeStubClient();
    const createClient = vi.fn(() => stub.client);
    const transport = createFirebaseMobileTransport({
      config: CONFIG,
      missingConfig: [],
      createClient,
      now: () => NOW,
    });
    expect(createClient).not.toHaveBeenCalled();
    await transport.connect();
    await transport.connect();
    expect(createClient).toHaveBeenCalledTimes(1);
  });
});

describe("connect / disconnect", () => {
  test("connect signs in and reports connected; repeated connects are safe", async () => {
    const stub = makeStubClient();
    const transport = makeTransport(stub);
    const states: string[] = [];
    transport.onConnectionStateChange((state) => states.push(state));

    await transport.connect();
    await transport.connect();
    expect(states).toEqual(["connected"]); // no duplicate transition
  });

  test("disconnect releases every listener and can be called repeatedly", async () => {
    const stub = makeStubClient();
    const transport = makeTransport(stub);
    await transport.connect();
    transport.watchCommandEnvelopes(PAIR_ID, () => {});
    transport.watchDeviceUpdates(PAIR_ID, () => {});
    expect(stub.streams.size).toBe(2);

    await transport.disconnect();
    await transport.disconnect();
    expect(stub.streams.size).toBe(0);
    expect(stub.unsubscribed.sort()).toEqual([pairCommandsPath(PAIR_ID), pairDevicesPath(PAIR_ID)].sort());
  });

  test("reconnecting after a disconnect re-establishes listeners", async () => {
    const stub = makeStubClient();
    const transport = makeTransport(stub);
    await transport.connect();
    transport.watchCommandEnvelopes(PAIR_ID, () => {});
    await transport.disconnect();
    await transport.connect();
    transport.watchCommandEnvelopes(PAIR_ID, () => {});
    expect(stub.streams.size).toBe(1);
  });

  test("an individual unsubscribe is idempotent and does not disturb the others", async () => {
    const stub = makeStubClient();
    const transport = makeTransport(stub);
    await transport.connect();
    const stopCommands = transport.watchCommandEnvelopes(PAIR_ID, () => {});
    transport.watchDeviceUpdates(PAIR_ID, () => {});
    stopCommands();
    stopCommands();
    expect([...stub.streams.keys()]).toEqual([pairDevicesPath(PAIR_ID)]);
  });
});

describe("pairing", () => {
  test("createInvitation calls the callable and returns its pairingId/expiry", async () => {
    const stub = makeStubClient();
    stub.setCallableResult({ pairingId: "pairing-1", expiresAt: NOW + 120_000 });
    const transport = makeTransport(stub);
    await transport.connect();

    const result = await transport.createInvitation({
      desktopDeviceId: PAIR_ID,
      desktopLabel: "Desk",
      desktopFingerprint: "AB:CD",
      desktopPublicKey: "cHVibGlj",
      secret: "s3cret",
      approvedCapabilities: ["notifications"],
      approvedProfileAllowlist: ["default"],
    });
    expect(result).toEqual({ pairingId: "pairing-1", expiresAt: NOW + 120_000 });
    // The whole payload, not just the callable name. The approved grants are the only place the
    // human's choice is recorded — claimPairing copies them onto the device record and the claim
    // request carries no capability list of its own — so a transport that quietly dropped them
    // sent an invitation nobody could claim. Asserting the name alone did not catch that.
    expect(stub.callables[0]).toEqual({
      name: "createPairingInvitation",
      data: {
        desktopDeviceId: PAIR_ID,
        desktopLabel: "Desk",
        desktopFingerprint: "AB:CD",
        desktopPublicKey: "cHVibGlj",
        secret: "s3cret",
        approvedCapabilities: ["notifications"],
        approvedProfileAllowlist: ["default"],
      },
    });
  });

  test("cancelInvitation calls the cancel callable and tolerates its failure", async () => {
    const stub = makeStubClient();
    const transport = makeTransport(stub);
    await transport.connect();
    await transport.cancelInvitation("pairing-1");
    expect(stub.callables.at(-1)).toEqual({ name: "cancelPairingInvitation", data: { pairingId: "pairing-1" } });

    // The invitation also expires on its own after 120s, so a failure here must not propagate as
    // a pairing error.
    const failing = makeStubClient();
    failing.client.callFunction = async () => {
      throw new Error("offline");
    };
    const tolerant = makeTransport(failing);
    await expect(tolerant.cancelInvitation("pairing-1")).resolves.toBeUndefined();
  });

  test("watchDeviceUpdates reports EVERY change, including a repeat of one already seen", async () => {
    const stub = makeStubClient();
    const transport = makeTransport(stub);
    await transport.connect();
    const seen: string[] = [];
    transport.watchDeviceUpdates(PAIR_ID, (device) => seen.push(device.deviceId));

    const handlers = stub.streams.get(pairDevicesPath(PAIR_ID))!;
    handlers.onEvent({ type: "put", path: "/", data: { "mobile-device-1": makeDevice() } });
    // A repeat IS reported now, and that is the fix (review 3 §P0.3). The old watcher kept a  set
    // and dropped every later frame for a device id, so a revoke performed by the phone or by another
    // installation never reached this desktop — and a command queued before it could still be executed
    // against a local record that said active. A stream that reports state changes has to report all of
    // them; "announce a claim once" is watchPairingClaim's job, and it has its own test below.
    handlers.onEvent({ type: "put", path: "/", data: { "mobile-device-1": makeDevice() } });
    handlers.onEvent({
      type: "put",
      path: "/mobile-device-2",
      data: makeDevice({ deviceId: "mobile-device-2" }),
    });
    expect(seen).toEqual(["mobile-device-1", "mobile-device-1", "mobile-device-2"]);
  });

  test("watchPairingClaim surfaces one invitation's claim, once, and nothing else", async () => {
    // The seam that replaced the broad adoption watcher: the pairing module cannot see a record claimed
    // under another invitation, so it cannot adopt one (review 3 §P0.1).
    const stub = makeStubClient();
    const transport = makeTransport(stub);
    await transport.connect();
    const seen: string[] = [];
    transport.watchPairingClaim(PAIR_ID, "pairing-1", (device) => seen.push(device.deviceId));

    const handlers = stub.streams.get(pairDevicesPath(PAIR_ID))!;
    handlers.onEvent({
      type: "put",
      path: "/",
      data: { "mobile-device-1": makeDevice({ pairingId: "pairing-1" }) },
    });
    // A record from another invitation, and a repeat of the one we already announced.
    handlers.onEvent({
      type: "put",
      path: "/mobile-device-2",
      data: makeDevice({ deviceId: "mobile-device-2", pairingId: "pairing-other" }),
    });
    handlers.onEvent({
      type: "put",
      path: "/mobile-device-1",
      data: makeDevice({ pairingId: "pairing-1" }),
    });
    expect(seen).toEqual(["mobile-device-1"]);
  });

  test("a malformed device record is ignored rather than crashing the stream", async () => {
    const stub = makeStubClient();
    const transport = makeTransport(stub);
    await transport.connect();
    const seen: string[] = [];
    transport.watchDeviceUpdates(PAIR_ID, (device) => seen.push(device.deviceId));
    const handlers = stub.streams.get(pairDevicesPath(PAIR_ID))!;
    handlers.onEvent({ type: "put", path: "/bogus", data: { not: "a device" } });
    handlers.onEvent({ type: "put", path: "/mobile-device-1", data: makeDevice() });
    expect(seen).toEqual(["mobile-device-1"]);
  });

  test("revokeDevice calls the revoke callable", async () => {
    const stub = makeStubClient();
    const transport = makeTransport(stub);
    await transport.connect();
    await transport.revokeDevice(PAIR_ID, "mobile-device-1");
    expect(stub.callables.at(-1)).toEqual({
      name: "revokeDevice",
      data: { pairId: PAIR_ID, deviceId: "mobile-device-1" },
    });
  });
});

/**
 * Event admission moved behind the `enqueueEvent` callable (review 3 §P0.2), so the two-phase
 * bump-then-create protocol these tests covered is gone, and with it the per-pair serialisation queue
 * that existed only to stop two of those pairs interleaving.
 *
 * What was wrong with it is worth restating, because every one of those tests passed: the per-pair
 * ceiling was enforced by Security Rules validating the CONTENTS of a client-written
 * `quotaWindows/{windowId}` node, and a rule cannot constrain the KEY it is evaluated under — so the
 * same canonical timestamps stored under any number of different keys sharded the cap without limit.
 * The server derives every window id from its own clock now, and the equivalent coverage lives in
 * strideterm-mobile: cloud/functions/test/enqueue-event-core.test.ts for the decisions and the rules
 * suite for the branch being closed to clients.
 *
 * What remains testable here is the thin part this transport still owns: one callable, and the error
 * mapping that keeps a quota answer distinguishable from a transport failure.
 */
describe("event admission through the enqueueEvent callable", () => {
  test("sends the pair id and the event, and writes nothing to RTDB itself", async () => {
    const stub = makeStubClient();
    const transport = makeTransport(stub);
    await transport.connect();
    const event = makeEvent();
    await transport.sendEvent(PAIR_ID, event);

    expect(stub.callables).toContainEqual({ name: "enqueueEvent", data: { pairId: PAIR_ID, event } });
    // No quota-window bumps, no event write: both branches are Admin-SDK-only now, so a client write
    // here would simply be refused by the rules — and would mean this transport had not been updated.
    expect(stub.writes).toHaveLength(0);
    expect(stub.multiUpdates).toHaveLength(0);
  });

  test("a resource-exhausted rejection maps to MobileQuotaExceededError", async () => {
    // The distinction upstream depends on: a quota answer is rolled into the once-a-day suppression
    // summary, while a real failure is logged as one (plan §7).
    const stub = makeStubClient();
    stub.client.callFunction = async () => {
      throw new MobileFirebaseCallableError("enqueueEvent", "resource-exhausted");
    };
    const transport = makeTransport(stub);
    await transport.connect();
    await expect(transport.sendEvent(PAIR_ID, makeEvent())).rejects.toBeInstanceOf(MobileQuotaExceededError);
  });

  test("any other failure is NOT disguised as a quota rejection", async () => {
    const stub = makeStubClient();
    stub.client.callFunction = async () => {
      throw new MobileFirebaseCallableError("enqueueEvent", "permission-denied");
    };
    const transport = makeTransport(stub);
    await transport.connect();
    await expect(transport.sendEvent(PAIR_ID, makeEvent())).rejects.not.toBeInstanceOf(MobileQuotaExceededError);
  });

  test("a transport-level failure surfaces as itself", async () => {
    const stub = makeStubClient();
    stub.client.callFunction = async () => {
      throw new Error("offline");
    };
    const transport = makeTransport(stub);
    await transport.connect();
    await expect(transport.sendEvent(PAIR_ID, makeEvent())).rejects.toThrow("offline");
  });
});

describe("commands, results and presence", () => {
  test("watchCommandEnvelopes parses envelopes from snapshot and incremental frames", async () => {
    const stub = makeStubClient();
    const transport = makeTransport(stub);
    await transport.connect();
    const received: string[] = [];
    transport.watchCommandEnvelopes(PAIR_ID, (envelope) => received.push(envelope.messageId));

    const handlers = stub.streams.get(pairCommandsPath(PAIR_ID))!;
    handlers.onEvent({ type: "put", path: "/", data: { "command-1": makeEnvelope() } });
    handlers.onEvent({
      type: "put",
      path: "/command-2",
      data: makeEnvelope({ messageId: "command-2" }),
    });
    // A cleanup sweep deletes a node — streamed as null data, which is not an envelope.
    handlers.onEvent({ type: "put", path: "/command-1", data: null });
    expect(received).toEqual(["command-1", "command-2"]);
  });

  test("a malformed command envelope is skipped, not passed on as a partial object", async () => {
    const stub = makeStubClient();
    const transport = makeTransport(stub);
    await transport.connect();
    const received: string[] = [];
    transport.watchCommandEnvelopes(PAIR_ID, (envelope) => received.push(envelope.messageId));
    const handlers = stub.streams.get(pairCommandsPath(PAIR_ID))!;
    handlers.onEvent({ type: "put", path: "/bad", data: { messageId: "bad" } });
    expect(received).toEqual([]);
  });

  test("claimCommand admits a command once and rejects the replay", async () => {
    const stub = makeStubClient();
    const transport = makeTransport(stub);
    await transport.connect();
    expect(await transport.claimCommand(PAIR_ID, "command-1")).toBe(true);
    expect(await transport.claimCommand(PAIR_ID, "command-1")).toBe(false);
    expect(await transport.claimCommand(PAIR_ID, "command-2")).toBe(true);
  });

  test("sendResultEnvelope writes under the commandId the mobile watcher subscribes to", async () => {
    const stub = makeStubClient();
    const transport = makeTransport(stub);
    await transport.connect();
    const envelope = makeEnvelope({ messageType: "commandResult", messageId: "command-1" });
    await transport.sendResultEnvelope(PAIR_ID, "mobile-device-1", "command-1", envelope);
    expect(stub.writes.at(-1)).toEqual({
      // Under the ISSUING device's own results subtree — the only results branch the rules let it
      // read (review 2 §P0.1).
      path: pairResultPath(PAIR_ID, "mobile-device-1", "command-1"),
      value: envelope,
    });
  });

  test("updatePresence writes this device's own node, tagged with the session uid", async () => {
    const stub = makeStubClient();
    const transport = makeTransport(stub);
    await transport.connect();
    await transport.updatePresence(PAIR_ID, PAIR_ID, "online");
    expect(stub.writes.at(-1)).toEqual({
      path: pairPresencePath(PAIR_ID, PAIR_ID),
      value: { deviceId: PAIR_ID, uid: "desktop-uid", status: "online", lastSeenAt: NOW },
    });
  });

  test("presence goes offline through the same per-device node", async () => {
    const stub = makeStubClient();
    const transport = makeTransport(stub);
    await transport.connect();
    await transport.updatePresence(PAIR_ID, PAIR_ID, "offline");
    expect((stub.writes.at(-1)!.value as { status: string }).status).toBe("offline");
  });
});
