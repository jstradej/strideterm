// The Account page, state by state.
//
// The assertions that matter are the ones about what is NOT on screen: no price this client
// assembled, no invoice, no checkout URL, and — in every lapsed state — the sentence that says the
// local app is free. The rest of the page is a rendering of what the server sent, and a test that
// re-derived the same value from the same input would only be checking that Vue works.
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ComponentPublicInstance } from "vue";

import SettingsAccountTab from "./SettingsAccountTab.vue";
import { ACCOUNT_ERROR_CODES } from "../../../../electron/backend/account/account-state.js";
import { useAccountStore } from "../../../stores/account.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyState = any;
type SettingsAccountTabProps = { view?: "overview" | "account" | "hidden"; phoneCount?: number; visible?: boolean };

const NOW = Date.UTC(2026, 2, 10);

function overview(patch: Record<string, unknown> = {}): AnyState {
  return {
    supportReference: "STR-1-ABCDEFGHJKMN",
    entitlement: {
      state: "active",
      source: "subscription",
      notAfter: NOW + 30 * 86_400_000,
      renewalAt: NOW + 27 * 86_400_000,
      planLabel: "strIDEterm",
    },
    offers: [
      { offerId: "personal-monthly", planLabel: "strIDEterm", formattedPrice: "€6 / month", billingPeriod: "monthly" },
      { offerId: "personal-annual", planLabel: "strIDEterm", formattedPrice: "€60 / year", billingPeriod: "annual" },
    ],
    usage: {
      installations: { used: 2, limit: 5 },
      mobileDevices: { used: 1, limit: 5 },
      activeRelaySessions: { used: 0, limit: 8 },
    },
    installations: [
      {
        installationId: "inst-1",
        label: "Workstation",
        registeredAt: NOW,
        lastSeenAt: NOW,
        isThisInstallation: true,
        state: "active",
      },
      { installationId: "inst-2", label: "Laptop", registeredAt: NOW, isThisInstallation: false, state: "active" },
    ],
    mobileDevices: [
      {
        mobileDeviceKeySuffix: "abcd1234",
        label: "Pixel",
        platform: "android",
        boundAt: NOW,
        lastSeenAt: NOW,
        state: "active",
        pairs: [],
      },
    ],
    notices: [],
    billingConfigured: true,
    generatedAt: NOW,
    ...patch,
  };
}

function stateFor(patch: Record<string, unknown> = {}): AnyState {
  return {
    phase: "ready",
    ownerEmail: "owner@example.test",
    busy: false,
    needsRecentAuth: false,
    signInAvailable: true,
    overview: overview(),
    entitlement: overview().entitlement,
    ...patch,
  };
}

/** A sign-in attempt in flight, as the backend broadcasts it: a substate, never a code. */
function authState(patch: Record<string, unknown> = {}): AnyState {
  return {
    phase: "awaiting-link",
    email: "owner@example.test",
    purpose: "reauth",
    expiresAt: NOW + 900_000,
    canResendAt: NOW - 1,
    manualOnly: false,
    sendsUsed: 1,
    sendOutcome: "sent",
    ...patch,
  };
}

/** A transport with every account method, recording what was called. */
function makeApi(state: AnyState, overrides: AnyState = {}) {
  const calls: { method: string; payload?: unknown }[] = [];
  const record = (method: string) => async (payload?: unknown) => {
    calls.push({ method, payload });
    return method === "accountOpenCheckout" ? "opened" : undefined;
  };
  return {
    calls,
    api: {
      // A COPY, the way a real IPC reply is: the payload crosses a structured clone, so the store
      // always receives a different object. A fake that returned the same reference would make the
      // ref assignment a no-op and hide a re-render that really does happen.
      getAccountState: async () => ({ ...state }),
      accountBeginSignIn: record("accountBeginSignIn"),
      accountConfirmSignIn: record("accountConfirmSignIn"),
      accountResendSignIn: record("accountResendSignIn"),
      accountCancelSignIn: record("accountCancelSignIn"),
      accountReleaseSignInFlow: record("accountReleaseSignInFlow"),
      accountSubmitSignInLink: record("accountSubmitSignInLink"),
      accountChangeLoginEmail: record("accountChangeLoginEmail"),
      accountClearPendingEmailChange: record("accountClearPendingEmailChange"),
      accountDismissOwnerEmailNotice: record("accountDismissOwnerEmailNotice"),
      accountDismissRecoveryRefused: record("accountDismissRecoveryRefused"),
      accountEnrolInstallation: record("accountEnrolInstallation"),
      accountStartTrial: record("accountStartTrial"),
      accountRefreshOverview: record("accountRefreshOverview"),
      accountOpenCheckout: record("accountOpenCheckout"),
      accountCopyCheckoutUrl: async (payload?: unknown) => {
        calls.push({ method: "accountCopyCheckoutUrl", payload });
        return "copied";
      },
      accountOpenBillingPortal: record("accountOpenBillingPortal"),
      accountRevoke: record("accountRevoke"),
      accountAcknowledgeNotice: record("accountAcknowledgeNotice"),
      accountSignOut: record("accountSignOut"),
      accountDelete: record("accountDelete"),
      accountSubmitDiagnostics: async (payload?: unknown) => {
        calls.push({ method: "accountSubmitDiagnostics", payload });
        return { reportId: "rep-0123456789abcdef", entryCount: 4 };
      },
      accountExportDiagnostics: async (payload?: unknown) => {
        calls.push({ method: "accountExportDiagnostics", payload });
        return { filename: "strideterm-diagnostics-2026-03-10T00-00-00.json", content: "{}", entryCount: 4 };
      },
      saveFile: async (payload?: unknown) => {
        calls.push({ method: "saveFile", payload });
        return "C:/Users/me/Downloads/strideterm-diagnostics-2026-03-10T00-00-00.json";
      },
      onAccountUpdated: () => () => {},
      // Last, so a test can replace one method with a promise it controls — which is the only way to
      // observe a spinner that is up only while a call is in flight.
      ...overrides,
    },
  };
}

async function render(
  state: AnyState,
  apiOverrides: AnyState = {},
  props: SettingsAccountTabProps = {},
): Promise<{
  wrapper: VueWrapper<unknown, ComponentPublicInstance<SettingsAccountTabProps>>;
  calls: { method: string; payload?: unknown }[];
  store: ReturnType<typeof useAccountStore>;
}> {
  const { api, calls } = makeApi(state, apiOverrides);
  const store = useAccountStore();
  store.attach(api);
  const wrapper = mount(SettingsAccountTab, { props }) as VueWrapper<
    unknown,
    ComponentPublicInstance<SettingsAccountTabProps>
  >;
  await flushPromises();
  return { wrapper, calls, store };
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.restoreAllMocks();
});

