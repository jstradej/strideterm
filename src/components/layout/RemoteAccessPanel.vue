<template>
  <!-- Compact sidebar card. The full editor lives in RemoteAccessDialog,
       opened via store.openRemoteAccessDialog(). Defaults to a single-line
       summary so the QR doesn't dominate the sidebar — a tiny QR thumbnail
       (or the caret) expands the card to show a scannable code on demand. -->
  <div
    v-if="remoteConfig.enabled && hasAnyUrl"
    :class="['remote-card', 'remote-card--compact', qrOpen && 'remote-card--qr-open']"
  >
    <div class="remote-compact__row">
      <button
        type="button"
        class="remote-compact__caret"
        :aria-expanded="qrOpen"
        :aria-controls="qrPanelId"
        :title="
          qrOpen
            ? 'Hide the QR code — collapse this panel back to a single row.'
            : 'Show a scannable QR code for the share URL — expands the panel below.'
        "
        @click="toggleQr"
      >
        <span class="remote-compact__caret-glyph" aria-hidden="true">{{ qrOpen ? "▾" : "▸" }}</span>
      </button>
      <button
        v-if="qrDataUrl"
        type="button"
        class="remote-compact__qr-thumb"
        :aria-expanded="qrOpen"
        :aria-controls="qrPanelId"
        :title="
          qrOpen
            ? 'Hide the QR code — collapse this panel back to a single row.'
            : 'Click to enlarge the QR code so you can scan it from your phone.'
        "
        @click="toggleQr"
      >
        <img class="remote-compact__qr-thumb-img" :src="qrDataUrl" alt="QR code thumbnail — click to enlarge" />
      </button>
      <span v-if="activeError" class="remote-pill remote-pill--error" :title="errorTooltip">connection error</span>
      <span
        v-else-if="hasPublicUrl"
        class="remote-pill remote-pill--ok"
        title="Remote access is reachable from the public internet (Cloudflare quick-tunnel or your custom VPS URL). Anyone with the share URL plus token can connect."
        >public</span
      >
      <span
        v-else
        class="remote-pill"
        title="Remote access is reachable on the local network only. Use a Cloudflare tunnel or VPS URL to expose it publicly."
        >LAN only</span
      >
      <div class="remote-compact__actions">
        <button
          v-if="mobileWarning"
          type="button"
          class="remote-pill remote-pill--mobile-warning"
          :class="{
            'remote-pill--mobile-warning-expired': isExpiredWarning,
            'remote-pill--mobile-warning-expiring': isUpcomingExpiry,
            'remote-pill--mobile-warning-critical': isCriticalExpiry,
            'remote-pill--mobile-warning-pulse': mobileWarningPulse,
          }"
          :title="mobileWarningTitle"
          :aria-label="mobileWarningTitle"
          @click="openMobileSettings"
        >
          <span class="remote-pill__label-full">{{ mobileWarningLabel }}</span>
          <span class="remote-pill__label-compact">{{ mobileWarningCompactLabel }}</span>
        </button>
        <button
          type="button"
          class="button button--ghost remote-summary__configure"
          aria-label="Configure Remote Access"
          title="Open Remote Access to connect strIDEterm Mobile, manage paired phones, or configure browser sharing."
          @click="store.openRemoteAccessDialog()"
        >
          <svg class="remote-summary__configure-icon" viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="m9.5 2.5-.8 2.2a8 8 0 0 0-1.6.9l-2.2-.6-2.4 4.2 1.6 1.6a8 8 0 0 0 0 1.8l-1.6 1.6 2.4 4.2 2.2-.6c.5.4 1 .7 1.6.9l.8 2.2h5l.8-2.2a8 8 0 0 0 1.6-.9l2.2.6 2.4-4.2-1.6-1.6a8 8 0 0 0 0-1.8l1.6-1.6-2.4-4.2-2.2.6a8 8 0 0 0-1.6-.9l-.8-2.2h-5Z"
              fill="none"
              stroke="currentColor"
              stroke-width="1.7"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
            <circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.7" />
          </svg>
          <span class="remote-summary__configure-label">Configure</span>
        </button>
      </div>
    </div>
    <div v-if="qrOpen && qrDataUrl" :id="qrPanelId" class="remote-compact__qr-panel">
      <button
        type="button"
        class="remote-qr-button"
        title="Copy the active share URL (token included) to the clipboard."
        @click="copyActiveUrl"
      >
        <img class="remote-compact__qr" :src="qrDataUrl" alt="QR code for active remote-access share URL" />
      </button>
    </div>
  </div>
  <div v-else class="remote-card remote-card--compact remote-card--minimal">
    <div class="remote-compact__icon" aria-hidden="true">&#9678;</div>
    <span class="remote-summary__label">Remote Access</span>
    <div class="remote-compact__actions">
      <button
        v-if="mobileWarning"
        type="button"
        class="remote-pill remote-pill--mobile-warning"
        :class="{
          'remote-pill--mobile-warning-expired': isExpiredWarning,
          'remote-pill--mobile-warning-expiring': isUpcomingExpiry,
          'remote-pill--mobile-warning-critical': isCriticalExpiry,
          'remote-pill--mobile-warning-pulse': mobileWarningPulse,
        }"
        :title="mobileWarningTitle"
        :aria-label="mobileWarningTitle"
        @click="openMobileSettings"
      >
        <span class="remote-pill__label-full">{{ mobileWarningLabel }}</span>
        <span class="remote-pill__label-compact">{{ mobileWarningCompactLabel }}</span>
      </button>
      <button
        type="button"
        class="button button--ghost remote-summary__configure"
        aria-label="Configure Remote Access"
        title="Open Remote Access to connect strIDEterm Mobile or set up LAN, Cloudflare, or VPS browser sharing."
        @click="store.openRemoteAccessDialog()"
      >
        <svg class="remote-summary__configure-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="m9.5 2.5-.8 2.2a8 8 0 0 0-1.6.9l-2.2-.6-2.4 4.2 1.6 1.6a8 8 0 0 0 0 1.8l-1.6 1.6 2.4 4.2 2.2-.6c.5.4 1 .7 1.6.9l.8 2.2h5l.8-2.2a8 8 0 0 0 1.6-.9l2.2.6 2.4-4.2-1.6-1.6a8 8 0 0 0 0-1.8l1.6-1.6-2.4-4.2-2.2.6a8 8 0 0 0-1.6-.9l-.8-2.2h-5Z"
            fill="none"
            stroke="currentColor"
            stroke-width="1.7"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
          <circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.7" />
        </svg>
        <span class="remote-summary__configure-label">Configure</span>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useAppStore } from "../../stores/app.js";
