<template>
  <div class="remote-overview" data-testid="remote-overview">
    <p class="remote-overview__intro">
      Remote channels are set up in Remote Access. Open one below to change it; nothing here is saved with Settings.
    </p>

    <ul v-if="warnings.length" class="remote-overview__warnings" aria-label="Needs attention">
      <li v-for="warning in warnings" :key="warning.id" class="remote-overview__warning" role="status">
        <span>{{ warning.text }}</span>
        <button type="button" class="button button--ghost" @click="warning.open()">Open</button>
      </li>
    </ul>

    <ul class="remote-overview__rows">
      <li class="remote-overview__row" data-testid="remote-row-mobile">
        <div class="remote-overview__label">
          <strong>Mobile</strong>
          <span>{{ mobileStatus }}</span>
        </div>
        <button type="button" class="button button--ghost" @click="openRemote({ mode: 'mobile' })">Open</button>
      </li>

      <li v-if="canHostPeers" class="remote-overview__row" data-testid="remote-row-hosting">
        <div class="remote-overview__label">
          <strong>Desktops — hosting</strong>
          <span>{{ hostingStatus }}</span>
        </div>
        <button type="button" class="button button--ghost" @click="openRemote({ mode: 'desktops' })">Open</button>
      </li>

      <template v-if="peers.available">
        <li
          v-for="host in peers.hosts"
          :key="host.id"
          class="remote-overview__row"
          :data-testid="`remote-row-host-${host.id}`"
        >
          <div class="remote-overview__label">
            <strong>Desktops — connected</strong>
            <span>{{ host.label }} · {{ hostStateText(host) }}</span>
          </div>
          <button type="button" class="button button--ghost" @click="openProfiles">Open Profiles</button>
        </li>
      </template>

      <li class="remote-overview__row" data-testid="remote-row-browser">
        <div class="remote-overview__label">
          <strong>Browser</strong>
          <span>{{ browserStatus }}</span>
        </div>
        <div class="remote-overview__actions">
          <button type="button" class="button button--ghost" @click="openRemote({ mode: browserMode })">Open</button>
          <button
            v-if="canListSessions"
            type="button"
            class="button button--ghost"
            data-testid="remote-open-sessions"
            @click="openRemote({ mode: browserMode, focusSessions: true })"
          >
            Sessions ({{ sessionCount }})
          </button>
        </div>
      </li>

      <li class="remote-overview__row" data-testid="remote-row-telegram">
        <div class="remote-overview__label">
          <strong>Telegram</strong>
          <span>{{ telegramStatus }}</span>
        </div>
        <button type="button" class="button button--ghost" @click="emit('open-tab', 'telegram')">Open</button>
      </li>
    </ul>
  </div>
</template>

<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { apiKey } from "../../../types/keys.js";
import type { Transport } from "../../../transport.js";
import { useAppStore } from "../../../stores/app.js";
import { useAccountStore } from "../../../stores/account.js";
import { usePeersStore } from "../../../stores/peers.js";
import { useNotificationStore } from "../../../stores/notifications.js";
import { useRemoteConnection } from "../../../composables/useRemoteConnection.js";
import { getMobileAccessWarning } from "../../../lib/mobile-access-warning.js";
import type { PeerAttachedHost, PeerHostState } from "../../../../electron/shared/peers.js";

const emit = defineEmits<{ "open-tab": [tabId: string] }>();

type RemoteMode = "mobile" | "desktops" | "lan" | "cloudflare" | "vps";

const api = inject<Transport>(apiKey);
const store = useAppStore();
const accountStore = useAccountStore();
const peers = usePeersStore();
const notifications = useNotificationStore();
const { remoteConfig } = useRemoteConnection();

const canHostPeers = typeof api?.getPeerHostState === "function";
const canListSessions = typeof api?.listRemoteSessions === "function";
const hostState = ref<PeerHostState | null>(null);
const sessionCount = ref(0);

const paused = computed(() => remoteConfig.value.paused === true);
const browserMode = computed<RemoteMode>(() => {
  const mode = store.remoteAccessMode;
  return mode === "cloudflare" || mode === "vps" ? mode : "lan";
});
const activePhoneCount = computed(
  () => store.mobileDevices.filter((device) => !device.revoked && device.state === "active").length,
);
const mobileWarning = computed(() =>
  getMobileAccessWarning({
    mobileEnabled: store.mobileEnabled,
    pairedPhoneCount: activePhoneCount.value,
    health: store.mobileConnectionHealth,
    entitlement: accountStore.entitlement ?? accountStore.overview?.entitlement,
  }),
);
const mobileExpiring = computed(
  () =>
    mobileWarning.value === "trial-expiring" ||
    mobileWarning.value === "access-expiring" ||
    mobileWarning.value === "trial-expired" ||
    mobileWarning.value === "access-expired",
);

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

const mobileStatus = computed(() => {
  if (!store.mobileEnabled && activePhoneCount.value === 0) return "Off";
  const parts: string[] = [];
  if (accountStore.available) {
    if (mobileWarning.value === "trial-expired" || mobileWarning.value === "access-expired")
      parts.push("Account access ended");
    else if (mobileExpiring.value) parts.push("Account access ends soon");
    else parts.push(accountStore.state.installationRegistered === true ? "Signed in" : "Not signed in");
  }
  parts.push(store.mobileRelayEnabled ? "Relay on" : "Relay off");
  parts.push(plural(activePhoneCount.value, "phone", "phones"));
  return parts.join(" · ");
});