describe("the account page", () => {
  test.each(["overview", "account"] as const)(
    "%s keeps progress visible after the email link is consumed",
    async (view) => {
      const { wrapper, store } = await render(
        stateFor({
          phase: "signing-in",
          busy: true,
          auth: authState({ phase: "verifying", purpose: "enrol-with-trial" }),
        }),
        {},
        { view },
      );
      expect(wrapper.text()).toContain("Finishing sign-in…");
      expect(wrapper.text()).toContain("activating your free trial");
      expect(wrapper.find('[role="status"] .account-spinner').exists()).toBe(true);

      store.state = {
        phase: "signed-out",
        busy: true,
        needsRecentAuth: true,
        installationRegistered: false,
        signInAvailable: true,
      };
      await flushPromises();
      expect(wrapper.text()).toContain("Finishing sign-in…");
      expect(wrapper.find('input[type="email"]').exists()).toBe(false);

      store.state = stateFor({ busy: false, auth: undefined });
      await flushPromises();
      expect(wrapper.text()).not.toContain("Finishing sign-in…");
      wrapper.unmount();
    },
  );

  test("verifying a restore says restoring, not registering", async () => {
    const { wrapper } = await render(
      stateFor({
        phase: "signing-in",
        busy: true,
        auth: authState({ phase: "verifying", purpose: "recover-uid" }),
      }),
      {},
      { view: "overview" },
    );
    expect(wrapper.text()).toContain("restoring this computer's enrolment");
    expect(wrapper.text()).not.toContain("registering");
    wrapper.unmount();
  });

  describe("a refused restore", () => {
    const refused = () =>
      stateFor({
        phase: "signed-out",
        ownerEmail: undefined,
        installationRegistered: false,
        needsRecentAuth: true,
        overview: null,
        entitlement: undefined,
        recoveryRefused: { email: "t-test@example.test", at: NOW },
        lastError: "nothing-to-recover",
      });

    test("asks instead of showing the generic alert, and Yes sends an enrol link", async () => {
      const { wrapper, calls } = await render(refused(), {}, { view: "overview" });
      const prompt = wrapper.find(".account-recovery-refused");
      expect(prompt.text()).toContain("Nothing to restore for t-test@example.test");
      expect(prompt.text()).toContain("No trial is started.");
      expect(wrapper.text()).not.toContain("so there is nothing to restore");
      expect(wrapper.findAll('[role="alert"]')).toHaveLength(1);

      await prompt
        .findAll("button")
        .find((button) => button.text() === "Yes, send a link")!
        .trigger("click");
      await flushPromises();
      const methods = calls.map((call) => call.method);
      expect(methods.indexOf("accountDismissRecoveryRefused")).toBeGreaterThanOrEqual(0);
      expect(methods.indexOf("accountDismissRecoveryRefused")).toBeLessThan(methods.indexOf("accountBeginSignIn"));
      expect(calls.find((call) => call.method === "accountDismissRecoveryRefused")?.payload).toEqual({
        answer: "register",
      });
      expect(calls.find((call) => call.method === "accountBeginSignIn")?.payload).toEqual({
        email: "t-test@example.test",
        purpose: "enrol",
      });
      wrapper.unmount();
    });

    test("No goes back to the form with the address kept and sends nothing", async () => {
      const { wrapper, calls } = await render(refused(), {}, { view: "overview" });
      await wrapper
        .find(".account-recovery-refused")
        .findAll("button")
        .find((button) => button.text() === "No")!
        .trigger("click");
      await flushPromises();
      expect(calls.find((call) => call.method === "accountDismissRecoveryRefused")?.payload).toEqual({
        answer: "back",
      });
      expect(calls.some((call) => call.method === "accountBeginSignIn")).toBe(false);
      expect((wrapper.find('input[type="email"]').element as HTMLInputElement).value).toBe("t-test@example.test");
      wrapper.unmount();
    });
  });

  test("failed registration exits progress and shows the error", async () => {
    const { wrapper, store } = await render(
      stateFor({ phase: "signing-in", busy: true, auth: authState({ phase: "verifying", purpose: "enrol" }) }),
      {},
      { view: "overview" },
    );
    store.state = {
      phase: "signed-out",
      busy: false,
      needsRecentAuth: true,
      installationRegistered: false,
      signInAvailable: true,
      lastError: "network",
    };
    await flushPromises();
    expect(wrapper.text()).not.toContain("Finishing sign-in…");
    expect(wrapper.find('[role="alert"]').exists()).toBe(true);
    expect(wrapper.find('input[type="email"]').exists()).toBe(true);
    wrapper.unmount();
  });

  test("signed out, it is ONE address field and a Continue button, with no password anywhere", async () => {
    const { wrapper } = await render({
      phase: "signed-out",
      busy: false,
      needsRecentAuth: true,
      signInAvailable: true,
    });
    expect(wrapper.text()).toContain("Sign in");
    expect(wrapper.text()).toContain("There is no password");
    expect(wrapper.text()).toContain("The desktop app itself is free");
    // The whole password vocabulary is gone from the page, not merely from the flow.
    expect(wrapper.findAll("input[type='password']")).toHaveLength(0);
    expect(wrapper.text()).not.toContain("Forgot password");
    expect(wrapper.text()).not.toContain("Create account");
  });

  test("the onboarding is EXPLICITLY chosen before a link is sent", async () => {
    // Plan section 9: a new user completes an onboarding they explicitly chose. A single Continue
    // that silently started a trial would not be a choice.
    const { wrapper, calls } = await render({
      phase: "signed-out",
      busy: false,
      needsRecentAuth: true,
      signInAvailable: true,
    });
    await wrapper.find(".custom-select__button").trigger("click");
    expect(document.body.querySelectorAll(".custom-select__option")).toHaveLength(3);
    await wrapper.find(".custom-select__button").trigger("click");
    await wrapper.find("input[type='email']").setValue("owner@example.test");
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Continue")!
      .trigger("click");
    await flushPromises();
    expect(calls.find((call) => call.method === "accountBeginSignIn")?.payload).toEqual({
      email: "owner@example.test",
      purpose: "enrol-with-trial",
    });
  });

  test("bootstrap failure stays in the sign-in form, preserves the email, and retries the frozen request", async () => {
    const retry = vi.fn(async () => undefined);
    const { wrapper, calls } = await render(
      stateFor({
        phase: "signed-out",
        onlineBootstrap: {
          phase: "failed",
          purpose: "sign-in",
          url: "https://bootstrap.example.test/prod.json",
          error: {
            stage: "fetch",
            category: "dns",
            code: "ENOTFOUND",
            message: "The server address could not be resolved.",
          },
        },
      }),
      { accountRetryOnlineBootstrap: retry },
    );

    const email = wrapper.find('input[type="email"]');
    await email.setValue("owner@example.test");
    expect(wrapper.text()).toContain("Online services configuration could not be downloaded");
    expect(wrapper.text()).toContain("Firebase and our relay servers");
    expect(wrapper.text()).toContain("email was not sent");
    expect(wrapper.text()).toContain("ENOTFOUND");
    expect(wrapper.text()).toContain("https://bootstrap.example.test/prod.json");
    expect(calls.some((call) => call.method === "accountBeginSignIn")).toBe(false);

    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Try again")!
      .trigger("click");
    await flushPromises();
    expect(retry).toHaveBeenCalledOnce();
    expect((wrapper.find('input[type="email"]').element as HTMLInputElement).value).toBe("owner@example.test");
    expect(calls.some((call) => call.method === "accountBeginSignIn")).toBe(false);
    wrapper.unmount();
  });

  test("a cached configuration warning stays non-blocking and cannot retry a sign-in", async () => {
    const { wrapper } = await render(
      stateFor({
        phase: "signing-in",
        lastError: "network",
        onlineBootstrap: {
          phase: "cache-warning",
          purpose: "sign-in",
          url: "https://bootstrap.example.test/prod.json",
          error: {
            stage: "verify",
            category: "verification",
            refusal: "unknown-key",
            message: "The configuration was signed by an untrusted key.",
          },
        },
        auth: authState(),
      }),
    );
    expect(wrapper.text()).toContain("A previously verified saved configuration remains available");
    expect(wrapper.text()).toContain("Could not reach the account service. Check your connection.");
    expect(wrapper.findAll("button").some((button) => button.text() === "Try update again")).toBe(false);
    expect(wrapper.text()).toContain("Check your email");
    wrapper.unmount();
  });

  test("a build with no sign-in configuration says so and disables Continue", async () => {
    const { wrapper } = await render({
      phase: "signed-out",
      busy: false,
      needsRecentAuth: true,
      signInAvailable: false,
    });
    expect(wrapper.text()).toContain("Signing in is not available in this build");
    const continueButton = wrapper.findAll("button").find((button) => button.text() === "Continue")!;
    expect(continueButton.attributes("disabled")).toBeDefined();
  });

  test("waiting for the link says SENT, never delivered, and offers the honest next steps", async () => {
    const { wrapper } = await render({
      phase: "signing-in",
      busy: false,
      needsRecentAuth: true,
      signInAvailable: true,
      auth: authState(),
    });
    const text = wrapper.text();
    expect(text).toContain("A sign-in link was sent");
    expect(text).toContain("owner@example.test");
    expect(text).toContain("check the spam folder");
    expect(text).not.toContain("delivered");
    // Cancelling our own waiting is not a revocation of the link, and the page says so.
    expect(text).toContain("does not make the link itself stop working");
  });

  test("the resend button is a cooldown, and it counts down", async () => {
    const { wrapper } = await render({
      phase: "signing-in",
      busy: false,
      needsRecentAuth: true,
      signInAvailable: true,
      auth: authState({ canResendAt: Date.now() + 45_000 }),
    });
    const resend = wrapper.findAll("button").find((button) => button.text().startsWith("Send it again"))!;
    expect(resend.text()).toMatch(/Send it again in \d+s/);
    expect(resend.attributes("disabled")).toBeDefined();
  });

  test("the last step happens on THIS computer, and names the address", async () => {
    const { wrapper, calls } = await render({
      phase: "signing-in",
      busy: false,
      needsRecentAuth: true,
      signInAvailable: true,
      auth: authState({ phase: "awaiting-confirmation" }),
    });
    expect(wrapper.text()).toContain("Email confirmed — finish on this computer");
    expect(wrapper.text()).toContain("Nothing has happened on this computer yet");
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Sign in on this computer")!
      .trigger("click");
    await flushPromises();
    expect(calls.some((call) => call.method === "accountConfirmSignIn")).toBe(true);
  });

  test("the pasted link is handed over once and the field is cleared", async () => {
    const { wrapper, calls } = await render({
      phase: "signing-in",
      busy: false,
      needsRecentAuth: true,
      signInAvailable: true,
      auth: authState({ manualOnly: true }),
    });
    expect(wrapper.text()).toContain("Paste the whole sign-in link");
    expect(wrapper.text()).toContain("never opens it");
    // AND WHERE TO GET IT. Phase 0's delivery step read a real message: the plain-text alternative
    // carries the anchor's WORDS and no URL, so somebody who copies what they can see pastes a
    // sentence and meets `invalid-code`. The instruction that avoids that is part of this panel.
    expect(wrapper.text()).toContain("copy the address");
    const field = wrapper.find(".account-paste input");
    await field.setValue("https://auth.strideterm.com/c?attempt=abc&oobCode=CODE");
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Use this link")!
      .trigger("click");
    await flushPromises();
    expect(calls.find((call) => call.method === "accountSubmitSignInLink")?.payload).toEqual({
      link: "https://auth.strideterm.com/c?attempt=abc&oobCode=CODE",
    });
    // The field does not keep a live sign-in code after it has been used.
    expect((field.element as HTMLInputElement).value).toBe("");
  });

  test("an enrolled desktop keeps its devices and entitlement while it reauthenticates", async () => {
    // Hiding the device list behind a sign-in form is how somebody loses the page that would have
    // told them which machine to remove.
    const { wrapper } = await render(stateFor({ auth: authState(), needsRecentAuth: true }));
    expect(wrapper.text()).toContain("A sign-in link was sent");
    expect(wrapper.text()).toContain("Workstation");
    expect(wrapper.find(".account-usage").text()).toContain("2 / 5");
  });

  test("an enrolling machine is offered enrolment, not a subscription", async () => {
    const { wrapper } = await render({
      phase: "enrolling",
      ownerEmail: "a@b.test",
      busy: false,
      needsRecentAuth: false,
    });
    expect(wrapper.text()).toContain("Add this desktop");
    expect(wrapper.text()).not.toContain("Subscribe monthly");
  });

  test("a paid account is labelled subscribed and does not offer another subscription", async () => {
    const { wrapper } = await render(stateFor());
    expect(wrapper.text()).toContain("Subscribed");
    expect(wrapper.text()).toContain("Manage billing");
    expect(wrapper.text()).not.toContain("Subscribe monthly");
    expect(wrapper.text()).not.toContain("€6 / month");
  });

  test("a scheduled cancellation shows its exact local deadline and a countdown, not the grace expiry", async () => {
    const end = Date.now() + 12 * 86_400_000;
    const scheduled = overview({
      entitlement: {
        state: "active",
        source: "subscription",
        notAfter: end + 3 * 86_400_000,
        cancellationAt: end,
        planLabel: "strIDEterm",
      },
    });
    const localDeadline = new Date(end).toLocaleString(undefined, {
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    });
    for (const view of ["overview", "account"] as const) {
      const { wrapper } = await render(
        stateFor({ overview: scheduled, entitlement: scheduled.entitlement }),
        {},
        { view },
      );
      expect(wrapper.text()).toContain("Cancellation scheduled");
      expect(wrapper.text()).toMatch(/12\s*days left/);
      expect(wrapper.text()).toContain(localDeadline);
      expect(wrapper.text()).not.toContain(new Date(end + 3 * 86_400_000).toLocaleDateString());
      expect(wrapper.text()).not.toContain("Subscribe monthly");
      wrapper.unmount();
    }
  });

  test("after cancellation the desktop keeps its free features and offers a new subscription", async () => {
    const ended = overview({ entitlement: { state: "lapsed", source: "none" } });
    const { wrapper } = await render(stateFor({ overview: ended, entitlement: ended.entitlement }));
    expect(wrapper.text()).toContain("Subscription ended");
    expect(wrapper.text()).toContain("Subscribe monthly");
    expect(wrapper.text()).toContain("Your terminals, workspaces");
    expect(wrapper.text()).not.toContain("Cancellation scheduled");
  });

  test("dates are dates, and a renewal is labelled as one", async () => {
    const { wrapper } = await render(stateFor());
    expect(wrapper.text()).toContain("Renews");
    expect(wrapper.text()).not.toContain("in 27 days");
  });

  test("last seen is a day and never a time of day", async () => {
    // Plan §8.4: the server coarsens it to the UTC day before it leaves, and the page must not imply
    // a precision the number does not have — rendering it as a datetime prints a midnight that never
    // happened. It also says, in words, that nothing is decided by it.
    const { wrapper } = await render(stateFor());
    const text = wrapper.text();
    // No clock time anywhere on the page: the only timestamps here are days.
    expect(text).not.toMatch(/[0-9]{1,2}:[0-9]{2}/);
    expect(wrapper.find('[title="Last seen is approximate"]').exists()).toBe(true);
  });

  test("the canonical desktop name is the one the phone shows", async () => {
    // One machine, one name. The server prefers `publicMeta.desktopLabel`; the page renders whatever
    // it was given and invents no local alias of its own.
    const patched = overview({
      installations: [
        {
          installationId: "inst-1",
          label: "Jaromir's workstation",
          registeredAt: NOW,
          isThisInstallation: true,
          state: "active",
        },
      ],
    });
    const { wrapper } = await render(stateFor({ overview: patched }));
    expect(wrapper.text()).toContain("Jaromir's workstation");
    expect(wrapper.text()).not.toContain("DESKTOP-");
  });

  test("a trial shows when it ends, and no invoice is rendered anywhere", async () => {
    const trial = overview({ entitlement: { state: "trial", source: "trial", notAfter: NOW + 3 * 86_400_000 } });
    const { wrapper } = await render(stateFor({ overview: trial, entitlement: trial.entitlement }));
    expect(wrapper.text()).toContain("Trial ends");
    // Invoice DOCUMENTS, not the word: the page legitimately says where invoices live, and the
    // merchant's own documents (numbers, tax lines, receipts) must never be rendered by us.
    for (const forbidden of ["Invoice #", "invoice #", "VAT", "Receipt"]) {
      expect(wrapper.text()).not.toContain(forbidden);
    }
    expect(wrapper.text()).toContain("€6 / month");
    expect(wrapper.text()).toContain("€60 / year");
  });

  test("past_due and lapsed both say the local app keeps working", async () => {
    for (const state of ["past_due", "lapsed", "revoked"]) {
      const patched = overview({ entitlement: { state, source: "subscription" } });
      const { wrapper } = await render(stateFor({ overview: patched, entitlement: patched.entitlement }));
      expect(wrapper.text().toLowerCase()).toContain("local");
      expect(wrapper.text().toLowerCase()).toMatch(/free|unaffected|keep working/);
    }
  });

  test("usage is shown as used-over-limit for all three caps", async () => {
    const { wrapper } = await render(stateFor());
    const usage = wrapper.find(".account-usage").text();
    expect(usage).toContain("2 / 5Desktops");
    expect(usage).toContain("1 / 5Phones");
    expect(usage).toContain("0 / 8Open relay sessions");
  });

  test("the device lists carry the canonical label, the last seen and a revoke", async () => {
    const { wrapper, calls } = await render(stateFor());
    expect(wrapper.text()).toContain("Workstation");
    expect(wrapper.text()).toContain("this one");
    expect(wrapper.text()).toContain("Pixel");
    expect(wrapper.find('[title="Last seen is approximate"]').exists()).toBe(true);

    const removeButtons = wrapper.findAll("button").filter((button) => button.text() === "Remove from account");
    expect(removeButtons.length).toBe(3);
    await removeButtons[0]!.trigger("click");
    await flushPromises();
    expect(calls.some((call) => call.method === "accountRevoke")).toBe(true);
  });

  test('"Connect phone" leads into the SAME pairing flow the Phone pairing section renders, not a QR of its own (plan §6, Fáze B)', async () => {
    const { wrapper } = await render(stateFor());
    const connect = wrapper.findAll("button").find((button) => button.text() === "Connect phone");
    expect(connect).toBeTruthy();
    await connect!.trigger("click");
    expect(wrapper.emitted("navigate-phones")).toHaveLength(1);

    // No enrollment QR anywhere near it — that path was removed, not moved.
    expect(wrapper.text()).not.toContain("enrollment");
  });

  test("overview offers a distinct 14-day start and existing-account sign-in", async () => {
    const { wrapper } = await render(
      { phase: "signed-out", busy: false, needsRecentAuth: true, signInAvailable: true },
      {},
      { view: "overview" },
    );
    expect(wrapper.text()).toContain("Start with 14 days free");
    expect(wrapper.text()).toContain("Sign in to an existing account");
    expect(wrapper.text()).toContain("Open terminals, follow tasks, and receive notifications on your phone");
    expect(wrapper.findAll("input[type='password']")).toHaveLength(0);
  });

  test("trial overview shows exact days and routes first-phone and plan actions", async () => {
    const trial = overview({ entitlement: { state: "trial", source: "trial", notAfter: Date.now() + 3 * 86_400_000 } });
    const { wrapper } = await render(
      stateFor({ overview: trial, entitlement: trial.entitlement }),
      {},
      { view: "overview", phoneCount: 0 },
    );
    expect(wrapper.find(".trial-indicator").text()).toContain("3days left");
    expect(wrapper.find(".trial-indicator").text()).toContain("Ends");
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Connect first phone")!
      .trigger("click");
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "View plans")!
      .trigger("click");
    expect(wrapper.emitted("connect-first-phone")).toHaveLength(1);
    expect(wrapper.emitted("navigate-account")).toHaveLength(1);
  });

  test("Manage phones keeps the existing Phones navigation", async () => {
    const { wrapper } = await render(stateFor(), {}, { view: "overview", phoneCount: 1 });
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Manage phones")!
      .trigger("click");
    expect(wrapper.emitted("navigate-phones")).toHaveLength(1);
    expect(wrapper.emitted("connect-first-phone")).toBeUndefined();
  });

  test("trial lifecycle copy distinguishes the last day and an ended trial", async () => {
    const lastDay = overview({ entitlement: { state: "trial", source: "trial", notAfter: Date.now() + 60_000 } });
    const active = await render(
      stateFor({ overview: lastDay, entitlement: lastDay.entitlement }),
      {},
      { view: "overview" },
    );
    expect(active.wrapper.find(".trial-indicator").text()).toContain("1day left");

    const ended = overview({ entitlement: { state: "lapsed", source: "trial" } });
    const lapsed = await render(
      stateFor({ overview: ended, entitlement: ended.entitlement }),
      {},
      { view: "overview" },
    );
    expect(lapsed.wrapper.text()).toContain("Trial ended");
    expect(lapsed.wrapper.text()).not.toContain("Subscription ended");
  });

  test("paid overview manages existing phones and never sells another plan", async () => {
    const { wrapper } = await render(stateFor(), {}, { view: "overview", phoneCount: 2 });
    expect(wrapper.text()).toContain("Subscribed");
    expect(wrapper.text()).toContain("Manage phones");
    expect(wrapper.text()).not.toContain("Subscribe monthly");
  });

  test("ready while entitlement is loading does not invent a subscription state or plan action", async () => {
    const { wrapper } = await render(
      {
        phase: "ready",
        ownerEmail: "owner@example.test",
        busy: true,
        needsRecentAuth: false,
        signInAvailable: true,
      },
      {},
      { view: "overview" },
    );
    expect(wrapper.text()).toContain("Loading account…");
    expect(wrapper.text()).toContain("Fetching your account details.");
    expect(wrapper.text()).not.toContain("Account details unavailable");
    expect(wrapper.text()).not.toContain("Retry");
    expect(wrapper.text()).not.toContain("No subscription");
    expect(wrapper.text()).not.toContain("Review plan");
    expect(wrapper.text()).not.toContain("Subscribe");
  });

  test("overview entitlement remains authoritative when the duplicate top-level field is absent", async () => {
    const serverOverview = overview();
    const { wrapper } = await render(
      stateFor({ entitlement: undefined, overview: serverOverview }),
      {},
      { view: "overview", phoneCount: 1 },
    );
    expect(wrapper.text()).toContain("Subscribed");
    expect(wrapper.text()).toContain("Manage phones");
    expect(wrapper.text()).not.toContain("Account details unavailable");
  });

  test("hidden view exposes an active authentication challenge without the account wall", async () => {
    const { wrapper } = await render(stateFor({ auth: authState(), needsRecentAuth: true }), {}, { view: "hidden" });
    expect(wrapper.text()).toContain("Check your email");
    expect(wrapper.text()).not.toContain("Account usage");
    expect(wrapper.text()).not.toContain("Workstation");
  });

  test("with a lapsed recent-auth window, Remove asks for a fresh link with the revoke pinned (plan §7/C2)", async () => {
    const { wrapper, calls } = await render(stateFor({ needsRecentAuth: true }));
    const removeButtons = wrapper.findAll("button").filter((button) => button.text() === "Remove from account");
    await removeButtons[0]!.trigger("click");
    await flushPromises();
    expect(calls.some((call) => call.method === "accountRevoke")).toBe(false);
    const signIn = calls.find((call) => call.method === "accountBeginSignIn");
    expect((signIn?.payload as AnyState)?.purpose).toBe("revoke-device");
    expect((signIn?.payload as AnyState)?.email).toBe("owner@example.test");
    // The installation this Remove button is FOR, packed so the backend can perform the exact same
    // revoke once the identity is proved (`decodeRevokeTarget` in `account-manager.ts`) — not whatever
    // is clicked next.
    expect(JSON.parse((signIn?.payload as AnyState)?.offerId as string)).toEqual(["installation", "inst-1"]);
  });

  test("removing with no remembered owner email opens an action-specific sign-in and keeps the target", async () => {
    const { wrapper, calls } = await render(stateFor({ ownerEmail: undefined, needsRecentAuth: true }));
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Remove from account")!
      .trigger("click");
    expect(wrapper.text()).toContain("Confirm your email to remove this desktop");
    await wrapper.find(".account-auth--requested input").setValue("owner@example.test");
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Send confirmation link")!
      .trigger("click");
    await flushPromises();
    const signIn = calls.find((call) => call.method === "accountBeginSignIn");
    expect(signIn?.payload).toMatchObject({ email: "owner@example.test", purpose: "revoke-device" });
    expect(JSON.parse((signIn?.payload as AnyState).offerId)).toEqual(["installation", "inst-1"]);
  });

  test("starting a trial with no remembered owner email asks for it instead of dead-ending", async () => {
    const lapsed = overview({ entitlement: { state: "unbound", source: "trial" } });
    const { wrapper, calls } = await render(
      stateFor({ ownerEmail: undefined, needsRecentAuth: true, overview: lapsed, entitlement: lapsed.entitlement }),
    );
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Start 14-day trial")!
      .trigger("click");
    expect(wrapper.text()).toContain("Confirm your email to start the trial");
    expect(calls.some((call) => call.method === "accountStartTrial")).toBe(false);
  });

  test("checkout opens in the main process and its private copy action never reveals the URL", async () => {
    const trial = overview({ entitlement: { state: "trial", source: "trial", notAfter: NOW + 3 * 86_400_000 } });
    const { wrapper, calls } = await render(stateFor({ overview: trial, entitlement: trial.entitlement }));
    const subscribe = wrapper.findAll("button").find((button) => button.text().startsWith("Subscribe monthly"))!;
    await subscribe.trigger("click");
    await flushPromises();
    expect(calls.find((call) => call.method === "accountOpenCheckout")?.payload).toEqual({
      offerId: "personal-monthly",
    });
    expect(wrapper.html()).not.toContain("http");
    const copy = wrapper.findAll("button").find((button) => button.text() === "Copy checkout link");
    expect(copy).toBeDefined();
    await copy!.trigger("click");
    await flushPromises();
    expect(calls.some((call) => call.method === "accountCopyCheckoutUrl")).toBe(true);
    expect(wrapper.text()).toContain("Checkout link copied");
    expect(wrapper.html()).not.toContain("http");
  });

  test("a pending checkout remains visible and only retries the same request", async () => {
    const trial = overview({ entitlement: { state: "trial", source: "trial", notAfter: NOW + 3 * 86_400_000 } });
    const checkout = vi.fn(async () => "pending");
    const { wrapper } = await render(stateFor({ overview: trial, entitlement: trial.entitlement }), {
      accountOpenCheckout: checkout,
    });
    const subscribe = wrapper.findAll("button").find((button) => button.text().startsWith("Subscribe monthly"))!;

    await subscribe.trigger("click");
    await flushPromises();

    expect(wrapper.find(".account-note--warn").text()).toContain("A checkout request is still pending");
    expect(wrapper.find(".account-error").exists()).toBe(false);
    expect((subscribe.element as HTMLButtonElement).disabled).toBe(true);

    const retry = wrapper.findAll("button").find((button) => button.text() === "Retry this checkout")!;
    await retry.trigger("click");
    await flushPromises();
    expect(checkout).toHaveBeenCalledTimes(2);
    expect(checkout).toHaveBeenNthCalledWith(1, { offerId: "personal-monthly" });
    expect(checkout).toHaveBeenNthCalledWith(2, { offerId: "personal-monthly" });
  });

  test("plan buttons disable immediately while checkout is being requested", async () => {
    const trial = overview({ entitlement: { state: "trial", source: "trial", notAfter: NOW + 3 * 86_400_000 } });
    let resolveCheckout!: (outcome: "opened") => void;
    const checkoutResponse = new Promise<"opened">((resolve) => {
      resolveCheckout = resolve;
    });
    const { wrapper } = await render(stateFor({ overview: trial, entitlement: trial.entitlement }), {
      accountOpenCheckout: async () => checkoutResponse,
    });
    const subscribe = wrapper.findAll("button").find((button) => button.text().startsWith("Subscribe monthly"))!;

    await subscribe.trigger("click");
    expect(wrapper.text()).toContain("Preparing checkout…");
    expect((subscribe.element as HTMLButtonElement).disabled).toBe(true);

    resolveCheckout("opened");
    await flushPromises();
    expect((subscribe.element as HTMLButtonElement).disabled).toBe(false);
  });

  test("with no owner session, Subscribe still opens checkout directly (I3: installation-authorized)", async () => {
    // Billing is authorized server-side against this desktop's OWN active installation record, not a
    // live owner session — the Subscribe/Portal buttons only render once the machine is enrolled
    // (`phase === 'ready'`), so there is no need to detour through a fresh owner sign-in first.
    const trial = overview({ entitlement: { state: "trial", source: "trial", notAfter: NOW + 3 * 86_400_000 } });
    const { wrapper, calls } = await render(
      stateFor({ needsRecentAuth: true, overview: trial, entitlement: trial.entitlement }),
    );
    const subscribe = wrapper.findAll("button").find((button) => button.text().startsWith("Subscribe monthly"))!;
    await subscribe.trigger("click");
    await flushPromises();
    expect(calls.find((call) => call.method === "accountOpenCheckout")?.payload).toEqual({
      offerId: "personal-monthly",
    });
    expect(calls.some((call) => call.method === "accountBeginSignIn")).toBe(false);
  });

  test("with no owner session, the portal button still opens the portal directly (I3)", async () => {
    const { wrapper, calls } = await render(stateFor({ needsRecentAuth: true }));
    const portal = wrapper.findAll("button").find((button) => button.text() === "Manage billing")!;
    await portal.trigger("click");
    await flushPromises();
    expect(calls.some((call) => call.method === "accountOpenBillingPortal")).toBe(true);
    expect(calls.some((call) => call.method === "accountBeginSignIn")).toBe(false);
  });

  test("the billing portal is a fresh request every time", async () => {
    const { wrapper, calls } = await render(stateFor());
    const portal = wrapper.findAll("button").find((button) => button.text() === "Manage billing")!;
    await portal.trigger("click");
    await portal.trigger("click");
    await flushPromises();
    expect(calls.filter((call) => call.method === "accountOpenBillingPortal")).toHaveLength(2);
  });

  test("the login email and the billing email are visibly different things", async () => {
    const { wrapper } = await render(stateFor());
    expect(wrapper.text()).toContain("LOGIN email only");
    expect(wrapper.text()).toContain("billing email is changed in the billing portal");
  });

  test("notices render from their KIND, are dismissible, and never link to a checkout", async () => {
    const withNotice = overview({
      notices: [{ noticeId: "n1", kind: "trial-ending-3d", effectiveAt: NOW, createdAt: NOW }],
    });
    const { wrapper, calls } = await render(stateFor({ overview: withNotice, entitlement: withNotice.entitlement }));
    expect(wrapper.text()).toContain("Trial ends in 3 days");
    const notice = wrapper.find(".account-notice");
    expect(notice.text()).not.toMatch(/[€$£]/);
    await notice.find("button").trigger("click");
    await flushPromises();
    expect(calls.find((call) => call.method === "accountAcknowledgeNotice")?.payload).toEqual({ noticeId: "n1" });
  });

  test("the support reference is shown and copyable", async () => {
    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });
    const { wrapper } = await render(stateFor());
    expect(wrapper.text()).toContain("STR-1-ABCDEFGHJKMN");
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Copy")!
      .trigger("click");
    expect(writeText).toHaveBeenCalledWith("STR-1-ABCDEFGHJKMN");
  });

  test("a stale proof hides the destructive controls behind another link", async () => {
    const { wrapper, calls } = await render(stateFor({ needsRecentAuth: true }));
    expect(wrapper.text()).toContain("confirm it is you");
    expect(wrapper.text()).not.toContain("Change login email");
    expect(wrapper.findAll("input[type='password']")).toHaveLength(0);
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Confirm it is you")!
      .trigger("click");
    await flushPromises();
    expect(calls.find((call) => call.method === "accountBeginSignIn")?.payload).toEqual({
      email: "owner@example.test",
      purpose: "reauth",
    });
  });

  test("a login-address change is described as WAITING, never as done", async () => {
    const { wrapper } = await render(stateFor({ pendingEmailChange: { email: "new@example.test", requestedAt: NOW } }));
    expect(wrapper.text()).toContain("waiting to be confirmed");
    expect(wrapper.text()).toContain("new@example.test");
    expect(wrapper.text()).toContain("keeps its current login address");
    // AND WHICH ADDRESS TO USE AFTERWARDS. Phase 0 rows 39 and 40: applying the change ends the
    // session that asked for it, and the old address then signs in to a brand-new empty account
    // rather than being told it moved. Without this sentence the honest refusal that follows
    // (`account-mismatch`) reads as the account having disappeared.
    expect(wrapper.text()).toContain("the new address is the one to sign in with");
  });

  test("the change-email copy says the OLD address keeps working until the link is opened", async () => {
    const { wrapper } = await render(stateFor());
    expect(wrapper.text()).toContain("strIDEterm emails the NEW address");
    expect(wrapper.text()).toContain("current login keeps working until then");
  });

  test("signing out with phones attached warns that they will be disconnected", async () => {
    const { wrapper } = await render(stateFor());
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Sign out of this desktop")!
      .trigger("click");
    expect(wrapper.text()).toContain("Any phones paired to this desktop will disconnect");
    expect(wrapper.text()).toContain("Local terminals keep working");
  });

  test("the account email stays visible and masked email is never used to reauthenticate", async () => {
    const { wrapper, calls } = await render(
      stateFor({
        ownerEmail: undefined,
        needsRecentAuth: true,
        overview: overview({ accountDisplay: "o***@example.test" }),
      }),
    );
    expect(wrapper.text()).toContain("Account o***@example.test");
    expect(wrapper.text()).toContain("Email partly hidden for privacy");
    expect((wrapper.find('input[autocomplete="username"]').element as HTMLInputElement).value).toBe("");
    await wrapper.find('input[autocomplete="username"]').setValue("owner@example.test");
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Confirm it is you")!
      .trigger("click");
    await flushPromises();
    expect(calls.find((call) => call.method === "accountBeginSignIn")?.payload).toEqual({
      email: "owner@example.test",
      purpose: "reauth",
    });
  });

  test("the login email remembered on this computer is shown in full and prefilled", async () => {
    const { wrapper } = await render(
      stateFor({
        ownerEmail: undefined,
        rememberedOwnerEmail: "owner@example.test",
        needsRecentAuth: true,
        overview: overview({ accountDisplay: "o***@example.test" }),
      }),
    );
    expect(wrapper.text()).toContain("Signed in as owner@example.test");
    expect(wrapper.text()).toContain("Login email remembered on this computer");
    expect(wrapper.text()).not.toContain("Email partly hidden for privacy");
    expect((wrapper.find('input[autocomplete="username"]').element as HTMLInputElement).value).toBe(
      "owner@example.test",
    );
  });

  test("a remembered address is confirmed in the form, never sent a link unasked", async () => {
    const { wrapper, calls } = await render(
      stateFor({
        ownerEmail: undefined,
        rememberedOwnerEmail: "owner@example.test",
        needsRecentAuth: true,
        overview: overview({ entitlement: { state: "unbound", source: "trial" }, accountDisplay: "o***@example.test" }),
        entitlement: { state: "unbound", source: "trial" },
      }),
    );
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Start 14-day trial")!
      .trigger("click");
    await flushPromises();
    expect(calls.some((call) => call.method === "accountBeginSignIn")).toBe(false);
    expect(wrapper.text()).toContain("Confirm your email to start the trial");

    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Send confirmation link")!
      .trigger("click");
    await flushPromises();
    expect(calls.find((call) => call.method === "accountBeginSignIn")?.payload).toEqual({
      email: "owner@example.test",
      purpose: "trial",
    });
  });

  test("a notice about the remembered address is shown and can be dismissed", async () => {
    const { wrapper, calls } = await render(
      stateFor({
        ownerEmail: undefined,
        ownerEmailNotice: {
          kind: "mismatch",
          remembered: "someone@other.test",
          accountDisplay: "o***@example.test",
          at: NOW,
        },
        overview: overview({ accountDisplay: "o***@example.test" }),
      }),
    );
    const notice = wrapper.find(".account-owner-email-notice");
    expect(notice.text()).toContain("someone@other.test");
    expect(notice.text()).toContain("no longer matches this account (o***@example.test)");
    await notice.find("button").trigger("click");
    await flushPromises();
    expect(calls.some((call) => call.method === "accountDismissOwnerEmailNotice")).toBe(true);
  });

  test("only one destructive confirmation can be open at a time", async () => {
    const { wrapper } = await render(stateFor());
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Sign out of this desktop")!
      .trigger("click");
    expect(wrapper.find(".account-confirm h5").text()).toBe("Sign out of this desktop?");
    await wrapper
      .findAll("button")
      .filter((button) => button.text() === "Delete account")[0]
      .trigger("click");
    expect(wrapper.findAll(".account-confirm h5")).toHaveLength(1);
    expect(wrapper.find(".account-confirm h5").text()).toBe("Delete this account permanently?");
  });

  test("sign-out reauthentication returns to the explicit final action", async () => {
    const { wrapper, calls, store } = await render(stateFor({ needsRecentAuth: true }));
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Sign out of this desktop")!
      .trigger("click");
    const confirm = wrapper
      .findAll(".account-confirm")
      .find((node) => node.text().includes("Sign out of this desktop?"))!;
    await confirm
      .findAll("button")
      .find((button) => button.text() === "Send sign-in link to confirm identity")!
      .trigger("click");
    await flushPromises();
    expect(calls.find((call) => call.method === "accountBeginSignIn")?.payload).toEqual({
      email: "owner@example.test",
      purpose: "reauth",
    });
    expect(calls.some((call) => call.method === "accountSignOut")).toBe(false);

    store.state = { ...store.state, needsRecentAuth: false };
    await wrapper.vm.$nextTick();
    await confirm
      .findAll("button")
      .find((button) => button.text().includes("Sign out of this desktop"))!
      .trigger("click");
    await flushPromises();
    expect(calls.find((call) => call.method === "accountSignOut")?.payload).toEqual({ disconnect: true });
  });

  test("sign-out has an inline spinner and ignores a second press while pending", async () => {
    let release: (() => void) | undefined;
    let submits = 0;
    const { wrapper } = await render(stateFor(), {
      accountSignOut: () => {
        submits += 1;
        return new Promise<void>((resolve) => (release = resolve));
      },
    });
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Sign out of this desktop")!
      .trigger("click");
    const confirm = wrapper
      .findAll(".account-confirm")
      .find((node) => node.text().includes("Sign out of this desktop?"))!;
    const submit = confirm.findAll("button").find((button) => button.text().includes("Sign out of this desktop"))!;
    await submit.trigger("click");
    expect(submit.find(".button-spinner").exists()).toBe(true);
    await submit.trigger("click");
    expect(submits).toBe(1);
    release!();
    await flushPromises();
    expect(submit.find(".button-spinner").exists()).toBe(false);
  });

  test("a stale sign-out proof keeps its refusal inline and offers reauthentication", async () => {
    const { wrapper } = await render(stateFor(), {
      accountSignOut: async () => {
        throw new Error("account callable refused: requires-recent-login");
      },
    });
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Sign out of this desktop")!
      .trigger("click");
    const confirm = wrapper
      .findAll(".account-confirm")
      .find((node) => node.text().includes("Sign out of this desktop?"))!;
    await confirm
      .findAll("button")
      .find((button) => button.text().includes("Sign out of this desktop"))!
      .trigger("click");
    await flushPromises();
    expect(confirm.find(".account-error--inline").text()).toContain("Confirm it is you again");
    expect(confirm.text()).toContain("Send sign-in link to confirm identity");
    expect(wrapper.find(".account-tab > .account-error").exists()).toBe(false);
  });

  test("a backend sign-in refusal arriving later appears inside the open confirmation", async () => {
    const { wrapper, store } = await render(stateFor());
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Sign out of this desktop")!
      .trigger("click");
    store.state = { ...store.state, lastError: "requires-recent-login" };
    await wrapper.vm.$nextTick();
    const confirm = wrapper
      .findAll(".account-confirm")
      .find((node) => node.text().includes("Sign out of this desktop?"))!;
    expect(confirm.find(".account-error--inline").text()).toContain("Confirm it is you again");
    expect(confirm.text()).toContain("Send sign-in link to confirm identity");
    expect(wrapper.find(".account-tab > .account-error").exists()).toBe(false);
  });

  test("deleting needs a fresh proof of identity as well as the phrase", async () => {
    const { wrapper } = await render(stateFor({ needsRecentAuth: true }));
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Delete account")!
      .trigger("click");
    const confirm = wrapper.find(".account-confirm--danger");
    expect(confirm.text()).toContain("Confirm your identity here first");
    expect(confirm.text()).toContain("it will not delete anything by itself");
    await confirm.find("input").setValue("DELETE MY ACCOUNT");
    const stillDisabled = confirm.findAll("button").find((entry) => entry.text() === "Delete account")!;
    expect(stillDisabled.attributes("disabled")).toBeDefined();
  });

  test("deleting requires the exact phrase before the button is usable", async () => {
    const { wrapper, calls } = await render(stateFor());
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Delete account")!
      .trigger("click");
    const confirm = wrapper.find(".account-confirm--danger");
    const button = confirm.findAll("button").find((entry) => entry.text() === "Delete account")!;
    expect(button.attributes("disabled")).toBeDefined();

    await confirm.find("input").setValue("DELETE MY ACCOUNT");
    expect(button.attributes("disabled")).toBeUndefined();
    await button.trigger("click");
    await flushPromises();
    expect(calls.find((call) => call.method === "accountDelete")?.payload).toEqual({
      confirmationPhrase: "DELETE MY ACCOUNT",
    });
  });

  test("a refusal is shown in OUR words, never the server's", async () => {
    const { wrapper, store } = await render(stateFor());
    store.actionError = "installation-limit";
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain("maximum number of desktops");
  });

  test("a failure behind TLS inspection says so, and a plain network failure keeps its sentence", async () => {
    const { wrapper, store } = await render(stateFor());
    store.actionError = "network-tls";
    await wrapper.vm.$nextTick();
    expect(wrapper.find(".account-error").text()).toContain("intercepting encrypted connections");
    store.actionError = "network";
    await wrapper.vm.$nextTick();
    expect(wrapper.find(".account-error").text()).toBe("Could not reach the account service. Check your connection.");
  });

  test("every account error code has copy of its own, not the generic fallback", async () => {
    // THE FALLBACK IS THE BUG THIS CATCHES. A code with no entry renders as "That did not work. Try
    // again." — which is advice for a transient failure and wrong for every one of these: a cap, a
    // billing URL this desktop refused, and an installation whose own sign-in is gone are each fixed
    // by doing one specific thing. Three of them landed on the fallback before it was total.
    const { wrapper, store } = await render(stateFor());
    const generic = await (async () => {
      store.actionError = "unknown";
      await wrapper.vm.$nextTick();
      return wrapper.find(".account-error").text();
    })();
    for (const code of ACCOUNT_ERROR_CODES) {
      if (code === "unknown") continue;
      store.actionError = code;
      await wrapper.vm.$nextTick();
      const shown = wrapper.find(".account-error").text();
      expect(shown, `no copy for "${code}"`).not.toBe(generic);
      expect(shown.length, `empty copy for "${code}"`).toBeGreaterThan(0);
    }
  });

  test("the three device caps say three different things", async () => {
    // They are fixed in three different places — this account's desktops, this account's phones,
    // this one desktop's phones — so collapsing them sends somebody to the wrong screen. The desktop
    // transport is what turns the server's `cap` into these three codes.
    const { wrapper, store } = await render(stateFor());
    const shown = new Set<string>();
    for (const code of ["installation-limit", "mobile-device-limit", "pairing-device-limit"] as const) {
      store.actionError = code;
      await wrapper.vm.$nextTick();
      shown.add(wrapper.find(".account-error").text());
    }
    expect(shown.size).toBe(3);
  });

  test("a deployment with no merchant offers no checkout and says so", async () => {
    const unconfigured = overview({ billingConfigured: false, offers: [] });
    const { wrapper } = await render(stateFor({ overview: unconfigured, entitlement: unconfigured.entitlement }));
    expect(wrapper.text()).toContain("Subscriptions are not available in this build");
    expect(wrapper.text()).not.toContain("Subscribe monthly");
  });

  test("a payment service refusal gets actionable copy", async () => {
    const { wrapper, store } = await render(stateFor());
    store.actionError = "provider-unavailable";
    await wrapper.vm.$nextTick();
    expect(wrapper.find(".account-error").text()).toBe(
      "The payment service could not prepare the payment page. Try again later.",
    );
  });
});

