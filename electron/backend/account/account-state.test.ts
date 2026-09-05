// What the renderer is told, and what it is never told.
//
// The half of this file that matters most is the second: an assertion about what the broadcast state
// does NOT contain. A token, a password, a provider id or a portal URL in a state diff is in every
// window's memory, in every devtools console and in every log line that dumps state — and none of
// those is a place any of them belongs.
import { describe, expect, test } from "vitest";

import {
  accountStateChanged,
  assessSignOut,
  deriveAccountState,
  mayBindDifferentAccount,
  signedOutState,
  toAccountErrorCode,
  unconfiguredState,
  type AccountStateInput,
} from "./account-state.js";
import type { AccountOverview } from "../mobile/mobile-schemas.js";

const NOW = 1_760_000_000_000;
const WINDOW = 5 * 60 * 1000;

function overview(patch: Partial<AccountOverview> = {}): AccountOverview {
  return {
    supportReference: "STR-1-ABCDEFGHJKMN",
    entitlement: { state: "active", source: "subscription", notAfter: NOW + 86_400_000 },
    offers: [],
    usage: {
      installations: { used: 1, limit: 5 },
      mobileDevices: { used: 1, limit: 5 },
      activeRelaySessions: { used: 0, limit: 8 },
    },
    installations: [{ installationId: "inst-1", registeredAt: NOW, isThisInstallation: true, state: "active" }],
    mobileDevices: [
      { mobileDeviceKeySuffix: "abcd1234", platform: "android", boundAt: NOW, state: "active", pairs: [] },
    ],
    notices: [],
    billingConfigured: true,
    generatedAt: NOW,
    ...patch,
  } as AccountOverview;
}

function input(patch: Partial<AccountStateInput> = {}): AccountStateInput {
  return {
    configured: true,
    owner: { email: "owner@example.test", emailVerified: true, authenticatedAt: NOW },
    installationRegistered: true,
    overview: overview(),
    busy: false,
    lastError: null,
    now: NOW,
    recentAuthWindowMs: WINDOW,
    ...patch,
  };
}

