/// <reference types="node" />
/**
 * The desktop's Firebase client: Auth + Realtime Database + callable Functions, over their public
 * HTTP APIs.
 *
 * WHY REST AND NOT THE `firebase` JS SDK
 * --------------------------------------
 * The review (§P0.2) asks for a real client "initialised from an environment/config object", able
 * to attach the emulators, and — explicitly — one where "the Auth session/refresh material and the
 * device private key go through the existing credential-store abstraction" and which "must not
 * rely on in-memory SDK persistence".
 *
 * That last requirement is the deciding one. ADR 0009 in strideterm-mobile established
 * empirically (against the real Auth emulator, not from documentation) that the Firebase JS SDK's
 * Auth persistence does not work in a headless Node process: there is no browser storage, and the
 * SDK exposes no supported way to export and re-import a refresh credential. A headless runtime
 * that must survive restarts therefore has to own its own session material regardless of which
 * client it uses — and once it does, the SDK's remaining value is a WebSocket transport and an
 * offline queue, in exchange for a very large dependency in an Electron app that currently has
 * none of it.
 *
 * The public APIs give everything the transport needs, and all of it was verified against the real
 * emulators before this was written rather than assumed:
 *
 *  - **Auth**: `accounts:signUp` for anonymous sign-in and `securetoken/v1/token` to exchange a
 *    refresh token for a fresh id token. The refresh token is a real credential, so it lives in
 *    `CredentialStore` (OS keychain when available) and never on disk in the clear.
 *  - **RTDB**: `GET`/`PUT`/`PATCH`/`DELETE` on `<path>.json`; `X-Firebase-ETag` +
 *    `if-match` for compare-and-set (a stale write returns 412), which is the transaction
 *    primitive; a root-level `PATCH` for atomic multi-location updates; and
 *    `Accept: text/event-stream` for live child streams.
 *  - **Functions**: a callable is a plain `POST` of `{"data": …}` with a `Bearer` id token; the
 *    Functions emulator confirmed `auth: VALID` for exactly this shape.
 *
 * This module is the *only* place in electron/backend/mobile that speaks HTTP to Firebase, mirrors
 * mobile-firebase-transport.ts's "single module allowed to depend on a Firebase client" rule, and
 * takes `fetch` as an injectable dependency so every behaviour above is testable without a
 * network.
 */
import type { CredentialStore } from "../shared/credential-store.js";
import {
  callableUrl,
  identityToolkitUrl,
  rtdbUrl,
  secureTokenUrl,
  type MobileFirebaseConfig,
} from "./mobile-firebase-config.js";
import { mobileErrorCode } from "./mobile-error-codes.js";
import { getLogger } from "../logger.js";

const log = getLogger("mobile-firebase-rest");

/** Refresh the id token this long before it actually expires. */
const TOKEN_REFRESH_MARGIN_MS = 60_000;

/**
 * How stale a server-clock sample may get before {@link MobileFirebaseRestClient.serverNow} takes
 * a fresh one. Every ordinary request refreshes it for free, so this only bites a transport that
 * has been idle — and five minutes of drift is orders of magnitude below the failure this exists
 * to prevent.
 */
const SERVER_TIME_SAMPLE_TTL_MS = 5 * 60_000;

/**
 * How long an RTDB SSE stream may go without ANY frame — including `keep-alive`, which RTDB sends
 * roughly every 30s — before the reader treats it as silently dead and reconnects. A NAT, proxy or
 * sleeping network adapter can drop the underlying connection without ever closing it, in which
 * case `reader.read()` simply never resolves again: the desktop shows "Connected" and no phone
 * command arrives until the process restarts. 90s is 3x the observed keep-alive cadence, so one or
 * two missed keep-alives are tolerated before the watchdog fires.
 */
