/**
 * Lightweight mock server for E2E testing.
 *
 * Serves fixture JSON payloads on the same HTTP + WebSocket endpoints that
 * remote-server.js uses, and proxies all other requests to the Vite dev server.
 * This lets the strIDEterm frontend load from a single origin and connect in
 * "remote" mode without a real Electron backend.
 *
 * Usage:
 *   node test/mock-server.js [fixture-name] [--port 3999]
 *
 * The fixture name maps to test/fixtures/<name>.json (default: "empty-state").
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer } from "ws";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VITE_ORIGIN = "http://127.0.0.1:1420";

function parseArgs(argv) {
  let fixture = "empty-state";
  let port = 3999;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--port" && argv[i + 1]) {
      port = Number(argv[i + 1]);
      i++;
    } else if (!argv[i].startsWith("-")) {
      fixture = argv[i];
    }
  }
  return { fixture, port };
}

export function loadFixture(name) {
  const filePath = path.join(__dirname, "fixtures", `${name}.json`);
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function deepClone(obj) { return JSON.parse(JSON.stringify(obj)); }

export async function startMockServer({ fixture = "empty-state", port = 3999 } = {}) {
  let payload = loadFixture(fixture);
  const TOKEN = "test-token";
  const sockets = new Set();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://localhost");

    // CORS for Vite dev server
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // API routes — accept any token or no token for testing
    if (url.pathname === "/api/state" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
      return;
    }

    // Stateful POST handler — apply basic mutations and broadcast via WS
    if (req.method === "POST" && url.pathname.startsWith("/api/")) {
      let raw = "";
      req.on("data", (chunk) => { raw += chunk; });
      req.on("error", () => { res.destroy(); });
      req.on("end", () => {
        const body = raw ? JSON.parse(raw) : {};

        // Workspace activation — switch active workspace and rebuild workspace view
        if (url.pathname.endsWith("/workspace/activate") || url.pathname.endsWith("/project/activate")) {
          const wsId = body.workspaceId || body.projectId;
          if (wsId) {
            payload.appState.activeWorkspaceId = wsId;
            payload.appState.activeProjectId = wsId;
            const ws = payload.appState.workspaces.find((w) => w.id === wsId);
            if (ws) {
              payload.workspace = {
                workspace: ws, project: ws,
                sessions: (ws.panels || []).map((p) => ({
                  sessionId: `${ws.id}:${p.id}`, panelId: p.id, title: p.title,
                  command: p.command, launch: p.launch, startup: p.startup, status: "running",
                })),
              };
            }
          }
          broadcast({ type: "state:updated", payload });
        }

        // Settings update — merge into settings
        if (url.pathname.endsWith("/settings/update") && body.settings) {
          Object.assign(payload.appState.settings, body.settings);
          broadcast({ type: "state:updated", payload });
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      });
      return;
    }

    // Proxy everything else to Vite dev server
    const proxyReq = http.request(`${VITE_ORIGIN}${req.url}`, {
      method: req.method,
      headers: { ...req.headers, host: new URL(VITE_ORIGIN).host },
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });
    proxyReq.on("error", () => {
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end("Vite dev server unavailable. Start it with: npm run dev:web");
    });
    req.pipe(proxyReq);
  });

  // WebSocket — send initial state on connection
  const wss = new WebSocketServer({ noServer: true });

  function broadcast(message) {
    const data = JSON.stringify(message);
    for (const ws of sockets) {
      if (ws.readyState === ws.OPEN) ws.send(data);
    }
  }

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "/", "http://localhost");
    if (url.pathname === "/ws") {
      wss.handleUpgrade(req, socket, head, (ws) => {
        sockets.add(ws);
        ws.on("close", () => sockets.delete(ws));
        ws.send(JSON.stringify({ type: "state:updated", payload }));
      });
      return;
    }
    // Proxy Vite HMR WebSocket and other non-app WS connections
    const viteUrl = new URL(VITE_ORIGIN);
    const proxyReq = http.request({
      hostname: viteUrl.hostname,
      port: viteUrl.port,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: viteUrl.host },
    });
    proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\n` +
        Object.entries(proxyRes.headers).map(([k, v]) => `${k}: ${v}`).join("\r\n") +
        "\r\n\r\n",
      );
      if (proxyHead.length) socket.write(proxyHead);
      proxySocket.pipe(socket);
      socket.pipe(proxySocket);
    });
    proxyReq.on("error", () => {
      socket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      socket.destroy();
    });
    proxyReq.end();
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
  });

  return {
    port,
    token: TOKEN,
    url: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/ws?token=${TOKEN}`,
    browserUrl: `http://127.0.0.1:${port}/?token=${TOKEN}`,
    async close() {
      for (const ws of wss.clients) ws.terminate();
      await new Promise((resolve) => wss.close(resolve));
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

// CLI entry point
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { fixture, port } = parseArgs(process.argv);
  const srv = await startMockServer({ fixture, port });
  console.log(`Mock server ready: ${srv.url} (fixture: ${fixture})`);
  console.log(`Browser URL: ${srv.browserUrl}`);
  process.on("SIGINT", async () => { await srv.close(); process.exit(0); });
}