import { useAccountStore } from "../../stores/account.js";
import { useRemoteConnection } from "../../composables/useRemoteConnection.js";
import { useQrCode } from "../../composables/useQrCode.js";
import {
  formatMobileAccessRemaining,
  getMobileAccessDeadline,
  getMobileAccessWarning,
  getMobileWarningPulseInterval,
  MOBILE_ACCESS_CRITICAL_WINDOW_MS,
  MOBILE_TRIAL_WARNING_WINDOW_MS,
} from "../../lib/mobile-access-warning.js";

const store = useAppStore();
const accountStore = useAccountStore();

const { remoteConfig, runtimeRemote, tunnel, activeShareUrl, hasPublicUrl, hasAnyUrl, activeError } =
  useRemoteConnection();

const { qrDataUrl } = useQrCode(activeShareUrl);
const mobileWarningNow = ref(Date.now());
let mobileWarningExpiryTimer: ReturnType<typeof setTimeout> | null = null;
let mobileWarningClockTimer: ReturnType<typeof setInterval> | null = null;
let mobileWarningPulseTimer: ReturnType<typeof setTimeout> | null = null;
let mobileWarningPulseOffTimer: ReturnType<typeof setTimeout> | null = null;
const mobileWarningPulse = ref(false);
const mobileEntitlement = computed(() => accountStore.entitlement ?? accountStore.overview?.entitlement);

