import {
  escapeHtml,
  normalizeAbsoluteUrl,
  preferredRemoteUrl,
  summarizeRemoteHost,
  withRemoteToken,
} from "./helpers.js";

function remoteFieldMarkup({
  label,
  value,
  readOnly = true,
  dataRole = "",
  placeholder = "",
  copyAction = "",
  copyDisabled = false,
}) {
  const copyButton = copyAction
    ? `<button class="button button--ghost remote-field__copy" data-action="${copyAction}" ${copyDisabled ? "disabled" : ""}>Copy</button>`
    : "";

  return `
    <label class="remote-access__field">
      <span>${escapeHtml(label)}</span>
      <span class="remote-field">
        <input ${readOnly ? "readonly" : ""} ${dataRole ? `data-role="${dataRole}"` : ""} value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}" />
        ${copyButton}
      </span>
    </label>
  `;
}

export function getActiveRemoteShareUrl({
  payload,
  selectedLanUrl = "",
  remoteAccessExpanded = false,
  remoteAccessMode = "lan",
}) {
  if (!payload) {
    return "";
  }

  const config = payload.appState?.settings?.remoteAccess || {};
  const runtimeRemote = payload.remoteAccess || {};
  const urls = runtimeRemote.urls || [];
  const lanShareUrl = (selectedLanUrl && urls.some((url) => withRemoteToken(url, config.token || "") === selectedLanUrl))
    ? selectedLanUrl
    : withRemoteToken(preferredRemoteUrl({ urls }), config.token || "");
  const tunnelShareUrl = withRemoteToken(runtimeRemote.tunnel?.publicUrl || "", config.token || "");
  const customShareUrl = withRemoteToken(config.customPublicUrl || "", config.token || "");
  const mode = remoteAccessExpanded ? (remoteAccessMode || "lan") : (tunnelShareUrl || customShareUrl ? "cloudflare" : "lan");

  if (mode === "cloudflare" && tunnelShareUrl) {
    return tunnelShareUrl;
  }
  if (mode === "vps" && customShareUrl) {
    return customShareUrl;
  }
  return customShareUrl || tunnelShareUrl || lanShareUrl;
}

export function getRemoteQrTarget({
  payload,
  selectedLanUrl = "",
  remoteAccessExpanded = false,
  remoteAccessMode = "lan",
}) {
  if (!payload) {
    return "";
  }

  const config = payload.appState?.settings?.remoteAccess || {};
  const urls = payload.remoteAccess?.urls || [];
  const tunnelUrl = payload.remoteAccess?.tunnel?.publicUrl || "";
  const customPublicUrl = config.customPublicUrl || "";
  const allLanShareUrls = urls.map((url) => withRemoteToken(url, config.token || ""));
  const effectiveLanShareUrl = (selectedLanUrl && allLanShareUrls.includes(selectedLanUrl))
    ? selectedLanUrl
    : withRemoteToken(preferredRemoteUrl({ urls }), config.token || "");

  if (remoteAccessExpanded) {
    const mode = remoteAccessMode || "lan";
    return mode === "cloudflare"
      ? withRemoteToken(tunnelUrl, config.token || "")
      : mode === "vps"
        ? withRemoteToken(customPublicUrl, config.token || "")
        : effectiveLanShareUrl;
  }

  const publicShareUrl = tunnelUrl
    ? withRemoteToken(tunnelUrl, config.token || "")
    : customPublicUrl
      ? withRemoteToken(customPublicUrl, config.token || "")
      : "";
  return publicShareUrl || effectiveLanShareUrl;
}

