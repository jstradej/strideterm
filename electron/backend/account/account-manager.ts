// The account flow, as one object every window and every IPC handler goes through.
//
// WHY A MANAGER AND NOT A SET OF HANDLERS. Three things have to be true at once and are easy to get
// wrong separately: exactly one derived state is broadcast (so two windows cannot disagree), an
// owner credential is transient unless somebody asked otherwise, and a destructive action is refused
// rather than half-performed. All three are properties of a single owner of the state.
//
// WHAT IT DOES NOT DO:
//
//   - IT NEVER DECIDES ENTITLEMENT. Every state it shows came from the server, and the server is the
//     only party that decides. A renderer that could infer "paid" from local settings would be a
//     renderer that can be edited into paying nothing.
//   - IT NEVER PERSISTS AN OWNER CREDENTIAL. There is no password to persist any more — the owner
//     proves an identity by opening a one-time link — and the session that produces lives in memory
//     only; the INSTALLATION's refresh token is the one thing in the credential store.
//   - IT NEVER TAKES AN IDENTITY FROM THE WEB. The confirmation page asks a person to type their
//     address; this manager compares that with the address the link was sent TO, and the uid it acts
//     on comes from `accounts:lookup` and from the server's own owner check — never from a form.
//   - IT NEVER BROADCASTS A URL. A checkout or portal URL is the one-shot return value of the call
//     that asked for it — see `account-state.ts` for the whole list of what stays out of state.
//
// SIGNING OUT IS AN ONLINE REVOCATION. While this machine still has pairings or a live relay
// session, the honest options are "cancel" and "disconnect this installation"; the second revokes at
// the server BEFORE the local refresh token is deleted. Deleting it first leaves a machine that
// cannot revoke its own pairings and a server that still thinks they are live.
//
// ONE AUTHENTICATION PER USER INTENTION (passwordless plan §7). With a password, "sign in again"
// cost a person four seconds, so an onboarding that authenticated twice was merely clumsy. With a
// link it costs an email, a tab and a wait — so `enrolThisInstallation()` releasing the owner session
// before `startTrial()` needed it would have meant a second link in the middle of the first run. The
// nested steps therefore never release: the OUTER operation owns the retention and drops it in a
// `finally`, and a partial success (registered, no trial) leaves the machine registered and offers to
// retry only the step that failed.
//
// THE OWNER SESSION IS TRANSIENT, AND THE INSTALLATION SESSION IS THE ONE THAT LASTS. Plan §2 says
// so in as many words: "owner email/password session je krátkodobá pouze pro enrollment/recent
// reauthentication a po operaci se zahodí". This manager used to hold the whole `OwnerSession` from
// enrolment until sign-out and refresh it for every ordinary read — so a desktop that had enrolled
// once ran its account page, its device list and its billing on a long-lived owner credential.
//
// What replaced it: the calls the server resolves through a BOUND uid (the overview, a self-revoke, a
// notice acknowledgement, diagnostics) go through the INSTALLATION session, which is the credential
// this machine is supposed to have; the owner session is taken for enrolment, a trial, a checkout, a
// portal session and a deletion, and is dropped as soon as the operation that needed it finishes
// unless the caller asked to keep it for a follow-up reauthentication. `restoreFromInstallation()` is
// what makes the account page work after a restart with no owner session at all — before it, a
// restarted desktop showed "not enrolled" until somebody signed in again.

import { EventEmitter } from "node:events";

import {
  AccountAuthError,
  hasRecentAuth,
  needsRefresh,
  readIdTokenClaims,
  RECENT_AUTH_WINDOW_MS,
  type AccountClient,
  type OwnerSession,
} from "./account-client.js";
import type { AuthLinkConfigRefusal } from "./authlink-config.js";
import {
  SignInBrokerError,
  type EmailSignInBroker,
  type SignInAttemptRef,
  type SignInAttemptState,
  type SignInPurpose,
} from "./email-signin-broker.js";
import {
  assessSignOut,
  deriveAccountState,
  mayBindDifferentAccount,
  toAccountErrorCode,
  unconfiguredState,
  type AccountErrorCode,
  type AccountUiState,
  type SignOutAssessment,
} from "./account-state.js";
import { AccountCallableError, type AccountTransport } from "./account-transport.js";
import {
  bindingSaysEnrolled,
  type InstallationBindingMarker,
  type InstallationBindingState,
} from "./account-binding.js";
import { checkBillingUrl } from "./billing-url.js";
import { getLogger } from "../logger.js";
import { requestDeadline, type RequestDeadline } from "./bounded-http.js";
import {
  buildDiagnosticsReport,
  diagnosticsExportFilename,
  DiagnosticsRing,
  renderDiagnosticsExport,
  type DiagnosticsApp,
  type DiagnosticsEntry,
} from "./account-diagnostics.js";
import type { AccountOverview } from "../mobile/mobile-schemas.js";

/** The installation half: its stable id, its Ed25519 public key and the signature over a transcript. */
export interface InstallationIdentity {
  readonly installationId: string;
  readonly publicKeyBase64Url: string;
  signChallenge(transcript: Buffer): Buffer;
}

export interface AccountManagerDeps {
  readonly client: AccountClient | null;
  readonly transport: AccountTransport | null;
  readonly identity: InstallationIdentity | null;
  /**
   * The passwordless sign-in broker, or null when this build has no auth-link configuration.
   *
   * Null is a NORMAL state and not a broken one: a dev build with no broker origin, or a build with
   * no hosted control plane at all. What it means is that no NEW owner sign-in can be started — and
   * nothing else. An installation that is already enrolled keeps its credential, its pairings and its
   * device list; see `authlink-config.ts` for why that separation is the whole point.
   */
  readonly broker?: EmailSignInBroker | null;
  /** Why there is no broker, when there is none. Carried into the UI as a fixed code. */
  readonly authLinkRefusal?: AuthLinkConfigRefusal | null;
  /** Opens a URL in the user's own browser, through the existing vetted external opener. */
  readonly openExternal: (url: string) => Promise<void>;
  /** A stable label for this machine, shown on the account page's device list. */
  readonly installationLabel?: string;
  readonly now?: () => number;
  /** Random idempotency keys. Injected so a test can make a retry provably the same request. */
  readonly newIdempotencyKey?: () => string;
  /**
   * Extra diagnostics entries to include in a report, from outside this module.
   *
   * The runtime supplies the mobile subsystem's own bounded audit rows here. A seam rather than an
   * import because this module must not reach into a SQLite store, and because a test that has no
   * store must still be able to prove the trimming.
   */
  readonly collectExtraDiagnostics?: () => readonly DiagnosticsEntry[];
  /** Which build produced the report. Version and platform only — see `account-diagnostics.ts`. */
  readonly appInfo?: DiagnosticsApp;
  /**
   * The EXACT hostnames a checkout or portal URL may point at, from the signed bootstrap envelope.
   *
   * A function rather than a value because the envelope can be replaced at runtime by a recovery, and
   * an allowlist captured at construction would be the old merchant's. Absent or empty means nothing
   * is opened — see `billing-url.ts` for why that is the right default.
   */
  readonly billingHosts?: () => readonly string[];
  /**
   * The pairs this desktop knows it owns, for the adoption hints an enrolment carries.
   *
   * The server treats them as LOCATORS and proves ownership itself from each pair's own
   * `publicMeta.desktopUid` — a hint is not evidence. Without them a machine that paired before it
   * had an account enrolled with its pairs left behind, which is the case §6.5 exists for.
   */
  readonly knownPairIds?: () => readonly string[];
  /**
   * Forgets this installation's persisted refresh token. Called AFTER a successful server revoke.
   *
   * A seam rather than a credential-store import: the manager must not own the credential, and the
   * ordering is the invariant — plan invariant 12, "sign-out must not discard a credential before the
   * server revocation can be completed". `signOutInstallation` used to clear only this object's own
   * fields, so the refresh token stayed on disk and the next start signed the machine back in.
   */
  readonly forgetInstallationCredential?: () => Promise<void>;
  /**
   * The DURABLE, LOCAL record of whether this machine is enrolled — read at start-up, before any
   * network call.
   *
   * The whole of F12. `installationRegistered` starts false and is only ever learned from the server
   * OVERVIEW, which is read with the very refresh token whose validity is in question. So a cold start
   * whose persisted token had been rejected asked "is this installation bound?", got `false` because
   * nothing had answered yet, and the REST client took that as permission to sign in anonymously —
   * minting a new uid, which is what the account's `installations` row, every pair membership and the
   * server's `accountByUid` index are keyed by. The same false answer came out of an ordinary network
   * outage. The absence of a server overview is not evidence that this machine was never enrolled;
   * this marker is the evidence, and it lives on disk beside the credential it protects.
   *
   * A STATE, NOT A BOOLEAN (G13 — see `account-binding.ts`). `enrolling` is the intent written before
   * the server is asked; `bound` and `none` are what the server said; `absent` and `unknown` are the
   * two ways of not knowing, and neither releases the identity.
   */
  readonly readInstallationBinding?: () => InstallationBindingState;
  /**
   * Records a marker. `enrolling` BEFORE the server mutation, `bound` after it confirms, `none` when
   * the server says this machine is not bound or the user signs it out.
   */
  readonly writeInstallationBinding?: (marker: InstallationBindingMarker) => Promise<void>;
}

/**
 * The lifetime of ONE operation, and the generation everything it does is checked against.
 *
 * R01. The sign-in completion had a lifecycle (`SignInFlow`, below) and the steps it called did not:
 * `enrolThisInstallation()`, `startTrial()`, `openCheckout()` and `openBillingPortal()` took no context
 * and no signal, so a cancel that ended the flow stopped the NEXT step of the flow and nothing inside
 * the step already running. After `await ensureAccount()` a new registration challenge was minted for
 * a flow nobody wanted any more; after a new sign-in the next step fetched "the owner" and got the
 * newer person's token; and a checkout whose answer arrived after the panel closed opened a browser.
 *
 * Every operation — a direct one started from the account page, or a step inside a completion — now
 * runs under one of these. Three things it carries:
 *
 *   - `alive`, ended by a cancel, a resend, the owning panel closing, a sign-out, a dispose or a newer
 *     sign-in. `requireScope()` is called after every await, before every mutation and before a URL
 *     is handed to the operating system, and refuses once this is false.
 *   - `abort`, so the requests the operation still has in flight go with it.
 *   - `ownerGeneration`: WHICH owner session the operation runs as. `this.ownerGeneration` moves
 *     whenever the owner session is set or dropped, so a step that started under one person's
 *     sign-in cannot continue under a newer one's — the token belongs to the operation's context, not
 *     to whichever session the manager happens to hold when the step gets round to asking.
 *
 * A performed server mutation is NOT undone by any of this. What ends is the next step; what the
 * server has already done is recorded as done (see `enrolWithin`).
 */
interface OperationScope {
  /** Monotonic, so a stale scope can ask "am I still the one" without comparing object identity. */
  readonly id: number;
  /** Aborts every request this operation still has in flight when it ends. */
  readonly abort: AbortController;
  /** The owner generation this operation runs under, or null while it has no owner yet. */
  ownerGeneration: number | null;
  alive: boolean;
}

/**
 * Everything ONE completion is allowed to know, captured before the code is presented and never
 * changed afterwards.
 *
 * F01. `confirmEmailSignIn()` used to read `broker.purpose`, `this.pendingOfferId` and "the current
 * attempt" at each step, and those are three questions with three different answers once a cancel or
 * a resend has happened in the middle of an await. What replaced them is this: an immutable record of
 * WHICH attempt this is, what it is for, and what it is to do afterwards — plus the two things that
 * end it, `alive` and an `AbortController`, which it shares with every other operation as an
 * {@link OperationScope}.
 *
 * The candidate session lives HERE rather than on the manager (F02), which is what makes "a failed
 * verification cannot leave a usable owner session" a property of the shape rather than of remembering
 * to clear a field: a flow that is not the active one can neither promote its candidate nor reach the
 * manager's, and the flow object goes out of scope with the call.
 */
interface SignInFlow extends OperationScope {
  /** The broker attempt this completion belongs to. Presented to `finish`/`cancel`. */
  readonly ref: SignInAttemptRef;
  readonly purpose: SignInPurpose;
  /**
   * The operand of a purpose that has one, pinned at the same moment as everything else.
   *
   * ONE STRING SLOT FOR TWO PURPOSES. `checkout` puts a bare offer id here; `revoke-device` puts
   * `encodeRevokeTarget(...)`'s packed `[kind, targetId]`. Widening this to a real union would also
   * widen `beginEmailSignIn`'s wire parameter — IPC, preload and the store all the way to the
   * renderer — for what is, on both sides, the one thing every purpose-with-an-operand needs: a
   * single opaque string captured now and handed back unchanged when the identity is proved.
   */
  readonly offerId: string | null;
  /** The verification window: at most two minutes from the moment the code was presented. */
  readonly deadline: number;
  /**
   * The session this flow has redeemed but not yet proved.
   *
   * NOT REACHABLE BY ORDINARY ACCOUNT OPERATIONS. `requireOwner()` and `tokenFor("owner")` read
   * `this.owner`, which this becomes only after the identity and the binding have both been checked.
   * The one call that needs it before then — `confirmOwnerForInstallation` — is handed the token
   * explicitly, which is the narrow access F02 asks for instead of publishing owner rights.
   */
  candidate: OwnerSession | null;
}

/**
 * One logical mutation whose outcome this process does not know yet.
 *
 * R03. The map used to hold a bare key per mutation NAME, and a key is a lookup key, not an identity:
 * the server digests the whole request (`challengeId`, `mode`, `label`, the pair hints; the offer) and
 * refuses a key presented with a different one as `idempotency-key-reused`. So a registration whose
 * answer was lost came back with the SAME key and a NEW challenge and signature — a refusal — and a
 * checkout for offer B after a lost answer for offer A came back with A's key, which the server
 * resolved to A's intent. What is kept is therefore the whole request: who asked (`principal`), and
 * exactly what they asked for (`request`, re-sent verbatim). A retry is the same request or it is not
 * a retry.
 */
