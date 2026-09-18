// What the renderer is allowed to know about the account, and how it is derived.
//
// Pure: no Electron, no network, no clock of its own. Every decision here is one that must be the
// same in every window and after a restart, which is exactly the kind that goes wrong when it is
// computed in a component.
//
// WHAT IS DELIBERATELY NOT IN THE BROADCAST STATE, and this list is the design:
//
//   - NO TOKENS of any kind — not the owner id token, not its refresh token, not a relay grant.
//   - NO SIGN-IN CODE AND NO CLAIM SECRET. A passwordless attempt has both in the backend for a few
//     minutes; neither has any business in a payload every window renders and every state dump
//     carries. What IS here is the address the link went to, the deadline and when a resend becomes
//     available — the three things a person waiting for an email actually needs.
//   - NO PASSWORD, and no field that could carry one. There is no password in this product at all.
//   - NO CLAIMS. The renderer must never derive entitlement from something it holds; it renders what
//     the server said, and the server is the only party that decides.
//   - NO PROVIDER IDENTIFIERS. A Paddle customer or subscription id in a state diff is a merchant
//     identifier in every window's memory and in every log line that dumps state.
//   - NO CHECKOUT OR PORTAL URL. Those are one-shot return values of the call that asked for them; a
//     portal URL in broadcast state is a live credential handed to everything that can read state.
//   - NO INTERNAL ACCOUNT ID. `supportReference` is the thing a person quotes, and it is derived and
//     rotatable; the opaque account id is not for showing.

import type { AccountOverview, EntitlementSummary } from "../mobile/mobile-schemas.js";

/** Where the account flow currently is, as one value the UI switches on. */
export type AccountPhase =
  /** No Firebase configuration at all. The whole hosted feature is absent, not broken. */
  | "unconfigured"
  /** Configured, nobody signed in. One email field and one button. */
  | "signed-out"
  /**
   * A sign-in link is in flight for a machine that is NOT enrolled yet.
   *
   * It replaced `verification-pending`, which described a state that no longer exists: with a link,
   * redeeming it IS the verification, so there is no signed-in-but-unverified owner to wait for. What
   * remains to wait for is the link itself, and `auth` says which part of that wait it is.
   */
  | "signing-in"
  /** Signed in, and this machine is not part of the account yet. */
  | "enrolling"
  /** Enrolled, and the server says what the entitlement is. */
  | "ready";

/** The sanitized substate of an attempt. Mirrors the broker's own, minus everything secret. */
export interface AccountAuthState {
  readonly phase: "sending" | "awaiting-link" | "awaiting-confirmation" | "verifying";
  /**
   * The address the link was sent to.
   *
   * IT IS NOT AN `ownerEmail`, and the two are separate fields for that reason (plan §8, Fáze 2:
   * "`pendingLoginEmail` není nová platná `ownerEmail`"). Nobody has proved anything yet; this is the
   * address a person typed, echoed back so they can see whether they typed it correctly.
   */
  readonly email: string;
  readonly purpose: string;
  readonly expiresAt: number;
  readonly canResendAt: number;
  /** The broker was unreachable when the attempt started: it can only be finished by pasting. */
  readonly manualOnly: boolean;
  readonly sendsUsed: number;
  /**
   * Whether the send request was ANSWERED, or went out with no answer coming back (F03).
   *
   * `unknown` is the state the UI must not round off to either of its neighbours: the message may be
   * in the mailbox and the attempt is still completable, so "sent" would be a claim this desktop
   * cannot make and "failed" would send somebody to ask for a second link that invalidates the first.
   */
  readonly sendOutcome: "sent" | "unknown";
}

