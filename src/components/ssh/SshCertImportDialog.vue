<template>
  <div class="dialog ssh-cert-import" :class="{ 'ssh-cert-import--embedded': embedded }">
    <div v-if="!embedded" class="dialog__header">
      <div>
        <p class="eyebrow">SSH</p>
        <h2>Import SSH certificate</h2>
      </div>
    </div>
    <div v-else class="ssh-embedded-header">
      <div class="ssh-embedded-header__title">
        <p class="eyebrow">SSH</p>
        <h2>Import SSH certificate</h2>
      </div>
      <div class="ssh-embedded-header__actions">
        <button
          type="button"
          class="button button--ghost"
          title="Return to SSH keys without importing certificate metadata."
          :disabled="busy"
          @click="requestClose"
        >
          {{ backLabel }}
        </button>
        <button
          type="button"
          class="button"
          title="Import this OpenSSH certificate metadata into strIDEterm."
          :disabled="busy || !cert.trim()"
          @click="submit"
        >
          {{ busy ? "Importing…" : "Import" }}
        </button>
      </div>
    </div>
    <p v-if="embedded && error" class="error-msg" role="alert">{{ error }}</p>

    <div class="form-group">
      <p class="field-help">
        Built-in SSH does not authenticate with SSH certificates. System SSH and WSL use a certificate only when their
        own OpenSSH config associates it with the matching key; importing it here does not configure those clients.
      </p>
      <label
        >OpenSSH certificate
        <HelpTooltip
          text="Paste the public certificate associated with a private key. Certificates are signed by your organization's SSH certificate authority and are only useful when the connection method is configured to use the matching certificate and key. Importing metadata here does not configure system SSH or WSL."
          label="SSH certificate help"
      /></label>
      <textarea
        ref="certRef"
        v-model="cert"
        class="input textarea"
        rows="6"
        placeholder="ssh-ed25519-cert-v01@openssh.com AAAA..."
      />
    </div>

    <div v-if="!embedded" class="dialog__footer dialog__footer--end">
      <p v-if="error" class="error-msg">{{ error }}</p>
      <button type="button" class="button button--ghost" :disabled="busy" @click="requestClose">Cancel</button>
      <button type="button" class="button" :disabled="busy || !cert.trim()" @click="submit">
        {{ busy ? "Importing…" : "Import" }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, nextTick } from "vue";
import { useSshStore } from "../../stores/ssh.js";
import { useAppStore } from "../../stores/app.js";
import HelpTooltip from "../common/HelpTooltip.vue";

const props = withDefaults(defineProps<{ keyId: string; backLabel?: string; embedded?: boolean }>(), {
  backLabel: "Back to keys",
  embedded: false,
});
const { embedded, backLabel } = props;
const emit = defineEmits<{
  (e: "cancel"): void;
}>();
const sshStore = useSshStore();
const appStore = useAppStore();
const busy = ref(false);
const confirmingDiscard = ref(false);
const error = ref("");
const cert = ref("");
const certRef = ref<HTMLTextAreaElement | null>(null);
async function requestClose() {
  if (busy.value || confirmingDiscard.value) return;
  if (cert.value.trim()) {
    confirmingDiscard.value = true;
    try {
      const discard = await appStore.confirmInApp({
        title: "Discard SSH certificate import?",
        message: "This certificate has not been imported.",
        confirmLabel: "Discard changes",
        cancelLabel: "Keep editing",
        danger: true,
      });
      if (!discard) return;
    } finally {
      confirmingDiscard.value = false;
    }
  }
  emit("cancel");
}
defineExpose({ requestClose });

onMounted(() => nextTick(() => certRef.value?.focus()));

async function submit() {
  const value = cert.value.trim();
  if (!value) return;
  busy.value = true;
  error.value = "";
  try {
    await sshStore.importCertificate(props.keyId, value);
    emit("cancel");
  } catch (e) {
    error.value = (e as Error).message || "Import failed.";
  } finally {
    busy.value = false;
  }
}
</script>

<style scoped>
.ssh-cert-import {
  width: min(480px, 100%);
  display: flex;
  flex-direction: column;
}
.form-group {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  scrollbar-gutter: stable;
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-bottom: 0;
}
.dialog__footer {
  flex-shrink: 0;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}
.ssh-embedded-header {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 12px;
  padding: 8px 0;
  background: var(--panel);
  border-bottom: 1px solid var(--border);
}
.ssh-embedded-header__title {
  flex: 1 1 auto;
}
.ssh-embedded-header__title h2 {
  margin: 0;
}
.ssh-embedded-header__actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-left: auto;
}
.ssh-cert-import--embedded label {
  display: flex;
  align-items: center;
  gap: 6px;
}
label {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}
.input {
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid var(--border);
  color: var(--text);
  padding: 8px;
  border-radius: 4px;
}
.textarea {
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  resize: vertical;
}
.error-msg {
  color: var(--danger);
  font-size: 13px;
  margin-right: auto;
}
</style>