function scheduleMobileWarningExpiry(notAfter: number | undefined): void {
  if (mobileWarningExpiryTimer !== null) clearTimeout(mobileWarningExpiryTimer);
  mobileWarningExpiryTimer = null;
  mobileWarningNow.value = Date.now();
  if (typeof notAfter !== "number" || !Number.isFinite(notAfter) || notAfter <= mobileWarningNow.value) return;
  const warningAt = notAfter - MOBILE_TRIAL_WARNING_WINDOW_MS;
  const criticalAt = notAfter - MOBILE_ACCESS_CRITICAL_WINDOW_MS;
  const nextBoundary = [warningAt, criticalAt, notAfter].find((boundary) => boundary > mobileWarningNow.value)!;
  mobileWarningExpiryTimer = setTimeout(
    () => {
      mobileWarningExpiryTimer = null;
      mobileWarningNow.value = Date.now();
      if (notAfter > mobileWarningNow.value) scheduleMobileWarningExpiry(notAfter);
    },
    Math.min(nextBoundary - mobileWarningNow.value + 1, 2_147_483_647),
  );
}

watch(
  () => {
    const entitlement = mobileEntitlement.value;
    return entitlement?.state === "lapsed" ? undefined : (getMobileAccessDeadline(entitlement) ?? undefined);
  },
  scheduleMobileWarningExpiry,
  { immediate: true },
);
onBeforeUnmount(() => {
  if (mobileWarningExpiryTimer !== null) clearTimeout(mobileWarningExpiryTimer);
  if (mobileWarningClockTimer !== null) clearInterval(mobileWarningClockTimer);
  if (mobileWarningPulseTimer !== null) clearTimeout(mobileWarningPulseTimer);
  if (mobileWarningPulseOffTimer !== null) clearTimeout(mobileWarningPulseOffTimer);
});
const mobileWarning = computed(() =>
  getMobileAccessWarning({
    mobileEnabled: store.mobileEnabled,
    pairedPhoneCount: store.mobileDevices.filter((device) => !device.revoked && device.state === "active").length,
    health: store.mobileConnectionHealth,
    entitlement: mobileEntitlement.value,
    now: mobileWarningNow.value,
  }),
);
const mobileAccessDeadline = computed(() => getMobileAccessDeadline(mobileEntitlement.value));
const mobileRemainingMs = computed(() => (mobileAccessDeadline.value ?? 0) - mobileWarningNow.value);
const mobileTimeRemaining = computed(() => formatMobileAccessRemaining(mobileRemainingMs.value));
const isUpcomingExpiry = computed(
  () => mobileWarning.value === "trial-expiring" || mobileWarning.value === "access-expiring",
);
const isExpiredWarning = computed(
  () => mobileWarning.value === "trial-expired" || mobileWarning.value === "access-expired",
);
const isCriticalExpiry = computed(
  () =>
    mobileWarning.value !== null &&
    mobileRemainingMs.value > 0 &&
    mobileRemainingMs.value <= MOBILE_ACCESS_CRITICAL_WINDOW_MS,
);
const mobileAccessEndDateTime = computed(() => {
  const notAfter = mobileAccessDeadline.value;
  if (typeof notAfter !== "number" || !Number.isFinite(notAfter) || notAfter <= 0) return "";
  const date = new Date(notAfter);
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
});
const mobileWarningLabel = computed(() => {
  if (isExpiredWarning.value) return "Mobile · Ended";
  if (mobileRemainingMs.value > 0 && mobileWarning.value !== null) {
    if (mobileRemainingMs.value < 60 * 60_000) {
      return `${Math.ceil(mobileRemainingMs.value / 60_000)}m left`;
    }
    return `${mobileTimeRemaining.value} left`;
  }
  return "Mobile · Attention";
});
const mobileWarningCompactLabel = computed(() => {
  if (isExpiredWarning.value) return "Mobile · Ended";
  if (mobileRemainingMs.value > 0 && mobileWarning.value !== null) {
    if (mobileRemainingMs.value >= 60 * 60_000) {
      return `${Math.floor(mobileRemainingMs.value / (60 * 60_000))}h left`;
    }
    return `${Math.ceil(mobileRemainingMs.value / 60_000)}m left`;
  }
  return "Mobile · Attention";
});
const mobileWarningTitle = computed(() => {
  if (mobileWarning.value === "trial-expired" || mobileWarning.value === "access-expired") {
    const subject = mobileWarning.value === "trial-expired" ? "The free mobile trial" : "Mobile access";
    return `${subject} ended ${mobileAccessEndDateTime.value}. Open Mobile settings to review account access.`;
  }
  if (isUpcomingExpiry.value) {
    const subject = mobileWarning.value === "trial-expiring" ? "The free mobile trial" : "Mobile access";
    return `${subject} ends in ${mobileTimeRemaining.value} (${mobileAccessEndDateTime.value}). Open Mobile settings to review account access.`;
  }
  const authorizationMessage =
    "The desktop's mobile access was not authorized. Open Mobile settings to review account and phone access.";
  if (mobileWarning.value === "authorization-denied" && mobileRemainingMs.value > 0) {
    return `${authorizationMessage} Mobile access ends in ${mobileTimeRemaining.value} (${mobileAccessEndDateTime.value}).`;
  }
  return authorizationMessage;
});