interface PendingMutation {
  readonly key: string;
  /** The owner uid the mutation was started as. A different owner is a different mutation. */
  readonly principal: string;
  /** The exact request, as the transport will be handed it again, minus the key. */
  readonly request: unknown;
  /** `canonical(request)`, compared to decide whether the next call is the same request. */
  readonly identity: string;
  /**
   * The send of this record that is still out, if one is (S04).
   *
   * Two callers asking the SAME logical mutation while one send is outstanding — a double-click, a
   * resumed flow beside the original — share this one promise and its one answer, rather than sending
   * the same key twice and racing to release it.
   */
  inFlight: Promise<unknown> | null;
}

/** The registration's owner leg, minus the key the manager supplies. Stored verbatim across a lost answer. */
type RegistrationRequest = Omit<Parameters<AccountTransport["completeInstallationRegistration"]>[0], "idempotencyKey">;

/**
 * The desktop log, beside the bounded diagnostics ring.
 *
 * The ring is what a user can SEND; the log is what a developer reads after the fact. Everything here
 * is a fixed operation name, a fixed code and a few numbers — never an address, a token, a key or a
 * payload. The redaction in `logger.ts` is the second line, not the first.
 */
const log = getLogger("account");

export class AccountManagerError extends Error {
  readonly code: AccountErrorCode;

  constructor(code: AccountErrorCode) {
    // The MESSAGE is ours and carries no remote text. Every caller shows the code.
    super(`account operation refused: ${code}`);
    this.name = "AccountManagerError";
    this.code = code;
  }
}

/**
 * Emits `state` whenever the derived state changes, and nothing else.
 *
 * One event, one payload, and it is the same object every window renders — which is what makes
 * "all windows converge on the same snapshot" true rather than a thing each window tries to do.
 */
export class AccountManager extends EventEmitter {
  private readonly deps: AccountManagerDeps;
  private readonly now: () => number;
  private readonly newKey: () => string;

  private owner: OwnerSession | null = null;
  /**
   * Which owner session `this.owner` is, as a number that moves every time it is set or dropped.
   *
   * R02. Both refresh paths did `this.owner = await client.refresh(...)` with no look at what had
   * happened during the await: a cancel, a closed panel, a lapsed retention or a NEW sign-in all
   * replaced or dropped the session, and the late answer then put the old one back — with no retention
   * timer, since the release had already cleared it. A refresh result is accepted only for the
   * generation it was asked for. Operations pin the same number (`OperationScope.ownerGeneration`) so
   * a step started under one sign-in cannot continue under the next one's token (R01).
   */
  private ownerGeneration = 0;
  /** Aborts a background refresh of the CURRENT owner session when that session is dropped or replaced. */
  private ownerAbort: AbortController | null = null;
  /**
   * Whether the owner session may outlive the operation that took it.
   *
   * True only between a sign-in and the enrolment or destructive action it was for. The rest of the
   * time the owner credential is dropped the moment its operation returns.
   */
  private ownerRetained = false;
  private overview: AccountOverview | null = null;
  private installationRegistered = false;
  /**
   * How many AUTHORITATIVE answers about this machine's binding have been applied (S01).
   *
   * An overview that was applied, a registration the server answered, a sign-out and a "not bound"
   * at start-up each move it. A registration answer is compared against the value it saw when it was
   * SENT: if anything authoritative landed in between, the late answer does not write the marker — it
   * belongs to the operation that asked, not to the machine's current state. A refused registration
   * used to write `none` over a `bound` a newer flow had just confirmed, and an old success wrote
   * `bound` back after a sign-out. The marker decides whether a rejected refresh token may be answered
   * with a new anonymous identity, so this is not display order.
   */
  private bindingRevision = 0;
  /**
   * The `bindingRevision` the last OPERATION-sourced binding write produced (T01).
   *
   * A registration answer and a sign-out are not overview reads, yet they are authoritative about the
   * binding — and an overview read that was already out when one of them landed is answering a question
   * about an OLDER machine, whether it answers with an overview or with `not-bound-to-an-account`. The
   * start-up read is the sharp case: the runtime does not await it, so it runs beside the first sign-in,
   * and its late refusal used to reach `restoreFromInstallation`'s catch and write `none` over the
   * `bound` a registration had just confirmed. A read compares this against the revision it saw when it
   * was ISSUED. A read that another READ overtook is caught by `overviewApplied` instead, so two reads
   * answering in the order they were issued both apply.
   */
  private bindingWrittenByOperationAt = 0;
  /** The attempt in progress, mirrored from the broker so the derived state is one object. */
  private auth: SignInAttemptState | null = null;
  /**
   * A login-address change that has been REQUESTED and not confirmed.
   *
   * Informational only, and deliberately not persisted (plan §7): after a restart it must not be
   * presented as authoritative, because the only party that knows whether the new mailbox was opened
   * is Firebase. The app re-reads the real state rather than believing the last local sentence.
   */
  private pendingEmailChange: { readonly email: string; readonly requestedAt: number; readonly uid: string } | null =
    null;
  /**
   * Orders the login-address change REQUESTS, so the note names the newest one asked for (T02).
   *
   * `emailChangeRequests` is taken when a request is sent; `emailChangeSettled` is the newest one that
   * has written the note or been overtaken. Firebase answers in the order the network delivers, which is
   * not the order the person asked in: an old success landing after a newer one wrote the OLDER address
   * back as the pending one, for the same account. A clear moves the settled mark to every request out at
   * the time, so a late answer cannot resurrect a note the person deliberately dismissed.
   */
  private emailChangeRequests = 0;
  private emailChangeSettled = 0;
  /** What to do once the identity is proved, for the purposes that carry an operand. */
  private pendingOfferId: string | null = null;
  /** Greater than zero while a purpose chain is running. See {@link releaseAfterOperation}. */
  private purposeDepth = 0;
  /** Ends the owner retention five minutes after the sign-in that opened it. */
  private ownerRetentionTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * The completion in flight, if any, and everything it is allowed to know. See {@link SignInFlow}.
   *
   * At most one at a time as far as the UI is concerned; a superseded one may still be unwinding, and
   * the whole point of the record is that it can tell it is no longer this field's value.
   */
  private activeFlow: SignInFlow | null = null;
  /**
   * Every operation currently running, the completion in flight included. See {@link OperationScope}.
   *
   * `busy` is derived from this set rather than set and reset by each `run()`: a nested step used to
   * clear the flag in the middle of the chain that owned it, and a late failure of an ABANDONED
   * operation used to clear it for the newer one that had started since (R01).
   */
  private readonly liveScopes = new Set<OperationScope>();
  private scopeSeq = 0;
  /**
   * Orders the overview reads, so an older answer never overwrites a newer authoritative one (R01).
   *
   * `overviewRequests` is taken when a read is issued; `overviewApplied` is the newest one whose answer
   * has been written. A sign-out moves both, so a read that was in flight when the machine signed out
   * cannot resurrect the account it just left.
   */
  private overviewRequests = 0;
  private overviewApplied = 0;
  /**
   * The attempt ids whose code is being redeemed right now.
   *
   * The polling loop, a pasted link and a double-clicked button all arrive at `confirmEmailSignIn`,
   * and exactly one of them may present a GIVEN code to Firebase (plan §6: "Souběh pollingu, vložení
   * odkazu a dvojkliku smí spustit právě jeden lokální požadavek na uplatnění daného kódu").
   *
   * KEYED BY ATTEMPT, not a single boolean, because a boolean answers the wrong question once F01's
   * lifecycle exists: a redemption that is still unwinding after its attempt was cancelled would
   * otherwise swallow the confirmation of the NEW attempt the person started — a silent no-op on the
   * button that matters most. One code, one redemption; a different code is a different question.
   */
  private readonly redeemingAttemptIds = new Set<string>();
  /**
   * Each mutation that has been started and has no definite outcome yet — its key AND its request.
   *
   * F06. A key generated at the call site is a NEW logical mutation every time the button is pressed,
   * so a `startTrial` whose answer was lost came back as a second trial request the server had no way
   * to recognise. The key belongs to the MUTATION, not to the request: it is minted the first time the
   * mutation is attempted, held across every retry of it, and released only when the outcome is
   * definite — a success, or a refusal that says what happened. A lost answer keeps it, because that
   * is precisely the case it exists for.
   *
   * AND THE KEY ALONE WAS NOT ENOUGH (R03): the server digests the whole request under the key, so a
   * retry has to BE the same request. See {@link PendingMutation} and {@link mutate}.
   *
   * REGISTRATION AND TRIAL HAVE SEPARATE KEYS, as the plan requires: they are two mutations, and one
   * key for both would make "retry only the step that failed" impossible to express.
   */
  private readonly pendingMutations = new Map<MutationName, PendingMutation>();
  private busy = false;
  private lastError: AccountErrorCode | null = null;
  private lastState: AccountUiState | null = null;
  /** What this installation did, bounded. The whole of what a diagnostics report is made of. */
  private readonly diagnostics = new DiagnosticsRing();
  private lastDiagnosticsReportId: string | null = null;

  constructor(deps: AccountManagerDeps) {
    super();
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
    this.newKey = deps.newIdempotencyKey ?? (() => crypto.randomUUID().replace(/-/g, ""));
    // ONE derived state, so every window agrees about the attempt too. The broker owns the timers and
    // the secret; this manager owns what anybody is allowed to see.
    deps.broker?.on("state", (state: SignInAttemptState | null) => {
      this.auth = state;
      this.publish();
    });
    deps.broker?.on("failed", (code: string) => {
      this.auth = null;
      this.lastError = toAccountErrorCode({ code });
      this.publish();
    });
  }

  /** Whether a NEW owner sign-in can be started at all. */
  get signInAvailable(): boolean {
    return this.configured && (this.deps.broker ?? null) !== null;
  }

  get configured(): boolean {
    return this.deps.client !== null && this.deps.transport !== null && this.deps.identity !== null;
  }

  state(): AccountUiState {
    // WHY, even when there is nothing to configure with (R06): a refused configuration is a state the
    // operator has to be able to read off the page.
    if (!this.configured) return unconfiguredState(this.deps.authLinkRefusal ?? null);
    return deriveAccountState({
      configured: true,
      owner:
        this.owner === null
          ? null
          : {
              email: this.owner.email,
              emailVerified: this.owner.emailVerified,
              authenticatedAt: this.owner.authenticatedAt,
            },
      installationRegistered: this.installationRegistered,
      overview: this.overview,
      busy: this.busy,
      lastError: this.lastError,
      lastDiagnosticsReportId: this.lastDiagnosticsReportId,
      auth: this.auth,
      // THE ACCOUNT IT WAS ASKED FOR (S03). A note left by one person's request is not shown beside a
      // different person's sign-in; with nobody signed in it is shown, because the address it names is
      // the one fact about the last account that the person still has to act on.
      pendingEmailChange:
        this.pendingEmailChange !== null && (this.owner === null || this.owner.uid === this.pendingEmailChange.uid)
          ? { email: this.pendingEmailChange.email, requestedAt: this.pendingEmailChange.requestedAt }
          : null,
      signInAvailable: this.signInAvailable,
      // WHICH backend, or WHY none — exactly one of the two, and never both (F11). `authLinkRefusal`
      // was previously accepted as a dependency and never read, so the page could say "sign-in is not
      // available" and could not say which of four operator problems it was.
      authEnvironment: this.signInAvailable ? (this.deps.broker?.environment ?? null) : null,
      signInUnavailableReason: this.signInAvailable ? null : (this.deps.authLinkRefusal ?? null),
      now: this.now(),
      recentAuthWindowMs: RECENT_AUTH_WINDOW_MS,
    });
  }

  /** What signing out would break, before it breaks it. */
  signOutAssessment(): SignOutAssessment {
    return assessSignOut(this.overview);
  }

  // --- owner identity, by one-time link -----------------------------------------------------------

  /**
   * Starts a passwordless sign-in for ONE stated intention.
   *
   * The purpose is pinned here and never travels: not in the link, not to the broker, not to
   * Firebase. It decides what happens after the identity is proved, and a URL somebody constructs
   * cannot change it, because the only copy of it is in this process.
   *
   * `offerId` is the operand for the one purpose that has one. It is captured now rather than asked
   * for again afterwards, because "open the checkout you already chose" is the request being
   * authenticated — plan §7: "vyžádat odkaz s připnutým účelem; ověřit vazbu a provést původní
   * požadavek".
   */
  async beginEmailSignIn(email: string, purpose: SignInPurpose, offerId?: string): Promise<void> {
    const broker = this.requireBroker();
    // A NEW sign-in supersedes whatever was pending, including a half-finished one. The retention of
    // any previous owner session goes with it: the person is proving an identity again, and the old
    // proof must not survive into the new intention. And so does any COMPLETION still unwinding
    // (F01): its late answer must not set a session, run a mutation or end this new attempt — and so
    // does every other operation in flight (R01), for the same reason.
    this.abandonOperations();
    this.releaseOwnerSession();
    this.pendingOfferId = purpose === "checkout" || purpose === "revoke-device" ? (offerId ?? null) : null;
    await this.run("email-sign-in-start", async () => {
      try {
        await broker.begin(email, purpose);
      } catch (error) {
        throw new AccountManagerError(
          error instanceof SignInBrokerError ? toAccountErrorCode({ code: error.code }) : "unknown",
        );
      }
    });
  }

