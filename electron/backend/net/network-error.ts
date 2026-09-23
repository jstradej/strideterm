/**
 * Classifies a transport failure from Node's fetch (undici), `ws` or `https` into a fixed kind.
 * Returns only the enum — never the error's text — so a caller can put it in the UI without
 * leaking free text from a foreign source (same rule as `mobileErrorCode`).
 */
export type NetworkFailureKind =
  | "tls-untrusted" // chain doesn't lead to a trusted root → TLS inspection / proxy
  | "tls-other" // expired, hostname mismatch, …
  | "dns" // ENOTFOUND, EAI_AGAIN
  | "refused" // ECONNREFUSED
  | "timeout" // ETIMEDOUT, UND_ERR_CONNECT_TIMEOUT, AbortError from our timeouts
  | "reset" // ECONNRESET, EPIPE, UND_ERR_SOCKET
  | null;

export const NETWORK_FAILURE_KINDS = ["tls-untrusted", "tls-other", "dns", "refused", "timeout", "reset"] as const;

const MAX_CAUSE_DEPTH = 4;

const TLS_UNTRUSTED = new Set([
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_GET_ISSUER_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "CERT_UNTRUSTED",
]);
const TLS_OTHER = new Set(["CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID", "CERT_NOT_YET_VALID"]);
const DNS = new Set(["ENOTFOUND", "EAI_AGAIN"]);
const REFUSED = new Set(["ECONNREFUSED"]);
const TIMEOUT = new Set(["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT"]);
const RESET = new Set(["ECONNRESET", "EPIPE", "UND_ERR_SOCKET"]);

function kindForCode(code: string): NetworkFailureKind {
  if (TLS_UNTRUSTED.has(code)) return "tls-untrusted";
  if (TLS_OTHER.has(code) || code.startsWith("ERR_TLS_") || code.startsWith("ERR_SSL_")) return "tls-other";
  if (DNS.has(code)) return "dns";
  if (REFUSED.has(code)) return "refused";
  if (TIMEOUT.has(code)) return "timeout";
  if (RESET.has(code)) return "reset";
  return null;
}

export function classifyNetworkError(err: unknown): NetworkFailureKind {
  let current: unknown = err;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth++) {
    if (!current || typeof current !== "object") return null;
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") {
      const kind = kindForCode(code);
      if (kind) return kind;
    }
    if (
      (current as { name?: unknown }).name === "AbortError" ||
      (current as { name?: unknown }).name === "TimeoutError"
    ) {
      return "timeout";
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}
