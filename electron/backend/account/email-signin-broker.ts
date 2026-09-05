// One passwordless sign-in attempt at a time, and everything that can go wrong with it.
//
// WHAT IT OWNS. The 32 random bytes that identify an attempt, the 32 more that authorise collecting
// its payload, the pinned address, the pinned PURPOSE, the deadline, the polling, the manual-paste
// fallback, and the cancel/ack that end it. What it deliberately does NOT own: redeeming the code.
// That is the account manager's, because redeeming is the moment an identity appears and the manager
// is what decides whether that identity may do the thing the attempt was started for.
//
// THE SECRET NEVER LEAVES THIS PROCESS. The broker is sent only `sha256(claimSecret)`; the secret
// itself lives in this object's memory, goes into exactly one request body per claim, and is never
// broadcast, persisted, logged or returned to a renderer. The `attemptId` is in the email link and
// is not an authorisation — knowing it gets you nothing without the secret.
//
// THE PURPOSE IS PINNED LOCALLY AND TRAVELS NOWHERE. Not in the link, not to the broker, not to
// Firebase. A URL somebody constructs cannot change what this desktop was going to do, because the
// only copy of that intention is here (plan §6, "Údaje jednoho pokusu").
//
// EVERY AWAIT IS FOLLOWED BY A GENERATION CHECK. A cancel, a resend, a configuration change or a
// shutdown bumps `generation`; a late answer belonging to an older one is dropped rather than
// applied. Without that, an attempt the user cancelled ten seconds ago could still walk into the
// follow-up action when its `/claim` finally returned (plan §9: "Opožděná odpověď zrušeného/resend
// pokusu nezmění account state").
//
// A CANCEL IS NOT A REVOCATION. Cancelling tells OUR broker to stop handing the payload over. It
// says nothing about the Firebase code, whose validity only Firebase decides — so nothing in this
// file, and nothing in the UI it feeds, may claim the link was revoked.

import { EventEmitter } from "node:events";
import { createHash, randomBytes } from "node:crypto";

import type { AccountClient } from "./account-client.js";
import { AccountAuthError } from "./account-client.js";
import { readBoundedJsonBody, requestDeadline } from "./bounded-http.js";
import type { BootstrapEnvironment } from "../mobile/control-plane-bootstrap.js";
import {
  continueUrlFor,
  MAX_OOB_CODE_LENGTH,
  normalizeAuthEmail,
  parseSignInLink,
  sameAuthEmail,
  type AuthLinkConfig,
} from "./authlink-config.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Why this sign-in was started. Pinned when the attempt is created and never changed by anything
 * outside this process.
 *
 * The list is the one from plan §7's table — one authentication per user intention — plus `reauth`,
 * which is the bare "prove you are the owner" with no follow-up of its own.
 */
export type SignInPurpose =
  | "enrol"
  | "enrol-with-trial"
  /**
   * The TRIAL ALONE, on a machine that is already registered (F06).
   *
   * It exists because "register and start a trial" can half-succeed: the registration stands and the
   * trial's answer is lost. The person then has a machine that is enrolled and a trial that may or may
   * not have started, and the button offering to finish it needs an owner session the transient design
   * has already dropped. Without this purpose that button called the owner endpoint with no owner —
   * plan §7's "Pokud owner session chybí, vyžádat odkaz s připnutým účelem", applied to the one step
   * that was left.
   */
  | "trial"
  | "recover-uid"
  | "reauth"
  | "checkout"
  | "portal"
  | "change-email"
  | "delete-account"
  /**
   * A revocation whose local recent-auth window had already lapsed (plan §7/C2: "Desktop má umět
   * obsloužit recent-auth odmítnutí a vrátit se ke konkrétnímu potvrzovanému záměru"). Like `checkout`,
   * this carries an operand (the packed revoke target) and performs the original request itself once
   * the identity is proved — revoking is the one decision the person already made by pressing the
   * button; reauthenticating is not a second one that needs its own form.
   */
  | "revoke-device";

export const SIGN_IN_PURPOSES: readonly SignInPurpose[] = [
  "enrol",
  "enrol-with-trial",
  "trial",
  "recover-uid",
  "reauth",
  "checkout",
  "portal",
  "change-email",
  "delete-account",
  "revoke-device",
];

/**
 * Where the attempt is, as one value every window renders.
 *
 *   `sending`               the link is being requested. Short, and it is NOT "sent".
 *   `awaiting-link`         Firebase accepted the request; we are waiting for somebody to open it.
 *   `awaiting-confirmation` the payload arrived and the person must confirm ON THIS DESKTOP.
 *   `verifying`             they confirmed; the code is being redeemed and the identity checked.
 *
 * The third exists because a link that completes itself is a link a stranger can complete: the last
 * step is a sentence naming the address, on the machine that will be signed in (plan §6 step 6).
 */
export type SignInPhase = "sending" | "awaiting-link" | "awaiting-confirmation" | "verifying";

