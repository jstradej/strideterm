import { SANDBOX_GATEWAY_HOST } from "../../shared/sandbox.js";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RegistryConnection } from "../../shared/registry.js";
import { SandboxGateway, type ResolvedRegistry } from "./gateway.js";
import type { RegistryAudit } from "./registry-audit.js";

interface Seen {
  method?: string;
  url?: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function listen(handler: (req: http.IncomingMessage, res: http.ServerResponse, seen: Seen) => void) {
  const requests: Seen[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const seen = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() };
      requests.push(seen);
      handler(req, res, seen);
    });
  });
  return new Promise<{ server: http.Server; port: number; requests: Seen[] }>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as AddressInfo).port, requests })),
  );
}

function call(
  port: number,
  options: { method?: string; path: string; headers?: Record<string, string>; body?: string },
) {
  return new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method: options.method || "GET", path: options.path, headers: options.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString(), headers: res.headers }),
        );
      },
    );
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

describe("SandboxGateway", () => {
  let registry: Awaited<ReturnType<typeof listen>>;
  let broker: Awaited<ReturnType<typeof listen>>;
  let gateway: SandboxGateway;
  let gatewayPort: number;
  let capability: string;
  let audit: {
    begin: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
    flush: ReturnType<typeof vi.fn>;
    beginOperation: ReturnType<typeof vi.fn>;
  };
  let finishOperation: ReturnType<typeof vi.fn>;
  let secret: string;
  let authKind: RegistryConnection["authKind"];
  let kind: RegistryConnection["kind"];

  function connection(): RegistryConnection {
    return {
      id: "r1",
      profileId: "default",
      label: "Corp",
      kind,
      url: `http://127.0.0.1:${registry.port}/repo`,
      mode: "mirror",
      authKind,
      username: "svc",
      npmScope: "",
    };
  }

  beforeEach(async () => {
    secret = "s3cret";
    authKind = "basic";
    kind = "maven";
    registry = await listen((req, res) => {
      if (req.url === "/repo/private-lib") {
        const own = `http://127.0.0.1:${registry.port}/repo`;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            name: "private-lib",
            versions: { "1.0.0": { dist: { tarball: `${own}/private-lib/-/private-lib-1.0.0.tgz` } } },
          }),
        );
        return;
      }
      if (req.url === "/repo/redirect-same") {
        res.writeHead(302, { Location: "/repo/landed" });
        res.end();
      } else if (req.url === "/repo/redirect-sibling") {
        res.writeHead(302, { Location: "/repository-other/private-data" });
        res.end();
      } else if (req.url === "/repo/redirect-dotdot") {
        res.writeHead(302, { Location: "/repo/%2e%2e/outside/private-data" });
        res.end();
      } else if (req.url === "/repo/redirect-away") {
        res.writeHead(302, { Location: "http://127.0.0.1:1/steal" });
        res.end();
      } else if (req.url === "/repo/unauthorized") {
        res.writeHead(401, { "WWW-Authenticate": "Basic realm=x" });
        res.end("no");
      } else {
        res.writeHead(200, { "Content-Type": "text/plain", "Set-Cookie": "a=b", ETag: '"e"', "X-Internal": "1" });
        res.end("artifact");
      }
    });
    broker = await listen((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"result":"ok"}');
    });
    finishOperation = vi.fn();
    audit = {
      begin: vi.fn(() => true),
      end: vi.fn(),
      flush: vi.fn(),
      beginOperation: vi.fn(() => finishOperation),
    };
    gateway = new SandboxGateway({
      audit: audit as unknown as RegistryAudit,
      resolveRegistry: (id, profileId): ResolvedRegistry | null =>
        id === "r1" && profileId === "default" ? { connection: connection(), secret } : null,
    });
    capability = gateway.registerSession({
      sessionId: "s1",
      profileId: "default",
      workspaceId: "w1",
      brokers: {
        "internal-mcp": `http://127.0.0.1:${broker.port}/internal-mcp`,
        notify: `http://127.0.0.1:${broker.port}/notify`,
      },
    });
    gatewayPort = await gateway.listenTcp("127.0.0.1");
  });

  afterEach(async () => {
    await gateway.close();
    registry.server.close();
    broker.server.close();
  });

  it("reads a registry with the stored sign-in added on the host and passes only safe response headers", async () => {
    const response = await call(gatewayPort, {
      path: `/registry/${capability}/r1/org/app/1.0/app.jar`,
      headers: { Authorization: "Bearer from-the-sandbox", Cookie: "x=y", Accept: "*/*" },
    });
    expect(response.status).toBe(200);
    expect(response.body).toBe("artifact");
    expect(response.headers.etag).toBe('"e"');
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(response.headers["x-internal"]).toBeUndefined();
    const seen = registry.requests[0];
    expect(seen.url).toBe("/repo/org/app/1.0/app.jar");
    expect(seen.headers.authorization).toBe(`Basic ${Buffer.from("svc:s3cret").toString("base64")}`);
    expect(seen.headers.cookie).toBeUndefined();
    expect(audit.begin).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "w1", connectionId: "r1" }));
    expect(audit.end).toHaveBeenCalledWith(expect.anything(), { status: 200, bytes: 8 });
  });

  it("marks every answer as data for the agent, not instructions", async () => {
    const ok = await call(gatewayPort, { path: `/registry/${capability}/r1/x` });
    const refused = await call(gatewayPort, { path: `/registry/${capability}/unknown/x` });
    const brokered = await call(gatewayPort, { method: "POST", path: `/broker/${capability}/notify` });
    for (const response of [ok, refused, brokered]) {
      expect(response.headers["x-strideterm-untrusted"]).toBe("data-not-instructions");
    }
  });

  it("sends a bearer token as one when the connection says so", async () => {
    authKind = "bearer";
    await call(gatewayPort, { path: `/registry/${capability}/r1/x` });
    expect(registry.requests[0].headers.authorization).toBe("Bearer s3cret");
  });

  it("answers HEAD and refuses every write method before contacting the registry", async () => {
    expect((await call(gatewayPort, { method: "HEAD", path: `/registry/${capability}/r1/x` })).status).toBe(200);
    registry.requests.length = 0;
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const response = await call(gatewayPort, { method, path: `/registry/${capability}/r1/x`, body: "{}" });
      expect(response.status, method).toBe(405);
      expect(response.headers.allow).toBe("GET, HEAD");
    }
    expect(registry.requests).toHaveLength(0);
  });

  it("knows a session only by its capability, and forgets it when revoked", async () => {
    expect((await call(gatewayPort, { path: `/registry/${"x".repeat(43)}/r1/x` })).status).toBe(404);
    expect((await call(gatewayPort, { path: `/registry/${capability}/unknown/x` })).status).toBe(404);
    gateway.revokeSession("s1");
    expect((await call(gatewayPort, { path: `/registry/${capability}/r1/x` })).status).toBe(404);
    expect(registry.requests).toHaveLength(0);
  });

  it("refuses a path that could leave the registry's base", async () => {
    for (const rest of ["..%2F..%2Fother", "a/../b", "a%5Cb", "%2e%2e/x"]) {
      const response = await call(gatewayPort, { path: `/registry/${capability}/r1/${rest}` });
      expect(response.status, rest).toBe(400);
    }
    expect(registry.requests).toHaveLength(0);
  });

  it("follows a redirect inside the registry's origin but never to another one", async () => {
    expect((await call(gatewayPort, { path: `/registry/${capability}/r1/redirect-same` })).status).toBe(200);
    expect(registry.requests.map((item) => item.url)).toEqual(["/repo/redirect-same", "/repo/landed"]);
    expect(registry.requests[1].headers.authorization).toBeDefined();
    const away = await call(gatewayPort, { path: `/registry/${capability}/r1/redirect-away` });
    expect(away.status).toBe(502);
  });

  it("never follows a redirect that leaves the registry's path prefix, even on its own origin", async () => {
    for (const name of ["redirect-sibling", "redirect-dotdot"]) {
      const response = await call(gatewayPort, { path: `/registry/${capability}/r1/${name}` });
      expect(response.status, name).toBe(502);
    }
    expect(registry.requests.map((item) => item.url)).toEqual(["/repo/redirect-sibling", "/repo/redirect-dotdot"]);
  });

  it("does not pass an upstream sign-in challenge to the sandbox", async () => {
    const response = await call(gatewayPort, { path: `/registry/${capability}/r1/unauthorized` });
    expect(response.status).toBe(502);
    expect(response.headers["www-authenticate"]).toBeUndefined();
  });

  it("points the absolute file links of an npm index back at the gateway, so the download comes through it too", async () => {
    kind = "npm";
    const response = await call(gatewayPort, { path: `/registry/${capability}/r1/private-lib` });
    const tarball = JSON.parse(response.body).versions["1.0.0"].dist.tarball as string;
    expect(tarball).toBe(
      `http://${SANDBOX_GATEWAY_HOST}/registry/${capability}/r1/private-lib/-/private-lib-1.0.0.tgz`,
    );
    expect(response.body).not.toContain(`127.0.0.1:${registry.port}`);
    expect(Number(response.headers["content-length"])).toBe(Buffer.byteLength(response.body));
  });

  it("leaves a Maven response exactly as the registry sent it", async () => {
    const response = await call(gatewayPort, { path: `/registry/${capability}/r1/private-lib` });
    expect(response.body).toContain(`127.0.0.1:${registry.port}`);
  });

  it("does not contact the registry when its audit window cannot be opened", async () => {
    audit.begin.mockReturnValue(false);
    const response = await call(gatewayPort, { path: `/registry/${capability}/r1/x` });
    expect(response.status).toBe(503);
    expect(registry.requests).toHaveLength(0);
  });

  it("forwards a broker call to the session's own loopback broker, bearer capability and query intact", async () => {
    const response = await call(gatewayPort, {
      method: "POST",
      path: `/broker/${capability}/notify?sid=1&secret=2`,
      headers: { Authorization: "Bearer broker-cap", "Content-Type": "application/json" },
      body: '{"a":1}',
    });
    expect(response.status).toBe(200);
    expect(response.body).toBe('{"result":"ok"}');
    const seen = broker.requests[0];
    expect(seen.method).toBe("POST");
    expect(seen.url).toBe("/notify?sid=1&secret=2");
    expect(seen.headers.authorization).toBe("Bearer broker-cap");
    expect(seen.body).toBe('{"a":1}');
  });

  it("records the intent of a broker operation before forwarding it, and finishes the same row", async () => {
    await call(gatewayPort, { method: "POST", path: `/broker/${capability}/internal-mcp`, body: "{}" });
    expect(audit.beginOperation).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "w1", route: "internal-mcp", method: "POST" }),
    );
    expect(audit.beginOperation.mock.invocationCallOrder[0]).toBeLessThan(
      finishOperation.mock.invocationCallOrder[0] ?? Infinity,
    );
    expect(finishOperation).toHaveBeenCalledWith(expect.objectContaining({ status: 200 }));
  });

  it("does not forward a broker operation whose intent cannot be recorded", async () => {
    audit.beginOperation.mockReturnValue(null);
    const refused = await call(gatewayPort, { method: "POST", path: `/broker/${capability}/internal-mcp`, body: "{}" });
    expect(refused.status).toBe(503);
    expect(broker.requests).toHaveLength(0);
  });

  it("offers no broker the session was not given, and no other path or method", async () => {
    expect((await call(gatewayPort, { method: "POST", path: `/broker/${capability}/review-git` })).status).toBe(404);
    expect((await call(gatewayPort, { method: "POST", path: `/broker/${capability}/internal-mcp/extra` })).status).toBe(
      404,
    );
    expect((await call(gatewayPort, { method: "DELETE", path: `/broker/${capability}/internal-mcp` })).status).toBe(
      405,
    );
    expect((await call(gatewayPort, { path: `/other/${capability}/x` })).status).toBe(404);
    expect(broker.requests).toHaveLength(0);
  });

  it("refuses to forward to anything but a loopback broker, and to bind to every interface", async () => {
    expect(() =>
      gateway.registerSession({
        sessionId: "s2",
        profileId: "p",
        workspaceId: "w",
        brokers: { notify: "http://10.0.0.5:80/notify" },
      }),
    ).toThrow(/loopback/);
    await expect(gateway.listenTcp("0.0.0.0")).rejects.toThrow(/one address/);
    await expect(gateway.listenTcp("localhost")).rejects.toThrow(/one address/);
  });

  it("flushes the audit trail when it closes", async () => {
    await gateway.close();
    expect(audit.flush).toHaveBeenCalled();
  });
});
