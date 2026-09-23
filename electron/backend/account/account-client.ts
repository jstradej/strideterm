// The OWNER identity, over Firebase's REST Auth API — deliberately separate from the installation
// session.
//
// TWO SESSIONS, AND THEY MUST NOT BE ONE. The installation session is a long-lived, anonymous-or-
// installation-bound identity that owns this machine's pairings, its device records and its relay
// connector; the owner session is the person's email login, used to create an account, prove
// ownership and reauthenticate before something destructive. Collapsing them would mean signing out
// of the account signs the machine out of its own pairings — and that signing in on a second
// machine could take the first one's pairings with it.
//
// THE OWNER CREDENTIAL IS TRANSIENT BY DEFAULT. Nothing here writes a refresh token to the
// credential store: the ordinary flow is "sign in, prove something, drop it". What IS persisted is
// the installation's own refresh token, by the transport that owns it.
//
// THERE IS NO PASSWORD HERE ANY MORE, AND THAT IS THE WHOLE POINT OF THIS FILE'S CURRENT SHAPE.
// A person never creates, types or resets a strIDEterm password: `signInWithPassword`, `signUp` and
// `PASSWORD_RESET` are gone from this client, and nothing generates a hidden random one as a way
// around that. What replaced them is a one-time sign-in link — `sendOobCode` with
// `requestType: EMAIL_SIGNIN`, then `signInWithEmailLink`.
//
// WHAT THAT DOES **NOT** MEAN, said here because the distinction decides whether a claim in the
// documentation is true (plan §5): Firebase requires the Email/Password provider to be ENABLED for
// email-link sign-in to work at all. Removing these methods removes the product's password flow; it
// does not, and cannot, stop the public Firebase API from accepting a password call made by
// something else. If the requirement ever becomes "Firebase must refuse every password", this design
// does not meet it and a different authentication decision is needed.
//
// EVERY ERROR IS A FIXED CODE. Firebase's own messages are stable-ish English strings that name
// whether an account exists, which is an oracle a login form should not hand out. They are mapped to
// a closed set here and the remote text is dropped — never interpolated into an error a user or a
// log will see.

import { identityToolkitUrl, secureTokenUrl, type MobileFirebaseConfig } from "../mobile/mobile-firebase-config.js";
import { classifyNetworkError, type NetworkFailureKind } from "../net/network-error.js";
import { readBoundedJsonBody, requestDeadline, type BoundedJson } from "./bounded-http.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** What one call may be told about the flow that made it. */
export interface AccountCallOptions {
  /**
   * The FLOW's abort signal, not this request's.
   *
   * A cancel, a resend, a closed dialog or a shutdown aborts the flow, and every request the flow has
   * outstanding goes with it (F04: "Propagovat abort konkrétního toku"). Each request also has a
   * deadline of its own; the two are separate, and `AccountAuthError` distinguishes them — an aborted
   * flow is not a network failure to report to anybody.
   */
  readonly signal?: AbortSignal;
}

/**
 * Every way an owner-identity call can fail, as a closed set.
 *
 * `invalid-code` covers "no such code" AND "already used" on purpose: Firebase does not reliably
 * distinguish them, and inventing a distinction the service does not make is how a UI ends up
 * telling somebody something confidently wrong. `expired-code` IS distinguished, because Firebase
 * names it and because it is the one a person can act on by asking for a new link.
 */
export type AccountAuthErrorCode =
  /** No owner session where one is required. Ours, not Firebase's. */
  | "invalid-credentials"
  | "invalid-email"
  /** The sign-in code was rejected: wrong, malformed, or already redeemed. */
  | "invalid-code"
  | "expired-code"
  | "too-many-attempts"
  | "requires-recent-login"
  | "user-disabled"
  | "network"
  /**
   * The FLOW this request belonged to was abandoned while it was in flight.
   *
   * Deliberately not `network`: nothing failed, and nothing about the service is known. The caller
   * asked for the answer and then stopped wanting it — a cancel, a resend, a closed dialog, a
   * shutdown — and reporting that as a connectivity problem would send somebody to check their
   * router (F04).
   */
  | "aborted"
  /**
   * The service ANSWERED, and the answer could not be read as one of its (R04).
   *
   * An HTTP 200 whose body was too large, or was not JSON. Distinct from `network` — the request
   * reached the service and the service responded — and distinct from every refusal, because nothing
   * was refused. For a request that changes something it is an UNKNOWN outcome: the send may well have
   * gone out, and the caller must not count the request as either confirmed or failed.
   */
  | "malformed-response"
  | "not-configured"
  /**
   * The identity service cannot serve this flow at all right now.
   *
   * Email-link sign-in turned off for the project, an unauthorized `continueUrl` domain, or the daily
   * send quota spent. Three different operator problems and none of them is the user's — which is why
   * they share one code rather than being guessed apart in a message.
   */
  | "auth-unavailable"
  | "unknown";

