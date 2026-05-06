<template>
  <!-- Compact sidebar card. The full editor lives in RemoteAccessDialog,
       opened via store.openRemoteAccessDialog(). -->
  <div v-if="remoteConfig.enabled && hasAnyUrl" class="remote-card remote-card--compact">
    <button
      v-if="remoteConfig.enabled && hasAnyUrl && qrDataUrl"
      type="button"
      class="remote-qr-button"
      title="Copy share URL"
      @click="copyActiveUrl"
    >
      <img class="remote-compact__qr" :src="qrDataUrl" alt="QR" />
    </button>
    <div class="remote-compact__info">
      <span v-if="activeError" class="remote-pill remote-pill--error">connection error</span>
      <span v-else-if="hasPublicUrl" class="remote-pill remote-pill--ok">public</span>
      <span v-else class="remote-pill">LAN only</span>
      <button
        type="button"
        class="button button--ghost remote-summary__configure"
        @click="store.openRemoteAccessDialog()"
      >
        Configure
      </button>
    </div>
  </div>
  <div v-else class="remote-card remote-card--compact remote-card--minimal">
    <div class="remote-compact__icon">&#9678;</div>
    <span class="remote-summary__label">Remote Access</span>
    <button
      type="button"
      class="button button--ghost remote-summary__configure"
      @click="store.openRemoteAccessDialog()"
    >
      Configure
    </button>
  </div>
</template>

<script setup lang="ts">
import { useAppStore } from "../../stores/app.js";
import { useRemoteConnection } from "../../composables/useRemoteConnection.js";
import { useQrCode } from "../../composables/useQrCode.js";

const store = useAppStore();

const { remoteConfig, activeShareUrl, hasPublicUrl, hasAnyUrl, activeError } = useRemoteConnection();

const { qrDataUrl } = useQrCode(activeShareUrl);

function copyActiveUrl(): void {
  const url = activeShareUrl.value;
  if (url) store.copyText(url);
}
</script>
