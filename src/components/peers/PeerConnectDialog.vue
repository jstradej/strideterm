<template>
  <div class="dialog peer-connect" data-testid="peer-connect">
    <div class="dialog__header">
      <div>
        <p class="eyebrow">Profiles</p>
        <h2>Connect from network</h2>
      </div>
      <button type="button" class="button button--ghost" data-testid="peer-connect-close" @click="emit('cancel')">
        Close
      </button>
    </div>

    <form v-if="step === 'address'" class="form peer-connect__form" @submit.prevent="submit">
      <p class="peer-connect__note">On the other computer, turn on Remote Access → Desktops first.</p>
      <div class="peer-connect__fields">
        <label class="peer-connect__field peer-connect__field--address">
          <span>Host name or IP address</span>
          <input
            v-model="address"
            class="settings-input"
            data-testid="peer-connect-address"
            type="text"
            autocomplete="off"
            spellcheck="false"
            :disabled="peers.starting"
          />
        </label>
        <label class="peer-connect__field peer-connect__field--port">
          <span>Port</span>
          <input
            v-model="port"
            class="settings-input"
            data-testid="peer-connect-port"
            type="text"
            inputmode="numeric"
            autocomplete="off"
            :disabled="peers.starting"
          />
        </label>
      </div>
      <p v-if="validationError" class="inline-error" data-testid="peer-connect-validation">{{ validationError }}</p>
      <div v-if="submitError" class="dialog__error" role="alert" data-testid="peer-connect-error">
        <span class="dialog__error-icon" aria-hidden="true">⚠</span>
        <span class="dialog__error-text">{{ submitError }}</span>
      </div>
      <p v-if="peers.starting" class="peer-connect__waiting" role="status" data-testid="peer-connect-contacting">
        <Spinner size="sm" aria-hidden="true" />
        Contacting {{ parsed.ok ? parsed.value.address : "the other computer" }}… This can take a while if it is asleep.
      </p>
      <div class="dialog__actions">
        <button type="button" class="button button--ghost" @click="emit('cancel')">Cancel</button>
        <button
          type="submit"
          class="button button--primary"
          :aria-busy="peers.starting ? 'true' : undefined"
          data-testid="peer-connect-submit"
          :disabled="peers.starting || !parsed.ok"
        >
          <Spinner v-if="peers.starting" size="sm" aria-hidden="true" />
          {{ peers.starting ? "Connecting…" : "Connect" }}
        </button>
      </div>
    </form>

    <div v-else-if="step === 'code' && pairing" class="form peer-connect__form">
      <p class="peer-connect__note">
        Type this code on <strong>{{ pairing.started.hostName }}</strong> under Remote Access → Desktops.
      </p>
      <p class="peer-connect__code" data-testid="peer-connect-code" aria-label="Pairing code">
        {{ pairing.started.code }}
      </p>
      <p class="peer-connect__note">
        Only this desktop shows the code. If the other computer shows a different request, reject it there.
      </p>
      <p v-if="versionHint" class="peer-connect__hint" data-testid="peer-connect-version">{{ versionHint }}</p>
      <p class="peer-connect__waiting" role="status" data-testid="peer-connect-waiting">
        <Spinner size="sm" aria-hidden="true" />
        Waiting for {{ pairing.started.hostName }}…
      </p>
      <div class="dialog__actions">
        <button type="button" class="button button--ghost" data-testid="peer-connect-cancel" @click="cancelAttempt">
          Cancel
        </button>
      </div>
    </div>

    <div v-else-if="step === 'result' && pairing?.end" class="form peer-connect__form">
      <div class="dialog__error" role="alert" data-testid="peer-connect-result">
        <span class="dialog__error-icon" aria-hidden="true">⚠</span>
        <span class="dialog__error-text">{{ resultMessage }}</span>
      </div>
      <div class="dialog__actions">
        <button type="button" class="button button--ghost" @click="emit('cancel')">Close</button>
        <button type="button" class="button button--primary" data-testid="peer-connect-retry" @click="tryAgain">
          Try again
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { PEER_DEFAULT_PORT } from "../../../electron/shared/peers.js";
import { userFacingMessage } from "../../lib/error-message.js";
import { useAppStore } from "../../stores/app.js";
import { parsePeerAddress, usePeersStore } from "../../stores/peers.js";
import { isPeerWindow } from "../../window-backend.js";
import Spinner from "../common/Spinner.vue";