const RTDB_STREAM_IDLE_TIMEOUT_MS = 90_000;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * A rules rejection, as distinct from a network or server error.
 *
 * Carries the PATH and nothing else. It used to carry the response body too, which is
 * remote-controlled text that reached the log through the error message (review 2 §"Logy a
 * diagnostika"); the body of an RTDB permission denial is `{"error":"Permission denied"}` in the
 * ordinary case and says nothing an operator can act on that the path does not.
 */
export class MobileFirebasePermissionDeniedError extends Error {
  constructor(path: string) {
    super(`PERMISSION_DENIED writing/reading ${path}`);
    this.name = "MobileFirebasePermissionDeniedError";
    this.path = path;
  }

  readonly path: string;
}

/**
 * A callable returned an `error` body (an `HttpsError` thrown inside the function).
 *
 * Deliberately does NOT carry the remote `message`. `functionName` is one of the names this repo
 * deploys and `status` is a gRPC status code — both enumerable, both ours — whereas the message is
 * whatever the function (or Firebase itself) produced, and it reached the logs verbatim through
 * this error's own `message` (review 2 §"Logy a diagnostika"). Callers that need to distinguish
 * outcomes switch on `status`; callers that log use `mobileErrorCode`.
 *
 * Fields are assigned explicitly rather than via TypeScript parameter properties: the
 * cross-repo emulator E2E (strideterm-mobile/cloud/e2e) imports this module through Node's
 * type-stripping loader, which rejects parameter properties outright.
 */
export class MobileFirebaseCallableError extends Error {
  readonly functionName: string;
  readonly status: string;
  readonly reason: string | null;

  constructor(functionName: string, status: string, reason: string | null = null) {
    super(`${functionName} failed (${status}${reason ? `: ${reason}` : ""})`);
    this.name = "MobileFirebaseCallableError";
    this.functionName = functionName;
    this.status = status;
    this.reason = reason;
  }
}

/**
 * Maps only the create-pairing callable's reviewed, fixed response messages to safe diagnostics.
 * Remote text is deliberately never copied into an Error: the response body is not trusted log
 * material, and this boundary is used by the loopback QA harness as well as the product.
 */
function callableReason(functionName: string, message: unknown): string | null {
  if (functionName !== "createPairingInvitation" || typeof message !== "string") return null;
  const prefix = "createPairingInvitation rejected: ";
  if (
    message ===
    "This desktop device id is already paired under a different account, or its key cannot be rotated while devices are still paired."
  ) {
    return "desktop-device-conflict";
  }
  if (!message.startsWith(prefix)) return null;
  const reason = message.slice(prefix.length);
  switch (reason) {
    case "entitlement-required":
    case "daily-limit-reached":
    case "too-many-pairs-for-uid":
    case "too-many-active":
    case "fingerprint-mismatch":
    case "malformed":
      return reason;
    default:
      return null;
  }
}

/**
 * Google's own names for "this refresh token cannot be exchanged, and never will be".
 *
 * WHY AN ALLOWLIST AND NOT "any 4xx". Falling back to a fresh anonymous account mints a NEW uid,
 * and pair membership is keyed on uid (`v2/pairs/$pairId/members/$uid`), so that fallback silently
 * unpairs every phone this desktop is paired with. It is the correct answer to a token that is
 * genuinely dead and the wrong answer to everything else — and on 2026-08-24 "everything else"
 * happened: `exchangeRefreshToken` threw undici's `TypeError: fetch failed`, one lost packet, and
 * the desktop reappeared in the cloud as a stranger. The pair kept the old uid in `publicMeta` and
 * `members`, so every read and write it attempted was refused for hours while its own UI said
 * "Connected".
 *
 * So the rule is inverted: a new identity is minted ONLY when the token endpoint names a reason
 * from this list. An unrecognised body, a 5xx, a captive portal, a dead network — the token is kept
 * and the caller retries. The cost of that trade is a truly-dead token whose reason we do not
 * recognise: it keeps failing instead of self-healing. That failure is visible (the presence
 * heartbeat is refused, which `getConnectionHealth` now reports) and recoverable by re-pairing,
 * whereas the failure it replaces destroyed a working pairing without saying a word.
 */
const REFRESH_TOKEN_REJECTIONS = new Set([
  "TOKEN_EXPIRED",
  "INVALID_REFRESH_TOKEN",
  "MISSING_REFRESH_TOKEN",
  "INVALID_GRANT_TYPE",
  "USER_DISABLED",
  "USER_NOT_FOUND",
  "PROJECT_NOT_FOUND",
  "CREDENTIAL_MISMATCH",
  // The OAuth-shaped body the same endpoint answers with for some grant errors.
  "invalid_grant",
  "invalid_request",
]);

/**
 * The token endpoint refused THIS credential, by a name we recognise — as distinct from failing to
 * answer. The only error that may cost this desktop its identity.
 *
 * `reason` is a member of {@link REFRESH_TOKEN_REJECTIONS} and therefore safe to log: it is matched
 * against our own constants, never echoed from the response.
 */
export class MobileFirebaseAuthRejectedError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`the stored Firebase refresh token was rejected (${reason})`);
    this.name = "MobileFirebaseAuthRejectedError";
    this.reason = reason;
  }
}

