import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, test, vi } from "vitest";
import { MobileManager, catalogRevisionOf, notificationKindFor } from "./mobile-manager.js";
import { buildExternalNotificationEvent } from "../notifications/external-notification-event.js";

test("questions use the native waiting-for-input notification channel", () => {
  expect(notificationKindFor("question")).toBe("waiting");
});
import { buildNotificationBody, recentTerminalExcerpt } from "../notifications/notification-context.js";
import { createMobilePairing } from "./mobile-pairing.js";
import { createMobileDeviceStore } from "./mobile-device-store.js";
import { createMobileAuditLogStore } from "./mobile-audit-log-store.js";
import { createMobileIdempotencyStore } from "./mobile-idempotency-store.js";
import { createMobileCommandDispatcher, type MobileCommandRuntime } from "./mobile-command-dispatch.js";
import { createMobileWebSessionTicketStore } from "./mobile-web-session-ticket-store.js";
import { createMobileNotificationOriginStore } from "./mobile-notification-origin-store.js";
import { createInMemoryMobileFirebaseTransport, MobileQuotaExceededError } from "./mobile-firebase-transport.js";
import { MobileFirebaseCallableError, MobileFirebasePermissionDeniedError } from "./mobile-firebase-rest.js";
import {
  computeGrantCommitment,
  deriveSessionKey,
  exportRawPublicKey,
  generateX25519KeyPair,
  openCombinedBase64,
  openEnvelope,
  buildRoutingAad,
  sealEnvelope,
} from "./mobile-crypto.js";
import {
  MAX_PUSH_EVENTS_PER_PAIR_PER_UTC_DAY,
  PROTOCOL_VERSION,
  RESERVED_HIGH_PRIORITY_DAILY_PUSH_SLOTS,
  SESSION_KEY_HKDF_INFO,
  MAX_EVENT_ENVELOPE_BYTES,
  NotificationPayloadSchema,
} from "./mobile-schemas.js";
import type { Capability, Command, EncryptedEnvelope, MobileDeviceRecord } from "./mobile-schemas.js";
import type { ExternalNotificationEvent } from "../../shared/types/notifications.js";
import type { AppState } from "../../shared/types/state.js";
import { makeCloudDevice } from "./mobile-test-fixtures.js";

const OWN_DEVICE_ID = "desktop-1";
/**
 * The redeeming server's own context, as `remote-server.ts` supplies it.
 *
 * A ticket is bound to one transport and one origin now, so reading one back takes saying which
 * server is asking (production hardening §5 "Ticket" 2).
 */
const TICKET_CONTEXT = { transport: "legacy" as const, origins: ["https://example.trycloudflare.com"] };
const PROTOCOL_INFO = Buffer.from(SESSION_KEY_HKDF_INFO);

