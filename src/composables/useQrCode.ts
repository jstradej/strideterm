import { ref, watch } from "vue";
import type { Ref } from "vue";
import QRCode from "qrcode";
import { APP_CONFIG } from "../../config/app-config.js";

/**
 * The module colours a QR is drawn with.
 *
 * The default is a pale foreground on a TRANSPARENT background, which is right for the remote-access
 * codes: they sit directly on the dark dialog surface, so pale-on-dark is high contrast.
 *
 * It is wrong for any code drawn on a light surface, and that is not a matter of taste. A decoder
 * needs a real luminance difference between dark and light modules; the default foreground
 * (`#d8e4f5`) against white is roughly 1.2:1, which is close to invisible. The pairing QR did
 * exactly that — transparent background over a `background: white` container — and the denser the
 * payload, the smaller the modules and the less tolerance there is for camera angle, distance and
 * screen glare on top of it.
 */
export interface QrCodeColors {
  dark: string;
  light: string;
}

/** Pale-on-transparent: for a QR drawn on the app's own dark surfaces. */
export const QR_COLORS_ON_DARK: QrCodeColors = {
  dark: APP_CONFIG.ui.qrForegroundColor,
  light: "#0000",
};

/**
 * Black on opaque white: for a QR a phone camera has to read off a screen.
 *
 * Deliberately the standard orientation rather than an inverted one. Most modern decoders handle
 * light-on-dark, but "most" is not a property to rest a pairing flow on, and this costs nothing.
 */
export const QR_COLORS_FOR_SCANNING: QrCodeColors = {
  dark: "#000000",
  light: "#ffffff",
};

/**
 * Generates a QR code data URL for a given target URL.
 * Caches the last generated URL to avoid redundant re-generation.
 * When targetUrl changes, re-generates asynchronously.
 *
 * [colors] defaults to {@link QR_COLORS_ON_DARK} so existing call sites are unchanged; a code that
 * will be photographed should pass {@link QR_COLORS_FOR_SCANNING}.
 */
export function useQrCode(
  targetUrl: Ref<string>,
  colors: QrCodeColors = QR_COLORS_ON_DARK,
  /**
   * Device pixels per QR module, i.e. how large the generated bitmap is.
   *
   * This is the knob to turn when a code has to FIT somewhere, rather than sizing the finished image
   * down in CSS. Downscaling a QR is not a neutral operation: it blends neighbouring modules, and a
   * decoder is looking for exactly those edges. Generating at the size it will be displayed at keeps
   * every module identical and square.
   *
   * The pairing payload is ~440 characters, which at error-correction level M is a 79-module symbol.
   * So 6 gives a 474px bitmap (too tall for the settings dialog) and 4 gives 316px (fits, with four
   * device pixels per module — comfortably scannable off a screen, and far better than the 2.5
   * blurred pixels the fixed-200px version produced).
   */
  scale = 6,
) {
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
        scale,
        color: { dark: colors.dark, light: colors.light },
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
