// Where this desktop learns which control plane to talk to, and how it keeps that answer.
//
// THE POINT OF THE WHOLE THING. Without it, the endpoints come from the environment this build was
// configured with, so recovering into a fresh Firebase project would mean shipping a new desktop
// release before anybody could reach it. That is a release schedule, not a recovery time. With it, an
// already-installed build follows a signed document to the new project.
//
// FOUR RULES, and every one of them is about not making things worse:
//
//   1. THE BOOTSTRAP BEING UNREACHABLE CHANGES NOTHING. A failed fetch, a timeout, a refusal — all
//      leave the last-known-good envelope in place and the control plane working. A recovery
//      mechanism that could take down a healthy install would be a liability, not a safety net.
//   2. LAST-KNOWN-GOOD IS REPLACED ONLY BY A STRICTLY HIGHER EPOCH, and the highest epoch ever
//      accepted is remembered separately from the envelope itself. Deleting the stored envelope must
//      not re-open the door to a rollback: the epoch floor is what makes the monotonic rule
//      persistent rather than merely current.
//   3. THE TRUST SET IS THE BUILD'S. `bootstrap-trust.ts` is a build constant. An environment
//      variable may only add keys where the environment is not production, and that is asserted —
//      otherwise "compiled-in trust set" would be a comment rather than a property.
//   4. THE WRITE IS ATOMIC. Written to a temporary file and renamed, so a crash mid-write leaves the
//      previous envelope rather than a truncated one that fails to parse on the next start.

import { verify as verifyEd25519, createPublicKey } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  canonicalJsonStringify,
  verifyControlPlaneBootstrap,
  type BootstrapEnvironment,
  type BootstrapRefusal,
  type ControlPlaneBootstrapEnvelope,
} from "./control-plane-bootstrap.js";
import { bootstrapTrustSet, type BootstrapTrust } from "./bootstrap-trust.js";
import { resolveMobileFirebaseConfig, type MobileFirebaseConfig } from "./mobile-firebase-config.js";

/** What is persisted beside the envelope. The floor is the half that must survive losing the rest. */
interface StoredBootstrap {
  readonly envelope: ControlPlaneBootstrapEnvelope;
  /** The highest epoch this installation has ever accepted. Never decreases. */
  readonly highestSeenEpoch: number;
  readonly acceptedAt: number;
  /**
   * The epoch whose TRANSITION this installation has actually carried out.
   *
   * ACCEPTED AND APPLIED ARE TWO DIFFERENT FACTS (F14), and storing only the first was the bug.
   * Adopting an envelope moves the endpoints; it does not by itself invalidate the credentials, the
   * uid or the pairings that belonged to the OLD project, and those are meaningless in the new one.
   * The transition must survive an interrupted startup, and a "we already raised the floor" marker is not the same
   * thing as "we have done the work". A crash between accepting and applying used to leave a floor
   * that refused to re-offer the same epoch and a transition nothing would ever run.
   */
  readonly appliedEpoch?: number;
  /** The project the applied configuration pointed at. What decides whether an identity survives. */
  readonly appliedProjectId?: string;
}

/** A transition this installation has accepted and not yet carried out. */
export interface PendingEpochTransition {
  readonly fromEpoch: number;
  readonly toEpoch: number;
  readonly fromProjectId: string;
  readonly toProjectId: string;
  /**
   * Whether the identity material of the old project has to go.
   *
   * TRUE ONLY WHEN THE PROJECT CHANGES. A new epoch that keeps the same project is an endpoint or a
   * key rotation, and signing the user out for one would be a self-inflicted outage; a new PROJECT
   * means this installation's uid, its refresh token, its account binding and its pairings all name
   * something that does not exist there.
   */
  readonly identityInvalidated: boolean;
}

export interface BootstrapFetchResult {
  /** The envelope now in force, or null when this installation has never accepted one. */
  readonly envelope: ControlPlaneBootstrapEnvelope | null;
  /** True only when THIS call replaced what was there. */
  readonly changed: boolean;
  /** Why a fetched envelope was not adopted. Absent when nothing was fetched or it was accepted. */
  readonly refusal?: BootstrapRefusal | "network" | "not-configured";
  /** Safe details for a user initiated fetch. Never contains response text or an Error object. */
  readonly error?: BootstrapError;
}

