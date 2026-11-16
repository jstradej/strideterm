import http from "node:http";
import { Readable } from "node:stream";
import { SANDBOX_GATEWAY_HOST } from "./sandbox.js";

/**
 * `fetch` for the loopback broker clients (the MCP bridges and the hook script). Inside a sandbox the
 * brokers are reached as `SANDBOX_GATEWAY_HOST` THROUGH the sandbox's HTTP proxy, which Node's `fetch`
 * does not use on its own. This sends such a request to the proxy in absolute form; every other
 * request is plain `fetch`, so outside a sandbox nothing changes.
 */

function proxyFromEnv(env: NodeJS.ProcessEnv): URL | null {
  const raw = env.HTTP_PROXY || env.http_proxy || "";
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "http:" ? parsed : null;
  } catch {
    return null;
  }
}

function headerRecord(headers: RequestInit["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  new Headers(headers).forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

export async function viaSandboxProxy(proxy: URL, target: URL, init: RequestInit = {}): Promise<Response> {
  const headers = headerRecord(init.headers);
  headers.host = target.host;
  if (proxy.username) {
    const user = decodeURIComponent(proxy.username);
    const pass = decodeURIComponent(proxy.password);
    headers["proxy-authorization"] = `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
  }
  const body = typeof init.body === "string" ? init.body : init.body instanceof Uint8Array ? init.body : undefined;
  if (body !== undefined) headers["content-length"] = String(Buffer.byteLength(body));
  return new Promise<Response>((resolve, reject) => {
    const request = http.request(
      {
        host: proxy.hostname,
        port: Number(proxy.port) || 80,
        method: init.method || "GET",
        path: target.href,
        headers,
        signal: init.signal ?? undefined,
      },
      (response) => {
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(response.headers)) {
          if (Array.isArray(value)) value.forEach((item) => responseHeaders.append(key, item));
          else if (typeof value === "string") responseHeaders.set(key, value);
        }
        const status = response.statusCode || 502;
        resolve(
          new Response(
            NULL_BODY_STATUSES.has(status) ? null : (Readable.toWeb(response) as unknown as ReadableStream<Uint8Array>),
            { status, headers: responseHeaders },
          ),
        );
      },
    );
    // Callers retry on a TypeError, the error `fetch` raises for a connection that could not be made.
    request.on("error", (error) => {
      if ((error as { name?: string }).name === "AbortError") reject(error);
      else reject(new TypeError(`The sandbox proxy could not be reached: ${error.message}`));
    });
    if (body !== undefined) request.write(body);
    request.end();
  });
}

export const sandboxAwareFetch: typeof fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return fetch(input, init);
  }
  if (target.hostname !== SANDBOX_GATEWAY_HOST) return fetch(input, init);
  const proxy = proxyFromEnv(process.env);
  if (!proxy) throw new TypeError("The sandbox proxy is not available to this tool (HTTP_PROXY is not set).");
  return viaSandboxProxy(proxy, target, init);
};
