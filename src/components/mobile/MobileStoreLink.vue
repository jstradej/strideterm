<template>
  <div class="mobile-store-link">
    <img
      v-if="qrDataUrl"
      :src="qrDataUrl"
      alt="QR code for strIDEterm Mobile on Google Play"
      class="mobile-store-link__qr"
    />
    <div class="mobile-store-link__text">
      <strong>Get strIDEterm Mobile</strong>
      <p>
        strIDEterm Mobile for Android is available on Google Play. Scan the code with your phone, or open the listing.
      </p>
      <a :href="GOOGLE_PLAY_URL" target="_blank" rel="noopener noreferrer" class="mobile-store-link__link"
        >Get it on Google Play</a
      >
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { QR_COLORS_FOR_SCANNING, useQrCode } from "../../composables/useQrCode.js";

const GOOGLE_PLAY_URL = "https://play.google.com/store/apps/details?id=com.strideterm.mobile";

const { qrDataUrl } = useQrCode(ref(GOOGLE_PLAY_URL), QR_COLORS_FOR_SCANNING, 4);
</script>

<style scoped>
.mobile-store-link {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 10px 12px;
  background: rgba(var(--tint), 0.04);
  border-left: 3px solid var(--accent);
  border-radius: 4px;
  font-size: 13px;
  line-height: 1.5;
}

.mobile-store-link__qr {
  flex: none;
  image-rendering: pixelated;
  background: white;
  padding: 6px;
  border-radius: 6px;
}

.mobile-store-link__text {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.mobile-store-link__text p {
  margin: 0;
  color: var(--muted);
}

.mobile-store-link__link {
  justify-self: start;
  font-weight: 600;
}

@media (max-width: 520px) {
  .mobile-store-link {
    flex-direction: column;
    align-items: flex-start;
  }
}
</style>
