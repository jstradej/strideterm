<template>
  <!-- Compact card when collapsed -->
  <template v-if="!store.remoteAccessExpanded">
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
        <button type="button" class="button button--ghost remote-summary__configure" @click="store.toggleRemotePanel()">
          Configure
        </button>
      </div>
    </div>
    <div v-else class="remote-card remote-card--compact remote-card--minimal">
      <div class="remote-compact__icon">&#9678;</div>
      <span class="remote-summary__label">Remote Access</span>
      <button type="button" class="button button--ghost remote-summary__configure" @click="store.toggleRemotePanel()">
        Configure
      </button>
    </div>
  </template>

  <!-- Expanded full card — teleported to body so position:fixed works (sidebar has container-type) -->
  <Teleport to="body">
    <div
      v-if="store.remoteAccessExpanded"
      :class="['remote-card', 'remote-access--expanded', !remoteConfig.enabled && 'remote-card--disabled']"
    >
      <div class="section-head">
        <div>
          <p class="eyebrow">{{ isRemote ? "Connected Client" : "Remote Access" }}</p>
          <h3>Share this workspace</h3>
        </div>
        <div class="remote-access__header-actions">
          <button v-if="!isRemote" type="button" class="button button--ghost" @click="store.toggleRemoteAccess()">
            {{ remoteConfig.enabled ? "Disable" : "Enable" }}
          </button>
          <button type="button" class="button button--ghost" @click="store.toggleRemotePanel()">Close</button>
        </div>
      </div>

      <!-- Mode tabs -->
      <div class="remote-mode-tabs">
        <button
          v-for="tab in MODES"
          :key="tab.id"
          type="button"
          :class="['remote-mode-tab', store.remoteAccessMode === tab.id && 'remote-mode-tab--active']"
          @click="store.setRemoteMode(tab.id)"
        >
          {{ tab.label }}
        </button>
      </div>

      <!-- QR + share URL hero -->
      <div class="remote-access__hero">
        <button
          v-if="remoteConfig.enabled && modeShareUrl && qrDataUrl"
          type="button"
          class="remote-qr-button"
          title="Copy share URL"
          @click="copyActiveUrl"
        >
          <img class="remote-access__qr" :src="qrDataUrl" alt="QR code for remote access" />
        </button>
        <div v-else class="remote-access__qr remote-access__qr--placeholder">QR</div>
        <div class="remote-access__hero-copy">
          <label class="remote-access__field">
            <span>Share URL</span>
            <span class="remote-field">
              <input readonly :value="modeShareUrl || 'No URL available for this mode.'" />
              <button
                type="button"
                class="button button--ghost remote-field__copy"
                :disabled="!modeShareUrl"
                @click="copyModeUrl"
              >
                Copy
              </button>
            </span>
          </label>
        </div>
      </div>

      <div class="remote-access__body">
        <!-- LAN panel -->
        <div :class="['remote-mode-panel', store.remoteAccessMode === 'lan' && 'remote-mode-panel--active']">
          <p
            class="remote-access__headline"
            :title="`If you can't connect from another device, check that Windows Firewall allows inbound TCP on port ${lanPort}.`"
          >
            Access this workspace from any device on your local network.
          </p>
          <label class="remote-access__field">
            <span>LAN URL</span>
            <span class="remote-field">
              <input readonly :value="lanShareUrl || 'Server is not running.'" />
              <button
                type="button"
                class="button button--ghost remote-field__copy"
                :disabled="!lanShareUrl"
                @click="store.copyText(lanShareUrl)"
              >
                Copy
              </button>
            </span>
          </label>
          <div v-if="lanUrlButtons.length" class="remote-access__stats">
            <button
              v-for="btn in lanUrlButtons"
              :key="btn.shareUrl"
              type="button"
              :class="['workspace-chip', 'workspace-chip--btn', btn.active && 'workspace-chip--active']"
              @click="store.pickLanUrl(btn.shareUrl)"
            >
              {{ btn.host }}
            </button>
          </div>
          <div class="remote-access__stats">
            <span class="workspace-chip"
              ><strong>{{ lanHost }}</strong> host</span
            >
            <span class="workspace-chip"
              ><strong>{{ lanPort }}</strong> port</span
            >
            <span
              :class="['workspace-chip', serverStatus === 'live' ? 'workspace-chip--ok' : 'workspace-chip--default']"
            >
              <strong>{{ serverStatus }}</strong> server
            </span>
          </div>
          <p v-if="runtimeRemote.error" class="inline-error">{{ runtimeRemote.error }}</p>
        </div>

        <!-- Cloudflare panel -->
        <div :class="['remote-mode-panel', store.remoteAccessMode === 'cloudflare' && 'remote-mode-panel--active']">
          <p class="remote-access__headline">
            Create a Cloudflare Quick Tunnel for public access without port forwarding.
          </p>
          <label class="remote-access__field">
            <span>Tunnel URL</span>
            <span class="remote-field">
              <input readonly :value="tunnelShareUrl || cloudflaredHint || 'No active tunnel.'" />
              <button
                type="button"
                class="button button--ghost remote-field__copy"
                :disabled="!tunnelShareUrl"
                @click="store.copyText(tunnelShareUrl)"
              >
                Copy
              </button>
            </span>
          </label>
          <template v-if="!isRemote">
            <label class="remote-access__field">
              <span>cloudflared path</span>
              <span class="remote-field">
                <input v-model="cloudflaredPathInput" placeholder="Leave empty for PATH, or set full path" />
                <button type="button" class="button button--ghost remote-field__copy" @click="browseCloudflared">
                  Browse
                </button>
              </span>
            </label>
          </template>
          <div class="remote-access__stats">
            <span
              :class="[
                'workspace-chip',
                tunnelStatusLabel === 'connected' ? 'workspace-chip--ok' : 'workspace-chip--default',
              ]"
            >
              <strong>{{ tunnelStatusLabel }}</strong> tunnel
            </span>
          </div>
          <p v-if="tunnel.error" class="inline-error">{{ tunnel.error }}</p>
          <div v-if="!isRemote" class="remote-mode-panel__actions">
            <button
              type="button"
              class="button"
              :disabled="!(remoteConfig.enabled && tunnel.available)"
              @click="store.createCloudflareTunnel()"
            >
              {{ tunnel.publicUrl ? "Recreate tunnel" : "Create tunnel" }}
            </button>
            <button
              type="button"
              class="button button--ghost"
              :disabled="!remoteConfig.enabled"
              @click="store.refreshTunnel()"
            >
              Refresh
            </button>
            <button
              type="button"
              class="button button--ghost"
              :disabled="!tunnel.publicUrl"
              @click="store.stopCloudflareTunnel()"
            >
              Stop
            </button>
          </div>
        </div>

        <!-- VPS panel -->
        <div :class="['remote-mode-panel', store.remoteAccessMode === 'vps' && 'remote-mode-panel--active']">
          <p class="remote-access__headline">Use a custom public URL for your own VPS, reverse proxy, or domain.</p>
          <label class="remote-access__field">
            <span>Public URL</span>
            <span class="remote-field">
              <input v-if="!isRemote" v-model="customUrlInput" placeholder="https://strideterm.example.com" />
              <input v-else readonly :value="customPublicUrl" />
              <button
                type="button"
                class="button button--ghost remote-field__copy"
                :disabled="!customShareUrl || !normalizedCustomUrl"
                @click="store.copyText(customShareUrl)"
              >
                Copy
              </button>
            </span>
          </label>
          <div v-if="!isRemote" class="remote-mode-panel__actions">
            <button type="button" class="button" @click="saveCustomUrl">Save URL</button>
            <button
              type="button"
              class="button button--ghost"
              :disabled="!remoteConfig.customPublicUrl"
              @click="store.clearCustomPublicUrl()"
            >
              Clear
            </button>
          </div>
        </div>
      </div>

      <!-- Footer: access token -->
      <div class="remote-access__footer">
        <label class="remote-access__field">
          <span>Access token</span>
          <span class="remote-field">
            <input readonly :value="remoteConfig.token || ''" />
          </span>
        </label>
        <div v-if="!isRemote" class="remote-access__footer-actions">
          <button
            type="button"
            class="button button--ghost"
            :disabled="!remoteConfig.enabled"
            @click="store.regenerateRemoteToken()"
          >
            Regenerate token
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { ref, computed, inject } from "vue";
import { useAppStore } from "../../stores/app.js";
import { useRemoteConnection } from "../../composables/useRemoteConnection.js";
import { useQrCode } from "../../composables/useQrCode.js";