describe("opt-in diagnostics", () => {
  /** Opens the section, which is collapsed until somebody asks for it. */
  async function openDiagnostics(wrapper: Awaited<ReturnType<typeof render>>["wrapper"]) {
    const toggle = wrapper.findAll("button").find((button) => button.text().includes("Send diagnostics to support"));
    expect(toggle).toBeTruthy();
    await toggle!.trigger("click");
    await flushPromises();
  }

  test("says what is in the report before anything is sent", async () => {
    const { wrapper } = await render(stateFor());
    await openDiagnostics(wrapper);
    const text = wrapper.text();
    // The consent has to describe the thing being consented to.
    expect(text).toContain("No terminal output");
    expect(text.toLowerCase()).toContain("no passwords");
    expect(text).toContain("Save it first if you would like to read it");
  });

  test("sending answers with a reference to quote, and never with the report", async () => {
    const state = stateFor();
    const { wrapper, calls, store } = await render(state);
    await openDiagnostics(wrapper);
    // The broadcast state is what carries the reference back, so every window shows the same one.
    state.lastDiagnosticsReportId = "rep-0123456789abcdef";
    const send = wrapper.findAll("button").find((button) => button.text() === "Send");
    await send!.trigger("click");
    await flushPromises();
    expect(calls.some((call) => call.method === "accountSubmitDiagnostics")).toBe(true);
    expect(store.state.lastDiagnosticsReportId).toBe("rep-0123456789abcdef");
    expect(wrapper.text()).toContain("rep-0123456789abcdef");
  });

  test("the note the user typed is the only thing the renderer contributes", async () => {
    const { wrapper, calls } = await render(stateFor());
    await openDiagnostics(wrapper);
    await wrapper.find(".account-confirm input[type='text']").setValue("it says lapsed and I paid");
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Send")!
      .trigger("click");
    await flushPromises();
    const call = calls.find((entry) => entry.method === "accountSubmitDiagnostics");
    expect(call?.payload).toEqual({ note: "it says lapsed and I paid" });
  });

  test("saving locally goes through the vetted save dialog and reports where it landed", async () => {
    const { wrapper, calls } = await render(stateFor());
    await openDiagnostics(wrapper);
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Save to a file")!
      .trigger("click");
    await flushPromises();
    expect(calls.some((call) => call.method === "accountExportDiagnostics")).toBe(true);
    const save = calls.find((call) => call.method === "saveFile");
    expect(save?.payload).toMatchObject({ defaultPath: "strideterm-diagnostics-2026-03-10T00-00-00.json" });
    expect(wrapper.text()).toContain("Downloads/strideterm-diagnostics-2026-03-10T00-00-00.json");
  });

  test("a desktop that is not enrolled can still save, and is told why it cannot send", async () => {
    // The state the page is in is usually part of what is broken; a report you can only produce once
    // everything works is a report nobody needs.
    const { wrapper } = await render({
      phase: "signed-out",
      busy: false,
      needsRecentAuth: true,
      signInAvailable: true,
    });
    await openDiagnostics(wrapper);
    expect(wrapper.findAll("button").some((button) => button.text() === "Send")).toBe(false);
    expect(wrapper.findAll("button").some((button) => button.text() === "Save to a file")).toBe(true);
    expect(wrapper.text()).toContain("save the file and attach it to an email");
  });

  test("a refusal is explained in our own words and points at the fallback", async () => {
    const { wrapper, store } = await render(stateFor());
    await openDiagnostics(wrapper);
    store.actionError = "daily-limit";
    await flushPromises();
    expect(wrapper.text()).toContain("Save the file instead");
  });
});

