/// <reference types="node" />
import { runSshMcpStdioServer } from "./ssh-mcp-stdio.js";

if (!process.argv.slice(2).includes("--ssh-mcp")) {
  process.stderr.write("Missing --ssh-mcp for SSH MCP stdio mode.\n");
  process.exit(1);
}

runSshMcpStdioServer()
  .then(() => {})
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
