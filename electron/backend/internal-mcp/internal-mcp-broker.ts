import { randomBytes } from "node:crypto";
import type http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { bearerCapability, listenOnLoopback, readJsonBody, sendJson } from "../loopback-broker-http.js";
import {
  INTERNAL_MCP_ROUTE,
  internalMcpRequestSchema,
  type InternalMcpErrorCode,
  type InternalMcpAutomationCreateInput,
} from "../../shared/internal-mcp.js";
import { InternalMcpError } from "./errors.js";
import { jiraMcpCallSucceeded, jiraUnavailableError } from "./jira-mcp-errors.js";
import type { InternalMcpScope, TaskService } from "./task-service.js";
import type { AutomationSetEnabledInput, AutomationUpdateInput } from "../../shared/automation-api.js";
import { scheduleTriggerSchema } from "../../shared/automation.js";

const MAX_BODY_BYTES = 6 * 1024 * 1024;
const BODY_TIMEOUT_MS = 10_000;
const MAX_GLOBAL_REQUESTS = 8;
const MAX_REQUESTS_PER_GRANT = 2;

export interface InternalMcpGrantContext extends InternalMcpScope {
  sessionId: string;
  panelId: string;
  command: string;
  tasksEnabled?: boolean;
  jiraEnabled?: boolean;
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
  jira?: JiraInternalMcpApi;
  automation?: AutomationInternalMcpApi;
  isGrantLive: (_grant: Readonly<InternalMcpGrantContext>) => boolean | Promise<boolean>;
  onError?: (message: string, details: Record<string, unknown>) => void;
}

export interface AutomationInternalMcpApi {
  catalog(scope: InternalMcpScope): Promise<unknown>;
  list(scope: InternalMcpScope): Promise<unknown>;
  get(scope: InternalMcpScope, workspaceId: string): Promise<unknown>;
  create(
    grant: InternalMcpGrantContext,
    input: InternalMcpAutomationCreateInput,
    assertGrant: () => void,
  ): Promise<unknown>;
  delete(grant: InternalMcpGrantContext, workspaceId: string, assertGrant: () => void): Promise<unknown>;
  update(grant: InternalMcpGrantContext, input: AutomationUpdateInput, assertGrant: () => void): Promise<unknown>;
  setEnabled(
    grant: InternalMcpGrantContext,
    input: AutomationSetEnabledInput,
    assertGrant: () => void,
  ): Promise<unknown>;
  runNow(
    scope: InternalMcpScope,
    input: { workspaceId: string; idempotencyKey: string },
    assertGrant: () => void,
  ): Promise<unknown>;
  stopRun(
    scope: InternalMcpScope,
    input: { workspaceId: string; runId: string },
    assertGrant: () => void,
  ): Promise<unknown>;
}