// ---------------------------------------------------------------------------
// The follow-up's UI half: F03, F06, F09 and F11
// ---------------------------------------------------------------------------
describe("what the page is allowed to claim about a send (F03)", () => {
  test("an UNKNOWN send result is neither a success nor a failure on screen", async () => {
    // The three sentences a person needs, and the page had none of them: the result is unknown, the
    // message may have arrived anyway, and asking for another link stops the older one working
    // (phase-0 row 26). Claiming "sent" would be a claim this desktop cannot make.
    const { wrapper } = await render(
      stateFor({ phase: "ready", auth: authState({ sendOutcome: "unknown", manualOnly: true }) }),
    );
    const text = wrapper.text();
    expect(text).toContain("did not confirm whether the link");
    expect(text).toContain("check that mailbox");
    expect(text).toContain("a new one stops the older link working");
    // And it does NOT say the link was sent.
    expect(text).not.toContain("A sign-in link was sent to");
  });

  test("an ANSWERED send still says it was sent", async () => {
    const { wrapper } = await render(stateFor({ phase: "ready", auth: authState() }));
    expect(wrapper.text()).toContain("A sign-in link was sent to");
    expect(wrapper.text()).not.toContain("did not confirm whether the link");
  });

  test.each([
    ["recover-uid", "nothing is registered automatically"],
    ["enrol", "No trial is started"],
    ["enrol-with-trial", "14-day free trial starts"],
  ])("a `%s` attempt says what opening the link will do", async (purpose, sentence) => {
    const { wrapper } = await render(
      stateFor({ phase: "ready", auth: authState({ phase: "awaiting-link", purpose }) }),
    );
    expect(wrapper.text()).toContain(sentence);
  });

  test.each([
    ["recover-uid", "restores it"],
    ["enrol", "No trial is started"],
    ["enrol-with-trial", "starts the 14-day free trial"],
    ["reauth", "signs this computer in as owner@example.test"],
  ])("a confirmed `%s` link names what the button will do", async (purpose, sentence) => {
    const { wrapper } = await render(
      stateFor({ phase: "ready", auth: authState({ phase: "awaiting-confirmation", purpose }) }),
    );
    const text = wrapper.text();
    expect(text).toContain("Email confirmed — finish on this computer");
    expect(text).toContain(sentence);
    expect(text).toContain("Not your address");
  });

  test("a `reauth` attempt has no next-step sentence", async () => {
    const { wrapper } = await render(
      stateFor({ phase: "ready", auth: authState({ phase: "awaiting-link", purpose: "reauth" }) }),
    );
    const text = wrapper.text();
    expect(text).toContain("A sign-in link was sent to");
    expect(text).not.toContain("nothing is registered automatically");
    expect(text).not.toContain("No trial is started");
    expect(text).not.toContain("14-day free trial starts");
  });
});

