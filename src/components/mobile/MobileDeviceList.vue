<template>
  <div class="mobile-device-list" data-role="mobile-device-list">
    <p v-if="app.isRemoteTransport" class="mobile-device-list__empty">
      Phone management is available in Settings on the desktop app.
    </p>
    <template v-else>
      <p v-if="errors._list" class="device-item__test-result" role="alert">{{ errors._list }}</p>
      <p v-if="devices.length === 0" class="mobile-device-list__empty">No phones paired yet.</p>
      <article
        v-for="device in devices"
        :key="device.deviceId"
        class="device-item mobile-device-card"
        :class="{ 'device-item--revoked': device.revoked, 'mobile-device-card--revoked': device.revoked }"
      >
        <header class="mobile-device-card__header">
          <template v-if="renamingId === device.deviceId">
            <input
              v-model="renameDraft"
              class="settings-input"
              maxlength="60"
              aria-label="Phone name"
              @keyup.enter="rename(device)"
            />
            <button class="button button--ghost" type="button" @click="rename(device)">Save</button>
            <button class="button button--ghost" type="button" @click="renamingId = null">Cancel</button>
          </template>
          <template v-else>
            <strong>{{ device.label }}</strong>
            <span
              class="mobile-device-card__badge"
              :class="device.revoked ? 'badge--off' : device.state === 'active' ? 'badge--ok' : 'badge--pending'"
            >
              {{ device.revoked ? "revoked" : device.state === "active" ? "Paired" : pendingLabel(device.state) }}
            </span>
            <button
              v-if="!device.revoked"
              class="button button--ghost"
              type="button"
              :disabled="paused"
              @click="
                renamingId = device.deviceId;
                renameDraft = device.label;
              "
            >
              Rename
            </button>
            <button
              v-if="!device.revoked && device.state !== 'active'"
              class="button button--ghost"
              type="button"
              :disabled="paused"
              @click="reviewPairing(device)"
            >
              Review pairing
            </button>
          </template>
          <button
            v-if="device.revoked"
            class="device-item__forget"
            type="button"
            :disabled="paused"
            @click="forget(device)"
          >
            ×
          </button>
        </header>
        <div class="mobile-device-card__meta">
          <span>{{ device.platform }}</span>
          <details>
            <summary>Security fingerprint</summary>
            <code>{{ device.fingerprint }}</code>
          </details>
          <span v-if="device.revoked" class="device-item__paused">Revoked</span>
          <span v-else-if="device.remoteUiPaused" class="device-item__paused">Device paused</span>
          <span
            v-else-if="isForegroundRecent(device.deviceId)"
            class="device-item__connected"
            title="The remote screen reported activity within the last 90 seconds."
            >Remote UI recently active</span
          >
          <span
            v-else-if="remoteUiConnected(device.deviceId)"
            class="device-item__connected"
            title="This phone has a live connection to the desktop."
            >Remote UI connected</span
          >
          <span
            v-else-if="connectedSince(device.deviceId) !== null"
            class="device-item__connected"
            :title="'Remote session started ' + formatTimestamp(connectedSince(device.deviceId)!)"
            >Session active</span
          >
          <span v-else :title="'Last seen: ' + formatTimestamp(device.lastSeenAt)"
            >last seen {{ formatTimestamp(device.lastSeenAt) }}</span
          >
          <span :title="profileAccessTitle"
            >profiles: all, except {{ (device.excludedProfileIds || []).map(profileLabel).join(", ") || "none" }}</span
          >
          <span :title="'Capabilities granted to this device: ' + device.capabilities.join(', ')"
            >capabilities: {{ device.capabilities.map(capabilityLabel).join(", ") || "none" }}</span
          >
        </div>
        <div v-if="!device.revoked" class="mobile-device-card__actions">
          <button
            v-if="device.state === 'active'"
            class="button button--ghost"
            type="button"
            :disabled="paused || busyId === device.deviceId"
            @click="setPaused(device)"
          >
            {{ device.remoteUiPaused ? "Resume device" : "Pause device" }}
          </button>
          <button class="button button--ghost" type="button" :disabled="paused" @click="toggleAccess(device)">
            {{ editingId === device.deviceId ? "Close access" : "Edit access" }}
          </button>
          <button
            v-if="device.state === 'active'"
            class="button button--ghost"
            type="button"
            :disabled="paused || device.remoteUiPaused || testBusyId === device.deviceId"
            @click="sendTest(device)"
          >
            {{ testBusyId === device.deviceId ? "Sending…" : "Send test push" }}
          </button>
          <button class="button button--ghost button--danger" type="button" @click="revoke(device)">Revoke</button>
        </div>
        <p v-if="result[device.deviceId]" class="device-item__test-result" role="status">
          {{ result[device.deviceId] }}
        </p>
        <p v-if="errors[device.deviceId]" class="device-item__test-result" role="alert">
          {{ errors[device.deviceId] }}
        </p>
        <fieldset
          v-if="editingId === device.deviceId"
          class="mobile-device-card__access device-item__allowlist-form"
          :disabled="paused || saving"
        >
          <p>Profiles excluded from this phone</p>
          <div class="pairing-picker">
            <label v-for="profile in profiles" :key="profile.id"
              ><input v-model="draft.excludedProfileIds" type="checkbox" :value="profile.id" />
              {{ profile.name }}</label
            >
          </div>
          <p>What it may do</p>
          <div class="pairing-picker">
            <label v-for="cap in capabilities" :key="cap.id"
              ><input v-model="draft.capabilities" type="checkbox" :value="cap.id" /> {{ cap.label }}</label
            >
          </div>
          <button class="button" type="button" :disabled="saving" @click="saveAccess(device)">Save access</button>
          <p v-if="accessError" role="alert">{{ accessError }}</p>
        </fieldset>
      </article>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { useAppStore } from "../../stores/app.js";
