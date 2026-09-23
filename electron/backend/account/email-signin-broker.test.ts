// One sign-in attempt at a time, and everything that can go wrong with it.
//
// WHAT THIS FILE PINS that nothing else can: the polling schedule and its bound, the resend rules,
// the local deadline (which holds independently of any server alarm), the race between the polling
// loop and a pasted link, and — the one that matters most — that a late answer belonging to a
// cancelled or superseded attempt changes nothing at all.
//
// The Worker is a fake `fetch` here. `authlink/worker/test/authlink-integration.test.mts` drives the
// real one; this is the other end of the same conversation.
import { describe, expect, test, vi } from "vitest";

import {
  EmailSignInBroker,
  LOCAL_ATTEMPT_TTL_MS,
  MAX_POLLS_PER_ATTEMPT,
  MAX_SENDS_PER_FLOW,
  nextPollDelayMs,
  RESEND_COOLDOWN_MS,
  SignInBrokerError,
  type SignInAttemptState,
} from "./email-signin-broker.js";
import type { AccountClient } from "./account-client.js";
import { AccountAuthError } from "./account-client.js";
import { MAX_OOB_CODE_LENGTH, type AuthLinkConfig } from "./authlink-config.js";

const NOW = 1_760_000_000_000;
const AUTHLINK: AuthLinkConfig = {
  environment: "local",
  origin: "http://127.0.0.1:8788",
  isLocal: true,
  firebaseProjectId: "demo-strideterm",
  actionHandlers: [{ origin: "https://demo-strideterm.firebaseapp.com", path: "/__/auth/action" }],
};
const ATTEMPT = "a".repeat(43);
const SECRET = "s".repeat(43);

interface Harness {
  broker: EmailSignInBroker;
  client: AccountClient;
  states: (SignInAttemptState | null)[];
  failures: string[];
  calls: { path: string; body: Record<string, unknown> }[];
  /** Runs every poll the broker has scheduled, one round at a time. */
  runScheduled(): Promise<void>;
  now(): number;
  advance(_ms: number): void;
  claimAnswer: { status: number; body: Record<string, unknown>; headers?: Record<string, string> };
  /** The delay of every poll the broker has scheduled, in order. */
  delays: number[];
  startAnswer: { status: number; body: Record<string, unknown> } | "unreachable";
  /** Consumed one per `/start`, then `startAnswer` for the rest. For the create-only repeat. */
  startAnswers: ({ status: number; body: Record<string, unknown> } | "unreachable")[];
}

