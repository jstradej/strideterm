import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import type { KeyObject } from "node:crypto";
import { afterEach, describe, expect, test } from "vitest";
import { createMobileCommandDispatcher, type MobileCommandRuntime } from "./mobile-command-dispatch.js";
import { createMobileIdempotencyStore } from "./mobile-idempotency-store.js";
import { createMobileAuditLogStore } from "./mobile-audit-log-store.js";
import { createMobileWebSessionTicketStore } from "./mobile-web-session-ticket-store.js";
import { createMobileNotificationOriginStore } from "./mobile-notification-origin-store.js";
import {
  deriveRelayE2eKeys,
  exportRawPublicKey,
  generateX25519KeyPair,
  openRelayE2eFrame,
  relayE2eInfo,
  relayE2eSalt,
  sealRelayE2eFrame,
  type RelayE2eDesktopOffer,
  type RelayE2ePhoneAcceptance,
} from "./mobile-crypto.js";
import { createRelayE2eOfferStore, type RelayE2eOfferStore } from "./mobile-relay-e2e-offer-store.js";
import { createRelayE2eSessionStore, type RelayE2eSessionStore } from "./mobile-relay-e2e-session-store.js";
import { RELAY_PROTOCOL_VERSION } from "./mobile-relay-protocol.js";
import type { Command, MobileDeviceRecord } from "./mobile-schemas.js";
import { createStore } from "../store.js";
import { createCredentialStore } from "../shared/credential-store.js";
import type { AppState } from "../../shared/types/state.js";

/**
 * The redeeming server's context — a ticket names the transport and the origin it may be used at, so
 * reading one back takes saying which server is asking (production hardening §5 "Ticket" 2).
 *
 * Two of them, because this suite covers both transports: the legacy tunnel and the managed relay.
 */
const TICKET_CONTEXT = {
  transport: "legacy" as const,
  origins: ["https://example.trycloudflare.com", "https://tunnel.example.com"],
};
const RELAY_TICKET_CONTEXT = { transport: "relay" as const, origins: ["https://relay.test.invalid"] };

const MASTER_TOKEN = "SUPER-SECRET-MASTER-REMOTE-TOKEN";