/** What the renderer is allowed to know about an attempt. No secret, no code, no token. */
export interface SignInAttemptState {
  readonly phase: SignInPhase;
  /** The address the link was sent to. NOT an `ownerEmail`: nobody has proved anything yet. */
  readonly email: string;
  readonly purpose: SignInPurpose;
  /** Absolute deadline. The server assigned it when the broker is reachable; otherwise ours. */
  readonly expiresAt: number;
  /** When "send it again" becomes available. A UX cooldown, and it says so. */
  readonly canResendAt: number;
  /** Whether this attempt can only be finished by pasting the link (the broker was unreachable). */
  readonly manualOnly: boolean;
  /** How many links this flow has sent. Bounded — see {@link MAX_SENDS_PER_FLOW}. */
  readonly sendsUsed: number;
  /**
   * What the SEND request answered — and `unknown` is a third answer, not a failure (F03).
   *
   * `sent` means Firebase accepted the request. `unknown` means the request went out and no answer
   * came back: a dropped connection, a timeout, a proxy that gave up. The message may well be in the
   * mailbox, so the attempt stays completable and the UI has to say which of the two it is rather
   * than claiming a send it cannot prove.
   */
  readonly sendOutcome: "sent" | "unknown";
}

/** The payload the broker hands back, once. Never leaves the backend. */
interface SignInPayload {
  readonly email: string;
  readonly oobCode: string;
}

/**
 * The identity of ONE attempt, as a value a caller can hold across an await.
 *
 * F01. `finish()` and `cancel()` used to mean "end whatever attempt is current", which is a different
 * sentence from "end the attempt this sign-in belongs to" every time something happened in between —
 * a cancel, a resend, a shutdown. The account manager takes one of these before it redeems a code and
 * presents it to every call that ends an attempt, so a late answer from an abandoned attempt cannot
 * acknowledge, cancel or otherwise touch the attempt that replaced it.
 *
 * The `generation` is what makes it an identity rather than a name: an attempt id is minted per
 * attempt, but the generation also moves on a `clear()`, so a ref stops matching the moment the
 * attempt it names stops existing.
 */
export interface SignInAttemptRef {
  readonly attemptId: string;
  readonly generation: number;
}

export type SignInFailureCode =
  | "network"
  | "auth-unavailable"
  | "invalid-email"
  | "too-many-attempts"
  | "expired-code"
  | "invalid-code"
  | "address-mismatch"
  | "attempt-expired"
  | "unknown";

export class SignInBrokerError extends Error {
  readonly code: SignInFailureCode;

  constructor(code: SignInFailureCode) {
    super(`sign-in refused: ${code}`);
    this.name = "SignInBrokerError";
    this.code = code;
  }
}

/** Fifteen minutes, matching the broker's own TTL. What a manual-only attempt is bounded by. */
export const LOCAL_ATTEMPT_TTL_MS = 15 * 60_000;

/** No resend for the first minute. A UX limit, not a security control — see the module header. */
export const RESEND_COOLDOWN_MS = 60_000;

/** At most three links per flow, and the window they are counted in. */
export const MAX_SENDS_PER_FLOW = 3;
export const SEND_WINDOW_MS = 10 * 60_000;

/** At most this many `/claim` requests per attempt, whatever the schedule computes. */
export const MAX_POLLS_PER_ATTEMPT = 75;

/**
 * The largest broker response this desktop will parse.
 *
 * Every answer here is a handful of short fields, and the biggest of them — a confirmed payload — is
 * an address plus an `oobCode`. Handing an unbounded body to `JSON.parse` costs memory for nothing,
 * and the origin at the other end is inside the authentication trust boundary rather than outside it
 * (see the module header), which is a reason to bound it and not a reason to skip the bound. Plan
 * §"Bezpečnostní hranice": "Odpovědi se parsují s limitem velikosti". Same value as
 * `account-client.ts`'s, for the same reason.
 */
const MAX_RESPONSE_BYTES = 64 * 1024;

/** Every request this broker makes is a few hundred bytes and answers in well under this. */
export const REQUEST_TIMEOUT_MS = 10_000;

/**
 * How long a verification that started IN TIME may take to finish.
 *
 * Plan §6: "Pozdní odpověď vlastního včas zahájeného requestu lze dokončit jen pokud pokus mezitím
 * nebyl zrušen nebo nahrazen; následné ověřování má vlastní krátký limit, nejvýše 2 minuty." The
 * deadline stops NEW work; it must not abandon a redemption already in flight, because the code may
 * already have been spent.
 */
export const VERIFY_GRACE_MS = 2 * 60_000;

/**
 * The polling schedule from plan §4, as a function of how long the attempt has been open.
 *
 * ~3 s for the first 30 s, ~10 s to two minutes, ~20 s to the deadline. About 75 requests over a
 * whole unfinished attempt rather than the 450 a flat two-second poll would make — which is the
 * difference between a rounding error against the free tier and a budget line.
 *
 * The JITTER is not decoration: twenty desktops that all started at a round minute would otherwise
 * poll in lockstep for ever.
 */
