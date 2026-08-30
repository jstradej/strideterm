/**
 * Review 3 §P0.1: the pairing state machine, and every way it must refuse to activate a device.
 *
 * WHAT THIS FILE REPLACED. It used to test the v2 handshake: the desktop sealed a random code into an
 * event addressed to a freshly-claimed device, the device echoed it back as an ordinary
 * `notification.acknowledge` command, and `verifiedAt` was set automatically. Every one of those tests
 * passed, and the arrangement was still fail-open — because no human input appeared anywhere in it. A
 * device that could decrypt was "verified", and verified was all anything checked. The SAS screen's
 * button hid the code.
 *
 * The cases here are the ones the review asks for, and each of them is a state v2 would have accepted:
 * a stale record that existed before the invitation, a record claimed under a different invitation, a
 * cryptographically perfect device that nobody approved, a destructive command from a `keyProven`
 * device, a SAS mismatch, a restart mid-approval, and an Admin-injected record.
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, test } from "vitest";
import { MobileManager } from "./mobile-manager.js";
import { createMobilePairing } from "./mobile-pairing.js";
import { createMobileDeviceStore } from "./mobile-device-store.js";
import { createMobileAuditLogStore } from "./mobile-audit-log-store.js";
import { createMobileIdempotencyStore } from "./mobile-idempotency-store.js";
import { createMobileCommandDispatcher, type MobileCommandRuntime } from "./mobile-command-dispatch.js";
import { createInMemoryMobileFirebaseTransport } from "./mobile-firebase-transport.js";
import { createMobileWebSessionTicketStore } from "./mobile-web-session-ticket-store.js";
import {
  buildRoutingAad,
  computeGrantCommitment,
  computeKeyProof,
  decodeCanonicalPublicKey,
  deriveSessionKey,
  exportRawPublicKey,
  generateX25519KeyPair,
  keyProofsEqual,
  publicKeyFromRaw,
  sealEnvelope,
} from "./mobile-crypto.js";
import {
  MAX_DESTRUCTIVE_COMMAND_TTL_MS,
  PROTOCOL_VERSION,
  SESSION_KEY_HKDF_INFO,
  type Command,
  type Device,
  type EncryptedEnvelope,
  type MobileDeviceRecord,
} from "./mobile-schemas.js";
import { makeCloudDevice } from "./mobile-test-fixtures.js";
import type { ExternalNotificationEvent } from "../../shared/types/notifications.js";
import type { AppState } from "../../shared/types/state.js";

const OWN_DEVICE_ID = "desktop-1";
const PROTOCOL_INFO = Buffer.from(SESSION_KEY_HKDF_INFO);
const MOBILE_DEVICE_ID = "mobile-1";

const tempDirs: string[] = [];
const openStores: Array<{ close(): void }> = [];
afterEach(async () => {
  for (const store of openStores.splice(0)) store.close();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function flush(rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

function noopRuntime(): MobileCommandRuntime & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    pauseTask: (w) => {
      calls.push(`pauseTask:${w}`);
      return { ok: true };
    },
    resumeTask: async () => ({ ok: true }),
    stopTask: (w) => {
      calls.push(`stopTask:${w}`);
      return { ok: true };
    },
    resetTask: async () => ({ ok: true }),
    updateTaskDescription: async () => ({ ok: true }),
    resendTaskInstruction: async () => ({ ok: true }),
    createCloudflareTunnel: async () => {},
    getPayload: () => ({
      remoteAccess: { enabled: true, host: "0.0.0.0", tunnel: { status: "connected", publicUrl: "" } },
    }),
    clearAlertForSession: (sessionId) => {
      calls.push(`clearAlertForSession:${sessionId}`);
      return null;
    },
  };
}

async function createFixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-mobile-activate-"));
  tempDirs.push(dir);
  const auditLogStore = createMobileAuditLogStore(path.join(dir, "audit.db"));
  const idempotencyStore = createMobileIdempotencyStore(path.join(dir, "idempotency.db"));
  openStores.push(auditLogStore, idempotencyStore);

  let devices: MobileDeviceRecord[] = [];
  const deviceStore = createMobileDeviceStore({
    getDevices: () => devices,
    mutateDevices: async (fn) => {
      devices = fn(devices);
      return devices;
    },
  });

  const desktopKeyPair = generateX25519KeyPair();
  const desktopPublicKeyBase64 = exportRawPublicKey(desktopKeyPair.publicKey).toString("base64");
  const transport = createInMemoryMobileFirebaseTransport();
  await transport.connect();

  const state = {
    activeWorkspaceId: "",
    settings: {
      remoteAccess: {
        enabled: true,
        host: "0.0.0.0",
        port: 1,
        token: "t",
        customPublicUrl: "",
        cloudflaredPath: "",
        autoTunnel: true,
      },
    },
    tabTemplates: [],
    profiles: [],
    workspaces: [{ id: "ws-1", profileId: "default", kind: "task", task: { taskId: "task-1", state: "paused" } }],
    ssh: {},
    windowSlots: [],
  } as unknown as AppState;

  const runtime = noopRuntime();
  const pairing = createMobilePairing({
    transport,
    deviceStore,
    auditLogStore,
    identity: {
      deviceId: OWN_DEVICE_ID,
      label: "My Desktop",
      publicKeyBase64: desktopPublicKeyBase64,
    },
    // The real verification, wired exactly as runtime.ts wires it — a fake that always returned true
    // would make every negative case in this file vacuous.
    verifyKeyProof: ({ device, pairingId, challengeBase64Url }) => {
      try {
        const sessionKey = deriveSessionKey(
          desktopKeyPair.privateKey,
          publicKeyFromRaw(decodeCanonicalPublicKey(device.publicKey)),
          Buffer.from(device.pairId),
          PROTOCOL_INFO,
        );
        return keyProofsEqual(
          computeKeyProof(sessionKey, {
            protocolVersion: PROTOCOL_VERSION,
            pairId: OWN_DEVICE_ID,
            pairingId,
            desktopDeviceId: OWN_DEVICE_ID,
            desktopPublicKeyBase64,
            mobileDeviceId: device.deviceId,
            mobilePublicKeyBase64: device.publicKey,
            challengeBase64Url,
          }),
          device.keyProof,
        );
      } catch {
        return false;
      }
    },
  });
  const events: { channel: string; payload: unknown }[] = [];
  const externalNotificationEvents = new EventEmitter();
  const manager = new MobileManager({
    transport,
    pairing,
    deviceStore,
    auditLogStore,
    commandDispatcher: createMobileCommandDispatcher({
      getState: () => state,
      runtime,
      idempotencyStore,
      auditLogStore,
      ticketIssuer: createMobileWebSessionTicketStore(),
    }),
    externalNotificationEvents,
    ownDeviceId: OWN_DEVICE_ID,
    ownPrivateKey: desktopKeyPair.privateKey,
  });
  for (const channel of ["mobile:pairing-progress"]) {
    manager.on(channel, (payload: unknown) => events.push({ channel, payload }));
  }

  return {
    manager,
    transport,
    deviceStore,
    auditLogStore,
    pairing,
    desktopKeyPair,
    desktopPublicKeyBase64,
    runtime,
    events,
    externalNotificationEvents,
  };
}

type Fixture = Awaited<ReturnType<typeof createFixture>>;

interface ClaimOptions {
  deviceId?: string;
  pairingId?: string;
  capabilities?: MobileDeviceRecord["capabilities"];
  profileAllowlist?: string[];
  /** Forge the key proof instead of computing a real one — the Admin-injection case. */
  forgedKeyProof?: string;
  /** Use a different challenge than the QR carried — a device that never saw the code. */
  challengeOverride?: string;
}