export class AccountAuthError extends Error {
  readonly code: AccountAuthErrorCode;
  /** For `network` only: which kind of transport failure it was (TLS inspection above all). */
  readonly detail: NetworkFailureKind;

  constructor(code: AccountAuthErrorCode, message: string, detail: NetworkFailureKind = null) {
    super(message);
    this.name = "AccountAuthError";
    this.code = code;
    this.detail = detail;
  }
}

/** The owner session. Held in memory; never persisted. */
export interface OwnerSession {
  readonly idToken: string;
  readonly refreshToken: string;
  readonly uid: string;
  readonly email: string;
  readonly emailVerified: boolean;
  /** Epoch ms. */
  readonly expiresAt: number;
  /**
   * When the person last actually proved this identity, or NULL when the token did not say.
   *
   * Set from the token's own `auth_time` by a redeemed sign-in link and by nothing else. A token
   * refresh does not move it — that is the whole distinction the five-minute window rests on — and
   * neither does a `lookup`. The SERVER checks the same thing on `auth_time` in the validated token;
   * this local value exists so the UI can ask for a fresh link BEFORE a destructive action rather
   * than after the server refuses it.
   *
   * NULL RATHER THAN `now()` (F08). It used to fall back to this machine's clock whenever the claim
   * was missing or unparseable, which turns "the token does not say when this person authenticated"
   * into "they authenticated just now" — a LOCAL permission derived from the absence of the evidence
   * for it. Null means the desktop does not know, `hasRecentAuth` is false, and the person is asked
   * for a fresh link. The server was always going to refuse the action anyway; the difference is
   * whether the desktop offers it first.
   */
  readonly authenticatedAt: number | null;
}

export interface AccountClientDeps {
  readonly config: MobileFirebaseConfig;
  readonly fetchImpl?: FetchLike;
  readonly now?: () => number;
}

/** How long a sign-in counts as recent. Matches the server's own window. */
export const RECENT_AUTH_WINDOW_MS = 5 * 60 * 1000;

/**
 * How far in the future an `auth_time` may be before it is nonsense rather than clock skew.
 *
 * F08 asks for "případná malá tolerance hodin", and there has to be one: the claim is stamped by
 * Google's clock and compared against this machine's, and a desktop whose clock is a minute behind
 * would otherwise reject its own fresh sign-in. Two minutes is small enough that it cannot extend the
 * five-minute window into anything useful, and generous enough to cover an ordinary unsynchronised
 * clock. Past it the value is not skew — it is a token claiming to have been issued in the future, and
 * a future `auth_time` never expires — so it is refused outright rather than clamped.
 */
export const AUTH_TIME_FUTURE_TOLERANCE_MS = 2 * 60 * 1000;

/**
 * The oldest `auth_time` that is a time at all.
 *
 * A `0`, a negative number, or a value from 1970 is not an authentication that happened long ago — it
 * is a claim that did not survive whatever produced it. It is refused for the same reason a future one
 * is: this value only ever decides whether the desktop OFFERS a destructive action, and it must not do
 * so on the strength of a number nobody wrote. 2020-01-01, comfortably before this product existed.
 */
export const AUTH_TIME_FLOOR_MS = Date.UTC(2020, 0, 1);

/** Refresh this long before the token actually expires, so a call never races the boundary. */
const REFRESH_SKEW_MS = 60 * 1000;

/**
 * How long any one identity request may take, body included.
 *
 * F04: "Propagovat abort konkrétního toku a přidat konečné request timeouty včetně čtení body." Every
 * call here is a few hundred bytes each way against a global service; ten seconds is the same bound
 * the broker uses, for the same reason — a request with no end holds a busy flag, a retry budget and
 * a person.
 */