  /** Sends another link for the same flow. Bounded by the broker: a cooldown and a per-flow ceiling. */
  async resendEmailSignIn(): Promise<void> {
    const broker = this.requireBroker();
    // A resend REPLACES the attempt, so a completion of the old one is abandoned here too — plan §6's
    // "Resend zakládá nový pokus a starý se ruší", extended to the half of the flow that lives in this
    // object rather than in the broker (F01).
    this.abandonActiveFlow();
    await this.run("email-sign-in-resend", async () => {
      try {
        await broker.resend();
      } catch (error) {
        throw new AccountManagerError(
          error instanceof SignInBrokerError ? toAccountErrorCode({ code: error.code }) : "unknown",
        );
      }
    });
  }

  /**
   * The manual fallback: the whole link, pasted out of a mail client.
   *
   * Synchronous and deliberately outside `run()` — it neither reaches the network nor blocks — so the
   * field can be cleared the moment it is accepted. The text goes no further than this call: it is
   * not broadcast, not stored and not logged.
   */
  submitSignInLink(link: string): void {
    const broker = this.requireBroker();
    try {
      broker.submitLink(link);
    } catch (error) {
      const code = error instanceof SignInBrokerError ? toAccountErrorCode({ code: error.code }) : "unknown";
      this.lastError = code;
      this.publish();
      throw new AccountManagerError(code);
    }
    this.lastError = null;
    this.publish();
  }

  /**
   * Abandons the attempt. Tells OUR broker to stop; it revokes no Firebase link, and says so.
   *
   * IT RELEASES THE OWNER RETENTION TOO (F02). It used to cancel the attempt and leave a retained
   * owner session behind it, so "never mind" produced a desktop that still held a live credential and
   * a UI that still showed a fresh authentication — with the follow-up action it was retained for now
   * unreachable. Cancelling one intention ends everything that intention was holding.
   */
  cancelEmailSignIn(): void {
    // EVERY operation, not only the completion (R01): the owning panel closing reaches this method
    // too, and a checkout or portal request whose answer arrives afterwards must not open a browser.
    this.abandonOperations();
    this.deps.broker?.cancel();
    this.releaseOwnerSession();
    this.pendingOfferId = null;
    // `pendingEmailChange` deliberately SURVIVES. Firebase has already sent a message to the new
    // address, and cancelling a sign-in does not unsend it; dropping the note would hide a true fact
    // about the account from the person who has to act on it.
    this.publish();
  }

  /**
   * The owning panel unmounted. Release what needed the form; leave a waiting link alone.
   *
   * THIS IS NOT A CANCEL, AND TREATING IT AS ONE WAS A DEFECT THE FLOW CANNOT SURVIVE. Passwordless
   * sign-in requires the person to LEAVE: the link is in a mail client, and reading it means closing
   * the Settings dialog or switching to another of its tabs — both of which unmount this panel. So
   * the previous behaviour cancelled the attempt as a direct consequence of the user doing the one
   * thing the flow asks of them, and the link they then opened was confirmed at the broker with
   * nothing left on this side to claim it. The desktop showed a fresh, empty form and no error,
   * because from its point of view nothing had gone wrong.
   *
   * WHAT F09 WAS ACTUALLY ABOUT SURVIVES INTACT. Its concern was a live OWNER CREDENTIAL retained for
   * a follow-up action whose form had gone away — a `change-email` or a `delete-account` waiting for
   * a second step nobody can take any more — plus an in-flight `checkout` whose answer must not open
   * a browser over a panel that no longer exists. Both are released here exactly as before. What is
   * kept is the one thing that has no credential attached to it yet: an attempt still WAITING for
   * somebody to open a link.
   *
   * That distinction is safe precisely because of the confirmation step. An attempt cannot turn into
   * an owner session on its own: the payload arrives, the state becomes `awaiting-confirmation`, and
   * it stays there until a person presses confirm ON THIS DESKTOP. No credential can therefore
   * appear while the panel is closed, which is what makes "keep the attempt, drop the retention" a
   * complete answer rather than half of one.
   *
   * The attempt is still bounded by everything that bounded it before — its own fifteen minutes, the
   * broker's deadline, the poll budget — so this widens no window. It only stops the desktop giving
   * up on a link the person is, at that very moment, walking over to their mailbox to open.
   */
  releaseSignInPanel(): void {
    const waiting = this.deps.broker?.state() !== null && this.deps.broker?.state() !== undefined;
    // EVERY operation in flight, whether or not an attempt survives (R01): a checkout or portal
    // answer arriving after the panel closed must not open a browser, and that is true of a closed
    // panel with a pending link exactly as it is of one without.
    this.abandonOperations();
    this.releaseOwnerSession();
    if (!waiting) {
      this.deps.broker?.cancel();
      // Only dropped with the attempt. `pendingOfferId` is the operand of the attempt's own pinned
      // purpose, so clearing it while the attempt lives would leave a `checkout` that authenticates
      // successfully and then has no offer to open.
      this.pendingOfferId = null;
    }
    this.publish();
  }

  /**
   * The person confirmed on THIS desktop. Redeem the code, prove the identity, then do the thing.
   *
   * THE ORDER IS THE SECURITY ARGUMENT, and every step exists because the one before it proves less
   * than it looks like it does:
   *
   *   1. `signInWithEmailLink` — proves somebody opened a link sent to that address. It does NOT
   *      prove which account, and its response does not document `emailVerified` at all.
   *   2. `accounts:lookup` — the server's own answer, and the uid it returns MUST equal the uid the
   *      sign-in returned. Retried on a network failure over the SAME candidate session: the code is
   *      spent, so re-redeeming it is not an option and is not attempted.
   *   3. `confirmOwnerForInstallation` — only the server can say that this identity owns the account
   *      this MACHINE is enrolled in. Skipped when the machine is not enrolled yet, where there is no
   *      binding to confirm and the registration handshake carries its own proof.
   *
   * A refusal at any step drops the candidate session and rebinds nothing.
   */
  async confirmEmailSignIn(): Promise<void> {
    const broker = this.requireBroker();
    const payload = broker.pendingPayload();
    const purpose = broker.purpose;
    const current = broker.currentRef();
    if (payload === null || purpose === null || current === null) throw new AccountManagerError("invalid-credentials");
    // ONE LOCAL REDEMPTION PER CODE. A second press, or the polling loop arriving behind a paste, is
    // a no-op for THIS attempt and says nothing about any other.
    if (this.redeemingAttemptIds.has(current.attemptId)) return;
    // THE LOCAL DEADLINE, RE-CHECKED before the code is presented — including one that has been in
    // memory since before the attempt lapsed (plan §6).
    let started: { deadline: number; ref: SignInAttemptRef };
    try {
      started = broker.beginVerification();
    } catch (error) {
      throw new AccountManagerError(
        error instanceof SignInBrokerError ? toAccountErrorCode({ code: error.code }) : "unknown",
      );
    }
    // EVERYTHING THIS COMPLETION WILL EVER KNOW, decided here and immutable from here (F01). Reading
    // `broker.purpose` or `this.pendingOfferId` again further down would be reading the state of
    // whatever attempt is current at that moment, which after a cancel or a resend is a different one.
    const flow: SignInFlow = {
      id: ++this.scopeSeq,
      ref: started.ref,
      purpose,
      offerId: purpose === "checkout" || purpose === "revoke-device" ? this.pendingOfferId : null,
      deadline: started.deadline,
      abort: new AbortController(),
      ownerGeneration: null,
      candidate: null,
      alive: true,
    };
    this.abandonActiveFlow();
    this.activeFlow = flow;
    this.redeemingAttemptIds.add(flow.ref.attemptId);
    try {
      await this.run(
        "email-sign-in-complete",
        async (client, transport, identity) => {
          this.requireFlow(flow);
          let session: OwnerSession;
          try {
            session = await client.completeEmailSignIn(payload.email, payload.oobCode, { signal: flow.abort.signal });
          } catch (error) {
            // The code was refused. It may have been spent, expired or never valid — Firebase does not
            // reliably tell those apart — so THIS attempt ends and the UI offers a new link. The ref is
            // what keeps that sentence true: a cancel or a resend during the redemption means the
            // attempt this refusal is about no longer exists, and the one that replaced it is untouched.
            broker.cancel(flow.ref);
            throw error;
          }
          // THE CODE IS SPENT FROM HERE ON, and this is the first check after the first await: if the
          // flow was cancelled, superseded or disposed while Firebase was answering, the answer belongs
          // to nobody. Nothing is acknowledged, no session is set, no mutation runs — and, crucially,
          // the attempt that replaced this one is not ended by this one's cleanup.
          this.requireFlow(flow);
          // The broker's copy has done its job, so THIS attempt is acknowledged and ends — and a failure
          // of that acknowledgement never fails this sign-in.
          broker.finish(flow.ref);
          // A CANDIDATE, NOT AN OWNER (F02). Nothing outside this flow can reach it: `requireOwner()`
          // and `tokenFor("owner")` read `this.owner`, and this becomes that only after both checks
          // below have passed.
          flow.candidate = session;

          const looked = await this.lookupWithRetry(client, flow, session);
          this.requireFlow(flow);
          // THE WINDOW, AFTER THE ANSWER (R05). The deadline used to be consulted only BEFORE each try,
          // so a lookup that was issued in time and answered late — a suspended laptop is the ordinary
          // way — went on to promote the candidate past a limit that had already passed.
          this.requireWithinWindow(flow);
          const claims = readIdTokenClaims(session.idToken, this.now());
          if (looked.uid !== session.uid || (claims.subject !== null && claims.subject !== session.uid)) {
            // A different account answered for the same address, or the token names a different subject
            // from the session built out of the same response. Never silently adopted (F08).
            throw new AccountManagerError("account-mismatch");
          }
          if (!looked.emailVerified || claims.emailVerified === false) {
            // A redeemed sign-in link verifies the address, so this is the server disagreeing with the
            // thing that just happened — or the Auth record and the token disagreeing with each other.
            // Every owner door requires `email_verified`, so continuing would only produce a refusal
            // further along with a less useful message. A token that does not CARRY the claim decides
            // nothing here: a local decode is not a substitute for the record (F08).
            throw new AccountManagerError("requires-recent-login");
          }
          const proved: OwnerSession = { ...session, email: looked.email, emailVerified: true };
          flow.candidate = proved;

          if (this.installationRegistered) {
            // THE ONE CALL THAT NEEDS THE CANDIDATE'S TOKEN, and it is handed the token rather than
            // being allowed to ask for "the owner" (F02).
            const answer = await this.confirmOwnerWithRetry(transport, identity.installationId, flow, proved);
            this.requireFlow(flow);
            this.requireWithinWindow(flow);
            if (answer.status !== "confirmed") {
              // THE OWNER CHECK IS THE ONE THAT MATTERS AFTER A RESTART, when there is no previous
              // `owner.email` to compare with and a renderer-side comparison would prove nothing.
              throw new AccountManagerError(
                answer.reason === "installation-not-active" ? "installation-identity-lost" : "account-mismatch",
              );
            }
          }

          // PROMOTED ONLY NOW, and the retention starts with it (F02): identity proved, binding proved.
          // Everything above ran on a candidate that no ordinary account operation could reach, so a
          // failure at any of those steps leaves no owner token behind and `needsRecentAuth` true.
          // AND ONLY INSIDE THE WINDOW (R05): this is the last check before a session exists, and the
          // clock is read here rather than trusted from the check before the previous await.
          this.requireFlow(flow);
          this.requireWithinWindow(flow);
          this.setOwner(proved);
          flow.ownerGeneration = this.ownerGeneration;
          this.retainOwner(proved);
          flow.candidate = null;

          // THE PAGE, BEFORE THE ACTION. A verified owner may already have an account and this machine
          // may already be enrolled; asking is cheap and is the only way to know. It also feeds the
          // guards the follow-up steps depend on — `mayBindDifferentAccount` reads this overview, and
          // without it an enrolment could rebind a machine whose pairings belong to another account.
          await this.afterOwnerReady();
          this.requireFlow(flow);

          await this.performPurpose(flow, transport, identity);
        },
        flow,
      );
    } finally {
      this.redeemingAttemptIds.delete(flow.ref.attemptId);
      // THE CANDIDATE GOES, WHATEVER HAPPENED. It is either promoted (and this field already null) or
      // it never proved anything.
      flow.candidate = null;
      // AND THE CLEANUP TOUCHES NOTHING THAT IS NOT THIS FLOW'S (F01). A `finally` that released the
      // owner session and cleared `pendingOfferId` unconditionally would, for a superseded flow, be
      // doing it to the flow that replaced it — which is the whole class of bug this guard closes.
      if (this.activeFlow === flow) {
        // THE OUTER OPERATION OWNS THE RETENTION. Whatever happened above, the credential does not
        // outlive it — except for the purposes whose follow-up action is a separate, deliberate second
        // step by the person (see `purposeKeepsOwner`).
        if (!purposeKeepsOwner(purpose)) this.releaseOwnerSession();
        this.pendingOfferId = null;
        this.endFlow(flow);
      }
    }
  }

  // --- the lifecycle of one completion (F01) --------------------------------------------------------

  /**
   * Throws unless this flow is still the one this manager is running.
   *
   * Called before and after every await in the completion path. The refusal is deliberately its own
   * code: "your sign-in was replaced" is a different sentence from "your sign-in expired", and the
   * person who sees it did something — they cancelled, or they asked for another link.
   *
   * A SERVER MUTATION ALREADY PERFORMED IS NOT UNDONE by this (the plan is explicit: "Již serverem
   * provedenou mutaci nepředstírat jako vrácenou zpět"). What it does is stop the NEXT step. An
   * enrolment that the server accepted stays accepted, its durable marker stays written, and the page
   * shows the machine as enrolled — which is the true state, not the one this flow intended.
   */
  private requireFlow(flow: SignInFlow): void {
    if (this.activeFlow !== flow) throw new AccountManagerError("sign-in-superseded");
    this.requireScope(flow);
  }