describe("the trial button asks for the authentication it needs (F06)", () => {
  test("with no recent authentication it starts a `trial` sign-in rather than calling the endpoint", async () => {
    // The finding, exactly: "Tlačítko trialu poté přímo volá owner endpoint bez zahájení potřebné
    // autentizace." The owner credential is transient, so after a restart there is none and the call
    // could only fail.
    const { wrapper, calls } = await render(
      stateFor({
        needsRecentAuth: true,
        overview: overview({ entitlement: { state: "unbound", source: "trial" } }),
        entitlement: { state: "unbound", source: "trial" },
      }),
    );
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Start 14-day trial")!
      .trigger("click");
    await flushPromises();
    expect(calls.some((call) => call.method === "accountStartTrial")).toBe(false);
    expect(calls.find((call) => call.method === "accountBeginSignIn")?.payload).toEqual({
      email: "owner@example.test",
      purpose: "trial",
    });
  });

  test("with a live owner session it performs the trial directly", async () => {
    const { wrapper, calls } = await render(
      stateFor({
        needsRecentAuth: false,
        overview: overview({ entitlement: { state: "unbound", source: "trial" } }),
        entitlement: { state: "unbound", source: "trial" },
      }),
    );
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Start 14-day trial")!
      .trigger("click");
    await flushPromises();
    expect(calls.some((call) => call.method === "accountStartTrial")).toBe(true);
    expect(calls.some((call) => call.method === "accountBeginSignIn")).toBe(false);
  });
});

