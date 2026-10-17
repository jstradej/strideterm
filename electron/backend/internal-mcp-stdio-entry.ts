/// <reference types="node" />
import { runInternalMcpStdioServer } from "./internal-mcp/internal-mcp-stdio.js";

if (!process.argv.slice(2).includes("--internal-mcp")) {
  process.stderr.write("Missing --internal-mcp for internal MCP stdio mode.\n");
  process.exit(1);
}

runInternalMcpStdioServer()
  .then(() => {})
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
