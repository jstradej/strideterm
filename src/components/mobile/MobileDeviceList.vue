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
        :class="{ 'mobile-device-card--revoked': device.revoked }"
      >
        <header class="mobile-device-card__header">
          <div class="mobile-device-card__title-group">
            <strong :class="{ 'mobile-device-card__label--revoked': device.revoked }">{{ device.label }}</strong>
            <span
              class="mobile-device-card__badge"
              :class="device.revoked ? 'badge--off' : device.state === 'active' ? 'badge--ok' : 'badge--pending'"
            >
              {{ device.revoked ? "Revoked" : device.state === "active" ? "Paired" : pendingLabel(device.state) }}
            </span>
            <span
              v-if="device.revoked && pendingAction(device, 'revoke')"
              class="mobile-device-card__pending-status"
              role="status"
            >
              <span class="mobile-device-card__spinner" aria-hidden="true"></span>
              Revoking…
            </span>
          </div>
          <div v-if="!device.revoked" class="mobile-device-card__header-actions">
            <template v-if="renamingId === device.deviceId">
              <input
                v-model="renameDraft"
                class="settings-input"
                maxlength="60"
                :disabled="isBusy(device)"
                aria-label="Phone name"
                @keyup.enter="rename(device)"
              />
              <button class="button button--ghost" type="button" :disabled="isBusy(device)" @click="rename(device)">
                <span
                  v-if="pendingAction(device, 'rename')"
                  class="mobile-device-card__spinner"
                  aria-hidden="true"
                ></span>
                {{ pendingAction(device, "rename") ? "Saving…" : "Save" }}
              </button>
              <button class="button button--ghost" type="button" :disabled="isBusy(device)" @click="renamingId = null">
                Cancel
              </button>
            </template>
            <template v-else>
              <button
                class="button button--ghost"
                type="button"
                :disabled="paused || isBusy(device)"
                @click="
                  renamingId = device.deviceId;
                  renameDraft = device.label;
                "
              >
                Rename
              </button>
              <button
                v-if="device.state !== 'active'"
                class="button button--ghost"
                type="button"
                :disabled="paused || isBusy(device)"
                @click="reviewPairing(device)"
              >
                <span
                  v-if="pendingAction(device, 'review')"
                  class="mobile-device-card__spinner"
                  aria-hidden="true"
                ></span>
                {{ pendingAction(device, "review") ? "Loading…" : "Review pairing" }}
              </button>
            </template>
          </div>
          <button
            v-if="device.revoked"
            class="device-item__forget"
            type="button"
            :disabled="paused || isBusy(device)"
            @click="forget(device)"
          >
            <span v-if="pendingAction(device, 'forget')" class="mobile-device-card__spinner" aria-hidden="true"></span>
            <span v-else aria-hidden="true">×</span>
            <span class="sr-only">{{ pendingAction(device, "forget") ? "Forgetting phone" : "Forget phone" }}</span>
          </button>
        </header>
        <div v-if="!device.revoked" class="mobile-device-card__meta">
          <span class="mobile-device-card__platform">{{ device.platform }}</span>
          <span v-if="device.remoteUiPaused" class="device-item__paused">Device paused</span>
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
            >last seen {{ formatLastSeen(device.lastSeenAt) }}</span
          >
        </div>
        <details v-if="!device.revoked" class="mobile-device-card__details">
          <summary>Access and security details</summary>
          <div class="mobile-device-card__details-content">
            <span :title="profileAccessTitle"
              >Profiles: all, except
              {{ (device.excludedProfileIds || []).map(profileLabel).join(", ") || "none" }}</span
            >
            <span :title="'Capabilities granted to this device: ' + device.capabilities.join(', ')"
              >Capabilities: {{ device.capabilities.map(capabilityLabel).join(", ") || "none" }}</span
            >
            <span>Platform: {{ device.platform }}</span>
            <span
              >Fingerprint: <code>{{ device.fingerprint }}</code></span
            >
          </div>
        </details>
        <div v-if="!device.revoked" class="mobile-device-card__actions">
          <button
            v-if="device.state === 'active'"
            class="button button--ghost"
            :class="device.remoteUiPaused ? 'mobile-device-card__resume' : 'mobile-device-card__pause'"
            type="button"
            :disabled="paused || isBusy(device)"
            :aria-label="device.remoteUiPaused ? 'Resume remote UI for this phone' : 'Pause remote UI for this phone'"
            @click="setPaused(device)"
          >
            <span v-if="pendingAction(device, 'pause')" class="mobile-device-card__spinner" aria-hidden="true"></span>
            <svg v-else-if="device.remoteUiPaused" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
              <path d="M5 3.5v9l7-4.5z" />
            </svg>
            <svg v-else viewBox="0 0 16 16" aria-hidden="true" focusable="false">
              <path d="M4 3h3v10H4zM9 3h3v10H9z" />
            </svg>
            {{ pendingAction(device, "pause") ? "Updating…" : device.remoteUiPaused ? "Resume" : "Pause" }}
          </button>
          <button
            class="button button--ghost"
            type="button"
            :disabled="paused || isBusy(device)"
            @click="toggleAccess(device)"
          >
            {{ editingId === device.deviceId ? "Close access" : "Edit access" }}
          </button>
          <button
            v-if="device.state === 'active'"
            class="button button--ghost"
            type="button"
            :disabled="paused || device.remoteUiPaused || isBusy(device)"
            @click="sendTest(device)"
          >
            <span v-if="pendingAction(device, 'test')" class="mobile-device-card__spinner" aria-hidden="true"></span>
            {{ pendingAction(device, "test") ? "Sending…" : "Test push" }}
          </button>
          <button
            class="button button--ghost button--danger"
            type="button"
            :disabled="isBusy(device)"
            @click="revoke(device)"
          >
            <span v-if="pendingAction(device, 'revoke')" class="mobile-device-card__spinner" aria-hidden="true"></span>
            {{ pendingAction(device, "revoke") ? "Revoking…" : "Revoke" }}
          </button>
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
          :disabled="paused || isBusy(device)"
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
          <button class="button" type="button" :disabled="isBusy(device)" @click="saveAccess(device)">
            <span v-if="pendingAction(device, 'access')" class="mobile-device-card__spinner" aria-hidden="true"></span>
            {{ pendingAction(device, "access") ? "Saving…" : "Save access" }}
          </button>
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
const devices = computed(() =>
  [...(app.mobileDevices as unknown as Device[])].sort((a, b) => Number(a.revoked) - Number(b.revoked)),
);
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
const accessError = ref("");
const pending = reactive<Record<string, string>>({});
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
  if (!Number.isFinite(ts) || ts <= 0) return "never";
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? "never" : date.toLocaleString();
}
function formatLastSeen(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return "never";
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "never";
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
function pendingAction(device: Device, action: string): boolean {
  return pending[device.deviceId] === action || (action === "revoke" && pending[device.deviceId] === "revoke-confirm");
}
function isBusy(device: Device): boolean {
  return Boolean(pending[device.deviceId]);
}
function isForegroundRecent(id: string): boolean {
  void now.value;
  const stamp = sessionFor(id)?.lastForegroundAt;
  return remoteUiConnected(id) && typeof stamp === "number" && now.value - stamp <= MOBILE_FOREGROUND_PRESENCE_FRESH_MS;
}
async function reviewPairing(device: Device): Promise<void> {
  pending[device.deviceId] = "review";
  try {
    await app.refreshMobileDevicesAwaitingApproval(device.deviceId);
    if (app.mobilePairingSas?.deviceId !== device.deviceId) {
      errors[device.deviceId] = "The pairing code for this phone is no longer available. Start pairing again.";
      return;
    }
    app.openSettingsDialog({ initialTab: "mobile", initialMobileView: "phones" });
  } catch (error) {
    errors[device.deviceId] = mobileErrorCopy(error, "review");
  } finally {
    delete pending[device.deviceId];
  }
}
async function forget(device: Device): Promise<void> {
  pending[device.deviceId] = "forget";
  try {
    const response = await app.forgetMobileDevice(device.deviceId);
    if (!response.ok) errors[device.deviceId] = mobileResultReasonCopy(response.reason, "forget");
  } catch (error) {
    errors[device.deviceId] = mobileErrorCopy(error, "forget");
  } finally {
    delete pending[device.deviceId];
  }
}
async function rename(device: Device): Promise<void> {
  const label = renameDraft.value.trim();
  if (!label || isBusy(device)) return;
  pending[device.deviceId] = "rename";
  try {
    await app.renameMobileDevice(device.deviceId, label);
    renamingId.value = null;
  } catch {
    errors[device.deviceId] = "Could not rename this phone. Please try again.";
  } finally {
    delete pending[device.deviceId];
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
  if (isBusy(device)) return;
  pending[device.deviceId] = "access";
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
    delete pending[device.deviceId];
  }
}
async function setPaused(device: Device): Promise<void> {
  if (isBusy(device)) return;
  pending[device.deviceId] = "pause";
  delete errors[device.deviceId];
  try {
    await app.setMobileDeviceRemoteUiPaused(device.deviceId, !device.remoteUiPaused);
  } catch (error) {
    errors[device.deviceId] = mobileErrorCopy(error, "relay");
  } finally {
    delete pending[device.deviceId];
  }
}
async function sendTest(device: Device): Promise<void> {
  if (isBusy(device)) return;
  pending[device.deviceId] = "test";
  try {
    const response = await app.sendMobileTestPush(device.deviceId);
    result[device.deviceId] = response?.ok ? "Test push sent." : mobileResultReasonCopy(response?.reason, "test-push");
  } catch (error) {
    errors[device.deviceId] = mobileErrorCopy(error, "test-push");
  } finally {
    delete pending[device.deviceId];
  }
}
async function revoke(device: Device): Promise<void> {
  if (isBusy(device)) return;
  pending[device.deviceId] = "revoke-confirm";
  try {
    const confirmed = await app.confirmInApp({
      title: "Revoke mobile device?",
      message: `"${device.label}" will immediately lose push notifications and remote access. This cannot be undone — the phone must be re-paired.`,
      confirmLabel: "Revoke",
      danger: true,
    });
    if (!confirmed) return;
    pending[device.deviceId] = "revoke";
    await app.revokeMobileDevice(device.deviceId);
    delete errors[device.deviceId];
  } catch (error) {
    errors[device.deviceId] = mobileErrorCopy(error, "revoke");
  } finally {
    delete pending[device.deviceId];
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
  color: var(--muted);
}
.mobile-device-card {
  min-width: 0;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 9px;
  background: var(--bg);
}
.mobile-device-card__header,
.mobile-device-card__actions,
.mobile-device-card__title-group,
.mobile-device-card__header-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.mobile-device-card__header {
  flex-wrap: nowrap;
}
.mobile-device-card__title-group {
  flex: 1 1 auto;
  flex-wrap: wrap;
}
.mobile-device-card__header-actions {
  flex: 0 0 auto;
  justify-content: flex-end;
}
.mobile-device-card__actions {
  flex-wrap: wrap;
}
.mobile-device-card__title-group strong {
  min-width: 0;
  overflow-wrap: anywhere;
  flex: 0 1 auto;
}
.mobile-device-card__label--revoked {
  color: var(--muted);
  text-decoration: line-through;
}
.mobile-device-card__header .settings-input {
  width: 100%;
  min-width: 0;
}
.mobile-device-card__header button {
  flex: 0 0 auto;
  padding-inline: 6px;
  white-space: nowrap;
}
.mobile-device-card__badge {
  flex: 0 0 auto;
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
.mobile-device-card__pending-status {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--muted);
  font-size: 11px;
  white-space: nowrap;
}
.mobile-device-card__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 8px;
  margin: 6px 0;
  font-size: 12px;
  overflow-wrap: anywhere;
}
.mobile-device-card__platform {
  text-transform: capitalize;
  color: var(--muted);
}
.mobile-device-card__details {
  min-width: 0;
  color: var(--muted);
  font-size: 12px;
  margin-bottom: 6px;
}
.mobile-device-card__details summary {
  width: fit-content;
  cursor: pointer;
}
.mobile-device-card__details-content {
  display: grid;
  gap: 4px;
  min-width: 0;
  padding: 6px 0 2px;
  overflow-wrap: anywhere;
}
.mobile-device-card__meta code {
  overflow-wrap: anywhere;
}
.mobile-device-card__actions button {
  display: inline-flex;
  flex: 1 1 calc(50% - 6px);
  justify-content: center;
  align-items: center;
  gap: 6px;
  min-width: 0;
  max-width: 100%;
  white-space: nowrap;
  padding-inline: 6px;
}
.mobile-device-card__actions button svg {
  width: 14px;
  height: 14px;
  flex: 0 0 14px;
  fill: currentColor;
}
.mobile-device-card__actions .mobile-device-card__pause {
  color: var(--status-paused);
  border-color: var(--status-paused);
}
.mobile-device-card__actions .mobile-device-card__pause:hover:not(:disabled) {
  background: color-mix(in srgb, var(--status-paused) 12%, transparent);
}
.mobile-device-card__spinner {
  display: inline-block;
  width: 12px;
  height: 12px;
  flex: 0 0 12px;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: mobile-device-card-spin 0.7s linear infinite;
}
@keyframes mobile-device-card-spin {
  to {
    transform: rotate(360deg);
  }
}
.mobile-device-card--revoked {
  padding-block: 6px;
  opacity: 1;
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
  color: var(--status-paused);
  font-weight: 600;
}
.device-item__test-result {
  margin: 7px 0 0;
  color: var(--muted);
  font-size: 12px;
}
.device-item__forget {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  flex: 0 0 24px;
  background: none;
  border: 0;
  color: var(--muted);
  cursor: pointer;
}
.device-item__forget:disabled,
.mobile-device-card button:disabled {
  cursor: wait;
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
</style>