describe("who owns the flow, and which errors are visible (F09)", () => {
  test("visibility hands sign-in notices back without releasing or unmounting the auth flow", async () => {
    const { wrapper, calls, store } = await render(
      stateFor({ auth: authState({ phase: "awaiting-confirmation" }) }),
      {},
      { visible: true },
    );
    expect(store.signInPanelMounted).toBe(true);

    await wrapper.setProps({ visible: false });
    expect(store.signInPanelMounted).toBe(false);
    expect(calls.some((call) => call.method === "accountReleaseSignInFlow")).toBe(false);
    expect(wrapper.text()).toContain("Email confirmed — finish on this computer");

    await wrapper.setProps({ visible: true });
    expect(store.signInPanelMounted).toBe(true);
    expect(calls.some((call) => call.method === "accountReleaseSignInFlow")).toBe(false);
  });

  test("closing the panel releases the flow it owns", async () => {
    // Unmounting used to clear a UI interval and nothing else, so closing the dialog left an attempt
    // waiting and — for a change of address or a deletion — a live credential held for a form that
    // had just gone away. The BACKEND decides whether this panel is the owner, which is why the call
    // is unconditional here.
    const { wrapper, calls } = await render(stateFor({ auth: authState({ purpose: "change-email" }) }));
    wrapper.unmount();
    await flushPromises();
    expect(calls.some((call) => call.method === "accountReleaseSignInFlow")).toBe(true);
    // And it is NOT a cancel: a cancel is a person pressing a button, and it would end the attempt
    // whichever window was showing it.
    expect(calls.some((call) => call.method === "accountCancelSignIn")).toBe(false);
  });

  test("an error the BACKEND reported is shown without any rejected call", async () => {
    // The broker writes `state.lastError` for the things nobody asked for — the attempt expiring, the
    // polling loop meeting an address mismatch — and `errorMessage` read only the store's own
    // `actionError`. So the page went on saying "check your email" for an attempt that had failed.
    const { wrapper } = await render(stateFor({ auth: authState(), lastError: "address-mismatch" }));
    expect(wrapper.find(".account-error").text()).toContain("not the one this link was sent to");
  });

  test("an action's own refusal wins over an older backend one", async () => {
    const { wrapper, store } = await render(stateFor({ lastError: "address-mismatch" }));
    store.actionError = "too-many-attempts";
    await wrapper.vm.$nextTick();
    expect(wrapper.find(".account-error").text()).toContain("Too many attempts");
  });
});