export interface AccountUiState {
  readonly phase: AccountPhase;
  /**
   * The signed-in address, shown so somebody can tell WHICH account this is.
   *
   * Present only when signed in, and it is the LOGIN address. The billing address is Paddle's and is
   * changed there — the UI says so, because two addresses that look like one is how somebody changes
   * the wrong one.
   */
  readonly ownerEmail?: string;
  /**
   * Whether THIS machine is enrolled on an account.
   *
   * In the state rather than implied by the phase, because the two came apart when the owner session
   * became transient: an enrolled desktop with no owner credential is `ready` and has no
   * `ownerEmail`, and the runtime's own anonymous-fallback guard has to be able to ask this question
   * without asking about a sign-in. It says nothing about entitlement — that is `entitlement`, and
   * it is the server's answer.
   */
  readonly installationRegistered: boolean;
  /**
   * The signed-in owner's address is not verified yet.
   *
   * A BANNER, not a phase. It used to be the `verification-pending` phase, which stopped the account
   * page rendering at all — and that conflated two different facts once the owner session became
   * transient: "the owner has to click a link" and "this machine cannot work". A desktop that is
   * enrolled and entitled keeps working while its owner verifies a NEW login address, and the person
   * still has to be told. Absent when no owner session is held, which is the ordinary case.
   */
  readonly ownerVerificationPending?: boolean;
  /**
   * The sign-in attempt in flight, if any.
   *
   * A SEPARATE FIELD RATHER THAN A PHASE, because a desktop that is already enrolled stays `ready`
   * while its owner reauthenticates (plan §8, Fáze 2: "Již zaregistrovaný desktop zůstává `ready`;
   * reauth ani čekání na změnu adresy nesmí skrýt přehled a zařízení"). Hiding the device list behind
   * a sign-in form is how somebody loses the page that would have told them which machine to remove.
   */
  readonly auth?: AccountAuthState;
  /**
   * A login-address change that has been requested and not confirmed.
   *
   * Informational, and not persisted: after a restart it is gone, because the only party that knows
   * whether the new mailbox was opened is Firebase. The UI says "waiting for confirmation", never
   * "changed".
   */
  readonly pendingEmailChange?: { readonly email: string; readonly requestedAt: number };
  /**
   * Whether a NEW owner sign-in can be started at all.
   *
   * False when this build has no auth-link configuration. It does not mean the account is broken: an
   * enrolled desktop keeps working, keeps its devices and keeps its entitlement — it simply cannot
   * begin a new owner sign-in until the configuration is there.
   */
  readonly signInAvailable: boolean;
  /**
   * WHICH backend a new sign-in would go to, when one can be started at all.
   *
   * `local`, `dev`, `qa` or `prod`. In the state because F11 made the environment an explicit
   * declaration rather than something inferred from where the files are, and a declaration nobody can
   * read is a declaration nobody can check — a desktop signed in to qa looks exactly like one
   * signed in to prod otherwise, which is how a test address ends up in a real account.
   *
   * It is not a secret and it authorises nothing: the origin it implies is fixed in
   * `authlink-config.ts`, and the renderer cannot change either.
   */
  readonly authEnvironment?: "local" | "dev" | "qa" | "prod";
  /**
   * WHY no sign-in can be started, when none can.
   *
   * The fixed refusal code from `resolveAuthLinkConfig` — a dev build with no broker origin named, a
   * contradictory `STRIDETERM_ENV`, an environment with no deployed broker, or no Firebase
   * configuration at all. It used to be handed to the manager and dropped on the floor, so the page
   * could say "sign-in is not available" and nothing else; four different operator problems with one
   * sentence between them is a support conversation that starts from nothing.
   */
  readonly signInUnavailableReason?: string;
  readonly entitlement?: EntitlementSummary;
  /** The last sanitized overview. Rebuilt by a refresh, never assembled in the renderer. */
  readonly overview?: AccountOverview;
  /** A fixed code, never remote text. */
  readonly lastError?: string;
  /** True while a request is in flight, so the UI can disable rather than double-submit. */
  readonly busy: boolean;
  /** Whether a destructive action would need a fresh sign-in right now. */
  readonly needsRecentAuth: boolean;
  /**
   * The reference for the last diagnostics report this installation sent, for the user to quote.
   *
   * An opaque `rep-...` id that authorizes nothing and carries nothing about them — the same
   * reasoning as `supportReference`. It is in the broadcast state rather than only in the return
   * value so a second window, and the window after a reopen, can still show what to quote.
   */
  readonly lastDiagnosticsReportId?: string;
}

/**
 * No control plane at all — or one that was REFUSED (R06), which is the same state with a reason.
 *
 * A contradictory Firebase configuration leaves the manager unconfigured, and a page that only said
 * "unconfigured" would send the operator looking for a missing variable when the problem is one too
 * many. The reason is the resolver's own code, carried into the state exactly as it is for a build
 * that has a control plane and no broker.
 */