export function renderRemoteAccessCard({
  payload,
  selectedLanUrl = "",
  remoteAccessExpanded = false,
  remoteAccessMode = "lan",
  remoteQrUrl = "",
  isRemote = false,
}) {
  if (!payload) {
    return "";
  }

  const config = payload.appState.settings.remoteAccess || {};
  const runtimeRemote = payload.remoteAccess || {};
  const urls = runtimeRemote.urls || [];
  const tunnel = runtimeRemote.tunnel || {};
  const lanUrl = preferredRemoteUrl({ urls }) || "";
  const tunnelUrl = tunnel.publicUrl || "";
  const customPublicUrl = config.customPublicUrl || "";
  const allLanShareUrls = urls.map((url) => withRemoteToken(url, config.token || ""));
  const lanShareUrl = (selectedLanUrl && allLanShareUrls.includes(selectedLanUrl))
    ? selectedLanUrl
    : withRemoteToken(lanUrl, config.token || "");
  const tunnelShareUrl = withRemoteToken(tunnelUrl, config.token || "");
  const customShareUrl = withRemoteToken(customPublicUrl, config.token || "");
  const normalizedCustomUrl = normalizeAbsoluteUrl(customPublicUrl);
  const serverStatus = runtimeRemote.error ? "offline" : "live";

  if (!remoteAccessExpanded) {
    const hasPublicUrl = !!(tunnelShareUrl || customShareUrl);
    const hasAnyUrl = !!(lanShareUrl || tunnelShareUrl || customShareUrl);
    const activeError = runtimeRemote.error || (tunnel.publicUrl && tunnel.status !== "connected" && tunnel.error);
    const compactQr = config.enabled && hasAnyUrl && remoteQrUrl
      ? `<button class="remote-qr-button" data-action="copy-qr-url" title="Copy share URL"><img class="remote-compact__qr" src="${remoteQrUrl}" alt="QR" /></button>`
      : "";

    if (config.enabled && hasAnyUrl) {
      return `
        <div class="remote-card remote-card--compact">
          ${compactQr}
          <div class="remote-compact__info">
            ${activeError
              ? `<span class="remote-pill remote-pill--error">connection error</span>`
              : hasPublicUrl
                ? `<span class="remote-pill remote-pill--ok">public</span>`
                : `<span class="remote-pill">LAN only</span>`
            }
            <button class="button button--ghost remote-summary__configure" data-action="toggle-remote-panel">Configure</button>
          </div>
        </div>
      `;
    }

    return `
      <div class="remote-card remote-card--compact remote-card--minimal">
        <div class="remote-compact__icon">&#9678;</div>
        <span class="remote-summary__label">Remote Access</span>
        <button class="button button--ghost remote-summary__configure" data-action="toggle-remote-panel">Configure</button>
      </div>
    `;
  }

  const mode = remoteAccessMode || "lan";
  const modeShareUrl = mode === "cloudflare" ? tunnelShareUrl : mode === "vps" ? customShareUrl : lanShareUrl;
  const qrMarkup = config.enabled && modeShareUrl && remoteQrUrl
    ? `<button class="remote-qr-button" data-action="copy-qr-url" title="Copy share URL"><img class="remote-access__qr" src="${remoteQrUrl}" alt="QR code for remote access" /></button>`
    : '<div class="remote-access__qr remote-access__qr--placeholder">QR</div>';

  const modeTab = (id, label) => {
    const active = mode === id;
    return `<button class="remote-mode-tab ${active ? "remote-mode-tab--active" : ""}" data-action="set-remote-mode" data-mode="${id}">
      ${label}
    </button>`;
  };

  const lanHost = runtimeRemote.host || config.host || "0.0.0.0";
  const lanPort = runtimeRemote.port || config.port || "";
  const lanUrlButtons = urls.length > 1
    ? urls.map((url) => {
        const host = summarizeRemoteHost(url);
        const shareUrl = withRemoteToken(url, config.token || "");
        const active = lanShareUrl === shareUrl;
        return `<button class="workspace-chip workspace-chip--btn ${active ? "workspace-chip--active" : ""}" data-action="pick-lan-url" data-url="${escapeHtml(shareUrl)}">${escapeHtml(host)}</button>`;
      }).join("")
    : "";
  const lanPanel = `
    <div class="remote-mode-panel ${mode === "lan" ? "remote-mode-panel--active" : ""}">
      <p class="remote-access__headline" title="If you can't connect from another device, check that Windows Firewall allows inbound TCP on port ${escapeHtml(String(lanPort))}. You may need to add a firewall rule.">Access this workspace from any device on your local network.</p>
      ${remoteFieldMarkup({
        label: "LAN URL",
        value: lanShareUrl || "Server is not running.",
        copyAction: "copy-lan-url",
        copyDisabled: !lanShareUrl,
      })}
      ${lanUrlButtons ? `<div class="remote-access__stats">${lanUrlButtons}</div>` : ""}
      <div class="remote-access__stats">
        <span class="workspace-chip"><strong>${escapeHtml(lanHost)}</strong> host</span>
        <span class="workspace-chip"><strong>${escapeHtml(String(lanPort))}</strong> port</span>
        <span class="workspace-chip workspace-chip--${serverStatus === "live" ? "ok" : "default"}"><strong>${escapeHtml(serverStatus)}</strong> server</span>
      </div>
      ${runtimeRemote.error ? `<p class="inline-error">${escapeHtml(runtimeRemote.error)}</p>` : ""}
    </div>`;

  const tunnelStatusLabel = tunnel.publicUrl ? "connected" : (tunnel.status || "idle");
  const tunnelActionLabel = tunnel.publicUrl ? "Recreate tunnel" : "Create tunnel";
  const cloudflaredHint = !tunnel.available && !tunnelUrl
    ? (config.cloudflaredPath
      ? `Binary unavailable: ${config.cloudflaredPath}`
      : "cloudflared not found. Add it to PATH or set a binary path.")
    : "";
  const cloudflarePanel = `
    <div class="remote-mode-panel ${mode === "cloudflare" ? "remote-mode-panel--active" : ""}">
      <p class="remote-access__headline">Create a Cloudflare Quick Tunnel for public access without port forwarding.</p>
      ${remoteFieldMarkup({
        label: "Tunnel URL",
        value: tunnelShareUrl || (cloudflaredHint || "No active tunnel."),
        copyAction: "copy-tunnel-url",
        copyDisabled: !tunnelShareUrl,
      })}
      ${
        isRemote
          ? ""
          : `<label class="remote-access__field">
              <span>cloudflared path</span>
              <span class="remote-field">
                <input data-role="cloudflared-path" value="${escapeHtml(config.cloudflaredPath || "")}" placeholder="Leave empty for PATH, or set full path" />
                <button class="button button--ghost remote-field__copy" data-action="browse-cloudflared">Browse</button>
              </span>
            </label>`
      }
      <div class="remote-access__stats">
        <span class="workspace-chip workspace-chip--${tunnelStatusLabel === "connected" ? "ok" : "default"}"><strong>${escapeHtml(tunnelStatusLabel)}</strong> tunnel</span>
      </div>
      ${tunnel.error ? `<p class="inline-error">${escapeHtml(tunnel.error)}</p>` : ""}
      ${
        isRemote
          ? ""
          : `<div class="remote-mode-panel__actions">
              <button class="button" data-action="create-cloudflare-tunnel" ${config.enabled && tunnel.available ? "" : "disabled"}>${tunnelActionLabel}</button>
              <button class="button button--ghost" data-action="refresh-cloudflare-tunnel" ${config.enabled ? "" : "disabled"}>Refresh</button>
              <button class="button button--ghost" data-action="stop-cloudflare-tunnel" ${tunnel.publicUrl ? "" : "disabled"}>Stop</button>
            </div>`
      }
    </div>`;

  const vpsPanel = `
    <div class="remote-mode-panel ${mode === "vps" ? "remote-mode-panel--active" : ""}">
      <p class="remote-access__headline">Use a custom public URL for your own VPS, reverse proxy, or domain.</p>
      ${remoteFieldMarkup({
        label: "Public URL",
        value: isRemote ? customPublicUrl : (customPublicUrl || ""),
        readOnly: isRemote,
        dataRole: "custom-public-url",
        placeholder: "https://strideterm.example.com",
        copyAction: "copy-custom-public-url",
        copyDisabled: !customShareUrl || !normalizedCustomUrl,
      })}
      ${
        isRemote
          ? ""
          : `<div class="remote-mode-panel__actions">
              <button class="button" data-action="save-custom-public-url">Save URL</button>
              <button class="button button--ghost" data-action="clear-custom-public-url" ${config.customPublicUrl ? "" : "disabled"}>Clear</button>
            </div>`
      }
    </div>`;

  return `
    <div class="remote-card ${config.enabled ? "" : "remote-card--disabled"}">
      <div class="section-head">
        <div>
          <p class="eyebrow">${isRemote ? "Connected Client" : "Remote Access"}</p>
          <h3>Share this workspace</h3>
        </div>
        <div class="remote-access__header-actions">
          ${
            isRemote
              ? ""
              : `<button class="button button--ghost" data-action="toggle-remote-access">${config.enabled ? "Disable" : "Enable"}</button>`
          }
          <button class="button button--ghost" data-action="toggle-remote-panel">Close</button>
        </div>
      </div>
      <div class="remote-mode-tabs">
        ${modeTab("lan", "LAN")}
        ${modeTab("cloudflare", "Cloudflare")}
        ${modeTab("vps", "VPS / Custom")}
      </div>
      <div class="remote-access__hero">
        ${qrMarkup}
        <div class="remote-access__hero-copy">
          ${remoteFieldMarkup({
            label: "Share URL",
            value: modeShareUrl || "No URL available for this mode.",
            copyAction: mode === "cloudflare" ? "copy-tunnel-url" : mode === "vps" ? "copy-custom-public-url" : "copy-lan-url",
            copyDisabled: !modeShareUrl,
          })}
        </div>
      </div>
      <div class="remote-access__body">
        ${lanPanel}
        ${cloudflarePanel}
        ${vpsPanel}
      </div>
      <div class="remote-access__footer">
        ${remoteFieldMarkup({
          label: "Access token",
          value: config.token || "",
        })}
        ${
          isRemote
            ? ""
            : `<div class="remote-access__footer-actions">
                <button class="button button--ghost" data-action="regenerate-remote-token" ${config.enabled ? "" : "disabled"}>Regenerate token</button>
              </div>`
        }
      </div>
    </div>
  `;
}