/**
 * Builds the device record `claimPairing` would have written for a real phone, with a genuine key
 * proof, and pushes it through the claim watcher.
 */
async function claimDevice(fixture: Fixture, options: ClaimOptions = {}) {
  fixture.manager.start();
  const capabilities = options.capabilities ?? (["task.control", "task.destructive"] as const);
  const profileAllowlist = options.profileAllowlist ?? ["default"];
  const qr = await fixture.pairing.createInvitation({
    profileAllowlist: [...profileAllowlist],
    capabilities: [...capabilities],
  });
  const mobileKeyPair = generateX25519KeyPair();
  const mobilePublicKeyBase64 = exportRawPublicKey(mobileKeyPair.publicKey).toString("base64");
  const deviceId = options.deviceId ?? MOBILE_DEVICE_ID;
  const pairingId = options.pairingId ?? qr.pairingId;
  const sessionKey = deriveSessionKey(
    mobileKeyPair.privateKey,
    fixture.desktopKeyPair.publicKey,
    Buffer.from(OWN_DEVICE_ID),
    PROTOCOL_INFO,
  );
  const device: Device = makeCloudDevice({
    deviceId,
    uid: "uid-mobile-1",
    pairId: OWN_DEVICE_ID,
    pairingId,
    state: "claimed",
    keyProvenAt: null,
    activatedAt: null,
    label: "Pixel",
    publicKey: mobilePublicKeyBase64,
    capabilities: [...capabilities],
    profileAllowlist: [...profileAllowlist],
    grantCommitment: computeGrantCommitment({
      protocolVersion: PROTOCOL_VERSION,
      pairId: OWN_DEVICE_ID,
      // The server computes it against the invitation the record was claimed under, so a mismatched
      // pairingId also produces a mismatched commitment — which is what the two checks are for.
      pairingId,
      mobileDeviceId: deviceId,
      capabilities: [...capabilities],
      profileAllowlist: [...profileAllowlist],
    }),
    keyProof:
      options.forgedKeyProof ??
      computeKeyProof(sessionKey, {
        protocolVersion: PROTOCOL_VERSION,
        pairId: OWN_DEVICE_ID,
        pairingId,
        desktopDeviceId: OWN_DEVICE_ID,
        desktopPublicKeyBase64: fixture.desktopPublicKeyBase64,
        mobileDeviceId: deviceId,
        mobilePublicKeyBase64,
        challengeBase64Url: options.challengeOverride ?? qr.keyProofChallenge,
      }),
    createdAt: 1000,
    lastSeenAt: 1000,
  });
  fixture.transport.simulateClaim(OWN_DEVICE_ID, device);
  await flush();
  return { mobileKeyPair, sessionKey, qr, device };
}

