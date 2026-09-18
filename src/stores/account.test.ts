import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, test } from "vitest";

import { useAccountStore } from "./account.js";

describe("account checkout feedback", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  test("pending is reported, then a failed or successful action replaces it", async () => {
    let checkoutOutcome: "pending" | "opened" = "pending";
    let trialFails = true;
    const account = useAccountStore();
    account.attach({
      accountOpenCheckout: async () => checkoutOutcome,
      accountStartTrial: async () => {
        if (trialFails) throw Object.assign(new Error("provider refused"), { code: "provider-unavailable" });
      },
      accountRefreshOverview: async () => undefined,
    });

    await expect(account.openCheckout("personal-monthly")).resolves.toBe("pending");
    expect(account.actionError).toBe("checkout-pending");

    await account.startTrial();
    expect(account.actionError).toBe("provider-unavailable");

    trialFails = false;
    checkoutOutcome = "opened";
    await account.startTrial();
    expect(account.actionError).toBeNull();
    await expect(account.openCheckout("personal-monthly")).resolves.toBe("opened");
    expect(account.actionError).toBeNull();
  });
});
