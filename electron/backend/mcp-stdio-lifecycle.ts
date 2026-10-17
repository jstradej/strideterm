/// <reference types="node" />
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

/**
 * Serve `server` on this process's stdio until the host closes its end, then abort whatever is
 * still running (`disconnected`) and shut down. Shared by every stdio MCP entry.
 */
export async function serveOverStdio(server: McpServer, disconnected: AbortController): Promise<void> {
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
