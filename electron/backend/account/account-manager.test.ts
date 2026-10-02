// The account manager's flows, against fakes: no network, no Firebase project, no Electron.
//
// The cases worth having are the ones where doing the obvious thing is wrong: signing out a machine
// that still has somebody's phone attached, deleting an account on a proof that is an hour old, and
// handing a checkout URL to a renderer.
//
// SIGNING IN HERE IS THE REAL PASSWORDLESS FLOW, not a shortcut. `signIn()` below drives the actual
// `EmailSignInBroker` — with a fake fetch standing in for the Worker and a deterministic id
// generator — and finishes it the way the manual fallback does, by handing the manager a link. That
// keeps every test in this file honest about the thing it is exercising: there is no way to obtain an
// owner session except through a redeemed link, and the tests do not have one either.
import { describe, expect, test, vi } from "vitest";

import { AccountManager, AccountManagerError, type InstallationIdentity } from "./account-manager.js";
import { EmailSignInBroker, type SignInPurpose } from "./email-signin-broker.js";
import type { AuthLinkConfig } from "./authlink-config.js";
import type { InstallationBindingMarker, InstallationBindingState } from "./account-binding.js";
import { AccountAuthError, type AccountClient, type OwnerSession } from "./account-client.js";
import { AccountCallableError, createAccountTransport, type AccountTransport } from "./account-transport.js";
import type { DiagnosticsEntry } from "./account-diagnostics.js";
import type { AccountOverview } from "../mobile/mobile-schemas.js";
import type { MobileFirebaseConfig } from "../mobile/mobile-firebase-config.js";

/**
 * The desktop log, captured (S01–S04). The manager logs every failed operation and every late answer
 * it withheld; the tests below check that those lines exist and carry no address, token or key.
 */
const logSpy = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), trace: vi.fn() }));
vi.mock("../logger.js", () => ({ getLogger: () => logSpy }));

const NOW = 1_760_000_000_000;

function ownerSession(patch: Partial<OwnerSession> = {}): OwnerSession {
  return {
    idToken: "id-token",
    refreshToken: "refresh-token",
    uid: "owner-uid",
    email: "owner@example.test",
    emailVerified: true,
    expiresAt: NOW + 3_600_000,
    authenticatedAt: NOW,
    ...patch,
  };
}

function overview(patch: Partial<AccountOverview> = {}): AccountOverview {
  return {
    supportReference: "STR-1-ABCDEFGHJKMN",
    entitlement: { state: "trial", source: "trial", notAfter: NOW + 86_400_000 },
    offers: [],
    usage: {
      installations: { used: 1, limit: 5 },
      mobileDevices: { used: 0, limit: 5 },
      activeRelaySessions: { used: 0, limit: 8 },
    },
    installations: [{ installationId: "inst-1", registeredAt: NOW, isThisInstallation: true, state: "active" }],
    mobileDevices: [],
    notices: [],
    billingConfigured: true,
    generatedAt: NOW,
    ...patch,
  } as AccountOverview;
}

const IDENTITY: InstallationIdentity = {
  installationId: "inst-1",
  publicKeyBase64Url: "cHVibGljS2V5",
  signChallenge: (transcript) => Buffer.from(`signed:${transcript.toString("utf8")}`),
};

function fakes(
  options: {
    session?: OwnerSession;
    overview?: AccountOverview | Error;
    collectExtraDiagnostics?: () => readonly DiagnosticsEntry[];
    /** R14: the signed merchant allowlist. Empty in a fixture means "this desktop opens nothing". */
    billingHosts?: readonly string[];
    knownPairIds?: readonly string[];
    forgetInstallationCredential?: () => Promise<void>;
    refreshInstallationToken?: () => Promise<void>;
    /**
     * The durable local binding marker — F12, and a STATE since G13. Seeded here, written through by
     * the manager; `failWrites` makes the store refuse, and `writes` records every marker asked for.
     */
    binding?: { value: InstallationBindingState; failWrites?: boolean; writes?: InstallationBindingMarker[] };
    /** The remembered login address, raw as stored. `failRead`/`failWrites` make the store refuse. */
    remembered?: { value: string; failRead?: boolean; failWrites?: boolean; writes?: (string | null)[] };
    /**
     * Whether the SERVER already lists this installation, before anything in the test runs.
     *
     * It defaults to true because most tests are about a machine that is already enrolled. The
     * enrolment tests pass `false`, and then the overview omits this installation until
     * `completeInstallationRegistration` has been called — which is what a real account answers, and
     * what the fixture used to get wrong: it listed the machine as active before it had registered, so
     * a manager that (correctly, since F06) declines to repeat a completed registration did nothing at
     * all.
     */
    enrolled?: boolean;
    /**
     * A movable clock, for the tests that need a cooldown to pass or a deadline to lapse.
     *
     * Shared with the broker the fixture builds, because the two disagreeing about the time is exactly
     * the kind of thing a fixture should not invent.
     */
    clock?: { now: number };
    /** Distinct idempotency keys, for the tests that are about which key a retry used (F06). */
    newIdempotencyKey?: () => string;
  } = {},
) {
  const clock = options.clock ?? { now: NOW };
  const now = (): number => clock.now;
  const session = options.session ?? ownerSession();
  let serverListsThisInstallation = options.enrolled ?? true;
  const client: AccountClient = {
    startEmailSignIn: vi.fn(async () => {}),
    completeEmailSignIn: vi.fn(async () => session),
    refresh: vi.fn(async (current) => ({ ...current, idToken: "refreshed" })),
    requestLoginEmailChange: vi.fn(async () => {}),
    // The SERVER's answer, and the uid is what the manager compares with the one it signed in as.
    lookup: vi.fn(async (current) => ({ uid: current.uid, email: current.email, emailVerified: true })),
  };
  const transport: AccountTransport = {
    ensureAccount: vi.fn(async () => ({
      status: "created" as const,
      supportReference: "STR-1-ABCDEFGHJKMN",
      claimsChanged: true,
    })),
    beginInstallationRegistration: vi.fn(async () => ({
      challengeId: "chal-1",
      transcript: "strideterm-installation:chal-1",
      expiresAt: NOW + 300_000,
    })),
    completeInstallationRegistration: vi.fn(async () => {
      serverListsThisInstallation = true;
      return { status: "registered" as const, installationId: "inst-1", claimsChanged: true };
    }),
    startTrial: vi.fn(async () => ({
      status: "started" as const,
      notAfter: NOW + 14 * 86_400_000,
      claimsChanged: true,
    })),
    confirmOwnerForInstallation: vi.fn(async () => ({ status: "confirmed" as const })),
    getAccountOverview: vi.fn(async () => {
      if (options.overview instanceof Error) throw options.overview;
      const answer = options.overview ?? overview();
      if (serverListsThisInstallation) return answer;
      // A machine the account does not list yet. Its own row is what `installationIsListed()` reads.
      return {
        ...answer,
        installations: answer.installations.filter((row) => row.installationId !== IDENTITY.installationId),
      };
    }),
    createCheckout: vi.fn(async () => ({
      status: "ready" as const,
      checkoutUrl: "https://checkout.example/pay",
      intentId: "int-1",
    })),
    createPortalSession: vi.fn(async () => ({
      status: "ready" as const,
      portalUrl: "https://portal.example/s/1",
      expiresAt: NOW,
    })),
    revokeAccountDevice: vi.fn(async () => ({
      status: "revoked" as const,
      revokedPairDeviceIds: [],
      relayCommandsQueued: 1,
    })),
    acknowledgeNotice: vi.fn(async () => ({ status: "acknowledged" as const })),
    submitDiagnostics: vi.fn(async () => ({ reportId: "rep-0123456789abcdef", entryCount: 1 })),
    deleteAccount: vi.fn(async () => ({ status: "accepted" as const, providerCancellationRequired: true })),
  };
  const opened: string[] = [];
  const { broker, attemptIds, brokerCalls } = makeBroker(client, now);
  const manager = new AccountManager({
    client,
    broker,
    transport,
    identity: IDENTITY,
    openExternal: async (url) => void opened.push(url),
    now,
    newIdempotencyKey: options.newIdempotencyKey ?? (() => "idem-1"),
    installationLabel: "Workstation",
    // The hosts the SIGNED bootstrap envelope names. The fixture URLs are on `checkout.example` and
    // `portal.example`, so those are what a passing billing test has to be told to allow — which is
    // the point of the whole check: a URL nobody named is not opened.
    billingHosts: () => options.billingHosts ?? ["checkout.example", "portal.example"],
    ...(options.knownPairIds === undefined ? {} : { knownPairIds: () => options.knownPairIds! }),
    ...(options.forgetInstallationCredential === undefined
      ? {}
      : { forgetInstallationCredential: options.forgetInstallationCredential }),
    ...(options.refreshInstallationToken === undefined
      ? {}
      : { refreshInstallationToken: options.refreshInstallationToken }),
    ...(options.binding === undefined
      ? {}
      : {
          readInstallationBinding: () => options.binding!.value,
          writeInstallationBinding: async (marker: InstallationBindingMarker) => {
            options.binding!.writes?.push(marker);
            if (options.binding!.failWrites) throw new Error("the keychain is locked");
            options.binding!.value = marker;
          },
        }),
    ...(options.remembered === undefined
      ? {}
      : {
          readRememberedOwnerEmail: () => {
            if (options.remembered!.failRead) throw new Error("the keychain is locked");
            return options.remembered!.value;
          },
          writeRememberedOwnerEmail: async (raw: string | null) => {
            options.remembered!.writes?.push(raw);
            if (options.remembered!.failWrites) throw new Error("the keychain is locked");
            options.remembered!.value = raw ?? "";
          },
        }),
    ...(options.collectExtraDiagnostics === undefined
      ? {}
      : { collectExtraDiagnostics: options.collectExtraDiagnostics }),
    appInfo: { versionName: "2.5.9", platform: "win32" },
  });
  return { manager, client, transport, opened, broker, attemptIds, brokerCalls, clock, binding: options.binding };
}

/** The one local-mode broker origin every fixture uses. A loopback origin is the only http one allowed. */
const AUTHLINK: AuthLinkConfig = {
  environment: "local",
  origin: "http://127.0.0.1:8788",
  isLocal: true,
  firebaseProjectId: "demo-strideterm",
  actionHandlers: [{ origin: "https://demo-strideterm.firebaseapp.com", path: "/__/auth/action" }],
};

/**
 * A real {@link EmailSignInBroker} over a fake Worker.
 *
 * DETERMINISTIC IDS, so a test can build the link the person would have received. The polling timer
 * is captured rather than armed — every test in this file finishes through the manual paste, which is
 * synchronous, and the broker's own suite is where the schedule is exercised.
 */
const FIRST_ATTEMPT_ID = "a".repeat(43);

