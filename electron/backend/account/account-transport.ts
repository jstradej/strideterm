// The account callables, as a narrow port.
//
// SEPARATE FROM `MobileFirebaseTransport` because the two speak for different identities. That one
// runs under the INSTALLATION session — it owns this machine's pairs and its relay connector — and
// these run under whichever session the account flow is currently proving something with: the
// installation session for the challenge leg, and a freshly verified OWNER session for everything
// else. Collapsing them would mean the account calls silently used whichever token happened to be
// cached, which is precisely the confusion the two-leg installation handshake exists to prevent.
//
// A PORT, so the manager's tests need no network and no Firebase project. The live adapter below is
// a direct passthrough with no logic of its own to get wrong.

import { callableUrl, type MobileFirebaseConfig } from "../mobile/mobile-firebase-config.js";
import { classifyNetworkError, type NetworkFailureKind } from "../net/network-error.js";
import {
  AccountNoticeAckResponseSchema,
  AccountOverviewSchema,
  AccountRevokeResponseSchema,
  AccountDeletionResponseSchema,
  CheckoutResponseSchema,
  ConfirmOwnerResponseSchema,
  EnsureAccountResponseSchema,
  InstallationChallengeResponseSchema,
  InstallationRegistrationResponseSchema,
  PortalSessionResponseSchema,
  TrialStartResponseSchema,
  type AccountNoticeAckResponse,
  type AccountOverview,
  type AccountRevokeResponse,
  type AccountDeletionResponse,
  type CheckoutResponse,
  type ConfirmOwnerResponse,
  type EnsureAccountResponse,
  type InstallationChallengeResponse,
  type InstallationRegistrationResponse,
  type PortalSessionResponse,
  type TrialStartResponse,
} from "../mobile/mobile-schemas.js";
import type { DiagnosticsReport } from "./account-diagnostics.js";
import { readBoundedJsonBody, requestDeadline } from "./bounded-http.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * How long one callable may take, body included.
 *
 * F04. These are ordinary control-plane calls against Cloud Functions; a cold start is the slow case
 * and it is seconds, not minutes. Twenty is generous for that and still finite, which is the property
 * that matters: a call with no end holds the busy flag, the retry budget and the person.
 */
export const CALLABLE_TIMEOUT_MS = 20_000;

/**
 * The largest callable response this desktop will read.
 *
 * The account overview is the biggest of them and is a few kilobytes. `response.json()` — which is
 * what this used to call — has no bound at all, so a compromised or broken endpoint could hand this
 * process as much memory as it cared to allocate before anything looked at the value.
 */
const MAX_RESPONSE_BYTES = 256 * 1024;

/** What the diagnostics door answers with. An opaque reference and a count, and nothing else. */
export interface DiagnosticsSubmission {
  readonly reportId: string;
  readonly entryCount: number;
}

/** Which identity a call is made as. Named rather than implied — see the module header. */
export type AccountCallerKind = "installation" | "owner";

export class AccountCallableError extends Error {
  /** The server's own refusal reason, from its closed set. Never free text shown to a user. */
  readonly reason: string;
  readonly status: number;
  /** For `network` only: which kind of transport failure it was (TLS inspection above all). */
  readonly detail: NetworkFailureKind;

  constructor(reason: string, status: number, detail: NetworkFailureKind = null) {
    super(`account callable rejected: ${reason}`);
    this.name = "AccountCallableError";
    this.reason = reason;
    this.status = status;
    this.detail = detail;
  }
}

/**
 * Which cap a `resource-exhausted` rejection named, as this desktop's own error code.
 *
 * A CAP IS NOT ONE PROBLEM, and `cap-exceeded` on its own is not a sentence anybody can act on:
 * "this account already has five desktops" and "this desktop already has three phones" are fixed in
 * two different places. The server carries the cap name for exactly that reason
 * (`account.schema.json#CapExhaustedErrorDetails`), and dropping it here — which is what reading only
 * `details.reason` did — threw the distinction away one line before the UI needed it.
 *
 * An unrecognised cap falls back to the generic `cap-exceeded`, which has copy of its own: the
 * server's set may grow, and a desktop that has not been updated must still say "a limit was
 * reached" rather than "that did not work".
 */
