/// <reference types="node" />

/**
 * Shared ETag-caching JSON HTTP client, factored out of azure-devops-api.ts
 * and github-api.ts. Both providers implemented an (almost) identical
 * ~110-line requestJson: the same ETag cache with the same max-size LRU
 * eviction, the same 304-replay logic (including the fix that re-issues a
 * request once, without If-None-Match, when a 304 arrives for a cache entry
 * that was evicted mid-flight), the same error-text parsing, and the same
 * audit-logging scaffolding.
 *
 * They differ only in:
 *   - how request headers are built (Basic vs Bearer auth, Accept header,
 *     provider-specific headers like GitHub's X-GitHub-Api-Version)
 *   - the error-message prefix/shape (Azure DevOps vs GitHub error bodies)
 *   - whether a 204 response means "no content" (GitHub) or never happens
 *     (Azure)
 *
 * Azure's requestText (build logs are plain text, not JSON) shares the same
 * HTTP-call + audit-logging scaffolding as requestJson, differing only in
 * how the response body is parsed and in having no ETag cache.
 */

export interface EtagJsonAuditEntry {
  method: string;
  url: string;
  statusCode: number;
  success: boolean;
  durationMs: number;
  errorMessage?: string;
}

export type EtagJsonAuditLogger = (entry: EtagJsonAuditEntry) => void;

interface EtagCacheEntry {
  etag: string;
  data: unknown;
}

/** Shape every provider's request-options type must satisfy. */
export interface EtagJsonRequestOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface EtagJsonClientConfig<TOptions extends EtagJsonRequestOptions> {
  /** Full header set for a JSON request: auth + Accept/Content-Type + any extra headers from options.headers. */
  buildJsonHeaders(options: TOptions): Record<string, string>;
  /** Full header set for a plain-text request. Only required if the provider uses requestText. */
  buildTextHeaders?(options: TOptions): Record<string, string>;
  /** Prefix used in thrown error messages: "${errorPrefix} request failed (${status}): ${message}". */
  errorPrefix: string;
  /** Pull a message out of a parsed JSON error body; return `fallback` if nothing usable is found. */
  extractErrorMessage(parsedBody: unknown, fallback: string): string;
  /** GitHub returns 204 No Content for some endpoints; Azure never does. */
  treatNoContentAsNull?: boolean;
  auditLogger?: EtagJsonAuditLogger;
  maxCacheSize?: number;
}

export function createEtagJsonClient<TOptions extends EtagJsonRequestOptions>(
  fetchImpl: typeof globalThis.fetch,
  config: EtagJsonClientConfig<TOptions>,
) {
  const {
    buildJsonHeaders,
    buildTextHeaders,
    errorPrefix,
    extractErrorMessage,
    treatNoContentAsNull = false,
    auditLogger,
    maxCacheSize = 200,
  } = config;

  const etagCache = new Map<string, EtagCacheEntry>();

  function logAudit(entry: EtagJsonAuditEntry): void {
    if (!auditLogger) return;
    try {
      auditLogger(entry);
    } catch {}
  }

  async function parseErrorMessage(response: Response): Promise<string> {
    const text = await response.text().catch(() => "");
    let message = text || response.statusText;
    try {
      const parsed = JSON.parse(text);
      message = extractErrorMessage(parsed, message);
    } catch {}
    return message;
  }

  async function requestJson(
    url: string,
    options: TOptions = {} as TOptions,
    allowStaleRetry = true,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: mirrors github-api.ts's pre-refactor
    // Promise<any> — GitHub's higher-level methods read response properties (e.g. `result?.items`)
    // without a cast, so this can't be narrowed to `unknown` without touching every call site.
  ): Promise<any> {
    const startTime = Date.now();
    const method = options.method || "GET";
    let statusCode = 0;

    const requestHeaders = buildJsonHeaders(options);

    // Add ETag/If-None-Match for GET requests (only when cached data exists to fall back to)
    let cached: EtagCacheEntry | undefined;
    if (method === "GET") {
      cached = etagCache.get(url);
      if (cached?.etag && cached?.data) {
        requestHeaders["If-None-Match"] = cached.etag;
      }
    }

    try {
      const response = await fetchImpl(url, {
        method,
        headers: requestHeaders,
        body: options.body == null ? undefined : JSON.stringify(options.body),
      });

      statusCode = response.status;

      // Return cached response on 304 Not Modified
      if (response.status === 304 && method === "GET") {
        if (cached?.data) {
          logAudit({ method, url, statusCode: 304, success: true, durationMs: Date.now() - startTime });
          return cached.data;
        }

        // The cache entry was evicted (LRU eviction under concurrent requests)
        // between sending If-None-Match and this 304 arriving, so there's
        // nothing to return. Re-issue the same request once without
        // If-None-Match to force a full response with a real body.
        if (allowStaleRetry) {
          logAudit({ method, url, statusCode: 304, success: true, durationMs: Date.now() - startTime });
          return requestJson(url, options, false);
        }
      }

      if (!response.ok && response.status !== 304) {
        const message = await parseErrorMessage(response);
        throw new Error(`${errorPrefix} request failed (${response.status}): ${message}`);
      }

      // Some endpoints (GitHub) return 204 No Content
      if (treatNoContentAsNull && response.status === 204) {
        logAudit({ method, url, statusCode, success: true, durationMs: Date.now() - startTime });
        return null;
      }

      const data = await response.json();

      // Cache ETag for GET responses
      if (method === "GET") {
        const etag = typeof response.headers?.get === "function" ? response.headers.get("etag") : null;
        if (etag) {
          // Evict oldest entries if cache grows too large
          if (etagCache.size >= maxCacheSize) {
            const firstKey = etagCache.keys().next().value;
            etagCache.delete(firstKey!);
          }
          etagCache.set(url, { etag, data });
        }
      }

      logAudit({ method, url, statusCode, success: true, durationMs: Date.now() - startTime });
      return data;
    } catch (err) {
      logAudit({
        method,
        url,
        statusCode,
        success: false,
        errorMessage: (err as Error).message,
        durationMs: Date.now() - startTime,
      });
      throw err;
    }
  }

  // Plain-text fetch (e.g. Azure build logs). Audited like requestJson, but no
  // ETag cache — logs are large and fetched on explicit user action.
  async function requestText(url: string, options: TOptions = {} as TOptions): Promise<string> {
    if (!buildTextHeaders) {
      throw new Error(`${errorPrefix}: requestText is not configured for this client (no buildTextHeaders supplied).`);
    }
    const startTime = Date.now();
    let statusCode = 0;
    const requestHeaders = buildTextHeaders(options);
    try {
      const response = await fetchImpl(url, { method: "GET", headers: requestHeaders });
      statusCode = response.status;
      if (!response.ok) {
        const message = await parseErrorMessage(response);
        throw new Error(`${errorPrefix} request failed (${response.status}): ${message}`);
      }
      const body = await response.text();
      logAudit({ method: "GET", url, statusCode, success: true, durationMs: Date.now() - startTime });
      return body;
    } catch (err) {
      logAudit({
        method: "GET",
        url,
        statusCode,
        success: false,
        errorMessage: (err as Error).message,
        durationMs: Date.now() - startTime,
      });
      throw err;
    }
  }

  return { requestJson, requestText };
}