export function unconfiguredState(signInUnavailableReason?: string | null): AccountUiState {
  return {
    phase: "unconfigured",
    busy: false,
    needsRecentAuth: true,
    installationRegistered: false,
    signInAvailable: false,
    ...(signInUnavailableReason ? { signInUnavailableReason } : {}),
  };
}

export function signedOutState(lastError?: string): AccountUiState {
  return {
    phase: "signed-out",
    busy: false,
    needsRecentAuth: true,
    installationRegistered: false,
    signInAvailable: true,
    ...(lastError === undefined ? {} : { lastError }),
  };
}

export interface AccountStateInput {
  readonly configured: boolean;
  /**
   * `authenticatedAt` is NULLABLE, and null is not "a long time ago" — it is "the token did not say".
   *
   * Both answers produce `needsRecentAuth: true` below, which is the point: F08's rule is that an
   * unproven authentication time grants no local permission, and the derivation must not have a
   * branch where a missing value becomes a fresh one.
   */
  readonly owner: {
    readonly email: string;
    readonly emailVerified: boolean;
    readonly authenticatedAt: number | null;
  } | null;
  readonly installationRegistered: boolean;
  readonly overview: AccountOverview | null;
  readonly busy: boolean;
  readonly lastError: string | null;
  readonly lastDiagnosticsReportId?: string | null;
  readonly auth?: AccountAuthState | null;
  readonly pendingEmailChange?: { readonly email: string; readonly requestedAt: number } | null;
  readonly signInAvailable?: boolean;
  /** Which backend a sign-in would reach; absent when none can be started. */
  readonly authEnvironment?: "local" | "dev" | "qa" | "prod" | null;
  /** Why none can be started; absent when one can. */
  readonly signInUnavailableReason?: string | null;
  readonly now: number;
  readonly recentAuthWindowMs: number;
}

/**
 * The single derivation. Every window renders this and nothing else, so two windows cannot disagree.
 *
 * The phase order is deliberate and each step is a real gate: an unverified owner cannot enrol,
 * because the server refuses; an unenrolled machine has no entitlement to show, because the account
 * has not been told it exists.
 */
export function deriveAccountState(input: AccountStateInput): AccountUiState {
  if (!input.configured) return unconfiguredState();
  const base = {
    busy: input.busy,
    needsRecentAuth:
      input.owner === null ||
      input.owner.authenticatedAt === null ||
      input.now - input.owner.authenticatedAt > input.recentAuthWindowMs,
    installationRegistered: input.installationRegistered,
    signInAvailable: input.signInAvailable !== false,
    ...(input.authEnvironment ? { authEnvironment: input.authEnvironment } : {}),
    ...(input.signInUnavailableReason ? { signInUnavailableReason: input.signInUnavailableReason } : {}),
    ...(input.lastError === null ? {} : { lastError: input.lastError }),
    ...(input.lastDiagnosticsReportId ? { lastDiagnosticsReportId: input.lastDiagnosticsReportId } : {}),
    ...(input.auth ? { auth: input.auth } : {}),
    ...(input.pendingEmailChange ? { pendingEmailChange: input.pendingEmailChange } : {}),
  };
  const withOwner = input.owner === null ? base : { ...base, ownerEmail: input.owner.email };

  // ENROLMENT COMES FIRST, and this is the ordering the transient owner session required. The owner
  // credential is dropped as soon as the operation that needed it finishes (plan §2), so an enrolled
  // machine ordinarily has NO owner session — and the old order answered `signed-out` for it, which
  // would have shown a login form on a desktop that was enrolled, entitled and working. What the
  // account page needs after a restart comes from the overview, which is read through the
  // installation session; `needsRecentAuth` is what tells the UI to ask for a fresh link before
  // anything destructive.
  if (input.installationRegistered) {
    return {
      phase: "ready",
      ...withOwner,
      ...(input.owner !== null && !input.owner.emailVerified ? { ownerVerificationPending: true } : {}),
      ...(input.overview === null ? {} : { overview: input.overview, entitlement: input.overview.entitlement }),
    };
  }
  // A LINK IN FLIGHT IS ITS OWN PHASE, and only for a machine that is not enrolled: this is what the
  // "check your email" screen renders. An enrolled desktop took the `ready` branch above and keeps its
  // overview, its devices and its entitlement while the same attempt runs.
  if (input.auth) return { phase: "signing-in", ...base };
  if (input.owner === null) return { phase: "signed-out", ...base };
  return { phase: "enrolling", ...withOwner };
}

