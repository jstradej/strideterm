<script setup lang="ts">
/**
 * The canonical Account page (plan §8.3) — mounted as the leading SECTION of the Mobile tab rather
 * than as a tab of its own, because the hosted control plane it buys is what the phone talks to.
 *
 * WHAT THIS PAGE IS FOR, and what it deliberately is not. The desktop app is free: terminals,
 * workspaces, the LAN server and a Quick Tunnel cost nothing and keep working whatever this page
 * says. What is paid for is the HOSTED control plane — pairing, the push path, the managed relay —
 * and this is the one place that is bought, renewed, inspected and ended.
 *
 * THERE IS NO PASSWORD ON THIS PAGE, ANYWHERE. Signing in is an address and a one-time link; there
 * is no password field, no "create account" step and no reset. What replaces the reauthentication
 * prompt is another link, for the one action that needs it — which is why the destructive controls
 * ask "confirm it's you" rather than "type your password again".
 *
 * NO INVOICE IS EVER RENDERED HERE, and no price string is assembled. Both come from the server's
 * own catalog, already formatted, in the currency the merchant of record decided; a client that
 * formatted a price would be a client that shows a different number from the one somebody is
 * charged. Payment methods, receipts and cancellation are the merchant's own portal, opened fresh
 * each time — the portal URL is temporary and is never cached anywhere.
 *
 * THE RENDERER DERIVES NO ENTITLEMENT. Every state below is read from the server's summary. There is
 * no local expiry comparison and no "isPaid" computed: the backend refuses the request regardless,
 * so a UI that disagreed with it would only ever lie to its user.
 */
import { computed, onMounted, onUnmounted, ref, watch } from "vue";

import { useAccountStore } from "../../../stores/account.js";
import { NETWORK_TLS_UNTRUSTED_COPY } from "../../../lib/network-error-copy.js";

type AccountView = "overview" | "account" | "hidden";

const props = withDefaults(defineProps<{ view?: AccountView; phoneCount?: number; visible?: boolean }>(), {
  view: "account",
  phoneCount: 0,
  visible: true,
});
const emit = defineEmits<{ "navigate-phones": []; "navigate-account": [] }>();

const account = useAccountStore();

const email = ref("");
/**
 * What the first sign-in is FOR, chosen before the link is sent.
 *
 * Plan §9 asks for an onboarding the person "explicitly chose", and §7's table is explicit that
 * adding a computer and starting a trial are one intention with one authentication. A single
 * "Continue" that silently started a trial would be neither.
 */
const intent = ref<"enrol-with-trial" | "enrol" | "recover-uid">("enrol-with-trial");
const pastedLink = ref("");
const newEmail = ref("");
const confirmationPhrase = ref("");
const showDelete = ref(false);
const showSignOut = ref(false);
const showPaste = ref(false);
/** The request a sign-in was asked FOR, when one was. See `startTrialFlow`. */
const pendingPurpose = ref<"reauth" | "trial" | "change-email" | "delete-account">("reauth");
const requestedAuth = ref<{
  purpose: "trial" | "revoke-device";
  offerId?: string;
  title: string;
} | null>(null);
const copiedReference = ref(false);
const showDiagnostics = ref(false);
const diagnosticsNote = ref("");
/** Where the last local export was written. Shown so somebody can go and find the file. */
const diagnosticsSavedPath = ref("");

/**
 * A ticking clock, so the resend cooldown and the deadline count down on screen.
 *
 * One second, and only while an attempt is open. A page that showed a frozen "wait 47 s" would be a
 * page somebody sits in front of pressing a disabled button.
 */
const nowMs = ref(Date.now());
let tick: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  void account.refreshState();
  tick = setInterval(() => (nowMs.value = Date.now()), 1000);
  account.setSignInPanelMounted(props.visible);
});
watch(
  () => props.visible,
  (visible) => account.setSignInPanelMounted(visible),
);
onUnmounted(() => {
  if (tick !== null) clearInterval(tick);
  account.setSignInPanelMounted(false);
  // F09. CLOSING THIS PANEL RELEASES WHAT NEEDED THE FORM — the owner retention, and every operation
  // in flight — and only for the flow this panel owns. The backend decides whether THIS panel is the
  // owner (it compares the window that started the sign-in), so a non-owning panel closing is a no-op
  // there and this can be called unconditionally.
  //
  // WHAT IT DELIBERATELY NO LONGER DOES IS CANCEL A WAITING LINK. Reading the link means leaving this
  // dialog — closing it, or switching to another of its tabs, both of which unmount this component —
  // so ending the attempt here cancelled the sign-in as a direct consequence of the user doing the
  // one thing the flow asks of them. See `releaseSignInPanel` in `account-manager.ts` for why keeping
  // the attempt is safe: it cannot become a credential without a press on this desktop.
  void account.releaseSignInFlow();
});

const phase = computed(() => account.state.phase);
const busy = computed(() => account.state.busy);

/**
 * Which button the person is currently waiting on, or null.
 *
 * WHY NOT `busy`. The manager runs one operation at a time, so `busy` is true for every button at
 * once — a spinner driven by it would put one in all six, and the person would learn nothing about
 * the one they pressed. This records the press itself, which is the only thing that knows.
 *
 * It is a UI detail and stays in the component: the backend already publishes `busy`, and adding a
 * "which button" field to the wire would put a renderer's concern in the protocol.
 */
const pendingAction = ref<string | null>(null);

/** Runs one button's action and keeps its spinner up for exactly as long as it takes. */
async function act(name: string, action: () => Promise<unknown> | unknown): Promise<void> {
  pendingAction.value = name;
  try {
    await action();
  } finally {
    // `finally`, so a refusal stops the spinner too — a button that spins forever after a failure is
    // worse than one that never spun, because it also hides the error the page just rendered.
    if (pendingAction.value === name) pendingAction.value = null;
  }
}

/**
 * What the app is doing, in the user's terms.
 *
 * Derived from the phase rather than reported by the backend on purpose: the state already carries
 * exactly enough to name the step, and adding an operation label to the wire would put an English
 * string in the protocol for the sake of one line of UI. "Working…" is the honest fallback for the
 * operations the person did not start from this panel.
 */
const busyLabel = computed(() => {
  const attempt = account.auth;
  if (attempt?.phase === "sending") return "Sending the sign-in link…";
  // ONE LABEL FOR REDEEMING AND ENROLLING, because they are one wait: confirming runs the redemption
  // and then registers the machine under the same phase, and splitting the sentence would promise a
  // progress bar this has no way to keep.
  if (attempt?.phase === "verifying") return "Signing in and registering this computer…";
  if (account.state.phase === "enrolling") return "Registering this computer…";
  if (account.state.phase === "ready" && !account.entitlement && !account.overview?.entitlement) {
    return "Loading account…";
  }
  return "Working…";
});
const overview = computed(() => account.overview);
const entitlement = computed(() => account.entitlement ?? account.overview?.entitlement);
const auth = computed(() => account.auth);
const pendingEmailChange = computed(() => account.pendingEmailChange);
const trialDaysLeft = computed(() => {
  if (entitlement.value?.state !== "trial" || !entitlement.value.notAfter) return null;
  return Math.max(0, Math.ceil((entitlement.value.notAfter - Date.now()) / 86_400_000));
});
const trialProgress = computed(() =>
  trialDaysLeft.value === null ? 0 : Math.min(100, Math.round((trialDaysLeft.value / 14) * 100)),
);

const resendInSeconds = computed(() => {
  if (!auth.value) return 0;
  return Math.max(0, Math.ceil((auth.value.canResendAt - nowMs.value) / 1000));
});
const expiresInMinutes = computed(() => {
  if (!auth.value) return 0;
  return Math.max(0, Math.ceil((auth.value.expiresAt - nowMs.value) / 60_000));
});