export const REQUEST_TIMEOUT_MS = 10_000;

/**
 * The largest response body this client will read.
 *
 * Every response here is a handful of short fields. Reading an unbounded one from a host that may not
 * be the host we think it is costs memory for nothing — plan §"Bezpečnostní hranice": "Odpovědi se
 * parsují s limitem velikosti".
 */
const MAX_RESPONSE_BYTES = 64 * 1024;

const ERROR_MAP: Record<string, AccountAuthErrorCode> = {
  // The sign-in link's own refusals.
  INVALID_OOB_CODE: "invalid-code",
  MISSING_OOB_CODE: "invalid-code",
  EXPIRED_OOB_CODE: "expired-code",
  INVALID_EMAIL: "invalid-email",
  MISSING_EMAIL: "invalid-email",
  // A request this project cannot serve. Every one of these is an operator problem.
  OPERATION_NOT_ALLOWED: "auth-unavailable",
  UNAUTHORIZED_DOMAIN: "auth-unavailable",
  INVALID_CONTINUE_URI: "auth-unavailable",
  MISSING_CONTINUE_URI: "auth-unavailable",
  INVALID_DYNAMIC_LINK_DOMAIN: "auth-unavailable",
  // The daily sending quota, which no retry loop can fix and which the user did not cause.
  QUOTA_EXCEEDED: "auth-unavailable",
  TOO_MANY_ATTEMPTS_TRY_LATER: "too-many-attempts",
  USER_DISABLED: "user-disabled",
  CREDENTIAL_TOO_OLD_LOGIN_AGAIN: "requires-recent-login",
  TOKEN_EXPIRED: "requires-recent-login",
  INVALID_ID_TOKEN: "requires-recent-login",
  // An address that already belongs to somebody. Deliberately NOT surfaced as a distinct outcome by
  // `requestLoginEmailChange` — see that method — but mapped here so nothing else guesses at it.
  EMAIL_EXISTS: "invalid-email",
};

/** Maps a Firebase error body onto a fixed code. The remote text is never carried through. */
export function mapAuthError(body: unknown): AccountAuthErrorCode {
  const message = (body as { error?: { message?: unknown } } | null)?.error?.message;
  if (typeof message !== "string") return "unknown";
  // Firebase appends a reason after a space (`INVALID_EMAIL : Bad email`).
  const head = message.split(/[\s:]/)[0] ?? "";
  return ERROR_MAP[head] ?? "unknown";
}

/** What `lookup` answers with. The uid is here because the caller has to compare it. */
export interface OwnerLookup {
  readonly uid: string;
  readonly email: string;
  readonly emailVerified: boolean;
}

export interface AccountClient {
  /**
   * Asks Firebase to email a one-time sign-in link.
   *
   * `continueUrl` is built by this backend from its own configuration (`authlink-config.ts`) and is
   * never taken from a renderer: it decides which host the person's browser hands the code to.
   */
  startEmailSignIn(email: string, continueUrl: string, options?: AccountCallOptions): Promise<void>;
  /**
   * Redeems the code. The address is the one this DESKTOP pinned, not one that came back from the web.
   *
   * It deliberately does NOT send `idToken`: that parameter means "link this email credential to the
   * currently signed-in user", which is an identity merge and not a sign-in (plan §6 step 7).
   */
  completeEmailSignIn(email: string, oobCode: string, options?: AccountCallOptions): Promise<OwnerSession>;
  /** A fresh id token for a session whose own has expired. Does NOT refresh `authenticatedAt`. */
  refresh(session: OwnerSession, options?: AccountCallOptions): Promise<OwnerSession>;
  /**
   * Starts a LOGIN-ADDRESS change: Firebase emails the NEW address and the change lands only when
   * that link is opened.
   */
  requestLoginEmailChange(session: OwnerSession, newEmail: string, options?: AccountCallOptions): Promise<void>;
  /** Re-reads the account from the server, including the uid the caller has to compare. */
  lookup(session: OwnerSession, options?: AccountCallOptions): Promise<OwnerLookup>;
}

