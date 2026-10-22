import { randomBytes } from "node:crypto";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import { reviewGitConfirmationSchema, reviewGitOperationKindSchema } from "../../shared/review-git-events.js";
import type { ReviewGitService } from "./service.js";
import type { ReviewPrActionService } from "./pr-actions.js";
import { reviewPrActionSchema, reviewPrActionOptionsSchema } from "../../shared/review-pr-actions.js";

const ROUTE = "/review-git";
const MAX_BODY_BYTES = 64 * 1024;
const BODY_TIMEOUT_MS = 5_000;
const MAX_GLOBAL_REQUESTS = 12;
const MAX_REQUESTS_PER_GRANT = 4;
const MAX_WAIT_MS = 20_000;

const pathSchema = z.string().trim().min(1).max(4096);

/**
 * What an agent may start. Publishing queued comments is deliberately not here:
 * it stays the user's own explicit action, and an agent's push never publishes.
 */
const agentOperationKindSchema = reviewGitOperationKindSchema.exclude(["push-and-publish"]);

export const reviewGitBrokerRequestSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("identity") }).strict(),
  z.object({ operation: z.literal("status") }).strict(),
  z.object({ operation: z.literal("refs"), query: z.boolean().optional() }).strict(),
  z
    .object({
      operation: z.literal("diff"),
      scope: z.enum(["worktree", "staged", "head-vs-target", "head-vs-source"]),
      path: pathSchema.optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("history"),
      range: z.enum(["head", "head-vs-target", "head-vs-source"]),
      limit: z.number().int().min(1).max(100).optional(),
    })
    .strict(),
  z.object({ operation: z.literal("conflicts") }).strict(),
  z.object({ operation: z.literal("checks") }).strict(),
  z
    .object({
      operation: z.literal("pr-inspect"),
      idempotencyKey: z.string().trim().min(8).max(100),
      waitMs: z.number().int().min(0).max(MAX_WAIT_MS).optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("pr-action-propose"),
      action: reviewPrActionSchema,
      options: reviewPrActionOptionsSchema.default({}),
      idempotencyKey: z.string().trim().min(8).max(100),
      waitMs: z.number().int().min(0).max(MAX_WAIT_MS).optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("pr-action-status"),
      id: z.string().trim().min(1).max(100),
      waitMs: z.number().int().min(0).max(MAX_WAIT_MS).optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("audit-log"),
      limit: z.number().int().min(1).max(100).optional(),
      category: z.enum(["read", "write"]).optional(),
      operationName: z.string().trim().min(1).max(100).optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("start"),
      kind: agentOperationKindSchema,
      /** Minted by the caller before the first attempt, so a lost acknowledgement can be retried safely. */
      idempotencyKey: z.string().trim().min(8).max(100),
      confirmation: reviewGitConfirmationSchema.optional(),
      paths: z.array(pathSchema).min(1).max(500).optional(),
      message: z.string().trim().min(1).max(10_000).optional(),
      /** What the agent reports the user answered. Recorded for audit; it is not proof of anything. */
      consent: z.string().trim().max(500).optional(),
      waitMs: z.number().int().min(0).max(MAX_WAIT_MS).optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("operation-status"),
      operationId: z.string().trim().min(1).max(100),
      waitMs: z.number().int().min(0).max(MAX_WAIT_MS).optional(),
    })
    .strict(),
]);

export type ReviewGitBrokerRequest = z.infer<typeof reviewGitBrokerRequestSchema>;

/** What a capability is scoped to. Re-proved against live state on every request. */
export interface ReviewGitGrantContext {
  sessionId: string;
  profileId: string;
  workspaceId: string;
  panelId: string;
  prKey: string;
  /** Digest of provider/connection/PR/source ref/source repository at mint time. */
  identityKey: string;
  agent: string;
  command: string;
}

export interface ReviewGitBrokerOptions {
  service: Pick<ReviewGitService, "read" | "start" | "lookup" | "operations">;
  prActions?: () => ReviewPrActionService | null;
  isGrantLive: (grant: Readonly<ReviewGitGrantContext>) => boolean | Promise<boolean>;
}

interface GrantRecord {
  context: ReviewGitGrantContext;
  controllers: Set<AbortController>;
}

class BrokerError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(payload));
}

