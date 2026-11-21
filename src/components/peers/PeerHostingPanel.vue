<template>
  <div class="peer-hosting" data-testid="peer-hosting">
    <p class="remote-access__note">
      Attaching desktops is a separate switch from browser sharing and the mobile relay, and works while they are off.
    </p>

    <p v-if="!state && !loadFailed" class="peer-hosting__muted peer-hosting__wait" role="status">
      <Spinner size="sm" aria-hidden="true" />
      Loading…
    </p>
    <div v-else-if="!state" class="peer-hosting__wait" data-testid="peer-hosting-load-failed">
      <p class="peer-hosting__muted" role="alert">Could not load desktop hosting.</p>
      <button type="button" class="button button--ghost" data-testid="peer-hosting-retry" @click="retryLoad">
        Retry
      </button>
    </div>
    <template v-else>
      <section class="peer-hosting__section">
        <label class="remote-access__checkbox">
          <input
            type="checkbox"
            data-testid="peer-hosting-toggle"
            :checked="state.hosting.enabled"
            :disabled="toggleDisabled"
            @change="onToggle"
          />
          <span>Let other strIDEterm desktops attach profiles of this one</span>
          <Spinner
            v-if="busyAction === 'toggle'"
            size="sm"
            label="Applying the change"
            data-testid="peer-hosting-toggle-busy"
          />
        </label>
        <p v-if="!state.encryptionAvailable" class="remote-access__secure-warning" role="alert">
          <strong>Secure storage is required.</strong> This computer has no encrypted credential storage, so hosting
          cannot be turned on.
        </p>
        <div class="peer-hosting__port">
          <label class="remote-access__field">
            <span>Port</span>
            <span class="remote-field">
              <input
                v-model="portDraft"
                class="settings-input"
                data-testid="peer-hosting-port"
                type="text"
                inputmode="numeric"
                autocomplete="off"
                :disabled="busy"
                aria-label="Port for attaching desktops"
                @keyup.enter="applyPort"
              />
              <button
                type="button"
                class="button button--ghost remote-field__copy"
                :class="{ 'button--pending': busyAction === 'port' }"
                :aria-busy="busyAction === 'port' ? 'true' : undefined"
                data-testid="peer-hosting-port-apply"
                :disabled="busy || !portValid || portUnchanged"
                @click="applyPort"
              >
                Apply
              </button>
            </span>
          </label>
          <p v-if="!portValid" class="inline-error" data-testid="peer-hosting-port-error">
            Enter a port between 1 and 65535.
          </p>
          <details class="peer-hosting__help" data-testid="peer-hosting-firewall">
            <summary>If another desktop cannot connect</summary>
            <PeerFirewallHelp :port="firewallPort" :os="localOs" />
          </details>
        </div>
      </section>

      <section v-if="state.hosting.enabled" class="peer-hosting__section" data-testid="peer-hosting-listener">
        <template v-if="state.listener.listening">
          <p class="peer-hosting__title">Listening on port {{ state.listener.port }}</p>
          <div class="remote-access__stats">
            <button
              v-for="address in state.listener.addresses"
              :key="address"
              type="button"
              class="workspace-chip workspace-chip--btn"
              data-testid="peer-hosting-address"
              :title="`Copy ${address}:${state.listener.port} to the clipboard.`"
              @click="copyAddress(address)"
            >
              {{ address }}:{{ state.listener.port }}
            </button>
          </div>
          <p class="remote-access__note">
            On the other desktop, open Profiles → “Connect from network…”, type one of these addresses and the port,
            then type here the code it shows.
          </p>
          <p class="remote-access__note">
            The connection is encrypted. A paired desktop stays paired until you remove it here.
          </p>
        </template>
        <p v-else class="remote-access__secure-warning" role="alert" data-testid="peer-hosting-listener-error">
          {{ state.listener.error || "Not listening." }}
        </p>
      </section>

      <section v-if="cards.length" class="peer-hosting__section" data-testid="peer-hosting-pending">
        <p class="peer-hosting__title">Pairing requests</p>
        <article v-for="card in cards" :key="card.entry.pairingId" class="peer-card" data-testid="peer-pairing-card">
          <header class="peer-card__header">
            <strong>{{ card.entry.name }}</strong>
            <span class="peer-card__meta"
              >{{ card.entry.platform }} · {{ card.entry.address }} · v{{ card.entry.appVersion }} ·
              {{ formatAge(card.entry.createdAt) }}</span
            >
          </header>
          <p v-if="versionDiffers(card.entry)" class="peer-card__hint" data-testid="peer-version-hint">
            This desktop runs a different version ({{ card.entry.appVersion }}, this one {{ localVersion }}). Both
            desktops must run the same version to connect.
          </p>

          <template v-if="card.outcome === 'sas-mismatch'">
            <p class="peer-card__error" role="alert" data-testid="peer-outcome-mismatch">
              The code did not match. This request is used up; the other desktop has to start the pairing again.
            </p>
            <div class="peer-card__actions">
              <button type="button" class="button button--ghost" @click="dismissOutcome(card.entry.pairingId)">
                Dismiss
              </button>
            </div>
          </template>
          <template v-else-if="card.outcome === 'not-found'">
            <p class="peer-card__error" role="alert" data-testid="peer-outcome-not-found">
              This request is no longer available.
            </p>
            <div class="peer-card__actions">
              <button type="button" class="button button--ghost" @click="dismissOutcome(card.entry.pairingId)">
                Dismiss
              </button>
            </div>
          </template>
          <template v-else-if="card.entry.sasReady">
            <p class="peer-card__hint">
              The other desktop is showing an 8-digit code. Type it here. Only someone at that desktop can give you the
              right one.
            </p>
            <div class="peer-card__code">
              <input
                :value="codes[card.entry.pairingId] || ''"
                class="settings-input peer-card__input"
                data-testid="peer-code-input"
                type="text"
                inputmode="numeric"
                autocomplete="off"
                spellcheck="false"
                aria-label="8-digit code shown on the other desktop"
                :disabled="rowBusy(card.entry.pairingId)"
                @input="onCodeInput(card.entry.pairingId, $event)"
                @keyup.enter="approve(card.entry)"
              />
              <span class="peer-card__slots" aria-hidden="true">{{ slotGuide(card.entry.pairingId) }}</span>
            </div>
            <div class="peer-card__actions">
              <button
                type="button"
                class="button button--primary"
                :class="{ 'button--pending': rowAction(card.entry.pairingId) === 'approve' }"
                :aria-busy="rowAction(card.entry.pairingId) === 'approve' ? 'true' : undefined"
                data-testid="peer-approve"
                :disabled="rowBusy(card.entry.pairingId) || digitCount(card.entry.pairingId) !== PEER_SAS_DIGITS"
                @click="approve(card.entry)"
              >
                Approve
              </button>
              <button
                type="button"
                class="button button--danger"
                :class="{ 'button--pending': rowAction(card.entry.pairingId) === 'reject' }"
                :aria-busy="rowAction(card.entry.pairingId) === 'reject' ? 'true' : undefined"
                data-testid="peer-reject"
                :disabled="rowBusy(card.entry.pairingId)"
                @click="reject(card.entry)"
              >
                Reject
              </button>
            </div>
          </template>
          <template v-else>
            <div class="peer-hosting__wait">
              <Spinner size="sm" aria-hidden="true" />
              <p class="peer-hosting__muted" role="status" data-testid="peer-waiting">Waiting for the other desktop…</p>
            </div>
            <div class="peer-card__actions">
              <button
                type="button"
                class="button button--danger"
                :class="{ 'button--pending': rowAction(card.entry.pairingId) === 'reject' }"
                :aria-busy="rowAction(card.entry.pairingId) === 'reject' ? 'true' : undefined"
                data-testid="peer-reject"
                :disabled="rowBusy(card.entry.pairingId)"
                @click="reject(card.entry)"
              >
                Reject
              </button>
            </div>
          </template>
        </article>
      </section>

      <section class="peer-hosting__section" data-testid="peer-hosting-devices">
        <p class="peer-hosting__title">Paired desktops</p>
        <p v-if="!state.devices.length" class="peer-hosting__muted">No desktops paired yet.</p>
        <article v-for="device in state.devices" :key="device.id" class="peer-card" data-testid="peer-device">
          <header class="peer-card__header">
            <strong>{{ device.name }}</strong>
            <span class="peer-card__meta"
              >{{ device.platform }} · last seen {{ formatLastSeen(device.lastSeenAt) }}
              <template v-if="device.lastAddress">· {{ device.lastAddress }}</template></span
            >
            <form
              v-if="renamingId === device.id"
              class="peer-card__rename"
              data-testid="peer-rename-form"
              @submit.prevent="saveRename(device)"
            >
              <input
                v-model="renameValue"
                class="settings-input"
                data-testid="peer-rename-input"
                type="text"
                maxlength="64"
                autocomplete="off"
                aria-label="Name of this desktop"
              />
              <button
                type="submit"
                class="button button--primary"
                :class="{ 'button--pending': rowAction(device.id) === 'rename' }"
                :aria-busy="rowAction(device.id) === 'rename' ? 'true' : undefined"
                data-testid="peer-rename-save"
                :disabled="rowBusy(device.id) || !renameValue.trim()"
              >
                Save
              </button>
              <button type="button" class="button button--ghost" @click="renamingId = null">Cancel</button>
            </form>
            <button
              v-else
              type="button"
              class="button button--ghost peer-card__remove"
              data-testid="peer-rename"
              :disabled="rowBusy(device.id)"
              title="Change the name this computer shows for the paired desktop. The other desktop is not told."
              @click="startRename(device)"
            >
              Rename
            </button>
            <button
              type="button"
              class="button button--ghost peer-card__remove"
              :class="{ 'button--pending': rowAction(device.id) === 'remove' }"
              :aria-busy="rowAction(device.id) === 'remove' ? 'true' : undefined"
              data-testid="peer-remove"
              :disabled="rowBusy(device.id)"
              @click="removeDevice(device)"
            >
              Remove
            </button>
          </header>
        </article>
      </section>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { apiKey } from "../../types/keys.js";