const tempDirs: string[] = [];
const openStores: Array<{ close(): void }> = [];
afterEach(async () => {
  for (const store of openStores.splice(0)) store.close();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function makeState(overrides: Partial<AppState> = {}): AppState {
  return {
    activeWorkspaceId: "",
    settings: {
      remoteAccess: {
        enabled: true,
        host: "0.0.0.0",
        port: 4756,
        token: MASTER_TOKEN,
        customPublicUrl: "",
        cloudflaredPath: "",
        autoTunnel: true,
      },
    } as AppState["settings"],
    tabTemplates: [],
    profiles: [],
    workspaces: [
      {
        id: "ws-1",
        profileId: "default",
        kind: "task",
        // A name and a sequence number, because `workspace.status.get` answers with the SAME string
        // the desktop's own UI shows — `formatWorkspaceDisplayName`, which appends the number for a
        // task workspace. A fixture without them would let the two drift apart untested.
        name: "Fix the parser",
        task: { taskId: "task-1", state: "paused", sequenceNumber: 3 },
      },
      {
        id: "ws-other-profile",
        profileId: "other",
        kind: "task",
        task: { taskId: "task-2", state: "paused" },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any,
    ssh: {} as AppState["ssh"],
    windowSlots: [],
    ...overrides,
  };
}

function makeDevice(overrides: Partial<MobileDeviceRecord> = {}): MobileDeviceRecord {
  return {
    deviceId: "dev-1",
    uid: "uid-1",
    pairId: "pair-1",
    platform: "android",
    label: "Pixel 8",
    fingerprint: "AB:CD",
    publicKey: "pub",
    sessionKeyVersion: 1,
    capabilities: [
      "notifications",
      "status.read",
      "task.control",
      "task.destructive",
      "remote.request",
      "remote.webSession",
    ],
    profileAllowlist: ["default"],
    createdAt: 1000,
    lastSeenAt: 1000,
    revoked: false,
    revokedAt: null,
    pairingId: "pairing-1",
    grantCommitment: "grant-commitment",
    keyProof: "k".repeat(43),
    state: "active",
    verifiedAt: 1000,
    activatedAt: 1000,
    notificationFilter: { minPriority: "low", mutedKinds: [] },
    ...overrides,
  };
}

function makeCommand(overrides: Partial<Command> & { type: Command["type"]; payload: unknown }): Command {
  // A one-minute lifetime, not a billion: COMMAND_POLICY bounds `expiresAt - createdAt` per type
  // (review 2 §P0.3), so a fixture declaring a 12-day TTL would exercise the rejection path rather
  // than whatever each test is actually about.
  const createdAt = Date.now();
  return {
    commandId: "cmd-1",
    idempotencyKey: "idem-1",
    createdAt,
    expiresAt: createdAt + 60_000,
    profileId: "default",
    targetDeviceId: "dev-1",
    status: "queued",
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as Command;
}

function createFakeRuntime(): MobileCommandRuntime & {
  calls: string[];
  setTunnelState: (status: string, publicUrl?: string) => void;
  setResult: (
    method: "pause" | "resume" | "stop" | "reset" | "updateDescription" | "resendInstruction",
    ok: boolean,
  ) => void;
} {
  const calls: string[] = [];
  const tunnel = {
    status: "connected",
    publicUrl: "https://example.trycloudflare.com",
    mode: "quick",
  };
  const results = {
    pause: true,
    resume: true,
    stop: true,
    reset: true,
    updateDescription: true,
    resendInstruction: true,
  };
  return {
    calls,
    setTunnelState(status, publicUrl = "") {
      tunnel.status = status;
      tunnel.publicUrl = publicUrl;
    },
    setResult(method, ok) {
      results[method] = ok;
    },
    pauseTask(workspaceId) {
      calls.push(`pauseTask:${workspaceId}`);
      return { ok: results.pause };
    },
    async resumeTask(workspaceId) {
      calls.push(`resumeTask:${workspaceId}`);
      return { ok: results.resume };
    },
    stopTask(workspaceId) {
      calls.push(`stopTask:${workspaceId}`);
      return { ok: results.stop };
    },
    async resetTask(workspaceId) {
      calls.push(`resetTask:${workspaceId}`);
      return { ok: results.reset };
    },
    async updateTaskDescription(workspaceId, description) {
      calls.push(`updateTaskDescription:${workspaceId}:${description}`);
      return { ok: results.updateDescription };
    },
    async resendTaskInstruction(workspaceId, role) {
      calls.push(`resendTaskInstruction:${workspaceId}:${role}`);
      return { ok: results.resendInstruction };
    },
    async createCloudflareTunnel() {
      calls.push("createCloudflareTunnel");
      tunnel.status = "connected";
      tunnel.publicUrl = "https://example.trycloudflare.com";
    },
    getPayload() {
      return {
        remoteAccess: {
          enabled: true,
          host: "0.0.0.0",
          tunnel: { ...tunnel },
          // Deliberately include the token here too, mimicking a worst-case
          // real payload — sanitizeRemoteStatus must strip it regardless.
          token: MASTER_TOKEN,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      };
    },
    clearAlertForSession(sessionId, options) {
      calls.push(`clearAlertForSession:${sessionId}:dismissed=${Boolean(options?.dismissed)}`);
      return null;
    },
  };
}

/** What the dispatcher is told about a managed relay. `null` means this build has none at all. */
type RelayFixture = { enabled: boolean; state: string; relayOrigin: string } | null;

async function createFixture(
  stateOverrides: Partial<AppState> = {},
  relay: RelayFixture = null,
  e2e: { ownPrivateKey: KeyObject; offerStore: RelayE2eOfferStore; sessionStore: RelayE2eSessionStore } | null = null,
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-mobile-dispatch-"));
  tempDirs.push(dir);
  const idempotencyStore = createMobileIdempotencyStore(path.join(dir, "idempotency.db"));
  const auditLogStore = createMobileAuditLogStore(path.join(dir, "audit.db"));
  openStores.push(idempotencyStore, auditLogStore);
  const state = makeState(stateOverrides);
  const runtime = createFakeRuntime();
  const ticketStore = createMobileWebSessionTicketStore();
  const notificationOrigins = createMobileNotificationOriginStore();
  const dispatcher = createMobileCommandDispatcher({
    getState: () => state,
    runtime,
    idempotencyStore,
    auditLogStore,
    ticketIssuer: ticketStore,
    notificationOrigins,
    relay: relay ? { status: () => relay } : undefined,
    ownPrivateKey: e2e?.ownPrivateKey,
    e2eOfferStore: e2e?.offerStore,
    e2eSessionStore: e2e?.sessionStore,
  });
  return { dispatcher, runtime, idempotencyStore, auditLogStore, ticketStore, notificationOrigins, state };
}

describe("authorization: membership / capability / profile", () => {
  test("accepts a valid command from a fully-authorized device", async () => {
    const { dispatcher, runtime } = await createFixture();
    const command = makeCommand({ type: "task.pause", payload: { workspaceId: "ws-1", taskId: "task-1" } });
    const result = await dispatcher.dispatch(command, makeDevice());
    expect(result).toMatchObject({ commandId: "cmd-1", status: "succeeded" });
    expect(runtime.calls).toContain("pauseTask:ws-1");
  });

  test("rejects a null device (not found / not a member)", async () => {
    const { dispatcher } = await createFixture();
    const command = makeCommand({ type: "task.pause", payload: { workspaceId: "ws-1", taskId: "task-1" } });
    const result = await dispatcher.dispatch(command, null);
    expect(result).toMatchObject({ status: "failed", errorCode: "device-not-found" });
  });

  test("rejects a revoked device", async () => {
    const { dispatcher, runtime } = await createFixture();
    const command = makeCommand({ type: "task.pause", payload: { workspaceId: "ws-1", taskId: "task-1" } });
    const result = await dispatcher.dispatch(command, makeDevice({ revoked: true, revokedAt: 2000 }));
    expect(result).toMatchObject({ status: "failed", errorCode: "device-revoked" });
    expect(runtime.calls).not.toContain("pauseTask:ws-1");
  });

  test("rejects a command whose requiredCapability the device does not have", async () => {
    const { dispatcher, runtime } = await createFixture();
    const command = makeCommand({
      type: "task.pause",
      payload: { workspaceId: "ws-1", taskId: "task-1" },
    });
    const device = makeDevice({ capabilities: ["remote.request"] }); // no task.control
    const result = await dispatcher.dispatch(command, device);
    expect(result).toMatchObject({ status: "failed", errorCode: "missing-capability" });
    expect(runtime.calls).not.toContain("pauseTask:ws-1");
  });

  test("rejects a command whose profileId the device's allowlist does not include", async () => {
    const { dispatcher, runtime } = await createFixture();
    const command = makeCommand({
      type: "task.pause",
      payload: { workspaceId: "ws-1", taskId: "task-1" },
      profileId: "other",
    });
    const device = makeDevice({ profileAllowlist: ["default"] }); // "other" not allowed
    const result = await dispatcher.dispatch(command, device);
    expect(result).toMatchObject({ status: "failed", errorCode: "profile-not-allowed" });
    expect(runtime.calls).not.toContain("pauseTask:ws-1");
  });

  test("rejects an already-expired command", async () => {
    const { dispatcher, runtime } = await createFixture();
    const command = makeCommand({
      type: "task.pause",
      payload: { workspaceId: "ws-1", taskId: "task-1" },
      expiresAt: 500,
    });
    const result = await dispatcher.dispatch(command, makeDevice());
    expect(result).toMatchObject({ status: "expired", errorCode: "command-expired" });
    expect(runtime.calls).not.toContain("pauseTask:ws-1");
  });
});

describe("profile catalog", () => {
  test("returns current display names only for profiles allowed to this device", async () => {
    const { dispatcher } = await createFixture({
      profiles: [
        { id: "default", name: "Default 2", color: "#111", workspaceIds: ["ws-1"] },
        { id: "other", name: "asdf", color: "#222", workspaceIds: ["ws-other-profile"] },
        { id: "secret", name: "Must not leak", color: "#333", workspaceIds: [] },
      ],
    });
    const command = makeCommand({ type: "profile.catalog.get", payload: {} });
    const device = makeDevice({
      capabilities: ["status.read"],
      profileAllowlist: ["default", "other"],
    });

    const result = await dispatcher.dispatch(command, device);

    expect(result).toMatchObject({ status: "succeeded", errorCode: null });
    expect(result.data).toEqual({
      profiles: [
        { id: "default", name: "Default 2", workspaceCount: 1, workspaceNames: ["Fix the parser #3"] },
        { id: "other", name: "asdf", workspaceCount: 1, workspaceNames: [] },
      ],
    });
  });
});

describe("cross-profile workspace rejection", () => {
  test("fails closed when the command's profileId is allowed for the device but the target workspace belongs to a different profile", async () => {
    const { dispatcher, runtime } = await createFixture();
    // Device is allowed for BOTH default and other, but the command claims
    // profileId "default" while targeting a workspace that actually lives
    // in "other" — must be rejected, not silently operate cross-profile.
    const device = makeDevice({ profileAllowlist: ["default", "other"] });
    const command = makeCommand({
      type: "task.pause",
      payload: { workspaceId: "ws-other-profile", taskId: "task-2" },
      profileId: "default",
    });
    const result = await dispatcher.dispatch(command, device);
    expect(result).toMatchObject({ status: "failed", errorCode: "cross-profile-workspace" });
    expect(runtime.calls).not.toContain("pauseTask:ws-other-profile");
  });

  test("fails closed for remote.status.get targeting a workspace outside the command's profileId", async () => {
    const { dispatcher } = await createFixture();
    const device = makeDevice({ profileAllowlist: ["default", "other"], capabilities: ["status.read"] });
    const command = makeCommand({
      type: "remote.status.get",
      payload: { workspaceId: "ws-other-profile" },
      profileId: "default",
    });
    const result = await dispatcher.dispatch(command, device);
    expect(result).toMatchObject({ status: "failed", errorCode: "cross-profile-workspace" });
  });

  test("rejects a task command whose taskId no longer matches the workspace's current task", async () => {
    const { dispatcher, runtime } = await createFixture();
    const command = makeCommand({
      type: "task.pause",
      payload: { workspaceId: "ws-1", taskId: "stale-task-id" },
    });
    const result = await dispatcher.dispatch(command, makeDevice());
    expect(result).toMatchObject({ status: "failed", errorCode: "task-id-mismatch" });
    expect(runtime.calls).not.toContain("pauseTask:ws-1");
  });
});

describe("idempotent command recovery", () => {
  test("a second dispatch with the same idempotencyKey after success returns the cached result without re-executing", async () => {
    const { dispatcher, runtime } = await createFixture();
    const command = makeCommand({ type: "task.pause", payload: { workspaceId: "ws-1", taskId: "task-1" } });
    const first = await dispatcher.dispatch(command, makeDevice());
    const second = await dispatcher.dispatch(command, makeDevice());
    expect(first.status).toBe("succeeded");
    expect(second).toEqual(first);
    expect(runtime.calls.filter((c) => c.startsWith("pauseTask")).length).toBe(1);
  });

  test("restart recovery: a 'claimed' row left by a crashed process is safely re-run for an idempotent command", async () => {
    const { dispatcher, runtime, idempotencyStore } = await createFixture();
    // Simulate a previous process instance having claimed this command and
    // then crashing before it could record a result.
    idempotencyStore.recordClaimed("cmd-1", "idem-1", new Date(500).toISOString());

    const command = makeCommand({ type: "task.pause", payload: { workspaceId: "ws-1", taskId: "task-1" } });
    const result = await dispatcher.dispatch(command, makeDevice());

    expect(result.status).toBe("succeeded");
    expect(runtime.calls).toContain("pauseTask:ws-1");
  });
});

describe("outcome-unknown recovery for non-idempotent commands", () => {
  test("restart recovery: a 'claimed' row left by a crashed process for task.sendInstruction becomes outcome-unknown and is NOT re-executed", async () => {
    const { dispatcher, runtime, idempotencyStore } = await createFixture();
    idempotencyStore.recordClaimed("cmd-1", "idem-1", new Date(500).toISOString());

    const command = makeCommand({
      type: "task.sendInstruction",
      payload: { workspaceId: "ws-1", taskId: "task-1", instruction: "please continue" },
    });
    const result = await dispatcher.dispatch(command, makeDevice());

    expect(result.status).toBe("outcome-unknown");
    expect(runtime.calls).not.toContain("resendTaskInstruction:ws-1:worker");
  });

  test("an in-process failure during a non-idempotent command's execution is recorded as outcome-unknown, not retried automatically", async () => {
    const { dispatcher, runtime, idempotencyStore } = await createFixture();
    const originalResend = runtime.resendTaskInstruction.bind(runtime);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (runtime as any).resendTaskInstruction = async (...args: Parameters<typeof originalResend>) => {
      throw new Error("simulated crash mid-flight");
    };

    const command = makeCommand({
      type: "task.sendInstruction",
      payload: { workspaceId: "ws-1", taskId: "task-1", instruction: "please continue" },
    });
    const result = await dispatcher.dispatch(command, makeDevice());

    expect(result.status).toBe("outcome-unknown");
    const stored = idempotencyStore.getByCommandId("cmd-1");
    expect(stored?.status).toBe("outcome-unknown");

    // A follow-up dispatch with the SAME idempotencyKey after this must not
    // silently retry the side effect either — it replays the recorded
    // outcome-unknown result.
    const second = await dispatcher.dispatch(command, makeDevice());
    expect(second.status).toBe("outcome-unknown");
  });

  test("task.sendInstruction discloses degraded delivery (free-text content not sent) rather than pretending success", async () => {
    const { dispatcher } = await createFixture();
    const command = makeCommand({
      type: "task.sendInstruction",
      payload: { workspaceId: "ws-1", taskId: "task-1", instruction: "do the thing" },
    });
    const result = await dispatcher.dispatch(command, makeDevice());
    expect(result.status).toBe("succeeded");
    expect(result.data).toMatchObject({ degraded: true });
  });
});

describe("tunnel safety gates", () => {
  test("remote.tunnel.reconnect is refused when autoTunnel was never enabled by the desktop (no new exposure)", async () => {
    const { dispatcher, runtime } = await createFixture({
      settings: {
        remoteAccess: {
          enabled: true,
          host: "0.0.0.0",
          port: 4756,
          token: MASTER_TOKEN,
          customPublicUrl: "",
          cloudflaredPath: "",
          autoTunnel: false, // never approved
        },
      } as AppState["settings"],
    });
    const device = makeDevice({ capabilities: ["remote.request"] });
    const command = makeCommand({
      type: "remote.tunnel.reconnect",
      payload: { workspaceId: "ws-1", tunnelId: "t-1" },
    });
    const result = await dispatcher.dispatch(command, device);
    expect(result).toMatchObject({ status: "failed", errorCode: "tunnel-not-approved" });
    expect(runtime.calls).not.toContain("createCloudflareTunnel");
  });

  test("remote.endpoint.request answers for the profile when no workspace is named", async () => {
    // The same relaxation as on the ticket command, and for the same reason: the phone asks which
    // transport this desktop is offering before it knows anything about a workspace.
    const { dispatcher } = await createFixture();
    const device = makeDevice({ capabilities: ["remote.request"] });
    const command = makeCommand({ type: "remote.endpoint.request", payload: {} });

    const result = await dispatcher.dispatch(command, device);

    expect(result.status).toBe("succeeded");
    expect(result.data).toMatchObject({ transport: "cloudflare" });
  });

  test("remote.endpoint.request is refused when remote access itself is disabled", async () => {
    const { dispatcher, runtime } = await createFixture({
      settings: {
        remoteAccess: {
          enabled: false,
          host: "0.0.0.0",
          port: 4756,
          token: MASTER_TOKEN,
          customPublicUrl: "",
          cloudflaredPath: "",
          autoTunnel: true,
        },
      } as AppState["settings"],
    });
    const device = makeDevice({ capabilities: ["remote.request"] });
    const command = makeCommand({
      type: "remote.endpoint.request",
      payload: { workspaceId: "ws-1" },
    });
    const result = await dispatcher.dispatch(command, device);
    expect(result).toMatchObject({ status: "failed", errorCode: "tunnel-not-approved" });
    expect(runtime.calls).not.toContain("createCloudflareTunnel");
  });

  test("remote.tunnel.reconnect is allowed (delegates to the tunnel manager) when remote access + autoTunnel were already approved", async () => {
    const { dispatcher, runtime } = await createFixture();
    const device = makeDevice({ capabilities: ["remote.request"] });
    const command = makeCommand({
      type: "remote.tunnel.reconnect",
      payload: { workspaceId: "ws-1", tunnelId: "t-1" },
    });
    const result = await dispatcher.dispatch(command, device);
    expect(result.status).toBe("succeeded");
    expect(runtime.calls).toContain("createCloudflareTunnel");
  });
});

describe("remote.webSession.issue", () => {
  const TUNNEL_ORIGIN = "https://example.trycloudflare.com"; // matches createFakeRuntime's getPayload()

  test("issues a genuine single-use ticket when remote access is approved and the origin matches the live tunnel", async () => {
    const { dispatcher, ticketStore } = await createFixture();
    const device = makeDevice({ capabilities: ["remote.webSession"] });
    const command = makeCommand({
      type: "remote.webSession.issue",
      payload: { workspaceId: "ws-1", allowedOrigin: TUNNEL_ORIGIN },
    });
    const before = Date.now();
    const result = await dispatcher.dispatch(command, device);
    const after = Date.now();

    expect(result.status).toBe("succeeded");
    const data = result.data as { ticketId: string; ticketSecret: string; expiresAt: number };
    expect(data.ticketId).toBeTruthy();
    expect(data.ticketSecret).toBeTruthy();
    // TTL is exactly 60s from issuance (mobile-web-session-ticket-store.ts).
    expect(data.expiresAt).toBeGreaterThanOrEqual(before + 60_000);
    expect(data.expiresAt).toBeLessThanOrEqual(after + 60_000);

    // Genuinely single-use end to end: the store the dispatcher issued from
    // can redeem it exactly once.
    const consumed = ticketStore.consumeTicket(data.ticketId, data.ticketSecret, TICKET_CONTEXT);
    expect(consumed).toMatchObject({
      deviceId: device.deviceId,
      pairId: device.pairId,
      profileId: "default",
      allowedOrigin: TUNNEL_ORIGIN,
      transport: "legacy",
      // One capability, not a copy of the device's grants: the remote UI is the authority for exactly
      // `remote.webSession` (production hardening §5 "Ticket" 6).
      requiredCapability: "remote.webSession",
    });
    expect(ticketStore.consumeTicket(data.ticketId, data.ticketSecret, TICKET_CONTEXT)).toBeNull();
  });

  test("a second dispatch (fresh idempotencyKey) mints a brand-new ticket, independent of the first", async () => {
    const { dispatcher, ticketStore } = await createFixture();
    const device = makeDevice({ capabilities: ["remote.webSession"] });
    const command = makeCommand({
      type: "remote.webSession.issue",
      payload: { workspaceId: "ws-1", allowedOrigin: TUNNEL_ORIGIN },
    });
    const first = await dispatcher.dispatch(command, device);
    const second = await dispatcher.dispatch(
      { ...command, commandId: "cmd-2", idempotencyKey: "idem-2" } as Command,
      device,
    );
    const firstData = first.data as { ticketId: string; ticketSecret: string };
    const secondData = second.data as { ticketId: string; ticketSecret: string };
    expect(firstData.ticketId).not.toBe(secondData.ticketId);
    // The first ticket is still independently redeemable — issuing a second
    // ticket must not invalidate the first.
    expect(ticketStore.consumeTicket(firstData.ticketId, firstData.ticketSecret, TICKET_CONTEXT)).not.toBeNull();
    expect(ticketStore.consumeTicket(secondData.ticketId, secondData.ticketSecret, TICKET_CONTEXT)).not.toBeNull();
  });

  test("refused when remote access itself is disabled (same gate as remote.endpoint.request)", async () => {
    const { dispatcher } = await createFixture({
      settings: {
        remoteAccess: {
          enabled: false,
          host: "0.0.0.0",
          port: 4756,
          token: MASTER_TOKEN,
          customPublicUrl: "",
          cloudflaredPath: "",
          autoTunnel: true,
        },
      } as AppState["settings"],
    });
    const device = makeDevice({ capabilities: ["remote.webSession"] });
    const command = makeCommand({
      type: "remote.webSession.issue",
      payload: { workspaceId: "ws-1", allowedOrigin: TUNNEL_ORIGIN },
    });
    const result = await dispatcher.dispatch(command, device);
    expect(result).toMatchObject({ status: "failed", errorCode: "tunnel-not-approved" });
  });

  test("refused when no tunnel is currently connected", async () => {
    const { dispatcher, runtime } = await createFixture();
    runtime.getPayload = () => ({
      remoteAccess: { enabled: true, host: "0.0.0.0", tunnel: { status: "idle", publicUrl: "", mode: "quick" } },
    });
    const device = makeDevice({ capabilities: ["remote.webSession"] });
    const command = makeCommand({
      type: "remote.webSession.issue",
      payload: { workspaceId: "ws-1", allowedOrigin: TUNNEL_ORIGIN },
    });
    const result = await dispatcher.dispatch(command, device);
    expect(result).toMatchObject({ status: "failed", errorCode: "tunnel-not-connected" });
  });

  test("refused when the requested allowedOrigin does not match the live tunnel origin", async () => {
    const { dispatcher } = await createFixture();
    const device = makeDevice({ capabilities: ["remote.webSession"] });
    const command = makeCommand({
      type: "remote.webSession.issue",
      payload: { workspaceId: "ws-1", allowedOrigin: "https://attacker.example" },
    });
    const result = await dispatcher.dispatch(command, device);
    expect(result).toMatchObject({ status: "failed", errorCode: "origin-mismatch" });
  });

  test("issues a ticket for a profile with no workspace named at all", async () => {
    // Review 1 finding 2. `workspaceId` is optional now, because a phone that has just chosen this
    // desktop and a profile in its own picker knows no workspace — and the ticket was never scoped to
    // one anyway: it carries a profileId and no workspace. While the field was required there was no
    // way to ask, which is why the remote screen was reachable only from a notification.
    const { dispatcher, ticketStore } = await createFixture();
    const device = makeDevice({ capabilities: ["remote.webSession"] });
    const command = makeCommand({
      type: "remote.webSession.issue",
      payload: { allowedOrigin: TUNNEL_ORIGIN },
    });

    const result = await dispatcher.dispatch(command, device);

    expect(result.status).toBe("succeeded");
    const data = result.data as { ticketId: string; ticketSecret: string };
    expect(ticketStore.consumeTicket(data.ticketId, data.ticketSecret, TICKET_CONTEXT)).toMatchObject({
      profileId: "default",
      allowedOrigin: TUNNEL_ORIGIN,
    });
  });

  test("but a profile with nothing in it is refused rather than opened onto a blank screen", async () => {
    // The one thing the desktop still has to decide when no workspace is named: whether the profile
    // the phone picked exists here at all. Only the desktop knows.
    const { dispatcher } = await createFixture();
    const device = makeDevice({ profileAllowlist: ["default", "empty"], capabilities: ["remote.webSession"] });
    const command = makeCommand({
      type: "remote.webSession.issue",
      payload: { allowedOrigin: TUNNEL_ORIGIN },
      profileId: "empty",
    });

    const result = await dispatcher.dispatch(command, device);

    expect(result).toMatchObject({ status: "failed", errorCode: "profile-has-no-workspace" });
  });

  test("fails closed for a cross-profile workspace, same as the other remote.* commands", async () => {
    const { dispatcher } = await createFixture();
    const device = makeDevice({ profileAllowlist: ["default", "other"], capabilities: ["remote.webSession"] });
    const command = makeCommand({
      type: "remote.webSession.issue",
      payload: { workspaceId: "ws-other-profile", allowedOrigin: TUNNEL_ORIGIN },
      profileId: "default",
    });
    const result = await dispatcher.dispatch(command, device);
    expect(result).toMatchObject({ status: "failed", errorCode: "cross-profile-workspace" });
  });
});

describe("master token never appears in a mobile-bound CommandResult", () => {
  test("across every one of the 12 command types", async () => {
    const { dispatcher } = await createFixture();
    const device = makeDevice();
    const commands: Command[] = [
      makeCommand({ type: "notification.acknowledge", payload: { eventId: "evt-1" } }),
      makeCommand({ type: "task.pause", payload: { workspaceId: "ws-1", taskId: "task-1" } }),
      makeCommand({ type: "task.resume", payload: { workspaceId: "ws-1", taskId: "task-1" } }),
      makeCommand({ type: "task.stop", payload: { workspaceId: "ws-1", taskId: "task-1", confirmed: true } }),
      makeCommand({ type: "task.reset", payload: { workspaceId: "ws-1", taskId: "task-1", confirmed: true } }),
      makeCommand({
        type: "task.updateDescription",
        payload: { workspaceId: "ws-1", taskId: "task-1", description: "new desc" },
      }),
      makeCommand({
        type: "task.sendInstruction",
        payload: { workspaceId: "ws-1", taskId: "task-1", instruction: "go" },
      }),
      makeCommand({
        type: "remote.status.get",
        payload: { workspaceId: "ws-1" },
      }),
      makeCommand({
        type: "remote.endpoint.request",
        payload: { workspaceId: "ws-1" },
      }),
      makeCommand({
        type: "remote.tunnel.reconnect",
        payload: { workspaceId: "ws-1", tunnelId: "t-1" },
      }),
      makeCommand({
        type: "remote.webSession.issue",
        // Matches createFakeRuntime's getPayload() tunnel origin so this
        // exercises the REAL ticket-issuing path (not just an origin-mismatch
        // failure) — the ticket's secret must not leak the master token either.
        payload: { workspaceId: "ws-1", allowedOrigin: "https://example.trycloudflare.com" },
      }),
      makeCommand({ type: "workspace.status.get", payload: { workspaceId: "ws-1" } }),
    ];

    for (const [index, command] of commands.entries()) {
      const result = await dispatcher.dispatch(
        { ...command, commandId: `cmd-${index}`, idempotencyKey: `idem-${index}` } as Command,
        device,
      );
      expect(JSON.stringify(result)).not.toContain(MASTER_TOKEN);
    }
  });
});

describe("the managed relay as a third transport", () => {
  const RELAY_ORIGIN = "https://relay.test.invalid";
  const READY_RELAY = { enabled: true, state: "ready", relayOrigin: RELAY_ORIGIN };
  const RELAY_TUNNEL_ORIGIN = "https://example.trycloudflare.com"; // matches createFakeRuntime's getPayload()

  test("remote.endpoint.request answers with the relay, and opens no tunnel to do it", async () => {
    const { dispatcher, runtime } = await createFixture({}, READY_RELAY);
    const command = makeCommand({ type: "remote.endpoint.request", payload: { workspaceId: "ws-1" } });
    const result = await dispatcher.dispatch(command, makeDevice({ capabilities: ["remote.request"] }));

    expect(result.status).toBe("succeeded");
    expect(result.data).toMatchObject({ transport: "managedRelay", host: RELAY_ORIGIN, tunnelKind: "managedRelay" });
    // The relay is a different transport with its own approval. Answering it must not start a
    // Cloudflare tunnel the user did not ask for.
    expect(runtime.calls).not.toContain("createCloudflareTunnel");
  });

  test("with no relay, remote.endpoint.request reuses the connected Cloudflare tunnel", async () => {
    const { dispatcher, runtime } = await createFixture();
    const command = makeCommand({ type: "remote.endpoint.request", payload: { workspaceId: "ws-1" } });
    const result = await dispatcher.dispatch(command, makeDevice({ capabilities: ["remote.request"] }));

    expect(result.status).toBe("succeeded");
    expect(result.data).toMatchObject({ transport: "cloudflare" });
    expect(runtime.calls).not.toContain("createCloudflareTunnel");
  });

  test("with no live tunnel, remote.endpoint.request reconnects Cloudflare", async () => {
    const { dispatcher, runtime } = await createFixture();
    runtime.setTunnelState("idle");
    const command = makeCommand({ type: "remote.endpoint.request", payload: { workspaceId: "ws-1" } });

    const result = await dispatcher.dispatch(command, makeDevice({ capabilities: ["remote.request"] }));

    expect(result.status).toBe("succeeded");
    expect(runtime.calls).toContain("createCloudflareTunnel");
  });

  test("a relay that is enabled but not yet attached is not offered", async () => {
    // An enabled flag is not a transport: a ticket for a relay this desktop has not attached to
    // would send the phone to an origin that answers 503.
    const { dispatcher, runtime } = await createFixture(
      {},
      { enabled: true, state: "connecting", relayOrigin: RELAY_ORIGIN },
    );
    const command = makeCommand({ type: "remote.endpoint.request", payload: { workspaceId: "ws-1" } });
    const result = await dispatcher.dispatch(command, makeDevice({ capabilities: ["remote.request"] }));

    expect(result.data).toMatchObject({ transport: "cloudflare" });
    expect(runtime.calls).not.toContain("createCloudflareTunnel");
  });

  describe("fixed codes instead of an unusable endpoint", () => {
    const TUNNEL_OFF = {
      settings: {
        remoteAccess: {
          enabled: false,
          host: "0.0.0.0",
          port: 4756,
          token: MASTER_TOKEN,
          customPublicUrl: "",
          cloudflaredPath: "",
          autoTunnel: true,
        },
      } as AppState["settings"],
    };
    const endpointRequest = () => makeCommand({ type: "remote.endpoint.request", payload: { workspaceId: "ws-1" } });
    const device = () => makeDevice({ capabilities: ["remote.request"] });

    test("relay enabled but connecting, tunnel not approved → relay-unavailable", async () => {
      const { dispatcher, runtime } = await createFixture(TUNNEL_OFF, {
        enabled: true,
        state: "connecting",
        relayOrigin: RELAY_ORIGIN,
      });
      const result = await dispatcher.dispatch(endpointRequest(), device());
      expect(result).toMatchObject({ status: "failed", errorCode: "relay-unavailable" });
      expect(runtime.calls).not.toContain("createCloudflareTunnel");
    });

    test("relay disabled, tunnel not approved → tunnel-not-approved (unchanged)", async () => {
      const { dispatcher } = await createFixture(TUNNEL_OFF, { enabled: false, state: "off", relayOrigin: "" });
      const result = await dispatcher.dispatch(endpointRequest(), device());
      expect(result).toMatchObject({ status: "failed", errorCode: "tunnel-not-approved" });
    });

    test("relay ready → managedRelay answer (unchanged), even with the tunnel not approved", async () => {
      const { dispatcher } = await createFixture(TUNNEL_OFF, READY_RELAY);
      const result = await dispatcher.dispatch(endpointRequest(), device());
      expect(result.status).toBe("succeeded");
      expect(result.data).toMatchObject({ transport: "managedRelay", host: RELAY_ORIGIN });
    });

    test("tunnel approved but createCloudflareTunnel ends without a publicUrl → tunnel-unavailable, no 0.0.0.0", async () => {
      const { dispatcher, runtime } = await createFixture();
      runtime.setTunnelState("idle");
      runtime.createCloudflareTunnel = async () => {
        runtime.calls.push("createCloudflareTunnel");
        runtime.setTunnelState("error", "");
      };
      const result = await dispatcher.dispatch(endpointRequest(), device());
      expect(result).toMatchObject({ status: "failed", errorCode: "tunnel-unavailable" });
      expect(runtime.calls).toContain("createCloudflareTunnel");
      expect(JSON.stringify(result)).not.toContain("0.0.0.0");
    });

    test("createCloudflareTunnel throws → tunnel-unavailable and the error text never reaches the phone", async () => {
      const { dispatcher, runtime } = await createFixture();
      runtime.setTunnelState("idle");
      runtime.createCloudflareTunnel = async () => {
        throw new Error("spawn cloudflared ENOENT C:\\Users\\someone\\bin\\cloudflared.exe");
      };
      const result = await dispatcher.dispatch(endpointRequest(), device());
      expect(result.errorCode).toBe("tunnel-unavailable");
      expect(result.status).toBe("failed");
      const text = JSON.stringify(result);
      expect(text).not.toContain("ENOENT");
      expect(text).not.toContain("Users");
    });

    test("tunnel connected → cloudflare answer with the tunnel host (unchanged)", async () => {
      const { dispatcher } = await createFixture();
      const result = await dispatcher.dispatch(endpointRequest(), device());
      expect(result.status).toBe("succeeded");
      expect(result.data).toMatchObject({ transport: "cloudflare", host: "example.trycloudflare.com" });
    });
  });

  test("remote.tunnel.reconnect stays relay-unaware: reconnecting the tunnel means the tunnel", async () => {
    const { dispatcher, runtime } = await createFixture({}, READY_RELAY);
    const command = makeCommand({
      type: "remote.tunnel.reconnect",
      payload: { workspaceId: "ws-1", tunnelId: "tunnel-1" },
    });
    const result = await dispatcher.dispatch(command, makeDevice({ capabilities: ["remote.request"] }));

    expect(result.status).toBe("succeeded");
    expect(runtime.calls).toContain("createCloudflareTunnel");
  });

  test("a webSession ticket is issued for the relay origin, without the tunnel gate", async () => {
    const { dispatcher, ticketStore } = await createFixture(
      {
        settings: {
          // Remote access off entirely: the relay's gate is the user's relay setting, not this one.
          remoteAccess: {
            enabled: false,
            host: "0.0.0.0",
            port: 4756,
            token: MASTER_TOKEN,
            customPublicUrl: "",
            cloudflaredPath: "",
          },
        } as AppState["settings"],
      },
      READY_RELAY,
    );
    const device = makeDevice({ capabilities: ["remote.webSession"] });
    const command = makeCommand({
      type: "remote.webSession.issue",
      payload: { workspaceId: "ws-1", allowedOrigin: RELAY_ORIGIN },
    });
    const result = await dispatcher.dispatch(command, device);

    expect(result.status).toBe("succeeded");
    const data = result.data as {
      ticketId: string;
      ticketSecret: string;
      allowedOrigin: string;
      transport: string;
      requiredCapability: string;
    };
    expect(data.allowedOrigin).toBe(RELAY_ORIGIN);
    // The ticket says which server it is for, and the phone reads the same field.
    expect(data.transport).toBe("relay");
    expect(data.requiredCapability).toBe("remote.webSession");
    // And it is redeemable at the RELAY instance only — the legacy server refuses it, which is the
    // cross-transport case the store's own suite covers in both directions.
    expect(ticketStore.consumeTicket(data.ticketId, data.ticketSecret, RELAY_TICKET_CONTEXT)).toMatchObject({
      allowedOrigin: RELAY_ORIGIN,
      transport: "relay",
    });
  });

  test("which transport a ticket is for is the desktop's answer, never the request's", async () => {
    const { dispatcher } = await createFixture({}, READY_RELAY);
    const device = makeDevice({ capabilities: ["remote.webSession"] });

    // A phone that names the tunnel origin while the desktop is on the relay gets nothing: the
    // desktop compares against what it is actually running.
    const namedTunnel = await dispatcher.dispatch(
      makeCommand({
        type: "remote.webSession.issue",
        payload: { workspaceId: "ws-1", allowedOrigin: RELAY_TUNNEL_ORIGIN },
      }),
      device,
    );
    expect(namedTunnel).toMatchObject({ status: "failed", errorCode: "origin-mismatch" });

    // And the mirror image: with no relay, naming a relay origin gets nothing either.
    const { dispatcher: noRelay } = await createFixture();
    const namedRelay = await noRelay.dispatch(
      makeCommand({
        type: "remote.webSession.issue",
        payload: { workspaceId: "ws-1", allowedOrigin: RELAY_ORIGIN },
      }),
      device,
    );
    expect(namedRelay).toMatchObject({ status: "failed", errorCode: "origin-mismatch" });
  });

  test("the ticket carries every field the protocol defines, so the phone can parse it", async () => {
    const { dispatcher } = await createFixture({}, READY_RELAY);
    const device = makeDevice({ capabilities: ["remote.webSession"] });
    const result = await dispatcher.dispatch(
      makeCommand({
        type: "remote.webSession.issue",
        payload: { workspaceId: "ws-1", allowedOrigin: RELAY_ORIGIN },
      }),
      device,
    );
    const data = result.data as Record<string, unknown>;
    for (const field of [
      "ticketId",
      "ticketSecret",
      "deviceId",
      "pairId",
      "profileId",
      "allowedOrigin",
      "transport",
      "requiredCapability",
      "issuedAt",
      "expiresAt",
    ]) {
      expect(data[field]).toBeDefined();
    }
    // And the field that used to be here is gone rather than additionally present: `capabilities` was
    // a copy of the device's grant list masquerading as a statement about the session.
    expect(data["capabilities"]).toBeUndefined();
  });

  test("the endpoint answer carries every field the protocol defines", async () => {
    const { dispatcher } = await createFixture({}, READY_RELAY);
    const result = await dispatcher.dispatch(
      makeCommand({ type: "remote.endpoint.request", payload: { workspaceId: "ws-1" } }),
      makeDevice({ capabilities: ["remote.request"] }),
    );
    const data = result.data as Record<string, unknown>;
    for (const field of ["host", "tunnelKind", "transport", "issuedAt", "expiresAt"]) {
      expect(data[field]).toBeDefined();
    }
    expect(data.expiresAt as number).toBeGreaterThan(data.issuedAt as number);
  });
});

describe("workspace.status.get carries the name the phone cannot otherwise learn", () => {
  test("answers with the desktop's own display name, not just the id", async () => {
    const { dispatcher } = await createFixture();
    const result = await dispatcher.dispatch(
      makeCommand({ type: "workspace.status.get", payload: { workspaceId: "ws-1" } }),
      makeDevice(),
    );

    expect(result.status).toBe("succeeded");
    // A workspace id is `workspace-<uuid>`, and the name never travels with a notification event —
    // its sealed payload has no field for one and cannot grow one without breaking older clients.
    // This is the only route by which the phone's notification list can say "Fix the parser #3"
    // instead of a database key.
    expect(result.data).toMatchObject({ kind: "task", taskState: "paused", name: "Fix the parser #3" });
  });

  test("says null rather than inventing a name for a workspace that has none", async () => {
    const { dispatcher } = await createFixture();
    const result = await dispatcher.dispatch(
      // `ws-other-profile` carries no `name` — an existing fixture rather than a new one, because
      // adding a workspace under `default` silently changes a profile's workspaceCount in the
      // catalog test two describes up.
      makeCommand({
        type: "workspace.status.get",
        payload: { workspaceId: "ws-other-profile" },
        profileId: "other",
      }),
      makeDevice({ profileAllowlist: ["default", "other"] }),
    );

    expect(result.status).toBe("succeeded");
    // The phone falls back to its own wording for this. An empty string dressed up as a name would
    // render as a blank subtitle, which reads as a bug rather than as an absence.
    expect((result.data as { name: unknown }).name).toBeNull();
  });
});

describe("notification.acknowledge clears the alert it names", () => {
  /**
   * The phone's "Got it" is two halves. The local one (marking the row read) happens on the device
   * and is not this repo's; this suite is the desktop half, which used to be a pure echo — so a
   * reader who acknowledged on the phone came back to a desktop still badging the same event.
   *
   * The command payload is only `{eventId}` and its schema is a mirrored `additionalProperties:
   * false` copy, so the link back to an alert is a recording made when the event was SENT — see
   * mobile-notification-origin-store.ts.
   */
  function ackCommand(eventId: string, overrides: Partial<Command> = {}): Command {
    return makeCommand({ ...overrides, type: "notification.acknowledge", payload: { eventId } });
  }

  test("clears the recorded alert, as engagement rather than a dismissal", async () => {
    const { dispatcher, runtime, notificationOrigins } = await createFixture();
    notificationOrigins.record("evt-1", {
      profileId: "default",
      workspaceId: "ws-1",
      panelId: "panel-a",
      sessionId: "ws-1:panel-a",
    });

    const result = await dispatcher.dispatch(ackCommand("evt-1"), makeDevice());

    expect(result.status).toBe("succeeded");
    expect(result.data).toMatchObject({ eventId: "evt-1", cleared: true });
    // `dismissed=false` is the point: a dismissal feeds adaptive suppression, and acknowledging an
    // event the user has read is engagement with it.
    expect(runtime.calls).toContain("clearAlertForSession:ws-1:panel-a:dismissed=false");
  });

  test("an event with no session falls back to the workspace:panel key", async () => {
    const { dispatcher, runtime, notificationOrigins } = await createFixture();
    notificationOrigins.record("evt-2", {
      profileId: "default",
      workspaceId: "ws-1",
      panelId: "panel-b",
      sessionId: "",
    });

    await dispatcher.dispatch(ackCommand("evt-2"), makeDevice());

    expect(runtime.calls).toContain("clearAlertForSession:ws-1:panel-b:dismissed=false");
  });

  test("an unknown event id succeeds and clears nothing", async () => {
    // Events that never raised an alert (the PR-review and pipeline forwards) and events older than
    // the store's window both land here. The phone has already done its local half, so refusing the
    // command would turn a handled notification into a visible error for no gain.
    const { dispatcher, runtime } = await createFixture();

    const result = await dispatcher.dispatch(ackCommand("evt-never-seen"), makeDevice());

    expect(result.status).toBe("succeeded");
    expect(result.data).toMatchObject({ eventId: "evt-never-seen", cleared: false });
    expect(runtime.calls.some((c) => c.startsWith("clearAlertForSession"))).toBe(false);
  });

  test("never clears an alert in a profile the command was not authorised for", async () => {
    // The workspace was moved to another profile while the event sat unread on the phone. The
    // recording still says "default", so trusting it would clear an alert in profile `other`.
    const { dispatcher, runtime, notificationOrigins } = await createFixture();
    notificationOrigins.record("evt-3", {
      profileId: "default",
      workspaceId: "ws-other-profile",
      panelId: "panel-c",
      sessionId: "ws-other-profile:panel-c",
    });

    const result = await dispatcher.dispatch(ackCommand("evt-3"), makeDevice());

    expect(result.status).toBe("succeeded");
    expect(result.data).toMatchObject({ cleared: false });
    expect(runtime.calls.some((c) => c.startsWith("clearAlertForSession"))).toBe(false);
  });

  test("a replayed acknowledgement does not clear twice", async () => {
    // `notification.acknowledge` is idempotent in COMMAND_POLICY, so a phone that retries after a
    // dropped result must get the recorded answer back rather than a second clear — which would
    // reset the session signal and count as engagement all over again.
    const { dispatcher, runtime, notificationOrigins } = await createFixture();
    notificationOrigins.record("evt-4", {
      profileId: "default",
      workspaceId: "ws-1",
      panelId: "panel-d",
      sessionId: "ws-1:panel-d",
    });

    const first = await dispatcher.dispatch(ackCommand("evt-4"), makeDevice());
    const replay = await dispatcher.dispatch(ackCommand("evt-4", { commandId: "cmd-replay" }), makeDevice());

    expect(first.status).toBe("succeeded");
    expect(replay.status).toBe("succeeded");
    expect(runtime.calls.filter((c) => c.startsWith("clearAlertForSession"))).toHaveLength(1);
  });

  test("a device without the notifications capability cannot clear anything", async () => {
    const { dispatcher, runtime, notificationOrigins } = await createFixture();
    notificationOrigins.record("evt-5", {
      profileId: "default",
      workspaceId: "ws-1",
      panelId: "panel-e",
      sessionId: "ws-1:panel-e",
    });

    const result = await dispatcher.dispatch(ackCommand("evt-5"), makeDevice({ capabilities: ["status.read"] }));

    expect(result.status).toBe("failed");
    expect(runtime.calls.some((c) => c.startsWith("clearAlertForSession"))).toBe(false);
  });
});

describe("relay end-to-end encryption key exchange (plan 2026-09-23)", () => {
  const RELAY_ORIGIN = "https://relay.test.invalid";
  const READY_RELAY = { enabled: true, state: "ready", relayOrigin: RELAY_ORIGIN };

  function makeE2eDeps() {
    const ownPrivateKey = generateX25519KeyPair().privateKey;
    return { ownPrivateKey, offerStore: createRelayE2eOfferStore(), sessionStore: createRelayE2eSessionStore() };
  }

  function makeE2eDevice() {
    const phonePairing = generateX25519KeyPair();
    return {
      device: makeDevice({
        capabilities: ["remote.request", "remote.webSession"],
        publicKey: exportRawPublicKey(phonePairing.publicKey).toString("base64"),
      }),
      phonePairingPrivateKey: phonePairing.privateKey,
    };
  }

  test("remote.endpoint.request offers no e2e block when this build has no e2eOfferStore wired", async () => {
    const { dispatcher } = await createFixture({}, READY_RELAY, null);
    const command = makeCommand({ type: "remote.endpoint.request", payload: {} });
    const result = await dispatcher.dispatch(command, makeDevice({ capabilities: ["remote.request"] }));
    expect(result.status).toBe("succeeded");
    expect(result.data).not.toHaveProperty("e2e");
  });

  test("remote.endpoint.request offers a fresh e2e block on every call when wired", async () => {
    const { dispatcher } = await createFixture({}, READY_RELAY, makeE2eDeps());
    const command = makeCommand({ type: "remote.endpoint.request", payload: {} });
    const first = await dispatcher.dispatch(command, makeDevice({ capabilities: ["remote.request"] }));
    const second = await dispatcher.dispatch(
      { ...command, commandId: "cmd-2", idempotencyKey: "idem-2" } as Command,
      makeDevice({ capabilities: ["remote.request"] }),
    );
    expect(first.data).toMatchObject({ e2e: { v: 1 } });
    expect(second.data).toMatchObject({ e2e: { v: 1 } });
    const firstE2e = (first.data as { e2e: { keyId: string; desktopEphemeralPub: string } }).e2e;
    const secondE2e = (second.data as { e2e: { keyId: string; desktopEphemeralPub: string } }).e2e;
    expect(firstE2e.keyId).not.toBe(secondE2e.keyId);
    expect(firstE2e.desktopEphemeralPub).not.toBe(secondE2e.desktopEphemeralPub);
  });

  test("compatibility: no e2e offered and none accepted issues today's ticket unchanged", async () => {
    const { dispatcher } = await createFixture({}, READY_RELAY, makeE2eDeps());
    const command = makeCommand({
      type: "remote.webSession.issue",
      payload: { allowedOrigin: RELAY_ORIGIN },
    });
    const result = await dispatcher.dispatch(command, makeDevice({ capabilities: ["remote.webSession"] }));
    expect(result.status).toBe("succeeded");
    expect(result.data).not.toHaveProperty("e2e");
    expect(result.data).toMatchObject({ transport: "relay" });
  });

  test("an e2e acceptance naming an unknown keyId refuses the whole ticket", async () => {
    const { dispatcher } = await createFixture({}, READY_RELAY, makeE2eDeps());
    const { device } = makeE2eDevice();
    const command = makeCommand({
      type: "remote.webSession.issue",
      payload: {
        allowedOrigin: RELAY_ORIGIN,
        e2e: {
          v: 1,
          keyId: "no-such-offer",
          phoneEphemeralPub: exportRawPublicKey(generateX25519KeyPair().publicKey).toString("base64"),
        },
      },
    });
    const result = await dispatcher.dispatch(command, device);
    expect(result).toMatchObject({ status: "failed", errorCode: "relay-e2e-key-mismatch" });
  });

  test("an e2e acceptance on a build with no e2eOfferStore wired refuses the ticket rather than silently downgrading", async () => {
    const { dispatcher } = await createFixture({}, READY_RELAY, null);
    const { device } = makeE2eDevice();
    const command = makeCommand({
      type: "remote.webSession.issue",
      payload: {
        allowedOrigin: RELAY_ORIGIN,
        e2e: {
          v: 1,
          keyId: "kid-1",
          phoneEphemeralPub: exportRawPublicKey(generateX25519KeyPair().publicKey).toString("base64"),
        },
      },
    });
    const result = await dispatcher.dispatch(command, device);
    expect(result).toMatchObject({ status: "failed", errorCode: "relay-e2e-key-mismatch" });
  });

  test("a malformed phoneEphemeralPub refuses the ticket instead of falling back to plaintext", async () => {
    const e2e = makeE2eDeps();
    const { dispatcher } = await createFixture({}, READY_RELAY, e2e);
    const { device } = makeE2eDevice();
    const endpointResult = await dispatcher.dispatch(
      makeCommand({ type: "remote.endpoint.request", payload: {} }),
      device,
    );
    const keyId = (endpointResult.data as { e2e: { keyId: string } }).e2e.keyId;
    const command = makeCommand({
      commandId: "cmd-2",
      idempotencyKey: "idem-2",
      type: "remote.webSession.issue",
      payload: { allowedOrigin: RELAY_ORIGIN, e2e: { v: 1, keyId, phoneEphemeralPub: "not-a-valid-key" } },
    });
    const result = await dispatcher.dispatch(command, device);
    expect(result).toMatchObject({ status: "failed", errorCode: "relay-e2e-key-mismatch" });
  });

  test("a matching e2e acceptance derives directional keys the phone can independently reproduce, stored by deviceId", async () => {
    const e2e = makeE2eDeps();
    const { dispatcher } = await createFixture({}, READY_RELAY, e2e);
    const { device, phonePairingPrivateKey } = makeE2eDevice();

    const endpointResult = await dispatcher.dispatch(
      makeCommand({ type: "remote.endpoint.request", payload: {} }),
      device,
    );
    expect(endpointResult.status).toBe("succeeded");
    const desktopOffer = (endpointResult.data as { e2e: RelayE2eDesktopOffer }).e2e;

    const phoneEphemeral = generateX25519KeyPair();
    const phoneAcceptance: RelayE2ePhoneAcceptance = {
      v: 1,
      keyId: desktopOffer.keyId,
      phoneEphemeralPub: exportRawPublicKey(phoneEphemeral.publicKey).toString("base64"),
    };
    const issueResult = await dispatcher.dispatch(
      makeCommand({
        commandId: "cmd-2",
        idempotencyKey: "idem-2",
        type: "remote.webSession.issue",
        payload: { allowedOrigin: RELAY_ORIGIN, e2e: phoneAcceptance },
      }),
      device,
    );
    expect(issueResult.status).toBe("succeeded");
    const ticketId = (issueResult.data as { ticketId: string }).ticketId;

    const storedKeys = e2e.sessionStore.get(device.deviceId);
    expect(storedKeys).not.toBeNull();

    // The phone independently derives the SAME keys from its own key material plus the two public
    // wire values it already has (the desktop's ephemeral pub from the endpoint answer, and its own
    // long-term view of the desktop's pairing public key) — proving the desktop's derivation is
    // something a real phone (with no access to this process's memory) could reproduce, not merely
    // self-consistent with itself.
    const { publicKeyFromRaw, decodeCanonicalPublicKey } = await import("./mobile-crypto.js");
    const { createPublicKey } = await import("node:crypto");
    const desktopPairingPublicKey = createPublicKey(e2e.ownPrivateKey);
    const salt = relayE2eSalt(desktopOffer, phoneAcceptance);
    const info = relayE2eInfo(device.pairId, device.deviceId, ticketId);
    const phoneDerivedKeys = deriveRelayE2eKeys(
      phoneEphemeral.privateKey,
      publicKeyFromRaw(decodeCanonicalPublicKey(desktopOffer.desktopEphemeralPub)),
      phonePairingPrivateKey,
      desktopPairingPublicKey,
      salt,
      info,
    );
    expect(storedKeys?.desktopToPhone.toString("hex")).toBe(phoneDerivedKeys.desktopToPhone.toString("hex"));
    expect(storedKeys?.phoneToDesktop.toString("hex")).toBe(phoneDerivedKeys.phoneToDesktop.toString("hex"));
  });

  test("a second issuance for the same device overwrites its stored session key with a fresh one", async () => {
    const e2e = makeE2eDeps();
    const { dispatcher } = await createFixture({}, READY_RELAY, e2e);
    const { device } = makeE2eDevice();

    async function issueOnce(commandId: string) {
      const endpointResult = await dispatcher.dispatch(
        makeCommand({ commandId, idempotencyKey: `${commandId}-idem`, type: "remote.endpoint.request", payload: {} }),
        device,
      );
      const desktopOffer = (endpointResult.data as { e2e: RelayE2eDesktopOffer }).e2e;
      const phoneEphemeral = generateX25519KeyPair();
      await dispatcher.dispatch(
        makeCommand({
          commandId: `${commandId}-issue`,
          idempotencyKey: `${commandId}-issue-idem`,
          type: "remote.webSession.issue",
          payload: {
            allowedOrigin: RELAY_ORIGIN,
            e2e: {
              v: 1,
              keyId: desktopOffer.keyId,
              phoneEphemeralPub: exportRawPublicKey(phoneEphemeral.publicKey).toString("base64"),
            },
          },
        }),
        device,
      );
    }

    await issueOnce("cmd-a");
    const firstKeys = e2e.sessionStore.get(device.deviceId);
    expect(firstKeys).not.toBeNull();

    await issueOnce("cmd-b");
    const secondKeys = e2e.sessionStore.get(device.deviceId);
    expect(secondKeys).not.toBeNull();
    expect(secondKeys?.desktopToPhone.toString("hex")).not.toBe(firstKeys?.desktopToPhone.toString("hex"));
  });

  test("a session key never reaches the persisted state", async () => {
    const e2e = makeE2eDeps();
    const { dispatcher, state } = await createFixture({}, READY_RELAY, e2e);
    const { device } = makeE2eDevice();
    const endpointResult = await dispatcher.dispatch(
      makeCommand({ type: "remote.endpoint.request", payload: {} }),
      device,
    );
    const desktopOffer = (endpointResult.data as { e2e: RelayE2eDesktopOffer }).e2e;
    const phoneEphemeral = generateX25519KeyPair();
    const issueResult = await dispatcher.dispatch(
      makeCommand({
        commandId: "cmd-2",
        idempotencyKey: "idem-2",
        type: "remote.webSession.issue",
        payload: {
          allowedOrigin: RELAY_ORIGIN,
          e2e: {
            v: 1,
            keyId: desktopOffer.keyId,
            phoneEphemeralPub: exportRawPublicKey(phoneEphemeral.publicKey).toString("base64"),
          },
        },
      }),
      device,
    );
    expect(issueResult.status).toBe("succeeded");
    // The state object this dispatcher was given is never mutated by any of this — the session-key
    // store is a wholly separate, desktop-memory-only structure.
    expect(JSON.stringify(state)).not.toContain((issueResult.data as { ticketId: string }).ticketId);
  });

  test("a full e2e session leaves credentials.json and the persisted state file byte-for-byte unchanged (plan P3)", async () => {
    // Unlike the in-memory `state` object above, this wires REAL disk-backed stores — the same
    // ones production uses (../store.js, ../shared/credential-store.js) — so the claim is about
    // actual files on disk, not just an object this test happens to control. A decoy secret is
    // added to the credential store first so the file is non-empty and a would-be leak has
    // somewhere plausible to land.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-mobile-e2e-persistence-"));
    tempDirs.push(dir);

    const statePath = path.join(dir, "state.json");
    const store = await createStore(statePath);
    // Seed the one precondition `remote.endpoint.request` needs (a workspace in the device's
    // profile) BEFORE snapshotting — the snapshot is the state a real session would actually run
    // against, not an empty-store edge case the dispatcher would refuse before touching anything.
    await store.mutate("seed-fixture-workspace", (draft) => {
      draft.workspaces = [
        { id: "ws-1", profileId: "default", kind: "task", name: "Fix the parser", task: { taskId: "task-1" } },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ] as any;
      return draft;
    });
    const stateBefore = await fs.readFile(statePath);

    const credentialsPath = path.join(dir, "credentials.json");
    const credentialStore = await createCredentialStore(credentialsPath);
    await credentialStore.setSecret("ssh:key:decoy", "not-a-real-secret", { forcePlaintext: true });
    const credentialsBefore = await fs.readFile(credentialsPath);

    const idempotencyStore = createMobileIdempotencyStore(path.join(dir, "idempotency.db"));
    const auditLogStore = createMobileAuditLogStore(path.join(dir, "audit.db"));
    openStores.push(idempotencyStore, auditLogStore);
    const runtime = createFakeRuntime();
    const ticketStore = createMobileWebSessionTicketStore();
    const notificationOrigins = createMobileNotificationOriginStore();
    const e2e = makeE2eDeps();
    const dispatcher = createMobileCommandDispatcher({
      getState: () => store.getState(),
      runtime,
      idempotencyStore,
      auditLogStore,
      ticketIssuer: ticketStore,
      notificationOrigins,
      relay: { status: () => READY_RELAY },
      ownPrivateKey: e2e.ownPrivateKey,
      e2eOfferStore: e2e.offerStore,
      e2eSessionStore: e2e.sessionStore,
    });
    const { device } = makeE2eDevice();

    const endpointResult = await dispatcher.dispatch(
      makeCommand({ type: "remote.endpoint.request", payload: {} }),
      device,
    );
    const desktopOffer = (endpointResult.data as { e2e: RelayE2eDesktopOffer }).e2e;
    const phoneEphemeral = generateX25519KeyPair();
    const issueResult = await dispatcher.dispatch(
      makeCommand({
        commandId: "cmd-2",
        idempotencyKey: "idem-2",
        type: "remote.webSession.issue",
        payload: {
          allowedOrigin: RELAY_ORIGIN,
          e2e: {
            v: 1,
            keyId: desktopOffer.keyId,
            phoneEphemeralPub: exportRawPublicKey(phoneEphemeral.publicKey).toString("base64"),
          },
        },
      }),
      device,
    );
    expect(issueResult.status).toBe("succeeded");
    const derivedKeys = e2e.sessionStore.get(device.deviceId);
    expect(derivedKeys).not.toBeNull();

    // Actually use the derived keys the way a live relay session would — seal and open a frame —
    // rather than only deriving and discarding them, so "a session" means more than a handshake.
    const aad = Buffer.from(
      JSON.stringify({
        v: RELAY_PROTOCOL_VERSION,
        t: "e2e.data",
        src: "connector",
        dst: "viewer",
        s: "s-1",
        id: "id-1",
        q: 0,
      }),
      "utf8",
    );
    const sealed = sealRelayE2eFrame(Buffer.from("hello from a live session"), derivedKeys!.desktopToPhone, 0n, aad);
    const opened = openRelayE2eFrame(sealed, derivedKeys!.desktopToPhone, aad);
    expect(opened.toString("utf8")).toBe("hello from a live session");

    const stateAfter = await fs.readFile(statePath);
    const credentialsAfter = await fs.readFile(credentialsPath);
    expect(stateAfter.equals(stateBefore)).toBe(true);
    expect(credentialsAfter.equals(credentialsBefore)).toBe(true);

    // Not just "nothing changed yet, by luck": the derived key material itself never appears in
    // either file's bytes, base64-encoded or raw.
    for (const key of [derivedKeys!.desktopToPhone, derivedKeys!.phoneToDesktop]) {
      expect(stateAfter.toString("latin1")).not.toContain(key.toString("base64"));
      expect(credentialsAfter.toString("latin1")).not.toContain(key.toString("base64"));
      expect(stateAfter.includes(key)).toBe(false);
      expect(credentialsAfter.includes(key)).toBe(false);
    }
  });
});