function readBody(request: IncomingMessage, controller: AbortController): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(value);
    };
    const timeout = setTimeout(() => {
      controller.abort();
      finish(new Error("Request body timed out."));
      request.destroy();
    }, BODY_TIMEOUT_MS);
    timeout.unref?.();
    request.on("data", (chunk: Buffer | string) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += value.length;
      if (size > MAX_BODY_BYTES) {
        controller.abort();
        finish(new Error("Request body too large."));
        request.destroy();
        return;
      }
      chunks.push(value);
    });
    request.on("end", () => {
      try {
        finish(undefined, JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        finish(new Error("Request body must be valid JSON."));
      }
    });
    request.on("error", (error) => finish(error));
    request.on("aborted", () => {
      controller.abort();
      finish(new Error("Request was cancelled."));
    });
  });
}

function bearerCapability(request: IncomingMessage): string {
  const header = request.headers.authorization || "";
  const match = /^Bearer ([A-Za-z0-9_-]{40,100})$/u.exec(header);
  return match?.[1] || "";
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/**
 * Loopback broker for the review MCP server's Git tools.
 *
 * The MCP child holds a session-scoped, least-privilege capability: it names
 * one profile, workspace, PR, source identity and agent tab, and the runtime
 * re-proves all of that against live state on every request. The master
 * remote token and provider PATs never reach the child — the runtime does the
 * Git work. Revoking a capability (the tab detaches or closes, the profile is
 * lost, the source identity changes) refuses NEW requests; an operation that
 * already started is the runtime's and finishes regardless.
 */
export function createReviewGitBroker({ service, prActions, isGrantLive }: ReviewGitBrokerOptions) {
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

  async function dispatch(grant: GrantRecord, request: ReviewGitBrokerRequest, signal: AbortSignal): Promise<unknown> {
    const { profileId, workspaceId, agent, panelId } = grant.context;
    switch (request.operation) {
      case "start": {
        const started = service.start(
          {
            kind: request.kind,
            workspaceId,
            idempotencyKey: request.idempotencyKey,
            confirmation: request.confirmation,
            paths: request.paths,
            message: request.message,
          },
          { profileId, requester: { source: "mcp", agent, panelId, consent: request.consent } },
        );
        return lookupWithWait(grant, started.operationId, request.waitMs ?? 0, signal, true);
      }
      case "operation-status":
        return lookupWithWait(grant, request.operationId, request.waitMs ?? 0, signal, false);
      case "pr-inspect": {
        const actions = prActions?.();
        if (!actions) throw new BrokerError("unavailable", "PR actions are unavailable.", 503);
        const started = await actions.startInspection(workspaceId, profileId, request.idempotencyKey);
        return await lookupPrActionWithWait(actions, grant, started.operationId, request.waitMs ?? 0, signal, true);
      }
      case "pr-action-propose": {
        const actions = prActions?.();
        if (!actions) throw new BrokerError("unavailable", "PR actions are unavailable.", 503);
        const started = await actions.startProposal(
          { action: request.action, options: request.options, idempotencyKey: request.idempotencyKey },
          { profileId, workspaceId, requester: { source: "mcp", agent, panelId } },
        );
        return await lookupPrActionWithWait(actions, grant, started.operationId, request.waitMs ?? 0, signal, true);
      }
      case "pr-action-status": {
        const actions = prActions?.();
        if (!actions) throw new BrokerError("unavailable", "PR actions are unavailable.", 503);
        return actions.lookupStatus(request.id, profileId, workspaceId);
      }
      default:
        return service.read(request, workspaceId, profileId);
    }
  }

  async function lookupPrActionWithWait(
    actions: ReviewPrActionService,
    grant: GrantRecord,
    operationId: string,
    waitMs: number,
    signal: AbortSignal,
    started: boolean,
  ) {
    const { profileId, workspaceId } = grant.context;
    const deadline = Date.now() + waitMs;
    let current = actions.lookupStatus(operationId, profileId, workspaceId);
    while (
      (current.status === "accepted" || current.status === "running") &&
      Date.now() < deadline &&
      !signal.aborted
    ) {
      await sleep(150, signal);
      current = actions.lookupStatus(operationId, profileId, workspaceId);
    }
    return { operationId, started, ...current };
  }

  async function lookupWithWait(
    grant: GrantRecord,
    operationId: string,
    waitMs: number,
    signal: AbortSignal,
    justStarted: boolean,
  ) {
    const { profileId, workspaceId } = grant.context;
    const deadline = Date.now() + waitMs;
    let current = service.lookup(operationId, profileId, workspaceId);
    while (current.status === "running" && Date.now() < deadline && !signal.aborted) {
      await sleep(150, signal);
      current = service.lookup(operationId, profileId, workspaceId);
    }
    return { operationId, started: justStarted, ...current };
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== "POST" || new URL(request.url || "/", "http://127.0.0.1").pathname !== ROUTE) {
      sendJson(response, 404, { error: { code: "not_found", message: "Not found." } });
      return;
    }
    const capability = bearerCapability(request);
    const grant = capability ? grants.get(capability) : undefined;
    if (!grant) {
      sendJson(response, 401, {
        error: {
          code: "unauthorized",
          message: "Review Git grant is unavailable. Restart this agent tab from its review workspace.",
        },
      });
      return;
    }
    if (activeRequests >= MAX_GLOBAL_REQUESTS || grant.controllers.size >= MAX_REQUESTS_PER_GRANT) {
      sendJson(response, 429, { error: { code: "busy", message: "Too many review Git requests are running." } });
      return;
    }

    activeRequests += 1;
    const controller = new AbortController();
    grant.controllers.add(controller);
    const onResponseClose = () => {
      if (!response.writableEnded) controller.abort();
    };
    response.once("close", onResponseClose);

    const expired = (operationId?: string) => {
      sendJson(response, 403, {
        error: {
          code: "grant_expired",
          message:
            "Review Git is no longer available for this tab (it was detached, closed, or its pull request changed). Operations already started keep running" +
            (operationId ? ` (operation ${operationId}); restart this agent tab to query them again.` : "."),
          ...(operationId ? { operationId } : {}),
        },
      });
    };

    try {
      if (!(await isLive(grant))) {
        revokeGrant(capability);
        return expired();
      }
      if (grants.get(capability) !== grant || controller.signal.aborted) {
        sendJson(response, 401, { error: { code: "unauthorized", message: "Review Git grant is unavailable." } });
        return;
      }
      const raw = await readBody(request, controller);
      if (controller.signal.aborted) return;
      const parsed = reviewGitBrokerRequestSchema.safeParse(raw);
      if (!parsed.success) {
        sendJson(response, 400, { error: { code: "invalid_request", message: "Invalid review Git request." } });
        return;
      }
      // Revalidate immediately before acting; state can change while the body is in flight.
      if (!(await isLive(grant))) {
        revokeGrant(capability);
        return expired();
      }
      const result = await dispatch(grant, parsed.data, controller.signal);
      if (!controller.signal.aborted) sendJson(response, 200, { result });
      else if (grants.get(capability) !== grant && !response.destroyed) {
        expired((result as { operationId?: string } | null)?.operationId);
      }
    } catch (error) {
      if (response.destroyed) return;
      if (error instanceof BrokerError) {
        sendJson(response, error.status, { error: { code: error.code, message: error.message } });
        return;
      }
      const message = error instanceof Error ? error.message : "Review Git request failed.";
      sendJson(response, 422, { error: { code: "rejected", message } });
    } finally {
      response.off("close", onResponseClose);
      grant.controllers.delete(controller);
      activeRequests = Math.max(0, activeRequests - 1);
    }
  }

  return {
    async start(): Promise<{ url: string }> {
      if (server) return { url: endpoint };
      const created = http.createServer((request, response) => {
        void handle(request, response).catch(() =>
          sendJson(response, 500, { error: { code: "internal_error", message: "Review Git request failed." } }),
        );
      });
      created.on("clientError", (_error, socket) => socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"));
      created.headersTimeout = 10_000;
      created.requestTimeout = BODY_TIMEOUT_MS + MAX_WAIT_MS + 5_000;
      await new Promise<void>((resolve, reject) => {
        created.once("error", reject);
        created.listen(0, "127.0.0.1", () => {
          created.off("error", reject);
          resolve();
        });
      });
      server = created;
      const address = created.address() as AddressInfo;
      endpoint = `http://127.0.0.1:${address.port}${ROUTE}`;
      return { url: endpoint };
    },

    mintGrant(context: ReviewGitGrantContext): { url: string; capability: string } {
      if (!server || !endpoint) throw new Error("Review Git broker has not started.");
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

    grantCount(): number {
      return grants.size;
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

export { ROUTE as REVIEW_GIT_BROKER_ROUTE };
