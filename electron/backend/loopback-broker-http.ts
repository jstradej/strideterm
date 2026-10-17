import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** The HTTP plumbing the loopback MCP brokers share: JSON in, JSON out, bearer capability, one 127.0.0.1 server. */

export function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(payload));
}

export function readJsonBody(
  request: IncomingMessage,
  controller: AbortController,
  { maxBytes, timeoutMs }: { maxBytes: number; timeoutMs: number },
): Promise<unknown> {
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
    }, timeoutMs);
    timeout.unref?.();
    request.on("data", (chunk: Buffer | string) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += value.length;
      if (size > maxBytes) {
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

export function bearerCapability(request: IncomingMessage): string {
  const header = request.headers.authorization || "";
  const match = /^Bearer ([A-Za-z0-9_-]{40,100})$/u.exec(header);
  return match?.[1] || "";
}

export async function listenOnLoopback(
  route: string,
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  { bodyTimeoutMs }: { bodyTimeoutMs: number },
): Promise<{ server: http.Server; url: string }> {
  const created = http.createServer(handler);
  created.on("clientError", (_error, socket) => socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"));
  created.headersTimeout = 10_000;
  created.requestTimeout = bodyTimeoutMs;
  await new Promise<void>((resolve, reject) => {
    created.once("error", reject);
    created.listen(0, "127.0.0.1", () => {
      created.off("error", reject);
      resolve();
    });
  });
  const address = created.address() as AddressInfo;
  return { server: created, url: `http://127.0.0.1:${address.port}${route}` };
}