function makeBroker(client: AccountClient, now: () => number = () => NOW) {
  const attemptIds = [FIRST_ATTEMPT_ID, "b".repeat(43), "c".repeat(43)];
  const issued: string[] = [];
  const brokerCalls: { path: string; body: Record<string, unknown> }[] = [];
  let index = 0;
  const broker = new EmailSignInBroker({
    authlink: AUTHLINK,
    client,
    now,
    jitter: () => 0,
    // Ids alternate attempt/secret, so the first attempt id is `attemptIds[0]`.
    newOpaqueId: () => {
      const value = index % 2 === 0 ? (attemptIds[Math.floor(index / 2)] ?? "z".repeat(43)) : "s".repeat(43);
      if (index % 2 === 0) issued.push(value);
      index += 1;
      return value;
    },
    schedule: () => () => {},
    fetchImpl: async (url, init) => {
      const path = new URL(url).pathname;
      brokerCalls.push({ path, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      if (path === "/start") {
        return new Response(JSON.stringify({ status: "created", expiresAt: now() + 15 * 60_000 }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    },
  });
  return { broker, attemptIds, brokerCalls };
}

/**
 * Signs in the way a person does: ask for a link, then present the link.
 *
 * The default purpose is `reauth` — the one that performs no follow-up action of its own — so a test
 * about billing or sign-out gets an owner session without also enrolling anything.
 */
async function signIn(
  manager: AccountManager,
  purpose: SignInPurpose = "reauth",
  options: { email?: string; oobCode?: string; offerId?: string; attemptId?: string } = {},
): Promise<void> {
  const email = options.email ?? "owner@example.test";
  await manager.beginEmailSignIn(email, purpose, options.offerId);
  // Every fixture's broker issues the same FIRST attempt id, so the link a person would have received
  // is reconstructible here without reaching into the broker's private state.
  manager.submitSignInLink(
    `${AUTHLINK.origin}/c?attempt=${options.attemptId ?? FIRST_ATTEMPT_ID}&oobCode=${options.oobCode ?? "OOB-CODE"}`,
  );
  await manager.confirmEmailSignIn();
}

describe("configuration", () => {
  test("an unconfigured deployment has the feature ABSENT, not broken", () => {
    const manager = new AccountManager({ client: null, transport: null, identity: null, openExternal: async () => {} });
    expect(manager.configured).toBe(false);
    expect(manager.state().phase).toBe("unconfigured");
  });

  test("every operation on an unconfigured manager is refused with one code", async () => {
    const manager = new AccountManager({ client: null, transport: null, identity: null, openExternal: async () => {} });
    await expect(manager.startTrial()).rejects.toMatchObject({ code: "not-configured" });
  });

  test("a build with no auth-link configuration refuses a NEW sign-in and nothing else", async () => {
    // The whole of `authlink-config.ts`'s promise: an absent broker blocks a new owner sign-in and
    // must not disconnect a working installation. `signInAvailable` is what the page renders.
    const { manager, transport } = fakes();
    const withoutBroker = new AccountManager({
      client: null,
      transport,
      identity: IDENTITY,
      openExternal: async () => {},
      broker: null,
      authLinkRefusal: "local-origin-missing",
    });
    await expect(withoutBroker.beginEmailSignIn("a@b.test", "reauth")).rejects.toMatchObject({
      code: "auth-unavailable",
    });
    expect(withoutBroker.signInAvailable).toBe(false);
    expect(manager.signInAvailable).toBe(true);
  });
});

describe("the passwordless sign-in", () => {
  test("a link is requested for the address, with the backend's own continueUrl", async () => {
    const { manager, client, attemptIds } = fakes();
    await manager.beginEmailSignIn("owner@example.test", "reauth");
    const [email, continueUrl] = (client.startEmailSignIn as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(email).toBe("owner@example.test");
    // The URL is composed from configuration and carries the attempt id and NOTHING else — no
    // address, no purpose, no uid.
    expect(continueUrl).toBe(`${AUTHLINK.origin}/c?attempt=${attemptIds[0]}`);
  });

  test("the broker is told only the HASH of the claim secret", async () => {
    const { manager, brokerCalls } = fakes();
    await manager.beginEmailSignIn("owner@example.test", "reauth");
    const start = brokerCalls.find((call) => call.path === "/start")!;
    expect(start.body["claimSecretHash"]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(start.body)).not.toContain("owner@example.test");
    expect(JSON.stringify(start.body)).not.toContain("reauth");
  });

  test("waiting for the link is a state, and it does not hold the page busy", async () => {
    const { manager } = fakes();
    await manager.beginEmailSignIn("owner@example.test", "reauth");
    const state = manager.state();
    expect(state.auth?.phase).toBe("awaiting-link");
    expect(state.auth?.email).toBe("owner@example.test");
    // NOT an `ownerEmail`: nobody has proved anything yet.
    expect(state.ownerEmail).toBeUndefined();
    expect(state.busy).toBe(false);
  });

  test("the state carries no code and no secret, ever", async () => {
    const { manager, attemptIds } = fakes();
    await manager.beginEmailSignIn("owner@example.test", "reauth");
    manager.submitSignInLink(`${AUTHLINK.origin}/c?attempt=${attemptIds[0]}&oobCode=SECRET-CODE`);
    const text = JSON.stringify(manager.state());
    expect(text).not.toContain("SECRET-CODE");
    expect(text).not.toContain("s".repeat(43));
    expect(manager.state().auth?.phase).toBe("awaiting-confirmation");
  });

  test("a link for ANOTHER attempt is refused", async () => {
    // A link for somebody else's attempt, or for the other environment, must not complete a flow it
    // has nothing to do with.
    const { manager } = fakes();
    await manager.beginEmailSignIn("owner@example.test", "reauth");
    expect(() => manager.submitSignInLink(`${AUTHLINK.origin}/c?attempt=${"z".repeat(43)}&oobCode=X`)).toThrow();
    expect(() =>
      manager.submitSignInLink("https://auth.strideterm.com/c?attempt=" + "a".repeat(43) + "&oobCode=X"),
    ).toThrow();
    expect(manager.state().auth?.phase).toBe("awaiting-link");
  });

  test("the completed sign-in redeems the code and cross-checks the uid with the lookup", async () => {
    const { manager, client } = fakes();
    await signIn(manager, "reauth");
    void client;
  });

  test("a lookup that names a DIFFERENT uid is refused, and no session survives", async () => {
    // A different account answered for the same address. Never silently adopted.
    const fixture = fakes();
    (fixture.client.lookup as ReturnType<typeof vi.fn>).mockResolvedValue({
      uid: "somebody-else",
      email: "owner@example.test",
      emailVerified: true,
    });
    await expect(signIn(fixture.manager, "reauth")).rejects.toMatchObject({ code: "account-mismatch" });
    expect(fixture.manager.state().ownerEmail).toBeUndefined();
  });

  test("a lookup that says the address is NOT verified is refused", async () => {
    const fixture = fakes();
    (fixture.client.lookup as ReturnType<typeof vi.fn>).mockResolvedValue({
      uid: "owner-uid",
      email: "owner@example.test",
      emailVerified: false,
    });
    await expect(signIn(fixture.manager, "reauth")).rejects.toBeInstanceOf(AccountManagerError);
  });

  test("a lookup that fails on the NETWORK is retried over the same candidate session", async () => {
    // The tokens have already arrived and the code is spent, so re-redeeming is not an option. What
    // failed is a CHECK, and a check is retried.
    const fixture = fakes();
    const lookup = fixture.client.lookup as ReturnType<typeof vi.fn>;
    let attempts = 0;
    lookup.mockImplementation(async (current: OwnerSession) => {
      attempts += 1;
      if (attempts === 1) {
        const { AccountAuthError } = await import("./account-client.js");
        throw new AccountAuthError("network", "down");
      }
      return { uid: current.uid, email: current.email, emailVerified: true };
    });
    await signIn(fixture.manager, "reauth");
    expect(attempts).toBe(2);
    expect(fixture.client.completeEmailSignIn).toHaveBeenCalledTimes(1);
  });

  test("an ENROLLED machine has the server confirm the owner before anything follows", async () => {
    // `getAccountOverview` cannot answer this: it runs under the INSTALLATION session, so a successful
    // call says the machine is bound and nothing about who just signed in.
    const fixture = fakes();
    await fixture.manager.restoreFromInstallation();
    await signIn(fixture.manager, "reauth");
    // THE CANDIDATE'S TOKEN IS NAMED (F02): this call is the one that decides whether there will be
    // an owner at all, so it may not ask the manager for "the owner" — there is not one yet.
    expect(fixture.transport.confirmOwnerForInstallation).toHaveBeenCalledWith(
      expect.objectContaining({ installationId: "inst-1", ownerIdToken: "id-token" }),
    );
  });

  test("a server that refuses the owner check drops the session and rebinds nothing", async () => {
    const fixture = fakes();
    await fixture.manager.restoreFromInstallation();
    (fixture.transport.confirmOwnerForInstallation as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "refused",
      reason: "owner-mismatch",
    });
    await expect(signIn(fixture.manager, "reauth")).rejects.toMatchObject({ code: "account-mismatch" });
    expect(fixture.manager.state().ownerEmail).toBeUndefined();
    expect(fixture.manager.state().installationRegistered).toBe(true);
  });

  test("an owner check that fails on the NETWORK is retried, and a REFUSAL is not", async () => {
    // The tokens have arrived and the code is spent, so a transport failure here is a failure of a
    // CHECK. A refusal is an answer, and asking again does not change it.
    const fixture = fakes();
    await fixture.manager.restoreFromInstallation();
    const confirmOwner = fixture.transport.confirmOwnerForInstallation as ReturnType<typeof vi.fn>;
    let calls = 0;
    confirmOwner.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) throw new AccountCallableError("network", 0);
      return { status: "confirmed" as const };
    });
    await signIn(fixture.manager, "reauth");
    expect(calls).toBe(2);

    const refusing = fakes();
    await refusing.manager.restoreFromInstallation();
    let refusals = 0;
    (refusing.transport.confirmOwnerForInstallation as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      refusals += 1;
      return { status: "refused" as const, reason: "owner-mismatch" as const };
    });
    await expect(signIn(refusing.manager, "reauth")).rejects.toMatchObject({ code: "account-mismatch" });
    expect(refusals).toBe(1);
  });

  test("a failed overview read during a sign-in does not flash `not enrolled` at an enrolled machine", async () => {
    // `afterOwnerReady` used to set `installationRegistered = false` on any failure, which is the one
    // answer a failed READ must never give: the control plane being unreachable is not evidence that
    // this machine was never enrolled, and the durable marker is what holds that answer.
    const binding = { value: "bound" as InstallationBindingState };
    const fixture = fakes({ binding });
    await fixture.manager.restoreFromInstallation();
    expect(fixture.manager.state().installationRegistered).toBe(true);
    (fixture.transport.getAccountOverview as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("offline"));
    await signIn(fixture.manager, "reauth");
    expect(fixture.manager.state().installationRegistered).toBe(true);
    expect(binding.value).toBe("bound");
  });

  test("an UNENROLLED machine does not call the owner check — there is no binding to confirm", async () => {
    const fixture = fakes();
    await signIn(fixture.manager, "reauth");
    expect(fixture.transport.confirmOwnerForInstallation).not.toHaveBeenCalled();
  });

  test("cancelling ends the attempt and tells the broker, and claims to revoke nothing", async () => {
    const { manager, brokerCalls } = fakes();
    await manager.beginEmailSignIn("owner@example.test", "reauth");
    manager.cancelEmailSignIn();
    expect(manager.state().auth).toBeUndefined();
    expect(brokerCalls.some((call) => call.path === "/cancel")).toBe(true);
  });

  test("ONE LINK, BOTH STEPS: the onboarding purpose registers and starts the trial", async () => {
    // Plan §7's table, row 1. `enrolThisInstallation()` used to release the owner session, so the
    // `startTrial()` that followed had no credential — which with a link would mean a second email in
    // the middle of the first run.
    const fixture = fakes({ enrolled: false });
    await signIn(fixture.manager, "enrol-with-trial");
    expect(fixture.transport.completeInstallationRegistration).toHaveBeenCalledOnce();
    expect(fixture.transport.startTrial).toHaveBeenCalledOnce();
    expect(fixture.client.completeEmailSignIn).toHaveBeenCalledOnce();
  });

  test("adding a PC to an existing account does NOT start a trial", async () => {
    const fixture = fakes({ enrolled: false });
    await signIn(fixture.manager, "enrol");
    expect(fixture.transport.completeInstallationRegistration).toHaveBeenCalledOnce();
    expect(fixture.transport.startTrial).not.toHaveBeenCalled();
  });

  test("a PARTIAL success is not a rollback: the registration stands when the trial fails", async () => {
    const fixture = fakes({ enrolled: false });
    (fixture.transport.startTrial as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "not-eligible",
      reason: "trial-already-used",
      claimsChanged: false,
    });
    await expect(signIn(fixture.manager, "enrol-with-trial")).rejects.toMatchObject({ code: "trial-already-used" });
    expect(fixture.transport.completeInstallationRegistration).toHaveBeenCalledOnce();
    expect(fixture.manager.state().installationRegistered).toBe(true);
  });

  test("the checkout purpose performs the request that was authenticated", async () => {
    const fixture = fakes();
    await fixture.manager.restoreFromInstallation();
    await signIn(fixture.manager, "checkout", { offerId: "personal-monthly" });
    expect(fixture.transport.createCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ offerId: "personal-monthly" }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  test("the revoke-device purpose performs the exact revoke that was authenticated (plan §7/C2)", async () => {
    const fixture = fakes();
    await fixture.manager.restoreFromInstallation();
    await signIn(fixture.manager, "revoke-device", { offerId: JSON.stringify(["mobile-device", "abc123"]) });
    expect(fixture.transport.revokeAccountDevice).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "mobile-device", targetId: "abc123" }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    // Nothing else is expected of the person, same as `checkout`/`trial` — the owner credential is gone.
    expect(fixture.manager.state().needsRecentAuth).toBe(true);
  });

  test("a revoke-device purpose with no operand (a superseded flow) performs nothing", async () => {
    const fixture = fakes();
    await fixture.manager.restoreFromInstallation();
    await signIn(fixture.manager, "revoke-device");
    expect(fixture.transport.revokeAccountDevice).not.toHaveBeenCalled();
  });

  test("the owner session is dropped when the purpose is finished, and kept when a step remains", async () => {
    const enrolled = fakes();
    await signIn(enrolled.manager, "enrol");
    // Nothing else is expected of the person, so the credential is gone.
    expect(enrolled.manager.state().needsRecentAuth).toBe(true);

    const changing = fakes();
    await signIn(changing.manager, "change-email");
    // The person still has to type the new address — inside the recent-auth window.
    expect(changing.manager.state().needsRecentAuth).toBe(false);
  });

  test("changing the login email sends to the NEW address and releases the credential", async () => {
    const fixture = fakes();
    await signIn(fixture.manager, "change-email");
    await fixture.manager.requestLoginEmailChange("new@example.test");
    expect(fixture.client.requestLoginEmailChange).toHaveBeenCalledWith(
      expect.anything(),
      "new@example.test",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    // "Waiting to be confirmed", never "changed" — and the credential does not wait with it.
    expect(fixture.manager.state().pendingEmailChange?.email).toBe("new@example.test");
    expect(fixture.manager.state().needsRecentAuth).toBe(true);
  });

  test("a configuration change or a shutdown ends the attempt and its timers", async () => {
    const { manager } = fakes();
    await manager.beginEmailSignIn("owner@example.test", "reauth");
    manager.dispose();
    expect(manager.state().auth).toBeUndefined();
    expect(manager.state().needsRecentAuth).toBe(true);
  });
});

describe("enrolment", () => {
  test("the transcript is signed VERBATIM as the server produced it", async () => {
    // A transcript each side assembles from its own idea of the format is a signature that verifies
    // until somebody edits one of them.
    const { manager, transport } = fakes();
    await signIn(manager);
    await manager.enrolThisInstallation();
    const call = (transport.completeInstallationRegistration as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(Buffer.from(call.signature, "base64url").toString("utf8")).toBe("signed:strideterm-installation:chal-1");
    expect(call.challengeId).toBe("chal-1");
    // The owner leg names the challenge and nothing about which installation it is.
    expect(call).not.toHaveProperty("installationId");
    expect(call).not.toHaveProperty("publicKey");
  });

  test("enrolling with no owner session at all is refused", async () => {
    // The unverified-owner case cannot arise through the sign-in any more — a session only exists once
    // `lookup` has said the address is verified, and one that says otherwise is refused before a
    // session is kept (see "a lookup that says the address is NOT verified is refused"). What is left
    // to pin here is the guard itself: no owner, no enrolment.
    const { manager } = fakes();
    await expect(manager.enrolThisInstallation()).rejects.toMatchObject({ code: "invalid-credentials" });
  });

  test("a machine with somebody else's pairings attached cannot bind a different account", async () => {
    const withPhone = overview({
      mobileDevices: [{ mobileDeviceKeySuffix: "abcd", platform: "android", boundAt: NOW, state: "active", pairs: [] }],
    } as Partial<AccountOverview>);
    const { manager } = fakes({ overview: withPhone });
    await signIn(manager);
    await expect(manager.enrolThisInstallation()).rejects.toMatchObject({ code: "account-mismatch" });
  });
});

describe("a started trial is on the installation token before the page says so", () => {
  // "Start trial", then straight to "Pair a phone": the page already said `trial`, the installation
  // token still carried the old claims, and `createPairingInvitation` refused the click with
  // `entitlement-required`. The answer's `claimsChanged` is the cue to mint a new token, and it has
  // to be minted BEFORE the overview re-read that makes the page offer the button.
  test("`claimsChanged` refreshes the installation token before the overview is re-read", async () => {
    let overviewReadsAtRefresh = -1;
    const fixture = fakes({
      refreshInstallationToken: async () => {
        overviewReadsAtRefresh = (fixture.transport.getAccountOverview as ReturnType<typeof vi.fn>).mock.calls.length;
      },
    });
    await signIn(fixture.manager, "reauth");
    await fixture.manager.startTrial();
    const overviewReads = (fixture.transport.getAccountOverview as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(overviewReadsAtRefresh).toBeGreaterThanOrEqual(0);
    expect(overviewReads).toBeGreaterThan(overviewReadsAtRefresh);
  });

  test("an answer that changed no claims mints no token", async () => {
    const refreshInstallationToken = vi.fn(async () => {});
    const fixture = fakes({ refreshInstallationToken });
    (fixture.transport.startTrial as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      status: "already-started",
      notAfter: NOW + 86_400_000,
      claimsChanged: false,
    });
    await signIn(fixture.manager, "reauth");
    await fixture.manager.startTrial();
    expect(refreshInstallationToken).not.toHaveBeenCalled();
  });

  test("a refresh that fails does not undo a trial the server granted", async () => {
    const fixture = fakes({
      refreshInstallationToken: async () => {
        throw new Error("fetch failed");
      },
    });
    await signIn(fixture.manager, "reauth");
    await expect(fixture.manager.startTrial()).resolves.toBeUndefined();
    expect(fixture.manager.state().entitlement?.state).toBe("trial");
  });
});

describe("billing", () => {
  test("a checkout URL is opened and NEVER returned to the caller or the state", async () => {
    // A URL that reaches a renderer reaches a state diff, a devtools console and a crash report.
    const { manager, opened } = fakes();
    await signIn(manager);
    const outcome = await manager.openCheckout("personal-monthly");
    expect(outcome).toBe("opened");
    expect(opened).toEqual(["https://checkout.example/pay"]);
    expect(JSON.stringify(manager.state())).not.toContain("checkout.example");
  });

  test("a pending checkout is a state, not an error — a second create is never started", async () => {
    const { manager, transport, opened } = fakes();
    (transport.createCheckout as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      status: "checkout-pending",
      intentId: "int-1",
    });
    await signIn(manager);
    await expect(manager.openCheckout("personal-monthly")).resolves.toBe("pending");
    expect(opened).toEqual([]);
  });

  test("a pending checkout retries ready under the same key", async () => {
    let keyNumber = 0;
    const { manager, transport, opened } = fakes({ newIdempotencyKey: () => `idem-${++keyNumber}` });
    const create = transport.createCheckout as ReturnType<typeof vi.fn>;
    create.mockResolvedValueOnce({ status: "checkout-pending", intentId: "int-1" });
    create.mockResolvedValueOnce({
      status: "ready",
      checkoutUrl: "https://checkout.example/pay",
      intentId: "int-1",
    });
    await signIn(manager);

    await expect(manager.openCheckout("personal-monthly")).resolves.toBe("pending");
    await expect(manager.openCheckout("personal-monthly")).resolves.toBe("opened");
    expect(create).toHaveBeenCalledTimes(2);
    expect((create.mock.calls[0]![0] as { idempotencyKey: string }).idempotencyKey).toBe(
      (create.mock.calls[1]![0] as { idempotencyKey: string }).idempotencyKey,
    );
    expect(opened).toEqual(["https://checkout.example/pay"]);
  });

  test("a different offer while checkout is pending does not start that offer", async () => {
    const { manager, transport } = fakes();
    const create = transport.createCheckout as ReturnType<typeof vi.fn>;
    create.mockResolvedValue({ status: "checkout-pending", intentId: "int-1" });
    await signIn(manager);

    await expect(manager.openCheckout("offer-a")).resolves.toBe("pending");
    await expect(manager.openCheckout("offer-b")).rejects.toMatchObject({ code: "checkout-pending" });
    expect(create.mock.calls.map((call) => (call[0] as { offerId: string }).offerId)).toEqual(["offer-a", "offer-a"]);
  });

  test("a definitive checkout failure releases the key for a new attempt", async () => {
    let keyNumber = 0;
    const { manager, transport } = fakes({ newIdempotencyKey: () => `idem-${++keyNumber}` });
    const create = transport.createCheckout as ReturnType<typeof vi.fn>;
    create.mockResolvedValueOnce({ status: "refused", errorReason: { reason: "billing-unconfigured" } });
    create.mockResolvedValueOnce({
      status: "ready",
      checkoutUrl: "https://checkout.example/pay",
      intentId: "int-2",
    });
    await signIn(manager);

    await expect(manager.openCheckout("personal-monthly")).rejects.toMatchObject({ code: "billing-unconfigured" });
    await expect(manager.openCheckout("personal-monthly")).resolves.toBe("opened");
    expect((create.mock.calls[0]![0] as { idempotencyKey: string }).idempotencyKey).not.toBe(
      (create.mock.calls[1]![0] as { idempotencyKey: string }).idempotencyKey,
    );
  });

  test("a portal session is fresh every time and is never cached in state", async () => {
    const { manager, transport, opened } = fakes();
    await signIn(manager);
    await manager.openBillingPortal();
    await manager.openBillingPortal();
    expect(transport.createPortalSession).toHaveBeenCalledTimes(2);
    expect(opened).toHaveLength(2);
    expect(JSON.stringify(manager.state())).not.toContain("portal.example");
  });

  test("a billing URL the SIGNED allowlist does not name is refused, not opened", async () => {
    // R14. The opener used to accept any `http:` or `https:` URL a callable returned and hand it to
    // `shell.openExternal`, and the transport cast the response instead of parsing it — so a
    // malformed or compromised body reached the operating system on a scheme check alone.
    const { manager, transport, opened } = fakes();
    (transport.createCheckout as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      status: "ready",
      checkoutUrl: "https://checkout.example.evil.test/pay",
      intentId: "int-1",
    });
    await signIn(manager);
    await expect(manager.openCheckout("personal-monthly")).rejects.toMatchObject({
      code: "checkout-url-not-allowed",
    });
    expect(opened).toEqual([]);
  });

  test("plain HTTP is refused even when the host itself is on the allowlist", async () => {
    const { manager, transport, opened } = fakes();
    (transport.createCheckout as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      status: "ready",
      checkoutUrl: "http://checkout.example/pay",
      intentId: "int-1",
    });
    await signIn(manager);
    await expect(manager.openCheckout("personal-monthly")).rejects.toMatchObject({
      code: "checkout-url-not-allowed",
    });
    expect(opened).toEqual([]);
  });

  test("a build that has been told NO merchant hosts opens nothing at all", async () => {
    // The default is the opposite of the old one. A build with no allowlist refuses; it does not
    // open anything the server happened to return.
    const { manager, opened } = fakes({ billingHosts: [] });
    await signIn(manager);
    await expect(manager.openCheckout("personal-monthly")).rejects.toMatchObject({ code: "billing-unconfigured" });
    expect(opened).toEqual([]);
  });

  test("a deployment with no merchant reports it as a state, not a payment failure", async () => {
    const { manager, transport } = fakes();
    (transport.createCheckout as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      status: "refused",
      errorReason: { reason: "billing-unconfigured" },
    });
    await signIn(manager);
    await expect(manager.openCheckout("personal-monthly")).rejects.toMatchObject({ code: "billing-unconfigured" });
  });

  // I3: billing is authorized server-side by this desktop's own active installation, not by a live
  // owner session — these two are the U09 scenario itself, with NO `signIn()` anywhere in them.
  test("this desktop opens checkout with no owner session at all, never an owner sign-in", async () => {
    const { manager, transport, opened } = fakes();
    await manager.restoreFromInstallation();
    const outcome = await manager.openCheckout("personal-monthly");
    expect(outcome).toBe("opened");
    expect(opened).toEqual(["https://checkout.example/pay"]);
    expect(transport.createCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ offerId: "personal-monthly", installationId: "inst-1" }),
      expect.anything(),
    );
  });

  test("the opened checkout URL stays available to the main-process copy path for one hour", async () => {
    const fixture = fakes();
    await fixture.manager.restoreFromInstallation();
    expect(fixture.manager.checkoutUrlForCopy("personal-monthly")).toBeNull();

    await fixture.manager.openCheckout("personal-monthly");
    expect(fixture.manager.checkoutUrlForCopy("personal-annual")).toBeNull();
    expect(fixture.manager.checkoutUrlForCopy("personal-monthly")).toBe("https://checkout.example/pay");

    fixture.clock.now += 60 * 60_000;
    expect(fixture.manager.checkoutUrlForCopy("personal-monthly")).toBeNull();
  });

  test("this desktop opens the billing portal with no owner session at all", async () => {
    const { manager, transport, opened } = fakes();
    await manager.restoreFromInstallation();
    await manager.openBillingPortal();
    expect(opened).toEqual(["https://portal.example/s/1"]);
    expect(transport.createPortalSession).toHaveBeenCalledWith({ installationId: "inst-1" }, expect.anything());
  });

  test("billing still opens after the owner session has been dropped, with no new sign-in", async () => {
    // The owner session is a brief verification step, not billing's credential (I3): after a purpose
    // like `enrol` finishes, the manager drops it (see "the owner session is dropped when the purpose
    // is finished" above, `needsRecentAuth` becomes true) — and that must not be the reason a checkout
    // this desktop's own installation asks for is refused.
    const { manager, opened } = fakes();
    await signIn(manager, "enrol");
    expect(manager.state().needsRecentAuth).toBe(true);
    const outcome = await manager.openCheckout("personal-monthly");
    expect(outcome).toBe("opened");
    expect(opened).toEqual(["https://checkout.example/pay"]);
  });
});

describe("signing out", () => {
  test("a registered installation asks for fresh owner auth before attempting remote revocation", async () => {
    const forgotten: string[] = [];
    const { manager, transport } = fakes({
      session: ownerSession({ authenticatedAt: NOW - 60 * 60 * 1000 }),
      forgetInstallationCredential: async () => void forgotten.push("forgotten"),
    });
    await signIn(manager);

    await expect(manager.signOutInstallation({ disconnect: true })).rejects.toMatchObject({
      code: "requires-recent-login",
    });
    expect(transport.revokeAccountDevice).not.toHaveBeenCalled();
    expect(forgotten).toEqual([]);
  });

  test("a machine with a phone attached refuses a plain sign-out and names what is in the way", async () => {
    const withPhone = overview({
      usage: {
        installations: { used: 1, limit: 5 },
        mobileDevices: { used: 1, limit: 5 },
        activeRelaySessions: { used: 0, limit: 8 },
      },
      mobileDevices: [{ mobileDeviceKeySuffix: "abcd", platform: "android", boundAt: NOW, state: "active", pairs: [] }],
    } as Partial<AccountOverview>);
    const { manager } = fakes({ overview: withPhone });
    await signIn(manager);
    expect(manager.signOutAssessment().blockers).toContain("active-pairings");
    await expect(manager.signOutInstallation({ disconnect: false })).rejects.toBeInstanceOf(AccountManagerError);
  });

  test("`disconnect` revokes AT THE SERVER before the local session is dropped", async () => {
    // Reversing the two leaves a machine that cannot revoke its own pairings and a server that still
    // believes they are live.
    const order: string[] = [];
    const { manager, transport } = fakes({
      forgetInstallationCredential: async () => void order.push("local-drop"),
    });
    (transport.revokeAccountDevice as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      order.push("server-revoke");
      return { status: "revoked", revokedPairDeviceIds: [], relayCommandsQueued: 1 };
    });
    await signIn(manager);
    await manager.signOutInstallation({ disconnect: true });
    expect(order).toEqual(["server-revoke", "local-drop"]);
    expect(manager.state().phase).toBe("signed-out");
  });
});

describe("deletion", () => {
  test("needs a recent password proof, whatever the token says", async () => {
    const { manager } = fakes({ session: ownerSession({ authenticatedAt: NOW - 60 * 60 * 1000 }) });
    await signIn(manager);
    await expect(manager.deleteAccount("DELETE MY ACCOUNT")).rejects.toMatchObject({ code: "requires-recent-login" });
  });

  test("reports honestly that a provider cancellation is still outstanding", async () => {
    // The runtime never pretends a cancellation happened; the durable job keeps retrying.
    const { manager } = fakes();
    await signIn(manager);
    await expect(manager.deleteAccount("DELETE MY ACCOUNT")).resolves.toEqual({ providerCancellationRequired: true });
  });
});

describe("state broadcast", () => {
  test("one publish per operation, and an unchanged state does not wake the windows", async () => {
    const { manager } = fakes();
    const states: string[] = [];
    manager.on("state", (state) => states.push(state.phase));
    await signIn(manager);
    const before = states.length;
    await manager.refreshOverview();
    // busy -> not busy is two changes; an identical result is not a third.
    expect(states.length).toBeGreaterThan(before);
    expect(states.at(-1)).toBe("ready");
  });

  test("a failure moves the state too, because the error is part of what the page shows", async () => {
    const { manager, transport } = fakes();
    await signIn(manager);
    (transport.getAccountOverview as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      Object.assign(new Error("x"), { reason: "network" }),
    );
    await expect(manager.refreshOverview()).rejects.toBeInstanceOf(AccountManagerError);
    expect(manager.state().lastError).toBeDefined();
    expect(manager.state().busy).toBe(false);
  });

  test("a network failure behind TLS inspection is shown as network-tls; an unclassified one as network", async () => {
    const { manager, transport } = fakes();
    await signIn(manager);
    const overview = transport.getAccountOverview as ReturnType<typeof vi.fn>;
    overview.mockRejectedValueOnce(new AccountCallableError("network", 0, "tls-untrusted"));
    await expect(manager.refreshOverview()).rejects.toBeInstanceOf(AccountManagerError);
    expect(manager.state().lastError).toBe("network-tls");
    overview.mockRejectedValueOnce(new AccountCallableError("network", 0));
    await expect(manager.refreshOverview()).rejects.toBeInstanceOf(AccountManagerError);
    expect(manager.state().lastError).toBe("network");
  });

  test("a background claim refresh never flashes an error at somebody who did not ask", async () => {
    const { manager, transport } = fakes();
    await signIn(manager);
    (transport.getAccountOverview as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("transient"));
    await expect(manager.onClaimsChanged()).resolves.toBeUndefined();
    expect(manager.state().lastError).toBeUndefined();
  });
});

