import { randomBytes, randomUUID } from "node:crypto";
import https from "node:https";
import { WebSocket } from "ws";
import {
  PEER_PAIRING_TTL_MS,
  PEER_PROTOCOL_VERSION,
  type PeerHello,
  type PeerHostRecord,
  type PeerIntegrationSettings,
  type PeerPairBegin,
  type PeerPairBeginResult,
  type PeerPairStatusResult,
  type PeerPairingEndState,
  type PeerPairingResult,
  type PeerStartedPairing,
} from "../../shared/peers.js";
import {
  exportPrivateKeyPem,
  exportRawPublicKey,
  generateX25519KeyPair,
  importPrivateKeyPem,
} from "../mobile/mobile-crypto.js";
import { getLogger } from "../logger.js";
import type { CredentialStore } from "../shared/credential-store.js";
import {
  PEER_PAIRING_IDENTITY,
  PEER_PAIRING_PSK,
  PEER_TLS_OPTIONS,
  computePeerCommitment,
  computePeerSas,
  derivePeerPsk,
  formatPeerSas,
} from "./peer-crypto.js";

const log = getLogger("peers");

export const peerLinkKeyRef = (hostId: string) => `peer:host-link:${hostId}:key`;

export const PEER_REQUEST_TIMEOUT_MS = 120_000;
export const PEER_MAX_RESPONSE_BYTES = 128 * 1024 * 1024;
const PAIRING_CALL_TIMEOUT_MS = 15_000;
const SOCKET_HANDSHAKE_TIMEOUT_MS = 15_000;
const POLL_FAILURES_BEFORE_GIVING_UP = 3;
/** The host closes an idle keep-alive connection after 100 s; ours go earlier so a request after a pause is not the one that finds out. */
export const PEER_IDLE_SOCKET_MS = 30_000;
const CLIENT_ID_HEADER = "x-strideterm-client-id";
const ALLOWED_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
const DROPPED_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "authorization",
  "cookie",
]);

export type PeerClientErrorCode =
  | "unreachable"
  | "not-paired"
  | "wrong-host"
  | "unknown-host"
  | "invalid-request"
  | "host-error"
  | "storage-unavailable"
  | "cancelled";

export class PeerClientError extends Error {
  constructor(
    readonly code: PeerClientErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "PeerClientError";
  }
}

export type PeerClientEvent = "peers:updated" | "peers:pairing-result";

export type { PeerPairingEndState, PeerPairingResult, PeerStartedPairing };

export interface PeerClientDeps {
  getSettings(): PeerIntegrationSettings;
  updateSettings(reason: string, update: (draft: PeerIntegrationSettings) => void): Promise<void>;
  credentials: Pick<CredentialStore, "getSecret" | "setSecret" | "deleteSecret" | "isEncryptionAvailable">;
  appVersion: string;
  deviceName(): string;
  platform: string;
  emit(event: PeerClientEvent, payload: unknown): void;
  now?(): number;
  randomId?(): string;
  /** Default 2000. */
  pollIntervalMs?: number;
  limits?: { requestTimeoutMs?: number; maxResponseBytes?: number; idleSocketMs?: number };
}

export interface PeerRequest {
  method: string;
  pathname: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface PeerResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export type PeerHostState = "unknown" | "online" | "offline" | "not-paired" | "wrong-host" | "version-mismatch";

export interface PeerHostStatus {
  state: PeerHostState;
  hostAppVersion: string;
  profiles: PeerHello["profiles"];
  checkedAt: number;
}

export interface PeerSocketClose {
  code: number;
  reason: string;
}

export interface PeerClientSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "open", handler: () => void): void;
  on(event: "message", handler: (data: string) => void): void;
  on(event: "close", handler: (info: PeerSocketClose) => void): void;
}

