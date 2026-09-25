// The renderer's view of the account, and nothing it derives for itself.
//
// EVERY VALUE HERE CAME FROM THE SERVER. The state is one object the main process broadcasts
// (`account:updated`), and this store holds the latest one. There is deliberately no computed
// "isPaid", no local expiry comparison and no cached entitlement: a renderer that could infer paid
// status from anything it holds is a renderer that can be edited into paying nothing, and the
// backend refuses the request anyway — so a UI that disagreed with it would only ever be a UI that
// lies to its user.
//
// AND NO URL EVER ARRIVES HERE. `openCheckout` and `openBillingPortal` answer with an outcome; the
// main process opens the page. A URL in a store is a URL in a devtools console and in every state
// dump.
//
// THE SIGN-IN LINK GOES THE OTHER WAY, AND ONLY ONE WAY. `submitSignInLink` carries the text a person
// pasted to the backend and keeps NOTHING: no ref holds it, no state carries it, and the component
// clears its field the moment the call returns. What comes back on `account:updated` is a substate, a
// deadline and the address the link was sent to — never the code, never the claim secret.

import { defineStore } from "pinia";
import { computed, ref } from "vue";

import type { AccountUiState } from "../../electron/backend/account/account-state.js";
import type { StridetermAPI } from "../../electron/shared/ipc-bridge.js";

/** The transport surface this store needs. Optional throughout: the remote client has none of it. */
type AccountApi = Partial<
  Pick<
    StridetermAPI,
    | "getAccountState"
    | "onAccountUpdated"
    | "accountBeginSignIn"
    | "accountConfirmSignIn"
    | "accountResendSignIn"
    | "accountCancelSignIn"
    | "accountReleaseSignInFlow"
    | "accountSubmitSignInLink"
    | "accountChangeLoginEmail"
    | "accountClearPendingEmailChange"
    | "accountEnrolInstallation"
    | "accountStartTrial"
    | "accountRefreshOverview"
    | "accountOpenCheckout"
    | "accountCopyCheckoutUrl"
    | "accountOpenBillingPortal"
    | "accountRevoke"
    | "accountAcknowledgeNotice"
    | "accountSignOut"
    | "accountDelete"
    | "accountSubmitDiagnostics"
    | "accountExportDiagnostics"
    | "saveFile"
  >
>;

const UNCONFIGURED: AccountUiState = {
  phase: "unconfigured",
  busy: false,
  needsRecentAuth: true,
  installationRegistered: false,
  signInAvailable: false,
};