/** Claims and then approves, i.e. a complete, human-confirmed pairing. */
async function claimAndApprove(fixture: Fixture, options: ClaimOptions = {}) {
  const claimed = await claimDevice(fixture, options);
  const result = await fixture.manager.approveDevice(options.deviceId ?? MOBILE_DEVICE_ID);
  expect(result.ok).toBe(true);
  return claimed;
}

function commandEnvelope(
  sessionKey: Buffer,
  command: Command,
  overrides: Partial<EncryptedEnvelope> = {},
): EncryptedEnvelope {
  const header = {
    protocolVersion: PROTOCOL_VERSION,
    pairId: OWN_DEVICE_ID,
    senderDeviceId: MOBILE_DEVICE_ID,
    targetDeviceId: OWN_DEVICE_ID,
    messageId: command.commandId,
    messageType: "command" as const,
    // Exactly the command's own timestamps, which is what the mobile client produces and what the
    // receiver now demands.
    createdAt: command.createdAt,
    expiresAt: command.expiresAt,
    sessionKeyVersion: 1,
    ...overrides,
  };
  const aad = buildRoutingAad({
    protocolVersion: header.protocolVersion,
    pairId: header.pairId,
    sourceDeviceId: header.senderDeviceId,
    targetDeviceId: header.targetDeviceId,
    messageId: header.messageId,
    messageType: header.messageType,
    sessionKeyVersion: header.sessionKeyVersion,
    createdAt: header.createdAt,
    expiresAt: header.expiresAt,
  });
  const sealed = sealEnvelope(Buffer.from(JSON.stringify(command)), sessionKey, aad);
  return {
    ...header,
    nonce: sealed.nonce.toString("base64"),
    ciphertext: sealed.ciphertext.toString("base64"),
    aad: aad.toString("base64"),
  };
}

function pauseCommand(now: number, commandId = "cmd-pause"): Command {
  return {
    commandId,
    idempotencyKey: `idem-${commandId}`,
    createdAt: now,
    expiresAt: now + 60_000,
    profileId: "default",
    targetDeviceId: OWN_DEVICE_ID,
    status: "queued",
    type: "task.pause",
    payload: { workspaceId: "ws-1", taskId: "task-1" },
  };
}

function stopCommand(now: number, commandId = "cmd-stop"): Command {
  return {
    commandId,
    idempotencyKey: `idem-${commandId}`,
    createdAt: now,
    expiresAt: now + MAX_DESTRUCTIVE_COMMAND_TTL_MS,
    profileId: "default",
    targetDeviceId: OWN_DEVICE_ID,
    status: "queued",
    type: "task.stop",
    payload: { workspaceId: "ws-1", taskId: "task-1", confirmed: true },
  };
}

function externalEvent(): ExternalNotificationEvent {
  return {
    eventId: "evt-real",
    profileId: "default",
    workspaceId: "ws-1",
    sessionId: null,
    panelId: null,
    kind: "waiting",
    priority: "high",
    title: "Waiting for input",
    detail: "The agent needs a decision",
    dedupeKey: "dedupe-1",
    collapseKey: null,
    createdAt: 1000,
    actions: [],
  };
}