describe("the derived state", () => {
  test("walks the phases in order, and each one is a real gate", () => {
    expect(deriveAccountState({ ...input(), configured: false }).phase).toBe("unconfigured");
    // NOT enrolled yet: the sign-in, the wait for the link, and the enrolment, in that order. There is
    // no "verification pending" any more — redeeming the link IS the verification.
    expect(deriveAccountState(input({ installationRegistered: false, owner: null })).phase).toBe("signed-out");
    expect(
      deriveAccountState(
        input({
          installationRegistered: false,
          owner: null,
          auth: {
            phase: "awaiting-link",
            email: "a@b.test",
            purpose: "enrol",
            expiresAt: NOW + 900_000,
            canResendAt: NOW + 60_000,
            manualOnly: false,
            sendsUsed: 1,
            sendOutcome: "sent",
          },
        }),
      ).phase,
    ).toBe("signing-in");
    expect(deriveAccountState(input({ installationRegistered: false })).phase).toBe("enrolling");
    expect(deriveAccountState(input()).phase).toBe("ready");
  });

  test("an ENROLLED machine stays `ready` while its owner reauthenticates", () => {
    // Plan §8, Fáze 2: "Již zaregistrovaný desktop zůstává `ready`; reauth ani čekání na změnu adresy
    // nesmí skrýt přehled a zařízení." Hiding the device list behind a sign-in form is how somebody
    // loses the page that would have told them which machine to remove.
    const state = deriveAccountState(
      input({
        owner: null,
        auth: {
          phase: "awaiting-link",
          email: "owner@example.test",
          purpose: "reauth",
          expiresAt: NOW + 900_000,
          canResendAt: NOW + 60_000,
          manualOnly: false,
          sendsUsed: 1,
          sendOutcome: "sent",
        },
      }),
    );
    expect(state.phase).toBe("ready");
    expect(state.overview).toBeDefined();
    expect(state.auth?.phase).toBe("awaiting-link");
    // AND THE PENDING ADDRESS IS NOT AN OWNER EMAIL. Nobody has proved anything yet.
    expect(state.ownerEmail).toBeUndefined();
    expect(state.auth?.email).toBe("owner@example.test");
  });

  test("a build with no auth-link configuration says so, and stays otherwise intact", () => {
    const state = deriveAccountState(input({ signInAvailable: false }));
    expect(state.signInAvailable).toBe(false);
    expect(state.phase).toBe("ready");
    expect(state.entitlement?.state).toBe("active");
  });

  test("an ENROLLED machine with no owner session is ready, not signed out", () => {
    // R12. The owner credential is transient (plan §2): it is taken for an enrolment or a
    // destructive action and dropped when that finishes, so after a restart there is none. The old
    // ordering answered `signed-out` for exactly that state — a login form on a desktop that was
    // enrolled, entitled and working.
    const state = deriveAccountState(input({ owner: null }));
    expect(state.phase).toBe("ready");
    expect(state.installationRegistered).toBe(true);
    expect(state.ownerEmail).toBeUndefined();
    expect(state.entitlement?.state).toBe("active");
    // And a destructive action still asks for the password again, which is the thing the missing
    // owner session must not silently skip.
    expect(state.needsRecentAuth).toBe(true);
  });

  test("an unverified NEW login address is a banner, not a phase that stops the machine working", () => {
    // Changing the login email leaves the new address unverified. The person has to be told; the
    // enrolled installation's entitlement does not depend on it, and hiding the account page behind
    // it would be telling them their machine had stopped working.
    const state = deriveAccountState(
      input({ owner: { email: "new@b.test", emailVerified: false, authenticatedAt: NOW } }),
    );
    expect(state.phase).toBe("ready");
    expect(state.ownerVerificationPending).toBe(true);
    expect(deriveAccountState(input()).ownerVerificationPending).toBeUndefined();
  });

  test("the entitlement shown is the SERVER's, and it is absent until there is an overview", () => {
    // A renderer that could infer "paid" from anything local would be a renderer that can be edited
    // into paying nothing.
    expect(deriveAccountState(input()).entitlement?.state).toBe("active");
    expect(deriveAccountState(input({ overview: null })).entitlement).toBeUndefined();
  });

  test("recent-auth is derived, not remembered, and expires at the window's edge", () => {
    expect(deriveAccountState(input()).needsRecentAuth).toBe(false);
    expect(deriveAccountState(input({ now: NOW + WINDOW })).needsRecentAuth).toBe(false);
    expect(deriveAccountState(input({ now: NOW + WINDOW + 1 })).needsRecentAuth).toBe(true);
    expect(deriveAccountState(input({ owner: null })).needsRecentAuth).toBe(true);
  });

  test("the state carries NO token, password, provider id, account id or URL", () => {
    const state = deriveAccountState(
      input({
        overview: overview({ supportReference: "STR-1-ABCDEFGHJKMN" }),
      }),
    );
    const text = JSON.stringify(state);
    for (const forbidden of [
      "idToken",
      "refreshToken",
      "password",
      "ctm_",
      "sub_",
      "checkoutUrl",
      "portalUrl",
      "entitlementId",
      "accountId",
    ]) {
      expect(text).not.toContain(forbidden);
    }
    // What it DOES carry: the support reference a person quotes, and the login address.
    expect(text).toContain("STR-1-ABCDEFGHJKMN");
    expect(state.ownerEmail).toBe("owner@example.test");
  });

  test("a signed-out state carries no email at all", () => {
    expect(deriveAccountState(input({ owner: null })).ownerEmail).toBeUndefined();
    expect(signedOutState("network").lastError).toBe("network");
    expect(unconfiguredState().phase).toBe("unconfigured");
  });

  test("an identical refresh does not wake every window", () => {
    const first = deriveAccountState(input());
    expect(accountStateChanged(null, first)).toBe(true);
    expect(accountStateChanged(first, deriveAccountState(input()))).toBe(false);
    expect(accountStateChanged(first, deriveAccountState(input({ busy: true })))).toBe(true);
  });
});

