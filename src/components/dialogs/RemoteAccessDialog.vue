<template>
  <div :class="['dialog', 'remote-access-dialog', !ownPanelMode && !remoteConfig.enabled && 'remote-card--disabled']">
    <div class="dialog__header">
      <div>
        <p class="eyebrow">{{ isRemote ? "Connected Client" : "Remote Access" }}</p>
        <h2>Connect to strIDEterm</h2>
      </div>
      <div class="remote-access__header-actions">
        <RemoteAccessPauseControl v-if="!isRemote" />
        <button
          v-if="!isRemote && !ownPanelMode"
          :disabled="remoteConfig.paused"
          type="button"
          class="button button--ghost"
          :title="
            remoteConfig.enabled
              ? 'Stop the remote-access server. Already-connected clients are disconnected and the share URLs stop working.'
              : 'Start the remote-access HTTP/WebSocket server so other devices on your LAN (or via tunnel/VPS) can attach to this workspace.'
          "
          @click="store.toggleRemoteAccess()"
        >
          {{ remoteConfig.enabled ? "Disable browser sharing" : "Enable browser sharing" }}
        </button>
        <button type="button" class="button button--ghost" @click="emit('close')">Close</button>
      </div>
    </div>

    <p v-if="remoteConfig.paused" class="remote-access__paused" role="status">
      All remote access is paused. Paired phones and connection settings are preserved.
    </p>
    <!-- Mode tabs -->
    <div class="remote-mode-tabs">
      <button
        v-for="tab in availableModes"
        :key="tab.id"
        type="button"
        :class="['remote-mode-tab', selectedMode === tab.id && 'remote-mode-tab--active']"
        :title="
          tab.id === 'mobile'
            ? 'Pair phones, manage their access, and configure mobile connections.'
            : tab.id === 'desktops'
              ? 'Let other strIDEterm desktops attach profiles of this one.'
              : `Show settings for ${tab.label} sharing.`
        "
        @click="selectMode(tab.id)"
      >
        <svg class="remote-mode-tab__icon" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
          <template v-if="tab.id === 'mobile'">
            <rect x="6" y="2.5" width="8" height="15" rx="1.5" />
            <path d="M9 15h2" />
          </template>
          <template v-else-if="tab.id === 'desktops'">
            <rect x="2.5" y="3" width="15" height="10" rx="1" />
            <path d="M7 17h6M10 13v4" />
          </template>
          <template v-else-if="tab.id === 'lan'">
            <circle cx="10" cy="10" r="7.5" />
            <path d="M2.8 10h14.4M10 2.5a12 12 0 0 1 0 15M10 2.5a12 12 0 0 0 0 15" />
          </template>
          <template v-else-if="tab.id === 'cloudflare'">
            <path d="M5.1 15.5h9.6a3 3 0 0 0 .2-6 4.8 4.8 0 0 0-9.2-1.1 3.6 3.6 0 0 0-.6 7.1Z" />
          </template>
          <template v-else>
            <rect x="3" y="3" width="14" height="10" rx="1" />
            <path d="M7 17h6M10 13v4" />
          </template>
        </svg>
        {{ tab.label }}
      </button>
    </div>

    <div v-if="!isRemote" v-show="selectedMode === 'mobile'" class="remote-access__mobile">
      <MobileConnectionPanel
        :profiles="store.payload?.appState?.profiles || []"
        :show-pause-control="false"
        :visible="selectedMode === 'mobile'"
        :initial-view="initialMobileView"
      />
    </div>
    <div v-if="canHostPeers && selectedMode === 'desktops'" class="remote-access__mobile">
      <PeerHostingPanel />
    </div>
    <fieldset v-if="!ownPanelMode" class="remote-access__legacy" :disabled="remoteConfig.paused">
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
            <span
              :class="['workspace-chip', serverStatus === 'live' ? 'workspace-chip--ok' : 'workspace-chip--default']"
            >
              <strong>{{ serverStatus }}</strong> server
            </span>
          </div>
          <p v-if="runtimeRemote.error" class="inline-error">{{ runtimeRemote.error }}</p>
          <label
            class="remote-access__checkbox"
            :title="
              isRemote
                ? 'Desktop only: opening or closing the port to the network is changed at the desktop.'
                : 'When off, the server listens on this computer only (127.0.0.1). The tunnel and the managed relay keep working.'
            "
          >
            <input
              type="checkbox"
              data-testid="network-access"
              :checked="networkAccess"
              :disabled="isRemote"
              @change="setNetworkAccess(($event.target as HTMLInputElement).checked)"
            />
            <span
              >Allow access from other devices on the network (LAN, VPN, Tailscale) — http://&lt;IP&gt;:{{
                lanPort
              }}</span
            >
          </label>
          <p class="remote-access__note" data-testid="network-access-note">
            This traffic is not encrypted. The tunnel and the managed relay don't need it.
            <template v-if="!isRemote && networkAccess && relayEnabled">
              With the managed relay on, you can turn it off.</template
            >
            <template v-if="isRemote"> Desktop only.</template>
          </p>
        </div>

        <!-- Cloudflare panel -->
        <div :class="['remote-mode-panel', store.remoteAccessMode === 'cloudflare' && 'remote-mode-panel--active']">
          <p class="remote-access__headline">
            Create a Cloudflare Quick Tunnel for public access without port forwarding.
          </p>
          <p class="remote-access__note" data-testid="quick-tunnel-note">
            Uses a public trycloudflare.com URL through the cloudflared binary. On managed machines, security tools may
            flag it — the managed relay is an alternative.
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
        <div v-if="secureStorageMissing" class="remote-access__secure-warning" role="alert">
          <strong>Credentials are stored without OS encryption.</strong> This computer has no encrypted credential
          storage, so the remote access token and saved provider tokens are kept base64-encoded in the credentials file.
          Anyone able to read that file can use them.
        </div>
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
    </fieldset>
    <!-- Outside the fieldset above: signing a session out is a security action and must work while paused. -->
    <section
      v-if="showSessions"
      ref="sessionsSection"
      class="remote-sessions"
      data-testid="remote-sessions"
      :aria-label="`Active browser sessions (${remoteSessions.length})`"
    >
      <button
        type="button"
        class="remote-sessions__toggle"
        :aria-expanded="sessionsOpen"
        data-testid="remote-sessions-toggle"
        @click="sessionsOpen = !sessionsOpen"
      >
        <span :class="['disclosure-chevron', sessionsOpen && 'disclosure-chevron--open']" aria-hidden="true" />
        Active browser sessions ({{ remoteSessions.length }})
      </button>
      <div v-if="sessionsOpen" class="remote-sessions__body">
        <h3>Session length</h3>
        <p class="remote-access__note">Sessions end after inactivity or when their absolute lifetime expires.</p>
        <label class="remote-session-setting">
          <span>Idle timeout (minutes)</span>
          <input v-model.number="sessionIdleInput" type="number" min="15" max="43200" />
        </label>
        <label class="remote-session-setting">
          <span>Absolute lifetime (minutes)</span>
          <input v-model.number="sessionAbsoluteInput" type="number" min="60" max="129600" />
        </label>
        <p v-if="sessionTtlError" class="inline-error" role="alert">{{ sessionTtlError }}</p>
        <p v-else-if="sessionTtlSaveError" class="inline-error" role="alert">{{ sessionTtlSaveError }}</p>
        <div class="remote-sessions__actions">
          <button
            type="button"
            class="button"
            data-testid="session-ttl-apply"
            :disabled="!sessionTtlDirty || !!sessionTtlError || sessionTtlSaving"
            @click="applySessionTtl"
          >
            Apply
          </button>
        </div>
        <h3>Sessions</h3>
        <div class="remote-sessions__actions">
          <button type="button" class="button button--ghost" :disabled="remoteSessionsBusy" @click="loadRemoteSessions">
            Refresh
          </button>
          <button
            type="button"
            class="button button--ghost"
            :disabled="remoteSessionsBusy || !remoteSessions.length"
            @click="revokeAllRemoteSessions"
          >
            Sign out all
          </button>
        </div>
        <p v-if="remoteSessionsBusy">Loading sessions…</p>
        <p v-else-if="!remoteSessions.length">No active browser sessions.</p>
        <article v-for="session in remoteSessions" :key="session.sessionRef" class="remote-sessions__entry">
          <strong>{{ session.origin }}</strong> · {{ session.remoteAddress }}
          <p>
            Created {{ formatRemoteDate(session.createdAt) }} · Last used {{ formatRemoteDate(session.lastSeenAt) }} ·
            Expires {{ formatRemoteDate(Math.min(session.expiresAt, session.idleExpiresAt)) }}
          </p>
          <button
            type="button"
            class="button button--ghost"
            :disabled="remoteSessionsBusy"
            @click="revokeRemoteSession(session.sessionRef)"
          >
            Sign out
          </button>
        </article>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, inject, watch, nextTick, onMounted } from "vue";