const tempDirs: string[] = [];
const openStores: Array<{ close(): void }> = [];
afterEach(async () => {
  for (const store of openStores.splice(0)) store.close();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function flush(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

function makeFakeRuntime(): MobileCommandRuntime & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    pauseTask(workspaceId) {
      calls.push(`pauseTask:${workspaceId}`);
      return { ok: true };
    },
    async resumeTask(workspaceId) {
      calls.push(`resumeTask:${workspaceId}`);
      return { ok: true };
    },
    stopTask(workspaceId) {
      calls.push(`stopTask:${workspaceId}`);
      return { ok: true };
    },
    async resetTask(workspaceId) {
      calls.push(`resetTask:${workspaceId}`);
      return { ok: true };
    },
    async updateTaskDescription(workspaceId, description) {
      calls.push(`updateTaskDescription:${workspaceId}:${description}`);
      return { ok: true };
    },
    async resendTaskInstruction(workspaceId, role) {
      calls.push(`resendTaskInstruction:${workspaceId}:${role}`);
      return { ok: true };
    },
    async createCloudflareTunnel() {
      calls.push("createCloudflareTunnel");
    },
    getPayload() {
      return { remoteAccess: { enabled: true, host: "0.0.0.0", tunnel: { status: "connected", publicUrl: "" } } };
    },
    clearAlertForSession(sessionId) {
      calls.push(`clearAlertForSession:${sessionId}`);
      return null;
    },
  };
}

async function createFixture(
  overrides: {
    now?: () => number;
    ownDeviceId?: string;
    getProfileIds?: () => string[];
    getCatalogSignature?: (allowedProfileIds: string[]) => string;
  } = {},
) {
  // The desktop installation this manager IS. Defaults to the one every existing test uses; a
  // test that needs a second computer passes its own, because the installation (data dir) is the
  // security principal — not the process and not a window (review 2 §Multiwindow).
  const ownDeviceId = overrides.ownDeviceId ?? OWN_DEVICE_ID;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-mobile-manager-"));
  tempDirs.push(dir);
  const auditLogStore = createMobileAuditLogStore(path.join(dir, "audit.db"));
  const idempotencyStore = createMobileIdempotencyStore(path.join(dir, "idempotency.db"));
  openStores.push(auditLogStore, idempotencyStore);

  let devices: MobileDeviceRecord[] = [];
  const mutateDevices = async (fn: (current: MobileDeviceRecord[]) => MobileDeviceRecord[]) => {
    devices = fn(devices);
    return devices;
  };
  const deviceStore = createMobileDeviceStore({ getDevices: () => devices, mutateDevices });

  const desktopKeyPair = generateX25519KeyPair();
  const desktopPublicKeyBase64 = exportRawPublicKey(desktopKeyPair.publicKey).toString("base64");

  const transport = createInMemoryMobileFirebaseTransport();
  await transport.connect();

  const state: AppState = {
    activeWorkspaceId: "",
    settings: {
      remoteAccess: {
        enabled: true,
        host: "0.0.0.0",
        port: 4756,
        token: "x",
        customPublicUrl: "",
        cloudflaredPath: "",
        autoTunnel: true,
      },
    } as AppState["settings"],
    tabTemplates: [],
    profiles: [],
    workspaces: [
      { id: "ws-1", profileId: "default", kind: "task", task: { taskId: "task-1", state: "paused" } },
      // A second workspace so a test can issue two genuinely distinct commands and tell their
      // effects apart (the out-of-order delivery test).
      { id: "ws-2", profileId: "default", kind: "task", task: { taskId: "task-2", state: "paused" } },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any,
    ssh: {} as AppState["ssh"],
    windowSlots: [],
  };
  const runtime = makeFakeRuntime();
  const ticketStore = createMobileWebSessionTicketStore();
  const commandDispatcher = createMobileCommandDispatcher({
    getState: () => state,
    runtime,
    idempotencyStore,
    auditLogStore,
    ticketIssuer: ticketStore,
  });

  const pairing = createMobilePairing({
    transport,
    deviceStore,
    auditLogStore,
    identity: { deviceId: ownDeviceId, label: "My Desktop", publicKeyBase64: desktopPublicKeyBase64 },
    // Adoption is not what this file tests — mobile-pairing.test.ts and
    // mobile-manager.activation.test.ts own the three checks a claim must pass (review 3 §P0.1),
    // including the real HMAC recomputation. Here a claim that reaches the watcher is meant to be
    // adopted, so the proof step is a constant.
    verifyKeyProof: () => true,
  });

  const revokeRemoteSessions = vi.fn();
  const revokeRelayE2eSession = vi.fn();
  const externalNotificationEvents = new EventEmitter();
  const notificationOrigins = createMobileNotificationOriginStore();
  const manager = new MobileManager({
    transport,
    pairing,
    deviceStore,
    auditLogStore,
    commandDispatcher,
    externalNotificationEvents,
    ownDeviceId,
    ownPrivateKey: desktopKeyPair.privateKey,
    ticketStore,
    notificationOrigins,
    revokeRemoteSessions,
    revokeRelayE2eSession,
    now: overrides.now,
    getProfileIds: overrides.getProfileIds,
    getCatalogSignature: overrides.getCatalogSignature,
  });

  return {
    ownDeviceId,
    manager,
    transport,
    deviceStore,
    // The same seam runtime.ts wires to `store.mutate`. Exposed so a test can put the persisted
    // device list into a state the store's own API deliberately has no method for — there is no
    // in-place device-key rotation in the product (a re-paired phone claims as a NEW device id),
    // so the only way to exercise the receiver's behaviour when a record's sessionKeyVersion moves is to
    // write it directly.
    mutateDevices,
    auditLogStore,
    runtime,
    externalNotificationEvents,
    desktopKeyPair,
    state,
    ticketStore,
    notificationOrigins,
    revokeRemoteSessions,
    revokeRelayE2eSession,
  };
}

/** Adds a device directly (bypassing the pairing flow) with a real X25519 keypair, so tests can build valid envelopes "as if sent by the mobile app". */
async function addMobileDevice(
  deviceStore: ReturnType<typeof createMobileDeviceStore>,
  overrides: {
    deviceId?: string;
    /** The desktop installation this device is paired WITH. Defaults to the usual one. */
    pairId?: string;
    capabilities?: Capability[];
    profileAllowlist?: string[];
    minPriority?: "high" | "normal" | "low";
    mutedKinds?: string[];
    /**
     * Devices are marked verified by default so the many tests about *delivery* aren't all
     * really testing the pairing handshake. The handshake itself has its own describe block,
     * which passes `verified: false` and drives the round trip for real.
     */
    verified?: boolean;
    /**
     * Reuses an existing keypair instead of generating one. The two-computer tests need ONE phone
     * present in two desktops' device stores — same physical device, same public key, two pair
     * records — which is exactly the case review 2 asks the semantics to be explicit about.
     */
    keyPair?: ReturnType<typeof generateX25519KeyPair>;
  } = {},
) {
  const keyPair = overrides.keyPair ?? generateX25519KeyPair();
  const deviceId = overrides.deviceId || "mobile-1";
  await deviceStore.addDevice({
    deviceId,
    uid: `uid-${deviceId}`,
    pairId: overrides.pairId ?? OWN_DEVICE_ID,
    platform: "android",
    label: "Pixel 8",
    fingerprint: "AB:CD",
    pairingId: "pairing-1",
    grantCommitment: "grant-commitment",
    keyProof: "k".repeat(43),
    state: "keyProven",
    publicKey: exportRawPublicKey(keyPair.publicKey).toString("base64"),
    sessionKeyVersion: 1,
    // Every grant by default: this fixture backs the tests about delivery, dispatch and the
    // handshake, none of which are about authorization. The tests that ARE about it pass an
    // explicit, narrower list.
    capabilities:
      overrides.capabilities ??
      ([
        "notifications",
        "status.read",
        "task.control",
        "task.destructive",
        "remote.request",
        "remote.webSession",
      ] as Capability[]),
    profileAllowlist: overrides.profileAllowlist || ["default"],
    now: 1000,
  });
  if (overrides.minPriority || overrides.mutedKinds) {
    await deviceStore.updateNotificationFilter(deviceId, {
      minPriority: overrides.minPriority || "low",
      mutedKinds: overrides.mutedKinds || [],
    });
  }
  // `verified` now means "activated": a human compared the pairing code and the cloud committed it
  // (review 3 §P0.1). The option keeps its name because what it means to a test has not changed —
  // "is this device usable" — but the mechanism has: nothing automatic reaches `active` any more.
  if (overrides.verified !== false) {
    await deviceStore.markActive(deviceId, 1000);
  }
  return { deviceId, keyPair };
}

function sessionKeyFor(
  mobilePrivateKey: Parameters<typeof deriveSessionKey>[0],
  desktopPublicKey: Parameters<typeof deriveSessionKey>[1],
  // The salt is the pairId, so one phone paired with two desktops holds two different session
  // keys even though its own keypair never changes — see the two-computer block below.
  pairId = OWN_DEVICE_ID,
) {
  return deriveSessionKey(mobilePrivateKey, desktopPublicKey, Buffer.from(pairId), PROTOCOL_INFO);
}

/**
 * Seals `command` into an envelope addressed to this desktop.
 *
 * `messageId` also becomes the inner command's `commandId`, because the receiver now requires the
 * two to be equal before it will claim anything (review 2 §P0.2) — and because the RTDB node key,
 * the AAD and the result path are all bound to the outer id while the claim and the idempotency
 * ledger key off the inner one, so a fixture where they differ describes a message no honest client
 * can produce. A test that wants them to differ says so explicitly with `innerCommandId`.
 */
function buildCommandEnvelope(params: {
  messageId: string;
  senderDeviceId: string;
  sessionKey: Buffer;
  command: Command;
  /** Defaults to this desktop. A test that names something else exercises review 2 §P0.2. */
  targetDeviceId?: string;
  pairId?: string;
  /** Deliberately breaks the inner/outer id equality. */
  innerCommandId?: string;
  /** Deliberately breaks the inner/outer TIMESTAMP equality, or puts the envelope outside its window. */
  createdAtOverride?: number;
  expiresAtOverride?: number;
}): EncryptedEnvelope {
  const pairId = params.pairId ?? OWN_DEVICE_ID;
  const targetDeviceId = params.targetDeviceId ?? OWN_DEVICE_ID;
  const command = { ...params.command, commandId: params.innerCommandId ?? params.messageId } as Command;
  // The envelope carries the COMMAND's own timestamps, because the receiver requires them to be equal
  // (review 3 §P0.4) and additionally checks the outer pair against its own clock. The fixed
  // `createdAt: 1000, expiresAt: 2000` these fixtures used to carry is 1970, so every envelope built
  // that way now reads as long expired — which is the new behaviour working, not a fixture detail.
  const createdAt = params.createdAtOverride ?? command.createdAt;
  const expiresAt = params.expiresAtOverride ?? command.expiresAt;
  const aad = buildRoutingAad({
    protocolVersion: 2,
    pairId,
    sourceDeviceId: params.senderDeviceId,
    targetDeviceId,
    messageId: params.messageId,
    messageType: "command",
    sessionKeyVersion: 1,
    createdAt,
    expiresAt,
  });
  const sealed = sealEnvelope(Buffer.from(JSON.stringify(command)), params.sessionKey, aad);
  return {
    protocolVersion: 2,
    pairId,
    senderDeviceId: params.senderDeviceId,
    targetDeviceId,
    messageId: params.messageId,
    messageType: "command",
    nonce: sealed.nonce.toString("base64"),
    createdAt,
    expiresAt,
    ciphertext: sealed.ciphertext.toString("base64"),
    aad: aad.toString("base64"),
    sessionKeyVersion: 1,
  };
}

function makePauseCommand(overrides: Partial<Command> = {}): Command {
  // A one-minute lifetime, not a billion — COMMAND_POLICY bounds `expiresAt - createdAt` per type
  // now (review 2 §P0.3), and a fixture that quietly declared a 12-day TTL would be exercising the
  // rejection path rather than the behaviour each test is actually about.
  const createdAt = Date.now();
  return {
    commandId: "cmd-1",
    idempotencyKey: "idem-1",
    createdAt,
    expiresAt: createdAt + 60_000,
    profileId: "default",
    targetDeviceId: OWN_DEVICE_ID,
    status: "queued",
    type: "task.pause",
    payload: { workspaceId: "ws-1", taskId: "task-1" },
    ...overrides,
  } as Command;
}

describe("MobileManager inbox: command envelope -> decrypt -> dispatch -> encrypted result", () => {
  test("a valid command envelope from a known device is decrypted, dispatched, and results in an encrypted result envelope", async () => {
    const { manager, transport, deviceStore, desktopKeyPair, runtime } = await createFixture();
    const { deviceId, keyPair } = await addMobileDevice(deviceStore);
    const sessionKey = sessionKeyFor(keyPair.privateKey, desktopKeyPair.publicKey);

    manager.start();
    const envelope = buildCommandEnvelope({
      messageId: "msg-1",
      senderDeviceId: deviceId,
      sessionKey,
      command: makePauseCommand(),
    });
    transport.pushCommandEnvelope(OWN_DEVICE_ID, envelope);
    await flush();

    expect(runtime.calls).toContain("pauseTask:ws-1");
    const results = transport.getSentResultEnvelopes(OWN_DEVICE_ID);
    expect(results).toHaveLength(1);
    expect(results[0].messageType).toBe("commandResult");

    // Decrypt the result envelope the same way the mobile app would, to
    // confirm it actually round-trips end to end.
    const resultAad = Buffer.from(results[0].aad, "base64");
    const decryptedResult = JSON.parse(
      openEnvelope(
        Buffer.from(results[0].ciphertext, "base64"),
        Buffer.from(results[0].nonce, "base64"),
        sessionKey,
        resultAad,
      ).toString("utf8"),
    );
    // The result is filed under the ENVELOPE messageId, which the receiver now requires the inner
    // commandId to equal — so there is only one identity for this exchange, not two.
    expect(decryptedResult).toMatchObject({ commandId: "msg-1", status: "succeeded" });
    manager.stop();
  });

  test("an envelope from an unknown or revoked device is rejected without dispatching", async () => {
    const { manager, transport, deviceStore, desktopKeyPair, runtime } = await createFixture();
    const { deviceId, keyPair } = await addMobileDevice(deviceStore);
    await deviceStore.revokeDevice(deviceId, 2000);
    const sessionKey = sessionKeyFor(keyPair.privateKey, desktopKeyPair.publicKey);

    manager.start();
    const envelope = buildCommandEnvelope({
      messageId: "msg-1",
      senderDeviceId: deviceId,
      sessionKey,
      command: makePauseCommand(),
    });
    transport.pushCommandEnvelope(OWN_DEVICE_ID, envelope);
    await flush();

    expect(runtime.calls).not.toContain("pauseTask:ws-1");
    expect(transport.getSentResultEnvelopes(OWN_DEVICE_ID)).toHaveLength(0);
    manager.stop();
  });

  test("an envelope that decrypts fine but fails Command schema validation is rejected without dispatching", async () => {
    const { manager, transport, deviceStore, desktopKeyPair, runtime, auditLogStore } = await createFixture();
    const { deviceId, keyPair } = await addMobileDevice(deviceStore);
    const sessionKey = sessionKeyFor(keyPair.privateKey, desktopKeyPair.publicKey);

    manager.start();
    const messageId = "msg-bad-schema";
    // Current timestamps: the receiver checks the envelope window BEFORE it decrypts (review 3 §P0.4), so
    // a 1970 envelope would be refused as expired and never reach the schema check this test is about.
    const envelopeCreatedAt = Date.now();
    const envelopeExpiresAt = envelopeCreatedAt + 60_000;
    const aad = buildRoutingAad({
      protocolVersion: 2,
      pairId: OWN_DEVICE_ID,
      sourceDeviceId: deviceId,
      targetDeviceId: OWN_DEVICE_ID,
      messageId,
      messageType: "command",
      sessionKeyVersion: 1,
      createdAt: envelopeCreatedAt,
      expiresAt: envelopeExpiresAt,
    });
    // Valid ciphertext (decrypts fine), but the plaintext is not a valid
    // Command — missing every required commandEnvelopeFields property and
    // using a `type` outside CommandSchema's discriminated union.
    const sealed = sealEnvelope(Buffer.from(JSON.stringify({ type: "not.a.real.command" })), sessionKey, aad);
    const envelope: EncryptedEnvelope = {
      protocolVersion: 2,
      pairId: OWN_DEVICE_ID,
      senderDeviceId: deviceId,
      targetDeviceId: OWN_DEVICE_ID,
      messageId,
      messageType: "command",
      nonce: sealed.nonce.toString("base64"),
      createdAt: envelopeCreatedAt,
      expiresAt: envelopeExpiresAt,
      ciphertext: sealed.ciphertext.toString("base64"),
      aad: aad.toString("base64"),
      sessionKeyVersion: 1,
    };
    transport.pushCommandEnvelope(OWN_DEVICE_ID, envelope);
    await flush();

    expect(runtime.calls).toHaveLength(0);
    expect(transport.getSentResultEnvelopes(OWN_DEVICE_ID)).toHaveLength(0);
    const { entries } = auditLogStore.query({ deviceId, action: "command.rejected" });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ status: "failure", detail: "decrypt-or-schema-failed" });
    manager.stop();
  });

  test("a duplicate delivery of the same command envelope is ignored (no double dispatch, no second result)", async () => {
    const { manager, transport, deviceStore, desktopKeyPair, runtime } = await createFixture();
    const { deviceId, keyPair } = await addMobileDevice(deviceStore);
    const sessionKey = sessionKeyFor(keyPair.privateKey, desktopKeyPair.publicKey);

    manager.start();
    const envelope = buildCommandEnvelope({
      messageId: "msg-1",
      senderDeviceId: deviceId,
      sessionKey,
      command: makePauseCommand(),
    });
    transport.pushCommandEnvelope(OWN_DEVICE_ID, envelope);
    await flush();
    // Redelivered — e.g. transport offline-queue replay after a reconnect.
    transport.pushCommandEnvelope(OWN_DEVICE_ID, envelope);
    await flush();

    expect(runtime.calls.filter((c) => c === "pauseTask:ws-1")).toHaveLength(1);
    expect(transport.getSentResultEnvelopes(OWN_DEVICE_ID)).toHaveLength(1);
    manager.stop();
  });

  test("commands delivered out of order both run, each answering under its own commandId", async () => {
    // Review §P1.6 asks for reordered delivery alongside duplicates. RTDB's child stream gives no
    // ordering guarantee across a reconnect resync, so the later command can genuinely arrive
    // first. Nothing may be dropped as "stale" and no result may be filed against the wrong id —
    // the mobile watcher subscribes to one specific commandId and would otherwise hang forever, or
    // worse, read someone else's answer.
    const { manager, transport, deviceStore, desktopKeyPair, runtime } = await createFixture();
    const { deviceId, keyPair } = await addMobileDevice(deviceStore);
    const sessionKey = sessionKeyFor(keyPair.privateKey, desktopKeyPair.publicKey);

    manager.start();
    const first = buildCommandEnvelope({
      messageId: "cmd-first",
      senderDeviceId: deviceId,
      sessionKey,
      command: makePauseCommand({
        commandId: "cmd-first",
        idempotencyKey: "idem-first",
        payload: { workspaceId: "ws-1", taskId: "task-1" },
      }),
    });
    const second = buildCommandEnvelope({
      messageId: "cmd-second",
      senderDeviceId: deviceId,
      sessionKey,
      command: makePauseCommand({
        commandId: "cmd-second",
        idempotencyKey: "idem-second",
        payload: { workspaceId: "ws-2", taskId: "task-2" },
      }),
    });

    // Backwards: sequence 2 lands before sequence 1.
    transport.pushCommandEnvelope(OWN_DEVICE_ID, second);
    await flush();
    transport.pushCommandEnvelope(OWN_DEVICE_ID, first);
    await flush();

    expect(runtime.calls).toContain("pauseTask:ws-1");
    expect(runtime.calls).toContain("pauseTask:ws-2");

    const results = transport.getSentResultEnvelopes(OWN_DEVICE_ID);
    expect(results).toHaveLength(2);
    // The envelope id is the commandId, and each decrypted result names the command it answers.
    const answered = new Map(
      results.map((envelope) => {
        const plaintext = JSON.parse(
          openEnvelope(
            Buffer.from(envelope.ciphertext, "base64"),
            Buffer.from(envelope.nonce, "base64"),
            sessionKey,
            Buffer.from(envelope.aad, "base64"),
          ).toString("utf8"),
        );
        return [envelope.messageId, plaintext.commandId as string];
      }),
    );
    expect(answered.get("cmd-first")).toBe("cmd-first");
    expect(answered.get("cmd-second")).toBe("cmd-second");

    // And a resync that replays the older one afterwards still changes nothing.
    transport.pushCommandEnvelope(OWN_DEVICE_ID, first);
    await flush();
    expect(runtime.calls.filter((c) => c === "pauseTask:ws-1")).toHaveLength(1);
    expect(transport.getSentResultEnvelopes(OWN_DEVICE_ID)).toHaveLength(2);
    manager.stop();
  });

  test("commands queued while disconnected are processed exactly once after reconnect", async () => {
    const { manager, transport, deviceStore, desktopKeyPair, runtime } = await createFixture();
    const { deviceId, keyPair } = await addMobileDevice(deviceStore);
    const sessionKey = sessionKeyFor(keyPair.privateKey, desktopKeyPair.publicKey);

    manager.start();
    transport.simulateDisconnect();
    const envelope = buildCommandEnvelope({
      messageId: "msg-1",
      senderDeviceId: deviceId,
      sessionKey,
      command: makePauseCommand(),
    });
    transport.pushCommandEnvelope(OWN_DEVICE_ID, envelope); // queued, not delivered yet
    await flush();
    expect(runtime.calls).not.toContain("pauseTask:ws-1");

    transport.simulateReconnect();
    await flush();
    expect(runtime.calls.filter((c) => c === "pauseTask:ws-1")).toHaveLength(1);
    manager.stop();
  });
});