/**
 * Every refusal the page can show, in the user's language rather than the server's.
 *
 * TOTAL OVER `ACCOUNT_ERROR_CODES`, and `SettingsAccountTab.test.ts` asserts it: a code with no
 * entry here renders as `unknown` — "That did not work. Try again." — which is the wrong sentence
 * for every refusal that is not transient.
 */
const ERROR_COPY: Record<string, string> = {
  "invalid-credentials": "That sign-in is no longer valid. Ask for a new link.",
  "invalid-email": "That does not look like an email address.",
  // Firebase does not reliably distinguish "wrong" from "already used", so neither does this
  // sentence — and it names the one thing that fixes all three. THE THIRD CAUSE IS NOT A GUESS:
  // phase 0 row 26 measured it against the live service, which keeps ONE live sign-in code per
  // address, so asking again — from here or from another computer — kills the link already in the
  // mailbox. Somebody who opens the older message lands here, and "it may already have been used"
  // on its own would be telling them something that did not happen.
  "invalid-code":
    "That link did not work — it may already have been used, or a newer link replaced it. Ask for a new one.",
  "expired-code": "That link has expired. Ask for a new one.",
  "address-mismatch": "The address confirmed in the browser is not the one this link was sent to.",
  "attempt-expired": "That sign-in ran out of time. Start again.",
  // F01. Cancelled, or replaced by a newer link, while it was being checked. Deliberately not the
  // sentence above: nothing ran out of time, and what the person needs to read is about what they did.
  "sign-in-superseded": "That sign-in was cancelled or replaced by a newer one. Use the newest link.",
  "malformed-response":
    "The service answered in a form this app could not read. The request may or may not have gone through; refresh the account page before trying again.",
  "auth-unavailable": "Sign-in is not available in this build right now. Nothing local is affected.",
  "too-many-attempts": "Too many attempts. Wait a few minutes and try again.",
  "requires-recent-login": "Confirm it is you again to do that.",
  "user-disabled": "That account has been disabled.",
  network: "Could not reach the account service. Check your connection.",
  "network-tls": NETWORK_TLS_UNTRUSTED_COPY,
  "not-configured": "This build has no hosted control plane configured.",
  "installation-limit": "This account already has the maximum number of desktops.",
  "mobile-device-limit": "This account already has the maximum number of phones.",
  "pairing-device-limit": "This desktop already has the maximum number of paired phones.",
  "account-mismatch": "That is a different account. Disconnect this installation first, or use the right address.",
  "billing-unconfigured": "Subscriptions are not available in this build.",
  "no-subscription": "There is no subscription to manage yet.",
  "already-subscribed": "This account already has a subscription.",
  "trial-already-used": "This desktop has already used its free trial.",
  "checkout-pending": "A checkout is already being prepared. Try again in a moment.",
  "provider-unavailable": "The payment service could not prepare the payment page. Try again later.",
  "entitlement-required": "This needs an active subscription.",
  "daily-limit": "You have sent the most diagnostics reports allowed today. Save the file instead.",
  "not-bound-to-an-account": "This desktop is not enrolled yet. Save the diagnostics to a file instead.",
  "diagnostics-empty": "There is nothing to report yet — this desktop has not done anything hosted.",
  // A fair-use cap this build has no specific name for. The three it does have are above; this is
  // what a bound added on the server after this release reads as, and "a limit" is still true.
  "cap-exceeded": "A limit on this account has been reached. Remove a device and try again.",
  // R14. The billing URL was not HTTPS, or its host is not on the allowlist the signed bootstrap
  // envelope carries. Shown rather than swallowed: a checkout that opened nothing is a payment
  // problem nobody can act on, and this one is not the user's to fix.
  "checkout-url-not-allowed": "This desktop would not open that payment page. Update strIDEterm, then try again.",
  // R12. The installation's own refresh token was rejected while this machine is bound. Minting a
  // new anonymous uid would silently replace the identity every pairing is keyed by, so it is
  // reported and the recovery enrolment is offered instead.
  "installation-identity-lost":
    "This desktop lost its own sign-in for the account. Sign in as the owner to reconnect it.",
  unknown: "That did not work. Try again.",
};

/**
 * The refusal to show, from EITHER of the two places one can appear.
 *
 * F09's last bullet. `actionError` is set by the store when an IPC call is rejected — which covers
 * everything the person did — and `state.lastError` is set by the BACKEND when something happened
 * without anybody asking: the attempt expiring, the polling loop meeting an address mismatch, the
 * broker failing. Reading only the first meant those three were invisible: the page went on saying
 * "check your email" for an attempt that had already failed.
 *
 * The action error wins when both are present, because it is the more recent and the more specific.
 */
const errorMessage = computed(() => {
  const code = account.actionError ?? account.state.lastError ?? "";
  return code ? (ERROR_COPY[code] ?? ERROR_COPY.unknown) : "";
});

/** Why no sign-in can be started, in the user's language. Four operator problems, four sentences. */
const SIGN_IN_UNAVAILABLE_COPY: Record<string, string> = {
  "not-configured": "This build has no hosted control plane configured.",
  "local-origin-missing": "This is a local build and no sign-in broker has been named for it.",
  "local-origin-invalid": "The sign-in broker named for this local build is not a usable address.",
  "environment-unsupported": "This build's environment has no sign-in broker deployed.",
  "environment-unresolved": "This build was started with an environment name it does not recognise.",
  "environment-contradiction":
    "This build declares a dev, qa or prod environment and is also configured with emulator hosts or a plain-HTTP database — one of the two has to go.",
  "environment-mismatch":
    "This data directory was already used for a different environment. Use a separate data directory for this one.",
  "local-endpoint-invalid":
    "This local build names a Firebase emulator or database address that is not on this machine. Local endpoints have to be loopback addresses for the declared demo project.",
};

const signInUnavailableReason = computed(() => {
  const code = account.state.signInUnavailableReason;
  return code ? (SIGN_IN_UNAVAILABLE_COPY[code] ?? "") : "";
});

/**
 * The copy for each notice kind.
 *
 * The wire carries the KIND, not the prose: a server that sent display strings would be a server
 * that has to be redeployed to fix a typo, and one that could put arbitrary text on this page. None
 * of these mentions a price or links to a checkout — a notice is a status, never a sales prompt.
 */
const NOTICE_COPY: Record<string, { title: string; body: string }> = {
  "trial-ending-3d": {
    title: "Trial ends in 3 days",
    body: "The hosted features stop then. Everything local stays free.",
  },
  "trial-ending-1d": {
    title: "Trial ends tomorrow",
    body: "The hosted features stop then. Everything local stays free.",
  },
  "trial-ended": {
    title: "Trial ended",
    body: "Pairing, push and the managed relay are off. The desktop app is unaffected.",
  },
  "cap-reached": { title: "Device limit reached", body: "Remove a device below to add another." },
  "payment-issue": { title: "Payment problem", body: "Update the payment method in the billing portal." },
  "access-ended": { title: "Hosted access ended", body: "Your terminals, workspaces and Quick Tunnel keep working." },
};

function noticeCopy(kind: string): { title: string; body: string } {
  return NOTICE_COPY[kind] ?? { title: "Account notice", body: "" };
}