describe("the pairing state machine", () => {
  test("a claim reaches keyProven and no further, and no event is sent to it", async () => {
    const fixture = await createFixture();
    await claimDevice(fixture);

    const device = fixture.deviceStore.getDevice(MOBILE_DEVICE_ID)!;
    expect(device.state).toBe("keyProven");
    expect(device.verifiedAt).not.toBeNull();
    expect(device.activatedAt).toBeNull();
    // The exit criterion, from the desktop's side: no real event without an explicit "Codes match".
    fixture.externalNotificationEvents.emit("event", externalEvent());
    await flush();
    expect(fixture.transport.getSentEvents(OWN_DEVICE_ID)).toHaveLength(0);
    // And the renderer was told to ask, not told it was done.
    expect(fixture.events.map((e) => (e.payload as { status: string }).status)).toContain("awaiting-approval");
    fixture.manager.stop();
  });

  test("approving activates the device, and only then do events flow", async () => {
    const fixture = await createFixture();
    await claimDevice(fixture);
    expect((await fixture.manager.approveDevice(MOBILE_DEVICE_ID)).ok).toBe(true);

    const device = fixture.deviceStore.getDevice(MOBILE_DEVICE_ID)!;
    expect(device.state).toBe("active");
    expect(device.activatedAt).not.toBeNull();

    fixture.externalNotificationEvents.emit("event", externalEvent());
    await flush();
    expect(fixture.transport.getSentEvents(OWN_DEVICE_ID)).toHaveLength(1);
    // The activation went through the cloud too — a locally-flipped flag is not an activation.
    const approve = fixture.transport.getPairingCalls().find((c) => c.call === "approvePairing");
    expect(approve).toBeTruthy();
    expect(approve!.deviceId).toBe(MOBILE_DEVICE_ID);
    fixture.manager.stop();
  });

  test("the approval names the transcript it approved, so it cannot be replayed onto another record", async () => {
    const fixture = await createFixture();
    const { device } = await claimDevice(fixture);
    await fixture.manager.approveDevice(MOBILE_DEVICE_ID);
    const approve = fixture.transport.getPairingCalls().find((c) => c.call === "approvePairing")!;
    // The hash commits to both public keys and the grant commitment; a record whose key or grants moved
    // between the code being shown and the button being pressed produces a different value, and the
    // server recomputes it from the stored record.
    expect(approve.detail).toBeTruthy();
    expect(approve.detail).not.toContain(device.publicKey);
    expect(approve.pairingId).toBe(device.pairingId);
    fixture.manager.stop();
  });

  test("a stale device that existed BEFORE the invitation is not adopted", async () => {
    // The Admin-injection path, in its simplest form. In v2 the desktop adopted any previously-unknown
    // record that appeared while an invitation was open — so an attacker who could write a device row at
    // any earlier time got it adopted, with the grants the human had just ticked, the next time the
    // pairing dialog was opened for any reason.
    const fixture = await createFixture();
    fixture.manager.start();
    const stale = makeCloudDevice({
      deviceId: "stale-1",
      pairId: OWN_DEVICE_ID,
      pairingId: "an-older-invitation",
      state: "claimed",
    });
    // Pushed BEFORE any invitation exists.
    fixture.transport.simulateClaim(OWN_DEVICE_ID, stale);
    await flush();
    expect(fixture.deviceStore.getDevice("stale-1")).toBeNull();

    // And it is still not adopted once an invitation IS open: the claim watcher only surfaces records
    // naming that invitation.
    await fixture.pairing.createInvitation({ profileAllowlist: ["default"], capabilities: ["task.control"] });
    fixture.transport.simulateClaim(OWN_DEVICE_ID, stale);
    await flush();
    expect(fixture.deviceStore.getDevice("stale-1")).toBeNull();
    fixture.manager.stop();
  });

  test("a device claimed under a DIFFERENT invitation is not adopted", async () => {
    const fixture = await createFixture();
    await claimDevice(fixture, { pairingId: "some-other-invitation" });
    expect(fixture.deviceStore.getDevice(MOBILE_DEVICE_ID)).toBeNull();
    fixture.manager.stop();
  });

  test("an Admin-injected record with its own key cannot pass the key proof", async () => {
    // The attack the whole state machine exists for. The injector chooses the public key — so it can
    // make the desktop derive a session key with a key it controls — but it cannot produce a MAC under
    // that session key without this desktop's private key, and it never saw the QR challenge either.
    const fixture = await createFixture();
    await claimDevice(fixture, { forgedKeyProof: "f".repeat(43) });
    expect(fixture.deviceStore.getDevice(MOBILE_DEVICE_ID)).toBeNull();
    const { entries } = fixture.auditLogStore.query({ action: "pairing.claim-rejected" });
    expect(entries.map((e) => e.detail)).toContain("key-proof-failed");
    fixture.manager.stop();
  });

  test("a device that never saw the QR cannot pass the key proof either", async () => {
    // Same shape, one step subtler: the right keys, the wrong challenge. This is what makes a valid
    // proof evidence of physical possession of the code rather than merely of a keypair.
    const fixture = await createFixture();
    await claimDevice(fixture, { challengeOverride: Buffer.alloc(32, 0x42).toString("base64url") });
    expect(fixture.deviceStore.getDevice(MOBILE_DEVICE_ID)).toBeNull();
    fixture.manager.stop();
  });

  test("a record whose recorded grants differ from the approved ones is not adopted", async () => {
    // The cloud's idea of what this device may do and this desktop's idea of it have to be the same
    // idea. Under v2 they were never compared: the desktop stapled its own pending invitation's grants
    // onto whatever record appeared.
    const fixture = await createFixture();
    fixture.manager.start();
    const qr = await fixture.pairing.createInvitation({
      profileAllowlist: ["default"],
      capabilities: ["task.control"],
    });
    const mobileKeyPair = generateX25519KeyPair();
    const mobilePublicKeyBase64 = exportRawPublicKey(mobileKeyPair.publicKey).toString("base64");
    const sessionKey = deriveSessionKey(
      mobileKeyPair.privateKey,
      fixture.desktopKeyPair.publicKey,
      Buffer.from(OWN_DEVICE_ID),
      PROTOCOL_INFO,
    );
    fixture.transport.simulateClaim(
      OWN_DEVICE_ID,
      makeCloudDevice({
        deviceId: MOBILE_DEVICE_ID,
        pairId: OWN_DEVICE_ID,
        pairingId: qr.pairingId,
        state: "claimed",
        publicKey: mobilePublicKeyBase64,
        // A commitment over a WIDER grant set than the human ticked.
        grantCommitment: computeGrantCommitment({
          protocolVersion: PROTOCOL_VERSION,
          pairId: OWN_DEVICE_ID,
          pairingId: qr.pairingId,
          mobileDeviceId: MOBILE_DEVICE_ID,
          capabilities: ["task.control", "task.destructive"],
          profileAllowlist: ["default"],
        }),
        keyProof: computeKeyProof(sessionKey, {
          protocolVersion: PROTOCOL_VERSION,
          pairId: OWN_DEVICE_ID,
          pairingId: qr.pairingId,
          desktopDeviceId: OWN_DEVICE_ID,
          desktopPublicKeyBase64: fixture.desktopPublicKeyBase64,
          mobileDeviceId: MOBILE_DEVICE_ID,
          mobilePublicKeyBase64,
          challengeBase64Url: qr.keyProofChallenge,
        }),
      }),
    );
    await flush();
    expect(fixture.deviceStore.getDevice(MOBILE_DEVICE_ID)).toBeNull();
    const { entries } = fixture.auditLogStore.query({ action: "pairing.claim-rejected" });
    expect(entries.map((e) => e.detail)).toContain("grant-commitment-mismatch");
    fixture.manager.stop();
  });
});

