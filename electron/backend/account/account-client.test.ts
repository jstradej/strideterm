// The owner identity client: what it sends, what it refuses to say, and what it never keeps.
//
// THERE IS NO PASSWORD IN THIS FILE, and that is the first thing it asserts. What replaced it is a
// one-time link: `sendOobCode` with `requestType: EMAIL_SIGNIN`, then `signInWithEmailLink`. The
// cases this file is really about are the two that decide whether the rest of the flow is safe —
// the session parser refuses anything incomplete rather than filling gaps, and the sign-in never
// sends the installation's `idToken` (which would be an identity MERGE and not a sign-in).
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  AccountAuthError,
  AUTH_TIME_FUTURE_TOLERANCE_MS,
  createAccountClient,
  hasRecentAuth,
  mapAuthError,
  needsRefresh,
  readIdTokenClaims,
  RECENT_AUTH_WINDOW_MS,
  REQUEST_TIMEOUT_MS,
  type FetchLike,
  type OwnerSession,
} from "./account-client.js";
import { MOBILE_FIREBASE_ENV_VARS, resolveMobileFirebaseConfig } from "../mobile/mobile-firebase-config.js";
import { FUNCTIONS_REGION } from "../mobile/mobile-rtdb-paths.js";

const CONFIG = resolveMobileFirebaseConfig(
  {
    STRIDETERM_ENV: "local",
    [MOBILE_FIREBASE_ENV_VARS.projectId]: "demo-strideterm",
    [MOBILE_FIREBASE_ENV_VARS.authEmulator]: "127.0.0.1:9099",
    [MOBILE_FIREBASE_ENV_VARS.databaseEmulator]: "127.0.0.1:9000",
    [MOBILE_FIREBASE_ENV_VARS.functionsEmulator]: "127.0.0.1:5001",
  },
  FUNCTIONS_REGION,
).config!;

const NOW = 1_760_000_000_000;
const OOB_CODE = "OOB-CODE-VALUE";
const CONTINUE_URL = "https://auth.strideterm.com/c?attempt=abc";

interface Call {
  url: string;
  body: string;
  init?: RequestInit;
}

function recordingFetch(responses: { status: number; body: unknown }[]): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  let index = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, body: String(init?.body ?? ""), ...(init === undefined ? {} : { init }) });
    const next = responses[Math.min(index, responses.length - 1)]!;
    index += 1;
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetchImpl, calls };
}

// The request deadline is a real timer, so the tests that exercise it drive the clock rather than
// waiting ten seconds each.
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function client(responses: { status: number; body: unknown }[]) {
  const { fetchImpl, calls } = recordingFetch(responses);
  return { client: createAccountClient({ config: CONFIG, fetchImpl, now: () => NOW }), calls };
}

/**
 * An unsigned id token carrying the claims this client reads.
 *
 * IT IS NOT A VALID TOKEN AND DOES NOT NEED TO BE: nothing here verifies a signature, and F08's whole
 * point is that a local decode authorises nothing. What the fixture has to be is a token whose payload
 * segment is real base64url JSON, because that is the only part this client looks at.
 */
function idTokenWith(claims: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `header.${payload}.signature`;
}

const SIGN_IN_BODY = {
  // A REAL `auth_time`, because since F08 a token without one no longer produces a session that claims
  // to have been authenticated just now — it produces `authenticatedAt: null`.
  idToken: idTokenWith({ auth_time: NOW / 1000, sub: "owner-uid-1", email_verified: true }),
  refreshToken: "refresh-token-1",
  localId: "owner-uid-1",
  email: "owner@example.test",
  expiresIn: "3600",
};

