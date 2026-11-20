import { constants as cryptoConstants } from "node:crypto";
import https from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { TLSSocket } from "node:tls";
import type { z } from "zod";
import {
  peerDirectoryListSchema,
  peerPairBeginSchema,
  peerPairRevealSchema,
  peerPairStatusSchema,
  type PeerAttentionSummary,
  type PeerDirectoryListing,
  type PeerHello,
} from "../shared/peers.js";
import { getLogger } from "./logger.js";
import { isPeerDeniedRoute } from "./peer-session-route-policy.js";
import { PEER_PAIRING_IDENTITY, PEER_TLS_OPTIONS } from "./peers/peer-crypto.js";
import { PeerDirectoryError } from "./peers/peer-directories.js";
import { PeerPairingError, type PeerHost } from "./peers/peer-host.js";

const log = getLogger("peers");

/**
 * Set here from the TLS identity and read by `remote-server.ts` in place of a cookie or a token.
 * Whatever a client sends under this name is overwritten.
 */
export const PEER_SESSION_HEADER = "x-strideterm-peer-session";

export type PeerOriginHost = Pick<
  PeerHost,
  "pskForIdentity" | "beginPairing" | "revealPairing" | "pairingStatus" | "noteDeviceSeen"
>;

const PAIRING_BODY_MAX_BYTES = 16 * 1024;
const PAIRING_RATE_WINDOW_MS = 60_000;
const PAIRING_RATE_PER_ADDRESS = 20;
const PAIRING_RATE_OVERALL = 200;
const HANDSHAKE_FAILURE_WINDOW_MS = 5 * 60_000;
const HANDSHAKE_FAILURE_LIMIT = 10;
const HANDSHAKE_BLOCK_MS = 15 * 60_000;
const REVOKED_SOCKET_GRACE_MS = 1_000;
const MAX_TRACKED_ADDRESSES = 512;

const PAIRING_ERROR_STATUS: Record<PeerPairingError["code"], number> = {
  "hosting-disabled": 403,
  "too-many-requests": 429,
  "not-found": 404,
  "commitment-mismatch": 400,
  "storage-unavailable": 503,
};

/** Routes answered right at the front door for a paired device, with the one method each takes. */
const PEER_DEVICE_ROUTES: Record<string, string> = {
  "/api/peer/hello": "GET",
  "/api/peer/attention": "GET",
  "/api/peer/fs/list": "POST",
};

interface CountWindow {
  start: number;
  count: number;
  blockedUntil: number;
}

class BadPairingRequest extends Error {}

function parseBody<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const result = schema.safeParse(body);
  if (!result.success) throw new BadPairingRequest("The pairing request is not valid.");
  return result.data;
}

function reply(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

function readSmallJson(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > PAIRING_BODY_MAX_BYTES) {
        request.destroy();
        reject(new BadPairingRequest("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(new BadPairingRequest("Invalid JSON body"));
      }
    });
    request.on("error", reject);
  });
}

export interface PeerFrontDoor {
  server: https.Server;
  /** Ends every open connection that was authenticated as `deviceId`. */
  destroyDeviceConnections(deviceId: string): void;
}

/**
 * The TLS-PSK listener of a peer origin. The TLS identity is the only credential: it is checked on
 * every request and upgrade, and a request that passes is handed to the ordinary remote request path
 * with a session header the server sets itself.
 */