export interface PeerClient {
  ensureInstanceId(): Promise<string>;
  startPairing(target: { address: string; port: number }): Promise<PeerStartedPairing>;
  cancelPairing(attemptId: string): void;
  listHosts(): PeerHostRecord[];
  removeHost(hostId: string): Promise<boolean>;
  updateHostAddress(hostId: string, target: { address: string; port: number }): Promise<boolean>;
  hello(hostId: string): Promise<PeerHello>;
  request(hostId: string, request: PeerRequest): Promise<PeerResponse>;
  openSocket(hostId: string, query: Record<string, string>): PeerClientSocket;
  getHostStatus(hostId: string): PeerHostStatus;
  /**
   * After a `not-paired` failure every link attempt for that host fails locally, because the host locks an address out
   * after repeated refused handshakes. `force` (the user's "Reconnect") lifts that and tries the network once.
   */
  refreshHost(hostId: string, options?: { force?: boolean }): Promise<PeerHostStatus>;
  dispose(): void;
}

interface Target {
  address: string;
  port: number;
}

interface RawRequest {
  method: string;
  pathname: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
  maxBytes: number;
  signal?: AbortSignal;
}

type FailureKind = "refused" | "timeout" | "unreachable" | "tls" | "other";

/** A pooled keep-alive socket the host had already closed: nothing reached the host, so one retry is safe. */
class StaleSocketError extends Error {}

const NETWORK_CODES = new Set(["EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND", "EAI_AGAIN", "ECONNRESET", "EPIPE"]);

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failureKind(error: unknown): FailureKind {
  const code = String((error as { code?: unknown } | null)?.code ?? "");
  if (code === "ECONNREFUSED") return "refused";
  if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") return "timeout";
  if (code.startsWith("ERR_SSL") || code.startsWith("ERR_TLS") || code === "EPROTO") return "tls";
  if (NETWORK_CODES.has(code)) return "unreachable";
  if (/alert|handshake|\bssl\b|\btls\b/i.test(errorText(error))) return "tls";
  return "other";
}

const where = (target: Target) => `${target.address}:${target.port}`;

function networkError(kind: FailureKind, target: Target, cause: unknown): PeerClientError {
  const text =
    kind === "refused"
      ? `Nothing is listening at ${where(target)}. Check the address and port, and that attaching profiles is turned on there.`
      : kind === "timeout"
        ? `${where(target)} did not answer in time.`
        : `${where(target)} cannot be reached from this computer.`;
  return new PeerClientError("unreachable", text, { cause });
}

function isSafeApiPath(pathname: unknown): pathname is string {
  if (typeof pathname !== "string" || !pathname.startsWith("/api/")) return false;
  if (/[\\#\s]/.test(pathname)) return false;
  for (let index = 0; index < pathname.length; index++) {
    const code = pathname.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return false;
  }
  const path = pathname.split("?", 1)[0]!;
  if (path.includes("//")) return false;
  return path.split("/").every((segment) => {
    const lower = segment.toLowerCase();
    return !(lower === "." || lower === ".." || /^(%2e)+$/.test(lower) || /%2f|%5c/.test(lower));
  });
}

function rawRequestOnce(agent: https.Agent, target: Target, options: RawRequest): Promise<PeerResponse> {
  return new Promise<PeerResponse>((resolve, reject) => {
    let settled = false;
    let gotResponse = false;
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      action();
    };
    const fail = (error: Error) => settle(() => reject(error));
    const onAbort = () => {
      fail(new PeerClientError("cancelled", "The request was cancelled."));
      req.destroy();
    };
    const headers = { ...options.headers };
    if (options.body !== undefined) headers["content-length"] = String(Buffer.byteLength(options.body, "utf8"));
    const req = https.request(
      { agent, host: target.address, port: target.port, method: options.method, path: options.pathname, headers },
      (res) => {
        gotResponse = true;
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > options.maxBytes) {
            fail(new PeerClientError("host-error", "The response of the other desktop is too large."));
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          const responseHeaders: Record<string, string> = {};
          for (const [name, value] of Object.entries(res.headers)) {
            if (value !== undefined) {
              responseHeaders[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
            }
          }
          settle(() =>
            resolve({
              status: res.statusCode ?? 0,
              headers: responseHeaders,
              body: Buffer.concat(chunks).toString("utf8"),
            }),
          );
        });
        res.on("error", fail);
        res.on("close", () => fail(new Error("The connection closed before the response was complete.")));
      },
    );
    const timer = setTimeout(() => {
      fail(Object.assign(new Error("The request timed out."), { code: "ETIMEDOUT" }));
      req.destroy();
    }, options.timeoutMs);
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });
    req.on("error", (error: NodeJS.ErrnoException) => {
      if (!gotResponse && req.reusedSocket && error.code === "ECONNRESET") fail(new StaleSocketError());
      else fail(error);
    });
    if (options.body !== undefined) req.write(options.body, "utf8");
    req.end();
  });
}