export const useAccountStore = defineStore("account", () => {
  const state = ref<AccountUiState>(UNCONFIGURED);
  /** The last thing an action refused with. A fixed code — never a remote string. */
  const actionError = ref<string | null>(null);
  const checkoutLinkAvailable = ref(false);
  const checkoutLinkOfferId = ref<string | null>(null);
  const checkoutRequestInFlight = ref(false);
  const checkoutRequestOfferId = ref<string | null>(null);
  const checkoutPendingOfferId = ref<string | null>(null);
  let api: AccountApi | null = null;
  let unsubscribe: (() => void) | null = null;

  /** True only where the hosted control plane exists AND this is the desktop app. */
  const available = computed(() => typeof api?.getAccountState === "function");
  const overview = computed(() => state.value.overview ?? null);
  const entitlement = computed(() => state.value.entitlement ?? null);
  const notices = computed(() => overview.value?.notices ?? []);
  /** The sign-in attempt in flight, or null. A sanitized substate — see `account-state.ts`. */
  const auth = computed(() => state.value.auth ?? null);
  /**
   * Whether the account panel is on screen right now.
   *
   * Set by `SettingsAccountTab` from its own mount hooks, and read by `useSignInNotice` so the
   * "your link was opened, come and confirm it" toast is raised only for somebody who is NOT already
   * looking at the button it points them to. A UI hint and nothing more: no decision in the backend
   * depends on it, and a stale `true` costs at most a toast that was not shown.
   */
  const signInPanelMounted = ref(false);
  function setSignInPanelMounted(mounted: boolean): void {
    signInPanelMounted.value = mounted;
  }
  const pendingEmailChange = computed(() => state.value.pendingEmailChange ?? null);

  function attach(transport: AccountApi | null): void {
    api = transport;
    checkoutLinkAvailable.value = false;
    checkoutLinkOfferId.value = null;
    checkoutPendingOfferId.value = null;
    unsubscribe?.();
    unsubscribe = null;
    if (!api?.onAccountUpdated) return;
    // One subscription, one payload. Every window gets the same object, which is what makes two
    // windows showing different things impossible rather than merely unlikely.
    unsubscribe = api.onAccountUpdated((payload) => {
      state.value = payload;
    });
  }

  function detach(): void {
    unsubscribe?.();
    unsubscribe = null;
    api = null;
    checkoutLinkAvailable.value = false;
    checkoutLinkOfferId.value = null;
    checkoutPendingOfferId.value = null;
    state.value = UNCONFIGURED;
  }

  async function refreshState(): Promise<void> {
    if (!api?.getAccountState) return;
    state.value = (await api.getAccountState()) as AccountUiState;
  }

  /**
   * Runs one action and records its refusal code.
   *
   * The CODE, never the message: the backend already speaks in a closed vocabulary, and a thrown
   * `Error`'s text is the last place a UI should be reading meaning from.
   */
  async function run<T>(action: (() => Promise<T>) | undefined, fallback: T): Promise<T> {
    actionError.value = null;
    if (!action) {
      actionError.value = "not-configured";
      return fallback;
    }
    try {
      return await action();
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      const message = (error as { message?: unknown } | null)?.message;
      const match = typeof message === "string" ? /refused:\s*([a-z-]+)/.exec(message) : null;
      actionError.value = typeof code === "string" ? code : (match?.[1] ?? "unknown");
      return fallback;
    } finally {
      await refreshState().catch(() => {});
    }
  }

  /** Asks for a sign-in link. Returns as soon as the request is made — the wait is in the state. */
  const beginSignIn = (
    email: string,
    purpose: Parameters<StridetermAPI["accountBeginSignIn"]>[0]["purpose"],
    offerId?: string,
  ) =>
    run(() => api!.accountBeginSignIn!({ email, purpose, ...(offerId === undefined ? {} : { offerId }) }), undefined);
  const confirmSignIn = () => run(() => api!.accountConfirmSignIn!(), undefined);
  const resendSignIn = () => run(() => api!.accountResendSignIn!(), undefined);
  const cancelSignIn = () => run(() => api!.accountCancelSignIn!(), undefined);
  /**
   * The owning panel is unmounting: end the flow it started, and nobody else's (F09).
   *
   * Deliberately NOT `cancelSignIn`. This is a dialog going away rather than a person pressing
   * cancel, and the backend compares the window that started the sign-in before it ends anything —
   * so a second window closing its panel, or a panel that never began one, changes nothing. It also
   * bypasses `run()`: an unmounting component has nowhere to show a refusal, and recording one in
   * `actionError` would flash it on the next panel that opens.
   */
  async function releaseSignInFlow(): Promise<void> {
    try {
      await api?.accountReleaseSignInFlow?.();
    } catch {
      // Nothing to report and nobody to report it to; the backend's own lifecycle still ends the
      // attempt at its deadline.
    }
  }
  /**
   * Hands a pasted link to the backend, and keeps nothing.
   *
   * The argument is not stored anywhere in this store, and the component that calls it clears its own
   * field immediately afterwards — plan §8, Fáze 3: "Ručně vložený odkaz má pouze vyhrazený krátkodobý
   * IPC přenos".
   */
  const submitSignInLink = (link: string) => run(() => api!.accountSubmitSignInLink!({ link }), undefined);
  const changeLoginEmail = (email: string) => run(() => api!.accountChangeLoginEmail!({ email }), undefined);
  const clearPendingEmailChange = () => run(() => api!.accountClearPendingEmailChange!(), undefined);
  const enrol = (mode: "register" | "recover-uid" = "register") =>
    run(() => api!.accountEnrolInstallation!({ mode }), undefined);
  const startTrial = () => run(() => api!.accountStartTrial!(), undefined);
  const refreshOverview = () => run(() => api!.accountRefreshOverview!(), undefined);
  /** Answers `opened` or `pending`. The URL is opened by the main process and never seen here. */
  const openCheckout = async (offerId: string): Promise<string> => {
    if (checkoutRequestInFlight.value) return "pending";
    if (checkoutPendingOfferId.value !== null && checkoutPendingOfferId.value !== offerId) {
      actionError.value = "checkout-pending";
      return "pending";
    }
    if (checkoutLinkOfferId.value !== offerId) {
      checkoutLinkAvailable.value = false;
      checkoutLinkOfferId.value = null;
    }
    checkoutRequestInFlight.value = true;
    checkoutRequestOfferId.value = offerId;
    try {
      const outcome = await run(() => api!.accountOpenCheckout!({ offerId }) as Promise<string>, "failed");
      if (outcome === "pending") {
        checkoutPendingOfferId.value = offerId;
        actionError.value = "checkout-pending";
      } else if (outcome === "opened") {
        checkoutPendingOfferId.value = null;
        checkoutLinkAvailable.value = true;
        checkoutLinkOfferId.value = offerId;
      } else if (checkoutPendingOfferId.value === offerId && actionError.value !== null) {
        // A retry of an unresolved request stays pending if the provider cannot answer yet.
        actionError.value = "checkout-pending";
      }
      return outcome;
    } finally {
      checkoutRequestInFlight.value = false;
      checkoutRequestOfferId.value = null;
    }
  };
  const copyCheckoutUrl = async (): Promise<boolean> => {
    const offerId = checkoutLinkOfferId.value;
    if (offerId === null) return false;
    const outcome = await run(
      () => api!.accountCopyCheckoutUrl!({ offerId }) as Promise<"copied" | "unavailable">,
      "unavailable",
    );
    if (outcome !== "copied") {
      checkoutLinkAvailable.value = false;
      checkoutLinkOfferId.value = null;
      actionError.value = "checkout-link-unavailable";
      return false;
    }
    return true;
  };
  const openBillingPortal = () => run(() => api!.accountOpenBillingPortal!(), undefined);
  const revoke = (kind: Parameters<StridetermAPI["accountRevoke"]>[0]["kind"], targetId?: string) =>
    run(() => api!.accountRevoke!({ kind, targetId }), undefined);
  const acknowledgeNotice = (noticeId: string) => run(() => api!.accountAcknowledgeNotice!({ noticeId }), undefined);
  const signOut = (disconnect: boolean) => run(() => api!.accountSignOut!({ disconnect }), undefined);
  const deleteAccount = (confirmationPhrase: string) =>
    run(() => api!.accountDelete!({ confirmationPhrase }), undefined);

  /**
   * Sends the report and answers with the reference to quote.
   *
   * The report itself never comes here — it is assembled in the main process from this
   * installation's own bounded log, so a renderer cannot decide what goes into a document destined
   * for the control plane.
   */
  const submitDiagnostics = (note?: string) =>
    run(
      () =>
        api!.accountSubmitDiagnostics!({ ...(note === undefined ? {} : { note }) }) as Promise<{ reportId: string }>,
      null as { reportId: string } | null,
    );

  /**
   * Saves the same document locally, for when the upload is not available at all.
   *
   * Two calls on purpose: the main process builds the document, and the EXISTING vetted save dialog
   * writes it wherever the user points. Answers the chosen path, or null if they cancelled.
   */
  async function exportDiagnostics(note?: string): Promise<string | null> {
    const report = await run(
      () =>
        api!.accountExportDiagnostics!({ ...(note === undefined ? {} : { note }) }) as Promise<{
          filename: string;
          content: string;
        }>,
      null as { filename: string; content: string } | null,
    );
    if (!report || !api?.saveFile) return null;
    const saved = await api.saveFile({
      defaultPath: report.filename,
      filters: [{ name: "Diagnostics report", extensions: ["json"] }],
      content: report.content,
    });
    return typeof saved === "string" ? saved : null;
  }

  return {
    state,
    actionError,
    checkoutLinkAvailable,
    checkoutRequestInFlight,
    checkoutRequestOfferId,
    checkoutPendingOfferId,
    available,
    overview,
    entitlement,
    notices,
    auth,
    pendingEmailChange,
    signInPanelMounted,
    setSignInPanelMounted,
    attach,
    detach,
    refreshState,
    beginSignIn,
    confirmSignIn,
    resendSignIn,
    cancelSignIn,
    releaseSignInFlow,
    submitSignInLink,
    changeLoginEmail,
    clearPendingEmailChange,
    enrol,
    startTrial,
    refreshOverview,
    openCheckout,
    copyCheckoutUrl,
    openBillingPortal,
    revoke,
    acknowledgeNotice,
    signOut,
    deleteAccount,
    submitDiagnostics,
    exportDiagnostics,
  };
});