describe("what an unapproved device may do", () => {
  test("an ordinary command from a keyProven device is refused before the claim", async () => {
    const fixture = await createFixture();
    const { sessionKey } = await claimDevice(fixture);
    const now = Date.now();

    fixture.transport.pushCommandEnvelope(OWN_DEVICE_ID, commandEnvelope(sessionKey, pauseCommand(now)));
    await flush();

    expect(fixture.runtime.calls).not.toContain("pauseTask:ws-1");
    const { entries } = fixture.auditLogStore.query({ action: "command.rejected" });
    expect(entries.map((e) => e.detail)).toContain("device-not-active");
    // And nothing was claimed, so the command is still there for a legitimately-activated device later.
    expect(fixture.transport.getSentResultEnvelopes(OWN_DEVICE_ID)).toHaveLength(0);
    fixture.manager.stop();
  });

  test("a DESTRUCTIVE command from a keyProven device is refused too", async () => {
    const fixture = await createFixture();
    const { sessionKey } = await claimDevice(fixture);
    const now = Date.now();

    fixture.transport.pushCommandEnvelope(OWN_DEVICE_ID, commandEnvelope(sessionKey, stopCommand(now)));
    await flush();

    expect(fixture.runtime.calls).not.toContain("stopTask:ws-1");
    fixture.manager.stop();
  });

  test("a cryptographically perfect device gets nothing without the human decision", async () => {
    // The exit criterion, stated as one test: correct AEAD, correct AAD, correct ids, correct
    // timestamps, verified key proof — and still no event, no command and no result.
    const fixture = await createFixture();
    const { sessionKey } = await claimDevice(fixture);
    const now = Date.now();

    fixture.externalNotificationEvents.emit("event", externalEvent());
    fixture.transport.pushCommandEnvelope(OWN_DEVICE_ID, commandEnvelope(sessionKey, pauseCommand(now)));
    await flush();

    expect(fixture.transport.getSentEvents(OWN_DEVICE_ID)).toHaveLength(0);
    expect(fixture.transport.getSentResultEnvelopes(OWN_DEVICE_ID)).toHaveLength(0);
    expect(fixture.runtime.calls).toHaveLength(0);
    fixture.manager.stop();
  });

  test("after approval the same command runs", async () => {
    const fixture = await createFixture();
    const { sessionKey } = await claimAndApprove(fixture);
    const now = Date.now();
    fixture.transport.pushCommandEnvelope(OWN_DEVICE_ID, commandEnvelope(sessionKey, pauseCommand(now)));
    await flush();
    expect(fixture.runtime.calls).toContain("pauseTask:ws-1");
    fixture.manager.stop();
  });
});