export function nextPollDelayMs(elapsedMs: number, jitter: number): number {
  const base = elapsedMs < 30_000 ? 3_000 : elapsedMs < 120_000 ? 10_000 : 20_000;
  const clamped = Math.min(Math.max(jitter, 0), 1);
  return Math.round(base * (0.85 + 0.3 * clamped));
}

export interface EmailSignInBrokerDeps {
  /**
   * The broker origin and environment, as an IMMUTABLE SNAPSHOT.
   *
   * An attempt works against the configuration it was started with. If the desktop adopts a new
   * bootstrap envelope or is pointed at another Firebase project mid-flow, the runtime cancels the
   * attempt outright rather than letting it finish against a configuration nobody chose for it.
   */
  readonly authlink: AuthLinkConfig;
  readonly client: AccountClient;
  readonly fetchImpl?: FetchLike;
  readonly now?: () => number;
  /** Injected so a test can make an attempt id predictable. 32 bytes, base64url. */
  readonly newOpaqueId?: () => string;
  /** Injected so the polling schedule is deterministic in tests. */
  readonly jitter?: () => number;
  /** Injected so a test can drive the polling clock without waiting. Returns a canceller. */
  readonly schedule?: (fn: () => void, delayMs: number) => () => void;
}

/** Emits `state` (a {@link SignInAttemptState} or null) whenever the attempt changes. */
export class EmailSignInBroker extends EventEmitter {
  private readonly deps: EmailSignInBrokerDeps;
  private readonly now: () => number;
  private readonly doFetch: FetchLike;
  private readonly newOpaqueId: () => string;
  private readonly jitter: () => number;
  private readonly schedule: (fn: () => void, delayMs: number) => () => void;

  /**
   * Bumped by every begin, resend, cancel and dispose.
   *
   * Read before AND after every await. See the module header: this is what makes a late answer from
   * an abandoned attempt a no-op instead of a surprise.
   */
  private generation = 0;
  private attempt: {
    readonly generation: number;
    readonly attemptId: string;
    readonly claimSecret: string;
    readonly email: string;
    readonly purpose: SignInPurpose;
    readonly startedAt: number;
    readonly expiresAt: number;
    readonly manualOnly: boolean;
    phase: SignInPhase;
    canResendAt: number;
    polls: number;
    payload: SignInPayload | null;
    sendOutcome: "sent" | "unknown";
  } | null = null;
  /**
   * The send timestamps of this FLOW — kept across resends, which is what bounds them.
   *
   * THE LIFETIME OF A FLOW, ACROSS EVERY ERROR STATE, because F03 asks for it precisely and the four
   * cases genuinely differ:
   *
   *   - an ACCEPTED send is counted, and so is an UNKNOWN one. A request that went out with no answer
   *     coming back may have delivered a message, and a budget that did not count it would let three
   *     lost answers become six messages.
   *   - a REFUSED send is not counted and ends the attempt. The service considered the request and
   *     said no, so nothing was sent; the flow has nothing left to bound.
   *   - a RESEND keeps the list. That is what makes "at most three links per flow" mean anything: the
   *     bound belongs to the person's one sign-in, not to each attempt inside it.
   *   - a NEW `begin()` resets it, including after a cancel or an expiry. A different address, or a
   *     fresh start, is a different sign-in — the bound is a limit on one flow, not a lockout.
   *
   * A `clear()` — an expiry, a cancel, a finish, a dispose — deliberately does NOT reset it: the
   * attempt is gone but the flow's spending is not undone, so a cancel-and-resend loop cannot mint
   * links past the ceiling. Only `begin()` starts a new flow.
   */
  private sendTimestamps: number[] = [];
  private cancelPoll: (() => void) | null = null;

  constructor(deps: EmailSignInBrokerDeps) {
    super();
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
    this.doFetch = deps.fetchImpl ?? ((input, init) => fetch(input, init));
    this.newOpaqueId = deps.newOpaqueId ?? (() => randomBytes(32).toString("base64url"));
    this.jitter = deps.jitter ?? (() => Math.random());
    this.schedule =
      deps.schedule ??
      ((fn, delayMs) => {
        const handle = setTimeout(fn, delayMs);
        // The Electron main process must not be held open by a poll timer.
        handle.unref?.();
        return () => clearTimeout(handle);
      });
  }

  /** The current attempt, or null. What the account state embeds verbatim. */
  state(): SignInAttemptState | null {
    if (this.attempt === null) return null;
    return {
      phase: this.attempt.phase,
      email: this.attempt.email,
      purpose: this.attempt.purpose,
      expiresAt: this.attempt.expiresAt,
      canResendAt: this.attempt.canResendAt,
      manualOnly: this.attempt.manualOnly,
      sendsUsed: this.sendTimestamps.length,
      sendOutcome: this.attempt.sendOutcome,
    };
  }

  get purpose(): SignInPurpose | null {
    return this.attempt?.purpose ?? null;
  }