import type { Transport } from "../../transport.js";
import Spinner from "../common/Spinner.vue";
import { detectDesktopOs } from "../../lib/desktop-os.js";
import PeerFirewallHelp from "./PeerFirewallHelp.vue";
import { useAppStore } from "../../stores/app.js";
import { useNotificationStore } from "../../stores/notifications.js";
import {
  PEER_DEFAULT_PORT,
  PEER_SAS_DIGITS,
  type PeerDeviceRecord,
  type PeerHostState,
  type PeerPendingPairing,
} from "../../../electron/shared/peers.js";

type Outcome = "sas-mismatch" | "not-found";

const api = inject<Transport>(apiKey);
const app = useAppStore();
const notifications = useNotificationStore();

const state = ref<PeerHostState | null>(null);
const loadFailed = ref(false);
const busyAction = ref<"toggle" | "port" | null>(null);
const busy = computed(() => busyAction.value !== null);
const portDraft = ref(String(PEER_DEFAULT_PORT));
const codes = reactive<Record<string, string>>({});
const rowBusyIds = reactive<Record<string, "approve" | "reject" | "remove" | "rename">>({});
const renamingId = ref<string | null>(null);
const renameValue = ref("");
const outcomes = reactive<Record<string, { outcome: Outcome; entry: PeerPendingPairing }>>({});
const now = ref(Date.now());