function capReason(details: { reason?: unknown; cap?: unknown } | undefined): string | null {
  if (details?.reason !== "cap-exceeded") return null;
  switch (details.cap) {
    case "installations":
      return "installation-limit";
    case "mobileDevices":
      return "mobile-device-limit";
    case "pairedMobileDevices":
      return "pairing-device-limit";
    default:
      return "cap-exceeded";
  }
}

/**
 * What every call under an operation carries besides its payload (S02).
 *
 * The manager's operation scope has an `AbortController`, and until now only the owner verification
 * was handed its signal. The mutations were not: a cancel during `beginInstallationRegistration` ended
 * the scope, and the request went out anyway once the token it was waiting for arrived, because the
 * transport's await on `tokenFor` is an asynchronous boundary the manager's guard before the call does
 * not cover. Passed OUTSIDE the wire payload, so nothing about it reaches the server.
 */
export interface AccountCallOptions {
  /** The operation's signal: nothing is sent once it has fired, and what was sent is abandoned. */
  readonly signal?: AbortSignal;
}

export interface AccountTransport {
  ensureAccount(idempotencyKey: string, options?: AccountCallOptions): Promise<EnsureAccountResponse>;
  beginInstallationRegistration(
    args: {
      installationId: string;
      publicKey: string;
      label?: string;
    },
    options?: AccountCallOptions,
  ): Promise<InstallationChallengeResponse>;
  completeInstallationRegistration(
    args: {
      challengeId: string;
      signature: string;
      idempotencyKey: string;
      label?: string;
      /**
       * `recover-uid`, exactly as the generated request contract spells it.
       *
       * It used to be `recover` here, and the server's schema accepts only `register` or `recover-uid`
       * — so the recovery leg was refused as a malformed request against a correct backend, and the
       * one path that exists for a desktop that lost its refresh token could never run.
       */
      mode: "register" | "recover-uid";
      pairHints?: readonly string[];
    },
    options?: AccountCallOptions,
  ): Promise<InstallationRegistrationResponse>;
  startTrial(
    args: { installationId: string; idempotencyKey: string },
    options?: AccountCallOptions,
  ): Promise<TrialStartResponse>;
  /**
   * Asks the SERVER whether the freshly signed-in owner owns the account this machine belongs to.
   *
   * It exists because a sign-in link proves an address and nothing else. `getAccountOverview` cannot
   * answer the question — it runs under the INSTALLATION session, so a successful call says the
   * machine is bound and says nothing about who just signed in — and comparing two addresses in a
   * renderer proves less again. Runs as the OWNER, and its answer is `confirmed` or a sanitized
   * refusal that names no identity.
   */
  confirmOwnerForInstallation(args: {
    installationId: string;
    /**
     * The CANDIDATE's id token, named rather than fetched (F02).
     *
     * Every other owner call here asks the manager for "the owner", and at this point in the flow
     * there is no owner — this call is what decides whether there will be one. Publishing the
     * candidate as the owner session so that `tokenFor("owner")` could find it is exactly the escape
     * the plan describes: a session usable by ordinary account operations before its binding has been
     * checked. So this one call is handed the one token it needs, and nothing else can reach it.
     */
    ownerIdToken: string;
    /** The flow's abort signal: a cancelled sign-in does not leave this call outstanding. */
    signal?: AbortSignal;
  }): Promise<ConfirmOwnerResponse>;
  getAccountOverview(): Promise<AccountOverview>;
  createCheckout(
    args: { offerId: string; installationId: string; idempotencyKey: string },
    options?: AccountCallOptions,
  ): Promise<CheckoutResponse>;
  createPortalSession(args: { installationId: string }, options?: AccountCallOptions): Promise<PortalSessionResponse>;
  revokeAccountDevice(
    args: {
      kind: "installation" | "mobile-device" | "pair" | "account-wide";
      targetId?: string;
      idempotencyKey: string;
    },
    options?: AccountCallOptions,
  ): Promise<AccountRevokeResponse>;
  acknowledgeNotice(noticeId: string, options?: AccountCallOptions): Promise<AccountNoticeAckResponse>;
  /**
   * The desktop's opt-in diagnostics door — `submitDesktopDiagnosticsReport`, not the phone's.
   *
   * A SEPARATE CALLABLE on purpose: the phone's enforces App Check, and must; an Electron process has
   * no attestation provider, and the only token it could present would be a shared secret embedded in
   * a public download. `enforceAppCheck` is an option on the callable rather than a per-request
   * decision, so the two doors differ in that one option and share every line of their body.
   */
  submitDiagnostics(report: DiagnosticsReport): Promise<DiagnosticsSubmission>;
  deleteAccount(
    args: { confirmationPhrase: string; idempotencyKey: string },
    options?: AccountCallOptions,
  ): Promise<AccountDeletionResponse>;
}