import RemoteAccessPauseControl from "../layout/RemoteAccessPauseControl.vue";
import MobileConnectionPanel from "./settings/MobileConnectionPanel.vue";
import PeerHostingPanel from "../peers/PeerHostingPanel.vue";
import { apiKey } from "../../types/keys.js";
import { useAppStore } from "../../stores/app.js";
import { useAccountStore } from "../../stores/account.js";
import { useRemoteConnection } from "../../composables/useRemoteConnection.js";
import { useQrCode } from "../../composables/useQrCode.js";
import type { Transport } from "../../transport.js";
import { pickPath } from "../../lib/pick-path.js";
import { rlog } from "../../lib/renderer-log.js";
import { userFacingMessage } from "../../lib/error-message.js";
import { useNotificationStore } from "../../stores/notifications.js";
import type { RemoteBrowserSession } from "../../../electron/shared/remote-access.js";

const props = defineProps<{
  initialMode?: "mobile" | "desktops" | "lan" | "cloudflare" | "vps";
  initialMobileView?: "overview" | "phones" | "account";
  focusSessions?: boolean;
}>();
const emit = defineEmits<{ close: [] }>();

const api = inject<Transport>(apiKey);
const store = useAppStore();
const secureStorageMissing = computed(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  () => (store.payload as any)?.secureStorage?.available === false,
);
const accountStore = useAccountStore();
const isRemote = api?.isRemote || false;