export function createAccountClient(deps: AccountClientDeps): AccountClient {
  const doFetch: FetchLike = deps.fetchImpl ?? ((input, init) => fetch(input, init));
  const now = deps.now ?? (() => Date.now());

  async function post(
    method: string,
    payload: Record<string, unknown>,
    options?: AccountCallOptions,
  ): Promise<Record<string, unknown>> {
    // ONE DEADLINE PER REQUEST, disarmed only after the BODY has been read (F04). It is chained to the
    // flow's own signal, so cancelling a sign-in ends the requests it left in flight instead of
    // leaving them to resolve into a flow that no longer exists.
    const deadline = requestDeadline(REQUEST_TIMEOUT_MS, options?.signal);
    try {
      let response: Response;
      try {
        response = await doFetch(identityToolkitUrl(deps.config, method), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
          // A REDIRECT ON A CREDENTIAL REQUEST IS AN ERROR, NOT A HOP. These bodies carry a sign-in
          // code, an id token or both, and HTTP 307/308 preserves the method AND the body — so a
          // redirect would re-send the credential to whatever host the response named. Plan
          // §"Bezpečnostní hranice": "Nativní requesty nesoucí kód, tajemství nebo token používají
          // `redirect: 'error'`".
          redirect: "error",
          signal: deadline.signal,
        });
      } catch (error) {
        // A transport failure is its own code: a sign-in form that says "that code is wrong" when the
        // network is down teaches people to ask for a second link that will not help either. An
        // ABANDONED FLOW is not one of those, and says so — see `AccountCallOptions`.
        throw transportError(deadline, options?.signal, error);
      }
      const body = await readBoundedJsonBody(response, MAX_RESPONSE_BYTES);
      return acceptBody(response, body, deadline, options?.signal);
    } finally {
      deadline.dispose();
    }
  }

  /**
   * What a response body MEANS, by how it was read (R04).
   *
   *   - a stream that BROKE before it ended is a transport outcome, whatever the status line said and
   *     whether or not the timer had fired — HTTP 200 followed by half a body is not a confirmed send,
   *     and it used to become `{}` and be counted as one;
   *   - a refusal (non-2xx) is mapped from whatever body there is, as before;
   *   - a 2xx whose body is too large or not JSON is `malformed-response`: the service answered, this
   *     desktop cannot say what, and a caller that mutates treats it as unknown.
   */
  function acceptBody(
    response: Response,
    body: BoundedJson,
    deadline: { timedOut(): boolean },
    signal: AbortSignal | undefined,
  ): Record<string, unknown> {
    if (body.kind === "unreadable") throw transportError(deadline, signal);
    if (!response.ok) {
      throw new AccountAuthError(
        mapAuthError(body.kind === "ok" ? body.value : null),
        "the identity service refused the request.",
      );
    }
    if (body.kind !== "ok") {
      throw new AccountAuthError(
        "malformed-response",
        "the identity service answered with a body this desktop could not read.",
      );
    }
    return body.value;
  }

  /** Which of the two transport outcomes this was: the caller stopped waiting, or nothing answered. */
  function transportError(deadline: { timedOut(): boolean }, signal?: AbortSignal, cause?: unknown): AccountAuthError {
    if (signal?.aborted === true && !deadline.timedOut()) {
      return new AccountAuthError("aborted", "the flow that made this request was abandoned.");
    }
    return new AccountAuthError(
      "network",
      "the identity service could not be reached.",
      cause === undefined ? null : classifyNetworkError(cause),
    );
  }

  /**
   * Builds the session from a sign-in response, requiring every field it needs.
   *
   * NO FALLBACK, AND NO PARTIAL SESSION. The old parser filled missing fields from a previous session
   * and coerced everything through `String(...)`, so an incomplete response produced an object that
   * looked like a session and carried an empty token — which then failed much later, somewhere that
   * could not say why. An answer that does not contain a token, a refresh token, a uid and an address
   * is not a sign-in.
   *
   * `emailVerified` is deliberately NOT read from here. The REST contract for `signInWithEmailLink`
   * does not document the field (plan §2), so believing it would mean believing something the service
   * does not promise to send; the caller asks `lookup` instead, and that is also where the uid is
   * cross-checked.
   */
  function sessionFromEmailLink(body: Record<string, unknown>, pinnedEmail: string): OwnerSession {
    const idToken = requireString(body["idToken"]);
    const refreshToken = requireString(body["refreshToken"]);
    const uid = requireString(body["localId"]);
    if (idToken === null || refreshToken === null || uid === null) {
      throw new AccountAuthError("unknown", "the identity service returned an incomplete session.");
    }
    const expiresIn = Number(body["expiresIn"] ?? 3600);
    return {
      idToken,
      refreshToken,
      uid,
      // THE ADDRESS THIS DESKTOP PINNED, not the one the response echoed. They are normally the same;
      // when they are not, the local one is the only one a person actually typed here.
      email: pinnedEmail,
      emailVerified: false,
      expiresAt: now() + (Number.isFinite(expiresIn) ? expiresIn : 3600) * 1000,
      // A redeemed link IS the proof of identity, so this is the one call that sets it — and it is
      // taken from the TOKEN's own `auth_time` and from nowhere else (plan §7, F08). The server
      // enforces the real `auth_time` on the validated token, so a desktop whose clock is fast would
      // otherwise offer a destructive action the server is about to refuse, and one whose clock is
      // slow would ask for a new link it does not need. A token that does not carry a usable one
      // leaves this NULL: the desktop then knows it cannot say, rather than saying "just now".
      authenticatedAt: readIdTokenClaims(idToken, now()).authTime,
    };
  }

  return {
    async startEmailSignIn(email, continueUrl, options) {
      await post(
        "sendOobCode",
        {
          requestType: "EMAIL_SIGNIN",
          email,
          continueUrl,
          // Firebase requires this for an email-link sign-in; without it the link is treated as a
          // plain web action and the code does not travel to `continueUrl`.
          canHandleCodeInApp: true,
        },
        options,
      );
    },

    async completeEmailSignIn(email, oobCode, options) {
      const body = await post("signInWithEmailLink", { email, oobCode }, options);
      return sessionFromEmailLink(body, email);
    },

    async refresh(session, options) {
      const deadline = requestDeadline(REQUEST_TIMEOUT_MS, options?.signal);
      try {
        let response: Response;
        try {
          response = await doFetch(secureTokenUrl(deps.config), {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: session.refreshToken }).toString(),
            redirect: "error",
            signal: deadline.signal,
          });
        } catch (error) {
          throw transportError(deadline, options?.signal, error);
        }
        const body = acceptBody(
          response,
          await readBoundedJsonBody(response, MAX_RESPONSE_BYTES),
          deadline,
          options?.signal,
        );
        const idToken = requireString(body["id_token"]);
        if (idToken === null) throw new AccountAuthError("unknown", "the refreshed session carried no token.");
        return {
          ...session,
          idToken,
          refreshToken: requireString(body["refresh_token"]) ?? session.refreshToken,
          expiresAt: now() + Number(body["expires_in"] ?? 3600) * 1000,
          // NOT refreshed: a new id token is not a new proof that the person is at the keyboard. The
          // field is carried through from `session` by the spread above, deliberately and not by
          // accident — a refresh that re-read `auth_time` from the NEW token would move the window
          // every hour, which is the one thing the five-minute rule exists to stop (F08).
        };
      } finally {
        deadline.dispose();
      }
    },

    async requestLoginEmailChange(session, newEmail, options) {
      if (!hasRecentAuth(session, now())) {
        throw new AccountAuthError("requires-recent-login", "changing the login email needs a fresh sign-in.");
      }
      // `VERIFY_AND_CHANGE_EMAIL`, NOT an `update` that sets the address (plan §2, §7). A direct
      // change puts the new address on the account before anybody has proved they can read it — so a
      // typo locks the person out of their own account, and with email-enumeration protection on,
      // Firebase refuses the direct call anyway. This way the OLD address keeps working until the new
      // mailbox is opened.
      try {
        await post(
          "sendOobCode",
          { requestType: "VERIFY_AND_CHANGE_EMAIL", idToken: session.idToken, newEmail },
          options,
        );
      } catch (error) {
        // AN ADDRESS THAT IS ALREADY TAKEN IS NOT REPORTED AS ONE (plan §7). Answering differently for
        // an occupied address turns this into a way to ask whether somebody has an account here. The
        // caller shows "check the new mailbox" either way, which is also the truthful sentence: a
        // successful send is not evidence a message arrived.
        if (error instanceof AccountAuthError && error.code === "invalid-email") return;
        throw error;
      }
    },

    async lookup(session, options) {
      const body = await post("lookup", { idToken: session.idToken }, options);
      const users = body["users"];
      const user = Array.isArray(users) ? (users[0] as Record<string, unknown> | undefined) : undefined;
      const uid = requireString(user?.["localId"]);
      if (uid === null) throw new AccountAuthError("unknown", "the identity service returned no account.");
      return {
        uid,
        email: requireString(user?.["email"]) ?? session.email,
        emailVerified: user?.["emailVerified"] === true,
      };
    },
  };
}

