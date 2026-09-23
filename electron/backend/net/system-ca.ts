import tls from "node:tls";

export type CaCertificateType = "default" | "system" | "bundled" | "extra";

export interface SystemCaDeps {
  getCACertificates?: (type: CaCertificateType) => string[];
  setDefaultCACertificates?: (certs: string[]) => void;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

export type SystemCaResult =
  | { status: "applied"; defaultCount: number; systemCount: number; addedCount: number; durationMs: number }
  | { status: "disabled" } // STRIDETERM_DISABLE_SYSTEM_CA=1
  | { status: "unsupported" } // Node without the API
  | { status: "failed"; error: string; durationMs: number };

let applied: SystemCaResult | null = null;

/**
 * Makes Node's TLS clients (global fetch/undici, `ws`, https) trust the OS certificate store in
 * addition to Node's bundled Mozilla roots. Required behind corporate TLS inspection (ESET,
 * Defender, Zscaler, …), whose root CA lives only in the OS store.
 *
 * Security: this grants the same trust the browser and the Electron renderer already have on the
 * same machine. No CA of our own is added and verification is never disabled
 * (`rejectUnauthorized` stays untouched).
 *
 * Must run before the first outbound TLS connection: undici keeps pooled connections and
 * `setDefaultCACertificates` does not affect sockets that already exist.
 *
 * Never throws — a missing or unreadable system store must not stop startup; the process then
 * keeps the bundled roots, exactly as before.
 */
export function applySystemCaTrust(deps: SystemCaDeps = {}): SystemCaResult {
  if (applied) return applied;
  const env = deps.env ?? process.env;
  if (env.STRIDETERM_DISABLE_SYSTEM_CA === "1") {
    applied = { status: "disabled" };
    return applied;
  }
  const get =
    deps.getCACertificates ?? (tls as { getCACertificates?: SystemCaDeps["getCACertificates"] }).getCACertificates;
  const set =
    deps.setDefaultCACertificates ??
    (tls as { setDefaultCACertificates?: SystemCaDeps["setDefaultCACertificates"] }).setDefaultCACertificates;
  if (typeof get !== "function" || typeof set !== "function") {
    applied = { status: "unsupported" };
    return applied;
  }
  const now = deps.now ?? (() => performance.now());
  const startedAt = now();
  try {
    // "default", not "bundled": it also carries NODE_EXTRA_CA_CERTS, so that override keeps working.
    const defaults = get("default");
    const system = get("system");
    const merged = [...new Set([...defaults, ...system])];
    set(merged);
    applied = {
      status: "applied",
      defaultCount: defaults.length,
      systemCount: system.length,
      addedCount: merged.length - new Set(defaults).size,
      durationMs: Math.round(now() - startedAt),
    };
  } catch (err) {
    applied = {
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
      durationMs: Math.round(now() - startedAt),
    };
  }
  return applied;
}

export function __resetSystemCaForTests(): void {
  applied = null;
}