  /**
   * Which environment this broker's immutable snapshot names.
   *
   * Read by the account manager so the broadcast state can SAY which backend a sign-in would go to
   * (F11). It is not a decision — the decision was made once, when the snapshot was built — it is the
   * one fact about that decision anybody outside this object can check.
   */
  get environment(): BootstrapEnvironment {
    return this.deps.authlink.environment;
  }

  /**
   * Whether the attempt this ref names is still the one this broker is running.
   *
   * F01's whole mechanism, in one predicate. Read before and after every await in the account
   * manager's completion path: a cancel, a resend, a `clear()` or a shutdown moves the generation on,
   * so a ref taken before the redemption stops matching the moment the attempt behind it is gone.
   */
  isCurrent(ref: SignInAttemptRef): boolean {
    const current = this.attempt;
    return current !== null && current.generation === ref.generation && current.attemptId === ref.attemptId;
  }

  /**
   * The identity of the attempt in flight, or null.
   *
   * Read BEFORE `beginVerification()` so the account manager can answer "is this code already being
   * redeemed" without the side effects of starting a verification it is about to abandon.
   */
  currentRef(): SignInAttemptRef | null {
    const current = this.attempt;
    return current === null ? null : { attemptId: current.attemptId, generation: current.generation };
  }

  get pinnedEmail(): string | null {
    return this.attempt?.email ?? null;
  }

  /**
   * Starts an attempt: create it at the broker, then ask Firebase to send the link.
   *
   * THAT ORDER MATTERS. The broker record has to exist before the link can be confirmed, and a link
   * whose attempt was never created is refused by the web page rather than half-completing. When the
   * broker itself cannot be reached the attempt continues in MANUAL-ONLY mode — a local attempt, no
   * server record, finished by pasting the link — because a person whose broker is down should not be
   * locked out of their own account (plan §6, "Záložní ruční vložení odkazu").
   */
  async begin(rawEmail: string, purpose: SignInPurpose): Promise<void> {
    const email = normalizeAuthEmail(rawEmail);
    if (email === null) throw new SignInBrokerError("invalid-email");
    // A NEW FLOW resets the send budget. A resend of the SAME flow does not — see `resend()`.
    this.sendTimestamps = [];
    await this.startAttempt(email, purpose);
  }

  /**
   * Sends another link for the SAME flow.
   *
   * A resend is a NEW attempt with a new id, a new secret and a new deadline, and the previous one is
   * cancelled — plan §6: "Resend zakládá nový pokus a starý se ruší; polling deadline neprodlužuje."
   * The budget is the flow's, not the attempt's, which is the only way a bound on resends means
   * anything.
   */
  async resend(): Promise<void> {
    const current = this.attempt;
    if (current === null) throw new SignInBrokerError("attempt-expired");
    const now = this.now();
    if (now < current.canResendAt) throw new SignInBrokerError("too-many-attempts");
    const recent = this.sendTimestamps.filter((at) => now - at < SEND_WINDOW_MS);
    if (recent.length >= MAX_SENDS_PER_FLOW) throw new SignInBrokerError("too-many-attempts");
    this.sendTimestamps = recent;
    await this.startAttempt(current.email, current.purpose);
  }

  /**
   * The payload, if one has arrived and the person has not confirmed it yet.
   *
   * Reading it does not consume it: the manager may need it again if the redemption fails for a
   * reason worth retrying. `finish()` is what ends the attempt.
   */
  pendingPayload(): SignInPayload | null {
    return this.attempt?.payload ?? null;
  }

  /**
   * Moves to `verifying`, and answers with the deadline that verification has.
   *
   * THE DEADLINE IS RE-CHECKED HERE, in the desktop, before anything is redeemed — including for a
   * code that has been sitting in memory since before it lapsed (plan §6).
   *
   * WHAT IT RETURNS IS A WINDOW OF ITS OWN, and deliberately not the attempt's. Plan §6 gives the
   * subsequent verification "vlastní krátký limit, nejvýše 2 minuty", so it is two minutes from NOW
   * and it may reach past the attempt's deadline: the deadline stops NEW work, and a redemption
   * already in flight must be allowed to finish because the code may already be spent. Two minutes
   * from now is always the shorter of that and two minutes past a deadline this attempt has not
   * reached yet, which is why there is nothing here to take a minimum of.
   */
  beginVerification(): { deadline: number; ref: SignInAttemptRef } {
    const current = this.attempt;
    if (current === null || current.payload === null) throw new SignInBrokerError("attempt-expired");
    const now = this.now();
    if (now >= current.expiresAt) throw new SignInBrokerError("attempt-expired");
    this.stopPolling();
    current.phase = "verifying";
    this.publish();
    // THE REF IS TAKEN HERE, at the last moment before the code is presented, and it is what every
    // later step in the completion is checked against (F01).
    return {
      deadline: now + VERIFY_GRACE_MS,
      ref: { attemptId: current.attemptId, generation: current.generation },
    };
  }