export interface AccountTransportDeps {
  readonly config: MobileFirebaseConfig;
  /**
   * The id token for the identity a given call must be made as.
   *
   * `signal` is the calling operation's (S02): a producer that refreshes before answering can stop when
   * the operation has ended, and must not answer with a token that belongs to a newer sign-in. The
   * transport re-checks the signal after this await either way — see `call`.
   */
  readonly tokenFor: (kind: AccountCallerKind, signal?: AbortSignal) => Promise<string>;
  readonly fetchImpl?: FetchLike;
}

/** A parser for one call's response. `undefined` for the calls whose body is ours, not the server's. */
type ResponseParser<T> = { safeParse(value: unknown): { success: boolean; data?: T } };

/**
 * Which credential a call is made with: one of the two named identities, or one explicit token.
 *
 * The explicit form exists for exactly one caller — `confirmOwnerForInstallation` with a candidate
 * session — and it is a union rather than an extra optional parameter so that the two cases cannot be
 * confused at a call site: either the transport resolves the identity, or the caller names the token.
 */
type CallerIdentity = AccountCallerKind | { readonly idToken: string };

/** Read at the moment of asking — an await sits between the two asks in `call`, so it may have changed. */
function hasFired(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

export function createAccountTransport(deps: AccountTransportDeps): AccountTransport {
  const doFetch: FetchLike = deps.fetchImpl ?? ((input, init) => fetch(input, init));

  /**
   * One call, and its response is PARSED rather than cast.
   *
   * The old body did `return body?.result as T`, which is a promise to the compiler and nothing at
   * all at runtime. It is the reason a malformed or compromised response could put an arbitrary
   * string into `checkoutUrl` and have it reach `shell.openExternal`: every field downstream was
   * typed and none of it was checked. A response that does not match the generated contract is a
   * refusal (`malformed-response`), not a value.
   */
  async function call<T>(
    name: string,
    as: CallerIdentity,
    data: unknown,
    parse?: ResponseParser<T>,
    options?: AccountCallOptions,
  ): Promise<T> {
    // NOTHING IS SENT FOR AN OPERATION THAT HAS ALREADY ENDED (S02). The manager checks its scope
    // before calling, and then this function AWAITS a token — a refresh of the installation session
    // can take seconds — so the cancel, the closed panel or the newer sign-in that arrived in between
    // used to be followed by a brand-new mutation request going out for a scope nobody wanted. The
    // check is after the await, which is the boundary the manager's own guard cannot see.
    if (hasFired(options?.signal)) throw new AccountCallableError("aborted", 0);
    const token = typeof as === "string" ? await deps.tokenFor(as, options?.signal) : as.idToken;
    if (hasFired(options?.signal)) throw new AccountCallableError("aborted", 0);
    const deadline = requestDeadline(CALLABLE_TIMEOUT_MS, options?.signal);
    try {
      return await callWithin(name, token, data, deadline, options?.signal, parse);
    } finally {
      deadline.dispose();
    }
  }

  async function callWithin<T>(
    name: string,
    token: string,
    data: unknown,
    deadline: { signal: AbortSignal; timedOut(): boolean },
    external: AbortSignal | undefined,
    parse?: ResponseParser<T>,
  ): Promise<T> {
    let response: Response;
    try {
      response = await doFetch(callableUrl(deps.config, name), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ data }),
        // F05. THIS REQUEST CARRIES A BEARER TOKEN, and 307/308 preserve the method AND the body — so
        // following a redirect means re-sending an owner or installation credential to whatever host
        // the response named. The Firebase client and the auth broker have refused redirects since
        // they were written; this transport did not, and it is the one that carries the longest-lived
        // credential of the three. Not "unlikely to matter": the whole point of an exact-host contract
        // is that it does not depend on a redirect being benign.
        redirect: "error",
        signal: deadline.signal,
      });
    } catch (error) {
      // THE OPERATION ENDED, or the network did — two different sentences (S02). Both leave the
      // server's state unknown, and the manager keeps the idempotency key for both; only the first is
      // the person's own doing, and is reported to them as such rather than as an outage.
      if (abandoned(external, deadline)) throw new AccountCallableError("aborted", 0);
      throw new AccountCallableError("network", 0, classifyNetworkError(error));
    }
    // BOUNDED, and read through the same deadline as the request (F04). `response.json()` reads
    // whatever arrives, for as long as it keeps arriving.
    const read = await readBoundedJsonBody(response, MAX_RESPONSE_BYTES);
    // A STREAM THAT BROKE IS A TRANSPORT OUTCOME (R04) — whether the deadline fired, the flow was
    // abandoned, or the connection simply dropped mid-body. It used to count as `network` only in the
    // first two cases; in the third an HTTP 200 with half a body was `malformed-response`, which the
    // manager read as a definite refusal and dropped the idempotency key on.
    if (read.kind === "unreadable") {
      throw new AccountCallableError(abandoned(external, deadline) ? "aborted" : "network", 0);
    }
    const body =
      read.kind === "ok"
        ? (read.value as {
            result?: unknown;
            error?: { message?: unknown; status?: unknown; details?: { reason?: unknown; cap?: unknown } };
          })
        : null;
    if (!response.ok || body?.error) {
      // The reason comes from OUR server's closed set — `<callable> rejected: <reason>` — and
      // nothing else in the message is used. A remote string shown to a user is a string another
      // system writes and can change without warning.
      const message = typeof body?.error?.message === "string" ? body.error.message : "";
      const detail = body?.error?.details?.reason;
      const match = /rejected:\s*([a-z-]+)/.exec(message);
      throw new AccountCallableError(
        capReason(body?.error?.details) ||
          (typeof detail === "string" && detail) ||
          match?.[1] ||
          String(body?.error?.status ?? "unknown"),
        response.status,
      );
    }
    // A 2xx WHOSE BODY IS NOT A JSON OBJECT, or is larger than any answer of ours, is an answer this
    // desktop cannot read (R04): `malformed-response`, which the manager keeps the mutation key on,
    // because the server may well have done what was asked and said so in bytes that were not read.
    if (body === null) throw new AccountCallableError("malformed-response", response.status);
    if (parse === undefined) return body.result as T;
    const parsed = parse.safeParse(body.result);
    if (!parsed.success || parsed.data === undefined) {
      // The SAME shape as a refusal, so every caller's existing error mapping covers it. A response
      // the contract does not describe is not a partial success to be read field by field.
      throw new AccountCallableError("malformed-response", response.status);
    }
    return parsed.data;
  }

  /** Whether the caller's own signal, and not the deadline, is why a request stopped. */
  function abandoned(external: AbortSignal | undefined, deadline: { timedOut(): boolean }): boolean {
    return hasFired(external) && !deadline.timedOut();
  }

  return {
    // The challenge leg runs as the INSTALLATION: the server records that caller's uid on the
    // challenge, so the owner leg cannot choose which installation it is registering.
    beginInstallationRegistration: (args, options) =>
      call("beginInstallationRegistration", "installation", args, InstallationChallengeResponseSchema, options),
    // The OWNER's, because the server requires a verified email on each of them.
    ensureAccount: (idempotencyKey, options) =>
      call("ensureAccount", "owner", { idempotencyKey }, EnsureAccountResponseSchema, options),
    completeInstallationRegistration: (args, options) =>
      call("completeInstallationRegistration", "owner", args, InstallationRegistrationResponseSchema, options),
    startTrial: (args, options) => call("startTrial", "owner", args, TrialStartResponseSchema, options),
    confirmOwnerForInstallation: ({ installationId, ownerIdToken, signal }) =>
      call(
        "confirmOwnerForInstallation",
        { idToken: ownerIdToken },
        { installationId },
        ConfirmOwnerResponseSchema,
        signal === undefined ? undefined : { signal },
      ),
    // THE INSTALLATION's, not the owner's (I3): the server authorizes billing against this desktop's
    // own active installation record, so a live owner sign-in is not required to open checkout or the
    // portal, and stays open after any owner session has expired. The server's separate owner path
    // (`requireBillingAuthorization`'s path a) exists for other callers of the same callables; the
    // desktop always has its own long-lived installation session and uses that one.
    createCheckout: (args, options) => call("createCheckout", "installation", args, CheckoutResponseSchema, options),
    createPortalSession: (args, options) =>
      call("createPortalSession", "installation", args, PortalSessionResponseSchema, options),
    deleteAccount: (args, options) => call("deleteMyAccount", "owner", args, AccountDeletionResponseSchema, options),
    // THE INSTALLATION's, because the server resolves these two through a BOUND uid and does not
    // require a verified owner (`bound-account-recovery`) — `getAccountOverview` reads
    // `requireBoundAccount` only, and `acknowledgeAccountNotice` below is documented server-side as
    // "deliberately NOT `requireVerifiedOwner`: a phone acknowledges its own account notices too, and
    // a phone has no owner login." That is what lets the account page render from a persistent
    // installation session — so a desktop does not have to hold a long-lived owner credential just to
    // show its own state after a restart.
    getAccountOverview: () => call("getAccountOverview", "installation", {}, AccountOverviewSchema),
    // THE OWNER's — NOT the installation's (a real bug this fixes: `revoke-account-device.ts` calls
    // `requireVerifiedOwner` FIRST, before it ever looks at `kind`, for every one of the four kinds —
    // installation, mobile-device, pair and account-wide alike. The installation session is
    // Firebase's own ANONYMOUS sign-in (`mobile-firebase-rest.ts`'s `signInAnonymously`), which never
    // carries `email_verified: true`, so sending it here always reached the server's refusal and
    // never once revoked anything — including the desktop's OWN self-revoke inside
    // `signOutInstallation`, which therefore never actually disconnected either. A caller must have
    // (or obtain) a live owner session before this can succeed; `AccountManagerError("invalid-credentials")`
    // is what a missing one already surfaces as, the same code `SettingsAccountTab.vue` already shows
    // "Ask for a new link" for.
    revokeAccountDevice: (args, options) =>
      call("revokeAccountDevice", "owner", args, AccountRevokeResponseSchema, options),
    acknowledgeNotice: (noticeId, options) =>
      call("acknowledgeAccountNotice", "installation", { noticeId }, AccountNoticeAckResponseSchema, options),
    submitDiagnostics: (report) => call("submitDesktopDiagnosticsReport", "installation", report),
  };
}