// ---------------------------------------------------------------------------
// Review 2 §P0.2 — the multi-computer target-confusion scenario.
//
// One phone, two desktops. Because `pairId := desktopDeviceId`, pairing with both produces two
// separate pair records and two separate session keys, and the phone holds both. It can therefore
// produce an envelope that is *perfectly authentic* to desktop A — right pair, right sender, right
// key, valid AEAD — while naming desktop B inside the plaintext it sealed.
//
// Under v1 desktop A decrypted that, saw a valid Command, and executed it. AEAD authenticity
// answers "did someone holding this key write this?"; nothing in the pipeline answered "was this
// addressed to me". These tests are the answer, and each of them asserts the same two things: no
// side effect, and no claim — because claiming is itself observable (it consumes the command so no
// other desktop can run it).
// ---------------------------------------------------------------------------
describe("MobileManager inbox: identity invariants (review 2 §P0.2)", () => {
  /** Everything an adversarial-routing test needs: a running manager and a mobile that can seal for it. */
  async function twoDesktopFixture() {
    const fixture = await createFixture();
    const { deviceId, keyPair } = await addMobileDevice(fixture.deviceStore);
    const sessionKey = sessionKeyFor(keyPair.privateKey, fixture.desktopKeyPair.publicKey);
    fixture.manager.start();
    return { ...fixture, deviceId, sessionKey };
  }

  /** No dispatch, no claim, and a fixed reason code in the audit trail. */
  function expectRefused(fixture: Awaited<ReturnType<typeof twoDesktopFixture>>, reason: string): void {
    expect(fixture.runtime.calls).not.toContain("pauseTask:ws-1");
    expect(fixture.transport.getSentResultEnvelopes(OWN_DEVICE_ID)).toHaveLength(0);
    const rejections = fixture.auditLogStore.query({ action: "command.rejected", limit: 20 });
    expect(rejections.entries.map((e) => e.detail)).toContain(reason);
  }

  test("a command authentic for THIS desktop but addressed to another is not executed", async () => {
    // The headline case. The envelope is sealed with the real session key for pair A and lands on
    // A's watcher; only the inner `targetDeviceId` says B.
    const fixture = await twoDesktopFixture();
    const envelope = buildCommandEnvelope({
      messageId: "cmd-for-b",
      senderDeviceId: fixture.deviceId,
      sessionKey: fixture.sessionKey,
      command: makePauseCommand({ targetDeviceId: "desktop-B" }),
    });
    fixture.transport.pushCommandEnvelope(OWN_DEVICE_ID, envelope);
    await flush();

    expectRefused(fixture, "command-target-mismatch");
    fixture.manager.stop();
  });

  test("an envelope whose OUTER target is another desktop is refused before it is even decrypted", async () => {
    // Belt and braces with the check above: the header is what the cloud and the rules can see, and
    // rejecting there means a misrouted envelope costs no decrypt at all.
    const fixture = await twoDesktopFixture();
    const envelope = buildCommandEnvelope({
      messageId: "cmd-outer-b",
      senderDeviceId: fixture.deviceId,
      sessionKey: fixture.sessionKey,
      command: makePauseCommand(),
      targetDeviceId: "desktop-B",
    });
    fixture.transport.pushCommandEnvelope(OWN_DEVICE_ID, envelope);
    await flush();

    expectRefused(fixture, "foreign-target");
    fixture.manager.stop();
  });

  test("an envelope naming a different pair is refused even when it arrives on this watcher", async () => {
    const fixture = await twoDesktopFixture();
    const envelope = buildCommandEnvelope({
      messageId: "cmd-other-pair",
      senderDeviceId: fixture.deviceId,
      sessionKey: fixture.sessionKey,
      command: makePauseCommand(),
      pairId: "desktop-B",
    });
    fixture.transport.pushCommandEnvelope(OWN_DEVICE_ID, envelope);
    await flush();

    expectRefused(fixture, "foreign-pair");
    fixture.manager.stop();
  });

  test("an inner commandId that differs from the envelope's messageId is refused", async () => {
    // The node key, the AAD and the result path bind to the OUTER id; the claim, the idempotency
    // ledger and the audit trail key off the INNER one. If the two may differ, a command can be
    // claimed under one identity and answered under another — and the phone's watcher, subscribed
    // to the outer id, would never see the result it was waiting for.
    const fixture = await twoDesktopFixture();
    const envelope = buildCommandEnvelope({
      messageId: "cmd-outer",
      innerCommandId: "cmd-inner-different",
      senderDeviceId: fixture.deviceId,
      sessionKey: fixture.sessionKey,
      command: makePauseCommand(),
    });
    fixture.transport.pushCommandEnvelope(OWN_DEVICE_ID, envelope);
    await flush();

    expectRefused(fixture, "command-id-mismatch");
    fixture.manager.stop();
  });

  test("the refusal audits a fixed reason code and nothing the sender wrote", async () => {
    // An audit line is read by a human during an incident. Echoing attacker-chosen text at them is
    // exactly what review 2 §P0.2 means by "obecný reason code bez obsahu".
    const fixture = await twoDesktopFixture();
    const envelope = buildCommandEnvelope({
      messageId: "cmd-for-b",
      senderDeviceId: fixture.deviceId,
      sessionKey: fixture.sessionKey,
      command: makePauseCommand({ targetDeviceId: "desktop-B--<script>alert(1)</script>" }),
    });
    fixture.transport.pushCommandEnvelope(OWN_DEVICE_ID, envelope);
    await flush();

    const serialized = JSON.stringify(fixture.auditLogStore.query({ limit: 50 }).entries);
    expect(serialized).not.toContain("script");
    expect(serialized).toContain("command-target-mismatch");
    fixture.manager.stop();
  });

  test("a correctly-addressed command from the same device still runs", async () => {
    // The control: the four checks above reject what they should and nothing else. Without this the
    // suite would pass just as well if the receiver refused everything.
    const fixture = await twoDesktopFixture();
    const envelope = buildCommandEnvelope({
      messageId: "cmd-ok",
      senderDeviceId: fixture.deviceId,
      sessionKey: fixture.sessionKey,
      command: makePauseCommand(),
    });
    fixture.transport.pushCommandEnvelope(OWN_DEVICE_ID, envelope);
    await flush();

    expect(fixture.runtime.calls).toContain("pauseTask:ws-1");
    expect(fixture.transport.getSentResultEnvelopes(OWN_DEVICE_ID)).toHaveLength(1);
    fixture.manager.stop();
  });

  test("a device record belonging to a different pair cannot drive this desktop", async () => {
    // Reachable if a state file is edited or merged across installations. Acting on it would mean
    // running a command from a device this desktop never paired with.
    const fixture = await createFixture();
    const keyPair = generateX25519KeyPair();
    await fixture.deviceStore.addDevice({
      deviceId: "mobile-from-elsewhere",
      uid: "uid-elsewhere",
      pairId: "desktop-B",
      platform: "android",
      label: "Pixel",
      fingerprint: "AB:CD",
      pairingId: "pairing-1",
      grantCommitment: "grant-commitment",
      keyProof: "k".repeat(43),
      state: "keyProven",
      publicKey: exportRawPublicKey(keyPair.publicKey).toString("base64"),
      sessionKeyVersion: 1,
      capabilities: ["task.control"],
      profileAllowlist: ["default"],
      now: 1000,
    });
    await fixture.deviceStore.markActive("mobile-from-elsewhere", 1000);
    fixture.manager.start();

    const sessionKey = sessionKeyFor(keyPair.privateKey, fixture.desktopKeyPair.publicKey);
    fixture.transport.pushCommandEnvelope(
      OWN_DEVICE_ID,
      buildCommandEnvelope({
        messageId: "cmd-elsewhere",
        senderDeviceId: "mobile-from-elsewhere",
        sessionKey,
        command: makePauseCommand(),
      }),
    );
    await flush();

    expect(fixture.runtime.calls).not.toContain("pauseTask:ws-1");
    const rejections = fixture.auditLogStore.query({ action: "command.rejected", limit: 20 });
    expect(rejections.entries.map((e) => e.detail)).toContain("device-pair-mismatch");
    fixture.manager.stop();
  });
});