export type BootstrapErrorStage = "fetch" | "verify" | "persist";
export type BootstrapErrorCategory =
  | "dns"
  | "timeout"
  | "connection-refused"
  | "connection-reset"
  | "tls"
  | "http"
  | "redirect"
  | "invalid-response"
  | "verification"
  | "not-configured"
  | "storage"
  | "network"
  | "cancelled";

/** Renderer-safe bootstrap diagnostics. All strings are fixed or bounded and sanitized. */
export interface BootstrapError {
  readonly stage: BootstrapErrorStage;
  readonly category: BootstrapErrorCategory;
  readonly code?: string;
  readonly status?: number;
  readonly url?: string;
  readonly retryAfterMs?: number;
  readonly refusal?: BootstrapRefusal | "not-configured";
  readonly message: string;
}

export interface BootstrapClientDeps {
  /** Directory the envelope is kept in — the installation's data directory. */
  readonly stateDir: string;
  readonly environment: BootstrapEnvironment;
  /** Absent in a build with no bootstrap configured; the client then only ever reports what it has. */
  readonly url?: string | undefined;
  readonly trust?: BootstrapTrust;
  readonly fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  readonly now?: () => number;
  /** How long a fetch may take. A bootstrap that hangs must not delay startup. */
  readonly timeoutMs?: number;
  /** Optional caller cancellation, distinct from the client's own timeout. */
  readonly signal?: AbortSignal;
}

const STATE_FILE = "control-plane-bootstrap.json";
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_BOOTSTRAP_BYTES = 64 * 1024;

function safeNodeCode(error: unknown): string | undefined {
  const value =
    (error as { cause?: { code?: unknown }; code?: unknown } | null)?.cause?.code ??
    (error as { code?: unknown } | null)?.code;
  return typeof value === "string" && /^[A-Z0-9_]{2,32}$/.test(value) ? value : undefined;
}

function errorForNetwork(error: unknown, timedOut: boolean, url: string, timeoutMs: number): BootstrapError {
  const code = safeNodeCode(error);
  const name = (error as { name?: unknown } | null)?.name;
  if (name === "AbortError" && !timedOut) {
    return { stage: "fetch", category: "cancelled", url, message: "Download cancelled." };
  }
  if (timedOut)
    return {
      stage: "fetch",
      category: "timeout",
      url,
      message: `The server did not respond within ${Math.ceil(timeoutMs / 1000)} seconds.`,
    };
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "ENODATA")
    return { stage: "fetch", category: "dns", code, url, message: "The server address could not be resolved." };
  if (code === "ECONNREFUSED")
    return { stage: "fetch", category: "connection-refused", code, url, message: "The server refused the connection." };
  if (code === "ECONNRESET" || code === "EPIPE")
    return { stage: "fetch", category: "connection-reset", code, url, message: "The connection was interrupted." };
  if (code?.startsWith("ERR_TLS") || code?.includes("CERT") || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE")
    return { stage: "fetch", category: "tls", code, url, message: "The secure connection could not be verified." };
  return {
    stage: "fetch",
    category: "network",
    ...(code ? { code } : {}),
    url,
    message: "The network connection failed.",
  };
}

function retryAfterMs(value: string | null, now: number): number | undefined {
  if (!value) return undefined;
  let delay: number;
  const trimmed = value.trim();
  const deltaSeconds =
    trimmed.length <= 16 &&
    trimmed.length > 0 &&
    [...trimmed].every((character) => (character >= "0" && character <= "9") || character === ".") &&
    trimmed.split(".").length <= 2 &&
    trimmed.replace(".", "").length > 0;
  if (deltaSeconds) delay = Number(trimmed) * 1000;
  else {
    const at = Date.parse(value);
    if (!Number.isFinite(at)) return undefined;
    delay = at - now;
  }
  // Honor only useful, bounded cooldowns. The response header is untrusted input.
  return Math.max(0, Math.min(60 * 60_000, delay));
}

function sanitizedBootstrapUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.username || url.password || url.search || url.hash) return undefined;
    if (url.protocol !== "https:" && !isLocalBootstrapUrl(raw)) return undefined;
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return undefined;
  }
}