const api = inject("api");
const store = useAppStore();
const isRemote = api?.isRemote || false;

const MODES = [
  { id: "lan", label: "LAN" },
  { id: "cloudflare", label: "Cloudflare" },
  { id: "vps", label: "VPS / Custom" },
];

const {
  remoteConfig,
  runtimeRemote,
  tunnel,
  lanShareUrl,
  tunnelShareUrl,
  customShareUrl,
  customPublicUrl,
  normalizedCustomUrl,
  modeShareUrl,
  activeShareUrl,
  serverStatus,
  tunnelStatusLabel,
  lanUrlButtons,
  cloudflaredHint,
  hasPublicUrl,
  hasAnyUrl,
  activeError,
} = useRemoteConnection();

const { qrDataUrl } = useQrCode(activeShareUrl);

const lanHost = computed(() => runtimeRemote.value.host || remoteConfig.value.host || "0.0.0.0");
const lanPort = computed(() => String(runtimeRemote.value.port || remoteConfig.value.port || ""));

const cloudflaredPathInput = ref(remoteConfig.value.cloudflaredPath || "");
const customUrlInput = ref(customPublicUrl.value);

function copyActiveUrl() {
  const url = activeShareUrl.value;
  if (url) store.copyText(url);
}

function copyModeUrl() {
  const url = modeShareUrl.value;
  if (url) store.copyText(url);
}

async function browseCloudflared() {
  if (!api?.browseFile) return;
  const selected = await api.browseFile({ defaultPath: cloudflaredPathInput.value });
  if (selected) {
    cloudflaredPathInput.value = selected;
    await store.updateSettings({ remoteAccess: { cloudflaredPath: selected } });
  }
}

function saveCustomUrl() {
  store.saveCustomPublicUrl(customUrlInput.value.trim());
}
</script>