  /**
   * Ends ONE attempt after a SUCCESSFUL sign-in.
   *
   * `ack` is best-effort by design: it tidies the broker's copy early, and plan §6 step 9 is explicit
   * that a failed one must not turn a completed sign-in back into an error. The rest is cleaned up by
   * the deadline and the object's own alarm.
   *
   * THE REF IS NOT DECORATION (F01). Without it this meant "acknowledge whatever is current", so a
   * redemption whose answer arrived after the person had already started a new attempt acknowledged
   * and cleared THAT one — ending a sign-in nobody had finished and leaving the new attempt's payload
   * unreachable. A ref that no longer names the current attempt makes this a no-op.
   */
  finish(ref: SignInAttemptRef): void {
    const current = this.attempt;
    if (current === null || !this.isCurrent(ref)) return;
    void this.releaseAttempt(current.attemptId, current.claimSecret, "ack");
    this.clear();
  }

  /**
   * Abandons the attempt. Tells the broker to stop handing the payload over; revokes nothing.
   *
   * With a ref it abandons only the attempt that ref names — the cleanup half of the same rule
   * `finish()` follows. Without one it is the person's own "never mind", which is about whatever is
   * on screen and therefore about whatever is current.
   */
  cancel(ref?: SignInAttemptRef): void {
    const current = this.attempt;
    if (current === null) return;
    if (ref !== undefined && !this.isCurrent(ref)) return;
    void this.releaseAttempt(current.attemptId, current.claimSecret, "cancel");
    this.clear();
  }

  /** Cancels without telling the broker. For shutdown, where there is no time for a round trip. */
  dispose(): void {
    this.clear();
    this.removeAllListeners();
  }

  /**
   * The manual fallback: the whole link, out of the person's mail client.
   *
   * IT IS PARSED, NEVER FETCHED (plan §"Záložní ruční vložení odkazu"). The parser accepts one shape,
   * from this build's own broker origin, and the attempt it names must be the one this desktop is
   * waiting for — otherwise a link for somebody else's attempt, or for the other environment, would
   * complete a flow it has nothing to do with. The address stays the LOCAL one: a pasted link does not
   * get to nominate who is signing in.
   */
  submitLink(raw: string): void {
    const current = this.attempt;
    if (current === null) throw new SignInBrokerError("attempt-expired");
    if (this.now() >= current.expiresAt) throw new SignInBrokerError("attempt-expired");
    const parsed = parseSignInLink(this.deps.authlink, raw);
    if (parsed === null) throw new SignInBrokerError("invalid-code");
    if (parsed.attemptId !== current.attemptId) throw new SignInBrokerError("invalid-code");
    this.acceptPayload({ email: current.email, oobCode: parsed.oobCode });
  }

  // --- internals ---------------------------------------------------------------------------------

  private async startAttempt(email: string, purpose: SignInPurpose): Promise<void> {
    // WHATEVER THIS REPLACES IS CANCELLED, not merely forgotten. Plan §6 says it of both ways in:
    // "Resend zakládá nový pokus a starý se ruší" and, for a corrected address, "Změna rozepsané
    // adresy ruší původní pokus místo úpravy jeho `expectedEmail`". Bumping the generation is enough
    // to make the old attempt unfinishable HERE — but the broker would keep a confirmable record for
    // the rest of its fifteen minutes, and a payload nobody holds the secret for is a payload with no
    // reason to exist. Best effort, and deliberately not awaited into the failure path: the old
    // attempt expires on its own deadline anyway, and a broker that cannot be told to cancel must not
    // stop somebody starting again.
    const replaced = this.attempt;
    if (replaced !== null) void this.releaseAttempt(replaced.attemptId, replaced.claimSecret, "cancel");
    this.stopPolling();
    const generation = ++this.generation;
    const attemptId = this.newOpaqueId();
    const claimSecret = this.newOpaqueId();
    const startedAt = this.now();
    this.attempt = {
      generation,
      attemptId,
      claimSecret,
      email,
      purpose,
      startedAt,
      expiresAt: startedAt + LOCAL_ATTEMPT_TTL_MS,
      manualOnly: false,
      phase: "sending",
      canResendAt: startedAt + RESEND_COOLDOWN_MS,
      polls: 0,
      payload: null,
      sendOutcome: "sent",
    };
    this.publish();

    const started = await this.createRemoteAttempt(attemptId, claimSecret, generation);
    if (generation !== this.generation) return;

    // THE BROKER MAY SHORTEN THE DEADLINE AND NEVER LENGTHEN IT. The server assigns the absolute
    // deadline (plan §6, "Údaje jednoho pokusu"), and the desktop enforces its own INDEPENDENTLY
    // (plan §9: "Lokální i serverový deadline platí nezávisle na alarmu"). Independent means a
    // ceiling, not a suggestion: adopting whatever number came back would let a broken or hostile
    // broker hand this attempt a deadline centuries out, and the local fifteen minutes would then be
    // the value it replaced rather than a limit.
    const expiresAt = Math.min(started.expiresAt ?? Infinity, startedAt + LOCAL_ATTEMPT_TTL_MS);
    this.attempt = { ...this.attempt!, expiresAt, manualOnly: !started.ok };

    let sendOutcome: "sent" | "unknown" = "sent";
    try {
      await this.deps.client.startEmailSignIn(email, continueUrlFor(this.deps.authlink, attemptId));
    } catch (error) {
      if (generation !== this.generation) return;
      const refusal = toBrokerError(error);
      // A REFUSAL AND A LOST ANSWER ARE DIFFERENT OUTCOMES (F03). Everything but `network` is an
      // ANSWER from the identity service — a malformed address, this address's rate limit, a project
      // that cannot serve the flow — and an answer means no message was sent, so the attempt is torn
      // down. This is also why the send is the LAST thing: a broker record with no email behind it is
      // a fifteen-minute no-op, and an email with no broker record is a link that cannot be confirmed.
      if (refusal.code !== "network") {
        void this.releaseAttempt(attemptId, claimSecret, "cancel");
        this.clear();
        throw refusal;
      }
      // AN UNKNOWN RESULT IS NOT PROOF OF NON-DELIVERY, and tearing the attempt down here was the
      // defect: `sendOobCode` may have reached Firebase and the message may already be in the mailbox,
      // and a torn-down attempt makes that link unusable by BOTH routes — the paste has no attempt to
      // match against, and the broker has no record to hand a payload over from. So the same attempt
      // stays open, with the same id, the same secret and the same deadline; the UI is told the result
      // is unknown rather than told it succeeded; and nothing here re-sends, because a second
      // `sendOobCode` for the same address invalidates the code in the message that may have arrived
      // (phase-0 row 26).
      sendOutcome = "unknown";
    }
    if (generation !== this.generation) return;

    // COUNTED WHEN THE REQUEST WENT OUT, not when a message arrived. Plan §6: a lost `sendOobCode`
    // response is an UNKNOWN result, never proof that nothing was sent — so it is counted against the
    // cooldown and the per-flow budget exactly like an accepted one, and nothing here retries the send
    // automatically.
    this.sendTimestamps.push(this.now());
    this.attempt = { ...this.attempt!, phase: "awaiting-link", sendOutcome };
    this.publish();
    if (!this.attempt.manualOnly) this.scheduleNextPoll(generation);
  }