describe("asking for a sign-in link", () => {
  test("sends EMAIL_SIGNIN with the backend's own continueUrl and canHandleCodeInApp", async () => {
    const { client: account, calls } = client([{ status: 200, body: {} }]);
    await account.startEmailSignIn("owner@example.test", CONTINUE_URL);
    const body = JSON.parse(calls[0]!.body) as Record<string, unknown>;
    expect(calls[0]!.url).toContain("accounts:sendOobCode");
    expect(body).toEqual({
      requestType: "EMAIL_SIGNIN",
      email: "owner@example.test",
      continueUrl: CONTINUE_URL,
      canHandleCodeInApp: true,
    });
  });

  test("an identity service that cannot serve the flow is ONE code, whichever way it says so", async () => {
    // Email-link sign-in turned off, an unauthorized continueUrl domain and a spent send quota are
    // three operator problems and none of them is the user's.
    for (const message of ["OPERATION_NOT_ALLOWED", "UNAUTHORIZED_DOMAIN", "INVALID_CONTINUE_URI", "QUOTA_EXCEEDED"]) {
      const { client: account } = client([{ status: 400, body: { error: { message } } }]);
      await expect(account.startEmailSignIn("a@b.test", CONTINUE_URL)).rejects.toMatchObject({
        code: "auth-unavailable",
      });
    }
  });

  test("a transport failure is its own code, not a refusal", async () => {
    // A form that says "that address is wrong" when the network is down teaches people to retype an
    // address that was right.
    const account = createAccountClient({
      config: CONFIG,
      now: () => NOW,
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    await expect(account.startEmailSignIn("a@b.test", CONTINUE_URL)).rejects.toMatchObject({ code: "network" });
  });

  test("a TLS-inspection failure stays `network` and carries the tls-untrusted detail", async () => {
    const account = createAccountClient({
      config: CONFIG,
      now: () => NOW,
      fetchImpl: async () => {
        throw new TypeError("fetch failed", {
          cause: Object.assign(new Error("unable to get local issuer certificate"), {
            code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
          }),
        });
      },
    });
    await expect(account.startEmailSignIn("a@b.test", CONTINUE_URL)).rejects.toMatchObject({
      code: "network",
      detail: "tls-untrusted",
    });
  });

  test("an unclassified transport failure has no detail", async () => {
    const account = createAccountClient({
      config: CONFIG,
      now: () => NOW,
      fetchImpl: async () => {
        throw new Error("boom");
      },
    });
    await expect(account.startEmailSignIn("a@b.test", CONTINUE_URL)).rejects.toMatchObject({
      code: "network",
      detail: null,
    });
  });
});

describe("redeeming the link", () => {
  test("returns a session stamped with the moment the identity was proved", async () => {
    const { client: account } = client([{ status: 200, body: SIGN_IN_BODY }]);
    const session = await account.completeEmailSignIn("owner@example.test", OOB_CODE);
    expect(session.uid).toBe("owner-uid-1");
    expect(session.expiresAt).toBe(NOW + 3_600_000);
    expect(session.authenticatedAt).toBe(NOW);
  });

  test("a hanging request ends, and ends as a transport failure rather than a refusal", async () => {
    // F04. A `fetch` that never settles used to hold the flow, its busy flag and the person for ever.
    let aborted = false;
    const account = createAccountClient({
      config: CONFIG,
      now: () => NOW,
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
        }),
    });
    // The handler is attached BEFORE the clock moves: the rejection happens inside
    // `advanceTimersByTimeAsync`, and a promise with no handler at that moment is an unhandled
    // rejection even though the assertion below would have caught it a tick later.
    const settled = account.completeEmailSignIn("owner@example.test", OOB_CODE).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1);
    expect(await settled).toMatchObject({ code: "network" });
    expect(aborted).toBe(true);
  });

  test("a body that never ends is bounded by the same deadline", async () => {
    // The headers arriving promptly is not the request ending. A timer cleared when `fetch` resolves
    // never sees a body that trickles for ever, which is why the deadline is disarmed after the read.
    const account = createAccountClient({
      config: CONFIG,
      now: () => NOW,
      fetchImpl: async (_url, init) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"idToken":"a"'));
              init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted")));
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });
    const settled = account.completeEmailSignIn("owner@example.test", OOB_CODE).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1);
    expect(await settled).toMatchObject({ code: "network" });
  });

  test("an oversized body is refused without being read into memory whole", async () => {
    // The bound is on BYTES RECEIVED, not on the length of a string the process has already accepted.
    let deliveredBytes = 0;
    const chunk = new TextEncoder().encode("x".repeat(8 * 1024));
    const account = createAccountClient({
      config: CONFIG,
      now: () => NOW,
      fetchImpl: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              // Far more than the 64 KiB limit if it were ever allowed to finish.
              if (deliveredBytes >= 4 * 1024 * 1024) return controller.close();
              deliveredBytes += chunk.byteLength;
              controller.enqueue(chunk);
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });
    await expect(account.completeEmailSignIn("owner@example.test", OOB_CODE)).rejects.toBeInstanceOf(AccountAuthError);
    expect(deliveredBytes).toBeLessThan(4 * 1024 * 1024);
  });

  test("abandoning the flow is `aborted`, not `network` - nothing about the service is known", async () => {
    const controller = new AbortController();
    const account = createAccountClient({
      config: CONFIG,
      now: () => NOW,
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });
    const pending = account.completeEmailSignIn("owner@example.test", OOB_CODE, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
  });

  test("`authenticatedAt` comes from the TOKEN's own auth_time when it has one", async () => {
    // The server enforces `auth_time` on a token it has verified, so a desktop reading its own clock
    // instead would offer a destructive action the server is about to refuse (fast clock) or ask for a
    // fresh link it does not need (slow clock). Read, never verified: nothing is authorised by it.
    const authTimeSeconds = Math.floor((NOW - 120_000) / 1000);
    const payload = Buffer.from(JSON.stringify({ auth_time: authTimeSeconds }), "utf8").toString("base64url");
    const { client: account } = client([
      { status: 200, body: { ...SIGN_IN_BODY, idToken: `header.${payload}.signature` } },
    ]);
    const session = await account.completeEmailSignIn("owner@example.test", OOB_CODE);
    expect(session.authenticatedAt).toBe(authTimeSeconds * 1000);
  });

  test("a token whose auth_time cannot be READ leaves the session with no proven auth time", async () => {
    // F08. It used to fall back to `now()`, which turns "the token does not say when this person
    // authenticated" into "they authenticated just now" — a LOCAL permission derived from the absence
    // of the evidence for it. Null is the honest answer, and it makes `hasRecentAuth` false, so the
    // desktop asks for a fresh link instead of offering a destructive action the server will refuse.
    for (const idToken of ["not-a-jwt", "a.!!!.c", "a.eyJ4IjoxfQ.c"]) {
      const { client: account } = client([{ status: 200, body: { ...SIGN_IN_BODY, idToken } }]);
      const session = await account.completeEmailSignIn("owner@example.test", OOB_CODE);
      expect(session.authenticatedAt, idToken).toBeNull();
      expect(hasRecentAuth(session, NOW), idToken).toBe(false);
    }
  });

  test("an auth_time that is not a usable time grants nothing, whichever way it is unusable", async () => {
    // Each of these either survived the old `typeof === "number"` test or slipped into the `now()`
    // fallback, and each one is a different way of never expiring or never having happened. F08:
    // "Chybejici, neciselny, nekonecny nebo casove nesmyslny auth udaj nesmi dat lokalni opravneni
    // k citlive akci."
    const cases: [string, unknown][] = [
      ["missing", undefined],
      ["a string", String(NOW / 1000)],
      ["NaN", Number.NaN],
      ["Infinity", Number.POSITIVE_INFINITY],
      ["the epoch", 0],
      ["negative", -1],
      ["1970", 1],
      ["far in the future", NOW / 1000 + 86_400],
      ["just past the clock tolerance", (NOW + AUTH_TIME_FUTURE_TOLERANCE_MS) / 1000 + 1],
    ];
    for (const [label, authTime] of cases) {
      const idToken = idTokenWith(authTime === undefined ? { sub: "owner-uid-1" } : { auth_time: authTime });
      const { client: account } = client([{ status: 200, body: { ...SIGN_IN_BODY, idToken } }]);
      const session = await account.completeEmailSignIn("owner@example.test", OOB_CODE);
      expect(session.authenticatedAt, label).toBeNull();
      expect(hasRecentAuth(session, NOW), label).toBe(false);
    }
  });

  test("a future auth_time INSIDE the clock tolerance is accepted, because that is what skew looks like", async () => {
    // The tolerance has to exist: the claim is stamped by Google's clock and compared against this
    // machine's, and a desktop a minute behind would otherwise refuse its own fresh sign-in.
    const authTime = (NOW + 60_000) / 1000;
    const { client: account } = client([
      { status: 200, body: { ...SIGN_IN_BODY, idToken: idTokenWith({ auth_time: authTime }) } },
    ]);
    const session = await account.completeEmailSignIn("owner@example.test", OOB_CODE);
    expect(session.authenticatedAt).toBe(authTime * 1000);
    expect(hasRecentAuth(session, NOW)).toBe(true);
  });

  test("the claims a caller cross-checks are read, and an absent one is null rather than false", () => {
    // The manager compares `sub` with the response's `localId` and `email_verified` with the Auth
    // record. A token that does not CARRY the claim must not read as `false` there — a local decode is
    // not a substitute for the record, and treating silence as a denial would refuse valid sign-ins.
    expect(readIdTokenClaims(idTokenWith({ sub: "u1", email_verified: true, auth_time: NOW / 1000 }), NOW)).toEqual({
      subject: "u1",
      emailVerified: true,
      authTime: NOW,
    });
    expect(readIdTokenClaims(idTokenWith({}), NOW)).toEqual({ subject: null, emailVerified: null, authTime: null });
    expect(readIdTokenClaims("not-a-jwt", NOW)).toEqual({ subject: null, emailVerified: null, authTime: null });
    expect(readIdTokenClaims(idTokenWith({ email_verified: "yes" }), NOW).emailVerified).toBeNull();
  });

  test("it does NOT send the installation's idToken — that would be an identity merge", async () => {
    // `signInWithEmailLink` takes an optional `idToken` meaning "link this credential to the user who
    // is already signed in". The desktop always has an installation session, so passing it would
    // silently merge the owner identity into the machine's anonymous one.
    const { client: account, calls } = client([{ status: 200, body: SIGN_IN_BODY }]);
    await account.completeEmailSignIn("owner@example.test", OOB_CODE);
    const body = JSON.parse(calls[0]!.body) as Record<string, unknown>;
    expect(body).toEqual({ email: "owner@example.test", oobCode: OOB_CODE });
  });

  test("the session carries the address this DESKTOP pinned, not one echoed back", async () => {
    const { client: account } = client([
      { status: 200, body: { ...SIGN_IN_BODY, email: "someone.else@example.test" } },
    ]);
    const session = await account.completeEmailSignIn("owner@example.test", OOB_CODE);
    expect(session.email).toBe("owner@example.test");
  });

  test("`emailVerified` is NOT read from the sign-in response, because it is not in the contract", async () => {
    // The REST contract for `signInWithEmailLink` does not document the field. Believing it would be
    // believing something the service does not promise to send; the caller asks `lookup` instead.
    const { client: account } = client([{ status: 200, body: { ...SIGN_IN_BODY, emailVerified: true } }]);
    const session = await account.completeEmailSignIn("owner@example.test", OOB_CODE);
    expect(session.emailVerified).toBe(false);
  });

  test("an INCOMPLETE response is not a session — no field is filled in from anywhere", async () => {
    // The old parser coerced every field through `String(...)` and fell back to a previous session, so
    // a partial answer produced an object that looked like a session and carried an empty token.
    for (const body of [
      { refreshToken: "r", localId: "u" },
      { idToken: "i", localId: "u" },
      { idToken: "i", refreshToken: "r" },
      { idToken: "", refreshToken: "r", localId: "u" },
      {},
    ]) {
      const { client: account } = client([{ status: 200, body }]);
      await expect(account.completeEmailSignIn("a@b.test", OOB_CODE)).rejects.toBeInstanceOf(AccountAuthError);
    }
  });

  test("a used or invalid code is one code; an expired one is its own", async () => {
    // Firebase does not reliably tell "wrong" from "already redeemed" apart, so neither does this —
    // and inventing the distinction is how a UI ends up confidently wrong. Expiry IS named, because
    // it is the one a person acts on by asking for a new link.
    for (const message of ["INVALID_OOB_CODE", "MISSING_OOB_CODE"]) {
      const { client: account } = client([{ status: 400, body: { error: { message } } }]);
      await expect(account.completeEmailSignIn("a@b.test", OOB_CODE)).rejects.toMatchObject({ code: "invalid-code" });
    }
    const { client: expired } = client([{ status: 400, body: { error: { message: "EXPIRED_OOB_CODE" } } }]);
    await expect(expired.completeEmailSignIn("a@b.test", OOB_CODE)).rejects.toMatchObject({ code: "expired-code" });
  });

  test("the remote message never reaches the thrown error", async () => {
    const { client: account } = client([
      {
        status: 400,
        body: { error: { message: "INVALID_OOB_CODE : the code for owner@example.test was already used" } },
      },
    ]);
    await expect(account.completeEmailSignIn("owner@example.test", OOB_CODE)).rejects.toSatisfy((error: unknown) => {
      const text = `${(error as Error).message} ${JSON.stringify(error)}`;
      return !text.includes("owner@example.test") && !text.includes("already used");
    });
  });

  test("a credential request refuses to follow a redirect", async () => {
    // HTTP 307/308 preserves the method AND the body, so a redirect on this request is an instruction
    // to send the sign-in code to whatever host the response named.
    const { client: account, calls } = client([{ status: 200, body: SIGN_IN_BODY }]);
    await account.completeEmailSignIn("a@b.test", OOB_CODE);
    expect(calls[0]!.init?.redirect).toBe("error");
  });
});

