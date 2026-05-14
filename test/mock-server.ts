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
import { WebSocketServer, WebSocket } from "ws";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// VITE_DEV_PORT lets test runners point the mock server at a vite instance on
// a non-default port — useful when the default 1420 is already taken by an
// unrelated dev session in another worktree.
const VITE_ORIGIN = process.env.VITE_DEV_ORIGIN || `http://127.0.0.1:${process.env.VITE_DEV_PORT || "1420"}`;
const WORKSPACE_GRID_SLOT_COUNTS: Record<string, number> = {
  cols: 2,
  rows: 2,
  "top-split": 3,
  "left-split": 3,
  grid: 4,
};

function normalizeWorkspaceGridIds(layout: string, workspaceIds?: (string | null)[]): (string | null)[] | null {
  const slots = WORKSPACE_GRID_SLOT_COUNTS[layout];
  if (!slots) return null;
  const ids: (string | null)[] = [];
  for (let i = 0; i < slots; i += 1) {
    ids.push(workspaceIds?.[i] ?? null);
  }
  return ids;
}

function compactWorkspaceGridIds(layout: string, workspaceIds?: (string | null)[]): (string | null)[] | null {
  const slots = WORKSPACE_GRID_SLOT_COUNTS[layout];
  if (!slots) return null;
  const existing = (workspaceIds || []).filter((id): id is string => typeof id === "string");
  const ids: (string | null)[] = [];
  for (let i = 0; i < slots; i += 1) {
    ids.push(existing[i] ?? null);
  }
  return ids;
}