export interface JiraInternalMcpApi {
  listConnections(scope: InternalMcpScope, input: Record<string, never>): Promise<unknown>;
  getIssue(scope: InternalMcpScope, input: { connectionId: string; issueId: string }): Promise<unknown>;
  search(scope: InternalMcpScope, input: { connectionId: string; query: string; limit?: number }): Promise<unknown>;
  myOpenIssues(
    scope: InternalMcpScope,
    input: { connectionId: string; limit?: number; cursor?: string },
  ): Promise<unknown>;
  getComments(scope: InternalMcpScope, input: { connectionId: string; issueId: string }): Promise<unknown>;
  listProjects(scope: InternalMcpScope, input: { connectionId: string }): Promise<unknown>;
  listFilters(scope: InternalMcpScope, input: { connectionId: string }): Promise<unknown>;
  getFilter(scope: InternalMcpScope, input: { connectionId: string; filterId: string }): Promise<unknown>;
  listBoards(scope: InternalMcpScope, input: { connectionId: string }): Promise<unknown>;
  boardView(
    scope: InternalMcpScope,
    input: {
      connectionId: string;
      boardId: number;
      mode?: "issues" | "backlog" | "sprints";
      cursor?: string;
      sprintId?: number;
    },
  ): Promise<unknown>;
  activeSprint(scope: InternalMcpScope, input: { connectionId: string; boardId: number }): Promise<unknown>;
  getTransitions(scope: InternalMcpScope, input: { connectionId: string; issueId: string }): Promise<unknown>;
  getAttachment(
    scope: InternalMcpScope,
    input: { connectionId: string; issueId: string; attachmentId: string; fileName: string },
  ): Promise<unknown>;
  linkedWork(scope: InternalMcpScope, input: { connectionId: string; issueId: string }): Promise<unknown>;
  proposeComment(
    scope: InternalMcpScope,
    input: { connectionId: string; issueId: string; body: string },
  ): Promise<unknown>;
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
  automation_not_found: 404,
  automation_limit_reached: 409,
  invalid_schedule: 422,
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
  jira_unavailable: 422,
  jira_draft_not_saved: 500,
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

export function createInternalMcpBroker({
  service,
  jira: jiraApi,
  automation,
  isGrantLive,
  onError,
}: InternalMcpBrokerOptions) {
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
    if (!parsed.success) {
      const request = raw as { operation?: unknown; input?: { definition?: { trigger?: { type?: unknown } } } } | null;
      const trigger = request?.input?.definition?.trigger;
      if (
        (request?.operation === "automation_create" || request?.operation === "automation_update") &&
        trigger?.type === "schedule" &&
        !scheduleTriggerSchema.safeParse(trigger).success
      )
        throw new InternalMcpError("invalid_schedule", "The automation schedule is invalid.");
      throw new InternalMcpError("invalid_request", "Invalid internal MCP request.");
    }
    // The profile and workspace come from the grant. Nothing in the request can change them.
    const scope: InternalMcpScope = { profileId: grant.context.profileId, workspaceId: grant.context.workspaceId };
    const request = parsed.data;
    const jiraCall = {
      operation: request.operation,
      connectionId:
        "connectionId" in request.input && typeof request.input.connectionId === "string"
          ? request.input.connectionId
          : undefined,
    };
    const jira = async (call: (api: JiraInternalMcpApi) => Promise<unknown>) => {
      if (!jiraApi) throw new InternalMcpError("jira_unavailable", "Jira is not available to this agent grant.");
      try {
        const result = await call(jiraApi);
        jiraMcpCallSucceeded(jiraCall);
        return result;
      } catch (error) {
        throw jiraUnavailableError(error, jiraCall);
      }
    };
    switch (request.operation) {
      case "prepare":
        if (!grant.context.tasksEnabled)
          throw new InternalMcpError("scope_denied", "Task tools are not enabled for this workspace.");
        return service.prepare(scope, request.input);
      case "start":
        if (!grant.context.tasksEnabled)
          throw new InternalMcpError("scope_denied", "Task tools are not enabled for this workspace.");
        return service.start(scope, request.input);
      case "operation_get":
        if (!grant.context.tasksEnabled)
          throw new InternalMcpError("scope_denied", "Task tools are not enabled for this workspace.");
        return service.operationGet(scope, request.input.operationId);
      case "task_list":
        if (!grant.context.tasksEnabled)
          throw new InternalMcpError("scope_denied", "Task tools are not enabled for this workspace.");
        return service.taskList(scope, request.input);
      case "task_get":
        if (!grant.context.tasksEnabled)
          throw new InternalMcpError("scope_denied", "Task tools are not enabled for this workspace.");
        return service.taskGet(scope, request.input);
      case "automation_event_catalog":
      case "automation_list":
      case "automation_get":
      case "automation_create":
      case "automation_delete":
      case "automation_update":
      case "automation_set_enabled":
      case "automation_run_now":
      case "automation_stop_run":
        if (!grant.context.tasksEnabled)
          throw new InternalMcpError("scope_denied", "Automation tools are not enabled for this workspace.");
        if (!automation) throw new InternalMcpError("internal_error", "Automation tools are unavailable.");
        if (request.operation === "automation_event_catalog") return automation.catalog(scope);
        if (request.operation === "automation_list") return automation.list(scope);
        if (
          [
            "automation_run_now",
            "automation_stop_run",
            "automation_update",
            "automation_set_enabled",
            "automation_create",
            "automation_delete",
          ].includes(request.operation)
        ) {
          const assertGrant = () => {
            if (![...grants.values()].includes(grant))
              throw new InternalMcpError("scope_denied", "Automation grant has expired.");
          };
          if (request.operation === "automation_run_now") return automation.runNow(scope, request.input, assertGrant);
          if (request.operation === "automation_stop_run") return automation.stopRun(scope, request.input, assertGrant);
          if (request.operation === "automation_update")
            return automation.update(grant.context, request.input, assertGrant);
          if (request.operation === "automation_set_enabled")
            return automation.setEnabled(grant.context, request.input, assertGrant);
          if (request.operation === "automation_create")
            return automation.create(grant.context, request.input, assertGrant);
          if (request.operation === "automation_delete")
            return automation.delete(grant.context, request.input.workspaceId, assertGrant);
        }
        if (request.operation === "automation_get") return automation.get(scope, request.input.workspaceId);
        throw new InternalMcpError("invalid_request", "Invalid automation request.");
      case "companion_create":
        if (!grant.context.tasksEnabled)
          throw new InternalMcpError("scope_denied", "Task tools are not enabled for this workspace.");
        return service.companionCreate(scope, grant.context.sessionId, request.input);
      case "companion_start":
        if (!grant.context.tasksEnabled)
          throw new InternalMcpError("scope_denied", "Task tools are not enabled for this workspace.");
        return service.companionStart(scope, grant.context.sessionId, request.input.workspaceId);
      case "companion_pause":
        if (!grant.context.tasksEnabled)
          throw new InternalMcpError("scope_denied", "Task tools are not enabled for this workspace.");
        return service.companionPause(scope, grant.context.sessionId, request.input.workspaceId);
      case "companion_answer":
        if (!grant.context.tasksEnabled)
          throw new InternalMcpError("scope_denied", "Task tools are not enabled for this workspace.");
        return service.companionAnswer(scope, grant.context.sessionId, request.input);
      case "jira_get_issue":
        if (!grant.context.jiraEnabled)
          throw new InternalMcpError("scope_denied", "Jira tools are not enabled for this workspace.");
        return jira((api) => api.getIssue(scope, request.input));
      case "jira_search":
        if (!grant.context.jiraEnabled)
          throw new InternalMcpError("scope_denied", "Jira tools are not enabled for this workspace.");
        return jira((api) => api.search(scope, request.input));
      case "jira_my_open_issues":
        if (!grant.context.jiraEnabled)
          throw new InternalMcpError("scope_denied", "Jira tools are not enabled for this workspace.");
        return jira((api) => api.myOpenIssues(scope, request.input));
      case "jira_get_comments":
        if (!grant.context.jiraEnabled)
          throw new InternalMcpError("scope_denied", "Jira tools are not enabled for this workspace.");
        return jira((api) => api.getComments(scope, request.input));
      case "jira_list_projects":
        if (!grant.context.jiraEnabled)
          throw new InternalMcpError("scope_denied", "Jira tools are not enabled for this workspace.");
        return jira((api) => api.listProjects(scope, request.input));
      case "jira_list_connections":
        if (!grant.context.jiraEnabled)
          throw new InternalMcpError("scope_denied", "Jira tools are not enabled for this workspace.");
        return jira((api) => api.listConnections(scope, request.input));
      case "jira_list_filters":
        if (!grant.context.jiraEnabled)
          throw new InternalMcpError("scope_denied", "Jira tools are not enabled for this workspace.");
        return jira((api) => api.listFilters(scope, request.input));
      case "jira_get_filter":
        if (!grant.context.jiraEnabled)
          throw new InternalMcpError("scope_denied", "Jira tools are not enabled for this workspace.");
        return jira((api) => api.getFilter(scope, request.input));
      case "jira_list_boards":
        if (!grant.context.jiraEnabled)
          throw new InternalMcpError("scope_denied", "Jira tools are not enabled for this workspace.");
        return jira((api) => api.listBoards(scope, request.input));
      case "jira_board_view":
        if (!grant.context.jiraEnabled)
          throw new InternalMcpError("scope_denied", "Jira tools are not enabled for this workspace.");
        return jira((api) => api.boardView(scope, request.input));
      case "jira_active_sprint":
        if (!grant.context.jiraEnabled)
          throw new InternalMcpError("scope_denied", "Jira tools are not enabled for this workspace.");
        return jira((api) => api.activeSprint(scope, request.input));
      case "jira_get_transitions":
        if (!grant.context.jiraEnabled)
          throw new InternalMcpError("scope_denied", "Jira tools are not enabled for this workspace.");
        return jira((api) => api.getTransitions(scope, request.input));
      case "jira_get_attachment":
        if (!grant.context.jiraEnabled)
          throw new InternalMcpError("scope_denied", "Jira tools are not enabled for this workspace.");
        return jira((api) => api.getAttachment(scope, request.input));
      case "jira_linked_work":
        if (!grant.context.jiraEnabled)
          throw new InternalMcpError("scope_denied", "Jira tools are not enabled for this workspace.");
        return jira((api) => api.linkedWork(scope, request.input));
      case "jira_propose_comment":
        if (!grant.context.jiraEnabled)
          throw new InternalMcpError("scope_denied", "Jira tools are not enabled for this workspace.");
        return jira((api) => api.proposeComment(scope, request.input));
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
        sendJson(response, STATUS_BY_CODE[error.code], {
          error: {
            code: error.code,
            message: error.message,
            ...(error.jiraCode ? { jiraCode: error.jiraCode } : {}),
            ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
          },
        });
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