describe("error mapping", () => {
  test("every documented Firebase code maps to one of ours, and an unknown one is `unknown`", () => {
    expect(mapAuthError({ error: { message: "INVALID_OOB_CODE" } })).toBe("invalid-code");
    expect(mapAuthError({ error: { message: "EXPIRED_OOB_CODE : the code has expired" } })).toBe("expired-code");
    expect(mapAuthError({ error: { message: "OPERATION_NOT_ALLOWED" } })).toBe("auth-unavailable");
    expect(mapAuthError({ error: { message: "TOO_MANY_ATTEMPTS_TRY_LATER" } })).toBe("too-many-attempts");
    expect(mapAuthError({ error: { message: "CREDENTIAL_TOO_OLD_LOGIN_AGAIN" } })).toBe("requires-recent-login");
    expect(mapAuthError({ error: { message: "USER_DISABLED" } })).toBe("user-disabled");
    expect(mapAuthError({ error: { message: "SOMETHING_NEW" } })).toBe("unknown");
    expect(mapAuthError(null)).toBe("unknown");
  });
});

describe("recent authentication", () => {
  const session: OwnerSession = {
    idToken: "id",
    refreshToken: "refresh",
    uid: "u",
    email: "a@b.test",
    emailVerified: true,
    expiresAt: NOW + 3_600_000,
    authenticatedAt: NOW,
  };

  test("a refresh gives a new token and does NOT count as proving the identity again", async () => {
    // The whole distinction "recent reauthentication" rests on, and the server enforces the same thing
    // on `auth_time`. A token that refreshes itself forever would make the five-minute window
    // meaningless on both sides.
    const { client: account } = client([
      { status: 200, body: { id_token: "id-token-2", refresh_token: "refresh-token-2", expires_in: "3600" } },
    ]);
    const refreshed = await account.refresh(session);
    expect(refreshed.idToken).toBe("id-token-2");
    expect(refreshed.authenticatedAt).toBe(session.authenticatedAt);
  });

  test("a refresh that answers without a token is a refusal, not an empty session", async () => {
    const { client: account } = client([{ status: 200, body: { refresh_token: "r", expires_in: "3600" } }]);
    await expect(account.refresh(session)).rejects.toBeInstanceOf(AccountAuthError);
  });

  test("redeeming a link DOES count", async () => {
    const { client: account } = client([{ status: 200, body: SIGN_IN_BODY }]);
    const proved = await account.completeEmailSignIn("owner@example.test", OOB_CODE);
    expect(proved.authenticatedAt).toBe(NOW);
  });

  test("a session with no proven auth time is never recent, however new it is", () => {
    // F08's rule stated at the one place every destructive door consults.
    expect(hasRecentAuth({ ...session, authenticatedAt: null }, NOW)).toBe(false);
  });

  test("the window is exclusive at its far edge", () => {
    expect(hasRecentAuth(session, NOW)).toBe(true);
    expect(hasRecentAuth(session, NOW + RECENT_AUTH_WINDOW_MS)).toBe(true);
    expect(hasRecentAuth(session, NOW + RECENT_AUTH_WINDOW_MS + 1)).toBe(false);
  });

  test("a token is refreshed before it expires, not after", () => {
    expect(needsRefresh(session, NOW)).toBe(false);
    expect(needsRefresh(session, session.expiresAt - 30_000)).toBe(true);
    expect(needsRefresh(session, session.expiresAt + 1)).toBe(true);
  });
});

