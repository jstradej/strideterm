import { randomBytes } from "node:crypto";
import type http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { bearerCapability, listenOnLoopback, readJsonBody, sendJson } from "../loopback-broker-http.js";
import { INTERNAL_MCP_ROUTE, internalMcpRequestSchema, type InternalMcpErrorCode } from "../../shared/internal-mcp.js";
import { InternalMcpError } from "./errors.js";
import type { InternalMcpScope, TaskService } from "./task-service.js";

const MAX_BODY_BYTES = 6 * 1024 * 1024;
const BODY_TIMEOUT_MS = 10_000;
const MAX_GLOBAL_REQUESTS = 8;
const MAX_REQUESTS_PER_GRANT = 2;

export interface InternalMcpGrantContext extends InternalMcpScope {
  sessionId: string;
  panelId: string;
  command: string;
}

export interface InternalMcpBrokerOptions {
  service: Pick<
    TaskService,
    | "prepare"
    | "start"
    | "operationGet"
    | "taskList"
    | "taskGet"
    | "companionCreate"
    | "companionStart"
    | "companionPause"
    | "companionAnswer"
  >;
  isGrantLive: (_grant: Readonly<InternalMcpGrantContext>) => boolean | Promise<boolean>;
  onError?: (message: string, details: Record<string, unknown>) => void;
}

interface GrantRecord {
  context: InternalMcpGrantContext;
  controllers: Set<AbortController>;
}

const STATUS_BY_CODE: Record<InternalMcpErrorCode, number> = {
  invalid_request: 400,
  scope_denied: 403,
  workspace_not_found: 404,
  task_not_found: 404,
  operation_not_found: 404,
  preparation_not_found: 404,
  checkout_conflict: 409,
  idempotency_conflict: 409,
  needs_reprepare: 409,
  preparation_not_ready: 409,
  start_refused: 409,
  provider_unavailable: 422,
  unsupported_workspace: 422,
  file_not_accessible: 422,
  busy: 429,
  internal_error: 500,
};

const GRANT_UNAVAILABLE = {
  error: {
    code: "unauthorized",
    message: "Internal MCP grant is unavailable. Restart this agent tab with internal MCP enabled for the workspace.",
  },
};
const GRANT_EXPIRED = {
  error: {
    code: "grant_expired",
    message: "Internal MCP is no longer enabled for this tab. Restart the agent tab to reconnect.",
  },
};

export function createInternalMcpBroker({ service, isGrantLive, onError }: InternalMcpBrokerOptions) {
  const grants = new Map<string, GrantRecord>();
  let server: http.Server | null = null;
  let endpoint = "";
  let activeRequests = 0;

  async function isLive(grant: GrantRecord): Promise<boolean> {
    try {
      return await isGrantLive(grant.context);
    } catch {
      return false;
    }
  }

  function revokeGrant(id: string): void {
    const grant = grants.get(id);
    if (!grant) return;
    grants.delete(id);
    for (const controller of grant.controllers) controller.abort();
    grant.controllers.clear();
  }

  function answerAborted(response: ServerResponse): void {
    if (!response.destroyed && !response.headersSent) sendJson(response, 403, GRANT_EXPIRED);
  }

  async function dispatch(grant: GrantRecord, raw: unknown): Promise<unknown> {
    const parsed = internalMcpRequestSchema.safeParse(raw);
    if (!parsed.success) throw new InternalMcpError("invalid_request", "Invalid internal MCP request.");
    // The profile and workspace come from the grant. Nothing in the request can change them.
    const scope: InternalMcpScope = { profileId: grant.context.profileId, workspaceId: grant.context.workspaceId };
    const request = parsed.data;
    switch (request.operation) {
      case "prepare":
        return service.prepare(scope, request.input);
      case "start":
        return service.start(scope, request.input);
      case "operation_get":
        return service.operationGet(scope, request.input.operationId);
      case "task_list":
        return service.taskList(scope, request.input);
      case "task_get":
        return service.taskGet(scope, request.input);
      case "companion_create":
        return service.companionCreate(scope, grant.context.sessionId, request.input);
      case "companion_start":
        return service.companionStart(scope, grant.context.sessionId, request.input.workspaceId);
      case "companion_pause":
        return service.companionPause(scope, grant.context.sessionId, request.input.workspaceId);
      case "companion_answer":
        return service.companionAnswer(scope, grant.context.sessionId, request.input);
    }
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== "POST" || new URL(request.url || "/", "http://127.0.0.1").pathname !== INTERNAL_MCP_ROUTE) {
      sendJson(response, 404, { error: { code: "not_found", message: "Not found." } });
      return;
    }
    const capability = bearerCapability(request);
    const grant = capability ? grants.get(capability) : undefined;
    if (!grant) {
      sendJson(response, 401, GRANT_UNAVAILABLE);
      return;
    }
    if (activeRequests >= MAX_GLOBAL_REQUESTS || grant.controllers.size >= MAX_REQUESTS_PER_GRANT) {
      sendJson(response, 429, { error: { code: "busy", message: "Too many internal MCP requests are running." } });
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
      if (!(await isLive(grant))) {
        revokeGrant(capability);
        sendJson(response, 403, GRANT_EXPIRED);
        return;
      }
      const raw = await readJsonBody(request, controller, { maxBytes: MAX_BODY_BYTES, timeoutMs: BODY_TIMEOUT_MS });
      if (controller.signal.aborted) {
        answerAborted(response);
        return;
      }
      // Renderer and workspace state can change while the body is in flight.
      if (!(await isLive(grant))) {
        revokeGrant(capability);
        sendJson(response, 403, GRANT_EXPIRED);
        return;
      }
      if (grants.get(capability) !== grant) {
        sendJson(response, 401, GRANT_UNAVAILABLE);
        return;
      }
      const result = await dispatch(grant, raw);
      if (controller.signal.aborted) answerAborted(response);
      else sendJson(response, 200, { result });
    } catch (error) {
      if (controller.signal.aborted) {
        answerAborted(response);
        return;
      }
      if (response.destroyed) return;
      if (error instanceof InternalMcpError) {
        sendJson(response, STATUS_BY_CODE[error.code], { error: { code: error.code, message: error.message } });
        return;
      }
      const message = error instanceof Error ? error.message : "Internal MCP request failed.";
      onError?.("internal MCP request failed", { err: message });
      sendJson(response, 500, { error: { code: "internal_error", message } });
    } finally {
      response.off("close", onResponseClose);
      grant.controllers.delete(controller);
      activeRequests = Math.max(0, activeRequests - 1);
    }
  }

  return {
    async start(): Promise<{ url: string }> {
      if (server) return { url: endpoint };
      const listening = await listenOnLoopback(
        INTERNAL_MCP_ROUTE,
        (request, response) => {
          void handle(request, response).catch(() =>
            sendJson(response, 500, { error: { code: "internal_error", message: "Internal MCP request failed." } }),
          );
        },
        { bodyTimeoutMs: BODY_TIMEOUT_MS },
      );
      server = listening.server;
      endpoint = listening.url;
      return { url: endpoint };
    },

    mintGrant(context: InternalMcpGrantContext): { url: string; capability: string } {
      if (!server || !endpoint) throw new Error("Internal MCP broker has not started.");
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
        if (!(await isLive(grant))) {
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

export type InternalMcpBroker = ReturnType<typeof createInternalMcpBroker>;
