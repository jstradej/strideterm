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
        name: "a.txt",
        size: data.length,
        sha256,
        idempotencyKey: "idem",
      });
      expect(begin.response.status).toBe(200);
      const transferId = begin.value.transferId as string;
      expect(transferId).toBeTruthy();

      // `idempotencyKey` is genuinely optional (mobileAttachmentOperationSchema) — a begin that
      // omits it entirely must not be refused as though an empty key had been sent on purpose.
      const noKeyBegin = await send("attachment.begin", {
        workspaceId: "ws",
        name: "no-idempotency-key.txt",
        size: 3,
        sha256: createHash("sha256").update(Buffer.from("abc")).digest("hex"),
      });
      expect(noKeyBegin.response.status).toBe(200);
      expect(noKeyBegin.value.transferId).toBeTruthy();
      await send("attachment.cancel", { workspaceId: "ws", transferId: noKeyBegin.value.transferId });

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
      expect(await readFile(path.join(root, ".strideterm/attachments", transferId, "a.txt"))).toEqual(data);
      const status = await send("attachment.status", { workspaceId: "ws", transferId });
      expect(status.value.state).toBe("complete");
      expect(status.value.offset).toBe(data.length);
      const listed = await send("attachment.list", { workspaceId: "ws" });
      expect(listed.value.attachments).toHaveLength(1);
      const crossProfile = await send("attachment.list", { workspaceId: "other-ws" });
      expect(crossProfile.value.error.code).toBe("attachment-failed");
      // Too many transfers at once is "busy, try later", never the storage quota: deleting a file would not help.
      const partials: string[] = [];
      for (let i = 0; i < 4; i++) {
        const partial = await send("attachment.begin", {
          workspaceId: "ws",
          name: `busy-${i}.txt`,
          size: 3,
          sha256: createHash("sha256").update(Buffer.from("abc")).digest("hex"),
          idempotencyKey: `busy-${i}`,
        });
        partials.push(partial.value.transferId as string);
      }
      const busy = await send("attachment.begin", {
        workspaceId: "ws",
        name: "busy-5.txt",
        size: 3,
        sha256: createHash("sha256").update(Buffer.from("abc")).digest("hex"),
        idempotencyKey: "busy-5",
      });
      expect(busy.value.error.code).toBe("attachment-transfer-limit");
      for (const partial of partials) await send("attachment.cancel", { workspaceId: "ws", transferId: partial });
      const switched = await fetch(`${base}/api/remote-client/profile/activate`, {
        method: "POST",
        headers: { "content-type": "application/json", Cookie: cookie },
        body: JSON.stringify({ profileId: "other" }),
      });
      expect(switched.status, await switched.text()).toBe(200);
      const switchedProfile = await send("attachment.list", { workspaceId: "other-ws" });
      expect(switchedProfile.value.attachments).toHaveLength(1);
      const sharedRemoved = await send("attachment.delete", { workspaceId: "other-ws", transferId, name: "a.txt" });
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
  }, 90_000);
});

