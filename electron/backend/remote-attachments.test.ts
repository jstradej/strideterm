import { describe, expect, test } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import {
  generateX25519KeyPair,
  exportRawPublicKey,
  deriveSessionKey,
  sealEnvelope,
  openEnvelope,
} from "./mobile/mobile-crypto.js";
import { startRemoteServer } from "./remote-server.js";

describe("encrypted mobile attachment route", () => {
  test("transfers, resumes, lists and deletes encrypted attachment data", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "strideterm-mobile-attachment-"));
    const port = await getFreePort();
    const desktop = generateX25519KeyPair();
    const phone = generateX25519KeyPair();
    const now = Date.now();
    const payload = {
      appState: {
        settings: { remoteAccess: { enabled: true, host: "127.0.0.1", port, token: "master" } },
        profiles: [
          { id: "default", name: "Default", workspaceIds: ["ws"] },
          { id: "other", name: "Other", workspaceIds: ["other-ws"] },
        ],
        workspaces: [
          { id: "ws", profileId: "default", kind: "manual", cwd: root, panels: [] },
          { id: "other-ws", profileId: "other", kind: "manual", cwd: root, panels: [] },
        ],
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
    let authorized = true;
    const runtime = {
      getPayload: () => payload,
      getInitialState: async () => payload,
      setRemoteInfo: () => undefined,
      listRemoteUrls: () => [],
      listMobileTicketOrigins: () => ["http://127.0.0.1"],
      on: () => () => undefined,
      isMobileSessionStillAuthorized: () => authorized,
      activateProfileForRemoteClient: async () => undefined,
      getMobileAttachmentContext: () => ({ desktopDeviceId: "desktop-1", privateKey: desktop.privateKey, device }),
      consumeMobileWebSessionTicket: (ticketId: string, secret: string) => {
        if ((ticketId !== "t" || secret !== "s") && (ticketId !== "t-other" || secret !== "s-other")) return null;
        return {
          deviceId: "phone-1",
          pairId: "pair-1",
          profileId: ticketId === "t-other" ? "other" : "default",
          allowedOrigin: "http://127.0.0.1",
          transport: "legacy" as const,
          requiredCapability: "remote.webSession" as const,
          expiresAt: now + 60_000,
        };
      },
    };
    const server = await startRemoteServer({ runtime: runtime as never, staticRoot: process.cwd() });
    const base = `http://127.0.0.1:${port}`;
    try {
      const boot = await fetch(`${base}/api/mobile/session/bootstrap`, {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ticketId: "t", secret: "s" }),
      });
      const cookie = (boot.headers.get("set-cookie") ?? "").split(";")[0];
      const key = deriveSessionKey(
        desktop.privateKey,
        phone.publicKey,
        Buffer.from("pair-1"),
        Buffer.from("strideterm/attachments/v1"),
      );
      const send = async (
        operation: string,
        operationPayload: Record<string, unknown>,
        sessionCookie = cookie,
        tamper = false,
      ) => {
        const requestId = randomUUID();
        const issuedAt = Date.now();
        const expiresAt = issuedAt + 60_000;
        const sealed = sealEnvelope(
          Buffer.from(JSON.stringify({ operation, payload: operationPayload, issuedAt, expiresAt })),
          key,
          Buffer.from(`strideterm-attachment-v1|1|1|request|pair-1|phone-1|desktop-1|${requestId}`),
        );
        const response = await fetch(`${base}/api/mobile/attachments`, {
          method: "POST",
          headers: { "content-type": "application/json", Cookie: sessionCookie },
          body: JSON.stringify({
            version: 1,
            requestId,
            pairId: "pair-1",
            sourceDeviceId: "phone-1",
            targetDeviceId: "desktop-1",
            sessionKeyVersion: 1,
            issuedAt,
            expiresAt,
            nonce: (tamper ? Buffer.from(sealed.nonce).fill(0) : sealed.nonce).toString("base64url"),
            ciphertext: sealed.ciphertext.toString("base64url"),
          }),
        });
        if (response.status !== 200) return { response, value: undefined };
        const outer = await response.json();
        const value = JSON.parse(
          openEnvelope(
            Buffer.from(outer.ciphertext, "base64url"),
            Buffer.from(outer.nonce, "base64url"),
            key,
            Buffer.from(`strideterm-attachment-v1|1|1|response|pair-1|phone-1|desktop-1|${requestId}`),
          ).toString("utf8"),
        );
        return { response, value };
      };
      const data = Buffer.alloc(5 * 1024 * 1024, 7);
      const sha256 = createHash("sha256").update(data).digest("hex");
      const begin = await send("attachment.begin", {
        workspaceId: "ws",
        name: "a.bin",
        size: data.length,
        sha256,
        idempotencyKey: "idem",
      });
      expect(begin.response.status).toBe(200);
      const transferId = begin.value.transferId as string;
      expect(transferId).toBeTruthy();
      for (let offset = 0; offset < data.length; offset += 512 * 1024) {
        const end = Math.min(offset + 512 * 1024, data.length);
        const chunk = await send("attachment.chunk", {
          workspaceId: "ws",
          transferId,
          offset,
          // Dart's base64UrlEncode retains '=' padding; accept that wire form.
          data: (() => {
            const encoded = data.subarray(offset, end).toString("base64url");
            return encoded + "=".repeat((4 - (encoded.length % 4)) % 4);
          })(),
        });
        expect(chunk.value.offset).toBe(end);
      }
      const finish = await send("attachment.finish", { workspaceId: "ws", transferId });
      expect(finish.value.sha256).toBe(sha256);
      expect(await readFile(path.join(root, ".strideterm/attachments", transferId, "a.bin"))).toEqual(data);
      const status = await send("attachment.status", { workspaceId: "ws", transferId });
      expect(status.value.state).toBe("complete");
      expect(status.value.offset).toBe(data.length);
      const listed = await send("attachment.list", { workspaceId: "ws" });
      expect(listed.value.attachments).toHaveLength(1);
      const crossProfile = await send("attachment.list", { workspaceId: "other-ws" });
      expect(crossProfile.value.error.code).toBe("attachment-failed");
      const switched = await fetch(`${base}/api/remote-client/profile/activate`, {
        method: "POST",
        headers: { "content-type": "application/json", Cookie: cookie },
        body: JSON.stringify({ profileId: "other" }),
      });
      expect(switched.status, await switched.text()).toBe(200);
      const switchedProfile = await send("attachment.list", { workspaceId: "other-ws" });
      expect(switchedProfile.value.attachments).toHaveLength(1);
      const sharedRemoved = await send("attachment.delete", { workspaceId: "other-ws", transferId, name: "a.bin" });
      expect(sharedRemoved.value.ok).toBe(true);
      expect((await send("attachment.list", { workspaceId: "other-ws" })).value.attachments).toHaveLength(0);
      const tampered = await send("attachment.list", { workspaceId: "ws" }, cookie, true);
      expect(tampered.response.status).toBe(403);
      authorized = false;
      const revoked = await send("attachment.list", { workspaceId: "ws" });
      expect(revoked.response.status).toBe(401);
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function getFreePort() {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address() as net.AddressInfo;
  const port = address.port;
  await new Promise<void>((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
  return port;
}