describe("mismatch, dismissal, timeout and restart", () => {
  test("a SAS mismatch revokes the device rather than warning about it", async () => {
    const fixture = await createFixture();
    await claimDevice(fixture);

    await fixture.manager.rejectDevice(MOBILE_DEVICE_ID, "sas-mismatch");

    const device = fixture.deviceStore.getDevice(MOBILE_DEVICE_ID)!;
    expect(device.state).toBe("revoked");
    expect(device.revoked).toBe(true);
    const reject = fixture.transport.getPairingCalls().find((c) => c.call === "rejectPairing");
    expect(reject?.detail).toBe("sas-mismatch");
    fixture.manager.stop();
  });

  test("a rejected device can never be activated afterwards", async () => {
    const fixture = await createFixture();
    await claimDevice(fixture);
    await fixture.manager.rejectDevice(MOBILE_DEVICE_ID, "sas-mismatch");
    const result = await fixture.manager.approveDevice(MOBILE_DEVICE_ID);
    expect(result.ok).toBe(false);
    expect(fixture.deviceStore.getDevice(MOBILE_DEVICE_ID)!.state).toBe("revoked");
    fixture.manager.stop();
  });

  test("dismissing the dialog leaves the device inert, not active", async () => {
    // "Zavření dialogu, timeout nebo restart nesmí aktivovat device." Dismissal is the absence of a
    // call, so the assertion is that nothing changed — and that the device is still refused.
    const fixture = await createFixture();
    const { sessionKey } = await claimDevice(fixture);
    const now = Date.now();
    fixture.transport.pushCommandEnvelope(OWN_DEVICE_ID, commandEnvelope(sessionKey, pauseCommand(now)));
    await flush();
    expect(fixture.deviceStore.getDevice(MOBILE_DEVICE_ID)!.state).toBe("keyProven");
    expect(fixture.runtime.calls).toHaveLength(0);
    fixture.manager.stop();
  });

  test("a restart mid-approval neither activates the device nor loses the ability to decide", async () => {
    const fixture = await createFixture();
    await claimDevice(fixture);
    // Simulate the crash window: the human pressed the button and the process died before the cloud
    // answered. `markUserApproved` is what the manager writes first, precisely so this state exists.
    await fixture.deviceStore.markUserApproved(MOBILE_DEVICE_ID);
    fixture.manager.stop();

    const restarted = fixture.deviceStore.getDevice(MOBILE_DEVICE_ID)!;
    expect(restarted.state).toBe("userApproved");
    expect(restarted.activatedAt).toBeNull();

    // Still not usable...
    fixture.manager.start();
    fixture.externalNotificationEvents.emit("event", externalEvent());
    await flush();
    expect(fixture.transport.getSentEvents(OWN_DEVICE_ID)).toHaveLength(0);

    // ...and still decidable, in both directions. The pairing code is recomputed from the transcript
    // rather than remembered, which is what makes the prompt survivable at all.
    expect(fixture.manager.listDevicesAwaitingApproval().map((d) => d.deviceId)).toEqual([MOBILE_DEVICE_ID]);
    expect(fixture.manager.sasForPendingDevice(MOBILE_DEVICE_ID)).toMatch(/^\d{4} \d{4}$/);
    expect((await fixture.manager.approveDevice(MOBILE_DEVICE_ID)).ok).toBe(true);
    expect(fixture.deviceStore.getDevice(MOBILE_DEVICE_ID)!.state).toBe("active");
    fixture.manager.stop();
  });

  test("a failed activation leaves the device inert rather than half-activated", async () => {
    const fixture = await createFixture();
    await claimDevice(fixture);
    // The cloud refuses (or is unreachable). The local record must not end up `active`.
    const failing = { ...fixture.transport, approvePairing: async () => Promise.reject(new Error("nope")) };
    const manager = new MobileManager({
      transport: failing as unknown as typeof fixture.transport,
      pairing: fixture.pairing,
      deviceStore: fixture.deviceStore,
      auditLogStore: fixture.auditLogStore,
      commandDispatcher: { dispatch: async () => ({ commandId: "x", status: "failed" }) } as never,
      externalNotificationEvents: new EventEmitter(),
      ownDeviceId: OWN_DEVICE_ID,
      ownPrivateKey: fixture.desktopKeyPair.privateKey,
    });
    const result = await manager.approveDevice(MOBILE_DEVICE_ID);
    expect(result.ok).toBe(false);
    expect(fixture.deviceStore.getDevice(MOBILE_DEVICE_ID)!.state).toBe("userApproved");
    fixture.manager.stop();
  });

  test("a reinstall claims as a NEW device id, leaving the old one revocable", async () => {
    const fixture = await createFixture();
    await claimAndApprove(fixture);
    await claimDevice(fixture, { deviceId: "mobile-2" });

    expect(fixture.deviceStore.getDevice("mobile-2")).not.toBeNull();
    expect(fixture.deviceStore.getDevice("mobile-2")!.publicKey).not.toBe(
      fixture.deviceStore.getDevice(MOBILE_DEVICE_ID)!.publicKey,
    );
    await fixture.manager.revokeDevice(MOBILE_DEVICE_ID);
    expect(fixture.deviceStore.getDevice(MOBILE_DEVICE_ID)!.revoked).toBe(true);
    expect(fixture.deviceStore.getDevice("mobile-2")!.revoked).toBe(false);
    fixture.manager.stop();
  });
});

