/// <reference types="node" />
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { WebSocketServer } from "ws";
import * as fm from "./file-manager.js";
import {
  dockerActionSchema,
  dockerComposeActionSchema,
  dockerInspectSchema,
  dockerLogsCloseSchema,
  dockerLogsOpenSchema,
  dockerLogsUpdateSchema,
  dockerPruneSchema,
  dockerRemoveSchema,
  dockerResourceRefSchema,
  dockerStatsSchema,
  dockerSystemDfSchema,
  dockerTopSchema,
  dockerVolumeBrowseSchema,
  gitBranchDeleteSchema,
  gitBranchListSchema,
  gitBranchRenameSchema,
  gitCheckoutRemoteSchema,
  gitLogGraphSchema,
  gitPayloadSchema,
  gitRemoteBranchDeleteSchema,
  gitStashApplySchema,
  gitStashBranchSchema,
  gitStashDropSchema,
  gitStashExportSchema,
  gitStashFileDiffSchema,
  gitStashFilesSchema,
  gitStashImportSchema,
  gitStashListSchema,
  taskUpdateDescriptionSchema,
  terminalSessionSchema,
  validateIpc,
  workspaceDeleteOptionsSchema,
  workspaceIdSchema,
  workspaceGridEnableSchema,
  workspaceGridSetCellSchema,
  workspaceGridSetLayoutSchema,
  workspaceGridSwapCellsSchema,
  wsTerminalInputSchema,
  wsTerminalResizeSchema,
} from "./ipc-schemas.js";
import { getLogger, createAuditLogger } from "./logger.js";
import { RemoteClientRegistry } from "./remote-client-registry.js";
import { remoteViewerId } from "./viewer-id.js";

/**
 * Cookie carrying a per-session ID. Once the user has bootstrapped via the
 * token-bearing share URL, the cookie is what every subsequent request
 * authenticates with — the master token is never sent again from a normal
 * browser session, so it stops appearing in URL bars, browser history,
 * proxy logs, screen shares, or accidental "copy this link" leaks.
 *
 * The cookie value is a fresh 256-bit random per session, *not* the
 * master token, so even if the cookie store is somehow exfiltrated we
 * don't lose the long-lived token. It survives only in this process —
 * regenerating the token (or restarting the server, which happens on
 * any settings change) tears down all sessions.
 *
 * Attributes:
 *   - HttpOnly: JS can't read it (mitigates XSS-driven session theft).
 *   - SameSite=Strict: browser only sends it on first-party requests,
 *     so even if a leaked URL is opened in another tab the cookie won't
 *     ride a cross-origin form post.
 *   - Path=/: applies to every endpoint on this origin.
 *   - Secure: appended only when `X-Forwarded-Proto: https` indicates the
 *     browser ↔ proxy hop was TLS (Cloudflare tunnel, reverse proxy). For
 *     bare HTTP LAN we omit it — `Secure` would forbid the browser from
 *     ever sending the cookie back, breaking the LAN bootstrap. See
 *     `buildSessionCookieAttrs` below.
 */
const SESSION_COOKIE_NAME = "strideterm_session";
const SESSION_COOKIE_ATTRS_BASE = "HttpOnly; SameSite=Strict; Path=/";

/**
 * Decide whether the cookie should carry the `Secure` attribute. When the
 * client reaches us through Cloudflare tunnel (or any other HTTPS reverse
 * proxy) the request socket is plain HTTP from the proxy → us, but the
 * browser ↔ proxy hop is TLS. The proxy advertises that via
 * `X-Forwarded-Proto: https`, and the browser will only consent to send a
 * `Secure` cookie back over the same scheme. Skipping `Secure` for the bare
 * LAN-HTTP case (no proxy) keeps the LAN bootstrap working — browsers scope
 * cookies by origin so an HTTP and HTTPS deployment never see each other's
 * cookies anyway, but adding `Secure` to an HTTPS-fronted deployment closes
 * the door on accidental insecure-channel echoes (e.g. tooling that strips
 * TLS for debugging).
 */
export function buildSessionCookieAttrs(headers: IncomingMessage["headers"]): string {
  const proto = String(headers["x-forwarded-proto"] || "")
    .toLowerCase()
    .split(",")[0]
    .trim();
  if (proto === "https") return `${SESSION_COOKIE_ATTRS_BASE}; Secure`;
  return SESSION_COOKIE_ATTRS_BASE;
}

const log = getLogger("remote-server");

/**
 * Heartbeat interval for remote WebSocket clients. Each tick we send a
 * ping; we only terminate a client after WS_HEARTBEAT_MAX_MISSED consecutive
 * ticks with no pong, not on the first miss.
 *
 * 20s is short enough to keep most NAT mappings (typical home-router UDP/TCP
 * keepalive is 30–60s) and long enough to be a rounding error on traffic.
 * The previous 30s "one strike and you're out" config evicted mobile clients
 * on a single sub-second network blip — a phone briefly losing 4G on a
 * subway stop reliably tripped a termination, then the client reconnected,
 * which spammed `WebSocket heartbeat timeout` warnings every few minutes
 * and silently lost any in-flight push notifications during the gap.
 *
 * MAX_MISSED=3 means a client must be unreachable for ~60s before we drop
 * it — still bounded so leaked tokens / kernel-dead sockets clean up, but
 * forgiving enough that flaky mobile networks don't get into reconnect
 * loops.
 */
const WS_HEARTBEAT_INTERVAL_MS = 20_000;
const WS_HEARTBEAT_MAX_MISSED = 3;

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;

/**
 * Minimal Runtime interface covering the methods used in the remote server.
 * The actual runtime object returned by createRuntime() satisfies this shape.
 */
interface Runtime {
  getPayload(): {
    appState: {
      settings: {
        remoteAccess: { enabled: boolean; host: string; port: number; token: string };
      };
    };
  };
  getInitialState(): Promise<unknown>;
  setRemoteInfo(info: { enabled: boolean; urls?: string[]; port?: number; host?: string; error?: string }): void;
  listRemoteUrls(): string[];
  on(channel: string, handler: AnyFn): () => void;
  writeToSession(sessionId: string, data: string, viewerId?: string): unknown;
  resizeSession(sessionId: string, size: { cols: number; rows: number }): void;
  // All other methods accessed dynamically via string keys
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

/**
 * Defence-in-depth response headers applied to every HTTP response.
 *
 *  - `Content-Security-Policy` — restricts what the browser may load or
 *    execute. `default-src 'none'` blocks everything not explicitly listed.
 *    `script-src 'self'` allows only same-origin JS bundles (Vite output).
 *    `style-src 'self' 'unsafe-inline'` allows same-origin CSS plus inline
 *    styles that xterm.js and Monaco inject at runtime.
 *    `connect-src 'self' ws: wss:` allows WebSocket back to the server.
 *    `worker-src 'self' blob:` allows Monaco's web workers (created via
 *    blob: URLs from the same origin).
 *    `img-src 'self' data: blob:` allows inline SVGs and canvas exports.
 *    `font-src 'self' data:` allows the embedded terminal font.
 *    `frame-ancestors 'none'` is a stronger X-Frame-Options equivalent.
 *    `base-uri 'self'` prevents <base href="..."> injection.
 *    `form-action 'none'` — the remote UI has no forms.
 *  - `X-Content-Type-Options: nosniff` — browser must trust our explicit
 *    Content-Type and not MIME-sniff a `.json` blob into HTML.
 *  - `X-Frame-Options: DENY` — strideterm never renders inside a frame;
 *    block clickjacking attempts that would embed the remote UI.
 *  - `Referrer-Policy: no-referrer` — prevents the access token (which
 *    rides in `?token=...`) from leaking to third-party origins via
 *    Referer when the user clicks an external link.
 *  - `Cache-Control: no-store` — JSON state and HTML responses include
 *    workspace metadata; do not let a shared HTTP cache (or the browser
 *    history) hold onto it.
 *  - `Permissions-Policy` — disables browser features that the remote UI
 *    never uses (camera, microphone, geolocation, payment).
 */
const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "connect-src 'self' ws: wss:",
    "worker-src 'self' blob:",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'none'",
  ].join("; "),
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};

function writeHead(response: ServerResponse, statusCode: number, headers: Record<string, string>): void {
  response.writeHead(statusCode, { ...SECURITY_HEADERS, ...headers });
}

/**
 * Settings on `remoteAccess` that a remote caller (HTTP-side updateSettings)
 * may not change. Local IPC bypasses this filter — the desktop Settings UI
 * needs to be able to flip these freely.
 *
 * Why each is dangerous when reachable from a leaked-token attacker:
 *   - `cloudflaredPath`: tunnel-manager spawns this binary directly. Combined
 *     with file-write into a workspace cwd (allowed by the file-API
 *     allowlist) it's a one-shot RCE — drop a script, repoint the path,
 *     POST /api/tunnel/create.
 *   - `enabled`/`host`/`port`: change how the server binds. Disabling kicks
 *     the legitimate user off; widening `host` increases exposure.
 *   - `token`: rotating invalidates every existing session and locks the
 *     legitimate user out until they walk back to the desktop.
 *   - `customPublicUrl`: display-only metadata, but the desktop "Copy share
 *     URL" affordance reads it — rewriting it from a leaked session turns the
 *     local user into an unwitting phishing courier. See the inline comment
 *     in the array below for the full rationale.
 */
export const REMOTE_BLOCKED_REMOTE_ACCESS_FIELDS: ReadonlyArray<string> = [
  // `autoTunnel` gates whether the Cloudflare quick-tunnel is re-established
  // on the next desktop startup (runtime.ts:3429). Starting a tunnel right
  // now is already a legitimate remote action via POST /api/tunnel/create,
  // but that path is overt — the user sees the tunnel state in the UI
  // immediately. Flipping `autoTunnel` is the *quiet* version: an attacker
  // with a leaked session can persist the tunnel across restarts without
  // having to keep calling /api/tunnel/create, and the user only finds out
  // when they notice cloudflared running on next launch. Per invariant M1/S1,
  // any remoteAccess.* field that triggers process spawn is blocklisted; this
  // field is the trigger. Legitimate writers (createCloudflareTunnel /
  // stopCloudflareTunnel in runtime.ts) flip it as a server-side side-effect,
  // never via /api/settings/update, so the blocklist costs no UX.
  "autoTunnel",
  "cloudflaredPath",
  "enabled",
  "host",
  "port",
  "token",
  // `customPublicUrl` is display-only metadata — but the desktop "Copy share
  // URL" affordance reads it, so a leaked-token attacker rewriting it to
  // `https://evil/strideterm` turns the local user into an unwitting phishing
  // courier. Blast radius is small (token leak already grants RCE-equivalent
  // access), but the fix is one entry and the lost capability — "edit my
  // VPS URL from the phone" — is rare enough to walk back to the desktop.
  "customPublicUrl",
];