async function rawRequest(agent: https.Agent, target: Target, options: RawRequest): Promise<PeerResponse> {
  try {
    return await rawRequestOnce(agent, target, options);
  } catch (error) {
    if (!(error instanceof StaleSocketError)) throw error;
  }
  try {
    return await rawRequestOnce(agent, target, options);
  } catch (error) {
    if (error instanceof StaleSocketError) throw Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" });
    throw error;
  }
}

function createPskAgent(psk: Buffer, identity: string, idleSocketMs?: number): https.Agent {
  return new https.Agent({
    keepAlive: true,
    // Node destroys a FREE pooled socket when its timeout fires (`onTimeout` in _http_agent); `keepAliveMsecs` only paces TCP probes.
    ...(idleSocketMs ? { timeout: idleSocketMs } : {}),
    // A cached TLS session is resumed without asking the host's pskCallback again, so a device the host
    // removed would still get in until the ticket expires.
    maxCachedSessions: 0,
    maxSockets: 16,
    ...PEER_TLS_OPTIONS,
    pskCallback: () => ({ psk, identity }),
    checkServerIdentity: () => undefined,
  });
}

interface Link {
  agent: https.Agent;
  hostPublicKey: string;
}

interface PairingAttempt {
  attemptId: string;
  controller: AbortController;
  agent: https.Agent;
  announced: boolean;
  committing: boolean;
  done: boolean;
  wake: (() => void) | null;
}