  /**
   * Throws unless the verification window is still open. The flow is checked FIRST by every caller,
   * so a cancelled flow whose window has also passed names what actually happened (R05).
   */
  private requireWithinWindow(flow: SignInFlow): void {
    if (this.now() >= flow.deadline) throw new AccountManagerError("attempt-expired");
  }

  /**
   * Throws unless this operation is still wanted AND still runs as the owner it started with (R01).
   *
   * Called after every await, before every mutation and before a URL leaves the process. The owner
   * check is the half a plain liveness flag cannot express: a newer sign-in that completed while this
   * step was awaiting moved `ownerGeneration`, and the token the next transport call would fetch is
   * that person's. The step refuses rather than continuing as somebody else.
   */
  private requireScope(scope: OperationScope): void {
    if (!scope.alive) throw new AccountManagerError("sign-in-superseded");
    if (scope.ownerGeneration !== null && scope.ownerGeneration !== this.ownerGeneration) {
      throw new AccountManagerError("sign-in-superseded");
    }
  }

  /** The owner session, for an operation that is still entitled to one. */
  private requireOwnerFor(scope: OperationScope): OwnerSession {
    this.requireScope(scope);
    return this.requireOwner();
  }

  /** A fresh scope for a direct operation, pinned to whichever owner session is held right now. */
  private newScope(): OperationScope {
    return {
      id: ++this.scopeSeq,
      abort: new AbortController(),
      ownerGeneration: this.ownerGeneration,
      alive: true,
    };
  }

  /** Ends one operation: no more steps, every outstanding request aborted, and `busy` re-derived. */
  private endScope(scope: OperationScope): void {
    scope.alive = false;
    scope.abort.abort();
    this.liveScopes.delete(scope);
    this.busy = this.liveScopes.size > 0;
  }

  /** Ends one flow: an operation scope, plus the candidate and the "which flow is current" pointer. */
  private endFlow(flow: SignInFlow): void {
    this.endScope(flow);
    flow.candidate = null;
    if (this.activeFlow === flow) this.activeFlow = null;
  }

  /** Ends whatever completion is in flight, if any. A resend: the attempt changes, nothing else does. */
  private abandonActiveFlow(): void {
    if (this.activeFlow !== null) this.endFlow(this.activeFlow);
  }

  /**
   * Ends every operation in flight — the completion and every direct one — except `except`, which is
   * the operation doing the abandoning (a sign-out runs inside its own scope). Cancel, panel close,
   * new sign-in, sign-out, shutdown.
   */
  private abandonOperations(except?: OperationScope): void {
    this.abandonActiveFlow();
    for (const scope of [...this.liveScopes]) {
      if (scope !== except) this.endScope(scope);
    }
  }

