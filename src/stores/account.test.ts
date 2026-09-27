import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { AccountUiState } from "../../electron/backend/account/account-state.js";
import { createTransport } from "../transport.js";
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
      accountCopyCheckoutUrl: async () => "copied",
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
    expect(account.checkoutLinkAvailable).toBe(true);
    await expect(account.copyCheckoutUrl()).resolves.toBe(true);
  });
});

describe("account event updates", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).strideterm;
  });

  test("the account:updated event advances a sign-in without a refresh", () => {
    const getAccountState = vi.fn(async () => ({ phase: "signed-out" as const }) as AccountUiState);
    let onAccountUpdated: ((payload: AccountUiState) => void) | undefined;
    const unsubscribe = vi.fn();
    (window as unknown as { strideterm: Record<string, unknown> }).strideterm = {
      getAccountState,
      onAccountUpdated: (handler: (payload: AccountUiState) => void) => {
        onAccountUpdated = handler;
        return unsubscribe;
      },
    };
    const account = useAccountStore();
    account.attach(createTransport());

    onAccountUpdated?.({
      phase: "signing-in",
      busy: false,
      installationRegistered: false,
      needsRecentAuth: true,
      signInAvailable: true,
      auth: {
        phase: "awaiting-link",
        email: "owner@example.com",
        purpose: "reauth",
        expiresAt: 1_800_000_000_000,
        canResendAt: 1_700_000_000_000,
        manualOnly: false,
        sendsUsed: 1,
        sendOutcome: "sent",
      },
    });
    expect(account.auth?.phase).toBe("awaiting-link");

    onAccountUpdated?.({
      phase: "signing-in",
      busy: false,
      installationRegistered: false,
      needsRecentAuth: true,
      signInAvailable: true,
      auth: {
        phase: "awaiting-confirmation",
        email: "owner@example.com",
        purpose: "reauth",
        expiresAt: 1_800_000_000_000,
        canResendAt: 1_700_000_000_000,
        manualOnly: false,
        sendsUsed: 1,
        sendOutcome: "sent",
      },
    });

    expect(account.auth?.phase).toBe("awaiting-confirmation");
    expect(getAccountState).not.toHaveBeenCalled();
    account.detach();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  test("online bootstrap progress is authoritative and retry/cancel use dedicated actions", async () => {
    const retry = vi.fn(async () => undefined);
    const cancel = vi.fn(async () => undefined);
    let onAccountUpdated: ((payload: AccountUiState) => void) | undefined;
    const account = useAccountStore();
    account.attach({
      onAccountUpdated: (handler) => {
        onAccountUpdated = handler;
        return () => {};
      },
      accountRetryOnlineBootstrap: retry,
      accountCancelOnlineBootstrap: cancel,
    });

    onAccountUpdated?.({
      phase: "signed-out",
      busy: false,
      installationRegistered: false,
      needsRecentAuth: true,
      signInAvailable: true,
      onlineBootstrap: {
        phase: "downloading",
        purpose: "refresh",
        url: "https://bootstrap.example.test/prod.json",
      },
    });
    expect(account.onlineBootstrap.phase).toBe("downloading");

    await account.retryOnlineBootstrap();
    await account.cancelOnlineBootstrap();
    expect(retry).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
  });
});