  /**
   * `POST /start`, create-only, and repeated ONCE when the answer never arrived.
   *
   * A FAILURE IS NOT FATAL, and this is the whole of the local fallback: the attempt continues with a
   * local deadline and `manualOnly`, so the person can still finish by pasting the link. What such an
   * attempt cannot do is be confirmed through the web page — the broker has no record of it, and plan
   * §6 requires exactly that ("Web u takového odkazu nesmí vytvořit session dodatečně").
   *
   * AN UNCERTAIN ANSWER IS RETRIED, AND WITH THE IDENTICAL REQUEST. Plan §6: "Podobně při nejistém
   * `/start` nejprve opakovat tentýž create-only request, nikoli vyrábět další čekající objekty."
   * There are two wrong ways to treat a dropped response here and this avoids both. Giving up costs
   * the person the phone and web route for the rest of the attempt over one lost packet — the record
   * may well exist, and there is no way to find out but to ask. Starting a SECOND attempt is worse: it
   * leaves the broker holding an object nobody will ever claim, which is the thing that sentence
   * forbids. Sending the same body again does neither, because `/start` is create-only: it either
   * creates the record or is answered with the deadline the first call already assigned, never a
   * second object and never a fresh deadline (`decideStart`'s `idempotent` branch, and
   * `authlink-integration.test.mts :: a repeat of the identical request returns the ORIGINAL
   * deadline`).
   *
   * ONLY AN UNCERTAIN ANSWER. A 4xx is an ANSWER — the other environment, a malformed body, this
   * address's rate limit — and asking again cannot change it. Two attempts and no more, the same
   * bound and the same reason as {@link releaseAttempt}: a retry loop must not keep this process
   * talking to a host that is gone.
   */
  private async createRemoteAttempt(
    attemptId: string,
    claimSecret: string,
    generation: number,
  ): Promise<{ ok: boolean; expiresAt: number | null }> {
    const body = {
      attemptId,
      claimSecretHash: sha256Base64Url(claimSecret),
      // No translation needed any more (plan §5.5): the desktop's `AuthLinkConfig.environment` and the
      // authlink Worker's `AuthLinkEnvironment` are now the SAME vocabulary (local | dev | qa | prod).
      // The old "dev" (desktop) -> "local" (Worker) rewrite existed only because the two used to name
      // the same thing differently.
      environment: this.deps.authlink.environment,
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      // The generation is read before the SECOND request too: an attempt that has been cancelled or
      // superseded in the meantime has nothing left to create.
      if (generation !== this.generation) return { ok: false, expiresAt: null };
      try {
        const response = await this.post("/start", body);
        if (!response.ok) {
          if (response.status < 500) return { ok: false, expiresAt: null };
          continue;
        }
        const expiresAt = response.body["expiresAt"];
        return { ok: true, expiresAt: typeof expiresAt === "number" ? expiresAt : null };
      } catch {
        // A transport failure or this request's own timeout: whether the record exists is unknown,
        // which is the case the repeat is for.
      }
    }
    return { ok: false, expiresAt: null };
  }

