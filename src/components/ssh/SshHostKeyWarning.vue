<template>
  <div v-if="data" class="ssh-host-key-warning" @keydown.esc.stop.prevent="reject">
    <div class="dialog">
      <header class="dialog__header">
        <h2 class="danger-title">
          ⚠ Host key verification
          <HelpTooltip
            text="An SSH host key identifies the server. Compare this fingerprint with one published by your administrator over a trusted channel before accepting it. If it changed unexpectedly, cancel and verify before reconnecting."
            label="Host key verification help"
          />
        </h2>
      </header>

      <div class="warning-content">
        <p>
          Host
          <strong>{{ data.host?.name || data.host?.host }}</strong>
          <span class="muted">({{ data.host?.host }}:{{ data.host?.port }})</span>
          presented a key we haven't trusted yet.
        </p>

        <div v-if="data.previous" class="fingerprint-box fingerprint-box--previous">
          <p class="muted">Previously trusted ({{ data.previous.keyType || "unknown type" }}):</p>
          <code>{{ data.previous.fingerprint }}</code>
        </div>

        <div class="fingerprint-box">
          <p class="muted">Now presented ({{ data.keyType || "unknown type" }}):</p>
          <code>{{ data.fingerprint }}</code>
        </div>

        <p v-if="data.previous" class="warning-text">
          The server's key changed. Possible causes: server reinstall, key rotation, or a man-in-the-middle attack.
        </p>
        <p v-else class="warning-text">
          First time connecting — verify this fingerprint with the server administrator before trusting.
        </p>
      </div>

      <footer class="dialog__footer">
        <button
          type="button"
          class="button button--ghost"
          autofocus
          title="Cancel the connection and do not trust this fingerprint. Verify it with your server administrator before trying again."
          :disabled="busy"
          @click="reject"
        >
          Cancel
        </button>
        <button
          type="button"
          class="button"
          title="Trust this fingerprint for this connection only. The next connection will ask again. Accept only after verifying the fingerprint with your server administrator."
          :disabled="busy"
          @click="acceptOnce"
        >
          Accept once
        </button>
        <button
          type="button"
          class="button button--danger"
          :title="
            data.previous
              ? 'Replace the saved fingerprint and trust this new one on future connections. Do this only after verifying the change with your server administrator.'
              : 'Save this fingerprint and trust it on future connections. Do this only after verifying it with your server administrator.'
          "
          :disabled="busy"
          @click="acceptPermanent"
        >
          {{ data.previous ? "Replace & trust" : "Trust forever" }}
        </button>
      </footer>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useSshStore } from "../../stores/ssh.js";
import HelpTooltip from "../common/HelpTooltip.vue";

interface HostKeyWarning {
  sessionId: string;
  promptId: string;
  host?: { name?: string; host?: string; port?: number };
  previous?: { keyType?: string; fingerprint?: string };
  keyType?: string;
  fingerprint?: string;
}

const props = withDefaults(
  defineProps<{
    warning?: HostKeyWarning | null;
  }>(),
  {
    warning: null,
  },
);

const sshStore = useSshStore();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const data = computed(() => props.warning || (sshStore.hostKeyWarning as any as HostKeyWarning | null));
const busy = ref(false);

watch(
  () => data.value?.promptId,
  () => {
    busy.value = false;
  },
);

async function reject() {
  if (!data.value?.sessionId || busy.value) return;
  const promptId = data.value.promptId;
  busy.value = true;
  await sshStore.rejectHostKey(data.value.sessionId, promptId);
  if (data.value?.promptId === promptId) busy.value = false;
}

async function acceptOnce() {
  if (!data.value?.sessionId || busy.value) return;
  const promptId = data.value.promptId;
  busy.value = true;
  await sshStore.acceptHostKey(data.value.sessionId, "once", promptId);
  if (data.value?.promptId === promptId) busy.value = false;
}

async function acceptPermanent() {
  if (!data.value?.sessionId || busy.value) return;
  const promptId = data.value.promptId;
  busy.value = true;
  await sshStore.acceptHostKey(data.value.sessionId, "permanent", promptId);
  if (data.value?.promptId === promptId) busy.value = false;
}
</script>

<style scoped>
.ssh-host-key-warning {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
}
.dialog {
  width: 540px;
  max-width: 95vw;
  background: #1e1e20;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 20px;
}
.danger-title {
  color: var(--danger, #ff6b6b);
  margin: 0;
}
.warning-content {
  margin: 20px 0;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.fingerprint-box {
  background: rgba(0, 0, 0, 0.3);
  padding: 12px;
  border-radius: 4px;
  border: 1px solid rgba(255, 255, 255, 0.1);
}
.fingerprint-box--previous {
  border-left: 3px solid #f59e0b;
}
.fingerprint-box code {
  color: var(--text);
  font-family: var(--font-mono);
  font-size: 13px;
  word-break: break-all;
}
.muted {
  color: var(--muted);
  font-size: 12px;
  margin: 0 0 4px 0;
}
.warning-text {
  color: #f59e0b;
  font-size: 13px;
  margin: 0;
}
.dialog__footer {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}
.button--danger {
  background: #b91c1c;
  color: #fff;
}
</style>