describe("capability / profile-allowlist changes take effect immediately (review §P1.6)", () => {
  test("a narrowed allowlist applies to the very next command, not the one after", async () => {
    // The desktop reads the device record fresh for every inbound envelope rather than caching a
    // snapshot at connect time, so an allowlist change is in force for the next command — this
    // asserts that rather than trusting it.
    const fixture = await createFixture();
    const { sessionKey } = await claimAndApprove(fixture);
    const now = Date.now();

    fixture.transport.pushCommandEnvelope(OWN_DEVICE_ID, commandEnvelope(sessionKey, pauseCommand(now, "cmd-allowed")));
    await flush();
    expect(fixture.runtime.calls).toContain("pauseTask:ws-1");

    // Narrow the allowlist so this device may no longer act on the "default" profile.
    await fixture.deviceStore.updateAllowlist(MOBILE_DEVICE_ID, { profileAllowlist: ["other-profile"] });
    fixture.runtime.calls.length = 0;

    fixture.transport.pushCommandEnvelope(
      OWN_DEVICE_ID,
      commandEnvelope(sessionKey, pauseCommand(now, "cmd-after-narrowing")),
    );
    await flush();
    expect(fixture.runtime.calls).not.toContain("pauseTask:ws-1");
    fixture.manager.stop();
  });

  test("a removed capability applies to the very next command", async () => {
    const fixture = await createFixture();
    const { sessionKey } = await claimAndApprove(fixture);
    const now = Date.now();

    await fixture.deviceStore.updateAllowlist(MOBILE_DEVICE_ID, { capabilities: [] });
    fixture.transport.pushCommandEnvelope(
      OWN_DEVICE_ID,
      commandEnvelope(sessionKey, pauseCommand(now, "cmd-no-capability")),
    );
    await flush();
    expect(fixture.runtime.calls).not.toContain("pauseTask:ws-1");
    fixture.manager.stop();
  });
});

describe("timestamps: the stale destructive command (review 3 §P0.4)", () => {
  test("a destructive command dated almost a day ahead is refused, however short its declared TTL", async () => {
    // The exact attack the review describes: outer envelope valid for the generic 24-hour maximum, a
    // destructive command inside dated `now + 23h55m` with a five-minute lifetime. The difference
    // satisfies the per-type TTL and `expiresAt > now` passes with almost a day to spare — and under v2
    // an offline desktop would have executed it the following day.
    const fixture = await createFixture();
    const { sessionKey } = await claimAndApprove(fixture);
    const now = Date.now();
    const future = now + 23 * 3_600_000 + 55 * 60_000;
    const command = { ...stopCommand(future, "cmd-stale-stop") };

    fixture.transport.pushCommandEnvelope(OWN_DEVICE_ID, commandEnvelope(sessionKey, command));
    await flush();

    expect(fixture.runtime.calls).not.toContain("stopTask:ws-1");
    fixture.manager.stop();
  });

  test("an expired outer envelope is refused before decrypt, however fresh the inner command", async () => {
    const fixture = await createFixture();
    const { sessionKey } = await claimAndApprove(fixture);
    const now = Date.now();
    const command = pauseCommand(now, "cmd-expired-outer");

    fixture.transport.pushCommandEnvelope(
      OWN_DEVICE_ID,
      commandEnvelope(sessionKey, command, { createdAt: now - 600_000, expiresAt: now - 300_000 }),
    );
    await flush();

    expect(fixture.runtime.calls).not.toContain("pauseTask:ws-1");
    const { entries } = fixture.auditLogStore.query({ action: "command.rejected" });
    expect(entries.map((e) => e.detail)).toContain("envelope-expired");
    fixture.manager.stop();
  });

  test("inner and outer timestamps must agree exactly", async () => {
    const fixture = await createFixture();
    const { sessionKey } = await claimAndApprove(fixture);
    const now = Date.now();

    // createdAt mismatch.
    fixture.transport.pushCommandEnvelope(
      OWN_DEVICE_ID,
      commandEnvelope(sessionKey, pauseCommand(now, "cmd-created-skew"), { createdAt: now - 1000 }),
    );
    // expiresAt mismatch.
    fixture.transport.pushCommandEnvelope(
      OWN_DEVICE_ID,
      commandEnvelope(sessionKey, pauseCommand(now, "cmd-expires-skew"), { expiresAt: now + 3_600_000 }),
    );
    await flush();

    expect(fixture.runtime.calls).not.toContain("pauseTask:ws-1");
    const details = fixture.auditLogStore.query({ action: "command.rejected" }).entries.map((e) => e.detail);
    expect(details).toContain("created-at-mismatch");
    expect(details).toContain("expires-at-mismatch");
    fixture.manager.stop();
  });

  test("an envelope created far in the future is refused", async () => {
    const fixture = await createFixture();
    const { sessionKey } = await claimAndApprove(fixture);
    const now = Date.now();
    const far = now + 3_600_000;

    fixture.transport.pushCommandEnvelope(
      OWN_DEVICE_ID,
      commandEnvelope(sessionKey, pauseCommand(far, "cmd-future-outer")),
    );
    await flush();

    expect(fixture.runtime.calls).not.toContain("pauseTask:ws-1");
    const details = fixture.auditLogStore.query({ action: "command.rejected" }).entries.map((e) => e.detail);
    expect(details).toContain("envelope-created-in-the-future");
    fixture.manager.stop();
  });

  test("a genuinely delayed but still-valid ordinary command is accepted", async () => {
    // The other side of the bound: a phone whose command sat in the mailbox for an hour while the
    // desktop was offline is the normal case, and refusing it would break the feature.
    const fixture = await createFixture();
    const { sessionKey } = await claimAndApprove(fixture);
    const now = Date.now();
    const command = {
      ...pauseCommand(now - 3_600_000, "cmd-delayed"),
      expiresAt: now + 3_600_000,
    };

    fixture.transport.pushCommandEnvelope(OWN_DEVICE_ID, commandEnvelope(sessionKey, command));
    await flush();

    expect(fixture.runtime.calls).toContain("pauseTask:ws-1");
    fixture.manager.stop();
  });
});

