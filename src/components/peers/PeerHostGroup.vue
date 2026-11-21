<template>
  <section class="peer-group" :data-host-id="host.id" data-testid="peer-host-group">
    <header class="peer-group__header">
      <button
        type="button"
        class="peer-group__toggle"
        data-testid="peer-group-toggle"
        :aria-expanded="!collapsed"
        :title="collapsed ? 'Show the profiles of this desktop' : 'Hide the profiles of this desktop'"
        @click="peers.setCollapsed(host.id, !collapsed)"
      >
        <span class="peer-group__chevron" aria-hidden="true">{{ collapsed ? "▸" : "▾" }}</span>
        <span class="peer-group__network" title="Another strIDEterm on your network">Network</span>
        <strong class="peer-group__label">{{ host.label }}</strong>
        <span class="peer-group__address">{{ host.address }}:{{ host.port }}</span>
      </button>
      <Spinner
        v-if="checking"
        size="sm"
        label="Checking the connection"
        class="peer-group__checking"
        data-testid="peer-checking"
      />
      <span class="peer-group__chip" :class="`peer-group__chip--${host.state}`" data-testid="peer-state-chip">{{
        chipText
      }}</span>
      <span v-if="thisWindow" class="peer-row__badge" data-testid="peer-this-window">This window</span>
      <div class="peer-group__actions">
        <button
          type="button"
          class="button button--ghost"
          :class="{ 'button--pending': headerAction === 'reconnect' }"
          :aria-busy="headerAction === 'reconnect' ? 'true' : undefined"
          data-testid="peer-reconnect"
          :disabled="headerBusy"
          title="Check the connection again, also after this desktop was refused."
          @click="reconnect"
        >
          Reconnect
        </button>
        <button
          type="button"
          class="button button--ghost"
          data-testid="peer-rename"
          :disabled="headerBusy"
          title="Change the name this computer shows for the other desktop. The other desktop is not told."
          @click="startRename"
        >
          Rename
        </button>
        <button
          type="button"
          class="button button--ghost"
          data-testid="peer-edit-address"
          :disabled="headerBusy"
          title="Change the address or port, for example after the other computer got a new IP address."
          @click="startEdit"
        >
          Edit address
        </button>
        <button
          type="button"
          class="button button--ghost button--danger-text"
          :class="{ 'button--pending': headerAction === 'disconnect' }"
          :aria-busy="headerAction === 'disconnect' ? 'true' : undefined"
          data-testid="peer-disconnect"
          :disabled="headerBusy"
          title="Remove this desktop from this one. Nothing is deleted on the other computer."
          @click="disconnect"
        >
          Disconnect
        </button>
      </div>
    </header>

    <form v-if="renaming" class="peer-group__edit" data-testid="peer-rename-form" @submit.prevent="saveRename">
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
        :class="{ 'button--pending': headerAction === 'rename' }"
        :aria-busy="headerAction === 'rename' ? 'true' : undefined"
        data-testid="peer-rename-save"
        :disabled="headerBusy || !renameValue.trim()"
      >
        Save
      </button>
      <button type="button" class="button button--ghost" @click="renaming = false">Cancel</button>
    </form>

    <form v-if="editing" class="peer-group__edit" data-testid="peer-edit-form" @submit.prevent="saveAddress">
      <input
        v-model="editAddress"
        class="settings-input"
        data-testid="peer-edit-address-input"
        type="text"
        autocomplete="off"
        spellcheck="false"
        aria-label="Host name or IP address"
      />
      <input
        v-model="editPort"
        class="settings-input peer-group__edit-port"
        data-testid="peer-edit-port-input"
        type="text"
        inputmode="numeric"
        autocomplete="off"
        aria-label="Port"
      />
      <button
        type="submit"
        class="button button--primary"
        :class="{ 'button--pending': headerAction === 'save' }"
        :aria-busy="headerAction === 'save' ? 'true' : undefined"
        data-testid="peer-edit-save"
        :disabled="headerBusy || !editParsed.ok"
      >
        Save
      </button>
      <button type="button" class="button button--ghost" @click="editing = false">Cancel</button>
      <p v-if="!editParsed.ok" class="inline-error peer-group__edit-error" data-testid="peer-edit-error">
        {{ editParsed.error }}
      </p>
    </form>

    <div v-if="!collapsed" class="peer-group__rows">
      <p v-if="!host.profiles.length" class="text-muted peer-group__empty">
        No profiles known yet{{ host.state === "online" ? "." : " — connect to see them." }}
      </p>
      <article
        v-for="profile in host.profiles"
        :key="profile.id"
        class="peer-row"
        :data-profile-id="profile.id"
        data-testid="peer-profile-row"
        :style="{ borderColor: isCurrent(profile.id) ? 'var(--accent)' : 'var(--border)' }"
      >
        <div class="peer-row__header">
          <div class="peer-row__name">
            <span
              class="peer-row__swatch"
              :style="{ background: profile.color || '#ffa424' }"
              aria-hidden="true"
            ></span>
            <span class="peer-row__title">{{ profile.name }}</span>
            <span v-if="isCurrent(profile.id)" class="peer-row__badge" data-testid="peer-current">Current</span>
            <small class="text-muted"
              >{{ profile.workspaceCount }} workspace{{ profile.workspaceCount !== 1 ? "s" : "" }}</small
            >
          </div>
          <div class="peer-row__actions">
            <button
              v-if="!isCurrent(profile.id)"
              type="button"
              class="button button--ghost"
              data-testid="peer-activate"
              :disabled="!online || busyKey !== null"
              :title="online ? 'Switch this window to this profile.' : disabledReason"
              @click="emit('activate', profile.id)"
            >
              <Spinner v-if="rowAction(profile.id) === 'activate'" size="sm" aria-hidden="true" />
              {{ rowAction(profile.id) === "activate" ? "Switching…" : "Activate" }}
            </button>
            <button
              type="button"
              class="button button--ghost"
              :class="{ 'button--pending': rowAction(profile.id) === 'new-window' }"
              :aria-busy="rowAction(profile.id) === 'new-window' ? 'true' : undefined"
              data-testid="peer-new-window"
              :disabled="!online || busyKey !== null"
              :title="online ? 'Open this profile in a new window.' : disabledReason"
              @click="emit('new-window', profile.id)"
            >
              New Window
            </button>
          </div>
        </div>
      </article>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import type { PeerAttachedHost } from "../../../electron/shared/peers.js";