describe("which backend, and why there is none (F11)", () => {
  test("a qa build says so, and a prod one does not shout about it", async () => {
    const qa = await render({
      phase: "signed-out",
      busy: false,
      needsRecentAuth: true,
      signInAvailable: true,
      authEnvironment: "qa",
    });
    expect(qa.wrapper.text()).toContain("qa");
    const prod = await render({
      phase: "signed-out",
      busy: false,
      needsRecentAuth: true,
      signInAvailable: true,
      authEnvironment: "prod",
    });
    expect(prod.wrapper.text()).not.toContain("account service");
  });

  test("each reason a sign-in is unavailable has a sentence of its own", async () => {
    // Operator problems, one sentence each. The page used to have one sentence between them, so "no
    // broker named for this local build" and "this build has no control plane" read identically.
    const seen = new Set<string>();
    for (const reason of [
      "not-configured",
      "local-origin-missing",
      "local-origin-invalid",
      "environment-unsupported",
      "environment-unresolved",
      "environment-contradiction",
      "environment-mismatch",
      "local-endpoint-invalid",
    ]) {
      const { wrapper } = await render({
        phase: "signed-out",
        busy: false,
        needsRecentAuth: true,
        signInAvailable: false,
        signInUnavailableReason: reason,
      });
      const shown = wrapper.find(".account-note--warn").text();
      expect(shown, reason).toContain("Signing in is not available");
      seen.add(shown);
    }
    expect(seen.size).toBe(8);
  });
});