describe("session key version (review 3 §P1.6)", () => {
  test("an envelope naming a key generation this device is not on is refused before any side effect", async () => {
    // `sessionKeyVersion` is derived from BOTH sides' key generations and stored identically by the
    // cloud, this desktop and the phone. It is inside the routing AAD, so an envelope that names a
    // different generation could not open anyway — but "the AEAD would have failed" is not a
    // refusal anybody can audit, and the failure has to land before `claimCommand`, which is itself
    // a side effect. The envelope below is internally consistent (its AAD commits to the version it
    // declares) and sealed with the real session key: the only thing wrong with it is the generation.
    const fixture = await createFixture();
    const { sessionKey } = await claimAndApprove(fixture);
    const now = Date.now();

    fixture.transport.pushCommandEnvelope(
      OWN_DEVICE_ID,
      commandEnvelope(sessionKey, pauseCommand(now, "cmd-wrong-generation"), { sessionKeyVersion: 1001 }),
    );
    await flush();

    expect(fixture.runtime.calls).not.toContain("pauseTask:ws-1");
    const details = fixture.auditLogStore.query({ action: "command.rejected" }).entries.map((e) => e.detail);
    expect(details).toContain("version-mismatch");
    fixture.manager.stop();
  });
});

describe("remote revocation (review 3 §P0.3)", () => {
  test("a revoke performed elsewhere reaches this desktop through the device-update stream", async () => {
    // The old watcher added each device id to a `seen` set on first sight and ignored every later
    // change, so a revoke performed by the phone was invisible until a restart.
    const fixture = await createFixture();
    const { device } = await claimAndApprove(fixture);
    expect(fixture.deviceStore.getDevice(MOBILE_DEVICE_ID)!.state).toBe("active");

    fixture.transport.simulateDeviceUpdate(OWN_DEVICE_ID, {
      ...device,
      state: "revoked",
      revoked: true,
      revokedAt: Date.now(),
    });
    await flush();

    const local = fixture.deviceStore.getDevice(MOBILE_DEVICE_ID)!;
    expect(local.revoked).toBe(true);
    expect(local.state).toBe("revoked");
    fixture.manager.stop();
  });

  test("a queued command from a device revoked while this desktop was offline does not execute", async () => {
    const fixture = await createFixture();
    const { sessionKey, device } = await claimAndApprove(fixture);
    const now = Date.now();

    // The phone revoked itself while this desktop was disconnected: the local record is still active,
    // and the command was already in the mailbox. The receiver's authoritative re-read is what catches
    // it — which is why that read happens immediately before the claim.
    fixture.transport.setRemoteDevice(OWN_DEVICE_ID, {
      ...device,
      state: "revoked",
      revoked: true,
      revokedAt: now,
    });
    fixture.transport.pushCommandEnvelope(
      OWN_DEVICE_ID,
      commandEnvelope(sessionKey, pauseCommand(now, "cmd-after-remote-revoke")),
    );
    await flush();

    expect(fixture.runtime.calls).not.toContain("pauseTask:ws-1");
    const details = fixture.auditLogStore.query({ action: "command.rejected" }).entries.map((e) => e.detail);
    expect(details).toContain("device-revoked-remotely");
    // And the local record now agrees, so nothing later has to re-discover it.
    expect(fixture.deviceStore.getDevice(MOBILE_DEVICE_ID)!.revoked).toBe(true);
    fixture.manager.stop();
  });

  test("revoked never returns to active, not even from a stale stream event", async () => {
    const fixture = await createFixture();
    const { device } = await claimAndApprove(fixture);
    await fixture.manager.revokeDevice(MOBILE_DEVICE_ID);
    expect(fixture.deviceStore.getDevice(MOBILE_DEVICE_ID)!.revoked).toBe(true);

    // An older snapshot arriving late — RTDB replays what changed while a listener was away, and a
    // resync can deliver a record captured before the revoke.
    fixture.transport.simulateDeviceUpdate(OWN_DEVICE_ID, { ...device, state: "active", revoked: false });
    await flush();

    const local = fixture.deviceStore.getDevice(MOBILE_DEVICE_ID)!;
    expect(local.revoked).toBe(true);
    expect(local.state).toBe("revoked");
    fixture.manager.stop();
  });
});
