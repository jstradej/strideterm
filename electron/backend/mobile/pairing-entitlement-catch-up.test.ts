// "Start trial", then straight to "Pair a phone": the overview already says `trial`, the installation
// token does not carry the claims yet, and the first invitation is refused with
// `entitlement-required`. A click a few seconds later worked — so the click itself has to wait for the
// token to catch up, and must not wait for an account the overview does not call entitled.

import { describe, expect, it, vi } from "vitest";

import { MobileFirebaseCallableError } from "./mobile-firebase-rest.js";
import { withPairingEntitlementCatchUp } from "./pairing-entitlement-catch-up.js";
import type { EntitlementSummary } from "./mobile-schemas.js";

const refusal = () =>
  new MobileFirebaseCallableError("createPairingInvitation", "PERMISSION_DENIED", "entitlement-required");

function harness(state: EntitlementSummary["state"] | undefined, refusals: number, error: () => Error = refusal) {
  const order: string[] = [];
  let calls = 0;
  const attempt = vi.fn(async () => {
    calls += 1;
    order.push(`attempt-${calls}`);
    if (calls <= refusals) throw error();
    return "invitation";
  });
  const deps = {
    ledgerState: () => state,
    refreshToken: vi.fn(async () => void order.push("refresh")),
    delaysMs: [0, 10, 20],
    sleep: vi.fn(async (ms: number) => void order.push(`sleep-${ms}`)),
  };
  return { attempt, deps, order };
}

describe("withPairingEntitlementCatchUp", () => {
  it("refreshes the token and retries while the overview says the trial is in force", async () => {
    const { attempt, deps, order } = harness("trial", 2);
    await expect(withPairingEntitlementCatchUp(attempt, deps)).resolves.toBe("invitation");
    expect(order).toEqual(["attempt-1", "sleep-0", "refresh", "attempt-2", "sleep-10", "refresh", "attempt-3"]);
  });

  it("refuses at once when the overview does not call the account entitled", async () => {
    for (const state of ["unbound", "lapsed", "revoked", "billing_unconfigured", undefined] as const) {
      const { attempt, deps } = harness(state, 1);
      await expect(withPairingEntitlementCatchUp(attempt, deps)).rejects.toMatchObject({
        reason: "entitlement-required",
      });
      expect(attempt).toHaveBeenCalledOnce();
      expect(deps.refreshToken).not.toHaveBeenCalled();
    }
  });

  it("does not retry any other failure", async () => {
    const { attempt, deps } = harness(
      "active",
      1,
      () => new MobileFirebaseCallableError("createPairingInvitation", "RESOURCE_EXHAUSTED", "daily-limit-reached"),
    );
    await expect(withPairingEntitlementCatchUp(attempt, deps)).rejects.toMatchObject({ reason: "daily-limit-reached" });
    expect(attempt).toHaveBeenCalledOnce();
  });

  it("gives up with the original refusal once the delays run out", async () => {
    const { attempt, deps } = harness("trial", Number.POSITIVE_INFINITY);
    await expect(withPairingEntitlementCatchUp(attempt, deps)).rejects.toMatchObject({
      reason: "entitlement-required",
    });
    expect(attempt).toHaveBeenCalledTimes(4);
    expect(deps.refreshToken).toHaveBeenCalledTimes(3);
  });
});