const emit = defineEmits<{ cancel: [] }>();

const peers = usePeersStore();
const app = useAppStore();

const address = ref("");
const port = ref(String(PEER_DEFAULT_PORT));
const submitError = ref("");

const pairing = computed(() => peers.pairing);
const step = computed<"address" | "code" | "result">(() => {
  if (!pairing.value) return "address";
  return pairing.value.end ? "result" : "code";
});

const parsed = computed(() => parsePeerAddress(address.value, port.value));
const validationError = computed(() => {
  if (parsed.value.ok) return "";
  if (address.value.trim() === "" && port.value === String(PEER_DEFAULT_PORT)) return "";
  return parsed.value.error;
});

const localVersion = computed(() =>
  isPeerWindow() ? peers.localAppVersion : app.payload?.meta?.appVersion || peers.localAppVersion,
);

const versionHint = computed(() => {
  const started = pairing.value?.started;
  if (!started || !started.hostAppVersion || !localVersion.value) return "";
  if (started.hostAppVersion === localVersion.value) return "";
  return `Pairing will work, but both desktops must run the same version to connect (${started.hostName} runs ${started.hostAppVersion}, this one ${localVersion.value}).`;
});

const resultMessage = computed(() => {
  const end = pairing.value?.end;
  const host = pairing.value?.started.hostName ?? "the other computer";
  if (!end) return "";
  if (end.state === "rejected") return `The request was rejected on ${host}, or the code did not match.`;
  if (end.state === "expired") return "The request timed out.";
  if (end.state === "failed") return end.error || "Pairing failed.";
  return "";
});

async function submit(): Promise<void> {
  if (!parsed.value.ok || peers.starting) return;
  submitError.value = "";
  try {
    await peers.startPairing(parsed.value.value.address, parsed.value.value.port);
  } catch (err) {
    submitError.value = userFacingMessage(err, "Could not start pairing.");
  }
}

async function cancelAttempt(): Promise<void> {
  await peers.resetPairing();
}

async function tryAgain(): Promise<void> {
  submitError.value = "";
  await peers.resetPairing();
}

watch(
  () => pairing.value?.end?.state,
  (state) => {
    if (state === "approved") emit("cancel");
    else if (state === "cancelled") void peers.resetPairing();
  },
);

onMounted(() => {
  if (isPeerWindow() && !peers.localAppVersion) void peers.load();
});

onBeforeUnmount(() => {
  void peers.resetPairing();
});
</script>

<style scoped>
.peer-connect__form {
  margin-top: 14px;
  display: grid;
  gap: 10px;
  min-width: 0;
}
.peer-connect__note {
  margin: 0;
  color: var(--muted);
  font-size: 13px;
  line-height: 1.4;
}
.peer-connect__fields {
  display: flex;
  gap: 8px;
  align-items: flex-end;
  min-width: 0;
}
.peer-connect__field {
  display: grid;
  gap: 4px;
  font-size: 12px;
  min-width: 0;
}
.peer-connect__field--address {
  flex: 1 1 auto;
}
.peer-connect__field--port {
  flex: 0 0 96px;
}
.peer-connect__code {
  margin: 0;
  padding: 14px 10px;
  text-align: center;
  font-family: var(--mono, ui-monospace, monospace);
  font-size: 34px;
  letter-spacing: 0.12em;
  font-weight: 700;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: rgba(var(--tint), 0.04);
  user-select: all;
}
.peer-connect__hint {
  margin: 0;
  padding: 8px 10px;
  border: 1px solid #d97706;
  border-radius: 6px;
  background: rgba(217, 119, 6, 0.12);
  font-size: 12.5px;
  line-height: 1.5;
}
.peer-connect__waiting {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  color: var(--muted);
  font-size: 13px;
}
.dialog__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