describe("MobileManager outbox: ExternalNotificationEvent -> encrypted per-device NotificationEvent", () => {
  function makeExternalEvent(overrides: Partial<ExternalNotificationEvent> = {}): ExternalNotificationEvent {
    return {
      eventId: "evt-1",
      profileId: "default",
      workspaceId: "ws-1",
      sessionId: "ws-1:shell",
      panelId: "shell",
      kind: "waiting",
      priority: "high",
      title: "Waiting for input",
      detail: "hook:Notification:idle_prompt",
      dedupeKey: "ws-1:ws-1:shell:waiting",
      collapseKey: null,
      createdAt: 1000,
      actions: ["task.sendInstruction", "task.pause", "notification.acknowledge"],
      ...overrides,
    };
  }

  /**
   * Recorded on the way OUT so the acknowledgement can find its alert on the way back: the ack
   * payload is `{eventId}` only, and its schema is a mirrored `additionalProperties: false` copy, so
   * the desktop remembering what it sent is the whole mechanism (see
   * mobile-notification-origin-store.ts and the ack suite in mobile-command-dispatch.test.ts).
   */
  test("an alert-backed event records where it came from, once, whatever the device count", async () => {
    const { manager, deviceStore, externalNotificationEvents, notificationOrigins } = await createFixture();
    await addMobileDevice(deviceStore, { profileAllowlist: ["default"], minPriority: "low" });
    // A second phone on the same pairing receives the SAME eventId, so the recording must not
    // become one entry per device.
    await addMobileDevice(deviceStore, {
      deviceId: "dev-2",
      profileAllowlist: ["default"],
      minPriority: "low",
    });

    manager.start();
    externalNotificationEvents.emit("event", makeExternalEvent());
    await flush();

    expect(notificationOrigins.get("evt-1")).toEqual({
      profileId: "default",
      workspaceId: "ws-1",
      panelId: "shell",
      sessionId: "ws-1:shell",
    });
    expect(notificationOrigins.size()).toBe(1);
  });

  test("an event that never raised an alert records nothing", async () => {
    // The PR-review and pipeline forwards emit an ExternalNotificationEvent with a workspace but no
    // panel or session, because no attention alert was ever raised — so there is nothing an
    // acknowledgement could clear, and an entry would only be misleading state.
    const { manager, deviceStore, externalNotificationEvents, notificationOrigins } = await createFixture();
    await addMobileDevice(deviceStore, { profileAllowlist: ["default"], minPriority: "low" });

    manager.start();
    externalNotificationEvents.emit(
      "event",
      makeExternalEvent({ eventId: "evt-review", kind: "review", sessionId: null, panelId: null }),
    );
    await flush();

    expect(notificationOrigins.get("evt-review")).toBeNull();
    expect(notificationOrigins.size()).toBe(0);
  });

  test("an event is sent to a device whose profile allowlist and notification filter both allow it", async () => {
    const { manager, transport, deviceStore, externalNotificationEvents } = await createFixture();
    const { deviceId } = await addMobileDevice(deviceStore, { profileAllowlist: ["default"], minPriority: "low" });

    manager.start();
    externalNotificationEvents.emit("event", makeExternalEvent());
    await flush();

    const sent = transport.getSentEvents(OWN_DEVICE_ID);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ eventId: "evt-1", severity: "high", profileId: "default" });
    manager.stop();
  });

  test("an event's title/detail are only recoverable by decrypting with the target device's own session key", async () => {
    const { manager, transport, deviceStore, desktopKeyPair, externalNotificationEvents } = await createFixture();
    const { deviceId, keyPair } = await addMobileDevice(deviceStore);

    manager.start();
    externalNotificationEvents.emit(
      "event",
      makeExternalEvent({
        title: "Secret alert title",
        detail: "Approve deployment?\n\nRecent terminal output:\npassed ✅",
        workspaceName: "api-gateway",
        taskId: "task-42",
        panelId: "panel-codex",
        tab: "Claude Code",
        activity: "pnpm test",
        exitCode: 0,
        durationMs: 12_345,
      }),
    );
    await flush();
    manager.stop();

    const [sent] = transport.getSentEvents(OWN_DEVICE_ID);
    expect(sent.ciphertext).not.toContain("Secret alert title");

    const sessionKey = sessionKeyFor(keyPair.privateKey, desktopKeyPair.publicKey);
    const aad = Buffer.from(sent.aad, "base64");
    const plaintext = JSON.parse(openCombinedBase64(sent.ciphertext, sessionKey, aad).toString("utf8"));
    expect(plaintext.title).toBe("Secret alert title");
    expect(plaintext).toMatchObject({
      body: "Approve deployment?\n\nRecent terminal output:\npassed ✅",
      workspaceName: "api-gateway",
      taskId: "task-42",
      panelId: "panel-codex",
      tab: "Claude Code",
      activity: "pnpm test",
      exitCode: 0,
      durationMs: 12_345,
    });
    for (const field of ["body", "workspaceName", "taskId", "panelId", "tab", "activity", "exitCode", "durationMs"]) {
      expect(sent).not.toHaveProperty(field);
    }
    expect(Buffer.byteLength(JSON.stringify(sent), "utf8")).toBeLessThanOrEqual(MAX_EVENT_ENVELOPE_BYTES);
    void deviceId;
  });

  test("rich multilingual content survives encryption within the event envelope limit", async () => {
    const { manager, transport, deviceStore, desktopKeyPair, externalNotificationEvents } = await createFixture();
    const { keyPair } = await addMobileDevice(deviceStore);
    const event = buildExternalNotificationEvent({
      eventId: "evt-context-budget",
      profileId: "default",
      workspaceId: "ws-1",
      kind: "waiting",
      title: "界".repeat(300),
      detail: buildNotificationBody({
        kind: "waiting",
        message: "🧪".repeat(400),
        recentOutput: recentTerminalExcerpt(`${"界".repeat(1200)}\nFINAL RESULT`),
      }),
      workspaceName: "界".repeat(200),
      tab: "界".repeat(200),
      activity: "界".repeat(300),
      prompt: "界".repeat(500),
      exitCode: 0,
    });
    manager.start();
    externalNotificationEvents.emit("event", event);
    await flush();
    manager.stop();
    const sentEvents = transport.getSentEvents(OWN_DEVICE_ID);
    expect(sentEvents).toHaveLength(1);
    const sent = sentEvents[0];
    expect(Buffer.byteLength(JSON.stringify(sent), "utf8")).toBeLessThanOrEqual(MAX_EVENT_ENVELOPE_BYTES);
    const plaintext = JSON.parse(
      openCombinedBase64(
        sent.ciphertext,
        sessionKeyFor(keyPair.privateKey, desktopKeyPair.publicKey),
        Buffer.from(sent.aad, "base64"),
      ).toString("utf8"),
    );
    expect(NotificationPayloadSchema.safeParse(plaintext).success).toBe(true);
    expect(plaintext.body).toMatch(/FINAL RESULT$/);
    expect(plaintext.tab).toBe(event.tab);
    expect(plaintext.workspaceName).toBe(event.workspaceName);
    expect(plaintext.activity).toBe(event.activity);
    expect(plaintext.prompt).toBe(event.prompt);
  });

  test("a device NOT in the event's profile allowlist does not receive it", async () => {
    const { manager, transport, deviceStore, externalNotificationEvents } = await createFixture();
    await addMobileDevice(deviceStore, { profileAllowlist: ["other-profile"] });

    manager.start();
    externalNotificationEvents.emit("event", makeExternalEvent({ profileId: "default" }));
    await flush();

    expect(transport.getSentEvents(OWN_DEVICE_ID)).toHaveLength(0);
    manager.stop();
  });

  test("a device that muted this event's kind does not receive it", async () => {
    const { manager, transport, deviceStore, externalNotificationEvents } = await createFixture();
    await addMobileDevice(deviceStore, { mutedKinds: ["waiting"] });

    manager.start();
    externalNotificationEvents.emit("event", makeExternalEvent({ kind: "waiting" }));
    await flush();

    expect(transport.getSentEvents(OWN_DEVICE_ID)).toHaveLength(0);
    manager.stop();
  });

  test("a device whose minPriority floor is above the event's priority does not receive it", async () => {
    const { manager, transport, deviceStore, externalNotificationEvents } = await createFixture();
    await addMobileDevice(deviceStore, { minPriority: "high" });

    manager.start();
    externalNotificationEvents.emit("event", makeExternalEvent({ priority: "low" }));
    await flush();

    expect(transport.getSentEvents(OWN_DEVICE_ID)).toHaveLength(0);
    manager.stop();
  });

  test("multiple eligible devices each get their own independently-encrypted copy", async () => {
    const { manager, transport, deviceStore, externalNotificationEvents } = await createFixture();
    const first = await addMobileDevice(deviceStore, { deviceId: "mobile-a" });
    const second = await addMobileDevice(deviceStore, { deviceId: "mobile-b" });

    manager.start();
    externalNotificationEvents.emit("event", makeExternalEvent());
    await flush();

    const sent = transport.getSentEvents(OWN_DEVICE_ID);
    expect(sent.map((e) => e.eventId).sort()).toEqual(["evt-1", "evt-1"].sort());
    manager.stop();
  });

  test("each copy is addressed to exactly one phone, and neither can open the other's", async () => {
    // Review 2 §P0.1's recipient isolation, from the desktop side: one desktop, two phones, one
    // alert. Two separately addressed, separately sealed records — never one broadcast the rules
    // then try to filter, which they cannot do (a `.read` on a parent reaches every child).
    //
    // The v1 shape of this scenario put both copies in one mailbox, distinguished only by an
    // eventId suffix; phone B could read A's record and its metadata even though it could not open
    // the plaintext. Here the assertion is stronger than "the ciphertexts differ": B's own session
    // key is used against A's record, and it must fail.
    const { manager, transport, deviceStore, desktopKeyPair, externalNotificationEvents } = await createFixture();
    const phoneA = await addMobileDevice(deviceStore, { deviceId: "mobile-a" });
    const phoneB = await addMobileDevice(deviceStore, { deviceId: "mobile-b" });

    manager.start();
    externalNotificationEvents.emit("event", makeExternalEvent({ title: "Only for A" }));
    await flush();
    manager.stop();

    const sent = transport.getSentEvents(OWN_DEVICE_ID);
    expect(sent).toHaveLength(2);
    const forA = sent.find((e) => e.targetDeviceId === phoneA.deviceId)!;
    const forB = sent.find((e) => e.targetDeviceId === phoneB.deviceId)!;
    expect(forA).toBeDefined();
    expect(forB).toBeDefined();
    expect(forA.ciphertext).not.toBe(forB.ciphertext);

    const keyA = sessionKeyFor(phoneA.keyPair.privateKey, desktopKeyPair.publicKey);
    const keyB = sessionKeyFor(phoneB.keyPair.privateKey, desktopKeyPair.publicKey);
    const aadFor = (event: (typeof sent)[number]) =>
      buildRoutingAad({
        protocolVersion: event.protocolVersion,
        pairId: event.pairId,
        sourceDeviceId: event.sourceDeviceId,
        targetDeviceId: event.targetDeviceId,
        messageId: event.eventId,
        messageType: "notificationEvent",
        sessionKeyVersion: event.sessionKeyVersion,
        createdAt: event.createdAt,
        expiresAt: event.expiresAt,
      });

    // A opens its own copy.
    expect(openCombinedBase64(forA.ciphertext, keyA, aadFor(forA)).toString("utf8")).toContain("Only for A");
    // B cannot open A's, under either its own key or A's AAD.
    expect(() => openCombinedBase64(forA.ciphertext, keyB, aadFor(forA))).toThrow();
    // And A's ciphertext re-filed under B's address fails too, because the target is in the AAD —
    // so moving a record between mailboxes is not merely a misplacement.
    expect(() =>
      openCombinedBase64(forA.ciphertext, keyA, aadFor({ ...forA, targetDeviceId: forB.targetDeviceId })),
    ).toThrow();
  });

  test("a rotated device key is used immediately, not shadowed by the cached one", async () => {
    // Review 2 §P1 "Key lifecycle a rotace". The session-key cache is keyed by device AND
    // sessionKeyVersion; with only the device id, the first key derived for a device would keep being used
    // for the life of the process, and every message after a rotation would fail its AEAD with
    // nothing naming the cause.
    const { manager, transport, deviceStore, mutateDevices, desktopKeyPair, externalNotificationEvents } =
      await createFixture();
    const { deviceId, keyPair } = await addMobileDevice(deviceStore);

    manager.start();
    externalNotificationEvents.emit("event", makeExternalEvent());
    await flush();
    expect(transport.getSentEvents(OWN_DEVICE_ID)).toHaveLength(1);

    // The device record's key moves to a new generation.
    const rotated = generateX25519KeyPair();
    await mutateDevices((devices) =>
      devices.map((d) =>
        d.deviceId === deviceId
          ? { ...d, publicKey: exportRawPublicKey(rotated.publicKey).toString("base64"), sessionKeyVersion: 2 }
          : d,
      ),
    );

    externalNotificationEvents.emit("event", makeExternalEvent({ eventId: "evt-2", dedupeKey: "d2" }));
    await flush();
    manager.stop();

    const second = transport.getSentEvents(OWN_DEVICE_ID).at(-1)!;
    expect(second.sessionKeyVersion).toBe(2);
    const aad = buildRoutingAad({
      protocolVersion: second.protocolVersion,
      pairId: second.pairId,
      sourceDeviceId: second.sourceDeviceId,
      targetDeviceId: second.targetDeviceId,
      messageId: second.eventId,
      messageType: "notificationEvent",
      sessionKeyVersion: second.sessionKeyVersion,
      createdAt: second.createdAt,
      expiresAt: second.expiresAt,
    });
    // Opens under the NEW key…
    expect(() =>
      openCombinedBase64(second.ciphertext, sessionKeyFor(rotated.privateKey, desktopKeyPair.publicKey), aad),
    ).not.toThrow();
    // …and not under the old one.
    expect(() =>
      openCombinedBase64(second.ciphertext, sessionKeyFor(keyPair.privateKey, desktopKeyPair.publicKey), aad),
    ).toThrow();
  });
});

describe("MobileManager lifecycle", () => {
  test("stop() detaches the external-notification listener — no event is sent after stop", async () => {
    const { manager, transport, deviceStore, externalNotificationEvents } = await createFixture();
    await addMobileDevice(deviceStore);

    manager.start();
    manager.stop();
    externalNotificationEvents.emit("event", {
      eventId: "evt-after-stop",
      profileId: "default",
      workspaceId: "ws-1",
      sessionId: null,
      panelId: null,
      kind: "waiting",
      priority: "high",
      title: "x",
      detail: "",
      dedupeKey: "k",
      collapseKey: null,
      createdAt: 1000,
      actions: [],
    } satisfies ExternalNotificationEvent);
    await flush();

    expect(transport.getSentEvents(OWN_DEVICE_ID)).toHaveLength(0);
  });

  test("calling start() twice does not double-register the external-notification listener", async () => {
    const { manager, deviceStore, externalNotificationEvents, transport } = await createFixture();
    await addMobileDevice(deviceStore, { profileAllowlist: ["default"] });

    manager.start();
    manager.start();
    expect(externalNotificationEvents.listenerCount("event")).toBe(1);

    externalNotificationEvents.emit("event", {
      eventId: "evt-once",
      profileId: "default",
      workspaceId: "ws-1",
      sessionId: null,
      panelId: null,
      kind: "waiting",
      priority: "high",
      title: "x",
      detail: "",
      dedupeKey: "k",
      collapseKey: null,
      createdAt: 1000,
      actions: [],
    } satisfies ExternalNotificationEvent);
    await flush();
    expect(transport.getSentEvents(OWN_DEVICE_ID)).toHaveLength(1);
    manager.stop();
  });
});