function parseArgs(argv: string[]): { fixture: string; port: number } {
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: fixture JSON is untyped server state blob
export function loadFixture(name: string): any {
  const filePath = path.join(__dirname, "fixtures", `${name}.json`);
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

export interface MockServerHandle {
  port: number;
  token: string;
  url: string;
  wsUrl: string;
  browserUrl: string;
  close(): Promise<void>;
}

export async function startMockServer({
  fixture = "empty-state",
  port = 0,
  fileContents = {},
  delayApiStateMs = 0,
  terminalOutput = {},
}: {
  fixture?: string;
  port?: number;
  fileContents?: Record<string, string>;
  terminalOutput?: Record<string, string>;
  /**
   * Delay the GET /api/state response by N ms. Useful for tests that need
   * the WebSocket `state:updated` broadcast to arrive before the HTTP
   * bootstrap — handleBroadcastPayload only applies workspace UI state
   * (splitGroup, activeViewId restoration) when `payload.value` is still
   * unset, so a WS-first ordering is required to test split-layout
   * bootstrap behaviour.
   */
  delayApiStateMs?: number;
} = {}): Promise<MockServerHandle> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: fixture JSON is untyped server state blob
  const payload: any = JSON.parse(JSON.stringify(loadFixture(fixture)));
  // Remote-mode frontend resolves activeProfileId from appState.windowSlots
  // (see resolveRemoteProfileId in src/stores/app.ts). Production fills slots
  // via normalizeWindowSlots in electron/backend/default-state.ts; mock-server
  // mirrors that minimal shape so the reduced payload from composePayload's
  // perspective is satisfied.
  if (!Array.isArray(payload?.appState?.windowSlots) || payload.appState.windowSlots.length === 0) {
    const activeProfileId = String(
      payload.appState?.activeProfileId || payload.appState?.profiles?.[0]?.id || "default",
    );
    payload.appState.windowSlots = [{ id: "mock-window-1", profileId: activeProfileId, windowIndex: 1 }];
  }
  const TOKEN = "test-token";
  const sockets = new Set<WebSocket>();

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
      const send = () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (delayApiStateMs > 0) setTimeout(send, delayApiStateMs);
      else send();
      return;
    }

    // Stateful POST handler — apply basic mutations and broadcast via WS
    if (req.method === "POST" && url.pathname.startsWith("/api/")) {
      let raw = "";
      req.on("data", (chunk: Buffer) => {
        raw += chunk;
      });
      req.on("error", () => {
        res.destroy();
      });
      req.on("end", () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: fixture JSON is untyped server state blob
        const body: any = raw ? JSON.parse(raw) : {};

        // Workspace activation — switch active workspace and rebuild workspace view
        if (url.pathname.endsWith("/workspace/activate") || url.pathname.endsWith("/project/activate")) {
          const wsId = body.workspaceId || body.projectId;
          if (wsId) {
            payload.appState.activeWorkspaceId = wsId;
            payload.appState.activeProjectId = wsId;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: fixture JSON is untyped server state blob
            const ws = payload.appState.workspaces.find((w: any) => w.id === wsId);
            if (ws) {
              payload.workspace = {
                workspace: ws,
                project: ws,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: fixture JSON is untyped server state blob
                sessions: (ws.panels || []).map((p: any) => ({
                  sessionId: `${ws.id}:${p.id}`,
                  panelId: p.id,
                  title: p.title,
                  command: p.command,
                  launch: p.launch,
                  startup: p.startup,
                  status: "running",
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

        if (url.pathname.endsWith("/workspace-grid/enable")) {
          const layout = String(body.layout || "");
          const cellWorkspaceIds = normalizeWorkspaceGridIds(layout, body.workspaceIds);
          if (cellWorkspaceIds) {
            payload.appState.workspaceGrid = { layout, cellWorkspaceIds };
            broadcast({ type: "state:updated", payload });
          }
        }

        if (url.pathname.endsWith("/workspace-grid/disable")) {
          payload.appState.workspaceGrid = null;
          broadcast({ type: "state:updated", payload });
        }

        if (url.pathname.endsWith("/workspace-grid/set-layout")) {
          const layout = String(body.layout || "");
          const cellWorkspaceIds = compactWorkspaceGridIds(layout, payload.appState.workspaceGrid?.cellWorkspaceIds);
          if (payload.appState.workspaceGrid && cellWorkspaceIds) {
            payload.appState.workspaceGrid.layout = layout;
            payload.appState.workspaceGrid.cellWorkspaceIds = cellWorkspaceIds;
            broadcast({ type: "state:updated", payload });
          }
        }

        if (url.pathname.endsWith("/workspace-grid/set-cell")) {
          const grid = payload.appState.workspaceGrid;
          const cellIndex = Number(body.cellIndex);
          if (grid && Number.isInteger(cellIndex) && cellIndex >= 0 && cellIndex < grid.cellWorkspaceIds.length) {
            const workspaceId = body.workspaceId ?? null;
            if (workspaceId) {
              const existing = grid.cellWorkspaceIds.indexOf(workspaceId);
              if (existing >= 0 && existing !== cellIndex) grid.cellWorkspaceIds[existing] = null;
            }
            grid.cellWorkspaceIds[cellIndex] = workspaceId;
            if (grid.cellWorkspaceIds.every((id: string | null) => id === null)) payload.appState.workspaceGrid = null;
            broadcast({ type: "state:updated", payload });
          }
        }

        if (url.pathname.endsWith("/workspace-grid/swap-cells")) {
          const grid = payload.appState.workspaceGrid;
          const a = Number(body.a);
          const b = Number(body.b);
          const ids = grid?.cellWorkspaceIds;
          if (
            ids &&
            Number.isInteger(a) &&
            Number.isInteger(b) &&
            a >= 0 &&
            b >= 0 &&
            a < ids.length &&
            b < ids.length &&
            a !== b
          ) {
            const tmp = ids[a];
            ids[a] = ids[b];
            ids[b] = tmp;
            broadcast({ type: "state:updated", payload });
          }
        }

        // File read — return injected content if available
        if (url.pathname.endsWith("/file/read") && body.relativePath !== undefined) {
          const content = fileContents[body.relativePath] ?? "";
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ content }));
          return;
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      });
      return;
    }

    // Proxy everything else to Vite dev server
    const proxyReq = http.request(
      `${VITE_ORIGIN}${req.url}`,
      {
        method: req.method,
        headers: { ...req.headers, host: new URL(VITE_ORIGIN).host },
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode!, proxyRes.headers);
        proxyRes.pipe(res);
      },
    );
    proxyReq.on("error", () => {
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end("Vite dev server unavailable. Start it with: npm run dev:web");
    });
    req.pipe(proxyReq);
  });

  // WebSocket — send initial state on connection
  const wss = new WebSocketServer({ noServer: true });

  function broadcast(message: unknown): void {
    const data = JSON.stringify(message);
    for (const ws of sockets) {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    }
  }

  function sendTerminalOutput(ws: WebSocket): void {
    for (const [sessionId, data] of Object.entries(terminalOutput)) {
      ws.send(JSON.stringify({ type: "terminal:data", payload: { sessionId, data } }));
    }
  }

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "/", "http://localhost");
    if (url.pathname === "/ws") {
      wss.handleUpgrade(req, socket as import("node:net").Socket, head, (ws) => {
        sockets.add(ws);
        ws.on("close", () => sockets.delete(ws));
        ws.send(JSON.stringify({ type: "state:updated", payload }));
        sendTerminalOutput(ws);
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
          Object.entries(proxyRes.headers)
            .map(([k, v]) => `${k}: ${v}`)
            .join("\r\n") +
          "\r\n\r\n",
      );
      if (proxyHead.length) socket.write(proxyHead);
      (proxySocket as NodeJS.ReadWriteStream).pipe(socket as unknown as NodeJS.WritableStream);
      (socket as NodeJS.ReadableStream).pipe(proxySocket as unknown as NodeJS.WritableStream);
    });
    proxyReq.on("error", () => {
      socket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      socket.destroy();
    });
    proxyReq.end();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const actualPort = (server.address() as import("node:net").AddressInfo).port;
  return {
    port: actualPort,
    token: TOKEN,
    url: `http://127.0.0.1:${actualPort}`,
    wsUrl: `ws://127.0.0.1:${actualPort}/ws?token=${TOKEN}`,
    browserUrl: `http://127.0.0.1:${actualPort}/?token=${TOKEN}`,
    async close() {
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// CLI entry point
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { fixture, port } = parseArgs(process.argv);
  const srv = await startMockServer({ fixture, port });
  console.log(`Mock server ready: ${srv.url} (fixture: ${fixture})`);
  console.log(`Browser URL: ${srv.browserUrl}`);
  process.on("SIGINT", async () => {
    await srv.close();
    process.exit(0);
  });
}