/** The three claims this desktop reads out of an id token, each of them possibly absent. */
export interface IdTokenClaims {
  /** `auth_time` in epoch milliseconds, or null when it is missing, malformed or nonsensical. */
  readonly authTime: number | null;
  /** `sub` — the uid the token itself names, for cross-checking against the response's `localId`. */
  readonly subject: string | null;
  /** `email_verified`, or null when the token does not carry it. Null is not `false`. */
  readonly emailVerified: boolean | null;
}

/**
 * The claims of an id token, READ AND NOT VERIFIED.
 *
 * NOTHING IS AUTHORISED BY THIS. The signature is not checked here and cannot be — the server checks
 * the same claims on a token it has verified, and that is the authorisation. What this decides is
 * strictly local: whether the desktop OFFERS a destructive action or asks for a fresh link first, and
 * whether two things that came back from the same sign-in agree with each other. A local decode of a
 * JWT is not a substitute for server-side validation and must never be treated as one (F08).
 *
 * WHAT MAKES AN `auth_time` USABLE, and why each of these is refused rather than fixed up:
 *
 *   - MISSING or NOT A NUMBER — the token does not say. Substituting `now()` was the defect: it turns
 *     the absence of the evidence into the evidence.
 *   - NOT FINITE — `Infinity` and `NaN` both survive a `typeof === "number"` test, and `Infinity`
 *     passes a "was this within five minutes" comparison for ever.
 *   - IN THE FUTURE beyond {@link AUTH_TIME_FUTURE_TOLERANCE_MS} — a future authentication never ages
 *     out of the window, so it is permanent recent-auth. A couple of minutes is clock skew; more is
 *     not a clock.
 *   - BEFORE {@link AUTH_TIME_FLOOR_MS} — a zero or a 1970 value is a claim that did not survive
 *     whatever produced it, not an old sign-in.
 *
 * `now` is passed in rather than read here so the comparison uses the same clock as the caller's.
 */
