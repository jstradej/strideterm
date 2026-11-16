import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SANDBOX_GATEWAY_HOST } from "./sandbox.js";
import { sandboxAwareFetch } from "./sandbox-fetch.js";

describe("sandboxAwareFetch", () => {
  const servers: http.Server[] = [];
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const server of servers.splice(0)) server.close();
  });

  function proxy(handler: (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void) {
    const seen: Array<{ url?: string; headers: http.IncomingHttpHeaders; method?: string; body: string }> = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString();
        seen.push({ url: req.url, headers: req.headers, method: req.method, body });
        handler(req, body, res);
      });
    });
    servers.push(server);
    return new Promise<{ port: number; seen: typeof seen }>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as AddressInfo).port, seen })),
    );
  }

  it("sends a gateway request to the sandbox proxy in absolute form, with the proxy's credential", async () => {
    const { port, seen } = await proxy((_req, _body, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"result":1}');
    });
    vi.stubEnv("HTTP_PROXY", `http://srt.user%3D:tok@127.0.0.1:${port}`);
    const response = await sandboxAwareFetch(`http://${SANDBOX_GATEWAY_HOST}/broker/CAP/internal-mcp`, {
      method: "POST",
      headers: { Authorization: "Bearer cap", "Content-Type": "application/json" },
      body: '{"a":1}',
    });
    expect(response.ok).toBe(true);
    expect(await response.json()).toEqual({ result: 1 });
    expect(seen[0]).toMatchObject({
      url: `http://${SANDBOX_GATEWAY_HOST}/broker/CAP/internal-mcp`,
      method: "POST",
      body: '{"a":1}',
    });
    expect(seen[0].headers.host).toBe(SANDBOX_GATEWAY_HOST);
    expect(seen[0].headers.authorization).toBe("Bearer cap");
    expect(seen[0].headers["proxy-authorization"]).toBe(`Basic ${Buffer.from("srt.user=:tok").toString("base64")}`);
  });

  it("raises a TypeError, which callers retry on, when the proxy cannot be reached", async () => {
    vi.stubEnv("HTTP_PROXY", "http://127.0.0.1:1");
    await expect(sandboxAwareFetch(`http://${SANDBOX_GATEWAY_HOST}/x`)).rejects.toBeInstanceOf(TypeError);
  });

  it("says so when a gateway URL is used with no sandbox proxy", async () => {
    vi.stubEnv("HTTP_PROXY", "");
    vi.stubEnv("http_proxy", "");
    await expect(sandboxAwareFetch(`http://${SANDBOX_GATEWAY_HOST}/x`)).rejects.toThrow(
      /sandbox proxy is not available/,
    );
  });

  it("leaves every other request to plain fetch", async () => {
    const { port, seen } = await proxy((_req, _body, res) => {
      res.end("direct");
    });
    vi.stubEnv("HTTP_PROXY", "http://127.0.0.1:1");
    const response = await sandboxAwareFetch(`http://127.0.0.1:${port}/plain`);
    expect(await response.text()).toBe("direct");
    expect(seen[0].url).toBe("/plain");
  });
});
