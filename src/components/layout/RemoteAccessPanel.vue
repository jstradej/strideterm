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
      <button
        v-if="mobileWarning"
        type="button"
        class="remote-pill remote-pill--mobile-warning"
        :class="{
          'remote-pill--mobile-warning-expired': mobileWarning === 'trial-expired',
          'remote-pill--mobile-warning-expiring': mobileWarning === 'trial-expiring',
        }"
        :title="mobileWarningTitle"
        @click="openMobileSettings"
      >
        {{ mobileWarningLabel }}
      </button>
      <button
        type="button"
        class="button button--ghost remote-summary__configure"
        title="Open Remote Access to connect strIDEterm Mobile, manage paired phones, or configure browser sharing."
        @click="store.openRemoteAccessDialog()"
      >
        Configure
      </button>
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
    <button
      v-if="mobileWarning"
      type="button"
      class="remote-pill remote-pill--mobile-warning"
      :class="{
        'remote-pill--mobile-warning-expired': mobileWarning === 'trial-expired',
        'remote-pill--mobile-warning-expiring': mobileWarning === 'trial-expiring',
      }"
      :title="mobileWarningTitle"
      @click="openMobileSettings"
    >
      {{ mobileWarningLabel }}
    </button>
    <button
      type="button"
      class="button button--ghost remote-summary__configure"
      title="Open Remote Access to connect strIDEterm Mobile or set up LAN, Cloudflare, or VPS browser sharing."
      @click="store.openRemoteAccessDialog()"
    >
      Configure
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useAppStore } from "../../stores/app.js";
import { useAccountStore } from "../../stores/account.js";
import { useRemoteConnection } from "../../composables/useRemoteConnection.js";
import { useQrCode } from "../../composables/useQrCode.js";
import { getMobileAccessWarning, MOBILE_TRIAL_WARNING_WINDOW_MS } from "../../lib/mobile-access-warning.js";

const store = useAppStore();
const accountStore = useAccountStore();

const { remoteConfig, runtimeRemote, tunnel, activeShareUrl, hasPublicUrl, hasAnyUrl, activeError } =
  useRemoteConnection();

const { qrDataUrl } = useQrCode(activeShareUrl);
const mobileWarningNow = ref(Date.now());
let mobileWarningExpiryTimer: ReturnType<typeof setTimeout> | null = null;
const mobileEntitlement = computed(() => accountStore.entitlement ?? accountStore.overview?.entitlement);

function scheduleMobileWarningExpiry(notAfter: number | undefined): void {
  if (mobileWarningExpiryTimer !== null) clearTimeout(mobileWarningExpiryTimer);
  mobileWarningExpiryTimer = null;
  mobileWarningNow.value = Date.now();
  if (typeof notAfter !== "number" || !Number.isFinite(notAfter) || notAfter <= mobileWarningNow.value) return;
  const warningAt = notAfter - MOBILE_TRIAL_WARNING_WINDOW_MS;
  const nextBoundary = warningAt > mobileWarningNow.value ? warningAt : notAfter;
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
    return entitlement?.state === "trial" || (entitlement?.state === "lapsed" && entitlement.source === "trial")
      ? entitlement.notAfter
      : undefined;
  },
  scheduleMobileWarningExpiry,
  { immediate: true },
);
onBeforeUnmount(() => {
  if (mobileWarningExpiryTimer !== null) clearTimeout(mobileWarningExpiryTimer);
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
const mobileTrialEndDate = computed(() => {
  const notAfter = mobileEntitlement.value?.notAfter;
  if (typeof notAfter !== "number" || !Number.isFinite(notAfter) || notAfter <= 0) return "";
  const date = new Date(notAfter);
  const options: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  if (date.getFullYear() !== new Date(mobileWarningNow.value).getFullYear()) options.year = "numeric";
  return new Intl.DateTimeFormat("en", options).format(date);
});
const mobileWarningLabel = computed(() => {
  if (mobileWarning.value === "trial-expired") return "Mobile trial ended";
  if (mobileWarning.value === "trial-expiring") return "Mobile trial ends soon";
  return "Mobile access needs attention";
});
const mobileWarningTitle = computed(() => {
  if (mobileWarning.value === "trial-expired") {
    return `The free mobile trial ended ${mobileTrialEndDate.value}. Open Mobile settings to review account access.`;
  }
  if (mobileWarning.value === "trial-expiring") {
    return `The free mobile trial ends ${mobileTrialEndDate.value}. Open Mobile settings to review account access.`;
  }
  return "The desktop's mobile access was not authorized. Open Mobile settings to review account and phone access.";
});

function openMobileSettings(): void {
  store.openSettingsDialog({
    initialTab: "mobile",
    initialMobileView:
      mobileWarning.value === "trial-expired" || mobileWarning.value === "trial-expiring" ? "account" : "overview",
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