const mobileWarningPulseInterval = computed(() =>
  mobileWarning.value !== null && !isExpiredWarning.value
    ? getMobileWarningPulseInterval(mobileRemainingMs.value)
    : null,
);
const mobileWarningCountdownActive = computed(
  () => mobileWarning.value !== null && !isExpiredWarning.value && mobileRemainingMs.value > 0,
);
watch(
  () => mobileWarningCountdownActive.value,
  (active) => {
    if (active && mobileWarningClockTimer === null) {
      mobileWarningClockTimer = setInterval(() => (mobileWarningNow.value = Date.now()), 60_000);
    } else if (!active && mobileWarningClockTimer !== null) {
      clearInterval(mobileWarningClockTimer);
      mobileWarningClockTimer = null;
    }
  },
  { immediate: true },
);
function clearMobileWarningPulseTimers(): void {
  if (mobileWarningPulseTimer !== null) clearTimeout(mobileWarningPulseTimer);
  if (mobileWarningPulseOffTimer !== null) clearTimeout(mobileWarningPulseOffTimer);
  mobileWarningPulseTimer = null;
  mobileWarningPulseOffTimer = null;
  mobileWarningPulse.value = false;
}
function pulseMobileWarning(): void {
  mobileWarningPulse.value = true;
  mobileWarningPulseOffTimer = setTimeout(() => {
    mobileWarningPulse.value = false;
    mobileWarningPulseOffTimer = null;
  }, 1200);
}
function scheduleMobileWarningPulse(interval: number | null): void {
  clearMobileWarningPulseTimers();
  if (interval === null) return;
  pulseMobileWarning();
  mobileWarningPulseTimer = setTimeout(() => {
    mobileWarningPulseTimer = null;
    mobileWarningNow.value = Date.now();
    scheduleMobileWarningPulse(mobileWarningPulseInterval.value);
  }, interval);
}
watch(mobileWarningPulseInterval, scheduleMobileWarningPulse, { immediate: true });

function openMobileSettings(): void {
  store.openSettingsDialog({
    initialTab: "mobile",
    initialMobileView: isExpiredWarning.value || isUpcomingExpiry.value ? "account" : "overview",
  });
}

// QR is collapsed by default — the panel renders as a single-row summary
// (caret + tiny QR thumb + status pill + Configure). Toggle via either the
// caret or the thumbnail; both expand a panel below the row that holds a
// full-size, click-to-copy QR.
const qrOpen = ref(false);
const qrPanelId = "remote-qr-panel";

function toggleQr(): void {
  qrOpen.value = !qrOpen.value;
}

const errorTooltip = computed(() => {
  const msg = String(runtimeRemote.value?.error || tunnel.value?.error || "").trim();
  return msg
    ? `Remote access reported an error: ${msg}. Open Configure for details.`
    : "Remote access reported a connection error. Open Configure for details.";
});

function copyActiveUrl(): void {
  const url = activeShareUrl.value;
  if (url) store.copyText(url);
}
</script>