export interface AuthSession {
  idToken: string;
  uid: string;
  /** Epoch ms. */
  expiresAt: number;
}

export interface MobileFirebaseRestClientDeps {
  config: MobileFirebaseConfig;
  credentialStore: Pick<CredentialStore, "getSecret" | "setSecret" | "deleteSecret"> &
    Partial<Pick<CredentialStore, "isEncryptionAvailable">>;
  /** Credential-store key the Auth refresh token is persisted under. */
  refreshTokenRef: string;
  fetchImpl?: FetchLike;
  now?: () => number;
  /**
   * Whether this installation is currently BOUND to an account.
   *
   * The guard on the anonymous fallback. A rejected refresh token used to be answered by deleting the
   * credential and signing in anonymously again, which produces a NEW uid — and that uid is the thing
   * every pair membership, the account's `installations` row, the relay connector identity and the
   * server's `accountByUid` index are keyed by. For an unbound machine that is the right recovery and
   * costs nothing. For a BOUND one it silently replaces the identity the account knows, and the
   * honest answer is to refuse and let the user run the `recover-uid` enrolment, which is the path
   * that exists precisely for a desktop that lost its refresh token.
   *
   * Absent means "not bound", which is today's behaviour for every caller that has no account.
   */
  isAccountBound?: () => boolean;
  /** A positive durable marker that an anonymous identity already belongs to an account. */
  isPositivelyBound?: () => boolean;
}

/**
 * Thrown instead of minting a new anonymous identity for an ACCOUNT-BOUND installation.
 *
 * Carries no remote text. The desktop maps it to `installation-identity-lost`, which the Account page
 * turns into "reconnect this machine" — the `recover-uid` enrolment, which keeps the account's cap
 * slot and its pairings instead of starting a second installation.
 */
export class MobileFirebaseIdentityLostError extends Error {
  // Declared and assigned, NOT a constructor parameter property. The cross-repo emulator scenario
  // imports this module through Node's type-stripping loader, which cannot rewrite `constructor(readonly
  // x)` — it removes types, it does not emit the field. A parameter property here made
  // `npm run e2e` fail at import with ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX, before a single test ran.
  readonly reason: string;

  constructor(reason: string) {
    super(`the stored Firebase refresh token was rejected for an account-bound installation (${reason})`);
    this.name = "MobileFirebaseIdentityLostError";
    this.reason = reason;
  }
}

export interface RtdbStreamEvent {
  /** `put` replaces the value at `path`; `patch` merges into it. */
  type: "put" | "patch";
  /** Path relative to the streamed node — `/` for the whole node. */
  path: string;
  data: unknown;
}

export interface RtdbStreamHandlers {
  onEvent(event: RtdbStreamEvent): void;
  onError?(error: Error): void;
}

/** Consecutive `auth_revoked` restarts (no data in between) after which the stream reports an error. */
const MAX_CONSECUTIVE_AUTH_RESTARTS = 3;

type RtdbStreamEndReason = "ended" | "restart-auth" | "restart-cancelled" | "idle";

export interface MobileFirebaseRestClient {
  /** Establishes (or restores) the Auth session. Idempotent and safe to call repeatedly. */
  signIn(): Promise<AuthSession>;
  /** Current session, refreshed if it is at/near expiry. */
  currentSession(): Promise<AuthSession>;
  /**
   * Mints a NEW id token now, whatever the cached one's expiry says.
   *
   * For the one thing an expiry cannot tell you: the CLAIMS changed. A custom claim is baked in when
   * the token is minted, so an installation whose account was just granted, renewed or revoked keeps
   * presenting the old one for the rest of its hour — and every entitlement-gated door refuses it
   * meanwhile. `v2/tokenRefresh/{uid}` is the server saying "ask again now"; this is asking.
   */
  refreshSession(): Promise<AuthSession>;
  /** Forgets the cached id token (the persisted refresh token stays, so the next call re-signs in). */
  clearCachedToken(): void;
  /** Forgets the persisted refresh token too — the next sign-in creates a NEW anonymous uid. */
  forgetSession(): Promise<void>;