const localVersion = computed(() => app.payload?.meta?.appVersion || "");

const portNumber = computed(() => {
  const text = portDraft.value.trim();
  return /^\d{1,5}$/.test(text) ? Number(text) : NaN;
});
const portValid = computed(
  () => Number.isInteger(portNumber.value) && portNumber.value >= 1 && portNumber.value <= 65535,
);
const localOs = detectDesktopOs();
const firewallPort = computed(() => state.value?.hosting.port ?? PEER_DEFAULT_PORT);
const portUnchanged = computed(() => !!state.value && portNumber.value === state.value.hosting.port);
const toggleDisabled = computed(() => {
  if (busy.value || !state.value) return true;
  if (state.value.hosting.enabled) return false;
  return !state.value.encryptionAvailable || !portValid.value;
});

const cards = computed(() => {
  const live = (state.value?.pending ?? []).map((entry) => ({
    entry,
    outcome: outcomes[entry.pairingId]?.outcome ?? null,
  }));
  const liveIds = new Set(live.map((card) => card.entry.pairingId));
  const settled = Object.values(outcomes)
    .filter((item) => !liveIds.has(item.entry.pairingId))
    .map((item) => ({ entry: item.entry, outcome: item.outcome as Outcome | null }));
  return [...live, ...settled];
});

function applyState(next: PeerHostState, syncDraft = false): void {
  if (syncDraft || !state.value || portDraft.value === String(state.value.hosting.port)) {
    portDraft.value = String(next.hosting.port);
  }
  state.value = next;
  now.value = Date.now();
  const ids = new Set(next.pending.map((entry) => entry.pairingId));
  for (const id of Object.keys(codes)) if (!ids.has(id)) delete codes[id];
}