  /**
   * Re-reads the account, retrying while the deadline allows.
   *
   * The tokens have already arrived, so a failure here is a failure of a CHECK and not of the
   * sign-in — and re-redeeming a spent code is not an option (plan §6). Retried over the same
   * candidate session in memory, with the attempt's own short grace as the bound.
   */
  private async lookupWithRetry(
    client: AccountClient,
    flow: SignInFlow,
    session: OwnerSession,
  ): Promise<{ uid: string; email: string; emailVerified: boolean }> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      // THE DEADLINE IS CHECKED BEFORE THE FIRST TRY TOO (F04). It used to be consulted only between
      // retries, so a redemption that had already taken longer than the two-minute verification window
      // — a hung `signInWithEmailLink`, a slow answer, a suspended laptop — went on to make the first
      // check anyway, past a limit that had already passed. The window is a limit on the whole
      // verification, not on its retries.
      // THE FLOW FIRST, THEN THE CLOCK. Both can be true at once — a cancelled flow whose window has
      // also passed — and the answer a caller sees should name what actually happened rather than
      // whichever check ran first.
      this.requireFlow(flow);
      if (this.now() >= flow.deadline) break;
      // THE REQUEST MAY NOT OUTLIVE THE WINDOW (R05): its own timeout is the shorter of the client's
      // and the time the verification has left, so a check that cannot answer in time is ended rather
      // than answered late.
      const window = this.verificationWindow(flow);
      try {
        return await client.lookup(session, { signal: window.signal });
      } catch (error) {
        lastError = error;
        // THE FLOW FIRST, THEN THE CLOCK, THEN THE ERROR. An abort here is the flow going away or the
        // window closing, and each of those has its own sentence; a refusal is an answer, and asking
        // again does not change it. ONLY a transport failure is retried.
        this.requireFlow(flow);
        this.requireWithinWindow(flow);
        if (!(error instanceof AccountAuthError) || error.code !== "network") throw error;
      } finally {
        window.dispose();
      }
    }
    throw lastError ?? new AccountManagerError("attempt-expired");
  }

  /** An abort signal that fires with the flow, or when the verification window closes. */
  private verificationWindow(flow: SignInFlow): RequestDeadline {
    return requestDeadline(Math.max(0, flow.deadline - this.now()), flow.abort.signal);
  }

  /**
   * Asks the server to confirm the owner, retrying while the deadline allows.
   *
   * The tokens have already arrived and the code is spent, so a TRANSPORT failure here is a failure
   * of a check and not of the sign-in — plan §6: "Pokud tokeny již dorazily a selže až `lookup` nebo
   * kontrola vazby kvůli síti, opakovat tuto kontrolu nad kandidátní session v paměti." A REFUSAL is
   * an answer and is returned unchanged; only an unreachable control plane is asked again.
   */
  private async confirmOwnerWithRetry(
    transport: AccountTransport,
    installationId: string,
    flow: SignInFlow,
    candidate: OwnerSession,
  ): Promise<{ status: string; reason?: string }> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      // Same two rules as the lookup, in the same order: the flow, then the window — which bounds the
      // whole check and not only its retries.
      this.requireFlow(flow);
      if (this.now() >= flow.deadline) break;
      const window = this.verificationWindow(flow);
      try {
        // THE CANDIDATE'S TOKEN, NAMED (F02). The transport does not ask this manager for "the owner"
        // here, because there is no owner yet — this call is what decides whether there will be one.
        return await transport.confirmOwnerForInstallation({
          installationId,
          ownerIdToken: candidate.idToken,
          signal: window.signal,
        });
      } catch (error) {
        lastError = error;
        this.requireFlow(flow);
        this.requireWithinWindow(flow);
        if (!(error instanceof AccountCallableError) || error.reason !== "network") throw error;
      } finally {
        window.dispose();
      }
    }
    throw lastError ?? new AccountManagerError("attempt-expired");
  }

  /**
   * Does the thing the sign-in was started for.
   *
   * `purposeDepth` is what makes "nested registration steps must not discard the session before the
   * trial" true (plan §7). Each of the steps below is ALSO a direct entry point — somebody can press
   * "start the trial" on its own — and each of those releases the credential when it finishes, which
   * is right for a direct call and wrong in the middle of a chain. The depth is the difference, and
   * the outer `finally` in `confirmEmailSignIn` is what actually releases.
   */
  private async performPurpose(
    flow: SignInFlow,
    transport: AccountTransport,
    identity: InstallationIdentity,
  ): Promise<void> {
    this.purposeDepth += 1;
    try {
      await this.performPurposeInner(flow, transport, identity);
    } finally {
      this.purposeDepth -= 1;
    }
  }

  private async performPurposeInner(
    flow: SignInFlow,
    transport: AccountTransport,
    identity: InstallationIdentity,
  ): Promise<void> {
    // EVERY STEP RUNS UNDER THE FLOW'S OWN SCOPE (R01). The `run()` calls below are NESTED in the
    // completion's: they record their own diagnostics line and touch neither `busy` nor `lastError`,
    // and every await inside them is checked against the flow rather than against whatever the
    // manager holds by then.
    switch (flow.purpose) {
      case "enrol":
        // A MACHINE THE SERVER ALREADY LISTS IS NOT REGISTERED AGAIN (F06). The overview was just
        // re-read and the owner check has just passed, so `installationRegistered` is the server's own
        // answer about the account this owner owns — and repeating a completed handshake because a
        // later step failed is the thing the plan forbids.
        if (!this.installationRegistered) await this.enrolUnder(flow, "register", []);
        return;
      case "enrol-with-trial":
        // ONE LINK, BOTH STEPS (plan §7's table, row 1). And a PARTIAL SUCCESS IS NOT A ROLLBACK: if
        // the registration stands and the trial does not, the machine stays registered and the UI
        // offers to retry the trial alone — which is what the `trial` purpose below is for.
        if (!this.installationRegistered) await this.enrolUnder(flow, "register", []);
        this.requireFlow(flow);
        await this.trialUnder(flow);
        return;
      case "trial":
        // THE UNFINISHED STEP, ON ITS OWN (F06). A registration that succeeded and a trial whose
        // answer was lost used to leave the person with a button that called the owner endpoint
        // directly, with no owner session and therefore no chance of working. This is the same
        // intention as `enrol-with-trial` minus the half that is already done, and the trial carries
        // the SAME idempotency key and the same request the lost attempt used.
        await this.trialUnder(flow);
        return;
      case "recover-uid":
        await this.enrolUnder(flow, "recover-uid", []);
        return;
      case "checkout": {
        // THE OPERAND PINNED WHEN THE FLOW WAS CREATED, not `this.pendingOfferId` as it is now: a
        // newer attempt may have replaced that field while this completion was awaiting (F01).
        if (flow.offerId === null) return;
        await this.run(
          "open-checkout",
          (_client, t, i, scope) => this.checkoutWithin(scope, t, i, flow.offerId!),
          flow,
        );
        return;
      }
      case "portal":
        await this.run("open-billing-portal", (_client, t, i, scope) => this.portalWithin(scope, t, i), flow);
        return;
      case "reauth":
      case "change-email":
      case "delete-account":
        // The follow-up is a separate, deliberate act by the person — typing a new address, or the
        // deletion phrase — inside the five-minute retention window. Nothing is performed here.
        void transport;
        void identity;
        return;
      case "revoke-device": {
        // THE OPERAND PINNED WHEN THE FLOW WAS CREATED (F01), same reasoning as `checkout` above: a
        // newer attempt may have replaced `this.pendingOfferId` while this completion was awaiting.
        const target = flow.offerId !== null ? decodeRevokeTarget(flow.offerId) : null;
        if (target === null) return;
        await this.run(
          "revoke",
          (_client, t, _i, scope) => this.revokeWithin(scope, t, target.kind, target.targetId),
          flow,
        );
        return;
      }
    }
  }

  /** The enrolment, as a step of the completion `flow`. */
  private enrolUnder(flow: SignInFlow, mode: "register" | "recover-uid", pairHints: readonly string[]): Promise<void> {
    return this.run(
      "enrol-installation",
      (_client, transport, identity, scope) => this.enrolWithin(scope, transport, identity, mode, pairHints),
      flow,
    );
  }

  /** The trial, as a step of the completion `flow`. */
  private trialUnder(flow: SignInFlow): Promise<void> {
    return this.run(
      "start-trial",
      (_client, transport, identity, scope) => this.trialWithin(scope, transport, identity),
      flow,
    );
  }

  /**
   * Starts a LOGIN-ADDRESS change.
   *
   * `VERIFY_AND_CHANGE_EMAIL`: Firebase writes the new address only once somebody opens the link sent
   * TO it, so the original login keeps working until then (plan §7). A typo, or closing the app, does
   * not cut anybody off from their own account — which a direct address change would.
   *
   * The owner token is RELEASED as soon as the request is sent: holding it while waiting for a link
   * somebody may open tomorrow is exactly the long-lived owner credential this design exists to avoid.
   */
  async requestLoginEmailChange(newEmail: string): Promise<void> {
    // THE RELEASE IS IN A `finally`, AND THAT IS THE FIX (F02). It used to be the statement after
    // `await this.run(...)`, which does not run when the call throws — so a network failure, a
    // refusal or a malformed answer left the owner session held, `needsRecentAuth` false, and the
    // next owner action running on a credential whose last check had failed. The plan's own words:
    // "Selhání odeslání změny login adresy musí mít definované ukončení owner session podle v2."
    //
    // AND IT RELEASES ONLY THE SESSION THIS OPERATION STARTED WITH (S03). The `finally` runs however
    // late the answer is, and "late" can mean after a cancel and after a NEWER sign-in has proved a
    // new owner: an unconditional release then dropped that person's session and its retention timer
    // from under them. The generation is pinned here, before the first await, and compared at the end.
    const generation = this.ownerGeneration;
    try {
      await this.run("change-login-email", async (client, _transport, _identity, scope) => {
        const owner = this.requireOwnerFor(scope);
        if (!hasRecentAuth(owner, this.now())) throw new AccountManagerError("requires-recent-login");
        // WHICH REQUEST THIS IS, taken before it is sent (T02): the answer is compared against it, and
        // `requestedAt` is when the person asked, not when the network got round to answering.
        const sequence = ++this.emailChangeRequests;
        const requestedAt = this.now();
        await client.requestLoginEmailChange(owner, newEmail, { signal: scope.abort.signal });
        // WHAT THE UI IS ALLOWED TO SAY. A successful send is not a delivered message and is not a
        // completed change — and with email-enumeration protection on, it is not even evidence that
        // the address was free. `pendingEmailChange` is a note that we asked, and nothing more.
        //
        // THE NOTE NAMES THE ACCOUNT IT IS ABOUT (S03), and `state()` shows it only beside that account
        // or beside nobody. Firebase HAS sent the message, whatever happened to this operation since,
        // so the note is written even for a scope that has ended — but never over a different owner's
        // view. What it never does is claim the change is complete: only the new mailbox decides that.
        if (this.owner !== null && this.owner.uid !== owner.uid) {
          log.warn("account: a login-email change was sent for a session a newer sign-in has replaced", {
            operation: "change-login-email",
            scopeAlive: scope.alive,
          });
        }
        // AND NEVER OVER A NEWER REQUEST'S NOTE (S03, T02). The slot is single, and the request that
        // fills it is the NEWEST ONE ASKED FOR — not the one whose answer happened to arrive last. That
        // holds for a different person's request (S03) and for the same account asking twice (T02):
        // "first@" held, "second@" asked and noted, then "first@" answering late used to write the old
        // address back as the pending one. A note the person cleared is not put back either. The
        // message to the older address WAS sent — the log keeps that fact; the page keeps the newest ask.
        if (sequence > this.emailChangeSettled) {
          this.emailChangeSettled = sequence;
          this.pendingEmailChange = { email: newEmail, requestedAt, uid: owner.uid };
        } else {
          log.info("account: a late login-email change answer left a newer pending note alone", {
            operation: "change-login-email",
            scopeAlive: scope.alive,
            sameAccount: this.pendingEmailChange !== null && this.pendingEmailChange.uid === owner.uid,
            sentUnderSequence: sequence,
            settledSequence: this.emailChangeSettled,
          });
        }
      });
    } finally {
      this.releaseOwnerSessionOf(generation, "change-login-email");
    }
  }

  /** Clears the "waiting for the new address to be confirmed" note. Purely local. */
  clearPendingEmailChange(): void {
    this.pendingEmailChange = null;
    // A request still out when the person cleared the note does not put it back (T02).
    this.emailChangeSettled = this.emailChangeRequests;
    this.publish();
  }

  /** Ends the retention a sign-in opened. The runtime calls it once the action is done. */
  releaseOwnerSession(): void {
    if (this.ownerRetentionTimer !== null) {
      clearTimeout(this.ownerRetentionTimer);
      this.ownerRetentionTimer = null;
    }
    this.ownerRetained = false;
    this.discardOwnerSession();
  }

  /**
   * Keeps the owner session for the follow-up action, and for no longer than the recent-auth window.
   *
   * FIVE MINUTES FROM THE AUTHENTICATION, not from the last thing that happened (plan §7: "Čekání na
   * potvrzení navazující akce má maximálně 5 minut od autentizace"). It is the same window the server
   * enforces on `auth_time`, so a credential this manager still held past it would be one every
   * destructive door refuses anyway — with a worse error.
   */
  private retainOwner(session: OwnerSession): void {
    this.ownerRetained = true;
    if (this.ownerRetentionTimer !== null) clearTimeout(this.ownerRetentionTimer);
    // A SESSION WITH NO PROVEN `auth_time` IS STILL RETAINED FOR THE FULL WINDOW, and that is not a
    // loophole (F08). Retention is how long the credential is KEPT, not what it is allowed to do:
    // `hasRecentAuth` answers false for such a session, so every destructive door refuses it locally
    // and the server refuses it again. Retaining it for zero milliseconds would instead break the one
    // thing that works — an enrolment chain, which needs the credential and needs no recent-auth
    // claim — by arming a timer that fires in the middle of it.
    const authenticatedAt = session.authenticatedAt ?? this.now();
    const remaining = Math.max(0, authenticatedAt + RECENT_AUTH_WINDOW_MS - this.now());
    this.ownerRetentionTimer = setTimeout(() => {
      this.ownerRetentionTimer = null;
      this.releaseOwnerSession();
    }, remaining);
    this.ownerRetentionTimer.unref?.();
  }

  /**
   * Releases the owner credential unless a purpose chain owns it — and only if it is still the
   * credential the operation started with (S03).
   *
   * Every direct entry point calls this when its operation ends, which is what plan §7's "Konec owner
   * session" column asks for. Inside a chain it does nothing, and the chain's own `finally` releases
   * once. `generation` is `ownerGeneration` as it was when the operation began: a cleanup that runs
   * after a cancel and a newer sign-in must not end the newer person's session.
   */
  private releaseAfterOperation(generation: number, operation: string): void {
    if (this.purposeDepth > 0) return;
    this.releaseOwnerSessionOf(generation, operation);
  }

  /**
   * `releaseOwnerSession()`, for the operation that started under `generation` and no other (S03).
   *
   * A release moves the generation, so an operation whose session was already released (a cancel, a
   * closed panel, the retention lapsing) finds a mismatch and does nothing — as does one whose session
   * was REPLACED by a newer sign-in, which is the case that used to cost the newer person their
   * session and its retention timer. The skip is logged, because a cleanup that did not run is the
   * kind of thing a developer reading the log after a bug report needs to be able to see.
   */
  private releaseOwnerSessionOf(generation: number, operation: string): void {
    if (this.ownerGeneration !== generation) {
      log.info("account: cleanup left a newer owner session alone", {
        operation,
        startedUnder: generation,
        current: this.ownerGeneration,
      });
      return;
    }
    this.releaseOwnerSession();
  }

  private requireBroker(): EmailSignInBroker {
    const broker = this.deps.broker ?? null;
    if (!this.configured || broker === null) throw new AccountManagerError("auth-unavailable");
    return broker;
  }

  // --- enrolment ---------------------------------------------------------------------------------

  /**
   * Creates the account if it does not exist, then enrols THIS machine.
   *
   * The two-leg handshake in one call because they are one user action: leg 1 runs as the
   * installation and the server records that caller's uid on the challenge; leg 2 runs as the owner
   * and names only the challenge and the signature. Neither leg can name the other's identity, which
   * is what stops an anonymous session claiming an account and an owner session claiming somebody
   * else's installation.
   */
  async enrolThisInstallation(
    /**
     * `recover-uid`, exactly as the generated contract spells it.
     *
     * It used to be `recover` — a value the server's schema does not accept — so the recovery leg
     * was refused as malformed against a correct backend. The one path that exists for a desktop
     * that has lost its refresh token could never run at all.
     */
    mode: "register" | "recover-uid" = "register",
    pairHints: readonly string[] = [],
  ): Promise<void> {
    const generation = this.ownerGeneration;
    await this.run("enrol-installation", (_client, transport, identity, scope) =>
      this.enrolWithin(scope, transport, identity, mode, pairHints),
    );
    // The credential the enrolment needed is done with — UNLESS this is the first half of a
    // register-then-trial chain, which still needs it. Everything the page shows from here on is read
    // through the INSTALLATION session either way.
    this.releaseAfterOperation(generation, "enrol-installation");
  }

  /**
   * The enrolment itself, under one operation scope (R01).
   *
   * `scope` is checked before every mutation and after every await: a cancel, a closed panel, a
   * dispose or a NEWER sign-in during `ensureAccount` means no challenge is minted; during the
   * challenge means nothing is signed and sent; and a newer owner session is never the one the next
   * transport call runs as. WHAT THE SERVER HAS ALREADY DONE IS RECORDED REGARDLESS: a registration the
   * server accepted while the flow was being cancelled is a registered machine, and the marker and the
   * flag say so — cancel rolls nothing back, it stops the next step.
   */
  private async enrolWithin(
    scope: OperationScope,
    transport: AccountTransport,
    identity: InstallationIdentity,
    mode: "register" | "recover-uid",
    pairHints: readonly string[],
  ): Promise<void> {
    const owner = this.requireOwnerFor(scope);
    if (!owner.emailVerified) throw new AccountManagerError("requires-recent-login");
    if (!mayBindDifferentAccount(this.overview, this.installationRegistered)) {
      // Re-binding a machine whose pairings and relay identity belong to another account is how
      // one person's phone ends up listed under somebody else's account.
      throw new AccountManagerError("account-mismatch");
    }
    // THE INTENT, DURABLY, BEFORE THE SERVER IS ASKED (G13). A crash after the server has enrolled
    // this machine and before `bound` is written used to leave no marker at all — and no marker read
    // as "never enrolled", which is the one answer the guard must not give for a machine the server
    // now knows. An intent that cannot be written is a store that cannot hold the confirmation
    // either, so the enrolment is refused rather than performed on a machine that could not remember
    // it.
    if (!(await this.recordBinding("enrolling"))) throw new AccountManagerError("unknown");
    this.requireScope(scope);
    // ONE KEY PER MUTATION, HELD ACROSS ITS RETRIES (F06). `ensureAccount` and the registration are
    // two mutations with two keys, and neither shares one with the trial: a retry after a lost
    // answer has to be recognisable as the SAME request, and a new key would make it a second one.
    await this.mutate(scope, "ensure-account", owner.uid, {}, (_request, key) =>
      transport.ensureAccount(key, { signal: scope.abort.signal }),
    );
    this.requireScope(scope);

    // THE SAME REQUEST, OR A NEW ONE (R03). A registration whose answer was lost is resumed with the
    // challenge, the signature, the mode, the label and the hints it was sent with — the server
    // digests all of those under the key, and a fresh challenge under the old key is refused as
    // `idempotency-key-reused`. Only when nothing is pending is a new challenge minted.
    let request = this.pendingRequest<RegistrationRequest>("enrol", owner.uid);
    if (request === null) {
      const challenge = await transport.beginInstallationRegistration(
        {
          installationId: identity.installationId,
          publicKey: identity.publicKeyBase64Url,
          ...(this.deps.installationLabel === undefined ? {} : { label: this.deps.installationLabel }),
        },
        // THE SCOPE'S SIGNAL, ALL THE WAY DOWN (S02). The guard above ran, and then the transport waits
        // for a token; a cancel that lands during that wait must stop the request from being sent.
        { signal: scope.abort.signal },
      );
      this.requireScope(scope);
      // The transcript comes from the SERVER and is signed verbatim. A transcript each side assembles
      // from its own idea of the format is a signature that verifies until somebody edits one of them.
      const signature = identity.signChallenge(Buffer.from(challenge.transcript, "utf8"));
      // THE PAIRS THIS MACHINE ALREADY HAS. Locators, not evidence: the server proves ownership from
      // each pair's own server-written `publicMeta.desktopUid`. Passing none meant a desktop that had
      // paired before it had an account enrolled with its phones left behind — §6.5's whole case.
      const hints = pairHints.length > 0 ? pairHints : (this.deps.knownPairIds?.() ?? []);
      request = {
        challengeId: challenge.challengeId,
        signature: signature.toString("base64url"),
        mode,
        ...(this.deps.installationLabel === undefined ? {} : { label: this.deps.installationLabel }),
        ...(hints.length === 0 ? {} : { pairHints: [...hints] }),
      };
    }
    this.requireScope(scope);
    // WHAT THE MACHINE'S BINDING WAS WHEN THIS REQUEST WENT OUT (S01). Compared after the answer.
    const revision = this.bindingRevision;
    const result = await this.mutate(scope, "enrol", owner.uid, request, (sent, key) =>
      transport.completeInstallationRegistration({ ...sent, idempotencyKey: key }, { signal: scope.abort.signal }),
    );
    // THE SERVER HAS ANSWERED, AND WHAT IT DID IS RECORDED WHETHER OR NOT THIS SCOPE IS STILL WANTED.
    // `uid-recovered` IS A SUCCESS — it is the whole answer the recovery mode exists to receive — and
    // treating it as a refusal meant a recovery that worked on the server was reported to the user as a
    // failure, with the local state left saying the machine was not enrolled.
    //
    // BUT NOT OVER A NEWER AUTHORITATIVE ANSWER (S01). "Regardless of the scope" is right for a cancel
    // — cancel rolls nothing back — and wrong once something authoritative has landed since this
    // request was sent: a newer flow's registration, an overview, a sign-out. A late refusal then wrote
    // `none` over a `bound` the newer flow had just confirmed, and a late success wrote `bound` back
    // over a sign-out. The late answer is still THIS operation's result — the refusal is thrown, the
    // success continues — but the shared state is not its to write. What settles the machine instead
    // is a fresh, ordered overview read issued now, after both; until it answers, the marker stays as
    // the newer authority left it, which is the conservative choice in both directions.
    if (this.bindingRevision !== revision) {
      log.warn("account: a registration answered after a newer binding was applied; not written", {
        operation: "enrol-installation",
        answer: result.status,
        scopeAlive: scope.alive,
        sentUnderRevision: revision,
        currentRevision: this.bindingRevision,
      });
      this.diagnostics.record({
        at: this.now(),
        event: "account.binding-marker",
        status: `late-answer-withheld:${result.status}`,
        level: "warn",
      });
      await this.reconcileBinding(transport);
      if (result.status === "refused")
        throw new AccountManagerError(toAccountErrorCode({ details: result.errorReason }));
      this.requireScope(scope);
      return;
    }
    if (result.status === "refused") {
      // The server did NOT enrol this machine: the intent is withdrawn, and the identity is free.
      await this.applyBinding("none", "operation");
      throw new AccountManagerError(toAccountErrorCode({ details: result.errorReason }));
    }
    // The durable marker, written as soon as the server says the enrolment stands — BEFORE the
    // overview read below, which can fail. A write that fails here leaves `enrolling`, which the
    // guard treats as bound: the machine keeps its identity, and the next server answer settles it.
    await this.applyBinding("bound", "operation");
    // The re-read is ordered against every other overview read, so it cannot overwrite a newer
    // answer; it is only refused as a STEP once the truth above has been recorded.
    this.requireScope(scope);
    await this.refreshOverviewInternal(transport);
  }

  /**
   * The safe way to find out what this machine IS when two answers disagree about the order they
   * happened in (S01): ask the server again, now, after both. The read is ordered like every other
   * overview read, so it cannot itself be overtaken by an older one. A failure changes nothing — the
   * marker keeps the newer authority's answer — and is logged, because a reconciliation that could not
   * run is what a developer needs to see next to the warning that asked for it.
   */
  private async reconcileBinding(transport: AccountTransport): Promise<void> {
    try {
      await this.refreshOverviewInternal(transport);
    } catch (error) {
      log.warn("account: the binding could not be re-read after a late registration answer", {
        code: codeOf(error),
      });
    }
  }

  /**
   * Applies an AUTHORITATIVE answer about this machine's binding — the flag, the marker and the
   * revision, together (S01). Every place that learns from the server whether this machine is bound
   * goes through here, so a registration answer can tell whether anything landed after it was sent.
   */
  private async applyBinding(marker: "bound" | "none", source: "operation" | "overview-read"): Promise<boolean> {
    this.bindingRevision += 1;
    // AN OPERATION'S ANSWER FENCES EVERY READ ALREADY OUT (T01); a read's own answer does not, or the
    // second of two in-order answers would be thrown away for having been issued beside the first.
    if (source === "operation") this.bindingWrittenByOperationAt = this.bindingRevision;
    this.installationRegistered = marker === "bound";
    return this.recordBinding(marker);
  }

  /**
   * Restores what this machine already is, from its PERSISTENT installation session alone.
   *
   * Called by the runtime at start-up. Before it, a restarted desktop had no owner session and
   * therefore no account state at all: the page said "not enrolled" until somebody signed in again,
   * on a machine that was enrolled the whole time. Quiet by construction — a failure here is a
   * machine that has not enrolled yet, which is not an error.
   */
  async restoreFromInstallation(): Promise<void> {
    if (!this.configured) return;
    // THE LOCAL MARKER FIRST, before anything is asked over the network (F12). The overview read
    // below uses the persisted refresh token, so on the one start-up that matters — the one where
    // that token has been rejected — it cannot answer this question at all, and the answer it fails
    // to give is the guard that stops a new anonymous uid being minted.
    //
    // The PAGE shows `bound` and nothing else as enrolled; the GUARD (in the runtime) keeps the
    // identity for `enrolling`, `absent` and `unknown` too. Those are different questions: what to
    // display while the server has not answered, and what may be destroyed meanwhile.
    this.installationRegistered = bindingSaysEnrolled(this.deps.readInstallationBinding?.() ?? "absent");
    try {
      await this.refreshOverviewInternal(this.deps.transport!);
    } catch (error) {
      // ONLY AN ANSWER THAT IS STILL THE NEWEST REACHES THIS CATCH (T01). `refreshOverviewInternal`
      // swallows the failure of a read that a newer read or an operation has overtaken, so the
      // `overview = null` and the `none` below can no longer erase a registration that completed while
      // the start-up read was out. The runtime does not await this method; it runs beside the first
      // sign-in, and a `not-bound-to-an-account` for the machine this WAS is not an answer about the
      // machine it has since become.
      this.overview = null;
      if (error instanceof AccountCallableError && error.reason === "not-bound-to-an-account") {
        // THE SERVER ANSWERED, and the answer is "not bound". That is the one thing that may write
        // `none` — for a fresh install, and for one an older build never wrote a marker for (G13). It
        // is the READ's answer, so it fences nothing issued after it.
        await this.applyBinding("none", "overview-read");
      } else {
        // The control plane could not be reached, or the credential was refused. NEITHER is evidence
        // that this machine was never enrolled: the durable marker keeps its answer, and the page shows
        // the unenrolled state only when nothing local says otherwise. The next foreground action
        // surfaces a real error.
        this.installationRegistered = bindingSaysEnrolled(this.deps.readInstallationBinding?.() ?? "absent");
      }
    }
    this.publish();
  }

  async startTrial(): Promise<void> {
    const generation = this.ownerGeneration;
    await this.run("start-trial", (_client, transport, identity, scope) =>
      this.trialWithin(scope, transport, identity),
    );
    this.releaseAfterOperation(generation, "start-trial");
  }

  private async trialWithin(
    scope: OperationScope,
    transport: AccountTransport,
    identity: InstallationIdentity,
  ): Promise<void> {
    const owner = this.requireOwnerFor(scope);
    // THE TRIAL'S OWN KEY, kept until the answer is definite (F06). A trial whose response was lost
    // is retried as the same request, so the server's idempotency record recognises it — which is
    // what makes "the resume performs only the unfinished step" mean something rather than being a
    // second trial with a new name.
    const result = await this.mutate(
      scope,
      "trial",
      owner.uid,
      { installationId: identity.installationId },
      (sent, key) => transport.startTrial({ ...sent, idempotencyKey: key }, { signal: scope.abort.signal }),
    );
    // `not-eligible` carries WHY — the trial tombstone for this key, an account that has already
    // paid, a key that belongs elsewhere — and the page needs the reason, not just a refusal.
    if (result.status === "not-eligible") throw new AccountManagerError(toAccountErrorCode({ code: result.reason }));
    this.requireScope(scope);
    await this.refreshOverviewInternal(transport);
  }

  // --- reading ------------------------------------------------------------------------------------

  async refreshOverview(): Promise<void> {
    await this.run("refresh-overview", async (_client, transport) => {
      await this.refreshOverviewInternal(transport);
    });
  }

  /**
   * Called by the runtime when the server's token-refresh marker moves.
   *
   * The marker means "your claims changed": a new token has to be fetched AND the overview re-read,
   * because what changed may be the thing the page is showing. Deliberately quiet — it must not
   * flash a busy state on every window for a background refresh.
   */
  async onClaimsChanged(): Promise<void> {
    if (!this.configured) return;
    try {
      // The OWNER session only if one happens to be held — it usually is not, and that is the point:
      // the marker means the INSTALLATION's claims changed, and the runtime force-refreshes that
      // session and restarts its streams (see `runtime.ts`). Re-reading the overview here is what
      // makes the page agree with the new claims.
      if (this.owner !== null) await this.refreshOwner(this.owner);
      await this.refreshOverviewInternal(this.deps.transport!);
    } catch {
      // A background refresh that fails changes nothing a user asked for. The next foreground action
      // will surface a real error.
    }
    this.publish();
  }

  /**
   * Refreshes `owner` and keeps the result ONLY if it is still the session that was asked about (R02).
   *
   * Between the request and the answer the session may have been released (a cancel, a closed panel,
   * the retention lapsing) or replaced (a newer sign-in). Either moves `ownerGeneration`, and either
   * aborts the request through `ownerAbort`; if the answer arrives anyway it is dropped, because
   * writing it back would put a released credential in the manager with no retention timer over it, or
   * overwrite the newer person's session with the older one's.
   */
  private async refreshOwner(owner: OwnerSession): Promise<OwnerSession | null> {
    const generation = this.ownerGeneration;
    const signal = this.ownerAbort?.signal;
    let refreshed: OwnerSession;
    try {
      refreshed = await this.deps.client!.refresh(owner, signal === undefined ? undefined : { signal });
    } catch (error) {
      // The session went away while the refresh was out: that is the answer, not the network.
      if (this.owner === null) throw new AccountManagerError("invalid-credentials");
      if (this.ownerGeneration !== generation) throw new AccountManagerError("sign-in-superseded");
      throw error;
    }
    if (this.owner === null) throw new AccountManagerError("invalid-credentials");
    if (this.ownerGeneration !== generation) throw new AccountManagerError("sign-in-superseded");
    this.owner = refreshed;
    return refreshed;
  }

  // --- billing -------------------------------------------------------------------------------------

  /**
   * Asks for a checkout URL and opens it in the user's own browser.
   *
   * The URL is returned by the call, validated by the SERVER against an exact host allowlist, opened
   * once and never stored. It is not returned to the renderer either: a URL that reaches a renderer
   * is a URL that reaches a state diff, a devtools console and a crash report.
   */
  async openCheckout(offerId: string): Promise<"opened" | "pending"> {
    const generation = this.ownerGeneration;
    const outcome = await this.run("open-checkout", (_client, transport, identity, scope) =>
      this.checkoutWithin(scope, transport, identity, offerId),
    );
    this.releaseAfterOperation(generation, "open-checkout");
    return outcome;
  }

  private async checkoutWithin(
    scope: OperationScope,
    transport: AccountTransport,
    identity: InstallationIdentity,
    offerId: string,
  ): Promise<"opened" | "pending"> {
    // NOT `requireOwnerFor(scope)`: billing is authorized server-side by this desktop's own active
    // installation (I3), not by a live owner session — an owner sign-in is a brief verification step,
    // not the credential billing should depend on. `requireScope` alone is the same check
    // `portalWithin` already makes.
    this.requireScope(scope);
    // Same rule, and here it is money: a checkout whose answer was lost must be retried as the same
    // intent rather than as a second one (F06) — and a DIFFERENT offer asked for while that answer is
    // still unknown does not inherit the old intent (R03): `mutate` first re-sends the old request,
    // verbatim, and opens nothing from it; only then does the new offer get a key of its own.
    const result = await this.mutate(
      scope,
      "checkout",
      identity.installationId,
      { offerId, installationId: identity.installationId },
      (sent, key) => transport.createCheckout({ ...sent, idempotencyKey: key }, { signal: scope.abort.signal }),
    );
    if (result.status === "ready" && result.checkoutUrl) {
      await this.openBillingUrl(scope, result.checkoutUrl);
      return "opened" as const;
    }
    if (result.status === "checkout-pending") return "pending" as const;
    throw new AccountManagerError(toAccountErrorCode({ details: result.errorReason }));
  }

  /** A FRESH portal session every time. Paddle's URL is temporary and must never be cached. */
  async openBillingPortal(): Promise<void> {
    const generation = this.ownerGeneration;
    await this.run("open-billing-portal", (_client, transport, identity, scope) =>
      this.portalWithin(scope, transport, identity),
    );
    this.releaseAfterOperation(generation, "open-billing-portal");
  }

  private async portalWithin(
    scope: OperationScope,
    transport: AccountTransport,
    identity: InstallationIdentity,
  ): Promise<void> {
    this.requireScope(scope);
    const result = await transport.createPortalSession(
      { installationId: identity.installationId },
      { signal: scope.abort.signal },
    );
    if (result.status !== "ready" || !result.portalUrl) {
      throw new AccountManagerError(toAccountErrorCode({ details: result.errorReason }));
    }
    await this.openBillingUrl(scope, result.portalUrl);
  }

  /**
   * The one place a billing URL leaves this process.
   *
   * HTTPS and an EXACT host from the signed bootstrap allowlist, checked HERE and not only at the
   * server (plan §2 asks for both boundaries). "It came from the callable" is not a property that
   * survives a malformed or compromised response, and the opener's job is to hand a URL to the
   * operating system — `shell.openExternal` invokes the registered protocol handler, so the last
   * check before it is the one that matters.
   *
   * AND THE OPERATION HAS TO STILL BE WANTED (R01). The answer to a checkout or portal request used to
   * open a browser whenever it arrived — after the flow was cancelled, after the panel that asked for
   * it had closed. A URL is the one side effect here that cannot be taken back.
   */
  private async openBillingUrl(scope: OperationScope, url: string): Promise<void> {
    const allowlist = this.deps.billingHosts?.() ?? [];
    const refusal = checkBillingUrl(url, allowlist);
    if (refusal !== null) {
      // A REFUSAL, not a silent success. A checkout that "worked" and opened nothing is a payment
      // problem the user cannot act on and support cannot see.
      throw new AccountManagerError(refusal === "no-allowlist" ? "not-configured" : "checkout-url-not-allowed");
    }
    this.requireScope(scope);
    await this.deps.openExternal(url);
  }

  // --- revocation and deletion ---------------------------------------------------------------------

  async revoke(kind: RevokeKind, targetId?: string): Promise<void> {
    await this.run("revoke", (_client, transport, _identity, scope) =>
      this.revokeWithin(scope, transport, kind, targetId),
    );
  }

  /**
   * The revoke itself, factored out of {@link revoke} so the `revoke-device` purpose (a retry after a
   * server `reauthentication-required` refusal, plan §7/C2) can run the SAME request under its own
   * flow's scope instead of duplicating it.
   */
  private async revokeWithin(
    scope: OperationScope,
    transport: AccountTransport,
    kind: RevokeKind,
    targetId: string | undefined,
  ): Promise<void> {
    this.requireScope(scope);
    await transport.revokeAccountDevice(
      {
        kind,
        ...(targetId === undefined ? {} : { targetId }),
        idempotencyKey: this.newKey(),
      },
      { signal: scope.abort.signal },
    );
    await this.refreshOverviewInternal(transport);
  }

  async acknowledgeNotice(noticeId: string): Promise<void> {
    await this.run("acknowledge-notice", async (_client, transport, _identity, scope) => {
      await transport.acknowledgeNotice(noticeId, { signal: scope.abort.signal });
      await this.refreshOverviewInternal(transport);
    });
  }

  /**
   * Signs THIS INSTALLATION out — an online revocation, in this order and no other.
   *
   * The server revokes first; only then is the local credential dropped. Reversing the two leaves a
   * machine that cannot revoke its own pairings and a server that still believes they are live, and
   * a network failure in the middle leaves the session signed in and retryable rather than stranded.
   *
   * The OWNER ACCOUNT is untouched. Closing the app is not a sign-out either.
   */
  async signOutInstallation(args: { readonly disconnect: boolean }): Promise<void> {
    await this.run("sign-out-installation", async (_client, transport, identity, scope) => {
      const assessment = assessSignOut(this.overview);
      if (assessment.blockers.length > 0 && !args.disconnect) {
        // The UI offers "cancel" or "disconnect this installation"; it never silently disconnects
        // somebody's phones because they clicked sign out.
        throw new AccountManagerError("account-mismatch");
      }
      if (this.installationRegistered) {
        await transport.revokeAccountDevice(
          {
            kind: "installation",
            targetId: identity.installationId,
            idempotencyKey: this.newKey(),
          },
          { signal: scope.abort.signal },
        );
      }
      // AND THE CREDENTIAL, but only now. Invariant 12: the server revocation has completed, so the
      // refresh token this machine has been signing in with may finally go. Clearing only this
      // object's own fields — which is all this used to do — left the token on disk, and the next
      // start signed the machine straight back in as an installation the server had just revoked.
      await this.deps.forgetInstallationCredential?.();
      // And the durable marker with it: this machine is deliberately no longer bound, so a fresh
      // anonymous identity IS the right answer for it from here on. `none` is the one marker that
      // releases it — which also makes this the way out of the recovery state for a machine whose
      // marker could not be read. AUTHORITATIVE (S01): a registration answer that lands after this
      // does not write `bound` back over it.
      await this.applyBinding("none", "operation");
      this.overview = null;
      // THIS IS THE NEWEST AUTHORITATIVE ANSWER about the overview (R01): a read that was in flight
      // when the machine signed out must not resurrect the account it just left when it lands.
      this.overviewApplied = ++this.overviewRequests;
      // THROUGH `releaseOwnerSession`, not by clearing two fields: it also cancels the retention
      // timer, and a timer left armed would fire into an object that has just signed out.
      this.releaseOwnerSession();
      // And any attempt in flight, for the same reason — a sign-in that completed after this would be
      // completing into a machine that is no longer bound to anything. The COMPLETION half too (F01):
      // a redemption still unwinding would otherwise walk into `performPurpose` on a machine that has
      // just signed out — and every other operation (R01), except this one.
      this.abandonOperations(scope);
      this.deps.broker?.cancel();
      this.pendingMutations.clear();
      // AND THE NOTE, as a CLEAR (T02): a change request still out when the machine signed out must not
      // write the address back beside nobody once it answers. The same rule `clearPendingEmailChange`
      // follows, for the most explicit clear there is.
      this.pendingEmailChange = null;
      this.emailChangeSettled = this.emailChangeRequests;
    });
  }

  async deleteAccount(confirmationPhrase: string): Promise<{ providerCancellationRequired: boolean }> {
    // THE SESSION ENDS WHEN THE REQUEST HAS BEEN SUBMITTED (passwordless plan §7's table, last row).
    // It used to be kept indefinitely so a durable deletion job could "answer for it", but nothing
    // asks it to: the job runs server-side against a record, and an owner credential held open for an
    // unbounded time is precisely the long-lived credential this design exists to avoid. What the
    // deletion needs from the person — a recent sign-in and an exact phrase — has already happened by
    // the time this returns.
    //
    // AND ONLY THE SESSION IT STARTED WITH GOES (S03) — the same rule as `requestLoginEmailChange`,
    // for the same `finally`.
    const generation = this.ownerGeneration;
    try {
      return await this.deleteAccountInternal(confirmationPhrase);
    } finally {
      this.releaseAfterOperation(generation, "delete-account");
    }
  }

  private async deleteAccountInternal(confirmationPhrase: string): Promise<{ providerCancellationRequired: boolean }> {
    return this.run("delete-account", async (_client, transport, _identity, scope) => {
      const owner = this.requireOwnerFor(scope);
      if (!hasRecentAuth(owner, this.now())) throw new AccountManagerError("requires-recent-login");
      const result = await transport.deleteAccount(
        { confirmationPhrase, idempotencyKey: this.newKey() },
        { signal: scope.abort.signal },
      );
      if (result.status === "refused") throw new AccountManagerError("unknown");
      // The local credential is NOT dropped here. The deletion is a durable job that may still need
      // this session to answer for it, and the runtime removes the credential when the job reports
      // it is done — see the plan's §10 step 6.
      return { providerCancellationRequired: result.providerCancellationRequired };
    });
  }

  // --- diagnostics ---------------------------------------------------------------------------------

  /**
   * Sends the bounded, redacted report, and answers with the reference to quote.
   *
   * OPT-IN, ALWAYS. Nothing here runs unless somebody pressed the button, and what is sent is
   * exactly what `exportDiagnostics` writes to a file — so a user who wants to see it first can.
   *
   * The report is trimmed to the SERVER's own bounds before it leaves (see `account-diagnostics.ts`):
   * the server refuses rather than truncates, and a refusal would cost the user both the report and a
   * slot of their daily budget.
   */
  async submitDiagnostics(note?: string): Promise<{ reportId: string; entryCount: number }> {
    return this.run("submit-diagnostics", async (_client, transport) => {
      const report = this.buildReport(note);
      if (report.entries.length === 0) throw new AccountManagerError("diagnostics-empty");
      const result = await transport.submitDiagnostics(report);
      this.lastDiagnosticsReportId = result.reportId;
      return result;
    });
  }

  /**
   * The same document, for local export.
   *
   * For the states where the upload is not available at all — no account bound yet, no network, or a
   * refusal — and it deliberately does NOT need the transport, a signed-in owner or the busy path.
   * The evidence a user can send by hand is the last thing that should depend on the thing that is
   * broken.
   */
  exportDiagnostics(note?: string): { filename: string; content: string; entryCount: number } {
    const report = this.buildReport(note);
    return {
      filename: diagnosticsExportFilename(this.now()),
      content: renderDiagnosticsExport(report),
      entryCount: report.entries.length,
    };
  }

  /** Records one line of this installation's own log. Fixed vocabulary; see the module header. */
  recordDiagnostic(entry: DiagnosticsEntry): void {
    this.diagnostics.record(entry);
  }

  private buildReport(note?: string) {
    return buildDiagnosticsReport({
      entries: [...this.diagnostics.entries(), ...(this.deps.collectExtraDiagnostics?.() ?? [])],
      ...(note === undefined ? {} : { note }),
      ...(this.deps.appInfo === undefined ? {} : { app: this.deps.appInfo }),
    });
  }

  // --- internals -------------------------------------------------------------------------------------

  private requireOwner(): OwnerSession {
    if (this.owner === null) throw new AccountManagerError("invalid-credentials");
    return this.owner;
  }

  /**
   * Drops the owner credential.
   *
   * Called at the end of every operation that needed one. Plan §2: the owner session is short-lived
   * and for enrolment or a recent reauthentication only. Holding it meant the account page and the
   * billing calls ran as the owner indefinitely, which is exactly what the per-installation uid
   * design exists to avoid — a revoked laptop with a live owner session is not revoked.
   */
  private discardOwnerSession(): void {
    if (this.ownerRetained) return;
    if (this.owner === null) return;
    this.owner = null;
    // A NEW GENERATION, AND THE OLD ONE'S REFRESH IS ABORTED (R02). A refresh still in flight for the
    // session just dropped must not put it back when it lands, and need not finish at all.
    this.ownerGeneration += 1;
    this.ownerAbort?.abort();
    this.ownerAbort = null;
    this.publish();
  }

  /** Installs a PROVED owner session as a new generation. The only writer of `owner` besides a refresh. */
  private setOwner(session: OwnerSession): void {
    this.ownerAbort?.abort();
    this.owner = session;
    this.ownerGeneration += 1;
    this.ownerAbort = new AbortController();
  }

  /**
   * The one place the owner's id token is produced, refreshed on the way out if it is due.
   *
   * NEVER THE TOKEN OF A REPLACED SESSION (R02). The refresh is an await, and what is held afterwards
   * is whatever `refreshOwner` accepted for the generation it started with: a session dropped or
   * replaced in the meantime is a refusal here, not the newer person's token handed to the older
   * person's operation.
   */
  async tokenFor(kind: "installation" | "owner", signal?: AbortSignal): Promise<string> {
    if (kind === "installation") throw new AccountManagerError("not-configured");
    // THE OPERATION THAT IS ASKING MUST STILL BE RUNNING (S02). `signal` is its scope's: an operation
    // ended while this refresh was out gets a refusal, not a token — and never the token of whatever
    // owner session the manager holds by the time the refresh lands.
    if (signalFired(signal)) throw new AccountManagerError("sign-in-superseded");
    const owner = this.requireOwner();
    if (!needsRefresh(owner, this.now())) return owner.idToken;
    const refreshed = await this.refreshOwner(owner);
    if (signalFired(signal)) throw new AccountManagerError("sign-in-superseded");
    return (refreshed ?? this.requireOwner()).idToken;
  }

  private async afterOwnerReady(): Promise<void> {
    // A verified owner may already have an account and this machine may already be enrolled. Asking
    // is cheap and is the only way to know; assuming either way produces a page that is wrong on the
    // second machine somebody signs in on.
    try {
      await this.refreshOverviewInternal(this.deps.transport!);
      this.installationRegistered = this.overview !== null && this.installationIsListed();
    } catch {
      // A FAILED READ IS NOT AN ANSWER (the same rule `restoreFromInstallation` follows). The control
      // plane could not be reached, or the credential was refused; neither is evidence that this
      // machine was never enrolled. Setting `false` here would flash "add this desktop" at somebody
      // who is enrolled, entitled and merely offline — and nothing durable is written either way, so
      // the marker keeps the answer.
      this.installationRegistered = bindingSaysEnrolled(this.deps.readInstallationBinding?.() ?? "absent");
    }
  }

  private installationIsListed(): boolean {
    const id = this.deps.identity?.installationId;
    if (!id || !this.overview) return false;
    return this.overview.installations.some((row) => row.installationId === id && row.state === "active");
  }

  /**
   * Reads the overview and applies it — unless the answer is STALE, in which case it applies nothing and
   * says so. Stale means a newer read has been applied since (R01), or an operation wrote the binding
   * since this read was issued (T01). A stale read's FAILURE is swallowed too: the caller's catch is
   * where `overview = null` and `applyBinding("none")` live, and an old refusal reaching it wrote over a
   * newer registration. The caller learns from the return value, not from a throw, that the state it
   * sees is newer than the read it asked for.
   */
  private async refreshOverviewInternal(transport: AccountTransport): Promise<"applied" | "stale"> {
    const request = ++this.overviewRequests;
    const revision = this.bindingRevision;
    let overview: AccountOverview;
    try {
      overview = await transport.getAccountOverview();
    } catch (error) {
      if (this.overviewIsStale(request, revision)) {
        log.info("account: an overview read failed after a newer binding was applied; not written", {
          code: codeOf(error),
          sentUnderRevision: revision,
          currentRevision: this.bindingRevision,
        });
        return "stale";
      }
      throw error;
    }
    // AN OLDER ANSWER NEVER OVERWRITES A NEWER ONE (R01). Two reads can be in flight — a step of an
    // abandoned flow and the newer flow's own — and the network does not promise to answer them in
    // order; neither does a sign-out wait for a read it did not start. NOR DOES A REGISTRATION (T01): an
    // overview issued before the server enrolled this machine does not list it, and applying it after
    // the registration's `bound` wrote `none` over a marker that was right.
    if (this.overviewIsStale(request, revision)) {
      log.info("account: an overview answered after a newer binding was applied; not written", {
        sentUnderRevision: revision,
        currentRevision: this.bindingRevision,
      });
      return "stale";
    }
    this.overviewApplied = request;
    this.overview = overview;
    // The SERVER has answered, so the durable marker follows it — in both directions. An installation
    // the account no longer lists has genuinely been revoked, and holding the marker for it would
    // leave the machine unable to sign in as anything at all. Authoritative (S01).
    await this.applyBinding(this.installationIsListed() ? "bound" : "none", "overview-read");
    return "applied";
  }

  /** See {@link refreshOverviewInternal}: overtaken by a newer read, or by an operation's binding write. */
  private overviewIsStale(request: number, issuedUnderRevision: number): boolean {
    return request <= this.overviewApplied || this.bindingWrittenByOperationAt > issuedUnderRevision;
  }

  /**
   * Runs one logical mutation under a key that survives its retries (F06), as the SAME request (R03).
   *
   * THE RELEASE RULE IS THE WHOLE THING. A DEFINITE outcome — the server answered, whatever it said —
   * frees the key, because the next press is a new intention. An UNKNOWN outcome keeps it, because the
   * next press is the same intention being asked again and the server has to be able to recognise it
   * as such. A transport failure is unknown; so is an answer this desktop could not read (R04) — the
   * server may have completed the mutation and said so in bytes that never arrived whole. Every other
   * refusal is an answer that arrived.
   *
   * AND THE KEY IS PRESENTED ONLY WITH THE REQUEST IT WAS MINTED FOR. The server digests the whole
   * request under the key and refuses a different one as `idempotency-key-reused`, so:
   *
   *   - the same principal asking the same request again is the retry, and gets the pending key and
   *     the pending request verbatim;
   *   - the same principal asking a DIFFERENT request while the previous one's fate is unknown first
   *     has the previous one re-sent, verbatim, to learn what happened. Its answer is consumed here and
   *     handed to nobody — a checkout for offer A is never opened as the result of asking for offer B —
   *     and if it is STILL unknown the new request is not attempted;
   *   - a different principal is a different mutation on the server too, and the old record is
   *     forgotten rather than resolved as somebody else.
   *
   * WHAT THIS DELIBERATELY DOES NOT DO: invent a different mutation to find out what happened. The
   * plan is explicit — "Při neznámém výsledku mutace nejprve navázat bezpečné zjištění výsledku/retry
   * podle serverového kontraktu, nikoli vytvořit jinou logickou mutaci" — and the server contract's
   * own way of resolving an unknown result is the idempotency key plus the same request.
   *
   * NOTHING HERE IS PERSISTED. After a restart the records are gone and the state is re-read from the
   * server instead of a pending attempt being promised back (F06's last bullet); a key kept on disk
   * would be a claim about a request whose fate this process never learned.
   */
  private async mutate<R, T>(
    scope: OperationScope,
    name: MutationName,
    principal: string,
    request: R,
    send: (request: R, key: string) => Promise<T>,
  ): Promise<T> {
    const identity = canonical(request);
    let pending = this.pendingMutations.get(name) ?? null;
    if (pending !== null && pending.principal !== principal) {
      this.pendingMutations.delete(name);
      pending = null;
    }
    if (pending !== null && pending.identity !== identity) {
      // RESOLVE THE OLD ONE FIRST, and open nothing from it. A definite answer — success or refusal —
      // settles it and frees the name; an unknown one is rethrown, so the new request waits.
      try {
        await this.sendUnderKey(name, pending, send as (request: unknown, key: string) => Promise<unknown>);
      } catch (error) {
        if (isUnknownMutationOutcome(error)) throw error;
      }
      this.requireScope(scope);
      pending = null;
    }
    const record: PendingMutation = pending ?? { key: this.newKey(), principal, request, identity, inFlight: null };
    return (await this.sendUnderKey(name, record, send as (request: unknown, key: string) => Promise<unknown>)) as T;
  }

  /**
   * One send of one pending record. Definite answers release it; unknown ones keep it.
   *
   * RELEASED BY IDENTITY, NOT BY NAME (S04). The map used to be cleared by `name` when the answer came
   * back, and the answer that came back was not always for the record in the map: request A still out,
   * its flow cancelled, a newer flow storing request B of the same kind under a different principal —
   * and A's late definite answer deleted B. If B's own answer was then lost on the network, nothing
   * put it back, and the retry that should have re-sent B under B's key minted a new one, which is a
   * second mutation. A send now releases the record only if that record is still the one on file.
   *
   * ONE SEND AT A TIME PER RECORD. Two callers reaching the same record while its send is out share the
   * promise — one request, one key, one answer — instead of sending the key twice and racing to release.
   */
  private async sendUnderKey(
    name: MutationName,
    record: PendingMutation,
    send: (request: unknown, key: string) => Promise<unknown>,
  ): Promise<unknown> {
    if (record.inFlight !== null) {
      log.info("account: a mutation already in flight is shared rather than sent again", { mutation: name });
      return record.inFlight;
    }
    this.pendingMutations.set(name, record);
    const attempt = (async () => {
      try {
        const result = await send(record.request, record.key);
        this.releasePending(name, record, "answered");
        return result;
      } catch (error) {
        if (isUnknownMutationOutcome(error)) {
          log.warn("account: a mutation's outcome is unknown; its key and request are kept for a retry", {
            mutation: name,
            code: codeOf(error),
          });
        } else {
          this.releasePending(name, record, "refused");
        }
        throw error;
      } finally {
        record.inFlight = null;
      }
    })();
    record.inFlight = attempt;
    return attempt;
  }

  /** Forgets `record` — and only `record`. A different record under the same name is somebody else's (S04). */
  private releasePending(name: MutationName, record: PendingMutation, why: "answered" | "refused"): void {
    if (this.pendingMutations.get(name) === record) {
      this.pendingMutations.delete(name);
      return;
    }
    log.info("account: a late mutation answer left a newer pending record alone", { mutation: name, why });
  }

  /** The request a pending mutation of `name` was sent with, if this principal has one. */
  private pendingRequest<R>(name: MutationName, principal: string): R | null {
    const pending = this.pendingMutations.get(name);
    if (pending === undefined || pending.principal !== principal) return null;
    return pending.request as R;
  }

  /**
   * Writes a binding marker and REPORTS a failure instead of swallowing it (G13).
   *
   * The marker is a security assumption — the guard on the anonymous fallback reads it — and a write
   * that quietly did nothing left the disk saying whatever it said before. Nothing here can make the
   * store work; what it can do is leave a fail-closed state behind (the caller chooses which) and put
   * the failure where a diagnostics report will carry it.
   */
  private async recordBinding(marker: InstallationBindingMarker): Promise<boolean> {
    if (!this.deps.writeInstallationBinding) return true;
    try {
      await this.deps.writeInstallationBinding(marker);
      return true;
    } catch (error) {
      log.error("account: the installation binding marker could not be written", {
        marker,
        error: error instanceof Error ? error.message : String(error),
      });
      this.diagnostics.record({
        at: this.now(),
        event: "account.binding-marker",
        status: `write-failed:${marker}`,
        level: "error",
      });
      return false;
    }
  }

  /**
   * Runs one operation with the busy flag, the error mapping and exactly one publish.
   *
   * ONE PUBLISH PER OPERATION, in a `finally`: a failure has to move the state too — the error is
   * part of what the page shows — and a success that forgot to publish is a page that stays busy.
   *
   * UNDER A SCOPE (R01). Without `existing`, a fresh {@link OperationScope} is opened for the body and
   * closed after it. With `existing` — the completion's flow — the body is a NESTED step: it records
   * its own diagnostics line and nothing else, because `busy` and `lastError` belong to the operation
   * that owns the scope. And the two shared fields are written only while the scope is still the one
   * the page is waiting on: a late rejection of an operation somebody has already cancelled or replaced
   * must not overwrite the error, or clear the busy flag, of the one that has started since.
   */
  private async run<T>(
    operation: string,
    body: (
      client: AccountClient,
      transport: AccountTransport,
      identity: InstallationIdentity,
      scope: OperationScope,
    ) => Promise<T>,
    existing?: OperationScope,
  ): Promise<T> {
    if (!this.configured) throw new AccountManagerError("not-configured");
    if (existing !== undefined) this.requireScope(existing);
    const nested = existing !== undefined && this.liveScopes.has(existing);
    const scope = existing ?? this.newScope();
    if (!nested) {
      this.liveScopes.add(scope);
      this.busy = true;
      this.lastError = null;
      this.publish();
    }
    const startedAt = this.now();
    try {
      const result = await body(this.deps.client!, this.deps.transport!, this.deps.identity!, scope);
      // THE NAME AND THE OUTCOME, and nothing either of them was called with. Every operation is
      // recorded here rather than at its call site so a new one cannot be added without one.
      this.diagnostics.record({
        at: startedAt,
        event: `account.${operation}`,
        status: "ok",
        level: "info",
        durationMs: Math.max(0, this.now() - startedAt),
      });
      log.debug(`account: ${operation} ok`, { durationMs: Math.max(0, this.now() - startedAt), nested });
      return result;
    } catch (error) {
      const code = codeOf(error);
      // THE ERROR BELONGS TO THE OPERATION THE PAGE IS STILL WAITING ON. An abandoned scope's late
      // refusal is reported to its caller and to the diagnostics, and to nobody else.
      if (!nested && scope.alive) this.lastError = code;
      this.diagnostics.record({
        at: startedAt,
        event: `account.${operation}`,
        // The fixed code the UI shows, which is also the only part of a refusal that is ours.
        status: code,
        level: "error",
        durationMs: Math.max(0, this.now() - startedAt),
      });
      // THE LOG LINE A BUG REPORT IS ANSWERED FROM: which operation, which of our codes, the transport's
      // own reason where there was one, whether the operation had already been abandoned when it
      // failed (so a "sign-in-superseded" here is the person's own cancel, not a fault), and how long
      // it took. Nothing the request or the answer contained.
      log.warn(`account: ${operation} failed`, {
        code,
        ...(error instanceof AccountCallableError ? { reason: error.reason, httpStatus: error.status } : {}),
        ...(error instanceof AccountAuthError ? { authCode: error.code } : {}),
        abandoned: !scope.alive,
        nested,
        durationMs: Math.max(0, this.now() - startedAt),
      });
      throw error instanceof AccountManagerError ? error : new AccountManagerError(code);
    } finally {
      if (!nested) {
        this.endScope(scope);
        this.publish();
      }
    }
  }

  private publish(): void {
    const next = this.state();
    if (this.lastState !== null && JSON.stringify(this.lastState) === JSON.stringify(next)) return;
    this.lastState = next;
    this.emit("state", next);
  }

  /**
   * Ends everything in flight. Called at shutdown, and when the configuration under this manager
   * changes.
   *
   * A CONFIGURATION CHANGE IS NOT A PAUSE. An attempt works against the broker origin and the Firebase
   * project it was started with (the broker holds an immutable snapshot of both), so a desktop that
   * has just adopted a new bootstrap envelope, or been pointed at another project, must not finish an
   * attempt nobody chose that configuration for — plan §8, Fáze 2. The identity of the INSTALLATION is
   * untouched: this ends a sign-in, not an enrolment.
   */
  dispose(): void {
    // THE COMPLETION IN FLIGHT GOES FIRST (F01). Cancelling the broker alone left a redemption in this
    // object still holding a candidate session and still intending to run its follow-up mutation
    // against a configuration nobody chose for it; ending the flow aborts its requests and makes every
    // remaining step a refusal rather than a surprise.
    this.abandonOperations();
    this.deps.broker?.cancel();
    this.releaseOwnerSession();
    // A clear (T02): a request still out answers into a configuration nobody chose for it.
    this.pendingEmailChange = null;
    this.emailChangeSettled = this.emailChangeRequests;
    this.pendingOfferId = null;
    // The keys of any mutation with an unknown outcome go with the configuration they were made
    // against: a key minted for one Firebase project is not a key for another (F06, F11).
    this.pendingMutations.clear();
    this.auth = null;
    this.publish();
  }
}