  get<T>(path: string): Promise<T | null>;
  set(path: string, value: unknown): Promise<void>;
  remove(path: string): Promise<void>;
  /** Root-level multi-location update; keys are absolute paths. Atomic server-side. */
  updateMulti(updates: Record<string, unknown>): Promise<void>;
  /** Reads a node plus its ETag, for {@link setIfMatch}. */
  getWithEtag<T>(path: string): Promise<{ value: T | null; etag: string }>;
  /** Compare-and-set. Returns false when the node changed under us (HTTP 412). */
  setIfMatch(path: string, value: unknown, etag: string): Promise<boolean>;

  /** Subscribes to a node via server-sent events. Returns an unsubscribe function. */
  stream(path: string, handlers: RtdbStreamHandlers): () => void;

  /**
   * The Firebase server's own clock, in epoch ms — the value `now` evaluates to inside a Security
   * Rules expression, up to sub-second sampling error.
   *
   * This exists because `database.rules.json` validates a `quotaWindows` bump with
   * `windowStart <= now && windowEnd > now` and, unlike every other timestamp check in that file,
   * deliberately carries no clock-skew tolerance: slack there would make several minute-windows
   * writable at once near a boundary and multiply the burst a client can emit before the
   * event-creation ceiling engages. So the writer has to agree with the server about what time it
   * is, rather than the rule being loosened to agree with the writer.
   *
   * Falls back to the local clock when no sample can be taken (offline, or a proxy that strips the
   * header) — that is exactly the status quo it replaces, never worse.
   */
  serverNow(): Promise<number>;

  /** Invokes an `onCall` Cloud Function and returns its `result`. */
  callFunction<TResult>(name: string, data: unknown): Promise<TResult>;
}