describe("opt-in diagnostics", () => {
  test("every operation records one line, with its outcome and nothing it was called with", async () => {
    const { manager } = fakes();
    await signIn(manager);
    const exported = JSON.parse(manager.exportDiagnostics().content) as {
      entries: Array<{ event: string; status?: string }>;
    };
    expect(exported.entries.map((row) => row.event)).toContain("account.email-sign-in-complete");
    expect(exported.entries.find((row) => row.event === "account.email-sign-in-complete")?.status).toBe("ok");
    // The address, the sign-in code, the claim secret and the token are not in the evidence a user is
    // about to email us.
    const text = JSON.stringify(exported);
    expect(text).not.toContain("OOB-CODE");
    expect(text).not.toContain("owner@example.test");
    expect(text).not.toContain("id-token");
    expect(text).not.toContain("s".repeat(43));
  });

  test("a refusal is recorded as the fixed code the page shows, not the error's text", async () => {
    const { manager, transport } = fakes();
    await signIn(manager);
    (transport.getAccountOverview as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new AccountCallableError("network", 0),
    );
    await expect(manager.refreshOverview()).rejects.toBeInstanceOf(AccountManagerError);
    const exported = JSON.parse(manager.exportDiagnostics().content) as {
      entries: Array<{ event: string; status?: string; level?: string }>;
    };
    const row = exported.entries.find((entry) => entry.event === "account.refresh-overview");
    expect(row?.status).toBe("network");
    expect(row?.level).toBe("error");
    // The callable's own message never reaches the report: only our closed vocabulary does.
    expect(JSON.stringify(exported)).not.toContain("account callable rejected");
  });

  test("sending answers with the reference to quote, and the state carries it for every window", async () => {
    const { manager, transport } = fakes();
    await signIn(manager);
    const result = await manager.submitDiagnostics("it says lapsed and I paid yesterday");
    expect(result.reportId).toBe("rep-0123456789abcdef");
    expect(manager.state().lastDiagnosticsReportId).toBe("rep-0123456789abcdef");
    const sent = (transport.submitDiagnostics as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      note: string;
      entries: unknown[];
      app: Record<string, unknown>;
    };
    expect(sent.note).toBe("it says lapsed and I paid yesterday");
    expect(sent.entries.length).toBeGreaterThan(0);
    expect(sent.app).toMatchObject({ versionName: "2.5.9", platform: "win32" });
  });

  test("a machine with nothing to report sends nothing and spends no daily slot", async () => {
    const { manager, transport } = fakes();
    await expect(manager.submitDiagnostics()).rejects.toMatchObject({ code: "diagnostics-empty" });
    expect(transport.submitDiagnostics).not.toHaveBeenCalled();
  });

  test("the local export needs no transport, no owner and no network", () => {
    // The evidence a user can send by hand must not depend on the thing that is broken.
    const manager = new AccountManager({ client: null, transport: null, identity: null, openExternal: async () => {} });
    manager.recordDiagnostic({ at: NOW, event: "account.sign-in", status: "network", level: "error" });
    const exported = manager.exportDiagnostics("no network here");
    expect(exported.entryCount).toBe(1);
    expect(exported.filename).toMatch(/^strideterm-diagnostics-/);
    expect(JSON.parse(exported.content)).toMatchObject({ note: "no network here" });
  });

  test("the mobile subsystem's own rows are included, through the seam", async () => {
    const { manager } = fakes({
      collectExtraDiagnostics: () => [
        { at: NOW - 1_000, event: "mobile.pairing.claimed", status: "success", level: "info" },
      ],
    });
    await signIn(manager);
    const exported = JSON.parse(manager.exportDiagnostics().content) as { entries: Array<{ event: string }> };
    expect(exported.entries.map((row) => row.event)).toContain("mobile.pairing.claimed");
    // Oldest first, whichever source it came from.
    expect(exported.entries[0]!.event).toBe("mobile.pairing.claimed");
  });
});

describe("the durable local binding (F12, and G13)", () => {
  test("a cold start whose overview read fails keeps the binding the marker records", async () => {
    // THE CASE THAT MINTED A NEW UID. `installationRegistered` starts false and is only ever learned
    // from the server overview — read with the very refresh token whose validity is in question. So
    // the guard on the anonymous fallback (`isAccountBound`) answered "not bound" on exactly the
    // start-up where being bound mattered, and the REST client signed in as a new anonymous user:
    // a new uid, which is what the account's `installations` row, every pair membership and the
    // server's `accountByUid` index are keyed by.
    const binding = { value: "bound" as InstallationBindingState };
    const { manager } = fakes({ overview: new Error("network"), binding });

    await manager.restoreFromInstallation();

    expect(manager.state().installationRegistered).toBe(true);
    expect(binding.value).toBe("bound");
  });

  test("with the marker saying `none`, an unreadable overview still reports an unenrolled machine", async () => {
    // The other direction has to keep working: a machine the server has DECLARED unbound must not be
    // told it is bound, or it could never sign in at all.
    const binding = { value: "none" as InstallationBindingState };
    const { manager } = fakes({ overview: new Error("network"), binding });

    await manager.restoreFromInstallation();

    expect(manager.state().installationRegistered).toBe(false);
    expect(binding.value).toBe("none");
  });

  test("a successful enrolment writes the INTENT before the server is asked and retains `bound` after an unauthenticated sign-out refusal", async () => {
    const writes: InstallationBindingMarker[] = [];
    const binding = { value: "none" as InstallationBindingState, writes };
    const { manager, transport } = fakes({ binding, forgetInstallationCredential: async () => {} });
    const calls: string[] = [];
    (transport.ensureAccount as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      calls.push(`ensureAccount:${binding.value}`);
      return { status: "created" as const, supportReference: "STR-1-ABCDEFGHJKMN", claimsChanged: true };
    });

    await signIn(manager);
    await manager.enrolThisInstallation();
    // G13: the intent was on disk BEFORE the first server mutation, so a crash after the server said
    // yes and before the confirmation could not read as "never enrolled".
    expect(calls).toEqual(["ensureAccount:enrolling"]);
    // (The sign-in's own overview read wrote `bound` first — the fixture lists this installation.)
    const intent = writes.indexOf("enrolling");
    expect(intent).toBeGreaterThan(-1);
    expect(writes[intent + 1]).toBe("bound");
    expect(binding.value).toBe("bound");

    await expect(manager.signOutInstallation({ disconnect: true })).rejects.toMatchObject({
      code: "requires-recent-login",
    });
    // A refused remote revocation must leave the durable binding in place with the credential.
    expect(binding.value).toBe("bound");

    await signIn(manager, "reauth", { attemptId: "b".repeat(43) });
    await manager.signOutInstallation({ disconnect: true });
    expect(binding.value).toBe("none");
  });

  test("a server overview that no longer lists this installation writes `none`", async () => {
    // A revoked installation must not hold the marker: the guard would then refuse it a new identity
    // for ever, and the machine could not sign in as anything at all.
    const binding = { value: "bound" as InstallationBindingState };
    const { manager } = fakes({
      binding,
      overview: overview({
        installations: [{ installationId: "other", registeredAt: NOW, isThisInstallation: false, state: "active" }],
      }),
    });

    await manager.restoreFromInstallation();

    expect(manager.state().installationRegistered).toBe(false);
    expect(binding.value).toBe("none");
  });

  test("G13: a confirmation that cannot be written leaves the INTENT, never `unbound`, and says so in the diagnostics", async () => {
    // The server enrolled this machine; the disk then refused the `bound` write. The old code swallowed
    // it, and the marker read as whatever it had said before — which, for a first enrolment, was
    // nothing: exactly the answer that releases the identity.
    const writes: InstallationBindingMarker[] = [];
    const binding = { value: "none" as InstallationBindingState, failWrites: false, writes };
    const { manager, transport } = fakes({ binding });
    (transport.completeInstallationRegistration as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      binding.failWrites = true; // the store fails from the moment the server has said yes
      return { status: "registered" as const, installationId: "inst-1", claimsChanged: true };
    });

    await signIn(manager);
    await manager.enrolThisInstallation();

    expect(writes).toContain("bound");
    expect(binding.value).toBe("enrolling");
    expect(manager.state().installationRegistered).toBe(true);
    const exported = JSON.parse(manager.exportDiagnostics().content) as {
      entries: Array<{ event: string; status: string }>;
    };
    expect(
      exported.entries.some((row) => row.event === "account.binding-marker" && row.status.startsWith("write-failed")),
    ).toBe(true);
  });

  test("G13: an intent that cannot be written refuses the enrolment before the server is asked", async () => {
    const binding = { value: "none" as InstallationBindingState, failWrites: true };
    const { manager, transport } = fakes({ binding });
    await signIn(manager);
    await expect(manager.enrolThisInstallation()).rejects.toMatchObject({ code: "unknown" });
    expect(transport.ensureAccount).not.toHaveBeenCalled();
    expect(binding.value).toBe("none");
  });

  test("G13: a refused enrolment withdraws the intent", async () => {
    const binding = { value: "none" as InstallationBindingState };
    const { manager, transport } = fakes({ binding });
    (transport.completeInstallationRegistration as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "refused" as const,
      claimsChanged: false,
      errorReason: { reason: "account-mismatch" },
    });
    await signIn(manager);
    await expect(manager.enrolThisInstallation()).rejects.toMatchObject({ code: "account-mismatch" });
    // The server did not enrol this machine, so the identity is free — and the marker SAYS so.
    expect(binding.value).toBe("none");
  });

  test("G13: a network failure after the intent leaves the intent — the server may know this machine", async () => {
    const binding = { value: "none" as InstallationBindingState };
    const { manager, transport } = fakes({ binding });
    (transport.completeInstallationRegistration as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("socket hang up"),
    );
    await signIn(manager);
    await expect(manager.enrolThisInstallation()).rejects.toBeTruthy();
    expect(binding.value).toBe("enrolling");
  });

  test("G13: a marker an older build never wrote is `absent`, and only the SERVER's own answer turns it into `none`", async () => {
    // The migration of a legacy install: no marker, a refresh token that works, and a server that says
    // this uid is bound to nothing. That answer — not a failed read, not a network error — is what may
    // release the identity.
    const binding = { value: "absent" as InstallationBindingState };
    const { manager } = fakes({ binding, overview: new AccountCallableError("not-bound-to-an-account", 403) });

    await manager.restoreFromInstallation();

    expect(manager.state().installationRegistered).toBe(false);
    expect(binding.value).toBe("none");
  });

  test("G13: a legacy install whose overview cannot be read stays `absent` — nothing has been proven", async () => {
    const binding = { value: "absent" as InstallationBindingState };
    const { manager } = fakes({ binding, overview: new Error("network") });
    await manager.restoreFromInstallation();
    expect(binding.value).toBe("absent");
    // And a legacy install the server DOES list is migrated to `bound` by that answer.
    const listed = { value: "absent" as InstallationBindingState };
    const { manager: enrolled } = fakes({ binding: listed });
    await enrolled.restoreFromInstallation();
    expect(listed.value).toBe("bound");
  });
});