/**
 * Top-level settings keys (sibling to `remoteAccess`, directly under
 * `state.settings.X`) that a remote caller may not change. Same threat model
 * as REMOTE_BLOCKED_REMOTE_ACCESS_FIELDS — a leaked-token attacker must not be
 * able to repoint a binary the local desktop will later spawn — but these
 * fields don't live under `remoteAccess`, so the per-field loop on that
 * subtree wouldn't see them.
 *
 *   - `externalPathOpener`: when `mode === "command"`, the desktop main
 *     process spawns `command` (parsed argv-style) every time the user
 *     clicks a path link in terminal output. Allowing a remote caller to
 *     repoint this turns a benign local action ("click a filename in my
 *     terminal") into arbitrary code execution. Per invariant S1 ("any
 *     user-configurable binary path pattern automatically belongs in the
 *     remote blocklist"), this entry is mandatory; do not relax it.
 *
 *     The whole subtree is dropped (not per-field) because `mode` and
 *     `command` are jointly part of the spawn chain — flipping `mode` from
 *     `"system"` to `"command"` is half the exploit by itself.
 *
 *   - `externalEditor`: same threat as `externalPathOpener.command` — the
 *     desktop spawns this binary with the clicked file path as argv on every
 *     terminal path link click. A remote caller repointing it to
 *     `C:\\Users\\<me>\\malware.exe` (or any local binary they smuggled in
 *     via an earlier upload primitive) gets RCE the next time the local user
 *     clicks a path in their terminal.
 *
 *   - `terminalFontSizeLocal`: not a security threat — a transport-isolation
 *     invariant. Desktop and remote/mobile clients each persist their own
 *     terminal font size (`terminalFontSizeLocal` vs `terminalFontSizeRemote`)
 *     so the two never overwrite each other when both are connected. Remote
 *     clients may freely write the `Remote` key but must not touch the
 *     `Local` one.
 *
 *   - `clipboardImagePasteDir`: filesystem path that the desktop main
 *     process writes PNGs into when the user pastes a screenshot. A
 *     remote caller repointing it (e.g. into a Startup folder or to
 *     overwrite a sensitive file via a chosen filename) turns paste-
 *     into-terminal into an arbitrary file-write primitive. Per
 *     invariant S1 ("any user-configurable filesystem path the desktop
 *     later writes to belongs in the remote blocklist"), this entry is
 *     mandatory.
 */
export const REMOTE_BLOCKED_TOP_LEVEL_FIELDS: ReadonlyArray<string> = [
  "externalPathOpener",
  "externalEditor",
  "terminalFontSizeLocal",
  // `clipboardImagePasteDir` decides where the desktop main process
  // writes PNGs on Ctrl+V of a screenshot. A remote caller repointing
  // it (e.g. to `C:\\Users\\<me>\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\`)
  // turns a benign local action into arbitrary file writes at attacker-
  // controlled paths on the next paste. Per invariant S1 (any user-
  // configurable filesystem path that the desktop later writes to
  // belongs in the remote blocklist), this entry is mandatory.
  "clipboardImagePasteDir",
];

/**
 * Apply the same blocklist `/api/settings/update` enforces. Exported for
 * tests; mutates `settings` in place to drop both the blocked top-level keys
 * and the blocked `remoteAccess` keys, and returns the names of fields that
 * were actually present so the caller can audit-log the drop.
 */
export function sanitizeSettingsFromRemote(settings: Record<string, unknown>): string[] {
  const removed: string[] = [];
  // Top-level subtrees first — these are dropped wholesale.
  for (const key of REMOTE_BLOCKED_TOP_LEVEL_FIELDS) {
    if (key in settings) {
      delete settings[key];
      removed.push(key);
    }
  }
  // Per-field drop inside `remoteAccess` (preserves non-blocked siblings).
  const remoteAccess = settings.remoteAccess as Record<string, unknown> | undefined;
  if (remoteAccess && typeof remoteAccess === "object") {
    for (const key of REMOTE_BLOCKED_REMOTE_ACCESS_FIELDS) {
      if (key in remoteAccess) {
        delete remoteAccess[key];
        removed.push(key);
      }
    }
  }
  return removed;
}

/**
 * Strip server-side secrets that a remote browser must never see in JSON
 * responses or `state:updated` broadcasts. Today that's only the master
 * access token — every other remote-only secret either rides outside the
 * payload (Set-Cookie session id) or is intentionally part of the share-URL
 * UX (`payload.remoteAccess.urls[*]` still embeds `?token=…`, accepted by
 * SEC-004 as the cost of a working "Copy share URL" button).
 *
 * This is defense in depth: the desktop Electron renderer reads state via
 * IPC, not /api/state, so stripping for the HTTP/WS path doesn't break any
 * local UI. A remote browser that wants to hand off the share URL still has
 * `payload.remoteAccess.urls`; UIs that surface the bare token (e.g.
 * "Token: <value>" in a settings panel) will now see an empty string when
 * loaded over remote, which is the desired outcome.
 *
 * Returns the input unchanged when it doesn't look like a runtime payload —
 * safe to wrap every JSON response, including `{ ok: true }` and error
 * envelopes.
 */
export function stripSecretsForRemote(body: unknown): unknown {
  if (!body || typeof body !== "object") return body;
  const payload = body as Record<string, unknown>;
  const appState = payload.appState as Record<string, unknown> | undefined;
  const settings = appState?.settings as Record<string, unknown> | undefined;
  const remoteAccess = settings?.remoteAccess as Record<string, unknown> | undefined;
  if (!remoteAccess || typeof remoteAccess !== "object") return body;
  return {
    ...payload,
    appState: {
      ...appState,
      settings: {
        ...settings,
        remoteAccess: { ...remoteAccess, token: "" },
      },
    },
  };
}

function json(response: ServerResponse, statusCode: number, body: unknown): void {
  writeHead(response, statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(stripSecretsForRemote(body)));
}

const MAX_BODY_SIZE = 5 * 1024 * 1024; // 5 MB

function readRequestBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = "";
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        request.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      raw += chunk.toString();
    });
    request.on("end", () => {
      if (!raw.trim()) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(raw) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function getTokenFromRequest(requestUrl: string, headers: IncomingMessage["headers"]): string {
  const url = new URL(requestUrl, "http://localhost");
  const header = (headers.authorization as string) || "";
  if (header.toLowerCase().startsWith("bearer ")) {
    return header.slice(7);
  }

  return url.searchParams.get("token") || "";
}

/**
 * Pull the session id out of the Cookie header. The header is a
 * single-line `name=value; name2=value2; …` blob; we only care about
 * our own cookie so a forgiving parser is fine.
 */
function getSessionFromRequest(headers: IncomingMessage["headers"]): string {
  const raw = (headers.cookie as string) || "";
  if (!raw) return "";
  for (const part of raw.split(";")) {
    const trimmed = part.trim();
    if (!trimmed.startsWith(`${SESSION_COOKIE_NAME}=`)) continue;
    return trimmed.slice(SESSION_COOKIE_NAME.length + 1).trim();
  }
  return "";
}

function getClientIdFromRequest(requestUrl: string, headers: IncomingMessage["headers"]): string {
  const header = headers["x-strideterm-client-id"];
  const fromHeader = Array.isArray(header) ? header[0] : header;
  const raw = fromHeader || new URL(requestUrl || "/", "http://localhost").searchParams.get("clientId") || "";
  const normalized = String(raw).trim();
  return /^[a-zA-Z0-9_-]{8,80}$/.test(normalized) ? normalized : "";
}

function remoteSessionRef(sessionId: string): string {
  if (!sessionId) return "none";
  const kind = sessionId.startsWith("token-client:") ? "token-client" : "cookie";
  const digest = createHash("sha256").update(sessionId).digest("hex").slice(0, 12);
  return `${kind}:${digest}`;
}

/**
 * Constant-time string comparison for token validation. Prevents timing
 * attacks where the attacker probes the token byte-by-byte by measuring
 * how long the server takes to reject each guess.
 *
 * `timingSafeEqual` requires equal-length buffers, so we short-circuit
 * the length check before the cryptographic compare. The empty-token
 * case is handled explicitly because `Buffer.from("")` is also length 0
 * and would compare equal to itself.
 */
function tokensEqual(a: string, b: string): boolean {
  if (!a || !b) return false;
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

function listRemoteUrls(host: string, port: number, token: string): string[] {
  const urls: string[] = [];
  const interfaces = os.networkInterfaces();

  if (host === "0.0.0.0") {
    for (const addresses of Object.values(interfaces)) {
      for (const address of addresses || []) {
        if (address.family === "IPv4" && !address.internal) {
          urls.push(`http://${address.address}:${port}/?token=${token}`);
        }
      }
    }
  } else {
    urls.push(`http://${host}:${port}/?token=${token}`);
  }

  return urls;
}

async function serveStatic(staticRoot: string, requestUrl: string, response: ServerResponse): Promise<void> {
  const url = new URL(requestUrl, "http://localhost");
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const resolvedPath = path.normalize(path.join(staticRoot, pathname));
  const safeRoot = path.normalize(staticRoot);
  if (!resolvedPath.startsWith(safeRoot)) {
    writeHead(response, 403, {});
    response.end("Forbidden");
    return;
  }

  let finalPath = resolvedPath;
  if (!existsSync(finalPath)) {
    // SPA fallback: route-style paths (no extension, e.g. /workspace/abc) get
    // index.html so client-side routing works on hard refresh. But hashed
    // assets (/assets/foo-XXX.js, .css, .map, etc.) must NOT fall back to
    // HTML — the browser's strict-MIME check rejects HTML for module
    // <script> tags and the page crashes with "Failed to load module
    // script". Return 404 instead so a stale chunk after a fresh build
    // surfaces as a clean error rather than a misleading HTML response.
    if (url.pathname.startsWith("/assets/") || /\.[a-zA-Z0-9]+$/.test(url.pathname)) {
      // Return 404 *with the requested file's MIME* so the browser surfaces a
      // plain "asset 404" rather than the extra-loud "Refused to apply style
      // because MIME ('text/plain') is wrong" message that fires whenever a
      // 404 carries text/plain for a <link rel=stylesheet> or module script.
      // The latter masks the real problem (stale chunk hash after rebuild) in
      // a wall of MIME-policy text.
      const ext = path.extname(url.pathname);
      const ct = CONTENT_TYPES[ext] || "text/plain; charset=utf-8";
      writeHead(response, 404, { "Content-Type": ct });
      response.end("");
      return;
    }
    finalPath = path.join(staticRoot, "index.html");
  }

  try {
    const buffer = await fs.readFile(finalPath);
    const contentType = CONTENT_TYPES[path.extname(finalPath)] || "application/octet-stream";
    writeHead(response, 200, { "Content-Type": contentType });
    response.end(buffer);
  } catch {
    writeHead(response, 503, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("strIDEterm remote UI is unavailable until the renderer build exists.");
  }
}

async function handleApiRequest(
  runtime: Runtime,
  request: IncomingMessage,
  response: ServerResponse,
  broadcast: (message: unknown) => void = () => {},
): Promise<void> {
  const url = new URL(request.url!, "http://localhost");

  try {
    if (request.method === "GET" && url.pathname === "/api/state") {
      json(response, 200, await runtime.getInitialState());
      return;
    }

    const body = await readRequestBody(request);

    if (
      request.method === "POST" &&
      (url.pathname === "/api/workspace/activate" || url.pathname === "/api/project/activate")
    ) {
      json(response, 200, await runtime.activateWorkspace((body.workspaceId || body.projectId) as string));
      return;
    }

    if (request.method === "POST" && (url.pathname === "/api/workspace/save" || url.pathname === "/api/project/save")) {
      json(response, 200, await runtime.saveWorkspace(body.workspace || body.project));
      return;
    }

    if (
      request.method === "POST" &&
      (url.pathname === "/api/workspace/delete" || url.pathname === "/api/project/delete")
    ) {
      const wsId = validateIpc(
        workspaceIdSchema,
        body.workspaceId || body.projectId,
        "remote:workspace/delete.workspaceId",
      );
      const opts = validateIpc(
        workspaceDeleteOptionsSchema,
        { deleteFromDisk: body.deleteFromDisk, diskPath: body.diskPath },
        "remote:workspace/delete.options",
      );
      json(response, 200, await runtime.deleteWorkspace(wsId, opts));
      return;
    }

    if (
      request.method === "POST" &&
      (url.pathname === "/api/workspace/reorder" || url.pathname === "/api/project/reorder")
    ) {
      json(response, 200, await runtime.reorderWorkspaces((body.workspaceIds || body.projectIds || []) as string[]));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/settings/update") {
      // Drop fields a remote caller is never authorised to change. See
      // REMOTE_BLOCKED_REMOTE_ACCESS_FIELDS and REMOTE_BLOCKED_TOP_LEVEL_FIELDS
      // for the rationale; the short version is "anything that controls a
      // binary spawn or the network bind/auth knobs". Mutating the parsed body
      // in place is fine — it isn't shared.
      //
      // We log every actual drop at warn-level so a leaked-token probe (or a
      // confused mobile UI sending desktop-only fields) leaves an
      // investigatable trail in the strideterm log; the per-request audit log
      // already records the request itself, this entry is the "and here's
      // what we silently stripped from it" annotation.
      const settings = (body.settings || {}) as Record<string, unknown>;
      const droppedFields = sanitizeSettingsFromRemote(settings);
      if (droppedFields.length > 0) {
        log.warn("remote settings update: dropped privileged fields", {
          fields: droppedFields,
          remoteAddress: request.socket?.remoteAddress,
        });
      }
      const result = await runtime.updateSettings(settings);
      json(response, 200, result.payload);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/azure/verify-connection") {
      json(response, 200, await runtime.verifyAzureConnection(body.connection || {}));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/azure/save-connection") {
      const result = await runtime.saveAzureConnection(body.connection || {});
      json(response, 200, result.payload);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/azure/delete-connection") {
      json(response, 200, await runtime.deleteAzureConnection(body.connectionId));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/azure/refresh") {
      json(response, 200, await runtime.refreshAzureState());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/azure/audit-log/query") {
      json(response, 200, runtime.queryAzureAuditLog(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/azure/audit-log/stats") {
      json(response, 200, runtime.getAzureAuditStats(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/azure/pull-request/seen") {
      json(response, 200, await runtime.markAzurePullRequestSeen(body.prKey));
      return;
    }

    // /api/azure/pull-request/open is handled in the outer dispatch so it can
    // resolve the bound windowId from the remote-client registry; reaching
    // here would mean the route bypassed that intercept.

    if (request.method === "POST" && url.pathname === "/api/azure/pull-request/comment") {
      json(response, 200, await runtime.commentAzurePullRequest(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/azure/pull-request/thread-status") {
      json(response, 200, await runtime.updateAzureThreadStatus(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/review-bridge/draft-comment/create") {
      json(response, 200, await runtime.createReviewBridgeDraftComment(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/review-bridge/draft/save") {
      json(response, 200, await runtime.saveReviewBridgeDraft(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/review-bridge/draft/queue") {
      json(response, 200, await runtime.queueReviewBridgeDraft(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/review-bridge/draft/delete") {
      json(response, 200, await runtime.deleteReviewBridgeDraft(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/review-bridge/comment/delete") {
      json(response, 200, await runtime.deleteReviewBridgeComment(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/review-bridge/agent-prompt/reset") {
      json(response, 200, await runtime.resetAgentPrompts());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/review-bridge/comment/reply-with-changes") {
      json(response, 200, await runtime.replyWithCodeChanges(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/review-bridge/pull-request/sync") {
      json(response, 200, await runtime.syncReviewBridgePullRequest(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/review-bridge/pull-request/push-and-publish") {
      json(response, 200, await runtime.pushAndPublishReview(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/azure/pull-request/vote") {
      json(response, 200, await runtime.voteAzurePullRequest(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/azure/workspace/fetch") {
      json(response, 200, await runtime.fetchAzureReviewWorkspace(body.workspaceId));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/azure/workspace/rebase") {
      json(response, 200, await runtime.rebaseAzureReviewWorkspace(body.workspaceId));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/azure/workspace/push") {
      json(
        response,
        200,
        await runtime.pushAzureReviewWorkspace(body.workspaceId as string, { force: Boolean(body.force) }),
      );
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/azure/create-pull-request") {
      json(response, 200, await runtime.azureCreatePullRequest(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/azure/list-remote-branches") {
      json(response, 200, await runtime.azureListRemoteBranches(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/azure/quickfix/list-projects") {
      json(response, 200, await runtime.azureQuickFixListProjects(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/azure/quickfix/list-repositories") {
      json(response, 200, await runtime.azureQuickFixListRepositories(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/azure/quickfix/list-branches") {
      json(response, 200, await runtime.azureQuickFixListBranches(body));
      return;
    }

    // /api/azure/quickfix/create is handled in the outer dispatch (slot-aware).
    if (request.method === "POST" && url.pathname === "/api/azure/rerun-check") {
      json(response, 200, await runtime.rerunAzureCheck(body.prKey, body.checkItem));
      return;
    }

    // Pipelines tab — connectionId-addressed reads/actions, handled inline like
    // the quickfix reads above (they don't touch local workspace/slot state).
    if (request.method === "POST" && url.pathname === "/api/azure/pipelines/list") {
      json(response, 200, await runtime.listAzurePipelines(body));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/azure/pipelines/runs") {
      json(response, 200, await runtime.listAzurePipelineRuns(body));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/azure/pipelines/run-seed") {
      json(response, 200, await runtime.getAzurePipelineRunSeed(body));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/azure/pipelines/run") {
      json(response, 200, await runtime.runAzurePipeline(body));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/azure/pipelines/run-status") {
      json(response, 200, await runtime.getAzurePipelineRunStatus(body));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/azure/pipelines/cancel") {
      json(response, 200, await runtime.cancelAzureBuild(body));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/azure/pipelines/build-log") {
      json(response, 200, await runtime.getAzureBuildLog(body));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/azure/pipelines/run-detail") {
      json(response, 200, await runtime.getAzurePipelineRunDetail(body));
      return;
    }

    // --- GitHub ---
    if (request.method === "POST" && url.pathname === "/api/github/verify-connection") {
      json(response, 200, await runtime.verifyGitHubConnection(body.connection || {}));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/github/save-connection") {
      const result = await runtime.saveGitHubConnection(body.connection || {});
      json(response, 200, result.payload);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/github/delete-connection") {
      json(response, 200, await runtime.deleteGitHubConnection(body.connectionId));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/github/refresh") {
      json(response, 200, await runtime.refreshGitHubState());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/github/audit-log/query") {
      json(response, 200, runtime.queryGitHubAuditLog(body));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/github/audit-log/stats") {
      json(response, 200, runtime.getGitHubAuditStats(body));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/github/pull-request/seen") {
      json(response, 200, await runtime.markGitHubPullRequestSeen(body.prKey));
      return;
    }
    // /api/github/pull-request/open is handled in the outer dispatch so it
    // can resolve the bound windowId from the remote-client registry.

    if (request.method === "POST" && url.pathname === "/api/github/pull-request/comment") {
      json(response, 200, await runtime.commentGitHubPullRequest(body));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/github/pull-request/review") {
      json(response, 200, await runtime.submitGitHubPullRequestReview(body));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/github/rerun-check") {
      json(response, 200, await runtime.rerunGitHubCheck(body.prKey, body.checkItem));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/github/workspace/fetch") {
      json(response, 200, await runtime.fetchGitHubReviewWorkspace(body.workspaceId));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/github/workspace/rebase") {
      json(response, 200, await runtime.rebaseGitHubReviewWorkspace(body.workspaceId));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/github/workspace/push") {
      json(response, 200, await runtime.pushGitHubReviewWorkspace(body.workspaceId, body));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/github/list-remote-branches") {
      json(response, 200, await runtime.githubListRemoteBranches(body));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/github/create-pull-request") {
      json(response, 200, await runtime.githubCreatePullRequest(body));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/github/quickfix/list-repos") {
      json(response, 200, await runtime.githubQuickFixListRepos(body));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/github/quickfix/list-branches") {
      json(response, 200, await runtime.githubQuickFixListBranches(body));
      return;
    }
    // /api/github/quickfix/create is handled in the outer dispatch (slot-aware).

    // --- Telegram ---
    if (request.method === "POST" && url.pathname === "/api/telegram/verify-connection") {
      json(response, 200, await runtime.verifyTelegramConnection(body.connection || {}));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/telegram/detect-chats") {
      json(response, 200, await runtime.detectTelegramChats(body.connection || {}));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/telegram/save-connection") {
      const result = await runtime.saveTelegramConnection(body.connection || {});
      json(response, 200, result.payload);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/telegram/delete-connection") {
      json(response, 200, await runtime.deleteTelegramConnection(body.connectionId));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/telegram/refresh") {
      json(response, 200, await runtime.refreshTelegramState());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/remote/token/regenerate") {
      json(response, 200, await runtime.regenerateRemoteToken());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/tunnel/refresh") {
      json(response, 200, await runtime.refreshTunnelState());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/tunnel/create") {
      json(response, 200, await runtime.createCloudflareTunnel());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/tunnel/stop") {
      json(response, 200, await runtime.stopCloudflareTunnel());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/claude-hook/configure") {
      json(response, 200, await runtime.configureClaudeHook());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/claude-hook/remove") {
      json(response, 200, await runtime.removeClaudeHook());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/claude-hook/status") {
      json(response, 200, await runtime.getClaudeHookStatus());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/gemini-hook/configure") {
      json(response, 200, await runtime.configureGeminiHook());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/gemini-hook/remove") {
      json(response, 200, await runtime.removeGeminiHook());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/gemini-hook/status") {
      json(response, 200, await runtime.getGeminiHookStatus());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/claude-hook/test") {
      json(response, 200, await runtime.testClaudeHook());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/gemini-hook/test") {
      json(response, 200, await runtime.testGeminiHook());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/codex-hook/configure") {
      json(response, 200, await runtime.configureCodexHook());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/codex-hook/remove") {
      json(response, 200, await runtime.removeCodexHook());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/codex-hook/status") {
      json(response, 200, await runtime.getCodexHookStatus());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/codex-hook/test") {
      json(response, 200, await runtime.testCodexHook());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/copilot-hook/configure") {
      json(response, 200, await runtime.configureCopilotHook());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/copilot-hook/remove") {
      json(response, 200, await runtime.removeCopilotHook());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/copilot-hook/status") {
      json(response, 200, await runtime.getCopilotHookStatus());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/copilot-hook/test") {
      json(response, 200, await runtime.testCopilotHook());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/opencode-hook/configure") {
      json(response, 200, await runtime.configureOpencodeHook());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/opencode-hook/remove") {
      json(response, 200, await runtime.removeOpencodeHook());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/opencode-hook/status") {
      json(response, 200, await runtime.getOpencodeHookStatus());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/opencode-hook/test") {
      json(response, 200, await runtime.testOpencodeHook());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/check-command") {
      json(response, 200, await runtime.checkCommand(body.command));
      return;
    }

    // --- Task runner ---
    if (request.method === "POST" && url.pathname === "/api/task/recheck-claude") {
      json(response, 200, await runtime.recheckClaude());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/task/check-providers") {
      json(response, 200, await runtime.checkProviders());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/task/check-git-repo") {
      json(response, 200, await runtime.checkIsGitRepo(String(body?.cwd || "")));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/fs/probe-directory") {
      json(response, 200, await runtime.probeDirectory(String(body?.cwd || "")));
      return;
    }
    // /api/task/create is handled in the outer dispatch (slot-aware).
    if (request.method === "POST" && url.pathname === "/api/task/start") {
      json(response, 200, await runtime.startTask(body.workspaceId));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/task/stop") {
      json(response, 200, runtime.stopTask(body.workspaceId));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/task/pause") {
      json(response, 200, runtime.pauseTask(body.workspaceId));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/task/resume") {
      json(response, 200, runtime.resumeTask(body.workspaceId));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/task/reset") {
      json(response, 200, await runtime.resetTask(body.workspaceId));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/task/reject-verdict") {
      json(response, 200, await runtime.rejectTaskVerdict(body.workspaceId, body.feedback));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/task/update-description") {
      // OPEN-5: HTTP path was missing the Zod parse its IPC counterpart uses.
      const parsed = validateIpc(taskUpdateDescriptionSchema, body, "POST /api/task/update-description");
      json(response, 200, await runtime.updateTaskDescription(parsed.workspaceId, parsed.description));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/task-recovery/resolve") {
      json(response, 200, await runtime.resolveTaskRecovery(body.decisions));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/task/status") {
      json(response, 200, runtime.getTaskStatus(body.workspaceId));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/session/activate") {
      json(response, 200, await runtime.activateSession(body.sessionId));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/workspace/set-ui-state") {
      json(response, 200, await runtime.setWorkspaceUIState(body.workspaceId, body.uiState));
      return;
    }

    // /api/workspace-grid/* and /api/attention/* — handled in the slot-aware
    // route block at the server top level so we can resolve windowId from
    // the bound session. The previous inline handlers passed no windowId and
    // the runtime fell back to windowSlots[0]'s profile, letting a remote
    // client on profile B mutate profile A's state.

    if (request.method === "POST" && url.pathname === "/api/terminal/restart") {
      json(response, 200, await runtime.restartSession(body.sessionId));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/terminal/replay") {
      const parsed = validateIpc(terminalSessionSchema, body, "/api/terminal/replay");
      json(response, 200, runtime.getTerminalReplay(parsed.sessionId));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/docker/refresh") {
      json(response, 200, await runtime.refreshDockerState());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/git/refresh") {
      json(response, 200, await runtime.refreshGitState(body.projectId || null));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/git/fetch") {
      json(response, 200, await runtime.gitFetch(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/git/pull") {
      json(response, 200, await runtime.gitPull(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/git/push") {
      json(response, 200, await runtime.gitPush(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/git/checkout-branch") {
      json(response, 200, await runtime.gitCheckoutBranch(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/git/create-branch") {
      json(response, 200, await runtime.gitCreateBranch(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/git/merge-into-current") {
      json(response, 200, await runtime.gitMergeIntoCurrent(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/git/rebase-onto") {
      json(response, 200, await runtime.gitRebaseOnto(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/git/continue") {
      json(response, 200, await runtime.gitContinueOperation(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/git/abort") {
      json(response, 200, await runtime.gitAbortOperation(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/git/diff-preview") {
      json(response, 200, await runtime.gitDiffPreview(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/git/merge-into-base") {
      json(response, 200, await runtime.gitMergeCurrentIntoBase(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/git/remove-worktree") {
      json(response, 200, await runtime.gitRemoveWorktree(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/git/commit-all") {
      json(response, 200, await runtime.gitCommitAll(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/git/stash") {
      json(response, 200, await runtime.gitStash(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/git/stash-pop") {
      json(response, 200, await runtime.gitStashPop(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/git/stash-list") {
      json(response, 200, await runtime.gitListStashes(body));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/git/stash-files") {
      json(response, 200, await runtime.gitStashFiles(body));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/git/stash-file-diff") {
      json(response, 200, await runtime.gitStashFileDiff(body));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/git/stash-apply") {
      json(response, 200, await runtime.gitStashApply(body));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/git/stash-drop") {
      json(response, 200, await runtime.gitStashDrop(body));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/git/stash-branch") {
      json(response, 200, await runtime.gitStashBranch(body));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/git/stash-export") {
      json(response, 200, await runtime.gitStashExport(body));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/git/stash-import") {
      json(response, 200, await runtime.gitStashImport(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/git/commit-diff") {
      json(response, 200, await runtime.gitCommitDiff(body));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/git/commit-info") {
      json(response, 200, await runtime.gitCommitInfo(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/git/log-page") {
      json(response, 200, await runtime.gitLogPage(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/git/list-tags") {
      json(response, 200, await runtime.gitListTags(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/git/create-tag") {
      json(response, 200, await runtime.gitCreateTag(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/git/delete-tag") {
      json(response, 200, await runtime.gitDeleteTag(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/git/push-tag") {
      json(response, 200, await runtime.gitPushTag(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/git/push-all-tags") {
      json(response, 200, await runtime.gitPushAllTags(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/git/delete-remote-tag") {
      json(response, 200, await runtime.gitDeleteRemoteTag(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/git/force-push-with-lease") {
      json(response, 200, await runtime.gitForcePushWithLease(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/git/list-branches") {
      const v = validateIpc(gitBranchListSchema, body, "POST /api/git/list-branches");
      json(response, 200, await runtime.gitListBranches(v));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/git/delete-branch") {
      const v = validateIpc(gitBranchDeleteSchema, body, "POST /api/git/delete-branch");
      json(response, 200, await runtime.gitDeleteBranch(v));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/git/delete-remote-branch") {
      const v = validateIpc(gitRemoteBranchDeleteSchema, body, "POST /api/git/delete-remote-branch");
      json(response, 200, await runtime.gitDeleteRemoteBranch(v));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/git/rename-branch") {
      const v = validateIpc(gitBranchRenameSchema, body, "POST /api/git/rename-branch");
      json(response, 200, await runtime.gitRenameBranch(v));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/git/checkout-remote-branch") {
      const v = validateIpc(gitCheckoutRemoteSchema, body, "POST /api/git/checkout-remote-branch");
      json(response, 200, await runtime.gitCheckoutRemoteBranch(v));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/git/log-graph") {
      const v = validateIpc(gitLogGraphSchema, body, "POST /api/git/log-graph");
      json(response, 200, await runtime.gitLogGraph(v));
      return;
    }

    // Docker endpoints are validated through the same zod schemas as the
    // Electron IPC channel so a remote/mobile client can't bypass the
    // argv-safety guards (no leading '-', length caps, character whitelists)
    // that the desktop path already enforces. The runtime methods themselves
    // trust their inputs — validation lives here at the trust boundary.
    if (request.method === "POST" && url.pathname === "/api/docker/action") {
      const v = validateIpc(dockerActionSchema, body, "POST /api/docker/action");
      json(response, 200, await runtime.dockerAction(v.action, v.containerId, v.backendId, v.contextName));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/docker/logs/open") {
      // Wire the streamer's onData/onClose callbacks to WebSocket broadcasts.
      // Buffers come over WS as utf8 strings — docker log payloads are ANSI
      // text and the renderer's writeData() already accepts strings, so we
      // avoid the base64 round-trip. (Binary log payloads would still survive
      // as latin-1-ish noise; acceptable for an MVP that runs against text
      // logs in practice.)
      const v = validateIpc(dockerLogsOpenSchema, body, "POST /api/docker/logs/open");
      await runtime.dockerLogsOpen(
        v.sessionId,
        v.containerId,
        v.backendId,
        v.contextName,
        (sid: string, data: Buffer) =>
          broadcast({ type: "docker:logs:write", payload: { sessionId: sid, data: data.toString("utf8") } }),
        (sid: string, code: number | null) =>
          broadcast({ type: "docker:logs:close", payload: { sessionId: sid, code } }),
        { timestamps: v.timestamps, tail: v.tail },
      );
      json(response, 200, { ok: true });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/docker/logs/update") {
      const v = validateIpc(dockerLogsUpdateSchema, body, "POST /api/docker/logs/update");
      const ok = runtime.dockerLogsUpdate(v.sessionId, { timestamps: v.timestamps, tail: v.tail });
      json(response, 200, { ok });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/docker/logs/close") {
      const v = validateIpc(dockerLogsCloseSchema, body, "POST /api/docker/logs/close");
      runtime.dockerLogsClose(v.sessionId);
      json(response, 200, { ok: true });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/docker/inspect") {
      const v = validateIpc(dockerInspectSchema, body, "POST /api/docker/inspect");
      json(response, 200, await runtime.dockerInspect(v.containerId, v.backendId, v.contextName));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/docker/top") {
      const v = validateIpc(dockerTopSchema, body, "POST /api/docker/top");
      json(response, 200, await runtime.dockerTop(v.containerId, v.backendId, v.contextName));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/docker/stats") {
      const v = validateIpc(dockerStatsSchema, body, "POST /api/docker/stats");
      json(response, 200, await runtime.dockerStats(v.containerId, v.backendId, v.contextName));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/docker/image/inspect") {
      const v = validateIpc(dockerResourceRefSchema, body, "POST /api/docker/image/inspect");
      json(response, 200, await runtime.dockerImageInspect(v.resource, v.backendId, v.contextName));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/docker/volume/inspect") {
      const v = validateIpc(dockerResourceRefSchema, body, "POST /api/docker/volume/inspect");
      json(response, 200, await runtime.dockerVolumeInspect(v.resource, v.backendId, v.contextName));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/docker/network/inspect") {
      const v = validateIpc(dockerResourceRefSchema, body, "POST /api/docker/network/inspect");
      json(response, 200, await runtime.dockerNetworkInspect(v.resource, v.backendId, v.contextName));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/docker/image/remove") {
      const v = validateIpc(dockerRemoveSchema, body, "POST /api/docker/image/remove");
      json(response, 200, await runtime.dockerImageRemove(v.resource, v.backendId, v.contextName, !!v.force));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/docker/volume/remove") {
      const v = validateIpc(dockerRemoveSchema, body, "POST /api/docker/volume/remove");
      json(response, 200, await runtime.dockerVolumeRemove(v.resource, v.backendId, v.contextName, !!v.force));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/docker/network/remove") {
      const v = validateIpc(dockerRemoveSchema, body, "POST /api/docker/network/remove");
      json(response, 200, await runtime.dockerNetworkRemove(v.resource, v.backendId, v.contextName));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/docker/image/pull") {
      const v = validateIpc(dockerResourceRefSchema, body, "POST /api/docker/image/pull");
      json(response, 200, await runtime.dockerImagePull(v.resource, v.backendId, v.contextName));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/docker/image/prune") {
      const v = validateIpc(dockerPruneSchema, body, "POST /api/docker/image/prune");
      json(response, 200, await runtime.dockerImagePrune(v.backendId, v.contextName, !!v.all));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/docker/volume/prune") {
      const v = validateIpc(dockerPruneSchema, body, "POST /api/docker/volume/prune");
      json(response, 200, await runtime.dockerVolumePrune(v.backendId, v.contextName));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/docker/network/prune") {
      const v = validateIpc(dockerPruneSchema, body, "POST /api/docker/network/prune");
      json(response, 200, await runtime.dockerNetworkPrune(v.backendId, v.contextName));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/docker/builder/prune") {
      const v = validateIpc(dockerPruneSchema, body, "POST /api/docker/builder/prune");
      json(response, 200, await runtime.dockerBuilderPrune(v.backendId, v.contextName, !!v.all));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/docker/system/df") {
      const v = validateIpc(dockerSystemDfSchema, body, "POST /api/docker/system/df");
      json(response, 200, await runtime.dockerSystemDf(v.backendId, v.contextName));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/docker/volume/list") {
      const v = validateIpc(dockerVolumeBrowseSchema, body, "POST /api/docker/volume/list");
      json(response, 200, await runtime.dockerVolumeList(v.volumeName, v.backendId, v.contextName, v.subPath));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/docker/volume/read") {
      const v = validateIpc(dockerVolumeBrowseSchema, body, "POST /api/docker/volume/read");
      json(response, 200, await runtime.dockerVolumeReadFile(v.volumeName, v.backendId, v.contextName, v.subPath));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/docker/compose-action") {
      const v = validateIpc(dockerComposeActionSchema, body, "POST /api/docker/compose-action");
      json(response, 200, await runtime.dockerComposeAction(v.action, v.backendId, v.contextName, v.projectName));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/docker/open-session") {
      json(response, 200, await runtime.openDockerSession(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/docker/open-lazydocker") {
      json(response, 200, await runtime.openLazydockerSession(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/git/open-lazygit") {
      json(response, 200, await runtime.openLazygitSession(body));
      return;
    }

    // /api/git/create-worktree is handled in the outer dispatch (slot-aware).

    if (request.method === "POST" && url.pathname === "/api/profile/save") {
      json(response, 200, await runtime.saveProfile(body.profile));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/profile/delete") {
      json(response, 200, await runtime.deleteProfile(body.profileId));
      return;
    }

    // --- File manager endpoints (read-only by default for remote) ---
    if (request.method === "POST" && url.pathname === "/api/file/list") {
      json(response, 200, await fm.listDirectory(body.rootPath as string, body.relativePath as string));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/file/tree") {
      json(response, 200, await fm.getDirectoryTree(body.rootPath as string, body.relativePath as string));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/file/preview") {
      json(response, 200, await fm.readFilePreview(body.rootPath as string, body.relativePath as string));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/file/read") {
      json(response, 200, await fm.readFileContent(body.rootPath as string, body.relativePath as string));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/file/write") {
      json(
        response,
        200,
        await fm.writeFileContent(body.rootPath as string, body.relativePath as string, body.content as string),
      );
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/file/create-file") {
      json(response, 200, await fm.createFile(body.rootPath as string, body.parentPath as string, body.name as string));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/file/create-dir") {
      json(
        response,
        200,
        await fm.createDirectory(body.rootPath as string, body.parentPath as string, body.name as string),
      );
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/file/rename") {
      json(
        response,
        200,
        await fm.renameEntry(body.rootPath as string, body.relativePath as string, body.newName as string),
      );
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/file/delete") {
      json(response, 200, await fm.deleteEntry(body.rootPath as string, body.relativePath as string));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/file/git-ignore") {
      json(
        response,
        200,
        await fm.addToGitignore(body.rootPath as string, body.relativePath as string, body.isDirectory === true),
      );
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/file/move") {
      json(response, 200, await fm.moveEntry(body.rootPath as string, body.fromPath as string, body.toPath as string));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/file/copy") {
      json(response, 200, await fm.copyEntry(body.rootPath as string, body.fromPath as string, body.toPath as string));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/file/open-in-explorer") {
      // Open-in-explorer is an Electron-only feature; noop for remote.
      json(response, 200, { ok: true });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/file/clipboard-copy") {
      // OS-clipboard "copy file" is an Electron-only feature; noop for remote.
      // The renderer-side in-app clipboard still works for paste-within-app.
      json(response, 200, { ok: true });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/file/open-in-editor") {
      // Open-in-editor is an Electron-only feature; noop for remote.
      json(response, 200, { ok: true });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/file/info") {
      json(response, 200, await fm.getFileInfo(body.rootPath as string, body.relativePath as string));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/file/git-status") {
      json(
        response,
        200,
        await fm.getGitFileStatus(body.rootPath as string, { includeIgnored: !!body.includeIgnored }),
      );
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/file/git-refs") {
      json(response, 200, await fm.getGitRefs(body.rootPath as string, (body.relativePath as string) || ""));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/file/git-diff") {
      json(
        response,
        200,
        await fm.computeFileDiff(body.rootPath as string, body.relativePath as string, {
          source: (body.source as string) || "head",
          revisionRef: (body.revisionRef as string) || "",
        }),
      );
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/file/commit-files") {
      json(response, 200, await fm.getCommitFiles(body.rootPath as string, body.hash as string));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/file/commit-diff") {
      json(
        response,
        200,
        await fm.computeCommitFileDiff(body.rootPath as string, body.relativePath as string, body.hash as string),
      );
      return;
    }

    // --- SSH (remote is read-only per plan §14) ---
    if (request.method === "POST" && url.pathname === "/api/ssh/hosts/list") {
      json(response, 200, await runtime["ssh:hosts:list"]());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/ssh/keys/list") {
      // Returns metadata only; private-key material never leaves the host.
      json(response, 200, await runtime["ssh:keys:list"]());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/ssh/certs/list") {
      json(response, 200, await runtime["ssh:certs:list"]());
      return;
    }
    // Remote sessions are allowed to respond to active prompts only — they
    // can't create/edit credentials. This mirrors how the user is already
    // attached to a session created locally.
    if (request.method === "POST" && url.pathname === "/api/ssh/auth/answer") {
      json(response, 200, await runtime["ssh:auth:answer"](body));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/ssh/auth/cancel") {
      json(response, 200, await runtime["ssh:auth:cancel"](body));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/ssh/host-key/accept") {
      json(response, 200, await runtime["ssh:host-key:accept"](body));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/ssh/host-key/reject") {
      json(response, 200, await runtime["ssh:host-key:reject"](body));
      return;
    }
    // Explicitly forbid credential/host administration from remote clients
    // so a leaked token can't exfiltrate or plant SSH hosts/keys. See plan
    // §14 — this must never be opened up without a per-host-on-remote
    // authorization story.
    if (
      request.method === "POST" &&
      (url.pathname === "/api/ssh/hosts/create" ||
        url.pathname === "/api/ssh/hosts/update" ||
        url.pathname === "/api/ssh/hosts/delete" ||
        url.pathname === "/api/ssh/hosts/duplicate" ||
        url.pathname === "/api/ssh/hosts/test" ||
        url.pathname === "/api/ssh/keys/import" ||
        url.pathname === "/api/ssh/keys/generate" ||
        url.pathname === "/api/ssh/keys/delete" ||
        url.pathname === "/api/ssh/certs/import" ||
        url.pathname === "/api/ssh/certs/delete" ||
        url.pathname === "/api/ssh/config/preview" ||
        url.pathname === "/api/ssh/config/import" ||
        url.pathname === "/api/ssh/known-hosts/import")
    ) {
      json(response, 403, { error: "SSH administration is not permitted on remote clients." });
      return;
    }

    json(response, 404, { error: "Not found" });
  } catch (error) {
    const msg = (error as Error).message || "Remote API failed";
    const statusCode = msg.startsWith("IPC validation failed") ? 400 : 500;
    json(response, statusCode, { error: msg });
  }
}

export async function startRemoteServer({
  runtime,
  staticRoot,
  logger: _logger = console,
}: {
  runtime: Runtime;
  staticRoot: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  logger?: any;
}): Promise<{ close: () => Promise<void> }> {
  const { enabled, host, port, token } = runtime.getPayload().appState.settings.remoteAccess;
  if (!enabled) {
    runtime.setRemoteInfo({ enabled: false, urls: [], port, host });
    return { close: async () => {} };
  }

  const audit = createAuditLogger("remote-api-audit");

  // Active session IDs minted after a valid token bootstrap. Lives only
  // in process memory; restarts (settings change, token regenerate, app
  // quit) wipe it, by design — that's how clients lose access when the
  // user revokes the token. See SESSION_COOKIE_NAME for the threat model.
  const activeSessions = new Set<string>();

  // Per-session remote client contexts — profile / workspace / session the
  // browser is currently looking at.  Never persisted; wiped on restart.
  const registry = new RemoteClientRegistry();
  registry.startCleanupSweep();
  // Expose the registry so runtime can call fallback helpers when profiles /
  // workspaces are deleted (runtime.setRemoteClientRegistry).
  runtime.setRemoteClientRegistry?.(registry);

  function isAuthorized(requestUrl: string, headers: IncomingMessage["headers"]): boolean {
    // Master token (URL `?token=` or `Authorization: Bearer …`) — used
    // by the renderer's fetch path and by external callers like the
    // mobile inbox / agent tooling.
    if (tokensEqual(getTokenFromRequest(requestUrl, headers), token)) return true;
    // Session cookie — minted on first HTML hit, used for every
    // subsequent navigation and WebSocket upgrade from the same
    // browser. Avoids re-emitting the long-lived token on every
    // request.
    const sessionId = getSessionFromRequest(headers);
    if (sessionId && activeSessions.has(sessionId)) return true;
    return false;
  }

  function mintSession(requestedProfileId = ""): string {
    const id = randomBytes(32).toString("base64url");
    activeSessions.add(id);
    // Bootstrap default profile / workspace context for this new session.
    registry.getOrCreate(id, (runtime.getPayload() as Record<string, unknown>).appState, requestedProfileId);
    return id;
  }

  function sessionIdForRequest(requestUrl: string, headers: IncomingMessage["headers"]): string {
    const url = new URL(requestUrl, "http://localhost");
    const cookieSessionId = getSessionFromRequest(headers);
    if (cookieSessionId && activeSessions.has(cookieSessionId)) return cookieSessionId;
    if (!tokensEqual(getTokenFromRequest(requestUrl, headers), token)) return "";
    const clientId = getClientIdFromRequest(requestUrl, headers);
    if (!clientId) return "";
    const tokenSessionId = `token-client:${clientId}`;
    activeSessions.add(tokenSessionId);
    registry.getOrCreate(
      tokenSessionId,
      (runtime.getPayload() as Record<string, unknown>).appState,
      url.searchParams.get("profileId") || "",
    );
    return tokenSessionId;
  }

  const server = http.createServer(async (request, response) => {
    const requestUrl = request.url || "/";
    const url = new URL(requestUrl, "http://localhost");
    const isApiRoute = url.pathname.startsWith("/api/");

    if (isApiRoute && !isAuthorized(requestUrl, request.headers)) {
      writeHead(response, 401, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Unauthorized");
      audit.warn("api request rejected", {
        method: request.method,
        path: url.pathname,
        statusCode: 401,
        remoteAddress: request.socket?.remoteAddress,
      });
      return;
    }

    if (isApiRoute) {
      const startedAt = Date.now();
      const remoteAddress = request.socket?.remoteAddress;
      response.on("finish", () => {
        audit.info("api request", {
          method: request.method,
          path: url.pathname,
          statusCode: response.statusCode,
          durationMs: Date.now() - startedAt,
          remoteAddress,
        });
      });

      // Bump TTL and get session for per-client endpoints.
      const apiSessionId = sessionIdForRequest(requestUrl, request.headers);
      if (apiSessionId && activeSessions.has(apiSessionId)) registry.bumpLastSeen(apiSessionId);

      // /api/state — return per-client composed payload when a session is known.
      if (request.method === "GET" && url.pathname === "/api/state") {
        const basePayload = stripSecretsForRemote(await runtime.getInitialState());
        json(response, 200, apiSessionId ? registry.composePayload(apiSessionId, basePayload) : basePayload);
        return;
      }

      // Remote-client-scoped activation endpoints — derive clientId from cookie or token client id.
      if (url.pathname.startsWith("/api/remote-client/")) {
        if (!apiSessionId || !activeSessions.has(apiSessionId)) {
          json(response, 401, { error: "No active session" });
          return;
        }
        const body = await readRequestBody(request);
        try {
          // The remote client is an independent viewer: activation mutates
          // ONLY its own RemoteClientContext (profile/workspace/session) and
          // never touches a desktop windowSlot. The runtime methods spawn
          // PTYs for the newly viewed workspace and broadcast state — every
          // socket gets a per-client composed payload with its own view.
          if (request.method === "POST" && url.pathname === "/api/remote-client/profile/activate") {
            await runtime.activateProfileForRemoteClient(apiSessionId, String(body.profileId ?? ""));
          } else if (request.method === "POST" && url.pathname === "/api/remote-client/workspace/activate") {
            await runtime.activateWorkspaceForRemoteClient(apiSessionId, String(body.workspaceId ?? ""));
          } else if (request.method === "POST" && url.pathname === "/api/remote-client/session/activate") {
            await runtime.activateSessionForRemoteClient(
              apiSessionId,
              String(body.workspaceId ?? ""),
              String(body.sessionId ?? ""),
            );
          } else {
            json(response, 404, { error: "Not found" });
            return;
          }
          json(response, 200, registry.composePayload(apiSessionId, stripSecretsForRemote(runtime.getPayload())));
        } catch (err) {
          json(response, 400, { error: (err as Error).message || "Activation failed" });
        }
        return;
      }

      // Slot-aware create/activate endpoints — mirror the new workspace into
      // the bound desktop slot so the frontend selector (slot-first) follows.
      // handleApiRequest doesn't have apiSessionId in scope, so we intercept
      // here. See runtime-azure-handlers.openAzurePullRequest for the flicker
      // this prevents.
      const slotAwareRoute: Record<
        string,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (body: any, windowId: string) => Promise<unknown>
      > = {
        "/api/azure/pull-request/open": (body, windowId) => runtime.openAzurePullRequest(body, windowId),
        "/api/github/pull-request/open": (body, windowId) => runtime.openGitHubPullRequest(body, windowId),
        "/api/azure/quickfix/create": (body, windowId) => runtime.azureQuickFixCreate(body, windowId),
        "/api/github/quickfix/create": (body, windowId) => runtime.githubQuickFixCreate(body, windowId),
        "/api/task/create": (body, windowId) => runtime.createTaskWorkspace(body, windowId),
        "/api/git/create-worktree": (body, windowId) => runtime.createWorktree(body, windowId),
        // saveWorkspace can change profileId or overwrite an existing
        // workspace; without slot-aware routing a remote on profile B
        // could create entries in profile A or hijack profile-A workspaces.
        "/api/workspace/save": (body, windowId) => runtime.saveWorkspace(body.workspace || body.project, windowId),
        "/api/project/save": (body, windowId) => runtime.saveWorkspace(body.workspace || body.project, windowId),
        "/api/workspace/set-ui-state": (body, windowId) =>
          runtime.setWorkspaceUIState(body.workspaceId, body.uiState, windowId),
        // Task lifecycle ops drive the runner against the workspace's cwd
        // (edits TASK.md, signals PTY, etc). Cross-profile must refuse.
        "/api/task/start": (body, windowId) => runtime.startTask(body.workspaceId, windowId),
        "/api/task/stop": (body, windowId) => Promise.resolve(runtime.stopTask(body.workspaceId, windowId)),
        "/api/task/pause": (body, windowId) => Promise.resolve(runtime.pauseTask(body.workspaceId, windowId)),
        "/api/task/resume": (body, windowId) => Promise.resolve(runtime.resumeTask(body.workspaceId, windowId)),
        "/api/task/reset": (body, windowId) => runtime.resetTask(body.workspaceId, windowId),
        "/api/task/update-description": (body, windowId) =>
          runtime.updateTaskDescription(body.workspaceId, body.description, windowId),
        // Activation also moves slot.activeWorkspaceId for the bound slot
        // (legacy activateWorkspace mirrors to windowSlots[0]) — must be
        // refused when the target lives in another profile.
        "/api/workspace/activate": (body, windowId) =>
          runtime.activateWorkspace((body.workspaceId || body.projectId) as string, windowId),
        "/api/project/activate": (body, windowId) =>
          runtime.activateWorkspace((body.workspaceId || body.projectId) as string, windowId),
        // Delete is irreversible — cross-profile delete is data loss in
        // another profile.
        "/api/workspace/delete": (body, windowId) => {
          const wsId = validateIpc(
            workspaceIdSchema,
            body.workspaceId || body.projectId,
            "remote-slot:workspace/delete.workspaceId",
          );
          const opts = validateIpc(
            workspaceDeleteOptionsSchema,
            { deleteFromDisk: body.deleteFromDisk, diskPath: body.diskPath },
            "remote-slot:workspace/delete.options",
          );
          return runtime.deleteWorkspace(wsId, opts, windowId);
        },
        "/api/project/delete": (body, windowId) => {
          const wsId = validateIpc(
            workspaceIdSchema,
            body.workspaceId || body.projectId,
            "remote-slot:project/delete.workspaceId",
          );
          const opts = validateIpc(
            workspaceDeleteOptionsSchema,
            { deleteFromDisk: body.deleteFromDisk, diskPath: body.diskPath },
            "remote-slot:project/delete.options",
          );
          return runtime.deleteWorkspace(wsId, opts, windowId);
        },
        // Connection save/delete pins connection.profileId to the bound
        // window's profile; without slot-aware routing a remote on profile
        // B that omits profileId silently lands the connection in
        // windowSlots[0]'s profile (typically "default").
        "/api/azure/save-connection": (body, windowId) =>
          runtime.saveAzureConnection(body.connection || body, windowId),
        "/api/azure/delete-connection": (body, windowId) =>
          runtime.deleteAzureConnection(body.connectionId || body.id || "", windowId),
        "/api/github/save-connection": (body, windowId) =>
          runtime.saveGitHubConnection(body.connection || body, windowId),
        "/api/github/delete-connection": (body, windowId) =>
          runtime.deleteGitHubConnection(body.connectionId || body.id || "", windowId),
        // Activation in window slot — same cross-profile rules as workspace.
        "/api/session/activate-in-window": (body, windowId) =>
          runtime.activateSessionInWindow(body.sessionId, windowId),
        // Take over the per-session input lease ("Take control?" confirm).
        "/api/session/take-control": (body, windowId) =>
          Promise.resolve(runtime.takeSessionControl(String(body.sessionId || ""), windowId)),
        // Reorder must be slot-aware: the runtime's profile-safe branch only
        // activates when windowId is supplied. Without it, the legacy global
        // branch replaces the entire workspaces array with the caller's IDs
        // and silently drops every workspace in other profiles.
        "/api/workspace/reorder": (body, windowId) =>
          runtime.reorderWorkspaces((body.workspaceIds || body.projectIds || []) as string[], windowId),
        "/api/project/reorder": (body, windowId) =>
          runtime.reorderWorkspaces((body.workspaceIds || body.projectIds || []) as string[], windowId),
        // Review-bridge handlers can publish comments to the PR provider
        // (pushAndPublishReview) and push to the git remote — both
        // externally visible side effects that must refuse cross-profile.
        "/api/review-bridge/draft-comment/create": (body, windowId) =>
          runtime.createReviewBridgeDraftComment(body, windowId),
        "/api/review-bridge/draft/save": (body, windowId) => runtime.saveReviewBridgeDraft(body, windowId),
        "/api/review-bridge/draft/queue": (body, windowId) => runtime.queueReviewBridgeDraft(body, windowId),
        "/api/review-bridge/draft/delete": (body, windowId) => runtime.deleteReviewBridgeDraft(body, windowId),
        "/api/review-bridge/comment/delete": (body, windowId) => runtime.deleteReviewBridgeComment(body, windowId),
        "/api/review-bridge/comment/reply-with-changes": (body, windowId) =>
          runtime.replyWithCodeChanges(body, windowId),
        "/api/review-bridge/pull-request/push-and-publish": (body, windowId) =>
          runtime.pushAndPublishReview(body, windowId),
        // Git ops all mutate state in a workspace's cwd (and gitFetch/Push/Pull
        // touch external remotes). Routing them through slotAwareRoute pins
        // each request to the caller's bound profile so a remote/mobile
        // client can't drive git on a workspace they don't see.
        "/api/git/fetch": (body, windowId) => runtime.gitFetch(body, windowId),
        "/api/git/pull": (body, windowId) => runtime.gitPull(body, windowId),
        "/api/git/push": (body, windowId) => runtime.gitPush(body, windowId),
        "/api/git/checkout-branch": (body, windowId) => runtime.gitCheckoutBranch(body, windowId),
        "/api/git/create-branch": (body, windowId) => runtime.gitCreateBranch(body, windowId),
        "/api/git/merge-into-current": (body, windowId) => runtime.gitMergeIntoCurrent(body, windowId),
        "/api/git/rebase-onto": (body, windowId) => runtime.gitRebaseOnto(body, windowId),
        "/api/git/continue": (body, windowId) => runtime.gitContinueOperation(body, windowId),
        "/api/git/abort": (body, windowId) => runtime.gitAbortOperation(body, windowId),
        "/api/git/diff-preview": (body, windowId) => runtime.gitDiffPreview(body, windowId),
        "/api/git/compare-branch": (body, windowId) => runtime.gitCompareBranch(body, windowId),
        "/api/git/merge-into-base": (body, windowId) => runtime.gitMergeCurrentIntoBase(body, windowId),
        "/api/git/remove-worktree": (body, windowId) => runtime.gitRemoveWorktree(body, windowId),
        "/api/git/commit-all": (body, windowId) => runtime.gitCommitAll(body, windowId),
        // Validate the same way the Electron IPC handlers do (ipc.ts) and the
        // branch routes below: this slot-aware map is the LIVE remote path for
        // stash ops (it intercepts before handleApiRequest), so without these
        // the `stash@{N}` ref regex and the 64 MiB import cap would never run
        // on the remote/mobile transport.
        "/api/git/stash": (body, windowId) =>
          runtime.gitStash(validateIpc(gitPayloadSchema, body, "POST /api/git/stash"), windowId),
        "/api/git/stash-pop": (body, windowId) =>
          runtime.gitStashPop(validateIpc(gitPayloadSchema, body, "POST /api/git/stash-pop"), windowId),
        // Stash detail/lifecycle ops are slot-aware too: write actions mutate
        // the workspace's working tree, and even the read actions expose file
        // content, so both must refuse cross-profile workspace IDs.
        "/api/git/stash-list": (body, windowId) =>
          runtime.gitListStashes(validateIpc(gitStashListSchema, body, "POST /api/git/stash-list"), windowId),
        "/api/git/stash-files": (body, windowId) =>
          runtime.gitStashFiles(validateIpc(gitStashFilesSchema, body, "POST /api/git/stash-files"), windowId),
        "/api/git/stash-file-diff": (body, windowId) =>
          runtime.gitStashFileDiff(
            validateIpc(gitStashFileDiffSchema, body, "POST /api/git/stash-file-diff"),
            windowId,
          ),
        "/api/git/stash-apply": (body, windowId) =>
          runtime.gitStashApply(validateIpc(gitStashApplySchema, body, "POST /api/git/stash-apply"), windowId),
        "/api/git/stash-drop": (body, windowId) =>
          runtime.gitStashDrop(validateIpc(gitStashDropSchema, body, "POST /api/git/stash-drop"), windowId),
        "/api/git/stash-branch": (body, windowId) =>
          runtime.gitStashBranch(validateIpc(gitStashBranchSchema, body, "POST /api/git/stash-branch"), windowId),
        "/api/git/stash-export": (body, windowId) =>
          runtime.gitStashExport(validateIpc(gitStashExportSchema, body, "POST /api/git/stash-export"), windowId),
        "/api/git/stash-import": (body, windowId) =>
          runtime.gitStashImport(validateIpc(gitStashImportSchema, body, "POST /api/git/stash-import"), windowId),
        "/api/git/commit-diff": (body, windowId) => runtime.gitCommitDiff(body, windowId),
        "/api/git/commit-info": (body, windowId) => runtime.gitCommitInfo(body, windowId),
        "/api/git/log-page": (body, windowId) => runtime.gitLogPage(body, windowId),
        "/api/git/list-tags": (body, windowId) => runtime.gitListTags(body, windowId),
        "/api/git/create-tag": (body, windowId) => runtime.gitCreateTag(body, windowId),
        "/api/git/delete-tag": (body, windowId) => runtime.gitDeleteTag(body, windowId),
        "/api/git/push-tag": (body, windowId) => runtime.gitPushTag(body, windowId),
        "/api/git/push-all-tags": (body, windowId) => runtime.gitPushAllTags(body, windowId),
        "/api/git/delete-remote-tag": (body, windowId) => runtime.gitDeleteRemoteTag(body, windowId),
        "/api/git/force-push-with-lease": (body, windowId) => runtime.gitForcePushWithLease(body, windowId),
        "/api/git/list-branches": (body, windowId) =>
          runtime.gitListBranches(validateIpc(gitBranchListSchema, body, "POST /api/git/list-branches"), windowId),
        "/api/git/delete-branch": (body, windowId) =>
          runtime.gitDeleteBranch(validateIpc(gitBranchDeleteSchema, body, "POST /api/git/delete-branch"), windowId),
        "/api/git/delete-remote-branch": (body, windowId) =>
          runtime.gitDeleteRemoteBranch(
            validateIpc(gitRemoteBranchDeleteSchema, body, "POST /api/git/delete-remote-branch"),
            windowId,
          ),
        "/api/git/rename-branch": (body, windowId) =>
          runtime.gitRenameBranch(validateIpc(gitBranchRenameSchema, body, "POST /api/git/rename-branch"), windowId),
        "/api/git/checkout-remote-branch": (body, windowId) =>
          runtime.gitCheckoutRemoteBranch(
            validateIpc(gitCheckoutRemoteSchema, body, "POST /api/git/checkout-remote-branch"),
            windowId,
          ),
        "/api/git/log-graph": (body, windowId) =>
          runtime.gitLogGraph(validateIpc(gitLogGraphSchema, body, "POST /api/git/log-graph"), windowId),
        // Grid mutations resolve their target profile from windowId. Without
        // the slot-aware path a mobile client bound to profile B would mutate
        // profile A's grid (runtime falls back to windowSlots[0] when no
        // windowId is supplied — see resolveWorkspaceGridProfile).
        "/api/workspace-grid/enable": (body, windowId) => {
          const parsed = validateIpc(workspaceGridEnableSchema, body, "POST /api/workspace-grid/enable");
          return runtime.enableWorkspaceGrid(parsed.layout, parsed.workspaceIds, windowId);
        },
        "/api/workspace-grid/disable": (_body, windowId) => runtime.disableWorkspaceGrid(windowId),
        "/api/workspace-grid/set-layout": (body, windowId) => {
          const parsed = validateIpc(workspaceGridSetLayoutSchema, body, "POST /api/workspace-grid/set-layout");
          return runtime.setGridLayout(parsed.layout, windowId);
        },
        "/api/workspace-grid/set-cell": (body, windowId) => {
          const parsed = validateIpc(workspaceGridSetCellSchema, body, "POST /api/workspace-grid/set-cell");
          return runtime.setGridCell(parsed.cellIndex, parsed.workspaceId, windowId);
        },
        "/api/workspace-grid/swap-cells": (body, windowId) => {
          const parsed = validateIpc(workspaceGridSwapCellsSchema, body, "POST /api/workspace-grid/swap-cells");
          return runtime.swapGridCells(parsed.a, parsed.b, windowId);
        },
        // "Clear all" must stay scoped to the caller's profile — otherwise
        // a Clear from profile B's window would wipe attention alerts on
        // workspaces in profile A (and silence the bell on every other
        // open window). Slot-aware routing supplies the bound windowId,
        // and runtime.clearAllAttention resolves the profile from it.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "/api/attention/clear-all": (_body, windowId) => (runtime as any).clearAllAttention(windowId),
        // Same reasoning as clear-all: clear-session deletes a workspace's
        // alert entry by sessionId — without scoping, a remote client on
        // profile B could clear alerts on a workspace in profile A by
        // submitting any sessionId. The runtime cross-checks the resolved
        // profile against the workspace's profileId and refuses mismatches.
        "/api/attention/clear-session": (body, windowId) =>
          runtime.clearAlertForSession(String(body?.sessionId || ""), {
            dismissed: body?.dismissed === true,
            windowId,
          }),
        // Sync surfaces "user is currently looking at these tabs" and after
        // ATTENTION_MIN_DISPLAY_MS turns visible sessions into cleared
        // alerts. Without scoping, profile B could mark profile A's
        // sessions visible and silently clear their bells.
        "/api/attention/sync": (body, windowId) =>
          runtime.syncAttentionContext({
            visibleSessionIds: Array.isArray(body?.visibleSessionIds) ? body.visibleSessionIds : [],
            windowFocused: body?.windowFocused !== false,
            windowId,
          }),
      };
      const slotAwareHandler = request.method === "POST" ? slotAwareRoute[url.pathname] : undefined;
      if (slotAwareHandler) {
        const body = await readRequestBody(request);
        // Viewer-aware routes mutate state in the context of the caller's
        // profile. The remote client IS the viewer: pass its viewer id
        // (`remote:<sessionId>`) — the runtime resolves the profile through
        // the registry, so these operations work even when the client's
        // profile is not open in any desktop window, and per-viewer
        // mutations (grid, activation mirror) land on the remote context
        // instead of a desktop slot. A token-only caller that skipped the
        // session/client-id binding must NOT get to mutate.
        const viewerId = apiSessionId && registry.get(apiSessionId) ? remoteViewerId(apiSessionId) : "";
        if (!viewerId) {
          json(response, 400, {
            error:
              "Slot-aware operation requires a bound session — include the strideterm cookie or X-Strideterm-Client-Id header so the server can resolve which profile to act on.",
          });
          return;
        }
        try {
          json(response, 200, await slotAwareHandler(body, viewerId));
        } catch (err) {
          const msg = (err as Error).message || "Slot operation failed";
          const statusCode = msg.startsWith("IPC validation failed") ? 400 : 500;
          json(response, statusCode, { error: msg });
        }
        return;
      }

      await handleApiRequest(runtime, request, response, broadcast);
      return;
    }

    // First-hit bootstrap: a freshly-shared QR/URL arrives as
    // `GET /?token=<master>`. Validate the token, mint a fresh session,
    // and 302 the browser to a clean URL. Net effect: the master token
    // appears in network logs / browser history exactly once (the
    // initial HTTP request) and never again — the cookie carries every
    // subsequent request, including the WebSocket upgrade.
    if (request.method === "GET" && url.pathname === "/" && url.searchParams.has("token")) {
      if (!tokensEqual(url.searchParams.get("token") || "", token)) {
        writeHead(response, 401, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Unauthorized");
        return;
      }
      const sessionId = mintSession(url.searchParams.get("profileId") || "");
      writeHead(response, 302, {
        "Set-Cookie": `${SESSION_COOKIE_NAME}=${sessionId}; ${buildSessionCookieAttrs(request.headers)}`,
        Location: "/",
      });
      response.end();
      return;
    }

    // Static asset fetches don't gate on auth (they're harmless JS/CSS
    // bundles served to any LAN peer who guesses the URL), but the
    // renderer's API + WS calls do. Keeping static open avoids a
    // brittle dependency on every asset path also having auth headers.
    await serveStatic(staticRoot, requestUrl, response);
  });

  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Set<import("ws").WebSocket>();
  // Maps each WS socket to its cookie session ID so per-client payloads can
  // be composed on every state:updated event.
  const socketSession = new WeakMap<import("ws").WebSocket, string>();

  function broadcast(message: unknown): void {
    const payload = JSON.stringify(message);
    for (const socket of sockets) {
      if (socket.readyState === socket.OPEN) {
        socket.send(payload);
      }
    }
  }

  /** Send a per-client composed state:updated to all sockets of `sessionId`. */
  function broadcastToSession(sessionId: string, basePayload: unknown): void {
    const composed = registry.composePayload(sessionId, basePayload);
    const msg = JSON.stringify({ type: "state:updated", payload: composed });
    for (const socket of sockets) {
      if (socket.readyState !== socket.OPEN) continue;
      if (socketSession.get(socket) !== sessionId) continue;
      socket.send(msg);
    }
  }

  const unsubscribe = [
    // state:updated — compose per-client so each browser sees its own profile context.
    runtime.on("state:updated", (payload: unknown) => {
      const stripped = stripSecretsForRemote(payload);
      for (const socket of sockets) {
        if (socket.readyState !== socket.OPEN) continue;
        const sessionId = socketSession.get(socket);
        const msg = sessionId
          ? JSON.stringify({ type: "state:updated", payload: registry.composePayload(sessionId, stripped) })
          : JSON.stringify({ type: "state:updated", payload: stripped });
        socket.send(msg);
      }
    }),
    runtime.on("terminal:data", (payload: unknown) => broadcast({ type: "terminal:data", payload })),
    runtime.on("terminal:exit", (payload: unknown) => broadcast({ type: "terminal:exit", payload })),
    runtime.on("ssh:auth-prompt", (payload: unknown) => broadcast({ type: "ssh:auth-prompt", payload })),
    runtime.on("ssh:host-key-change", (payload: unknown) => broadcast({ type: "ssh:host-key-change", payload })),
    runtime.on("ssh:state", (payload: unknown) => broadcast({ type: "ssh:state", payload })),
    runtime.on("ssh:connection-state", (payload: unknown) => broadcast({ type: "ssh:connection-state", payload })),
  ];

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url || "/", "http://localhost");
    // WS upgrade accepts either the master token (Bearer header or
    // ?token= URL — useful for non-browser clients that don't carry
    // cookies) or the session cookie set during bootstrap. Browsers
    // attach cookies to WS upgrade requests automatically, so the
    // renderer's `new WebSocket(url)` call no longer needs the token
    // in the URL once the user has bootstrapped.
    if (url.pathname !== "/ws" || !isAuthorized(request.url || "/", request.headers)) {
      log.warn("WebSocket upgrade rejected: unauthorized", {
        path: url.pathname,
        remoteAddress: request.socket?.remoteAddress,
      });
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    // CSRF guard for the WebSocket: a malicious page in the user's browser
    // could open ws://host:port/ws?token=<leaked> and (since browsers send
    // cookies/auth headers cross-origin for WS) ride the user's session.
    // Refuse upgrades whose Origin doesn't match the Host the user is
    // connecting to. Same-origin and tooling without an Origin header (curl,
    // websocat, the Electron renderer) still pass.
    const origin = (request.headers.origin || "").toString();
    if (origin) {
      try {
        const originUrl = new URL(origin);
        const host = (request.headers.host || "").toString().toLowerCase();
        const expected =
          `${originUrl.hostname}:${originUrl.port || (originUrl.protocol === "https:" ? "443" : "80")}`.toLowerCase();
        if (host && host !== expected && host !== originUrl.hostname.toLowerCase()) {
          log.warn("WebSocket upgrade rejected: origin/host mismatch", { origin, host });
          socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
          socket.destroy();
          return;
        }
      } catch {
        log.warn("WebSocket upgrade rejected: malformed Origin", { origin });
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
    }

    wss.handleUpgrade(request, socket, head, async (ws) => {
      sockets.add(ws);
      // Tolerant heartbeat: count consecutive missed pongs instead of the
      // binary alive/dead flag. A pong on any tick resets the counter.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- missedPongs is the heartbeat counter attached to the ws instance
      (ws as any).missedPongs = 0;
      ws.on("pong", () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (ws as any).missedPongs = 0;
      });
      // Tag the socket with its session so per-client state can be composed on broadcast.
      const wsSessionId = sessionIdForRequest(request.url || "/", request.headers);
      if (wsSessionId && activeSessions.has(wsSessionId)) {
        socketSession.set(ws, wsSessionId);
        registry.bumpLastSeen(wsSessionId);
      }
      log.info("WebSocket client connected", {
        remoteAddress: request.socket?.remoteAddress,
        sessionRef: remoteSessionRef(wsSessionId),
        total: sockets.size,
      });
      const baseInitial = stripSecretsForRemote(await runtime.getInitialState());
      const initialPayload = wsSessionId ? registry.composePayload(wsSessionId, baseInitial) : baseInitial;
      ws.send(
        JSON.stringify({
          type: "state:updated",
          payload: initialPayload,
        }),
      );

      ws.on("message", (raw: Buffer) => {
        // Every incoming message counts as activity — bump TTL.
        if (wsSessionId) registry.bumpLastSeen(wsSessionId);
        try {
          const message = JSON.parse(raw.toString()) as { type: string };
          if (message.type === "terminal:input") {
            const parsed = wsTerminalInputSchema.safeParse(message);
            if (parsed.success) {
              log.debug("WebSocket terminal input", {
                sessionRef: remoteSessionRef(wsSessionId),
                terminalSessionId: parsed.data.sessionId,
                bytes: Buffer.byteLength(parsed.data.data || "", "utf8"),
              });
              // The remote client is a viewer — its typing participates in
              // the per-session input lease like a desktop window's.
              const viewerId = wsSessionId ? remoteViewerId(wsSessionId) : undefined;
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const result = runtime.writeToSession(parsed.data.sessionId, parsed.data.data, viewerId) as any;
              if (result?.blocked) {
                ws.send(
                  JSON.stringify({
                    type: "terminal:input-blocked",
                    sessionId: parsed.data.sessionId,
                    ownerLabel: String(result.ownerLabel || "another window"),
                  }),
                );
              }
            } else {
              log.warn("WebSocket terminal input rejected: invalid payload", {
                sessionRef: remoteSessionRef(wsSessionId),
              });
            }
          } else if (message.type === "terminal:resize") {
            const parsed = wsTerminalResizeSchema.safeParse(message);
            if (parsed.success) {
              log.debug("WebSocket terminal resize", {
                sessionRef: remoteSessionRef(wsSessionId),
                terminalSessionId: parsed.data.sessionId,
                cols: parsed.data.cols,
                rows: parsed.data.rows,
              });
              runtime.resizeSession(parsed.data.sessionId, { cols: parsed.data.cols, rows: parsed.data.rows });
            } else {
              log.warn("WebSocket terminal resize rejected: invalid payload", {
                sessionRef: remoteSessionRef(wsSessionId),
              });
            }
          }
        } catch (err) {
          log.warn("WebSocket message ignored: malformed JSON", {
            sessionRef: remoteSessionRef(wsSessionId),
            err: (err as Error)?.message || String(err),
          });
        }
      });

      ws.on("error", (err) => {
        log.warn("WebSocket client error", {
          sessionRef: remoteSessionRef(wsSessionId),
          err: (err as Error)?.message || String(err),
        });
      });

      ws.on("close", (code, reason) => {
        sockets.delete(ws);
        const meta = {
          sessionRef: remoteSessionRef(wsSessionId),
          code,
          reason: reason?.toString("utf8") || "",
          remaining: sockets.size,
        };
        if (code === 1000 || code === 1001) {
          log.info("WebSocket client disconnected", meta);
        } else {
          log.warn("WebSocket client disconnected unexpectedly", meta);
        }
      });
    });
  });

  // Drop dead WebSocket clients: each tick we ping every connection and bump
  // its missed-pong counter. Pong handlers reset it. Only after
  // WS_HEARTBEAT_MAX_MISSED consecutive ticks with no pong do we terminate —
  // that handles NAT boxes silently dropping the connection (the counter
  // climbs) without punishing real clients for a single 20s network blip.
  // Without this, a leaked-token attacker reusing an idle channel would
  // never be evicted by token regeneration alone.
  const heartbeat = setInterval(() => {
    for (const ws of sockets) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const missed = (ws as any).missedPongs ?? 0;
      if (missed >= WS_HEARTBEAT_MAX_MISSED) {
        log.warn("WebSocket heartbeat timeout — terminating client", {
          sessionRef: remoteSessionRef(socketSession.get(ws) || ""),
          missedPongs: missed,
          remaining: Math.max(0, sockets.size - 1),
        });
        sockets.delete(ws);
        ws.terminate();
        continue;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (ws as any).missedPongs = missed + 1;
      try {
        ws.ping();
      } catch {
        // Ping on a half-closed socket throws; the next tick will reap it
        // once missedPongs crosses the threshold.
      }
    }
  }, WS_HEARTBEAT_INTERVAL_MS);
  // Ensure the heartbeat doesn't keep the event loop alive on shutdown.
  heartbeat.unref?.();

  const listenResult = await new Promise<{ ok: boolean; error?: Error }>((resolve) => {
    server.once("error", (error: Error) => {
      const isPortBusy = (error as NodeJS.ErrnoException).code === "EADDRINUSE" || /EADDRINUSE/.test(error.message);
      if (isPortBusy) {
        log.warn("remote access port already in use — disabled until restart", {
          port,
          host,
          hint: "Set STRIDETERM_REMOTE_PORT to pick a different port, or stop the other strideterm instance.",
        });
      } else {
        log.warn("remote access server failed", { err: error.message, port, host });
      }
      resolve({ ok: false, error });
    });
    server.listen(port, host, () => resolve({ ok: true }));
  });

  if (!listenResult.ok) {
    clearInterval(heartbeat);
    audit.close();
    unsubscribe.forEach((dispose) => dispose());
    wss.close();
    server.close();
    runtime.setRemoteInfo({ enabled: false, urls: [], port, host, error: listenResult.error!.message });
    return { close: async () => {} };
  }

  runtime.setRemoteInfo({
    enabled: true,
    host,
    port,
    urls: listRemoteUrls(host, port, token),
  });
  const urls = runtime.listRemoteUrls();
  if (urls.length > 0) {
    log.info("remote access ready", { url: urls[0] });
  }

  return {
    async close() {
      clearInterval(heartbeat);
      registry.stopCleanupSweep();
      audit.close();
      unsubscribe.forEach((dispose) => dispose());
      for (const socket of sockets) {
        socket.close();
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
