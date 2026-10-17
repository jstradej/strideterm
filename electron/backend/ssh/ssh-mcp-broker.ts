import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type http from "node:http";
import { z } from "zod";
import type { createSshCommandService } from "./ssh-command-service.js";
import { bearerCapability, listenOnLoopback, readJsonBody, sendJson } from "../loopback-broker-http.js";

const ROUTE = "/ssh-mcp";
const MAX_BODY_BYTES = 16 * 1024;
const BODY_TIMEOUT_MS = 5_000;
const MAX_GLOBAL_REQUESTS = 8;
const MAX_REQUESTS_PER_GRANT = 2;

const requestSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("list") }).strict(),
  z
    .object({
      operation: z.literal("run"),
      hostId: z.string().trim().min(1).max(200),
      command: z.string().trim().min(1).max(8_000),
      timeoutMs: z.number().int().min(1).max(60_000).optional(),
    })
    .strict(),
]);

export interface SshMcpGrantContext {
  sessionId: string;
  profileId: string;
  workspaceId: string;
  panelId: string;
  command: string;
}

export interface SshMcpBrokerOptions {
  service: Pick<ReturnType<typeof createSshCommandService>, "listHosts" | "runCommand">;
  isGrantLive: (_grant: Readonly<SshMcpGrantContext>) => boolean | Promise<boolean>;
}

interface GrantRecord {
  context: SshMcpGrantContext;
  controllers: Set<AbortController>;
}

export function createSshMcpBroker({ service, isGrantLive }: SshMcpBrokerOptions) {
  const grants = new Map<string, GrantRecord>();
  let server: http.Server | null = null;
  let endpoint = "";
  let activeRequests = 0;

  function findGrant(capability: string): [string, GrantRecord] | null {
    if (!capability) return null;
    const grant = grants.get(capability);
    return grant ? [capability, grant] : null;
  }

  async function isLive(grant: GrantRecord): Promise<boolean> {
    try {
      return await isGrantLive(grant.context);
    } catch {
      return false;
    }
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== "POST" || new URL(request.url || "/", "http://127.0.0.1").pathname !== ROUTE) {
      sendJson(response, 404, { error: { code: "not_found", message: "Not found." } });
      return;
    }

    const capability = bearerCapability(request);
    const found = findGrant(capability);
    if (!found) {
      sendJson(response, 401, {
        error: {
          code: "unauthorized",
          message: "SSH tool grant is unavailable. Restart this agent tab with SSH tools enabled.",
        },
      });
      return;
    }
    const [grantId, grant] = found;
    if (activeRequests >= MAX_GLOBAL_REQUESTS || grant.controllers.size >= MAX_REQUESTS_PER_GRANT) {
      sendJson(response, 429, {
        error: { code: "busy", message: "Too many SSH tool requests are running. Try again shortly." },
      });
      return;
    }

    activeRequests += 1;
    const controller = new AbortController();
    grant.controllers.add(controller);
    const onResponseClose = () => {
      if (!response.writableEnded) controller.abort();
    };
    response.once("close", onResponseClose);

    try {
      const live = await isLive(grant);
      if (!live) {
        revokeGrant(grantId);
        sendJson(response, 403, {
          error: {
            code: "grant_expired",
            message: "SSH tools are no longer enabled for this tab. Restart the opted-in agent tab to reconnect.",
          },
        });
        return;
      }
      if (grants.get(grantId) !== grant || controller.signal.aborted) {
        sendJson(response, 401, {
          error: {
            code: "unauthorized",
            message: "SSH tool grant is unavailable. Restart this agent tab with SSH tools enabled.",
          },
        });
        return;
      }

      const raw = await readJsonBody(request, controller, { maxBytes: MAX_BODY_BYTES, timeoutMs: BODY_TIMEOUT_MS });
      if (controller.signal.aborted) return;
      const parsed = requestSchema.safeParse(raw);
      if (!parsed.success) {
        sendJson(response, 400, { error: { code: "invalid_request", message: "Invalid SSH tool request." } });
        return;
      }

      // Revalidate immediately before the operation; renderer state can change
      // while the request body is in flight.
      const stillLive = await isLive(grant);
      if (!stillLive) {
        revokeGrant(grantId);
        sendJson(response, 403, {
          error: {
            code: "grant_expired",
            message: "SSH tools are no longer enabled for this tab. Restart the opted-in agent tab to reconnect.",
          },
        });
        return;
      }
      if (grants.get(grantId) !== grant || controller.signal.aborted) {
        sendJson(response, 401, {
          error: {
            code: "unauthorized",
            message: "SSH tool grant is unavailable. Restart this agent tab with SSH tools enabled.",
          },
        });
        return;
      }

      const result =
        parsed.data.operation === "list"
          ? { hosts: service.listHosts() }
          : await service.runCommand({
              hostId: parsed.data.hostId,
              command: parsed.data.command,
              timeoutMs: parsed.data.timeoutMs,
              signal: controller.signal,
            });
      if (!controller.signal.aborted) sendJson(response, 200, { result });
    } catch (error) {
      if (controller.signal.aborted) {
        if (!response.destroyed)
          sendJson(response, 403, {
            error: {
              code: "grant_expired",
              message: "SSH tools are no longer enabled for this tab. Restart the opted-in agent tab to reconnect.",
            },
          });
        return;
      }
      if (response.destroyed) return;
      const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "ssh_error";
      const message = error instanceof Error ? error.message : "SSH tool request failed.";
      const status = code === "invalid_request" ? 400 : code === "busy" ? 429 : code === "unsupported_host" ? 422 : 502;
      sendJson(response, status, { error: { code, message } });
    } finally {
      response.off("close", onResponseClose);
      grant.controllers.delete(controller);
      activeRequests = Math.max(0, activeRequests - 1);
    }
  }

  function revokeGrant(id: string): void {
    const grant = grants.get(id);
    if (!grant) return;
    grants.delete(id);
    for (const controller of grant.controllers) controller.abort();
    grant.controllers.clear();
  }

  return {
    async start(): Promise<{ url: string }> {
      if (server) return { url: endpoint };
      const listening = await listenOnLoopback(
        ROUTE,
        (request, response) => {
          void handle(request, response).catch(() =>
            sendJson(response, 500, { error: { code: "internal_error", message: "SSH tool request failed." } }),
          );
        },
        { bodyTimeoutMs: BODY_TIMEOUT_MS },
      );
      server = listening.server;
      endpoint = listening.url;
      return { url: endpoint };
    },

    mintGrant(context: SshMcpGrantContext): { url: string; capability: string } {
      if (!server || !endpoint) throw new Error("SSH MCP broker has not started.");
      const capability = randomBytes(32).toString("base64url");
      grants.set(capability, { context: { ...context }, controllers: new Set() });
      return { url: endpoint, capability };
    },

    revokeSession(sessionId: string): void {
      for (const [id, grant] of grants) {
        if (grant.context.sessionId === sessionId) revokeGrant(id);
      }
    },

    async revokeInvalid(): Promise<number> {
      let revoked = 0;
      for (const [id, grant] of grants) {
        const live = await isLive(grant);
        if (!live) {
          revokeGrant(id);
          revoked += 1;
        }
      }
      return revoked;
    },

    async close(): Promise<void> {
      for (const id of grants.keys()) revokeGrant(id);
      const current = server;
      server = null;
      endpoint = "";
      if (!current) return;
      await new Promise<void>((resolve) => current.close(() => resolve()));
    },
  };
}

export { ROUTE as SSH_MCP_BROKER_ROUTE };