import { mobileErrorCopy, mobileResultReasonCopy } from "../dialogs/settings/mobile-error-copy.js";
import { MOBILE_FOREGROUND_PRESENCE_FRESH_MS } from "../../../electron/shared/mobile-session-events.js";
import type { MobileCapability } from "../../../electron/shared/types/state.js";

interface Profile {
  id: string;
  name: string;
  color?: string;
}
interface Device {
  deviceId: string;
  label: string;
  platform: string;
  fingerprint: string;
  state: string;
  revoked: boolean;
  remoteUiPaused: boolean;
  lastSeenAt: number;
  capabilities: MobileCapability[];
  profileAllowlist: string[];
  excludedProfileIds?: string[];
}
const props = withDefaults(defineProps<{ profiles?: Profile[]; refreshOnMount?: boolean }>(), {
  profiles: () => [],
  refreshOnMount: true,
});
const app = useAppStore();
const devices = computed(() => app.mobileDevices as unknown as Device[]);
const paused = computed(() => app.payload?.appState?.settings?.remoteAccess?.paused === true);
const profiles = computed(() =>
  props.profiles.length
    ? props.profiles
    : (app.payload?.appState?.profiles || []).map(({ id, name, color }) => ({ id, name, color })),
);
const now = ref(Date.now());
let freshnessTimer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  if (props.refreshOnMount && !app.isRemoteTransport)
    void app.refreshMobileDevices().catch((error) => {
      errors._list = mobileErrorCopy(error, "review");
    });
  freshnessTimer = setInterval(() => {
    now.value = Date.now();
  }, 15_000);
});
onBeforeUnmount(() => {
  if (freshnessTimer) clearInterval(freshnessTimer);
});
const renamingId = ref<string | null>(null);
const renameDraft = ref("");
const editingId = ref<string | null>(null);
const saving = ref(false);
const accessError = ref("");
const busyId = ref<string | null>(null);
const testBusyId = ref<string | null>(null);
const result = reactive<Record<string, string>>({});
const errors = reactive<Record<string, string>>({});
const draft = reactive<{ capabilities: MobileCapability[]; excludedProfileIds: string[] }>({
  capabilities: [],
  excludedProfileIds: [],
});
const capabilities = [
  { id: "notifications", label: "Receive notifications" },
  { id: "review.start", label: "Start PR reviews" },
  { id: "status.read", label: "Read status" },
  { id: "task.control", label: "Control tasks" },
  { id: "task.destructive", label: "Stop and reset tasks" },
  { id: "remote.request", label: "Request remote access" },
  { id: "remote.webSession", label: "Open the remote UI" },
];
const profileAccessTitle =
  "This phone can use every profile except the ones listed, and new profiles are included automatically. Inside a profile it has that profile's terminals — a shell on this computer under your account — and files, so excluding a profile keeps the phone out of it in the app, not at the operating-system level.";
