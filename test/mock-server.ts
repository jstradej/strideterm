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
import {
  buildRemoteCore,
  buildResourceDetail,
  resourceRevision,
  isKnownResourceKey,
  resourceProfileAuthorized,
  selectCapabilities,
  servesRemoteCore,
  looksLikeStatePayload,
  REMOTE_STATE_PROTOCOL,
} from "../electron/backend/remote-core.js";

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: fixture JSON is untyped server state blob
function findWorkspace(payload: any, workspaceId: string): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: fixture JSON is untyped server state blob
  return payload.appState?.workspaces?.find((w: any) => w.id === workspaceId) || null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: fixture JSON is untyped server state blob
function workspaceSessions(ws: any): any[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: fixture JSON is untyped server state blob
  return (ws.panels || []).map((p: any) => ({
    sessionId: `${ws.id}:${p.id}`,
    panelId: p.id,
    title: p.title,
    command: p.command,
    launch: p.launch,
    startup: p.startup,
    status: "running",
  }));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: fixture JSON is untyped server state blob
function setActiveWorkspace(payload: any, workspaceId: string): void {
  const ws = findWorkspace(payload, workspaceId);
  if (!ws) return;
  payload.appState.activeWorkspaceId = workspaceId;
  payload.appState.activeProjectId = workspaceId;
  payload.workspace = {
    workspace: ws,
    project: ws,
    sessions: workspaceSessions(ws),
  };
  if (payload.remoteClient) {
    payload.remoteClient.activeWorkspaceId = workspaceId;
    if (
      payload.remoteClient.activeSessionId &&
      !String(payload.remoteClient.activeSessionId).startsWith(`${workspaceId}:`)
    ) {
      payload.remoteClient.activeSessionId = "";
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: fixture JSON is untyped server state blob
function ensureRemoteClient(payload: any): void {
  const activeProfileId = String(payload.appState?.activeProfileId || payload.appState?.profiles?.[0]?.id || "default");
  const activeWorkspaceId = String(payload.appState?.activeWorkspaceId || "");
  payload.remoteClient = {
    id: payload.remoteClient?.id || "mock-remote-client",
    profileId: payload.remoteClient?.profileId || activeProfileId,
    activeWorkspaceId: payload.remoteClient?.activeWorkspaceId || activeWorkspaceId,
    activeSessionId: payload.remoteClient?.activeSessionId || "",
    // Viewer-scoped grid (production injects it via registry.composePayload); the
    // slim remote core reads this, not the desktop-global appState.workspaceGrid.
    workspaceGrid: payload.remoteClient?.workspaceGrid ?? payload.appState?.workspaceGrid ?? null,
  };
}

export interface MockServerHandle {
  port: number;
  token: string;
  url: string;
  wsUrl: string;
  browserUrl: string;
  /** Every `terminal:input` WS message received from clients, in arrival order. */
  terminalInputs: Array<{ sessionId: string; data: string }>;
  close(): Promise<void>;
}

export async function startMockServer({
  fixture = "empty-state",
  port = 0,
  fileContents = {},
  delayApiStateMs = 0,
  terminalOutput = {},
  patchState,
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
  /**
   * Mutate the cloned fixture payload before the server starts. Lets a single
   * fixture be reshaped per-test (e.g. flip a workspace's git `dirty` flag) so
   * tests don't need a near-duplicate fixture file on disk.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: fixture JSON is untyped server state blob
  patchState?: (_payload: any) => void;
} = {}): Promise<MockServerHandle> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: fixture JSON is untyped server state blob
  const payload: any = JSON.parse(JSON.stringify(loadFixture(fixture)));
  patchState?.(payload);
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
  ensureRemoteClient(payload);
  const TOKEN = "test-token";
  const sockets = new Set<WebSocket>();
  const terminalInputs: Array<{ sessionId: string; data: string }> = [];
  // Per-socket detail interests (resource keys the client's mounted panes render)
  // so state broadcasts can push resource:invalidate the same way remote-server
  // does. Keyed by the WebSocket instance.
  const socketInterests = new Map<WebSocket, Set<string>>();
  // Per-socket negotiated protocol (2 = slim v2 core, 1 = legacy full payload).
  const socketProtocol = new Map<WebSocket, number>();
  const profileId = String(payload.remoteClient?.profileId || "default");

  // Monotonic broadcast revision. The app store's acceptCoreRevision gate applies
  // a remote snapshot only when its coreRevision is strictly newer than the last
  // applied one, so every state broadcast must bump this or the client drops it.
  let coreRevision = 1;

  /** Read the advertised state protocol from a request (header wins, then ?sp=). */
  function protocolFrom(u: URL, headers: http.IncomingHttpHeaders): number {
    const raw = headers["x-strideterm-state-protocol"];
    const fromHeader = Array.isArray(raw) ? raw[0] : raw;
    if (fromHeader) return Number(fromHeader) || 1;
    const sp = u.searchParams.get("sp");
    return sp ? Number(sp) || 1 : 1;
  }

  /**
   * The one response adapter — mirrors remote-server.ts adaptRemoteResponse so
   * the E2E client exercises the REAL slim-core contract, not a full desktop
   * payload. A v2 client receives the slim RemoteStateV2 core (or, for a nested
   * `{ payload, result }`, a core-in-envelope); a legacy client gets the full
   * payload unchanged. Small results (no state payload) pass through.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: fixture JSON is untyped server state blob
  function adaptForClient(body: any, protocol: number): any {
    const capabilities = selectCapabilities(capabilitiesArg(protocol), protocol);
    if (!servesRemoteCore(capabilities)) return body;
    const opts = { coreRevision, capabilities, profileId };
    if (looksLikeStatePayload(body)) return buildRemoteCore(syncRemoteClientView(body), opts);
    if (body && typeof body === "object" && looksLikeStatePayload(body.payload)) {
      return { ...body, payload: buildRemoteCore(syncRemoteClientView(body.payload), opts) };
    }
    return body;
  }

  // Mirror production's registry.composePayload: the remote core is viewer-scoped,
  // so the per-client `remoteClient.workspaceGrid` (and active workspace) — not the
  // desktop-global appState fields — is what buildRemoteCore reads. The mock has a
  // single viewer whose view IS the global appState, so refresh the viewer grid
  // from appState.workspaceGrid right before composing (grid mutations write
  // appState.workspaceGrid). Without this the slim core would carry no grid.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: fixture JSON is untyped server state blob
  function syncRemoteClientView(p: any): any {
    if (p?.remoteClient) {
      p.remoteClient.workspaceGrid = p.appState?.workspaceGrid ?? null;
      p.remoteClient.activeWorkspaceId =
        p.remoteClient.activeWorkspaceId || String(p.appState?.activeWorkspaceId || "");
    }
    return p;
  }

  // The real client always advertises the full capability set alongside sp=2;
  // an empty caps arg makes selectCapabilities imply the full set for protocol 2.
  function capabilitiesArg(protocol: number): string[] {
    return protocol >= REMOTE_STATE_PROTOCOL ? ["remote-core-v2", "resource-details-v1"] : [];
  }

  /** Map a detail GET route (+ query) to a resource key, mirroring the
   *  DETAIL_ROUTES table + detailEndpointFor client mapping. */
  function detailResourceKey(u: URL): string | null {
    switch (u.pathname) {
      case "/api/docker/detail":
        return "docker";
      case "/api/azure/inbox":
        return "azure-inbox";
      case "/api/github/inbox":
        return "github-inbox";
      case "/api/git/workspace-detail": {
        const id = u.searchParams.get("workspaceId");
        return id ? `git:${id}` : null;
      }
      case "/api/azure/pull-request-detail": {
        const k = u.searchParams.get("prKey");
        return k ? `azure-pr:${k}` : null;
      }
      case "/api/github/pull-request-detail": {
        const k = u.searchParams.get("prKey");
        return k ? `github-pr:${k}` : null;
      }
      case "/api/review-bridge/pull-request": {
        const k = u.searchParams.get("prKey");
        return k ? `review-bridge:${k}` : null;
      }
      case "/api/review-bridge/agent-prompts":
        return "agent-prompts";
      default:
        return null;
    }
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    const reqProtocol = protocolFrom(url, req.headers);

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
        res.end(JSON.stringify(adaptForClient(payload, reqProtocol)));
      };
      if (delayApiStateMs > 0) setTimeout(send, delayApiStateMs);
      else send();
      return;
    }

    // Slim-core detail resources — on-demand, profile-authorized. Mirrors the
    // DETAIL_ROUTES table in remote-server.ts so a mounted pane's fetch resolves
    // against the real builders instead of falling through to the Vite proxy.
    if (req.method === "GET" && url.pathname.startsWith("/api/")) {
      const resourceKey = detailResourceKey(url);
      if (resourceKey) {
        if (!isKnownResourceKey(resourceKey)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Missing or invalid resource id" }));
          return;
        }
        if (!resourceProfileAuthorized(payload, profileId, resourceKey)) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Resource is not in your active profile" }));
          return;
        }
        const detail = buildResourceDetail(payload, profileId, resourceKey);
        res.writeHead(detail ? 200 : 404, { "Content-Type": "application/json" });
        res.end(JSON.stringify(detail ?? { error: "Resource not available yet" }));
        return;
      }
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
            setActiveWorkspace(payload, String(wsId));
          }
          broadcastState();
        }

        // Settings update — merge into settings
        if (url.pathname.endsWith("/settings/update") && body.settings) {
          Object.assign(payload.appState.settings, body.settings);
          broadcastState();
        }

        if (url.pathname.endsWith("/workspace-grid/enable")) {
          const layout = String(body.layout || "");
          const cellWorkspaceIds = normalizeWorkspaceGridIds(layout, body.workspaceIds);
          if (cellWorkspaceIds) {
            payload.appState.workspaceGrid = { layout, cellWorkspaceIds };
            broadcastState();
          }
        }

        if (url.pathname.endsWith("/workspace-grid/disable")) {
          payload.appState.workspaceGrid = null;
          broadcastState();
        }

        if (url.pathname.endsWith("/workspace-grid/set-layout")) {
          const layout = String(body.layout || "");
          const cellWorkspaceIds = compactWorkspaceGridIds(layout, payload.appState.workspaceGrid?.cellWorkspaceIds);
          if (payload.appState.workspaceGrid && cellWorkspaceIds) {
            payload.appState.workspaceGrid.layout = layout;
            payload.appState.workspaceGrid.cellWorkspaceIds = cellWorkspaceIds;
            broadcastState();
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
            broadcastState();
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
            broadcastState();
          }
        }

        // --- Git stash endpoints (data-driven from the fixture's __stash blob) ---
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: fixture JSON is untyped server state blob
        const stash: any = (payload.__stash ||= { list: [], files: {}, diff: {} });
        if (url.pathname.endsWith("/git/stash-list")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, stashes: stash.list, summary: `${stash.list.length} stash(es)` }));
          return;
        }
        if (url.pathname.endsWith("/git/stash-files")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, files: stash.files[body.ref] || [], baseCommit: "", summary: "" }));
          return;
        }
        if (url.pathname.endsWith("/git/stash-file-diff")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              ok: true,
              language: "typescript",
              leftLabel: "base",
              rightLabel: body.ref,
              ...stash.diff,
            }),
          );
          return;
        }
        if (url.pathname.endsWith("/git/stash-export")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              ok: true,
              patch: "# strideterm-stash-patch v1\ndiff --git a/x b/x\n",
              suggestedFilename: "stash-0.patch",
              summary: "ok",
            }),
          );
          return;
        }
        if (url.pathname.endsWith("/git/stash-drop") || url.pathname.endsWith("/git/stash-pop")) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT
          stash.list = stash.list.filter((e: any) => e.ref !== body.ref);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({ payload, result: { ok: true, summary: "Stash removed.", warnings: [], conflicts: [] } }),
          );
          return;
        }
        // Prepend a new entry to the stash stack (re-indexing the rest), used by
        // both "New stash…" (POST /git/stash) and patch import.
        const prependStash = (customMessage: string, branch: string) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT
          const shifted = stash.list.map((e: any, i: number) => ({ ...e, index: i + 1, ref: `stash@{${i + 1}}` }));
          stash.list = [
            {
              index: 0,
              ref: "stash@{0}",
              date: new Date().toISOString(),
              author: "Tester",
              branch,
              baseCommit: "",
              baseSubject: "",
              message: customMessage ? `On ${branch}: ${customMessage}` : `WIP on ${branch}`,
              customMessage,
              isWipDefault: !customMessage,
              fileCount: 1,
            },
            ...shifted,
          ];
        };
        if (url.pathname.endsWith("/git/stash")) {
          const ws = payload.git?.workspaces?.[body.workspaceId];
          prependStash(String(body.message || ""), String(ws?.branch || "master"));
          // Creating a stash cleans the working tree.
          if (ws) {
            ws.dirty = false;
            ws.dirtyCount = 0;
            ws.stashCount = stash.list.length;
          }
          broadcastState();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              payload,
              result: { ok: true, summary: "Saved working directory.", warnings: [], conflicts: [] },
            }),
          );
          return;
        }
        if (url.pathname.endsWith("/git/stash-import")) {
          const ws = payload.git?.workspaces?.[body.workspaceId];
          prependStash(String(body.message || "Imported stash"), String(ws?.branch || "master"));
          if (ws) ws.stashCount = stash.list.length;
          broadcastState();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ payload, result: { ok: true, summary: "Imported.", warnings: [], conflicts: [] } }));
          return;
        }
        if (url.pathname.endsWith("/git/stash-apply")) {
          // Applying a stash drops its changes into the working tree, dirtying it.
          const ws = payload.git?.workspaces?.[body.workspaceId];
          if (ws) {
            ws.dirty = true;
            ws.dirtyCount = (ws.dirtyCount || 0) + 1;
          }
          broadcastState();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ payload, result: { ok: true, summary: "Applied.", warnings: [], conflicts: [] } }));
          return;
        }
        if (url.pathname.endsWith("/git/stash-branch")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ payload, result: { ok: true, summary: "Done.", warnings: [], conflicts: [] } }));
          return;
        }

        // File read — return injected content if available
        if (url.pathname.endsWith("/file/read") && body.relativePath !== undefined) {
          const content = fileContents[body.relativePath] ?? "";
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ content }));
          return;
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        // Navigation mutations (activate/save/reorder/grid/settings) fall through
        // here and the client ADOPTS the response — so a v2 client must receive
        // the slim core, never the full desktop payload (matches remote-server's
        // adaptRemoteResponse). Refresh/domain mutations are discarded client-side.
        res.end(JSON.stringify(adaptForClient(payload, reqProtocol)));
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

  /** Push a fresh state snapshot to every socket in its negotiated shape (slim
   *  v2 core or full legacy payload), bumping the broadcast revision so the
   *  client's acceptCoreRevision gate applies it. Then re-invalidate each
   *  socket's interested detail resources so mounted panes stay current. */
  function broadcastState(): void {
    coreRevision += 1;
    for (const ws of sockets) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      const proto = socketProtocol.get(ws) ?? REMOTE_STATE_PROTOCOL;
      ws.send(JSON.stringify({ type: "state:updated", payload: adaptForClient(payload, proto) }));
      pushInvalidations(ws);
    }
  }

  /** Tell one socket that each of its interested detail resources may have
   *  changed (revision derived from the payload). The client refetches only when
   *  its cached revision is stale — mirrors remote-server's invalidation push. */
  function pushInvalidations(ws: WebSocket): void {
    const interests = socketInterests.get(ws);
    if (!interests || ws.readyState !== WebSocket.OPEN) return;
    for (const resource of interests) {
      ws.send(
        JSON.stringify({
          type: "resource:invalidate",
          payload: { resource, revision: resourceRevision(payload, resource) },
        }),
      );
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
      const wsProtocol = protocolFrom(url, req.headers);
      wss.handleUpgrade(req, socket as import("node:net").Socket, head, (ws) => {
        sockets.add(ws);
        socketProtocol.set(ws, wsProtocol);
        ws.on("close", () => {
          sockets.delete(ws);
          socketProtocol.delete(ws);
          socketInterests.delete(ws);
        });
        // Record terminal input so tests can assert what the frontend wrote
        // to a PTY (real remote-server forwards these to the runtime), and track
        // detail-resource interests so we can push resource:invalidate.
        ws.on("message", (raw) => {
          try {
            const msg = JSON.parse(String(raw));
            if (msg?.type === "terminal:input" && typeof msg.sessionId === "string") {
              terminalInputs.push({ sessionId: msg.sessionId, data: String(msg.data ?? "") });
            } else if (msg?.type === "resource:interest" && Array.isArray(msg.resources)) {
              const interests = new Set<string>(
                msg.resources.filter((r: unknown): r is string => typeof r === "string"),
              );
              socketInterests.set(ws, interests);
              // Immediately invalidate the newly-interested resources so the
              // client fetches their detail (matches remote-server behaviour).
              pushInvalidations(ws);
            } else if (msg?.type === "state:sync") {
              // Bootstrap→WS handoff: if the client's revision is behind, send it
              // the current core. In tests state rarely moves in that window, so
              // this is usually a no-op.
              if (typeof msg.rev === "number" && msg.rev < coreRevision && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: "state:updated", payload: adaptForClient(payload, wsProtocol) }));
              }
            }
          } catch {
            // Non-JSON frames are not part of the app protocol — ignore.
          }
        });
        ws.send(JSON.stringify({ type: "state:updated", payload: adaptForClient(payload, wsProtocol) }));
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
    terminalInputs,
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