/**
 * Whether the state changed in a way any window needs to re-render for.
 *
 * Compared structurally rather than by reference so a refresh that produced an identical overview
 * does not wake every window — and so `account:updated` means "something is different", which is what
 * makes it safe to subscribe to.
 */
export function accountStateChanged(previous: AccountUiState | null, next: AccountUiState): boolean {
  if (previous === null) return true;
  return JSON.stringify(previous) !== JSON.stringify(next);
}

// --- signing out --------------------------------------------------------------------------------

export type SignOutBlocker = "active-pairings" | "active-relay-sessions";

export interface SignOutAssessment {
  /** What must be dealt with first, in the order the UI should present it. */
  readonly blockers: readonly SignOutBlocker[];
  /** How many phones would be disconnected by "disconnect this installation". */
  readonly pairedDevices: number;
  readonly activeRelaySessions: number;
}

/**
 * What signing out of this installation would break, before it breaks it.
 *
 * SIGN-OUT IS AN ONLINE REVOCATION, not a local forget. While this machine still has pairings or a
 * live relay session, the honest options are "cancel" and "disconnect this installation" — and the
 * second one revokes at the server before the local refresh token is deleted. Deleting the token
 * first would leave a machine that cannot revoke its own pairings and a server that still thinks
 * they are live.
 *
 * The OWNER ACCOUNT survives either way. Signing this installation out is not closing an account.
 */
export function assessSignOut(overview: AccountOverview | null): SignOutAssessment {
  if (!overview) return { blockers: [], pairedDevices: 0, activeRelaySessions: 0 };
  const pairedDevices = overview.mobileDevices.filter((device) => device.state === "active").length;
  const activeRelaySessions = overview.usage.activeRelaySessions.used;
  const blockers: SignOutBlocker[] = [];
  if (pairedDevices > 0) blockers.push("active-pairings");
  if (activeRelaySessions > 0) blockers.push("active-relay-sessions");
  return { blockers, pairedDevices, activeRelaySessions };
}

/**
 * Whether this installation may bind to a DIFFERENT account.
 *
 * Refused while any account-bound data is still attached. Re-binding a machine whose pairings,
 * device records and relay identity belong to another account is how one person's phone ends up
 * listed under somebody else's account — and the detach is what makes the answer honest rather than
 * hopeful.
 */
export function mayBindDifferentAccount(overview: AccountOverview | null, installationRegistered: boolean): boolean {
  if (!installationRegistered) return true;
  return assessSignOut(overview).blockers.length === 0;
}

// --- errors -------------------------------------------------------------------------------------

