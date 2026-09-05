// The signed control-plane bootstrap envelope — THIS REPO'S COPY of the canonical rules.
//
// HAND-MIRRORED from strideterm-mobile's protocol/typescript/src/bootstrap/control-plane-bootstrap.ts
// for the same reason mobile-schemas.ts is (plan §3.2: this checkout cannot import that one across
// two repositories, and no registry package exists yet). What stops the copy drifting is
// `mobile-bootstrap-vectors.json` — the canonical fixture, copied in and compared by
// `npm run check:mobile-schema-drift`, and executed by this module's own tests.
//
// WHY THIS DOCUMENT EXISTS AT ALL. Today's endpoints come from the environment and a project id this
// build was configured with, so recovering into a fresh Firebase project would need a new desktop
// release. That is not a recovery time, it is a release schedule. A signed envelope is what makes a
// clean-project restore reachable by the builds people already have installed.

/**
 * Canonical JSON: keys in ASCII order, no insignificant whitespace, `undefined` values omitted.
 *
 * Inlined rather than imported because this repo has no other canonical-JSON producer — the relay
 * grants it handles are verified, not built. Byte-identical to the canonical implementation's, and
 * the shared vectors are what prove it: a signature over a differently-ordered document is one the
 * other two runtimes cannot reproduce.
 */
