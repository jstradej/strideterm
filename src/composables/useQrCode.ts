import { ref, watch } from "vue";
import type { Ref } from "vue";
import QRCode from "qrcode";
import { APP_CONFIG } from "../../config/app-config.js";

/**
 * Generates a QR code data URL for a given target URL.
 * Caches the last generated URL to avoid redundant re-generation.
 * When targetUrl changes, re-generates asynchronously.
 */
export function useQrCode(targetUrl: Ref<string>) {
  const qrDataUrl = ref("");
  let currentKey = "";

  async function generate(url: string) {
    const key = url || "";
    if (currentKey === key) return;
    currentKey = key;

    if (!url) {
      qrDataUrl.value = "";
      return;
    }

    try {
      const dataUrl = await QRCode.toDataURL(url, {
        errorCorrectionLevel: "M",
        margin: 1,
        scale: 6,
        color: {
          dark: APP_CONFIG.ui.qrForegroundColor,
          light: "#0000",
        },
      });
      if (currentKey === key) {
        qrDataUrl.value = dataUrl;
      }
    } catch {
      if (currentKey === key) {
        qrDataUrl.value = "";
      }
    }
  }

  watch(targetUrl, (url) => generate(url), { immediate: true });

  return { qrDataUrl };
}