/** Every account error the renderer may be shown. Fixed codes; no remote text ever reaches a user. */
export const ACCOUNT_ERROR_CODES = [
  "invalid-credentials",
  "invalid-email",
  // The sign-in link's own refusals. `invalid-code` covers "wrong" AND "already used" because
  // Firebase does not reliably distinguish them, and a UI that claimed to would be confidently wrong;
  // `expired-code` IS distinguished, because it is the one a person acts on by asking for a new link.
  "invalid-code",
  "expired-code",
  // The address confirmed on the web page is not the one this desktop sent the link to. The attempt
  // is refused rather than adopting the other address as a new identity.
  "address-mismatch",
  // The attempt ran out before it was finished. Local and server deadlines both produce this.
  "attempt-expired",
  // F01. The completion this answer belonged to was cancelled, replaced by a newer attempt, or ended
  // by a shutdown or a configuration change while it was in flight. DELIBERATELY NOT `attempt-expired`:
  // nothing ran out of time, somebody did something — and the sentence a person needs to read is about
  // what they did, not about a clock. Whatever the server had already done stays done; what this code
  // says is that nothing further was attempted on this flow's behalf.
  "sign-in-superseded",
  // No sign-in can be STARTED: this build has no auth-link configuration, the identity service has
  // email-link sign-in turned off, its `continueUrl` domain is not authorized, or the daily send
  // quota is spent. Four operator problems and none of them is the user's.
  "auth-unavailable",
  "too-many-attempts",
  "requires-recent-login",
  "user-disabled",
  "network",
  // R04. The service ANSWERED and the answer could not be read — a body that was too large, or not
  // JSON, or not the shape the contract describes. Not `network`: the request arrived. Not a refusal:
  // nothing was refused. The mutation it was about may have happened, and the page has to say so
  // rather than pretend to know either way.
  "malformed-response",
  "not-configured",
  "installation-limit",
  "mobile-device-limit",
  "pairing-device-limit",
  "account-mismatch",
  "billing-unconfigured",
  "no-subscription",
  "already-subscribed",
  "trial-already-used",
  "checkout-pending",
  "provider-unavailable",
  "entitlement-required",
  // R14. A billing URL the DESKTOP refused: it was not HTTPS, or its host is not on the exact-host
  // allowlist the signed bootstrap envelope carries. A refusal the user can see, deliberately — a
  // checkout that "worked" and opened nothing is a payment problem nobody can act on. `cap-exceeded`
  // is the structured `resource-exhausted` all three account caps answer with (invariant 7);
  // `account-transport.ts`'s `capReason` turns the details block's `cap` into the three specific
  // codes above, and THIS one is what a cap named by a newer server than this build reads as.
  "checkout-url-not-allowed",
  "cap-exceeded",
  // R12. The installation's own refresh token was rejected while this machine is bound to an
  // account. Minting a new anonymous uid would silently replace the identity every pair membership
  // and the account registry are keyed by, so it is reported and the recovery enrolment is offered.
  "installation-identity-lost",
  // Diagnostics. `daily-limit` and `not-bound-to-an-account` are the two a person can act on — both
  // mean "export it locally instead" — and `diagnostics-empty` is ours: this machine has done
  // nothing worth reporting, so nothing is sent and no daily slot is spent proving it.
  "daily-limit",
  "not-bound-to-an-account",
  "diagnostics-empty",
  "unknown",
] as const;

export type AccountErrorCode = (typeof ACCOUNT_ERROR_CODES)[number];

/**
 * Maps whatever came back onto a fixed code.
 *
 * A REMOTE MESSAGE IS NEVER SHOWN. It is written by another system, it can contain identifiers, and
 * it changes without warning — three good reasons for the UI to speak in its own vocabulary.
 */
/**
 * A server reason spelled differently from the desktop's own vocabulary for the same refusal.
 *
 * `requireRecentAuth` (`account-admission.ts`, used by `deleteMyAccount`/`confirmOwnerForInstallation`/
 * `revokeAccountDevice`) writes `reauthentication-required` — a fact about ITS check, not a code this
 * closed set otherwise has any reason to carry twice. Every one of those callables' OWN local
 * `hasRecentAuth` gate is meant to catch this first (same window, deliberately — see that gate's own
 * comment), so in practice the server rarely gets the last word; when it does, it must still land on
 * the code the UI already knows how to show rather than on `unknown`.
 */
const SERVER_REASON_ALIASES: Readonly<Record<string, AccountErrorCode>> = {
  "reauthentication-required": "requires-recent-login",
};

function normalizeReason(reason: string): AccountErrorCode | null {
  const aliased = SERVER_REASON_ALIASES[reason];
  if (aliased !== undefined) return aliased;
  return (ACCOUNT_ERROR_CODES as readonly string[]).includes(reason) ? (reason as AccountErrorCode) : null;
}

export function toAccountErrorCode(error: unknown): AccountErrorCode {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string") {
    const normalized = normalizeReason(code);
    if (normalized !== null) return normalized;
  }
  const details = (error as { details?: { reason?: unknown } } | null)?.details?.reason;
  if (typeof details === "string") {
    const normalized = normalizeReason(details);
    if (normalized !== null) return normalized;
  }
  // A callable refusal carries `<callable> rejected: <reason>` in its message. The REASON is ours —
  // this server wrote it, from a closed set — so it is matched; nothing else in the text is used.
  const message = (error as { message?: unknown } | null)?.message;
  if (typeof message === "string") {
    const match = /rejected:\s*([a-z-]+)/.exec(message);
    const reason = match?.[1];
    const normalized = reason !== undefined ? normalizeReason(reason) : null;
    if (normalized !== null) return normalized;
  }
  return "unknown";
}
