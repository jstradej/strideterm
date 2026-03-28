import { computed } from "vue";
import { useAppStore } from "../stores/app.js";
import { preferredRemoteUrl, withRemoteToken, normalizeAbsoluteUrl, summarizeRemoteHost } from "../app/helpers.js";

/**
 * Provides computed remote connection state derived from the app store.
 */
export function useRemoteConnection() {
  const store = useAppStore();

  const remoteConfig = computed(() => store.payload?.appState?.settings?.remoteAccess || {});
  const runtimeRemote = computed(() => store.payload?.remoteAccess || {});
  const tunnel = computed(() => runtimeRemote.value.tunnel || {});

  const urls = computed(() => runtimeRemote.value.urls || []);
  const token = computed(() => remoteConfig.value.token || "");

  const lanUrl = computed(() => preferredRemoteUrl({ urls: urls.value }) || "");
  const tunnelUrl = computed(() => tunnel.value.publicUrl || "");
  const customPublicUrl = computed(() => remoteConfig.value.customPublicUrl || "");

  const allLanShareUrls = computed(() => urls.value.map((url) => withRemoteToken(url, token.value)));

  const lanShareUrl = computed(() => {
    const sel = store.selectedLanUrl;
    return sel && allLanShareUrls.value.includes(sel) ? sel : withRemoteToken(lanUrl.value, token.value);
  });

  const tunnelShareUrl = computed(() => withRemoteToken(tunnelUrl.value, token.value));
  const customShareUrl = computed(() => withRemoteToken(customPublicUrl.value, token.value));
  const normalizedCustomUrl = computed(() => normalizeAbsoluteUrl(customPublicUrl.value));

  const activeShareUrl = computed(() => {
    const mode = store.remoteAccessExpanded
      ? store.remoteAccessMode || "lan"
      : tunnelShareUrl.value || customShareUrl.value
        ? "cloudflare"
        : "lan";
    if (mode === "cloudflare" && tunnelShareUrl.value) return tunnelShareUrl.value;
    if (mode === "vps" && customShareUrl.value) return customShareUrl.value;
    return customShareUrl.value || tunnelShareUrl.value || lanShareUrl.value;
  });

  const modeShareUrl = computed(() => {
    const mode = store.remoteAccessMode || "lan";
    if (mode === "cloudflare") return tunnelShareUrl.value;
    if (mode === "vps") return customShareUrl.value;
    return lanShareUrl.value;
  });

  const serverStatus = computed(() => (runtimeRemote.value.error ? "offline" : "live"));
  const tunnelStatusLabel = computed(() => (tunnel.value.publicUrl ? "connected" : tunnel.value.status || "idle"));

  const lanUrlButtons = computed(() =>
    urls.value.length > 1
      ? urls.value.map((url) => ({
          host: summarizeRemoteHost(url),
          shareUrl: withRemoteToken(url, token.value),
          active: lanShareUrl.value === withRemoteToken(url, token.value),
        }))
      : [],
  );

  const cloudflaredHint = computed(() => {
    if (tunnel.value.available || tunnelUrl.value) return "";
    return remoteConfig.value.cloudflaredPath
      ? `Binary unavailable: ${remoteConfig.value.cloudflaredPath}`
      : "cloudflared not found. Add it to PATH or set a binary path.";
  });

  const hasPublicUrl = computed(() => Boolean(tunnelShareUrl.value || customShareUrl.value));
  const hasAnyUrl = computed(() => Boolean(lanShareUrl.value || tunnelShareUrl.value || customShareUrl.value));
  const activeError = computed(
    () =>
      runtimeRemote.value.error ||
      (tunnel.value.publicUrl && tunnel.value.status !== "connected" && tunnel.value.error),
  );

  return {
    remoteConfig,
    runtimeRemote,
    tunnel,
    urls,
    token,
    lanUrl,
    tunnelUrl,
    customPublicUrl,
    lanShareUrl,
    tunnelShareUrl,
    customShareUrl,
    normalizedCustomUrl,
    activeShareUrl,
    modeShareUrl,
    serverStatus,
    tunnelStatusLabel,
    lanUrlButtons,
    cloudflaredHint,
    hasPublicUrl,
    hasAnyUrl,
    activeError,
  };
}