import { useAppStore } from "../../stores/app.js";
import { parsePeerAddress, usePeersStore } from "../../stores/peers.js";
import Spinner from "../common/Spinner.vue";

const props = defineProps<{
  host: PeerAttachedHost;
  /** This window shows a profile of this host. */
  thisWindow?: boolean;
  /** The profile of this host that this window shows. */
  currentProfileId?: string;
  /** `<hostId>:<profileId>` of the row whose action is running. */
  busyKey: string | null;
  /** Which button of the busy row was pressed. */
  busyAction?: "activate" | "new-window";
}>();

const emit = defineEmits<{ activate: [profileId: string]; "new-window": [profileId: string] }>();

const peers = usePeersStore();
const app = useAppStore();

const headerAction = ref<"reconnect" | "save" | "rename" | "disconnect" | null>(null);
const headerBusy = computed(() => headerAction.value !== null);
const editing = ref(false);
const editAddress = ref("");
const editPort = ref("");
const renaming = ref(false);
const renameValue = ref("");

const collapsed = computed(() => peers.isCollapsed(props.host.id));
const checking = computed(() => (peers.checking[props.host.id] ?? 0) > 0);
const online = computed(() => props.host.state === "online");
const editParsed = computed(() => parsePeerAddress(editAddress.value, editPort.value));

const chipText = computed(() => {
  switch (props.host.state) {
    case "online":
      return "Online";
    case "offline":
      return "Offline";
    case "not-paired":
      return "Needs pairing";
    case "version-mismatch":
      return `Different version (host ${props.host.hostAppVersion || "?"} · this ${props.host.localAppVersion || "?"})`;
    case "wrong-host":
      return "Another strIDEterm answers here";
    default:
      return "Checking…";
  }
});

const disabledReason = computed(() => {
  const label = props.host.label;
  switch (props.host.state) {
    case "offline":
      return `${label} is offline. Check that it is running and that Remote Access → Desktops is on, then Reconnect.`;
    case "not-paired":
      return `${label} no longer accepts this desktop. Disconnect it and connect again.`;
    case "version-mismatch":
      return `Both desktops must run the same version (${label} runs ${props.host.hostAppVersion || "?"}, this one ${props.host.localAppVersion || "?"}). Update the older one.`;
    case "wrong-host":
      return `Another strIDEterm answers at ${props.host.address}:${props.host.port}, not ${label}. Edit the address.`;
    default:
      return `Still checking ${label}…`;
  }
});