export function createPeerFrontDoor(deps: {
  peerHost: PeerOriginHost;
  hello(): PeerHello;
  /** Sub-folders of one folder on this machine; throws `PeerDirectoryError` for a refusal the device can read. */
  listDirectories(path: string): Promise<PeerDirectoryListing>;
  /** Alert counts per profile, no text. */
  attention(): PeerAttentionSummary;
  clientIdOf(requestUrl: string, headers: IncomingMessage["headers"]): string;
  /** The ordinary remote request path, reached only with the session header set. */
  serve(request: IncomingMessage, response: ServerResponse): Promise<void>;
  upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void;
}): PeerFrontDoor {
  const identities = new WeakMap<TLSSocket, string>();
  const liveSockets = new Set<TLSSocket>();
  const upgraded = new WeakSet<Duplex>();
  const failures = new Map<string, CountWindow>();
  const pairingByAddress = new Map<string, CountWindow>();
  let pairingOverall: CountWindow = { start: 0, count: 0, blockedUntil: 0 };

  function isBlocked(address: string): boolean {
    return (failures.get(address)?.blockedUntil ?? 0) > Date.now();
  }

  function noteHandshakeFailure(address: string, reason: string): void {
    const now = Date.now();
    if (failures.size >= MAX_TRACKED_ADDRESSES && !failures.has(address)) {
      for (const [key, entry] of failures) {
        if (entry.blockedUntil <= now && now - entry.start >= HANDSHAKE_FAILURE_WINDOW_MS) failures.delete(key);
      }
      if (failures.size >= MAX_TRACKED_ADDRESSES) failures.delete(failures.keys().next().value as string);
    }
    let window = failures.get(address);
    if (!window || (window.blockedUntil <= now && now - window.start >= HANDSHAKE_FAILURE_WINDOW_MS)) {
      window = { start: now, count: 0, blockedUntil: 0 };
    }
    window.count += 1;
    if (window.count > HANDSHAKE_FAILURE_LIMIT && window.blockedUntil <= now) {
      window.blockedUntil = now + HANDSHAKE_BLOCK_MS;
      log.warn("peer address blocked after repeated handshake failures", { address });
    }
    failures.set(address, window);
    log.warn("peer handshake failed", { address, reason });
  }

  function pairingRateLimited(address: string): boolean {
    const now = Date.now();
    if (now - pairingOverall.start >= PAIRING_RATE_WINDOW_MS) {
      pairingOverall = { start: now, count: 0, blockedUntil: 0 };
    }
    let window = pairingByAddress.get(address);
    if (!window || now - window.start >= PAIRING_RATE_WINDOW_MS) {
      if (pairingByAddress.size >= MAX_TRACKED_ADDRESSES) {
        for (const [key, entry] of pairingByAddress) {
          if (now - entry.start >= PAIRING_RATE_WINDOW_MS) pairingByAddress.delete(key);
        }
        if (pairingByAddress.size >= MAX_TRACKED_ADDRESSES) {
          pairingByAddress.delete(pairingByAddress.keys().next().value as string);
        }
      }
      window = { start: now, count: 0, blockedUntil: 0 };
      pairingByAddress.set(address, window);
    }
    window.count += 1;
    pairingOverall.count += 1;
    return window.count > PAIRING_RATE_PER_ADDRESS || pairingOverall.count > PAIRING_RATE_OVERALL;
  }

  async function handlePairing(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<void> {
    const address = request.socket.remoteAddress || "unknown";
    if (request.method !== "POST") {
      reply(response, 403, { error: "Not available on this connection." });
      return;
    }
    if (pairingRateLimited(address)) {
      log.warn("peer pairing rate-limited", { address });
      reply(response, 429, { error: "Too many requests." });
      return;
    }
    try {
      const body = await readSmallJson(request);
      if (pathname === "/api/peer/pair/begin") {
        const input = parseBody(peerPairBeginSchema, body);
        reply(response, 200, await deps.peerHost.beginPairing(input, address));
      } else if (pathname === "/api/peer/pair/reveal") {
        const input = parseBody(peerPairRevealSchema, body);
        reply(response, 200, deps.peerHost.revealPairing(input));
      } else {
        const input = parseBody(peerPairStatusSchema, body);
        reply(response, 200, deps.peerHost.pairingStatus(input.pairingId));
      }
    } catch (error) {
      if (error instanceof PeerPairingError) {
        reply(response, PAIRING_ERROR_STATUS[error.code], { error: error.message });
      } else if (error instanceof BadPairingRequest) {
        reply(response, 400, { error: error instanceof Error ? error.message : "Invalid request." });
      } else {
        log.error("peer pairing request failed", { path: pathname, err: errorText(error) });
        reply(response, 500, { error: "Pairing failed." });
      }
    }
  }

  /** The identity is only trusted while the host still lists it: a removed device must not ride an open socket. */
  function identityOf(socket: TLSSocket): string {
    const identity = identities.get(socket) ?? "";
    if (!identity || !deps.peerHost.pskForIdentity(identity)) return "";
    return identity;
  }

  function scrub(request: IncomingMessage, sessionId: string): void {
    delete request.headers.authorization;
    delete request.headers.cookie;
    delete request.headers["cf-connecting-ip"];
    request.headers[PEER_SESSION_HEADER] = sessionId;
  }

  async function handleDirectoryList(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const parsed = peerDirectoryListSchema.safeParse(await readSmallJson(request));
      if (!parsed.success) {
        reply(response, 400, { error: "The folder request is not valid." });
        return;
      }
      reply(response, 200, await deps.listDirectories(parsed.data.path));
    } catch (error) {
      if (error instanceof PeerDirectoryError) {
        reply(response, error.status, { error: error.message });
      } else if (error instanceof BadPairingRequest) {
        reply(response, 400, { error: error.message });
      } else {
        log.error("peer folder listing failed", { err: errorText(error) });
        reply(response, 500, { error: "The folder could not be listed." });
      }
    }
  }

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const identity = identityOf(request.socket as TLSSocket);
    if (!identity) {
      request.socket.destroy();
      return;
    }
    let pathname: string;
    try {
      pathname = new URL(request.url || "/", "http://localhost").pathname;
    } catch {
      reply(response, 400, { error: "Malformed request target." });
      return;
    }
    if (!pathname.startsWith("/api/")) {
      reply(response, 404, { error: "Not found" });
      return;
    }
    const isPairingRoute =
      pathname === "/api/peer/pair/begin" ||
      pathname === "/api/peer/pair/reveal" ||
      pathname === "/api/peer/pair/status";
    if (identity === PEER_PAIRING_IDENTITY) {
      if (isPairingRoute) await handlePairing(request, response, pathname);
      else reply(response, 403, { error: "Not available on this connection." });
      return;
    }
    if (isPairingRoute) {
      reply(response, 403, { error: "Not available on this connection." });
      return;
    }
    const peerRoute = PEER_DEVICE_ROUTES[pathname];
    if (pathname.startsWith("/api/mobile/") || (pathname.startsWith("/api/peer/") && !peerRoute)) {
      reply(response, 404, { error: "Not found" });
      return;
    }
    if (peerRoute) {
      if (request.method !== peerRoute) {
        reply(response, 404, { error: "Not found" });
        return;
      }
      deps.peerHost.noteDeviceSeen(identity, request.socket.remoteAddress || "");
      if (pathname === "/api/peer/hello") reply(response, 200, deps.hello());
      else if (pathname === "/api/peer/attention") reply(response, 200, deps.attention());
      else await handleDirectoryList(request, response);
      return;
    }
    if (isPeerDeniedRoute(pathname)) {
      reply(response, 403, { error: "Not available to an attached desktop." });
      return;
    }
    const clientId = deps.clientIdOf(request.url || "/", request.headers);
    if (!clientId) {
      reply(response, 400, { error: "A valid X-Strideterm-Client-Id header is required." });
      return;
    }
    deps.peerHost.noteDeviceSeen(identity, request.socket.remoteAddress || "");
    scrub(request, `peer:${identity}:${clientId}`);
    await deps.serve(request, response);
  }

  function refuseUpgrade(socket: Duplex, status: string): void {
    socket.write(`HTTP/1.1 ${status}\r\n\r\n`);
    socket.destroy();
  }

  function handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const identity = identityOf(request.socket as TLSSocket);
    if (!identity) {
      socket.destroy();
      return;
    }
    let pathname: string;
    try {
      pathname = new URL(request.url || "/", "http://localhost").pathname;
    } catch {
      refuseUpgrade(socket, "400 Bad Request");
      return;
    }
    if (identity === PEER_PAIRING_IDENTITY) {
      refuseUpgrade(socket, "403 Forbidden");
      return;
    }
    if (pathname !== "/ws") {
      refuseUpgrade(socket, "404 Not Found");
      return;
    }
    const clientId = deps.clientIdOf(request.url || "/", request.headers);
    if (!clientId) {
      refuseUpgrade(socket, "400 Bad Request");
      return;
    }
    deps.peerHost.noteDeviceSeen(identity, request.socket.remoteAddress || "");
    scrub(request, `peer:${identity}:${clientId}`);
    upgraded.add(request.socket);
    deps.upgrade(request, socket, head);
  }

  const server = https.createServer(
    {
      ...PEER_TLS_OPTIONS,
      // A resumed TLS session skips pskCallback, so a removed device would keep getting in.
      secureOptions: cryptoConstants.SSL_OP_NO_TICKET,
      pskCallback: (socket: TLSSocket, identity: string) => {
        const psk = deps.peerHost.pskForIdentity(identity);
        if (!psk) return null;
        identities.set(socket, identity);
        return psk;
      },
    },
    (request, response) => {
      handleRequest(request, response).catch((error: unknown) => {
        log.error("peer request failed", { err: errorText(error) });
        try {
          if (!response.headersSent) reply(response, 500, { error: "Internal server error" });
          else response.end();
        } catch {
          request.socket.destroy();
        }
      });
    },
  );
  server.on("newSession", (_id, _data, callback) => callback());
  server.on("resumeSession", (_id, callback) => callback(null, undefined));
  server.on("connection", (socket) => {
    if (isBlocked(socket.remoteAddress || "unknown")) socket.destroy();
  });
  server.on("secureConnection", (socket) => {
    liveSockets.add(socket);
    socket.on("close", () => liveSockets.delete(socket));
  });
  server.on("tlsClientError", (error, socket) => {
    noteHandshakeFailure(socket.remoteAddress || "unknown", (error as NodeJS.ErrnoException).code || error.message);
  });
  server.on("upgrade", (request, socket, head) => {
    try {
      handleUpgrade(request, socket, head);
    } catch (error) {
      log.error("peer upgrade failed", { err: errorText(error) });
      socket.destroy();
    }
  });

  return {
    server,
    destroyDeviceConnections(deviceId) {
      for (const socket of [...liveSockets]) {
        if (identities.get(socket) !== deviceId) continue;
        if (!upgraded.has(socket)) {
          socket.destroy();
          continue;
        }
        // The 1008 close frame is already queued; end() lets it out before the connection goes.
        socket.end();
        setTimeout(() => socket.destroy(), REVOKED_SOCKET_GRACE_MS).unref();
      }
    },
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