  private scheduleNextPoll(generation: number, notBeforeMs = 0): void {
    const current = this.attempt;
    if (current === null || generation !== this.generation) return;
    const now = this.now();
    if (now >= current.expiresAt || current.polls >= MAX_POLLS_PER_ATTEMPT) {
      // THE LOCAL DEADLINE, ENFORCED LOCALLY. The broker enforces its own; neither depends on the
      // other, and neither depends on an alarm having run (plan §9).
      this.expire();
      return;
    }
    // `notBeforeMs` IS A SERVER'S `Retry-After`, AND IT EXTENDS NOTHING (plan §6). It can only ever
    // make the next poll later than the band would have, and it is clamped to the time the attempt
    // has left — so a wait longer than the deadline, whether it came from a real limiter or from a
    // hostile header, cannot park a pending attempt past the moment it should have expired. The
    // deadline above is checked before every poll regardless of what any header said.
    const remainingMs = Math.max(0, current.expiresAt - now);
    const notBefore = Math.min(Math.max(notBeforeMs, 0), remainingMs);
    const delay = Math.max(nextPollDelayMs(now - current.startedAt, this.jitter()), notBefore);
    this.cancelPoll = this.schedule(() => {
      void this.poll(generation);
    }, delay);
  }

  private async poll(generation: number): Promise<void> {
    if (generation !== this.generation) return;
    const current = this.attempt;
    if (current === null || current.phase !== "awaiting-link") return;
    current.polls += 1;
    let response: { ok: boolean; status: number; body: Record<string, unknown>; retryAfterMs: number };
    try {
      response = await this.post("/claim", { attemptId: current.attemptId, claimSecret: current.claimSecret });
    } catch {
      // A network failure is a reason to try again later, never a reason to end an attempt somebody
      // may be in the middle of completing on their phone.
      if (generation === this.generation) this.scheduleNextPoll(generation);
      return;
    }
    if (generation !== this.generation) return;
    if (this.attempt === null || this.attempt.phase !== "awaiting-link") return;

    if (response.ok && response.body["state"] === "confirmed") {
      const email = normalizeAuthEmail(response.body["email"]);
      const oobCode = typeof response.body["oobCode"] === "string" ? response.body["oobCode"] : "";
      // THE CODE IS BOUNDED ON BOTH ROUTES. `parseSignInLink` refuses an empty or over-long `oobCode`
      // in a pasted link; a polled payload arrives from the same broker and gets the same bound, or
      // the fallback path would be the strict one and the ordinary path the lenient one (plan
      // §"Bezpečnostní hranice": "JSON schémata odmítají neznámá pole a nestandardní délky").
      if (oobCode.length === 0 || oobCode.length > MAX_OOB_CODE_LENGTH) {
        this.fail("invalid-code");
        return;
      }
      // THE ADDRESS IS COMPARED, NOT ADOPTED (plan §6 step 6). The web page asks a person to type an
      // address; this desktop already knows which one it sent the link to, and a disagreement means
      // the wrong attempt is being finished — not that the login address has changed. `sameAuthEmail`
      // rather than `===` because the identity service folds the whole address (phase-0 row 36), so a
      // difference of case is not a disagreement — and the address the sign-in USES is still this
      // desktop's own, never the one the page sent.
      if (email === null || !sameAuthEmail(email, this.attempt.email)) {
        this.fail("address-mismatch");
        return;
      }
      this.acceptPayload({ email: this.attempt.email, oobCode });
      return;
    }
    if (response.status === 410) {
      this.expire();
      return;
    }
    const state = response.body["state"];
    if (state === "cancelled" || state === "acknowledged") {
      this.clear();
      return;
    }
    // A 429 is not "nothing yet": it is the broker saying how long to wait, and plan §6 says this
    // client respects it. Everything else falls through to the ordinary band.
    this.scheduleNextPoll(generation, response.status === 429 ? response.retryAfterMs : 0);
  }

  /**
   * Records the payload and asks the person to confirm — once, whichever route brought it.
   *
   * The polling loop and a pasted link race by construction, and a double-clicked button races with
   * both. The first one to arrive wins and the rest are no-ops, which is what makes "exactly one local
   * request to redeem a given code" true (plan §6).
   */
  private acceptPayload(payload: SignInPayload): void {
    const current = this.attempt;
    if (current === null || current.payload !== null) return;
    this.stopPolling();
    current.payload = payload;
    current.phase = "awaiting-confirmation";
    this.publish();
  }

  private expire(): void {
    this.fail("attempt-expired");
  }

  private fail(code: SignInFailureCode): void {
    const current = this.attempt;
    this.clear();
    if (current !== null) this.emit("failed", code);
  }

  private clear(): void {
    this.generation += 1;
    this.stopPolling();
    this.attempt = null;
    this.publish();
  }