function rowKey(profileId: string): string {
  return `${props.host.id}:${profileId}`;
}

function rowAction(profileId: string): "activate" | "new-window" | null {
  return props.busyKey === rowKey(profileId) ? (props.busyAction ?? "activate") : null;
}

function isCurrent(profileId: string): boolean {
  return !!props.thisWindow && props.currentProfileId === profileId;
}

async function withHeader(
  action: "reconnect" | "save" | "rename" | "disconnect",
  fn: () => Promise<unknown>,
): Promise<void> {
  if (headerBusy.value) return;
  headerAction.value = action;
  try {
    await fn();
  } finally {
    headerAction.value = null;
  }
}

async function reconnect(): Promise<void> {
  await withHeader("reconnect", () => peers.refresh(props.host.id, true));
}

function startEdit(): void {
  editAddress.value = props.host.address;
  editPort.value = String(props.host.port);
  editing.value = true;
}

async function saveAddress(): Promise<void> {
  const parsed = editParsed.value;
  if (!parsed.ok) return;
  await withHeader("save", async () => {
    if (await peers.updateAddress(props.host.id, parsed.value.address, parsed.value.port)) editing.value = false;
  });
}

function startRename(): void {
  renameValue.value = props.host.label;
  renaming.value = true;
}

async function saveRename(): Promise<void> {
  const label = renameValue.value.trim();
  if (!label) return;
  await withHeader("rename", async () => {
    if (await peers.renameHost(props.host.id, label)) renaming.value = false;
  });
}

async function disconnect(): Promise<void> {
  if (headerBusy.value) return;
  const label = props.host.label;
  const confirmed = await app.confirmInApp({
    title: "Disconnect desktop?",
    message: `${label} will be removed from this desktop. Windows showing its profiles will close. Nothing is deleted on ${label}.`,
    confirmLabel: "Disconnect",
    danger: true,
  });
  if (!confirmed) return;
  await withHeader("disconnect", () => peers.removeHost(props.host.id));
}
</script>

<style scoped>
.peer-group {
  display: grid;
  gap: 8px;
  min-width: 0;
  padding: 8px;
  border: 1px dashed var(--accent);
  border-radius: 6px;
  background: rgba(var(--tint), 0.02);
}
.peer-group__header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
  min-width: 0;
}
.peer-group__toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: 1 1 auto;
  padding: 2px 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.peer-group__network {
  flex-shrink: 0;
  padding: 1px 6px;
  border: 1px solid var(--accent);
  border-radius: 999px;
  color: var(--accent);
  font-size: 10px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.peer-group__label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.peer-group__address {
  color: var(--muted);
  font-size: 12px;
  white-space: nowrap;
}
.peer-group__chip {
  flex-shrink: 0;
  padding: 1px 8px;
  border: 1px solid var(--border);
  border-radius: 999px;
  font-size: 11px;
  color: var(--muted);
}
.peer-group__chip--online {
  color: var(--accent);
  border-color: var(--accent);
}
.peer-group__chip--offline,
.peer-group__chip--not-paired,
.peer-group__chip--wrong-host,
.peer-group__chip--version-mismatch {
  color: var(--danger);
  border-color: var(--danger);
}
.peer-group__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.peer-group__edit {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}
.peer-group__edit .settings-input {
  flex: 1 1 160px;
  min-width: 0;
}
.peer-group__edit .peer-group__edit-port {
  flex: 0 0 90px;
}
.peer-group__edit-error {
  flex-basis: 100%;
  margin: 0;
}
.peer-group__rows {
  display: grid;
  gap: 8px;
  min-width: 0;
}
.peer-group__empty {
  margin: 0;
  font-size: 12px;
}
.peer-row {
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 10px;
  background: rgba(var(--tint), 0.03);
}
.peer-row__header {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.peer-row__actions {
  display: flex;
  gap: 4px;
  justify-content: flex-end;
}
.peer-row__name {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.peer-row__swatch {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
  border: 1px solid rgba(255, 255, 255, 0.2);
}
.peer-row__title {
  min-width: 0;
  font-weight: 700;
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.peer-row__badge {
  color: var(--accent);
  font-size: 11px;
  flex-shrink: 0;
  white-space: nowrap;
}
.text-muted {
  color: var(--muted);
}
.button--danger-text {
  color: var(--danger);
}
@media (max-width: 520px) {
  .peer-row__header {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