async function refresh(): Promise<void> {
  const load = api?.getPeerHostState;
  if (!load) return;
  const loaded = await notifications.runWithToast("Could not load desktop hosting", async () => {
    applyState(await load());
  });
  loadFailed.value = !loaded && !state.value;
}

async function retryLoad(): Promise<void> {
  loadFailed.value = false;
  await refresh();
}

async function change(
  next: { enabled: boolean; port: number },
  title: string,
  action: "toggle" | "port",
): Promise<void> {
  const call = api?.setPeerHosting;
  if (!call || busy.value) return;
  busyAction.value = action;
  try {
    await notifications.runWithToast(title, async () => {
      applyState(await call(next), true);
    });
  } finally {
    busyAction.value = null;
  }
}

async function onToggle(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const enabled = input.checked;
  const port = enabled ? portNumber.value : (state.value?.hosting.port ?? PEER_DEFAULT_PORT);
  await change({ enabled, port }, enabled ? "Could not turn hosting on" : "Could not turn hosting off", "toggle");
  input.checked = state.value?.hosting.enabled ?? false;
}

async function applyPort(): Promise<void> {
  if (!portValid.value || portUnchanged.value || !state.value) return;
  await change({ enabled: state.value.hosting.enabled, port: portNumber.value }, "Could not change the port", "port");
}

function copyAddress(address: string): void {
  void app.copyText(`${address}:${state.value?.listener.port ?? ""}`);
}

function rowBusy(id: string): boolean {
  return rowBusyIds[id] !== undefined;
}

function rowAction(id: string): "approve" | "reject" | "remove" | "rename" | undefined {
  return rowBusyIds[id];
}

async function withRow(
  id: string,
  action: "approve" | "reject" | "remove" | "rename",
  fn: () => Promise<void>,
  title: string,
): Promise<void> {
  if (rowBusyIds[id]) return;
  rowBusyIds[id] = action;
  try {
    await notifications.runWithToast(title, fn);
  } finally {
    delete rowBusyIds[id];
  }
}

function digitCount(id: string): number {
  return (codes[id] || "").replace(/\D/g, "").length;
}

function slotGuide(id: string): string {
  const slots = " ".repeat(digitCount(id)).padEnd(PEER_SAS_DIGITS, "_");
  return `${slots.slice(0, 4)} ${slots.slice(4)}`;
}

function onCodeInput(id: string, event: Event): void {
  const input = event.target as HTMLInputElement;
  const digits = input.value.replace(/\D/g, "").slice(0, PEER_SAS_DIGITS);
  const formatted = digits.length > 4 ? `${digits.slice(0, 4)} ${digits.slice(4)}` : digits;
  codes[id] = formatted;
  input.value = formatted;
}

async function approve(entry: PeerPendingPairing): Promise<void> {
  const call = api?.approvePeerPairing;
  const id = entry.pairingId;
  if (!call || digitCount(id) !== PEER_SAS_DIGITS) return;
  const code = codes[id].replace(/\D/g, "");
  await withRow(
    id,
    "approve",
    async () => {
      try {
        const result = await call({ pairingId: id, code });
        if (result === "approved") {
          notifications.pushEphemeralToast({
            title: "Desktop paired",
            body: `${entry.name} can now attach profiles of this desktop.`,
          });
        } else {
          outcomes[id] = { outcome: result, entry };
        }
      } finally {
        delete codes[id];
      }
      await reload();
    },
    "Could not approve the pairing",
  );
}

async function reject(entry: PeerPendingPairing): Promise<void> {
  const call = api?.rejectPeerPairing;
  if (!call) return;
  await withRow(
    entry.pairingId,
    "reject",
    async () => {
      await call(entry.pairingId);
      delete codes[entry.pairingId];
      await reload();
    },
    "Could not reject the pairing",
  );
}

async function removeDevice(device: PeerDeviceRecord): Promise<void> {
  const call = api?.removePeerDevice;
  if (!call || rowBusy(device.id)) return;
  const confirmed = await app.confirmInApp({
    title: "Remove paired desktop?",
    message: `${device.name} will be disconnected at once and has to be paired again.`,
    confirmLabel: "Remove",
    danger: true,
  });
  if (!confirmed) return;
  await withRow(
    device.id,
    "remove",
    async () => {
      await call(device.id);
      await reload();
    },
    "Could not remove the desktop",
  );
}

function startRename(device: PeerDeviceRecord): void {
  renameValue.value = device.name;
  renamingId.value = device.id;
}