  private stopPolling(): void {
    this.cancelPoll?.();
    this.cancelPoll = null;
  }

  private publish(): void {
    this.emit("state", this.state());
  }

  /**
   * `ack` or `cancel`, best effort, never awaited by anything a user is waiting on.
   *
   * TWO ATTEMPTS AND NO MORE (plan §6 step 9: "má krátký timeout a omezené opakování"). One dropped
   * packet should not leave the payload sitting in the broker for the rest of the window, and a retry
   * loop should not keep this process talking to a host that is gone. Whatever this does not manage is
   * cleaned up by the deadline and the object's own alarm, which is why failing here is silent.
   */
  private async releaseAttempt(attemptId: string, claimSecret: string, kind: "ack" | "cancel"): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await this.post(`/${kind}`, { attemptId, claimSecret });
        // A refusal is an ANSWER — the attempt is already terminal, or the secret is wrong — and
        // asking again does not change it. Only a transport failure is worth a second try.
        if (response.status < 500) return;
      } catch {
        // Fall through to the second attempt, then stop.
      }
    }
  }

  /**
   * One JSON POST to the broker, bounded in time and refusing a redirect.
   *
   * `redirect: "error"` because these bodies carry the claim secret, and HTTP 307/308 preserves the
   * method and the body — so a redirect is an instruction to send that secret to another host.
   */
  private async post(
    path: string,
    body: Record<string, unknown>,
  ): Promise<{ ok: boolean; status: number; body: Record<string, unknown>; retryAfterMs: number }> {
    // THE DEADLINE COVERS THE BODY TOO (F04). It is disarmed after `readBoundedJsonBody` has returned, not
    // when `fetch` resolves: a peer that sends headers promptly and then trickles a body for ever is a
    // hung request, and a timer cleared at the earlier point never sees it.
    const deadline = requestDeadline(REQUEST_TIMEOUT_MS);
    try {
      const response = await this.doFetch(`${this.deps.authlink.origin}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        redirect: "error",
        signal: deadline.signal,
      });
      // A body too large is treated exactly like a body that is not JSON: an empty object, so the
      // caller falls through to whatever its status code means. There is nothing in an oversized
      // answer worth reading — and `readBoundedJsonBody` stops the stream rather than measuring a
      // string it has already accepted in full. A stream that BROKE is different (R04): nothing is
      // known about what the broker said, so it is a transport failure like a refused connection, and
      // the caller's own retry rule applies.
      const read = await readBoundedJsonBody(response, MAX_RESPONSE_BYTES);
      if (read.kind === "unreadable") throw new SignInBrokerError("network");
      return {
        ok: response.ok,
        status: response.status,
        body: read.kind === "ok" ? read.value : {},
        retryAfterMs: retryAfterMs(response.headers.get("retry-after")),
      };
    } finally {
      deadline.dispose();
    }
  }
}

/**
 * A `Retry-After` header, in the only form this broker sends: whole seconds.
 *
 * Plan §6: *"HTTP 429 vrací `Retry-After`; klient jej respektuje bez prodlužování deadline."* The
 * server half was there from the start — the object answers `claim-locked` and `too-many-requests`
 * with the header — and NOTHING read it, so a 429 was treated as "nothing yet" and the next poll went
 * out on the ordinary three-second band. The two answers that carry a sixty-second wait are for a
 * caller that cannot prove the attempt, so a legitimate desktop does not meet them today; that is a
 * fact about two constants in two repositories (a 3 s band against a 1 s server interval) and not
 * something this file should depend on.
 *
 * The RFC also permits an HTTP-date. It is not accepted here: this client's own clock is the one thing
 * a date would have to be compared against, and a wrong clock would turn a one-minute wait into an
 * arbitrary one. An unparseable header means no extra wait, which is the same as no header — the
 * ordinary schedule, which is bounded anyway.
 */
function retryAfterMs(header: string | null): number {
  if (header === null) return 0;
  const seconds = Number(header.trim());
  if (!Number.isInteger(seconds) || seconds < 0) return 0;
  return seconds * 1_000;
}

function sha256Base64Url(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

/** A Firebase refusal, as one of this broker's own codes. */
function toBrokerError(error: unknown): SignInBrokerError {
  if (error instanceof AccountAuthError) {
    switch (error.code) {
      // AN ANSWER THIS DESKTOP COULD NOT READ IS NOT PROOF OF NON-DELIVERY EITHER (R04). The service
      // responded 200 and the body was not one of its — the message is as likely in the mailbox as
      // after a lost answer, and the attempt has to stay open for the same reason.
      case "network":
      case "malformed-response":
        return new SignInBrokerError("network");
      case "invalid-email":
        return new SignInBrokerError("invalid-email");
      case "too-many-attempts":
        return new SignInBrokerError("too-many-attempts");
      case "auth-unavailable":
      case "not-configured":
        return new SignInBrokerError("auth-unavailable");
      default:
        return new SignInBrokerError("unknown");
    }
  }
  return new SignInBrokerError("unknown");
}