function sessionFor(id: string) {
  return app.mobileConnectedDevices.find((entry) => entry.deviceId === id);
}
function connectedSince(id: string): number | null {
  return sessionFor(id)?.startedAt ?? null;
}
function remoteUiConnected(id: string): boolean {
  return sessionFor(id)?.remoteUiConnected === true;
}
function formatTimestamp(ts: number): string {
  return ts ? new Date(ts).toLocaleString() : "never";
}
function profileLabel(id: string): string {
  return profiles.value.find((profile) => profile.id === id)?.name || id;
}
function capabilityLabel(id: string): string {
  return capabilities.find((cap) => cap.id === id)?.label || id;
}
function pendingLabel(state: string): string {
  return state === "claimed"
    ? "proving key"
    : state === "keyProven"
      ? "awaiting your confirmation"
      : state === "userApproved"
        ? "activating"
        : state;
}
function isForegroundRecent(id: string): boolean {
  void now.value;
  const stamp = sessionFor(id)?.lastForegroundAt;
  return remoteUiConnected(id) && typeof stamp === "number" && now.value - stamp <= MOBILE_FOREGROUND_PRESENCE_FRESH_MS;
}
async function reviewPairing(device: Device): Promise<void> {
  try {
    await app.refreshMobileDevicesAwaitingApproval(device.deviceId);
    if (app.mobilePairingSas?.deviceId !== device.deviceId) {
      errors[device.deviceId] = "The pairing code for this phone is no longer available. Start pairing again.";
      return;
    }
    app.openSettingsDialog({ initialTab: "mobile", initialMobileView: "phones" });
  } catch (error) {
    errors[device.deviceId] = mobileErrorCopy(error, "review");
  }
}
async function forget(device: Device): Promise<void> {
  try {
    const response = await app.forgetMobileDevice(device.deviceId);
    if (!response.ok) errors[device.deviceId] = mobileResultReasonCopy(response.reason, "forget");
  } catch (error) {
    errors[device.deviceId] = mobileErrorCopy(error, "forget");
  }
}
async function rename(device: Device): Promise<void> {
  const label = renameDraft.value.trim();
  if (!label) return;
  try {
    await app.renameMobileDevice(device.deviceId, label);
    renamingId.value = null;
  } catch {
    errors[device.deviceId] = "Could not rename this phone. Please try again.";
  }
}
function toggleAccess(device: Device): void {
  if (editingId.value === device.deviceId) {
    editingId.value = null;
    return;
  }
  draft.capabilities = [...device.capabilities];
  draft.excludedProfileIds = [...(device.excludedProfileIds || [])];
  accessError.value = "";
  editingId.value = device.deviceId;
}
async function saveAccess(device: Device): Promise<void> {
  saving.value = true;
  accessError.value = "";
  try {
    await app.updateMobileDeviceAllowlist(device.deviceId, {
      capabilities: [...draft.capabilities],
      excludedProfileIds: [...draft.excludedProfileIds],
    });
    editingId.value = null;
  } catch {
    accessError.value = "Could not synchronize access with the phone. Please try again.";
  } finally {
    saving.value = false;
  }
}
async function setPaused(device: Device): Promise<void> {
  busyId.value = device.deviceId;
  delete errors[device.deviceId];
  try {
    await app.setMobileDeviceRemoteUiPaused(device.deviceId, !device.remoteUiPaused);
  } catch (error) {
    errors[device.deviceId] = mobileErrorCopy(error, "relay");
  } finally {
    busyId.value = null;
  }
}
async function sendTest(device: Device): Promise<void> {
  testBusyId.value = device.deviceId;
  try {
    const response = await app.sendMobileTestPush(device.deviceId);
    result[device.deviceId] = response?.ok ? "Test push sent." : mobileResultReasonCopy(response?.reason, "test-push");
  } catch (error) {
    errors[device.deviceId] = mobileErrorCopy(error, "test-push");
  } finally {
    testBusyId.value = null;
  }
}
async function revoke(device: Device): Promise<void> {
  const confirmed = await app.confirmInApp({
    title: "Revoke mobile device?",
    message: `"${device.label}" will immediately lose push notifications and remote access. This cannot be undone — the phone must be re-paired.`,
    confirmLabel: "Revoke",
    danger: true,
  });
  if (!confirmed) return;
  try {
    await app.revokeMobileDevice(device.deviceId);
    delete errors[device.deviceId];
  } catch (error) {
    errors[device.deviceId] = mobileErrorCopy(error, "revoke");
  }
}
</script>

<style scoped>
.mobile-device-list {
  display: grid;
  gap: 10px;
  min-width: 0;
}
.mobile-device-list__empty {
  color: var(--text-secondary);
}
.mobile-device-card {
  min-width: 0;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 10px;
  background: var(--bg-secondary);
}
.mobile-device-card__header,
.mobile-device-card__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.mobile-device-card__header strong {
  overflow-wrap: anywhere;
  margin-right: auto;
}
.mobile-device-card__badge {
  border-radius: 10px;
  padding: 2px 7px;
  font-size: 11px;
}
.mobile-device-card__badge.badge--ok {
  color: #0c6;
  background: rgba(0, 200, 100, 0.15);
}
.mobile-device-card__badge.badge--pending {
  color: #b07a00;
  background: rgba(255, 180, 0, 0.18);
}
.mobile-device-card__badge.badge--off {
  color: var(--muted);
  background: rgba(255, 255, 255, 0.06);
}
.mobile-device-card__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 5px 10px;
  margin: 8px 0;
  font-size: 12px;
  overflow-wrap: anywhere;
}
.mobile-device-card__meta code {
  overflow-wrap: anywhere;
}
.mobile-device-card__actions button {
  max-width: 100%;
  white-space: normal;
}
.mobile-device-card__access {
  display: grid;
  gap: 7px;
  min-width: 0;
  margin-top: 10px;
}
.mobile-device-card__access label {
  overflow-wrap: anywhere;
}
.mobile-device-card__access .pairing-picker {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 12px;
}
.mobile-device-card__access p {
  margin: 6px 0 0;
  font-weight: 600;
}
.device-item__connected {
  color: var(--success-fg, var(--success));
  font-weight: 600;
}
.device-item__paused {
  color: var(--warning-fg, var(--warning));
  font-weight: 600;
}
.device-item__test-result {
  margin: 7px 0 0;
  color: var(--text-secondary);
  font-size: 12px;
}
.device-item__forget {
  margin-left: auto;
  background: none;
  border: 0;
  color: var(--muted);
  cursor: pointer;
}
</style>
