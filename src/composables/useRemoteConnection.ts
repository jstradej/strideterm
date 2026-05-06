import { computed } from "vue";
import { useAppStore } from "../stores/app.js";
import { preferredRemoteUrl, withRemoteToken, normalizeAbsoluteUrl, summarizeRemoteHost } from "../app/helpers.js";

// The runtime remote-access shape differs from the typed RemoteAccessSettings/RemoteAccessState;
// use a loose record to avoid having to cast every field access.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = Record<string, any>;

/**
 * Provides computed remote connection state derived from the app store.
 */
export function useRemoteConnection() {
  const store = useAppStore();

  const remoteConfig = computed<AnyRecord>(() => store.payload?.appState?.settings?.remoteAccess || {});
  const runtimeRemote = computed<AnyRecord>(() => (store.payload as AnyRecord)?.remoteAccess || {});
  const tunnel = computed<AnyRecord>(() => runtimeRemote.value.tunnel || {});

  const urls = computed<string[]>(() => runtimeRemote.value.urls || []);
  const token = computed<string>(() => remoteConfig.value.token || "");

  const lanUrl = computed(() => preferredRemoteUrl({ urls: urls.value }) || "");
  const tunnelUrl = computed(() => tunnel.value.publicUrl || "");
  const customPublicUrl = computed(() => remoteConfig.value.customPublicUrl || "");

  const allLanShareUrls = computed(() => urls.value.map((url: string) => withRemoteToken(url, token.value)));

  const lanShareUrl = computed(() => {
    const sel = store.selectedLanUrl;
    return sel && allLanShareUrls.value.includes(sel) ? sel : withRemoteToken(lanUrl.value, token.value);
  });

  const tunnelShareUrl = computed(() => withRemoteToken(tunnelUrl.value, token.value));
  const customShareUrl = computed(() => withRemoteToken(customPublicUrl.value, token.value));
  const normalizedCustomUrl = computed(() => normalizeAbsoluteUrl(customPublicUrl.value));

  const activeShareUrl = computed(() => {
    // While the Remote Access dialog is open the user is actively choosing a
    // mode, so honor their tab selection. Otherwise (compact sidebar card)
    // auto-pick the most useful URL: prefer a public tunnel/VPS over LAN.
    const dialogOpen = store.overlay === "RemoteAccessDialog";
    const mode = dialogOpen
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
      ? urls.value.map((url: string) => ({
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
