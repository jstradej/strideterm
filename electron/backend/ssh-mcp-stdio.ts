/// <reference types="node" />
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { SSH_MCP_CAPABILITY_ENV, SSH_MCP_URL_ENV } from "../shared/agent-ssh.js";
import { serveOverStdio } from "./mcp-stdio-lifecycle.js";

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
    async listFiles(input: { hostId: string; path?: string }, signal?: AbortSignal): Promise<unknown> {
      return send({ operation: "list-files", ...input }, signal);
    },
    async upload(
      input: { hostId: string; localPath: string; remoteDir: string; overwrite?: boolean },
      signal?: AbortSignal,
    ): Promise<unknown> {
      return send({ operation: "upload", ...input }, signal);
    },
    async download(
      input: { hostId: string; remotePath: string; localDir: string; overwrite?: boolean },
      signal?: AbortSignal,
    ): Promise<unknown> {
      return send({ operation: "download", ...input }, signal);
    },
    async transferStatus(input: { transferId: string }, signal?: AbortSignal): Promise<unknown> {
      return send({ operation: "transfer-status", ...input }, signal);
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
  const hostId = z.string().trim().min(1).max(200).describe("Saved host ID returned by list_ssh_hosts.");
  server.registerTool(
    "list_ssh_files",
    {
      title: "List a directory on a saved SSH host",
      description:
        "List a directory on a saved Built-in SSH host over SFTP (names, types, sizes, modification times, modes). `path` is an absolute POSIX path on the host such as /var/log; omit it for the home directory. At most 5000 entries are returned and `truncated` says when more exist. Symbolic links are reported, not followed.",
      inputSchema: {
        hostId,
        path: z.string().min(1).max(4096).optional().describe("Absolute directory path on the host."),
      },
    },
    async (input, extra) => textResult(await handlers.listFiles(input, withDisconnect(extra.signal))),
  );
  server.registerTool(
    "upload_to_ssh_host",
    {
      title: "Upload a file or folder to a saved SSH host",
      description:
        "Upload a file or folder from this workspace to a saved Built-in SSH host. `localPath` is relative to the workspace folder or an absolute path inside this workspace's folders; `remoteDir` is an existing absolute directory on the host, and the item keeps its name there. Symbolic links are skipped. Existing remote files are not replaced unless `overwrite` is true; a clash is an error listing the paths. Returns a transferId at once: check it with ssh_transfer_status. At most 2 transfers run at once and one transfer is limited to 5 GiB.",
      inputSchema: {
        hostId,
        localPath: z.string().min(1).max(4096).describe("File or folder in this workspace (relative or absolute)."),
        remoteDir: z.string().min(1).max(4096).describe("Existing absolute directory on the host."),
        overwrite: z.boolean().optional().describe("Replace files that already exist (default false)."),
      },
    },
    async (input, extra) => textResult(await handlers.upload(input, withDisconnect(extra.signal))),
  );
  server.registerTool(
    "download_from_ssh_host",
    {
      title: "Download a file or folder from a saved SSH host",
      description:
        "Download a file or folder from a saved Built-in SSH host into this workspace. `remotePath` is an absolute path on the host; `localDir` is an existing directory relative to the workspace folder or absolute inside this workspace's folders. Nothing is ever written into a .git directory. Symbolic links are skipped. Existing local files are not replaced unless `overwrite` is true; a clash is an error listing the paths. Returns a transferId at once: check it with ssh_transfer_status. At most 2 transfers run at once and one transfer is limited to 5 GiB.",
      inputSchema: {
        hostId,
        remotePath: z.string().min(1).max(4096).describe("Absolute path of the file or folder on the host."),
        localDir: z.string().min(1).max(4096).describe("Existing directory in this workspace (relative or absolute)."),
        overwrite: z.boolean().optional().describe("Replace files that already exist (default false)."),
      },
    },
    async (input, extra) => textResult(await handlers.download(input, withDisconnect(extra.signal))),
  );
  server.registerTool(
    "ssh_transfer_status",
    {
      title: "Check a file transfer",
      description:
        "State (running, succeeded, failed, cancelled), progress and the final result of a transfer started by upload_to_ssh_host or download_from_ssh_host from this tab. A finished transfer stays known for 24 hours.",
      inputSchema: { transferId: z.string().min(1).max(100).describe("The id returned when the transfer started.") },
    },
    async (input, extra) => textResult(await handlers.transferStatus(input, withDisconnect(extra.signal))),
  );

  await serveOverStdio(server, disconnected);
}