function refusalMessage(refusal: BootstrapRefusal): string {
  switch (refusal) {
    case "unsupported-version":
      return "The configuration uses an unsupported schema version.";
    case "unknown-key":
      return "The configuration was signed by an untrusted key.";
    case "bad-signature":
      return "The configuration signature is invalid.";
    case "wrong-environment":
      return "The configuration belongs to a different environment.";
    case "epoch-not-newer":
      return "The stored configuration is already current.";
    case "not-yet-valid":
      return "The configuration is not valid yet.";
    case "insecure-endpoint":
      return "The configuration contains an endpoint that is not allowed.";
    case "malformed":
      return "The server did not return a valid configuration.";
  }
}

async function readLimitedBody(response: Response, limit: number, signal: AbortSignal): Promise<Uint8Array> {
  const advertised = Number(response.headers.get("content-length"));
  if (Number.isFinite(advertised) && advertised > limit) {
    void response.body?.cancel().catch(() => undefined);
    throw Object.assign(new Error("response-too-large"), { code: "BOOTSTRAP_TOO_LARGE" });
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > limit) throw Object.assign(new Error("response-too-large"), { code: "BOOTSTRAP_TOO_LARGE" });
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      if (signal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
      const { done, value } = await new Promise<Awaited<ReturnType<typeof reader.read>>>((resolve, reject) => {
        const abort = () => {
          void reader.cancel().catch(() => undefined);
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        };
        signal.addEventListener("abort", abort, { once: true });
        reader
          .read()
          .then(resolve, reject)
          .finally(() => signal.removeEventListener("abort", abort));
      });
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        void reader.cancel().catch(() => undefined);
        throw Object.assign(new Error("response-too-large"), { code: "BOOTSTRAP_TOO_LARGE" });
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* An aborted stream can still be unwinding its read. */
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Ed25519 over raw bytes, via Node. The rules are the shared module's; this is only the primitive. */
function verifySignature(args: { message: Uint8Array; signature: Uint8Array; publicKey: Uint8Array }): boolean {
  // SPKI header for Ed25519, then the 32 raw bytes.
  const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(args.publicKey)]);
  const key = createPublicKey({ key: spki, format: "der", type: "spki" });
  return verifyEd25519(null, Buffer.from(args.message), key, Buffer.from(args.signature));
}