export function canonicalJsonStringify(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON cannot carry a non-finite number");
    return JSON.stringify(value);
  }
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJsonStringify(entry)).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(record).sort()) {
      const entry = record[key];
      if (entry === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${canonicalJsonStringify(entry)}`);
    }
    return `{${parts.join(",")}}`;
  }
  throw new Error("canonical JSON cannot carry this value");
}

/**
 * The four environments, and nothing else — `local | dev | qa | prod`. `local` is one machine
 * (emulators, local Workers); `dev` a personal test against real servers; `qa` the shared
 * pre-production tier; `prod` production. The retired `staging`/`production` spellings are not
 * accepted aliases — a value outside this set is malformed.
 */
export type BootstrapEnvironment = "local" | "dev" | "qa" | "prod";

export interface ControlPlaneBootstrapPayload {
  readonly schemaVersion: number;
  readonly environment: BootstrapEnvironment;
  readonly configEpoch: number;
  readonly issuedAt: number;
  readonly notBefore?: number;
  readonly projectId: string;
  readonly apiKey: string;
  readonly appId: string;
  readonly messagingSenderId: string;
  readonly databaseUrl: string;
  readonly functionsBaseUrl: string;
  readonly relayOrigin?: string;
  readonly appCheckAndroidAppId?: string;
  readonly appCheckWebAppId?: string;
  /**
   * The EXACT hostnames a checkout or portal URL may point at. Lower-cased, no scheme, no port.
   *
   * Here because THIS runtime's external opener needs an allowlist and this is the only
   * environment-scoped, signed thing it can get one from. It used to hand any `https:` (indeed any
   * `http:`) URL from a callable response straight to `shell.openExternal`.
   */
  readonly billingCheckoutHosts?: readonly string[];
}

export interface ControlPlaneBootstrapEnvelope {
  readonly v: 1;
  readonly keyId: string;
  readonly payload: ControlPlaneBootstrapPayload;
  readonly signature: string;
}

/** The schema version a client of this generation understands. An unknown one is refused, not ignored. */
export const BOOTSTRAP_SCHEMA_VERSION = 2;

/**
 * The domain separator. Prefixed to the canonical payload before signing.
 *
 * Without it, a signature over some other canonical JSON document this project signs elsewhere could
 * be presented here — the whole reason every signed thing in this codebase carries one.
 */
export const BOOTSTRAP_SIGNING_DOMAIN = "strideterm-control-plane-bootstrap-v1";

export type BootstrapRefusal =
  | "unsupported-version"
  | "unknown-key"
  | "bad-signature"
  | "wrong-environment"
  | "epoch-not-newer"
  | "not-yet-valid"
  | "insecure-endpoint"
  | "malformed";

export interface BootstrapVerdict {
  readonly accepted: boolean;
  readonly refusal?: BootstrapRefusal;
}

/** The exact bytes that are signed. Canonical, so all three runtimes sign and verify the same input. */
export function bootstrapSigningInput(payload: ControlPlaneBootstrapPayload): Uint8Array {
  return new TextEncoder().encode(`${BOOTSTRAP_SIGNING_DOMAIN}\n${canonicalJsonStringify(payload)}`);
}

/**
 * Whether an endpoint is one a build outside `local` may be pointed at.
 *
 * Exported because the Dart and ops implementations must apply the identical rule, and because the
 * list of what counts as "private" is exactly the kind of thing that drifts when it is written three
 * times.
 */
export function isSecureBootstrapEndpoint(value: string): boolean {
  if (!value.startsWith("https://")) return false;
  const host = bootstrapEndpointHost(value);
  if (host === null || host.length === 0) return false;
  if (host === "localhost") return false;
  // IPv6 arrives BRACKETED in a URL, so splitting on ':' finds '[' and nothing else — which is how
  // `https://[::1]:9000` slipped past a loopback check that looked correct. The brackets are stripped
  // and the address compared as an address.
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") return false;
  if (host.startsWith("fe80:")) return false;
  // IPv4-mapped IPv6: another spelling of the same loopback.
  if (host.startsWith("::ffff:")) return isSecureBootstrapEndpoint(`https://${host.slice("::ffff:".length)}`);
  if (/^127\./.test(host)) return false;
  // RFC1918 and link-local. A production client that can be pointed at a private address is a
  // production client that can be pointed at whatever is on the operator's laptop.
  if (/^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
  return true;
}

/**
 * The host of an `https://` endpoint, lower-cased and with IPv6 brackets removed.
 *
 * Exported so the Dart and ops implementations can be held to the same parse: the bracketed-IPv6
 * case is exactly the one a hand-written `split(':')[0]` gets wrong, in every language.
 */
export function bootstrapEndpointHost(value: string): string | null {
  if (!value.startsWith("https://")) return null;
  const authority = value.slice("https://".length).split("/")[0] ?? "";
  const at = authority.lastIndexOf("@");
  const hostPort = at >= 0 ? authority.slice(at + 1) : authority;
  if (hostPort.startsWith("[")) {
    const close = hostPort.indexOf("]");
    if (close < 0) return null;
    return hostPort.slice(1, close).toLowerCase();
  }
  return (hostPort.split(":")[0] ?? "").toLowerCase();
}

/** Verifies the Ed25519 signature. Injected, because Node, the browser and Dart each have their own. */
export type BootstrapSignatureVerifier = (args: {
  readonly message: Uint8Array;
  readonly signature: Uint8Array;
  readonly publicKey: Uint8Array;
}) => boolean;

/**
 * Decides whether this client accepts the envelope.
 *
 * PURE, and the signature check is injected: this module is imported by an Electron main process, a
 * browser-side test and a Node script, and each has a different Ed25519 primitive. What must not
 * differ is the ORDER and the SET of checks, which is what lives here.
 */
export function verifyControlPlaneBootstrap(args: {
  readonly envelope: unknown;
  /** keyId -> raw 32-byte Ed25519 public key. Compiled into a build; nothing at runtime may add to it. */
  readonly trustKeys: ReadonlyMap<string, Uint8Array>;
  readonly expectedEnvironment: BootstrapEnvironment;
  /** The highest epoch this client has ever accepted. `0` for a client that has accepted none. */
  readonly highestSeenEpoch: number;
  readonly now: number;
  readonly verifySignature: BootstrapSignatureVerifier;
}): BootstrapVerdict {
  const { envelope, trustKeys, expectedEnvironment, highestSeenEpoch, now } = args;
  if (typeof envelope !== "object" || envelope === null) return { accepted: false, refusal: "malformed" };
  const candidate = envelope as ControlPlaneBootstrapEnvelope;
  if (candidate.v !== 1) return { accepted: false, refusal: "malformed" };
  if (typeof candidate.keyId !== "string" || candidate.keyId.length === 0) {
    return { accepted: false, refusal: "malformed" };
  }
  if (typeof candidate.signature !== "string" || candidate.signature.length === 0) {
    return { accepted: false, refusal: "malformed" };
  }
  const payload = candidate.payload;
  if (typeof payload !== "object" || payload === null) return { accepted: false, refusal: "malformed" };
  // The version gate comes before the shape check on purpose: a version this build does not know may
  // legitimately have fields it cannot validate, and "refuse" is the right answer to both.
  if (payload.schemaVersion !== BOOTSTRAP_SCHEMA_VERSION) {
    return { accepted: false, refusal: "unsupported-version" };
  }
  if (!payloadIsWellFormed(payload)) return { accepted: false, refusal: "malformed" };

  const key = trustKeys.get(candidate.keyId);
  if (!key) return { accepted: false, refusal: "unknown-key" };

  // A throwing primitive is a refusal, not a crash: a malformed base64 signature reaches this and
  // must be answered, not propagated into a launch path.
  let signatureOk: boolean;
  try {
    signatureOk = args.verifySignature({
      message: bootstrapSigningInput(payload),
      signature: base64ToBytes(candidate.signature),
      publicKey: key,
    });
  } catch {
    signatureOk = false;
  }
  // NOTHING BELOW THIS LINE READS A VALUE THE SIGNATURE HAS NOT COVERED.
  if (!signatureOk) return { accepted: false, refusal: "bad-signature" };

  if (payload.environment !== expectedEnvironment) return { accepted: false, refusal: "wrong-environment" };
  if (payload.configEpoch <= highestSeenEpoch) return { accepted: false, refusal: "epoch-not-newer" };
  if (payload.notBefore !== undefined && payload.notBefore > now) {
    return { accepted: false, refusal: "not-yet-valid" };
  }
  // Only `local` may name a loopback, private-range or plain-HTTP endpoint: that is the one
  // environment whose servers ARE this machine. `dev`, `qa` and `prod` are all real tiers.
  if (expectedEnvironment !== "local") {
    for (const endpoint of [
      payload.databaseUrl,
      payload.functionsBaseUrl,
      ...(payload.relayOrigin === undefined ? [] : [payload.relayOrigin]),
    ]) {
      if (!isSecureBootstrapEndpoint(endpoint)) return { accepted: false, refusal: "insecure-endpoint" };
    }
  }
  return { accepted: true };
}

function payloadIsWellFormed(payload: ControlPlaneBootstrapPayload): boolean {
  const strings: (keyof ControlPlaneBootstrapPayload)[] = [
    "projectId",
    "apiKey",
    "appId",
    "messagingSenderId",
    "databaseUrl",
    "functionsBaseUrl",
  ];
  for (const field of strings) {
    const value = payload[field];
    if (typeof value !== "string" || value.length === 0) return false;
  }
  if (
    payload.environment !== "local" &&
    payload.environment !== "dev" &&
    payload.environment !== "qa" &&
    payload.environment !== "prod"
  ) {
    return false;
  }
  if (!Number.isInteger(payload.configEpoch) || payload.configEpoch < 1) return false;
  if (!Number.isInteger(payload.issuedAt) || payload.issuedAt < 0) return false;
  if (payload.notBefore !== undefined && (!Number.isInteger(payload.notBefore) || payload.notBefore < 0)) {
    return false;
  }
  for (const optional of ["relayOrigin", "appCheckAndroidAppId", "appCheckWebAppId"] as const) {
    const value = payload[optional];
    if (value !== undefined && typeof value !== "string") return false;
  }
  const hosts = payload.billingCheckoutHosts;
  if (hosts !== undefined) {
    if (!Array.isArray(hosts) || hosts.length > 8) return false;
    for (const host of hosts) {
      // A HOSTNAME, not a URL and not a pattern. A caller that could put `*.example.com` or
      // `https://x/` here would be writing a matcher, and every matcher this project has needed has
      // eventually matched something it should not.
      if (typeof host !== "string" || host.length === 0 || host.length > 253) return false;
      if (host !== host.toLowerCase()) return false;
      if (/[^a-z0-9.-]/.test(host)) return false;
    }
  }
  return true;
}

/**
 * Whether a billing URL is one a CLIENT may hand to the operating system.
 *
 * HTTPS and an exact host from the signed allowlist. Mirrored from the canonical rule so this and the
 * ops verifier apply the identical one, and asserted against the shared vectors.
 *
 * An EMPTY allowlist refuses everything. That is deliberate and is the opposite of the old behaviour:
 * a build that has not been told which merchant it uses must open nothing, not anything.
 */
export function isAllowedBillingHost(url: string, allowlist: readonly string[]): boolean {
  if (allowlist.length === 0) return false;
  if (!url.startsWith("https://")) return false;
  const host = bootstrapEndpointHost(url);
  if (host === null || host.length === 0) return false;
  return allowlist.some((entry) => entry.toLowerCase() === host);
}

function base64ToBytes(value: string): Uint8Array {
  // `Buffer` is not available in a browser bundle and `atob` is not in older Node typings; both
  // exist where this actually runs, so pick whichever is present rather than importing either.
  const globalBuffer = (globalThis as { Buffer?: { from(input: string, encoding: string): Uint8Array } }).Buffer;
  if (globalBuffer) return globalBuffer.from(value, "base64");
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * Which of two envelopes a client should keep.
 *
 * The LAST-KNOWN-GOOD rule: an envelope is only replaced by one that verified AND carries a higher
 * epoch. A fetch that fails, times out or returns something refused changes nothing — the bootstrap
 * being unreachable must never take down a control plane that is working.
 */
export function chooseBootstrap<T extends { readonly payload: ControlPlaneBootstrapPayload }>(
  current: T | null,
  candidate: T | null,
): T | null {
  if (candidate === null) return current;
  if (current === null) return candidate;
  return candidate.payload.configEpoch > current.payload.configEpoch ? candidate : current;
}