// The feedback the page owes somebody who just pressed a button (2026-09-13).
describe("progress and refusals are where the person is looking", () => {
  test("a busy operation says what it is doing, instead of only greying buttons out", async () => {
    // Redeeming the link and registering the machine is three server round trips. With only
    // `:disabled` to show for it the page looked frozen for five seconds, and the reasonable
    // response to a frozen page is to press again.
    const { wrapper } = await render({
      phase: "signing-in",
      busy: true,
      needsRecentAuth: true,
      installationRegistered: false,
      signInAvailable: true,
      auth: {
        phase: "verifying",
        email: "owner@example.test",
        purpose: "enrol-with-trial",
        expiresAt: NOW + 600_000,
        canResendAt: NOW,
        manualOnly: false,
        sendsUsed: 1,
        sendOutcome: "sent",
      },
    });

    const busy = wrapper.find(".account-completing");
    expect(busy.exists()).toBe(true);
    expect(busy.text()).toContain("registering this computer and activating your free trial");
    // Announced, not merely drawn: the spinner itself is decorative.
    expect(busy.attributes("role")).toBe("status");
    expect(wrapper.find(".account-spinner").attributes("aria-hidden")).toBe("true");
  });

  test("the spinner is IN the button that was pressed, not only at the top of the panel", async () => {
    // Feedback belongs at the point of interaction. A muted progress line above a card the person has
    // scrolled past is not an answer to their click — which is how a five-second registration read as
    // a page that had ignored the press.
    let release: (() => void) | undefined;
    const { wrapper } = await render(
      {
        phase: "signing-in",
        busy: false,
        needsRecentAuth: true,
        installationRegistered: false,
        signInAvailable: true,
        auth: {
          phase: "awaiting-confirmation",
          email: "owner@example.test",
          purpose: "enrol-with-trial",
          expiresAt: NOW + 600_000,
          canResendAt: NOW,
          manualOnly: false,
          sendsUsed: 1,
          sendOutcome: "sent",
        },
      },
      { accountConfirmSignIn: () => new Promise<void>((resolve) => (release = resolve)) },
    );

    const confirm = wrapper.findAll("button").find((b) => b.text().includes("Sign in and start 14-day free trial"))!;
    expect(confirm.find(".button-spinner").exists()).toBe(false);

    await confirm.trigger("click");
    await wrapper.vm.$nextTick();
    expect(confirm.find(".button-spinner").exists()).toBe(true);
    // Exactly one button spins: `busy` is true for all of them, and a spinner in each would say
    // nothing about the one that was pressed.
    expect(wrapper.findAll(".button-spinner")).toHaveLength(1);

    release!();
    await flushPromises();
    expect(wrapper.find(".button-spinner").exists()).toBe(false);
  });

  test("a refused action stops its spinner too", async () => {
    // A button that spins for ever after a failure also hides the error the page has just rendered.
    const { wrapper } = await render(
      {
        phase: "signed-out",
        busy: false,
        needsRecentAuth: true,
        installationRegistered: false,
        signInAvailable: true,
      },
      { accountBeginSignIn: () => Promise.reject(new Error("account callable rejected: network")) },
    );

    const emailField = wrapper.find('input[type="email"]');
    await emailField.setValue("owner@example.test");
    const cont = wrapper.findAll("button").find((b) => b.text().trim() === "Continue")!;
    await cont.trigger("click");
    await flushPromises();

    expect(wrapper.find(".button-spinner").exists()).toBe(false);
  });

  test("nothing spins when nothing is happening", async () => {
    const { wrapper } = await render({
      phase: "signed-out",
      busy: false,
      needsRecentAuth: true,
      installationRegistered: false,
      signInAvailable: true,
    });
    expect(wrapper.find(".account-busy").exists()).toBe(false);
  });

  test("a refusal renders ABOVE the page, not at the bottom of it", async () => {
    // It used to be the last element of a long scrolling panel. A failure resets the view to the
    // top, so the alert sat off-screen and the app read as having said nothing at all — which is
    // exactly how a registration that died on a missing installation session was reported.
    const { wrapper } = await render({
      phase: "signed-out",
      busy: false,
      needsRecentAuth: true,
      installationRegistered: false,
      signInAvailable: true,
      lastError: "not-configured",
    });

    const error = wrapper.find(".account-error");
    expect(error.exists()).toBe(true);
    expect(error.attributes("role")).toBe("alert");
    expect(error.text()).toContain("hosted control plane");
    // First, before the body of the panel.
    const html = wrapper.html();
    expect(html.indexOf("account-error")).toBeLessThan(html.indexOf("Sign in"));
  });

  test("a missing installation session is named, not reported as unknown", async () => {
    // The backend now refuses with `not-configured` instead of a bare Error, so this is the code
    // that reaches the page. `unknown` has no sentence anybody can act on.
    expect(ACCOUNT_ERROR_CODES).toContain("not-configured");
  });
});
