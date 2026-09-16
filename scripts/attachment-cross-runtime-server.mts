import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { startRemoteServer } from "../electron/backend/remote-server.js";
import { exportRawPublicKey, x25519KeyPairFromSeed } from "../electron/backend/mobile/mobile-crypto.js";

const root = process.env.ATTACHMENT_WORKSPACE_ROOT;
if (!root) throw new Error("ATTACHMENT_WORKSPACE_ROOT is required");
await mkdir(root, { recursive: true });

const desktop = x25519KeyPairFromSeed(Buffer.alloc(32, 0x22));
const phone = x25519KeyPairFromSeed(Buffer.alloc(32, 0x11));
const now = Date.now();
const payload = {
  appState: {
    settings: { remoteAccess: { enabled: true, host: "127.0.0.1", port: 0, token: "test-token" } },
    profiles: [{ id: "default", name: "Default", workspaceIds: ["workspace-cross-runtime"] }],
    workspaces: [{ id: "workspace-cross-runtime", profileId: "default", kind: "manual", cwd: root, panels: [] }],
    windowSlots: [],
  },
};
const device = {
  publicKey: exportRawPublicKey(phone.publicKey).toString("base64"),
  pairId: "pair-1",
  sessionKeyVersion: 1,
  capabilities: ["remote.webSession"],
  profileAllowlist: ["default"],
  revoked: false,
  state: "active",
};
const runtime = {
  getPayload: () => payload,
  getInitialState: async () => payload,
  setRemoteInfo: () => undefined,
  listRemoteUrls: () => [],
  listMobileTicketOrigins: () => ["http://127.0.0.1"],
  on: () => () => undefined,
  isMobileSessionStillAuthorized: () => true,
  activateProfileForRemoteClient: async () => undefined,
  getMobileAttachmentContext: () => ({ desktopDeviceId: "desktop-1", privateKey: desktop.privateKey, device }),
  consumeMobileWebSessionTicket: (ticketId: string, secret: string) =>
    ticketId === "ticket-cross-runtime" && secret === "secret-cross-runtime"
      ? {
          deviceId: "phone-1",
          pairId: "pair-1",
          profileId: "default",
          allowedOrigin: "http://127.0.0.1",
          transport: "legacy" as const,
          requiredCapability: "remote.webSession" as const,
          expiresAt: now + 60_000,
        }
      : null,
};

const guardToken = "attachment-cross-runtime-guard";
const server = await startRemoteServer({
  runtime: runtime as never,
  staticRoot: process.cwd(),
  loopbackOrigin: {
    host: "127.0.0.1",
    port: 0,
    guardToken,
    publicOrigin: "http://127.0.0.1",
  },
});
const address = server.address;
if (!address) throw new Error("Attachment test server did not bind a port");
process.stdout.write(
  `${JSON.stringify({
    baseUrl: `http://127.0.0.1:${address.port}`,
    workspaceRoot: root,
    ticketId: "ticket-cross-runtime",
    secret: "secret-cross-runtime",
    guardToken,
    pairId: "pair-1",
    sourceDeviceId: "phone-1",
    targetDeviceId: "desktop-1",
    sessionKeyVersion: 1,
    mobilePrivateSeedHex: "11".repeat(32),
    desktopPublicKeyBase64: exportRawPublicKey(desktop.publicKey).toString("base64"),
    expectedPayloadSha256: createHash("sha256")
      .update(Buffer.alloc(5 * 1024 * 1024, 7))
      .digest("hex"),
  })}\n`,
);

const close = async () => {
  await server.close();
  process.exit(0);
};
process.once("SIGTERM", () => void close());
process.once("SIGINT", () => void close());
process.stdin.resume();