describe("MobileManager.revokeDevice", () => {
  test("revoking a device stops it from receiving further events and its commands are rejected", async () => {
    const { manager, transport, deviceStore, desktopKeyPair, runtime, externalNotificationEvents } =
      await createFixture();
    const { deviceId, keyPair } = await addMobileDevice(deviceStore);
    const sessionKey = sessionKeyFor(keyPair.privateKey, desktopKeyPair.publicKey);

    manager.start();
    await manager.revokeDevice(deviceId);

    externalNotificationEvents.emit("event", {
      eventId: "evt-1",
      profileId: "default",
      workspaceId: "ws-1",
      sessionId: null,
      panelId: null,
      kind: "waiting",
      priority: "high",
      title: "x",
      detail: "",
      dedupeKey: "k",
      collapseKey: null,
      createdAt: 1000,
      actions: [],
    } satisfies ExternalNotificationEvent);
    await flush();
    expect(transport.getSentEvents(OWN_DEVICE_ID)).toHaveLength(0);

    const envelope = buildCommandEnvelope({
      messageId: "msg-1",
      senderDeviceId: deviceId,
      sessionKey,
      command: makePauseCommand(),
    });
    transport.pushCommandEnvelope(OWN_DEVICE_ID, envelope);
    await flush();
    expect(runtime.calls).not.toContain("pauseTask:ws-1");

    manager.stop();
  });

  test("mobile:device-revoked event carries only the deviceId — no secret/key material", async () => {
    const { manager, deviceStore } = await createFixture();
    const { deviceId } = await addMobileDevice(deviceStore);
    const spy = vi.fn();
    manager.on("mobile:device-revoked", spy);
    await manager.revokeDevice(deviceId);
    expect(spy).toHaveBeenCalledWith({ deviceId });
  });

  test("revoking a device invalidates its outstanding WebView session ticket and closes its remote sessions", async () => {
    const { manager, deviceStore, ticketStore, revokeRemoteSessions } = await createFixture();
    const { deviceId } = await addMobileDevice(deviceStore);

    const issued = ticketStore.issueTicket({
      deviceId,
      pairId: OWN_DEVICE_ID,
      profileId: "default",
      allowedOrigin: "https://example.trycloudflare.com",
      transport: "legacy",
    });

    await manager.revokeDevice(deviceId);

    expect(ticketStore.consumeTicket(issued.ticketId, issued.secret, TICKET_CONTEXT)).toBeNull();
    expect(revokeRemoteSessions).toHaveBeenCalledWith(deviceId);
  });

  test("revoking a device withdraws its relay e2e keys and ends its e2e streams (E2E 3.8)", async () => {
    const { manager, deviceStore, revokeRelayE2eSession } = await createFixture();
    const { deviceId } = await addMobileDevice(deviceStore);
    await manager.revokeDevice(deviceId);
    expect(revokeRelayE2eSession).toHaveBeenCalledTimes(1);
    expect(revokeRelayE2eSession).toHaveBeenCalledWith(deviceId);
  });

  test("a revoke discovered by the authoritative re-read runs the WHOLE local cleanup", async () => {
    // Plan §3.9. The command path re-reads the cloud record immediately before it claims, because a
    // desktop that was offline when the phone unpaired has a stale local copy. That path used to stop
    // after the store transition and the key eviction — so the revoke it discovered left an
    // outstanding WebView ticket redeemable and a live remote session open, which are two of the
    // three things a revoke exists to end. All four paths into `revoked` now share one sequence.
    const { manager, deviceStore, transport, ticketStore, revokeRemoteSessions, runtime, desktopKeyPair } =
      await createFixture();
    const { deviceId, keyPair } = await addMobileDevice(deviceStore);
    const sessionKey = sessionKeyFor(keyPair.privateKey, desktopKeyPair.publicKey);
    manager.start();

    const issued = ticketStore.issueTicket({
      deviceId,
      pairId: OWN_DEVICE_ID,
      profileId: "default",
      allowedOrigin: "https://example.trycloudflare.com",
      transport: "legacy",
    });

    // The cloud says revoked; the local record still says active, exactly as it would after an
    // offline unpair. Nothing has told this desktop yet — the re-read is what finds out.
    const local = deviceStore.getDevice(deviceId)!;
    transport.setRemoteDevice(OWN_DEVICE_ID, {
      deviceId,
      pairId: OWN_DEVICE_ID,
      uid: local.uid,
      pairingId: local.pairingId,
      platform: local.platform,
      label: local.label,
      publicKey: local.publicKey,
      sessionKeyVersion: local.sessionKeyVersion,
      capabilities: local.capabilities,
      profileAllowlist: local.profileAllowlist,
      createdAt: local.createdAt,
      lastSeenAt: local.lastSeenAt,
      state: "revoked",
      revoked: true,
    } as never);

    const envelope = buildCommandEnvelope({
      messageId: "msg-revoked-reread",
      senderDeviceId: deviceId,
      sessionKey,
      command: makePauseCommand({ commandId: "msg-revoked-reread" }),
    });
    transport.pushCommandEnvelope(OWN_DEVICE_ID, envelope);
    await flush();

    // The command did not run…
    expect(runtime.calls).not.toContain("pauseTask:ws-1");
    // …and the local record, the ticket and the live sessions were all dealt with.
    expect(deviceStore.getDevice(deviceId)?.revoked).toBe(true);
    expect(ticketStore.consumeTicket(issued.ticketId, issued.secret, TICKET_CONTEXT)).toBeNull();
    expect(revokeRemoteSessions).toHaveBeenCalledWith(deviceId);

    manager.stop();
  });

  test("a cloud-pushed revoke runs the same cleanup as a local one", async () => {
    const { manager, deviceStore, transport, ticketStore, revokeRemoteSessions } = await createFixture();
    const { deviceId } = await addMobileDevice(deviceStore);
    manager.start();

    const issued = ticketStore.issueTicket({
      deviceId,
      pairId: OWN_DEVICE_ID,
      profileId: "default",
      allowedOrigin: "https://example.trycloudflare.com",
      transport: "legacy",
    });

    transport.simulateDeviceUpdate(OWN_DEVICE_ID, {
      deviceId,
      pairId: OWN_DEVICE_ID,
      revoked: true,
      state: "revoked",
    } as never);
    await flush();

    expect(deviceStore.getDevice(deviceId)?.revoked).toBe(true);
    expect(ticketStore.consumeTicket(issued.ticketId, issued.secret, TICKET_CONTEXT)).toBeNull();
    expect(revokeRemoteSessions).toHaveBeenCalledWith(deviceId);

    manager.stop();
  });

  test("revoking a device does not affect another device's outstanding ticket", async () => {
    const { manager, deviceStore, ticketStore } = await createFixture();
    const { deviceId } = await addMobileDevice(deviceStore, { deviceId: "mobile-1" });
    await addMobileDevice(deviceStore, { deviceId: "mobile-2" });

    const issuedForOther = ticketStore.issueTicket({
      deviceId: "mobile-2",
      pairId: OWN_DEVICE_ID,
      profileId: "default",
      allowedOrigin: "https://example.trycloudflare.com",
      transport: "legacy",
    });

    await manager.revokeDevice(deviceId);

    expect(ticketStore.consumeTicket(issuedForOther.ticketId, issuedForOther.secret, TICKET_CONTEXT)).not.toBeNull();
  });
});

describe("a revoke made offline still reaches the cloud (the other side finishes it on reconnect)", () => {
  test.each(["NOT_FOUND", "not-found"])("an absent cloud device completes revocation (%s)", async (status) => {
    const { manager, transport, deviceStore } = await createFixture();
    const { deviceId } = await addMobileDevice(deviceStore);
    transport.revokeDevice = async () => {
      throw new MobileFirebaseCallableError("revokeDevice", status);
    };
    await manager.revokeDevice(deviceId);
    expect(deviceStore.getDevice(deviceId)?.pendingCloudRevoke).toBeUndefined();
    expect(await manager.removeRevokedDevice(deviceId)).toEqual({ ok: true });
  });

  // WHAT THIS IS THE REGRESSION FOR. `revokeDevice` used to call the transport ONCE and swallow the
  // failure into a `log.warn`. A desktop that was offline when the user revoked a phone therefore
  // left the cloud record `active` for ever: the phone never learned it had been unpaired, kept its
  // pair membership, its push token and its mailbox, and nothing anywhere would ever reconcile the
  // two sides. The phone half of exactly this was fixed in review 3 §P0.3 — this is its mirror.

  /** Makes the transport refuse the cloud half, the way being offline does. */
  function breakCloudRevoke(transport: ReturnType<typeof createInMemoryMobileFirebaseTransport>): () => void {
    const realRevoke = transport.revokeDevice.bind(transport);
    const realReject = transport.rejectPairing.bind(transport);
    transport.revokeDevice = async () => {
      throw new Error("offline");
    };
    transport.rejectPairing = async () => {
      throw new Error("offline");
    };
    return () => {
      transport.revokeDevice = realRevoke;
      transport.rejectPairing = realReject;
    };
  }

  test("the local revoke still lands, and the cloud half is kept rather than lost", async () => {
    const { manager, transport, deviceStore } = await createFixture();
    const { deviceId } = await addMobileDevice(deviceStore);
    const restore = breakCloudRevoke(transport);

    await manager.revokeDevice(deviceId);

    // Local: unusable here, immediately and whatever the network did. That half never depended on it.
    expect(deviceStore.getDevice(deviceId)?.revoked).toBe(true);
    // Cloud: owed, durably, with the attempt counted and labelled for whoever reads the state later.
    const pending = deviceStore.getDevice(deviceId)?.pendingCloudRevoke;
    expect(pending).toBeDefined();
    expect(pending?.kind).toBe("revoke");
    expect(pending?.attempts).toBe(1);
    expect(pending?.lastErrorCode).toBeTruthy();

    restore();
  });

  test("reconnecting sends everything that was owed, and clears it", async () => {
    const { manager, transport, deviceStore, ownDeviceId } = await createFixture();
    const { deviceId } = await addMobileDevice(deviceStore);
    const restore = breakCloudRevoke(transport);
    await manager.revokeDevice(deviceId);
    expect(transport.getPairingCalls().filter((c) => c.call === "revokeDevice")).toHaveLength(0);

    restore();
    const flushed = await manager.flushPendingCloudRevocations();

    expect(flushed).toEqual({ sent: 1, owed: 0 });
    expect(deviceStore.getDevice(deviceId)?.pendingCloudRevoke).toBeUndefined();
    const calls = transport.getPairingCalls();
    expect(calls.some((c) => c.call === "revokeDevice" && c.deviceId === deviceId && c.pairId === ownDeviceId)).toBe(
      true,
    );
  });

  test("a rejection made offline is kept too — the human said no, and it must not read as a timeout", async () => {
    const { manager, transport, deviceStore } = await createFixture();
    const { deviceId } = await addMobileDevice(deviceStore);
    const restore = breakCloudRevoke(transport);

    await manager.rejectDevice(deviceId, "sas-mismatch");
    expect(deviceStore.getDevice(deviceId)?.pendingCloudRevoke?.kind).toBe("reject");

    restore();
    await manager.flushPendingCloudRevocations();
    expect(deviceStore.getDevice(deviceId)?.pendingCloudRevoke).toBeUndefined();
    expect(transport.getPairingCalls().some((c) => c.call === "rejectPairing")).toBe(true);
  });

  test("nothing gives up: repeated failures keep counting, and never drop the entry", async () => {
    const { manager, deviceStore, transport } = await createFixture();
    const { deviceId } = await addMobileDevice(deviceStore);
    const restore = breakCloudRevoke(transport);

    await manager.revokeDevice(deviceId);
    for (let i = 0; i < 5; i += 1) await manager.flushPendingCloudRevocations();

    expect(deviceStore.getDevice(deviceId)?.pendingCloudRevoke?.attempts).toBe(6);
    restore();
  });

  test("a second revoke of the same device does not reset the record of how long it has been owed", async () => {
    const { manager, deviceStore, transport } = await createFixture();
    const { deviceId } = await addMobileDevice(deviceStore);
    const restore = breakCloudRevoke(transport);

    await manager.revokeDevice(deviceId);
    const first = deviceStore.getDevice(deviceId)?.pendingCloudRevoke?.requestedAt;
    await manager.revokeDevice(deviceId);

    expect(deviceStore.getDevice(deviceId)?.pendingCloudRevoke?.requestedAt).toBe(first);
    expect(deviceStore.getDevice(deviceId)?.pendingCloudRevoke?.attempts).toBe(2);
    restore();
  });

  test("the audit log says FAILURE while the cloud has not been told, and success once it has", async () => {
    // The old line was written after the try/catch unconditionally: `status: "success"` even when the
    // transport had just thrown, in the one place somebody debugging "why is my phone still paired"
    // looks first.
    const { manager, deviceStore, transport, auditLogStore } = await createFixture();
    const { deviceId } = await addMobileDevice(deviceStore);
    const restore = breakCloudRevoke(transport);

    await manager.revokeDevice(deviceId);
    const failed = auditLogStore.query({ action: "device.revoked" }).entries;
    expect(failed).toHaveLength(1);
    expect(failed[0]?.status).toBe("failure");
    expect(String(failed[0]?.detail)).toContain("cloud pending");

    restore();
    await manager.flushPendingCloudRevocations();
    const synced = auditLogStore.query({ action: "device.revoked" }).entries;
    expect(synced.some((e) => e.status === "success")).toBe(true);
  });
});

describe("MobileManager.removeRevokedDevice (clearing the list)", () => {
  test("a revoked device is forgotten, and the audit log records that it was", async () => {
    const { manager, deviceStore, auditLogStore } = await createFixture();
    const { deviceId } = await addMobileDevice(deviceStore);
    await manager.revokeDevice(deviceId);

    expect(await manager.removeRevokedDevice(deviceId)).toEqual({ ok: true });

    expect(deviceStore.getDevice(deviceId)).toBeNull();
    const forgotten = auditLogStore.query({ action: "device.forgotten" }).entries;
    expect(forgotten).toHaveLength(1);
    expect(forgotten[0]?.status).toBe("success");
  });

  test("an active device is refused — this is housekeeping, not a way to drop a live pairing", async () => {
    const { manager, deviceStore } = await createFixture();
    const { deviceId } = await addMobileDevice(deviceStore);

    expect(await manager.removeRevokedDevice(deviceId)).toEqual({ ok: false, reason: "not-revoked" });
    expect(deviceStore.getDevice(deviceId)).not.toBeNull();
  });

  test("a device whose cloud revocation is still owed is refused, then allowed once it is sent", async () => {
    // Deleting the record would take the outbox entry with it, and the cloud would never be told.
    const { manager, deviceStore, transport } = await createFixture();
    const { deviceId } = await addMobileDevice(deviceStore);
    const realRevoke = transport.revokeDevice.bind(transport);
    transport.revokeDevice = async () => {
      throw new Error("offline");
    };
    await manager.revokeDevice(deviceId);

    expect(await manager.removeRevokedDevice(deviceId)).toEqual({ ok: false, reason: "cloud-revoke-pending" });

    transport.revokeDevice = realRevoke;
    await manager.flushPendingCloudRevocations();
    expect(await manager.removeRevokedDevice(deviceId)).toEqual({ ok: true });
    expect(deviceStore.getDevice(deviceId)).toBeNull();
  });

  test("a forgotten device is refused exactly as a revoked one was", async () => {
    // The point of the whole change: `isDeviceUsable(null)` and `isDeviceUsable(revoked)` are the
    // same answer, so removing the row gives nothing back to the phone.
    const { manager, transport, deviceStore, desktopKeyPair, runtime } = await createFixture();
    const { deviceId, keyPair } = await addMobileDevice(deviceStore);
    const sessionKey = sessionKeyFor(keyPair.privateKey, desktopKeyPair.publicKey);
    manager.start();
    await manager.revokeDevice(deviceId);
    await manager.removeRevokedDevice(deviceId);

    transport.pushCommandEnvelope(
      OWN_DEVICE_ID,
      buildCommandEnvelope({
        messageId: "msg-forgotten",
        senderDeviceId: deviceId,
        sessionKey,
        command: makePauseCommand(),
      }),
    );
    await flush();
    expect(runtime.calls).not.toContain("pauseTask:ws-1");

    manager.stop();
  });
});