export function readIdTokenClaims(idToken: string, now: number): IdTokenClaims {
  const absent: IdTokenClaims = { authTime: null, subject: null, emailVerified: null };
  const payload = idToken.split(".")[1];
  if (!payload) return absent;
  let claims: { auth_time?: unknown; sub?: unknown; email_verified?: unknown };
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as typeof claims;
  } catch {
    return absent;
  }
  if (typeof claims !== "object" || claims === null) return absent;
  return {
    authTime: usableAuthTime(claims.auth_time, now),
    subject: typeof claims.sub === "string" && claims.sub.length > 0 ? claims.sub : null,
    emailVerified: typeof claims.email_verified === "boolean" ? claims.email_verified : null,
  };
}

function usableAuthTime(raw: unknown, now: number): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  const authTime = raw * 1000;
  if (!Number.isFinite(authTime)) return null;
  if (authTime < AUTH_TIME_FLOOR_MS) return null;
  if (authTime > now + AUTH_TIME_FUTURE_TOLERANCE_MS) return null;
  return authTime;
}

/** A non-empty string, or null. Never a `String(undefined)` that reads as a value downstream. */
function requireString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Whether a session's sign-in proof is still recent enough for a destructive action.
 *
 * A session with no proven `authenticatedAt` is NOT recent (F08). "The token did not say when this
 * person authenticated" is a reason to ask for a fresh link, never a reason to act.
 */
export function hasRecentAuth(session: OwnerSession, now: number): boolean {
  if (session.authenticatedAt === null) return false;
  return now - session.authenticatedAt <= RECENT_AUTH_WINDOW_MS;
}

/** Whether a session's id token needs refreshing before the next call. */
export function needsRefresh(session: OwnerSession, now: number): boolean {
  return session.expiresAt - now <= REFRESH_SKEW_MS;
}