async function getFreePort() {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address() as net.AddressInfo;
  const port = address.port;
  await new Promise<void>((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
  return port;
}

describe("desktop-class attachment routes", () => {
  const routes = [
    "/api/attachment/upload/begin",
    "/api/attachment/upload/chunk",
    "/api/attachment/upload/finish",
    "/api/attachment/upload/cancel",
    "/api/attachment/read",
  ];

  type Ctx = {
    root: string;
    call: (
      route: string,
      body: unknown,
      options?: { client?: string | null; profile?: string; cookie?: string },
    ) => Promise<{ status: number; body: Record<string, unknown> }>;
    phoneCookie: () => Promise<string>;
  };

  async function withServer(run: (ctx: Ctx) => Promise<void>) {
    const root = await mkdtemp(path.join(os.tmpdir(), "strideterm-remote-upload-"));
    const otherRoot = await mkdtemp(path.join(os.tmpdir(), "strideterm-remote-upload-other-"));
    const port = await getFreePort();
    const desktop = generateX25519KeyPair();
    const phone = generateX25519KeyPair();
    const payload = {
      appState: {
        settings: { remoteAccess: { enabled: true, host: "127.0.0.1", port, token: "master" } },
        profiles: [
          { id: "default", name: "Default", workspaceIds: ["ws", "ssh-ws", "box-ws"] },
          { id: "other", name: "Other", workspaceIds: ["other-ws"] },
        ],
        workspaces: [
          { id: "ws", profileId: "default", kind: "manual", cwd: root, panels: [] },
          { id: "other-ws", profileId: "other", kind: "manual", cwd: otherRoot, panels: [] },
          { id: "ssh-ws", profileId: "default", kind: "ssh", cwd: root, panels: [] },
          {
            id: "box-ws",
            profileId: "default",
            kind: "manual",
            cwd: root,
            panels: [{ launch: { kind: "container" } }],
          },
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
        ticketId === "t" && secret === "s"
          ? {
              deviceId: "phone-1",
              pairId: "pair-1",
              profileId: "default",
              allowedOrigin: "http://127.0.0.1",
              transport: "legacy" as const,
              requiredCapability: "remote.webSession" as const,
              expiresAt: Date.now() + 60_000,
            }
          : null,
    };
    const server = await startRemoteServer({ runtime: runtime as never, staticRoot: process.cwd() });
    const base = `http://127.0.0.1:${port}`;
    const makeCtx = (): Ctx => ({
      root,
      call: async (
        route: string,
        body: unknown,
        options: { client?: string | null; profile?: string; cookie?: string } = {},
      ) => {
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (options.cookie) headers.Cookie = options.cookie;
        else headers.Authorization = "Bearer master";
        if (options.client !== null && !options.cookie)
          headers["X-Strideterm-Client-Id"] = options.client ?? "client-a";
        const response = await fetch(`${base}${route}?profileId=${options.profile ?? "default"}`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });
        return { status: response.status, body: (await response.json()) as Record<string, unknown> };
      },
      phoneCookie: async () => {
        const boot = await fetch(`${base}/api/mobile/session/bootstrap`, {
          method: "POST",
          redirect: "manual",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ticketId: "t", secret: "s" }),
        });
        return (boot.headers.get("set-cookie") ?? "").split(";")[0];
      },
    });
    try {
      await run(makeCtx());
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
      await rm(otherRoot, { recursive: true, force: true });
    }
  }

  test("uploads in blocks, finishes with the list record, reads it back and refuses another client", async () => {
    await withServer(async ({ call, root }) => {
      const data = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(600 * 1024, 9)]);
      const begin = await call("/api/attachment/upload/begin", {
        workspaceId: "ws",
        name: "pic.png",
        size: data.length,
      });
      expect(begin.status, JSON.stringify(begin.body)).toBe(200);
      expect(begin.body).toMatchObject({ chunkBytes: 512 * 1024, received: 0 });
      const transferId = begin.body.transferId as string;
      const block = (offset: number) => ({
        workspaceId: "ws",
        transferId,
        offset,
        data: data.subarray(offset, offset + 512 * 1024).toString("base64"),
      });

      expect((await call("/api/attachment/upload/chunk", block(0), { client: "client-b" })).status).toBe(400);
      expect((await call("/api/attachment/upload/chunk", block(0))).body).toEqual({ received: 512 * 1024 });
      expect((await call("/api/attachment/upload/chunk", block(512 * 1024))).body).toEqual({ received: data.length });
      const refused = await call(
        "/api/attachment/upload/finish",
        { workspaceId: "ws", transferId },
        { client: "client-b" },
      );
      expect(refused.status).toBe(400);
      expect(refused.body.error).toMatch(/owner/);

      const finished = await call("/api/attachment/upload/finish", { workspaceId: "ws", transferId });
      expect(finished.status).toBe(200);
      expect(finished.body).toMatchObject({
        transferId,
        name: "pic.png",
        size: data.length,
        sha256: createHash("sha256").update(data).digest("hex"),
      });
      expect(await readFile(path.join(root, finished.body.path as string))).toEqual(data);

      const listed = await call("/api/attachment/list", { workspaceId: "ws" }, { client: "client-b" });
      expect(listed.body.attachments).toHaveLength(1);
      expect(listed.body.usage).toMatchObject({ dailyLimit: null, fileSizeLimit: 1024 ** 3 });

      const window = await call(
        "/api/attachment/read",
        { workspaceId: "ws", transferId, name: "pic.png", offset: 512 * 1024, length: 512 * 1024 },
        { client: "client-b" },
      );
      expect(window.status).toBe(200);
      expect(window.body.eof).toBe(true);
      expect(window.body.size).toBe(data.length);
      expect(Buffer.from(window.body.data as string, "base64")).toEqual(data.subarray(512 * 1024));

      const second = await call("/api/attachment/upload/begin", { workspaceId: "ws", name: "gone.png", size: 10 });
      const cancelled = await call("/api/attachment/upload/cancel", {
        workspaceId: "ws",
        transferId: second.body.transferId,
      });
      expect(cancelled.body).toEqual({ ok: true });
    });
  });

  test("refuses another profile's workspace, SSH and container workspaces, bad payloads and a caller without identity", async () => {
    await withServer(async ({ call }) => {
      const begin = { name: "a.png", size: 5 };
      const other = await call("/api/attachment/upload/begin", { workspaceId: "other-ws", ...begin });
      expect(other.status).toBe(400);
      expect(other.body.error).toMatch(/not available in this profile/);
      expect(
        (
          await call(
            "/api/attachment/upload/begin",
            { workspaceId: "other-ws", ...begin },
            { profile: "other", client: "client-o" },
          )
        ).status,
      ).toBe(200);
      for (const workspaceId of ["ssh-ws", "box-ws"]) {
        const refused = await call("/api/attachment/upload/begin", { workspaceId, ...begin });
        expect(refused.status).toBe(400);
        expect(refused.body.error).toMatch(/unavailable for SSH or container/);
      }
      const invalid = await call("/api/attachment/upload/begin", { workspaceId: "ws", name: "a.png", size: 0 });
      expect(invalid.status).toBe(400);
      expect(invalid.body.error).toMatch(/validation failed/);
      const anonymous = await call("/api/attachment/upload/begin", { workspaceId: "ws", ...begin }, { client: null });
      expect(anonymous.status).toBe(400);
      expect(anonymous.body.error).toMatch(/bound session/);
      const unknown = await call("/api/attachment/read", {
        workspaceId: "ws",
        transferId: randomUUID(),
        name: "a.png",
        offset: 0,
        length: 1,
      });
      expect(unknown.status).toBe(400);
      expect(unknown.body.error).toMatch(/not found/);
    });
  });

  test("a quota refusal reaches the client as 4xx JSON that names the limit", async () => {
    await withServer(async ({ call }) => {
      for (let i = 0; i < 4; i++)
        expect(
          (await call("/api/attachment/upload/begin", { workspaceId: "ws", name: `p${i}.zip`, size: 1024 ** 3 }))
            .status,
        ).toBe(200);
      const refused = await call("/api/attachment/upload/begin", { workspaceId: "ws", name: "more.zip", size: 1 });
      expect(refused.status).toBe(400);
      expect(refused.body.error).toBe("Attachment quota exceeded: a workspace holds at most 4 GiB of attachments");
    });
  });

  test("a mobile session is refused on all five routes and a paired desktop is not", async () => {
    await withServer(async ({ call, phoneCookie }) => {
      const cookie = await phoneCookie();
      expect(cookie).toBeTruthy();
      const payloads: Record<string, unknown> = {
        "/api/attachment/upload/begin": { workspaceId: "ws", name: "a.png", size: 5 },
        "/api/attachment/upload/chunk": { workspaceId: "ws", transferId: randomUUID(), offset: 0, data: "AAAA" },
        "/api/attachment/upload/finish": { workspaceId: "ws", transferId: randomUUID() },
        "/api/attachment/upload/cancel": { workspaceId: "ws", transferId: randomUUID() },
        "/api/attachment/read": { workspaceId: "ws", transferId: randomUUID(), name: "a.png", offset: 0, length: 1 },
      };
      for (const route of routes) {
        const refused = await call(route, payloads[route], { cookie });
        expect(refused.status, route).toBe(403);
        expect(refused.body.reason, route).toBe("route-not-available-to-mobile");
      }
      expect((await call("/api/attachment/list", { workspaceId: "ws" }, { cookie })).status).toBe(200);
    });
    const { PEER_DENIED_ROUTES } = await import("./peer-session-route-policy.js");
    for (const route of routes) expect(PEER_DENIED_ROUTES.has(route), route).toBe(false);
  }, 60_000);
});
