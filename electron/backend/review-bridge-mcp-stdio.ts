/// <reference types="node" />
import { parseReviewBridgeMcpArgs, runReviewBridgeMcpServer } from "./review-bridge-mcp.js";

const mcpMode = parseReviewBridgeMcpArgs(process.argv.slice(2));

if (!mcpMode) {
  process.stderr.write("Missing --review-bridge-mcp for review bridge MCP stdio mode.\n");
  process.exit(1);
}

runReviewBridgeMcpServer(mcpMode)
  .then(() => process.exit(0))
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
