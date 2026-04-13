import http from "node:http";
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
const VALID_NOTIFICATION_TYPES = new Set(["idle_prompt", "permission_prompt", "auth_success", "elicitation_dialog"]);

export function generateNotifySecret() {
  return crypto.randomUUID();
}

export function buildNotifyUrl(port, sessionId, secret) {
  return `http://127.0.0.1:${port}/notify?sid=${encodeURIComponent(sessionId)}&secret=${encodeURIComponent(secret)}`;
}

export function startNotifyServer({ onNotification, secret, logger: _logger = null }) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
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

      request.on("data", (chunk) => {
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

        let payload = {};
        if (body.trim()) {
          try {
            payload = JSON.parse(body);
          } catch {
            response.writeHead(400, { "Content-Type": "text/plain" });
            response.end("Bad Request");
            return;
          }
        }

        const notificationType = String(payload.notification_type || "").trim();
        if (notificationType && !VALID_NOTIFICATION_TYPES.has(notificationType)) {
          log.trace("unknown notification type ignored", { notificationType, sessionId });
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end("{}");
          return;
        }

        log.trace("notification received", {
          sessionId,
          notificationType: notificationType || "idle_prompt",
          message: String(payload.message || "").slice(0, 100),
        });
        try {
          onNotification({
            sessionId,
            notificationType: notificationType || "idle_prompt",
            message: String(payload.message || ""),
            title: String(payload.title || ""),
          });
        } catch (error) {
          log.warn("onNotification error", { err: error.message });
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

    server.on("error", (error) => {
      reject(error);
    });

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address.port;
      log.info("listening", { host: "127.0.0.1", port });

      resolve({
        port,
        server,
        async close() {
          return new Promise((resolveClose) => {
            server.close(() => resolveClose());
          });
        },
      });
    });
  });
}