export function createControlPlaneBootstrapClient(deps: BootstrapClientDeps) {
  const now = deps.now ?? (() => Date.now());
  const doFetch = deps.fetchImpl ?? ((input: string, init?: RequestInit) => fetch(input, init));
  const trust = deps.trust ?? bootstrapTrustSet(deps.environment, process.env);
  const statePath = join(deps.stateDir, STATE_FILE);

  function read(): StoredBootstrap | null {
    try {
      const parsed = JSON.parse(readFileSync(statePath, "utf8")) as StoredBootstrap;
      if (typeof parsed?.highestSeenEpoch !== "number") return null;
      return parsed;
    } catch {
      // A missing or unreadable file is "this installation has accepted none", which is the correct
      // starting state and not an error worth failing a launch over.
      return null;
    }
  }

  function write(next: StoredBootstrap): void {
    mkdirSync(dirname(statePath), { recursive: true });
    const temporary = `${statePath}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    renameSync(temporary, statePath);
  }

  return {
    /**
     * What is on disk, without going anywhere and WITHOUT re-checking it.
     *
     * Kept for the one caller that legitimately wants the raw record — the diagnostics/status view,
     * which reports what is stored rather than what is trusted. Nothing that CONFIGURES anything may
     * use it; see `currentVerified`.
     */
    current(): ControlPlaneBootstrapEnvelope | null {
      return read()?.envelope ?? null;
    },

    /**
     * What is in force right now, RE-VERIFIED against this build's own rules.
     *
     * The runtime used to read the stored envelope and believe it as configuration. Five things were
     * therefore never re-checked on a start-up that adopted one: the signature, whether its `keyId`
     * is still in the build's trust set (a retired key), whether its environment is this build's,
     * whether its epoch is still at or above the persistent floor (the rollback the floor exists to
     * stop, arriving from disk rather than over the network), and whether its endpoints are secure
     * for a production build.
     *
     * The epoch is compared against `highestSeenEpoch - 1`, not against the floor itself: this
     * envelope IS the one that set the floor, so requiring "strictly newer" would refuse the very
     * document it just accepted. What it still refuses is one whose epoch is BELOW the floor, which
     * is the file-swap case.
     */
    currentVerified(): ControlPlaneBootstrapEnvelope | null {
      const stored = read();
      if (!stored?.envelope) return null;
      const verdict = verifyControlPlaneBootstrap({
        envelope: stored.envelope,
        trustKeys: trust.keys,
        expectedEnvironment: deps.environment,
        highestSeenEpoch: Math.max(0, (stored.highestSeenEpoch ?? 0) - 1),
        now: now(),
        verifySignature,
      });
      return verdict.accepted ? stored.envelope : null;
    },

    /** The rollback floor. Survives the envelope being deleted; that is the whole point of it. */
    highestSeenEpoch(): number {
      return read()?.highestSeenEpoch ?? 0;
    },

    /**
     * The transition this installation has accepted and not yet carried out, or null.
     *
     * Asked at START-UP, before any client is built — see `runtime.ts`. It is derived from the
     * VERIFIED envelope, so a stored document this build would no longer accept cannot drive one.
     *
     * `compiledProjectId` is what an installation that has never applied a transition is compared
     * against: the very first envelope moves it off the configuration it was built with, and treating
     * that as "nothing to do" is what left the floor-0 case unhandled entirely.
     */
    pendingTransition(compiledProjectId: string | undefined): PendingEpochTransition | null {
      const stored = read();
      const envelope = this.currentVerified();
      if (!stored || !envelope) return null;
      const toEpoch = envelope.payload.configEpoch;
      const fromEpoch = stored.appliedEpoch ?? 0;
      if (fromEpoch === toEpoch) return null;
      const fromProjectId = stored.appliedProjectId ?? compiledProjectId ?? "";
      const toProjectId = envelope.payload.projectId;
      return {
        fromEpoch,
        toEpoch,
        fromProjectId,
        toProjectId,
        identityInvalidated: fromProjectId !== "" && fromProjectId !== toProjectId,
      };
    },

    /**
     * Records that a transition has been carried out.
     *
     * Written LAST, after the work. A crash before it leaves the transition pending and the next
     * launch repeats it, which is safe because every step of it is idempotent — the alternative,
     * marking it first, is exactly the "applied" that meant "we intended to".
     */
    markEpochApplied(epoch: number, projectId: string): void {
      const stored = read();
      if (!stored) return;
      write({ ...stored, appliedEpoch: epoch, appliedProjectId: projectId });
    },

    /**
     * Fetches once and adopts the result only if it verifies AND carries a higher epoch.
     *
     * Never throws. Every failure path answers with what is already in force, because a bootstrap
     * that could break a working install is worse than one that is occasionally out of date.
     */
    async refresh(options: { readonly signal?: AbortSignal } = {}): Promise<BootstrapFetchResult> {
      const stored = read();
      const held = this.currentVerified();
      const errorUrl = sanitizedBootstrapUrl(deps.url);
      if (!deps.url || !errorUrl || trust.keys.size === 0) {
        const error: BootstrapError = {
          stage: "fetch",
          category: "not-configured",
          ...(errorUrl ? { url: errorUrl } : {}),
          refusal: "not-configured",
          message: "This version has no configured online service bootstrap.",
        };
        return { envelope: held, changed: false, refusal: "not-configured", error };
      }
      if (deps.environment === "local" && !isLocalBootstrapUrl(deps.url)) {
        const error: BootstrapError = {
          stage: "verify",
          category: "verification",
          refusal: "insecure-endpoint",
          url: errorUrl,
          message: "The configured bootstrap address is not allowed for this environment.",
        };
        return { envelope: held, changed: false, refusal: "insecure-endpoint", error };
      }

      let body: unknown;
      const controller = new AbortController();
      let timedOut = false;
      const forwardAbort = () => controller.abort();
      options.signal?.addEventListener("abort", forwardAbort, { once: true });
      const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      try {
        if (options.signal?.aborted) {
          const error: BootstrapError = {
            stage: "fetch",
            category: "cancelled",
            url: errorUrl,
            message: "Download cancelled.",
          };
          return { envelope: held, changed: false, refusal: "network", error };
        }
        const response = await doFetch(deps.url, {
          redirect: "manual",
          signal: controller.signal,
          // A bootstrap document is public and versioned by epoch; nothing here authenticates the
          // caller, and no cookie or token may be attached to a request to a recovery domain.
          headers: { accept: "application/json" },
        });
        if (response.status >= 300 && response.status < 400) {
          void response.body?.cancel().catch(() => undefined);
          const error: BootstrapError = {
            stage: "fetch",
            category: "redirect",
            status: response.status,
            url: errorUrl,
            message: "The server redirected the bootstrap request.",
          };
          return { envelope: held, changed: false, refusal: "network", error };
        }
        if (!response.ok) {
          void response.body?.cancel().catch(() => undefined);
          const retry = response.status === 429 ? retryAfterMs(response.headers.get("retry-after"), now()) : undefined;
          const error: BootstrapError = {
            stage: "fetch",
            category: "http",
            status: response.status,
            url: errorUrl,
            ...(retry === undefined ? {} : { retryAfterMs: retry }),
            message:
              response.status === 429
                ? "The server is temporarily limiting requests."
                : response.status === 404
                  ? "The bootstrap configuration was not found (HTTP 404)."
                  : response.status >= 500
                    ? "The configuration server is temporarily unavailable."
                    : `The server returned HTTP ${response.status}.`,
          };
          return { envelope: held, changed: false, refusal: "network", error };
        }
        let bytes: Uint8Array;
        try {
          bytes = await readLimitedBody(response, MAX_BOOTSTRAP_BYTES, controller.signal);
        } catch (error) {
          if (safeNodeCode(error) === "BOOTSTRAP_TOO_LARGE") {
            const detail: BootstrapError = {
              stage: "fetch",
              category: "invalid-response",
              code: "BOOTSTRAP_TOO_LARGE",
              url: errorUrl,
              message: "The server response is too large to be a configuration.",
            };
            return { envelope: held, changed: false, refusal: "network", error: detail };
          }
          throw error;
        }
        try {
          body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        } catch {
          const error: BootstrapError = {
            stage: "fetch",
            category: "invalid-response",
            code: "INVALID_JSON",
            url: errorUrl,
            message: "The server did not return a valid configuration.",
          };
          return { envelope: held, changed: false, refusal: "network", error };
        }
      } catch (error) {
        const detail = errorForNetwork(error, timedOut, errorUrl, timeoutMs);
        return { envelope: held, changed: false, refusal: "network", error: detail };
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", forwardAbort);
      }

      const verdict = verifyControlPlaneBootstrap({
        envelope: body,
        trustKeys: trust.keys,
        expectedEnvironment: deps.environment,
        highestSeenEpoch: stored?.highestSeenEpoch ?? 0,
        now: now(),
        verifySignature,
      });
      if (!verdict.accepted) {
        const refusal = verdict.refusal ?? "malformed";
        if (refusal === "epoch-not-newer") {
          const candidate = body as Partial<ControlPlaneBootstrapEnvelope>;
          const candidatePayload = candidate && typeof candidate === "object" ? candidate.payload : undefined;
          const sameAsHeld =
            held !== null &&
            candidatePayload !== undefined &&
            typeof candidatePayload === "object" &&
            canonicalJsonStringify(candidatePayload) === canonicalJsonStringify(held.payload);
          if (sameAsHeld) return { envelope: held, changed: false, refusal };
          const message =
            (candidatePayload as { configEpoch?: unknown } | undefined)?.configEpoch === stored?.highestSeenEpoch
              ? "A different configuration used an already accepted epoch."
              : "The server returned an older configuration; the rollback check refused it.";
          const detail: BootstrapError = { stage: "verify", category: "verification", refusal, url: errorUrl, message };
          return { envelope: held, changed: false, refusal, error: detail };
        }
        const detail: BootstrapError = {
          stage: "verify",
          category: "verification",
          refusal,
          url: errorUrl,
          message: refusalMessage(refusal),
        };
        return { envelope: held, changed: false, refusal, error: detail };
      }

      const accepted = body as ControlPlaneBootstrapEnvelope;
      try {
        write({
          envelope: accepted,
          highestSeenEpoch: Math.max(stored?.highestSeenEpoch ?? 0, accepted.payload.configEpoch),
          acceptedAt: now(),
          // ACCEPTING IS NOT APPLYING (F14). The applied marker is carried across untouched: it records
          // the transition this installation has actually CARRIED OUT, and dropping it here would both
          // lose which project the identity currently belongs to and make the new envelope look like a
          // first adoption off the compiled configuration.
          ...(stored?.appliedEpoch === undefined ? {} : { appliedEpoch: stored.appliedEpoch }),
          ...(stored?.appliedProjectId === undefined ? {} : { appliedProjectId: stored.appliedProjectId }),
        });
      } catch (error) {
        const code = safeNodeCode(error);
        const detail: BootstrapError = {
          stage: "persist",
          category: "storage",
          ...(code ? { code } : {}),
          url: errorUrl,
          message: "The configuration was downloaded but could not be saved.",
        };
        return { envelope: held, changed: false, refusal: "network", error: detail };
      }
      return { envelope: accepted, changed: true };
    },
  };
}

export type ControlPlaneBootstrapClient = ReturnType<typeof createControlPlaneBootstrapClient>;

/**
 * The Firebase configuration an accepted envelope describes.
 *
 * Remote envelopes supply their endpoints. Local envelopes additionally require the complete,
 * validated Emulator Suite and may change only its demo namespace, never replace it with cloud URLs.
 */
export function configFromBootstrap(
  envelope: ControlPlaneBootstrapEnvelope,
  functionsRegion: string,
  localConfig?: MobileFirebaseConfig | null,
): MobileFirebaseConfig {
  if (envelope.payload.environment === "local") {
    if (!localConfig?.emulators) throw new Error("Local bootstrap requires the complete Emulator Suite");
    const payload = envelope.payload;
    const resolved = resolveMobileFirebaseConfig(
      {
        STRIDETERM_ENV: "local",
        STRIDETERM_MOBILE_FIREBASE_PROJECT_ID: payload.projectId,
        STRIDETERM_MOBILE_FIREBASE_API_KEY: payload.apiKey,
        STRIDETERM_MOBILE_FIREBASE_DATABASE_URL: payload.databaseUrl,
        FIREBASE_AUTH_EMULATOR_HOST: localConfig.emulators.auth,
        FIREBASE_DATABASE_EMULATOR_HOST: localConfig.emulators.database,
        FIREBASE_FUNCTIONS_EMULATOR_HOST: localConfig.emulators.functions,
      },
      functionsRegion,
    );
    const expectedFunctions = `http://${localConfig.emulators.functions}/${payload.projectId}/${functionsRegion}`;
    if (
      !resolved.config ||
      payload.functionsBaseUrl !== expectedFunctions ||
      (payload.relayOrigin !== undefined && !isLocalBootstrapUrl(payload.relayOrigin)) ||
      (payload.billingCheckoutHosts?.length ?? 0) > 0
    ) {
      throw new Error("Local bootstrap must name only the configured demo Emulator Suite and a local relay");
    }
    return { ...resolved.config, relayOrigin: payload.relayOrigin };
  }
  return {
    projectId: envelope.payload.projectId,
    apiKey: envelope.payload.apiKey,
    functionsRegion,
    emulators: null,
    databaseUrl: envelope.payload.databaseUrl,
    // THE SIGNED FUNCTIONS BASE URL, and the relay origin. Both were dropped, so a client that had
    // accepted an envelope pointed its RTDB at the new project and its CALLABLES at a URL derived
    // from `functionsRegion` and the project id — which is right by accident for a Firebase-hosted
    // deployment and wrong for every other case the field exists for, including a recovery behind a
    // different domain. A partly-followed endpoint document is exactly what the schema's own
    // "refuse a version you cannot fully read" rule exists to avoid.
    functionsBaseUrl: envelope.payload.functionsBaseUrl,
    ...(envelope.payload.relayOrigin === undefined ? {} : { relayOrigin: envelope.payload.relayOrigin }),
    billingCheckoutHosts: [...(envelope.payload.billingCheckoutHosts ?? [])],
  };
}

export function isLocalBootstrapUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.hash &&
      !url.search &&
      url.port !== "0"
    );
  } catch {
    return false;
  }
}

export function resolveBootstrapFirebaseConfig(
  configured: ReturnType<typeof resolveMobileFirebaseConfig>,
  envelope: ControlPlaneBootstrapEnvelope | null,
  functionsRegion: string,
): ReturnType<typeof resolveMobileFirebaseConfig> {
  if (!envelope || configured.refusal || (envelope.payload.environment === "local" && !configured.config))
    return configured;
  try {
    return { config: configFromBootstrap(envelope, functionsRegion, configured.config), missing: [], refusal: null };
  } catch {
    return {
      config: null,
      missing: [],
      refusal: {
        reason: "local-endpoint-invalid",
        detail: "the local bootstrap does not match the required demo Emulator Suite",
      },
    };
  }
}