describe("the lookup", () => {
  const session: OwnerSession = {
    idToken: "id",
    refreshToken: "refresh",
    uid: "owner-uid-1",
    email: "owner@example.test",
    emailVerified: false,
    expiresAt: NOW + 3_600_000,
    authenticatedAt: NOW,
  };

  test("answers with the UID, so the caller can compare it with the one it signed in as", async () => {
    const { client: account } = client([
      { status: 200, body: { users: [{ localId: "owner-uid-1", email: "owner@example.test", emailVerified: true }] } },
    ]);
    expect(await account.lookup(session)).toEqual({
      uid: "owner-uid-1",
      email: "owner@example.test",
      emailVerified: true,
    });
  });

  test("an answer with no account at all is a refusal, not a blank uid", async () => {
    for (const body of [{ users: [] }, { users: [{ email: "a@b.test" }] }, {}]) {
      const { client: account } = client([{ status: 200, body }]);
      await expect(account.lookup(session)).rejects.toBeInstanceOf(AccountAuthError);
    }
  });
});

describe("changing the login address", () => {
  const session: OwnerSession = {
    idToken: "id",
    refreshToken: "refresh",
    uid: "u",
    email: "old@example.test",
    emailVerified: true,
    expiresAt: NOW + 3_600_000,
    authenticatedAt: NOW,
  };

  test("uses VERIFY_AND_CHANGE_EMAIL, so the OLD address keeps working until the new one is opened", async () => {
    // A direct `update` would put the new address on the account before anybody proved they can read
    // it — so a typo locks the person out of their own account. With enumeration protection on,
    // Firebase refuses the direct call anyway.
    const { client: account, calls } = client([{ status: 200, body: {} }]);
    await account.requestLoginEmailChange(session, "new@example.test");
    const body = JSON.parse(calls[0]!.body) as Record<string, unknown>;
    expect(body).toEqual({ requestType: "VERIFY_AND_CHANGE_EMAIL", idToken: "id", newEmail: "new@example.test" });
    expect(JSON.stringify(body)).not.toContain("returnSecureToken");
  });

  test("needs a recent proof of identity", async () => {
    const { client: account } = client([{ status: 200, body: {} }]);
    await expect(
      account.requestLoginEmailChange(
        { ...session, authenticatedAt: NOW - RECENT_AUTH_WINDOW_MS - 1 },
        "new@example.test",
      ),
    ).rejects.toMatchObject({ code: "requires-recent-login" });
  });

  test("an address that is ALREADY TAKEN is not reported as one", async () => {
    // Answering differently for an occupied address turns this into a way to ask whether somebody has
    // an account here. The caller says "check the new mailbox" either way — which is also the truthful
    // sentence, since a successful send is not evidence a message arrived.
    const { client: account } = client([{ status: 400, body: { error: { message: "EMAIL_EXISTS" } } }]);
    await expect(account.requestLoginEmailChange(session, "taken@example.test")).resolves.toBeUndefined();
  });

  test("a failure for any OTHER reason is still an error", async () => {
    const { client: account } = client([{ status: 400, body: { error: { message: "TOO_MANY_ATTEMPTS_TRY_LATER" } } }]);
    await expect(account.requestLoginEmailChange(session, "a@b.test")).rejects.toBeInstanceOf(AccountAuthError);
  });
});