export function createPeerClient(deps: PeerClientDeps): PeerClient {
  const now = deps.now ?? Date.now;
  const randomId = deps.randomId ?? randomUUID;
  const pollIntervalMs = deps.pollIntervalMs ?? 2000;
  const requestTimeoutMs = deps.limits?.requestTimeoutMs ?? PEER_REQUEST_TIMEOUT_MS;
  const maxResponseBytes = deps.limits?.maxResponseBytes ?? PEER_MAX_RESPONSE_BYTES;
  const idleSocketMs = deps.limits?.idleSocketMs ?? PEER_IDLE_SOCKET_MS;
  const links = new Map<string, Link>();
  const sockets = new Map<string, Set<{ close(code?: number, reason?: string): void }>>();
  const statuses = new Map<string, PeerHostStatus>();
  const refreshes = new Map<string, Promise<PeerHostStatus>>();
  const loggedFailure = new Map<string, string>();
  const notPaired = new Set<string>();
  let instanceInFlight: Promise<string> | null = null;
  let pairing: PairingAttempt | null = null;

  function ensureInstanceId(): Promise<string> {
    const existing = deps.getSettings().instanceId;
    if (existing) return Promise.resolve(existing);
    instanceInFlight ??= (async () => {
      const minted = randomId();
      await deps.updateSettings("peers:instance-id", (draft) => {
        if (!draft.instanceId) draft.instanceId = minted;
      });
      return deps.getSettings().instanceId;
    })().finally(() => {
      instanceInFlight = null;
    });
    return instanceInFlight;
  }

  function findHost(hostId: string): PeerHostRecord | undefined {
    return deps.getSettings().hosts.find((host) => host.id === hostId);
  }

  function dropLink(hostId: string): void {
    links.get(hostId)?.agent.destroy();
    links.delete(hostId);
  }

  function closeSockets(hostId: string, reason: string): void {
    for (const socket of [...(sockets.get(hostId) ?? [])]) socket.close(1000, reason);
  }

  async function getLink(hostId: string): Promise<{ link: Link; host: PeerHostRecord; instanceId: string }> {
    const instanceId = await ensureInstanceId();
    const host = findHost(hostId);
    if (!host) throw new PeerClientError("unknown-host", "This desktop is not attached.");
    const cached = links.get(hostId);
    if (cached && cached.hostPublicKey === host.hostPublicKey) return { link: cached, host, instanceId };
    dropLink(hostId);
    const pem = deps.credentials.getSecret(peerLinkKeyRef(hostId));
    if (!pem) {
      throw new PeerClientError("unknown-host", `The key for ${host.label} is missing. Pair this desktop again.`);
    }
    let psk: Buffer;
    try {
      psk = derivePeerPsk({
        privateKey: importPrivateKeyPem(pem).privateKey,
        remotePublicKey: host.hostPublicKey,
        hostInstanceId: host.id,
        deviceId: instanceId,
      });
    } catch (error) {
      log.error("peer link key cannot be used", { hostId, err: errorText(error) });
      throw new PeerClientError("unknown-host", `The key for ${host.label} cannot be read. Pair this desktop again.`, {
        cause: error,
      });
    }
    const link: Link = { agent: createPskAgent(psk, instanceId, idleSocketMs), hostPublicKey: host.hostPublicKey };
    links.set(hostId, link);
    return { link, host, instanceId };
  }

  function logFailureOnce(host: { id: string; address?: string; port?: number }, code: string): void {
    if (loggedFailure.get(host.id) === code) return;
    loggedFailure.set(host.id, code);
    log.warn("peer link failed", { hostId: host.id, address: host.address, port: host.port, code });
  }

  function translateLinkFailure(host: PeerHostRecord, error: unknown): PeerClientError {
    if (error instanceof PeerClientError) return error;
    const kind = failureKind(error);
    let translated: PeerClientError;
    if (kind === "tls") {
      notPaired.add(host.id);
      translated = new PeerClientError("not-paired", `${host.label} no longer accepts this desktop. Pair it again.`, {
        cause: error,
      });
    } else if (kind === "other") {
      translated = new PeerClientError("host-error", `${host.label} could not be reached: ${errorText(error)}`, {
        cause: error,
      });
    } else {
      translated = networkError(kind, host, error);
    }
    logFailureOnce(host, translated.code);
    return translated;
  }

  function refuseWhileNotPaired(host: PeerHostRecord | undefined): void {
    if (host && notPaired.has(host.id)) {
      throw new PeerClientError("not-paired", `${host.label} no longer accepts this desktop. Pair it again.`);
    }
  }

  function sanitizeHeaders(input: Record<string, string> | undefined): Record<string, string> {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(input ?? {})) {
      const lower = name.toLowerCase();
      if (DROPPED_REQUEST_HEADERS.has(lower)) continue;
      if (typeof value !== "string" || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\r\n\0]/.test(value)) {
        throw new PeerClientError("invalid-request", "A request header is not valid.");
      }
      headers[lower] = value;
    }
    return headers;
  }

  async function linkRequest(hostId: string, request: PeerRequest): Promise<PeerResponse> {
    const method = String(request.method ?? "").toUpperCase();
    if (!ALLOWED_METHODS.has(method)) {
      throw new PeerClientError("invalid-request", "The request method is not allowed.");
    }
    if (!isSafeApiPath(request.pathname)) {
      throw new PeerClientError("invalid-request", "The request path is not allowed.");
    }
    if (request.body !== undefined && typeof request.body !== "string") {
      throw new PeerClientError("invalid-request", "The request body must be text.");
    }
    const headers = sanitizeHeaders(request.headers);
    refuseWhileNotPaired(findHost(hostId));
    const { link, host } = await getLink(hostId);
    try {
      const response = await rawRequest(
        link.agent,
        { address: host.address, port: host.port },
        {
          method,
          pathname: request.pathname,
          headers,
          body: request.body,
          timeoutMs: requestTimeoutMs,
          maxBytes: maxResponseBytes,
        },
      );
      loggedFailure.delete(hostId);
      return response;
    } catch (error) {
      throw translateLinkFailure(host, error);
    }
  }

  async function hello(hostId: string): Promise<PeerHello> {
    const instanceId = await ensureInstanceId();
    const host = findHost(hostId);
    const response = await linkRequest(hostId, {
      method: "GET",
      pathname: "/api/peer/hello",
      headers: { [CLIENT_ID_HEADER]: instanceId },
    });
    const unreadable = () =>
      new PeerClientError("host-error", "The other desktop sent an answer this version cannot read.");
    if (response.status !== 200) {
      throw new PeerClientError(
        "host-error",
        `${host?.label ?? "The other desktop"} answered with status ${response.status}.`,
      );
    }
    let parsed: PeerHello;
    try {
      parsed = JSON.parse(response.body) as PeerHello;
    } catch {
      throw unreadable();
    }
    if (
      !parsed ||
      typeof parsed.hostInstanceId !== "string" ||
      typeof parsed.appVersion !== "string" ||
      !Array.isArray(parsed.profiles)
    ) {
      throw unreadable();
    }
    if (parsed.hostInstanceId !== hostId) {
      logFailureOnce({ id: hostId, address: host?.address, port: host?.port }, "wrong-host");
      throw new PeerClientError(
        "wrong-host",
        `The address ${host ? where(host) : ""} now belongs to a different strIDEterm installation.`,
      );
    }
    return parsed;
  }

  function getHostStatus(hostId: string): PeerHostStatus {
    return statuses.get(hostId) ?? { state: "unknown", hostAppVersion: "", profiles: [], checkedAt: 0 };
  }

  function setStatus(hostId: string, next: PeerHostStatus): PeerHostStatus {
    const previous = statuses.get(hostId);
    statuses.set(hostId, next);
    if (
      !previous ||
      previous.state !== next.state ||
      previous.hostAppVersion !== next.hostAppVersion ||
      JSON.stringify(previous.profiles) !== JSON.stringify(next.profiles)
    ) {
      deps.emit("peers:updated", {});
    }
    return next;
  }

  async function runRefresh(hostId: string): Promise<PeerHostStatus> {
    let next: Omit<PeerHostStatus, "checkedAt">;
    try {
      const answer = await hello(hostId);
      next = {
        state: answer.appVersion === deps.appVersion ? "online" : "version-mismatch",
        hostAppVersion: answer.appVersion,
        profiles: answer.profiles,
      };
    } catch (error) {
      const code = error instanceof PeerClientError ? error.code : "host-error";
      if (code === "unknown-host") return getHostStatus(hostId);
      const state: PeerHostState = code === "not-paired" || code === "wrong-host" ? code : "offline";
      next = { state, hostAppVersion: "", profiles: [] };
    }
    if (!findHost(hostId)) return getHostStatus(hostId);
    return setStatus(hostId, { ...next, checkedAt: now() });
  }

  async function pairingCall<T>(attempt: PairingAttempt, target: Target, pathname: string, body: unknown): Promise<T> {
    let response: PeerResponse;
    try {
      response = await rawRequest(attempt.agent, target, {
        method: "POST",
        pathname,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        timeoutMs: PAIRING_CALL_TIMEOUT_MS,
        maxBytes: 1024 * 1024,
        signal: attempt.controller.signal,
      });
    } catch (error) {
      if (error instanceof PeerClientError) throw error;
      const kind = failureKind(error);
      if (kind === "tls") {
        throw new PeerClientError("host-error", "This address does not answer as a strIDEterm that accepts desktops.", {
          cause: error,
        });
      }
      if (kind === "other") throw new PeerClientError("host-error", errorText(error), { cause: error });
      throw networkError(kind, target, error);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.body);
    } catch {
      parsed = null;
    }
    if (response.status < 200 || response.status >= 300) {
      const sentence = (parsed as { error?: unknown } | null)?.error;
      throw new PeerClientError(
        "host-error",
        typeof sentence === "string" && sentence
          ? sentence
          : `The other desktop answered with status ${response.status}.`,
      );
    }
    if (!parsed || typeof parsed !== "object") {
      throw new PeerClientError("host-error", "The other desktop sent an answer this version cannot read.");
    }
    return parsed as T;
  }

  function finishAttempt(attempt: PairingAttempt, result: Omit<PeerPairingResult, "attemptId">): void {
    if (attempt.done) return;
    attempt.done = true;
    attempt.controller.abort();
    attempt.wake?.();
    attempt.agent.destroy();
    if (pairing === attempt) pairing = null;
    if (!attempt.announced) return;
    log.info("pairing ended", { attemptId: attempt.attemptId, state: result.state });
    deps.emit("peers:pairing-result", { attemptId: attempt.attemptId, ...result });
  }

  function sleep(attempt: PairingAttempt, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      attempt.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  async function storeApproval(
    attempt: PairingAttempt,
    approved: { host: PeerHostRecord; privateKeyPem: string },
  ): Promise<void> {
    const { host } = approved;
    attempt.committing = true;
    try {
      await deps.credentials.setSecret(peerLinkKeyRef(host.id), approved.privateKeyPem, {
        requireEncryptedStorage: true,
      });
    } catch (error) {
      log.warn("peer link key could not be stored", { hostId: host.id, err: errorText(error) });
      finishAttempt(attempt, { state: "failed", error: "The pairing key could not be stored in secure storage." });
      return;
    }
    try {
      await deps.updateSettings("peers:host-paired", (draft) => {
        const index = draft.hosts.findIndex((entry) => entry.id === host.id);
        if (index >= 0) draft.hosts[index] = host;
        else draft.hosts.push(host);
      });
    } catch (error) {
      log.warn("peer host could not be saved", { hostId: host.id, err: errorText(error) });
      await deps.credentials.deleteSecret(peerLinkKeyRef(host.id)).catch(() => undefined);
      finishAttempt(attempt, { state: "failed", error: "The paired desktop could not be saved." });
      return;
    }
    dropLink(host.id);
    closeSockets(host.id, "re-paired");
    notPaired.delete(host.id);
    loggedFailure.delete(host.id);
    statuses.delete(host.id);
    log.info("pairing approved", { hostId: host.id, address: host.address, port: host.port });
    finishAttempt(attempt, { state: "approved", hostId: host.id });
    deps.emit("peers:updated", {});
  }

  async function pollPairing(
    attempt: PairingAttempt,
    target: Target,
    pairingId: string,
    deadline: number,
    approved: { host: PeerHostRecord; privateKeyPem: string },
  ): Promise<void> {
    let failures = 0;
    while (!attempt.done) {
      await sleep(attempt, pollIntervalMs);
      if (attempt.done) return;
      if (now() >= deadline) {
        finishAttempt(attempt, { state: "expired" });
        return;
      }
      let state: PeerPairStatusResult["state"];
      try {
        const answer = await pairingCall<PeerPairStatusResult>(attempt, target, "/api/peer/pair/status", {
          pairingId,
        });
        state = answer.state;
        failures = 0;
      } catch (error) {
        if (attempt.done) return;
        failures += 1;
        if (failures >= POLL_FAILURES_BEFORE_GIVING_UP) {
          finishAttempt(attempt, { state: "failed", error: errorText(error) });
          return;
        }
        continue;
      }
      if (state === "approved") {
        await storeApproval(attempt, { ...approved, host: { ...approved.host, pairedAt: now() } });
        return;
      }
      if (state === "rejected" || state === "expired") {
        finishAttempt(attempt, { state });
        return;
      }
    }
  }

  function trackSocket(hostId: string, socket: { close(code?: number, reason?: string): void }): () => void {
    let set = sockets.get(hostId);
    if (!set) {
      set = new Set();
      sockets.set(hostId, set);
    }
    set.add(socket);
    return () => {
      set.delete(socket);
      if (set.size === 0 && sockets.get(hostId) === set) sockets.delete(hostId);
    };
  }

  return {
    ensureInstanceId,

    async startPairing(target) {
      if (!deps.credentials.isEncryptionAvailable()) {
        throw new PeerClientError(
          "storage-unavailable",
          "Secure storage is required to attach profiles between desktops, and it is not available on this machine.",
        );
      }
      const instanceId = await ensureInstanceId();
      if (pairing) finishAttempt(pairing, { state: "cancelled" });
      const attempt: PairingAttempt = {
        attemptId: randomId(),
        controller: new AbortController(),
        agent: createPskAgent(PEER_PAIRING_PSK, PEER_PAIRING_IDENTITY),
        announced: false,
        committing: false,
        done: false,
        wake: null,
      };
      pairing = attempt;
      const keys = generateX25519KeyPair();
      const devicePublicKey = exportRawPublicKey(keys.publicKey).toString("base64");
      const deviceNonce = randomBytes(32).toString("base64");
      const begin: PeerPairBegin = {
        protocolVersion: PEER_PROTOCOL_VERSION,
        deviceId: instanceId,
        name: (deps.deviceName().trim() || "Desktop").slice(0, 64),
        platform: deps.platform.slice(0, 16),
        appVersion: deps.appVersion.slice(0, 32),
        commitment: computePeerCommitment({ deviceId: instanceId, publicKey: devicePublicKey, nonce: deviceNonce }),
      };
      const deadline = now() + PEER_PAIRING_TTL_MS;
      log.info("pairing started", { attemptId: attempt.attemptId, address: target.address, port: target.port });
      try {
        const answer = await pairingCall<PeerPairBeginResult>(attempt, target, "/api/peer/pair/begin", begin);
        if (answer.hostInstanceId === instanceId) {
          throw new PeerClientError("host-error", "This desktop cannot be attached to itself.");
        }
        let code: string;
        try {
          code = formatPeerSas(
            computePeerSas({
              pairingId: answer.pairingId,
              hostInstanceId: answer.hostInstanceId,
              hostPublicKey: answer.hostPublicKey,
              hostNonce: answer.hostNonce,
              deviceId: instanceId,
              devicePublicKey,
              deviceNonce,
            }),
          );
        } catch (error) {
          throw new PeerClientError("host-error", "The other desktop sent an answer this version cannot read.", {
            cause: error,
          });
        }
        await pairingCall(attempt, target, "/api/peer/pair/reveal", {
          pairingId: answer.pairingId,
          publicKey: devicePublicKey,
          nonce: deviceNonce,
        });
        if (attempt.done) throw new PeerClientError("cancelled", "The pairing was cancelled.");
        attempt.announced = true;
        const hostName = String(answer.hostName || "").slice(0, 64) || target.address;
        const host: PeerHostRecord = {
          id: answer.hostInstanceId,
          label: hostName,
          address: target.address,
          port: target.port,
          hostPublicKey: answer.hostPublicKey,
          pairedAt: 0,
        };
        void pollPairing(attempt, target, answer.pairingId, deadline, {
          host,
          privateKeyPem: exportPrivateKeyPem(keys.privateKey),
        });
        return {
          attemptId: attempt.attemptId,
          code,
          hostId: answer.hostInstanceId,
          hostName,
          hostAppVersion: String(answer.appVersion ?? ""),
        };
      } catch (error) {
        finishAttempt(attempt, { state: "failed" });
        log.warn("pairing failed to start", {
          attemptId: attempt.attemptId,
          address: target.address,
          port: target.port,
          code: error instanceof PeerClientError ? error.code : "other",
        });
        throw error;
      }
    },

    cancelPairing(attemptId) {
      if (pairing && pairing.attemptId === attemptId && !pairing.committing) {
        finishAttempt(pairing, { state: "cancelled" });
      }
    },

    listHosts() {
      return deps.getSettings().hosts.map((host) => ({ ...host }));
    },

    async removeHost(hostId) {
      if (!findHost(hostId)) return false;
      await deps.updateSettings("peers:host-removed", (draft) => {
        draft.hosts = draft.hosts.filter((host) => host.id !== hostId);
      });
      dropLink(hostId);
      closeSockets(hostId, "removed");
      statuses.delete(hostId);
      loggedFailure.delete(hostId);
      notPaired.delete(hostId);
      try {
        await deps.credentials.deleteSecret(peerLinkKeyRef(hostId));
      } catch (error) {
        log.warn("peer link key could not be deleted", { hostId, err: errorText(error) });
      }
      log.info("host removed", { hostId });
      deps.emit("peers:updated", {});
      return true;
    },

    async updateHostAddress(hostId, target) {
      if (!findHost(hostId)) return false;
      await deps.updateSettings("peers:host-address", (draft) => {
        const host = draft.hosts.find((entry) => entry.id === hostId);
        if (!host) return;
        host.address = target.address;
        host.port = target.port;
      });
      dropLink(hostId);
      closeSockets(hostId, "address changed");
      loggedFailure.delete(hostId);
      notPaired.delete(hostId);
      log.info("host address changed", { hostId, address: target.address, port: target.port });
      deps.emit("peers:updated", {});
      return true;
    },

    hello,
    request: linkRequest,

    openSocket(hostId, query) {
      const handlers = {
        open: [] as Array<() => void>,
        message: [] as Array<(data: string) => void>,
        close: [] as Array<(info: PeerSocketClose) => void>,
      };
      let ws: WebSocket | null = null;
      let closed = false;
      let closeRequested = false;
      let failureReason = "";
      const untrack = trackSocket(hostId, { close: (code, reason) => socket.close(code, reason) });
      const emitClose = (code: number, reason: string) => {
        if (closed) return;
        closed = true;
        untrack();
        for (const handler of handlers.close) handler({ code, reason });
      };
      const socket: PeerClientSocket = {
        send(data) {
          if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error("The connection is not open.");
          ws.send(data);
        },
        close(code, reason) {
          if (closed || closeRequested) return;
          closeRequested = true;
          if (!ws) {
            emitClose(code ?? 1000, reason ?? "");
            return;
          }
          try {
            ws.close(code, reason);
          } catch {
            ws.terminate();
          }
        },
        on(event: "open" | "message" | "close", handler: never) {
          (handlers[event] as unknown[]).push(handler);
        },
      };
      void (async () => {
        if (notPaired.has(hostId) && findHost(hostId)) {
          await Promise.resolve();
          emitClose(1008, "not-paired");
          return;
        }
        let resolved: Awaited<ReturnType<typeof getLink>>;
        try {
          resolved = await getLink(hostId);
        } catch (error) {
          emitClose(1006, errorText(error));
          return;
        }
        if (closed) return;
        const { link, host } = resolved;
        const bracketed = host.address.includes(":") ? `[${host.address}]` : host.address;
        const url = `wss://${bracketed}:${host.port}/ws?${new URLSearchParams(query).toString()}`;
        const connection = new WebSocket(url, { agent: link.agent, handshakeTimeout: SOCKET_HANDSHAKE_TIMEOUT_MS });
        ws = connection;
        connection.on("open", () => {
          loggedFailure.delete(hostId);
          for (const handler of handlers.open) handler();
        });
        connection.on("message", (data, isBinary) => {
          if (isBinary) return;
          const text = Array.isArray(data)
            ? Buffer.concat(data).toString("utf8")
            : Buffer.from(data as Buffer).toString("utf8");
          for (const handler of handlers.message) handler(text);
        });
        connection.on("error", (error) => {
          failureReason = translateLinkFailure(host, error).message;
        });
        connection.on("close", (code, reason) => emitClose(code, reason.toString("utf8") || failureReason));
      })();
      return socket;
    },

    getHostStatus,

    refreshHost(hostId, options) {
      const force = options?.force === true;
      if (force) notPaired.delete(hostId);
      const running = refreshes.get(hostId);
      if (running && !force) return running;
      const started: Promise<PeerHostStatus> = runRefresh(hostId).finally(() => {
        if (refreshes.get(hostId) === started) refreshes.delete(hostId);
      });
      refreshes.set(hostId, started);
      return started;
    },

    dispose() {
      if (pairing) finishAttempt(pairing, { state: "cancelled" });
      for (const hostId of [...sockets.keys()]) closeSockets(hostId, "shutting down");
      for (const hostId of [...links.keys()]) dropLink(hostId);
    },
  };
}