async function saveRename(device: PeerDeviceRecord): Promise<void> {
  const call = api?.renamePeerDevice;
  const name = renameValue.value.trim();
  if (!call || !name || rowBusy(device.id)) return;
  await withRow(
    device.id,
    "rename",
    async () => {
      await call({ deviceId: device.id, name });
      renamingId.value = null;
      await reload();
    },
    "Could not rename the desktop",
  );
}

function dismissOutcome(id: string): void {
  delete outcomes[id];
}

async function reload(): Promise<void> {
  const load = api?.getPeerHostState;
  if (!load) return;
  applyState(await load());
}

function versionDiffers(entry: PeerPendingPairing): boolean {
  return !!localVersion.value && entry.appVersion !== localVersion.value;
}

function formatAge(ts: number): string {
  const seconds = Math.max(0, Math.round((now.value - ts) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.round(minutes / 60)} h ago`;
}

function formatLastSeen(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return "never";
  const seconds = Math.max(0, Math.round((now.value - ts) / 1000));
  if (seconds < 45) return "just now";
  const relative = new Intl.RelativeTimeFormat("en", { numeric: "always" });
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return relative.format(-minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 24) return relative.format(-hours, "hour");
  const days = Math.round(hours / 24);
  if (days < 14) return relative.format(-days, "day");
  const weeks = Math.round(days / 7);
  if (weeks < 8) return relative.format(-weeks, "week");
  const months = Math.round(days / 30);
  if (months < 12) return relative.format(-months, "month");
  return relative.format(-Math.round(days / 365), "year");
}

const unsubscribers: Array<() => void> = [];
onMounted(() => {
  void refresh();
  for (const subscribe of [api?.onPeersUpdated, api?.onPeerPairingProgress]) {
    if (subscribe) unsubscribers.push(subscribe(() => void refresh()));
  }
});
onBeforeUnmount(() => {
  for (const off of unsubscribers.splice(0)) off();
});
</script>

<style scoped>
.peer-hosting {
  display: grid;
  align-content: start;
  gap: 12px;
  min-width: 0;
}
.peer-hosting__section {
  display: grid;
  gap: 8px;
  min-width: 0;
}
.peer-hosting__help {
  margin-top: 8px;
  font-size: 12.5px;
}
.peer-hosting__help summary {
  cursor: pointer;
}
.peer-hosting__help[open] summary {
  margin-bottom: 6px;
}
.peer-hosting__title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
}
.peer-hosting__muted {
  margin: 0;
  color: var(--muted);
  font-size: 12px;
}
.peer-hosting__wait {
  display: flex;
  align-items: center;
  gap: 8px;
}
.peer-hosting__port .remote-access__field {
  max-width: 260px;
}
.remote-access__secure-warning {
  margin: 0;
  padding: 10px 12px;
  border: 1px solid #d97706;
  border-radius: 6px;
  background: rgba(217, 119, 6, 0.12);
  font-size: 12.5px;
  line-height: 1.5;
}
.peer-card {
  display: grid;
  gap: 6px;
  min-width: 0;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 9px;
  background: var(--bg);
}
.peer-card__header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
  min-width: 0;
}
.peer-card__header strong {
  overflow-wrap: anywhere;
}
.peer-card__meta {
  flex: 1 1 auto;
  min-width: 0;
  color: var(--muted);
  font-size: 12px;
}
.peer-card__rename {
  display: flex;
  flex: 1 1 100%;
  flex-wrap: wrap;
  gap: 6px;
}
.peer-card__rename .settings-input {
  flex: 1 1 160px;
  min-width: 0;
}
.peer-card__remove {
  flex: 0 0 auto;
}
.peer-card__hint {
  margin: 0;
  font-size: 12px;
  color: var(--muted);
  line-height: 1.5;
}
.peer-card__error {
  margin: 0;
  font-size: 12px;
  color: var(--danger, #c0392b);
  line-height: 1.5;
}
.peer-card__code {
  position: relative;
  font-family: var(--font-mono, monospace);
  font-size: 22px;
  line-height: 1.4;
  letter-spacing: 0.14em;
  width: calc(9ch + 9 * 0.14em + 26px);
  max-width: 100%;
}
.peer-card__input {
  font: inherit;
  letter-spacing: inherit;
  width: 100%;
  padding: 8px 10px;
  box-sizing: border-box;
}
.peer-card__slots {
  position: absolute;
  inset-inline-start: 11px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--muted);
  white-space: pre;
  pointer-events: none;
  user-select: none;
}
.peer-card__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
</style>
