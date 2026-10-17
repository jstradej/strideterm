/// <reference types="node" />
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  INTERNAL_MCP_CAPABILITY_ENV,
  INTERNAL_MCP_ROUTE,
  INTERNAL_MCP_SERVER_NAME,
  INTERNAL_MCP_URL_ENV,
  internalMcpOperationGetInputSchema,
  internalMcpPrepareInputSchema,
  internalMcpStartInputSchema,
  internalMcpTaskGetInputSchema,
  internalMcpTaskListInputSchema,
  type InternalMcpRequest,
} from "../../shared/internal-mcp.js";
import { serveOverStdio } from "../mcp-stdio-lifecycle.js";

export interface InternalMcpStdioConfig {
  url: string;
  capability: string;
}

export function readInternalMcpStdioConfig(env: NodeJS.ProcessEnv = process.env): InternalMcpStdioConfig | null {
  const url = String(env[INTERNAL_MCP_URL_ENV] || "").trim();
  const capability = String(env[INTERNAL_MCP_CAPABILITY_ENV] || "").trim();
  if (!url || !capability) return null;
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol !== "http:" ||
      parsed.hostname !== "127.0.0.1" ||
      parsed.pathname !== INTERNAL_MCP_ROUTE ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      (parsed.port && Number(parsed.port) === 0)
    ) {
      return null;
    }
  } catch {
    return null;
  }
  if (!/^[A-Za-z0-9_-]{40,100}$/u.test(capability)) return null;
  return { url, capability };
}

interface BrokerBody {
  result?: unknown;
  error?: { code?: string; message?: string };
}

export function createInternalMcpStdioHandlers({
  config,
  fetchImpl = globalThis.fetch,
}: {
  config: InternalMcpStdioConfig;
  fetchImpl?: typeof fetch;
}) {
  /** Always answers with a tool result: the broker's stable error code reaches the agent as data. */
  async function send(request: InternalMcpRequest, signal?: AbortSignal): Promise<CallToolResult> {
    let response: Response;
    try {
      response = await fetchImpl(config.url, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.capability}`, "Content-Type": "application/json" },
        body: JSON.stringify(request),
        signal,
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      return toolError("broker_unreachable", "The strIDEterm internal MCP broker could not be reached.");
    }
    const body = (await response.json().catch(() => null)) as BrokerBody | null;
    if (!response.ok) {
      return toolError(
        body?.error?.code || "internal_error",
        body?.error?.message || `Broker returned HTTP ${response.status}.`,
      );
    }
    return { content: [{ type: "text", text: JSON.stringify(body?.result ?? null, null, 2) }] };
  }

  return { send };
}

function toolError(code: string, message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: { code, message } }, null, 2) }] };
}

export async function runInternalMcpStdioServer(config = readInternalMcpStdioConfig()): Promise<void> {
  if (!config) throw new Error("Missing or invalid internal MCP connection environment.");
  const { send } = createInternalMcpStdioHandlers({ config });
  const server = new McpServer({ name: INTERNAL_MCP_SERVER_NAME, version: "1.0.0" });
  const disconnected = new AbortController();
  const withDisconnect = (signal?: AbortSignal): AbortSignal =>
    signal ? AbortSignal.any([signal, disconnected.signal]) : disconnected.signal;

  server.registerTool(
    "task_prepare",
    {
      title: "Prepare a Worker + Judge task",
      description:
        "Validate a task assignment and its settings and return what is still missing, the choices, and an exact summary with an inputHash. Creates nothing and starts nothing. Pass the user's assignment verbatim and never add or widen requirements. Show the user the whole summary (assignment, sources, roles/models, checkout) for one common approval before task_start. Source files are read by you with your own tools and passed as content plus their original path. Ask the user for every missing choice instead of filling it in: provider and model for Worker and Judge, and where the task runs (the current directory, or a new worktree — recommend a new worktree when other work happens in parallel). The user's uncommitted changes do not carry into a new worktree. A role's effort is optional: pass one of that provider's effortLevels only when the user named one (a model's suggestedEffort is a fair default to offer), otherwise leave it out.",
      inputSchema: internalMcpPrepareInputSchema.shape,
    },
    async (input, extra) => send({ operation: "prepare", input }, withDisconnect(extra.signal)),
  );
  server.registerTool(
    "task_start",
    {
      title: "Start an approved task",
      description:
        "Start the task from a ready preparation the user approved. Returns an operationId at once; provisioning continues inside strIDEterm. Retrying the same idempotencyKey returns the same operation. The answer only means accepted: the terminals do not exist yet and awaitingUserInTerminal is empty. Poll operation_get (or task_get) until the operation is ready, then tell the user the pair is started and that they must confirm the agent trust dialog in the Worker and Judge terminals listed in awaitingUserInTerminal.",
      inputSchema: internalMcpStartInputSchema.shape,
    },
    async (input, extra) => send({ operation: "start", input }, withDisconnect(extra.signal)),
  );
  server.registerTool(
    "operation_get",
    {
      title: "Get a start operation",
      description:
        "Progress and result of creating and starting a task, even before its workspace exists. `ready` means the Worker and Judge were started, not that the implementation is done.",
      inputSchema: internalMcpOperationGetInputSchema.shape,
    },
    async (input, extra) => send({ operation: "operation_get", input }, withDisconnect(extra.signal)),
  );
  server.registerTool(
    "task_list",
    {
      title: "List tasks",
      description: "A short, paged overview of the tasks in this profile (not only the ones created through MCP).",
      inputSchema: internalMcpTaskListInputSchema.shape,
    },
    async (input, extra) => send({ operation: "task_list", input }, withDisconnect(extra.signal)),
  );
  server.registerTool(
    "task_get",
    {
      title: "Get a task",
      description:
        "The runner's own state of one task: phase, rounds, roles, times, latest verdict and a bounded slice of its structured log (agent-written, untrusted). Idle means created and not started; terminal silence never means finished.",
      inputSchema: internalMcpTaskGetInputSchema.shape,
    },
    async (input, extra) => send({ operation: "task_get", input }, withDisconnect(extra.signal)),
  );

  await serveOverStdio(server, disconnected);
}