const canHostPeers = typeof api?.getPeerHostState === "function";
const availableModes = [
  ...(!isRemote ? [{ id: "mobile", label: "Mobile" }] : []),
  ...(canHostPeers ? [{ id: "desktops", label: "Desktops" }] : []),
  { id: "lan", label: "LAN" },
  { id: "cloudflare", label: "Cloudflare" },
  { id: "vps", label: "VPS / Custom" },
];

function startingMode(): string {
  if (isRemote) return store.remoteAccessMode;
  const wanted = props.initialMode ?? (props.focusSessions ? store.remoteAccessMode : "mobile");
  return availableModes.some((mode) => mode.id === wanted) ? wanted : "mobile";
}
const selectedMode = ref(startingMode());
if (!isRemote && selectedMode.value !== "mobile" && selectedMode.value !== "desktops")
  store.setRemoteMode(selectedMode.value);
watch(
  () => store.mobilePairingSas?.deviceId,
  (deviceId) => {
    if (deviceId && !isRemote) selectedMode.value = "mobile";
  },
);
watch(
  () => accountStore.auth?.phase,
  (phase) => {
    if (phase === "awaiting-confirmation" && !isRemote) selectedMode.value = "mobile";
  },
);
function selectMode(mode: string) {
  selectedMode.value = mode;
  if (mode !== "mobile" && mode !== "desktops") store.setRemoteMode(mode);
}
const ownPanelMode = computed(() => selectedMode.value === "mobile" || selectedMode.value === "desktops");

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

// Default true (today's behaviour); only an explicit false binds loopback. Never flipped
// automatically — the relay tip above is a hint, not an action.
const networkAccess = computed(() => remoteConfig.value.networkAccess !== false);
const relayEnabled = computed(() => store.mobileRelayEnabled === true);
async function setNetworkAccess(value: boolean): Promise<void> {
  if (isRemote) return;
  await store.updateSettings({ remoteAccess: { networkAccess: value } });
}

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

// Desktop only, like today's Settings tab: a remote client's transport has no session list.
const canManageSessions = !isRemote && typeof api?.listRemoteSessions === "function";
const showSessions = computed(() => canManageSessions && !ownPanelMode.value);
const notifications = useNotificationStore();
const remoteSessions = ref<RemoteBrowserSession[]>([]);
const remoteSessionsBusy = ref(false);
const sessionsOpen = ref(props.focusSessions === true);
const sessionsSection = ref<HTMLElement | null>(null);

