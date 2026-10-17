import type { InternalMcpErrorCode } from "../../shared/internal-mcp.js";

export class InternalMcpError extends Error {
  constructor(
    readonly code: InternalMcpErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "InternalMcpError";
  }
}
