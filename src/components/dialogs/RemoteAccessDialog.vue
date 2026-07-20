<template>
  <div :class="['dialog', 'remote-access-dialog', !remoteConfig.enabled && 'remote-card--disabled']">
    <div class="dialog__header">
      <div>
        <p class="eyebrow">{{ isRemote ? "Connected Client" : "Remote Access" }}</p>
        <h2>Share this workspace</h2>
      </div>
      <div class="remote-access__header-actions">
        <button
          v-if="!isRemote"
          type="button"
          class="button button--ghost"
          :title="
            remoteConfig.enabled
              ? 'Stop the remote-access server. Already-connected clients are disconnected and the share URLs stop working.'
              : 'Start the remote-access HTTP/WebSocket server so other devices on your LAN (or via tunnel/VPS) can attach to this workspace.'
          "
          @click="store.toggleRemoteAccess()"
        >
          {{ remoteConfig.enabled ? "Disable" : "Enable" }}
        </button>
        <button type="button" class="button button--ghost" @click="emit('close')">Close</button>
      </div>
    </div>

    <!-- Mode tabs -->
    <div class="remote-mode-tabs">
      <button
        v-for="tab in MODES"
        :key="tab.id"
        type="button"
        :class="['remote-mode-tab', store.remoteAccessMode === tab.id && 'remote-mode-tab--active']"
        :title="`Show settings for the ${tab.label} sharing mode and use its URL as the active share URL (its QR code shows above).`"
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
        title="Copy the share URL of the currently selected sharing mode (token included) to the clipboard."
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
              title="Copy the share URL of the currently selected sharing mode (token included) to the clipboard."
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
              title="Copy the LAN share URL (token included) to the clipboard so you can paste it into a phone or another device on the same network."
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
            :title="`Use ${btn.host} as the active LAN share URL — the QR code and Copy buttons above will switch to this address. Useful when the host has multiple network interfaces.`"
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
          <span :class="['workspace-chip', serverStatus === 'live' ? 'workspace-chip--ok' : 'workspace-chip--default']">
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
              title="Copy the public Cloudflare tunnel URL (token included) to the clipboard."
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
              <button
                type="button"
                class="button button--ghost remote-field__copy"
                title="Open a file picker to locate your cloudflared binary on disk. Leave empty to fall back to the system PATH lookup."
                @click="browseCloudflared"
              >
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
            :disabled="!(remoteConfig.enabled && tunnel.available) || creatingTunnel"
            :title="
              tunnel.publicUrl
                ? 'Tear down the current Cloudflare quick-tunnel and start a fresh one — useful if the existing URL stopped routing.'
                : 'Spawn cloudflared to create a public Cloudflare quick-tunnel that proxies to your local remote-access server. No port forwarding needed.'
            "
            @click="createTunnel"
          >
            <span v-if="creatingTunnel" class="button-spinner" aria-hidden="true"></span>
            {{ creatingTunnel ? "Creating tunnel…" : tunnel.publicUrl ? "Recreate tunnel" : "Create tunnel" }}
          </button>
          <button
            type="button"
            class="button button--ghost"
            :disabled="!remoteConfig.enabled"
            title="Re-read the cloudflared binary status and tunnel state — does not restart the tunnel."
            @click="store.refreshTunnel()"
          >
            Refresh
          </button>
          <button
            type="button"
            class="button button--ghost"
            :disabled="!tunnel.publicUrl"
            title="Stop the running Cloudflare quick-tunnel — the public URL stops working immediately. LAN access is unaffected."
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
              title="Copy the saved custom public URL (token included) to the clipboard."
              @click="store.copyText(customShareUrl)"
            >
              Copy
            </button>
          </span>
        </label>
        <div v-if="!isRemote" class="remote-mode-panel__actions">
          <button
            type="button"
            class="button"
            title="Persist the URL above as the custom public URL for this app — used by the Telegram /tunnel command and the Share URL field above."
            @click="saveCustomUrl"
          >
            Save URL
          </button>
          <button
            type="button"
            class="button button--ghost"
            :disabled="!remoteConfig.customPublicUrl"
            title="Forget the saved custom public URL — falls back to the Cloudflare tunnel URL or LAN URL as the active share URL."
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
          title="Generate a new random access token. The old token is invalidated immediately — every active remote client is disconnected and must reconnect with the new share URL."
          @click="store.regenerateRemoteToken()"
        >
          Regenerate token
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, inject } from "vue";
import { apiKey } from "../../types/keys.js";
import { useAppStore } from "../../stores/app.js";
import { useRemoteConnection } from "../../composables/useRemoteConnection.js";
import { useQrCode } from "../../composables/useQrCode.js";
import type { Transport } from "../../transport.js";
import { pickPath } from "../../lib/pick-path.js";

const emit = defineEmits<{ close: [] }>();

const api = inject<Transport>(apiKey);
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
} = useRemoteConnection();

const { qrDataUrl } = useQrCode(activeShareUrl);

const lanHost = computed(() => runtimeRemote.value.host || remoteConfig.value.host || "0.0.0.0");
const lanPort = computed(() => String(runtimeRemote.value.port || remoteConfig.value.port || ""));

const cloudflaredPathInput = ref(remoteConfig.value.cloudflaredPath || "");
const customUrlInput = ref(customPublicUrl.value);
const creatingTunnel = ref(false);

async function createTunnel(): Promise<void> {
  if (creatingTunnel.value) return;
  creatingTunnel.value = true;
  try {
    await store.createCloudflareTunnel();
  } catch (err) {
    // Backend has already written the human-readable failure into
    // tunnel.error via applyExternalError, so the inline-error <p>
    // surfaces it automatically. Console.error is for the brave.
    console.error("createCloudflareTunnel failed", err);
  } finally {
    creatingTunnel.value = false;
  }
}

function copyActiveUrl(): void {
  const url = activeShareUrl.value;
  if (url) store.copyText(url);
}

function copyModeUrl(): void {
  const url = modeShareUrl.value;
  if (url) store.copyText(url);
}

async function browseCloudflared(): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const apiBrowse = (api as any)?.browseFile;
  if (!apiBrowse) return;
  const selected = await pickPath(() => apiBrowse({ defaultPath: cloudflaredPathInput.value }));
  if (selected) {
    cloudflaredPathInput.value = selected;
    await store.updateSettings({ remoteAccess: { cloudflaredPath: selected } });
  }
}

function saveCustomUrl(): void {
  store.saveCustomPublicUrl(customUrlInput.value.trim());
}
</script>

<style scoped>
.button-spinner {
  display: inline-block;
  width: 12px;
  height: 12px;
  margin-right: 6px;
  vertical-align: -2px;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: remote-access-spin 0.7s linear infinite;
}

@keyframes remote-access-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
