/**
 * Human text for the fixed network-failure codes the backend reports (`network:<kind>` from
 * `electron/backend/net/network-error.ts`, surfaced by `mobileErrorCode()` and the relay manager).
 *
 * Returns null for anything else, so a caller keeps showing an unknown code exactly as before.
 * The texts deliberately name no OS and no product.
 */
export const NETWORK_TLS_UNTRUSTED_COPY =
  "Your network is intercepting encrypted connections (security software or a corporate proxy), and its certificate isn't trusted by this computer. Ask your IT to exclude strIDEterm from TLS inspection, or to install their root certificate in the system certificate store.";

const OFFLINE_COPY = "No internet connection or the server is blocked by a firewall.";

const NETWORK_ERROR_COPY: Record<string, string> = {
  "network:tls-untrusted": NETWORK_TLS_UNTRUSTED_COPY,
  "network:tls-other": "Secure connection failed (certificate problem). Check the system clock.",
  "network:dns": OFFLINE_COPY,
  "network:refused": OFFLINE_COPY,
  "network:timeout": OFFLINE_COPY,
  "network:reset": OFFLINE_COPY,
};

export function describeNetworkErrorCode(code: string | null | undefined): string | null {
  return code ? (NETWORK_ERROR_COPY[code] ?? null) : null;
}