/**
 * Whether the owner credential survives the purpose chain, and for how good a reason.
 *
 * Three purposes end with the person having to do one more deliberate thing — type a new address,
 * type the deletion phrase, or simply be re-authenticated for a decision they have not made yet — and
 * a credential dropped the instant the link was redeemed would mean asking for a second link to
 * complete the first intention. The retention is capped at the recent-auth window either way, so the
 * question is only whether it ends now or in at most five minutes.
 */
function purposeKeepsOwner(purpose: SignInPurpose): boolean {
  return purpose === "reauth" || purpose === "change-email" || purpose === "delete-account";
}

type RevokeKind = "installation" | "mobile-device" | "pair" | "account-wide";

const REVOKE_KINDS: readonly RevokeKind[] = ["installation", "mobile-device", "pair", "account-wide"];

/**
 * Unpacks a `revoke-device` reauth's target from the one string `beginEmailSignIn`'s `offerId`
 * parameter carries end to end (see {@link SignInFlow.offerId}). The renderer packs it as
 * `JSON.stringify([kind, targetId ?? null])` — `SettingsAccountTab.vue`'s `revokeOrReauth` is the one
 * place that does, and must stay in sync with the shape read here. `null` for anything that is not.
 */
function decodeRevokeTarget(raw: string): { kind: RevokeKind; targetId: string | undefined } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) return null;
  const [kind, targetId] = parsed as [unknown, unknown];
  if (typeof kind !== "string" || !REVOKE_KINDS.includes(kind as RevokeKind)) return null;
  if (targetId !== null && typeof targetId !== "string") return null;
  return { kind: kind as RevokeKind, targetId: targetId ?? undefined };
}

