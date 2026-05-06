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
        type="button"
        class="button button--ghost remote-summary__configure"
        title="Open the Remote Access dialog to switch modes (LAN / Cloudflare / VPS), copy share URLs, and rotate the access token."
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
      type="button"
      class="button button--ghost remote-summary__configure"
      title="Open the Remote Access dialog to enable LAN sharing, set up a Cloudflare quick-tunnel, or pin a custom VPS URL."
      @click="store.openRemoteAccessDialog()"
    >
      Configure
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { useAppStore } from "../../stores/app.js";
import { useRemoteConnection } from "../../composables/useRemoteConnection.js";
import { useQrCode } from "../../composables/useQrCode.js";

const store = useAppStore();

const { remoteConfig, runtimeRemote, tunnel, activeShareUrl, hasPublicUrl, hasAnyUrl, activeError } =
  useRemoteConnection();

const { qrDataUrl } = useQrCode(activeShareUrl);

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