const pairedDeviceCount = computed(() => hostState.value?.devices.length ?? 0);
const hostingStatus = computed(() => {
  const state = hostState.value;
  if (!state) return "Checking…";
  const devices = plural(state.devices.length, "paired desktop", "paired desktops");
  return state.hosting.enabled ? `On · port ${state.hosting.port} · ${devices}` : `Off · ${devices}`;
});

const browserStatus = computed(() => {
  const label = { lan: "LAN", cloudflare: "Cloudflare", vps: "VPS / Custom" }[browserMode.value as string];
  const sharing = remoteConfig.value.enabled ? "Sharing on" : "Sharing off";
  return canListSessions
    ? `${sharing} · ${label} · ${plural(sessionCount.value, "active session", "active sessions")}`
    : `${sharing} · ${label}`;
});

const telegramStatus = computed(() => {
  const count = store.payload?.appState?.settings?.integrations?.telegram?.connections?.length ?? 0;
  return count ? plural(count, "bot connection", "bot connections") : "Not set up";
});

function hostStateText(host: PeerAttachedHost): string {
  switch (host.state) {
    case "online":
      return "online";
    case "offline":
      return "offline";
    case "not-paired":
      return "needs pairing";
    case "wrong-host":
      return "another strIDEterm answers there";
    case "version-mismatch":
      return `version mismatch (host ${host.hostAppVersion || "?"}, here ${host.localAppVersion || "?"})`;
    default:
      return "checking…";
  }
}

interface Warning {
  id: string;
  text: string;
  open: () => void;
}
const warnings = computed<Warning[]>(() => {
  const list: Warning[] = [];
  if (paused.value)
    list.push({
      id: "paused",
      text: "All remote access is paused.",
      open: () => openRemote({ mode: "mobile" }),
    });
  if (mobileExpiring.value)
    list.push({
      id: "mobile-account",
      text:
        mobileWarning.value === "trial-expired" || mobileWarning.value === "access-expired"
          ? "Mobile account access has ended."
          : "Mobile account access ends soon.",
      open: () => openRemote({ mode: "mobile", mobileView: "account" }),
    });
  if (peers.available)
    for (const host of peers.hosts)
      if (host.state === "version-mismatch")
        list.push({
          id: `version-${host.id}`,
          text: `${host.label}: ${hostStateText(host)}. Both desktops must run the same version.`,
          open: openProfiles,
        });
  if (hostState.value && !hostState.value.hosting.enabled && pairedDeviceCount.value > 0)
    list.push({
      id: "hosting-off",
      text: `Hosting is off, but ${plural(pairedDeviceCount.value, "desktop is", "desktops are")} paired.`,
      open: () => openRemote({ mode: "desktops" }),
    });
  return list;
});

function openRemote(opts: {
  mode?: RemoteMode;
  mobileView?: "overview" | "phones" | "account";
  focusSessions?: boolean;
}) {
  store.openRemoteAccessDialog(opts);
}
function openProfiles(): void {
  store.openProfilesDialog({ subDialog: true });
}

async function loadHostState(): Promise<void> {
  const load = api?.getPeerHostState;
  if (!load) return;
  await notifications.runWithToast("Could not load desktop hosting", async () => {
    hostState.value = await load();
  });
}
async function loadSessions(): Promise<void> {
  const list = api?.listRemoteSessions;
  if (!list) return;
  await notifications.runWithToast("Failed to load sessions", async () => {
    sessionCount.value = (await list()).length;
  });
}
async function loadPhones(): Promise<void> {
  if (typeof api?.listMobileDevices !== "function") return;
  await notifications.runWithToast("Could not load phones", () => store.refreshMobileDevices());
}
async function reload(): Promise<void> {
  await Promise.all([loadHostState(), loadSessions(), loadPhones(), peers.open()]);
}

const unsubscribers: Array<() => void> = [];
onMounted(() => {
  peers.refreshAvailability();
  unsubscribers.push(peers.watch());
  void reload();
  for (const subscribe of [api?.onPeersUpdated, api?.onPeerPairingProgress])
    if (subscribe) unsubscribers.push(subscribe(() => void loadHostState()));
});
onBeforeUnmount(() => unsubscribers.splice(0).forEach((off) => off()));

// A layer opened from here (Remote Access, Profiles) may have changed what the rows show.
watch(
  () => store.dialogLayers.length,
  (now, before) => {
    if (now < before) void reload();
  },
);
</script>

<style scoped>
.remote-overview {
  display: grid;
  gap: 12px;
  align-content: start;
}

.remote-overview__intro {
  margin: 0;
  color: var(--muted);
}

.remote-overview__warnings,
.remote-overview__rows {
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.remote-overview__warning,
.remote-overview__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
}

.remote-overview__warning {
  border-color: var(--accent);
  color: var(--accent);
}

.remote-overview__label {
  display: grid;
  gap: 2px;
  min-width: 0;
}

.remote-overview__label span {
  color: var(--muted);
  overflow-wrap: anywhere;
}

.remote-overview__actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}
</style>