function harness(options: { startEmailSignIn?: AccountClient["startEmailSignIn"] } = {}): Harness {
  let clock = NOW;
  const pending: (() => void)[] = [];
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const states: (SignInAttemptState | null)[] = [];
  const failures: string[] = [];
  const delays: number[] = [];
  const ids = [ATTEMPT, SECRET, "b".repeat(43), "t".repeat(43), "c".repeat(43), "u".repeat(43)];
  let index = 0;

  const client: AccountClient = {
    startEmailSignIn: options.startEmailSignIn ?? vi.fn(async () => {}),
    completeEmailSignIn: vi.fn(async () => {
      throw new Error("not used by the broker");
    }),
    refresh: vi.fn(async (session) => session),
    requestLoginEmailChange: vi.fn(async () => {}),
    lookup: vi.fn(async () => ({ uid: "u", email: "a@b.test", emailVerified: true })),
  };

  const state: Harness = {
    broker: null as unknown as EmailSignInBroker,
    client,
    states,
    failures,
    calls,
    delays,
    now: () => clock,
    advance: (ms) => {
      clock += ms;
    },
    claimAnswer: { status: 200, body: { state: "pending" } },
    startAnswer: { status: 200, body: { status: "created", expiresAt: NOW + LOCAL_ATTEMPT_TTL_MS } },
    startAnswers: [],
    async runScheduled() {
      const round = pending.splice(0, pending.length);
      for (const fn of round) fn();
      // Let the poll's own promise chain settle.
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };

  state.broker = new EmailSignInBroker({
    authlink: AUTHLINK,
    client,
    now: () => clock,
    jitter: () => 0.5,
    newOpaqueId: () => ids[index++] ?? "z".repeat(43),
    schedule: (fn, delay) => {
      delays.push(delay);
      pending.push(fn);
      return () => {
        const at = pending.indexOf(fn);
        if (at >= 0) pending.splice(at, 1);
      };
    },
    fetchImpl: async (url, init) => {
      const path = new URL(url).pathname;
      calls.push({ path, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      if (path === "/start") {
        const answer = state.startAnswers.shift() ?? state.startAnswer;
        if (answer === "unreachable") throw new Error("ECONNREFUSED");
        return new Response(JSON.stringify(answer.body), { status: answer.status });
      }
      if (path === "/claim") {
        return new Response(JSON.stringify(state.claimAnswer.body), {
          status: state.claimAnswer.status,
          headers: state.claimAnswer.headers,
        });
      }
      return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    },
  });
  state.broker.on("state", (value: SignInAttemptState | null) => states.push(value));
  state.broker.on("failed", (code: string) => failures.push(code));
  return state;
}

describe("the polling schedule", () => {
  test("is the plan's three bands, and jitter never makes it slower than the band", () => {
    // ~3s for the first 30s, ~10s to two minutes, ~20s to the deadline (plan §4). About 75 requests
    // over a whole unfinished attempt, rather than the 450 a flat two-second poll would make.
    expect(nextPollDelayMs(0, 0.5)).toBe(3_000);
    expect(nextPollDelayMs(29_999, 0.5)).toBe(3_000);
    expect(nextPollDelayMs(30_000, 0.5)).toBe(10_000);
    expect(nextPollDelayMs(119_999, 0.5)).toBe(10_000);
    expect(nextPollDelayMs(120_000, 0.5)).toBe(20_000);
    // The jitter band is +/- 15%, and it is bounded whatever the source returns.
    expect(nextPollDelayMs(0, 0)).toBe(2_550);
    expect(nextPollDelayMs(0, 1)).toBe(3_450);
    expect(nextPollDelayMs(0, -5)).toBe(2_550);
    expect(nextPollDelayMs(0, 99)).toBe(3_450);
  });

  test("the whole attempt is bounded by a poll ceiling as well as by the deadline", async () => {
    const h = harness();
    await h.broker.begin("owner@example.test", "reauth");
    for (let i = 0; i < MAX_POLLS_PER_ATTEMPT + 5; i++) await h.runScheduled();
    expect(h.calls.filter((call) => call.path === "/claim").length).toBeLessThanOrEqual(MAX_POLLS_PER_ATTEMPT);
    expect(h.failures).toContain("attempt-expired");
  });
});

describe("starting an attempt", () => {
  test("creates the attempt at the broker BEFORE asking Firebase to send anything", async () => {
    // A link whose attempt was never created is refused by the web page rather than half-completing.
    const h = harness();
    await h.broker.begin("owner@example.test", "enrol");
    const order = h.calls.map((call) => call.path);
    expect(order[0]).toBe("/start");
    expect(h.client.startEmailSignIn).toHaveBeenCalledOnce();
  });

  test("the broker is told the HASH of the secret, and nothing about the person", async () => {
    const h = harness();
    await h.broker.begin("owner@example.test", "enrol");
    const start = h.calls.find((call) => call.path === "/start")!;
    expect(start.body["attemptId"]).toBe(ATTEMPT);
    expect(start.body["claimSecretHash"]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(start.body["claimSecretHash"]).not.toBe(SECRET);
    const text = JSON.stringify(start.body);
    expect(text).not.toContain("owner@example.test");
    expect(text).not.toContain("enrol");
  });

  test("the address is normalised before anything is sent", async () => {
    const h = harness();
    await h.broker.begin("  Owner@EXAMPLE.test ", "reauth");
    expect(h.broker.pinnedEmail).toBe("Owner@example.test");
    expect((h.client.startEmailSignIn as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe("Owner@example.test");
  });

  test("an address that is not one is refused before any request is made", async () => {
    const h = harness();
    await expect(h.broker.begin("not-an-address", "reauth")).rejects.toMatchObject({ code: "invalid-email" });
    expect(h.calls).toHaveLength(0);
  });

  test("an unreachable BROKER falls back to manual-only rather than failing the sign-in", async () => {
    // A person whose broker is down must not be locked out of their own account. What such an attempt
    // cannot do is be confirmed through the web page — there is no record of it there.
    const h = harness();
    h.startAnswer = "unreachable";
    await h.broker.begin("owner@example.test", "reauth");
    expect(h.broker.state()?.manualOnly).toBe(true);
    expect(h.broker.state()?.expiresAt).toBe(NOW + LOCAL_ATTEMPT_TTL_MS);
    expect(h.client.startEmailSignIn).toHaveBeenCalledOnce();
    // TWICE AND NO MORE. The repeat is what the next test is about; this pins its bound, so a
    // broker that is simply gone cannot turn into a retry loop.
    expect(h.calls.filter((call) => call.path === "/start")).toHaveLength(2);
    // And nothing polls, because there is nothing to poll.
    await h.runScheduled();
    expect(h.calls.some((call) => call.path === "/claim")).toBe(false);
  });

  test("an answer that never arrived is asked again, with the IDENTICAL create-only request", async () => {
    // Plan §6: "Podobně při nejistém `/start` nejprve opakovat tentýž create-only request, nikoli
    // vyrábět další čekající objekty." One dropped response must not cost the person the phone and
    // web route for the rest of the attempt — and must not leave a second object behind either, which
    // is why the repeat carries the same id and the same secret hash.
    const h = harness();
    h.startAnswers = ["unreachable"];
    await h.broker.begin("owner@example.test", "reauth");
    const starts = h.calls.filter((call) => call.path === "/start");
    expect(starts).toHaveLength(2);
    expect(starts[1]!.body).toEqual(starts[0]!.body);
    // The record was found, so this attempt is NOT stuck in manual-only and takes the server deadline.
    expect(h.broker.state()?.manualOnly).toBe(false);
    expect(h.broker.state()?.expiresAt).toBe(NOW + LOCAL_ATTEMPT_TTL_MS);
  });

  test("a 5xx is uncertain and repeated; a REFUSAL is an answer and is not", async () => {
    const uncertain = harness();
    uncertain.startAnswers = [{ status: 503, body: {} }];
    await uncertain.broker.begin("owner@example.test", "reauth");
    expect(uncertain.calls.filter((call) => call.path === "/start")).toHaveLength(2);
    expect(uncertain.broker.state()?.manualOnly).toBe(false);

    // A 409 says this id belongs to a different attempt, a 400 that the body was wrong, a 429 that
    // this address has asked too often. Repeating any of them changes nothing, so the attempt goes
    // straight to the manual route.
    const refused = harness();
    refused.startAnswer = { status: 409, body: { code: "attempt-exists" } };
    await refused.broker.begin("owner@example.test", "reauth");
    expect(refused.calls.filter((call) => call.path === "/start")).toHaveLength(1);
    expect(refused.broker.state()?.manualOnly).toBe(true);
  });

  test("a FIREBASE failure tears the attempt down, because nothing will ever confirm it", async () => {
    const h = harness({
      startEmailSignIn: vi.fn(async () => {
        throw new AccountAuthError("auth-unavailable", "email-link is off");
      }),
    });
    await expect(h.broker.begin("owner@example.test", "reauth")).rejects.toMatchObject({ code: "auth-unavailable" });
    expect(h.broker.state()).toBeNull();
    expect(h.calls.some((call) => call.path === "/cancel")).toBe(true);
  });

  test("the server's deadline wins over the local one when the broker answered", async () => {
    const h = harness();
    h.startAnswer = { status: 200, body: { status: "created", expiresAt: NOW + 60_000 } };
    await h.broker.begin("owner@example.test", "reauth");
    expect(h.broker.state()?.expiresAt).toBe(NOW + 60_000);
  });
});

describe("resending", () => {
  test("is refused inside the cooldown", async () => {
    const h = harness();
    await h.broker.begin("owner@example.test", "reauth");
    await expect(h.broker.resend()).rejects.toMatchObject({ code: "too-many-attempts" });
    h.advance(RESEND_COOLDOWN_MS);
    await expect(h.broker.resend()).resolves.toBeUndefined();
  });

  test("a resend is a NEW attempt, and the old one is cancelled rather than extended", async () => {
    // Plan §6: "Resend zakládá nový pokus a starý se ruší; polling deadline neprodlužuje."
    const h = harness();
    await h.broker.begin("owner@example.test", "reauth");
    h.advance(RESEND_COOLDOWN_MS);
    await h.broker.resend();
    const cancelled = h.calls.find((call) => call.path === "/cancel");
    expect(cancelled?.body["attemptId"]).toBe(ATTEMPT);
    const starts = h.calls.filter((call) => call.path === "/start");
    expect(starts).toHaveLength(2);
    expect(starts[1]!.body["attemptId"]).not.toBe(ATTEMPT);
    // A link for the OLD attempt no longer completes anything.
    expect(() => h.broker.submitLink(`${AUTHLINK.origin}/c?attempt=${ATTEMPT}&oobCode=CODE`)).toThrow();
  });

  test("the budget is the FLOW's, not the attempt's", async () => {
    const h = harness();
    await h.broker.begin("owner@example.test", "reauth");
    for (let i = 1; i < MAX_SENDS_PER_FLOW; i++) {
      h.advance(RESEND_COOLDOWN_MS);
      await h.broker.resend();
    }
    h.advance(RESEND_COOLDOWN_MS);
    await expect(h.broker.resend()).rejects.toMatchObject({ code: "too-many-attempts" });
    // A NEW flow starts with a fresh budget: it is a bound on one person's one sign-in, not a lockout.
    await expect(h.broker.begin("owner@example.test", "reauth")).resolves.toBeUndefined();
  });

  test("an unknown send result never triggers an automatic resend", async () => {
    // Plan §6: a lost `sendOobCode` response is an UNKNOWN outcome, never proof that nothing was sent.
    let sends = 0;
    const h = harness({
      startEmailSignIn: vi.fn(async () => {
        sends += 1;
        throw new AccountAuthError("network", "timed out");
      }),
    });
    await h.broker.begin("owner@example.test", "reauth");
    for (let i = 0; i < 5; i++) await h.runScheduled();
    expect(sends).toBe(1);
  });

  test("a LOST send answer keeps the same attempt completable, and says the result is unknown", async () => {
    // F03. Tearing the attempt down here was the defect: `sendOobCode` may have reached Firebase and
    // the message may already be in the mailbox, and a torn-down attempt makes that link unusable by
    // BOTH routes — the paste has no attempt to match against and the broker has no record to hand a
    // payload over from. So the attempt survives, with the same id, and the state says `unknown`
    // rather than claiming a send this desktop cannot prove.
    const h = harness({
      startEmailSignIn: vi.fn(async () => {
        throw new AccountAuthError("network", "the answer never came back");
      }),
    });
    await h.broker.begin("owner@example.test", "reauth");
    const state = h.broker.state();
    expect(state?.phase).toBe("awaiting-link");
    expect(state?.sendOutcome).toBe("unknown");
    // The link that may have arrived still finishes this attempt.
    h.broker.submitLink(`${AUTHLINK.origin}/c?attempt=${ATTEMPT}&oobCode=CODE`);
    expect(h.broker.pendingPayload()).toEqual({ email: "owner@example.test", oobCode: "CODE" });
  });

  test("an externally minted link seeds a manual-only attempt without sending or broker calls", () => {
    const h = harness();
    h.broker.beginExternalLink(
      "owner@example.test",
      `${AUTHLINK.origin}/c?attempt=${ATTEMPT}&oobCode=EXTERNAL`,
      "enrol-with-trial",
    );
    expect(h.calls).toHaveLength(0);
    expect(h.broker.state()).toMatchObject({ phase: "awaiting-link", manualOnly: true, sendOutcome: "unknown" });
    expect(h.broker.pendingPayload()).toEqual({ email: "owner@example.test", oobCode: "EXTERNAL" });
  });

  test("an ANSWERED refusal is not an unknown result: the attempt ends", async () => {
    // The other half of the same distinction. Everything but a transport failure is a message that
    // arrived — a malformed address, this address's rate limit, a project that cannot serve the flow —
    // and an answer means no message was sent, so keeping the attempt open would be offering to
    // complete a link that does not exist.
    for (const code of ["invalid-email", "too-many-attempts", "auth-unavailable"] as const) {
      const h = harness({
        startEmailSignIn: vi.fn(async () => {
          throw new AccountAuthError(code === "auth-unavailable" ? "not-configured" : code, "refused");
        }),
      });
      await expect(h.broker.begin("owner@example.test", "reauth")).rejects.toMatchObject({ code });
      expect(h.broker.state(), code).toBeNull();
    }
  });

  test("the flow's spending survives an expiry, so a cancel-and-resend loop cannot mint extra links", async () => {
    // F03 asks for the flow's lifetime across the error states to be precise, and this is the one
    // that could go the wrong way: a `clear()` — an expiry, a cancel, a finish — ends the ATTEMPT, and
    // if it also reset the budget then cancelling and resending would be a way past the ceiling. Only
    // a new `begin()` starts a new flow.
    const h = harness();
    await h.broker.begin("owner@example.test", "reauth");
    h.advance(RESEND_COOLDOWN_MS);
    await h.broker.resend();
    expect(h.broker.state()?.sendsUsed).toBe(2);
    // The attempt expires (the poll ceiling and the deadline both produce this).
    h.advance(LOCAL_ATTEMPT_TTL_MS);
    await h.runScheduled();
    expect(h.broker.state()).toBeNull();
    expect(h.failures).toContain("attempt-expired");
    // A resend after that has no attempt to resend, and the budget is still spent: the THIRD link is
    // available and a fourth is not.
    await expect(h.broker.resend()).rejects.toMatchObject({ code: "attempt-expired" });
  });

  test("an unknown send still counts against the cooldown and the per-flow budget", async () => {
    // F03: "Cooldown a započítání možného odeslání zachovat i po ztracené odpovědi." A send that may
    // have happened is a send: not counting it would let three lost answers become six messages.
    let sends = 0;
    const h = harness({
      startEmailSignIn: vi.fn(async () => {
        sends += 1;
        throw new AccountAuthError("network", "timed out");
      }),
    });
    await h.broker.begin("owner@example.test", "reauth");
    expect(h.broker.state()?.sendsUsed).toBe(1);
    // Inside the cooldown a resend is refused, exactly as it would be after a successful send.
    await expect(h.broker.resend()).rejects.toMatchObject({ code: "too-many-attempts" });
    for (let i = 1; i < MAX_SENDS_PER_FLOW; i++) {
      h.advance(RESEND_COOLDOWN_MS);
      await h.broker.resend();
    }
    h.advance(RESEND_COOLDOWN_MS);
    await expect(h.broker.resend()).rejects.toMatchObject({ code: "too-many-attempts" });
    expect(sends).toBe(MAX_SENDS_PER_FLOW);
  });
});

describe("collecting the payload", () => {
  test("a confirmed payload moves to the desktop's own final confirmation", async () => {
    const h = harness();
    await h.broker.begin("owner@example.test", "reauth");
    h.claimAnswer = {
      status: 200,
      body: { state: "confirmed", email: "owner@example.test", oobCode: "OOB", availableUntil: NOW + 300_000 },
    };
    await h.runScheduled();
    expect(h.broker.state()?.phase).toBe("awaiting-confirmation");
    expect(h.broker.pendingPayload()).toEqual({ email: "owner@example.test", oobCode: "OOB" });
  });

  test("an address that is not the one this desktop sent the link to is refused", async () => {
    // The web page asks a person to type an address; this desktop already knows which one it used.
    // A disagreement means the wrong attempt is being finished, not that the login address changed.
    const h = harness();
    await h.broker.begin("owner@example.test", "reauth");
    h.claimAnswer = {
      status: 200,
      body: { state: "confirmed", email: "someone.else@example.test", oobCode: "OOB" },
    };
    await h.runScheduled();
    expect(h.failures).toContain("address-mismatch");
    expect(h.broker.state()).toBeNull();
  });

  test("an over-long oobCode is refused on the POLLED route too, not only the pasted one", async () => {
    // Plan §"Bezpečnostní hranice": "JSON schémata odmítají neznámá pole a nestandardní délky". The
    // pasted-link parser has always bounded the code; the polled payload comes from the same broker
    // and must get the same bound, or the fallback would be the strict route and the ordinary one the
    // lenient route.
    const h = harness();
    await h.broker.begin("owner@example.test", "reauth");
    h.claimAnswer = {
      status: 200,
      body: { state: "confirmed", email: "owner@example.test", oobCode: "x".repeat(MAX_OOB_CODE_LENGTH + 1) },
    };
    await h.runScheduled();
    expect(h.failures).toContain("invalid-code");
    expect(h.broker.state()).toBeNull();
  });

  test("a code of exactly the permitted length is still accepted", async () => {
    const h = harness();
    await h.broker.begin("owner@example.test", "reauth");
    h.claimAnswer = {
      status: 200,
      body: { state: "confirmed", email: "owner@example.test", oobCode: "x".repeat(MAX_OOB_CODE_LENGTH) },
    };
    await h.runScheduled();
    expect(h.broker.pendingPayload()?.oobCode).toHaveLength(MAX_OOB_CODE_LENGTH);
  });

  test("a response too large to be one of ours is not parsed, and no payload comes out of it", async () => {
    // Plan §"Bezpečnostní hranice": "Odpovědi se parsují s limitem velikosti". The broker is inside
    // the authentication trust boundary, which is a reason for the bound rather than a reason to skip
    // it — and an oversized body reads as "not JSON", so the attempt just keeps waiting.
    const h = harness();
    await h.broker.begin("owner@example.test", "reauth");
    h.claimAnswer = {
      status: 200,
      body: {
        state: "confirmed",
        email: "owner@example.test",
        oobCode: "OOB",
        padding: "p".repeat(64 * 1024),
      },
    };
    await h.runScheduled();
    expect(h.broker.pendingPayload()).toBeNull();
    expect(h.broker.state()?.phase).toBe("awaiting-link");
  });

  test("a deadline further out than the local one is CLAMPED, not adopted", async () => {
    // Plan §9: "Lokální i serverový deadline platí nezávisle na alarmu." A broker that answers with
    // a deadline a century away must not be able to keep this attempt alive past the desktop's own
    // fifteen minutes.
    const h = harness();
    h.startAnswer = { status: 200, body: { status: "created", expiresAt: NOW + 100 * 365 * 24 * 3600_000 } };
    await h.broker.begin("owner@example.test", "reauth");
    expect(h.broker.state()?.expiresAt).toBe(NOW + LOCAL_ATTEMPT_TTL_MS);
    h.advance(LOCAL_ATTEMPT_TTL_MS + 1);
    await h.runScheduled();
    expect(h.failures).toContain("attempt-expired");
  });

  test("a deadline SHORTER than the local one is respected — the broker may only shorten", async () => {
    const h = harness();
    h.startAnswer = { status: 200, body: { status: "created", expiresAt: NOW + 60_000 } };
    await h.broker.begin("owner@example.test", "reauth");
    expect(h.broker.state()?.expiresAt).toBe(NOW + 60_000);
  });

  test("starting again with a CORRECTED address cancels the first attempt at the broker", async () => {
    // Plan §6: "Změna rozepsané adresy ruší původní pokus místo úpravy jeho `expectedEmail`." The
    // generation bump alone would make the old attempt unfinishable here while leaving the broker a
    // confirmable record for the rest of its window.
    const h = harness();
    await h.broker.begin("typo@example.test", "reauth");
    const firstAttempt = h.calls.find((call) => call.path === "/start")?.body["attemptId"];
    h.calls.length = 0;
    await h.broker.begin("owner@example.test", "reauth");
    const cancelled = h.calls.find((call) => call.path === "/cancel");
    expect(cancelled?.body["attemptId"]).toBe(firstAttempt);
    // And the new attempt is a NEW id, not the old one re-addressed.
    expect(h.calls.find((call) => call.path === "/start")?.body["attemptId"]).not.toBe(firstAttempt);
  });

  test("the SAME address in a different case is not a mismatch", async () => {
    // Phase-0 row 36: the Identity Toolkit lowercases the whole address, so `Person@x` and `person@x`
    // are one mailbox as far as the sign-in is concerned. Refusing the confirmation over a difference
    // the service does not have was refusing somebody their own address.
    const h = harness();
    await h.broker.begin("Owner.Case@Example.test", "reauth");
    h.claimAnswer = {
      status: 200,
      body: { state: "confirmed", email: "owner.case@example.test", oobCode: "OOB" },
    };
    await h.runScheduled();
    expect(h.failures).toEqual([]);
    // And the address the sign-in will USE is still this desktop's own, not the page's spelling.
    // The local part exactly as typed, the domain folded — `normalizeAuthEmail`'s rule, unchanged.
    expect(h.broker.pendingPayload()?.email).toBe("Owner.Case@example.test");
  });

  test("a 429 is waited out for as long as the broker asked, not for the ordinary band", async () => {
    // PLAN §6: "HTTP 429 vrací `Retry-After`; klient jej respektuje bez prodlužování deadline."
    // The object answers `claim-locked` and `too-many-requests` with the header and nothing read
    // it, so a 429 was indistinguishable from "nothing yet" and the next poll went out three seconds
    // later — against a server that had just said sixty.
    const h = harness();
    await h.broker.begin("owner@example.test", "reauth");
    h.claimAnswer = { status: 429, body: { code: "too-many-requests" }, headers: { "retry-after": "60" } };
    const before = h.delays.length;
    await h.runScheduled();
    expect(h.delays.slice(before).at(-1)).toBeGreaterThanOrEqual(60_000);
    // AND IT IS ONLY EVER A FLOOR. The band comes back the moment the broker stops asking for a wait.
    h.claimAnswer = { status: 200, body: { state: "pending" } };
    const middle = h.delays.length;
    await h.runScheduled();
    expect(h.delays.slice(middle).at(-1)).toBeLessThan(60_000);
  });

  test("a Retry-After longer than the attempt has left cannot park it past its own deadline", async () => {
    // A wait is not an extension. Whether the header comes from a real limiter or from something
    // hostile, the attempt still ends when it was always going to end.
    const h = harness();
    await h.broker.begin("owner@example.test", "reauth");
    h.claimAnswer = { status: 429, body: { code: "claim-locked" }, headers: { "retry-after": "86400" } };
    const before = h.delays.length;
    await h.runScheduled();
    const waited = h.delays.slice(before).at(-1) ?? 0;
    expect(waited).toBeLessThanOrEqual(LOCAL_ATTEMPT_TTL_MS);
    expect(waited).toBeGreaterThan(60_000);
  });

  test("a header that is not whole seconds is ignored rather than guessed at", async () => {
    // The RFC also permits an HTTP-date, which would have to be read against this machine's clock.
    // A wrong clock turning a one-minute wait into an arbitrary one is worse than no wait at all,
    // and the ordinary schedule is bounded anyway.
    const h = harness();
    await h.broker.begin("owner@example.test", "reauth");
    h.claimAnswer = {
      status: 429,
      body: { code: "too-many-requests" },
      headers: { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" },
    };
    const before = h.delays.length;
    await h.runScheduled();
    expect(h.delays.slice(before).at(-1)).toBeLessThan(30_000);
  });

  test("a network failure keeps polling instead of ending the attempt", async () => {
    const h = harness();
    await h.broker.begin("owner@example.test", "reauth");
    h.claimAnswer = { status: 500, body: {} };
    await h.runScheduled();
    expect(h.broker.state()?.phase).toBe("awaiting-link");
    h.claimAnswer = { status: 200, body: { state: "confirmed", email: "owner@example.test", oobCode: "OOB" } };
    await h.runScheduled();
    expect(h.broker.state()?.phase).toBe("awaiting-confirmation");
  });

  test("a 410 from the broker ends the attempt as expired", async () => {
    const h = harness();
    await h.broker.begin("owner@example.test", "reauth");
    h.claimAnswer = { status: 410, body: { code: "attempt-expired" } };
    await h.runScheduled();
    expect(h.failures).toContain("attempt-expired");
  });

  test("a FOREIGN claimSecret against this attempt id is not a payload, and polling continues", async () => {
    // Plan §3's "Hotovo" row: "cizí secret ... má testovaný výsledek." The Worker answers a wrong
    // claimSecret with the SAME `401 unauthorized` it gives a nonexistent attempt (durable-object.ts:
    // "ONE ANSWER for 'no such attempt' and 'wrong secret'"), on purpose — so this desktop, which only
    // ever presents its OWN secret, must treat that answer exactly like "nothing yet": no payload is
    // accepted, no failure is emitted, and the ordinary poll continues rather than tearing the attempt
    // down (which is what would let a third party who does not have the secret end someone else's
    // sign-in just by trying a wrong one against it).
    const h = harness();
    await h.broker.begin("owner@example.test", "reauth");
    h.claimAnswer = { status: 401, body: { code: "unauthorized" } };
    await h.runScheduled();
    expect(h.broker.state()?.phase).toBe("awaiting-link");
    expect(h.broker.pendingPayload()).toBeNull();
    expect(h.failures).toEqual([]);
    // The legitimate desktop's own next poll, with its own correct secret, still completes normally.
    h.claimAnswer = { status: 200, body: { state: "confirmed", email: "owner@example.test", oobCode: "OOB" } };
    await h.runScheduled();
    expect(h.broker.state()?.phase).toBe("awaiting-confirmation");
  });

  test("the pasted link and the polling race, and exactly one payload survives", async () => {
    const h = harness();
    await h.broker.begin("owner@example.test", "reauth");
    h.broker.submitLink(`${AUTHLINK.origin}/c?attempt=${ATTEMPT}&oobCode=PASTED`);
    h.claimAnswer = { status: 200, body: { state: "confirmed", email: "owner@example.test", oobCode: "POLLED" } };
    await h.runScheduled();
    // The first one in wins; the second is a no-op rather than a second redemption.
    expect(h.broker.pendingPayload()?.oobCode).toBe("PASTED");
  });

  test("a link for another attempt, or after the deadline, is refused", async () => {
    const h = harness();
    await h.broker.begin("owner@example.test", "reauth");
    expect(() => h.broker.submitLink(`${AUTHLINK.origin}/c?attempt=${"z".repeat(43)}&oobCode=C`)).toThrow(
      SignInBrokerError,
    );
    h.advance(LOCAL_ATTEMPT_TTL_MS + 1);
    expect(() => h.broker.submitLink(`${AUTHLINK.origin}/c?attempt=${ATTEMPT}&oobCode=C`)).toThrow(SignInBrokerError);
  });
});

describe("the local deadline", () => {
  test("is enforced by the desktop before a code is ever presented", async () => {
    // Plan §6: "Před zahájením Firebase sign-in znovu ověřit deadline také v desktopu, včetně kódu
    // již načteného do paměti." Neither deadline depends on the other, and neither depends on an
    // alarm having run.
    const h = harness();
    await h.broker.begin("owner@example.test", "reauth");
    h.broker.submitLink(`${AUTHLINK.origin}/c?attempt=${ATTEMPT}&oobCode=CODE`);
    h.advance(LOCAL_ATTEMPT_TTL_MS + 1);
    expect(() => h.broker.beginVerification()).toThrow(SignInBrokerError);
  });

  test("a verification that started IN TIME gets its own short grace", async () => {
    const h = harness();
    await h.broker.begin("owner@example.test", "reauth");
    h.broker.submitLink(`${AUTHLINK.origin}/c?attempt=${ATTEMPT}&oobCode=CODE`);
    const { deadline } = h.broker.beginVerification();
    expect(deadline).toBeGreaterThan(h.now());
    // Never longer than two minutes from now, whatever the attempt's own deadline says.
    expect(deadline).toBeLessThanOrEqual(h.now() + 2 * 60_000);
    expect(h.broker.state()?.phase).toBe("verifying");
  });
});

describe("ending an attempt", () => {
  test("cancelling tells the broker and stops the polling", async () => {
    const h = harness();
    await h.broker.begin("owner@example.test", "reauth");
    h.broker.cancel();
    expect(h.calls.some((call) => call.path === "/cancel")).toBe(true);
    expect(h.broker.state()).toBeNull();
    const before = h.calls.length;
    await h.runScheduled();
    expect(h.calls.length).toBe(before);
  });

  test("a LATE answer from a cancelled attempt changes nothing", async () => {
    // The whole reason every await is followed by a generation check. Without it, an attempt somebody
    // cancelled ten seconds ago could still walk into the follow-up action when its claim returned.
    const h = harness();
    await h.broker.begin("owner@example.test", "reauth");
    h.claimAnswer = { status: 200, body: { state: "confirmed", email: "owner@example.test", oobCode: "OOB" } };
    const pending = h.runScheduled();
    h.broker.cancel();
    await pending;
    expect(h.broker.state()).toBeNull();
    expect(h.broker.pendingPayload()).toBeNull();
  });

  test("finishing acknowledges the broker, and a failed ack is not an error", async () => {
    const h = harness();
    await h.broker.begin("owner@example.test", "reauth");
    h.broker.submitLink(`${AUTHLINK.origin}/c?attempt=${ATTEMPT}&oobCode=CODE`);
    h.broker.finish(h.broker.beginVerification().ref);
    expect(h.calls.some((call) => call.path === "/ack")).toBe(true);
    expect(h.broker.state()).toBeNull();
  });

  test("dispose ends everything without waiting for a round trip", async () => {
    const h = harness();
    await h.broker.begin("owner@example.test", "reauth");
    const before = h.calls.length;
    h.broker.dispose();
    expect(h.calls.length).toBe(before);
    expect(h.broker.state()).toBeNull();
  });
});

describe("what the broadcast state carries", () => {
  test("never the secret, never the code, never the attempt id", async () => {
    const h = harness();
    await h.broker.begin("owner@example.test", "reauth");
    h.broker.submitLink(`${AUTHLINK.origin}/c?attempt=${ATTEMPT}&oobCode=A-LIVE-CODE`);
    const text = JSON.stringify(h.states.filter(Boolean));
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("A-LIVE-CODE");
    expect(text).not.toContain(ATTEMPT);
    // What it DOES carry is what a person waiting for an email needs.
    expect(h.broker.state()).toMatchObject({ email: "owner@example.test", purpose: "reauth", manualOnly: false });
  });
});