// ---------------------------------------------------------------------------
// R04 — an interrupted body is an UNKNOWN outcome, and an unreadable answer is not a confirmed one
// ---------------------------------------------------------------------------
describe("what an HTTP 200 with a broken or unreadable body means (R04)", () => {
  function bodyResponse(chunks: string[], options: { status?: number; failAfter?: boolean } = {}): Response {
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
          if (options.failAfter) controller.error(new Error("connection reset by peer"));
          else controller.close();
        },
      }),
      { status: options.status ?? 200, headers: { "content-type": "application/json" } },
    );
  }

  test("a 200 whose body breaks off BEFORE the timeout is `network`: the send is not confirmed", async () => {
    // The defect: the reader answered `null`, the timer had not fired, so the body became `{}` and
    // `startEmailSignIn` resolved — a send counted as confirmed by a body nobody read. The broker
    // maps `network` to an UNKNOWN send outcome, which is the truthful one here.
    const account = createAccountClient({
      config: CONFIG,
      now: () => NOW,
      fetchImpl: async () => bodyResponse(['{"email":"owner@exa'], { failAfter: true }),
    });
    await expect(account.startEmailSignIn("owner@example.test", CONTINUE_URL)).rejects.toMatchObject({
      code: "network",
    });
  });

  test("a 200 whose body is not JSON is `malformed-response`, not a session and not a refusal", async () => {
    const account = createAccountClient({
      config: CONFIG,
      now: () => NOW,
      fetchImpl: async () => bodyResponse(["<html>upstream</html>"]),
    });
    await expect(account.completeEmailSignIn("owner@example.test", OOB_CODE)).rejects.toMatchObject({
      code: "malformed-response",
    });
    await expect(account.startEmailSignIn("owner@example.test", CONTINUE_URL)).rejects.toMatchObject({
      code: "malformed-response",
    });
  });

  test("a 200 whose body is too large is `malformed-response` too — verified apart from the broken stream", async () => {
    const account = createAccountClient({
      config: CONFIG,
      now: () => NOW,
      fetchImpl: async () => bodyResponse([`{"pad":"${"p".repeat(64 * 1024)}"}`]),
    });
    await expect(account.completeEmailSignIn("owner@example.test", OOB_CODE)).rejects.toMatchObject({
      code: "malformed-response",
    });
  });

  test("a refusal whose body broke off is still a transport outcome, not an `unknown` refusal", async () => {
    const account = createAccountClient({
      config: CONFIG,
      now: () => NOW,
      fetchImpl: async () => bodyResponse(['{"error":{"message":"INVALID_OOB'], { status: 400, failAfter: true }),
    });
    await expect(account.completeEmailSignIn("owner@example.test", OOB_CODE)).rejects.toMatchObject({
      code: "network",
    });
  });

  test("a refresh whose body broke off is `network`, and the session is left as it was", async () => {
    const account = createAccountClient({
      config: CONFIG,
      now: () => NOW,
      fetchImpl: async () => bodyResponse(['{"id_token":"new'], { failAfter: true }),
    });
    const session: OwnerSession = {
      idToken: "old",
      refreshToken: "r",
      uid: "u",
      email: "owner@example.test",
      emailVerified: true,
      expiresAt: NOW,
      authenticatedAt: NOW,
    };
    await expect(account.refresh(session)).rejects.toMatchObject({ code: "network" });
  });
});