/**
 * The mutations that carry an idempotency key of their own.
 *
 * Four names rather than one shared key, because the plan asks for exactly that separation ("Pro
 * registraci a trial používat oddělené klíče") and because the failure it prevents is specific: a
 * registration that succeeded and a trial that did not are two different unfinished states, and one
 * key could not describe both.
 */
type MutationName = "ensure-account" | "enrol" | "trial" | "checkout";

/**
 * Whether this failure leaves the SERVER's state unknown.
 *
 * Only a transport failure does. Every other refusal is a message that arrived: the server considered
 * the request and said no, so the mutation did not happen and the next attempt is a new one. An
 * unknown outcome is the case the key exists for, and it is the only case that keeps it.
 */
function isUnknownMutationOutcome(error: unknown): boolean {
  // A RESPONSE THIS DESKTOP COULD NOT READ IS NOT AN ANSWER EITHER (R04). HTTP 200 with a body that
  // broke off, or that the contract does not describe, is a server that may well have completed the
  // mutation; dropping the key on it made the next press a second mutation.
  //
  // NOR IS A REQUEST THE OPERATION ABANDONED (S02). `aborted` covers both a request that was never
  // sent — the scope ended while the transport waited for a token — and one that was in flight when
  // the scope ended. The second may have reached the server; the key and the request are kept for
  // both, because a kept key for a request the server never saw costs nothing, and a dropped key for
  // one it did see is a second mutation. Abort is not a rollback.
  if (error instanceof AccountCallableError) return UNKNOWN_OUTCOME_REASONS.has(error.reason);
  if (error instanceof AccountAuthError) return UNKNOWN_OUTCOME_REASONS.has(error.code);
  if (error instanceof AccountManagerError) return UNKNOWN_OUTCOME_REASONS.has(error.code);
  // Anything else — a thrown TypeError from a broken fetch stub, an abort — is not an answer either.
  return true;
}

const UNKNOWN_OUTCOME_REASONS: ReadonlySet<string> = new Set(["network", "malformed-response", "aborted"]);

/**
 * The fixed code an error is shown and logged as.
 *
 * A transport or auth `aborted` is the person's own cancel — the operation's scope ended while its
 * request was waiting or in flight (S02) — and is shown as such: "your sign-in was cancelled or
 * replaced", not "the network failed". Everything else maps as it always did.
 */
function codeOf(error: unknown): AccountErrorCode {
  if (error instanceof AccountManagerError) return error.code;
  if (error instanceof AccountAuthError)
    return error.code === "aborted" ? "sign-in-superseded" : toAccountErrorCode(error);
  if (error instanceof AccountCallableError) {
    return error.reason === "aborted" ? "sign-in-superseded" : toAccountErrorCode({ code: error.reason });
  }
  return "unknown";
}

/** Read at the moment of asking; an await sits between the two asks in `tokenFor`. */
function signalFired(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

/** A stable rendering of one request, so "the same request" is a comparison and not a guess. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) => {
    if (inner === null || typeof inner !== "object" || Array.isArray(inner)) return inner;
    return Object.fromEntries(Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)));
  });
}
