/// <reference types="node" />
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { SSH_MCP_CAPABILITY_ENV, SSH_MCP_URL_ENV } from "../shared/agent-ssh.js";

export { SSH_MCP_CAPABILITY_ENV, SSH_MCP_URL_ENV };

export interface SshMcpStdioConfig {
  url: string;
  capability: string;
}

export function readSshMcpStdioConfig(env: NodeJS.ProcessEnv = process.env): SshMcpStdioConfig | null {
  const url = String(env[SSH_MCP_URL_ENV] || "").trim();
  const capability = String(env[SSH_MCP_CAPABILITY_ENV] || "").trim();
  if (!url || !capability) return null;
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol !== "http:" ||
      parsed.hostname !== "127.0.0.1" ||
      parsed.pathname !== "/ssh-mcp" ||
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

export function createSshMcpStdioHandlers({
  config,
  fetchImpl = globalThis.fetch,
}: {
  config: SshMcpStdioConfig;
  fetchImpl?: typeof fetch;
}) {
  async function send(payload: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const response = await fetchImpl(config.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.capability}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal,
    });
    const body = (await response.json().catch(() => null)) as { result?: unknown; error?: { message?: string } } | null;
    if (!response.ok) throw new Error(body?.error?.message || `SSH tool broker returned HTTP ${response.status}.`);
    return body?.result;
  }

  return {
    async listHosts(signal?: AbortSignal): Promise<unknown> {
      return send({ operation: "list" }, signal);
    },
    async runCommand(
      input: { hostId: string; command: string; timeoutMs?: number },
      signal?: AbortSignal,
    ): Promise<unknown> {
      return send({ operation: "run", ...input }, signal);
    },
  };
}

function textResult(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

export async function runSshMcpStdioServer(config = readSshMcpStdioConfig()): Promise<void> {
  if (!config) throw new Error("Missing or invalid per-tab SSH MCP connection environment.");
  const handlers = createSshMcpStdioHandlers({ config });
  const server = new McpServer({ name: "strideterm-ssh", version: "1.0.0" });
  const disconnected = new AbortController();
  const withDisconnect = (signal?: AbortSignal): AbortSignal =>
    signal ? AbortSignal.any([signal, disconnected.signal]) : disconnected.signal;

  server.registerTool(
    "list_ssh_hosts",
    {
      title: "List Built-in SSH hosts",
      description:
        "List saved strIDEterm hosts available through Built-in SSH. Host summaries never include passwords, private keys, credential references, or key file contents.",
      inputSchema: {},
    },
    async (_input, extra) => textResult(await handlers.listHosts(withDisconnect(extra.signal))),
  );
  server.registerTool(
    "run_ssh_command",
    {
      title: "Run a command on a saved SSH host",
      description:
        "Run one command on a saved host configured for Built-in SSH. The host must already pass its SSH host-key and credential checks. Commands are bounded to 60 seconds and output is truncated at the built-in limit.",
      inputSchema: {
        hostId: z.string().trim().min(1).max(200).describe("Saved host ID returned by list_ssh_hosts."),
        command: z.string().trim().min(1).max(8_000).describe("Command to execute on the remote host."),
        timeoutMs: z
          .number()
          .int()
          .min(1)
          .max(60_000)
          .optional()
          .describe("Optional timeout in milliseconds (maximum 60000)."),
      },
    },
    async (input, extra) => textResult(await handlers.runCommand(input, withDisconnect(extra.signal))),
  );

  const transport = new StdioServerTransport();
  let finishWait!: () => void;
  let rejectWait!: (error: Error) => void;
  const finished = new Promise<void>((resolve, reject) => {
    finishWait = resolve;
    rejectWait = reject;
  });
  const onDisconnect = () => {
    disconnected.abort();
    finishWait();
  };
  const onInputError = (error: Error) => {
    disconnected.abort();
    rejectWait(error);
  };
  process.stdin.once("end", onDisconnect);
  process.stdin.once("close", onDisconnect);
  process.stdin.once("error", onInputError);
  process.once("SIGTERM", onDisconnect);
  try {
    await server.connect(transport);
    await finished;
  } finally {
    onDisconnect();
    process.stdin.off("end", onDisconnect);
    process.stdin.off("close", onDisconnect);
    process.stdin.off("error", onInputError);
    process.off("SIGTERM", onDisconnect);
    await server.close().catch(() => {});
  }
}
