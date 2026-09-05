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

// Most hook payloads are a few hundred bytes. `PermissionRequest` is the
// exception: `tool_input` for a `Write` or an `Edit` carries the file content
// being written, which routinely runs past 64 KB. A 413 there is not a
// harmless rejection — it means no decision is made and the user gets the
// prompt the setting promised to answer, with no summary to explain it.
// `notify.mjs` already trims that payload down to the fields a decision and a
// summary need; this ceiling is the safety valve for a payload that arrives
// untrimmed anyway (an older installed script, another agent's hook).
const MAX_BODY_SIZE = 256 * 1024; // 256 KB

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
  // The only hook whose RESPONSE matters: Claude Code reads our stdout to
  // decide whether the permission dialog is shown. See onDecision below.
  "PermissionRequest",
]);

/** Hook whose response body carries a decision back to the agent. */
const DECIDABLE_HOOK = "PermissionRequest";

/**
 * `PermissionRequest` runs a two-phase handshake, because more than one
 * strIDEterm can receive the same hook (dev beside prod, two panels sharing a
 * `cwd`) and only one of them may answer:
 *
 *  - `offer`  — "I would answer this one." Nothing irreversible happens: no
 *               audit row, no Notification Center entry, no Telegram message.
 *               The reply is an opaque `requestId`.
 *  - `commit` — sent by `notify.mjs` to the single instance that offered, once
 *               it has counted the offers. Only now is the approval recorded
 *               and the decision returned for stdout.
 *
 * A body without `phase` is an ordinary notification (every other hook).
 */
export type PermissionPhase = "offer" | "commit";

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
  /**
   * Offer to answer a `PermissionRequest`. Return the `requestId` this
   * instance would commit under, or null to abstain (the prompt is then shown
   * to the user as if no hook existed).
   *
   * Called only for `PermissionRequest`, and only AFTER `onNotification` — the
   * decision reads session state that the dispatcher keeps up to date. It must
   * be synchronous: the response has to go out inside Claude's hook timeout,
   * and `notify.mjs` has nothing to wait on. It must have NO side effects the
   * user can observe: at this point it is not yet known whether another
   * instance is offering too.
   */
  onPermissionOffer?: (n: NotifyPayload) => { requestId: string } | null;
  /**
   * Commit a previously offered decision, chosen by `notify.mjs` as the only
   * one. Return the COMPLETE stdout document Claude Code reads — i.e. the
   * `{ hookSpecificOutput: … }` wrapper, not just its contents — or null if
   * the offer expired or could not be recorded.
   */
  onPermissionCommit?: (n: NotifyPayload, requestId: string) => Record<string, unknown> | null;
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
  onPermissionOffer,
  onPermissionCommit,
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
        const phase = String(payload.phase || "").trim() as PermissionPhase | "";

        log.trace("notification received", {
          sessionId,
          hook,
          subtype: subtype || null,
          message: String(payload.message || "").slice(0, 100),
        });
        const notification: NotifyPayload = {
          sessionId,
          hook,
          subtype,
          payload,
          // Back-compat fields for callers that haven't migrated to the new shape.
          // Dispatcher (Phase 0 step 4) ignores these and reads hook/subtype instead.
          notificationType: subtype || "idle_prompt",
          message: String(payload.message || ""),
          title: String(payload.title || ""),
        };
        // The commit leg is a second POST for a request the dispatcher has
        // already seen. Re-running the notification pipeline for it would
        // double every side effect it has (signal updates, activity state), so
        // it goes straight to the committer.
        if (hook === DECIDABLE_HOOK && phase === "commit") {
          const requestId = String(payload.request_id || "").trim();
          let committed: Record<string, unknown> | null = null;
          if (requestId && onPermissionCommit) {
            try {
              committed = onPermissionCommit(notification, requestId) || null;
            } catch (error) {
              log.warn("onPermissionCommit error — leaving the prompt to the user", {
                sessionId,
                requestId,
                err: (error as Error).message,
              });
              committed = null;
            }
          }
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(committed ? JSON.stringify({ hookOutput: committed }) : "{}");
          return;
        }

        try {
          onNotification(notification);
        } catch (error) {
          log.warn("onNotification error", { err: (error as Error).message });
        }

        // An offer only exists for PermissionRequest, and only when an offerer
        // is wired. Anything else — including an offerer that throws — answers
        // with `{}`, which notify.mjs reads as "no opinion" and the agent then
        // shows its prompt. Failing silent is the safe direction.
        let offer: { requestId: string } | null = null;
        if (hook === DECIDABLE_HOOK && onPermissionOffer) {
          try {
            offer = onPermissionOffer(notification) || null;
          } catch (error) {
            log.warn("onPermissionOffer error — leaving the prompt to the user", {
              sessionId,
              err: (error as Error).message,
            });
            offer = null;
          }
        }

        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(offer?.requestId ? JSON.stringify({ offer: { requestId: offer.requestId } }) : "{}");
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