/** A date, not a countdown: "in 3 days" is a number somebody has to convert back to plan around. */
function formatDate(epochMs: number | undefined): string {
  if (!epochMs) return "—";
  return new Date(epochMs).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

/**
 * A DAY, never a time of day (plan §8.4).
 *
 * The server composes this from bounded presence and registry data and coarsens it to the UTC day
 * before it leaves — a precise "14:32:07" would be a trace of somebody's working hours, and the
 * question this column exists to answer, "which of these machines can I remove", is answered exactly
 * as well by a date. Rendering the raw value with `toLocaleString` would print a midnight that never
 * happened and quietly imply a precision the number does not have.
 */
function formatLastSeen(epochMs: number | undefined): string {
  if (!epochMs) return "never";
  return new Date(epochMs).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

const stateCopy = computed(() => {
  const state = entitlement.value?.state;
  if (state === "trial") return { title: "Free trial", tone: "ok" };
  if (state === "active") {
    return entitlement.value?.source === "subscription"
      ? { title: "Subscribed", tone: "ok" }
      : { title: "Active access", tone: "ok" };
  }
  if (state === "past_due") return { title: "Payment problem", tone: "warn" };
  if (state === "lapsed") {
    return entitlement.value?.source === "trial"
      ? { title: "Trial ended", tone: "warn" }
      : { title: "Subscription ended", tone: "warn" };
  }
  if (state === "revoked") return { title: "Access revoked", tone: "warn" };
  if (state === "billing_unconfigured") return { title: "Not available in this build", tone: "muted" };
  if (state === "unbound") return { title: "No plan yet", tone: "muted" };
  return { title: busy.value ? "Loading account…" : "Account details unavailable", tone: "muted" };
});

const canChoosePlan = computed(() => {
  const state = entitlement.value?.state;
  return state === "trial" || state === "unbound" || state === "lapsed" || state === "revoked";
});

const canStartTrial = computed(() => {
  const state = entitlement.value?.state;
  return state === "unbound";
});

const hasActiveHostedAccess = computed(() => {
  const state = entitlement.value?.state;
  return state === "trial" || state === "active";
});

/**
 * Scrolls to the Phone pairing section rendered below this one on the same Mobile settings tab
 * (`SettingsMobileTab.vue`'s `#mobile-tab-phone-pairing` heading) — the plain pairing flow the plan
 * (§6, Fáze B) says "Připojit telefon" must lead into, rather than a QR/enrollment path of its own.
 */
function scrollToPhonePairing(): void {
  emit("navigate-phones");
}

async function copyReference(): Promise<void> {
  const reference = overview.value?.supportReference;
  if (!reference) return;
  await navigator.clipboard.writeText(reference);
  copiedReference.value = true;
  window.setTimeout(() => (copiedReference.value = false), 2000);
}

/**
 * Sends the report, opt-in and nothing else.
 *
 * The reference comes back in the broadcast state, so a second window and the window after a reopen
 * still show what to quote.
 */
async function sendDiagnostics(): Promise<void> {
  diagnosticsSavedPath.value = "";
  await account.submitDiagnostics(diagnosticsNote.value || undefined);
}

/** The same document, saved wherever the user points. The fallback when the upload is not there. */
async function saveDiagnostics(): Promise<void> {
  const saved = await account.exportDiagnostics(diagnosticsNote.value || undefined);
  diagnosticsSavedPath.value = saved ?? "";
}

/** The first sign-in: one address, one explicitly chosen intention. */
async function submitContinue(): Promise<void> {
  await account.beginSignIn(email.value, intent.value);
}

/**
 * Subscribe.
 *
 * This button only renders once the machine is enrolled (`phase === 'ready'`), and billing is
 * authorized server-side against THIS DESKTOP's own active installation record, not a live owner
 * session (I3) — so, unlike `startTrialFlow` below (which calls the OWNER-authenticated `startTrial`
 * and still needs one), this never has to detour through a fresh sign-in first.
 */
async function startPurchase(offerId: string): Promise<void> {
  await account.openCheckout(offerId);
}

/**
 * Start the trial — asking for a link first when there is no owner session (F06).
 *
 * This button used to call the owner endpoint directly. The owner credential is transient by design,
 * so after a restart — or after the `enrol-with-trial` chain released it — there was none, and the
 * call could only fail. The `trial` purpose exists for exactly this: prove the identity, then perform
 * the ONE step that is left, with the same idempotency key the lost attempt used.
 */
async function startTrialFlow(): Promise<void> {
  if (!account.state.needsRecentAuth) {
    await account.startTrial();
    return;
  }
  pendingPurpose.value = "trial";
  const address = account.state.ownerEmail || email.value;
  if (address) {
    await account.beginSignIn(address, "trial");
    return;
  }
  requestedAuth.value = { purpose: "trial", title: "Confirm your email to start the trial" };
}

/** The same, for the merchant's own portal — installation-authorized (I3), same reasoning as above. */
async function startPortal(): Promise<void> {
  await account.openBillingPortal();
}

/**
 * Removes a desktop/phone/pair, asking for a fresh link first when the local recent-auth window has
 * lapsed (plan §7/C2: "Desktop má umět obsloužit recent-auth odmítnutí a vrátit se ke konkrétnímu
 * potvrzovanému záměru"). Same shape as `startTrialFlow` above: revoking is the one decision already
 * made by pressing the button, so — unlike change-email/delete-account — there is no separate form to
 * come back to; the `revoke-device` purpose performs this exact request itself once re-proved.
 */
async function revokeOrReauth(
  kind: "installation" | "mobile-device" | "pair" | "account-wide",
  targetId?: string,
): Promise<void> {
  if (!account.state.needsRecentAuth) {
    await account.revoke(kind, targetId);
    return;
  }
  const address = account.state.ownerEmail || email.value;
  const offerId = JSON.stringify([kind, targetId ?? null]);
  if (!address) {
    requestedAuth.value = {
      purpose: "revoke-device",
      offerId,
      title:
        kind === "installation"
          ? "Confirm your email to remove this desktop"
          : "Confirm your email to remove this phone",
    };
    return;
  }
  // Mirrors `decodeRevokeTarget` in `electron/backend/account/account-manager.ts` — keep both in sync.
  await account.beginSignIn(address, "revoke-device", offerId);
}

async function submitRequestedAuth(): Promise<void> {
  if (!requestedAuth.value || !email.value) return;
  const request = requestedAuth.value;
  requestedAuth.value = null;
  await account.beginSignIn(email.value, request.purpose, request.offerId);
}

/**
 * Reauthenticate for one action, from a machine that is already enrolled.
 *
 * The address is the one the account state already carries when there is one; otherwise the person
 * types it. That second case is the ordinary one after a restart — the owner session is transient by
 * design, so a button that assumed `ownerEmail` would be a button that does nothing (plan §7).
 *
 * NEVER `"checkout"`/`"portal"` any more: both are installation-authorized (I3, `bc8d408`) and go
 * straight through `startPurchase`/`startPortal` below, never through this reauth detour.
 */
async function startReauth(
  purpose: "reauth" | "trial" | "change-email" | "delete-account" = pendingPurpose.value,
): Promise<void> {
  const address = account.state.ownerEmail || email.value;
  if (!address) return;
  await account.beginSignIn(address, purpose);
}

/** The manual fallback. The field is cleared the moment the link has been handed over. */
async function submitPastedLink(): Promise<void> {
  const link = pastedLink.value;
  pastedLink.value = "";
  await account.submitSignInLink(link);
}

async function submitChangeEmail(): Promise<void> {
  await account.changeLoginEmail(newEmail.value);
  newEmail.value = "";
}

async function submitDelete(): Promise<void> {
  await account.deleteAccount(confirmationPhrase.value);
  confirmationPhrase.value = "";
  showDelete.value = false;
}
</script>

<template>
  <section class="account-tab" :class="`account-tab--${props.view}`">
    <!-- THE REFUSAL, WHERE THE PERSON IS LOOKING. It used to render at the very bottom of a long
         scrolling panel, so a failure that reset the view to the top left an `role="alert"` the user
         never saw — which is indistinguishable from the app saying nothing at all, and is exactly
         what happened to a registration that died on a missing installation session. An alert
         belongs above the thing it is about. -->
    <p v-if="errorMessage" class="account-error" role="alert">{{ errorMessage }}</p>

    <!-- THE FALLBACK LINE, for work no button on this page started — a refresh the backend issued,
         or an operation begun in another window. When somebody DID press a button, the spinner lives
         in that button instead: a progress line at the top of the panel is not feedback for a click
         that happened further down, which is exactly how a five-second registration read as a page
         that had ignored the press. `aria-live` because a spinner nobody can see is not feedback. -->
    <p v-if="busy && pendingAction === null" class="account-busy" role="status" aria-live="polite">
      <span class="account-spinner" aria-hidden="true"></span>
      <span>{{ busyLabel }}</span>
    </p>

    <div v-if="requestedAuth && !auth" class="account-confirm account-auth account-auth--requested" role="region">
      <h4>{{ requestedAuth.title }}</h4>
      <p class="account-note">Enter the login email for this account. We will send a one-time link.</p>
      <label class="account-field">
        <span>Login email</span>
        <input v-model="email" type="email" autocomplete="username" :disabled="busy" />
      </label>
      <div class="account-actions">
        <button
          type="button"
          class="button"
          :disabled="busy || !email"
          @click="act('requested-auth', submitRequestedAuth)"
        >
          <span v-if="pendingAction === 'requested-auth'" class="button-spinner" aria-hidden="true"></span>
          Send confirmation link
        </button>
        <button type="button" class="button button--ghost" :disabled="busy" @click="requestedAuth = null">
          Cancel
        </button>
      </div>
    </div>

    <div v-if="props.view === 'overview' && !auth && !requestedAuth" class="account-overview-card">
      <div>
        <p class="account-kicker">strIDEterm Mobile</p>
        <h3 v-if="phase === 'ready'">{{ stateCopy.title }}</h3>
        <h3 v-else>Take your desktop with you</h3>
        <p v-if="phase !== 'ready'" class="account-lead">
          Open terminals, follow tasks, and receive notifications on your phone.
        </p>
      </div>
      <template v-if="!account.available">
        <p class="account-note">Mobile account features are available in the desktop app.</p>
      </template>
      <template v-else-if="phase === 'unconfigured'">
        <p class="account-note account-note--warn">Mobile access is not configured in this build.</p>
      </template>
      <template v-else-if="phase === 'signed-out' || (phase === 'signing-in' && !auth)">
        <div class="onboarding-choice">
          <label :class="['onboarding-option', { 'onboarding-option--selected': intent === 'enrol-with-trial' }]">
            <input v-model="intent" type="radio" value="enrol-with-trial" />
            <span
              ><strong>Start with 14 days free</strong
              ><small>Set up this desktop and explore Mobile first.</small></span
            >
          </label>
          <label :class="['onboarding-option', { 'onboarding-option--selected': intent === 'enrol' }]">
            <input v-model="intent" type="radio" value="enrol" />
            <span><strong>Sign in to an existing account</strong><small>Add this desktop to your account.</small></span>
          </label>
        </div>
        <label class="account-field"
          ><span>Email</span><input v-model="email" type="email" autocomplete="username" :disabled="busy"
        /></label>
        <button
          type="button"
          class="button account-overview-card__action"
          :disabled="busy || !email || !account.state.signInAvailable"
          @click="act('continue', submitContinue)"
        >
          <span v-if="pendingAction === 'continue'" class="button-spinner" aria-hidden="true"></span>
          Continue with email
        </button>
        <p class="account-note">We'll email you a one-time sign-in link. The desktop app stays free.</p>
        <button type="button" class="link account-restore" @click="intent = 'recover-uid'">
          Restore a previous enrolment
        </button>
        <p v-if="!account.state.signInAvailable" class="account-note account-note--warn">
          Signing in is not available in this build.<span v-if="signInUnavailableReason">
            {{ signInUnavailableReason }}</span
          >
        </p>
      </template>
      <template v-else-if="phase === 'enrolling'">
        <p class="account-note">
          Signed in as <strong>{{ account.state.ownerEmail }}</strong
          >. Finish adding this desktop.
        </p>
        <div class="account-actions">
          <button type="button" class="button" :disabled="busy" @click="act('enrol', () => account.enrol('register'))">
            Add this desktop
          </button>
          <button
            type="button"
            class="button button--ghost"
            :disabled="busy"
            @click="act('recover', () => account.enrol('recover-uid'))"
          >
            Restore enrolment
          </button>
        </div>
      </template>
      <template v-else-if="phase === 'ready'">
        <div class="account-overview-card__facts">
          <span>{{ account.state.ownerEmail }}</span>
          <span v-if="entitlement?.planLabel">{{ entitlement.planLabel }}</span>
        </div>
        <div v-if="trialDaysLeft !== null" class="trial-indicator" role="status">
          <div class="trial-indicator__heading">
            <span
              ><strong>{{ trialDaysLeft }}</strong
              ><small>{{ trialDaysLeft === 1 ? "day left" : "days left" }}</small></span
            >
            <small>Ends {{ formatDate(entitlement?.notAfter) }}</small>
          </div>
          <div class="trial-indicator__track" aria-hidden="true">
            <span :style="{ width: `${trialProgress}%` }"></span>
          </div>
          <small>{{
            props.phoneCount > 0 ? "Manage your connected phones below." : "Connect your phone to get started."
          }}</small>
        </div>
        <p v-else-if="entitlement?.state === 'active' && entitlement?.renewalAt" class="account-note">
          Renews {{ formatDate(entitlement.renewalAt) }}
        </p>
        <p v-else-if="entitlement?.state === 'active' && entitlement?.notAfter" class="account-note">
          Access until {{ formatDate(entitlement.notAfter) }}
        </p>
        <p v-if="entitlement?.state === 'past_due'" class="account-note account-note--warn">
          Update your payment details to keep Mobile access.
        </p>
        <p
          v-else-if="entitlement?.state === 'lapsed' || entitlement?.state === 'revoked'"
          class="account-note account-note--warn"
        >
          Mobile access has ended. Review your plan to restore it.
        </p>
        <p v-else-if="!entitlement" :class="['account-note', { 'account-note--warn': !busy }]">
          {{
            busy
              ? "Fetching your account details."
              : "Account details are unavailable right now. Try loading them again."
          }}
        </p>
        <div v-if="entitlement" class="account-actions">
          <button
            v-if="hasActiveHostedAccess"
            type="button"
            class="button account-overview-card__action"
            @click="scrollToPhonePairing"
          >
            {{ props.phoneCount > 0 ? "Manage phones" : "Connect first phone" }}
          </button>
          <button
            type="button"
            :class="['button', { 'button--ghost': hasActiveHostedAccess }]"
            @click="emit('navigate-account')"
          >
            {{
              entitlement?.state === "trial" ? "View plans" : hasActiveHostedAccess ? "Plan and account" : "Review plan"
            }}
          </button>
        </div>
        <button
          v-else-if="!busy"
          type="button"
          class="button button--ghost account-overview-card__action"
          :disabled="busy"
          @click="account.refreshOverview()"
        >
          Retry
        </button>
      </template>
    </div>

    <div v-if="props.view === 'account' || auth" class="account-detail">
      <p v-if="!account.available" class="account-note">The hosted account is only available in the desktop app.</p>

      <template v-else-if="phase === 'unconfigured'">
        <p class="account-note">
          This build has no hosted control plane configured. Everything local — terminals, workspaces, the LAN server
          and Quick Tunnel — works exactly as it does otherwise.
        </p>
      </template>

      <template v-else>
        <!-- Waiting for a link ------------------------------------------------------------------
           Rendered in EVERY phase that can have one, and deliberately not as a phase of its own for
           an enrolled desktop: reauthenticating must not hide the device list and the entitlement
           this page exists to show (plan §8, Fáze 3). -->
        <div v-if="auth" class="account-confirm account-auth">
          <template v-if="auth.phase === 'sending'">
            <h4>Sending a sign-in link…</h4>
            <p class="account-note">To {{ auth.email }}.</p>
          </template>

          <template v-else-if="auth.phase === 'awaiting-confirmation'">
            <h4>Sign this computer in as {{ auth.email }}?</h4>
            <p class="account-note">
              The link was opened and confirmed. Nothing has been signed in yet — this last step happens on this
              computer.
            </p>
            <div class="account-actions">
              <button
                type="button"
                class="button"
                :disabled="busy"
                @click="act('confirm', () => account.confirmSignIn())"
              >
                <span v-if="pendingAction === 'confirm'" class="button-spinner" aria-hidden="true"></span>
                Sign in on this computer
              </button>
              <button type="button" class="button button--ghost" :disabled="busy" @click="account.cancelSignIn()">
                Cancel
              </button>
            </div>
          </template>

          <template v-else-if="auth.phase === 'verifying'">
            <h4>Signing in…</h4>
            <p class="account-note">Checking the link and this computer's account.</p>
          </template>

          <template v-else>
            <h4>Check your email</h4>
            <!-- "SENT", NEVER "DELIVERED" (plan §8, Fáze 3). A successful request to the identity
               service is not evidence that a message arrived — and with enumeration protection on,
               it is not even evidence that the address exists. -->
            <!-- AND "UNKNOWN" IS A THIRD ANSWER (F03). When the send request went out and no answer
               came back, this desktop cannot claim it was sent and must not claim it failed: the
               message may be in the mailbox, and the attempt is still completable. Asking for another
               one invalidates whatever did arrive (phase-0 row 26), so checking comes first. -->
            <p v-if="auth.sendOutcome === 'unknown'" class="account-note account-note--warn">
              The sign-in service did not confirm whether the link to <strong>{{ auth.email }}</strong> was sent. It may
              have arrived anyway — check that mailbox, including the spam folder, and open the newest message. Only ask
              for another link if nothing is there: a new one stops the older link working.
            </p>
            <p v-else class="account-note">
              A sign-in link was sent to <strong>{{ auth.email }}</strong
              >. Open it on this computer or on your phone — either finishes the sign-in here. If it is not there, check
              the spam folder.
            </p>
            <p class="account-note account-note--muted">
              The link works for about {{ expiresInMinutes }} more minute{{ expiresInMinutes === 1 ? "" : "s" }}. If you
              ask for another one, only the newest message works.
            </p>
            <p v-if="auth.manualOnly" class="account-note account-note--warn">
              The sign-in service could not be reached, so this link cannot be confirmed in the browser. Paste the whole
              link below instead.
            </p>
            <div class="account-actions">
              <button
                type="button"
                class="button button--ghost"
                :disabled="busy || resendInSeconds > 0"
                @click="act('resend', () => account.resendSignIn())"
              >
                <span v-if="pendingAction === 'resend'" class="button-spinner" aria-hidden="true"></span>
                {{ resendInSeconds > 0 ? `Send it again in ${resendInSeconds}s` : "Send it again" }}
              </button>
              <button type="button" class="button button--ghost" :disabled="busy" @click="account.cancelSignIn()">
                Use a different address
              </button>
              <button type="button" class="link" @click="showPaste = !showPaste">
                {{ showPaste ? "Hide" : "Paste the link from the email" }}
              </button>
            </div>
            <div v-if="showPaste || auth.manualOnly" class="account-paste">
              <label class="account-field">
                <span>Paste the whole sign-in link from the email</span>
                <input
                  v-model="pastedLink"
                  type="text"
                  autocomplete="off"
                  spellcheck="false"
                  :disabled="busy"
                  placeholder="https://…"
                />
              </label>
              <button
                type="button"
                class="button"
                :disabled="busy || !pastedLink"
                @click="act('paste', submitPastedLink)"
              >
                <span v-if="pendingAction === 'paste'" class="button-spinner" aria-hidden="true"></span>
                Use this link
              </button>
              <!-- WHERE THE LINK ACTUALLY IS, because selecting the words does not get it. Phase 0's
                 delivery step read a real message: the sign-in mail is `multipart/alternative`, its
                 HTML part carries the whole URL in ONE anchor whose text is "Sign in to …", and its
                 plain-text alternative carries that same text and NO URL at all. So a person who
                 selects and copies what they can see pastes a sentence here and meets `invalid-code`
                 for a reason nothing on this page would have explained. -->
              <p class="account-note account-note--muted">
                The message shows the link as words to click, not as an address — copy the link itself (right-click it
                and choose to copy the address). strIDEterm reads the link and never opens it. The field is cleared as
                soon as it is used.
              </p>
            </div>
            <p class="account-note account-note--muted">
              Cancelling stops this computer waiting for the link. It does not make the link itself stop working — only
              the sign-in service decides that.
            </p>
          </template>
        </div>

        <!-- Signed out ------------------------------------------------------------------------- -->
        <template v-if="props.view === 'account' && (phase === 'signed-out' || (phase === 'signing-in' && !auth))">
          <h4>Sign in</h4>
          <p class="account-note">
            An account is only needed for the hosted features: pairing a phone, push notifications and the managed
            relay. The desktop app itself is free.
          </p>
          <p v-if="!account.state.signInAvailable" class="account-note account-note--warn">
            Signing in is not available in this build. Everything local keeps working.
            <span v-if="signInUnavailableReason"> {{ signInUnavailableReason }}</span>
          </p>
          <!-- WHICH BACKEND (F11). A desktop signed in to qa looks exactly like one signed in to prod
             otherwise, which is how a test address ends up in a real account. Prod is the ordinary
             case and says nothing; local, dev and qa say so. -->
          <p
            v-else-if="account.state.authEnvironment && account.state.authEnvironment !== 'prod'"
            class="account-note account-note--muted"
          >
            This build signs in against the <strong>{{ account.state.authEnvironment }}</strong> account service.
          </p>

          <label class="account-field">
            <span>Email</span>
            <input v-model="email" type="email" autocomplete="username" :disabled="busy" />
          </label>
          <label class="account-field">
            <span>What should this do?</span>
            <select v-model="intent" :disabled="busy">
              <option value="enrol-with-trial">Add this computer and start the free trial</option>
              <option value="enrol">Add this computer to an account I already have</option>
              <option value="recover-uid">Restore a previous enrolment on this computer</option>
            </select>
          </label>
          <div class="account-actions">
            <button
              type="button"
              class="button"
              :disabled="busy || !email || !account.state.signInAvailable"
              @click="act('continue', submitContinue)"
            >
              <span v-if="pendingAction === 'continue'" class="button-spinner" aria-hidden="true"></span>
              Continue
            </button>
          </div>
          <p class="account-note account-note--muted">
            There is no password. strIDEterm emails a one-time link, and opening it is what signs this computer in.
          </p>
        </template>

        <!-- Signed in, this machine not enrolled -------------------------------------------------- -->
        <template v-else-if="props.view === 'account' && phase === 'enrolling'">
          <h4>Add this desktop</h4>
          <p class="account-note">
            Signed in as <strong>{{ account.state.ownerEmail }}</strong
            >. This machine is not part of the account yet.
          </p>
          <div class="account-actions">
            <button
              type="button"
              class="button"
              :disabled="busy"
              @click="act('enrol', () => account.enrol('register'))"
            >
              <span v-if="pendingAction === 'enrol'" class="button-spinner" aria-hidden="true"></span>
              Add this desktop
            </button>
            <button
              type="button"
              class="button button--ghost"
              :disabled="busy"
              @click="act('recover', () => account.enrol('recover-uid'))"
            >
              <span v-if="pendingAction === 'recover'" class="button-spinner" aria-hidden="true"></span>
              Restore a previous enrolment
            </button>
          </div>
        </template>

        <!-- Ready --------------------------------------------------------------------------------- -->
        <template v-else-if="props.view === 'account' && phase === 'ready'">
          <section class="account-section account-section--plan">
            <header class="account-header">
              <div>
                <p class="account-section__eyebrow">Plan and billing</p>
                <h4 :class="`account-state account-state--${stateCopy.tone}`">{{ stateCopy.title }}</h4>
                <p class="account-note">
                  {{ account.state.ownerEmail ?? overview?.supportReference }} ·
                  {{ entitlement?.planLabel ?? "strIDEterm" }}
                </p>
              </div>
              <button
                type="button"
                class="button button--ghost button--small"
                :disabled="busy"
                @click="account.refreshOverview()"
              >
                Refresh
              </button>
            </header>

            <!-- The dates, as dates -->
            <dl class="account-facts">
              <template v-if="entitlement?.state === 'trial'">
                <dt>Trial ends</dt>
                <dd>{{ formatDate(entitlement?.notAfter) }}</dd>
              </template>
              <template v-else-if="entitlement?.renewalAt">
                <dt>Renews</dt>
                <dd>{{ formatDate(entitlement?.renewalAt) }}</dd>
              </template>
              <template v-else-if="entitlement?.notAfter">
                <dt>Access until</dt>
                <dd>{{ formatDate(entitlement?.notAfter) }}</dd>
              </template>
            </dl>

            <p v-if="entitlement?.state === 'past_due'" class="account-note account-note--warn">
              A payment did not go through. Everything local keeps working; update the payment method in the billing
              portal to keep the hosted features.
            </p>
            <p
              v-else-if="entitlement?.state === 'lapsed' || entitlement?.state === 'revoked'"
              class="account-note account-note--warn"
            >
              The hosted features are off. Your terminals, workspaces, the LAN server and Quick Tunnel are free and
              unaffected.
            </p>

            <!-- Offers: server-supplied, never a price this client assembled -->
            <div v-if="overview?.billingConfigured && canChoosePlan" class="account-offers">
              <button
                v-for="(offer, index) in overview?.offers ?? []"
                :key="offer.offerId"
                type="button"
                :class="['button', { 'button--ghost': index > 0 }]"
                :disabled="busy"
                @click="startPurchase(offer.offerId)"
              >
                {{ offer.billingPeriod === "annual" ? "Subscribe yearly" : "Subscribe monthly" }} —
                {{ offer.formattedPrice }}
              </button>
              <button
                v-if="canStartTrial"
                type="button"
                class="button button--ghost"
                :disabled="busy"
                @click="startTrialFlow"
              >
                Start 14-day trial
              </button>
            </div>
            <button
              v-if="overview?.billingConfigured && entitlement?.source === 'subscription'"
              type="button"
              class="button button--ghost"
              :disabled="busy"
              @click="startPortal"
            >
              Manage billing
            </button>
            <p v-else-if="!overview?.billingConfigured" class="account-note">
              Subscriptions are not available in this build.
            </p>

            <p v-if="entitlement?.source === 'subscription'" class="account-note account-note--muted">
              Payment methods, invoices and cancellation are handled in the billing portal.
            </p>
          </section>

          <!-- Usage -->
          <section class="account-section">
            <div class="account-section__heading">
              <h5>Account usage</h5>
              <span>Across all your devices</span>
            </div>
            <div class="account-usage">
              <div>
                <strong>{{ overview?.usage.installations.used }} / {{ overview?.usage.installations.limit }}</strong
                ><span>Desktops</span>
              </div>
              <div>
                <strong>{{ overview?.usage.mobileDevices.used }} / {{ overview?.usage.mobileDevices.limit }}</strong
                ><span>Phones</span>
              </div>
              <div>
                <strong
                  >{{ overview?.usage.activeRelaySessions.used }} /
                  {{ overview?.usage.activeRelaySessions.limit }}</strong
                ><span>Open relay sessions</span>
              </div>
            </div>

            <!-- Notices -->
            <div v-if="account.notices.length > 0" class="account-notices">
              <h5>Notices</h5>
              <div v-for="notice in account.notices" :key="notice.noticeId" class="account-notice">
                <div>
                  <strong>{{ noticeCopy(notice.kind).title }}</strong>
                  <p>{{ noticeCopy(notice.kind).body }}</p>
                </div>
                <button type="button" class="link" :disabled="busy" @click="account.acknowledgeNotice(notice.noticeId)">
                  Dismiss
                </button>
              </div>
            </div>
          </section>

          <!-- Devices -->
          <section class="account-section">
            <div class="account-section__heading">
              <h5>Account-wide devices</h5>
              <span>All desktops and phones</span>
            </div>
            <h5>Desktops</h5>
            <table class="account-devices">
              <tbody>
                <tr v-for="installation in overview?.installations ?? []" :key="installation.installationId">
                  <td>
                    {{ installation.label ?? installation.installationId }}
                    <span v-if="installation.isThisInstallation" class="account-badge">this one</span>
                  </td>
                  <td class="account-muted" title="Last seen is approximate">
                    last seen {{ formatLastSeen(installation.lastSeenAt) }}
                  </td>
                  <td>
                    <button
                      v-if="installation.state === 'active'"
                      type="button"
                      class="button button--ghost button--small"
                      :disabled="busy"
                      @click="revokeOrReauth('installation', installation.installationId)"
                    >
                      Remove from account
                    </button>
                    <span v-else class="account-muted">removed</span>
                  </td>
                </tr>
              </tbody>
            </table>
            <p class="account-note account-note--muted">
              Removing a desktop disconnects its hosted access. Local terminals keep working.
            </p>

            <h5>Phones</h5>
            <!-- No enrollment/QR flow lives here any more (plan §6, Fáze B) — this is the entry point the
             bullet asks for, re-pointed at the same plain pairing flow the Phone pairing section below
             renders, not a parallel path of its own. -->
            <button
              type="button"
              class="button button--ghost button--small account-connect-phone"
              title="Opens the same phone pairing flow as the Phone pairing section on this tab."
              @click="scrollToPhonePairing"
            >
              Connect phone
            </button>
            <p v-if="(overview?.mobileDevices ?? []).length === 0" class="account-note">
              No phones on this account yet.
            </p>
            <table class="account-devices">
              <tbody>
                <tr v-for="device in overview?.mobileDevices ?? []" :key="device.mobileDeviceKeySuffix">
                  <td>{{ device.label ?? device.platform }} · …{{ device.mobileDeviceKeySuffix }}</td>
                  <td class="account-muted" title="Last seen is approximate">
                    {{ device.pairs.length }} pairing{{ device.pairs.length === 1 ? "" : "s" }} · last seen
                    {{ formatLastSeen(device.lastSeenAt) }}
                  </td>
                  <td>
                    <button
                      v-if="device.state === 'active'"
                      type="button"
                      class="button button--ghost button--small"
                      :disabled="busy"
                      @click="revokeOrReauth('mobile-device', device.mobileDeviceKeySuffix)"
                    >
                      Remove from account
                    </button>
                    <span v-else class="account-muted">removed</span>
                  </td>
                </tr>
              </tbody>
            </table>
            <p class="account-note account-note--muted">Removing a phone disconnects all of its desktop pairings.</p>
          </section>

          <!-- Identity -->
          <details class="account-section account-disclosure">
            <summary>
              <span
                ><strong>Login and support</strong><small>{{ account.state.ownerEmail }}</small></span
              >
            </summary>
            <h5>Login and support</h5>
            <p class="account-note">
              Support reference
              <code>{{ overview?.supportReference }}</code>
              <button type="button" class="link" @click="copyReference">
                {{ copiedReference ? "Copied" : "Copy" }}
              </button>
            </p>

            <!--
          The last sentence is a MEASUREMENT, not a caution: phase 0 row 39 — applying the change ends
          the session that asked for it — and row 40 — the old address then signs in to a brand-new
          empty account, and with enumeration protection on it cannot be told that it moved. Somebody
          who reaches for the address they have always used would meet `account-mismatch` and read it
          as their account having vanished.
        -->
            <p v-if="pendingEmailChange" class="account-note account-note--warn">
              A change of login email to <strong>{{ pendingEmailChange.email }}</strong> is waiting to be confirmed.
              Open the link in that mailbox. Until then this account keeps its current login address, so nothing is lost
              if the new one was a typo. Once it is open, the new address is the one to sign in with — the old one no
              longer reaches this account.
              <button type="button" class="link" @click="account.clearPendingEmailChange()">Hide</button>
            </p>

            <div v-if="account.state.needsRecentAuth && !auth" class="account-reauth">
              <p class="account-note">
                To change the login email or delete the account, confirm it is you — strIDEterm sends a one-time link.
              </p>
              <label v-if="!account.state.ownerEmail" class="account-field">
                <span>Your login email</span>
                <input v-model="email" type="email" autocomplete="username" :disabled="busy" />
              </label>
              <div class="account-actions">
                <button
                  type="button"
                  class="button"
                  :disabled="busy || (!account.state.ownerEmail && !email)"
                  @click="startReauth()"
                >
                  Confirm it is you
                </button>
              </div>
            </div>
            <template v-else-if="!auth">
              <label class="account-field">
                <span>Change login email</span>
                <input v-model="newEmail" type="email" :disabled="busy" placeholder="new@example.com" />
              </label>
              <div class="account-actions">
                <button
                  type="button"
                  class="button button--ghost"
                  :disabled="busy || !newEmail"
                  @click="submitChangeEmail"
                >
                  Change login email
                </button>
              </div>
              <p class="account-note account-note--muted">
                strIDEterm emails the NEW address. The change happens only when that link is opened, so the current
                login keeps working until then. This is the LOGIN email only — the billing email is changed in the
                billing portal.
              </p>
            </template>
          </details>

          <!-- Destructive -->
          <details class="account-section account-disclosure account-disclosure--danger">
            <summary>
              <span
                ><strong>Sign out or close account</strong
                ><small>Actions that disconnect devices or remove data</small></span
              >
            </summary>
            <div class="account-danger">
              <button type="button" class="link" :disabled="busy" @click="showSignOut = !showSignOut">
                Sign this desktop out
              </button>
              <button type="button" class="link" :disabled="busy" @click="showDelete = !showDelete">
                Delete account
              </button>
            </div>

            <div v-if="showSignOut" class="account-confirm">
              <p v-if="(overview?.mobileDevices ?? []).some((device) => device.state === 'active')">
                This desktop still has phones paired to it. Signing out disconnects them — they will need to be paired
                again.
              </p>
              <p v-else>This desktop will lose its hosted access. Your account and other machines are unaffected.</p>
              <div class="account-actions">
                <button type="button" class="button button--danger" :disabled="busy" @click="account.signOut(true)">
                  Disconnect this installation
                </button>
                <button type="button" class="button button--ghost" @click="showSignOut = false">Cancel</button>
              </div>
            </div>

            <div v-if="showDelete" class="account-confirm account-confirm--danger">
              <p>
                This closes the account for every device, cancels the subscription and deletes the personal data. It
                cannot be undone. Type <code>DELETE MY ACCOUNT</code> to confirm.
              </p>
              <p v-if="account.state.needsRecentAuth" class="account-note account-note--warn">
                Confirm it is you first — use the button above. Clicking a link in an email never deletes anything on
                its own.
              </p>
              <input v-model="confirmationPhrase" type="text" :disabled="busy" />
              <div class="account-actions">
                <button
                  type="button"
                  class="button button--danger"
                  :disabled="busy || confirmationPhrase !== 'DELETE MY ACCOUNT' || account.state.needsRecentAuth"
                  @click="submitDelete"
                >
                  Delete account
                </button>
                <button type="button" class="button button--ghost" @click="showDelete = false">Cancel</button>
              </div>
            </div>
          </details>
        </template>
      </template>

      <!-- Diagnostics ------------------------------------------------------------------------
         Available in EVERY phase, including before there is an account at all. When something is
         broken, the state the page is in is usually part of what is broken — a report you can only
         produce once everything works is a report nobody needs. Sending needs an enrolled machine
         (the server resolves the account from this installation's membership); saving locally never
         does, which is what makes it the honest fallback. -->
      <template v-if="props.view === 'account' && account.available">
        <div class="account-danger">
          <button type="button" class="link" @click="showDiagnostics = !showDiagnostics">
            {{ showDiagnostics ? "Hide diagnostics" : "Send diagnostics to support" }}
          </button>
        </div>
        <div v-if="showDiagnostics" class="account-confirm">
          <p class="account-note">
            This sends a short record of what this desktop's account and pairing operations did — the operation, whether
            it worked, and the refusal code if it did not. No terminal output, no file paths, no workspace names, no
            passwords, no sign-in links and no email address. Save it first if you would like to read it.
          </p>
          <label class="account-field">
            <span>What went wrong? (optional)</span>
            <input v-model="diagnosticsNote" type="text" maxlength="500" :disabled="busy" />
          </label>
          <div class="account-actions">
            <button v-if="phase === 'ready'" type="button" class="button" :disabled="busy" @click="sendDiagnostics">
              Send
            </button>
            <button type="button" class="button button--ghost" :disabled="busy" @click="saveDiagnostics">
              Save to a file
            </button>
          </div>
          <p v-if="phase !== 'ready'" class="account-note account-note--muted">
            Sending needs this desktop to be signed in and enrolled. Until then, save the file and attach it to an
            email.
          </p>
          <p v-if="account.state.lastDiagnosticsReportId" class="account-note">
            Sent. Quote this reference:
            <code>{{ account.state.lastDiagnosticsReportId }}</code>
          </p>
          <p v-if="diagnosticsSavedPath" class="account-note">
            Saved to <code>{{ diagnosticsSavedPath }}</code>
          </p>
        </div>
      </template>
    </div>
  </section>
</template>

<style scoped>
.account-tab {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: min(100%, 820px);
  max-width: 820px;
}
.account-tab h3,
.account-tab h4,
.account-tab h5 {
  margin: 0;
}
.account-overview-card {
  display: grid;
  gap: 14px;
  padding: clamp(18px, 3vw, 28px);
  border: 1px solid color-mix(in srgb, var(--accent, #f2a63b) 28%, var(--border, #333));
  border-radius: 12px;
  background: linear-gradient(135deg, color-mix(in srgb, var(--accent, #f2a63b) 9%, transparent), transparent 65%);
}
.account-kicker {
  margin: 0 0 5px;
  color: var(--accent, #f2a63b);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.account-overview-card h3 {
  font-size: 21px;
  font-weight: 650;
}
.account-lead {
  max-width: 54ch;
  margin: 7px 0 0;
  color: var(--text, #f2f2f2);
  font-size: 13px;
  line-height: 1.55;
}
.onboarding-choice {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}
.onboarding-option {
  display: flex;
  gap: 9px;
  min-width: 0;
  padding: 11px;
  border: 1px solid var(--border, #333);
  border-radius: 8px;
  cursor: pointer;
  background: color-mix(in srgb, var(--panel) 94%, rgba(var(--tint), 0.04));
}
.onboarding-option--selected {
  border-color: color-mix(in srgb, var(--accent, #f2a63b) 72%, var(--border, #333));
  background: color-mix(in srgb, var(--accent, #f2a63b) 10%, transparent);
}
.onboarding-option input[type="radio"] {
  flex: 0 0 16px;
  align-self: center;
  width: 16px;
  min-width: 16px;
  max-width: 16px;
  height: 16px;
  min-height: 16px;
  max-height: 16px;
  margin: 0;
  padding: 0;
  accent-color: var(--accent, #f2a63b);
}
.onboarding-option span {
  display: grid;
  gap: 3px;
  color: var(--text);
  letter-spacing: normal;
  text-transform: none;
}
.onboarding-option strong,
.onboarding-option small {
  letter-spacing: normal;
  text-transform: none;
}
.onboarding-option small {
  color: var(--muted);
  line-height: 1.35;
}
.account-restore {
  justify-self: start;
}
.account-overview-card__action {
  justify-self: start;
}
.account-overview-card__facts {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  color: var(--muted);
  font-size: 12px;
}
.trial-indicator {
  display: grid;
  gap: 6px;
  font-size: 12px;
}
.trial-indicator__heading {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 12px;
}
.trial-indicator__heading > span {
  display: flex;
  align-items: baseline;
  gap: 6px;
}
.trial-indicator__heading > span strong {
  color: var(--text, #f2f2f2);
  font-size: 30px;
  line-height: 1;
}
.trial-indicator__heading > span small {
  color: var(--text, #f2f2f2);
  font-weight: 600;
}
.trial-indicator__track {
  height: 6px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--border, #333);
}
.trial-indicator__track span {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--accent, #f2a63b);
}
.trial-indicator small {
  color: var(--muted);
}
.account-state--warn {
  color: var(--warn, #d08a34);
}
.account-state--muted {
  color: var(--muted);
}
.account-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
}
.account-detail {
  display: grid;
  gap: 12px;
}
.account-section {
  display: grid;
  gap: 10px;
  margin: 0;
  padding: 14px;
  border: 1px solid var(--border, #333);
  border-radius: 9px;
  background: color-mix(in srgb, var(--panel) 96%, rgba(var(--tint), 0.03));
}
.account-section--plan {
  border-color: color-mix(in srgb, var(--accent, #f2a63b) 24%, var(--border, #333));
}
.account-section__eyebrow {
  margin: 0 0 3px;
  color: var(--muted);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.account-section__heading {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}
.account-section__heading span {
  color: var(--muted);
  font-size: 11px;
}
.account-disclosure {
  display: block;
}
.account-disclosure > summary {
  cursor: pointer;
  list-style-position: outside;
}
.account-disclosure > summary span {
  display: inline-grid;
  gap: 2px;
  margin-left: 3px;
}
.account-disclosure > summary small {
  color: var(--muted);
  font-weight: 400;
}
.account-disclosure[open] > summary {
  margin-bottom: 12px;
}
.account-disclosure--danger[open] {
  border-color: color-mix(in srgb, var(--danger, #c0392b) 45%, var(--border, #333));
}
.account-note {
  color: var(--muted);
  font-size: 12px;
  margin: 0;
}
.account-note--warn {
  color: var(--warn, #d08a34);
}
.account-note--muted {
  opacity: 0.8;
}
.account-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
}
.account-actions {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
.account-offers {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.account-connect-phone {
  min-height: 32px;
  justify-self: start;
}
.account-facts {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 2px 12px;
  margin: 0;
  font-size: 12px;
}
.account-usage {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 7px;
  margin: 0;
  padding: 0;
}
.account-usage > div {
  display: grid;
  gap: 2px;
  padding: 9px;
  border: 1px solid var(--border, #333);
  border-radius: 7px;
}
.account-usage strong {
  font-size: 14px;
}
.account-usage span {
  color: var(--muted);
  font-size: 10px;
}
.account-devices {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.account-devices td {
  padding: 7px 6px;
  border-bottom: 1px solid var(--border, #333);
}
.account-devices td:first-child {
  padding-left: 0;
}
.account-devices td:last-child {
  padding-right: 0;
  text-align: right;
}
.account-badge {
  font-size: 10px;
  opacity: 0.7;
  margin-left: 6px;
}
.account-muted {
  color: var(--muted);
}
.account-notice {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: flex-start;
  border: 1px solid var(--border, #333);
  border-radius: 4px;
  padding: 8px;
}
.account-danger {
  display: flex;
  gap: 12px;
  margin-top: 8px;
}
.account-confirm {
  border: 1px solid var(--border, #333);
  border-radius: 8px;
  padding: 12px;
  font-size: 12px;
}
.account-auth--requested {
  border-color: color-mix(in srgb, var(--accent, #f2a63b) 42%, var(--border, #333));
}
.account-confirm--danger {
  border-color: var(--danger, #c0392b);
}
/* The waiting panel, which is rendered above the rest of the page rather than instead of it. */
.account-auth {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.account-auth h4 {
  margin: 0;
}
.account-paste {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 4px;
}
/* The progress line. Sits with the alert at the top of the panel, so both are where the eye is. */
.account-busy {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: 12px;
  color: var(--muted);
}
.account-spinner {
  width: 12px;
  height: 12px;
  flex: none;
  border: 2px solid var(--border, #333);
  border-top-color: var(--accent, #ffa424);
  border-radius: 50%;
  animation: account-spin 0.8s linear infinite;
}
/* The same spinner, inside the button that is waiting. `currentColor` so it works on the accent
   button and the ghost one without either knowing about the other's palette; the transparent top
   is what makes the rotation visible. */
.button-spinner {
  display: inline-block;
  width: 11px;
  height: 11px;
  margin-right: 6px;
  vertical-align: -1px;
  border: 2px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  opacity: 0.8;
  animation: account-spin 0.8s linear infinite;
}
@media (prefers-reduced-motion: reduce) {
  .button-spinner {
    animation: none;
  }
}
@keyframes account-spin {
  to {
    transform: rotate(360deg);
  }
}
/* A spinner that cannot stop is a distraction for somebody who has asked the system not to move. */
@media (prefers-reduced-motion: reduce) {
  .account-spinner {
    animation: none;
  }
}
.account-error {
  color: var(--danger, #c0392b);
  font-size: 12px;
  margin: 0;
}
/*
 * The inline text affordances — Dismiss, Copy, Hide, and the two disclosure toggles. Everything that
 * DOES something is a `.button` from the app's own set (sidebar.css / git.css); this is only for the
 * ones that read as part of a sentence. Muted rather than accent-coloured: the accent belongs to the
 * one primary action on screen.
 */
.link {
  background: none;
  border: none;
  color: var(--muted);
  cursor: pointer;
  padding: 0;
  font: inherit;
  text-decoration: underline;
}
.link:hover:not(:disabled) {
  color: var(--text);
}
.link:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.account-tab :is(button, input, select, summary):focus-visible {
  outline: 2px solid var(--accent, #f2a63b);
  outline-offset: 2px;
}
@media (max-width: 620px) {
  .onboarding-choice,
  .account-usage {
    grid-template-columns: 1fr;
  }
  .account-section__heading,
  .account-header {
    align-items: flex-start;
    flex-direction: column;
  }
  .account-devices,
  .account-devices tbody,
  .account-devices tr,
  .account-devices td {
    display: block;
    width: 100%;
  }
  .account-devices tr {
    padding: 7px 0;
    border-bottom: 1px solid var(--border, #333);
  }
  .account-devices td {
    padding: 2px 0;
    border: 0;
    text-align: left !important;
  }
}
</style>