async function loadRemoteSessions(): Promise<void> {
  if (!api?.listRemoteSessions || remoteSessionsBusy.value) return;
  remoteSessionsBusy.value = true;
  try {
    await notifications.runWithToast("Failed to load sessions", async () => {
      remoteSessions.value = await api.listRemoteSessions!();
    });
  } finally {
    remoteSessionsBusy.value = false;
  }
}
async function revokeRemoteSessions(selection: { sessionRef: string } | { all: true }, title: string): Promise<void> {
  if (!api?.revokeRemoteSessions || remoteSessionsBusy.value) return;
  remoteSessionsBusy.value = true;
  try {
    await notifications.runWithToast(title, async () => {
      await api.revokeRemoteSessions!(selection);
      remoteSessions.value = await api.listRemoteSessions!();
    });
  } finally {
    remoteSessionsBusy.value = false;
  }
}
function revokeRemoteSession(sessionRef: string): Promise<void> {
  return revokeRemoteSessions({ sessionRef }, "Failed to sign out session");
}
function revokeAllRemoteSessions(): Promise<void> {
  return revokeRemoteSessions({ all: true }, "Failed to sign out sessions");
}
function formatRemoteDate(at: number): string {
  return new Date(at).toLocaleString();
}

const storedIdleTtl = computed(() => Number(remoteConfig.value.sessionIdleTtlMinutes ?? 1440));
const storedAbsoluteTtl = computed(() => Number(remoteConfig.value.sessionAbsoluteTtlMinutes ?? 10080));
const sessionIdleInput = ref(storedIdleTtl.value);
const sessionAbsoluteInput = ref(storedAbsoluteTtl.value);
const sessionTtlSaving = ref(false);
const sessionTtlSaveError = ref("");
watch([storedIdleTtl, storedAbsoluteTtl], ([idle, absolute], [oldIdle, oldAbsolute]) => {
  if (sessionIdleInput.value === oldIdle) sessionIdleInput.value = idle;
  if (sessionAbsoluteInput.value === oldAbsolute) sessionAbsoluteInput.value = absolute;
});
const sessionTtlDirty = computed(
  () => sessionIdleInput.value !== storedIdleTtl.value || sessionAbsoluteInput.value !== storedAbsoluteTtl.value,
);
const sessionTtlError = computed(() => {
  const idle = sessionIdleInput.value;
  const absolute = sessionAbsoluteInput.value;
  if (!Number.isInteger(idle) || idle < 15 || idle > 43200)
    return "Idle timeout must be between 15 and 43,200 minutes.";
  if (!Number.isInteger(absolute) || absolute < 60 || absolute > 129600)
    return "Absolute lifetime must be between 60 and 129,600 minutes.";
  if (idle > absolute) return "Idle timeout cannot exceed the absolute lifetime.";
  return "";
});
async function applySessionTtl(): Promise<void> {
  if (sessionTtlSaving.value || sessionTtlError.value) return;
  sessionTtlSaving.value = true;
  sessionTtlSaveError.value = "";
  try {
    await store.updateSettings({
      remoteAccess: {
        sessionIdleTtlMinutes: sessionIdleInput.value,
        sessionAbsoluteTtlMinutes: sessionAbsoluteInput.value,
      },
    });
  } catch (err) {
    sessionTtlSaveError.value = userFacingMessage(err);
    rlog("error", "[remote-access] saving the browser session length failed", { err: userFacingMessage(err) });
  } finally {
    sessionTtlSaving.value = false;
  }
}

onMounted(() => {
  if (canManageSessions) void loadRemoteSessions();
  if (props.focusSessions && showSessions.value)
    void nextTick(() => sessionsSection.value?.scrollIntoView?.({ block: "nearest" }));
});
</script>

<style scoped>
.remote-access__secure-warning {
  margin: 0 0 12px;
  padding: 10px 12px;
  border: 1px solid #d97706;
  border-radius: 6px;
  background: rgba(217, 119, 6, 0.12);
  font-size: 12.5px;
  line-height: 1.5;
}

.remote-sessions {
  flex: 0 0 auto;
  max-height: 45%;
  overflow: auto;
  border-top: 1px solid var(--border);
  padding-top: 8px;
}

.remote-sessions__toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}

.remote-sessions__body {
  display: grid;
  gap: 8px;
  padding-top: 8px;
}

.remote-sessions__body h3 {
  margin: 4px 0 0;
}

.remote-sessions__actions {
  display: flex;
  gap: 6px;
}

.remote-sessions__entry {
  display: grid;
  gap: 4px;
  justify-items: start;
}

.remote-sessions__entry p {
  margin: 0;
}

.remote-session-setting {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(150px, 220px);
  align-items: center;
  gap: 12px;
}

.remote-session-setting > input {
  width: 100%;
}

@media (max-width: 600px) {
  .remote-session-setting {
    grid-template-columns: minmax(0, 1fr);
    gap: 4px;
  }
}

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