describe("mobile:* runtime events never carry secrets", () => {
  test("mobile:pairing-progress on a successful claim carries status/deviceId/label and the SAS, nothing else", async () => {
    const { manager, transport } = await createFixture();
    const spy = vi.fn();
    manager.on("mobile:pairing-progress", spy);

    const qr = await manager.createInvitation({ profileAllowlist: ["default"], capabilities: ["task.control"] });
    const claimKeyPair = generateX25519KeyPair();
    transport.simulateClaim(
      OWN_DEVICE_ID,
      makeCloudDevice({
        deviceId: "mobile-x",
        uid: "uid-x",
        pairId: OWN_DEVICE_ID,
        pairingId: qr.pairingId,
        state: "claimed",
        keyProvenAt: null,
        activatedAt: null,
        // The commitment the server would have written for the grants this invitation approved. The
        // desktop recomputes it and refuses a mismatch (review 3 §P0.1), so a fixture that omitted it
        // would be rejected before the event under test is ever emitted.
        grantCommitment: computeGrantCommitment({
          protocolVersion: PROTOCOL_VERSION,
          pairId: OWN_DEVICE_ID,
          pairingId: qr.pairingId,
          mobileDeviceId: "mobile-x",
          capabilities: ["task.control"],
          profileAllowlist: ["default"],
        }),
        label: "Pixel",
        publicKey: exportRawPublicKey(claimKeyPair.publicKey).toString("base64"),
        capabilities: ["task.control"],
        profileAllowlist: ["default"],
        createdAt: 1000,
        lastSeenAt: 1000,
      }),
    );
    await flush();

    // `awaiting-approval`, not `claimed` (review 3 §P0.1): the event now ASKS for a decision rather
    // than reporting a finished pairing, and it carries the invitation the decision applies to so the
    // renderer can name it back when the user answers.
    expect(spy).toHaveBeenCalledWith({
      status: "awaiting-approval",
      deviceId: "mobile-x",
      label: "Pixel",
      sasReady: true,
      pairingId: qr.pairingId,
    });
    expect(qr.pairingId).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Plan §10.5: desktop Settings → Mobile management methods added on top of
// the existing lifecycle/outbox/inbox behavior above.
// ---------------------------------------------------------------------------

describe("MobileManager.listDevices / renameDevice / updateDeviceAllowlist", () => {
  test("listDevices returns both active and revoked devices", async () => {
    const { manager, deviceStore } = await createFixture();
    const { deviceId: activeId } = await addMobileDevice(deviceStore, { deviceId: "mobile-active" });
    const { deviceId: revokedId } = await addMobileDevice(deviceStore, { deviceId: "mobile-revoked" });
    await manager.revokeDevice(revokedId);

    const devices = manager.listDevices();
    expect(devices.map((d) => d.deviceId).sort()).toEqual([activeId, revokedId].sort());
    expect(devices.find((d) => d.deviceId === revokedId)?.revoked).toBe(true);
    expect(devices.find((d) => d.deviceId === activeId)?.revoked).toBe(false);
  });

  test("renameDevice updates the device's label and logs an audit entry", async () => {
    const { manager, deviceStore, auditLogStore } = await createFixture();
    const { deviceId } = await addMobileDevice(deviceStore);

    await manager.renameDevice(deviceId, "My Pixel");

    expect(manager.listDevices().find((d) => d.deviceId === deviceId)?.label).toBe("My Pixel");
    const { entries } = auditLogStore.query({ deviceId, action: "device.renamed" });
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe("success");
  });

  test("updateDeviceAllowlist updates capabilities/profileAllowlist and logs an audit entry", async () => {
    const { manager, deviceStore, auditLogStore } = await createFixture();
    const { deviceId } = await addMobileDevice(deviceStore, {
      capabilities: ["task.control"],
      profileAllowlist: ["default"],
    });

    await manager.updateDeviceAllowlist(deviceId, {
      capabilities: ["remote.request"],
      profileAllowlist: ["default", "other"],
    });

    const updated = manager.listDevices().find((d) => d.deviceId === deviceId);
    expect(updated?.capabilities).toEqual(["remote.request"]);
    expect(updated?.profileAllowlist).toEqual(["default", "other"]);
    const { entries } = auditLogStore.query({ deviceId, action: "device.allowlist-updated" });
    expect(entries).toHaveLength(1);
  });
});

describe("MobileManager connection health (plan §10.5 'refresh connection health')", () => {
  test("getConnectionHealth reflects running/connectionState/deviceCount/pendingInvitation before start()", async () => {
    const { manager, deviceStore } = await createFixture();
    await addMobileDevice(deviceStore);

    expect(manager.getConnectionHealth()).toEqual({
      running: false,
      connectionState: "disconnected",
      lastError: null,
      deviceCount: 1,
      pendingInvitation: null,
      pairAuthorization: "unknown",
    });
  });

  test("deviceCount counts only active (non-revoked) devices", async () => {
    const { manager, deviceStore } = await createFixture();
    const { deviceId: a } = await addMobileDevice(deviceStore, { deviceId: "mobile-a" });
    await addMobileDevice(deviceStore, { deviceId: "mobile-b" });
    await manager.revokeDevice(a);

    expect(manager.getConnectionHealth().deviceCount).toBe(1);
  });

  test("start() reports connected even when the transport was already connected beforehand (no state-change event fires in that case)", async () => {
    const { manager } = await createFixture(); // createFixture's transport.connect() already ran once
    manager.start();
    await flush();

    expect(manager.getConnectionHealth().connectionState).toBe("connected");
    manager.stop();
  });

  test("stop() reports disconnected immediately without waiting on transport.disconnect() to settle", async () => {
    const { manager } = await createFixture();
    manager.start();
    await flush();

    manager.stop();

    expect(manager.getConnectionHealth()).toMatchObject({ running: false, connectionState: "disconnected" });
  });

  test("getConnectionHealth reports the pending invitation while one is active, and clears it on cancel", async () => {
    const { manager } = await createFixture();
    const qr = await manager.createInvitation({ profileAllowlist: ["default"], capabilities: ["task.control"] });

    expect(manager.getConnectionHealth().pendingInvitation).toEqual({
      pairingId: qr.pairingId,
      expiresAt: qr.expiresAt,
      // The grants the human ticked travel with the pending invitation now, because they are what a
      // claim's grant commitment is checked against (review 3 §P0.1) — a caller that has to know what
      // this code authorizes must not have to guess. Still no secret: not the invitation secret, and
      // not the key-proof challenge.
      capabilities: ["task.control"],
      profileAllowlist: ["default"],
    });

    await manager.cancelInvitation();
    expect(manager.getConnectionHealth().pendingInvitation).toBeNull();
  });

  test("refreshConnectionHealth attempts a reconnect when running-but-disconnected, and clears lastError on success", async () => {
    const { manager, transport } = await createFixture();
    manager.start();
    await flush();
    transport.simulateDisconnect();
    expect(manager.getConnectionHealth().connectionState).toBe("disconnected");

    const health = await manager.refreshConnectionHealth();

    expect(health.connectionState).toBe("connected");
    expect(health.lastError).toBeNull();
    manager.stop();
  });

  test("refreshConnectionHealth surfaces a reconnect failure as a fixed code, not the error's text", async () => {
    // Review 2 §"Logy a diagnostika": `lastError` is both logged and handed to the renderer, so it
    // carries a structured reason code rather than whatever the transport said. `boom` here stands
    // in for undici's own message, which for this client can embed the request URL — and RTDB URLs
    // carry the caller's Firebase ID token as `?auth=`.
    const { manager, transport } = await createFixture();
    manager.start();
    await flush();
    transport.simulateDisconnect();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (transport as any).connect = vi.fn(async () => {
      throw new Error("boom https://db.example/v2/pairs.json?auth=eyJhbGciOiJIUzI1NiJ9.e30.sig");
    });

    const health = await manager.refreshConnectionHealth();

    expect(health.connectionState).toBe("disconnected");
    expect(health.lastError).toBe("Error");
    expect(health.lastError).not.toContain("auth=");
    manager.stop();
  });

  test("a quota rejection and a callable refusal get distinguishable codes", async () => {
    // The trade the code-only rule makes is only affordable because the codes still separate the
    // cases an operator acts on differently — otherwise every failure would read "Error".
    const { manager, transport } = await createFixture();
    manager.start();
    await flush();
    transport.simulateDisconnect();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (transport as any).connect = vi.fn(async () => {
      throw new MobileQuotaExceededError();
    });
    expect((await manager.refreshConnectionHealth()).lastError).toBe("quota-exceeded");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (transport as any).connect = vi.fn(async () => {
      throw new MobileFirebaseCallableError("enqueueCommand", "permission-denied");
    });
    expect((await manager.refreshConnectionHealth()).lastError).toBe("callable:enqueueCommand:permission-denied");
    manager.stop();
  });
});

describe("MobileManager.getQuotaSnapshot (local approximation — see doc comment)", () => {
  test("counts successful event.sent audit entries since the start of the current UTC day, and reports the fixed limits/reset time", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.UTC(2026, 0, 15, 10, 30, 0));
      const { manager, deviceStore, externalNotificationEvents } = await createFixture();
      await addMobileDevice(deviceStore, { deviceId: "mobile-1" });

      manager.start();
      externalNotificationEvents.emit("event", {
        eventId: "evt-quota-1",
        profileId: "default",
        workspaceId: "ws-1",
        sessionId: null,
        panelId: null,
        kind: "waiting",
        priority: "high",
        title: "x",
        detail: "",
        dedupeKey: "k",
        collapseKey: null,
        createdAt: Date.now(),
        actions: [],
      } satisfies ExternalNotificationEvent);
      await flush();
      manager.stop();

      const quota = manager.getQuotaSnapshot();
      expect(quota.used).toBe(1);
      expect(quota.limit).toBe(MAX_PUSH_EVENTS_PER_PAIR_PER_UTC_DAY);
      expect(quota.reservedHighPriorityRemaining).toBe(RESERVED_HIGH_PRIORITY_DAILY_PUSH_SLOTS);
      expect(quota.resetAt).toBe(Date.UTC(2026, 0, 16, 0, 0, 0));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("MobileManager.queryAuditLog", () => {
  test("delegates to the underlying audit log store with the given filters", async () => {
    const { manager, deviceStore } = await createFixture();
    const { deviceId } = await addMobileDevice(deviceStore);
    await manager.renameDevice(deviceId, "Renamed");

    const { entries, total } = manager.queryAuditLog({ deviceId, action: "device.renamed" });
    expect(total).toBe(1);
    expect(entries[0]).toMatchObject({ deviceId, action: "device.renamed", status: "success" });
  });
});

describe("MobileManager.sendTestPush", () => {
  test("sends a test push through the same outbox path, visibly flagged in the decrypted plaintext, and counts toward the quota", async () => {
    const { manager, transport, deviceStore, desktopKeyPair } = await createFixture();
    const { deviceId, keyPair } = await addMobileDevice(deviceStore);

    const result = await manager.sendTestPush(deviceId);

    expect(result).toEqual({ ok: true });
    const sent = transport.getSentEvents(OWN_DEVICE_ID);
    expect(sent).toHaveLength(1);

    const sessionKey = sessionKeyFor(keyPair.privateKey, desktopKeyPair.publicKey);
    const aad = Buffer.from(sent[0].aad, "base64");
    const plaintext = JSON.parse(openCombinedBase64(sent[0].ciphertext, sessionKey, aad).toString("utf8"));
    expect(plaintext.isTest).toBe(true);
    expect(String(plaintext.title)).toContain("test");

    // Same audit action ("event.sent") a real push uses — so it counts toward
    // the exact same quota approximation getQuotaSnapshot() computes.
    expect(manager.getQuotaSnapshot().used).toBe(1);
  });

  test("rejects a nonexistent device cleanly, without throwing", async () => {
    const { manager } = await createFixture();
    const result = await manager.sendTestPush("no-such-device");
    expect(result).toEqual({ ok: false, reason: "device-not-found" });
  });

  test("rejects a revoked device cleanly, without throwing", async () => {
    const { manager, deviceStore } = await createFixture();
    const { deviceId } = await addMobileDevice(deviceStore);
    await manager.revokeDevice(deviceId);

    const result = await manager.sendTestPush(deviceId);
    expect(result).toEqual({ ok: false, reason: "device-not-found" });
  });
});

// ---------------------------------------------------------------------------
// Plan §7/§10.7: quota-exceeded pushes must never raise a per-event desktop
// notification. Only the FIRST suppression of a given UTC day emits one
// `mobile:status` summary; later suppressions the same day only bump the
// audit-logged/suppressedToday count. Telegram/other channels for the same
// underlying alert are unaffected — proven separately in runtime.test.ts's
// "ExternalNotificationEvent — Mobile listener does not affect Telegram"
// describe block, since that's where Telegram forwarding actually happens.
// ---------------------------------------------------------------------------
describe("MobileManager push-limit summary (plan §7/§10.7)", () => {
  function makeQuotaEvent(overrides: Partial<ExternalNotificationEvent> = {}): ExternalNotificationEvent {
    return {
      eventId: "evt-quota",
      profileId: "default",
      workspaceId: "ws-1",
      sessionId: null,
      panelId: null,
      kind: "waiting",
      priority: "high",
      title: "x",
      detail: "",
      dedupeKey: "k",
      collapseKey: null,
      createdAt: Date.now(),
      actions: [],
      ...overrides,
    };
  }

  test("the first quota-exceeded suppression of a UTC day emits exactly one mobile:status summary, and the event is not sent", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.UTC(2026, 0, 15, 10, 0, 0));
      const { manager, transport, deviceStore, externalNotificationEvents } = await createFixture();
      await addMobileDevice(deviceStore, { deviceId: "mobile-1" });
      transport.setQuotaExceeded(OWN_DEVICE_ID, true);

      const statusSpy = vi.fn();
      manager.on("mobile:status", statusSpy);
      manager.start();
      externalNotificationEvents.emit("event", makeQuotaEvent());
      await flush();
      manager.stop();

      expect(transport.getSentEvents(OWN_DEVICE_ID)).toHaveLength(0);
      const limitCalls = statusSpy.mock.calls.filter(
        ([payload]) => (payload as { pushLimitReached?: boolean })?.pushLimitReached,
      );
      expect(limitCalls).toHaveLength(1);
      expect(limitCalls[0][0]).toMatchObject({
        pushLimitReached: true,
        suppressedCount: 1,
        resetAt: Date.UTC(2026, 0, 16, 0, 0, 0),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test("a second and third suppression on the same UTC day do not emit another summary", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.UTC(2026, 0, 15, 10, 0, 0));
      const { manager, transport, deviceStore, externalNotificationEvents } = await createFixture();
      await addMobileDevice(deviceStore, { deviceId: "mobile-1" });
      transport.setQuotaExceeded(OWN_DEVICE_ID, true);

      const statusSpy = vi.fn();
      manager.on("mobile:status", statusSpy);
      manager.start();
      externalNotificationEvents.emit("event", makeQuotaEvent({ eventId: "evt-1" }));
      await flush();
      externalNotificationEvents.emit("event", makeQuotaEvent({ eventId: "evt-2" }));
      await flush();
      externalNotificationEvents.emit("event", makeQuotaEvent({ eventId: "evt-3" }));
      await flush();
      manager.stop();

      const limitCalls = statusSpy.mock.calls.filter(
        ([payload]) => (payload as { pushLimitReached?: boolean })?.pushLimitReached,
      );
      expect(limitCalls).toHaveLength(1);
      expect(manager.getQuotaSnapshot().suppressedToday).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  test("crossing into a new UTC day allows exactly one more summary", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.UTC(2026, 0, 15, 23, 59, 0));
      const { manager, transport, deviceStore, externalNotificationEvents } = await createFixture();
      await addMobileDevice(deviceStore, { deviceId: "mobile-1" });
      transport.setQuotaExceeded(OWN_DEVICE_ID, true);

      const statusSpy = vi.fn();
      manager.on("mobile:status", statusSpy);
      manager.start();
      externalNotificationEvents.emit("event", makeQuotaEvent({ eventId: "evt-day1" }));
      await flush();

      vi.setSystemTime(Date.UTC(2026, 0, 16, 0, 5, 0));
      externalNotificationEvents.emit("event", makeQuotaEvent({ eventId: "evt-day2" }));
      await flush();
      manager.stop();

      const limitCalls = statusSpy.mock.calls.filter(
        ([payload]) => (payload as { pushLimitReached?: boolean })?.pushLimitReached,
      );
      expect(limitCalls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test("getQuotaSnapshot().suppressedToday reflects suppressed pushes without counting toward used", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.UTC(2026, 0, 15, 10, 0, 0));
      const { manager, transport, deviceStore, externalNotificationEvents } = await createFixture();
      await addMobileDevice(deviceStore, { deviceId: "mobile-1" });
      transport.setQuotaExceeded(OWN_DEVICE_ID, true);

      manager.start();
      externalNotificationEvents.emit("event", makeQuotaEvent({ eventId: "evt-1" }));
      await flush();
      externalNotificationEvents.emit("event", makeQuotaEvent({ eventId: "evt-2" }));
      await flush();
      manager.stop();

      const quota = manager.getQuotaSnapshot();
      expect(quota.suppressedToday).toBe(2);
      expect(quota.used).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Multiwindow and multi-computer semantics (review 2 §"Multiwindow a více počítačů")
// ---------------------------------------------------------------------------
//
// The review asks for these to be explicit rather than incidental. The claim under test is that
// the security principal is the desktop INSTALLATION — one data dir, one credential store, one
// device id, one X25519 keypair, one MobileManager — and that a BrowserWindow is not a principal
// at all. Windows never reach this layer: they are renderers that talk to the runtime over IPC,
// and the runtime constructs exactly one manager. So the observable property here is that the
// number of *subscribers* to the manager's events has no effect on how many times anything is sent
// or executed, and that two managers with different identities are two independent desktops that
// cannot act for one another.
//
// The installation-identity half (same data dir -> same device id and private key across restarts
// and processes) is asserted in runtime.test.ts, where the credential store actually lives.
describe("multiwindow and multi-computer semantics (review 2)", () => {
  test("extra event subscribers do not multiply a command's side effect or its result", async () => {
    // Matrix item 1: two windows, one runtime. Each window subscribes to `mobile:*` for its status
    // UI; if that subscription were what drove delivery, a second window would double every side
    // effect. It is not — the manager owns the inbox and the windows only observe.
    const fixture = await createFixture();
    const { deviceId, keyPair } = await addMobileDevice(fixture.deviceStore);
    const sessionKey = sessionKeyFor(keyPair.privateKey, fixture.desktopKeyPair.publicKey);
    fixture.manager.on("mobile:status", () => {});
    fixture.manager.on("mobile:status", () => {});
    fixture.manager.start();

    fixture.transport.pushCommandEnvelope(
      OWN_DEVICE_ID,
      buildCommandEnvelope({
        messageId: "cmd-two-windows",
        senderDeviceId: deviceId,
        sessionKey,
        command: makePauseCommand(),
      }),
    );
    await flush();

    expect(fixture.runtime.calls.filter((call) => call === "pauseTask:ws-1")).toHaveLength(1);
    expect(fixture.transport.getSentResultEnvelopes(OWN_DEVICE_ID)).toHaveLength(1);
    fixture.manager.stop();
  });

  test("extra event subscribers do not duplicate an outbound notification either", async () => {
    const fixture = await createFixture();
    await addMobileDevice(fixture.deviceStore, { deviceId: "mobile-1" });
    fixture.manager.on("mobile:status", () => {});
    fixture.manager.on("mobile:status", () => {});
    fixture.manager.start();

    fixture.externalNotificationEvents.emit("event", {
      eventId: "evt-one-copy",
      profileId: "default",
      workspaceId: "ws-1",
      sessionId: null,
      panelId: null,
      kind: "waiting",
      priority: "high",
      title: "One copy",
      detail: "Exactly one",
      dedupeKey: "dedupe-one-copy",
      collapseKey: null,
      createdAt: 1000,
      actions: [],
    });
    await flush();

    // One addressee, one sealed copy — the count is per approved device, never per window.
    expect(fixture.transport.getSentEvents(OWN_DEVICE_ID)).toHaveLength(1);
    fixture.manager.stop();
  });

  /**
   * One phone, two computers. Both desktops hold a device record for the SAME phone keypair, and
   * each is its own pair with its own session key — which is what makes the cross-route cases below
   * meaningful rather than tautological.
   */
  async function twoComputersOnePhone() {
    const deskA = await createFixture();
    const deskB = await createFixture({ ownDeviceId: "desktop-2" });
    const phoneKeyPair = generateX25519KeyPair();
    await addMobileDevice(deskA.deviceStore, { deviceId: "phone-1", keyPair: phoneKeyPair });
    await addMobileDevice(deskB.deviceStore, {
      deviceId: "phone-1",
      keyPair: phoneKeyPair,
      pairId: "desktop-2",
    });
    deskA.manager.start();
    deskB.manager.start();
    return {
      deskA,
      deskB,
      phoneKeyPair,
      keyForA: sessionKeyFor(phoneKeyPair.privateKey, deskA.desktopKeyPair.publicKey, OWN_DEVICE_ID),
      keyForB: sessionKeyFor(phoneKeyPair.privateKey, deskB.desktopKeyPair.publicKey, "desktop-2"),
      stop() {
        deskA.manager.stop();
        deskB.manager.stop();
      },
    };
  }

  test("two data dirs are two desktops: different identity, different keypair, two session keys", async () => {
    // Matrix item 3. Same person, same OS account, same phone — and still two independent
    // installations, because the identity lives in the data dir, not in the human.
    const mesh = await twoComputersOnePhone();
    expect(mesh.deskA.ownDeviceId).not.toBe(mesh.deskB.ownDeviceId);
    expect(exportRawPublicKey(mesh.deskA.desktopKeyPair.publicKey).toString("base64")).not.toBe(
      exportRawPublicKey(mesh.deskB.desktopKeyPair.publicKey).toString("base64"),
    );
    // The pairId is the HKDF salt, so even a hypothetical shared desktop keypair would still
    // produce two different session keys — the binding is to the pair, not only to the keys.
    expect(mesh.keyForA.equals(mesh.keyForB)).toBe(false);
    mesh.stop();
  });

  test("a command for desktop B never executes on desktop A, in either direction", async () => {
    // Matrix item 4. The envelope is genuinely authentic — sealed by a phone that really is paired
    // with B, using the real session key for B — and it is delivered onto A's watcher.
    const mesh = await twoComputersOnePhone();
    mesh.deskA.transport.pushCommandEnvelope(
      OWN_DEVICE_ID,
      buildCommandEnvelope({
        messageId: "cmd-for-desktop-2",
        senderDeviceId: "phone-1",
        sessionKey: mesh.keyForB,
        command: makePauseCommand(),
        pairId: "desktop-2",
        targetDeviceId: "desktop-2",
      }),
    );
    // And the mirror image, so the check is not merely right for one of the two.
    mesh.deskB.transport.pushCommandEnvelope(
      "desktop-2",
      buildCommandEnvelope({
        messageId: "cmd-for-desktop-1",
        senderDeviceId: "phone-1",
        sessionKey: mesh.keyForA,
        command: makePauseCommand(),
        pairId: OWN_DEVICE_ID,
        targetDeviceId: OWN_DEVICE_ID,
      }),
    );
    await flush();

    expect(mesh.deskA.runtime.calls).toHaveLength(0);
    expect(mesh.deskB.runtime.calls).toHaveLength(0);
    expect(mesh.deskA.transport.getSentResultEnvelopes(OWN_DEVICE_ID)).toHaveLength(0);
    expect(mesh.deskB.transport.getSentResultEnvelopes("desktop-2")).toHaveLength(0);
    for (const fixture of [mesh.deskA, mesh.deskB]) {
      const rejections = fixture.auditLogStore.query({ action: "command.rejected", limit: 20 });
      expect(rejections.entries.map((entry) => entry.detail)).toContain("foreign-pair");
    }
    mesh.stop();
  });

  test("revoking the phone on desktop A leaves its pairing with desktop B intact", async () => {
    // Matrix item 4 / §Multiwindow's last bullet: revoke is per pair. There is no account layer that
    // could make it global, and pretending otherwise would be the more dangerous default — a user
    // who revokes on the laptop must not be told the phone is off the other desktop too.
    const mesh = await twoComputersOnePhone();
    await mesh.deskA.manager.revokeDevice("phone-1");

    expect(mesh.deskA.deviceStore.getDevice("phone-1")?.revoked).toBe(true);
    expect(mesh.deskB.deviceStore.getDevice("phone-1")?.revoked).toBe(false);

    mesh.deskB.transport.pushCommandEnvelope(
      "desktop-2",
      buildCommandEnvelope({
        messageId: "cmd-still-works",
        senderDeviceId: "phone-1",
        sessionKey: mesh.keyForB,
        command: makePauseCommand({ targetDeviceId: "desktop-2" }),
        pairId: "desktop-2",
        targetDeviceId: "desktop-2",
      }),
    );
    await flush();
    expect(mesh.deskB.runtime.calls).toContain("pauseTask:ws-1");
    mesh.stop();
  });

  test("a revoke that lands before an in-flight command wins: no side effect, deterministic refusal", async () => {
    // Matrix item 7. The envelope was sealed while the device was still paired — a real race, not a
    // forged message — and arrives after the revoke. The receiver's device lookup is what decides,
    // and it decides before claimCommand, before touchLastSeen and before any dispatch.
    //
    // Revoked through the device store rather than through `manager.revokeDevice`, deliberately:
    // the in-memory transport's revokeDevice also tears down the command watcher, which would
    // decide the outcome by making the envelope undeliverable and prove nothing about the
    // receiver. The real transport keeps watching, so this is the harder and more honest state —
    // the record says revoked and the envelope still arrives.
    const fixture = await createFixture();
    const { deviceId, keyPair } = await addMobileDevice(fixture.deviceStore);
    const sessionKey = sessionKeyFor(keyPair.privateKey, fixture.desktopKeyPair.publicKey);
    fixture.manager.start();
    const envelope = buildCommandEnvelope({
      messageId: "cmd-in-flight",
      senderDeviceId: deviceId,
      sessionKey,
      command: makePauseCommand(),
    });

    await fixture.deviceStore.revokeDevice(deviceId, 2000);
    fixture.transport.pushCommandEnvelope(OWN_DEVICE_ID, envelope);
    await flush();

    expect(fixture.runtime.calls).toHaveLength(0);
    expect(fixture.transport.getSentResultEnvelopes(OWN_DEVICE_ID)).toHaveLength(0);
    const rejections = fixture.auditLogStore.query({ action: "command.rejected", limit: 20 });
    expect(rejections.entries.map((entry) => entry.detail)).toContain("unknown-or-revoked-device");
    fixture.manager.stop();
  });
});

describe("MobileManager presence: the desktop says it is reachable", () => {
  // `updatePresence` was implemented on the transport, allowed by the security rules, and called by
  // nothing. Read against the live database, the pair's whole `presence` branch was null — so a
  // desktop that was paired, connected and answering commands showed on the phone as "Not
  // reachable", which is the report these tests close.
  test("a connected desktop publishes its own presence, keyed by its own id", async () => {
    const { manager, transport } = await createFixture();
    manager.start();
    await vi.waitFor(() => expect(transport.getPresenceUpdates().length).toBeGreaterThan(0));

    expect(transport.getPresenceUpdates()[0]).toEqual({
      // One desktop is one pair, and the rules require the path key to be the desktop's own
      // deviceId: both arguments are the same id on purpose.
      pairId: OWN_DEVICE_ID,
      deviceId: OWN_DEVICE_ID,
      status: "online",
    });
    manager.stop();
  });

  test("stopping says offline, so the phone does not wait for a timestamp to rot", async () => {
    const { manager, transport } = await createFixture();
    manager.start();
    await vi.waitFor(() => expect(transport.getPresenceUpdates().length).toBeGreaterThan(0));

    await manager.stop();

    const updates = transport.getPresenceUpdates();
    expect(updates[updates.length - 1]).toEqual({
      pairId: OWN_DEVICE_ID,
      deviceId: OWN_DEVICE_ID,
      status: "offline",
    });
  });

  test("shutdown waits for the offline write before disconnecting the transport", async () => {
    const { manager, transport } = await createFixture();
    manager.start();
    await vi.waitFor(() => expect(transport.getPresenceUpdates().length).toBeGreaterThan(0));

    let finishOffline!: () => void;
    const offlinePending = new Promise<void>((resolve) => {
      finishOffline = resolve;
    });
    vi.spyOn(transport, "updatePresence").mockImplementation((_pairId, _deviceId, status) =>
      status === "offline" ? offlinePending : Promise.resolve(),
    );
    const disconnect = vi.spyOn(transport, "disconnect");

    const stopping = manager.stop();
    await Promise.resolve();
    expect(disconnect).not.toHaveBeenCalled();

    finishOffline();
    await stopping;
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  test("shutdown disconnects after the bounded wait when the offline write hangs", async () => {
    vi.useFakeTimers();
    try {
      const { manager, transport } = await createFixture();
      manager.start();
      await vi.waitFor(() => expect(transport.getPresenceUpdates().length).toBeGreaterThan(0));

      vi.spyOn(transport, "updatePresence").mockImplementation((_pairId, _deviceId, status) =>
        status === "offline" ? new Promise<void>(() => {}) : Promise.resolve(),
      );
      const disconnect = vi.spyOn(transport, "disconnect");
      const stopping = manager.stop();

      await vi.advanceTimersByTimeAsync(1_999);
      expect(disconnect).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await stopping;
      expect(disconnect).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // The heartbeat is also the health probe. A desktop whose uid is no longer in the pair's
  // `members` — what a re-minted anonymous account leaves behind — connects normally and has every
  // read and write refused, and `connectionState` alone reported that as "Connected" for hours.
  test("a rules rejection on the heartbeat reports the pair as unauthorized", async () => {
    const { manager, transport } = await createFixture();
    transport.updatePresence = () =>
      Promise.reject(new MobileFirebasePermissionDeniedError("v2/pairs/own/presence/own"));

    manager.start();
    await vi.waitFor(() => expect(manager.getConnectionHealth().pairAuthorization).toBe("denied"));

    // The link itself is genuinely up — which is exactly why the state had to stop being the whole
    // answer.
    expect(manager.getConnectionHealth().connectionState).toBe("connected");
    manager.stop();
  });

  test("a heartbeat that lands reports the pair as authorized", async () => {
    const { manager } = await createFixture();
    manager.start();
    await vi.waitFor(() => expect(manager.getConnectionHealth().pairAuthorization).toBe("ok"));
    manager.stop();
  });

  test("a heartbeat that fails for any other reason says nothing about authorization", async () => {
    // Offline, unconfigured Firebase, a 5xx: none of them is evidence about who this desktop is,
    // and reporting "not authorized" for them would send people re-pairing over a lost packet.
    const { manager, transport } = await createFixture();
    transport.updatePresence = () => Promise.reject(new Error("nope"));

    manager.start();
    await vi.waitFor(() => expect(manager.getConnectionHealth().connectionState).toBe("connected"));

    expect(manager.getConnectionHealth().pairAuthorization).toBe("unknown");
    manager.stop();
  });

  test("a presence write that fails does not take anything else down with it", async () => {
    // Presence is a display signal. A transport that refuses it (unconfigured Firebase, a denied
    // rule, a dead network) must not turn that into a failed start or a failed shutdown.
    const { manager, transport } = await createFixture();
    transport.updatePresence = () => Promise.reject(new Error("nope"));
    expect(() => manager.start()).not.toThrow();
    await vi.waitFor(() => expect(manager.getConnectionHealth().connectionState).toBe("connected"));
    expect(() => manager.stop()).not.toThrow();
  });
});

describe("default profile access and live synchronization", () => {
  test("the catalog revision is a pure function of the catalog content", () => {
    // 2026-10-05: a random UUID per publish made every manager restart look like a catalog change.
    const a = catalogRevisionOf('[["work","Work"]]');
    expect(a).toBe(catalogRevisionOf('[["work","Work"]]'));
    expect(a).not.toBe(catalogRevisionOf('[["work","Work renamed"]]'));
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  test("publishes a new opaque revision only when this device's allowed catalog changes", async () => {
    let workName = "Work";
    let privateName = "Private";
    const { manager, deviceStore, transport } = await createFixture({
      getProfileIds: () => ["work", "private"],
      getCatalogSignature: (allowed) =>
        JSON.stringify(allowed.map((id) => [id, id === "work" ? workName : privateName])),
    });
    const { deviceId } = await addMobileDevice(deviceStore, {
      profileAllowlist: ["work"],
    });
    const publish = vi.spyOn(transport, "updateDeviceAccess");
    await manager.start();
    try {
      await manager.updateDeviceAllowlist(deviceId, { excludedProfileIds: ["private"] });
      await manager.syncProfileAccess();
      const firstRevision = publish.mock.lastCall?.[4];
      expect(firstRevision).toMatch(/^[0-9a-f-]{36}$/);
      expect(publish.mock.lastCall?.[1]).toBe(deviceId);
      const calls = publish.mock.calls.length;

      privateName = "Private renamed";
      await manager.syncProfileAccess();
      expect(publish).toHaveBeenCalledTimes(calls);
      workName = "Work renamed";
      await manager.syncProfileAccess();
      expect(publish).toHaveBeenCalledTimes(calls + 1);
      expect(publish.mock.lastCall?.[4]).not.toBe(firstRevision);
      await manager.syncProfileAccess();
      expect(publish).toHaveBeenCalledTimes(calls + 1);
    } finally {
      manager.stop();
    }
  });

  test("migrates an existing pairing and includes profiles created later without reconnecting", async () => {
    let profiles = ["default", "other"];
    const { manager, deviceStore, transport } = await createFixture({ getProfileIds: () => profiles });
    const { deviceId } = await addMobileDevice(deviceStore, { profileAllowlist: ["default"] });
    const publish = vi.spyOn(transport, "updateDeviceAccess");
    await manager.start();
    try {
      await manager.syncProfileAccess();
      expect(deviceStore.getDevice(deviceId)).toMatchObject({ excludedProfileIds: [], profileAllowlist: profiles });
      expect(publish).toHaveBeenLastCalledWith(OWN_DEVICE_ID, deviceId, expect.any(Array), profiles);
      profiles = [...profiles, "new"];
      await manager.syncProfileAccess();
      expect(publish).toHaveBeenLastCalledWith(OWN_DEVICE_ID, deviceId, expect.any(Array), profiles);
      const calls = publish.mock.calls.length;
      await manager.syncProfileAccess();
      expect(publish).toHaveBeenCalledTimes(calls);
    } finally {
      manager.stop();
    }
  });

  test("persists exclusions, revokes old sessions, and keeps including future profiles", async () => {
    let profiles = ["default", "private"];
    const { manager, deviceStore, transport, revokeRemoteSessions } = await createFixture({
      getProfileIds: () => profiles,
    });
    const { deviceId } = await addMobileDevice(deviceStore);
    const publish = vi.spyOn(transport, "updateDeviceAccess");
    await manager.start();
    try {
      await manager.syncProfileAccess();
      await manager.updateDeviceAllowlist(deviceId, { excludedProfileIds: ["private"] });
      expect(revokeRemoteSessions).toHaveBeenCalledWith(deviceId);
      profiles = [...profiles, "new"];
      await manager.syncProfileAccess();
      expect(deviceStore.getDevice(deviceId)).toMatchObject({
        excludedProfileIds: ["private"],
        profileAllowlist: ["default", "new"],
      });
      expect(publish).toHaveBeenLastCalledWith(OWN_DEVICE_ID, deviceId, expect.any(Array), ["default", "new"]);
    } finally {
      manager.stop();
    }
  });

  test("retries failed publication with backoff instead of retrying on every state update", async () => {
    let now = 1000;
    const { manager, deviceStore, transport } = await createFixture({
      now: () => now,
      getProfileIds: () => ["default", "new"],
    });
    await addMobileDevice(deviceStore);
    const publish = vi.spyOn(transport, "updateDeviceAccess").mockRejectedValue(new Error("offline"));
    await manager.start();
    try {
      await manager.syncProfileAccess().catch(() => {});
      const calls = publish.mock.calls.length;
      await manager.syncProfileAccess();
      expect(publish).toHaveBeenCalledTimes(calls);
      now += 30001;
      publish.mockResolvedValue(undefined);
      await manager.syncProfileAccess();
      expect(publish).toHaveBeenCalledTimes(calls + 1);
    } finally {
      manager.stop();
    }
  });
});
