<template>
  <div :class="inline ? 'ssh-key-transfer-dialog ssh-key-transfer-dialog--inline' : 'dialog ssh-key-transfer-dialog'">
    <header v-if="!inline" class="dialog__header">
      <div>
        <p class="eyebrow">SSH</p>
        <h2>Transfer public key</h2>
      </div>
    </header>

    <p v-if="managerError" class="dialog__error" role="alert">{{ managerError }}</p>
    <p v-if="actionError" class="dialog__error" role="alert">{{ actionError }}</p>

    <div class="transfer-controls">
      <label v-if="!initialHostId && !draft" class="field">
        <span class="field__label">Saved host</span>
        <CustomSelect
          v-model="selectedHostId"
          :options="hostOptions"
          placeholder="Choose a saved host…"
          :disabled="busy"
        />
      </label>
      <p v-else class="transfer-host-label">
        <strong>Target:</strong> {{ selectedHost ? hostLabel(selectedHost) : "Loading saved host…" }}
      </p>

      <footer
        :class="
          inline
            ? 'ssh-key-transfer-dialog__footer ssh-key-transfer-dialog__footer--inline'
            : 'dialog__footer dialog__footer--end ssh-key-transfer-dialog__footer'
        "
      >
        <button
          type="button"
          class="button button--ghost button--small"
          :title="isRunning ? 'Stop the public-key transfer and close setup.' : 'Close public-key setup.'"
          :disabled="closing"
          @click="requestClose"
        >
          {{ closeLabel }}
        </button>
        <button
          v-if="!isRunning && canRetry"
          type="button"
          :class="inline ? 'button button--small' : 'button'"
          :disabled="busy || !selectedHost"
          title="Send the public key to this server account's authorized_keys. The private key stays in strIDEterm."
          @click="startTransfer"
        >
          {{ startLabel }}
        </button>
      </footer>
    </div>

    <p :class="inline ? 'transfer-intro transfer-intro--inline' : 'transfer-intro'">
      <template v-if="inline"
        >Only the public key is sent. The private key stays in strIDEterm; a server password may be requested once and
        is not saved. Stopping after upload does not remove the public key from the server.</template
      >
      <template v-else
        >Add this key's public part to a saved Built-in SSH host. The private key never leaves strIDEterm. If needed,
        you may be asked for the server account password once; it is used only for this transfer and is not saved.
        Stopping after upload does not remove the public key from the server.</template
      >
    </p>

    <p v-if="!draft && !sshStore.hosts.length" class="muted">
      Add a saved host with Built-in SSH and a username before transferring a key.
    </p>
    <p v-else-if="!draft && !availableHosts.length" class="muted">
      None of your saved hosts can use this transfer yet. Edit a host, choose Built-in SSH, and set its remote username.
    </p>

    <div
      v-if="operationState"
      class="transfer-result"
      :class="`transfer-result--${operationState.status}`"
      aria-live="polite"
    >
      <span v-if="isRunning" class="transfer-progress">
        <Spinner size="sm" />
        {{ statusText(operationState) }}
      </span>
      <span v-else>{{ statusText(operationState) }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import type { SshKeyTransferStart } from "../../../electron/backend/ipc-schemas.js";
import type { SshHost, SshKeyTransferState } from "../../../electron/shared/types/ssh.js";
import { resolveSshLaunchVia } from "../../../electron/shared/ssh-connection.js";
import { useAppStore } from "../../stores/app.js";
import { useSshStore } from "../../stores/ssh.js";
import CustomSelect from "../common/CustomSelect.vue";
import Spinner from "../common/Spinner.vue";

const props = withDefaults(
  defineProps<{
    keyId: string;
    profileId: string;
    initialHostId?: string;
    draft?: NonNullable<SshKeyTransferStart["draft"]>;
    inline?: boolean;
    onCancel?: () => void;
  }>(),
  {
    inline: false,
  },
);
const appStore = useAppStore();
const sshStore = useSshStore();
const selectedHostId = ref(props.initialHostId || "");
const operationId = ref("");
const localStatus = ref<SshKeyTransferState["status"] | null>(null);
const managerError = ref("");
const actionError = ref("");
const starting = ref(false);
const stopping = ref(false);
const closing = ref(false);
const currentOperationState = computed(() =>
  operationId.value ? sshStore.keyTransferStates[operationId.value] : null,
);
const operationState = computed<SshKeyTransferState | null>(() => {
  if (currentOperationState.value) return currentOperationState.value;
  if (!operationId.value || !localStatus.value) return null;
  return {
    operationId: operationId.value,
    keyId: props.keyId,
    hostId: selectedHostId.value,
    status: localStatus.value,
  };
});
const key = computed(() => sshStore.keys.find((candidate) => candidate.id === props.keyId) || null);
const defaultLaunchVia = computed(() => appStore.payload?.appState?.settings?.ssh?.defaultLaunchVia);
const hostChoices = computed(() =>
  sshStore.hosts.map((host) => {
    const mode = resolveSshLaunchVia(host.advanced?.launchVia, defaultLaunchVia.value);
    const disabledReason =
      mode !== "ssh2"
        ? `${mode === "wsl" ? "WSL" : "System SSH"} requires its own key setup`
        : !host.username
          ? "Add a username in the host editor"
          : "";
    return { host, mode, disabledReason };
  }),
);
const hostOptions = computed(() =>
  hostChoices.value.map(({ host, disabledReason }) => ({
    value: host.id || "",
    label: `${hostLabel(host)}${disabledReason ? ` — ${disabledReason}` : ""}`,
    disabled: Boolean(disabledReason),
  })),
);
const availableHosts = computed(() => hostChoices.value.filter((choice) => !choice.disabledReason));
const selectedHost = computed(
  () => props.draft || availableHosts.value.find((choice) => choice.host.id === selectedHostId.value)?.host || null,
);
const activeProfileId = computed(() => appStore.myActiveProfileId);
const isRunning = computed(() =>
  Boolean(operationState.value && ["connecting", "uploading", "verifying"].includes(operationState.value.status)),
);
const busy = computed(() => starting.value || stopping.value || closing.value || isRunning.value);
const closeLabel = computed(() =>
  starting.value
    ? "Starting…"
    : operationState.value?.status === "verifying"
      ? "Stop verification"
      : isRunning.value
        ? "Stop transfer"
        : operationId.value
          ? "Close"
          : "Cancel",
);
const canRetry = computed(
  () => !operationState.value || ["error", "verification-failed", "cancelled"].includes(operationState.value.status),
);
const startLabel = computed(() => (operationId.value ? "Try again" : "Start transfer"));

const emit = defineEmits<{ cancel: [] }>();
let startPromise: Promise<{ operationId: string; status: "connecting" }> | null = null;
let closePromise: Promise<boolean> | null = null;
let stopInFlight: { operationId: string; promise: Promise<void> } | null = null;
let disposed = false;

function hostLabel(host: Pick<SshHost, "host"> & Partial<Pick<SshHost, "username" | "port" | "name">>): string {
  const userHost = host.username ? `${host.username}@${host.host}` : host.host;
  const address = `${userHost}${host.port && host.port !== 22 ? `:${host.port}` : ""}`;
  if (!host.name || host.name === host.host || host.name === userHost || host.name === address) return address;
  return `${host.name} (${address})`;
}

function statusText(state: SshKeyTransferState): string {
  switch (state.status) {
    case "connecting":
      return "Connecting to the selected host…";
    case "uploading":
      return "Adding the public key to the remote account…";
    case "verifying":
      return "Checking that the key can sign in…";
    case "installed":
      return transferSuccessText(state, false);
    case "already-installed":
      return transferSuccessText(state, true);
    case "verification-failed":
      return `The public key is installed or already present, but key-only sign-in could not be verified.${state.error ? ` ${state.error}` : ""}`;
    case "error":
      return `${state.remoteMayHaveChanged ? "The public key may have been added before the transfer failed. " : ""}Transfer failed.${state.error ? ` ${state.error}` : ""}`;
    case "cancelled":
      return state.installed
        ? "Public key is installed or already present; verification was cancelled."
        : state.remoteMayHaveChanged
          ? "Transfer was cancelled after the public key may have been added. Check the remote account before retrying."
          : "Transfer cancelled.";
  }
}

function transferSuccessText(state: SshKeyTransferState, alreadyPresent: boolean): string {
  const label = sshStore.keys.find((candidate) => candidate.id === state.keyId)?.label || "This key";
  const host = props.draft || sshStore.hosts.find((candidate) => candidate.id === state.hostId);
  const target = host ? hostLabel(host as SshHost) : "the selected host";
  const result = alreadyPresent
    ? "This public key was already present and verified."
    : "Public key transferred successfully.";
  return props.draft
    ? `${result} “${label}” can now sign in to ${target}. Save this host to keep these connection settings.`
    : `${result} “${label}” can now sign in to ${target}. Select it in a saved host's Built-in SSH settings to use it.`;
}

async function startTransfer(): Promise<void> {
  if (starting.value || stopping.value || isRunning.value) return;
  managerError.value = "";
  actionError.value = "";
  localStatus.value = null;
  if ((activeProfileId.value || "default") !== (props.profileId || "default")) {
    managerError.value = "The active profile changed. Close this dialog and reopen it before transferring the key.";
    return;
  }
  if (appStore.isRemoteTransport) {
    managerError.value = "Key transfer is available in the desktop app only.";
    return;
  }
  if (!key.value?.publicKey) {
    managerError.value = "This key has no public-key data to transfer.";
    return;
  }
  if (!selectedHost.value) {
    managerError.value = "Choose a saved Built-in SSH host with a username.";
    return;
  }

  if (operationId.value) {
    stopping.value = true;
    try {
      await stopOperation(operationId.value);
      operationId.value = "";
    } catch (err) {
      actionError.value = `Could not stop the previous transfer: ${(err as Error).message || "request failed"}`;
      stopping.value = false;
      return;
    } finally {
      stopping.value = false;
    }
  }

  starting.value = true;
  const transferRequest = props.draft
    ? { profileId: props.profileId, keyId: props.keyId, draft: props.draft }
    : {
        profileId: props.profileId,
        keyId: props.keyId,
        hostId: availableHosts.value.find((choice) => choice.host.id === selectedHostId.value)?.host.id || "",
      };
  const pending = sshStore.startKeyTransfer(transferRequest as SshKeyTransferStart);
  startPromise = pending;
  try {
    const started = await pending;
    if (disposed) {
      await stopOperation(started.operationId);
      return;
    }
    operationId.value = started.operationId;
    localStatus.value = started.status;
  } catch (err) {
    if (!disposed) managerError.value = `Could not start key transfer: ${(err as Error).message || "request failed"}`;
  } finally {
    if (startPromise === pending) startPromise = null;
    starting.value = false;
  }
}

function stopOperation(id: string): Promise<void> {
  if (stopInFlight?.operationId === id) return stopInFlight.promise;
  const promise = sshStore.stopKeyTransfer(id).then(() => sshStore.clearKeyTransferState(id));
  stopInFlight = { operationId: id, promise };
  void promise.then(
    () => {
      if (stopInFlight?.promise === promise) stopInFlight = null;
    },
    () => {
      if (stopInFlight?.promise === promise) stopInFlight = null;
    },
  );
  return promise;
}

function requestClose(): Promise<boolean> {
  if (closePromise) return closePromise;
  closePromise = (async () => {
    closing.value = true;
    actionError.value = "";
    if (startPromise) {
      try {
        const started = await startPromise;
        if (!operationId.value) operationId.value = started.operationId;
      } catch {
        // A failed start has no operation to stop.
      }
    }
    const id = operationId.value;
    if (id) {
      stopping.value = true;
      try {
        await stopOperation(id);
        operationId.value = "";
        localStatus.value = null;
      } catch (err) {
        actionError.value = `Could not stop the key transfer: ${(err as Error).message || "request failed"}`;
        closing.value = false;
        return false;
      } finally {
        stopping.value = false;
      }
    }
    if (!disposed) emit("cancel");
    return true;
  })().finally(() => {
    closePromise = null;
  });
  return closePromise;
}

watch(activeProfileId, (profileId) => {
  if ((profileId || "default") !== (props.profileId || "default")) void requestClose();
});

onBeforeUnmount(() => {
  disposed = true;
  const cleanup = async () => {
    if (startPromise) {
      try {
        const started = await startPromise;
        await stopOperation(started.operationId);
      } catch {
        return;
      }
      return;
    }
    if (operationId.value) {
      try {
        await stopOperation(operationId.value);
      } catch {
        // The owner window closing also lets the backend expire its owned operation.
      }
    }
  };
  void cleanup();
});

defineExpose({ requestClose, isBusy: () => busy.value });
</script>

<style scoped>
.ssh-key-transfer-dialog {
  width: min(560px, 100%);
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.ssh-key-transfer-dialog--inline {
  width: 100%;
  min-width: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  align-items: start;
  gap: 8px;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.025);
}
.ssh-key-transfer-dialog--inline > * {
  min-width: 0;
}
.transfer-controls {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: end;
  gap: 10px;
  min-width: 0;
}
.transfer-controls .field {
  margin: 0;
  min-width: 0;
}
.transfer-controls .custom-select {
  min-width: 0;
  max-width: 100%;
}
.ssh-key-transfer-dialog--inline .transfer-controls {
  grid-column: 1 / -1;
}
.transfer-intro--inline {
  font-size: 12px;
}
.transfer-host-label {
  margin: 0;
  color: var(--muted);
  font-size: 12px;
}
.ssh-key-transfer-dialog--inline .ssh-key-transfer-dialog__footer--inline {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px;
  grid-column: auto;
  margin: 0;
  padding: 0;
  border: 0;
}
.ssh-key-transfer-dialog--inline .transfer-result,
.ssh-key-transfer-dialog--inline > .dialog__error,
.ssh-key-transfer-dialog--inline > .muted {
  grid-column: 1 / -1;
}
@media (max-width: 520px) {
  .transfer-controls {
    grid-template-columns: minmax(0, 1fr);
  }
  .ssh-key-transfer-dialog__footer--inline {
    justify-content: flex-start;
  }
}
.transfer-intro,
.muted {
  margin: 0;
  color: var(--muted);
  line-height: 1.5;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.field__label {
  font-size: 13px;
  font-weight: 600;
}
.input {
  width: 100%;
  min-width: 0;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.05);
  color: var(--text);
  font: inherit;
}
.transfer-result {
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  line-height: 1.5;
}
.transfer-progress {
  display: flex;
  align-items: center;
  gap: 8px;
}
.transfer-result--installed,
.transfer-result--already-installed {
  border-color: var(--success, #3fb950);
}
.transfer-result--verification-failed,
.transfer-result--error {
  border-color: var(--warning, #d29922);
}
.ssh-key-transfer-dialog__footer {
  margin-top: 4px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}
</style>
