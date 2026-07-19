/// <reference types="node" />
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import crypto from "node:crypto";
import { getLogger } from "./logger.js";

const log = getLogger("notify-server");

/**
 * Lightweight HTTP server for receiving agent notification hooks.
 *
 * Listens on 127.0.0.1 with an OS-assigned port. Claude Code (and other
 * agent CLIs) POST to this server when they transition to idle or need
 * user input, giving strIDEterm instant alert detection instead of
 * silence-based heuristics.
 *
 * Each PTY session receives a unique URL via the STRIDETERM_NOTIFY_URL
 * env var that encodes the session ID and a shared secret.
 */

const MAX_BODY_SIZE = 64 * 1024; // 64 KB — hook payloads are small

// Hook names we accept. Unknown names are logged but not dropped at the HTTP
// layer — the dispatcher decides user-facing vs system-only based on the
// classification table, so experimentation / new hook types don't require a
// server restart.
const KNOWN_HOOK_NAMES = new Set([
  "Notification",
  "Stop",
  "SubagentStop",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PreCompact",
]);

export interface NotifyPayload {
  sessionId: string;
  hook: string;
  subtype: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: Record<string, any>;
  /** Back-compat fields */
  notificationType: string;
  message: string;
  title: string;
}

export interface NotifyServerHandle {
  port: number;
  server: http.Server;
  close(): Promise<void>;
}

export interface StartNotifyServerOptions {
  onNotification: (n: NotifyPayload) => void;
  secret: string;
}

export function generateNotifySecret(): string {
  return crypto.randomUUID();
}

export function buildNotifyUrl(port: number, sessionId: string, secret: string): string {
  return `http://127.0.0.1:${port}/notify?sid=${encodeURIComponent(sessionId)}&secret=${encodeURIComponent(secret)}`;
}

export function startNotifyServer({
  onNotification,
  secret,
}: StartNotifyServerOptions): Promise<NotifyServerHandle> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((request: IncomingMessage, response: ServerResponse) => {
      if (request.method === "OPTIONS") {
        response.writeHead(204);
        response.end();
        return;
      }

      if (request.method !== "POST") {
        response.writeHead(405, { "Content-Type": "text/plain" });
        response.end("Method Not Allowed");
        return;
      }

      const url = new URL(request.url || "/", "http://localhost");

      if (url.pathname !== "/notify") {
        response.writeHead(404, { "Content-Type": "text/plain" });
        response.end("Not Found");
        return;
      }

      // Validate secret (timing-safe comparison to prevent side-channel leaks)
      const providedSecret = url.searchParams.get("secret") || "";
      let secretMatch = false;
      try {
        secretMatch = crypto.timingSafeEqual(Buffer.from(providedSecret, "utf8"), Buffer.from(secret, "utf8"));
      } catch {
        // Length mismatch throws — treat as non-match
      }
      if (!secretMatch) {
        log.warn("rejected request: invalid secret", {
          providedSecretPrefix: providedSecret.slice(0, 8) + "...",
          expectedSecretPrefix: secret.slice(0, 8) + "...",
          sid: url.searchParams.get("sid") || "",
        });
        response.writeHead(403, { "Content-Type": "text/plain" });
        response.end("Forbidden");
        return;
      }

      const sessionId = url.searchParams.get("sid") || "";
      log.trace("request authenticated", { sessionId });

      // Read JSON body
      let body = "";
      let size = 0;
      let aborted = false;

      request.on("data", (chunk: Buffer) => {
        if (aborted) return;
        size += chunk.length;
        if (size > MAX_BODY_SIZE) {
          aborted = true;
          response.writeHead(413, { "Content-Type": "text/plain" });
          response.end("Payload Too Large");
          request.destroy();
        } else {
          body += chunk;
        }
      });

      request.on("end", () => {
        if (aborted) return;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let payload: Record<string, any> = {};
        if (body.trim()) {
          try {
            payload = JSON.parse(body) as Record<string, unknown>;
          } catch {
            response.writeHead(400, { "Content-Type": "text/plain" });
            response.end("Bad Request");
            return;
          }
        }

        // The notify.mjs script injects `hook` into the body (from argv[2])
        // so every event type (Notification, Stop, SubagentStop,
        // UserPromptSubmit) reaches us with its name. Fall back to
        // hook_event_name (some Claude versions include it) and finally
        // to "Notification" so legacy scripts still work.
        const hook = String(payload.hook || payload.hook_event_name || "Notification").trim();
        if (!KNOWN_HOOK_NAMES.has(hook)) {
          log.trace("unknown hook name — still forwarding for dispatcher to classify", { hook, sessionId });
        }

        // For Notification hooks the subtype (idle_prompt / permission_prompt /
        // etc.) is meaningful; for other hooks it is usually empty.
        const subtype = String(payload.notification_type || "").trim();

        log.trace("notification received", {
          sessionId,
          hook,
          subtype: subtype || null,
          message: String(payload.message || "").slice(0, 100),
        });
        try {
          onNotification({
            sessionId,
            hook,
            subtype,
            payload,
            // Back-compat fields for callers that haven't migrated to the new shape.
            // Dispatcher (Phase 0 step 4) ignores these and reads hook/subtype instead.
            notificationType: subtype || "idle_prompt",
            message: String(payload.message || ""),
            title: String(payload.title || ""),
          });
        } catch (error) {
          log.warn("onNotification error", { err: (error as Error).message });
        }

        response.writeHead(200, { "Content-Type": "application/json" });
        response.end("{}");
      });

      request.on("error", () => {
        if (!response.headersSent) {
          response.writeHead(500, { "Content-Type": "text/plain" });
          response.end("Internal Server Error");
        }
      });
    });

    server.on("error", (error: Error) => {
      reject(error);
    });

    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as { port: number };
      const port = address.port;
      log.info("listening", { host: "127.0.0.1", port });

      resolve({
        port,
        server,
        async close() {
          return new Promise<void>((resolveClose) => {
            server.close(() => resolveClose());
          });
        },
      });
    });
  });
}
