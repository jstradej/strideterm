import { randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import net from "node:net";
import { Readable } from "node:stream";
import { unlinkSync } from "node:fs";
import type { RegistryConnection } from "../../shared/registry.js";
import { SANDBOX_GATEWAY_HOST } from "../../shared/sandbox.js";
import { getLogger } from "../logger.js";
import type { RegistryAudit } from "./registry-audit.js";

const log = getLogger("sandbox-gateway");

/**
 * The host-side gateway a sandbox reaches through its proxy (`SANDBOX_GATEWAY_HOST`). It offers a
 * short, fixed list of operations and nothing else:
 *   - `GET|HEAD /registry/<capability>/<connection id>/<path>`: a read-only view of a private registry
 *     with the stored sign-in added HERE, on the host.
 *   - `/broker/<capability>/<route>`: the loopback brokers strIDEterm already runs for this one session
 *     (internal MCP, review Git, SSH tools, notifications). They keep their own bearer capability.
 * The capability in the path names one session; a revoked or unknown one is a 404.
 */

export const BROKER_ROUTE_NAMES = ["internal-mcp", "review-git", "ssh-mcp", "notify"] as const;
export type BrokerRouteName = (typeof BROKER_ROUTE_NAMES)[number];

export interface GatewaySession {
  sessionId: string;
  profileId: string;
  workspaceId: string;
  /** Loopback URL of each broker this session may reach (no query for notify; it is carried by the client). */
  brokers: Partial<Record<BrokerRouteName, string>>;
}

export interface ResolvedRegistry {
  connection: RegistryConnection;
  /** The stored secret; empty for `authKind: none`. */
  secret: string;
}

export interface SandboxGatewayOptions {
  resolveRegistry: (connectionId: string, profileId: string) => ResolvedRegistry | null;
  audit: RegistryAudit;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  maxBrokerBodyBytes?: number;
}

const MAX_REGISTRY_REDIRECTS = 5;
/** Everything the gateway answers is data for the agent, never instructions to it; the header says so to any tool that looks. */
const UNTRUSTED_CONTENT = { "X-Strideterm-Untrusted": "data-not-instructions" };
/** Largest index document (npm packument, pip simple page) whose absolute links are rewritten in memory. */
const MAX_REWRITTEN_INDEX_BYTES = 32 * 1024 * 1024;
const PASS_RESPONSE_HEADERS = ["content-type", "etag", "last-modified", "cache-control", "content-disposition"];

/** Path and query of a request target, absolute-form (through the sandbox proxy) or origin-form, unnormalized. */
function rawTarget(requestUrl: string): { path: string; search: string } | null {
  let remainder = requestUrl;
  const absolute = /^https?:\/\/[^/?#]+/iu.exec(remainder);
  if (absolute) remainder = remainder.slice(absolute[0].length) || "/";
  if (!remainder.startsWith("/") || remainder.includes("#")) return null;
  const query = remainder.indexOf("?");
  return query < 0
    ? { path: remainder, search: "" }
    : { path: remainder.slice(0, query), search: remainder.slice(query) };
}

function sameCapability(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** `rest` of a registry path as upstream path segments, or null when it could escape the registry base. */
function safeRegistrySegments(rest: string): string[] | null {
  const segments: string[] = [];
  for (const raw of rest.split("/")) {
    if (raw === "") continue;
    let decoded: string;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (decoded === "." || decoded === ".." || /[\\\0]/u.test(decoded) || decoded.includes("/")) return null;
    segments.push(raw);
  }
  return segments;
}

export class SandboxGateway {
  private readonly sessionsByCapability = new Map<string, GatewaySession>();
  private readonly capabilityBySession = new Map<string, string>();
  private readonly servers: http.Server[] = [];
  private unixPath = "";
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;
  private readonly maxBrokerBodyBytes: number;

  constructor(private readonly options: SandboxGatewayOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
    this.maxBrokerBodyBytes = options.maxBrokerBodyBytes ?? 4 * 1024 * 1024;
  }

  /** Mints the capability for one session. Calling it again for the same session replaces the old one. */
  registerSession(session: GatewaySession): string {
    for (const target of Object.values(session.brokers)) {
      const parsed = new URL(target);
      if (parsed.hostname !== "127.0.0.1" || parsed.protocol !== "http:") {
        throw new Error("The gateway only forwards to loopback brokers.");
      }
    }
    this.revokeSession(session.sessionId);
    const capability = randomBytes(32).toString("base64url");
    this.sessionsByCapability.set(capability, session);
    this.capabilityBySession.set(session.sessionId, capability);
    return capability;
  }

  revokeSession(sessionId: string): void {
    const capability = this.capabilityBySession.get(sessionId);
    if (!capability) return;
    this.capabilityBySession.delete(sessionId);
    this.sessionsByCapability.delete(capability);
  }

  hasSession(sessionId: string): boolean {
    return this.capabilityBySession.has(sessionId);
  }

  private sessionFor(capability: string): GatewaySession | null {
    for (const [known, session] of this.sessionsByCapability) {
      if (sameCapability(known, capability)) return session;
    }
    return null;
  }

  /** URL a client inside the sandbox uses for a registry or broker (host name is added by the caller). */
  registryPath(sessionId: string, connectionId: string): string {
    return `/registry/${this.capabilityBySession.get(sessionId) ?? ""}/${encodeURIComponent(connectionId)}`;
  }

  brokerPath(sessionId: string, route: BrokerRouteName): string {
    return `/broker/${this.capabilityBySession.get(sessionId) ?? ""}/${route}`;
  }

  async listenUnix(socketPath: string): Promise<void> {
    try {
      unlinkSync(socketPath);
    } catch {
      /* no stale socket */
    }
    const server = this.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.unixPath = socketPath;
    this.servers.push(server);
  }

  /** TCP listener for a sandbox that cannot share a socket with the host (WSL2). Bound to one address, never 0.0.0.0. */
  async listenTcp(host: string, port = 0): Promise<number> {
    if (host === "0.0.0.0" || host === "::" || !net.isIP(host)) throw new Error("Bind the gateway to one address.");
    const server = this.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.servers.push(server);
    return (server.address() as net.AddressInfo).port;
  }

  get socketPath(): string {
    return this.unixPath;
  }

  async close(): Promise<void> {
    this.options.audit.flush();
    await Promise.all(
      this.servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
    this.sessionsByCapability.clear();
    this.capabilityBySession.clear();
    if (this.unixPath) {
      try {
        unlinkSync(this.unixPath);
      } catch {
        /* already gone */
      }
      this.unixPath = "";
    }
  }

  private createServer(): http.Server {
    const server = http.createServer((request, response) => {
      this.handle(request, response).catch((error: unknown) => {
        log.warn("gateway request failed", { err: (error as Error)?.message || String(error) });
        if (!response.headersSent) this.reply(response, 502, "Gateway error.");
        else response.destroy();
      });
    });
    server.on("clientError", (_error, socket) => socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"));
    server.headersTimeout = 15_000;
    return server;
  }

  private reply(response: http.ServerResponse, status: number, message: string): void {
    if (response.destroyed || response.writableEnded) return;
    response.writeHead(status, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      ...UNTRUSTED_CONTENT,
    });
    response.end(`${message}\n`);
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    // The path is read as the client wrote it: URL parsing would fold "a/../b" into "b" and could turn a
    // registry path into a route of another kind. Dot segments are refused instead.
    const target = rawTarget(request.url || "/");
    if (!target || target.path.split("/").some((part) => part === "." || part === "..")) {
      this.reply(response, 400, "Bad request.");
      return;
    }
    const url = { search: target.search };
    const parts = target.path.split("/");
    const [, kind, capability, name, ...rest] = parts;
    const session = capability ? this.sessionFor(capability) : null;
    if (!session || !name || (kind !== "registry" && kind !== "broker")) {
      this.reply(response, 404, "Not found.");
      return;
    }
    if (kind === "registry") {
      await this.handleRegistry(request, response, session, decodeURIComponent(name), rest.join("/"), url.search);
      return;
    }
    await this.handleBroker(request, response, session, name, rest.join("/"), url.search);
  }

  private async handleRegistry(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    session: GatewaySession,
    connectionId: string,
    rest: string,
    search: string,
  ): Promise<void> {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.setHeader("Allow", "GET, HEAD");
      this.reply(response, 405, "Registries are read-only through the sandbox.");
      return;
    }
    const resolved = this.options.resolveRegistry(connectionId, session.profileId);
    if (!resolved) {
      this.reply(response, 404, "Unknown registry.");
      return;
    }
    const segments = safeRegistrySegments(rest);
    if (!segments) {
      this.reply(response, 400, "Invalid registry path.");
      return;
    }
    const base = new URL(resolved.connection.url);
    const basePath = base.pathname.replace(/\/+$/u, "");
    const trailing = rest.endsWith("/") ? "/" : "";
    const target = new URL(`${base.origin}${basePath}/${segments.join("/")}${trailing}${search}`);
    const subject = {
      profileId: session.profileId,
      workspaceId: session.workspaceId,
      connectionId: resolved.connection.id,
      label: resolved.connection.label,
    };
    if (!this.options.audit.begin(subject)) {
      this.reply(response, 503, "The audit log is unavailable, so the registry was not contacted.");
      return;
    }
    let status = 0;
    let bytes = 0;
    try {
      const upstream = await this.fetchRegistry(request, target, resolved);
      if (!upstream) {
        status = 502;
        this.reply(response, 502, "The registry redirected outside its own repository; refused.");
        return;
      }
      status = upstream.status === 401 ? 502 : upstream.status;
      if (upstream.status === 401) {
        this.reply(response, 502, "The registry rejected the stored sign-in.");
        return;
      }
      const headers: Record<string, string> = { ...UNTRUSTED_CONTENT };
      for (const key of PASS_RESPONSE_HEADERS) {
        const value = upstream.headers.get(key);
        if (value) headers[key] = value;
      }
      // npm and pip index documents name their files by absolute URL on the registry's own address, which the
      // sandbox cannot reach: those links are pointed back at this gateway so the download comes through it too.
      if (this.isRewritableIndex(resolved.connection.kind, request.method, upstream)) {
        const text = await upstream.text();
        const publicBase = `http://${SANDBOX_GATEWAY_HOST}${this.registryPath(session.sessionId, connectionId)}`;
        const upstreamBase = `${base.origin}${basePath}`;
        const escaped = (value: string) => value.replaceAll("/", "\\/");
        const out = Buffer.from(
          text.split(upstreamBase).join(publicBase).split(escaped(upstreamBase)).join(escaped(publicBase)),
        );
        delete headers["content-disposition"];
        headers["content-length"] = String(out.length);
        bytes = out.length;
        response.writeHead(upstream.status, headers);
        response.end(out);
        return;
      }
      response.writeHead(upstream.status, headers);
      if (request.method === "HEAD" || !upstream.body) {
        response.end();
        return;
      }
      const body = Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream<Uint8Array>);
      body.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
      });
      await new Promise<void>((resolve) => {
        body.on("error", () => {
          status = 0;
          response.destroy();
          resolve();
        });
        response.on("close", () => resolve());
        body.pipe(response);
      });
    } catch (error) {
      status = 0;
      log.warn("registry request failed", { connectionId: resolved.connection.id, err: (error as Error)?.message });
      if (!response.headersSent) this.reply(response, 502, "The registry could not be reached.");
      else response.destroy();
    } finally {
      this.options.audit.end(subject, { status, bytes });
    }
  }

  private isRewritableIndex(kind: string, method: string | undefined, upstream: Response): boolean {
    if (method !== "GET" || upstream.status !== 200 || !upstream.body) return false;
    if (kind !== "npm" && kind !== "pip") return false;
    const type = upstream.headers.get("content-type") || "";
    if (!/json|html/iu.test(type)) return false;
    const length = Number(upstream.headers.get("content-length") || 0);
    return !length || length <= MAX_REWRITTEN_INDEX_BYTES;
  }

  /** Fetches with the stored sign-in, following redirects only inside the registry's own origin AND path prefix. */
  private async fetchRegistry(
    request: http.IncomingMessage,
    first: URL,
    { connection, secret }: ResolvedRegistry,
  ): Promise<Response | null> {
    const registryUrl = new URL(connection.url);
    const origin = registryUrl.origin;
    const prefix = registryUrl.pathname.replace(/\/+$/u, "");
    const headers: Record<string, string> = { "user-agent": "strIDEterm-sandbox-gateway" };
    for (const key of ["accept", "range", "if-none-match", "if-modified-since"]) {
      const value = request.headers[key];
      if (typeof value === "string") headers[key] = value;
    }
    if (connection.authKind === "basic" && secret) {
      headers.authorization = `Basic ${Buffer.from(`${connection.username}:${secret}`).toString("base64")}`;
    } else if (connection.authKind === "bearer" && secret) {
      headers.authorization = `Bearer ${secret}`;
    }
    let target = first;
    for (let hop = 0; hop <= MAX_REGISTRY_REDIRECTS; hop += 1) {
      const result = await this.fetchImpl(target, {
        method: request.method,
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
      if (result.status < 300 || result.status >= 400 || !result.headers.get("location")) return result;
      const next = new URL(result.headers.get("location")!, target);
      await result.body?.cancel().catch(() => undefined);
      if (next.origin !== origin) return null;
      if (prefix && next.pathname !== prefix && !next.pathname.startsWith(`${prefix}/`)) return null;
      target = next;
    }
    return null;
  }

  private async handleBroker(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    session: GatewaySession,
    route: string,
    rest: string,
    search: string,
  ): Promise<void> {
    const targetBase = (BROKER_ROUTE_NAMES as readonly string[]).includes(route)
      ? session.brokers[route as BrokerRouteName]
      : undefined;
    if (!targetBase || rest) {
      this.reply(response, 404, "Not found.");
      return;
    }
    if (request.method !== "GET" && request.method !== "POST") {
      this.reply(response, 405, "Method not allowed.");
      return;
    }
    // The intent is on record before anything is dispatched; without it the operation is refused.
    const finishAudit = this.options.audit.beginOperation({
      profileId: session.profileId,
      workspaceId: session.workspaceId,
      sessionId: session.sessionId,
      route,
      method: request.method || "GET",
    });
    if (!finishAudit) {
      this.reply(response, 503, "The audit log is unavailable, so the operation was not forwarded.");
      return;
    }
    let outcomeStatus = 0;
    let outcomeBytes = 0;
    try {
      await this.forwardBroker(request, response, targetBase, search, (status, bytes) => {
        outcomeStatus = status;
        outcomeBytes = bytes;
      });
    } finally {
      finishAudit({ status: outcomeStatus, bytes: outcomeBytes });
    }
  }

  private async forwardBroker(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    targetBase: string,
    search: string,
    report: (status: number, bytes: number) => void,
  ): Promise<void> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > this.maxBrokerBodyBytes) {
        report(413, 0);
        this.reply(response, 413, "Request body too large.");
        request.destroy();
        return;
      }
      chunks.push(buffer);
    }
    const target = new URL(targetBase);
    target.search = search;
    const headers: Record<string, string | number> = {};
    for (const key of ["authorization", "content-type", "accept"]) {
      const value = request.headers[key];
      if (typeof value === "string") headers[key] = value;
    }
    const body = Buffer.concat(chunks);
    if (request.method === "POST") headers["content-length"] = body.length;
    await new Promise<void>((resolve) => {
      const upstream = http.request(
        {
          host: target.hostname,
          port: Number(target.port),
          path: `${target.pathname}${target.search}`,
          method: request.method,
          headers,
          timeout: this.requestTimeoutMs,
        },
        (result) => {
          const outHeaders: Record<string, string> = { ...UNTRUSTED_CONTENT };
          for (const key of ["content-type", "cache-control"]) {
            const value = result.headers[key];
            if (typeof value === "string") outHeaders[key] = value;
          }
          report(result.statusCode || 502, Number(result.headers["content-length"]) || 0);
          response.writeHead(result.statusCode || 502, outHeaders);
          result.pipe(response);
          result.on("end", resolve);
          result.on("error", () => {
            response.destroy();
            resolve();
          });
        },
      );
      upstream.on("timeout", () => upstream.destroy(new Error("broker timeout")));
      upstream.on("error", () => {
        report(0, 0);
        if (!response.headersSent) this.reply(response, 502, "The broker could not be reached.");
        else response.destroy();
        resolve();
      });
      if (request.method === "POST") upstream.write(body);
      upstream.end();
    });
  }
}