export function createMobileFirebaseRestClient(deps: MobileFirebaseRestClientDeps): MobileFirebaseRestClient {
  const { config, credentialStore, refreshTokenRef } = deps;
  const doFetch: FetchLike = deps.fetchImpl || ((input, init) => fetch(input, init));
  const now = deps.now || (() => Date.now());

  let session: AuthSession | null = null;
  /**
   * The refresh token when the credential store REFUSED it (no secure storage: Mobile's keys are never
   * written as plaintext). This client also serves the account's installation session, which must not
   * fail outright on such a machine — it keeps the token for this run only, and the identity does not
   * survive a restart, which is exactly the trade the refusal makes.
   */
  let memoryOnlyRefreshToken = "";
  let inFlight: Promise<AuthSession> | null = null;
  let forcedRefresh: Promise<AuthSession> | null = null;
  const openStreams = new Set<AbortController>();

  /** Server clock minus local clock, in ms. `null` until the first sample lands. */
  let serverTimeOffsetMs: number | null = null;
  let serverTimeSampledAt = 0;

  /**
   * Takes a server-clock sample from a response's `Date` header.
   *
   * Every Firebase HTTP response carries one — including a 401 from a rules rejection — so this
   * costs no extra round trip. The header has one-second resolution and the response spent part of
   * a round trip in flight, so the sample is anchored at the request's midpoint, the standard
   * correction; the residual error is under a second plus half the RTT. Quota windows are
   * minute-aligned at their finest, so that is ample.
   */
  function recordServerTime(response: Response, sentAt: number): void {
    const header = response.headers?.get("date");
    if (!header) return;
    const serverMs = Date.parse(header);
    if (!Number.isFinite(serverMs)) return;
    serverTimeOffsetMs = serverMs - (sentAt + now()) / 2;
    serverTimeSampledAt = now();
  }

  /** Every request in this module goes through here, so every response feeds the clock sample. */
  async function timedFetch(input: string, init?: RequestInit): Promise<Response> {
    const sentAt = now();
    const response = await doFetch(input, config.emulators ? { ...init, redirect: "error" } : init);
    recordServerTime(response, sentAt);
    return response;
  }

  async function readJson(response: Response): Promise<unknown> {
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  /**
   * The named reason this refresh token was refused, or `null` when the endpoint did not refuse it
   * (it answered fine, or it failed to answer at all).
   *
   * Reads both shapes the token endpoint uses: Identity Toolkit's `{error:{message:"TOKEN_EXPIRED"}}`
   * and the OAuth-style `{error:"invalid_grant"}`. `message` can carry a trailing explanation after
   * a colon (`"TOKEN_EXPIRED : ..."`), so only the name is matched.
   */
  function refreshTokenRejection(response: Response, body: unknown): string | null {
    if (response.ok) return null;
    const error = typeof body === "object" && body !== null ? (body as { error?: unknown }).error : undefined;
    const raw =
      typeof error === "string"
        ? error
        : typeof error === "object" && error !== null && typeof (error as { message?: unknown }).message === "string"
          ? (error as { message: string }).message
          : "";
    const named = raw.split(":")[0].trim();
    return REFRESH_TOKEN_REJECTIONS.has(named) ? named : null;
  }

  async function persistRefreshToken(token: string): Promise<void> {
    try {
      await credentialStore.setSecret(refreshTokenRef, token);
      memoryOnlyRefreshToken = "";
    } catch (err) {
      if (credentialStore.isEncryptionAvailable?.() !== false) throw err;
      memoryOnlyRefreshToken = token;
      log.warn("mobile Firebase refresh token kept in memory only: secure storage is unavailable");
    }
  }

  async function exchangeRefreshToken(refreshToken: string): Promise<AuthSession> {
    const response = await timedFetch(secureTokenUrl(config), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }).toString(),
    });
    const body = (await readJson(response)) as Record<string, unknown> | null;
    const rejection = refreshTokenRejection(response, body);
    if (rejection) throw new MobileFirebaseAuthRejectedError(rejection);
    if (!response.ok || !body || typeof body.id_token !== "string") {
      // Status only. The body is remote-controlled text and this message reaches a log through
      // `establishSession`'s warn — the same reason `MobileFirebasePermissionDeniedError` carries
      // a path and nothing else.
      throw new Error(`Firebase Auth refresh failed (${response.status})`);
    }
    // Google rotates the refresh token on some exchanges; persist whatever came back so the
    // stored credential never goes stale.
    if (typeof body.refresh_token === "string" && body.refresh_token !== refreshToken) {
      await persistRefreshToken(body.refresh_token);
    }
    return {
      idToken: body.id_token,
      uid: String(body.user_id ?? ""),
      expiresAt: now() + Number(body.expires_in ?? 3600) * 1000,
    };
  }

  async function signInAnonymously(): Promise<AuthSession> {
    const response = await timedFetch(identityToolkitUrl(config, "signUp"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ returnSecureToken: true }),
    });
    const body = (await readJson(response)) as Record<string, unknown> | null;
    if (!response.ok || !body || typeof body.idToken !== "string") {
      throw new Error(`Firebase anonymous sign-in failed (${response.status}): ${JSON.stringify(body)}`);
    }
    if (typeof body.refreshToken === "string") {
      await persistRefreshToken(body.refreshToken);
    }
    return {
      idToken: body.idToken,
      uid: String(body.localId ?? ""),
      expiresAt: now() + Number(body.expiresIn ?? 3600) * 1000,
    };
  }

  async function establishSession(): Promise<AuthSession> {
    const storedRefreshToken = credentialStore.getSecret(refreshTokenRef) || memoryOnlyRefreshToken;
    if (!storedRefreshToken && deps.isPositivelyBound?.() === true) {
      // A durable bound marker with no token is identity loss, not a fresh install. Creating an
      // anonymous uid here would silently detach every account installation row and pairing.
      throw new MobileFirebaseIdentityLostError("MISSING_REFRESH_TOKEN");
    }
    if (storedRefreshToken) {
      try {
        const restored = await exchangeRefreshToken(storedRefreshToken);
        log.info("restored mobile Firebase Auth session from the credential store");
        return restored;
      } catch (err) {
        if (!(err instanceof MobileFirebaseAuthRejectedError)) {
          // Not a refusal of this credential — see REFRESH_TOKEN_REJECTIONS. Keep the identity and
          // let the caller retry: presence, the command stream and every RTDB write already treat
          // a failed session as a transient failure, and none of them is worth a new uid.
          log.warn("mobile Firebase token refresh failed; keeping the stored identity", {
            code: mobileErrorCode(err),
          });
          throw err;
        }
        // A revoked token, or one belonging to a project this install no longer points at.
        //
        // FOR AN ACCOUNT-BOUND INSTALLATION THIS IS NOT A RECOVERY. A fresh anonymous sign-in
        // produces a NEW uid, and that uid is what every pair membership, the account's
        // `installations` row and the server's `accountByUid` index are keyed by — so "sign in again"
        // quietly replaces the identity the account knows with one it has never seen, and the machine
        // appears to have vanished from its own account. The credential is KEPT (there is nothing to
        // gain by destroying it) and the user is told, so the `recover-uid` enrolment can put the new
        // uid on the SAME installation row.
        if (deps.isAccountBound?.() === true) {
          log.warn("stored mobile Firebase refresh token was rejected for an account-bound installation", {
            reason: err.reason,
          });
          throw new MobileFirebaseIdentityLostError(err.reason);
        }
        // An UNBOUND machine has nothing keyed by its uid yet, so a fresh anonymous identity is the
        // right answer and costs nothing. Still logged loudly: it does invalidate any pre-account
        // pairing this machine had.
        log.warn("stored mobile Firebase refresh token was rejected; signing in as a new anonymous user", {
          reason: err.reason,
        });
        await credentialStore.deleteSecret(refreshTokenRef);
      }
    }
    return signInAnonymously();
  }

  async function currentSession(): Promise<AuthSession> {
    if (session && session.expiresAt - TOKEN_REFRESH_MARGIN_MS > now()) return session;
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const next = await establishSession();
        session = next;
        return next;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  async function authParams(): Promise<Record<string, string>> {
    const active = await currentSession();
    return { auth: active.idToken };
  }

  function permissionDenied(response: Response, body: unknown): boolean {
    if (response.status !== 401 && response.status !== 403) return false;
    const detail = typeof body === "object" && body !== null ? (body as { error?: unknown }).error : body;
    return typeof detail !== "string" || /permission/i.test(detail) || detail.length > 0;
  }

  async function rtdbRequest(
    method: string,
    path: string,
    options: { body?: unknown; headers?: Record<string, string>; params?: Record<string, string> } = {},
  ): Promise<{ response: Response; body: unknown }> {
    const url = rtdbUrl(config, path, { ...(await authParams()), ...(options.params || {}) });
    const response = await timedFetch(url, {
      method,
      headers: options.headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const body = await readJson(response);
    if (permissionDenied(response, body)) {
      // The path and the status, never the body: an RTDB rejection body is remote-controlled
      // text that ends up in an error message and from there in a log (review 2 §"Logy a
      // diagnostika"). What an operator needs from a permission denial is which node was refused,
      // and that is ours.
      throw new MobileFirebasePermissionDeniedError(path);
    }
    if (!response.ok) {
      throw new Error(`RTDB ${method} ${path} failed (${response.status})`);
    }
    return { response, body };
  }

  return {
    async signIn() {
      return currentSession();
    },
    async refreshSession() {
      if (forcedRefresh) return forcedRefresh;
      forcedRefresh = (async () => {
        // An ordinary exchange may have started before the claims marker was written. Joining that
        // request can therefore return a token minted before the claims changed. Let it settle, then
        // force one exchange whose request is known to start after the marker was observed.
        const earlier = inFlight;
        session = null;
        if (earlier) await earlier.catch(() => undefined);
        session = null;
        return currentSession();
      })().finally(() => {
        forcedRefresh = null;
      });
      return forcedRefresh;
    },

    currentSession,

    clearCachedToken() {
      session = null;
    },

    async forgetSession() {
      session = null;
      await credentialStore.deleteSecret(refreshTokenRef);
    },

    async get<T>(path: string): Promise<T | null> {
      const { body } = await rtdbRequest("GET", path);
      return (body ?? null) as T | null;
    },

    async set(path: string, value: unknown): Promise<void> {
      await rtdbRequest("PUT", path, { body: value });
    },

    async remove(path: string): Promise<void> {
      await rtdbRequest("DELETE", path);
    },

    async updateMulti(updates: Record<string, unknown>): Promise<void> {
      // A PATCH at the root with absolute path keys is RTDB's multi-location update: the server
      // applies all of them or none. This is how the two-phase quota bump writes its three
      // window nodes without an interleaved partial state.
      await rtdbRequest("PATCH", "", { body: updates });
    },

    async getWithEtag<T>(path: string): Promise<{ value: T | null; etag: string }> {
      const { response, body } = await rtdbRequest("GET", path, {
        headers: { "X-Firebase-ETag": "true" },
      });
      return { value: (body ?? null) as T | null, etag: response.headers.get("etag") ?? "" };
    },

    async setIfMatch(path: string, value: unknown, etag: string): Promise<boolean> {
      const url = rtdbUrl(config, path, await authParams());
      const response = await timedFetch(url, {
        method: "PUT",
        headers: { "if-match": etag },
        body: JSON.stringify(value),
      });
      if (response.status === 412) {
        // Someone else wrote this node between our read and this write. The caller retries.
        await response.text();
        return false;
      }
      const body = await readJson(response);
      if (permissionDenied(response, body)) {
        throw new MobileFirebasePermissionDeniedError(path);
      }
      if (!response.ok) {
        throw new Error(`RTDB compare-and-set ${path} failed (${response.status})`);
      }
      return true;
    },

    stream(path: string, handlers: RtdbStreamHandlers): () => void {
      const controller = new AbortController();
      openStreams.add(controller);
      let closed = false;

      const pump = async (): Promise<void> => {
        // One reconnect loop per stream. RTDB's SSE endpoint ends the response on its own
        // periodically (and on any network blip); re-opening replays the current state as a
        // fresh `put` at `/`, which is exactly the resync behaviour a reconnecting listener
        // needs — the caller does not have to track what it missed.
        let backoffMs = 500;
        // `auth_revoked` is routine (the ID token on the open stream expires about hourly), so it
        // is not reported as an error. A stream that keeps being revoked right after reconnecting
        // with a fresh token, without ever delivering data, is a real rejection and is reported.
        let consecutiveAuthRestarts = 0;
        const streamHandlers: RtdbStreamHandlers = {
          onEvent: (event) => {
            consecutiveAuthRestarts = 0;
            handlers.onEvent(event);
          },
          onError: (error) => handlers.onError?.(error),
        };
        while (!closed) {
          try {
            const url = rtdbUrl(config, path, await authParams());
            const response = await timedFetch(url, {
              headers: { Accept: "text/event-stream" },
              signal: controller.signal,
            });
            if (!response.ok || !response.body) {
              throw new Error(`RTDB stream ${path} failed (${response.status})`);
            }
            backoffMs = 500;
            const endReason = await consumeEventStream(response.body, streamHandlers, () => closed);
            if (endReason === "ended") consecutiveAuthRestarts = 0;
            if (endReason !== "ended") {
              // Firebase sends `auth_revoked` when the credential attached to an already-open SSE
              // request expires. The response is allowed to stay open after that terminal frame,
              // so merely reporting it leaves the desktop listening to a dead stream forever. End
              // this iteration explicitly and forget the cached ID token: the next `authParams()`
              // call exchanges the durable refresh token and opens a fresh authenticated stream.
              if (endReason === "restart-auth") {
                session = null;
                consecutiveAuthRestarts += 1;
                log.info("RTDB stream credential expired; reconnecting with a fresh token", { path });
                if (consecutiveAuthRestarts === MAX_CONSECUTIVE_AUTH_RESTARTS) {
                  handlers.onError?.(
                    new Error(
                      `RTDB stream ${path}: credential rejected after ${MAX_CONSECUTIVE_AUTH_RESTARTS} refreshes`,
                    ),
                  );
                }
              }
              if (endReason === "idle") {
                log.warn("RTDB stream went idle; reconnecting", { code: "rtdb-stream-idle", path });
              }
              await new Promise((resolve) => setTimeout(resolve, backoffMs));
              backoffMs = Math.min(backoffMs * 2, 30_000);
            }
          } catch (err) {
            if (closed || controller.signal.aborted) return;
            handlers.onError?.(err as Error);
            await new Promise((resolve) => setTimeout(resolve, backoffMs));
            backoffMs = Math.min(backoffMs * 2, 30_000);
          }
        }
      };

      void pump();

      return () => {
        if (closed) return;
        closed = true;
        openStreams.delete(controller);
        controller.abort();
      };
    },

    async serverNow(): Promise<number> {
      if (serverTimeOffsetMs === null || now() - serverTimeSampledAt > SERVER_TIME_SAMPLE_TTL_MS) {
        try {
          // A shallow GET of the database root, deliberately unauthenticated: whether the rules
          // allow it is irrelevant, because a rejection carries the same `Date` header, and not
          // needing a session keeps this callable before sign-in.
          const probe = await timedFetch(rtdbUrl(config, "", { shallow: "true" }), { method: "GET" });
          await probe.text().catch(() => "");
        } catch (err) {
          // Offline. The fallback below is the local clock — which is what this call replaces, so
          // this degrades to the previous behaviour rather than failing the write outright.
          log.warn("could not sample Firebase server time; falling back to the local clock", {
            code: mobileErrorCode(err),
          });
        }
      }
      return now() + (serverTimeOffsetMs ?? 0);
    },

    async callFunction<TResult>(name: string, data: unknown): Promise<TResult> {
      const active = await currentSession();
      const response = await timedFetch(callableUrl(config, name), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${active.idToken}`,
        },
        body: JSON.stringify({ data }),
      });
      const body = (await readJson(response)) as Record<string, unknown> | null;
      const error = body?.error as { status?: string; message?: string } | undefined;
      if (error) {
        // `status` is a gRPC status code the callable itself chose. Only a reviewed, fixed reason
        // from this callable's closed set is carried into the error; arbitrary response text is not.
        throw new MobileFirebaseCallableError(
          name,
          error.status ?? String(response.status),
          callableReason(name, error.message),
        );
      }
      if (!response.ok) {
        throw new MobileFirebaseCallableError(name, String(response.status));
      }
      return (body?.result ?? null) as TResult;
    },
  };
}

/**
 * Parses RTDB's server-sent-event framing. Each event is
 * `event: <name>\ndata: <json>\n\n`; `keep-alive`, `auth_revoked` and `cancel` also occur.
 * Exported for its own tests — SSE framing splits across chunk boundaries in practice, and that
 * is exactly the kind of bug that only shows up against a real server under load.
 */
export async function consumeEventStream(
  body: ReadableStream<Uint8Array>,
  handlers: RtdbStreamHandlers,
  isClosed: () => boolean,
  idleTimeoutMs: number = RTDB_STREAM_IDLE_TIMEOUT_MS,
): Promise<RtdbStreamEndReason> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let idle = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const armIdleTimer = (): void => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idle = true;
      // Best-effort: resolves the pending `read()` below so the loop notices `idle` promptly
      // instead of waiting for the underlying connection to time out on its own.
      void reader.cancel().catch(() => {});
    }, idleTimeoutMs);
  };
  armIdleTimer();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      // The watchdog firing wins over whatever `read()` settled with — a frame that happened to
      // arrive in the same tick the timer fired does not un-declare the stream idle.
      if (idle) return "idle";
      if (done || isClosed()) return "ended";
      armIdleTimer();
      buffer += decoder.decode(value, { stream: true });
      let separator = buffer.indexOf("\n\n");
      while (separator >= 0) {
        const frame = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        const endReason = handleFrame(frame, handlers);
        if (endReason) return endReason;
        separator = buffer.indexOf("\n\n");
      }
    }
  } finally {
    clearTimeout(idleTimer);
    try {
      reader.releaseLock();
    } catch {
      // Already released by an abort; nothing to do.
    }
  }
}

function handleFrame(frame: string, handlers: RtdbStreamHandlers): Exclude<RtdbStreamEndReason, "ended"> | null {
  let eventName = "";
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) eventName = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (eventName !== "put" && eventName !== "patch") {
    // `keep-alive` carries no data. `auth_revoked` is the routine expiry of the ID token on an
    // open stream: not an error, the reconnect loop just re-authenticates. `cancel` means the
    // listener lost permission — surfaced as an error.
    if (eventName === "auth_revoked") return "restart-auth";
    if (eventName === "cancel") {
      handlers.onError?.(new Error(`RTDB stream ${eventName}`));
      return "restart-cancelled";
    }
    return null;
  }
  let payload: { path?: string; data?: unknown };
  try {
    payload = JSON.parse(dataLines.join("\n")) as { path?: string; data?: unknown };
  } catch {
    handlers.onError?.(new Error(`unparseable RTDB stream frame: ${frame.slice(0, 200)}`));
    return null;
  }
  handlers.onEvent({ type: eventName, path: payload.path ?? "/", data: payload.data ?? null });
  return null;
}