describe("signing out", () => {
  test("live pairings and relay sessions are named as blockers, with their counts", () => {
    const assessment = assessSignOut(
      overview({
        usage: {
          installations: { used: 1, limit: 5 },
          mobileDevices: { used: 2, limit: 5 },
          activeRelaySessions: { used: 2, limit: 8 },
        },
        mobileDevices: [
          { mobileDeviceKeySuffix: "a", platform: "android", boundAt: NOW, state: "active", pairs: [] },
          { mobileDeviceKeySuffix: "b", platform: "ios", boundAt: NOW, state: "revoked", pairs: [] },
        ],
      } as Partial<AccountOverview>),
    );
    expect(assessment.blockers).toEqual(["active-pairings", "active-relay-sessions"]);
    expect(assessment.pairedDevices).toBe(1);
    expect(assessment.activeRelaySessions).toBe(2);
  });

  test("nothing attached means nothing to warn about", () => {
    const assessment = assessSignOut(overview({ mobileDevices: [] } as Partial<AccountOverview>));
    expect(assessment.blockers).toEqual([]);
    expect(assessSignOut(null).blockers).toEqual([]);
  });

  test("binding a DIFFERENT account is refused while account-bound data is still attached", () => {
    // Re-binding a machine whose pairings and relay identity belong to another account is how one
    // person's phone ends up listed under somebody else's account.
    expect(mayBindDifferentAccount(overview(), true)).toBe(false);
    expect(mayBindDifferentAccount(overview({ mobileDevices: [] } as Partial<AccountOverview>), true)).toBe(true);
    expect(mayBindDifferentAccount(overview(), false)).toBe(true);
  });
});

describe("error codes", () => {
  test("a structured code, a structured reason and our own refusal text all resolve", () => {
    expect(toAccountErrorCode({ code: "expired-code" })).toBe("expired-code");
    expect(toAccountErrorCode({ code: "auth-unavailable" })).toBe("auth-unavailable");
    expect(toAccountErrorCode({ details: { reason: "installation-limit" } })).toBe("installation-limit");
    // A cap the transport already resolved to its specific code, and one it could not.
    expect(toAccountErrorCode({ code: "pairing-device-limit" })).toBe("pairing-device-limit");
    expect(toAccountErrorCode({ code: "cap-exceeded" })).toBe("cap-exceeded");
    // The raw details block, for a caller that hands the error through without the transport.
    expect(toAccountErrorCode({ details: { reason: "cap-exceeded" } })).toBe("cap-exceeded");
    expect(toAccountErrorCode({ message: "createCheckout rejected: already-subscribed" })).toBe("already-subscribed");
  });

  test("the server's own `reauthentication-required` reason lands on our `requires-recent-login` (plan §7/C2)", () => {
    // `requireRecentAuth` (M's `account-admission.ts`) writes this exact reason for
    // `deleteMyAccount`/`confirmOwnerForInstallation`/`revokeAccountDevice` alike — it is not one of
    // this closed set's own codes, so without the alias it fell through to `unknown`.
    expect(toAccountErrorCode({ code: "reauthentication-required" })).toBe("requires-recent-login");
    expect(toAccountErrorCode({ details: { reason: "reauthentication-required" } })).toBe("requires-recent-login");
    expect(toAccountErrorCode({ message: "revokeAccountDevice rejected: reauthentication-required" })).toBe(
      "requires-recent-login",
    );
  });

  test("anything else is `unknown` — a remote string is never shown to a user", () => {
    expect(toAccountErrorCode({ message: "Something went terribly wrong on server 14" })).toBe("unknown");
    expect(toAccountErrorCode({ code: "some-new-thing" })).toBe("unknown");
    expect(toAccountErrorCode(null)).toBe("unknown");
    expect(toAccountErrorCode(new Error("boom"))).toBe("unknown");
  });
});