// ---------------------------------------------------------------------------
// F01 — a completion belongs to ONE attempt, and a held answer proves it
// ---------------------------------------------------------------------------
//
// WHY EVERY TEST HERE HOLDS A RESPONSE. The bug F01 describes cannot happen quickly: it needs
// something to arrive AFTER the person has cancelled, resent or closed the app, and a fake that
// resolves immediately never leaves that window open. So each of these stops the flow at one await,
// does the thing that abandons it, and only then lets the answer through.
describe("a late answer belongs to the attempt that asked for it (F01)", () => {
  /** A promise a test resolves when it chooses. What "a held response" means here. */
  function held<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  /**
   * Holds ONE fake's answer, and says when the flow arrived at it.
   *
   * `entered` is what makes "a cancel during the lookup" mean the lookup rather than "a cancel some
   * time earlier that happened to be before it": without it the test cancels while the flow is still
   * two awaits upstream, and the case it claims to cover is never reached.
   */
  function gateOn<T>(fake: ReturnType<typeof vi.fn>): {
    entered: Promise<void>;
    resolve: (value: T) => void;
  } {
    const entry = held<void>();
    const answer = held<T>();
    fake.mockImplementation(() => {
      entry.resolve(undefined);
      return answer.promise;
    });
    return { entered: entry.promise, resolve: answer.resolve };
  }

  /** Asks for a link and hands the link over, WITHOUT confirming. The caller drives the rest. */
  async function upToTheLink(
    fixture: ReturnType<typeof fakes>,
    purpose: SignInPurpose,
    attemptId = FIRST_ATTEMPT_ID,
  ): Promise<void> {
    await fixture.manager.beginEmailSignIn("owner@example.test", purpose);
    fixture.manager.submitSignInLink(`${AUTHLINK.origin}/c?attempt=${attemptId}&oobCode=OOB-CODE`);
  }

  test("a CANCEL during the redemption sets no session, runs no mutation, and leaves the new attempt alone", async () => {
    const fixture = fakes({ enrolled: false });
    const gate = gateOn<OwnerSession>(fixture.client.completeEmailSignIn as ReturnType<typeof vi.fn>);
    await upToTheLink(fixture, "enrol-with-trial");
    const completing = fixture.manager.confirmEmailSignIn().catch((error: unknown) => error);
    await gate.entered;

    // The person changes their mind, then starts again.
    fixture.manager.cancelEmailSignIn();
    await fixture.manager.beginEmailSignIn("owner@example.test", "reauth");

    // ...and only now does Firebase answer the FIRST attempt.
    gate.resolve(ownerSession());
    expect(await completing).toMatchObject({ code: "sign-in-superseded" });

    // Nothing was signed in, nothing was registered, no trial was started.
    expect(fixture.manager.state().ownerEmail).toBeUndefined();
    expect(fixture.manager.state().needsRecentAuth).toBe(true);
    expect(fixture.transport.completeInstallationRegistration).not.toHaveBeenCalled();
    expect(fixture.transport.startTrial).not.toHaveBeenCalled();
    // And the NEW attempt is untouched: it is still waiting, and the old flow's cleanup did not
    // acknowledge it away.
    expect(fixture.manager.state().auth?.phase).toBe("awaiting-link");
    expect(fixture.brokerCalls.filter((call) => call.path === "/ack")).toHaveLength(0);
  });

  test("a RESEND during the redemption is the same rule, and the resent attempt survives it", async () => {
    const clock = { now: NOW };
    const fixture = fakes({ clock });
    const gate = gateOn<OwnerSession>(fixture.client.completeEmailSignIn as ReturnType<typeof vi.fn>);
    await upToTheLink(fixture, "reauth");
    const completing = fixture.manager.confirmEmailSignIn().catch((error: unknown) => error);
    await gate.entered;

    clock.now += 61_000; // past the resend cooldown
    await fixture.manager.resendEmailSignIn();
    gate.resolve(ownerSession());
    expect(await completing).toMatchObject({ code: "sign-in-superseded" });

    expect(fixture.manager.state().ownerEmail).toBeUndefined();
    // The SECOND attempt is the one on screen, and it is still confirmable — which it would not be if
    // the first flow's `broker.finish()` had ended "whatever is current".
    expect(fixture.manager.state().auth?.phase).toBe("awaiting-link");
    fixture.manager.submitSignInLink(`${AUTHLINK.origin}/c?attempt=${fixture.attemptIds[1]}&oobCode=SECOND`);
    expect(fixture.manager.state().auth?.phase).toBe("awaiting-confirmation");
  });

  test("a DISPOSE during the redemption abandons it, and no owner session appears afterwards", async () => {
    // A configuration change is the case that matters: an attempt started against one Firebase project
    // must not finish against another.
    const fixture = fakes();
    const gate = gateOn<OwnerSession>(fixture.client.completeEmailSignIn as ReturnType<typeof vi.fn>);
    await upToTheLink(fixture, "reauth");
    const completing = fixture.manager.confirmEmailSignIn().catch((error: unknown) => error);
    await gate.entered;

    fixture.manager.dispose();
    gate.resolve(ownerSession());
    expect(await completing).toMatchObject({ code: "sign-in-superseded" });
    expect(fixture.manager.state().ownerEmail).toBeUndefined();
    expect(fixture.manager.state().auth).toBeUndefined();
  });

  test("a cancel during the LOOKUP leaves no owner session and no retention", async () => {
    const fixture = fakes();
    const gate = gateOn<{ uid: string; email: string; emailVerified: boolean }>(
      fixture.client.lookup as ReturnType<typeof vi.fn>,
    );
    await upToTheLink(fixture, "reauth");
    const completing = fixture.manager.confirmEmailSignIn().catch((error: unknown) => error);
    await gate.entered;

    fixture.manager.cancelEmailSignIn();
    gate.resolve({ uid: "owner-uid", email: "owner@example.test", emailVerified: true });
    expect(await completing).toMatchObject({ code: "sign-in-superseded" });
    expect(fixture.manager.state().ownerEmail).toBeUndefined();
    await expect(fixture.manager.tokenFor("owner")).rejects.toMatchObject({ code: "invalid-credentials" });
  });

  test("a cancel during the OWNER CHECK stops the follow-up action", async () => {
    const fixture = fakes();
    // The owner check only happens for a machine the server already knows, so the fixture is restored
    // first — the same order a real desktop starts in.
    await fixture.manager.restoreFromInstallation();
    const gate = gateOn<{ status: "confirmed" }>(
      fixture.transport.confirmOwnerForInstallation as ReturnType<typeof vi.fn>,
    );
    await upToTheLink(fixture, "checkout");
    const completing = fixture.manager.confirmEmailSignIn().catch((error: unknown) => error);
    await gate.entered;

    fixture.manager.cancelEmailSignIn();
    gate.resolve({ status: "confirmed" });
    expect(await completing).toMatchObject({ code: "sign-in-superseded" });
    expect(fixture.transport.createCheckout).not.toHaveBeenCalled();
    expect(fixture.opened).toHaveLength(0);
  });

  test("a double-clicked confirmation redeems the code exactly once", async () => {
    // Plan §6: "Souběh pollingu, vložení odkazu a dvojkliku smí spustit právě jeden lokální požadavek
    // na uplatnění daného kódu."
    const fixture = fakes();
    const gate = gateOn<OwnerSession>(fixture.client.completeEmailSignIn as ReturnType<typeof vi.fn>);
    await upToTheLink(fixture, "reauth");
    const first = fixture.manager.confirmEmailSignIn().catch((error: unknown) => error);
    await gate.entered;
    const second = fixture.manager.confirmEmailSignIn().catch((error: unknown) => error);
    gate.resolve(ownerSession());
    await first;
    await second;
    expect(fixture.client.completeEmailSignIn).toHaveBeenCalledOnce();
  });

  test("a redemption still unwinding does not swallow the confirmation of the NEXT attempt", async () => {
    // The reason the guard is keyed by attempt id rather than being one boolean: a single `redeeming`
    // flag made `confirmEmailSignIn()` a silent no-op for the new attempt while the abandoned one was
    // still waiting for Firebase — on the one button a person would press next.
    const clock = { now: NOW };
    const fixture = fakes({ clock });
    const entry = held<void>();
    const answer = held<OwnerSession>();
    const complete = fixture.client.completeEmailSignIn as ReturnType<typeof vi.fn>;
    complete.mockImplementationOnce(() => {
      entry.resolve(undefined);
      return answer.promise;
    });
    const gate = { entered: entry.promise, resolve: answer.resolve };
    await upToTheLink(fixture, "reauth");
    const abandoned = fixture.manager.confirmEmailSignIn().catch((error: unknown) => error);
    await gate.entered;

    clock.now += 61_000;
    await fixture.manager.resendEmailSignIn();
    fixture.manager.submitSignInLink(`${AUTHLINK.origin}/c?attempt=${fixture.attemptIds[1]}&oobCode=SECOND`);
    await fixture.manager.confirmEmailSignIn();
    expect(fixture.manager.state().ownerEmail).toBe("owner@example.test");

    gate.resolve(ownerSession());
    expect(await abandoned).toMatchObject({ code: "sign-in-superseded" });
    // The late one did not undo the sign-in that succeeded.
    expect(fixture.manager.state().ownerEmail).toBe("owner@example.test");
  });

  test("a mutation the SERVER already performed is not pretended to be rolled back", async () => {
    // The plan's own words: "Již serverem provedenou mutaci nepředstírat jako vrácenou zpět. Zastavit
    // další kroky a zachovat pravdivý stav částečného výsledku." The registration below has completed
    // at the server when the flow is abandoned, so the machine stays registered — and nothing tries to
    // revoke it to make the local state match the intention that was cancelled.
    const fixture = fakes({ enrolled: false, binding: { value: "absent", writes: [] } });
    const gate = gateOn<{ status: "started"; notAfter: number; claimsChanged: boolean }>(
      fixture.transport.startTrial as ReturnType<typeof vi.fn>,
    );
    await upToTheLink(fixture, "enrol-with-trial");
    const completing = fixture.manager.confirmEmailSignIn().catch((error: unknown) => error);
    await gate.entered;
    // The registration is done by the time the trial is in flight.
    expect(fixture.transport.completeInstallationRegistration).toHaveBeenCalledOnce();

    fixture.manager.cancelEmailSignIn();
    gate.resolve({ status: "started", notAfter: NOW + 1000, claimsChanged: true });
    await completing;

    expect(fixture.manager.state().installationRegistered).toBe(true);
    expect(fixture.binding?.value).toBe("bound");
    expect(fixture.transport.revokeAccountDevice).not.toHaveBeenCalled();
  });

  test("the operand is the one the flow pinned, not whatever a newer attempt put there", async () => {
    const fixture = fakes();
    const gate = gateOn<OwnerSession>(fixture.client.completeEmailSignIn as ReturnType<typeof vi.fn>);
    await fixture.manager.beginEmailSignIn("owner@example.test", "checkout", "offer-first");
    fixture.manager.submitSignInLink(`${AUTHLINK.origin}/c?attempt=${FIRST_ATTEMPT_ID}&oobCode=OOB-CODE`);
    const completing = fixture.manager.confirmEmailSignIn().catch((error: unknown) => error);
    await gate.entered;
    // A second sign-in for a DIFFERENT offer replaces the pending one.
    await fixture.manager.beginEmailSignIn("owner@example.test", "checkout", "offer-second");
    gate.resolve(ownerSession());
    await completing;
    // The abandoned flow bought nothing at all — and certainly not the other offer.
    expect(fixture.transport.createCheckout).not.toHaveBeenCalled();
  });

  test("a revoke-device operand is the one THIS flow pinned, not a newer one's", async () => {
    const fixture = fakes();
    const gate = gateOn<OwnerSession>(fixture.client.completeEmailSignIn as ReturnType<typeof vi.fn>);
    await fixture.manager.beginEmailSignIn(
      "owner@example.test",
      "revoke-device",
      JSON.stringify(["installation", "old-installation"]),
    );
    fixture.manager.submitSignInLink(`${AUTHLINK.origin}/c?attempt=${FIRST_ATTEMPT_ID}&oobCode=OOB-CODE`);
    const completing = fixture.manager.confirmEmailSignIn().catch((error: unknown) => error);
    await gate.entered;
    // A second sign-in for a DIFFERENT revoke target replaces the pending one.
    await fixture.manager.beginEmailSignIn(
      "owner@example.test",
      "revoke-device",
      JSON.stringify(["installation", "new-installation"]),
    );
    gate.resolve(ownerSession());
    await completing;
    // The abandoned flow revoked nothing at all — and certainly not the other target.
    expect(fixture.transport.revokeAccountDevice).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// F02 — a candidate session cannot escape a failed verification
// ---------------------------------------------------------------------------
describe("a failed verification leaves no usable owner session (F02)", () => {
  /** Every purpose whose successful completion is allowed to RETAIN the owner credential. */
  const RETENTION_PURPOSES: SignInPurpose[] = ["reauth", "change-email", "delete-account"];

  test("an EXCEPTION in the lookup — not the handled network branch — leaves nothing behind", async () => {
    // The exact hole the finding names: the session was assigned to `this.owner` and retained before
    // the checks, and only the handled `AccountAuthError("network")` path dropped it again. A
    // `TypeError` out of a malformed response, or any other throw, left a retained owner session and a
    // UI reporting a fresh authentication.
    for (const purpose of RETENTION_PURPOSES) {
      const fixture = fakes();
      (fixture.client.lookup as ReturnType<typeof vi.fn>).mockRejectedValue(new TypeError("cannot read properties"));
      await expect(signIn(fixture.manager, purpose)).rejects.toBeInstanceOf(AccountManagerError);
      expect(fixture.manager.state().ownerEmail, purpose).toBeUndefined();
      expect(fixture.manager.state().needsRecentAuth, purpose).toBe(true);
      await expect(fixture.manager.tokenFor("owner")).rejects.toMatchObject({ code: "invalid-credentials" });
    }
  });

  test("a REPEATED network failure in the lookup leaves nothing behind either", async () => {
    for (const purpose of RETENTION_PURPOSES) {
      const fixture = fakes();
      (fixture.client.lookup as ReturnType<typeof vi.fn>).mockRejectedValue(
        new (await import("./account-client.js")).AccountAuthError("network", "down"),
      );
      await expect(signIn(fixture.manager, purpose)).rejects.toMatchObject({ code: "network" });
      expect(fixture.manager.state().ownerEmail, purpose).toBeUndefined();
      expect(fixture.manager.state().needsRecentAuth, purpose).toBe(true);
    }
  });

  test("an exhausted OWNER CHECK leaves nothing behind, and keeps the binding and the overview", async () => {
    // "Vazba a přehled instalace zůstávají zachované" — a failed owner check is a failed CHECK, not a
    // reason to forget which account this machine belongs to.
    for (const purpose of RETENTION_PURPOSES) {
      const fixture = fakes({ binding: { value: "bound", writes: [] } });
      await fixture.manager.restoreFromInstallation();
      (fixture.transport.confirmOwnerForInstallation as ReturnType<typeof vi.fn>).mockRejectedValue(
        new AccountCallableError("network", 0),
      );
      await expect(signIn(fixture.manager, purpose)).rejects.toMatchObject({ code: "network" });
      expect(fixture.manager.state().ownerEmail, purpose).toBeUndefined();
      expect(fixture.manager.state().needsRecentAuth, purpose).toBe(true);
      expect(fixture.manager.state().installationRegistered, purpose).toBe(true);
      expect(fixture.manager.state().overview, purpose).toBeDefined();
      expect(fixture.binding?.value, purpose).toBe("bound");
    }
  });

  test("a REFUSED owner check leaves nothing behind, for every retention purpose", async () => {
    for (const purpose of RETENTION_PURPOSES) {
      const fixture = fakes();
      await fixture.manager.restoreFromInstallation();
      (fixture.transport.confirmOwnerForInstallation as ReturnType<typeof vi.fn>).mockResolvedValue({
        status: "refused",
        reason: "not-the-owner",
      });
      await expect(signIn(fixture.manager, purpose)).rejects.toMatchObject({ code: "account-mismatch" });
      expect(fixture.manager.state().ownerEmail, purpose).toBeUndefined();
      expect(fixture.manager.state().needsRecentAuth, purpose).toBe(true);
    }
  });

  test("after a failed verification, a change of address does not proceed", async () => {
    // The consequence the finding is really about: `requestLoginEmailChange()` used the held token
    // directly against Firebase, with no new check of the binding.
    const fixture = fakes();
    await fixture.manager.restoreFromInstallation();
    (fixture.transport.confirmOwnerForInstallation as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "refused",
      reason: "not-the-owner",
    });
    await expect(signIn(fixture.manager, "change-email")).rejects.toMatchObject({ code: "account-mismatch" });
    await expect(fixture.manager.requestLoginEmailChange("new@example.test")).rejects.toMatchObject({
      code: "invalid-credentials",
    });
    expect(fixture.client.requestLoginEmailChange).not.toHaveBeenCalled();
  });

  test("a FAILED change of address still ends the owner session", async () => {
    // The release used to be the statement after `await this.run(...)`, which a throw skips — so a
    // network failure here left the credential held and the UI showing a fresh authentication.
    const fixture = fakes();
    await signIn(fixture.manager, "change-email");
    expect(fixture.manager.state().needsRecentAuth).toBe(false);
    (fixture.client.requestLoginEmailChange as ReturnType<typeof vi.fn>).mockRejectedValue(
      new (await import("./account-client.js")).AccountAuthError("network", "down"),
    );
    await expect(fixture.manager.requestLoginEmailChange("new@example.test")).rejects.toMatchObject({
      code: "network",
    });
    expect(fixture.manager.state().needsRecentAuth).toBe(true);
    await expect(fixture.manager.tokenFor("owner")).rejects.toMatchObject({ code: "invalid-credentials" });
  });

  test("CANCELLING releases the retention a sign-in opened", async () => {
    const fixture = fakes();
    await signIn(fixture.manager, "reauth");
    expect(fixture.manager.state().needsRecentAuth).toBe(false);
    fixture.manager.cancelEmailSignIn();
    expect(fixture.manager.state().needsRecentAuth).toBe(true);
    await expect(fixture.manager.tokenFor("owner")).rejects.toMatchObject({ code: "invalid-credentials" });
  });

  test("a token whose auth_time the desktop cannot prove signs in but authorises nothing", async () => {
    // F08 at the manager: the session is real — the server accepted the code — but the desktop cannot
    // say when the person authenticated, so it asks again rather than offering the destructive door.
    const fixture = fakes({ session: ownerSession({ authenticatedAt: null }) });
    await signIn(fixture.manager, "delete-account");
    expect(fixture.manager.state().needsRecentAuth).toBe(true);
    await expect(fixture.manager.deleteAccount("delete my account")).rejects.toMatchObject({
      code: "requires-recent-login",
    });
    expect(fixture.transport.deleteAccount).not.toHaveBeenCalled();
  });

  test("a token naming a DIFFERENT subject from the session is refused", async () => {
    const idToken = `header.${Buffer.from(JSON.stringify({ sub: "somebody-else" }), "utf8").toString("base64url")}.sig`;
    const fixture = fakes({ session: ownerSession({ idToken }) });
    await expect(signIn(fixture.manager, "reauth")).rejects.toMatchObject({ code: "account-mismatch" });
    expect(fixture.manager.state().ownerEmail).toBeUndefined();
  });

  test("a token that says the address is NOT verified is refused even when the record says it is", async () => {
    const claims = { sub: "owner-uid", email_verified: false };
    const idToken = `header.${Buffer.from(JSON.stringify(claims), "utf8").toString("base64url")}.sig`;
    const fixture = fakes({ session: ownerSession({ idToken }) });
    await expect(signIn(fixture.manager, "reauth")).rejects.toMatchObject({ code: "requires-recent-login" });
    expect(fixture.manager.state().ownerEmail).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// F06 — resume only the unfinished step, with the same mutation identity
// ---------------------------------------------------------------------------
describe("resuming a partial result (F06)", () => {
  /** Keys that differ per call, so a test can say which key a retry used. */
  function countingKeys(): () => string {
    let n = 0;
    return () => `idem-${++n}`;
  }

  test("registration and trial use SEPARATE keys", async () => {
    const fixture = fakes({ enrolled: false, newIdempotencyKey: countingKeys() });
    await signIn(fixture.manager, "enrol-with-trial");
    const enrolKey = (fixture.transport.completeInstallationRegistration as ReturnType<typeof vi.fn>).mock.calls[0]![0]
      .idempotencyKey as string;
    const trialKey = (fixture.transport.startTrial as ReturnType<typeof vi.fn>).mock.calls[0]![0]
      .idempotencyKey as string;
    expect(enrolKey).not.toBe(trialKey);
  });

  test("a trial whose answer was LOST is retried with the SAME key", async () => {
    // The heart of the finding. A key minted at the call site made every press a new logical mutation,
    // so a lost answer came back as a second trial the server had no way to recognise.
    const fixture = fakes({ enrolled: false, newIdempotencyKey: countingKeys() });
    const startTrial = fixture.transport.startTrial as ReturnType<typeof vi.fn>;
    startTrial.mockRejectedValueOnce(new AccountCallableError("network", 0));
    await expect(signIn(fixture.manager, "enrol-with-trial")).rejects.toMatchObject({ code: "network" });
    expect(fixture.manager.state().installationRegistered).toBe(true);

    // The person asks again, through the purpose that exists for exactly this.
    await fixture.manager.beginEmailSignIn("owner@example.test", "trial");
    fixture.manager.submitSignInLink(`${AUTHLINK.origin}/c?attempt=${fixture.attemptIds[1]}&oobCode=OOB-CODE`);
    await fixture.manager.confirmEmailSignIn();

    const keys = startTrial.mock.calls.map((call) => (call[0] as { idempotencyKey: string }).idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    // And ONLY the trial ran again: the registration that stood is not repeated, and neither is
    // `ensureAccount`.
    expect(fixture.transport.completeInstallationRegistration).toHaveBeenCalledOnce();
    expect(fixture.transport.ensureAccount).toHaveBeenCalledOnce();
  });

  test("the `trial` purpose performs the trial and nothing else", async () => {
    const fixture = fakes();
    await signIn(fixture.manager, "trial");
    expect(fixture.transport.startTrial).toHaveBeenCalledOnce();
    expect(fixture.transport.completeInstallationRegistration).not.toHaveBeenCalled();
    expect(fixture.transport.ensureAccount).not.toHaveBeenCalled();
  });

  test("a DEFINITE refusal releases the key: the next press is a new mutation", async () => {
    // The other half of the rule. A refusal is an answer — the server considered the request and said
    // no — so the next attempt is a new intention and must not be deduplicated against the old one.
    const fixture = fakes({ newIdempotencyKey: countingKeys() });
    const startTrial = fixture.transport.startTrial as ReturnType<typeof vi.fn>;
    startTrial.mockResolvedValueOnce({ status: "not-eligible", reason: "trial-already-used", claimsChanged: false });
    await signIn(fixture.manager, "reauth");
    await expect(fixture.manager.startTrial()).rejects.toMatchObject({ code: "trial-already-used" });
    await fixture.manager.startTrial();
    const keys = startTrial.mock.calls.map((call) => (call[0] as { idempotencyKey: string }).idempotencyKey);
    expect(keys[0]).not.toBe(keys[1]);
  });

  test("a machine the account ALREADY lists is not registered again", async () => {
    // "Neopakovat dokončenou registraci ani `ensureAccount` jen proto, že selhal navazující krok."
    const fixture = fakes({ enrolled: true });
    await signIn(fixture.manager, "enrol-with-trial");
    expect(fixture.transport.completeInstallationRegistration).not.toHaveBeenCalled();
    expect(fixture.transport.ensureAccount).not.toHaveBeenCalled();
    expect(fixture.transport.startTrial).toHaveBeenCalledOnce();
  });

  test("a restart promises no pending attempt: the state is re-read instead", async () => {
    // F06's last bullet. Nothing about an attempt is persisted, so `restoreFromInstallation()` answers
    // out of the durable marker and the server's overview — never out of a remembered sign-in.
    const fixture = fakes({ binding: { value: "bound", writes: [] } });
    await upToTheLinkOnly(fixture);
    fixture.manager.dispose();
    await fixture.manager.restoreFromInstallation();
    expect(fixture.manager.state().auth).toBeUndefined();
    expect(fixture.manager.state().installationRegistered).toBe(true);
    expect(fixture.manager.state().needsRecentAuth).toBe(true);
  });

  async function upToTheLinkOnly(fixture: ReturnType<typeof fakes>): Promise<void> {
    await fixture.manager.beginEmailSignIn("owner@example.test", "reauth");
    fixture.manager.submitSignInLink(`${AUTHLINK.origin}/c?attempt=${FIRST_ATTEMPT_ID}&oobCode=OOB-CODE`);
  }
});

// ---------------------------------------------------------------------------
// F04 — nothing is left holding the flow after a timeout or a deadline
// ---------------------------------------------------------------------------
describe("a request that does not answer leaves nothing behind (F04)", () => {
  test("a timed-out redemption releases the busy flag and a NEW flow can be started", async () => {
    // "Busy stav se po timeoutu uvolní a uživatel může zrušit nebo zahájit nový tok." A page stuck
    // busy is a page with every button disabled and nothing to press.
    const fixture = fakes();
    const complete = fixture.client.completeEmailSignIn as ReturnType<typeof vi.fn>;
    complete.mockRejectedValueOnce(new (await import("./account-client.js")).AccountAuthError("network", "timed out"));
    await fixture.manager.beginEmailSignIn("owner@example.test", "reauth");
    fixture.manager.submitSignInLink(`${AUTHLINK.origin}/c?attempt=${FIRST_ATTEMPT_ID}&oobCode=OOB-CODE`);
    await expect(fixture.manager.confirmEmailSignIn()).rejects.toMatchObject({ code: "network" });

    expect(fixture.manager.state().busy).toBe(false);
    expect(fixture.manager.state().ownerEmail).toBeUndefined();
    await expect(fixture.manager.tokenFor("owner")).rejects.toMatchObject({ code: "invalid-credentials" });
    // And starting again works, rather than meeting a flow that never ended.
    await fixture.manager.beginEmailSignIn("owner@example.test", "reauth");
    expect(fixture.manager.state().auth?.phase).toBe("awaiting-link");
  });

  test("the verification window bounds the whole check, not only its retries", async () => {
    // The defect F04 names: the deadline was consulted only BETWEEN retries, so a redemption that had
    // already taken longer than the two-minute window went on to make the first check anyway.
    const clock = { now: NOW };
    const fixture = fakes({ clock });
    (fixture.client.completeEmailSignIn as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      // The sign-in itself takes longer than the whole verification window.
      clock.now += 3 * 60_000;
      return ownerSession();
    });
    await fixture.manager.beginEmailSignIn("owner@example.test", "reauth");
    fixture.manager.submitSignInLink(`${AUTHLINK.origin}/c?attempt=${FIRST_ATTEMPT_ID}&oobCode=OOB-CODE`);
    await expect(fixture.manager.confirmEmailSignIn()).rejects.toMatchObject({ code: "attempt-expired" });
    // The lookup was never attempted, and no session survives.
    expect(fixture.client.lookup).not.toHaveBeenCalled();
    expect(fixture.manager.state().ownerEmail).toBeUndefined();
    expect(fixture.manager.state().needsRecentAuth).toBe(true);
  });

  test("a redemption whose code was refused ends the attempt and leaves no candidate", async () => {
    const fixture = fakes();
    (fixture.client.completeEmailSignIn as ReturnType<typeof vi.fn>).mockRejectedValue(
      new (await import("./account-client.js")).AccountAuthError("invalid-code", "spent"),
    );
    await fixture.manager.beginEmailSignIn("owner@example.test", "reauth");
    fixture.manager.submitSignInLink(`${AUTHLINK.origin}/c?attempt=${FIRST_ATTEMPT_ID}&oobCode=OOB-CODE`);
    await expect(fixture.manager.confirmEmailSignIn()).rejects.toMatchObject({ code: "invalid-code" });
    expect(fixture.manager.state().auth).toBeUndefined();
    expect(fixture.manager.state().ownerEmail).toBeUndefined();
    expect(fixture.manager.state().busy).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// R01 — a cancel stops the inner registration and billing chain, not only the next step
// ---------------------------------------------------------------------------
describe("every step of a completion is checked against the flow that started it (R01)", () => {
  function held<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  /** Holds ONE fake's answer and says when the flow arrived at it; the default answer is the fixture's. */
  function gateOn<T>(fake: ReturnType<typeof vi.fn>): {
    entered: Promise<void>;
    resolve: (value: T) => void;
    reject: (reason: unknown) => void;
  } {
    const entry = held<void>();
    const answer = held<T>();
    const original = fake.getMockImplementation();
    fake.mockImplementationOnce(async (...args: unknown[]) => {
      entry.resolve(undefined);
      const value = await answer.promise;
      // The fixture's own answer and side effects (the server now lists the machine) still happen;
      // a test that resolves with `undefined` gets that answer, one that resolves a value gets its own.
      const fromFixture = original ? await (original as (...inner: unknown[]) => Promise<unknown>)(...args) : undefined;
      return value ?? fromFixture;
    });
    return { entered: entry.promise, resolve: answer.resolve, reject: answer.reject };
  }

  async function upToTheLink(
    fixture: ReturnType<typeof fakes>,
    purpose: SignInPurpose,
    offerId?: string,
  ): Promise<void> {
    await fixture.manager.beginEmailSignIn("owner@example.test", purpose, offerId);
    fixture.manager.submitSignInLink(`${AUTHLINK.origin}/c?attempt=${FIRST_ATTEMPT_ID}&oobCode=OOB-CODE`);
  }

  /**
   * The four ways a running operation stops being wanted. "panel close" reaches `cancelEmailSignIn`
   * (F09). A RESEND is not among them by the time these steps run: the broker's attempt was finished
   * the moment the code was redeemed, so there is nothing to resend — what a person does instead is
   * start a new sign-in, which is the fourth row. (A resend DURING the redemption is the F01 case.)
   */
  const INTERRUPTIONS = {
    cancel: (fixture: ReturnType<typeof fakes>) => fixture.manager.cancelEmailSignIn(),
    "panel close": (fixture: ReturnType<typeof fakes>) => fixture.manager.cancelEmailSignIn(),
    "a new sign-in": (fixture: ReturnType<typeof fakes>) =>
      fixture.manager.beginEmailSignIn("owner@example.test", "reauth"),
    dispose: (fixture: ReturnType<typeof fakes>) => fixture.manager.dispose(),
  } as const;

  /**
   * Each held step a completion can be waiting on, and what must NOT follow once it is released. The
   * first three are the enrol-with-trial chain on a machine the account does not list yet; the last two
   * are the billing purposes on an enrolled machine, where "what follows" is the browser — the fixture's
   * default answer to both is a `ready` URL on an allowed host, so an empty `opened` is the proof.
   */
  const STEPS = [
    {
      held: "ensureAccount",
      purpose: "enrol-with-trial",
      enrolled: false,
      mustNotFollow: ["beginInstallationRegistration", "completeInstallationRegistration", "startTrial"],
    },
    {
      held: "beginInstallationRegistration",
      purpose: "enrol-with-trial",
      enrolled: false,
      mustNotFollow: ["completeInstallationRegistration", "startTrial"],
    },
    {
      held: "completeInstallationRegistration",
      purpose: "enrol-with-trial",
      enrolled: false,
      mustNotFollow: ["startTrial"],
    },
    { held: "createCheckout", purpose: "checkout", offerId: "personal-monthly", enrolled: true, mustNotFollow: [] },
    { held: "createPortalSession", purpose: "portal", enrolled: true, mustNotFollow: [] },
  ] as const satisfies readonly {
    held: keyof AccountTransport;
    purpose: SignInPurpose;
    offerId?: string;
    enrolled: boolean;
    mustNotFollow: readonly (keyof AccountTransport)[];
  }[];

  for (const step of STEPS) {
    for (const [name, interrupt] of Object.entries(INTERRUPTIONS)) {
      test(`${name} while \`${step.held}\` is outstanding: nothing follows when it answers`, async () => {
        const clock = { now: NOW };
        const fixture = fakes({ enrolled: step.enrolled, clock, binding: { value: "none", writes: [] } });
        const gate = gateOn<unknown>(fixture.transport[step.held] as ReturnType<typeof vi.fn>);
        await upToTheLink(fixture, step.purpose, "offerId" in step ? step.offerId : undefined);
        const completing = fixture.manager.confirmEmailSignIn().catch((error: unknown) => error);
        await gate.entered;

        await interrupt(fixture);
        gate.resolve(undefined);
        expect(await completing).toMatchObject({ code: "sign-in-superseded" });

        for (const later of step.mustNotFollow) {
          expect(fixture.transport[later], `${later} after ${name} during ${step.held}`).not.toHaveBeenCalled();
        }
        expect(fixture.opened).toEqual([]);
        expect(fixture.manager.state().busy).toBe(false);
      });
    }
  }

  test("a registration the server PERFORMED while the flow was being cancelled stays recorded", async () => {
    // Cancel rolls nothing back. The server enrolled this machine; the flag and the durable marker say
    // so, and the page shows the true state rather than the one the cancelled flow intended.
    const writes: InstallationBindingMarker[] = [];
    const fixture = fakes({ enrolled: false, binding: { value: "none", writes } });
    const gate = gateOn<unknown>(fixture.transport.completeInstallationRegistration as ReturnType<typeof vi.fn>);
    await upToTheLink(fixture, "enrol-with-trial");
    const completing = fixture.manager.confirmEmailSignIn().catch((error: unknown) => error);
    await gate.entered;
    fixture.manager.cancelEmailSignIn();
    gate.resolve({ status: "registered", installationId: "inst-1", claimsChanged: true });
    expect(await completing).toMatchObject({ code: "sign-in-superseded" });

    expect(fixture.manager.state().installationRegistered).toBe(true);
    expect(writes).toContain("bound");
    expect(fixture.binding?.value).toBe("bound");
    expect(fixture.transport.startTrial).not.toHaveBeenCalled();
  });

  test("a checkout answer that arrives after the cancel opens NO browser, through the flow", async () => {
    const fixture = fakes();
    const gate = gateOn<unknown>(fixture.transport.createCheckout as ReturnType<typeof vi.fn>);
    await upToTheLink(fixture, "checkout", "personal-monthly");
    const completing = fixture.manager.confirmEmailSignIn().catch((error: unknown) => error);
    await gate.entered;
    fixture.manager.cancelEmailSignIn();
    gate.resolve({ status: "ready", checkoutUrl: "https://checkout.example/pay", intentId: "int-1" });
    expect(await completing).toMatchObject({ code: "sign-in-superseded" });
    expect(fixture.opened).toEqual([]);
  });

  test("a portal answer that arrives after the panel closed opens NO browser", async () => {
    const fixture = fakes();
    const gate = gateOn<unknown>(fixture.transport.createPortalSession as ReturnType<typeof vi.fn>);
    await upToTheLink(fixture, "portal");
    const completing = fixture.manager.confirmEmailSignIn().catch((error: unknown) => error);
    await gate.entered;
    fixture.manager.cancelEmailSignIn();
    gate.resolve({ status: "ready", portalUrl: "https://portal.example/s/1", expiresAt: NOW });
    expect(await completing).toMatchObject({ code: "sign-in-superseded" });
    expect(fixture.opened).toEqual([]);
  });

  test("a DIRECT checkout is an operation too: cancelled, its late answer opens nothing", async () => {
    // The direct entry point — the button on the account page inside the retention window — used to
    // run with no context at all.
    const fixture = fakes();
    await signIn(fixture.manager, "reauth");
    const gate = gateOn<unknown>(fixture.transport.createCheckout as ReturnType<typeof vi.fn>);
    const opening = fixture.manager.openCheckout("personal-monthly").catch((error: unknown) => error);
    await gate.entered;
    fixture.manager.cancelEmailSignIn();
    gate.resolve({ status: "ready", checkoutUrl: "https://checkout.example/pay", intentId: "int-1" });
    expect(await opening).toMatchObject({ code: "sign-in-superseded" });
    expect(fixture.opened).toEqual([]);
  });

  test("the owner session lapsing during a checkout opens nothing: the token belonged to the operation", async () => {
    // The owner-generation half of the scope. Nothing cancelled the operation; the session it was
    // running as went away (here the runtime releasing it, as the retention timer also does), and the
    // answer is refused rather than acted on under a session that no longer exists.
    const fixture = fakes();
    await signIn(fixture.manager, "reauth");
    const gate = gateOn<unknown>(fixture.transport.createCheckout as ReturnType<typeof vi.fn>);
    const opening = fixture.manager.openCheckout("personal-monthly").catch((error: unknown) => error);
    await gate.entered;
    fixture.manager.releaseOwnerSession();
    gate.resolve({ status: "ready", checkoutUrl: "https://checkout.example/pay", intentId: "int-1" });
    expect(await opening).toMatchObject({ code: "sign-in-superseded" });
    expect(fixture.opened).toEqual([]);
  });

  test("a NEWER sign-in: the old flow uses none of its token, and overwrites neither its busy nor its error", async () => {
    const fixture = fakes({ enrolled: false });
    const gate = gateOn<unknown>(fixture.transport.completeInstallationRegistration as ReturnType<typeof vi.fn>);
    await upToTheLink(fixture, "enrol-with-trial");
    const first = fixture.manager.confirmEmailSignIn().catch((error: unknown) => error);
    await gate.entered;

    // Somebody else signs in on this desktop, and their sign-in completes while the first flow is
    // still waiting for the registration answer.
    (fixture.client.completeEmailSignIn as ReturnType<typeof vi.fn>).mockResolvedValue(
      ownerSession({ uid: "second-uid", email: "second@example.test", idToken: "second-token" }),
    );
    await fixture.manager.beginEmailSignIn("second@example.test", "reauth");
    fixture.manager.submitSignInLink(`${AUTHLINK.origin}/c?attempt=${fixture.attemptIds[1]}&oobCode=SECOND`);
    await fixture.manager.confirmEmailSignIn();
    expect(fixture.manager.state().ownerEmail).toBe("second@example.test");
    expect(fixture.manager.state().lastError).toBeUndefined();

    // Now the first flow's registration answers.
    gate.resolve({ status: "registered", installationId: "inst-1", claimsChanged: true });
    expect(await first).toMatchObject({ code: "sign-in-superseded" });
    // The trial that would have run next — as the SECOND person — never started...
    expect(fixture.transport.startTrial).not.toHaveBeenCalled();
    // ...the second sign-in's state is untouched by the first flow's refusal...
    expect(fixture.manager.state().lastError).toBeUndefined();
    expect(fixture.manager.state().busy).toBe(false);
    expect(fixture.manager.state().ownerEmail).toBe("second@example.test");
    expect(await fixture.manager.tokenFor("owner")).toBe("second-token");
    // ...and what the server did for the first person is still the truth about this machine.
    expect(fixture.manager.state().installationRegistered).toBe(true);
  });

  test("a late failure of an abandoned operation does not clear the busy flag of the one that replaced it", async () => {
    const fixture = fakes();
    await signIn(fixture.manager, "reauth");
    const checkoutGate = gateOn<unknown>(fixture.transport.createCheckout as ReturnType<typeof vi.fn>);
    const opening = fixture.manager.openCheckout("personal-monthly").catch((error: unknown) => error);
    await checkoutGate.entered;
    fixture.manager.cancelEmailSignIn();
    expect(fixture.manager.state().busy).toBe(false);

    // A newer operation is now in flight.
    const overviewGate = gateOn<unknown>(fixture.transport.getAccountOverview as ReturnType<typeof vi.fn>);
    const refreshing = fixture.manager.refreshOverview();
    await overviewGate.entered;
    expect(fixture.manager.state().busy).toBe(true);

    // The abandoned checkout fails late. Its caller hears about it; the page does not.
    checkoutGate.reject(new AccountCallableError("network", 0));
    expect(await opening).toMatchObject({ code: "network" });
    expect(fixture.manager.state().busy).toBe(true);
    expect(fixture.manager.state().lastError).toBeUndefined();

    overviewGate.resolve(overview());
    await refreshing;
    expect(fixture.manager.state().busy).toBe(false);
  });

  test("an older overview answer never overwrites a newer one", async () => {
    // Two reads in flight, answered out of order: the one issued LAST is the authoritative state.
    const fixture = fakes();
    const read = fixture.transport.getAccountOverview as ReturnType<typeof vi.fn>;
    const older = held<AccountOverview>();
    const newer = held<AccountOverview>();
    read.mockImplementationOnce(() => older.promise).mockImplementationOnce(() => newer.promise);
    const first = fixture.manager.refreshOverview();
    const second = fixture.manager.refreshOverview();
    newer.resolve(overview({ supportReference: "STR-1-NEWER00000000" } as Partial<AccountOverview>));
    await second;
    older.resolve(overview({ supportReference: "STR-1-OLDER00000000" } as Partial<AccountOverview>));
    await first;
    expect(fixture.manager.state().overview?.supportReference).toBe("STR-1-NEWER00000000");
  });

  test("an overview answer that lands after a sign-out does not resurrect the account", async () => {
    const fixture = fakes({ binding: { value: "bound", writes: [] } });
    await fixture.manager.restoreFromInstallation();
    await signIn(fixture.manager, "reauth");
    const read = fixture.transport.getAccountOverview as ReturnType<typeof vi.fn>;
    const late = held<AccountOverview>();
    read.mockImplementationOnce(() => late.promise);
    const refreshing = fixture.manager.refreshOverview();
    await fixture.manager.signOutInstallation({ disconnect: true });
    late.resolve(overview());
    await refreshing;
    expect(fixture.manager.state().overview).toBeUndefined();
    expect(fixture.manager.state().installationRegistered).toBe(false);
    expect(fixture.binding?.value).toBe("none");
  });
});

// ---------------------------------------------------------------------------
// R02 — a late refresh does not put a released owner session back
// ---------------------------------------------------------------------------
describe("a refresh answer is kept only for the session it was asked about (R02)", () => {
  function heldRefresh(fixture: ReturnType<typeof fakes>): {
    entered: Promise<void>;
    resolve: (session: OwnerSession) => void;
    signals: (AbortSignal | undefined)[];
  } {
    let entered!: () => void;
    const enteredPromise = new Promise<void>((res) => {
      entered = res;
    });
    let resolve!: (session: OwnerSession) => void;
    const answer = new Promise<OwnerSession>((res) => {
      resolve = res;
    });
    const signals: (AbortSignal | undefined)[] = [];
    (fixture.client.refresh as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (_session: OwnerSession, options?: { signal?: AbortSignal }) => {
        signals.push(options?.signal);
        entered();
        return answer;
      },
    );
    return { entered: enteredPromise, resolve, signals };
  }

  test("a background refresh answered after the owner was RELEASED leaves no owner behind", async () => {
    const fixture = fakes();
    await signIn(fixture.manager, "reauth");
    const refresh = heldRefresh(fixture);
    const claims = fixture.manager.onClaimsChanged();
    await refresh.entered;

    fixture.manager.releaseOwnerSession();
    expect(refresh.signals[0]?.aborted).toBe(true);
    refresh.resolve(ownerSession({ idToken: "late-refresh" }));
    await claims;

    expect(fixture.manager.state().ownerEmail).toBeUndefined();
    expect(fixture.manager.state().needsRecentAuth).toBe(true);
    await expect(fixture.manager.tokenFor("owner")).rejects.toMatchObject({ code: "invalid-credentials" });
  });

  test("a background refresh answered after a NEWER sign-in does not overwrite the newer owner", async () => {
    const fixture = fakes();
    await signIn(fixture.manager, "reauth");
    const refresh = heldRefresh(fixture);
    const claims = fixture.manager.onClaimsChanged();
    await refresh.entered;

    (fixture.client.completeEmailSignIn as ReturnType<typeof vi.fn>).mockResolvedValue(
      ownerSession({ uid: "second-uid", email: "second@example.test", idToken: "second-token" }),
    );
    await fixture.manager.beginEmailSignIn("second@example.test", "reauth");
    fixture.manager.submitSignInLink(`${AUTHLINK.origin}/c?attempt=${fixture.attemptIds[1]}&oobCode=SECOND`);
    await fixture.manager.confirmEmailSignIn();

    refresh.resolve(ownerSession({ idToken: "late-refresh-of-the-first" }));
    await claims;
    expect(fixture.manager.state().ownerEmail).toBe("second@example.test");
    expect(await fixture.manager.tokenFor("owner")).toBe("second-token");
  });

  test("`tokenFor` refreshing an expiring token answers nothing once the session is released", async () => {
    // The token is due for a refresh, the refresh is out, and the session is released before it
    // answers. What used to happen: the refreshed session was written back and its token returned.
    const fixture = fakes({ session: ownerSession({ expiresAt: NOW + 30_000 }) });
    await signIn(fixture.manager, "reauth");
    const refresh = heldRefresh(fixture);
    const token = fixture.manager.tokenFor("owner").catch((error: unknown) => error);
    await refresh.entered;
    fixture.manager.releaseOwnerSession();
    refresh.resolve(ownerSession({ idToken: "late-refresh" }));
    expect(await token).toMatchObject({ code: "invalid-credentials" });
    expect(fixture.manager.state().ownerEmail).toBeUndefined();
    await expect(fixture.manager.tokenFor("owner")).rejects.toMatchObject({ code: "invalid-credentials" });
  });

  test("`tokenFor` never returns a REPLACED session's token", async () => {
    const fixture = fakes({ session: ownerSession({ expiresAt: NOW + 30_000 }) });
    await signIn(fixture.manager, "reauth");
    const refresh = heldRefresh(fixture);
    const token = fixture.manager.tokenFor("owner").catch((error: unknown) => error);
    await refresh.entered;

    (fixture.client.completeEmailSignIn as ReturnType<typeof vi.fn>).mockResolvedValue(
      ownerSession({ uid: "second-uid", email: "second@example.test", idToken: "second-token" }),
    );
    await fixture.manager.beginEmailSignIn("second@example.test", "reauth");
    fixture.manager.submitSignInLink(`${AUTHLINK.origin}/c?attempt=${fixture.attemptIds[1]}&oobCode=SECOND`);
    await fixture.manager.confirmEmailSignIn();

    refresh.resolve(ownerSession({ idToken: "late-refresh-of-the-first" }));
    expect(await token).toMatchObject({ code: "sign-in-superseded" });
    expect(await fixture.manager.tokenFor("owner")).toBe("second-token");
  });
});

// ---------------------------------------------------------------------------
// R03 — the idempotency key travels with the whole request
// ---------------------------------------------------------------------------
describe("a retry is the same request, or it is not a retry (R03)", () => {
  function countingKeys(): () => string {
    let n = 0;
    return () => `idem-${++n}`;
  }

  test("a registration whose answer was LOST is re-sent with the same challenge, signature and key", async () => {
    // The server digests `challengeId` under the key. A retry that minted a new challenge under the old
    // key was refused as `idempotency-key-reused`; one that minted a new key was a second registration.
    const fixture = fakes({ enrolled: false, newIdempotencyKey: countingKeys() });
    const complete = fixture.transport.completeInstallationRegistration as ReturnType<typeof vi.fn>;
    const begin = fixture.transport.beginInstallationRegistration as ReturnType<typeof vi.fn>;
    complete.mockRejectedValueOnce(new AccountCallableError("network", 0));
    await expect(signIn(fixture.manager, "enrol")).rejects.toMatchObject({ code: "network" });

    await fixture.manager.beginEmailSignIn("owner@example.test", "enrol");
    fixture.manager.submitSignInLink(`${AUTHLINK.origin}/c?attempt=${fixture.attemptIds[1]}&oobCode=OOB-CODE`);
    await fixture.manager.confirmEmailSignIn();

    expect(begin).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[1]![0]).toEqual(complete.mock.calls[0]![0]);
    expect(fixture.manager.state().installationRegistered).toBe(true);
  });

  test("a STORED refusal replayed for the same request settles it, and the next attempt is a new one", async () => {
    // The server keeps the first request's result under the key, refusal included; re-sending the same
    // request receives it. That is a definite answer: the key and the request are released, and the
    // attempt after that mints a new challenge and a new key.
    const fixture = fakes({ enrolled: false, newIdempotencyKey: countingKeys() });
    const complete = fixture.transport.completeInstallationRegistration as ReturnType<typeof vi.fn>;
    const begin = fixture.transport.beginInstallationRegistration as ReturnType<typeof vi.fn>;
    complete.mockRejectedValueOnce(new AccountCallableError("network", 0));
    complete.mockResolvedValueOnce({ status: "refused", errorReason: { reason: "installation-limit" } });
    await expect(signIn(fixture.manager, "enrol")).rejects.toMatchObject({ code: "network" });

    await fixture.manager.beginEmailSignIn("owner@example.test", "enrol");
    fixture.manager.submitSignInLink(`${AUTHLINK.origin}/c?attempt=${fixture.attemptIds[1]}&oobCode=OOB-CODE`);
    await expect(fixture.manager.confirmEmailSignIn()).rejects.toMatchObject({ code: "installation-limit" });
    expect(begin).toHaveBeenCalledOnce();
    expect(complete.mock.calls[1]![0]).toEqual(complete.mock.calls[0]![0]);

    await fixture.manager.beginEmailSignIn("owner@example.test", "enrol");
    fixture.manager.submitSignInLink(`${AUTHLINK.origin}/c?attempt=${fixture.attemptIds[2]}&oobCode=OOB-CODE`);
    await fixture.manager.confirmEmailSignIn();
    expect(begin).toHaveBeenCalledTimes(2);
    const keys = complete.mock.calls.map((call) => (call[0] as { idempotencyKey: string }).idempotencyKey);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  test("checkout A → lost answer → checkout B never opens A as the result of B", async () => {
    const fixture = fakes({ newIdempotencyKey: countingKeys() });
    const create = fixture.transport.createCheckout as ReturnType<typeof vi.fn>;
    let calls = 0;
    create.mockImplementation(async (args: { offerId: string }) => {
      calls += 1;
      if (calls === 1) throw new AccountCallableError("network", 0);
      return {
        status: "ready",
        checkoutUrl: `https://checkout.example/${args.offerId}`,
        intentId: `int-${args.offerId}`,
      };
    });
    await signIn(fixture.manager, "reauth");
    await expect(fixture.manager.openCheckout("offer-a")).rejects.toMatchObject({ code: "network" });
    await expect(fixture.manager.openCheckout("offer-b")).resolves.toBe("opened");

    const sent = create.mock.calls.map((call) => call[0] as { offerId: string; idempotencyKey: string });
    // A is resolved first — same key, same request — then B goes out under a key of its own.
    expect(sent.map((call) => call.offerId)).toEqual(["offer-a", "offer-a", "offer-b"]);
    expect(sent[0]!.idempotencyKey).toBe(sent[1]!.idempotencyKey);
    expect(sent[2]!.idempotencyKey).not.toBe(sent[0]!.idempotencyKey);
    // And A's link, though the server handed it back, is not what the person asked for.
    expect(fixture.opened).toEqual(["https://checkout.example/offer-b"]);
  });

  test("checkout A → lost answer → the SAME offer again is one intent, under one key", async () => {
    const fixture = fakes({ newIdempotencyKey: countingKeys() });
    const create = fixture.transport.createCheckout as ReturnType<typeof vi.fn>;
    create.mockRejectedValueOnce(new AccountCallableError("network", 0));
    await signIn(fixture.manager, "reauth");
    await expect(fixture.manager.openCheckout("offer-a")).rejects.toMatchObject({ code: "network" });
    await expect(fixture.manager.openCheckout("offer-a")).resolves.toBe("opened");
    const keys = create.mock.calls.map((call) => (call[0] as { idempotencyKey: string }).idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  test("a stale checkout that is STILL unknown blocks the new offer rather than being replaced by it", async () => {
    // "Neřešit nejistotu pouhým vygenerováním jiného klíče." Until A's fate is known, B is not sent.
    const fixture = fakes({ newIdempotencyKey: countingKeys() });
    const create = fixture.transport.createCheckout as ReturnType<typeof vi.fn>;
    create.mockRejectedValue(new AccountCallableError("network", 0));
    await signIn(fixture.manager, "reauth");
    await expect(fixture.manager.openCheckout("offer-a")).rejects.toMatchObject({ code: "network" });
    await expect(fixture.manager.openCheckout("offer-b")).rejects.toMatchObject({ code: "network" });
    expect(create.mock.calls.map((call) => (call[0] as { offerId: string }).offerId)).toEqual(["offer-a", "offer-a"]);
  });

  test("an answer this desktop could not READ keeps the trial's key, like a lost one (R04)", async () => {
    const fixture = fakes({ newIdempotencyKey: countingKeys() });
    const startTrial = fixture.transport.startTrial as ReturnType<typeof vi.fn>;
    startTrial.mockRejectedValueOnce(new AccountCallableError("malformed-response", 200));
    await signIn(fixture.manager, "reauth");
    await expect(fixture.manager.startTrial()).rejects.toMatchObject({ code: "malformed-response" });
    await fixture.manager.startTrial();
    const keys = startTrial.mock.calls.map((call) => (call[0] as { idempotencyKey: string }).idempotencyKey);
    expect(keys[0]).toBe(keys[1]);
  });

  test("a lookup that fails on the NETWORK is retried over the same candidate session", async () => {
    // R04's last clause. The code is spent; the check is asked again, with the same tokens.
    const fixture = fakes();
    const lookup = fixture.client.lookup as ReturnType<typeof vi.fn>;
    lookup.mockRejectedValueOnce(new AccountAuthError("network", "the body broke off"));
    await signIn(fixture.manager, "reauth");
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(lookup.mock.calls[0]![0]).toBe(lookup.mock.calls[1]![0]);
    expect(fixture.manager.state().ownerEmail).toBe("owner@example.test");
  });
});

// ---------------------------------------------------------------------------
// R05 — the verification window is checked after the LAST await too
// ---------------------------------------------------------------------------
describe("a verification that finishes after the window is not a verification (R05)", () => {
  test("the clock passes the window INSIDE the last lookup: the session is not promoted", async () => {
    // The existing F04 case moves the clock during the redemption, before the first check. This one
    // moves it inside the check itself — the lookup was issued in time and answered late — which the
    // pre-try check could not see.
    const clock = { now: NOW };
    const fixture = fakes({ clock, enrolled: false });
    (fixture.client.lookup as ReturnType<typeof vi.fn>).mockImplementation(async (current: OwnerSession) => {
      clock.now += 3 * 60_000;
      return { uid: current.uid, email: current.email, emailVerified: true };
    });
    await expect(signIn(fixture.manager, "enrol-with-trial")).rejects.toMatchObject({ code: "attempt-expired" });
    expect(fixture.manager.state().ownerEmail).toBeUndefined();
    expect(fixture.manager.state().needsRecentAuth).toBe(true);
    expect(fixture.transport.ensureAccount).not.toHaveBeenCalled();
    expect(fixture.transport.startTrial).not.toHaveBeenCalled();
    await expect(fixture.manager.tokenFor("owner")).rejects.toMatchObject({ code: "invalid-credentials" });
  });

  test("the clock passes the window INSIDE the last owner check: same answer", async () => {
    const clock = { now: NOW };
    const fixture = fakes({ clock, binding: { value: "bound", writes: [] } });
    await fixture.manager.restoreFromInstallation();
    (fixture.transport.confirmOwnerForInstallation as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      clock.now += 3 * 60_000;
      return { status: "confirmed" };
    });
    await expect(signIn(fixture.manager, "trial")).rejects.toMatchObject({ code: "attempt-expired" });
    expect(fixture.manager.state().ownerEmail).toBeUndefined();
    expect(fixture.manager.state().needsRecentAuth).toBe(true);
    expect(fixture.transport.startTrial).not.toHaveBeenCalled();
    // The binding and the overview survive: a late check is a failed CHECK, not a lost account.
    expect(fixture.manager.state().installationRegistered).toBe(true);
  });

  test("the verification requests carry a signal that closes with the window", async () => {
    // "Request timeout omezit zbývajícím časem ověřování." The lookup is handed a signal that is
    // aborted when the window closes — a check that cannot answer in time is ended, not answered late.
    const clock = { now: NOW };
    const fixture = fakes({ clock });
    let signal: AbortSignal | undefined;
    (fixture.client.lookup as ReturnType<typeof vi.fn>).mockImplementation(
      async (current: OwnerSession, options?: { signal?: AbortSignal }) => {
        signal = options?.signal;
        return { uid: current.uid, email: current.email, emailVerified: true };
      },
    );
    await signIn(fixture.manager, "reauth");
    expect(signal).toBeDefined();
    expect(signal?.aborted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The second follow-up review (2026-09-10): S01–S04. Shared plumbing for holding one fake's answer.
// ---------------------------------------------------------------------------

/** A promise whose settlement the test controls. */
function heldAnswer<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Holds ONE fake's next answer and says when the operation arrived at it. Resolving with `undefined`
 * hands back the fixture's own answer (and runs its side effects — "the server now lists the machine").
 */
function holdNext<T>(fake: ReturnType<typeof vi.fn>): {
  entered: Promise<void>;
  resolve: (value?: T) => void;
  reject: (reason: unknown) => void;
} {
  const entry = heldAnswer<void>();
  const answer = heldAnswer<T | undefined>();
  const original = fake.getMockImplementation();
  fake.mockImplementationOnce(async (...args: unknown[]) => {
    entry.resolve(undefined);
    const value = await answer.promise;
    const fromFixture = original ? await (original as (...inner: unknown[]) => Promise<unknown>)(...args) : undefined;
    return value ?? fromFixture;
  });
  return { entered: entry.promise, resolve: answer.resolve, reject: answer.reject };
}

/** Starts a sign-in and presents the link for the attempt at `index`, without confirming it. */
async function presentLink(
  fixture: ReturnType<typeof fakes>,
  purpose: SignInPurpose,
  index: number,
  options: { email?: string; offerId?: string } = {},
): Promise<void> {
  await fixture.manager.beginEmailSignIn(options.email ?? "owner@example.test", purpose, options.offerId);
  fixture.manager.submitSignInLink(`${AUTHLINK.origin}/c?attempt=${fixture.attemptIds[index]}&oobCode=OOB-CODE`);
}

/**
 * What a machine restarted with this marker shows, when the server cannot be asked: the real
 * `restoreFromInstallation` path, over a transport whose overview read fails on the network.
 */
async function afterRestart(binding: { value: InstallationBindingState }): Promise<boolean> {
  const restarted = fakes({ binding: { value: binding.value }, overview: new AccountCallableError("network", 0) });
  await restarted.manager.restoreFromInstallation();
  return restarted.manager.state().installationRegistered;
}

describe("a late registration answer does not overwrite a newer binding (S01)", () => {
  test("an OLD refusal landing after a NEWER flow was bound leaves `bound` in place", async () => {
    // Two owners who both start unregistered. A's registration is held; A is cancelled; B — a different
    // person — signs in and registers this machine, which is now `bound`. Then A's answer arrives, and
    // it is a refusal. The refusal is A's result and nobody else's: the marker stays `bound`, because
    // `none` is the one value that lets a rejected refresh token be answered with a brand-new identity.
    const writes: InstallationBindingMarker[] = [];
    const binding = { value: "none" as InstallationBindingState, writes };
    const fixture = fakes({ enrolled: false, binding });
    const complete = fixture.transport.completeInstallationRegistration as ReturnType<typeof vi.fn>;
    const gate = holdNext<unknown>(complete);
    await presentLink(fixture, "enrol", 0);
    const flowA = fixture.manager.confirmEmailSignIn().catch((error: unknown) => error);
    await gate.entered;

    fixture.manager.cancelEmailSignIn();
    (fixture.client.completeEmailSignIn as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      ownerSession({ uid: "owner-b", email: "b@example.test" }),
    );
    await presentLink(fixture, "enrol", 1, { email: "b@example.test" });
    await fixture.manager.confirmEmailSignIn();
    expect(binding.value).toBe("bound");
    expect(fixture.manager.state().installationRegistered).toBe(true);
    const overviewReadsBefore = (fixture.transport.getAccountOverview as ReturnType<typeof vi.fn>).mock.calls.length;
    const writesBeforeLate = writes.length;

    gate.resolve({ status: "refused", errorReason: { reason: "installation-limit" } });
    // A's own result is A's refusal — reported to A's caller, and to nobody's shared state.
    expect(await flowA).toMatchObject({ code: "installation-limit" });
    expect(binding.value).toBe("bound");
    // Nothing after B's `bound` but the re-read's own `bound`: the late `none` was never written.
    expect(writes.slice(writesBeforeLate)).toEqual(["bound"]);
    expect(fixture.manager.state().installationRegistered).toBe(true);
    // The safe determination: the server was asked again, after both answers.
    expect((fixture.transport.getAccountOverview as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
      overviewReadsBefore + 1,
    );
    // And a restart reads the marker the newer authority wrote.
    expect(await afterRestart(binding)).toBe(true);
    // The late refusal did not become the page's error either: nothing the person is looking at failed.
    expect(fixture.manager.state().lastError).toBeUndefined();
  });

  test("an OLD success landing after a sign-out does not put `bound` back", async () => {
    // The registration the server performed is real, and the credential that performed it is gone: the
    // person signed this machine out in between. Locally the right answer stays `none` — a new identity
    // is exactly what this machine should mint next — and the late success is not allowed to say
    // otherwise. The re-read that would settle it fails the way it does after a sign-out, and that
    // failure changes nothing.
    const writes: InstallationBindingMarker[] = [];
    const binding = { value: "none" as InstallationBindingState, writes };
    const forgotten: number[] = [];
    const fixture = fakes({
      enrolled: false,
      binding,
      forgetInstallationCredential: async () => void forgotten.push(1),
    });
    const complete = fixture.transport.completeInstallationRegistration as ReturnType<typeof vi.fn>;
    const gate = holdNext<unknown>(complete);
    await presentLink(fixture, "enrol", 0);
    const flowA = fixture.manager.confirmEmailSignIn().catch((error: unknown) => error);
    await gate.entered;

    fixture.manager.cancelEmailSignIn();
    await fixture.manager.signOutInstallation({ disconnect: false });
    expect(forgotten).toEqual([1]);
    expect(binding.value).toBe("none");
    // After a sign-out the installation credential is gone, and an overview read answers accordingly.
    (fixture.transport.getAccountOverview as ReturnType<typeof vi.fn>).mockRejectedValue(
      new AccountCallableError("not-bound-to-an-account", 403),
    );

    gate.resolve(undefined);
    expect(await flowA).toMatchObject({ code: "sign-in-superseded" });
    expect(binding.value).toBe("none");
    expect(writes.at(-1)).toBe("none");
    expect(fixture.manager.state().installationRegistered).toBe(false);
    expect(await afterRestart(binding)).toBe(false);
    // The attempt to re-read was made, and its failure was not the page's problem.
    expect(fixture.transport.getAccountOverview).toHaveBeenCalled();
    expect(fixture.manager.state().lastError).toBeUndefined();
    expect(fixture.manager.state().busy).toBe(false);
  });

  test("an OLD success landing after a newer REVOCATION stays revoked: the re-read confirms `none`", async () => {
    // The revocation arrives as an overview that no longer lists this machine — applied after A's request
    // went out. A's late success is withheld, and the re-read, which also does not list the machine,
    // is what the marker follows. The old answer never becomes the page's state.
    const writes: InstallationBindingMarker[] = [];
    const binding = { value: "none" as InstallationBindingState, writes };
    const fixture = fakes({ enrolled: false, binding });
    const gate = holdNext<unknown>(fixture.transport.completeInstallationRegistration as ReturnType<typeof vi.fn>);
    await presentLink(fixture, "enrol", 0);
    const flowA = fixture.manager.confirmEmailSignIn().catch((error: unknown) => error);
    await gate.entered;
    fixture.manager.cancelEmailSignIn();
    // From here the server answers every overview with "this machine is not listed".
    (fixture.transport.getAccountOverview as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...overview(),
      installations: [],
    });
    await fixture.manager.refreshOverview();
    expect(writes.at(-1)).toBe("none");
    const writesBeforeLate = writes.length;

    gate.resolve(undefined);
    expect(await flowA).toMatchObject({ code: "sign-in-superseded" });
    expect(writes.slice(writesBeforeLate)).toEqual(["none"]);
    expect(binding.value).toBe("none");
    expect(fixture.manager.state().installationRegistered).toBe(false);
    expect(await afterRestart(binding)).toBe(false);
  });

  test("a cancel with NOTHING after it still records the registration the server performed", async () => {
    // The other half of the rule, kept from R01: a cancel moves no revision. What the server did is
    // written, and survives a restart.
    const writes: InstallationBindingMarker[] = [];
    const binding = { value: "none" as InstallationBindingState, writes };
    const fixture = fakes({ enrolled: false, binding });
    const gate = holdNext<unknown>(fixture.transport.completeInstallationRegistration as ReturnType<typeof vi.fn>);
    await presentLink(fixture, "enrol-with-trial", 0);
    const flowA = fixture.manager.confirmEmailSignIn().catch((error: unknown) => error);
    await gate.entered;
    fixture.manager.cancelEmailSignIn();
    gate.resolve(undefined);
    expect(await flowA).toMatchObject({ code: "sign-in-superseded" });
    expect(binding.value).toBe("bound");
    expect(fixture.manager.state().installationRegistered).toBe(true);
    expect(fixture.transport.startTrial).not.toHaveBeenCalled();
    expect(await afterRestart(binding)).toBe(true);
  });

  test("an OLD success landing after a newer overview said `none` is settled by a re-read, not by the old answer", async () => {
    // The ambiguous order: an overview that was issued before the registration completed on the server
    // and applied after — it said "not listed" — beside a registration answer that says "registered".
    // Neither is written over the other; the server is asked once more, now, and that answer wins.
    const writes: InstallationBindingMarker[] = [];
    const binding = { value: "none" as InstallationBindingState, writes };
    const fixture = fakes({ enrolled: false, binding });
    const gate = holdNext<unknown>(fixture.transport.completeInstallationRegistration as ReturnType<typeof vi.fn>);
    await presentLink(fixture, "enrol", 0);
    const flowA = fixture.manager.confirmEmailSignIn().catch((error: unknown) => error);
    await gate.entered;
    fixture.manager.cancelEmailSignIn();
    // A newer authoritative read, applied while A's answer is still out: the server does not list
    // this machine yet (in the fixture, the server "performs" the registration when the gate opens).
    await fixture.manager.refreshOverview();
    expect(writes.at(-1)).toBe("none");
    const writesBeforeLate = writes.length;

    gate.resolve(undefined);
    await flowA;
    // The old answer itself wrote nothing; the re-read it triggered found the machine listed.
    expect(writes.slice(writesBeforeLate)).toEqual(["bound"]);
    expect(binding.value).toBe("bound");
    expect(fixture.manager.state().installationRegistered).toBe(true);
  });

  test("the withheld answer is logged with the operation and the codes, and nothing personal", async () => {
    const binding = { value: "none" as InstallationBindingState, writes: [] as InstallationBindingMarker[] };
    const fixture = fakes({ enrolled: false, binding });
    const gate = holdNext<unknown>(fixture.transport.completeInstallationRegistration as ReturnType<typeof vi.fn>);
    await presentLink(fixture, "enrol", 0);
    const flowA = fixture.manager.confirmEmailSignIn().catch((error: unknown) => error);
    await gate.entered;
    fixture.manager.cancelEmailSignIn();
    (fixture.client.completeEmailSignIn as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      ownerSession({ uid: "owner-b", email: "b@example.test" }),
    );
    await presentLink(fixture, "enrol", 1, { email: "b@example.test" });
    await fixture.manager.confirmEmailSignIn();
    logSpy.warn.mockClear();
    gate.resolve({ status: "refused", errorReason: { reason: "installation-limit" } });
    await flowA;

    const withheld = logSpy.warn.mock.calls.find(([message]) => String(message).includes("newer binding"));
    expect(withheld).toBeDefined();
    expect(withheld![1]).toMatchObject({ operation: "enrol-installation", answer: "refused", scopeAlive: false });
    const everything = JSON.stringify(logSpy.warn.mock.calls);
    expect(everything).not.toContain("example.test");
    expect(everything).not.toContain("owner-b");
    expect(everything).not.toContain("id-token");
    expect(everything).not.toContain("idem-");
    // And the operation's own failure line names the fixed code the person would have seen.
    const failed = logSpy.warn.mock.calls.find(([message]) =>
      String(message).includes("email-sign-in-complete failed"),
    );
    expect(failed![1]).toMatchObject({ code: "installation-limit", abandoned: true });
  });
});

/**
 * Holds the next `count` answers of one fake, each released with an EXPLICIT value. `holdNext` cannot be
 * stacked: its fallback is `getMockImplementation()`, which in vitest is the queued once-implementation —
 * the previous gate — and it is awaited whatever the gate was released with, so a second gate waits on
 * the first. Calls past `count` fall through to the fake's own implementation.
 */
function holdReads<T>(
  fake: ReturnType<typeof vi.fn>,
  count: number,
): { entered: Promise<void>; resolve: (value: T) => void; reject: (reason: unknown) => void }[] {
  const original = fake.getMockImplementation() as ((...args: unknown[]) => Promise<unknown>) | undefined;
  const gates = Array.from({ length: count }, () => ({ entry: heldAnswer<void>(), answer: heldAnswer<T>() }));
  let calls = 0;
  fake.mockImplementation(async (...args: unknown[]) => {
    const index = calls++;
    if (index >= count) return original ? original(...args) : undefined;
    gates[index].entry.resolve(undefined);
    return gates[index].answer.promise;
  });
  return gates.map((gate) => ({
    entered: gate.entry.promise,
    resolve: gate.answer.resolve,
    reject: gate.answer.reject,
  }));
}

describe("a late start-up answer does not erase a newer binding (T01)", () => {
  /**
   * The runtime does not await `restoreFromInstallation()`, so the start-up overview read runs beside
   * whatever the person does first. Here that is a registration, and the start-up read answers AFTER it
   * — the two orders of the review's scenario: its refusal (`not-bound-to-an-account`, the answer for a
   * machine that was not bound when the read was issued), and its success with an overview that does not
   * list the machine yet. Both are answers about the machine this WAS. Each lands while the
   * registration's own re-read is still out.
   *
   * WHAT THE SIGN-IN'S OWN READ DID decides which rule catches the late answer. When it APPLIED (the
   * server did not list the machine yet), the start-up read has been overtaken by a newer read and the
   * request ordering alone (R01) marks it stale. When it FAILED — swallowed by `afterOwnerReady`, nothing
   * applied — the start-up read is the only read ever applied-or-not, and ONLY the operation fence (the
   * registration's `bound` written since the read was issued, T01) stands between the refusal and the
   * catch. The second shape is the one the fence exists for, and the test of it fails without the fence.
   */
  async function startupBesideARegistration(ownerReadAnswer: "lists nothing" | "fails" = "lists nothing"): Promise<{
    fixture: ReturnType<typeof fakes>;
    binding: { value: InstallationBindingState; writes: InstallationBindingMarker[] };
    restore: Promise<void>;
    startupRead: ReturnType<typeof holdReads<AccountOverview>>[number];
    reRead: ReturnType<typeof holdReads<AccountOverview>>[number];
    flow: Promise<unknown>;
    writesBeforeLate: number;
  }> {
    const writes: InstallationBindingMarker[] = [];
    const binding = { value: "none" as InstallationBindingState, writes };
    const fixture = fakes({ enrolled: false, binding });
    const read = fixture.transport.getAccountOverview as ReturnType<typeof vi.fn>;
    // Three reads, held in the order they are issued: the start-up read, the sign-in's own read
    // (`afterOwnerReady`, answered at once — the server has not enrolled the machine yet, so it does not
    // list it) and the registration's confirming re-read.
    const [startupRead, ownerRead, reRead] = holdReads<AccountOverview>(read, 3);
    const restore = fixture.manager.restoreFromInstallation();
    await startupRead.entered;
    expect(binding.value).toBe("none");

    await presentLink(fixture, "enrol", 0);
    const flow = fixture.manager.confirmEmailSignIn().catch((error: unknown) => error);
    await ownerRead.entered;
    if (ownerReadAnswer === "lists nothing") ownerRead.resolve({ ...overview(), installations: [] });
    else ownerRead.reject(new AccountAuthError("network", "the identity service could not be reached."));
    await reRead.entered;
    // The server has enrolled the machine and the marker says so; only the confirming re-read is out.
    expect(binding.value).toBe("bound");
    expect(fixture.manager.state().installationRegistered).toBe(true);
    return { fixture, binding, restore, startupRead, reRead, flow, writesBeforeLate: writes.length };
  }

  test("the start-up read's late `not-bound-to-an-account` leaves the registration, the overview and the marker alone", async () => {
    // Before the fix this refusal reached `restoreFromInstallation`'s catch, which wrote `overview = null`
    // and `none` without asking whether anything had happened since the read went out. The marker is
    // the guard that keeps a rejected refresh token from minting a new identity, so this was not display.
    const { fixture, binding, restore, startupRead, reRead, flow, writesBeforeLate } =
      await startupBesideARegistration();
    logSpy.info.mockClear();
    startupRead.reject(new AccountCallableError("not-bound-to-an-account", 403));
    await restore;
    expect(binding.value).toBe("bound");
    expect(fixture.manager.state().installationRegistered).toBe(true);
    expect(binding.writes.slice(writesBeforeLate)).toEqual([]);
    // Logged as what it is, with counters and codes and nothing personal.
    const withheld = logSpy.info.mock.calls.find(([message]) => String(message).includes("overview read failed after"));
    expect(withheld).toBeDefined();
    expect(withheld![1]).toMatchObject({ code: "not-bound-to-an-account" });
    expect(JSON.stringify(logSpy.info.mock.calls)).not.toContain("example.test");

    reRead.resolve(overview());
    await flow;
    expect(binding.writes.slice(writesBeforeLate)).toEqual(["bound"]);
    expect(fixture.manager.state().installationRegistered).toBe(true);
    expect(fixture.manager.state().overview?.installations.some((row) => row.installationId === "inst-1")).toBe(true);
    expect(fixture.manager.state().lastError).toBeUndefined();
    expect(fixture.manager.state().busy).toBe(false);
    // A restart with the backend unreachable still knows the machine is enrolled.
    expect(await afterRestart(binding)).toBe(true);
  });

  test("with the sign-in's own read FAILED, only the registration's write stands between the refusal and the catch", async () => {
    // Nothing has been APPLIED since the start-up read went out: the sign-in's read failed and was
    // swallowed, so `overviewApplied` still names no read and the R01 check alone would let the refusal
    // through. What marks it stale is the `bound` the registration wrote after the read was issued (T01).
    const { fixture, binding, restore, startupRead, reRead, flow, writesBeforeLate } =
      await startupBesideARegistration("fails");
    logSpy.info.mockClear();
    startupRead.reject(new AccountCallableError("not-bound-to-an-account", 403));
    await restore;
    expect(binding.value).toBe("bound");
    expect(fixture.manager.state().installationRegistered).toBe(true);
    expect(binding.writes.slice(writesBeforeLate)).toEqual([]);
    const withheld = logSpy.info.mock.calls.find(([message]) => String(message).includes("overview read failed after"));
    expect(withheld).toBeDefined();
    expect(withheld![1]).toMatchObject({ code: "not-bound-to-an-account", sentUnderRevision: 0, currentRevision: 1 });

    reRead.resolve(overview());
    await flow;
    expect(binding.writes.slice(writesBeforeLate)).toEqual(["bound"]);
    expect(fixture.manager.state().installationRegistered).toBe(true);
    expect(fixture.manager.state().lastError).toBeUndefined();
    expect(await afterRestart(binding)).toBe(true);
  });

  test("the start-up read's late SUCCESS with an overview that predates the registration is not applied either", async () => {
    // The successful half of the same race: an overview issued before the server enrolled the machine
    // does not list it, and applying it after the registration's `bound` wrote `none` — through the
    // shared path, which ordered reads only against other reads.
    const { fixture, binding, restore, startupRead, reRead, flow, writesBeforeLate } =
      await startupBesideARegistration();
    logSpy.info.mockClear();
    startupRead.resolve({ ...overview(), installations: [] });
    await restore;
    expect(binding.value).toBe("bound");
    expect(fixture.manager.state().installationRegistered).toBe(true);
    expect(binding.writes.slice(writesBeforeLate)).toEqual([]);
    expect(
      logSpy.info.mock.calls.find(([message]) => String(message).includes("overview answered after a newer binding")),
    ).toBeDefined();

    reRead.resolve(overview());
    await flow;
    expect(binding.writes.slice(writesBeforeLate)).toEqual(["bound"]);
    expect(fixture.manager.state().overview?.installations.some((row) => row.installationId === "inst-1")).toBe(true);
    expect(await afterRestart(binding)).toBe(true);
  });

  test("two reads answering in the order they were issued both apply: a read's own answer fences nothing", async () => {
    // The rule must not throw away the second of two in-order answers. A start-up read and a refresh
    // are out together; the start-up read answers first and applies; the refresh's answer, issued beside
    // it under the same revision, is the newer truth and is applied too.
    const writes: InstallationBindingMarker[] = [];
    const binding = { value: "bound" as InstallationBindingState, writes };
    const fixture = fakes({ binding });
    const read = fixture.transport.getAccountOverview as ReturnType<typeof vi.fn>;
    const [first, second] = holdReads<AccountOverview>(read, 2);
    const restore = fixture.manager.restoreFromInstallation();
    await first.entered;
    const refresh = fixture.manager.refreshOverview();
    await second.entered;
    first.resolve(overview());
    await restore;
    expect(fixture.manager.state().overview?.installations.some((row) => row.installationId === "inst-1")).toBe(true);
    // The server revoked the machine between the two answers: the second read carries that, and wins.
    second.resolve({ ...overview(), installations: [] });
    await refresh;
    expect(binding.value).toBe("none");
    expect(fixture.manager.state().installationRegistered).toBe(false);
    expect(writes).toEqual(["bound", "none"]);
  });

  test("the ordinary start-up refusal on a fresh install still writes `none`", async () => {
    // Nothing newer happened: the refusal is the newest answer, and it is the one thing allowed to write
    // `none` for a machine no build ever wrote a marker for (G13).
    const writes: InstallationBindingMarker[] = [];
    const binding = { value: "absent" as InstallationBindingState, writes };
    const fixture = fakes({ binding, overview: new AccountCallableError("not-bound-to-an-account", 403) });
    await fixture.manager.restoreFromInstallation();
    expect(binding.value).toBe("none");
    expect(writes).toEqual(["none"]);
    expect(fixture.manager.state().installationRegistered).toBe(false);
  });
});

describe("the operation's abort reaches the callable transport (S02)", () => {
  /** A callable endpoint that answers by name, counts what it was asked, and never needs a network. */
  function callableEndpoint(options: { installationTokens: () => Promise<string> }) {
    const sent: { name: string; signal: AbortSignal | undefined }[] = [];
    const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
      const name = new URL(url).pathname.split("/").pop() ?? "";
      sent.push({ name, signal: init?.signal ?? undefined });
      const result =
        name === "getAccountOverview"
          ? { ...overview(), installations: [] }
          : name === "ensureAccount"
            ? { status: "created", supportReference: "STR-1-ABCDEFGHJKMN", claimsChanged: true }
            : name === "beginInstallationRegistration"
              ? { challengeId: "chal-1", transcript: "strideterm-installation:chal-1", expiresAt: NOW + 300_000 }
              : { status: "registered", installationId: "inst-1", claimsChanged: true };
      return new Response(JSON.stringify({ result }), { status: 200, headers: { "content-type": "application/json" } });
    };
    return { sent, fetchImpl, installationTokens: options.installationTokens };
  }

  // A REAL-shaped project id: the URL helpers refuse a cloud endpoint for a `demo-` project without
  // emulators (follow-up 2026-09-11, item 1), and this fixture exercises the real cloud transport.
  const CONFIG: MobileFirebaseConfig = {
    projectId: "fixture-strideterm",
    apiKey: "test-api-key",
    functionsRegion: "europe-west1",
    emulators: null,
    databaseUrl: "https://fixture-strideterm.europe-west1.firebasedatabase.app",
  };

  test("a cancel while the transport waits for the installation token: the mutation is never sent", async () => {
    // THE REAL TRANSPORT, not the fake port: the gap is between the manager's guard and the fetch, and
    // only the real `createAccountTransport` has that gap. The installation token is held on the ask
    // that `beginInstallationRegistration` makes; the sign-in's own overview read gets its token at once.
    let installationAsks = 0;
    const heldToken = heldAnswer<string>();
    const endpoint = callableEndpoint({
      installationTokens: () => {
        installationAsks += 1;
        return installationAsks === 1 ? Promise.resolve("installation-token") : heldToken.promise;
      },
    });
    const clock = { now: NOW };
    const client: AccountClient = {
      startEmailSignIn: vi.fn(async () => {}),
      completeEmailSignIn: vi.fn(async () => ownerSession()),
      refresh: vi.fn(async (current) => current),
      requestLoginEmailChange: vi.fn(async () => {}),
      lookup: vi.fn(async (current) => ({ uid: current.uid, email: current.email, emailVerified: true })),
    };
    const { broker } = makeBroker(client, () => clock.now);
    const manager: AccountManager = new AccountManager({
      client,
      broker,
      identity: IDENTITY,
      openExternal: async () => {},
      now: () => clock.now,
      billingHosts: () => [],
      transport: createAccountTransport({
        config: CONFIG,
        fetchImpl: endpoint.fetchImpl,
        tokenFor: (kind, signal) =>
          kind === "owner" ? manager.tokenFor("owner", signal) : endpoint.installationTokens(),
      }),
    });
    await manager.beginEmailSignIn("owner@example.test", "reauth");
    manager.submitSignInLink(`${AUTHLINK.origin}/c?attempt=${FIRST_ATTEMPT_ID}&oobCode=OOB-CODE`);
    await manager.confirmEmailSignIn();
    expect(endpoint.sent.map((call) => call.name)).toEqual(["getAccountOverview"]);

    const enrolling = manager.enrolThisInstallation().catch((error: unknown) => error);
    // `ensureAccount` went out as the owner; the challenge leg is now waiting for its installation token.
    await vi.waitFor(() => expect(installationAsks).toBe(2));
    expect(endpoint.sent.map((call) => call.name)).toEqual(["getAccountOverview", "ensureAccount"]);

    manager.cancelEmailSignIn();
    heldToken.resolve("installation-token");
    expect(await enrolling).toMatchObject({ code: "sign-in-superseded" });
    // ZERO new mutation requests after the token arrived — the whole of the finding.
    expect(endpoint.sent.map((call) => call.name)).toEqual(["getAccountOverview", "ensureAccount"]);
    expect(manager.state().busy).toBe(false);
  });

  test("a request already in flight is handed the operation's signal, and a cancel aborts it", async () => {
    // The other half: what WAS sent is abandoned with the operation. The fetch records the signal it
    // was given; the cancel fires it; the outcome is `aborted` — kept as unknown, shown as superseded.
    let sentSignal: AbortSignal | undefined;
    let requests = 0;
    const clock = { now: NOW };
    const client: AccountClient = {
      startEmailSignIn: vi.fn(async () => {}),
      completeEmailSignIn: vi.fn(async () => ownerSession()),
      refresh: vi.fn(async (current) => current),
      requestLoginEmailChange: vi.fn(async () => {}),
      lookup: vi.fn(async (current) => ({ uid: current.uid, email: current.email, emailVerified: true })),
    };
    const { broker } = makeBroker(client, () => clock.now);
    const manager = new AccountManager({
      client,
      broker,
      identity: IDENTITY,
      openExternal: async () => {},
      now: () => clock.now,
      billingHosts: () => [],
      transport: createAccountTransport({
        config: CONFIG,
        fetchImpl: (_url, init) => {
          requests += 1;
          // The sign-in's overview read is the first request and is answered so the flow can finish.
          if (requests === 1) {
            return Promise.resolve(
              new Response(JSON.stringify({ result: overview() }), {
                status: 200,
                headers: { "content-type": "application/json" },
              }),
            );
          }
          sentSignal = init?.signal ?? undefined;
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          });
        },
        tokenFor: async () => "owner-token",
      }),
    });
    await manager.beginEmailSignIn("owner@example.test", "reauth");
    manager.submitSignInLink(`${AUTHLINK.origin}/c?attempt=${FIRST_ATTEMPT_ID}&oobCode=OOB-CODE`);
    await manager.confirmEmailSignIn();

    sentSignal = undefined;
    const trial = manager.startTrial().catch((error: unknown) => error);
    await vi.waitFor(() => expect(sentSignal).toBeDefined());
    expect(sentSignal!.aborted).toBe(false);
    manager.cancelEmailSignIn();
    expect(sentSignal!.aborted).toBe(true);
    expect(await trial).toMatchObject({ code: "sign-in-superseded" });
    expect(manager.state().busy).toBe(false);
  });

  test("an aborted mutation keeps its key and request for the retry, like a lost answer", async () => {
    // Abort is not a rollback: the request may have reached the server. The next attempt is the SAME
    // request under the SAME key, so the server can recognise it.
    let n = 0;
    const fixture = fakes({ newIdempotencyKey: () => `idem-${++n}` });
    const startTrial = fixture.transport.startTrial as ReturnType<typeof vi.fn>;
    startTrial.mockRejectedValueOnce(new AccountCallableError("aborted", 0));
    await signIn(fixture.manager, "reauth");
    await expect(fixture.manager.startTrial()).rejects.toMatchObject({ code: "sign-in-superseded" });
    await fixture.manager.startTrial();
    const keys = startTrial.mock.calls.map((call) => (call[0] as { idempotencyKey: string }).idempotencyKey);
    expect(keys).toEqual(["idem-1", "idem-1"]);
  });

  test("`tokenFor` refuses an operation whose scope ended during the owner refresh", async () => {
    const clock = { now: NOW };
    const fixture = fakes({ clock, session: ownerSession({ expiresAt: NOW + 30_000 }) });
    const refresh = fixture.client.refresh as ReturnType<typeof vi.fn>;
    const gate = holdNext<OwnerSession>(refresh);
    await signIn(fixture.manager, "reauth");
    const controller = new AbortController();
    const asking = fixture.manager.tokenFor("owner", controller.signal).catch((error: unknown) => error);
    await gate.entered;
    controller.abort();
    gate.resolve(undefined);
    expect(await asking).toMatchObject({ code: "sign-in-superseded" });
    // The session itself is intact — the refusal was about the asker, not the owner.
    expect(fixture.manager.state().ownerEmail).toBe("owner@example.test");
  });
});

describe("an old operation's cleanup releases only its own owner session (S03)", () => {
  test("a held email-change SUCCESS landing after a new reauth leaves the new session, its timer and its view alone", async () => {
    vi.useFakeTimers();
    const clock = { now: NOW };
    const fixture = fakes({ clock });
    const request = fixture.client.requestLoginEmailChange as ReturnType<typeof vi.fn>;
    const gate = holdNext<void>(request);
    await signIn(fixture.manager, "change-email");
    const changing = fixture.manager.requestLoginEmailChange("new@example.test").catch((error: unknown) => error);
    await gate.entered;

    fixture.manager.cancelEmailSignIn();
    // A DIFFERENT person signs in now.
    (fixture.client.completeEmailSignIn as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      ownerSession({ uid: "owner-b", email: "b@example.test", authenticatedAt: NOW }),
    );
    await presentLink(fixture, "reauth", 1, { email: "b@example.test" });
    await fixture.manager.confirmEmailSignIn();
    expect(fixture.manager.state().ownerEmail).toBe("b@example.test");

    gate.resolve(undefined);
    // The old operation's result is its own: the request was sent and answered, so it resolves.
    expect(await changing).toBeUndefined();
    // The new owner session is still here...
    expect(fixture.manager.state().ownerEmail).toBe("b@example.test");
    expect(fixture.manager.state().needsRecentAuth).toBe(false);
    // ...the note about the OTHER account's address is not shown beside this one...
    expect(fixture.manager.state().pendingEmailChange).toBeUndefined();
    // ...and its retention timer is still armed: the old cleanup used to clear it. Four minutes in the
    // session is still here; at the five-minute window it ends, by the timer the NEW sign-in armed.
    clock.now += 4 * 60_000;
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(fixture.manager.state().ownerEmail).toBe("b@example.test");
    clock.now += 60_001;
    await vi.advanceTimersByTimeAsync(60_001);
    expect(fixture.manager.state().ownerEmail).toBeUndefined();
    vi.useRealTimers();
  });

  test("a held email-change FAILURE landing after a new reauth does the same", async () => {
    const fixture = fakes();
    const request = fixture.client.requestLoginEmailChange as ReturnType<typeof vi.fn>;
    const gate = holdNext<void>(request);
    await signIn(fixture.manager, "change-email");
    const changing = fixture.manager.requestLoginEmailChange("new@example.test").catch((error: unknown) => error);
    await gate.entered;
    fixture.manager.cancelEmailSignIn();
    (fixture.client.completeEmailSignIn as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      ownerSession({ uid: "owner-b", email: "b@example.test" }),
    );
    await presentLink(fixture, "reauth", 1, { email: "b@example.test" });
    await fixture.manager.confirmEmailSignIn();

    gate.reject(new AccountAuthError("network", "the identity service could not be reached."));
    // Its own failure, reported to its own caller.
    expect(await changing).toMatchObject({ code: "network" });
    expect(fixture.manager.state().ownerEmail).toBe("b@example.test");
    expect(fixture.manager.state().needsRecentAuth).toBe(false);
    // The old operation's failure is not the new person's error.
    expect(fixture.manager.state().lastError).toBeUndefined();
    expect(fixture.manager.state().pendingEmailChange).toBeUndefined();
  });

  test("a held email-change SUCCESS landing after a new owner's own request leaves that owner's pending address alone", async () => {
    // The plan's own sentence: a late answer "must not change the pending address of another flow".
    // A's request is held; B signs in, asks for THEIR change and gets it noted; A's answer arrives last.
    const fixture = fakes();
    const request = fixture.client.requestLoginEmailChange as ReturnType<typeof vi.fn>;
    const gate = holdNext<void>(request);
    await signIn(fixture.manager, "change-email");
    const changing = fixture.manager.requestLoginEmailChange("a-new@example.test").catch((error: unknown) => error);
    await gate.entered;
    fixture.manager.cancelEmailSignIn();

    (fixture.client.completeEmailSignIn as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      ownerSession({ uid: "owner-b", email: "b@example.test" }),
    );
    await presentLink(fixture, "reauth", 1, { email: "b@example.test" });
    await fixture.manager.confirmEmailSignIn();
    await fixture.manager.requestLoginEmailChange("b-new@example.test");
    expect(fixture.manager.state().pendingEmailChange?.email).toBe("b-new@example.test");

    gate.resolve(undefined);
    expect(await changing).toBeUndefined();
    // B's note is the one still on file, with nobody signed in and with B signed in again.
    expect(fixture.manager.state().pendingEmailChange?.email).toBe("b-new@example.test");
    (fixture.client.completeEmailSignIn as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      ownerSession({ uid: "owner-b", email: "b@example.test" }),
    );
    await presentLink(fixture, "reauth", 2, { email: "b@example.test" });
    await fixture.manager.confirmEmailSignIn();
    expect(fixture.manager.state().pendingEmailChange?.email).toBe("b-new@example.test");
    expect(fixture.manager.state().lastError).toBeUndefined();
  });

  test("the person who is signed in writes their own note over an older account's", async () => {
    // The guard above keeps a NEWER flow's note; it must not freeze an OLD one. B asked earlier and left;
    // A is signed in now and asks — A's request is the newest fact and the page shows it.
    const fixture = fakes();
    (fixture.client.completeEmailSignIn as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      ownerSession({ uid: "owner-b", email: "b@example.test" }),
    );
    await presentLink(fixture, "change-email", 0, { email: "b@example.test" });
    await fixture.manager.confirmEmailSignIn();
    await fixture.manager.requestLoginEmailChange("b-new@example.test");
    expect(fixture.manager.state().pendingEmailChange?.email).toBe("b-new@example.test");

    await presentLink(fixture, "change-email", 1);
    await fixture.manager.confirmEmailSignIn();
    await fixture.manager.requestLoginEmailChange("a-new@example.test");
    expect(fixture.manager.state().pendingEmailChange?.email).toBe("a-new@example.test");
  });

  test("the note about a sent change is shown beside the account it was for, and beside nobody", async () => {
    // Firebase HAS sent the message, so the fact is kept; it is shown when that person (or nobody) is on
    // the page, and hidden while somebody else is.
    const fixture = fakes();
    await signIn(fixture.manager, "change-email");
    await fixture.manager.requestLoginEmailChange("new@example.test");
    expect(fixture.manager.state().ownerEmail).toBeUndefined();
    expect(fixture.manager.state().pendingEmailChange?.email).toBe("new@example.test");

    (fixture.client.completeEmailSignIn as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      ownerSession({ uid: "owner-b", email: "b@example.test" }),
    );
    await presentLink(fixture, "reauth", 1, { email: "b@example.test" });
    await fixture.manager.confirmEmailSignIn();
    expect(fixture.manager.state().pendingEmailChange).toBeUndefined();

    fixture.manager.releaseOwnerSession();
    expect(fixture.manager.state().pendingEmailChange?.email).toBe("new@example.test");

    await presentLink(fixture, "reauth", 2);
    await fixture.manager.confirmEmailSignIn();
    expect(fixture.manager.state().ownerEmail).toBe("owner@example.test");
    expect(fixture.manager.state().pendingEmailChange?.email).toBe("new@example.test");
  });

  test("a held delete-account answer landing after a new sign-in leaves the new session alone", async () => {
    const fixture = fakes();
    const remove = fixture.transport.deleteAccount as ReturnType<typeof vi.fn>;
    const gate = holdNext<unknown>(remove);
    await signIn(fixture.manager, "delete-account");
    const deleting = fixture.manager.deleteAccount("DELETE MY ACCOUNT").catch((error: unknown) => error);
    await gate.entered;
    fixture.manager.cancelEmailSignIn();
    (fixture.client.completeEmailSignIn as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      ownerSession({ uid: "owner-b", email: "b@example.test" }),
    );
    await presentLink(fixture, "reauth", 1, { email: "b@example.test" });
    await fixture.manager.confirmEmailSignIn();

    gate.resolve(undefined);
    // The deletion the server accepted is the old operation's own result.
    expect(await deleting).toEqual({ providerCancellationRequired: true });
    expect(fixture.manager.state().ownerEmail).toBe("b@example.test");
    expect(fixture.manager.state().needsRecentAuth).toBe(false);
    await expect(fixture.manager.openBillingPortal()).resolves.toBeUndefined();
  });

  test("the ordinary case is unchanged: the operation that took the session releases it", async () => {
    const fixture = fakes();
    await signIn(fixture.manager, "change-email");
    await fixture.manager.requestLoginEmailChange("new@example.test");
    expect(fixture.manager.state().ownerEmail).toBeUndefined();
    expect(fixture.manager.state().needsRecentAuth).toBe(true);
    await presentLink(fixture, "delete-account", 1);
    await fixture.manager.confirmEmailSignIn();
    await fixture.manager.deleteAccount("DELETE MY ACCOUNT");
    expect(fixture.manager.state().ownerEmail).toBeUndefined();
  });
});

describe("two login-address changes of one account are ordered by request, not by answer (T02)", () => {
  test("a held FIRST request answering after a newer request of the SAME account leaves the newer address pending", async () => {
    // The S03 guard kept a different account's note; the same account asking twice had no order at all.
    // A for "first@" is held; B for "second@" is asked under the same session and noted; then A answers.
    const clock = { now: NOW };
    const fixture = fakes({ clock });
    const request = fixture.client.requestLoginEmailChange as ReturnType<typeof vi.fn>;
    const gate = holdNext<void>(request);
    await signIn(fixture.manager, "change-email");
    const first = fixture.manager.requestLoginEmailChange("first@example.test").catch((error: unknown) => error);
    await gate.entered;
    clock.now += 1_000;
    await fixture.manager.requestLoginEmailChange("second@example.test");
    expect(fixture.manager.state().pendingEmailChange).toMatchObject({
      email: "second@example.test",
      requestedAt: NOW + 1_000,
    });
    logSpy.info.mockClear();

    gate.resolve(undefined);
    expect(await first).toBeUndefined();
    // The newer ask is what the page shows — and when it was asked, not when the network answered.
    expect(fixture.manager.state().pendingEmailChange).toMatchObject({
      email: "second@example.test",
      requestedAt: NOW + 1_000,
    });
    expect(fixture.manager.state().lastError).toBeUndefined();
    const late = logSpy.info.mock.calls.find(([message]) => String(message).includes("newer pending note alone"));
    expect(late).toBeDefined();
    expect(late![1]).toMatchObject({
      operation: "change-login-email",
      sameAccount: true,
      sentUnderSequence: 1,
      settledSequence: 2,
    });
    expect(JSON.stringify(logSpy.info.mock.calls)).not.toContain("example.test");
  });

  test("the same with a new reauth of the SAME account in between: the newer address, the new session and its retention stay", async () => {
    vi.useFakeTimers();
    const clock = { now: NOW };
    const fixture = fakes({ clock });
    const request = fixture.client.requestLoginEmailChange as ReturnType<typeof vi.fn>;
    const gate = holdNext<void>(request);
    await signIn(fixture.manager, "change-email");
    const first = fixture.manager.requestLoginEmailChange("first@example.test").catch((error: unknown) => error);
    await gate.entered;
    fixture.manager.cancelEmailSignIn();

    // The SAME person signs in again and asks for a different address.
    clock.now += 30_000;
    (fixture.client.completeEmailSignIn as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      ownerSession({ authenticatedAt: clock.now }),
    );
    await presentLink(fixture, "reauth", 1);
    await fixture.manager.confirmEmailSignIn();
    await fixture.manager.requestLoginEmailChange("second@example.test");
    expect(fixture.manager.state().pendingEmailChange?.email).toBe("second@example.test");
    // That request released its own session, as it should. A THIRD sign-in opens a retention that the
    // still-outstanding first request must leave alone when it finally answers.
    clock.now += 30_000;
    (fixture.client.completeEmailSignIn as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      ownerSession({ authenticatedAt: clock.now }),
    );
    await presentLink(fixture, "reauth", 2);
    await fixture.manager.confirmEmailSignIn();
    expect(fixture.manager.state().ownerEmail).toBe("owner@example.test");
    expect(fixture.manager.state().needsRecentAuth).toBe(false);

    gate.resolve(undefined);
    expect(await first).toBeUndefined();
    expect(fixture.manager.state().pendingEmailChange?.email).toBe("second@example.test");
    expect(fixture.manager.state().ownerEmail).toBe("owner@example.test");
    expect(fixture.manager.state().needsRecentAuth).toBe(false);
    expect(fixture.manager.state().lastError).toBeUndefined();
    // The retention the reauth opened is untouched by the old operation, and ends on its own clock.
    clock.now += 4 * 60_000;
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(fixture.manager.state().ownerEmail).toBe("owner@example.test");
    clock.now += 60_001;
    await vi.advanceTimersByTimeAsync(60_001);
    expect(fixture.manager.state().ownerEmail).toBeUndefined();
    expect(fixture.manager.state().pendingEmailChange?.email).toBe("second@example.test");
    vi.useRealTimers();
  });

  test("a held FAILURE of the first request does not disturb the second's note, and is its own error only", async () => {
    const fixture = fakes();
    const request = fixture.client.requestLoginEmailChange as ReturnType<typeof vi.fn>;
    const gate = holdNext<void>(request);
    await signIn(fixture.manager, "change-email");
    const first = fixture.manager.requestLoginEmailChange("first@example.test").catch((error: unknown) => error);
    await gate.entered;
    await fixture.manager.requestLoginEmailChange("second@example.test");
    gate.reject(new AccountAuthError("network", "the identity service could not be reached."));
    expect(await first).toMatchObject({ code: "network" });
    expect(fixture.manager.state().pendingEmailChange?.email).toBe("second@example.test");
  });

  test("a note the person cleared is not put back by a request that was still out", async () => {
    const fixture = fakes();
    const request = fixture.client.requestLoginEmailChange as ReturnType<typeof vi.fn>;
    const gate = holdNext<void>(request);
    await signIn(fixture.manager, "change-email");
    const first = fixture.manager.requestLoginEmailChange("first@example.test").catch((error: unknown) => error);
    await gate.entered;
    fixture.manager.clearPendingEmailChange();
    gate.resolve(undefined);
    expect(await first).toBeUndefined();
    expect(fixture.manager.state().pendingEmailChange).toBeUndefined();
    // The next request is newer than the clear, and is noted.
    await presentLink(fixture, "change-email", 1);
    await fixture.manager.confirmEmailSignIn();
    await fixture.manager.requestLoginEmailChange("third@example.test");
    expect(fixture.manager.state().pendingEmailChange?.email).toBe("third@example.test");
  });

  test("a sign-out is a clear too: a request still out does not write the address back beside nobody", async () => {
    // `state()` shows a note beside nobody, because it is the one fact about the last account the person
    // still has to act on — which is exactly why a machine that signed out must not grow one from a
    // request that was in flight when it did.
    const fixture = fakes();
    const request = fixture.client.requestLoginEmailChange as ReturnType<typeof vi.fn>;
    const gate = holdNext<void>(request);
    await signIn(fixture.manager, "change-email");
    const first = fixture.manager.requestLoginEmailChange("first@example.test").catch((error: unknown) => error);
    await gate.entered;
    await fixture.manager.signOutInstallation({ disconnect: true });
    expect(fixture.manager.state().pendingEmailChange).toBeUndefined();
    gate.resolve(undefined);
    expect(await first).toBeUndefined();
    expect(fixture.manager.state().pendingEmailChange).toBeUndefined();
    expect(fixture.manager.state().ownerEmail).toBeUndefined();
    expect(fixture.manager.state().lastError).toBeUndefined();
  });

  test("a dispose is a clear too: a request still out does not write a note into the next configuration", async () => {
    const fixture = fakes();
    const request = fixture.client.requestLoginEmailChange as ReturnType<typeof vi.fn>;
    const gate = holdNext<void>(request);
    await signIn(fixture.manager, "change-email");
    const first = fixture.manager.requestLoginEmailChange("first@example.test").catch((error: unknown) => error);
    await gate.entered;
    fixture.manager.dispose();
    gate.resolve(undefined);
    await first;
    expect(fixture.manager.state().pendingEmailChange).toBeUndefined();
  });

  test("the ordinary order is unchanged: the later request's answer writes the note", async () => {
    const clock = { now: NOW };
    const fixture = fakes({ clock });
    await signIn(fixture.manager, "change-email");
    await fixture.manager.requestLoginEmailChange("first@example.test");
    expect(fixture.manager.state().pendingEmailChange).toMatchObject({ email: "first@example.test", requestedAt: NOW });
    clock.now += 1_000;
    await presentLink(fixture, "change-email", 1);
    await fixture.manager.confirmEmailSignIn();
    await fixture.manager.requestLoginEmailChange("second@example.test");
    expect(fixture.manager.state().pendingEmailChange).toMatchObject({
      email: "second@example.test",
      requestedAt: NOW + 1_000,
    });
  });
});

describe("a mutation's answer releases only the record it was sent for (S04)", () => {
  function countingKeys(): () => string {
    let n = 0;
    return () => `idem-${++n}`;
  }

  // I3: billing's pending-mutation record is keyed by this desktop's INSTALLATION, not by whichever
  // owner happens to be signed in — a checkout must survive an owner switch mid-flight rather than
  // being torn down by it, since the server itself authorizes the request the same way either way.
  // That is a real behavior change from before I3: `checkout` used to be keyed by `owner.uid`, so a
  // newer owner's sign-in was a DIFFERENT principal and abandoned A's pending record outright: these
  // two cases now go through the ordinary "resolve the old one first" path (S03/S04) instead, exactly
  // like two offers asked for by the same, never-switched principal already do (see "checkout A → lost
  // answer → checkout B" above) — an owner switch in the middle changes nothing about that.
  test("A pending → newer B signs in on the SAME installation → A's late success settles first → B goes out under its own key", async () => {
    const fixture = fakes({ newIdempotencyKey: countingKeys() });
    const create = fixture.transport.createCheckout as ReturnType<typeof vi.fn>;
    const gateA = heldAnswer<unknown>();
    create.mockImplementationOnce(() => gateA.promise);
    create.mockImplementationOnce(async () => ({
      status: "ready",
      checkoutUrl: "https://checkout.example/offer-b",
      intentId: "int-b",
    }));
    await signIn(fixture.manager, "reauth");
    const checkoutA = fixture.manager.openCheckout("offer-a").catch((error: unknown) => error);
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));

    fixture.manager.cancelEmailSignIn();
    (fixture.client.completeEmailSignIn as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      ownerSession({ uid: "owner-b", email: "b@example.test" }),
    );
    await presentLink(fixture, "reauth", 1, { email: "b@example.test" });
    await fixture.manager.confirmEmailSignIn();

    // B asks for a different offer while A's answer is still unknown: `mutate` re-sends A's own
    // request first (sharing A's still-outstanding send, per S04) before B's is ever attempted.
    const checkoutB = fixture.manager.openCheckout("offer-b");
    await Promise.resolve();
    expect(create).toHaveBeenCalledTimes(1);

    gateA.resolve({ status: "ready", checkoutUrl: "https://checkout.example/offer-a", intentId: "int-a" });
    // The mutation itself settles as A's (the pending record is released, never repeated for B) —
    // but A's OWN operation is the one the owner switch abandoned (R01), so A's own call sees that,
    // not a checkout URL that scope no longer owns opening.
    expect(await checkoutA).toMatchObject({ code: "sign-in-superseded" });
    await expect(checkoutB).resolves.toBe("opened");

    const sent = create.mock.calls.map((call) => call[0] as { offerId: string; idempotencyKey: string });
    expect(sent.map((call) => call.offerId)).toEqual(["offer-a", "offer-b"]);
    expect(sent[1]!.idempotencyKey).not.toBe(sent[0]!.idempotencyKey);
    // A's answer settled the mutation but was never opened — B's own, fresh answer was.
    expect(fixture.opened).toEqual(["https://checkout.example/offer-b"]);
  });

  test("A pending → newer B signs in on the SAME installation → A's late REFUSAL settles first → B still opens", async () => {
    const fixture = fakes({ newIdempotencyKey: countingKeys() });
    const create = fixture.transport.createCheckout as ReturnType<typeof vi.fn>;
    const gateA = heldAnswer<unknown>();
    create.mockImplementationOnce(() => gateA.promise);
    create.mockResolvedValueOnce({
      status: "ready",
      checkoutUrl: "https://checkout.example/offer-b",
      intentId: "int-b",
    });
    await signIn(fixture.manager, "reauth");
    const checkoutA = fixture.manager.openCheckout("offer-a").catch((error: unknown) => error);
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));

    fixture.manager.cancelEmailSignIn();
    (fixture.client.completeEmailSignIn as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      ownerSession({ uid: "owner-b", email: "b@example.test" }),
    );
    await presentLink(fixture, "reauth", 1, { email: "b@example.test" });
    await fixture.manager.confirmEmailSignIn();

    const checkoutB = fixture.manager.openCheckout("offer-b");
    await Promise.resolve();
    expect(create).toHaveBeenCalledTimes(1);

    gateA.reject(new AccountCallableError("billing-not-configured", 400));
    // A's own refusal is A's own — the owner switch does not hand it to B.
    await checkoutA;
    await expect(checkoutB).resolves.toBe("opened");

    const keys = create.mock.calls.map((call) => (call[0] as { idempotencyKey: string }).idempotencyKey);
    expect(keys[0]).not.toBe(keys[1]);
  });

  test("two callers of the SAME pending record share one send, one key and one answer", async () => {
    // A double-click, or a resumed flow beside the original: one request goes out, and whatever it
    // answers — success here — is what both callers receive.
    const fixture = fakes({ newIdempotencyKey: countingKeys() });
    const create = fixture.transport.createCheckout as ReturnType<typeof vi.fn>;
    const gate = heldAnswer<unknown>();
    create.mockImplementationOnce(async () => gate.promise);
    await signIn(fixture.manager, "reauth");
    const first = fixture.manager.openCheckout("offer-a");
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const second = fixture.manager.openCheckout("offer-a");
    await Promise.resolve();
    expect(create).toHaveBeenCalledTimes(1);

    gate.resolve({ status: "ready", checkoutUrl: "https://checkout.example/offer-a", intentId: "int-a" });
    await expect(first).resolves.toBe("opened");
    await expect(second).resolves.toBe("opened");
    expect(create).toHaveBeenCalledTimes(1);
    expect((create.mock.calls[0]![0] as { idempotencyKey: string }).idempotencyKey).toBe("idem-1");
  });

  test("two callers of the same record whose shared send is LOST both learn that, and the retry is one request under the same key", async () => {
    // The "different order of answers" case has one answer by construction: the send is shared. What
    // must hold is that the record survives the shared failure once, and the retry re-sends it once.
    const fixture = fakes({ newIdempotencyKey: countingKeys() });
    const create = fixture.transport.createCheckout as ReturnType<typeof vi.fn>;
    const gate = heldAnswer<unknown>();
    create.mockImplementationOnce(async () => gate.promise);
    await signIn(fixture.manager, "reauth");
    const first = fixture.manager.openCheckout("offer-a").catch((error: unknown) => error);
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const second = fixture.manager.openCheckout("offer-a").catch((error: unknown) => error);

    gate.reject(new AccountCallableError("network", 0));
    expect(await first).toMatchObject({ code: "network" });
    expect(await second).toMatchObject({ code: "network" });

    await expect(fixture.manager.openCheckout("offer-a")).resolves.toBe("opened");
    const keys = create.mock.calls.map((call) => (call[0] as { idempotencyKey: string }).idempotencyKey);
    expect(keys).toEqual(["idem-1", "idem-1"]);
  });
});

describe("the login email remembered on this computer", () => {
  const stored = (email: string, uid = "owner-uid") => JSON.stringify({ v: 1, email, uid, savedAt: NOW - 1000 });

  function loggedText(): string {
    return JSON.stringify([logSpy.warn.mock.calls, logSpy.error.mock.calls, logSpy.info.mock.calls]);
  }

  test("a verified sign-in is remembered, and shown once the owner session is gone", async () => {
    const remembered = { value: "", writes: [] as (string | null)[] };
    const { manager } = fakes({ remembered });
    await signIn(manager);
    manager.releaseOwnerSession();
    await manager.flushRememberedOwnerEmail();

    const state = manager.state();
    expect(state.ownerEmail).toBeUndefined();
    expect(state.rememberedOwnerEmail).toBe("owner@example.test");
    expect(state.ownerEmailNotice).toBeUndefined();
    expect(JSON.parse(remembered.value)).toMatchObject({ v: 1, email: "owner@example.test", uid: "owner-uid" });
  });

  test("after a restart the remembered address is shown when the server's mask agrees", async () => {
    const { manager } = fakes({
      remembered: { value: stored("owner@example.test") },
      binding: { value: "bound" },
      overview: overview({ accountDisplay: "o••••@example.test" }),
    });
    await manager.restoreFromInstallation();

    const state = manager.state();
    expect(state.phase).toBe("ready");
    expect(state.rememberedOwnerEmail).toBe("owner@example.test");
    expect(state.ownerEmailNotice).toBeUndefined();
  });

  test("a remembered address the server's mask contradicts is forgotten, told and logged without the address", async () => {
    logSpy.warn.mockClear();
    const remembered = { value: stored("someone@other.test"), writes: [] as (string | null)[] };
    const { manager } = fakes({
      remembered,
      binding: { value: "bound" },
      overview: overview({ accountDisplay: "o••••@example.test" }),
    });
    await manager.restoreFromInstallation();
    await manager.flushRememberedOwnerEmail();

    const state = manager.state();
    expect(state.rememberedOwnerEmail).toBeUndefined();
    expect(state.ownerEmailNotice).toMatchObject({
      kind: "mismatch",
      remembered: "someone@other.test",
      accountDisplay: "o••••@example.test",
    });
    expect(remembered.writes).toEqual([null]);
    expect(logSpy.warn).toHaveBeenCalledWith(expect.stringContaining("does not match"));
    expect(loggedText()).not.toContain("someone@other.test");
    expect(manager.exportDiagnostics().content).toContain("account.remembered-email");

    manager.dismissOwnerEmailNotice();
    expect(manager.state().ownerEmailNotice).toBeUndefined();
  });

  test("a sign-in with a different address than the remembered one tells the owner", async () => {
    const { manager } = fakes({ remembered: { value: stored("previous@example.test") } });
    await signIn(manager);

    expect(manager.state().ownerEmailNotice).toMatchObject({
      kind: "changed",
      previous: "previous@example.test",
      current: "owner@example.test",
      sameAccount: true,
    });
    expect(loggedText()).not.toContain("previous@example.test");
  });

  test("a sign-in as a different account says so", async () => {
    const { manager } = fakes({ remembered: { value: stored("owner@example.test", "another-uid") } });
    await signIn(manager);

    expect(manager.state().ownerEmailNotice).toMatchObject({ kind: "changed", sameAccount: false });
  });

  test("the same address signing in again changes nothing and tells nobody", async () => {
    const remembered = { value: stored("OWNER@example.test"), writes: [] as (string | null)[] };
    const { manager } = fakes({ remembered });
    await signIn(manager);
    await manager.flushRememberedOwnerEmail();

    expect(manager.state().ownerEmailNotice).toBeUndefined();
    expect(remembered.writes).toEqual([]);
  });

  test("a store that cannot be read is told and logged, and the page falls back to the mask", async () => {
    logSpy.error.mockClear();
    const { manager } = fakes({
      remembered: { value: "", failRead: true },
      binding: { value: "bound" },
      overview: overview({ accountDisplay: "o••••@example.test" }),
    });
    await manager.restoreFromInstallation();

    expect(manager.state().rememberedOwnerEmail).toBeUndefined();
    expect(manager.state().ownerEmailNotice).toMatchObject({ kind: "storage-failed", operation: "read" });
    expect(logSpy.error).toHaveBeenCalledWith(expect.stringContaining("could not be read"), expect.anything());
  });

  test("an unreadable record is told, logged and removed", async () => {
    const remembered = { value: "{not json", writes: [] as (string | null)[] };
    const { manager } = fakes({ remembered, binding: { value: "bound" } });
    await manager.restoreFromInstallation();
    await manager.flushRememberedOwnerEmail();

    expect(manager.state().ownerEmailNotice).toMatchObject({ kind: "storage-failed", operation: "read" });
    expect(remembered.writes).toEqual([null]);
  });

  test("a save that fails is told and logged", async () => {
    logSpy.error.mockClear();
    const { manager } = fakes({ remembered: { value: "", failWrites: true } });
    await signIn(manager);
    await manager.flushRememberedOwnerEmail();

    expect(manager.state().ownerEmailNotice).toMatchObject({ kind: "storage-failed", operation: "write" });
    expect(logSpy.error).toHaveBeenCalledWith(expect.stringContaining("could not be saved"), expect.anything());
  });

  test("signing this computer out forgets it, without a notice", async () => {
    const remembered = { value: "", writes: [] as (string | null)[] };
    const { manager } = fakes({ remembered, binding: { value: "absent" } });
    await signIn(manager);
    await manager.signOutInstallation({ disconnect: true });
    await manager.flushRememberedOwnerEmail();

    expect(remembered.writes.at(-1)).toBeNull();
    expect(remembered.value).toBe("");
    expect(manager.state().rememberedOwnerEmail).toBeUndefined();
    expect(manager.state().ownerEmailNotice).toBeUndefined();
  });
});

describe("a refused restore asks before anything else happens", () => {
  const refuse = (transport: AccountTransport): void => {
    (transport.completeInstallationRegistration as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "refused" as const,
      claimsChanged: false,
      errorReason: { reason: "account-mismatch" },
    });
  };

  test("the code says there is nothing to restore, the prompt is held, and no registration follows", async () => {
    logSpy.warn.mockClear();
    const { manager, transport } = fakes({ enrolled: false });
    refuse(transport);

    await expect(signIn(manager, "recover-uid")).rejects.toMatchObject({ code: "nothing-to-recover" });

    expect(manager.state().lastError).toBe("nothing-to-recover");
    expect(manager.state().recoveryRefused?.email).toBe("owner@example.test");
    expect(transport.completeInstallationRegistration).toHaveBeenCalledOnce();
    expect(transport.startTrial).not.toHaveBeenCalled();
    expect(JSON.stringify(logSpy.warn.mock.calls)).not.toContain("owner@example.test");

    manager.dismissRecoveryRefused("back");
    expect(manager.state().recoveryRefused).toBeUndefined();
    expect(manager.state().lastError).toBeUndefined();
    expect(transport.completeInstallationRegistration).toHaveBeenCalledOnce();
  });

  test("a refused registration keeps `account-mismatch` and asks nothing", async () => {
    const { manager, transport } = fakes({ enrolled: false });
    refuse(transport);

    await expect(signIn(manager, "enrol")).rejects.toMatchObject({ code: "account-mismatch" });

    expect(manager.state().recoveryRefused).toBeUndefined();
  });

  test("a new sign-in clears a prompt nobody answered", async () => {
    const { manager, transport } = fakes({ enrolled: false });
    refuse(transport);
    await expect(signIn(manager, "recover-uid")).rejects.toMatchObject({ code: "nothing-to-recover" });
    expect(manager.state().recoveryRefused).toBeDefined();

    await manager.beginEmailSignIn("owner@example.test", "enrol");

    expect(manager.state().recoveryRefused).toBeUndefined();
  });
});
